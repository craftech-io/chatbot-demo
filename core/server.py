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
from agent.events import TextDelta
from agent.llm import BedrockAdapter
from agent.memoria import Memoria
from agent.tools import crear_tools_usuario, tools_de_gateway
from agent.workflow import ChatWorkflow, LlamadaTool

PORT = 8080

logger = logging.getLogger(__name__)


class _EchoLLM:
    """LLM de smoke: repite el mensaje. Solo se usa con FAKE_LLM=1.

    Con tools, ante un mensaje que menciona "pedido" simula una tool call a
    `mis_pedidos` (regla del modo local: pinea el loop sin Bedrock ni red).
    """

    async def astream(self, message: str, history: list[dict]):
        for palabra in f"eco: {message}".split(" "):
            yield palabra + " "

    async def aresponder_con_tools(self, message: str, history: list[dict], tools: list):
        if history and history[-1].get("role") == "tool":
            # Segunda ronda: "redacta" la respuesta con el resultado de la tool.
            return f"eco tools: {history[-1]['content']}", []
        if "pedido" in message.lower():
            return None, [LlamadaTool(id="eco-1", nombre="mis_pedidos", argumentos={})]
        return f"eco: {message}", []


def build_app(
    llm_factory=None,
    env=None,
    memoria_factory=None,
    tools_usuario_factory=None,
    tools_gateway_factory=None,
) -> Starlette:
    # `env` se inyecta en los tests; en el contenedor es os.environ.
    env = os.environ if env is None else env
    # La config se carga al CONSTRUIR la app, no por request: si falta algo
    # obligatorio es preferible no arrancar (la misma razón de config.py).
    cfg = load_config(env)
    # El factory se inyecta en los tests para no pegarle a Bedrock.
    # FAKE_LLM permite el smoke del contenedor sin credenciales de Bedrock.
    if llm_factory is None and env.get("FAKE_LLM"):
        llm_factory = lambda cfg: _EchoLLM()  # noqa: E731
    llm_factory = llm_factory or BedrockAdapter
    # Sin MEMORY_ID (Task 4 no cableó el recurso, o entorno sin memoria) queda en
    # None: el server sigue usando `payload.get("history")` como en 2a.
    if memoria_factory is None and cfg.memory_id:
        memoria_factory = lambda cfg: Memoria(cfg.memory_id)  # noqa: E731
    memoria = memoria_factory(cfg) if memoria_factory else None
    tools_usuario_factory = tools_usuario_factory or crear_tools_usuario
    tools_gateway_factory = tools_gateway_factory or tools_de_gateway
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
        # El actToken viene del payload del InvokeAgentRuntime (contrato 2d) y
        # muere acá: entra a la tool de usuario como Bearer y a ningún otro lado.
        tools = await armar_tools(payload.get("actToken"))

        workflow = ChatWorkflow(llm=llm_factory(cfg), tools=tools or None, timeout=120)
        handler = workflow.run(message=message, history=history)

        async def eventos():
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
                texto = (await handler).texto
                # Se persiste ANTES de emitir el `done`: el turno queda guardado aunque
                # el cliente corte al recibirlo. El costo es la latencia de una llamada
                # a Memory (fail-open: si falla, no impide emitir el evento final).
                if memoria:
                    memoria.registrar_turno(actor, sesion, message, texto)
                yield f"data: {json.dumps({'type': 'done', 'text': texto})}\n\n"
            except Exception as exc:
                logger.error("Fallo el workflow del agente a mitad del stream: %s", exc)
                yield f"data: {json.dumps({'type': 'error', 'code': 'agent_error'})}\n\n"

        return StreamingResponse(eventos(), media_type="text/event-stream")

    return Starlette(
        routes=[Route("/ping", ping), Route("/invocations", invocations, methods=["POST"])]
    )


if __name__ == "__main__":
    import uvicorn

    # La app se construye recién acá: el contenedor falla al arrancar si falta
    # config, y el import del módulo (en los tests) no dispara load_config.
    uvicorn.run(build_app(), host="0.0.0.0", port=PORT)
