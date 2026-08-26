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


# --- tools_de_gateway (MCP) ---


class SpecFalso:
    """Doble de McpToolSpec: registra el cliente y devuelve tools fijas."""

    ultimo: "SpecFalso | None" = None

    def __init__(self, cliente):
        self.cliente = cliente
        SpecFalso.ultimo = self

    async def to_tool_list_async(self):
        return ["tool-mcp"]


class ClienteMCPFalso:
    """Doble de BasicMCPClient: registra la URL y el http_client firmante."""

    ultimo: "ClienteMCPFalso | None" = None

    def __init__(self, url, http_client=None):
        self.url = url
        self.http_client = http_client
        ClienteMCPFalso.ultimo = self


async def test_tools_de_gateway_lista_via_mcp_con_sigv4():
    tools = await tools_de_gateway(
        "https://gw/mcp",
        "us-east-1",
        credenciales=Credentials("AKIAEJEMPLO", "secreto"),
        cliente_factory=ClienteMCPFalso,
        spec_factory=SpecFalso,
    )

    assert tools == ["tool-mcp"]
    cliente = ClienteMCPFalso.ultimo
    assert cliente.url == "https://gw/mcp"
    # El http_client que se le pasa al cliente MCP firma cada request con SigV4.
    assert isinstance(cliente.http_client.auth, SigV4Auth)
    assert SpecFalso.ultimo.cliente is cliente


async def test_tools_de_gateway_falla_abierto_con_lista_vacia():
    def factory_que_falla(url, http_client=None):
        raise RuntimeError("gateway caído")

    tools = await tools_de_gateway(
        "https://gw/mcp",
        "us-east-1",
        credenciales=Credentials("AKIAEJEMPLO", "secreto"),
        cliente_factory=factory_que_falla,
    )
    # El chat sigue sin tools de tenant, como los reads fail-open del bff.
    assert tools == []
