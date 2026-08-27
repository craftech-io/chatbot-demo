import json

from starlette.testclient import TestClient

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


def test_con_memoria_el_historial_sale_de_memory_y_el_turno_se_persiste():
    class MemoriaFalsa:
        def __init__(self):
            self.turnos = []

        def historial(self, actor_id, session_id):
            self.reclamado = (actor_id, session_id)
            return [{"role": "user", "content": "previo"}]

        def registrar_turno(self, actor_id, session_id, pregunta, respuesta):
            self.turnos.append((actor_id, session_id, pregunta, respuesta))

    llm = FakeLLM()
    mem = MemoriaFalsa()
    c = TestClient(
        build_app(
            llm_factory=lambda cfg: llm,
            env={"MODEL_ID": "fake", "MEMORY_ID": "mem-1"},
            memoria_factory=lambda cfg: mem,
        )
    )
    r = c.post("/invocations", json={"message": "hola", "sessionId": "s1", "userId": "u1"})
    assert r.status_code == 200
    assert mem.reclamado == ("u1", "s1")
    assert mem.turnos == [("u1", "s1", "hola", "Hola mundo")]
    assert llm.visto["history"] == [{"role": "user", "content": "previo"}]


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
        return ("listo", [])


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


def test_fake_llm_con_tools_pinea_el_loop_local_sin_bedrock_ni_red():
    # FAKE_LLM + "pedido" simula la tool call a mis_pedidos. Sin actToken la
    # tool real responde no-autenticado SIN tocar la red: el loop entero corre
    # local.
    app = build_app(env={"MODEL_ID": "fake", "FAKE_LLM": "1", "CLIENT_API_URL": "http://api.cliente"})
    r = TestClient(app).post("/invocations", json={"message": "¿dónde está mi pedido?"})

    assert r.status_code == 200
    assert "no está autenticado" in texto_del_done(r)
