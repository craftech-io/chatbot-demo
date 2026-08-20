# craftech-ai-chat — Fase 2a: esqueleto vertical

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un mensaje escrito en el widget llega al agente en AgentCore Runtime, el LLM responde, y la respuesta se ve aparecer token por token — sin tools y sin RAG.

**Architecture:** El widget habla con una Lambda (BFF) en modo response streaming. El BFF valida el token del usuario, invoca AgentCore Runtime con IAM y traduce el NDJSON que devuelve a SSE para el browser. Dentro del Runtime corre un contenedor ARM64 que expone `/ping` y `/invocations`, donde un Workflow de LlamaIndex llama a Bedrock Converse y emite un evento por cada delta de texto.

**Tech Stack:** Python 3.12 · `llama-index-workflows` · `llama-index-llms-bedrock-converse` · boto3 · pytest + pytest-asyncio · TypeScript · `@aws-sdk/client-bedrock-agentcore` · `jose` · vitest · SST v4 · Docker (ARM64)

**Spec:** `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md`

**Convención de rutas:** todas las rutas de este plan son **relativas a la raíz del
repo**, y todo comando se ejecuta desde ahí salvo que el paso indique otro directorio.
No hay rutas absolutas: el repo puede vivir donde el ejecutor quiera.

## Global Constraints

Estas reglas aplican a **todas** las tareas:

- **La imagen del contenedor DEBE ser ARM64.** AgentCore Runtime no acepta otra arquitectura. En Docker: `--platform linux/arm64`.
- **Contrato del Runtime:** el contenedor escucha en `0.0.0.0:8080`, expone `GET /ping` (devuelve `{"status":"Healthy"}`) y `POST /invocations`.
- **`InvokeAgentRuntime` devuelve NDJSON**, una línea JSON por evento — no SSE. La traducción a SSE la hace el BFF.
- **AgentCore corre la imagen en una microVM de Firecracker por sesión, y la mantiene viva entre invocaciones** ruteando por `runtimeSessionId`. Ese id se **deriva** del principal verificado; aceptarlo del browser permitiría a un usuario caer en la microVM caliente de otro.
- **El core nunca usa `Resource` de SST.** Lee su config por `core/src/agent/config.py` (env, y SSM en fases posteriores). Un `import` de SST en `core/` es un error de revisión.
- **El BFF usa `Resource` únicamente dentro de `src/config/resource.ts`.** El resto del código consume la interfaz de `src/config/index.ts`.
- **Guardrail fail-open:** si el guardrail falla, se loguea y el chat sigue. Nunca cortar la conversación por una falla del filtro.
- **Guardrail de salida vía `guardrail_stream_processing_mode="sync"`** en BedrockConverse, para que Bedrock filtre cada chunk antes de emitirlo. Nunca filtrar a mano texto ya streameado.
- **Máximo 400 líneas por archivo.** Organización feature-based.
- **Producto en español**, sin i18n. Los textos visibles salen de un registro, no de literales dispersos.
- **Antes de escribir un literal, buscar si ya existe un registro** (regla de oro de parametría heredada de `msp-platform`).
- **Versiones exactas y lockfile commiteado.** No usar rangos abiertos: `uv add` para Python, `npm i -E` para TS.

---

## Estructura de archivos

Todo se crea en un repo nuevo llamado `craftech-ai-chat`. Las rutas de la tabla son
relativas a su raíz.

| Archivo | Responsabilidad |
|---|---|
| `core/src/agent/workflow.py` | El harness: eventos y pasos del Workflow. No sabe de HTTP ni de AWS |
| `core/src/agent/config.py` | Única puerta a la config del core: lee env, valida lo obligatorio |
| `core/src/agent/llm.py` | Adaptador de modelo: construye el cliente de Bedrock Converse con su guardrail |
| `core/src/agent/events.py` | Los tipos de evento del stream, compartidos entre workflow y server |
| `core/server.py` | Contrato HTTP del Runtime: `/ping` y `/invocations` con SSE. Sin lógica de agente |
| `core/Dockerfile` | Imagen ARM64 del contenedor |
| `packages/bff/src/auth/verify.ts` | Verificación del token del usuario: HMAC y JWKS |
| `packages/bff/src/config/index.ts` | Interfaz de config del BFF (agnóstica de IaC) |
| `packages/bff/src/config/resource.ts` | Implementación SST: el único archivo que importa `Resource` |
| `packages/bff/src/chat/handler.ts` | Function URL de chat: valida, invoca el Runtime, traduce NDJSON→SSE |
| `packages/bff/src/chat/ndjson.ts` | Traducción de NDJSON a SSE, aislada para poder testearla sola |
| `packages/widget/src/index.ts` | `mount()`: monta la UI, pide el token, envía el mensaje, renderiza deltas |
| `packages/widget/src/token.ts` | Obtención y renovación del token contra `/chat-token` del cliente |
| `examples/demo-client/` | Cliente de prueba y ejemplo de integración: sirve la página con el widget y firma el `/chat-token` |
| `infra/sst/` | Sabor de referencia: Runtime, BFF, ECR, roles |
| `infra/CONTRACT.md` | Las variables que cualquier sabor de IaC debe inyectar |

---

### Task 1: Repo y workflow mínimo del core

Arranca el repo y deja el harness corriendo con un LLM falso. Sin Bedrock todavía: se valida que el Workflow emite deltas al stream y devuelve el texto completo.

**Files:**
- Create: `pyproject.toml`, `core/src/agent/__init__.py`, `core/src/agent/events.py`, `core/src/agent/workflow.py`
- Test: `core/tests/test_workflow.py`

**Interfaces:**
- Produces:
  - `class TextDelta(Event)` con campo `text: str`
  - `class ChatStart(StartEvent)` con campos `message: str`, `history: list[dict]`
  - `class ChatDone(StopEvent)` con campo `texto: str`. **Dos cosas:** (1) `await handler`
    devuelve la instancia de `ChatDone`, no el string — el framework desenvuelve
    `.result` solo cuando el StopEvent es exactamente `StopEvent`, no un subtipo;
    (2) el campo se llama `texto` y no `result` para no colisionar con el `result` de
    `StopEvent`. Todo consumidor escribe `(await handler).texto`.
  - `class ChatWorkflow(Workflow)` — su constructor recibe `llm` (cualquier objeto con `astream(message, history) -> AsyncIterator[str]`)

- [ ] **Step 1: Crear el repo y el proyecto Python**

```bash
# El repo se crea en el directorio de trabajo actual. El nombre de la carpeta es el
# del proyecto; a partir de acá, todo comando corre desde esta raíz.
mkdir -p craftech-ai-chat/core/src/agent craftech-ai-chat/core/tests
cd craftech-ai-chat
git init
printf '__pycache__/\n.venv/\n*.pyc\nnode_modules/\n.sst/\ndist/\n.env\n*.local\n' > .gitignore
uv init --bare
uv add llama-index-workflows
uv add --dev pytest pytest-asyncio
touch core/src/agent/__init__.py
```

Agregar a `pyproject.toml`:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
pythonpath = ["core/src"]
```

- [ ] **Step 2: Escribir el test que falla**

`core/tests/test_workflow.py`:

```python
from agent.events import TextDelta
from agent.workflow import ChatWorkflow


class FakeLLM:
    """Doble del adaptador de LLM: emite chunks fijos."""

    def __init__(self, chunks: list[str]):
        self.chunks = chunks
        self.seen: dict | None = None

    async def astream(self, message: str, history: list[dict]):
        self.seen = {"message": message, "history": history}
        for c in self.chunks:
            yield c


async def test_emite_un_delta_por_chunk_y_devuelve_el_texto_completo():
    llm = FakeLLM(["Hola", " ", "mundo"])
    handler = ChatWorkflow(llm=llm, timeout=10).run(message="¿hola?", history=[])

    deltas = [ev.text async for ev in handler.stream_events() if isinstance(ev, TextDelta)]
    # `await handler` devuelve el ChatDone, NO su `.result`: el framework solo
    # desenvuelve cuando el StopEvent es exactamente StopEvent, jamás un subtipo.
    done = await handler

    assert deltas == ["Hola", " ", "mundo"]
    assert done.texto == "Hola mundo"
    assert llm.seen == {"message": "¿hola?", "history": []}
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `uv run pytest core/tests/test_workflow.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'agent.events'`

- [ ] **Step 4: Escribir la implementación mínima**

`core/src/agent/events.py`:

```python
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
    con el `result` de `StopEvent`. Esa colisión no es solo un warning de pydantic —
    en versiones anteriores de la librería hacía que `result` quedara silenciosamente
    como un `property object` en vez del string.
    """

    texto: str
```

`core/src/agent/workflow.py`:

```python
"""El harness: el loop del agente como grafo de pasos y eventos explícito.

Que sea un Workflow y no un loop opaco es lo que lo hace testeable paso a paso:
cada step se prueba por los eventos que emite, con dobles de LLM y de tools.
"""

from workflows import Context, Workflow, step

from .events import ChatDone, ChatStart, TextDelta


class ChatWorkflow(Workflow):
    def __init__(self, llm, **kwargs):
        # `llm` es el adaptador de modelo (agent/llm.py) o un doble en los tests.
        # El workflow no conoce Bedrock: solo el protocolo `astream`.
        super().__init__(**kwargs)
        self.llm = llm

    @step
    async def responder(self, ctx: Context, ev: ChatStart) -> ChatDone:
        # Cada chunk del modelo se publica al stream apenas llega, y a la vez se
        # acumula: el texto completo es lo que después se persiste en la memoria.
        partes: list[str] = []
        async for chunk in self.llm.astream(ev.message, ev.history):
            partes.append(chunk)
            ctx.write_event_to_stream(TextDelta(text=chunk))
        return ChatDone(texto="".join(partes))
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `uv run pytest core/tests/test_workflow.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock .gitignore core/
git commit -m "feat(core): workflow del agente con streaming de deltas"
```

---

### Task 2: Config del core

La única puerta a la configuración. Falla al arrancar con un mensaje claro si falta algo obligatorio, en vez de romper en la primera invocación.

**Files:**
- Create: `core/src/agent/config.py`
- Test: `core/tests/test_config.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Config` con campos `model_id: str`, `guardrail_id: str | None`, `guardrail_version: str | None`, `region: str`
  - `def load_config(env: Mapping[str, str]) -> Config` — lanza `ConfigError` si falta `MODEL_ID`
  - `class ConfigError(RuntimeError)`

- [ ] **Step 1: Escribir el test que falla**

`core/tests/test_config.py`:

```python
import pytest

