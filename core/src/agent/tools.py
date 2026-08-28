"""Tools del agente.

Dos familias, dos caminos:
- Usuario ("mis pedidos"): FunctionTool local que llama la API del cliente por
  HTTP con el `actToken` del usuario. El token NUNCA se loguea ni se persiste.
- Tenant (catálogo, FAQ): llegan como MCP tools desde un AgentCore Gateway con
  inbound AWS_IAM — cada request MCP se firma con SigV4.

Nota de librerías: el camino MCP usa el cliente OFICIAL (`mcp`), no
`llama-index-tools-mcp`. Esa librería (0.5.0) desempaca 3 valores del
transporte streamable-http y `mcp` 2.x yieldea 2 — falla con "not enough
values to unpack" contra toda la línea 2.x (2.0.0, 2.0.1, 2.1.0, 2.1.1).
La superficie necesaria es chica (list_tools + call_tool), así que se habla
MCP directo y se envuelve cada tool en un FunctionTool.

`mcp` usa `httpx2`, no el httpx clásico: por eso SigV4Auth extiende
`httpx2.Auth`, mientras que la tool de usuario usa `httpx` clásico como el
resto del ecosistema llama-index. Misma API, distinto import.
"""

import logging
from contextlib import asynccontextmanager

import boto3
import botocore.auth
import httpx
import httpx2
from botocore.awsrequest import AWSRequest
from llama_index.core.tools import FunctionTool
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import Field, create_model

logger = logging.getLogger(__name__)

MENSAJE_NO_AUTENTICADO = (
    "El usuario no está autenticado para consultar sus pedidos."
)
MENSAJE_ERROR_PEDIDOS = (
    "No pude consultar los pedidos en este momento; el servicio no respondió."
)
MENSAJE_ERROR_TOOL_TENANT = (
    "No pude consultar esa información en este momento; el servicio no respondió."
)

# La tool de escalamiento vive en el Gateway y llega prefijada con el nombre del
# target (`<target>___escalar_a_humano`), así que se reconoce por el sufijo. El
# cierre del turno la usa para contar derivaciones (spec §17) sin mirar el
# contenido de la conversación.
NOMBRE_TOOL_ESCALAMIENTO = "escalar_a_humano"

_TIMEOUT_API_CLIENTE = 10  # segundos


def crear_tools_usuario(
    base_url: str, act_token: str | None, client_factory=httpx.AsyncClient
) -> list[FunctionTool]:
    """Tools por-usuario contra la API del cliente.

    La tool existe aunque falte el `act_token`: en ese caso responde que el
    usuario no está autenticado (el agente lo explica en humano) y NUNCA manda
    un request sin token. Errores de red/HTTP también vuelven como string
    humano: fail-open conversacional, nunca una excepción al workflow.
    """

    async def mis_pedidos() -> str:
        """Consulta los pedidos del usuario autenticado y su estado de envío."""
        if not act_token:
            return MENSAJE_NO_AUTENTICADO
        try:
            async with client_factory(timeout=_TIMEOUT_API_CLIENTE) as cliente:
                respuesta = await cliente.get(
                    f"{base_url}/pedidos",
                    headers={"Authorization": f"Bearer {act_token}"},
                )
                respuesta.raise_for_status()
                return respuesta.text
        except Exception as exc:
            # Ojo: se loguea la excepción, jamás el token.
            logger.error("Falló la consulta de pedidos a la API del cliente: %s", exc)
            return MENSAJE_ERROR_PEDIDOS

    return [
        FunctionTool.from_defaults(
            async_fn=mis_pedidos,
            name="mis_pedidos",
            description=(
                "Consulta los pedidos del usuario autenticado y su estado de envío."
            ),
        )
    ]


class SigV4Auth(httpx2.Auth):
    """Firma cada request al gateway con SigV4 (servicio `bedrock-agentcore`).

    El inbound del gateway es AWS_IAM: la identidad es el rol del Runtime, no
    un JWT. `requires_request_body` es obligatorio: sin el cuerpo cargado la
    firma no matchea el payload.
    """

    requires_request_body = True

    def __init__(self, credenciales, region: str, servicio: str = "bedrock-agentcore"):
        self._credenciales = credenciales
        self._region = region
        self._servicio = servicio

    def auth_flow(self, request):
        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers={"Content-Type": request.headers.get("content-type", "application/json")},
        )
        botocore.auth.SigV4Auth(self._credenciales, self._servicio, self._region).add_auth(
            aws_request
        )
        # Los headers firmados (Authorization, X-Amz-Date, X-Amz-Security-Token
        # si hay sesión) pisan los del request; el resto queda como estaba.
        request.headers.update(dict(aws_request.headers))
        yield request


