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
from agent.workflow import ChatWorkflow

PORT = 8080

logger = logging.getLogger(__name__)


class _EchoLLM:
    """LLM de smoke: repite el mensaje. Solo se usa con FAKE_LLM=1."""

    async def astream(self, message: str, history: list[dict]):
        for palabra in f"eco: {message}".split(" "):
            yield palabra + " "


def build_app(llm_factory=None, env=None) -> Starlette:
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

    async def ping(_: Request) -> JSONResponse:
        return JSONResponse({"status": "Healthy"})

    async def invocations(request: Request):
        payload = await request.json()
        message = payload.get("message")
        if not message:
            return JSONResponse({"error": "falta 'message' en el payload"}, status_code=400)

        workflow = ChatWorkflow(llm=llm_factory(cfg), timeout=120)
        handler = workflow.run(message=message, history=payload.get("history") or [])

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
