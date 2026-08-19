import json

from starlette.testclient import TestClient

from server import build_app


class FakeLLM:
    async def astream(self, message: str, history: list[dict]):
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
