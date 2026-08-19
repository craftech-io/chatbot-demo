from agent.events import TextDelta
from agent.workflow import ChatWorkflow


class FakeLLM:
    """Doble del adaptador de LLM: emite chunks fijos."""

    def __init__(self, chunks: list[str]):
        self.chunks = chunks
        self.seen: dict | None = None

    async def astream(self, message: str, history: list[dict]):
        self.seen = {"message": message, "history": history}
        for c in self.chunks:
            yield c


async def test_emite_un_delta_por_chunk_y_devuelve_el_texto_completo():
    llm = FakeLLM(["Hola", " ", "mundo"])
    handler = ChatWorkflow(llm=llm, timeout=10).run(message="¿hola?", history=[])

    deltas = [ev.text async for ev in handler.stream_events() if isinstance(ev, TextDelta)]
    # `await handler` devuelve el ChatDone, NO su `.result`: el framework solo
    # desenvuelve cuando el StopEvent es exactamente StopEvent, jamás un subtipo.
    done = await handler

    assert deltas == ["Hola", " ", "mundo"]
    assert done.result == "Hola mundo"
    assert llm.seen == {"message": "¿hola?", "history": []}
