"""Contrato HTTP de AgentCore Runtime (BYOC): 0.0.0.0:8080, GET /ping y
POST /invocations. Este archivo no tiene lógica de agente: arma el workflow,
lo corre y traduce sus eventos a SSE.

La invocación llega por InvokeAgentRuntime con IAM, así que el payload lo armó el
BFF después de validar al usuario: es CONFIABLE. No se valida identidad acá.
"""

import asyncio
import json
import logging
import os

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from agent.config import load_config
from agent.costo import UsoTokens, costo_estimado
from agent.events import TextDelta
from agent.llm import BedrockAdapter
from agent.tools import NOMBRE_TOOL_ESCALAMIENTO, crear_tools_usuario, tools_de_gateway
from agent.workflow import ChatWorkflow, LlamadaTool, RespuestaLLM

PORT = 8080

logger = logging.getLogger(__name__)

# Estado de la guarda de instrumentación. Vive a nivel MÓDULO y no en el closure
# de build_app porque lo que se engancha es global al PROCESO: el instrumentor de
# OpenInference es un singleton y el dispatcher de LlamaIndex que modifica es uno
# solo, compartido por todas las apps del proceso.
_trazas_instrumentadas = False


def _instrumentar_trazas(env, instrumentador_factory=None) -> bool:
    """Engancha OpenInference al dispatcher de LlamaIndex si la env lo pide.

    Hace falta llamarlo a mano: `opentelemetry-instrument` (el entrypoint del
    contenedor, ver core/Dockerfile) NO conoce este instrumentor, no está entre
    sus auto-instrumentaciones. Sin esta llamada el contenedor exporta los spans
    de HTTP pero NINGUNO del interior del turno — ni el workflow, ni las tools,
    ni los contadores de tokens del LLM.

    Va detrás de una guarda de env a propósito: los tests y el modo local no
    tienen por qué pagar el import ni un enganche global. La infra la prende en
    el Runtime con `TRAZAS_OPENINFERENCE=1` (ver infra/CONTRACT.md).

    Devuelve si instrumentó en ESTA llamada. El server no usa el valor; existe
    para que la guarda sea observable desde los tests.
    """
    global _trazas_instrumentadas
    if not env.get("TRAZAS_OPENINFERENCE"):
        return False
    if _trazas_instrumentadas:
        # `LlamaIndexInstrumentor.instrument()` ya es idempotente por su cuenta
        # (BaseInstrumentor es un singleton con un flag
        # `_is_instrumented_by_opentelemetry`, y su `_instrument` además revisa
        # el dispatcher antes de agregar handlers), pero la segunda llamada
        # loguea un WARNING que no significa nada: mejor no hacerla.
        return False
    if instrumentador_factory is None:
        # Import PEREZOSO, adentro de la guarda: el paquete arrastra
        # `llama_index.core` y `openinference` entero, y con la guarda apagada
        # no tiene por qué entrar al proceso.
        from openinference.instrumentation.llama_index import LlamaIndexInstrumentor

        instrumentador_factory = LlamaIndexInstrumentor
    instrumentador_factory().instrument()
    _trazas_instrumentadas = True
    # Sin nada del turno: este log dice QUE se instrumentó, y nada más.
    logger.info("Trazas: instrumentacion de OpenInference activada")
    return True


class _EchoLLM:
    """LLM local que repite el mensaje. Solo se usa con FAKE_LLM=1.

    Con tools, ante un mensaje que menciona "pedido" simula una tool call a
    `mis_pedidos`: así el loop de tools se ejercita entero sin Bedrock ni red.
    """

    def __init__(self):
        # Uso de tokens de mentira: hace visible el log de cierre del turno en
        # modo local, sin Bedrock. El costo queda en null porque el MODEL_ID
        # local no está en la tabla de tarifas (agent/costo.py).
        self.uso_del_turno = UsoTokens(entrada=42, salida=17)

    async def astream(self, message: str, history: list[dict]):
        for palabra in f"eco: {message}".split(" "):
            yield palabra + " "

    async def aresponder_con_tools(self, message: str, history: list[dict], tools: list):
        if history and history[-1].get("role") == "tool":
            # Segunda ronda: "redacta" la respuesta con el resultado de la tool.
            return RespuestaLLM(texto=f"eco tools: {history[-1]['content']}", llamadas=[])
        if "pedido" in message.lower():
            return RespuestaLLM(
                texto=None,
                llamadas=[LlamadaTool(id="eco-1", nombre="mis_pedidos", argumentos={})],
            )
        return RespuestaLLM(texto=f"eco: {message}", llamadas=[])