from agent.config import ConfigError, load_config


def test_falla_con_mensaje_claro_si_falta_el_modelo():
    with pytest.raises(ConfigError, match="MODEL_ID"):
        load_config({})


def test_lee_el_modelo_y_el_guardrail():
    cfg = load_config(
        {
            "MODEL_ID": "us.anthropic.claude-sonnet-4-6",
            "GUARDRAIL_ID": "gr-123",
            "GUARDRAIL_VERSION": "3",
            "AWS_REGION": "us-east-1",
        }
    )
    assert cfg.model_id == "us.anthropic.claude-sonnet-4-6"
    assert cfg.guardrail_id == "gr-123"
    assert cfg.guardrail_version == "3"
    assert cfg.region == "us-east-1"


def test_el_guardrail_es_opcional():
    cfg = load_config({"MODEL_ID": "m", "AWS_REGION": "us-east-1"})
    assert cfg.guardrail_id is None
    assert cfg.guardrail_version is None
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `uv run pytest core/tests/test_config.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'agent.config'`

- [ ] **Step 3: Escribir la implementación mínima**

`core/src/agent/config.py`:

```python
"""Única puerta a la configuración del core.

El core NO conoce el IaC que lo desplegó: recibe todo por variables de entorno,
según el contrato de `infra/CONTRACT.md`. Un `import` de SST acá es un error.
"""

from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Falta configuración obligatoria: es preferible no arrancar."""


@dataclass(frozen=True)
class Config:
    model_id: str
    guardrail_id: str | None
    guardrail_version: str | None
    region: str


def load_config(env: Mapping[str, str]) -> Config:
    model_id = env.get("MODEL_ID")
    if not model_id:
        raise ConfigError(
            "Falta MODEL_ID. Lo inyecta el IaC según infra/CONTRACT.md."
        )
    return Config(
        model_id=model_id,
        guardrail_id=env.get("GUARDRAIL_ID") or None,
        guardrail_version=env.get("GUARDRAIL_VERSION") or None,
        region=env.get("AWS_REGION", "us-east-1"),
    )
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `uv run pytest core/tests/test_config.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agent/config.py core/tests/test_config.py
git commit -m "feat(core): config por env con validacion al arrancar"
```

---

### Task 3: Adaptador de LLM sobre Bedrock Converse

Traduce el protocolo `astream` que espera el workflow a una llamada real de Bedrock, con el guardrail de salida aplicado por Bedrock en modo síncrono.

**Files:**
- Create: `core/src/agent/llm.py`
- Test: `core/tests/test_llm.py`

**Interfaces:**
- Consumes: `Config` de Task 2
- Produces:
  - `class BedrockAdapter` con `__init__(self, cfg: Config, client_factory=BedrockConverse)` y `async def astream(self, message: str, history: list[dict]) -> AsyncIterator[str]`

**Nota importante para el implementador:** hay issues conocidos en `BedrockConverse` donde `astream_chat` no emite tokens o el stream no termina. Por eso el test 2 de esta tarea verifica explícitamente que el generador **cierra**. Si al integrar contra Bedrock real el stream cuelga, es este bug conocido: fijar la versión que funcione y dejarlo anotado en el commit.

- [ ] **Step 1: Instalar la integración**

```bash
uv add llama-index-llms-bedrock-converse
```

- [ ] **Step 2: Escribir el test que falla**

`core/tests/test_llm.py`:

```python
import asyncio

from llama_index.core.base.llms.types import ChatMessage, ChatResponse

from agent.config import load_config
from agent.llm import BedrockAdapter

ENV = {
    "MODEL_ID": "us.anthropic.claude-sonnet-4-6",
    "GUARDRAIL_ID": "gr-123",
    "GUARDRAIL_VERSION": "3",
    "AWS_REGION": "us-east-1",
}


class FakeConverse:
    """Doble de BedrockConverse: registra cómo fue construido y qué recibió."""

    kwargs: dict = {}

    def __init__(self, **kwargs):
        FakeConverse.kwargs = kwargs
        self.recibido: list[ChatMessage] = []

    async def astream_chat(self, messages):
        self.recibido = messages

        async def gen():
            for texto in ("Hola", "Hola mundo"):
                yield ChatResponse(
                    message=ChatMessage(role="assistant", content=texto),
                    delta=texto[len("Hola") :] if texto != "Hola" else "Hola",
                )

        return gen()


def test_construye_el_cliente_con_el_guardrail_en_modo_sync():
    BedrockAdapter(load_config(ENV), client_factory=FakeConverse)
    assert FakeConverse.kwargs["model"] == "us.anthropic.claude-sonnet-4-6"
    assert FakeConverse.kwargs["guardrail_identifier"] == "gr-123"
    assert FakeConverse.kwargs["guardrail_version"] == "3"
    assert FakeConverse.kwargs["guardrail_stream_processing_mode"] == "sync"


async def test_emite_deltas_y_el_generador_termina():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)

    async def recolectar():
        return [c async for c in adapter.astream("¿hola?", [])]

    # El timeout es el test: hay bugs conocidos de streams que no cierran.
    deltas = await asyncio.wait_for(recolectar(), timeout=5)
    assert deltas == ["Hola", " mundo"]


async def test_manda_el_historial_antes_del_mensaje_nuevo():
    adapter = BedrockAdapter(load_config(ENV), client_factory=FakeConverse)
    history = [{"role": "user", "content": "previo"}, {"role": "assistant", "content": "ok"}]

    async for _ in adapter.astream("nuevo", history):
        pass

    roles = [(m.role, m.content) for m in adapter.client.recibido]
    assert roles == [("user", "previo"), ("assistant", "ok"), ("user", "nuevo")]
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `uv run pytest core/tests/test_llm.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'agent.llm'`

- [ ] **Step 4: Escribir la implementación mínima**

`core/src/agent/llm.py`:

```python
"""Adaptador de modelo. Es la frontera que permite cambiar de proveedor sin tocar
el workflow: este archivo es el único que sabe que abajo hay Bedrock.

El guardrail de SALIDA se aplica acá, delegado a Bedrock con
`guardrail_stream_processing_mode="sync"`: Bedrock evalúa cada chunk ANTES de emitirlo.
Filtrar a mano texto ya streameado llegaría tarde.
"""

from collections.abc import AsyncIterator

from llama_index.core.base.llms.types import ChatMessage
from llama_index.llms.bedrock_converse import BedrockConverse

from .config import Config


class BedrockAdapter:
    def __init__(self, cfg: Config, client_factory=BedrockConverse):
        kwargs = {"model": cfg.model_id, "region_name": cfg.region}
        if cfg.guardrail_id:
            kwargs |= {
                "guardrail_identifier": cfg.guardrail_id,
                "guardrail_version": cfg.guardrail_version,
                "guardrail_stream_processing_mode": "sync",
            }
        self.client = client_factory(**kwargs)

    async def astream(self, message: str, history: list[dict]) -> AsyncIterator[str]:
        messages = [ChatMessage(role=h["role"], content=h["content"]) for h in history]
        messages.append(ChatMessage(role="user", content=message))
        stream = await self.client.astream_chat(messages)
        async for response in stream:
            if response.delta:
                yield response.delta
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `uv run pytest core/tests/ -v`
Expected: PASS (todos, incluidos los de Tasks 1 y 2)

- [ ] **Step 6: Commit**

```bash
git add core/src/agent/llm.py core/tests/test_llm.py pyproject.toml uv.lock
git commit -m "feat(core): adaptador de Bedrock Converse con guardrail sync"
```

---

### Task 4: Server del contenedor — `/ping` y `/invocations`

El contrato HTTP que exige AgentCore Runtime. Sin lógica de agente: arma el workflow, lo corre y traduce sus eventos a SSE.

**Files:**
- Create: `core/server.py`
- Test: `core/tests/test_server.py`

**Interfaces:**
- Consumes: `ChatWorkflow` (Task 1), `load_config` (Task 2), `BedrockAdapter` (Task 3)
- Produces:
  - `def build_app(llm_factory=None, env=None) -> Starlette` — app ASGI con `GET /ping`
    y `POST /invocations`. La config se carga al construir la app (fail-fast); `env`
    se inyecta en tests y default a `os.environ`. No hay `app` a nivel módulo.
  - Formato de los eventos SSE: `data: {"type":"delta","text":"..."}` por chunk,
    `data: {"type":"done","text":"..."}` al final, y — si el workflow falla a mitad
    del stream — un frame terminal `data: {"type":"error","code":"agent_error"}`
    en lugar del `done`: el cliente nunca recibe un stream truncado sin señal

- [ ] **Step 1: Instalar el servidor ASGI**

```bash
# httpx2: el TestClient de starlette >=1.6 lo usa como backend; con httpx clásico
# emite un deprecation warning y la salida de tests debe quedar limpia.
uv add starlette uvicorn && uv add --dev httpx2
```

- [ ] **Step 2: Escribir el test que falla**

`core/tests/test_server.py`:

```python
import json

from starlette.testclient import TestClient

from server import build_app


class FakeLLM:
    async def astream(self, message: str, history: list[dict]):
        for c in ("Hola", " mundo"):
            yield c


def client():
    # env inyectado: los tests no dependen de os.environ.
    return TestClient(
        build_app(llm_factory=lambda cfg: FakeLLM(), env={"MODEL_ID": "fake"})
    )


def test_ping_responde_healthy():
    r = client().get("/ping")
    assert r.status_code == 200
    assert r.json() == {"status": "Healthy"}


def test_invocations_streamea_deltas_y_evento_final():
    r = client().post("/invocations", json={"message": "¿hola?", "history": []})
    assert r.status_code == 200

    eventos = [
        json.loads(line[len("data: ") :])
        for line in r.text.splitlines()
        if line.startswith("data: ")
    ]
    assert eventos == [
        {"type": "delta", "text": "Hola"},
        {"type": "delta", "text": " mundo"},
        {"type": "done", "text": "Hola mundo"},
    ]


