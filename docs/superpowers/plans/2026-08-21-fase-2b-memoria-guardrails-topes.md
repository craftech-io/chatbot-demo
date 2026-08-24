# craftech-ai-chat — Fase 2b: memoria, guardrail de entrada y topes de uso

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El chat recuerda la conversación entre invocaciones (AgentCore Memory), filtra la entrada del usuario antes de pagar Runtime y modelo (guardrail en el BFF), y aplica topes de mensajes por usuario y por sesión — todo con su modo mock local.

**Architecture:** La memoria vive en AgentCore Memory y la lee/escribe el core por `(actorId, sessionId)`; el BFF mantiene un índice de hilos en Dynamo (`SessionsTable`, solo metadata) y los contadores de tope en `LimitsTable`. El guardrail de Bedrock se crea en infra y se aplica dos veces: entrada en el BFF (`ApplyGuardrail`, fail-open) y salida en el core (ya existente, modo `sync`). Los textos que ve el usuario salen de un registro nuevo compartido (`packages/shared`).

**Tech Stack:** lo ya fijado en fase 2a (SST v4, aws 7.32.0 / aws-native 1.68.0, Python 3.13 + llama-index-workflows 2.23.2, TS + vitest) más `@aws-sdk/client-bedrock-runtime` (BFF), `@aws-sdk/client-dynamodb` (BFF) y `boto3` (core, para el data plane de Memory).

**Spec:** `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md` (§9 guardrails, §10 memoria, §12 topes, §15 errores, §16 regla de mock)

**Convención de rutas:** relativas a la raíz del repo; los comandos corren desde ahí salvo indicación.

## Global Constraints

- **El core nunca importa nada de SST** (config por env vía `core/src/agent/config.py`). El BFF usa `Resource` SOLO en `packages/bff/src/config/resource.ts`.
- **Fail-open del guardrail** (spec §9): si `ApplyGuardrail` falla, se loguea y el chat sigue. Una entrada BLOQUEADA no es un error: es una respuesta — frame `done` con el mensaje canónico del registro.
- **Orden en el handler**: auth → mensaje → **topes** → **guardrail de entrada** → invoke. Los topes van antes que el guardrail (ApplyGuardrail cuesta por llamada).
- **Los textos visibles salen de `packages/shared`** (registro nuevo `mensajes.ts`) — nunca literales dispersos. El widget y el BFF consumen el mismo registro.
- **Regla de mock (spec §16)**: cada capacidad de esta fase llega con su modo local — memoria en proceso, topes y bloqueo simulables por keyword. Una capacidad sin modo local no está terminada.
- **`runtimeSessionId` derivado, nunca del browser** (invariante de 2a — no se toca).
- **TDD estricto** con evidencia RED/GREEN; salida de tests limpia; typecheck (`npm run typecheck`, `npm run typecheck:infra`) limpio; máx. 400 líneas por archivo; español; versiones exactas (`npm i -E` / `uv add`) y lockfiles commiteados.
- **El `sst-env.d.ts` interino de la raíz se actualiza a mano** cuando se agregan linkables (el real se regenera al deploy). Dejarlo desincronizado rompe el typecheck del BFF.
- Deploys SOLO por CI (push a `staging`). Los pasos de deploy/smoke real quedan para el humano.
- Lección de 2a: si un recurso/campo de provider no coincide con lo que este plan asume, verificar contra los tipos instalados (`.sst/platform/`) y reportar — no improvisar. El `containerUri` con digest puro y el sub-recurso `runtime-endpoint/*` de IAM ya están resueltos; no tocarlos.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `packages/shared/src/mensajes.ts` | Registro de textos visibles: guardrail y límites. Consumido por BFF, widget e infra |
| `infra/sst/guardrail.ts` | El Guardrail de Bedrock del template + linkable (id y versión) |
| `infra/sst/memoria.ts` | AgentCore Memory + `MEMORY_ID` al Runtime |
| `infra/sst/tablas.ts` | `SessionsTable` y `LimitsTable` (Dynamo) + linkables al BFF |
| `packages/bff/src/guardrail/entrada.ts` | `ApplyGuardrail` sobre el INPUT, fail-open |
| `packages/bff/src/limites/topes.ts` | Verificación e incremento atómico de topes (día/sesión) |
| `packages/bff/src/sesiones/indice.ts` | Índice de hilos por usuario (metadata, nunca transcripción) |
| `core/src/agent/memoria.py` | list/create de eventos en AgentCore Memory; degrada a history del payload |
| `examples/demo-client/mock.mjs` + `server.mjs` | Memoria en proceso + escenarios `tope` y `bloqueado` |

---

### Task 1: Registro compartido de mensajes (`packages/shared`)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/mensajes.ts`, `packages/shared/src/mensajes.test.ts`
- Modify: `package.json` (raíz — nada que cambiar en workspaces: `packages/*` ya matchea)

**Interfaces:**
- Produces:
  - `MENSAJES_GUARDRAIL = { entradaBloqueada: string }`
  - `MENSAJES_LIMITE = { diarioAlcanzado: string, sesionAlcanzada: string }`
  - Import path para los demás paquetes: `@craftech-ai-chat/shared/mensajes`

- [ ] **Step 1: Crear el paquete**

```bash
mkdir -p packages/shared/src
cat > packages/shared/package.json <<'JSON'
{
  "name": "@craftech-ai-chat/shared",
  "private": true,
  "license": "UNLICENSED",
  "type": "module",
  "exports": { "./mensajes": "./src/mensajes.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" }
}
JSON
cat > packages/shared/tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "lib": ["ES2022"]
  },
  "include": ["src"]
}
JSON
npm i -E -D -w @craftech-ai-chat/shared typescript vitest
```

- [ ] **Step 2: Test que falla**

`packages/shared/src/mensajes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MENSAJES_GUARDRAIL, MENSAJES_LIMITE } from "./mensajes";

describe("registro de mensajes", () => {
  it("los textos existen, están en español y terminan en puntuación", () => {
    for (const texto of [
      MENSAJES_GUARDRAIL.entradaBloqueada,
      MENSAJES_LIMITE.diarioAlcanzado,
      MENSAJES_LIMITE.sesionAlcanzada,
    ]) {
      expect(texto.length).toBeGreaterThan(20);
      expect(texto).toMatch(/[.!?]$/);
    }
  });
});
```