@asynccontextmanager
async def _sesion_mcp(gateway_url: str, region: str, credenciales):
    """Abre una sesión MCP firmada con SigV4 contra el gateway.

    Una sesión por operación (listar o invocar): el transporte es
    request/response, así que no hay estado que valga la pena sostener entre
    turnos — y así el cliente HTTP siempre se cierra.
    """
    credenciales = credenciales or boto3.Session().get_credentials()
    async with httpx2.AsyncClient(auth=SigV4Auth(credenciales, region)) as http_client:
        async with streamable_http_client(gateway_url, http_client=http_client) as (
            lectura,
            escritura,
        ):
            async with ClientSession(lectura, escritura) as sesion:
                await sesion.initialize()
                yield sesion


def _texto_de(salida) -> str:
    """Concatena el contenido textual de un resultado MCP."""
    return "".join(getattr(bloque, "text", "") for bloque in (salida.content or []))


_TIPOS_JSON = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _modelo_de(nombre: str, schema: dict | None):
    """Traduce el input schema JSON de una tool MCP a un modelo pydantic.

    LlamaIndex necesita el schema para contarle al LLM qué parámetros existen;
    la función envuelta recibe `**kwargs`, así que sin esto el LLM vería una
    tool sin argumentos.
    """
    propiedades = (schema or {}).get("properties") or {}
    requeridos = set((schema or {}).get("required") or [])
    campos = {}
    for campo, definicion in propiedades.items():
        tipo = _TIPOS_JSON.get((definicion or {}).get("type"), str)
        descripcion = (definicion or {}).get("description", "")
        campos[campo] = (
            (tipo, Field(description=descripcion))
            if campo in requeridos
            else (tipo | None, Field(default=None, description=descripcion))
        )
    # El nombre del modelo se sanea: los nombres de tools del gateway vienen
    # como `target___tool` y pydantic no acepta cualquier cosa como identificador.
    return create_model(f"Args_{nombre.replace('-', '_').replace('.', '_')}", **campos)


def _envolver(tool_mcp, gateway_url: str, region: str, credenciales, sesion_factory):
    """Envuelve una tool MCP del gateway como FunctionTool del agente."""
    nombre = tool_mcp.name
    descripcion = getattr(tool_mcp, "description", "") or nombre

    async def invocar(**argumentos) -> str:
        # Los None que agrega el modelo por los campos opcionales no se mandan:
        # el servidor MCP valida contra su propio schema.
        argumentos = {k: v for k, v in argumentos.items() if v is not None}
        try:
            async with sesion_factory(gateway_url, region, credenciales) as sesion:
                return _texto_de(await sesion.call_tool(nombre, argumentos))
        except Exception as exc:
            # Fail-open conversacional, igual que la tool de usuario: el agente
            # recibe un texto y lo explica en humano, nunca revienta el turno.
            logger.error("Falló la tool de tenant %s: %s", nombre, exc)
            return MENSAJE_ERROR_TOOL_TENANT

    return FunctionTool.from_defaults(
        async_fn=invocar,
        name=nombre,
        description=descripcion,
        fn_schema=_modelo_de(nombre, getattr(tool_mcp, "input_schema", None)),
    )


async def tools_de_gateway(
    gateway_url: str,
    region: str,
    credenciales=None,
    sesion_factory=_sesion_mcp,
) -> list:
    """Lista las MCP tools de tenant que expone el AgentCore Gateway.

    Fail-open: si el gateway no responde o el listado falla, el chat sigue sin
    tools de tenant (lista vacía + log), nunca una excepción al turno.
    """
    try:
        async with sesion_factory(gateway_url, region, credenciales) as sesion:
            listado = await sesion.list_tools()
            return [
                _envolver(tool, gateway_url, region, credenciales, sesion_factory)
                for tool in listado.tools
            ]
    except Exception as exc:
        # El ExceptionGroup de anyio esconde la causa real en `exceptions`: hay
        # que loguear las sub-excepciones o el log no dice nada útil.
        subs = getattr(exc, "exceptions", None)
        detalle = "; ".join(f"{type(s).__name__}: {s}" for s in subs) if subs else f"{exc}"
        logger.error("No se pudieron listar las tools del gateway: %s", detalle)
        return []
