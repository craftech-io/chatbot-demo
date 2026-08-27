# Fase 2d — Tools (tenant vía Gateway, usuario vía HTTP) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El agente puede usar herramientas: las de tenant (catálogo, FAQ — lo mismo para todos) vía AgentCore Gateway con MCP, y las de usuario ("mis pedidos") llamando la API del cliente por HTTP con el `actToken` del usuario.

**Architecture:** El core (LlamaIndex) gana un loop de function calling en su workflow explícito: `achat_with_tools` → ejecutar tool calls → repetir hasta respuesta final. Las tools de tenant llegan como MCP tools desde un AgentCore Gateway (inbound **AWS_IAM/SigV4** — verificado en spike 2026-08-26, sin prerequisito de JWT); las de usuario son `FunctionTool`s locales que llaman la API del cliente con el `actToken`. El `actToken` viaja (decisión aceptada, opción A): claim `act_token` del chat-token o, en su defecto, el token crudo presentado → campo del mensaje SQS (cifrado en reposo, **NUNCA** en MessagesTable) → payload del InvokeAgentRuntime. Para la demo, una Lambda "API del cliente" de ejemplo expone `/catalogo` (tenant) y `/pedidos` (usuario).

**Tech Stack:** `llama-index-tools-mcp>=0.5.0` (única dep nueva; trae `mcp 2.1.1`, resuelve limpio contra los pins — verificado), `httpx` pasa a dependencia de runtime del core, `awsnative.bedrockagentcore.Gateway/GatewayTarget` (existen en `@pulumi/aws-native` 1.68.0 — verificado), botocore SigV4 (~20 líneas de `httpx.Auth`).

**Spec:** `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md` §7 (tools; ojo: la credencial outbound es POR TARGET, no de nivel gateway — corrección del spike) y §18 fase 2d (decisión del actToken).

## Global Constraints

- Todo en español: código, comentarios, tests, commits. TDD estricto (rojo verificado antes de implementar).
- NUNCA `git stash`. NUNCA loguear el `actToken` ni escribirlo en DynamoDB — solo cola y payload.
- Regla del proyecto: toda capacidad con modo local/mock (el core con `FAKE_LLM` + tools falsas; el demo con keywords nuevas).
- Python: seguir el estilo de `core/` (adaptadores inyectables, workflow de steps explícitos, nada de agentes prefabricados).
- El widget (`packages/widget`) NO se toca en esta fase.

## Paralelización

- **Ola 1 (4 tareas en paralelo, archivos disjuntos):**
  - T1 = `core/` (+ `pyproject.toml`/`uv.lock` raíz — SOLO las líneas de deps nuevas)
  - T2 = `infra/sst/` + `examples/api-cliente/` + `sst-env.d.ts`
  - T3 = `packages/bff/` + `packages/worker/` + `infra/CONTRACT.md`
  - T4 = `examples/demo-client/`
  - Un worktree por agente (`wt/d1`..`wt/d4`); merges seriales del controlador con suite completa tras cada merge.
- **Ola 2:** T5 (controlador + humano): deploy y smoke.

## Contratos entre tareas (cerrados acá; nadie los renegocia)

- **Mensaje SQS** (lo produce T3-bff, lo consume T3-worker): el body actual suma `actToken?: string`.
- **Payload InvokeAgentRuntime** (lo produce T3-worker, lo consume T1): `{ message, userId, sessionId, actToken? }`.
- **Env del core** (lo setea T2, lo lee T1): `GATEWAY_URL` (endpoint MCP del gateway; vacío/ausente ⇒ sin tools de tenant), `CLIENT_API_URL` (base URL de la API del cliente; vacío/ausente ⇒ sin tools de usuario).
- **API del cliente demo** (la sirve T2, la mockea T4, la consume T1 vía tools): `GET /catalogo` → 200 `{"productos":[{"id":"p-1","nombre":"Casco MTB","precio":45000},{"id":"p-2","nombre":"Luz trasera USB","precio":12000},{"id":"p-3","nombre":"Kit de parches","precio":3500}]}` (sin auth). `GET /pedidos` → exige header `Authorization: Bearer <actToken>`; sin header → 401 `{"error":"falta el token"}`; con header → 200 `{"pedidos":[{"id":"A-1001","estado":"en camino","eta":"mañana"},{"id":"A-0997","estado":"entregado"}]}` (contenido fijo demo; el `sub` del token no se valida en la demo API — es un ejemplo, documentarlo).
- **Nombres de tools** (T1 y T4 los citan igual): tenant vía gateway (los nombra el OpenAPI: `listar_catalogo`), usuario local: `mis_pedidos`.

