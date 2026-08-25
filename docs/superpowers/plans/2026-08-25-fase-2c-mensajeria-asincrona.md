# craftech-ai-chat — Fase 2c: mensajería asíncrona (SQS + worker con debounce)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El chat deja de ser síncrono/streaming: los mensajes viven en un store, un worker con debounce invoca al agente, y el widget lee por polling — la arquitectura que hace posibles WhatsApp y Facebook como adapters futuros. Primera tanda: widget como único canal.

**Architecture:** El BFF se convierte en **Messages Backend**: POST `/mensajes` (auth + topes + guardrail de entrada → escribe en `MessagesTable` → encola en SQS FIFO con delay de debounce) y GET `/mensajes` (polling). Un **worker** nuevo consume la cola (grupo FIFO = conversación → serial), verifica contra el store que su mensaje siga siendo el último del usuario (debounce), agrega los mensajes pendientes en un turno, invoca AgentCore con el contrato de siempre y escribe la respuesta en el store. El core NO cambia. El widget cambia de transporte (POST + polling), no de UI.

**Tech Stack:** lo ya fijado + `@aws-sdk/client-sqs` (BFF) y el runtime de SQS→Lambda (worker). Sin dependencias nuevas en widget/core.

**Spec:** `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md` — §8 v2 (flujo async), §5 (worker), §10 (dos stores), §15 (errores v2), §16 (regla de mock).

**Convención de rutas:** relativas a la raíz del repo.

## Global Constraints

- **El core no se toca.** Su contrato (`/invocations` con `{message, userId, sessionId, history?}` → SSE) queda idéntico; el worker consume ese SSE completo y usa el texto del `done`.
- **La frontera de confianza no se mueve**: todo lo que entra a la cola pasó por auth + topes + guardrail en el Messages Backend. El worker confía en la cola.
- **`conversationId` ES el `runtimeSessionId` derivado** (`sha256(userId:hilo)`) — misma clave para store, cola, tope por sesión y Memory. Nunca del browser.
- **Orden del POST**: auth → mensaje → topes → guardrail → store+encolar. Un mensaje bloqueado escribe la respuesta de política como mensaje del asistente DIRECTO al store (sin encolar); un tope rechazado responde 429 JSON sin escribir nada.
- **Fail-open donde ya existía** (guardrail, topes); el worker es **fail-safe**: cualquier error → escribe un mensaje del asistente con `MENSAJES_WORKER.error` (registro compartido) — el usuario nunca ve silencio. El handler del worker NUNCA lanza (un throw reintentaría por SQS y bloquearía el grupo FIFO).
- **FIFO real**: `MessageGroupId = conversationId`, `MessageDeduplicationId = msgId`, delay A NIVEL COLA (FIFO no soporta delay por mensaje) = `DEBOUNCE_SEGUNDOS` (default "6").
- Los textos nuevos visibles van a `packages/shared` (`MENSAJES_WORKER`). Máx 400 líneas; español; `npm i -E`; TDD estricto con RED/GREEN; suites previas que no se retiran, intactas; `sst-env.d.ts` interino actualizado con cada linkable nuevo.
- **Retiro del streaming**: `handler.ts`/SSE del BFF y el reader SSE del widget se ELIMINAN con sus tests (no quedan muertos); `ndjson.ts` NO se borra — se muda al worker, que es quien ahora consume el stream del Runtime.
- Deploys por CI; smoke real = Task 9 (controlador + humano).

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `packages/shared/src/mensajes.ts` | + `MENSAJES_WORKER` (error del agente en async) |
| `infra/sst/mensajeria.ts` | `MessagesTable` (Dynamo) + `MensajesCola` (SQS FIFO + DLQ) + linkables |
| `infra/sst/worker.ts` | La Lambda del worker + suscripción a la cola + permisos |
| `packages/bff/src/mensajes/store.ts` | Escribir/listar mensajes; último msg del usuario; pendientes desde la última respuesta |
| `packages/bff/src/mensajes/api.ts` | `postMensaje` y `getMensajes` (la API del Messages Backend, testeable sin Lambda) |
| `packages/bff/src/chat/lambda.ts` | Router por path: POST/GET `/mensajes` (el path SSE se retira) |
| `packages/worker/src/turno.ts` | Debounce + agregación + invoke + writeback (lógica pura testeable) |
| `packages/worker/src/lambda.ts` | Handler SQS: pegamento AWS (nunca lanza) |
| `packages/widget/src/index.ts` | Transporte nuevo: POST + polling; misma UI |
| `examples/demo-client/server.mjs` + `mock.mjs` | Mock del Messages Backend + worker fake con debounce |

