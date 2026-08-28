"""El harness: el loop del agente como grafo de pasos y eventos explícito.

Que sea un Workflow y no un loop opaco es lo que lo hace testeable paso a paso:
cada step se prueba por los eventos que emite, con dobles de LLM y de tools.
"""

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from workflows import Context, Workflow, step

from .costo import UsoTokens
from .events import ChatDone, ChatStart, TextDelta

logger = logging.getLogger(__name__)

# El loop de tools es acotado por diseño: un modelo que encadena llamadas sin
# cerrar la respuesta no puede colgar el turno.
MAX_RONDAS_TOOLS = 4

MENSAJE_FALLBACK_TOOLS = (
    "No pude completar la consulta con las herramientas disponibles. "
    "¿Podés intentarlo de nuevo o reformular la pregunta?"
)


@dataclass(frozen=True)
class LlamadaTool:
    """Una tool call que el modelo pidió ejecutar (neutral al proveedor)."""

    id: str
    nombre: str
    argumentos: dict


@dataclass(frozen=True)
class RespuestaLLM:
    """Lo que devuelve una ronda del camino con tools.

    Era una tupla `(texto, llamadas)`; el uso de tokens habría hecho una tupla de
    tres, así que pasó a dataclass.

    `uso` es el uso de ESA llamada al modelo (None si el proveedor no lo
    reportó). El workflow no lo mira: el turno completo lo acumula el adaptador
    (`uso_del_turno` en agent/llm.py), que es el que sabe traducir lo que reporta
    su proveedor. Viaja acá igual para que el contrato sea explícito.
    """

    texto: str | None
    llamadas: list[LlamadaTool]
    uso: UsoTokens | None = None


class AdaptadorLLM(Protocol):
    """El workflow no conoce Bedrock: solo este protocolo (duck typing). Lo
    implementa agent/llm.py y, en los tests, los dobles de LLM."""

    def astream(self, message: str, history: list[dict]) -> AsyncIterator[str]: ...

    async def aresponder_con_tools(
        self, message: str, history: list[dict], tools: list
    ) -> RespuestaLLM:
        """Opcional: solo se invoca cuando el workflow recibió tools.

        El history usa el formato de dicts neutral, extendido para el turno con
        tools: `tool_calls` (lista de {id, nombre, argumentos}) en mensajes
        assistant y `tool_call_id` en mensajes con role `tool`.
        """
        ...


class ChatWorkflow(Workflow):
    def __init__(self, llm: AdaptadorLLM, tools: list | None = None, **kwargs):
        # `llm` es el adaptador de modelo (agent/llm.py) o un doble en los tests.
        # `tools` son BaseTool de LlamaIndex (FunctionTool de usuario + MCP de
        # tenant); sin tools el turno sale por el camino de streaming.
        super().__init__(**kwargs)
        self.llm = llm
        self.tools = tools or []

    @step
    async def responder(self, ctx: Context, ev: ChatStart) -> ChatDone:
        if not self.tools:
            # Camino sin tools: cada chunk del modelo se publica al stream
            # apenas llega, y a la vez se acumula para la memoria.
            partes: list[str] = []
            async for chunk in self.llm.astream(ev.message, ev.history):
                partes.append(chunk)
                ctx.write_event_to_stream(TextDelta(text=chunk))
            return ChatDone(texto="".join(partes))
        return await self._responder_con_tools(ev)

    async def _responder_con_tools(self, ev: ChatStart) -> ChatDone:
        # Con tools no hay streaming de deltas: achat_with_tools responde el
        # turno entero. Da igual río abajo — el worker ignora los deltas y solo
        # consume el texto del evento final, que sale por el MISMO ChatDone.
        tools_por_nombre = {t.metadata.name: t for t in self.tools}
        # Copia: el loop apendea los mensajes del turno y el history de entrada
        # no es nuestro (la memoria persiste solo pregunta y respuesta final).
        historial = list(ev.history)
        turno_apendeado = False
        # Qué tools se ejecutaron en el turno: el consumidor lo usa para contar
        # (p. ej. si hubo escalamiento). Solo nombres, ningún argumento ni resultado.
        tools_usadas: list[str] = []
        for _ in range(MAX_RONDAS_TOOLS):
            respuesta = await self.llm.aresponder_con_tools(
                ev.message, historial, self.tools
            )
            texto, llamadas = respuesta.texto, respuesta.llamadas
            if not llamadas:
                if texto:
                    return ChatDone(texto=texto, tools_usadas=tools_usadas)
                break  # ni texto ni llamadas: no hay más que hacer
            if not turno_apendeado:
                # La pregunta entra al historial UNA vez, recién cuando el turno
                # sigue con tools; hasta acá viajó como `message` del adaptador.
                historial.append({"role": "user", "content": ev.message})
                turno_apendeado = True
            historial.append(
                {
                    "role": "assistant",
                    "content": texto or "",
                    "tool_calls": [
                        {"id": ll.id, "nombre": ll.nombre, "argumentos": ll.argumentos}
                        for ll in llamadas
                    ],
                }
            )
            for llamada in llamadas:
                if llamada.nombre in tools_por_nombre:
                    # Se anota la que EXISTE: un nombre alucinado no se ejecutó,
                    # y contarlo inflaría la métrica.
                    tools_usadas.append(llamada.nombre)
                resultado = await self._ejecutar_tool(tools_por_nombre, llamada)
                historial.append(
                    {"role": "tool", "content": resultado, "tool_call_id": llamada.id}
                )
        # Rondas agotadas (o una ronda muda): respuesta humana, nunca un turno colgado.
        return ChatDone(texto=MENSAJE_FALLBACK_TOOLS, tools_usadas=tools_usadas)

    @staticmethod
    async def _ejecutar_tool(tools_por_nombre: dict, llamada: LlamadaTool) -> str:
        tool = tools_por_nombre.get(llamada.nombre)
        if tool is None:
            # El modelo alucinó un nombre: el error viaja como resultado de la
            # tool y el loop sigue (fail-open conversacional).
            return f"No existe la herramienta '{llamada.nombre}'."
        try:
            return str(await tool.acall(**llamada.argumentos))
        except Exception as exc:
            logger.error("Falló la tool '%s': %s", llamada.nombre, exc)
            return f"La herramienta '{llamada.nombre}' falló al ejecutarse."