def _loguear_cierre(sesion: str, cfg, adaptador, escalado: bool, estimador_de_costo) -> None:
    """Cierre del turno en una línea de JSON: ids, tokens, costo y escalamiento.

    **Sin el texto de la conversación**, ni la pregunta ni la respuesta ni el
    resultado de ninguna tool. Eso es lo que hace la métrica consultable por
    Logs Insights aunque las trazas se exporten a un destino externo.

    El uso lo trae el adaptador (`uso_del_turno`, ver agent/llm.py). Un doble, el
    modo local o un proveedor que no lo reporte dejan los tokens en cero y el
    costo en null: acá nunca se inventa un número y nunca se tumba el turno.
    """
    uso = getattr(adaptador, "uso_del_turno", None)
    # Sin uso reportado los contadores van en cero y el costo en null: el turno
    # se cuenta igual.
    tokens = uso or UsoTokens()
    logger.info(
        json.dumps(
            {
                "evento": "turno_cerrado",
                "sessionId": sesion,
                "modelo": cfg.model_id,
                "tokensEntrada": tokens.entrada,
                "tokensSalida": tokens.salida,
                "tokensCacheLectura": tokens.cache_lectura,
                "tokensCacheEscritura": tokens.cache_escritura,
                "costoUsd": estimador_de_costo(uso, cfg.model_id, cfg.region),
                "intentoEscalamiento": escalado,
            }
        )
    )


