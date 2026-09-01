import json
import logging

from starlette.testclient import TestClient

from agent.costo import UsoTokens
from agent.workflow import LlamadaTool, RespuestaLLM
from server import build_app


class FakeLLM:
    def __init__(self):
        self.visto = None

    async def astream(self, message: str, history: list[dict]):
        self.visto = {"message": message, "history": history}
        for c in ("Hola", " mundo"):
            yield c


class FakeLLMQueFalla:
    """Emite un chunk y después revienta: simula throttling a mitad del stream."""

    async def astream(self, message: str, history: list[dict]):
        yield "Hola"
        raise RuntimeError("throttling simulado")


def client():
    # env inyectado: los tests no dependen de os.environ.
    return TestClient(
        build_app(llm_factory=lambda cfg: FakeLLM(), env={"MODEL_ID": "fake"})
    )


def test_ping_responde_healthy():
    r = client().get("/ping")
    assert r.status_code == 200
    assert r.json() == {"status": "Healthy"}


def test_invocations_streamea_deltas_y_evento_final():
    r = client().post("/invocations", json={"message": "¿hola?", "history": []})
    assert r.status_code == 200
    # Este header es el gatillo del streaming en AgentCore: sin él, el Runtime
    # podría bufferear la respuesta entera antes de relayarla.
    assert r.headers["content-type"].startswith("text/event-stream")

    eventos = [
        json.loads(line[len("data: ") :])
        for line in r.text.splitlines()
        if line.startswith("data: ")
    ]
    assert eventos == [
        {"type": "delta", "text": "Hola"},
        {"type": "delta", "text": " mundo"},
        {"type": "done", "text": "Hola mundo"},
    ]


def test_invocations_rechaza_payload_sin_mensaje():
    r = client().post("/invocations", json={"history": []})
    assert r.status_code == 400
    assert "message" in r.json()["error"]


def test_invocations_corta_con_evento_de_error_si_el_workflow_falla_a_mitad_del_stream():
    app = build_app(llm_factory=lambda cfg: FakeLLMQueFalla(), env={"MODEL_ID": "fake"})
    r = TestClient(app).post("/invocations", json={"message": "¿hola?", "history": []})
    assert r.status_code == 200

    eventos = [
        json.loads(line[len("data: ") :])
        for line in r.text.splitlines()
        if line.startswith("data: ")
    ]
    assert eventos == [
        {"type": "delta", "text": "Hola"},
        {"type": "error", "code": "agent_error"},
    ]


def test_el_historial_llega_en_el_payload():
    # El core no habla con ningún store: el historial lo arma el worker desde
    # MessagesTable y viaja en el payload del invoke.
    llm = FakeLLM()
    c = TestClient(build_app(llm_factory=lambda cfg: llm, env={"MODEL_ID": "fake"}))
    historial = [
        {"role": "user", "content": "previo"},
        {"role": "assistant", "content": "respondido"},
    ]
    r = c.post(
        "/invocations",
        json={"message": "hola", "sessionId": "s1", "userId": "u1", "history": historial},
    )
    assert r.status_code == 200
    assert llm.visto["history"] == historial


def test_sin_historial_en_el_payload_el_turno_arranca_limpio():
    llm = FakeLLM()
    c = TestClient(build_app(llm_factory=lambda cfg: llm, env={"MODEL_ID": "fake"}))
    r = c.post("/invocations", json={"message": "hola", "sessionId": "s1", "userId": "u1"})
    assert r.status_code == 200
    assert llm.visto["history"] == []


# --- tools por request ---


def texto_del_done(respuesta) -> str:
    eventos = [
        json.loads(line[len("data: ") :])
        for line in respuesta.text.splitlines()
        if line.startswith("data: ")
    ]
    (done,) = [e for e in eventos if e["type"] == "done"]
    return done["text"]


class FakeLLMSoloTools:
    """Doble que solo sabe responder por el camino de tools."""

    async def aresponder_con_tools(self, message, history, tools):
        return RespuestaLLM(texto="listo", llamadas=[])


