"""AgentCore Memory: el historial de la conversación por (actorId, sessionId).

Fail-open deliberado: una caída de Memory degrada a conversación sin historial,
nunca tumba el turno. El evento se crea con el timestamp del server.
"""

import logging
from datetime import datetime, timezone

import boto3

log = logging.getLogger(__name__)


class Memoria:
    def __init__(self, memory_id: str, cliente=None):
        self.memory_id = memory_id
        self.cliente = cliente or boto3.client("bedrock-agentcore")

    def historial(self, actor_id: str, session_id: str) -> list[dict]:
        try:
            out = self.cliente.list_events(
                memoryId=self.memory_id, actorId=actor_id, sessionId=session_id,
                # `includePayloads` default a False en el data plane real: sin esto,
                # los eventos vuelven sin contenido y el historial queda vacío en
                # silencio (no es un fail-open, es leer mal la respuesta).
                includePayloads=True,
                maxResults=100,
            )
        except Exception:
            log.exception("no se pudo leer el historial de Memory (fail-open)")
            return []
        mensajes: list[dict] = []
        for ev in out.get("events", []):
            for p in ev.get("payload", []):
                conv = p.get("conversational")
                if conv:
                    mensajes.append(
                        {"role": conv["role"].lower(), "content": conv["content"]["text"]}
                    )
        return mensajes

    def registrar_turno(self, actor_id: str, session_id: str, pregunta: str, respuesta: str) -> None:
        try:
            self.cliente.create_event(
                memoryId=self.memory_id, actorId=actor_id, sessionId=session_id,
                eventTimestamp=datetime.now(timezone.utc),
                payload=[
                    {"conversational": {"role": "USER", "content": {"text": pregunta}}},
                    {"conversational": {"role": "ASSISTANT", "content": {"text": respuesta}}},
                ],
            )
        except Exception:
            log.exception("no se pudo persistir el turno en Memory (fail-open)")
