"""Tests de las tools del agente: las de usuario (HTTP con actToken) y las de
tenant (MCP vía Gateway con SigV4).

Estilo de la casa: nada de mocks de librería — los clientes HTTP/MCP se
inyectan por factory, igual que `client_factory` en llm.py. La firma SigV4 se
prueba con botocore REAL (sin red): firmar es un cálculo puro.
"""

import httpx2
from botocore.credentials import Credentials

from agent.tools import (
    MENSAJE_ERROR_PEDIDOS,
    MENSAJE_ERROR_TOOL_TENANT,
    MENSAJE_NO_AUTENTICADO,
    SigV4Auth,
    crear_tools_usuario,
    tools_de_gateway,
)


class RespuestaFalsa:
    def __init__(self, texto: str, status: int = 200):
        self.text = texto
        self.status = status

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")


class ClienteHttpFalso:
    """Doble de httpx.AsyncClient: registra el GET; opcionalmente falla."""

    def __init__(self, respuesta: RespuestaFalsa | None = None, falla: bool = False):
        self.respuesta = respuesta or RespuestaFalsa('{"pedidos": []}')
        self.falla = falla
        self.visto: tuple | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None):
        if self.falla:
            raise RuntimeError("red caída")
        self.visto = (url, headers)
        return self.respuesta


# --- mis_pedidos (tool de usuario) ---


async def test_sin_token_responde_no_autenticado_y_no_toca_la_red():
    creados: list = []

    def factory(**kwargs):
        creados.append(kwargs)
        return ClienteHttpFalso()

    (tool,) = crear_tools_usuario("http://api.cliente", None, client_factory=factory)

    assert tool.metadata.name == "mis_pedidos"
    resultado = str(await tool.acall())
    assert resultado == MENSAJE_NO_AUTENTICADO
    # NUNCA un request sin token: ni siquiera se construye el cliente HTTP.
    assert creados == []


async def test_con_token_hace_el_get_con_el_bearer_y_timeout():
    cliente = ClienteHttpFalso(RespuestaFalsa('{"pedidos": [{"id": "A-1001"}]}'))
    kwargs_del_factory: dict = {}

    def factory(**kwargs):
        kwargs_del_factory.update(kwargs)
        return cliente

    (tool,) = crear_tools_usuario("http://api.cliente", "tok-abc", client_factory=factory)

    resultado = str(await tool.acall())
    assert resultado == '{"pedidos": [{"id": "A-1001"}]}'
    url, headers = cliente.visto
    assert url == "http://api.cliente/pedidos"
    assert headers["Authorization"] == "Bearer tok-abc"
    assert kwargs_del_factory["timeout"] == 10


async def test_error_de_red_devuelve_un_mensaje_humano_y_no_una_excepcion():
    (tool,) = crear_tools_usuario(
        "http://api.cliente", "tok-abc", client_factory=lambda **kw: ClienteHttpFalso(falla=True)
    )
    assert str(await tool.acall()) == MENSAJE_ERROR_PEDIDOS


async def test_respuesta_http_de_error_tambien_cae_al_mensaje_humano():
    cliente = ClienteHttpFalso(RespuestaFalsa('{"error": "falta el token"}', status=401))
    (tool,) = crear_tools_usuario(
        "http://api.cliente", "tok-vencido", client_factory=lambda **kw: cliente
    )
    assert str(await tool.acall()) == MENSAJE_ERROR_PEDIDOS


# --- SigV4Auth (firma de requests al gateway) ---


def test_sigv4_firma_el_request_con_la_region_y_el_servicio():
    auth = SigV4Auth(Credentials("AKIAEJEMPLO", "secreto"), region="us-east-1")
    request = httpx2.Request(
        "POST", "https://gw.example.com/mcp", content=b'{"method": "tools/list"}'
    )

    firmado = next(auth.auth_flow(request))

    autorizacion = firmado.headers["Authorization"]
    assert autorizacion.startswith("AWS4-HMAC-SHA256")
    assert "us-east-1/bedrock-agentcore/aws4_request" in autorizacion
    assert firmado.headers.get("X-Amz-Date")


def test_sigv4_pide_el_cuerpo_del_request_para_firmarlo():
    # Sin esto httpx entrega el request sin contenido y la firma no matchea.
    assert SigV4Auth.requires_request_body is True