---

### Task 1: Function calling y tools en el core

**Files:**
- Modify: `core/src/agent/workflow.py` (loop de tools en el step `responder`)
- Modify: `core/src/agent/llm.py` (BedrockAdapter gana el camino con tools)
- Create: `core/src/agent/tools.py` (tools de usuario + cliente MCP con SigV4)
- Modify: `core/src/agent/config.py` (`gateway_url`, `client_api_url` opcionales)
- Modify: `core/server.py` (pasa `actToken` del payload y arma las tools por request)
- Modify: `pyproject.toml` + `uv.lock` raíz (deps: `llama-index-tools-mcp>=0.5.0`, `httpx` a runtime)
- Test: `core/tests/test_tools.py` (nuevo), `core/tests/test_workflow.py` (casos de loop), `core/tests/test_server.py` (payload con actToken)

**Interfaces:**
- Consumes: payload `{message, userId, sessionId, actToken?}` (contrato de arriba); env `GATEWAY_URL`/`CLIENT_API_URL`.
- Produces: nada que otra tarea importe (el core es la punta).

**Diseño cerrado:**
- El protocolo `AdaptadorLLM` gana un método opcional de tools; `BedrockAdapter` lo implementa con `achat_with_tools` + `get_tool_calls_from_response` (existen en el pin 0.14.18 — verificado). Firma nueva del adaptador:

```python
async def aresponder_con_tools(
    self, message: str, history: list[dict], tools: list  # list[BaseTool]
) -> tuple[str | None, list]:  # (texto_final | None, tool_calls pendientes)
```

- El step `responder` del workflow: si no hay tools ⇒ camino actual intacto (astream). Con tools ⇒ loop (máx. 4 rondas): `aresponder_con_tools` → si hay tool_calls, `await tool.acall(**kwargs)` por cada una, apendear resultados al history como mensajes `tool`, repetir; al agotar rondas sin texto final, responder un mensaje humano de fallback ("No pude completar la consulta…"). El texto final sale por el MISMO ChatDone.texto de siempre.
- `tools.py`:
  - `crear_tools_usuario(base_url: str, act_token: str | None) -> list[FunctionTool]`: si falta `act_token`, la tool `mis_pedidos` existe igual pero devuelve "El usuario no está autenticado para consultar sus pedidos" (el agente lo explica en humano; NUNCA manda un request sin token). Con token: `httpx.AsyncClient` → `GET {base_url}/pedidos` con `Authorization: Bearer {act_token}`; timeout 10s; error/timeout ⇒ string de error humano (fail-open conversacional, nunca excepción al workflow).
  - `class SigV4Auth(httpx.Auth)`: firma cada request con `botocore.auth.SigV4Auth(credentials, "bedrock-agentcore", region)` (mecanismo verificado en spike; `requires_request_body = True`).
  - `async def tools_de_gateway(gateway_url: str) -> list`: `BasicMCPClient(gateway_url, http_client=httpx.AsyncClient(auth=SigV4Auth(...)))` + `McpToolSpec(client).to_tool_list_async()`. Error al listar ⇒ log + lista vacía (el chat sigue sin tools de tenant; fail-open como los reads del bff).
