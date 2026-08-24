from agent.memoria import Memoria


class ClienteFalso:
    """Doble del data plane de AgentCore Memory."""

    def __init__(self, eventos=None, falla=False):
        self.eventos = eventos or []
        self.falla = falla
        self.creados = []

    def list_events(self, **kw):
        if self.falla:
            raise RuntimeError("memory caída")
        self.kw = kw
        return {"events": self.eventos}

    def create_event(self, **kw):
        if self.falla:
            raise RuntimeError("memory caída")
        self.creados.append(kw)
        return {}


def evento(rol, texto):
    return {"payload": [{"conversational": {"role": rol, "content": {"text": texto}}}]}


def test_historial_traduce_eventos_al_formato_del_adaptador():
    cliente = ClienteFalso(eventos=[evento("USER", "hola"), evento("ASSISTANT", "¡hola!")])
    m = Memoria("mem-1", cliente=cliente)
    h = m.historial("user-a", "sesion-1")
    assert h == [
        {"role": "user", "content": "hola"},
        {"role": "assistant", "content": "¡hola!"},
    ]
    assert cliente.kw["memoryId"] == "mem-1"
    assert cliente.kw["actorId"] == "user-a"
    assert cliente.kw["sessionId"] == "sesion-1"


def test_registrar_turno_crea_el_evento_con_ambos_mensajes():
    cliente = ClienteFalso()
    Memoria("mem-1", cliente=cliente).registrar_turno("user-a", "sesion-1", "¿2+2?", "4")
    assert len(cliente.creados) == 1
    payload = cliente.creados[0]["payload"]
    roles = [(p["conversational"]["role"], p["conversational"]["content"]["text"]) for p in payload]
    assert roles == [("USER", "¿2+2?"), ("ASSISTANT", "4")]


def test_fail_open_en_lectura_y_escritura():
    m = Memoria("mem-1", cliente=ClienteFalso(falla=True))
    assert m.historial("u", "s") == []  # sin historial, la conversación sigue
    m.registrar_turno("u", "s", "a", "b")  # no lanza