- [ ] **Step 3: RED** — Run: `npm test -w @craftech-ai-chat/shared` · Expected: FAIL (no existe `./mensajes`)

- [ ] **Step 4: Implementación**

`packages/shared/src/mensajes.ts`:

```ts
// Registro central de textos visibles al usuario (regla de parametría del
// proyecto: nunca literales dispersos). El BFF los emite, el widget los muestra
// y la infra los usa como mensajes de bloqueo del propio Guardrail.
export const MENSAJES_GUARDRAIL = {
  entradaBloqueada:
    "No puedo ayudarte con ese pedido. Reformulalo y seguimos conversando.",
} as const;

export const MENSAJES_LIMITE = {
  diarioAlcanzado:
    "Alcanzaste el límite de mensajes de hoy. Mañana podés seguir conversando.",
  sesionAlcanzada:
    "Esta conversación llegó a su límite de mensajes. Empezá una nueva para seguir.",
} as const;
```

- [ ] **Step 5: GREEN + typecheck** — Run: `npm test -w @craftech-ai-chat/shared && npm run typecheck -w @craftech-ai-chat/shared` · Expected: PASS, limpio

- [ ] **Step 6: Commit**

```bash
git add packages/shared package.json package-lock.json
git commit -m "feat(shared): registro de mensajes de guardrail y limites"
```

---

### Task 2: Infra — Guardrail de Bedrock + linkable

**Files:**
- Create: `infra/sst/guardrail.ts`
- Modify: `sst.config.ts` (importar guardrail), `infra/sst/runtime.ts` (env `GUARDRAIL_ID`/`GUARDRAIL_VERSION` al Runtime), `infra/sst/bff.ts` (link + permiso `bedrock:ApplyGuardrail`), `sst-env.d.ts` (agregar `Guardrail: { id: string; version: string }`), `infra/CONTRACT.md`

**Interfaces:**
- Consumes: `MENSAJES_GUARDRAIL` de Task 1 (la infra importa el registro por ruta relativa)
- Produces: linkable `Guardrail` con `{ id, version }`; env `GUARDRAIL_ID`/`GUARDRAIL_VERSION` en el contenedor del core

- [ ] **Step 1: Escribir la infra**

`infra/sst/guardrail.ts`:

```ts
// Guardrail de contenido del template. Se aplica DOS veces: entrada en el BFF
// (ApplyGuardrail, barato, corta antes de pagar Runtime) y salida en el core
// (guardrail_stream_processing_mode="sync", ya cableado en fase 2a).
import { MENSAJES_GUARDRAIL } from "../../packages/shared/src/mensajes";

const FILTROS = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT", "PROMPT_ATTACK"] as const;

export const guardrail = new aws.bedrock.Guardrail("Guardrail", {
  name: `craftech-ai-chat-${$app.stage}`,
  // Mensajes canónicos del registro compartido: los mismos que emite el BFF.
  blockedInputMessaging: MENSAJES_GUARDRAIL.entradaBloqueada,
  blockedOutputsMessaging: MENSAJES_GUARDRAIL.entradaBloqueada,
  contentPolicyConfig: {
    filtersConfigs: FILTROS.map((type) => ({
      type,
      inputStrength: type === "PROMPT_ATTACK" ? "HIGH" : "MEDIUM",
      // PROMPT_ATTACK solo admite outputStrength NONE.
      outputStrength: type === "PROMPT_ATTACK" ? "NONE" : "MEDIUM",
    })),
  },
});

export const guardrailLink = new sst.Linkable("Guardrail", {
  properties: { id: guardrail.guardrailId, version: guardrail.version },
});
```

Si los nombres de campos difieren en el provider instalado (`filtersConfigs`, `guardrailId`, `version`), verificarlos con `grep -r "guardrail" .sst/platform/node_modules/@pulumi/aws/types/input.d.ts | head` y usar los reales — anotando el mapeo en `infra/CONTRACT.md`.

- [ ] **Step 2: Cablear runtime y BFF**

En `sst.config.ts`, dentro de `run()`, antes del import de runtime: `await import("./infra/sst/guardrail");` no es necesario si runtime lo importa — cablear así: en `infra/sst/runtime.ts` importar `import { guardrail } from "./guardrail";` y en `environmentVariables` del Runtime agregar:

```ts
    GUARDRAIL_ID: guardrail.guardrailId,
    GUARDRAIL_VERSION: guardrail.version,
```

En `infra/sst/bff.ts`: importar `import { guardrailLink } from "./guardrail";`, agregar `guardrailLink` al array `link` de la Function, y al array `permissions`:

```ts
    { actions: ["bedrock:ApplyGuardrail"], resources: ["*"] },
```

(`ApplyGuardrail` con `resources` al ARN del guardrail si el typecheck y el ARN lo permiten: `$interpolate`arn:aws:bedrock:${...}:guardrail/${guardrail.guardrailId}`` — preferir scoped; si el formato del ARN no está disponible como output, dejar `"*"` con comentario.)

En `sst-env.d.ts` (raíz), dentro de `interface Resource` agregar:

```ts
    Guardrail: { id: string; version: string };
```

- [ ] **Step 3: Verificar** — Run: `npx sst install && npm run typecheck:infra` · Expected: OK

- [ ] **Step 4: CONTRACT.md** — en la tabla de recursos agregar fila `Guardrail de Bedrock | filtro de contenido entrada+salida | mensajes desde packages/shared`; en variables del core, marcar `GUARDRAIL_ID`/`GUARDRAIL_VERSION` como "las inyecta la infra desde 2b"; en variables del BFF agregar `GUARDRAIL_ID`/`GUARDRAIL_VERSION` (vía linkable en SST).

- [ ] **Step 5: Commit**

```bash
git add infra/ sst-env.d.ts sst.config.ts
git commit -m "feat(infra): guardrail de Bedrock con mensajes del registro compartido"
```

---

### Task 3: BFF — guardrail de entrada (fail-open)

