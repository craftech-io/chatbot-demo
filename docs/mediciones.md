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

Números reales los midió el smoke del deploy que cierre la fase 2c.