## Paralelización (regla del proyecto, 2026-08-25)

Las tareas se ejecutan en OLAS de archivos disjuntos, un worktree por implementer:

- **Ola 1 (paralela):** T1 (shared+infra) ∥ T2 (store, deps inyectadas) ∥ T6 (widget,
  contra el contrato del plan) ∥ T7 (mock, ídem). Ninguna instala deps npm → cero
  conflicto de lockfile.
- **Ola 2 (serial):** T3 (necesita T1+T2 mergeadas).
- **Ola 3 (serial):** T4 → T5 (comparten la zona de bff/chat y el lockfile: T4 saca
  el streaming, T5 muda ndjson y crea el worker) → T8 (docs).
- T9 (smoke) al final, controlador + humano.

Merge: el controlador mergea cada rama `wt/tN` a `fase-2a` DESPUÉS de su review
limpia, en orden de ola; la suite completa corre tras cada merge.

---

### Task 1: Registro + infra de mensajería

**Files:**
- Modify: `packages/shared/src/mensajes.ts` (+`MENSAJES_WORKER`), `packages/shared/src/mensajes.test.ts` (+1 aserción en el test existente)
- Create: `infra/sst/mensajeria.ts`
- Modify: `infra/sst/bff.ts` (links + env), `sst-env.d.ts`, `infra/CONTRACT.md`

**Interfaces:**
- Produces:
  - `MENSAJES_WORKER = { error: "Tuve un problema para responderte. Probá de nuevo en un momento." }`
  - `MessagesTable`: pk `conversationId` (string), sk `orden` (string, `${ts ISO}#${msgId}`) — el orden lexicográfico ES el cronológico
  - `MensajesCola` (SQS FIFO, `craftech-ai-chat-mensajes-${stage}.fifo`, `delaySeconds` de env `DEBOUNCE_SEGUNDOS` default 6, DLQ con maxReceiveCount 3)
  - Linkables: `MessagesTable { name }`, `MensajesCola { url }` — BFF linkea ambos (permisos: Dynamo Query/PutItem scoped; `sqs:SendMessage` scoped al arn de la cola)
  - Env del BFF: `DEBOUNCE_SEGUNDOS: "6"` (documentado: el delay real vive en la cola; el env es informativo para logs/tests)

- [ ] **Step 1: Registro (TDD).** Aserción nueva en el test de mensajes (RED): incluir `MENSAJES_WORKER.error` en el loop de textos. Implementar en `mensajes.ts` con comentario ("respuesta del asistente cuando el worker falla: el usuario nunca ve silencio"). GREEN.

- [ ] **Step 2: Infra.** `infra/sst/mensajeria.ts`:

```ts
// La mensajería asíncrona (spec §8 v2): el store es la fuente de verdad de la
// transcripción para UIs y canales; la cola FIFO serializa por conversación.
export const messagesTable = new sst.aws.Dynamo("MessagesTableDb", {
  fields: { conversationId: "string", orden: "string" },
  primaryIndex: { hashKey: "conversationId", rangeKey: "orden" },
});

const dlq = new sst.aws.Queue("MensajesDlq", { fifo: true });

// Sufijo Queue en el COMPONENTE: los nombres de componentes SST son únicos
// globalmente y el Linkable de abajo ya usa "MensajesCola" (la clave de
// Resource) — misma lección que MessagesTableDb (y que el fix de deploy de 2b).
export const mensajesCola = new sst.aws.Queue("MensajesColaQueue", {
  fifo: true,
  // FIFO no soporta delay POR MENSAJE: el delay de la cola ES la ventana de
  // debounce — todo mensaje espera estos segundos antes de ser visible.
  delay: "6 seconds",
  // SIEMPRE mayor que el timeout del worker (3 min): con el default de 30s,
  // SQS re-entrega mientras el invoke sigue corriendo → doble respuesta
  // silenciosa. 2x el timeout alcanza porque el handler nunca lanza (la
  // redelivery solo ocurre en crash duro) y un 6x literal bloquearía la
  // conversación FIFO demasiado tiempo tras un crash.
  visibilityTimeout: "6 minutes",
  dlq: { queue: dlq.arn, retry: 3 },
});

export const messagesTableLink = new sst.Linkable("MessagesTable", {
  properties: { name: messagesTable.name },
  include: [
    sst.aws.permission({
      actions: ["dynamodb:Query", "dynamodb:PutItem"],
      resources: [messagesTable.arn],
    }),
  ],
});

export const mensajesColaLink = new sst.Linkable("MensajesCola", {
  properties: { url: mensajesCola.url },
  include: [
    sst.aws.permission({ actions: ["sqs:SendMessage"], resources: [mensajesCola.arn] }),
  ],
});
```

