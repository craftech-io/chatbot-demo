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
    """Fin del turno: el texto completo que se le dijo al usuario.

    El campo se llama `texto`, no `result`: declarar `result` acá lo haría colisionar
    con el `result` de `StopEvent`. Esa colisión no es solo un warning de pydantic:
    puede dejar `result` como un `property object` en vez del string, en silencio.

    `tools_usadas` son los nombres de las tools que el turno EJECUTÓ, en orden:
    lo que el cierre del turno necesita para contar (p. ej. escalamientos) sin
    tener que mirar el contenido de la conversación. Vacía en el camino de streaming.
    """

    texto: str
    tools_usadas: list[str] = []
