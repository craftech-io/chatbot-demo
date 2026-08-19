"""Tipos de evento del stream del agente. Compartidos entre el workflow y el server."""

from workflows.events import Event, StartEvent, StopEvent


class ChatStart(StartEvent):
    """Entrada del workflow: el mensaje del usuario y el historial ya cargado."""

    message: str
    history: list[dict]


class TextDelta(Event):
    """Un fragmento de texto del modelo, listo para enviar al browser."""

    text: str


class ChatDone(StopEvent):
    """Fin del turno: el texto completo que se le dijo al usuario."""

    result: str