**Verificar contra `.sst/platform/src/components/aws/queue.ts`** (lección 2a/2b): nombres reales de `fifo`, `delay`, `dlq` (¿`dlq: {queue, retry}` o `dlq: arn`?), y si `Queue` exige sufijo `.fifo` en un `name` explícito (no pasamos name → autoname; confirmar que el componente agrega `.fifo` solo). Si difiere, usar lo real y anotar el mapeo en CONTRACT.md.

En `bff.ts`: links + `DEBOUNCE_SEGUNDOS: "6"` en environment. `sst-env.d.ts`: `MessagesTable { name }`, `MensajesCola { url }`. CONTRACT.md: recursos y variables nuevos.

- [ ] **Step 3:** `npx sst install && npm run typecheck:infra` OK. Commit: `feat(infra): store de mensajes y cola FIFO con debounce`

---

### Task 2: Store de mensajes (BFF)

**Files:**
- Create: `packages/bff/src/mensajes/store.ts`, `packages/bff/src/mensajes/store.test.ts`

**Interfaces:**
- Produces (todas reciben `deps: { ddb: DynamoDBClient; tabla: string }`):
  - `type Mensaje = { conversationId: string; orden: string; msgId: string; rol: "user" | "assistant"; texto: string; ts: string }`
  - `escribirMensaje(deps, m: Omit<Mensaje, "orden">): Promise<Mensaje>` — arma `orden = `${m.ts}#${m.msgId}``, PutItem; LANZA en error (el caller decide; acá no hay fail-open: perder un mensaje del usuario sí es grave)
  - `listarMensajes(deps, conversationId, desde?: string): Promise<Mensaje[]>` — Query ascendente por `orden`, con `orden > :desde` si viene cursor; devuelve [] en error (fail-open de lectura, con console.error)
  - `pendientesDesdeUltimaRespuesta(deps, conversationId): Promise<Mensaje[]>` — Query DESCENDENTE, corta en el primer `rol=assistant`, devuelve los `user` en orden cronológico
  - `ultimoMsgIdUsuario(deps, conversationId): Promise<string | null>`

