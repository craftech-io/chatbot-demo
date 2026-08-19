"""El harness: el loop del agente como grafo de pasos y eventos explícito.

Que sea un Workflow y no un loop opaco es lo que lo hace testeable paso a paso:
cada step se prueba por los eventos que emite, con dobles de LLM y de tools.
"""

from workflows import Context, Workflow, step

from .events import ChatDone, ChatStart, TextDelta


class ChatWorkflow(Workflow):
    def __init__(self, llm, **kwargs):
        # `llm` es el adaptador de modelo (agent/llm.py) o un doble en los tests.
        # El workflow no conoce Bedrock: solo el protocolo `astream`.
        super().__init__(**kwargs)
        self.llm = llm

    @step
    async def responder(self, ctx: Context, ev: ChatStart) -> ChatDone:
        # Cada chunk del modelo se publica al stream apenas llega, y a la vez se
        # acumula: el texto completo es lo que después se persiste en la memoria.
        partes: list[str] = []
        async for chunk in self.llm.astream(ev.message, ev.history):
            partes.append(chunk)
            ctx.write_event_to_stream(TextDelta(text=chunk))
        return ChatDone(result="".join(partes))
