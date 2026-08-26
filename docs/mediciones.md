# Mediciones

El spec marca el cold start del contenedor como riesgo 2. Estas mediciones son las
que lo cierran o lo escalan.

| Fecha | Qué | Valor |
|---|---|---|
| 2026-08-19 | tamaño de la imagen (`docker images craftech-ai-chat-core:dev`) | 471MB (470733004 bytes) |
| 2026-08-19 | import de `agent.workflow` + `agent.llm` en el contenedor | ~28s (dos corridas: 27.86s y 28.49s), bajo emulación QEMU ARM64 sobre host amd64 |

Nota: los ~28s son bajo QEMU en amd64 y sirven como cota superior — en ARM real
(CI y AWS) el arranque es mucho menor.

Nota: los 471MB del 2026-08-19 se midieron con la imagen base `python:3.12-slim`,
que además de no coincidir con el `>=3.13` de `pyproject.toml` forzaba a `uv
sync` a bajar un segundo Python 3.13 managed en build — dos runtimes en la
misma imagen. Al fijar la base en `python:3.13-slim` (ver `core/Dockerfile`) se
espera un tamaño menor; no remedido todavía porque el rebuild es lento bajo
QEMU (lo cubre el smoke del próximo deploy).

## Primer deploy real (staging, cuenta 776805327629, 2026-08-21)

| Qué | Valor |
|---|---|
| Respuesta con microVM caliente (mismo hilo) | ~3,3 s total (incluye el modelo) |
| Respuesta con sesión nueva (microVM fría) | ~3,3 s total — el cold start real en ARM es despreciable |
| Boot de la imagen en runner x86 bajo QEMU | ~60 s hasta /ping (cota superior, no representativa) |

El riesgo de cold start del spec (§19.2) queda cerrado: era un artefacto de QEMU.

## Smoke de la fase 2b (staging, 2026-08-24)

| Qué | Resultado |
|---|---|
| Memoria: 3 turnos, pregunta por el 1º | ✓ "Verde esmeralda" — orden cronológico, includePayloads y acciones IAM del data plane confirmados |
| Guardrail de entrada (prompt attack) | ✓ done canónico del registro, sin invoke al Runtime |
| Guardrail de salida armado | ✓ los turnos streamean (ApplyGuardrail scoped al guardrailArn funciona) |
| LimitsTable | ✓ count=4 con TTL — el mensaje bloqueado consumió cupo (semántica deliberada del diseño) |
| SessionsTable | ✓ turnos=3, título = primer mensaje; el turno bloqueado NO se indexó (correcto: nunca hubo invoke) |
| Errores de fail-open en logs | 0 — los permisos Dynamo del fix C1 funcionan de verdad |

El 429 forzado no se ejerció en vivo (requeriría ~37 mensajes más); los contadores
probados vivos + la lógica pineada por unit tests se consideran evidencia suficiente.

## Latencia percibida en fase 2c (mensajería asíncrona)

Desde la fase 2c el flujo es asíncrono (spec §8 v2): el usuario no ve streaming
palabra por palabra, sino una respuesta entera cuando está lista. La latencia
percibida es la suma de:

- **Debounce de cola:** 6 segundos (configurable en `infra/sst/mensajeria.ts`,
  `MensajesColaQueue.delay`) — ventana de agregación de mensajes que llegan
  seguidos (si mandás dos mensajes en menos de 6s, se agrupan y se responde
  una sola vez).
- **Turno del agente:** el invoke al AgentCore Runtime y procesamiento de su
  respuesta (típicamente 3-4s en staging con microVM caliente, ver smoke 2b
  arriba).
- **Intervalo de polling:** 1,5 segundos aprox (configurable en el widget,
  `packages/widget/src/index.ts`, `POLL_MS_DEFECTO`) — cadencia con que
  el navegador pregunta si la respuesta ya está lista.

## Smoke de la fase 2c (staging, 2026-08-25)