- `server.py`: `act_token = payload.get("actToken")`; arma `tools = tools_usuario + tools_gateway` por request (las de gateway se cachean a nivel módulo tras la primera lista exitosa — una lista por microVM, no por turno).
- Modo local (regla): con `FAKE_LLM`, un `_EchoLLM` extendido que ante "pedido" simula una tool call a `mis_pedidos` — pinea el loop sin Bedrock ni red.

- [ ] **Step 1: Tests en rojo.** `test_tools.py`: (a) `crear_tools_usuario` sin token → la tool devuelve el mensaje de no-autenticado y NO llama HTTP (httpx mockeado con `respx` NO — sin deps nuevas de test: inyectar `client_factory` como hace llm.py); (b) con token → GET con el Bearer correcto; (c) error de red → string humano. `test_workflow.py`: (d) LLM falso que devuelve una tool call y después texto → el loop ejecuta la tool y el ChatDone.texto es el texto final; (e) LLM que nunca da texto → fallback humano a las 4 rondas. `test_server.py`: (f) payload con `actToken` llega a `crear_tools_usuario`.
- [ ] **Step 2: Correr y ver fallar** (`uv run pytest core/tests/ -x` desde el root). Pegar salida.
- [ ] **Step 3: Implementar** (tools.py → llm.py → workflow.py → server.py → config.py), en ese orden, verde incremental.
- [ ] **Step 4: Deps.** `uv add llama-index-tools-mcp httpx` (verificar que el lock resuelve mcp>=2 sin conflictos — el spike ya lo probó en limpio).
- [ ] **Step 5: Suite completa del core** (`uv run pytest`) + pegar salida.
- [ ] **Step 6: Commit** `feat(core): function calling con tools de usuario y de gateway (2d)`

### Task 2: Gateway + API del cliente demo (infra)

**Files:**
- Create: `infra/sst/gateway.ts`
- Create: `infra/sst/api-cliente.ts`
- Create: `examples/api-cliente/handler.mjs` (+ `examples/api-cliente/README.md`)
- Modify: `infra/sst/runtime.ts` (env nuevas del contenedor + permiso InvokeGateway en el RuntimeRole; leer el archivo real — el nombre puede diferir)
- Modify: `sst-env.d.ts` (a mano, el deploy lo regenera)

**Interfaces:**
- Produces: env `GATEWAY_URL` y `CLIENT_API_URL` en el Runtime (contrato de arriba); la demo API con `/catalogo` y `/pedidos`.
- Consumes: nada de otras tareas.

**Diseño cerrado:**
- `examples/api-cliente/handler.mjs`: Lambda nodejs pelada (sin framework) que implementa el contrato de arriba. Es una PIEZA DE EJEMPLO (juega el rol de "API del cliente"): README lo dice y aclara que en un cliente real esta API ya existe y no la deployamos nosotros.
- `infra/sst/api-cliente.ts`: `sst.aws.Function("ApiClienteDemo", { handler: "examples/api-cliente/handler.mjs", url: true, runtime: "nodejs24.x", timeout: "10 seconds" })`.
- `infra/sst/gateway.ts`:
  - `GatewayRole`: rol IAM con trust `bedrock-agentcore.amazonaws.com` (mirar cómo runtime.ts hizo el RuntimeRole y seguir el patrón).
  - `new awsnative.bedrockagentcore.Gateway("Gateway", { name: ..., authorizerType: "AWS_IAM", protocolType: "MCP", roleArn: GatewayRole.arn })` — los nombres exactos de props salen de `.sst/platform/node_modules/@pulumi/aws-native/bedrockagentcore/gateway.d.ts` (LEERLO antes de escribir; el spike confirmó que existe).
  - `GatewayTarget` con `targetConfiguration.mcp.openApiSchema.inlinePayload` = OpenAPI 3 de la demo API (solo `GET /catalogo`, operationId `listar_catalogo`, con el `servers:[{url: apiClienteDemo.url}]`), `credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }]`. `/pedidos` NO va al gateway (regla dura del spec: nada per-usuario por el gateway).
  - Ojo Cloud Control: si `GatewayTarget` exige `gatewayIdentifier` createOnly, tomar el id del Gateway (`gateway.gatewayIdentifier` o el atributo que el .d.ts exponga).