- [ ] **Step 1: Tests (TDD, RED).** Con dobles de ddb (patrón de `topes.test.ts`): escribir arma la key compuesta y serializa campos; listar aplica `KeyConditionExpression` con `>` cuando hay `desde` y devuelve [] si el ddb revienta (con console.error espiado); pendientes: dado un Query descendente que devuelve [assistant#3, user#2, user#1] → `[user#1, user#2]`... ojo: descendente devuelve [user#2b, user#2a, assistant#1, user#0] → corta en assistant → devuelve [user#2a, user#2b] cronológico; último msgId usuario con mezcla de roles.
- [ ] **Step 2: RED** → **Step 3: implementación** (Query con `ScanIndexForward` según el caso; comentarios en español del porqué de cada semántica) → **Step 4: GREEN + typecheck** → **Step 5: Commit** `feat(bff): store de mensajes`

---

### Task 3: La API del Messages Backend

**Files:**
- Create: `packages/bff/src/mensajes/api.ts`, `packages/bff/src/mensajes/api.test.ts`
- Modify: `packages/bff/src/config/index.ts` + `resource.ts` (`mensajes: { tabla, colaUrl, debounceSegundos }`)

**Interfaces:**
- Consumes: `verifyUserToken`, `evaluarEntrada`, `verificarYConsumirTope`/`turnosDeSesion`/`registrarTurnoEnIndice` (sin cambios), store de Task 2, `MENSAJES_GUARDRAIL`
- Produces:
  - `postMensaje(input: { token?, texto?, hilo? }, deps): Promise<{ status: number; body: { msgId?: string; conversationId?: string; error?: { code: string; motivo?: string } } }>` — deps inyectables: `{ cfg, store, encolar: (payload: { conversationId, msgId, userId }) => Promise<void>, guard?, limites? }`
  - Flujo del POST: auth (401 codes como antes, ahora en JSON) → texto vacío 400 → topes 429 `{error:{code:"limit_reached",motivo}}` → guardrail: si bloquea → escribe mensaje user + mensaje assistant con texto canónico al store, NO encola, responde 200 con msgId (el widget verá la respuesta por polling como cualquier otra) → normal: escribe user msg, encola `{conversationId, msgId, userId}` (groupId=conversationId, dedupId=msgId), `registrarTurnoEnIndice` fire-and-forget, responde 200 `{msgId, conversationId, orden}` (el `orden` es el cursor inicial del polling del widget)
  - `getMensajes(input: { token?, hilo?, desde? }, deps): Promise<{ status; body: { mensajes?: Mensaje[]; error? } }>` — auth igual; lista por el conversationId DERIVADO del principal (nunca del query), con cursor `desde`
  - La derivación `runtimeSessionId(userId, hilo)` se extrae de handler.ts a `packages/bff/src/mensajes/conversacion.ts` (export puro) para compartirla — handler.ts la importa de ahí mientras siga vivo (lo retira la Task 4)

- [ ] Tests (RED primero, ~8): auth 401/expirado; 400 vacío; 429 con motivo y NADA escrito/encolado; bloqueado → 2 escrituras (user+assistant policy) y 0 encoladas, status 200; normal → 1 escritura + 1 encolada con groupId/dedupId correctos y msgId devuelto; getMensajes deriva el conversationId del token (dos users, mismo hilo → listas distintas — reusar el patrón del test de aislamiento 2a); cursor `desde` pasa al store; guard/limites opcionales → flujo sin ellos intacto.
- [ ] Implementación → GREEN → typecheck → Commit `feat(bff): api de mensajes con guardrail y topes en el POST`

---

### Task 4: Router del Lambda y retiro del streaming

**Files:**
- Modify: `packages/bff/src/chat/lambda.ts` (router por path; adiós streamifyResponse), `packages/bff/package.json` (fuera `@aws-sdk/client-bedrock-agentcore`, entra `@aws-sdk/client-sqs`), `infra/sst/bff.ts` (la Function deja de ser streaming; fuera el permiso InvokeAgentRuntime y el link del runtime; CORS igual)
- Delete: `packages/bff/src/chat/handler.ts`, `handler.test.ts` (el flujo vive en api.ts con más tests), `packages/bff/src/chat/ndjson.ts` + test **se MUEVEN** a `packages/worker/src/` en la Task 5 (en esta task solo se retiran de bff si la 5 ya los copió — para mantener cada task verde: esta task los deja y la 5 los muda; ver nota)

**Nota de orden:** para que ambas tareas queden verdes por separado, esta task crea el router y borra `handler.ts`/`handler.test.ts`; `ndjson.ts` queda en bff hasta que la Task 5 lo mude (import temporal desde worker NO: la 5 lo copia y borra el original en su propio commit).

**Interfaces:**
- Produces: Lambda handler clásico (JSON): `POST /mensajes` → `postMensaje`; `GET /mensajes` → `getMensajes`; cualquier otro path → 404. `encolar` real con `SQSClient.SendMessageCommand` (`QueueUrl` del config, `MessageGroupId`, `MessageDeduplicationId`). Respuestas con `content-type: application/json` y el status de la API.

El router además CABLEA las deps reales de la API (era trabajo del viejo lambda.ts): `guard` con `evaluarEntrada` si hay `cfg.guardrail`, `limites` con `verificarYConsumirTope`+`turnosDeSesion` (con `hoy` POR REQUEST, como en 2b), `store` con el ddb, `encolar` con SQS. `registrarTurnoEnIndice` fire-and-forget se dispara en el POST exitoso (la semántica del contador de sesión pasa a contar mensajes aceptados — coherente con el tope).

- [ ] Tests del router: no hay (pegamento) — la evidencia es typecheck + las suites de api.ts; el smoke real lo cubre. Verificar que NINGÚN archivo de bff quede importando `client-bedrock-agentcore` (grep). Commit: `feat(bff): router de mensajes y retiro del camino streaming`

---

### Task 5: El worker

**Files:**
- Create: `packages/worker/package.json`, `tsconfig.json`, `src/turno.ts`, `src/turno.test.ts`, `src/lambda.ts`
- Move: `packages/bff/src/chat/ndjson.ts` + `ndjson.test.ts` → `packages/worker/src/` (copiar, borrar el original, ajustar imports; los tests se mudan tal cual)
- Create: `infra/sst/worker.ts` · Modify: `sst.config.ts` si hace falta import, `sst-env.d.ts`, `infra/CONTRACT.md`

**Interfaces:**
- Produces:
  - `procesarMensaje(evento: { conversationId, msgId, userId }, deps): Promise<"procesado" | "descartado" | "error_respondido">` — deps: `{ store (Task 2 interfaces), invocar: (payload: { message, userId, sessionId }) => Promise<AsyncIterable<Uint8Array>>, escribir: typeof escribirMensaje }`
  - Lógica: `ultimoMsgIdUsuario != msgId` → "descartado" (log). Si es el último: `pendientesDesdeUltimaRespuesta` → `message = textos.join("\n")` → invocar → parsear frames (ndjson.ts mudado) → texto = frame `done` (o error del core → tratar como fallo) → `escribirMensaje(assistant)` → "procesado". CUALQUIER fallo (invoke, stream, parse, PutItem del assistant) → escribir assistant con `MENSAJES_WORKER.error` (si hasta ESO falla, log y tragar) → "error_respondido". **Jamás lanza.**
  - `lambda.ts`: handler SQS batch (registros → for secuencial → `procesarMensaje` con deps reales: `InvokeAgentRuntimeCommand` — el código de invoke se muda desde el viejo lambda.ts del bff — y ddb). Nunca lanza; siempre consume el batch.
  - `infra/sst/worker.ts`: `new sst.aws.Function("Worker", { handler: "packages/worker/src/lambda.handler", link: [messagesTableLink-worker?, runtimeLink], permissions: [InvokeAgentRuntime al arn + runtime-endpoint/*, dynamodb Query/PutItem a la tabla], timeout: "3 minutes" })` + `mensajesCola.subscribe(worker, { batch: { size: 1 } })` — verificar la forma real de subscribe/batch en `.sst/platform` (queue.subscribe acepta el handler directo: usar el patrón real del componente).

- [ ] Tests de `turno.ts` (RED, ~6): descarta si no es el último; agrega 2 pendientes con \n; escribe el done como assistant; frame error del core → assistant con MENSAJES_WORKER.error; invoke que lanza → ídem y NO lanza; PutItem del assistant que lanza → no lanza (log). Los tests de ndjson mudados pasan sin cambios.
- [ ] GREEN → typecheck raíz + infra → Commit `feat(worker): debounce, agregacion e invoke asincrono del agente`

---

### Task 6: Widget — transporte polling

**Files:**
- Modify: `packages/widget/src/index.ts` (transporte), `index.test.ts` (rewrite de los tests de transporte; los de UI/estilos quedan)

**Interfaces:**
- `mount(el, { tokenUrl, apiUrl })` — `apiUrl` reemplaza a `chatUrl` (base del Messages Backend). `send(texto)`: burbuja user + escribiendo (igual que hoy) → `POST ${apiUrl}/mensajes` `{texto, hilo}` → por status/JSON: 401 expired → retry-once (igual que hoy); 429 → textos de límite por motivo; otros errores → genérico. 200 → **polling**: `GET ${apiUrl}/mensajes?hilo=…&desde=<orden del msg propio>` cada 1500 ms hasta encontrar `rol=assistant` con `orden > desde` (renderiza y corta) o timeout 90 s → genérico. El POST devuelve msgId; el GET del primer poll usa `desde` derivado de la respuesta del POST (el body incluye `orden`? → agregar `orden` al body del POST en api.ts Task 3 — SÍ: el POST devuelve `{msgId, conversationId, orden}`).
- El `hilo` sigue siendo el de `sessionStorage` (`sesion()` actual); el server deriva el conversationId real — sin cambios de seguridad.
- `leerSse` y los tests de frames SSE se ELIMINAN.

- [ ] Tests (rewrite, TDD): render de la respuesta tras N polls (fetch stub que devuelve [] dos veces y el assistant a la 3ra — con `vi.useFakeTimers` o interval corto inyectable: agregar `_pollMs` opcional en opts para tests); 429 motivo dia; expired retry-once (POST 401 → renueva → segundo POST ok); timeout → genérico (con `_pollTimeoutMs` inyectable); los 4 tests de UI (burbujas/estilos/escribiendo) intactos.
- [ ] GREEN + build → Commit `feat(widget): transporte asincrono con polling`

---

### Task 7: Mock del demo-client (regla §16)

**Files:**
- Modify: `examples/demo-client/server.mjs` (endpoints nuevos + worker fake), `mock.mjs` (sin cambios de firma; se reusa), `mock.test.mjs` (+2), `public/index.html` (apiUrl), `README.md`

**Comportamiento:** el mock implementa el MISMO contrato: `POST /mensajes` (guarda user msg en un Map por conversación, programa con `setTimeout(DEBOUNCE_MS=1200)` el "worker" fake: si llegó otro mensaje después, no responde — el timer del último agrega todos; genera la respuesta con `planificarRespuesta(textosAgregados, sub, contexto)` y la guarda como assistant) y `GET /mensajes?desde=`. Escenarios: `tope` → 429 en el POST; `bloqueado` → user+assistant policy directo (sin debounce); `vencido` → 401 expired_token en el POST primera vez. **El debounce se VE en el mock**: mandar dos mensajes rápido produce UNA respuesta que menciona ambos.

- [ ] Tests: POST+GET del contrato con fetch al server levantado en puerto efímero (node:test style con vitest: levantar server en beforeAll — si el server no es importable como función, refactor mínimo `crearServer()` exportable) — 2 tests: flujo normal (POST → esperar >debounce → GET trae assistant), debounce (2 POST seguidos → UNA respuesta). GREEN → smoke manual browser → Commit `feat(examples): mock del messages backend con worker fake y debounce visible`

---

### Task 8: Limpieza de contrato y docs

**Files:**
- Modify: `infra/CONTRACT.md` (tabla final v2), `README.md` raíz (flujo nuevo, un párrafo), `examples/demo-client/README.md` si quedó referencia a SSE, `docs/mediciones.md` (nota: latencia percibida pasa a respuesta+debounce)
- Verificar con grep que no queden referencias vivas a `chatUrl`/SSE/streaming fuera de docs históricos (plan/ledgers no se tocan).

- [ ] Commit: `docs: contrato y lecturas de la arquitectura v2`

---

### Task 9: Smoke real (controlador + humano)

- [ ] Push a staging → CI verde (el CI no cambia).
- [ ] Turno normal: POST → polling → respuesta en el store y en el widget (~4–9 s con debounce).
- [ ] **Debounce en vivo**: dos POST seguidos (<6 s) al mismo hilo → UNA sola invocación al Runtime (verificar en logs del worker: un "descartado" + un "procesado") y una respuesta que atiende ambos mensajes.
- [ ] Memoria: sigue funcionando (3 turnos, recall del 1º) — ahora vía worker.
- [ ] Bloqueado: respuesta de política aparece por polling sin invocación.
- [ ] DLQ vacía; latencias a `docs/mediciones.md`.

## Definición de terminado

- Suites: shared, bff (sin handler/ndjson), worker (nuevo), widget, demo-client, core — verdes y limpias; typechecks OK
- `npm run dev` demuestra el flujo async Y el debounce sin AWS
- Smoke real de Task 9 completo
- CONTRACT.md refleja la v2; cero referencias vivas al camino SSE

## Fuera de esta fase

Adapters de canales (WhatsApp/Facebook — fases cortas propias), push en vez de polling, panel "Message UI" del diagrama, Cognito del Messages Backend (2f standalone), tools (2d), RAG (2e).
