from llama_index.core.tools import FunctionTool

from agent.events import TextDelta
from agent.costo import UsoTokens
from agent.workflow import (
    MAX_RONDAS_TOOLS,
    MENSAJE_FALLBACK_TOOLS,
    ChatWorkflow,
    LlamadaTool,
    RespuestaLLM,
)


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
    assert done.texto == "Hola mundo"
    assert llm.seen == {"message": "¿hola?", "history": []}


# --- loop de tools ---


class FakeLLMConTools:
    """Doble del camino con tools: responde según un guion de RespuestaLLM.

    Si el guion se agota, repite la última entrada — sirve para simular un LLM
    que nunca da texto final.
    """

    def __init__(self, guion: list[RespuestaLLM]):
        self.guion = list(guion)
        self.vistos: list[dict] = []

    async def aresponder_con_tools(self, message: str, history: list[dict], tools: list):
        self.vistos.append(
            {"message": message, "history": [dict(h) for h in history], "tools": list(tools)}
        )
        if len(self.guion) > 1:
            return self.guion.pop(0)
        return self.guion[0]


def tool_mis_pedidos():
    async def mis_pedidos() -> str:
        """Consulta los pedidos del usuario."""
        return "A-1001 en camino"

    return FunctionTool.from_defaults(
        async_fn=mis_pedidos, name="mis_pedidos", description="Consulta los pedidos del usuario."
    )


async def test_con_tools_ejecuta_la_llamada_y_el_texto_final_sale_por_chatdone():
    llamada = LlamadaTool(id="t1", nombre="mis_pedidos", argumentos={})
    llm = FakeLLMConTools(
        [
            RespuestaLLM(texto=None, llamadas=[llamada]),
            # El uso de tokens viaja en la respuesta y el workflow lo ignora: lo
            # acumula el adaptador (agent/llm.py), que es quien vive el turno.
            RespuestaLLM(
                texto="Tu pedido A-1001 está en camino.",
                llamadas=[],
                uso=UsoTokens(entrada=500, salida=120),
            ),
        ]
    )
    handler = ChatWorkflow(llm=llm, tools=[tool_mis_pedidos()], timeout=10).run(
        message="¿dónde está mi pedido?", history=[]
    )

    done = await handler

    assert done.texto == "Tu pedido A-1001 está en camino."
    # La segunda ronda ve el turno completo: la pregunta, la tool call del
    # asistente y el resultado como mensaje `tool` — es el contrato con llm.py.
    assert llm.vistos[1]["history"] == [
        {"role": "user", "content": "¿dónde está mi pedido?"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "t1", "nombre": "mis_pedidos", "argumentos": {}}],
        },
        {"role": "tool", "content": "A-1001 en camino", "tool_call_id": "t1"},
    ]


async def test_una_tool_desconocida_no_rompe_el_loop():
    llm = FakeLLMConTools(
        [
            RespuestaLLM(
                texto=None, llamadas=[LlamadaTool(id="t1", nombre="inexistente", argumentos={})]
            ),
            RespuestaLLM(texto="ok", llamadas=[]),
        ]
    )
    handler = ChatWorkflow(llm=llm, tools=[tool_mis_pedidos()], timeout=10).run(
        message="hola", history=[]
    )

    done = await handler

    assert done.texto == "ok"
    resultado_tool = llm.vistos[1]["history"][-1]
    assert resultado_tool["role"] == "tool"
    assert "inexistente" in resultado_tool["content"]


async def test_si_nunca_hay_texto_final_responde_el_fallback_a_las_cuatro_rondas():
    llamada = LlamadaTool(id="t1", nombre="mis_pedidos", argumentos={})
    llm = FakeLLMConTools([RespuestaLLM(texto=None, llamadas=[llamada])])  # nunca da texto final
    handler = ChatWorkflow(llm=llm, tools=[tool_mis_pedidos()], timeout=10).run(
        message="¿mi pedido?", history=[]
    )

    done = await handler

    assert done.texto == MENSAJE_FALLBACK_TOOLS
    assert len(llm.vistos) == MAX_RONDAS_TOOLS == 4


async def test_sin_texto_ni_llamadas_cae_al_fallback_sin_agotar_rondas():
    llm = FakeLLMConTools([RespuestaLLM(texto=None, llamadas=[])])
    handler = ChatWorkflow(llm=llm, tools=[tool_mis_pedidos()], timeout=10).run(
        message="hola", history=[]
    )

    done = await handler

    assert done.texto == MENSAJE_FALLBACK_TOOLS
    assert len(llm.vistos) == 1


async def test_sin_tools_el_workflow_streamea_la_respuesta():
    # Con tools=None ni siquiera se le pide aresponder_con_tools al adaptador:
    # FakeLLM no lo implementa y aun así el turno sale por astream.
    llm = FakeLLM(["igual", " que", " antes"])
    handler = ChatWorkflow(llm=llm, tools=None, timeout=10).run(message="hola", history=[])
    done = await handler
    assert done.texto == "igual que antes"


# --- qué tools se usaron en el turno (para la métrica de derivación, spec §17) ---


async def test_el_evento_final_dice_que_tools_se_ejecutaron():
    llamada = LlamadaTool(id="t1", nombre="mis_pedidos", argumentos={})
    llm = FakeLLMConTools(
        [
            RespuestaLLM(texto=None, llamadas=[llamada]),
            RespuestaLLM(texto="Listo.", llamadas=[]),
        ]
    )
    handler = ChatWorkflow(llm=llm, tools=[tool_mis_pedidos()], timeout=10).run(
        message="¿mi pedido?", history=[]
    )

    done = await handler

    # Nombres, no argumentos ni resultados: el consumidor lo usa para contar, y
    # el contenido de la conversación no sale por acá.
    assert done.tools_usadas == ["mis_pedidos"]


async def test_una_tool_que_no_existe_no_cuenta_como_ejecutada():
    llm = FakeLLMConTools(
        [
            RespuestaLLM(
                texto=None, llamadas=[LlamadaTool(id="t1", nombre="inexistente", argumentos={})]
            ),
            RespuestaLLM(texto="ok", llamadas=[]),
        ]
    )
    handler = ChatWorkflow(llm=llm, tools=[tool_mis_pedidos()], timeout=10).run(
        message="hola", history=[]
    )

    done = await handler

    assert done.tools_usadas == []


async def test_sin_tools_el_evento_final_no_reporta_ninguna_usada():
    handler = ChatWorkflow(llm=FakeLLM(["ok"]), tools=None, timeout=10).run(
        message="hola", history=[]
    )

    done = await handler

    assert done.tools_usadas == []