**Files:**
- Create: `packages/bff/src/guardrail/entrada.ts`, `packages/bff/src/guardrail/entrada.test.ts`
- Modify: `packages/bff/src/chat/handler.ts` (nuevo paso + dep inyectable), `packages/bff/src/chat/handler.test.ts` (2 tests nuevos), `packages/bff/src/config/index.ts` y `resource.ts` (campo `guardrail?`), `packages/bff/src/chat/lambda.ts` (cablear), `packages/bff/package.json` (dep nueva)

**Interfaces:**
- Consumes: `MENSAJES_GUARDRAIL` (Task 1); linkable `Guardrail` (Task 2)
- Produces:
  - `async function evaluarEntrada(texto: string, cfg: { id: string; version: string }, cliente?: BedrockRuntimeClient): Promise<{ bloqueada: boolean }>` — fail-open: ante error, loguea y devuelve `{ bloqueada: false }`
  - `BffConfig` gana `guardrail?: { id: string; version: string }`
  - `handleChat` gana dep opcional `guard?: (texto: string) => Promise<{ bloqueada: boolean }>`; si bloquea → `{ status: 200, frames: [done con MENSAJES_GUARDRAIL.entradaBloqueada] }` (una respuesta, no un error — spec §15)

- [ ] **Step 1: Instalar** — `cd packages/bff && npm i -E @aws-sdk/client-bedrock-runtime @craftech-ai-chat/shared`

  (`@craftech-ai-chat/shared` es workspace: npm lo linkea; si `npm i -E` de un workspace local falla, agregar a mano `"@craftech-ai-chat/shared": "*"` en dependencies y correr `npm install` en la raíz.)

- [ ] **Step 2: Test de `entrada.ts` que falla**

`packages/bff/src/guardrail/entrada.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { evaluarEntrada } from "./entrada";

const cfg = { id: "gr-1", version: "DRAFT" };

function clienteFalso(action: string) {
  return { send: vi.fn(async () => ({ action })) } as never;
}

describe("evaluarEntrada", () => {
  it("bloqueada cuando el guardrail interviene", async () => {
    const r = await evaluarEntrada("texto", cfg, clienteFalso("GUARDRAIL_INTERVENED"));
    expect(r.bloqueada).toBe(true);
  });

  it("pasa cuando no interviene", async () => {
    const r = await evaluarEntrada("texto", cfg, clienteFalso("NONE"));
    expect(r.bloqueada).toBe(false);
  });

  it("fail-open: si el guardrail revienta, deja pasar y loguea", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = { send: vi.fn(async () => { throw new Error("bedrock caído"); }) } as never;
    const r = await evaluarEntrada("texto", cfg, roto);
    expect(r.bloqueada).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("texto vacío no llama al guardrail", async () => {
    const c = clienteFalso("NONE");
    await evaluarEntrada("   ", cfg, c);
    expect((c as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: RED** — Run: `cd packages/bff && npx vitest run src/guardrail` · Expected: FAIL (no existe `./entrada`)

- [ ] **Step 4: Implementación**

`packages/bff/src/guardrail/entrada.ts`:

```ts
// Guardrail de ENTRADA: se corre en el BFF porque es barato y corta antes de
// pagar Runtime y modelo. El de SALIDA vive en el core (modo sync). Política de
// fallo: fail-open (spec §9) — se prefiere disponibilidad a censura dura.
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";

const clienteDefault = new BedrockRuntimeClient({});

export async function evaluarEntrada(
  texto: string,
  cfg: { id: string; version: string },
  cliente: BedrockRuntimeClient = clienteDefault,
): Promise<{ bloqueada: boolean }> {
  if (!texto.trim()) return { bloqueada: false };
  try {
    const out = await cliente.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: cfg.id,
        guardrailVersion: cfg.version,
        source: "INPUT",
        content: [{ text: { text: texto } }],
      }),
    );
    return { bloqueada: out.action === "GUARDRAIL_INTERVENED" };
  } catch (e) {
    console.error("guardrail de entrada falló (fail-open)", e);
    return { bloqueada: false };
  }
}
```

- [ ] **Step 5: Handler — tests nuevos que fallan** (agregar a `handler.test.ts`; el helper `token()` y `cfg` ya existen ahí)

```ts
  it("una entrada bloqueada responde el mensaje canónico como done, no como error", async () => {
    const recibido: InvokePayload[] = [];
    const r = await handleChat(
      { token: await token(), message: "algo horrible", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido), guard: async () => ({ bloqueada: true }) },
    );
    expect(r.status).toBe(200);
    const fs = await frames(r.frames);
    expect(fs).toHaveLength(1);
    expect(JSON.parse(fs[0].slice(6)).type).toBe("done");
    expect(recibido).toHaveLength(0); // nunca llegó al Runtime
  });

  it("si no hay guard configurado, el flujo sigue igual que antes", async () => {
    const recibido: InvokePayload[] = [];
    const r = await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido) },
    );
    expect(r.status).toBe(200);
    expect(recibido).toHaveLength(1);
  });
```

- [ ] **Step 6: Handler — implementación.** En `handler.ts`: el tipo `Deps` gana `guard?: (texto: string) => Promise<{ bloqueada: boolean }>`. Después de validar el mensaje y ANTES del invoke (y después de los topes cuando la Task 7 los agregue — el orden final es: auth → mensaje → topes → guardrail → invoke):

```ts
  if (deps.guard) {
    const g = await deps.guard(input.message);
    if (g.bloqueada) {
      // Una entrada bloqueada es una RESPUESTA, no un error (spec §15): el
      // widget la muestra como burbuja normal con el texto canónico.
      return {
        status: 200,
        frames: unFrame({ type: "done", text: MENSAJES_GUARDRAIL.entradaBloqueada }),
      };
    }
  }
