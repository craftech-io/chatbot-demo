import asyncio

from llama_index.core.base.llms.types import ChatMessage, ChatResponse
from llama_index.core.llms.llm import ToolSelection

from agent.config import load_config
from agent.llm import BedrockAdapter
from agent.workflow import LlamadaTool

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
            # El chunk de delta="" en el medio pinea el filtro de deltas vacíos:
            # Bedrock a veces emite un chunk sin texto (metadata pura) a mitad
            # del stream, y no debería colarse como un "" en la salida.
            secuencia = [
                ("Hola", "Hola"),
                ("Hola", ""),
                ("Hola mundo", " mundo"),
            ]
            for texto, delta in secuencia:
                yield ChatResponse(
                    message=ChatMessage(role="assistant", content=texto),
                    delta=delta,
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

    # El timeout es la aserción: un stream que no cierra colgaría el turno.
    deltas = await asyncio.wait_for(recolectar(), timeout=5)
    assert deltas == ["Hola", " mundo"]


async def test_manda_el_historial_antes_del_mensaje_nuevo():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)
    history = [{"role": "user", "content": "previo"}, {"role": "assistant", "content": "ok"}]

    async for _ in adapter.astream("nuevo", history):
        pass

    roles = [(m.role, m.content) for m in adapter.client.recibido]
    assert roles == [("user", "previo"), ("assistant", "ok"), ("user", "nuevo")]


def test_no_manda_claves_de_guardrail_si_no_hay_guardrail_configurado():
    env_sin_guardrail = {
        "MODEL_ID": "us.anthropic.claude-sonnet-4-6",
        "AWS_REGION": "us-east-1",
    }
    BedrockAdapter(load_config(env_sin_guardrail), client_factory=FakeConverse)
    assert FakeConverse.kwargs["model"] == "us.anthropic.claude-sonnet-4-6"
    assert FakeConverse.kwargs["region_name"] == "us-east-1"
    assert "guardrail_identifier" not in FakeConverse.kwargs
    assert "guardrail_version" not in FakeConverse.kwargs
    assert "guardrail_stream_processing_mode" not in FakeConverse.kwargs


# --- camino con tools ---