def build_app(
    llm_factory=None,
    env=None,
    tools_usuario_factory=None,
    tools_gateway_factory=None,
    estimador_de_costo=None,
    instrumentador_factory=None,
) -> Starlette:
    # `env` se inyecta en los tests; en el contenedor es os.environ.
    env = os.environ if env is None else env
    # Lo PRIMERO: el instrumentor tiene que estar enganchado al dispatcher antes
    # de que corra el primer turno. Sin try/except a propósito: si la env pide
    # instrumentar y el import falla, la imagen está mal armada y es mejor no
    # arrancar (misma razón que load_config) que servir turnos sin trazas y sin
    # que nadie se entere.
    _instrumentar_trazas(env, instrumentador_factory)
    # La config se carga al CONSTRUIR la app, no por request: si falta algo
    # obligatorio es preferible no arrancar (la misma razón de config.py).
    cfg = load_config(env)
    # El factory se inyecta en los tests para no pegarle a Bedrock.
    # FAKE_LLM permite correr el contenedor sin credenciales de Bedrock.
    if llm_factory is None and env.get("FAKE_LLM"):
        llm_factory = lambda cfg: _EchoLLM()  # noqa: E731
    llm_factory = llm_factory or BedrockAdapter
    tools_usuario_factory = tools_usuario_factory or crear_tools_usuario
    tools_gateway_factory = tools_gateway_factory or tools_de_gateway
    # Se inyecta en los tests para no pegarle a la Pricing API. El default es
    # fail-open de punta a punta: sin tarifa, el turno se loguea sin costo.
    # En modo local no se estima costo: evita pegarle a la Pricing API (si el
    # MODEL_ID es uno real) y evita una línea de warning no-JSON por turno en el
    # mismo log que Logs Insights parsea.
    if estimador_de_costo is None:
        estimador_de_costo = (lambda *_: None) if env.get("FAKE_LLM") else costo_estimado
    # Cache de las tools de tenant: una lista por microVM, no por turno
    # (build_app corre una vez por proceso). Vive en el closure y no a nivel
    # módulo para que cada app de test tenga su propio cache.
    cache_gateway: list | None = None

    async def armar_tools(act_token: str | None) -> list:
        nonlocal cache_gateway
        tools: list = []
        if cfg.client_api_url:
            # Las de usuario se arman POR REQUEST: llevan el actToken del turno.
            tools += tools_usuario_factory(cfg.client_api_url, act_token)
        if cfg.gateway_url:
            if cache_gateway is None:
                listado = await tools_gateway_factory(cfg.gateway_url, cfg.region)
                if listado:
                    # Solo se cachea una lista exitosa: la vacía es el fail-open
                    # de tools_de_gateway y el próximo turno reintenta.
                    cache_gateway = listado
                tools += listado
            else:
                tools += cache_gateway
        return tools

    async def ping(_: Request) -> JSONResponse:
        return JSONResponse({"status": "Healthy"})

    async def invocations(request: Request):
        payload = await request.json()
        message = payload.get("message")
        if not message:
            return JSONResponse({"error": "falta 'message' en el payload"}, status_code=400)

        actor = payload.get("userId") or "anonimo"
        sesion = payload.get("sessionId") or "default"
        # El historial lo arma el worker desde MessagesTable y viaja en el
        # payload: el core no habla con ningún store.
        history = payload.get("history") or []
        # El actToken viene en el payload del InvokeAgentRuntime y muere acá:
        # entra a la tool de usuario como Bearer y a ningún otro lado. Nunca se
        # loguea ni se persiste.
        tools = await armar_tools(payload.get("actToken"))

        # El adaptador se guarda: vive este turno y al final se le pide el uso de
        # tokens que acumuló (`uso_del_turno`).
        adaptador = llm_factory(cfg)
        workflow = ChatWorkflow(llm=adaptador, tools=tools or None, timeout=120)
        handler = workflow.run(message=message, history=history)

        async def eventos():
            escalado = False
            # Nada tumba la conversación: si el workflow falla a mitad del stream
            # (throttling de Bedrock, guardrail, timeout), los deltas ya emitidos
            # quedan como están y el turno se cierra con un evento terminal de
            # error en vez de dejar el SSE truncado sin cierre.
            try:
                async for ev in handler.stream_events():
                    if isinstance(ev, TextDelta):
                        yield f"data: {json.dumps({'type': 'delta', 'text': ev.text})}\n\n"
                # `.texto` explícito: await sobre el handler devuelve el ChatDone, no un
                # string (el framework no desenvuelve subtipos de StopEvent), y el campo
                # se llama `texto` para no colisionar con el `result` de StopEvent.
                done = await handler
                texto = done.texto
                # El core no mira el contenido del escalamiento: le alcanza el
                # nombre de la tool que se ejecutó.
                escalado = any(
                    nombre.endswith(NOMBRE_TOOL_ESCALAMIENTO) for nombre in done.tools_usadas
                )
                yield f"data: {json.dumps({'type': 'done', 'text': texto})}\n\n"
            except Exception as exc:
                logger.error("Fallo el workflow del agente a mitad del stream: %s", exc)
                yield f"data: {json.dumps({'type': 'error', 'code': 'agent_error'})}\n\n"
            finally:
                # DESPUÉS del evento final a propósito: resolver la tarifa puede
                # costar una llamada a la Pricing API la primera vez de cada
                # microVM, y el usuario no la espera. En `finally` para que un
                # turno que se cayó también quede contado.
                #
                # Va en un thread y no inline: `_loguear_cierre` es SÍNCRONO y la
                # resolución de tarifas construye un cliente boto3 y pagina la
                # Pricing API. Inline eso bloquea el event loop más de un segundo
                # en el primer turno de cada microVM, con la respuesta HTTP
                # todavía abierta y el health check de AgentCore pegándole a
                # /ping en el medio.
                await asyncio.to_thread(
                    _loguear_cierre, sesion, cfg, adaptador, escalado, estimador_de_costo
                )

        return StreamingResponse(eventos(), media_type="text/event-stream")

    return Starlette(
        routes=[Route("/ping", ping), Route("/invocations", invocations, methods=["POST"])]
    )


if __name__ == "__main__":
    import uvicorn

    # Sin esto el log de cierre del turno (INFO) se perdería: uvicorn configura
    # sus propios loggers y deja el root en WARNING, así que `logger.info` no
    # llegaría nunca a CloudWatch. Va en `__main__` y no a nivel módulo para no
    # pisarle la config de logging a nadie que importe este archivo (los tests,
    # otro proceso que use `build_app`).
    #
    # El root queda en WARNING y solo nuestros módulos suben a INFO: botocore y
    # compañía loguean cosas como "Found credentials in ..." en INFO y no vale
    # pagar por eso en cada microVM.
    #
    # El formato es solo el mensaje: así la línea del cierre del turno es JSON
    # puro y Logs Insights la parsea sin `parse` ni regex.
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    logging.getLogger("agent").setLevel(logging.INFO)
    logging.getLogger(__name__).setLevel(logging.INFO)
    # La app se construye recién acá: el contenedor falla al arrancar si falta
    # config, y el import del módulo (en los tests) no dispara load_config.
    uvicorn.run(build_app(), host="0.0.0.0", port=PORT)