Primer deploy de la arquitectura v2 (asíncrona). El deploy salió verde a la
primera — cero fixes de infraestructura.

| Qué | Resultado |
|---|---|
| GET /mensajes con token válido | ✓ 200 — el fix C1 (runtimeArn fuera de BffConfig) funciona en producción |
| Turno simple end-to-end (POST → cola → worker → Runtime → polling) | ✓ 8 s totales (incluye los 6 s de debounce) |
| Debounce en vivo: 2 POSTs con 2 s de separación | ✓ UNA sola respuesta que cubre ambos mensajes; logs del worker: 1 `descartado` + 1 `procesado`; una sola invocación al Runtime |
| Memoria: recall del nombre en un turno posterior | ✓ "Te llamás Lautaro" — 13 s end-to-end |
| Guardrail de entrada (prompt attack) vía polling | ✓ respuesta canónica visible en el primer poll (~3 s), sin encolar |
| CORS preflight (OPTIONS) real | ✓ 200 con Allow-Origin/Headers/Methods |
| DLQ | ✓ vacía (0 mensajes) tras todos los turnos |
| Permiso `runtime-endpoint/*` del worker | ✓ implícito — todas las invocaciones al Runtime salieron sin AccessDenied |

Con la ventana de debounce de 6 s, la latencia percibida real quedó en 8-13 s
por turno — dentro del rango estimado. Si para el widget web se quisiera
bajar, el knob es `MensajesColaQueue.delay` en `infra/sst/mensajeria.ts` (el
trade-off es agrupar menos los mensajes que llegan seguidos).

No ejercido en vivo: la falla forzada del worker (requeriría deployar
configuración rota a staging). La rama está pineada por unit tests — el worker
nunca lanza: escribe `MENSAJES_WORKER.error` como mensaje del assistant y el
grupo FIFO sigue fluyendo. La DLQ vacía tras el smoke es consistente.

## Smoke de la fase 2d (staging, 2026-08-26) — tools

| Qué | Resultado |
|---|---|
| Tool de usuario ("¿dónde está mi pedido?") con login Cognito | ✓ 31 s — el agente llamó la API del cliente con el `actToken` del usuario y devolvió los pedidos reales (A-1001 en camino, A-0997 entregado) |
| Tool de tenant ("¿qué productos tienen?") por AgentCore Gateway (MCP + SigV4) | ✓ 31 s — catálogo real de la demo API vía `api-cliente___listar_catalogo` |
| Las dos tools en un mismo turno | ✓ 33 s — el loop de function calling encadena ambas y responde una sola vez |
| Turno simple sin tools (control de regresión) | ✓ 27 s |
| `actToken` en MessagesTable | ✓ ausente — 31 items escaneados, ni la clave ni ningún JWT (`eyJ`) |
| `actToken` en logs (worker + runtime) | ✓ 0 ocurrencias de `eyJ` |
| Errores de listado del gateway tras el fix | ✓ 0 |
| DLQ | ✓ vacía |

**Latencias:** el turno con tools ronda los 31-33 s contra los 8-13 s de un
turno simple en 2c. La diferencia NO es el gateway: es que `achat_with_tools`
no streamea y el loop hace 2 llamadas al modelo (una para decidir la tool, otra
para redactar con el resultado), más la llamada HTTP intermedia. El turno de
control también subió a 27 s porque con `CLIENT_API_URL` seteada TODO turno
pasa por el camino con tools (observación M6 del review): si en el futuro
molesta, el corte es decidir por heurística o por un primer paso barato si
conviene ofrecer tools a ese mensaje.

**Bug de librería encontrado acá** (ver ledger 2d): `llama-index-tools-mcp`
0.5.0 es incompatible con `mcp` 2.x (desempaca 3 valores del transporte
streamable-http, que yieldea 2). Se reemplazó por el cliente MCP oficial. La
lección de proceso: el spike verificó que las versiones *resolvían*, no que
*funcionaran* — un `tools/list` real contra un servidor lo hubiera cazado antes
del deploy.
