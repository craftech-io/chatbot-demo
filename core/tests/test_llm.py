import asyncio

from llama_index.core.base.llms.types import ChatMessage, ChatResponse

from agent.config import load_config
from agent.llm import BedrockAdapter

ENV = {
    "MODEL_ID": "us.anthropic.claude-sonnet-4-6",
    "GUARDRAIL_ID": "gr-123",
    "GUARDRAIL_VERSION": "3",
    "AWS_REGION": "us-east-1",
}


class FakeConverse:
    """Doble de BedrockConverse: registra cómo fue construido y qué recibió."""

    kwargs: dict = {}

    def __init__(self, **kwargs):
        FakeConverse.kwargs = kwargs
        self.recibido: list[ChatMessage] = []

    async def astream_chat(self, messages):
        self.recibido = messages

        async def gen():
            for texto in ("Hola", "Hola mundo"):
                yield ChatResponse(
                    message=ChatMessage(role="assistant", content=texto),
                    delta=texto[len("Hola") :] if texto != "Hola" else "Hola",
                )

        return gen()


def test_construye_el_cliente_con_el_guardrail_en_modo_sync():
    BedrockAdapter(load_config(ENV), client_factory=FakeConverse)
    assert FakeConverse.kwargs["model"] == "us.anthropic.claude-sonnet-4-6"
    assert FakeConverse.kwargs["guardrail_identifier"] == "gr-123"
    assert FakeConverse.kwargs["guardrail_version"] == "3"
    assert FakeConverse.kwargs["guardrail_stream_processing_mode"] == "sync"


async def test_emite_deltas_y_el_generador_termina():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)

    async def recolectar():
        return [c async for c in adapter.astream("¿hola?", [])]

    # El timeout es el test: hay bugs conocidos de streams que no cierran.
    deltas = await asyncio.wait_for(recolectar(), timeout=5)
    assert deltas == ["Hola", " mundo"]


async def test_manda_el_historial_antes_del_mensaje_nuevo():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)
    history = [{"role": "user", "content": "previo"}, {"role": "assistant", "content": "ok"}]

    async for _ in adapter.astream("nuevo", history):
        pass

    roles = [(m.role, m.content) for m in adapter.client.recibido]
    assert roles == [("user", "previo"), ("assistant", "ok"), ("user", "nuevo")]