def test_invocations_rechaza_payload_sin_mensaje():
    r = client().post("/invocations", json={"history": []})
    assert r.status_code == 400
    assert "message" in r.json()["error"]
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `uv run pytest core/tests/test_server.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'server'`

- [ ] **Step 4: Escribir la implementación mínima**

`core/server.py`:

```python
"""Contrato HTTP de AgentCore Runtime (BYOC): 0.0.0.0:8080, GET /ping y
POST /invocations. Este archivo no tiene lógica de agente: arma el workflow,
lo corre y traduce sus eventos a SSE.

La invocación llega por InvokeAgentRuntime con IAM, así que el payload lo armó el
BFF después de validar al usuario: es CONFIABLE. No se valida identidad acá.
"""

import json
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


def build_app(llm_factory=None, env=None) -> Starlette:
    # `env` se inyecta en los tests; en el contenedor es os.environ.
    env = os.environ if env is None else env
    # La config se carga al CONSTRUIR la app, no por request: si falta algo
    # obligatorio es preferible no arrancar (la misma razón de config.py).
    cfg = load_config(env)
    # El factory se inyecta en los tests para no pegarle a Bedrock.
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
            async for ev in handler.stream_events():
                if isinstance(ev, TextDelta):
                    yield f"data: {json.dumps({'type': 'delta', 'text': ev.text})}\n\n"
            # `.texto` explícito: await sobre el handler devuelve el ChatDone, no un
            # string (el framework no desenvuelve subtipos de StopEvent), y el campo
            # se llama `texto` para no colisionar con el `result` de StopEvent.
            texto = (await handler).texto
            yield f"data: {json.dumps({'type': 'done', 'text': texto})}\n\n"

        return StreamingResponse(eventos(), media_type="text/event-stream")

    return Starlette(
        routes=[Route("/ping", ping), Route("/invocations", invocations, methods=["POST"])]
    )


if __name__ == "__main__":
    import uvicorn

    # La app se construye recién acá: el contenedor falla al arrancar si falta
    # config, y el import del módulo (en los tests) no dispara load_config.
    uvicorn.run(build_app(), host="0.0.0.0", port=PORT)
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `uv run pytest core/tests/ -v`
Expected: PASS (todos)

- [ ] **Step 6: Commit**

```bash
git add core/server.py core/tests/test_server.py pyproject.toml uv.lock
git commit -m "feat(core): server del contenedor con contrato de AgentCore Runtime"
```

---

### Task 5: Imagen ARM64 y smoke local del contenedor

**Files:**
- Create: `core/Dockerfile`, `core/.dockerignore`, `core/smoke.sh`

**Interfaces:**
- Consumes: `core/server.py` (Task 4)
- Produces: imagen local `craftech-ai-chat-core:dev` (ARM64), y `core/smoke.sh` que la levanta y verifica `/ping` e `/invocations`

- [ ] **Step 1: Escribir el Dockerfile**

`core/Dockerfile`:

```dockerfile
# ARM64 es OBLIGATORIO: AgentCore Runtime no acepta otra arquitectura.
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

COPY core/ ./core/
ENV PYTHONPATH=/app/core/src

EXPOSE 8080
CMD ["uv", "run", "--no-dev", "python", "core/server.py"]
```

`core/.dockerignore`:

```
core/tests/
**/__pycache__/
.venv/
```

- [ ] **Step 2: Escribir el script de smoke**

`core/smoke.sh`:

```bash
#!/usr/bin/env bash
# Smoke del contenedor: levanta la imagen y verifica el contrato del Runtime.
# Usa FAKE_LLM=1 para no pegarle a Bedrock.
set -euo pipefail

docker build --platform linux/arm64 -f core/Dockerfile -t craftech-ai-chat-core:dev .
cid=$(docker run -d -p 8080:8080 -e MODEL_ID=fake -e FAKE_LLM=1 craftech-ai-chat-core:dev)
trap 'docker rm -f "$cid" >/dev/null' EXIT

# Presupuesto generoso: bajo QEMU (build multi-arch en x86) el arranque tarda
# ~30s; en ARM real es mucho menor. 60×2s cubre ambos con margen.
for _ in $(seq 1 60); do
  if curl -sf localhost:8080/ping >/dev/null; then break; fi
  sleep 2
done

echo "== /ping =="
curl -sf localhost:8080/ping | grep -q Healthy && echo OK

echo "== /invocations =="
curl -sfN localhost:8080/invocations -H 'content-type: application/json' \
  -d '{"message":"hola","history":[]}' | grep -q '"type": "done"' && echo OK
```

- [ ] **Step 3: Agregar el LLM falso al server para el smoke**

En `core/server.py`, dentro de `build_app`, reemplazar exactamente esta línea:

```python
    llm_factory = llm_factory or BedrockAdapter
```

por estas tres:

```python
    # FAKE_LLM permite el smoke del contenedor sin credenciales de Bedrock.
    if llm_factory is None and env.get("FAKE_LLM"):
        llm_factory = lambda cfg: _EchoLLM()  # noqa: E731
    llm_factory = llm_factory or BedrockAdapter
```

Y agregar, arriba de la definición de `build_app`:

```python
class _EchoLLM:
    """LLM de smoke: repite el mensaje. Solo se usa con FAKE_LLM=1."""

    async def astream(self, message: str, history: list[dict]):
        for palabra in f"eco: {message}".split(" "):
            yield palabra + " "
```

- [ ] **Step 4: Correr el smoke y verificar que pasa**

Run: `chmod +x core/smoke.sh && ./core/smoke.sh`
Expected: dos líneas `OK`. Si el build falla por la plataforma, verificar que Docker tenga emulación ARM64 (`docker run --privileged --rm tonistiigi/binfmt --install arm64`).

- [ ] **Step 5: Medir el arranque en frío y anotarlo**

Run: `time docker run --rm -e MODEL_ID=fake -e FAKE_LLM=1 craftech-ai-chat-core:dev uv run --no-dev python -c "import agent.workflow, agent.llm"`

(El `uv run --no-dev` es necesario: el `python` pelado del contenedor no ve el venv
que `uv sync` creó.) Anotar junto al valor que la medición es **bajo QEMU en amd64**:
en ARM real (CI y AWS) el arranque es mucho menor — el número sirve como cota
superior, no como estimación del cold start productivo.

Crear el archivo con los resultados:

```bash
mkdir -p docs
cat > docs/mediciones.md <<'MD'
# Mediciones

El spec marca el cold start del contenedor como riesgo 2. Estas mediciones son las
que lo cierran o lo escalan.

| Fecha | Qué | Valor |
|---|---|---|
| <hoy> | tamaño de la imagen (`docker images craftech-ai-chat-core:dev`) | |
| <hoy> | import de `agent.workflow` + `agent.llm` en el contenedor | |
MD
```

Completar la tabla con los valores obtenidos.

- [ ] **Step 6: Commit**

```bash
git add core/Dockerfile core/.dockerignore core/smoke.sh core/server.py docs/mediciones.md
git commit -m "feat(core): imagen ARM64 y smoke del contrato del Runtime"
```

---

### Task 6: BFF — verificación del token del usuario

La frontera de confianza. Del token del usuario sale el principal; sin token válido no se invoca nada. Dos emisores: el backend del cliente (HMAC o JWKS) y, más adelante, Cognito del standalone.

**Files:**
- Create: `package.json` (raíz, workspaces), `packages/bff/package.json`, `packages/bff/tsconfig.json`, `packages/bff/src/auth/verify.ts`
- Test: `packages/bff/src/auth/verify.test.ts`

**Interfaces:**
- Produces:
  - `type Principal = { userId: string; email?: string; actToken?: string }`
  - `type Verifier = { kind: "hmac"; secret: string } | { kind: "jwks"; url: string }`
  - `async function verifyUserToken(token: string, v: Verifier): Promise<Principal>` — lanza `AuthError` si el token es inválido, expirado o le falta `sub`
  - `class AuthError extends Error` con `code: "invalid_token" | "expired_token"`

- [ ] **Step 1: Crear el workspace TS y el paquete del BFF**

```bash
cd "$(git rev-parse --show-toplevel)"
cat > package.json <<'JSON'
{
  "name": "craftech-ai-chat",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present"
  }
}
JSON
mkdir -p packages/bff/src/auth
cd packages/bff
npm init -y >/dev/null
npm i -E jose
npm i -E -D typescript vitest @types/node
```

`packages/bff/package.json` — agregar:

```json
{
  "name": "@craftech-ai-chat/bff",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`packages/bff/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Escribir el test que falla**

`packages/bff/src/auth/verify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { AuthError, verifyUserToken } from "./verify";

const SECRET = new TextEncoder().encode("un-secreto-de-al-menos-32-bytes!!");
const verifier = { kind: "hmac", secret: "un-secreto-de-al-menos-32-bytes!!" } as const;

async function firmar(claims: Record<string, unknown>, exp = "10m") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(SECRET);
}