class FakeConverseConTools:
    """Doble del camino con tools de BedrockConverse: achat_with_tools +
    get_tool_calls_from_response, como los usa el adaptador."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.selecciones: list[ToolSelection] = []
        self.texto = ""
        self.visto: dict = {}

    async def achat_with_tools(self, tools, user_msg=None, chat_history=None, **kw):
        self.visto = {"tools": tools, "user_msg": user_msg, "chat_history": chat_history}
        return ChatResponse(message=ChatMessage(role="assistant", content=self.texto))

    def get_tool_calls_from_response(self, respuesta, error_on_no_tool_call=True, **kw):
        assert error_on_no_tool_call is False  # sin tool calls NO es un error
        return self.selecciones


async def test_con_tools_manda_el_mensaje_y_mapea_las_tool_calls():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)
    adapter.client.selecciones = [
        ToolSelection(tool_id="t1", tool_name="mis_pedidos", tool_kwargs={})
    ]

    texto, llamadas = await adapter.aresponder_con_tools("¿mi pedido?", [], tools=["tool-a"])

    # Sin contenido de texto el adaptador normaliza a None (no "").
    assert texto is None
    assert llamadas == [LlamadaTool(id="t1", nombre="mis_pedidos", argumentos={})]
    assert adapter.client.visto["user_msg"] == "¿mi pedido?"
    assert adapter.client.visto["tools"] == ["tool-a"]


async def test_en_rondas_siguientes_no_repite_el_mensaje_y_traduce_el_turno():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)
    adapter.client.texto = "Tu pedido está en camino."
    # El history que arma el workflow tras ejecutar una tool: la pregunta ya
    # está adentro, así que repetirla como user_msg duplicaría el mensaje
    # DESPUÉS del resultado de la tool (orden inválido para Converse).
    history = [
        {"role": "user", "content": "¿mi pedido?"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "t1", "nombre": "mis_pedidos", "argumentos": {}}],
        },
        {"role": "tool", "content": "A-1001 en camino", "tool_call_id": "t1"},
    ]

    texto, llamadas = await adapter.aresponder_con_tools("¿mi pedido?", history, tools=[])

    assert texto == "Tu pedido está en camino."
    assert llamadas == []
    assert adapter.client.visto["user_msg"] is None
    mensajes = adapter.client.visto["chat_history"]
    # Traducción al formato que messages_to_converse_messages espera:
    # toolUseId/name/input en el asistente y tool_call_id en el mensaje tool.
    assert mensajes[1].additional_kwargs["tool_calls"] == [
        {"toolUseId": "t1", "name": "mis_pedidos", "input": {}}
    ]
    assert mensajes[2].role == "tool"
    assert mensajes[2].additional_kwargs["tool_call_id"] == "t1"


# --- prompt del sistema (env PROMPT_SISTEMA, ver infra/CONTRACT.md) ---

PROMPT = "Sos el asistente de Acme. No inventes: citá los documentos."
ENV_CON_PROMPT = ENV | {"PROMPT_SISTEMA": PROMPT}


async def test_el_prompt_del_sistema_abre_la_lista_de_mensajes_en_el_stream():
    adapter = BedrockAdapter(load_config(ENV_CON_PROMPT), client_factory=FakeConverse)
    history = [{"role": "user", "content": "previo"}, {"role": "assistant", "content": "ok"}]

    async for _ in adapter.astream("nuevo", history):
        pass

    assert [(m.role, m.content) for m in adapter.client.recibido] == [
        ("system", PROMPT),
        ("user", "previo"),
        ("assistant", "ok"),
        ("user", "nuevo"),
    ]


async def test_sin_prompt_del_sistema_el_stream_no_manda_ningun_system():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)

    async for _ in adapter.astream("nuevo", []):
        pass

    assert [m.role for m in adapter.client.recibido] == ["user"]


HISTORY_TRAS_TOOL = [
    {"role": "user", "content": "¿mi pedido?"},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "t1", "nombre": "mis_pedidos", "argumentos": {}}],
    },
    {"role": "tool", "content": "A-1001 en camino", "tool_call_id": "t1"},
]


async def test_el_prompt_del_sistema_va_primero_en_el_camino_con_tools():
    adapter = BedrockAdapter(load_config(ENV_CON_PROMPT), client_factory=FakeConverseConTools)

    await adapter.aresponder_con_tools("¿mi pedido?", HISTORY_TRAS_TOOL, tools=[])

    mensajes = adapter.client.visto["chat_history"]
    assert mensajes[0].role == "system"
    assert mensajes[0].content == PROMPT
    # El sistema se agrega ANTES del historial y no altera el orden del turno de
    # tools: la pregunta sigue adentro del historial y no se repite como
    # user_msg después del toolResult (orden que Converse no acepta).
    assert [m.role for m in mensajes] == ["system", "user", "assistant", "tool"]
    assert adapter.client.visto["user_msg"] is None


async def test_el_prompt_del_sistema_tambien_va_en_la_primera_ronda_con_tools():
    adapter = BedrockAdapter(load_config(ENV_CON_PROMPT), client_factory=FakeConverseConTools)

    await adapter.aresponder_con_tools("¿mi pedido?", [], tools=["tool-a"])

    mensajes = adapter.client.visto["chat_history"]
    assert [(m.role, m.content) for m in mensajes] == [("system", PROMPT)]
    # En la primera ronda la pregunta viaja como user_msg: el adaptador de
    # LlamaIndex la apendea al final del chat_history, detrás del sistema.
    assert adapter.client.visto["user_msg"] == "¿mi pedido?"


async def test_sin_prompt_del_sistema_el_camino_con_tools_no_manda_ningun_system():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)

    await adapter.aresponder_con_tools("¿mi pedido?", HISTORY_TRAS_TOOL, tools=[])

    mensajes = adapter.client.visto["chat_history"]
    assert [m.role for m in mensajes] == ["user", "assistant", "tool"]


async def test_el_prompt_del_sistema_no_se_acumula_entre_turnos():
    # El adaptador vive un turno o varios: si el mensaje de sistema se guardara
    # en una lista reusada, la segunda ronda mandaría dos.
    adapter = BedrockAdapter(load_config(ENV_CON_PROMPT), client_factory=FakeConverseConTools)

    await adapter.aresponder_con_tools("¿mi pedido?", [], tools=[])
    await adapter.aresponder_con_tools("¿y el otro?", [], tools=[])

    mensajes = adapter.client.visto["chat_history"]
    assert [m.role for m in mensajes] == ["system"]