```

con `import { MENSAJES_GUARDRAIL } from "@craftech-ai-chat/shared/mensajes";`.

En `config/index.ts`: `BffConfig` gana `guardrail?: { id: string; version: string }`. En `resource.ts`: leerlo del linkable (`Resource.Guardrail`) si existe. En `lambda.ts`: construir `guard` solo si `cfg.guardrail` está — `guard: cfg.guardrail ? (t) => evaluarEntrada(t, cfg.guardrail!) : undefined`.

- [ ] **Step 7: GREEN** — Run: `cd packages/bff && npx vitest run && npx tsc --noEmit` · Expected: PASS (todos), limpio

- [ ] **Step 8: Commit**

```bash
git add packages/bff packages/shared package-lock.json
git commit -m "feat(bff): guardrail de entrada fail-open con mensaje canonico"
```

---

### Task 4: Infra — AgentCore Memory

**Files:**
- Create: `infra/sst/memoria.ts`
- Modify: `infra/sst/runtime.ts` (env `MEMORY_ID` + permisos del data plane), `infra/CONTRACT.md`

**Interfaces:**
- Produces: recurso Memory; env `MEMORY_ID` en el contenedor; permisos `bedrock-agentcore:CreateEvent`/`ListEvents` (o los nombres reales del data plane) en el RuntimeRole

- [ ] **Step 0: Verificar el recurso en los tipos (lección de 2a — NO asumir)**

```bash
grep -rio "bedrockagentcore\.Memory" .sst/platform/ | sort -u | head -5
grep -rn "class Memory" .sst/platform/node_modules/@pulumi/aws-native/bedrockagentcore/ 2>/dev/null | head -3
ls .sst/platform/node_modules/@pulumi/aws-native/bedrockagentcore/ | head
```

Si `Memory` NO existe en `@pulumi/aws-native@1.68.0`, PARAR y reportar BLOCKED con lo que sí exista — el controlador decide (subir versión del provider o Cloud Control genérico).

- [ ] **Step 1: Infra**

`infra/sst/memoria.ts` (ajustar nombres de campos a los tipos reales del Step 0):

```ts
// Memoria de conversación gestionada (AgentCore Memory). El core la lee y
// escribe por (actorId=userId, sessionId); short-term en 2b — los resúmenes
// long-term son extensión futura (spec §10).
export const memoria = new awsnative.bedrockagentcore.Memory("Memoria", {
  name: `craftechAiChatMemoria${$app.stage.replace(/[^a-zA-Z0-9_]/g, "_")}`,
  // Retención de eventos short-term (días). 30 alinea con retención típica de chats.
  eventExpiryDuration: 30,
});
```

En `infra/sst/runtime.ts`: `import { memoria } from "./memoria";`, agregar a `environmentVariables`:

```ts
    MEMORY_ID: memoria.memoryId,
```

(verificar el nombre real del output: `memoryId` vs `id` en los tipos) y al `RuntimeRolePolicy` un statement:

```ts
      {
        // Data plane de Memory: el core lista y crea eventos de la conversación.
        Effect: "Allow",
        Action: ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents"],
        Resource: [$interpolate`${memoria.memoryArn}*`],
      },
