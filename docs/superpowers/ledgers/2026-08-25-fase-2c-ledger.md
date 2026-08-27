# SDD ledger — plan: docs/superpowers/plans/2026-08-25-fase-2c-mensajeria-asincrona.md

Spec v2 §8. Repo: rama fase-2a, BASE 3ca42b9. Regla nueva: ejecución por OLAS paralelas con worktrees.

## Pre-flight scan

| Par | Hallazgo |
|---|---|
| T1↔T2↔T6↔T7 (ola 1) | Archivos DISJUNTOS verificados: shared+infra / bff/src/mensajes/store / widget / demo-client. Ninguna instala deps npm (lockfile intacto). T6/T7 construyen contra el contrato del plan (POST {msgId,conversationId,orden}, GET {mensajes}) — riesgo aceptado: si T3 se desvía del contrato, T6/T7 se ajustan en fix round |
| T3 → T1,T2 | Consume linkables (sst-env de T1) + store (T2). Serial, ola 2 |
| T4 → T5 | Zona compartida bff/chat + lockfile (sqs dep en T4, workspace nuevo en T5). Serial, ola 3, con la nota de mudanza de ndjson ya en el plan |
| T1 y T5 | Ambas tocan sst-env.d.ts y CONTRACT.md — olas distintas ✓ |
| T6 | apiUrl reemplaza chatUrl → T7 actualiza el index.html del demo en su propia tarea (archivos disjuntos ✓) |

Ruling: paralelismo con worktrees por instrucción del usuario (prima sobre la regla serial del skill); conflictos prevenidos por olas de archivos disjuntos; merges seriales del controlador tras review limpia; suite completa tras cada merge. Costo si está mal: un merge conflict manual.

## Progreso

