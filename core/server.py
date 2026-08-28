"""Contrato HTTP de AgentCore Runtime (BYOC): 0.0.0.0:8080, GET /ping y
POST /invocations. Este archivo no tiene lógica de agente: arma el workflow,
lo corre y traduce sus eventos a SSE.

La invocación llega por InvokeAgentRuntime con IAM, así que el payload lo armó el
BFF después de validar al usuario: es CONFIABLE. No se valida identidad acá.
"""

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
from agent.memoria import Memoria
from agent.tools import NOMBRE_TOOL_ESCALAMIENTO, crear_tools_usuario, tools_de_gateway
from agent.workflow import ChatWorkflow, LlamadaTool, RespuestaLLM

PORT = 8080

logger = logging.getLogger(__name__)


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
                "escalado": escalado,
            }
        )
    )


def build_app(
    llm_factory=None,
    env=None,
    memoria_factory=None,
    tools_usuario_factory=None,
    tools_gateway_factory=None,
    estimador_de_costo=None,
) -> Starlette:
    # `env` se inyecta en los tests; en el contenedor es os.environ.
    env = os.environ if env is None else env
    # La config se carga al CONSTRUIR la app, no por request: si falta algo
    # obligatorio es preferible no arrancar (la misma razón de config.py).
    cfg = load_config(env)
    # El factory se inyecta en los tests para no pegarle a Bedrock.
    # FAKE_LLM permite correr el contenedor sin credenciales de Bedrock.
    if llm_factory is None and env.get("FAKE_LLM"):
        llm_factory = lambda cfg: _EchoLLM()  # noqa: E731
    llm_factory = llm_factory or BedrockAdapter
    # Sin MEMORY_ID no hay memoria persistente: el historial llega en el payload
    # (`history`) y el turno no se guarda en ningún lado.
    if memoria_factory is None and cfg.memory_id:
        memoria_factory = lambda cfg: Memoria(cfg.memory_id)  # noqa: E731
    memoria = memoria_factory(cfg) if memoria_factory else None
    tools_usuario_factory = tools_usuario_factory or crear_tools_usuario
    tools_gateway_factory = tools_gateway_factory or tools_de_gateway
    # Se inyecta en los tests para no pegarle a la Pricing API. El default es
    # fail-open de punta a punta: sin tarifa, el turno se loguea sin costo.
    estimador_de_costo = estimador_de_costo or costo_estimado
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
        history = memoria.historial(actor, sesion) if memoria else (payload.get("history") or [])
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
                    NOMBRE_TOOL_ESCALAMIENTO in nombre for nombre in done.tools_usadas
                )
                # Se persiste ANTES de emitir el `done`: el turno queda guardado aunque
                # el cliente corte al recibirlo. El costo es la latencia de una llamada
                # a Memory (fail-open: si falla, no impide emitir el evento final).
                if memoria:
                    memoria.registrar_turno(actor, sesion, message, texto)
                yield f"data: {json.dumps({'type': 'done', 'text': texto})}\n\n"
            except Exception as exc:
                logger.error("Fallo el workflow del agente a mitad del stream: %s", exc)
                yield f"data: {json.dumps({'type': 'error', 'code': 'agent_error'})}\n\n"
            finally:
                # DESPUÉS del evento final a propósito: resolver la tarifa puede
                # costar una llamada a la Pricing API la primera vez de cada
                # microVM, y el usuario no la espera. En `finally` para que un
                # turno que se cayó también quede contado (y es código síncrono:
                # nada que await en el cierre del generador).
                _loguear_cierre(sesion, cfg, adaptador, escalado, estimador_de_costo)

        return StreamingResponse(eventos(), media_type="text/event-stream")

    return Starlette(
        routes=[Route("/ping", ping), Route("/invocations", invocations, methods=["POST"])]
    )


if __name__ == "__main__":
    import uvicorn

    # Sin esto el log de cierre del turno (INFO) se perdería: uvicorn configura
    # sus propios loggers y deja el root en WARNING, así que `logger.info` no
    # llegaría nunca a CloudWatch.
    #
    # El root queda en WARNING y solo nuestros módulos suben a INFO: botocore y
    # compañía loguean cosas como "Found credentials in ..." en INFO y no vale
    # pagar por eso en cada microVM. `__name__` acá es "__main__", que es
    # justamente el logger de este archivo cuando se corre como script.
    #
    # El formato es solo el mensaje: así la línea del cierre del turno es JSON
    # puro y Logs Insights la parsea sin `parse` ni regex.
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    logging.getLogger("agent").setLevel(logging.INFO)
    logging.getLogger(__name__).setLevel(logging.INFO)
    # La app se construye recién acá: el contenedor falla al arrancar si falta
    # config, y el import del módulo (en los tests) no dispara load_config.
    uvicorn.run(build_app(), host="0.0.0.0", port=PORT)
