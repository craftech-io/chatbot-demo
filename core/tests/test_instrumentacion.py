"""La guarda de la instrumentación de trazas (spec §17, capa 2).

Lo que se pinea acá no es que los spans salgan —eso lo prueba el deploy— sino
las dos propiedades que hacen que la capa de trazas no moleste donde no se la
pidió: sin `TRAZAS_OPENINFERENCE` el paquete de OpenInference no entra al
proceso, y con la env prendida el instrumentor se llama UNA sola vez aunque
`build_app` corra dos veces.
"""

import sys

import pytest

import server
from server import build_app

MODULO_OPENINFERENCE = "openinference.instrumentation.llama_index"


class InstrumentadorEspia:
    """Doble del LlamaIndexInstrumentor: solo cuenta llamadas a instrument()."""

    def __init__(self):
        self.llamadas = 0

    def instrument(self):
        self.llamadas += 1


@pytest.fixture(autouse=True)
def guarda_limpia():
    # El estado de la guarda vive a nivel módulo (el instrumentor de
    # OpenInference es un singleton de PROCESO, no de app), así que cada test
    # arranca con la pizarra limpia y no depende del orden de ejecución.
    server._trazas_instrumentadas = False
    yield
    server._trazas_instrumentadas = False


def _app(env, instrumentador=None):
    # llm_factory inyectado: no se toca Bedrock ni se importa el adaptador real.
    return build_app(
        llm_factory=lambda cfg: object(),
        env=env,
        instrumentador_factory=(lambda: instrumentador) if instrumentador else None,
    )


def test_sin_la_env_no_instrumenta():
    espia = InstrumentadorEspia()
    _app({"MODEL_ID": "fake"}, espia)
    assert espia.llamadas == 0


def test_sin_la_env_no_importa_el_paquete_de_openinference():
    # Precondición: el import es perezoso, así que el paquete solo puede estar
    # cargado si otro test lo trajo. Si esto falla, el test perdió su sentido.
    assert MODULO_OPENINFERENCE not in sys.modules, (
        "otro test ya importó OpenInference: este necesita el proceso limpio"
    )
    # Sin factory inyectado: se ejercita el camino REAL, con su import perezoso.
    _app({"MODEL_ID": "fake"})
    assert MODULO_OPENINFERENCE not in sys.modules


def test_con_la_env_instrumenta_una_sola_vez():
    espia = InstrumentadorEspia()
    _app({"MODEL_ID": "fake", "TRAZAS_OPENINFERENCE": "1"}, espia)
    # Segunda app en el MISMO proceso: el dispatcher de LlamaIndex es global,
    # engancharlo dos veces duplicaría cada span del turno.
    _app({"MODEL_ID": "fake", "TRAZAS_OPENINFERENCE": "1"}, espia)
    assert espia.llamadas == 1