describe("verifyUserToken", () => {
  it("devuelve el principal de un token HMAC valido", async () => {
    const token = await firmar({ sub: "4821", email: "juan@empresa.com" });
    const p = await verifyUserToken(token, verifier);
    expect(p).toEqual({ userId: "4821", email: "juan@empresa.com", actToken: undefined });
  });

  it("propaga el actToken cuando viene en el claim", async () => {
    const token = await firmar({ sub: "4821", act_token: "tok-api-cliente" });
    const p = await verifyUserToken(token, verifier);
    expect(p.actToken).toBe("tok-api-cliente");
  });

  it("rechaza un token expirado con code expired_token", async () => {
    const token = await firmar({ sub: "4821" }, "-1m");
    await expect(verifyUserToken(token, verifier)).rejects.toMatchObject({
      code: "expired_token",
    });
  });

  it("rechaza una firma que no corresponde", async () => {
    const token = await firmar({ sub: "4821" });
    const otro = { kind: "hmac", secret: "otro-secreto-de-32-bytes-o-mas!!" } as const;
    await expect(verifyUserToken(token, otro)).rejects.toBeInstanceOf(AuthError);
  });

  it("rechaza un token sin sub: sin identidad no hay principal", async () => {
    const token = await firmar({ email: "juan@empresa.com" });
    await expect(verifyUserToken(token, verifier)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `cd packages/bff && npx vitest run src/auth/verify.test.ts`
Expected: FAIL — no existe `./verify`

- [ ] **Step 4: Escribir la implementación mínima**

`packages/bff/src/auth/verify.ts`:

```ts
// Verificación del token del usuario final. Es la frontera de confianza del
// sistema: todo lo que sale de acá se considera cierto, y nada que no haya pasado
// por acá llega al Runtime.
//
// El token lo emite el backend del CLIENTE en su endpoint /chat-token, para el
// usuario que ya está logueado en su app. Nosotros solo verificamos la firma:
// nunca manejamos sus credenciales ni le pedimos un segundo login al usuario.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type Principal = {
  userId: string;
  email?: string;
  // Token para llamar a la API del cliente EN NOMBRE del usuario. En la mayoría
  // de los casos es el mismo token (si su API ya usa JWTs de acceso); viaja
  // aparte solo cuando su API usa otro esquema de auth.
  actToken?: string;
};

export type Verifier =
  | { kind: "hmac"; secret: string }
  | { kind: "jwks"; url: string };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_token" | "expired_token",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// Los JWKSet se cachean por URL: crear uno por request perdería el cache de
// claves de `jose` y agregaría una llamada HTTP a cada mensaje del chat.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(url: string) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

// Algoritmos permitidos por tipo de emisor. Allowlist explícita: en una frontera
// de confianza no se deja que el token elija el algoritmo.
const HMAC_ALGS = ["HS256"];
const JWKS_ALGS = ["RS256", "ES256", "PS256", "EdDSA"];

export async function verifyUserToken(
  token: string,
  v: Verifier,
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    // Sin cast: cada tipo de clave va con su allowlist en su propia rama.
    ({ payload } =
      v.kind === "hmac"
        ? await jwtVerify(token, new TextEncoder().encode(v.secret), {
            algorithms: HMAC_ALGS,
          })
        : await jwtVerify(token, jwks(v.url), { algorithms: JWKS_ALGS }));
  } catch (e) {
    // jose marca sus errores con .code (estable ante minificación, a diferencia
    // de .name). Lo que no venga de jose (red, DNS, URL malformada) se loguea
    // antes de fallar cerrado: una caída del JWKS no debe quedar indistinguible
    // de un token adulterado en los logs.
    const code = (e as { code?: string }).code ?? "";
    if (!code.startsWith("ERR_")) {
      console.error("verifyUserToken: error no-JWT verificando el token", e);
    }
    const expirado = code === "ERR_JWT_EXPIRED";
    throw new AuthError(
      expirado ? "el token venció" : "token inválido",
      expirado ? "expired_token" : "invalid_token",
    );
  }

  // `sub` es la identidad misma: se exige string no vacío, no solo truthy —
  // un emisor mal configurado que mande un sub numérico no puede colarse
  // como userId en el contrato que todo lo demás considera cierto.
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new AuthError("el token no trae 'sub'", "invalid_token");
  }

  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    actToken:
      typeof payload.act_token === "string" ? payload.act_token : undefined,
  };
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run src/auth/verify.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests) y typecheck limpio

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add package.json package-lock.json packages/bff/
git commit -m "feat(bff): verificacion del token del usuario (HMAC y JWKS)"
```

---

### Task 7: BFF — traducción NDJSON → SSE

`InvokeAgentRuntime` devuelve NDJSON. El browser consume SSE. Esta tarea aísla la traducción, porque su bug clásico —una línea JSON partida entre dos chunks de red— solo se ve con un test que la parta a propósito.

**Files:**
- Create: `packages/bff/src/chat/ndjson.ts`
- Test: `packages/bff/src/chat/ndjson.test.ts`

**Interfaces:**
- Produces:
  - `async function* parseNdjson(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Record<string, unknown>>` — junta líneas partidas entre chunks, ignora líneas vacías, y emite `{type:"error"}` ante JSON inválido en vez de tirar
  - `function toSse(event: Record<string, unknown>): string`

- [ ] **Step 1: Escribir el test que falla**

`packages/bff/src/chat/ndjson.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseNdjson, toSse } from "./ndjson";

const enc = new TextEncoder();

async function* fuente(...partes: string[]) {
  for (const p of partes) yield enc.encode(p);
}

async function recolectar(it: AsyncIterable<Record<string, unknown>>) {
  const out: Record<string, unknown>[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("parseNdjson", () => {
  it("parsea una linea por evento", async () => {
    const evs = await recolectar(
      parseNdjson(fuente('{"type":"delta","text":"Hola"}\n{"type":"done"}\n')),
    );
    expect(evs).toEqual([{ type: "delta", text: "Hola" }, { type: "done" }]);
  });

  it("junta una linea partida entre dos chunks", async () => {
    // Este es EL bug de los parsers de streaming: el chunk de red no respeta
    // los límites de línea.
    const evs = await recolectar(
      parseNdjson(fuente('{"type":"delta","te', 'xt":"Hola"}\n')),
    );
    expect(evs).toEqual([{ type: "delta", text: "Hola" }]);
  });

  it("emite la ultima linea aunque no venga con salto final", async () => {
    const evs = await recolectar(parseNdjson(fuente('{"type":"done"}')));
    expect(evs).toEqual([{ type: "done" }]);
  });

  it("ignora lineas vacias", async () => {
    const evs = await recolectar(parseNdjson(fuente('\n\n{"type":"done"}\n\n')));
    expect(evs).toEqual([{ type: "done" }]);
  });

  it("ante JSON invalido emite un evento de error y sigue", async () => {
    const evs = await recolectar(parseNdjson(fuente('roto\n{"type":"done"}\n')));
    expect(evs[0]).toMatchObject({ type: "error" });
    expect(evs[1]).toEqual({ type: "done" });
  });
});

describe("toSse", () => {
  it("formatea un evento como frame SSE", () => {
    expect(toSse({ type: "delta", text: "Hola" })).toBe(
      'data: {"type":"delta","text":"Hola"}\n\n',
    );
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd packages/bff && npx vitest run src/chat/ndjson.test.ts`
Expected: FAIL — no existe `./ndjson`

- [ ] **Step 3: Escribir la implementación mínima**

`packages/bff/src/chat/ndjson.ts`:

```ts
// AgentCore Runtime responde NDJSON: una línea JSON por evento. El browser
// consume SSE. Esta es toda la traducción, aislada para poder testear el caso
// que la rompe: un chunk de red que corta una línea por la mitad.

export async function* parseNdjson(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const dec = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    // stream: true mantiene el estado del decoder entre chunks, para no partir
    // un carácter multibyte (los acentos del español, justamente).
    buffer += dec.decode(chunk, { stream: true });
    let corte: number;
    while ((corte = buffer.indexOf("\n")) !== -1) {
      const linea = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 1);
      const ev = parsear(linea);
      if (ev) yield ev;
    }
  }

  // El Runtime puede cerrar sin salto final: la última línea también cuenta.
  const ultimo = parsear(buffer);
  if (ultimo) yield ultimo;
}

function parsear(linea: string): Record<string, unknown> | null {
  const t = linea.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    // Una línea corrupta no tumba la conversación: se reporta como evento.
    return { type: "error", error: "evento ilegible del agente" };
  }
}

export function toSse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run src/chat/ndjson.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests) y typecheck limpio

- [ ] **Step 5: Commit**

```bash
git add packages/bff/src/chat/
git commit -m "feat(bff): traduccion NDJSON a SSE con lineas partidas"
```

---

### Task 8: BFF — handler de chat

Une las piezas: config, verificación del token, invocación del Runtime y traducción del stream. Es el archivo que se despliega como Function URL en modo response streaming.

**Files:**
- Create: `packages/bff/src/config/index.ts`, `packages/bff/src/config/resource.ts`, `packages/bff/src/chat/handler.ts`
- Test: `packages/bff/src/chat/handler.test.ts`

**Interfaces:**
- Consumes: `verifyUserToken`, `AuthError`, `Principal` (Task 6); `parseNdjson`, `toSse` (Task 7)
- Produces:
  - `type BffConfig = { runtimeArn: string; verifier: Verifier }`
  - `async function handleChat(input: { token?: string; message?: string; sessionId?: string }, deps: { cfg: BffConfig; invoke: (p: InvokePayload) => Promise<AsyncIterable<Uint8Array>> }): Promise<{ status: number; frames: AsyncIterable<string> }>`
  - `type InvokePayload = { userId: string; actToken?: string; message: string; sessionId: string }`
    — `sessionId` es el `runtimeSessionId` de AgentCore: **derivado** del principal
    verificado (`sha256(userId + ":" + hiloDelBrowser)`), nunca tomado del request.

- [ ] **Step 1: Escribir el test que falla**

`packages/bff/src/chat/handler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { handleChat, type InvokePayload } from "./handler";

const SECRET = "un-secreto-de-al-menos-32-bytes!!";
const cfg = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/x",
  verifier: { kind: "hmac", secret: SECRET } as const,
};
const enc = new TextEncoder();

async function token(claims: Record<string, unknown> = { sub: "4821" }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

function invokeFalso(recibido: InvokePayload[]) {
  return async (p: InvokePayload) => {
    recibido.push(p);
    return (async function* () {
      yield enc.encode('{"type":"delta","text":"Hola"}\n');
      yield enc.encode('{"type":"done","text":"Hola"}\n');
    })();
  };
}

async function frames(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe("handleChat", () => {
  it("traduce el stream del runtime a frames SSE", async () => {
    const recibido: InvokePayload[] = [];
    const r = await handleChat(
      { token: await token(), message: "¿hola?", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido) },
    );
    expect(r.status).toBe(200);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"delta","text":"Hola"}\n\n',
      'data: {"type":"done","text":"Hola"}\n\n',
    ]);
  });

  it("le pasa al runtime el userId del token, nunca uno del request", async () => {
    const recibido: InvokePayload[] = [];
    await handleChat(
      { token: await token({ sub: "4821", act_token: "tok" }), message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido) },
    );
    expect(recibido[0]).toMatchObject({ userId: "4821", actToken: "tok", message: "hola" });
  });

  it("aisla la microVM por usuario: mismo sessionId del browser, sesiones distintas", async () => {
    // AgentCore rutea por runtimeSessionId y mantiene VIVA la microVM entre
    // invocaciones. Si el id viniera crudo del browser, un usuario podría pedir la
    // microVM caliente de otro, con su filesystem y su memoria.
    const recibido: InvokePayload[] = [];
    const invoke = invokeFalso(recibido);
    await handleChat({ token: await token({ sub: "A" }), message: "hola", sessionId: "s1" }, { cfg, invoke });
    await handleChat({ token: await token({ sub: "B" }), message: "hola", sessionId: "s1" }, { cfg, invoke });

    expect(recibido[0].sessionId).not.toBe(recibido[1].sessionId);
    // Y el id no filtra el userId: es un hash, no una concatenación.
    expect(recibido[0].sessionId).not.toContain("A");
    expect(recibido[0].sessionId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el mismo usuario en el mismo hilo reusa la misma microVM", async () => {
    const recibido: InvokePayload[] = [];
    const invoke = invokeFalso(recibido);
    await handleChat({ token: await token({ sub: "A" }), message: "1", sessionId: "s1" }, { cfg, invoke });
    await handleChat({ token: await token({ sub: "A" }), message: "2", sessionId: "s1" }, { cfg, invoke });
    expect(recibido[0].sessionId).toBe(recibido[1].sessionId);
  });

  it("responde 401 sin token", async () => {
    const r = await handleChat(
      { message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso([]) },
    );
    expect(r.status).toBe(401);
  });

  it("responde 401 con code expired_token para que el widget renueve", async () => {
    const vencido = await new SignJWT({ sub: "4821" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("-1m")
      .sign(new TextEncoder().encode(SECRET));
    const r = await handleChat(
      { token: vencido, message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso([]) },
    );
    expect(r.status).toBe(401);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"error","code":"expired_token"}\n\n',
    ]);
  });

  it("responde 400 sin mensaje", async () => {
    const r = await handleChat(
      { token: await token(), sessionId: "s1" },
      { cfg, invoke: invokeFalso([]) },
    );
    expect(r.status).toBe(400);
  });

  it("si el stream muere a mitad de la respuesta, emite un frame de error", async () => {
    const r = await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      {
        cfg,
        invoke: async () =>
          (async function* () {
            yield enc.encode('{"type":"delta","text":"Hola"}\n');
            throw new Error("microVM caída");
          })(),
      },
    );
    expect(r.status).toBe(200);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"delta","text":"Hola"}\n\n',
      'data: {"type":"error","code":"agent_unavailable"}\n\n',
    ]);
  });

  it("si el runtime falla, emite un evento de error en vez de tirar", async () => {
    const r = await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      {
        cfg,
        invoke: async () => {
          throw new Error("runtime caído");
        },
      },
    );
    expect(r.status).toBe(200);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"error","code":"agent_unavailable"}\n\n',
    ]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run src/chat/handler.test.ts`
Expected: FAIL — no existe `./handler`

- [ ] **Step 3: Escribir la config del BFF**

`packages/bff/src/config/index.ts`:

```ts
// Interfaz de config del BFF, agnóstica del IaC. El resto del código consume
// SOLO esto: así cambiar de SST a Terraform toca un archivo, no el producto.
import type { Verifier } from "../auth/verify";

