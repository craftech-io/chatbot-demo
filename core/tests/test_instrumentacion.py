"""La guarda de la instrumentación de trazas (spec §17, capa 2).

Lo que se pinea acá no es que los spans salgan —eso lo prueba el deploy— sino
las dos propiedades que hacen que la capa de trazas no moleste donde no se la
pidió: sin `TRAZAS_OPENINFERENCE` el paquete de OpenInference no entra al
proceso, y con la env prendida el instrumentor se llama UNA sola vez aunque
`build_app` corra dos veces.
"""

import os
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


# La prueba que faltaba, y la que caza la clase de bug más caro de esta capa:
# afirmar sobre los ATRIBUTOS REALES de los spans, no sobre las variables de
# entorno. Las env son la intención; los atributos son lo que sale del proceso.
#
# El caso real: el distro de AWS carga instrumentors propios de llama_index y de
# MCP que emiten el texto completo en `gen_ai.*` con un tracer que las flags de
# OpenInference no gobiernan. Todas las env estaban bien puestas y la
# conversación salía igual.
@pytest.mark.asyncio
async def test_ningun_span_lleva_el_texto_de_la_conversacion():
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from agent.workflow import ChatWorkflow

    instrumentor = pytest.importorskip(
        "openinference.instrumentation.llama_index"
    ).LlamaIndexInstrumentor

    # Las MISMAS env de redacción que declara infra/sst/runtime.ts para el caso
    # `contenidoEnTrazas: false`. El test corre la configuración que se
    # despliega, no la de fábrica de la librería: si alguien saca una env de la
    # infra, este test tiene que ponerse rojo.
    for flag in (
        "INPUTS", "OUTPUTS", "INPUT_MESSAGES", "OUTPUT_MESSAGES",
        "INPUT_TEXT", "OUTPUT_TEXT", "INPUT_IMAGES", "PROMPTS",
        "CHOICES", "EMBEDDINGS_TEXT",
    ):
        os.environ[f"OPENINFERENCE_HIDE_{flag}"] = "true"
    os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "false"

    exporter = InMemorySpanExporter()
    proveedor = TracerProvider()
    proveedor.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(proveedor)

    SECRETOS = ("mi-tarjeta-es-4111", "el-documento-dice-XYZ", "no-inventes-nada")

    inst = instrumentor()
    inst.instrument(tracer_provider=proveedor)
    try:
        class LLMConSecretos:
            async def astream(self, message, history):
                yield "listo"

            async def aresponder_con_tools(self, message, history, tools):
                from agent.llm import RespuestaLLM

                return RespuestaLLM(texto=f"resultado: {SECRETOS[1]}", llamadas=[], uso=None)

        wf = ChatWorkflow(llm=LLMConSecretos(), timeout=10)
        await wf.run(message=SECRETOS[0], history=[{"role": "system", "content": SECRETOS[2]}])
    finally:
        inst.uninstrument()

    atributos = " ".join(
        f"{k}={v}" for span in exporter.get_finished_spans() for k, v in (span.attributes or {}).items()
    )
    assert exporter.get_finished_spans(), "no se capturó ningún span: el test no probaría nada"
    for secreto in SECRETOS:
        assert secreto not in atributos, f"el span filtró {secreto!r}"