```

(verificar `memoryArn` en los tipos; el `*` final cubre sub-recursos por sesión si el servicio los usa — lección del `runtime-endpoint/*`).

- [ ] **Step 2: Verificar** — Run: `npm run typecheck:infra` · Expected: OK

- [ ] **Step 3: CONTRACT.md** — recursos: fila `AgentCore Memory | historial de conversación | (actorId, sessionId)`; variables del core: `MEMORY_ID | no | sin ella, el core usa el history del payload (modo local/tests)`.

- [ ] **Step 4: Commit**

```bash
git add infra/
git commit -m "feat(infra): AgentCore Memory con MEMORY_ID al core"
```

---

### Task 5: Core — memoria.py (leer y persistir el historial)

**Files:**
- Create: `core/src/agent/memoria.py`, `core/tests/test_memoria.py`
- Modify: `core/src/agent/config.py` (+`memory_id`), `core/tests/test_config.py` (+1 test), `core/server.py` (cablear), `core/tests/test_server.py` (+1 test), `pyproject.toml` (boto3)

**Interfaces:**
- Consumes: env `MEMORY_ID` (Task 4)
- Produces:
  - `Config` gana `memory_id: str | None` (opcional, como el guardrail)
  - `class Memoria:` con `__init__(self, memory_id: str, cliente=None)` (cliente boto3 `bedrock-agentcore` inyectable), `def historial(self, actor_id: str, session_id: str) -> list[dict]` (rol/content en el formato que consume `BedrockAdapter.astream`: `{"role": "user"|"assistant", "content": str}`, en orden cronológico), `def registrar_turno(self, actor_id: str, session_id: str, pregunta: str, respuesta: str) -> None` (fail-open: un error de Memory no tumba el turno — se loguea)
  - `server.py`: el payload gana `userId` (ya viaja desde 2a en InvokePayload); si `cfg.memory_id` está seteado, el historial sale de Memoria y el turno se persiste tras el `done`; si no, se usa `payload.get("history")` como hasta ahora

- [ ] **Step 1: Instalar** — `uv add boto3`

- [ ] **Step 2: Test que falla**

`core/tests/test_memoria.py`:

```python
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
```

- [ ] **Step 3: RED** — Run: `uv run pytest core/tests/test_memoria.py -v` · Expected: FAIL (`No module named 'agent.memoria'`)

- [ ] **Step 4: Implementación**

`core/src/agent/memoria.py`:

```python
"""AgentCore Memory: el historial de la conversación por (actorId, sessionId).

Fail-open deliberado (spec §15): una caída de Memory degrada a conversación sin
historial, nunca tumba el turno. El evento se crea con el timestamp del server.
"""

import logging
from datetime import datetime, timezone

import boto3

log = logging.getLogger(__name__)


class Memoria:
    def __init__(self, memory_id: str, cliente=None):
        self.memory_id = memory_id
        self.cliente = cliente or boto3.client("bedrock-agentcore")

    def historial(self, actor_id: str, session_id: str) -> list[dict]:
        try:
            out = self.cliente.list_events(
                memoryId=self.memory_id, actorId=actor_id, sessionId=session_id,
                maxResults=100,
            )
        except Exception:
            log.exception("no se pudo leer el historial de Memory (fail-open)")
            return []
        mensajes: list[dict] = []
        for ev in out.get("events", []):
            for p in ev.get("payload", []):
                conv = p.get("conversational")
                if conv:
                    mensajes.append(
                        {"role": conv["role"].lower(), "content": conv["content"]["text"]}
                    )
        return mensajes

    def registrar_turno(self, actor_id: str, session_id: str, pregunta: str, respuesta: str) -> None:
        try:
            self.cliente.create_event(
                memoryId=self.memory_id, actorId=actor_id, sessionId=session_id,
                eventTimestamp=datetime.now(timezone.utc),
                payload=[
                    {"conversational": {"role": "USER", "content": {"text": pregunta}}},
                    {"conversational": {"role": "ASSISTANT", "content": {"text": respuesta}}},
                ],
            )
        except Exception:
            log.exception("no se pudo persistir el turno en Memory (fail-open)")
```

Si los nombres del data plane difieren en el boto3 instalado (`list_events`/`create_event`, forma del payload), verificarlos con `uv run python -c "import boto3; c=boto3.client('bedrock-agentcore', region_name='us-east-1'); print([m for m in dir(c) if 'event' in m])"` y ajustar — reportando el mapeo.

- [ ] **Step 5: Config** — test nuevo en `test_config.py`:

```python
def test_memory_id_es_opcional():
    assert load_config({"MODEL_ID": "m"}).memory_id is None
    assert load_config({"MODEL_ID": "m", "MEMORY_ID": "mem-1"}).memory_id == "mem-1"
```

y en `config.py`: campo `memory_id: str | None` + `memory_id=env.get("MEMORY_ID") or None`.

- [ ] **Step 6: Server — test nuevo** (en `test_server.py`; los helpers existen):

```python
def test_con_memoria_el_historial_sale_de_memory_y_el_turno_se_persiste():
    class MemoriaFalsa:
        def __init__(self):
            self.turnos = []

        def historial(self, actor_id, session_id):
            self.reclamado = (actor_id, session_id)
            return [{"role": "user", "content": "previo"}]

        def registrar_turno(self, actor_id, session_id, pregunta, respuesta):
            self.turnos.append((actor_id, session_id, pregunta, respuesta))

    llm = FakeLLM()
    mem = MemoriaFalsa()
    c = TestClient(
        build_app(
            llm_factory=lambda cfg: llm,
            env={"MODEL_ID": "fake", "MEMORY_ID": "mem-1"},
            memoria_factory=lambda cfg: mem,
        )
    )
    r = c.post("/invocations", json={"message": "hola", "sessionId": "s1", "userId": "u1"})
    assert r.status_code == 200
    assert mem.reclamado == ("u1", "s1")
    assert mem.turnos == [("u1", "s1", "hola", "Hola mundo")]
```

(Nota: `FakeLLM` del archivo emite "Hola"+" mundo"; si el fixture difiere, usar el texto real. El `history` que recibe el LLM debe ser el de Memory — si `FakeLLM` guarda lo recibido, afirmarlo también.)

- [ ] **Step 7: Server — implementación.** En `server.py`: `build_app(llm_factory=None, env=None, memoria_factory=None)`. Tras cargar `cfg`: si `cfg.memory_id` y no hay factory, `memoria_factory = lambda cfg: Memoria(cfg.memory_id)`. En `/invocations`: `actor = payload.get("userId") or "anonimo"`, `sesion = payload.get("sessionId") or "default"`; si hay memoria → `history = memoria.historial(actor, sesion)`, si no → `payload.get("history") or []`. Tras acumular el texto final (el `done`), si hay memoria: `memoria.registrar_turno(actor, sesion, message, texto)` ANTES de emitir el frame `done` (así el turno queda persistido aun si el cliente corta al recibirlo; la latencia extra es una llamada). Import: `from agent.memoria import Memoria`.

- [ ] **Step 8: GREEN** — Run: `uv run pytest core/tests/ -v` · Expected: PASS (todos, los previos intactos)

- [ ] **Step 9: Commit**

```bash
git add core/ pyproject.toml uv.lock
git commit -m "feat(core): historial en AgentCore Memory con fail-open"
```

---

### Task 6: Infra — tablas de sesiones y límites

**Files:**
- Create: `infra/sst/tablas.ts`
- Modify: `infra/sst/bff.ts` (links + env de topes), `sst-env.d.ts`, `infra/CONTRACT.md`

**Interfaces:**
- Produces: `SessionsTable` (pk `userId`, sk `sessionId`) y `LimitsTable` (pk `userId`, sk `periodo`); linkables con `.name`; env `LIMITE_DIARIO="50"` y `LIMITE_POR_SESION="40"` en la Function del chat

- [ ] **Step 1: Infra**

`infra/sst/tablas.ts`:

```ts
// SessionsTable: índice de hilos por usuario — SOLO metadata (título, timestamps,
// contador de turnos). La transcripción vive en AgentCore Memory, nunca acá.
export const sessionsTable = new sst.aws.Dynamo("SessionsTable", {
  fields: { userId: "string", sessionId: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "sessionId" },
});

// LimitsTable: contadores de tope por usuario y período (día). El cliente paga
// su Bedrock: sin topes, la primera factura sorpresa se come la relación (§12).
export const limitsTable = new sst.aws.Dynamo("LimitsTable", {
  fields: { userId: "string", periodo: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "periodo" },
});
```

En `infra/sst/bff.ts`: importar ambas, agregarlas al `link`, y a la Function un bloque `environment`:

```ts
  environment: {
    // Topes por defecto del template; por cliente se ajustan acá (client.config
    // los absorberá en 2e).
    LIMITE_DIARIO: "50",
    LIMITE_POR_SESION: "40",
  },
```

En `sst-env.d.ts`: `SessionsTable: { name: string };` y `LimitsTable: { name: string };`.

- [ ] **Step 2: Verificar** — `npm run typecheck:infra` · Expected: OK

- [ ] **Step 3: CONTRACT.md** — recursos: dos filas Dynamo; variables BFF: `SESSIONS_TABLE`, `LIMITS_TABLE` (linkables), `LIMITE_DIARIO`, `LIMITE_POR_SESION` (env, defaults 50/40).

- [ ] **Step 4: Commit**

```bash
git add infra/ sst-env.d.ts
git commit -m "feat(infra): tablas de sesiones y limites"
```

---

### Task 7: BFF — topes de uso e índice de hilos

**Files:**
- Create: `packages/bff/src/limites/topes.ts`, `packages/bff/src/limites/topes.test.ts`, `packages/bff/src/sesiones/indice.ts`, `packages/bff/src/sesiones/indice.test.ts`
- Modify: `packages/bff/src/chat/handler.ts` (+dep `limites`), `handler.test.ts` (+2 tests), `config/index.ts` + `resource.ts` (tablas y topes), `lambda.ts` (cablear), `packages/bff/package.json` (dynamodb)

**Interfaces:**
- Consumes: tablas de Task 6; `MENSAJES_LIMITE` de Task 1
- Produces:
  - `async function verificarYConsumirTope(deps: { ddb, tabla: string, topeDiario: number, topeSesion: number, sesiones: { turnos(userId, sessionId): Promise<number> } }, userId: string, sessionId: string, hoy: string): Promise<{ permitido: true } | { permitido: false; motivo: "dia" | "sesion" }>` — incremento atómico con `UpdateItem ADD`, verificación post-incremento (si `count > tope` → no permitido; el contador ya sumó, aceptable: sobrecuenta 1 en el borde)
  - `registrarTurnoEnIndice(deps, userId, sessionId, primerMensaje): Promise<number>` — upsert de metadata: `titulo` (solo si es el primer turno: primeros 80 chars), `ultimoTurnoAt` (ISO), `turnos` (+1, ADD); devuelve el contador de turnos
  - `handleChat` gana dep opcional `limites?: (userId: string, sessionId: string) => Promise<{ permitido: boolean; motivo?: "dia" | "sesion" }>`; si no permite → `{ status: 429, frames: [error code "limit_reached", motivo] }`; el frame lleva `motivo` para que el widget elija el texto

- [ ] **Step 1: Instalar** — `cd packages/bff && npm i -E @aws-sdk/client-dynamodb`

- [ ] **Step 2: Tests que fallan**

`packages/bff/src/limites/topes.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { verificarYConsumirTope } from "./topes";

function ddbFalso(nuevoCount: number) {
  return { send: vi.fn(async () => ({ Attributes: { count: { N: String(nuevoCount) } } })) } as never;
}

const base = (ddb: never, turnosSesion = 0) => ({
  ddb, tabla: "Limits", topeDiario: 3, topeSesion: 5,
  sesiones: { turnos: async () => turnosSesion },
});

describe("verificarYConsumirTope", () => {
  it("permite bajo el tope diario", async () => {
    const r = await verificarYConsumirTope(base(ddbFalso(2)), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: true });
  });

  it("rechaza al superar el tope diario", async () => {
    const r = await verificarYConsumirTope(base(ddbFalso(4)), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: false, motivo: "dia" });
  });

  it("rechaza al superar el tope por sesión aunque el día alcance", async () => {
    const r = await verificarYConsumirTope(base(ddbFalso(1), 6), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: false, motivo: "sesion" });
  });

  it("fail-open: si dynamo falla, permite y loguea", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = { send: vi.fn(async () => { throw new Error("dynamo caída"); }) } as never;
    const r = await verificarYConsumirTope(base(roto), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: true });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
```

`packages/bff/src/sesiones/indice.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { registrarTurnoEnIndice } from "./indice";

describe("registrarTurnoEnIndice", () => {
  it("hace upsert con ADD de turnos y devuelve el contador", async () => {
    const send = vi.fn(async () => ({ Attributes: { turnos: { N: "3" } } }));
    const n = await registrarTurnoEnIndice(
      { ddb: { send } as never, tabla: "Sessions" },
      "u1", "s1", "hola, tengo una consulta larga…",
    );
    expect(n).toBe(3);
    const cmd = send.mock.calls[0][0].input;
    expect(cmd.TableName).toBe("Sessions");
    expect(cmd.Key.userId.S).toBe("u1");
    expect(cmd.Key.sessionId.S).toBe("s1");
    expect(cmd.UpdateExpression).toContain("ADD turnos");
    expect(cmd.UpdateExpression).toContain("if_not_exists(titulo");
  });

  it("fail-open: un fallo del índice no molesta al turno", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = { send: vi.fn(async () => { throw new Error("dynamo caída"); }) } as never;
    const n = await registrarTurnoEnIndice({ ddb: roto, tabla: "S" }, "u", "s", "x");
    expect(n).toBe(0);
    err.mockRestore();
  });
});
```

- [ ] **Step 3: RED** — `npx vitest run src/limites src/sesiones` · Expected: FAIL (módulos no existen)

- [ ] **Step 4: Implementación**

`packages/bff/src/limites/topes.ts`:

```ts
// Topes de uso (spec §12): el cliente paga su Bedrock; los topes evitan la
// factura sorpresa. Estrategia: incremento atómico (ADD) y verificación del
// valor resultante — en el borde sobrecuenta 1, aceptable y sin carrera.
// Fail-open: si Dynamo falla, el chat sigue (disponibilidad > contabilidad).
import { UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

type Deps = {
  ddb: DynamoDBClient;
  tabla: string;
  topeDiario: number;
  topeSesion: number;
  sesiones: { turnos(userId: string, sessionId: string): Promise<number> };
};

export async function verificarYConsumirTope(
  deps: Deps,
  userId: string,
  sessionId: string,
  hoy: string,
): Promise<{ permitido: true } | { permitido: false; motivo: "dia" | "sesion" }> {
  try {
    const turnosSesion = await deps.sesiones.turnos(userId, sessionId);
    if (turnosSesion >= deps.topeSesion) return { permitido: false, motivo: "sesion" };

    const out = await deps.ddb.send(
      new UpdateItemCommand({
        TableName: deps.tabla,
        Key: { userId: { S: userId }, periodo: { S: hoy } },
        UpdateExpression: "ADD #c :uno",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":uno": { N: "1" } },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const count = Number(out.Attributes?.count?.N ?? "0");
    if (count > deps.topeDiario) return { permitido: false, motivo: "dia" };
    return { permitido: true };
  } catch (e) {
    console.error("verificación de topes falló (fail-open)", e);
    return { permitido: true };
  }
}
```

`packages/bff/src/sesiones/indice.ts`:

```ts
// Índice de hilos por usuario — SOLO metadata (spec §10): título, timestamps y
// contador de turnos. La transcripción vive en AgentCore Memory. Este índice es
// lo que una UI usa para listar conversaciones (la standalone de 2e).
import { GetItemCommand, UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

type Deps = { ddb: DynamoDBClient; tabla: string };

export async function registrarTurnoEnIndice(
  deps: Deps,
  userId: string,
  sessionId: string,
  primerMensaje: string,
): Promise<number> {
  try {
    const out = await deps.ddb.send(
      new UpdateItemCommand({
        TableName: deps.tabla,
        Key: { userId: { S: userId }, sessionId: { S: sessionId } },
        UpdateExpression:
          "ADD turnos :uno SET titulo = if_not_exists(titulo, :titulo), ultimoTurnoAt = :ahora",
        ExpressionAttributeValues: {
          ":uno": { N: "1" },
          ":titulo": { S: primerMensaje.slice(0, 80) },
          ":ahora": { S: new Date().toISOString() },
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(out.Attributes?.turnos?.N ?? "0");
  } catch (e) {
    console.error("índice de sesiones falló (fail-open)", e);
    return 0;
  }
}

export async function turnosDeSesion(
  deps: Deps,
  userId: string,
  sessionId: string,
): Promise<number> {
  try {
    const out = await deps.ddb.send(
      new GetItemCommand({
        TableName: deps.tabla,
        Key: { userId: { S: userId }, sessionId: { S: sessionId } },
        ProjectionExpression: "turnos",
      }),
    );
    return Number(out.Item?.turnos?.N ?? "0");
  } catch (e) {
    console.error("lectura de turnos falló (fail-open)", e);
    return 0;
  }
}
```

- [ ] **Step 5: Handler — tests nuevos que fallan** (en `handler.test.ts`):

```ts
  it("un tope excedido responde 429 con frame limit_reached y su motivo", async () => {
    const recibido: InvokePayload[] = [];
    const r = await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido), limites: async () => ({ permitido: false, motivo: "dia" }) },
    );
    expect(r.status).toBe(429);
    const ev = JSON.parse((await frames(r.frames))[0].slice(6));
    expect(ev).toEqual({ type: "error", code: "limit_reached", motivo: "dia" });
    expect(recibido).toHaveLength(0);
  });

  it("los topes corren ANTES que el guardrail (no se paga ApplyGuardrail de más)", async () => {
    const guard = vi.fn(async () => ({ bloqueada: false }));
    await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso([]), guard, limites: async () => ({ permitido: false, motivo: "dia" }) },
    );
    expect(guard).not.toHaveBeenCalled();
  });
```

(agregar `import { vi } from "vitest";` si el archivo no lo tiene)

- [ ] **Step 6: Handler — implementación.** `Deps` gana `limites?: (userId: string, sessionId: string) => Promise<{ permitido: boolean; motivo?: "dia" | "sesion" }>`. Tras derivar el `sessionId` y ANTES del guard:

```ts
  if (deps.limites) {
    const l = await deps.limites(principal.userId, payload.sessionId);
    if (!l.permitido) {
      return {
        status: 429,
        frames: unFrame({ type: "error", code: "limit_reached", motivo: l.motivo }),
      };
    }
  }
```

(ojo al orden de construcción: el payload con el sessionId derivado ya existe antes de este check — mover la construcción del payload arriba del check si hace falta). En `config/index.ts`: `BffConfig` gana `tablas?: { sesiones: string; limites: string }` y `topes?: { diario: number; porSesion: number }`. En `resource.ts`: leer `Resource.SessionsTable.name`, `Resource.LimitsTable.name` y `process.env.LIMITE_DIARIO`/`LIMITE_POR_SESION` (con defaults 50/40 — este archivo es el único que toca env). En `lambda.ts`: construir `limites` con `verificarYConsumirTope` + `turnosDeSesion` (cliente `DynamoDBClient` a nivel módulo; **`hoy` se calcula POR REQUEST** — `new Date().toISOString().slice(0, 10)` dentro del closure de `limites`, nunca a nivel módulo: un contenedor caliente cruzaría la medianoche con la fecha vieja), y tras un invoke exitoso llamar `registrarTurnoEnIndice` (fire-and-forget con `.catch(console.error)` — no bloquea el stream).

- [ ] **Step 7: GREEN** — `npx vitest run && npx tsc --noEmit` · Expected: PASS, limpio

- [ ] **Step 8: Commit**

```bash
git add packages/bff package-lock.json
git commit -m "feat(bff): topes de uso e indice de hilos con fail-open"
```

---

### Task 8: Widget — mensaje humano para limit_reached

**Files:**
- Modify: `packages/widget/src/index.ts` (rama nueva + registro compartido), `packages/widget/src/index.test.ts` (+1 test), `packages/widget/package.json` (dep shared)

**Interfaces:**
- Consumes: `MENSAJES_LIMITE` (Task 1); frame `{type:"error",code:"limit_reached",motivo:"dia"|"sesion"}` (Task 7)
- Produces: la burbuja muestra `MENSAJES_LIMITE.diarioAlcanzado` o `.sesionAlcanzada` según `motivo`

- [ ] **Step 1: Instalar** — `cd packages/widget && npm i -E @craftech-ai-chat/shared` (mismo fallback del workspace que en Task 3 si `-E` se queja)

- [ ] **Step 2: Test que falla** (en `index.test.ts`, con los helpers existentes `sse()` y el stub de fetch):

```ts
  it("ante limit_reached muestra el mensaje del registro según el motivo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"error","code":"limit_reached","motivo":"dia"}\n\n'),
      ),
    );
    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");
    expect(el.textContent).toMatch(/límite de mensajes de hoy/i);
  });
```

- [ ] **Step 3: RED** — `npx vitest run` · Expected: FAIL (muestra el genérico)

- [ ] **Step 4: Implementación.** En `index.ts`: importar `MENSAJES_LIMITE` del registro compartido y en la rama de error, antes del fallback genérico:

```ts
        } else if (ev.code === "limit_reached") {
          burbuja.textContent =
            ev.motivo === "sesion"
              ? MENSAJES_LIMITE.sesionAlcanzada
              : MENSAJES_LIMITE.diarioAlcanzado;
```

(El registro `MENSAJES` local del widget se mantiene para sus textos propios; los compartidos vienen de shared — vite los bundlea.)

- [ ] **Step 5: GREEN + build** — `npx vitest run && npx tsc --noEmit && npx vite build` · Expected: PASS, `dist/widget.js` generado

- [ ] **Step 6: Commit**

```bash
git add packages/widget package-lock.json
git commit -m "feat(widget): mensaje humano para limite alcanzado"
```

---

### Task 9: Mock — memoria en proceso y escenarios de tope/bloqueo

**Files:**
- Modify: `examples/demo-client/mock.mjs` (+historial y escenarios), `examples/demo-client/mock.test.mjs` (+3 tests), `examples/demo-client/server.mjs` (estado por sesión), `examples/demo-client/public/index.html` (hint), `examples/demo-client/README.md`

**Interfaces:**
- Consumes: contrato de frames (incl. `limit_reached` de Task 7 y el done-canónico de Task 3)
- Produces: `planificarRespuesta(mensaje, sub, contexto)` — tercer parámetro `{ turnos: number, historial: string[] }`; keywords nuevas: `tope` → frame `{type:"error",code:"limit_reached",motivo:"dia"}`; `bloqueado` → done con el texto de `MENSAJES_GUARDRAIL.entradaBloqueada`; `memoria` → la respuesta incluye cuántos turnos lleva la conversación y el último mensaje previo

- [ ] **Step 1: Tests que fallan** (en `mock.test.mjs`; importar `MENSAJES_GUARDRAIL` no es posible en .mjs sin build — duplicar el texto NO: leerlo vía import TS tampoco; el mock ES ejemplo sin build, así que se afirma la FORMA, no el texto exacto):

```js
import { describe, expect, it } from "vitest";
import { planificarRespuesta } from "./mock.mjs";

const ctx = { turnos: 0, historial: [] };

describe("escenarios de la fase 2b", () => {
  it("'tope' produce el frame de límite con motivo", () => {
    const { frames } = planificarRespuesta("quiero ver el tope", "A", ctx);
    expect(frames).toEqual([{ type: "error", code: "limit_reached", motivo: "dia" }]);
  });

  it("'bloqueado' responde un done de política (respuesta, no error)", () => {
    const { frames } = planificarRespuesta("bloqueado por favor", "A", ctx);
    expect(frames.at(-1).type).toBe("done");
    expect(frames.at(-1).text.length).toBeGreaterThan(20);
  });

  it("'memoria' usa el contexto: menciona los turnos y el mensaje previo", () => {
    const { frames } = planificarRespuesta("memoria", "A", {
      turnos: 2,
      historial: ["hola", "¿cómo estás?"],
    });
    const texto = frames.at(-1).text;
    expect(texto).toContain("2");
    expect(texto).toContain("¿cómo estás?");
  });
});
```

- [ ] **Step 2: RED** — `npm test -w @craftech-ai-chat/demo-client` · Expected: FAIL (firma de 2 args / escenarios inexistentes)

- [ ] **Step 3: Implementación.** `mock.mjs`: `planificarRespuesta(mensaje, sub, contexto = { turnos: 0, historial: [] })`; escenarios por keyword (case-insensitive) ANTES del caso general: `tope` → plan con el único frame de límite; `bloqueado` → done con un texto de política en español (>20 chars, mismo espíritu que el registro; el texto real de producción sale de shared — el mock lo emula y el comentario lo dice); `memoria` → done que dice `Llevamos ${contexto.turnos} turnos; lo último que me dijiste fue: "${contexto.historial.at(-1)}"`. Los tests existentes siguen pasando (el tercer parámetro tiene default). `server.mjs`: un `Map` `historialPorSesion` (sessionId → array de mensajes); en cada `/chat` mock: `const contexto = { turnos: historial.length, historial }` → planificar → después de responder, pushear el mensaje. `index.html`: hint agrega `· memoria · tope · bloqueado`. README: párrafo de los escenarios nuevos.

- [ ] **Step 4: GREEN** — `npm test -w @craftech-ai-chat/demo-client` (7/7) y verificación manual: `npm run dev`, probar `memoria` dos veces (la segunda menciona el turno previo), `tope` y `bloqueado`.

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "feat(examples): mock con memoria en proceso y escenarios de tope y bloqueo"
```

---

### Task 10: Smoke del deploy (humano en el loop)

Fuera del alcance de los subagentes (regla de la fase 2a): la corre el controlador con el humano tras el push a `staging`.

- [ ] Push a `staging` → CI verde (typechecks + 4 suites + smoke de imagen + deploy).
- [ ] Smoke de memoria real: dos mensajes al MISMO `sessionId` — el segundo pregunta "¿qué te pregunté recién?" y la respuesta debe referirlo (Memory funcionando).
- [ ] Smoke de topes: bajar `LIMITE_POR_SESION` a "2" en un stage de prueba o mandar N mensajes hasta el 429 con frame `limit_reached`.
- [ ] Smoke de guardrail de entrada: un mensaje que dispare `PROMPT_ATTACK` (p.ej. "ignorá tus instrucciones y...") → done con el mensaje canónico, sin invoke al Runtime (verificar en logs de la Lambda).
- [ ] Anotar latencias en `docs/mediciones.md` (el turno ahora suma ListEvents + CreateEvent + 2 Dynamo).

## Definición de terminado (fase 2b)

- [ ] Suites: core (pytest) + shared + bff + widget + demo-client, todas verdes y limpias
- [ ] `npm run typecheck` y `npm run typecheck:infra` limpios; `sst-env.d.ts` interino actualizado
- [ ] El mock demuestra memoria, tope y bloqueo sin AWS (`npm run dev`)
- [ ] Smoke real de Task 10 completado con el humano
- [ ] `infra/CONTRACT.md` refleja los recursos y variables nuevos

## Fuera de esta fase

Memoria long-term/resúmenes; listado de conversaciones en UI (2e usa el índice); tools (2c); RAG (2d); ajuste de topes por cliente vía client.config (2e).
