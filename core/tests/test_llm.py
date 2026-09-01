import asyncio

from llama_index.core.base.llms.types import ChatMessage, ChatResponse
from llama_index.core.llms.llm import ToolSelection

from agent.config import load_config
from agent.costo import UsoTokens
from agent.llm import BedrockAdapter
from agent.workflow import LlamadaTool

ENV = {
    "MODEL_ID": "us.anthropic.claude-sonnet-4-6",
    "GUARDRAIL_ID": "gr-123",
    "GUARDRAIL_VERSION": "3",
    "AWS_REGION": "us-east-1",
}


# Lo que `_get_response_token_counts` de bedrock_converse pone en
# `additional_kwargs` del chunk de metadata (nombres de LlamaIndex, no de la API
# de Converse).
USO_DEL_STREAM = {
    "prompt_tokens": 1200,
    "completion_tokens": 300,
    "total_tokens": 1500,
    "cache_read_input_tokens": 800,
    "cache_creation_input_tokens": 40,
}


class FakeConverse:
    """Doble de BedrockConverse: registra cómo fue construido y qué recibió."""

    kwargs: dict = {}
    # Puesto en False, el stream termina sin chunk de metadata: el proveedor no
    # reportó el uso de tokens.
    con_uso = True

    def __init__(self, **kwargs):
        FakeConverse.kwargs = kwargs
        self.recibido: list[ChatMessage] = []
        self.con_uso = FakeConverse.con_uso

    async def astream_chat(self, messages):
        self.recibido = messages
        con_uso = self.con_uso

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
            if con_uso:
                # El chunk final del stream real: `delta=""` y el uso de tokens
                # en additional_kwargs. Es el que el guard de deltas descartaba.
                yield ChatResponse(
                    message=ChatMessage(role="assistant", content="Hola mundo"),
                    delta="",
                    additional_kwargs=dict(USO_DEL_STREAM),
                )

        return gen()


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
        # Igual que en el stream, pero sin chunks: achat lo pone directo en la
        # respuesta. Un dict vacío = el proveedor no reportó uso.
        self.uso: dict = {"prompt_tokens": 500, "completion_tokens": 120}

    async def achat_with_tools(self, tools, user_msg=None, chat_history=None, **kw):
        # `chat_history` se guarda como COPIA: es lo que el adaptador mandó en
        # esta llamada, y abajo mutamos la lista real.
        self.visto = {"tools": tools, "user_msg": user_msg, "chat_history": list(chat_history)}
        # MUTA la lista recibida, igual que `_prepare_chat_with_tools` de
        # LlamaIndex, que apendea el `user_msg` a la `chat_history` que le pasan.
        # Sin esto, un adaptador que compartiera la lista entre turnos pasaría
        # el test de acumulación sin que nada lo delate.
        if user_msg is not None:
            chat_history.append(ChatMessage(role="user", content=user_msg))
        return ChatResponse(
            message=ChatMessage(role="assistant", content=self.texto),
            additional_kwargs=dict(self.uso),
        )

    def get_tool_calls_from_response(self, respuesta, error_on_no_tool_call=True, **kw):
        assert error_on_no_tool_call is False  # sin tool calls NO es un error
        return self.selecciones


async def test_con_tools_manda_el_mensaje_y_mapea_las_tool_calls():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)
    adapter.client.selecciones = [
        ToolSelection(tool_id="t1", tool_name="mis_pedidos", tool_kwargs={})
    ]

    respuesta = await adapter.aresponder_con_tools("¿mi pedido?", [], tools=["tool-a"])

    # Sin contenido de texto el adaptador normaliza a None (no "").
    assert respuesta.texto is None
    assert respuesta.llamadas == [LlamadaTool(id="t1", nombre="mis_pedidos", argumentos={})]
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

    respuesta = await adapter.aresponder_con_tools("¿mi pedido?", history, tools=[])

    assert respuesta.texto == "Tu pedido está en camino."
    assert respuesta.llamadas == []
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
    """El adaptador vive varios turnos: `_mensajes_iniciales` devuelve una lista
    NUEVA cada vez, y este test cubre las dos formas de que eso se rompa.

    1. Por el propio adaptador: `astream` hace `messages += [...]`, que MUTA la
       lista devuelta por `_mensajes_iniciales`. Si esa lista fuera cacheada, el
       segundo turno mandaría el `system` dos veces.
    2. Por el cliente: `_prepare_chat_with_tools` de LlamaIndex APENDEA el
       `user_msg` a la `chat_history` que recibe — `FakeConverseConTools` hace lo
       mismo a propósito—, así que una lista compartida crecería turno a turno.
    """
    en_stream = BedrockAdapter(load_config(ENV_CON_PROMPT), client_factory=FakeConverse)
    for pregunta in ("nueva", "y otra"):
        async for _ in en_stream.astream(pregunta, []):
            pass
    assert [m.role for m in en_stream.client.recibido] == ["system", "user"]

    con_tools = BedrockAdapter(load_config(ENV_CON_PROMPT), client_factory=FakeConverseConTools)
    await con_tools.aresponder_con_tools("¿mi pedido?", [], tools=[])
    await con_tools.aresponder_con_tools("¿y el otro?", [], tools=[])
    assert [m.role for m in con_tools.client.visto["chat_history"]] == ["system"]


# --- uso de tokens (observabilidad, spec §17) ---


async def test_el_chunk_de_metadata_deja_el_uso_y_no_emite_texto_vacio():
    """El chunk que trae los tokens es el que tiene `delta=""`: se lee sin
    emitirlo, así que el consumidor del generador ve exactamente lo de antes."""
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)

    deltas = [c async for c in adapter.astream("¿hola?", [])]

    assert deltas == ["Hola", " mundo"]
    assert adapter.uso_del_turno == UsoTokens(
        entrada=1200, salida=300, cache_lectura=800, cache_escritura=40
    )


async def test_sin_chunk_de_metadata_el_uso_queda_en_none():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)
    adapter.client.con_uso = False

    deltas = [c async for c in adapter.astream("¿hola?", [])]

    assert deltas == ["Hola", " mundo"]
    # None, no un uso en cero: "no lo sabemos" y "no gastó tokens" no son lo mismo.
    assert adapter.uso_del_turno is None


async def test_con_tools_el_uso_vuelve_en_la_respuesta_y_queda_en_el_adaptador():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)

    respuesta = await adapter.aresponder_con_tools("¿mi pedido?", [], tools=["tool-a"])

    assert respuesta.uso == UsoTokens(entrada=500, salida=120)
    assert adapter.uso_del_turno == respuesta.uso


async def test_el_uso_se_acumula_entre_las_rondas_del_turno():
    # El adaptador vive UN turno (server.py arma uno por request), así que lo
    # que acumula es el uso del turno: el loop de tools llama al modelo varias veces.
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)

    await adapter.aresponder_con_tools("¿mi pedido?", [], tools=["tool-a"])
    await adapter.aresponder_con_tools("¿mi pedido?", HISTORY_TRAS_TOOL, tools=["tool-a"])

    assert adapter.uso_del_turno == UsoTokens(entrada=1000, salida=240)


async def test_una_respuesta_sin_uso_no_inventa_tokens():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverseConTools)
    adapter.client.uso = {}

    respuesta = await adapter.aresponder_con_tools("¿mi pedido?", [], tools=["tool-a"])

    assert respuesta.uso is None
    assert adapter.uso_del_turno is None
