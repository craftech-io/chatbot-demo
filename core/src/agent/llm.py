"""Adaptador de modelo. Es la frontera que permite cambiar de proveedor sin tocar
el workflow: este archivo es el único que sabe que abajo hay Bedrock.

El guardrail de SALIDA se aplica acá, delegado a Bedrock con
`guardrail_stream_processing_mode="sync"`: Bedrock evalúa cada chunk ANTES de emitirlo.
Filtrar a mano texto ya streameado llegaría tarde.
"""

from collections.abc import AsyncIterator

from llama_index.core.base.llms.types import ChatMessage
from llama_index.llms.bedrock_converse import BedrockConverse

from .config import Config
from .workflow import LlamadaTool


def _a_chat_message(mensaje: dict) -> ChatMessage:
    """Traduce el dict neutral del workflow al ChatMessage de LlamaIndex.

    El turno con tools extiende el formato: `tool_calls` del workflow pasa al
    shape que `messages_to_converse_messages` espera en additional_kwargs
    (toolUseId/name/input), y `tool_call_id` marca el resultado de la tool.
    """
    extra: dict = {}
    if mensaje.get("tool_calls"):
        extra["tool_calls"] = [
            {"toolUseId": tc["id"], "name": tc["nombre"], "input": tc["argumentos"]}
            for tc in mensaje["tool_calls"]
        ]
    if mensaje.get("tool_call_id"):
        extra["tool_call_id"] = mensaje["tool_call_id"]
    return ChatMessage(
        role=mensaje["role"], content=mensaje["content"], additional_kwargs=extra
    )


class BedrockAdapter:
    def __init__(self, cfg: Config, client_factory=BedrockConverse):
        kwargs = {"model": cfg.model_id, "region_name": cfg.region}
        if cfg.guardrail_id:
            kwargs |= {
                "guardrail_identifier": cfg.guardrail_id,
                "guardrail_version": cfg.guardrail_version,
                "guardrail_stream_processing_mode": "sync",
            }
        self.client = client_factory(**kwargs)

    async def astream(self, message: str, history: list[dict]) -> AsyncIterator[str]:
        messages = [_a_chat_message(h) for h in history]
        messages.append(ChatMessage(role="user", content=message))
        stream = await self.client.astream_chat(messages)
        async for response in stream:
            if response.delta:
                yield response.delta

    async def aresponder_con_tools(
        self, message: str, history: list[dict], tools: list
    ) -> tuple[str | None, list[LlamadaTool]]:
        """Una ronda del loop de tools: (texto_final | None, tool_calls pendientes)."""
        # En la primera ronda la pregunta todavía no está en el history y viaja
        # como user_msg. En las siguientes el workflow ya la apendeó junto a la
        # tool call y su resultado: repetirla acá la duplicaría DESPUÉS del
        # toolResult (orden que Converse no acepta).
        user_msg = None if history and history[-1].get("role") == "tool" else message
        respuesta = await self.client.achat_with_tools(
            tools=tools,
            user_msg=user_msg,
            chat_history=[_a_chat_message(h) for h in history],
        )
        llamadas = [
            LlamadaTool(id=s.tool_id, nombre=s.tool_name, argumentos=s.tool_kwargs)
            for s in self.client.get_tool_calls_from_response(
                respuesta, error_on_no_tool_call=False
            )
        ]
        return respuesta.message.content or None, llamadas
