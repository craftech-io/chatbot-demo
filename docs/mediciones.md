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