def test_el_acttoken_del_payload_llega_a_las_tools_de_usuario():
    visto = {}

    def factory(base_url, act_token):
        visto.update(base_url=base_url, act_token=act_token)
        return []

    app = build_app(
        llm_factory=lambda cfg: FakeLLM(),
        env={"MODEL_ID": "fake", "CLIENT_API_URL": "http://api.cliente"},
        tools_usuario_factory=factory,
    )
    r = TestClient(app).post("/invocations", json={"message": "hola", "actToken": "tok-123"})

    assert r.status_code == 200
    assert visto == {"base_url": "http://api.cliente", "act_token": "tok-123"}


def test_sin_client_api_url_no_se_arman_tools_de_usuario():
    llamados = []

    def factory(base_url, act_token):
        llamados.append(base_url)
        return []

    app = build_app(
        llm_factory=lambda cfg: FakeLLM(),
        env={"MODEL_ID": "fake"},
        tools_usuario_factory=factory,
    )
    assert TestClient(app).post("/invocations", json={"message": "hola"}).status_code == 200
    assert llamados == []


def test_las_tools_del_gateway_se_cachean_tras_la_primera_lista_exitosa():
    from llama_index.core.tools import FunctionTool

    async def catalogo() -> str:
        """Catálogo del tenant."""
        return "catálogo"

    tool_catalogo = FunctionTool.from_defaults(
        async_fn=catalogo, name="listar_catalogo", description="Catálogo del tenant."
    )
    llamados = []

    async def gateway_factory(url, region):
        llamados.append((url, region))
        return [tool_catalogo]

    app = build_app(
        llm_factory=lambda cfg: FakeLLMSoloTools(),
        env={"MODEL_ID": "fake", "GATEWAY_URL": "https://gw/mcp", "AWS_REGION": "us-east-1"},
        tools_gateway_factory=gateway_factory,
    )
    c = TestClient(app)
    assert texto_del_done(c.post("/invocations", json={"message": "hola"})) == "listo"
    assert texto_del_done(c.post("/invocations", json={"message": "otra"})) == "listo"
    # Una lista por microVM, no por turno.
    assert llamados == [("https://gw/mcp", "us-east-1")]


def test_una_lista_vacia_del_gateway_no_se_cachea_y_el_chat_sigue():
    llamados = []

    async def gateway_factory(url, region):
        llamados.append(url)
        return []  # el fail-open de tools_de_gateway devuelve lista vacía

    app = build_app(
        llm_factory=lambda cfg: FakeLLM(),
        env={"MODEL_ID": "fake", "GATEWAY_URL": "https://gw/mcp"},
        tools_gateway_factory=gateway_factory,
    )
    c = TestClient(app)
    # Sin tools el turno sale por el camino de streaming.
    assert texto_del_done(c.post("/invocations", json={"message": "hola"})) == "Hola mundo"
    assert texto_del_done(c.post("/invocations", json={"message": "otra"})) == "Hola mundo"
    # El fallo no queda cacheado: la próxima request vuelve a intentar.
    assert llamados == ["https://gw/mcp", "https://gw/mcp"]


def test_fake_llm_con_tools_recorre_el_loop_sin_bedrock_ni_red():
    # FAKE_LLM + "pedido" simula la tool call a mis_pedidos. Sin actToken la
    # tool real responde no-autenticado SIN tocar la red: el loop entero corre
    # local.
    app = build_app(env={"MODEL_ID": "fake", "FAKE_LLM": "1", "CLIENT_API_URL": "http://api.cliente"})
    r = TestClient(app).post("/invocations", json={"message": "¿dónde está mi pedido?"})

    assert r.status_code == 200
    assert "no está autenticado" in texto_del_done(r)


# --- cierre del turno: el log estructurado (observabilidad, spec §17) ---


def log_del_cierre(caplog) -> dict:
    """El único log de cierre de turno, parseado. Falla si hay más de uno."""
    (linea,) = [
        r.getMessage() for r in caplog.records if '"evento": "turno_cerrado"' in r.getMessage()
    ]
    return json.loads(linea)


class FakeLLMConUso:
    """Doble que expone el uso del turno, como hace BedrockAdapter."""

    def __init__(self):
        self.uso_del_turno = UsoTokens(
            entrada=1200, salida=300, cache_lectura=800, cache_escritura=40
        )

    async def astream(self, message: str, history: list[dict]):
        yield "Hola"
        yield " mundo"


