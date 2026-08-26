"""Tools del agente (fase 2d).

Dos familias, dos caminos (spec §7):
- Usuario ("mis pedidos"): FunctionTool local que llama la API del cliente por
  HTTP con el `actToken` del usuario. El token NUNCA se loguea ni se persiste.
- Tenant (catálogo, FAQ): llegan como MCP tools desde un AgentCore Gateway con
  inbound AWS_IAM — cada request MCP se firma con SigV4.

Nota de librerías: el stack MCP (`mcp` 2.1.1 / llama-index-tools-mcp) usa
`httpx2`, no el httpx clásico — el `http_client` de BasicMCPClient está tipado
como `httpx2.AsyncClient`. Por eso SigV4Auth extiende `httpx2.Auth`, mientras
que la tool de usuario usa `httpx` clásico como el resto del ecosistema
llama-index. Misma API, distinto import.
"""

import logging

import boto3
import botocore.auth
import httpx
import httpx2
from botocore.awsrequest import AWSRequest
from llama_index.core.tools import FunctionTool
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

logger = logging.getLogger(__name__)

MENSAJE_NO_AUTENTICADO = (
    "El usuario no está autenticado para consultar sus pedidos."
)
MENSAJE_ERROR_PEDIDOS = (
    "No pude consultar los pedidos en este momento; el servicio no respondió."
)

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


async def tools_de_gateway(
    gateway_url: str,
    region: str,
    credenciales=None,
    cliente_factory=BasicMCPClient,
    spec_factory=McpToolSpec,
) -> list:
    """Lista las MCP tools de tenant que expone el AgentCore Gateway.

    Fail-open como los reads del bff: si el gateway no responde o el listado
    falla, el chat sigue sin tools de tenant (lista vacía + log), nunca una
    excepción al turno.
    """
    try:
        credenciales = credenciales or boto3.Session().get_credentials()
        http_client = httpx2.AsyncClient(auth=SigV4Auth(credenciales, region))
        cliente = cliente_factory(gateway_url, http_client=http_client)
        return await spec_factory(cliente).to_tool_list_async()
    except Exception as exc:
        logger.error("No se pudieron listar las tools del gateway: %s", exc)
        return []
