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
        messages = [ChatMessage(role=h["role"], content=h["content"]) for h in history]
        messages.append(ChatMessage(role="user", content=message))
        stream = await self.client.astream_chat(messages)
        async for response in stream:
            if response.delta:
                yield response.delta