def test_el_cierre_del_turno_se_loguea_en_una_linea_json_sin_texto_de_la_conversacion(caplog):
    app = build_app(
        llm_factory=lambda cfg: FakeLLMConUso(),
        env={"MODEL_ID": "fake", "AWS_REGION": "us-east-1"},
        # El estimador se inyecta: los tests no pegan a la Pricing API.
        estimador_de_costo=lambda uso, model_id, region: 0.0126,
    )
    with caplog.at_level(logging.INFO):
        r = TestClient(app).post(
            "/invocations",
            json={"message": "¿cuánto sale el envío a Córdoba?", "sessionId": "s-9"},
        )

    assert r.status_code == 200
    assert log_del_cierre(caplog) == {
        "evento": "turno_cerrado",
        "sessionId": "s-9",
        "modelo": "fake",
        "tokensEntrada": 1200,
        "tokensSalida": 300,
        "tokensCacheLectura": 800,
        "tokensCacheEscritura": 40,
        "costoUsd": 0.0126,
        "intentoEscalamiento": False,
    }
    # Ni la pregunta ni la respuesta viajan en el log: es lo que hace consultable
    # la métrica sin exponer la conversación.
    assert "Córdoba" not in caplog.text
    assert "mundo" not in caplog.text


def test_sin_uso_reportado_el_turno_se_cierra_igual_con_tokens_en_cero(caplog):
    # FakeLLM no expone `uso_del_turno` (ni el modo local, ni un proveedor que no
    # lo reporte): el log sale igual, sin costo.
    app = build_app(llm_factory=lambda cfg: FakeLLM(), env={"MODEL_ID": "fake"})
    with caplog.at_level(logging.INFO):
        r = TestClient(app).post("/invocations", json={"message": "hola", "sessionId": "s-1"})

    assert r.status_code == 200
    datos = log_del_cierre(caplog)
    assert datos["tokensEntrada"] == 0
    assert datos["costoUsd"] is None


def test_el_turno_se_cierra_con_log_aunque_el_workflow_falle(caplog):
    app = build_app(llm_factory=lambda cfg: FakeLLMQueFalla(), env={"MODEL_ID": "fake"})
    with caplog.at_level(logging.INFO):
        r = TestClient(app).post("/invocations", json={"message": "hola", "sessionId": "s-2"})

    assert r.status_code == 200
    assert log_del_cierre(caplog)["sessionId"] == "s-2"


def test_el_log_marca_el_escalamiento_cuando_el_agente_usa_esa_tool(caplog):
    from llama_index.core.tools import FunctionTool

    async def escalar() -> str:
        """Deriva la conversación a una persona."""
        return "escalamiento ACME-42 creado"

    # El Gateway prefija las tools con el nombre del target: el core reconoce el
    # escalamiento por el sufijo, no por el nombre pelado.
    tool = FunctionTool.from_defaults(
        async_fn=escalar,
        name="acme___escalar_a_humano",
        description="Deriva la conversación a una persona.",
    )

    class FakeLLMQueEscala:
        def __init__(self):
            self.rondas = 0

        async def aresponder_con_tools(self, message, history, tools):
            self.rondas += 1
            if self.rondas == 1:
                return RespuestaLLM(
                    texto=None,
                    llamadas=[
                        LlamadaTool(id="e1", nombre="acme___escalar_a_humano", argumentos={})
                    ],
                )
            return RespuestaLLM(texto="Ya derivé tu caso.", llamadas=[])

    async def gateway_factory(url, region):
        return [tool]

    app = build_app(
        llm_factory=lambda cfg: FakeLLMQueEscala(),
        env={"MODEL_ID": "fake", "GATEWAY_URL": "https://gw/mcp"},
        tools_gateway_factory=gateway_factory,
    )
    with caplog.at_level(logging.INFO):
        r = TestClient(app).post(
            "/invocations", json={"message": "quiero hablar con alguien", "sessionId": "s-3"}
        )

    assert r.status_code == 200
    assert log_del_cierre(caplog)["intentoEscalamiento"] is True
    # El resultado de la tool tampoco sale en el log.
    assert "ACME-42" not in caplog.text