export type BffConfig = {
  runtimeArn: string;
  verifier: Verifier;
};

export async function loadConfig(): Promise<BffConfig> {
  // Por defecto, el sabor de referencia (SST). Los otros sabores reemplazan este
  // módulo por ./env.ts, que lee el contrato de infra/CONTRACT.md desde el entorno.
  const { fromResource } = await import("./resource");
  return fromResource();
}
```

`packages/bff/src/config/resource.ts`:

```ts
/// <reference path="../../../../sst-env.d.ts" />
// EL ÚNICO archivo del BFF que importa `Resource` de SST. Cualquier otro import
// de "sst" en packages/bff es un error de revisión: rompe la portabilidad que
// vende el paquete.
import { Resource } from "sst";
import type { BffConfig } from "./index";

export function fromResource(): BffConfig {
  // El cliente se autentica por JWKS (preferido: sin secreto compartido) o por HMAC
  // (cuando no tiene OIDC — y es también el modo que usa el demo-client, porque un
  // /chat-token local no puede publicar un JWKS que Lambda alcance).
  const { jwksUrl, hmacSecret } = Resource.ClientAuth;
  if (!jwksUrl && !hmacSecret) {
    throw new Error(
      "Falta configurar el emisor de tokens: seteá ClientJwksUrl o ClientHmacSecret.",
    );
  }
  return {
    runtimeArn: Resource.AgentRuntime.arn,
    verifier: hmacSecret
      ? { kind: "hmac", secret: hmacSecret }
      : { kind: "jwks", url: jwksUrl },
  };
}
```

- [ ] **Step 4: Escribir el handler**

`packages/bff/src/chat/handler.ts`:

```ts
// Function URL de chat, en modo response streaming. Es el portero: valida el
// token, arma el payload CONFIABLE para el Runtime y relata el stream de vuelta.
// No tiene lógica de agente.
import { createHash } from "node:crypto";
import { AuthError, verifyUserToken } from "../auth/verify";
import type { BffConfig } from "../config/index";
import { parseNdjson, toSse } from "./ndjson";

// AgentCore Runtime provisiona una microVM de Firecracker POR SESIÓN y la mantiene
// VIVA entre invocaciones, ruteando por este id. Por eso no puede venir crudo del
// browser: quien adivinara el id de otro caería en SU microVM caliente, con su
// filesystem y su memoria. Se deriva del principal ya verificado, y se hashea para
// no filtrar el userId en un identificador que viaja a AWS.
function runtimeSessionId(userId: string, hiloDelBrowser?: string): string {
  return createHash("sha256")
    .update(`${userId}:${hiloDelBrowser ?? "default"}`)
    .digest("hex");
}

export type InvokePayload = {
  userId: string;
  actToken?: string;
  message: string;
  sessionId: string;
};

type Deps = {
  cfg: BffConfig;
  invoke: (p: InvokePayload) => Promise<AsyncIterable<Uint8Array>>;
};

type Result = { status: number; frames: AsyncIterable<string> };

function unFrame(event: Record<string, unknown>): AsyncIterable<string> {
  return (async function* () {
    yield toSse(event);
  })();
}

export async function handleChat(
  input: { token?: string; message?: string; sessionId?: string },
  deps: Deps,
): Promise<Result> {
  if (!input.token) {
    return { status: 401, frames: unFrame({ type: "error", code: "invalid_token" }) };
  }
  if (!input.message) {
    return { status: 400, frames: unFrame({ type: "error", code: "empty_message" }) };
  }

  let principal;
  try {
    principal = await verifyUserToken(input.token, deps.cfg.verifier);
  } catch (e) {
    // El code viaja al widget para que sepa si conviene renovar el token y
    // reintentar una vez, o si el token está mal de origen.
    const code = e instanceof AuthError ? e.code : "invalid_token";
    return { status: 401, frames: unFrame({ type: "error", code }) };
  }

  // El userId sale SIEMPRE del token verificado, nunca del cuerpo del request:
  // el browser no es confiable. El payload que se manda al Runtime va con IAM,
  // así que del otro lado se considera confiable.
  const payload: InvokePayload = {
    userId: principal.userId,
    actToken: principal.actToken,
    message: input.message,
    sessionId: runtimeSessionId(principal.userId, input.sessionId),
  };

  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await deps.invoke(payload);
  } catch (e) {
    console.error("invoke del runtime falló", e);
    // Nada tumba la conversación: el widget muestra un mensaje, no un stack.
    return { status: 200, frames: unFrame({ type: "error", code: "agent_unavailable" }) };
  }

  return {
    status: 200,
    frames: (async function* () {
      // El stream puede morir DESPUÉS de que el invoke resolvió (la microVM se
      // cae a mitad de la respuesta). También ahí la conversación no se tumba:
      // se loguea y el widget recibe un frame de error parseable.
      try {
        for await (const ev of parseNdjson(stream)) yield toSse(ev);
      } catch (e) {
        console.error("stream del runtime cortado a mitad de la respuesta", e);
        yield toSse({ type: "error", code: "agent_unavailable" });
      }
    })(),
  };
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (todos los tests del BFF).

El typecheck de `config/resource.ts` falla hasta que Task 10 genere `sst-env.d.ts`. Hasta
entonces, agregar esta clave a `packages/bff/tsconfig.json` (Task 10 la elimina):

```json
  "exclude": ["src/config/resource.ts"]
```

- [ ] **Step 6: Commit**

```bash
git add packages/bff/src/
git commit -m "feat(bff): handler de chat con payload confiable al Runtime"
```

---

### Task 9: Widget embebible

Lo que el cliente pega en su app. Un `<script>` y un `mount()`. Sin React en el bundle, para no chocar con su stack.

**Files:**
- Create: `packages/widget/package.json`, `packages/widget/tsconfig.json`, `packages/widget/vite.config.ts`, `packages/widget/src/token.ts`, `packages/widget/src/index.ts`
- Test: `packages/widget/src/token.test.ts`, `packages/widget/src/index.test.ts`

**Interfaces:**
- Produces:
  - `function mount(el: HTMLElement, opts: { tokenUrl: string; chatUrl: string }): { send: (texto: string) => Promise<void> }`
  - `class TokenSource` con `constructor(tokenUrl: string)`, `async get(): Promise<string>`, `invalidate(): void`

- [ ] **Step 1: Crear el paquete**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p packages/widget/src && cd packages/widget
npm init -y >/dev/null
npm i -E -D typescript vite vitest happy-dom
```

`packages/widget/package.json` — agregar:

```json
{
  "name": "@craftech-ai-chat/widget",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`packages/widget/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

`packages/widget/vite.config.ts`:

```ts
// defineConfig de vitest/config (no de vite): vite 8 no tipa el campo `test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Bundle IIFE: el cliente lo carga con un <script> y llama window.CraftechChat.
  build: {
    lib: { entry: "src/index.ts", name: "CraftechChat", formats: ["iife"], fileName: () => "widget.js" },
  },
  test: { environment: "happy-dom" },
});
```

- [ ] **Step 2: Escribir el test del token, que falla**

`packages/widget/src/token.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenSource } from "./token";