- `runtime.ts`: env `GATEWAY_URL` (el endpoint MCP del gateway — el atributo del recurso; si el .d.ts expone `gatewayUrl`, usarlo) y `CLIENT_API_URL` (url de ApiClienteDemo); política nueva en RuntimeRole: `bedrock-agentcore:InvokeGateway` scoped al ARN del gateway (+ `/target/*` si el describe-type lo pide — verificar contra el schema, patrón conocido del runtime-endpoint/* de 2a).
- Si Cloud Control rechaza algo que el .d.ts sugiere, NO improvisar variantes a ciegas: `NEEDS_CONTEXT` con el error exacto.

- [ ] **Step 1:** Leer `gateway.d.ts`/`gatewayTarget.d.ts` del SDK local y `infra/sst/runtime.ts` real. Escribir `api-cliente` handler + test manual local (`node --test` no hace falta: probarlo con `node -e` requests al handler no aplica — es Lambda; alcanza typecheck + el smoke de T5. El contrato queda pineado por el mock de T4 y el smoke).
- [ ] **Step 2:** Escribir `gateway.ts`, `api-cliente.ts`, tocar `runtime.ts`, `sst-env.d.ts`.
- [ ] **Step 3:** `npm run typecheck:infra` verde. Pegar salida.
- [ ] **Step 4: Commit** `feat(infra): AgentCore Gateway (AWS_IAM) + API del cliente demo (2d)`

### Task 3: El viaje del actToken (bff + worker)

**Files:**
- Modify: `packages/bff/src/mensajes/api.ts` (postMensaje encola con actToken)
- Modify: `packages/bff/src/chat/lambda.ts` (pasa el token crudo al handler si hace falta — leer cómo fluye hoy el principal)
- Modify: `packages/worker/src/lambda.ts` + `packages/worker/src/turno.ts` (passthrough al invoke)
- Modify: `infra/CONTRACT.md` (payload del runtime + campo del mensaje SQS)
- Test: los test files existentes de api y turno

**Interfaces:**
- Consumes: `Principal.actToken` (ya existe en `verify.ts`, claim `act_token`).
- Produces: mensaje SQS con `actToken?`; payload invoke `{message, userId, sessionId, actToken?}` (contrato de arriba).

**Diseño cerrado:**
- Regla del actToken (spec §6, caso común): `actToken = principal.actToken ?? tokenCrudo` — si el emisor no manda claim `act_token`, viaja el mismo token que el usuario presentó (su API ya lo consume). El token crudo está en el header del request; hoy `postMensaje` recibe el principal ya verificado — LEER la cadena real (lambda.ts → api.ts) y pasar el crudo por el camino que menos firmas rompa.
- El `actToken` va SOLO en `encolar(...)` (body SQS). PROHIBIDO en `store.escribir` — agregar un test que lo pinee: el mensaje escrito en Dynamo no contiene actToken.
- Worker: el body del mensaje SQS ya se parsea en `lambda.ts`; `turno.ts` (`procesarMensaje`) agrega el campo al llamar `invocar`. Un mensaje SIN actToken (cola vieja, canal futuro) sigue funcionando (campo opcional).
- Si el turno agrupa varios mensajes pendientes (debounce), vale el `actToken` del mensaje del job que se procesa (el último — es el más fresco). Documentarlo en un comentario.

- [ ] **Step 1: Tests en rojo:** (a) postMensaje encola body con `actToken` = claim si existe; (b) = token crudo si no hay claim; (c) el item escrito en MessagesTable NO tiene actToken; (d) worker: `invocar` recibe el actToken del evento; (e) evento sin actToken → invoke sin el campo, sin romper.
- [ ] **Step 2: Ver fallar.** `npx vitest run --root packages/bff` y `--root packages/worker`. Pegar salida.
- [ ] **Step 3: Implementar.** Verde.
- [ ] **Step 4: CONTRACT.md** (payload + campo SQS + la regla "nunca en Dynamo, nunca en logs").
- [ ] **Step 5: Suite + typecheck.** Pegar salida.
- [ ] **Step 6: Commit** `feat(bff,worker): el actToken viaja por la cola hasta el runtime (2d, opción A)`

### Task 4: Tools en el modo local del demo

**Files:**
- Modify: `examples/demo-client/mock.mjs` y/o `server.mjs` (donde viva `planificarRespuesta` — leerlo)
- Modify: `examples/demo-client/public/index.html` (chips nuevos del hint)
- Modify: `examples/demo-client/README.md`
- Test: `examples/demo-client/mock.test.mjs`

**Interfaces:** consume el contrato de la demo API (datos fijos de arriba) para que el mock y la realidad cuenten la misma historia.

**Diseño cerrado:** dos keywords nuevas en el mock (regla del modo local):
- `pedido` → responde como si el agente hubiera usado `mis_pedidos`: "Consulté tus pedidos: A-1001 está en camino (llega mañana) y A-0997 ya fue entregado." — pasa por el debounce normal (es un turno del agente, no un corte).
- `catalogo` (aceptar también `catálogo`) → ídem con `listar_catalogo`: "Tenemos 3 productos: Casco MTB ($45.000), Luz trasera USB ($12.000) y Kit de parches ($3.500)."
- Chips nuevos en `MOCK_HINT_HTML`. README: sección corta "Tools en modo local" + nota de que en modo real las tools las ejecuta el agente en AWS (Gateway + API demo).

- [ ] **Step 1: Tests en rojo** (2 casos en mock.test.mjs, patrón existente: POST + poll y asertar el texto).
- [ ] **Step 2: Ver fallar. Step 3: Implementar. Step 4: Suite completa del demo verde** (los 27+ existentes intactos). Pegar salidas.
- [ ] **Step 5: Commit** `feat(demo): escenarios de tools (pedido/catalogo) en el mock (2d)`

### Task 5: Deploy + smoke (controlador + humano)

- [ ] Merges seriales de T1-T4 + suite completa + review final de fase (agente revisor, foco: el actToken no toca Dynamo/logs; costuras T1↔T3 payload y T1↔T2 env; loop de tools acotado).
- [ ] Deploy a staging (CI, o local si Actions sigue caído).
- [ ] Smoke: (1) "¿qué productos tienen?" → el agente usa el gateway (verificar en logs del runtime la llamada MCP) y responde con el catálogo real; (2) "¿dónde está mi pedido?" con login Cognito → usa `mis_pedidos` con el ID token como Bearer contra la demo API; (3) sin tools configuradas (stage viejo o env vacía) el chat sigue respondiendo normal; (4) el item de MessagesTable del turno no contiene actToken (scan del item); (5) latencias con tools a `docs/mediciones.md`.
- [ ] Actualizar artifact (tools → HOY), memoria, ledger a `docs/superpowers/ledgers/`.

## Self-review

- Cobertura spec §7: tenant vía Gateway (T2) con credencial POR TARGET (corrección del spike aplicada), usuario vía HTTP con actToken (T1+T3), regla dura respetada (/pedidos nunca en el gateway). §18-2d: opción A implementada en T3. Regla local-mock: T1 (FAKE_LLM con tool call) + T4 (keywords). ✓
- Placeholders: los pasos de infra citan los .d.ts a leer en vez de inventar props — es deliberado (los nombres exactos los tiene el SDK local; el spike verificó que existen las clases y los shapes del registry). Todo lo demás tiene código o contrato concreto. ✓
- Tipos consistentes: `actToken` con esa grafía en SQS/payload/core (`payload.get("actToken")`); nombres de tools `mis_pedidos`/`listar_catalogo` idénticos en T1, T2 (OpenAPI operationId) y T4 (textos). `aresponder_con_tools` solo vive en T1. ✓