Ola 1: dispatch T1, T2, T6, T7 en paralelo (worktrees wt/t1, wt/t2, wt/t6, wt/t7; BASE 3ca42b9)
Ola 1 — T2: implementer DONE_WITH_CONCERNS (b5d2d32 en wt/t2; 12 tests nuevos, 51/51 bff; hallazgos: ejemplo contradictorio del brief resuelto por el autoconsistente + #orden por palabra reservada). Dispatch review (sonnet)
Ola 1 — T1: implementer DONE (2841d75 en wt/t1; gate Queue verificado, desvío: nombre físico por autoname, mapeado en CONTRACT). Dispatch reviews T1+T2 en paralelo
Ola 1 — T6: implementer DONE_WITH_CONCERNS (1d5b1d0 en wt/t6; 15/15, build OK; 5 decisiones de contrato declaradas, retiró agent_unavailable como código muerto). Dispatch review
T2: review Approved con 1 Important (sin Limit/paginación en las queries descendentes — riesgo real aunque acotado por LIMITE_POR_SESION=40) + minors (RED débil por módulo nuevo — aceptado; comentario del alias #orden técnicamente incorrecto: la reservada es ORDER en inglés, orden no colisionaba — el alias queda como defensa, el comentario se corrige)
Ruling: fix round — Limit 100 en pendientesDesdeUltimaRespuesta y ultimoMsgIdUsuario (una línea c/u; el corte de 1MB queda inalcanzable) + corrección del comentario del alias (plegado: mismo archivo, evita difundir una justificación falsa). Costo si está mal: nada.
Ola 1 — T7: implementer DONE (b83dc4b en wt/t7; contrato POST/GET + worker fake, debounce visible, crearServer() exportable). Dispatch review
T6: review Approved con 2 Importants (sends concurrentes → respuesta agregada renderizada 2 veces; GET 401 enmascarado como "todavía no") + 2 minors. La remoción de agent_unavailable verificada correcta contra el plan.
Ruling: ambos se fixean en T6 — (1) poller único por mount: sends durante un polling activo POSTean y agregan su burbuja de usuario pero NO abren segundo loop ni segunda burbuja de respuesta (la respuesta agregada resuelve una sola vez); (2) 401 del GET → renovar token UNA vez y seguir; segundo 401 → error inmediato sin esperar timeout (simetría con el POST). Minors diferidos: circuit-breaker de fallas duras consecutivas; costo wall-clock de tests con timers reales.
T2: fix round 1/5 aplicado (9c5af18: Limit 100 + comentario del alias corregido, RED->GREEN); dispatch re-review (haiku)
T1: review Needs fixes — 1 CRITICAL cazado ANTES del deploy: colisión de nombre SST Queue↔Linkable "MensajesCola" (misma clase que el fix de deploy de 2b; venía del pseudocódigo de MI brief; el reviewer trazó link.ts de la plataforma). + 2 minors plegables (fila DLQ en CONTRACT, comentario del sufijo Db).
Ruling: fix round — componente renombrado a MensajesColaQueue (Linkable conserva la clave Resource.MensajesCola); minors plegados (mismos archivos). Plan corregido en origen. La mejora del proceso quedó demostrada: en 2b este bug costó un ciclo de CI; acá lo pagó una review.
T2: fix round 1/5 (2 addressed; b5d2d32..9c5af18) — listarMensajes sin Limit POR DISEÑO (el cursor pagina)
T2: complete + MERGEADA a fase-2a (merge --no-ff wt/t2); suite completa verde post-merge
T1: fix round 1/5 aplicado (7e9c3ef: MensajesColaQueue + minors plegados); dispatch re-review (haiku)
T1: fix round 1/5 (3 addressed; 2841d75..7e9c3ef) — clave Resource intacta, dlq por referencia de objeto
T1: complete + MERGEADA a fase-2a; typecheck:infra y suite verdes post-merge
== OLA 2: dispatch T3 (worktree wt/t3 desde fase-2a con T1+T2 adentro) ==
T6: fix round 1/5 aplicado (9f53ee6: poller único con mutex síncrono + renovación en GET 401); dispatch re-review (haiku)
T7: review Needs fixes — 1 Important (descarte del timer contra un Map que bloqueado no actualiza → respuesta espuria en el intercalado; el store real consulta el transcript dinámicamente) + 2 minors (aritmética del reporte 8+3+2≠14 — el preexistente era 9; test de debounce afirma conteos, no agregación textual)
Ruling: fix — el descarte pasa a derivar el último msgId del usuario ESCANEANDO el transcript (paridad real con ultimoMsgIdUsuario del store) + guarda pendientes.length===0 → no responder (cinturón). Test del intercalado normal→bloqueado que nace ROJO. Minor de agregación textual diferido (limitación del branch default de planificarRespuesta, no del server).
T6: fix round 1/5 (2 addressed; 1d5b1d0..9f53ee6) — mutex verificado en los 8 caminos de salida, retry del POST re-reclama limpio, el 429 del concurrente no toca el indicador del dueño
T6: complete + MERGEADA a fase-2a; suite verde post-merge
T7: fix round 1/5 aplicado (7803c23; RED solo lógico — la re-review lo verifica); dispatch re-review (haiku)
Ola 2 — T3: implementer DONE_WITH_CONCERNS (3b0fbbb; 11 tests, 62/62 bff; desvío: dep opcional registrarTurno por inconsistencia del brief). Dispatch review (sonnet)
T7: fix round 1/5 (1 addressed; b83dc4b..7803c23) — RED resuelto por trace del re-reviewer contra el código viejo (habría fallado con 2 assistants)
T7: complete + MERGEADA a fase-2a. == OLA 1 COMPLETA (4/4 mergeadas) ==
T3: review Needs fixes — 2 Importants (escrituras/encolado sin manejo de error → rechazo sin forma; empate de ts en bloqueado → posible inversión user/assistant en la transcripción) + 1 minor (registrarTurno sin test de camino positivo)
Ruling: (1) try/catch → 500 JSON {error:{code:"error_interno"}}; el "huérfano" NO necesita reintento: la agregación de pendientes del worker lo procesa con el próximo mensaje (auto-reparación del diseño — documentarla en comentario); (2) ts del assistant = ts del user + 1ms (estrictamente mayor) + test de orden lexicográfico; (3) minor plegado: test del camino positivo de registrarTurno y de que su rechazo no rompe la respuesta.
T3: fix round 1/5 aplicado (0bbc57f; 16/16 api, 67/67 bff); dispatch re-review (haiku)
T3: re-review — 3/3 ADDRESSED con residual de comentario en el catch de bloqueado
Ruling: el trace del residual revela una fuga estrecha real (política no escrita → el próximo turno agrega el texto bloqueado sin re-evaluar) ACEPTADA por la postura fail-open del §9 con el guardrail de salida como segunda red — se documenta en el código (ronda 2 mínima, solo comentario), no se "arregla" con complejidad extra. Costo si está mal: reevaluar en el worker (fase futura si el riesgo sube).
T3: round 2 (comentario del ruling; bd939bb) — complete + MERGEADA a fase-2a; suite verde
== OLA 3: dispatch T4 (worktree wt/t4) ==
T4: implementer DONE (0c61111; 54/54 bff, 87/87 workspace, greps limpios, runtime.ts alcanzable vía sst.config). Dispatch review (sonnet)
T4: review Approved, 0 Critical/Important, 3 minors diferidos (timeout 5min heredado del streaming — endurecer en el review final; chaining cosmético; 405 vs 404)
T4: complete + MERGEADA. Dispatch T5 (worktree wt/t5)
T5: implementer DONE (4ed1c44; 93 tests monorepo, worker 15; gate subscribe: por arn con permisos SQS a mano). Dispatch review (sonnet)
T5: review Needs fixes — 1 CRITICAL (visibilityTimeout default 30s < timeout del worker 3min → re-entrega y doble respuesta silenciosa bajo latencia normal; cazado por review, otra vez antes del deploy) + 3 minors
Ruling: visibilityTimeout: "6 minutes" (2x el timeout del worker — no el 6x literal de AWS: el handler nunca lanza, la redelivery solo ocurre en crash duro, y 18min bloquearían el grupo FIFO demasiado). Fix en mensajeria.ts dentro del worktree de T5 (el archivo no cambió en fase-2a desde el branch → merge limpio). Minor plegado: test del stream-sin-done. Otros minors diferidos (garantía jamás-lanza implícita vía fail-open del store — verificada; dep cross-package sin declarar). Plan corregido en origen.
T5: fix round 1/5 aplicado (f7a94f0); dispatch re-review (haiku)
T5: fix round 1/5 (2 addressed; 4ed1c44..f7a94f0) — complete + MERGEADA
== T8 (docs, última tarea): dispatch (haiku, worktree wt/t8) ==
T8: implementer DONE (11f73f2, docs-only); dispatch review (haiku)
T8: review Approved (spot-checks contra el código reales) — complete + MERGEADA
== LAS 8 TAREAS COMPLETAS. Worktrees removidos. Review final de fase (fable) ==
Review final (fable, 3ca42b9..c5ad145): With fixes — 1 CRITICAL entre tareas paralelas (C1: resource.ts lee Resource.AgentRuntime que T4 des-linkeó → outage total del POST/GET en el primer deploy; cada mitad era correcta por separado — LA costura del paralelismo), 3 Importants (I1 guarda de pendientes vacíos; I2 fail-open del debounce que silencia; I3 timeout 5min heredado), 5 minors. La costura widget↔API cerró byte a byte (construidas a ciegas en paralelo). Triage del ledger completo; el ruling del bloqueado no re-litigado.
Ruling: fix wave única (C1+I1+I2+I3+M1-M5); semántica "la política absorbe el mensaje normal en el intercalado" va al smoke para validación de PRODUCTO con el humano. Lección de proceso anotada para futuras olas: los archivos de config compartidos (resource.ts↔infra) son costura de paralelismo — sumarlos a la lista de hotspots de la regla de memoria.
Fix wave: DONE (8c0ef92 C1, a449f9d I1+I2, 39f52c0 I3+minors; 99 JS/TS + 19 core); dispatch re-review scoped (sonnet)
Fix wave: re-review — C1+I1+I2+I3+M1-M5 todos ADDRESSED; interaction checks confirmados; 1 observación cosmética (el comentario del pin de tipo sobrestima vitest run — la red real es tsc, que está en CI). Sin nueva ronda.
== FASE 2C COMPLETA: 8 tareas en 3 olas paralelas + fix wave. Falta Task 9 (smoke real, controlador+humano + decisión de producto del intercalado). ==