describe("TokenSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pide el token al backend del cliente una sola vez y lo cachea", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "t1" })));
    vi.stubGlobal("fetch", fetchMock);

    const src = new TokenSource("/chat-token");
    expect(await src.get()).toBe("t1");
    expect(await src.get()).toBe("t1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tras invalidate pide uno nuevo", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: `t${++n}` }))));

    const src = new TokenSource("/chat-token");
    expect(await src.get()).toBe("t1");
    src.invalidate();
    expect(await src.get()).toBe("t2");
  });

  it("si el backend del cliente no da token, falla con un mensaje claro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    await expect(new TokenSource("/chat-token").get()).rejects.toThrow(/chat-token/);
  });
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `cd packages/widget && npx vitest run src/token.test.ts`
Expected: FAIL — no existe `./token`

- [ ] **Step 4: Implementar TokenSource**

`packages/widget/src/token.ts`:

```ts
// El token del usuario lo emite el backend DEL CLIENTE en su endpoint
// /chat-token, para el usuario que ya está logueado en su app. El widget nunca
// ve credenciales: solo pide un pase firmado y lo presenta.
export class TokenSource {
  private cache: string | null = null;
  private pendiente: Promise<string> | null = null;

  constructor(private readonly tokenUrl: string) {}

  async get(): Promise<string> {
    if (this.cache) return this.cache;
    // Si dos mensajes salen juntos, comparten un solo pedido de token.
    this.pendiente ??= this.pedir();
    try {
      this.cache = await this.pendiente;
      return this.cache;
    } finally {
      this.pendiente = null;
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  private async pedir(): Promise<string> {
    const r = await fetch(this.tokenUrl, { credentials: "include" });
    if (!r.ok) {
      throw new Error(
        `no se pudo obtener el token de chat-token (${r.status}). ` +
          "Verificá que el endpoint responda al usuario logueado.",
      );
    }
    const { token } = (await r.json()) as { token?: string };
    if (!token) throw new Error("chat-token no devolvió 'token'");
    return token;
  }
}
```

- [ ] **Step 5: Escribir el test del mount, que falla**

`packages/widget/src/index.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./index";

function sse(...frames: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200 },
  );
}

describe("mount", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renderiza los deltas a medida que llegan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"delta","text":"Hola"}\n\n', 'data: {"type":"delta","text":" mundo"}\n\n'),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("¿hola?");

    expect(el.textContent).toContain("Hola mundo");
  });

  it("ante expired_token renueva el token y reintenta UNA vez", async () => {
    let chats = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("chat-token")) {
        return new Response(JSON.stringify({ token: `t${chats}` }));
      }
      chats++;
      return chats === 1
        ? sse('data: {"type":"error","code":"expired_token"}\n\n')
        : sse('data: {"type":"delta","text":"listo"}\n\n');
    });
    vi.stubGlobal("fetch", fetchMock);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(chats).toBe(2);
    expect(el.textContent).toContain("listo");
  });

  it("el done reconcilia la burbuja con el texto autoritativo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse(
              'data: {"type":"delta","text":"Hola mund"}\n\n',
              'data: {"type":"done","text":"Hola mundo"}\n\n',
            ),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(el.querySelector(".cc-respuesta")?.textContent).toBe("Hola mundo");
  });

  it("una respuesta sin ningún frame SSE muestra el error genérico", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : new Response("Internal Server Error", { status: 500 }),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(el.textContent).toMatch(/problema al responder/i);
  });

  it("ante agent_unavailable muestra un mensaje al usuario, no un stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"error","code":"agent_unavailable"}\n\n'),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(el.textContent).toMatch(/no est(á|a) disponible/i);
  });
});
```

- [ ] **Step 6: Correr el test y verificar que falla**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — no existe `./index`

- [ ] **Step 7: Implementar mount**

`packages/widget/src/index.ts`:

```ts
// El widget: lo que el cliente pega en su app. Sin framework, para no chocar con
// su stack. Toda la UI es DOM plano; los textos visibles viven en MENSAJES.
import { TokenSource } from "./token";

// Registro de textos visibles: el producto es en español y los literales no se
// dispersan por el código.
const MENSAJES = {
  agenteCaido: "El asistente no está disponible en este momento. Probá de nuevo en unos minutos.",
  errorGenerico: "Hubo un problema al responder. Probá de nuevo.",
} as const;

export function mount(
  el: HTMLElement,
  opts: { tokenUrl: string; chatUrl: string },
): { send: (texto: string) => Promise<void> } {
  const tokens = new TokenSource(opts.tokenUrl);
  const hilo = document.createElement("div");
  hilo.className = "cc-hilo";
  el.append(hilo);

  async function enviar(texto: string, reintentado = false): Promise<void> {
    const burbuja = document.createElement("p");
    burbuja.className = "cc-respuesta";
    hilo.append(burbuja);

    const r = await fetch(opts.chatUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await tokens.get()}`,
      },
      body: JSON.stringify({ message: texto, sessionId: sesion() }),
    });

    // Nota: NO se corta por r.ok — el 401 del BFF trae frames SSE parseables
    // (expired_token viaja ahí). La guarda correcta es "ningún frame llegó".
    let huboEventos = false;
    for await (const ev of leerSse(r)) {
      huboEventos = true;
      if (ev.type === "delta") {
        burbuja.textContent += String(ev.text ?? "");
      } else if (ev.type === "done") {
        // El texto del done es el autoritativo: reconcilia la burbuja por si
        // los deltas y el texto final divergieran (renormalización, retries).
        if (typeof ev.text === "string") burbuja.textContent = ev.text;
      } else if (ev.type === "error") {
        // El token venció mientras el usuario escribía: se renueva y se reintenta
        // UNA vez. Más de una sería un loop ante un token mal emitido.
        if (ev.code === "expired_token" && !reintentado) {
          tokens.invalidate();
          burbuja.remove();
          return enviar(texto, true);
        }
        burbuja.textContent =
          ev.code === "agent_unavailable" ? MENSAJES.agenteCaido : MENSAJES.errorGenerico;
      }
    }
    if (!huboEventos) {
      // Una respuesta sin ni un frame SSE (el 5xx de un proxy, un body vacío)
      // no puede dejar la burbuja vacía para siempre.
      burbuja.textContent = MENSAJES.errorGenerico;
    }
  }

  return { send: (texto: string) => enviar(texto) };
}

// Un id de sesión por pestaña: el hilo sobrevive a un reload, no se mezcla entre
// pestañas.
function sesion(): string {
  const clave = "cc-session";
  let id = sessionStorage.getItem(clave);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(clave, id);
  }
  return id;
}

async function* leerSse(r: Response): AsyncIterable<Record<string, unknown>> {
  const reader = r.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let corte: number;
    while ((corte = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);
      if (frame.startsWith("data: ")) {
        try {
          yield JSON.parse(frame.slice(6)) as Record<string, unknown>;
        } catch {
          yield { type: "error", code: "frame_ilegible" };
        }
      }
    }
  }
}
```

- [ ] **Step 8: Correr los tests y verificar que pasan**

Run: `npx vitest run && npx tsc --noEmit && npx vite build`
Expected: PASS (6 tests), typecheck limpio y `dist/widget.js` generado

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add packages/widget/ package-lock.json
git commit -m "feat(widget): mount embebible con streaming y renovacion de token"
```

---

### Task 10: Infra SST y contrato de infraestructura

Cierra el vertical: despliega el contenedor como AgentCore Runtime y el handler como Function URL, e inyecta las variables del contrato. El deploy va **por CI**, nunca `sst deploy` local: la misma regla que `msp-platform`, y a propósito no hay script npm para hacerlo.

**Files:**
- Create: `sst.config.ts`, `infra/sst/runtime.ts`, `infra/sst/bff.ts`, `infra/CONTRACT.md`, `.github/workflows/deploy.yml`
- Modify: `packages/bff/tsconfig.json` (quitar el `exclude` de `src/config/resource.ts`)
  y `packages/bff/src/config/resource.ts` (**eliminar la línea `// @ts-nocheck`** que
  la Task 8 dejó como puente — con `sst` instalado y `sst-env.d.ts` generado, el
  archivo debe typechequear de verdad; dejarlo en nocheck sería un agujero silencioso)

**Interfaces:**
- Consumes: `core/Dockerfile` (Task 5), `packages/bff/src/chat/handler.ts` (Task 8)
- Produces: linkables `AgentRuntime` (con `arn`) y `ClientAuth` (con `jwksUrl`), consumidos por `packages/bff/src/config/resource.ts`

- [ ] **Step 0: Verificar los nombres reales de los recursos antes de escribir infra**

El código de infra de esta tarea usa `aws.native.bedrockagentcore.Runtime` y
`dockerbuild.Image`. **Esos nombres no están verificados** — son la parte del plan con
más chance de estar mal, porque AgentCore es reciente y no está en el provider classic.
Resolverlos contra los tipos generados, no contra este plan:

```bash
cd "$(git rev-parse --show-toplevel)"
npm i -E -D sst && npx sst install
grep -rio "bedrockagentcore\.[A-Za-z]*" .sst/platform/ | sort -u | head -20
ls .sst/platform/node_modules/@pulumi/ | grep -iE "docker|native"
```

Si el nombre del recurso difiere, usar el que aparezca y anotar el real en
`infra/CONTRACT.md`. Si `bedrockagentcore` no aparece en absoluto, **parar y
reportarlo**: significa que el sabor SST necesita `aws.cloudcontrolapi.Resource` a mano,
lo que cambia el alcance de esta tarea y refuerza el riesgo 1 del spec.

- [ ] **Step 1: Escribir el contrato de infraestructura**

`infra/CONTRACT.md`:

```markdown
# Contrato de infraestructura

Cualquier sabor de IaC (SST, Terraform, Pulumi) debe crear estos recursos e
inyectar estas variables. El código del producto no conoce el sabor: cambiar de
uno a otro es reimplementar esta lista, nada más.

## Recursos

| Recurso | Para qué | Notas |
|---|---|---|
| AgentCore Runtime | corre el contenedor del agente | imagen **ARM64**; `/ping` y `/invocations` en `:8080` |
| Repositorio ECR | aloja la imagen del core | |
| Rol de ejecución del Runtime | lo asume `bedrock-agentcore.amazonaws.com` | permisos: `bedrock:InvokeModelWithResponseStream`, `bedrock:ApplyGuardrail` |
| Lambda del BFF + Function URL | chat con response streaming | permiso `bedrock-agentcore:InvokeAgentRuntime` |
| Secreto del emisor de tokens | verificar el token del cliente | JWKS URL o secreto HMAC |

## Variables que recibe el core (contenedor)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MODEL_ID` | sí | id del modelo o inference profile de Bedrock |
| `AWS_REGION` | no (default `us-east-1`) | región de Bedrock |
| `GUARDRAIL_ID` | no | si falta, el core corre sin guardrail |
| `GUARDRAIL_VERSION` | no | requerida si hay `GUARDRAIL_ID` |

