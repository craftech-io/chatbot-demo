"""Adaptador de modelo. Es la frontera que permite cambiar de proveedor sin tocar
el workflow: este archivo es el único que sabe que abajo hay Bedrock.

Filtrar a mano texto ya streameado llegaría tarde.
"""

from collections.abc import AsyncIterator

from llama_index.core.base.llms.types import ChatMessage
from llama_index.llms.bedrock_converse import BedrockConverse

from .config import Config
from .costo import UsoTokens
from .workflow import LlamadaTool, RespuestaLLM


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


def _uso_de(respuesta) -> UsoTokens | None:
    """El uso de tokens de una respuesta o de un chunk, traducido al tipo neutral.

    Los nombres son los de LlamaIndex, no los de Converse:
    `_get_response_token_counts` de bedrock_converse traduce `inputTokens` &
    compañía a `prompt_tokens`/`completion_tokens`/`cache_read_input_tokens`/
    `cache_creation_input_tokens` y los deja en `additional_kwargs`, o deja un
    dict VACÍO si esa respuesta no trae `usage`.

    Devuelve None (no un uso en cero) cuando no hay nada que reportar: "no lo
    sabemos" y "no gastó tokens" no son lo mismo para la métrica de costo.
    """
    kwargs = getattr(respuesta, "additional_kwargs", None) or {}
    if "prompt_tokens" not in kwargs and "completion_tokens" not in kwargs:
        return None
    return UsoTokens(
        entrada=int(kwargs.get("prompt_tokens") or 0),
        salida=int(kwargs.get("completion_tokens") or 0),
        cache_lectura=int(kwargs.get("cache_read_input_tokens") or 0),
        cache_escritura=int(kwargs.get("cache_creation_input_tokens") or 0),
    )


class BedrockAdapter:
    def __init__(self, cfg: Config, client_factory=BedrockConverse):
        kwargs = {"model": cfg.model_id, "region_name": cfg.region}
        self.client = client_factory(**kwargs)
        self.prompt_sistema = cfg.prompt_sistema
        # Uso de tokens del TURNO: el adaptador se construye uno por request
        # (server.py), así que acumular acá es acumular el turno — el loop de
        # tools llama al modelo hasta cuatro veces. None mientras el proveedor
        # no haya reportado nada. Lo lee el cierre del turno en server.py.
        self.uso_del_turno: UsoTokens | None = None

    def _mensajes_iniciales(self) -> list[ChatMessage]:
        """La política de comportamiento, si está configurada, abre la lista.

        Lista NUEVA en cada llamada a propósito: `_prepare_chat_with_tools` de
        LlamaIndex apendea el `user_msg` a la lista que recibe, así que una lista
        compartida acumularía mensajes turno a turno.

        No hay riesgo con el orden que Converse exige después de un `toolResult`:
        `messages_to_converse_messages` SACA los mensajes `system` de la lista y
        los manda en el campo `system` de la request, así que el prompt nunca
        queda como un turno más entre el resultado de la tool y lo que sigue.
        """
        if not self.prompt_sistema:
            return []
        return [ChatMessage(role="system", content=self.prompt_sistema)]

    def _acumular(self, uso: UsoTokens | None) -> None:
        if uso is None:
            return
        self.uso_del_turno = uso if self.uso_del_turno is None else self.uso_del_turno + uso

    async def astream(self, message: str, history: list[dict]) -> AsyncIterator[str]:
        messages = self._mensajes_iniciales()
        messages += [_a_chat_message(h) for h in history]
        messages.append(ChatMessage(role="user", content=message))
        stream = await self.client.astream_chat(messages)
        uso = None
        async for response in stream:
            # El uso de tokens llega en el ÚLTIMO chunk del stream, que tiene
            # `delta=""` (bedrock_converse emite uno por el evento `metadata` de
            # Converse). Antes ese chunk se descartaba entero por el guard de
            # abajo; ahora se LEE y se sigue sin emitir.
            #
            # El guard sigue siendo necesario y no cambia lo que ve el
            # consumidor: Bedrock emite chunks sin texto (metadata pura) también
            # a mitad del stream, y un delta "" se colaría como un fragmento
            # vacío hasta el browser.
            #
            # Reemplaza en vez de sumar: lo que trae el chunk son los TOTALES de
            # esta llamada, no un incremento.
            nuevo = _uso_de(response)
            if nuevo is not None:
                uso = nuevo
            if response.delta:
                yield response.delta
        self._acumular(uso)

    async def aresponder_con_tools(
        self, message: str, history: list[dict], tools: list
    ) -> RespuestaLLM:
        """Una ronda del loop de tools: texto final, tool calls y uso de tokens."""
        # En la primera ronda la pregunta todavía no está en el history y viaja
        # como user_msg. En las siguientes el workflow ya la apendeó junto a la
        # tool call y su resultado: repetirla acá la duplicaría DESPUÉS del
        # toolResult (orden que Converse no acepta).
        user_msg = None if history and history[-1].get("role") == "tool" else message
        respuesta = await self.client.achat_with_tools(
            tools=tools,
            user_msg=user_msg,
            chat_history=self._mensajes_iniciales()
            + [_a_chat_message(h) for h in history],
        )
        # `achat_with_tools` devuelve el ChatResponse entero: el uso de tokens
        # está en `additional_kwargs` y antes se perdía al desarmar el objeto en
        # una tupla de (texto, llamadas).
        uso = _uso_de(respuesta)
        self._acumular(uso)
        llamadas = [
            LlamadaTool(id=s.tool_id, nombre=s.tool_name, argumentos=s.tool_kwargs)
            for s in self.client.get_tool_calls_from_response(
                respuesta, error_on_no_tool_call=False
            )
        ]
        return RespuestaLLM(
            texto=respuesta.message.content or None, llamadas=llamadas, uso=uso
        )