# --- tools_de_gateway (MCP directo contra el Gateway) ---
#
# Por qué MCP directo y no llama-index-tools-mcp: esa librería (0.5.0) desempaca
# 3 valores del transporte streamable-http mientras `mcp` 2.x yieldea 2
# ("not enough values to unpack") — está rota contra TODA la línea 2.x (2.0.0,
# 2.0.1, 2.1.0, 2.1.1). El cliente oficial es estable y la superficie necesaria
# es chica: list_tools + call_tool.


class SesionFalsa:
    """Doble de ClientSession ya inicializada: registra las llamadas."""

    def __init__(self, tools, salida="{}", falla_call=False):
        self._tools = tools
        self._salida = salida
        self._falla_call = falla_call
        self.llamadas: list[tuple] = []

    async def list_tools(self):
        class Listado:
            def __init__(self, tools):
                self.tools = tools

        return Listado(self._tools)

    async def call_tool(self, nombre, argumentos):
        self.llamadas.append((nombre, argumentos))
        if self._falla_call:
            raise RuntimeError("el gateway cortó la llamada")

        class Contenido:
            def __init__(self, texto):
                self.text = texto

        class Salida:
            def __init__(self, texto):
                self.content = [Contenido(texto)]

        return Salida(self._salida)


class ToolMcpFalsa:
    def __init__(self, name, description="", input_schema=None):
        self.name = name
        self.description = description
        self.input_schema = input_schema


def factory_de_sesion(sesion):
    """Devuelve un sesion_factory (async context manager) que rinde `sesion`."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def factory(gateway_url, region, credenciales):
        factory.vista = (gateway_url, region, credenciales)
        yield sesion

    factory.vista = None
    return factory


async def test_tools_de_gateway_envuelve_las_tools_del_listado():
    credenciales = Credentials("AKIAEJEMPLO", "secreto")
    sesion = SesionFalsa(
        [
            ToolMcpFalsa("api-cliente___listar_catalogo", "Lista el catálogo"),
            ToolMcpFalsa(
                "api-cliente___buscar",
                "Busca por nombre",
                {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
            ),
        ]
    )
    factory = factory_de_sesion(sesion)

    tools = await tools_de_gateway(
        "https://gw/mcp", "us-east-1", credenciales=credenciales, sesion_factory=factory
    )

    assert [t.metadata.name for t in tools] == [
        "api-cliente___listar_catalogo",
        "api-cliente___buscar",
    ]
    # El parámetro del schema MCP viaja al schema que ve el LLM.
    assert "q" in tools[1].metadata.fn_schema.model_fields
    # Credentials no define igualdad: se compara identidad (mismas credenciales
    # relevadas al factory, sin re-resolverlas por tool).
    assert factory.vista == ("https://gw/mcp", "us-east-1", credenciales)


async def test_tool_envuelta_llama_al_gateway_y_devuelve_el_texto():
    sesion = SesionFalsa(
        [ToolMcpFalsa("api-cliente___listar_catalogo")], salida='{"productos": []}'
    )
    tools = await tools_de_gateway(
        "https://gw/mcp", "us-east-1", credenciales=None, sesion_factory=factory_de_sesion(sesion)
    )

    resultado = await tools[0].acall()

    assert str(resultado) == '{"productos": []}'
    assert sesion.llamadas == [("api-cliente___listar_catalogo", {})]


async def test_tool_envuelta_falla_abierto_con_mensaje_humano():
    sesion = SesionFalsa([ToolMcpFalsa("api-cliente___listar_catalogo")], falla_call=True)
    tools = await tools_de_gateway(
        "https://gw/mcp", "us-east-1", credenciales=None, sesion_factory=factory_de_sesion(sesion)
    )

    # La tool que revienta no tumba el turno: el agente recibe un texto y lo explica.
    assert str(await tools[0].acall()) == MENSAJE_ERROR_TOOL_TENANT


async def test_tools_de_gateway_falla_abierto_con_lista_vacia():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def factory_que_falla(gateway_url, region, credenciales):
        raise RuntimeError("gateway caído")
        yield  # pragma: no cover

    tools = await tools_de_gateway(
        "https://gw/mcp",
        "us-east-1",
        credenciales=Credentials("AKIAEJEMPLO", "secreto"),
        sesion_factory=factory_que_falla,
    )
    # El chat sigue sin tools de tenant y el turno no revienta.
    assert tools == []