## Variables que recibe el BFF

| Variable | Obligatoria | Descripción |
|---|---|---|
| `AGENT_RUNTIME_ARN` | sí | ARN del AgentCore Runtime a invocar |
| `CLIENT_JWKS_URL` | una de las dos | JWKS del emisor de tokens del cliente |
| `CLIENT_HMAC_SECRET` | una de las dos | secreto compartido, si el cliente no tiene OIDC |

En el sabor SST estas variables se resuelven por linking y las lee
`packages/bff/src/config/resource.ts`. En los demás sabores se inyectan como
variables de entorno y las lee `packages/bff/src/config/env.ts`.
```

- [ ] **Step 2: Escribir la infra**

```bash
npm i -E -D sst && mkdir -p infra/sst
```

`sst.config.ts`:

```ts
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "craftech-ai-chat",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: {
        // Pin explícito: el bundle tiene que ser determinístico entre local y CI.
        aws: { version: "7.32.0", region: process.env.AWS_REGION ?? "us-east-1" },
        // Cloud Control: AgentCore Runtime no está en el provider classic.
        "aws-native": { version: "1.68.0", region: process.env.AWS_REGION ?? "us-east-1" },
      },
    };
  },
  async run() {
    const { runtime } = await import("./infra/sst/runtime");
    await import("./infra/sst/bff");
    return { runtimeArn: runtime.arn };
  },
});
```

`infra/sst/runtime.ts`:

```ts
// AgentCore Runtime + su imagen. La imagen DEBE ser ARM64: el Runtime no acepta
// otra arquitectura, y el fallo aparece recién al desplegar.
const region = aws.getRegionOutput().name;
const accountId = aws.getCallerIdentityOutput().accountId;

const repo = new aws.ecr.Repository("CoreRepo", { forceDelete: true });

const image = new dockerbuild.Image("CoreImage", {
  context: { location: "." },
  dockerfile: { location: "core/Dockerfile" },
  platforms: ["linux/arm64"],
  push: true,
  tags: [$interpolate`${repo.repositoryUrl}:latest`],
  registries: [
    {
      address: repo.repositoryUrl,
      username: aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId }).userName,
      password: aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId }).password,
    },
  ],
});

const role = new aws.iam.Role("RuntimeRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

new aws.iam.RolePolicy("RuntimeRolePolicy", {
  role: role.name,
  policy: $jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        // El prefijo `us.` de los inference profiles rutea a otra región: hay que
        // permitir foundation-model y inference-profile, no solo uno.
        Action: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel", "bedrock:ApplyGuardrail"],
        Resource: [
          $interpolate`arn:aws:bedrock:${region}::foundation-model/*`,
          $interpolate`arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
        Resource: "*",
      },
    ],
  }),
});

export const runtime = new aws.native.bedrockagentcore.Runtime("AgentRuntime", {
  agentRuntimeName: $interpolate`craftechAiChat${$app.stage}`,
  agentRuntimeArtifact: { containerConfiguration: { containerUri: image.ref } },
  networkConfiguration: { networkMode: "PUBLIC" },
  roleArn: role.arn,
  environmentVariables: {
    MODEL_ID: "us.anthropic.claude-sonnet-4-6",
  },
});

export const runtimeLink = new sst.Linkable("AgentRuntime", {
  properties: { arn: runtime.agentRuntimeArn },
});
```

`infra/sst/bff.ts`:

```ts
import { runtime, runtimeLink } from "./runtime";

// El emisor de tokens del cliente: JWKS (preferido) o HMAC. Los dos llevan default
// vacío para que se setee SOLO el que aplica sin que el deploy corte por el otro.
// En el paquete final esto sale de client.config.ts.
const clientJwksUrl = new sst.Secret("ClientJwksUrl", "");
const clientHmacSecret = new sst.Secret("ClientHmacSecret", "");

export const clientAuth = new sst.Linkable("ClientAuth", {
  properties: {
    jwksUrl: clientJwksUrl.value,
    hmacSecret: clientHmacSecret.value,
  },
});

export const chat = new sst.aws.Function("Chat", {
  handler: "packages/bff/src/chat/lambda.handler",
  runtime: "nodejs24.x",
  timeout: "5 minutes",
  // Response streaming: el SSE tiene que salir a medida que llega, no al final.
  streaming: true,
  url: { cors: { allowOrigins: ["*"], allowHeaders: ["content-type", "authorization"] } },
  link: [runtimeLink, clientAuth],
  permissions: [
    // Scoped al ARN del runtime propio: bff.ts ya importa de ./runtime, no hay
    // dependencia circular que justifique el wildcard.
    {
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      resources: [runtime.agentRuntimeArn],
    },
  ],
});
```

- [ ] **Step 3: Escribir el entrypoint Lambda del handler**

`packages/bff/src/chat/lambda.ts`:

```ts
// Entrypoint de la Function URL en modo response streaming. Todo lo testeable
// vive en handler.ts; acá solo está el pegamento con Lambda y el SDK.
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { loadConfig } from "../config/index";
import { handleChat, type InvokePayload } from "./handler";

const client = new BedrockAgentCoreClient({});

// La config se resuelve una vez por contenedor caliente, no una vez por request.
let cfgCache: Awaited<ReturnType<typeof loadConfig>> | undefined;
async function cfg() {
  cfgCache ??= await loadConfig();
  return cfgCache;
}

async function invoke(p: InvokePayload): Promise<AsyncIterable<Uint8Array>> {
  const out = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: (await cfg()).runtimeArn,
      runtimeSessionId: p.sessionId,
      payload: new TextEncoder().encode(JSON.stringify(p)),
    }),
  );
  return out.response as AsyncIterable<Uint8Array>;
}

// @ts-expect-error — `awslambda` lo inyecta el runtime de Lambda, no hay tipos.
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // La Function URL es pública: un body malformado no puede tirar la Lambda.
  // Si no parsea, queda {} y handleChat responde 400 por falta de message.
  let body: { message?: string; sessionId?: string };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const r = await handleChat(
    { token: auth.replace(/^Bearer /, "") || undefined, message: body.message, sessionId: body.sessionId },
    { cfg: await cfg(), invoke },
  );
  try {
    for await (const frame of r.frames) responseStream.write(frame);
  } catch (e) {
    // Si el write falla (cliente desconectado) no hay a quién avisarle: solo log.
    // Los errores del agente ya llegan como frames desde handleChat.
    console.error("no se pudo escribir el stream al cliente", e);
  } finally {
    responseStream.end();
  }
});
```

```bash
cd packages/bff && npm i -E @aws-sdk/client-bedrock-agentcore
```

- [ ] **Step 4: Verificar los tipos del SDK contra el código**

Run: `cd packages/bff && npx tsc --noEmit`
Expected: typecheck limpio. Si `out.response` no es el nombre del campo de respuesta en la versión instalada, el error de tipos lo dice exactamente — corregirlo por lo que indiquen los tipos, no por lo que dice este plan.

- [ ] **Step 5: Escribir el workflow de CI**

`.github/workflows/deploy.yml`:

```yaml
name: deploy
on:
  push:
    branches: [main, staging]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - uses: docker/setup-qemu-action@v3   # emulación ARM64 en runners x86
      # El driver docker default NO buildea plataformas no nativas ni con QEMU:
      # hace falta un builder docker-container. Sin esto, el primer CI falla.
      - uses: docker/setup-buildx-action@v3
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - run: npm ci
      # .sst/platform está gitignoreado: sin esto, el gate de typecheck de infra
      # no tiene tipos en un checkout fresco.
      - run: npx sst install
      - run: npm run typecheck && npm test
      # Typecheck de sst.config.ts + infra/ (el de workspaces no los cubre).
      # Filtra el único error preexistente de .sst/platform (vendored, gitignoreado).
      - run: npm run typecheck:infra
      - run: npx sst deploy --stage ${{ github.ref_name == 'main' && 'production' || 'staging' }}
```

- [ ] **Step 6: Setear el secreto y desplegar por CI**

```bash
# El secreto va ANTES de mergear el código que lo usa, o el deploy corta con
# SecretMissingError.
# Para la prueba con el demo-client se usa HMAC. Generar el secreto y guardarlo:
openssl rand -base64 32 > .secreto-demo.local   # NO commitear: está en .gitignore
npx sst secret set ClientHmacSecret "$(cat .secreto-demo.local)" --stage staging
# Cuando haya un cliente real con OIDC, en su lugar:
#   npx sst secret set ClientJwksUrl "https://<cliente>/.well-known/jwks.json" --stage staging
git add sst.config.ts infra/ .github/ packages/bff/ package-lock.json
git commit -m "feat(infra): AgentCore Runtime y Function URL de chat en SST"
git push origin HEAD:staging
```

- [ ] **Step 7: Smoke del deploy**

Con la URL de la Function que imprime el deploy. El token de prueba se firma con el
mismo secreto HMAC que se seteó en el Step 6:

```bash
CHAT_URL="<url de la Function del deploy>"
TOKEN=$(node -e '
const c = require("node:crypto"), fs = require("node:fs");
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const secreto = fs.readFileSync(".secreto-demo.local", "utf8").trim();
const cuerpo = b({ alg: "HS256", typ: "JWT" }) + "." +
  b({ sub: "smoke", exp: Math.floor(Date.now() / 1000) + 600 });
const firma = c.createHmac("sha256", secreto).update(cuerpo).digest("base64url");
process.stdout.write(cuerpo + "." + firma);
')

curl -sN "$CHAT_URL" -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"message":"hola, ¿quién sos?","sessionId":"smoke-1"}'
```

Expected: frames `data: {"type":"delta",...}` apareciendo de a poco y un `done` al final. Si tarda mucho el primer mensaje, es el cold start del riesgo 2 del spec: comparar con la medición de Task 5.

- [ ] **Step 8: Commit del registro del smoke**

```bash
# Anotar en docs/mediciones.md la latencia del primer mensaje y de los siguientes.
git add docs/mediciones.md
git commit -m "docs: mediciones del primer deploy end-to-end"
```

---

### Task 11: Cliente de prueba y ejemplo de integración

Cierra el vertical con algo que se pueda mirar funcionando, y de paso produce el
ejemplo que se le entrega a cada cliente: qué tiene que poner de su lado para
embeber el chat. Son dos cosas: un `/chat-token` que firma el JWT y una página que
monta el widget.

Usa HMAC porque un `/chat-token` corriendo local no puede publicar un JWKS que la
Lambda alcance. El firmado va con `node:crypto` y sin dependencias, a propósito: el
ejemplo tiene que mostrarle al cliente el mínimo real, no arrastrarle librerías.

**Files:**
- Create: `examples/demo-client/package.json`, `examples/demo-client/sign.mjs`, `examples/demo-client/server.mjs`, `examples/demo-client/public/index.html`, `examples/demo-client/README.md`
- Modify: `package.json` (raíz — agregar `examples/*` a workspaces)
- Test: `examples/demo-client/sign.test.mjs`

**Interfaces:**
- Consumes: el bundle `packages/widget/dist/widget.js` (Task 9); la Function URL desplegada (Task 10)
- Produces: `function signChatToken(userId: string, secret: string, ttlSeconds?: number): string` — JWT HS256 verificable por `verifyUserToken` del BFF con el mismo secreto

- [ ] **Step 1: Crear el paquete y sumarlo al workspace**

En `package.json` de la raíz, cambiar la línea de workspaces por:

```json
  "workspaces": ["packages/*", "examples/*"],
```

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p examples/demo-client/public
cat > examples/demo-client/package.json <<'JSON'
{
  "name": "@craftech-ai-chat/demo-client",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "vitest run"
  },
  "devDependencies": {}
}
JSON
npm i -E -D -w @craftech-ai-chat/demo-client vitest jose
```

- [ ] **Step 2: Escribir el test que falla**

El test que importa no es que la función devuelva "algo con tres puntos": es que el
token que firma el cliente lo pueda **verificar el BFF**. Por eso se verifica con
`jose`, la misma librería que usa `verifyUserToken`.

`examples/demo-client/sign.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { signChatToken } from "./sign.mjs";

const SECRETO = "un-secreto-de-al-menos-32-bytes!!";
const clave = new TextEncoder().encode(SECRETO);

describe("signChatToken", () => {
  it("produce un token que jose verifica: es interoperable con el BFF", async () => {
    const token = signChatToken("4821", SECRETO);
    const { payload } = await jwtVerify(token, clave);
    expect(payload.sub).toBe("4821");
  });

  it("respeta el TTL y vence", async () => {
    const token = signChatToken("4821", SECRETO, -1);
    await expect(jwtVerify(token, clave)).rejects.toMatchObject({
      name: "JWTExpired",
    });
  });

  it("un token firmado con otro secreto no verifica", async () => {
    const token = signChatToken("4821", "otro-secreto-de-32-bytes-o-mas!!");
    await expect(jwtVerify(token, clave)).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `npm test -w @craftech-ai-chat/demo-client`
Expected: FAIL — no existe `./sign.mjs`

- [ ] **Step 4: Escribir la implementación mínima**

`examples/demo-client/sign.mjs`:

```js
// Firmado del token de chat, con node:crypto y sin dependencias.
//
// ESTO ES LO QUE EL CLIENTE TIENE QUE IMPLEMENTAR DE SU LADO. Su backend ya sabe
// quién es el usuario porque está logueado en su app; lo único que agrega es firmar
// un pase corto que el widget presenta a nuestro BFF. Nosotros nunca vemos sus
// credenciales y el usuario nunca se loguea dos veces.
import { createHmac } from "node:crypto";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export function signChatToken(userId, secret, ttlSeconds = 600) {
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo =
    b64({ alg: "HS256", typ: "JWT" }) +
    "." +
    b64({ sub: userId, iat: ahora, exp: ahora + ttlSeconds });
  const firma = createHmac("sha256", secret).update(cuerpo).digest("base64url");
  return `${cuerpo}.${firma}`;
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npm test -w @craftech-ai-chat/demo-client`
Expected: PASS (3 tests)

- [ ] **Step 6: Escribir el servidor del demo**

`examples/demo-client/server.mjs`:

```js
// Servidor del demo: hace de "app del cliente". Sirve la página, el bundle del
// widget y el /chat-token. Es solo un ejemplo: no usarlo en producción.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { signChatToken } from "./sign.mjs";

const PORT = Number(process.env.PORT || 3000);
const SECRETO = process.env.CHAT_HMAC_SECRET;
const CHAT_URL = process.env.CHAT_URL;

if (!SECRETO || !CHAT_URL) {
  console.error(
    "Faltan CHAT_HMAC_SECRET (el mismo que ClientHmacSecret del stage) y CHAT_URL " +
      "(la Function URL del deploy).",
  );
  process.exit(1);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/chat-token") {
    // En una app real, el usuario sale de la sesión. Acá viene por query para poder
    // probar el aislamiento entre usuarios: ?user=A y ?user=B.
    const userId = url.searchParams.get("user") || "demo";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: signChatToken(userId, SECRETO) }));
    return;
  }

  if (url.pathname === "/widget.js") {
    const js = await readFile(
      new URL("../../packages/widget/dist/widget.js", import.meta.url),
    );
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(js);
    return;
  }

  const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html.replace("__CHAT_URL__", CHAT_URL));
}).listen(PORT, () => console.log(`demo-client en http://localhost:${PORT}`));
```

`examples/demo-client/public/index.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Demo del chat</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; }
  .cc-hilo { min-height: 8rem; border: 1px solid #ccc; padding: .75rem; border-radius: .5rem; }
  form { display: flex; gap: .5rem; margin-top: .75rem; }
  input { flex: 1; padding: .5rem; }
</style>

<h1>Demo del chat</h1>
<p>Usuario: <code id="quien"></code> — cambialo con <code>?user=B</code> en la URL.</p>

<div id="chat"></div>
<form id="f"><input id="m" placeholder="Escribí un mensaje…" autocomplete="off" /><button>Enviar</button></form>

<script src="/widget.js"></script>
<script>
  const user = new URLSearchParams(location.search).get("user") || "demo";
  document.getElementById("quien").textContent = user;

  const chat = CraftechChat.mount(document.getElementById("chat"), {
    tokenUrl: `/chat-token?user=${encodeURIComponent(user)}`,
    chatUrl: "__CHAT_URL__",
  });

  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("m");
    if (input.value.trim()) chat.send(input.value.trim());
    input.value = "";
  });
</script>
```

- [ ] **Step 7: Escribir el README que se le entrega al cliente**

`examples/demo-client/README.md`:

```markdown
# Integrar el chat en tu app

De tu lado hacen falta dos cosas.

## 1. Un endpoint que emita el token del chat

Tu backend ya sabe quién es el usuario porque está logueado en tu app. Lo único que
agrega es firmar un pase corto que el widget presenta a nuestro backend. Nunca nos
mandás credenciales y tu usuario no se loguea dos veces.

Ver `sign.mjs` para el firmado completo (HS256, sin dependencias). En resumen:

```js
app.get("/chat-token", requireLogin, (req, res) => {
  res.json({ token: signChatToken(req.user.id, process.env.CHAT_HMAC_SECRET) });
});
```

Si tu identity provider habla OIDC, mejor: publicá tu JWKS y nos das la URL. Así no
compartimos ningún secreto.

## 2. Montar el widget

```html
<div id="chat"></div>
<script src="https://<tu-cdn>/widget.js"></script>
<script>
  CraftechChat.mount(document.getElementById("chat"), {
    tokenUrl: "/chat-token",
    chatUrl: "https://<url-del-chat>",
  });
</script>
```

## Correr este demo

```bash
npm run build -w @craftech-ai-chat/widget
CHAT_HMAC_SECRET="$(cat ../../.secreto-demo.local)" \
CHAT_URL="<la Function URL del deploy>" \
  npm start -w @craftech-ai-chat/demo-client
```

Abrir http://localhost:3000. Con `?user=A` y `?user=B` en dos pestañas se ve que cada
usuario tiene su propia conversación.
```

- [ ] **Step 8: Smoke visual end-to-end**

```bash
npm run build -w @craftech-ai-chat/widget
CHAT_HMAC_SECRET="$(cat .secreto-demo.local)" CHAT_URL="<Function URL>" \
  npm start -w @craftech-ai-chat/demo-client
```

Expected: en http://localhost:3000, al enviar un mensaje la respuesta aparece
**token por token**. Con `?user=A` y `?user=B` en dos pestañas, cada una mantiene su
propia conversación. Anotar en `docs/mediciones.md` la latencia hasta el primer token
del primer mensaje (microVM fría) y la del segundo mensaje (microVM caliente): esa
diferencia es la medición que cierra el riesgo 2 del spec.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add package.json package-lock.json examples/ docs/mediciones.md
git commit -m "feat(examples): cliente de prueba y ejemplo de integracion"
```

---

## Definición de terminado (fase 2a)

- [ ] `uv run pytest core/tests/ -v` — todo verde
- [ ] `npm test` en la raíz — todo verde
- [ ] `npm run typecheck` en la raíz — limpio
- [ ] `./core/smoke.sh` — dos `OK`
- [ ] `npm test -w @craftech-ai-chat/demo-client` — todo verde
- [ ] Un mensaje real, escrito en el widget montado en el demo-client, se responde token por token
- [ ] Dos pestañas con `?user=A` y `?user=B` mantienen conversaciones separadas
- [ ] `docs/mediciones.md` tiene tamaño de imagen, cold start del contenedor, y latencia hasta el primer token con microVM fría y caliente

## Fuera de esta fase

Sin tools (2c), sin RAG (2d), sin memoria persistente (2b: el `history` viaja en el
payload pero nadie lo guarda todavía), sin guardrail de entrada en el BFF (2b), sin
topes de uso (2b), sin sabor Terraform (fase 3).

La app standalone con Cognito propio sigue siendo de la fase 2e: el demo-client de la
Task 11 **no la reemplaza**. Es un ejemplo de integración y un banco de pruebas, no una
superficie de producto — no tiene login real y su `/chat-token` firma para cualquiera
que le pida.
