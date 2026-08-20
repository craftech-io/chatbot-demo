# SDD ledger — plan: docs/superpowers/plans/2026-08-19-fase-2a-esqueleto-vertical.md

Spec: docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md (legible, autoridad vinculante)
Repo: /home/lautaro/Craftech/craftech-ai-chat · rama `fase-2a` · base aaba1c1

## Pre-flight scan

### Pares de tareas que comparten archivo o interfaz

| Par | Produce → consume | Hallazgo |
|---|---|---|
| T1 → T4 | `pyproject.toml` (`pythonpath = ["core/src"]`) → `core/tests/test_server.py` hace `from server import build_app` | **CONFLICTO**: `core/` no está en pythonpath; el test de T4 no puede importar `server` |
| T4 → T5 | `core/server.py` → T5 lo modifica (agrega `_EchoLLM` + rama `FAKE_LLM`) | OK, T5 lo declara en Files:Modify con el antes/después exacto |
| T1 → T3,T4 | `agent.events` / `ChatWorkflow` | OK, firmas coinciden |
| T2 → T3,T4 | `Config` / `load_config` | OK |
| T3 → T4 | `BedrockAdapter(cfg, client_factory)` llamado como `llm_factory(cfg)` | OK |
| T6 → T8 | `verifyUserToken`, `AuthError`, `Principal`, `Verifier` | OK |
| T7 → T8 | `parseNdjson`, `toSse` | OK |
| T8 → T9 | contrato SSE: `data: {json}\n\n`, codes `expired_token` / `agent_unavailable` | OK, el widget parsea y ramifica por esos mismos codes |
| T8 → T10 | `Resource.ClientAuth.{jwksUrl,hmacSecret}` ← Linkable de T10 | OK, las dos props existen en ambos lados |
| T8 → T10 | `packages/bff/tsconfig.json`: T8 agrega `exclude` de resource.ts, T10 lo quita | OK, T10 lo declara en Files:Modify |
| T6 → T11 | `package.json` raíz: workspaces `["packages/*"]` → `["packages/*","examples/*"]` | OK, T11 lo declara |
| T9 → T11 | bundle IIFE global `CraftechChat.mount` | OK, vite `name: "CraftechChat"` |
| T10 → T11 | Function URL + `ClientHmacSecret` → `CHAT_URL` + `CHAT_HMAC_SECRET` | OK |

### Auto-consistencia por tarea

| Tarea | Sus tests vs su código / sus archivos | Hallazgo |
|---|---|---|
| T1 | test importa `agent.events`+`agent.workflow`; pythonpath los cubre | OK |
| T2 | 3 tests contra `load_config` | OK |
| T3 | `FakeConverse` deltas → `["Hola"," mundo"]`; `adapter.client.recibido` existe | OK |
| T4 | `from server import build_app` | ver CONFLICTO T1→T4 |
| T5 | modifica server.py por línea exacta; crea `docs/mediciones.md` antes del `git add` | OK |
| T6 | 5 tests; tsconfig incluye `src` | OK |
| T7 | 6 tests, incluido el de línea partida | OK |
| T8 | resource.ts necesita `sst-env.d.ts` (recién en T10) | OK, mitigado por el `exclude` |
| T9 | 6 tests con happy-dom; `crypto.randomUUID` disponible | OK |
| T10 | el CI corre `npm test` (workspaces TS) pero **no** corre pytest | **GAP menor**: los tests del core no se ejecutan en CI |
| T11 | vitest descubre `*.test.mjs` por default | OK |

## Rulings (pre-flight)

Ruling: el repo, la rama `fase-2a` y el commit inicial de docs los creó el setup del controlador, no la Task 1 — el skill exige workspace aislado y no arrancar en main. La Task 1 omite `mkdir craftech-ai-chat`, `git init` y el `.gitignore` (ya existe, y ya incluye `*.local` y `.superpowers/`). Costo si está mal: nulo; el trabajo de T1 es idéntico salvo esos tres comandos.
Ruling: `pyproject.toml` lleva `pythonpath = ["core/src", "core"]`, no solo `["core/src"]` — sin `core` en el path, el test de T4 no puede importar `server`. Corrige un defecto del plan detectado en el scan. Costo si está mal: ninguno funcional; solo agrega un directorio al path de pytest.
Ruling: en T10 el workflow de CI corre además `uv run pytest core/tests/ -v` antes del deploy. El plan dejaba los tests del core fuera del CI, lo que haría que un deploy pase con el core roto. Costo si está mal: el CI tarda un poco más.

## Progreso

Task 1: dispatch (implementer sonnet, BASE aaba1c1) — brief task-1-brief.md
Task 1: NEEDS_CONTEXT — `await handler` devuelve el ChatDone, no su `.result` (WorkflowHandler._await_result desenvuelve solo si `type(ev) is StopEvent`; verificado 0.2.0→2.23.2)
Ruling: se mantiene el tipo `ChatDone` y los consumidores escriben `(await handler).result` — descarto la alternativa de devolver `StopEvent` plano. El contrato de eventos tipados ES la razón de que el harness sea un Workflow y no un loop opaco; borrar el tipo para complacer un azúcar del framework invierte la prioridad, y la fase 2d agrega citas de RAG al evento final, lo que obligaría a reintroducirlo. Plan y briefs 1 y 4 corregidos en origen, con comentario en ambos lugares para que nadie lea `await handler` esperando un string. Costo si está mal: cada consumidor del evento final escribe `.result` — hoy son dos lugares (test de T1 y server de T4).
Task 1: implementer DONE (commit 45d2425, 1/1 test, llama-index-workflows==2.23.2 fijada) — reporta un UserWarning de pydantic (ChatDone redeclara StopEvent.result) no silenciado
Task 1: dispatch task-review (sonnet, aaba1c1..45d2425)
Ruling: la copia canónica del plan y del spec es la del repo craftech-ai-chat (versionada en git). La de /home/lautaro/Craftech/aersa/docs/ queda como copia de lectura y puede quedar desactualizada; hoy están sincronizadas. Costo si está mal: alguien lee la copia vieja en aersa — mitigable con un puntero al repo.
Task 1: review spec ✅ / quality Approved, 1 Important plan-mandated (UserWarning de pydantic: ChatDone.result sombrea StopEvent.result) + 2 minors
Ruling: rechazo las dos salidas que propuso el reviewer (filterwarnings, o aceptarlo como deuda) y elimino la causa raíz: el campo de ChatDone pasa a llamarse `texto`. El reviewer aportó el dato decisivo — en versiones anteriores esa misma colisión dejaba `result` como un `property object` en silencio, así que no es ruido de test sino una trampa latente; silenciar el warning esconde exactamente la señal que la delata. Renombrar mantiene el tipo `ChatDone` (mi ruling previo sigue en pie), da tipado estricto, no depende del comportamiento interno de StopEvent, y usa español como el resto del core. Corregido en origen: plan (dos copias) y briefs 1 y 4. Costo si está mal: los consumidores escriben `.texto`; son dos lugares (test de T1, server de T4).
Task 1: minor (deferred): `pyproject.toml` usa `>=` (salida literal de `uv add`) donde el constraint pide versiones exactas; el lockfile commiteado ya da reproducibilidad. Evaluar `uv add --bounds exact` en el review final.
Task 1: minor (deferred): `ChatWorkflow.__init__` recibe `llm` sin Protocol anotado; corresponde cuando T3 introduzca el adaptador real.
Task 1: fix round 1/5 — implementer aplicó el rename (commit f81e9a7, 1/1 test, sin sección de warnings); dispatch re-review scoped (haiku, 45d2425..f81e9a7)
Task 1: fix round 1/5 (1 addressed, 0 open; commits 45d2425..f81e9a7) — rename verificado completo en los 3 sitios, sin breakage
Task 1: complete (commits aaba1c1..f81e9a7, review clean)
Task 2: dispatch (implementer haiku, BASE f81e9a7) — transcripción, el brief trae el código completo
Task 2: implementer DONE (commit 56333ec, 3/3 tests) — mencionó un "PytestConfigWarning pre-existente" que el controlador NO reprodujo (suite completa: 4 passed, sin warnings); se le pidió al reviewer chequear qué muestra el reporte
Task 2: dispatch task-review (haiku, f81e9a7..56333ec)
Task 2: review spec ✅ / Approved, 0 Important, 3 minors
Task 2: minor (deferred): config.py usa `Optional[str]` donde el brief pide `str | None`. Ruling: el target del proyecto es Python 3.12 (Dockerfile python:3.12-slim), así que la razón del implementer (compat 3.9) no aplica — normalizar a `str | None` en el review final. Sin efecto en runtime.
Task 2: minor (deferred): el reporte muestra `1 warning` sin identificar; el controlador corrió la suite completa post-commit y no se reproduce (4 passed, sin warnings). Se considera transitorio; re-chequear en el review final.
Task 2: minor (deferred): falta test del caso `MODEL_ID=""` (el código lo maneja bien vía `if not model_id`); coverage-gap menor.
Task 2: complete (commits f81e9a7..56333ec, review clean)
Task 3: dispatch (implementer sonnet, BASE 56333ec) — integra librería externa con bugs conocidos de streaming
Task 3: NEEDS_CONTEXT — el parámetro `guardrail_stream_mode` del plan no existe en NINGUNA versión publicada de BedrockConverse (0.4.2–0.14.18); el real desde 0.12.0 es `guardrail_stream_processing_mode` (TypeError confirmado). Versión instalada: llama-index-llms-bedrock-converse==0.14.18.
Ruling: renombrar al nombre real `guardrail_stream_processing_mode` con valor "sync" en todo origen — plan (2 copias, 4 menciones c/u), spec (sección 9, 2 copias) y brief 3 regenerado. El valor "sync" se mantiene: es el streamProcessingMode síncrono de la API ConverseStream de Bedrock, que evalúa cada chunk antes de emitirlo — la semántica que exige el diseño. Costo si está mal: solo el nombre del kwarg; el TypeError en el constructor lo delataría de inmediato.
Task 3: implementer DONE (commit df6a325, 7/7 tests, bedrock-converse==0.14.18); dispatch task-review (sonnet, 56333ec..df6a325)
Task 3: review spec ✅ / Approved con 1 Important (sin test del camino no-guardrail: constraint explícita sin pin; un refactor podría regresionarla en verde) + 3 minors
Task 3: minor (deferred): el comentario del test de timeout promete más de lo que prueba (el doble siempre cierra; no cubre el bug real de streams que no terminan — eso es integración)
Task 3: minor (deferred): filtro de deltas vacíos implementado pero sin test (ningún fixture trae delta="" o None)
Task 3: minor (deferred): FakeConverse.kwargs es atributo mutable de clase sin reset entre tests (heredado del brief, smell de aislamiento latente)
Task 3: fix round 1/5 — test-pin agregado (348b207, 8/8); dispatch re-review scoped (haiku, df6a325..348b207)
Task 3: fix round 1/5 (1 addressed, 0 open; commits df6a325..348b207) — pin verificado, autocontenido, sin breakage
Task 3: complete (commits 56333ec..348b207, review clean)
Task 4: dispatch (implementer sonnet, BASE 348b207) — integra workflow+config+llm en el server ASGI
Task 4: NEEDS_CONTEXT — (1) el test nunca setea MODEL_ID y el server llama load_config(os.environ) por request → 1 test rojo; (2) starlette==1.6.0 depreca httpx clásico en TestClient (warning en salida). El riesgo anticipado (deadlock TestClient/StreamingResponse) NO se materializó.
Ruling: build_app pasa a build_app(llm_factory=None, env=None) y carga la config AL CONSTRUIR la app, no por request — el plan contradecía la razón de ser de config.py ("es preferible no arrancar"); además se elimina `app = build_app()` a nivel módulo (bug latente: el import en tests dispararía load_config) y el __main__ hace uvicorn.run(build_app(), ...). El test inyecta env={"MODEL_ID": "fake"}. Sigue el mismo patrón que load_config(env) eligió en T2 por testeabilidad. Costo si está mal: firma con un parámetro más; el contrato del contenedor no cambia.
Ruling: la dependencia dev pasa de httpx a httpx2 — la constraint de salida limpia manda sobre el literal del Step 1; el implementer verificó que con httpx2 el warning desaparece. Costo si está mal: cambiar un paquete dev.
Ruling: la rama FAKE_LLM de T5 lee `env.get("FAKE_LLM")` (el nuevo parámetro), no os.environ — mantiene una sola puerta de entrada del entorno a build_app. Plan corregido en origen (2 copias), briefs 4 y 5 regenerados.
Task 4: implementer DONE tras 3 rulings (commit 029cb2d, 11/11 limpio, starlette==1.6.0/uvicorn==0.52.4/httpx2==2.12.0); dispatch task-review (sonnet, 348b207..029cb2d)
Task 4: review spec ✅ / Approved con 1 Important (sin manejo de falla del workflow a mitad del stream: SSE truncado sin frame terminal) + 2 minors
Ruling: el Important entra al fix loop AHORA, contra la sugerencia del reviewer de solo trackearlo — el principio del spec ("nada tumba la conversación: cada falla se traduce") es vinculante, las fallas de streaming de un LLM son modo de falla normal y no caso borde, y T8/T9 ya manejan eventos {"type":"error"}. El contrato SSE de T4 gana el frame terminal {"type":"error","code":"agent_error"}; plan actualizado en Interfaces (2 copias). Costo si está mal: un try/except y un test de más en el esqueleto.
Task 4: minor (deferred): body no-JSON o no-dict produce 500 crudo en vez de 400 manejado (aceptable: payload confiable del BFF; endurecer a futuro)
Task 4: minor (deferred): ningún test asegura el content-type text/event-stream
Task 4: fix round 1/5 — frame de error terminal (060634a, 12/12, RED->GREEN); dispatch re-review scoped (haiku, 029cb2d..060634a)
Task 4: fix round 1/5 (1 addressed, 0 open; commits 029cb2d..060634a) — try/except no captura GeneratorExit (correcto), happy path intacto, sin breakage
Task 4: complete (commits 348b207..060634a, review clean)
Task 5: dispatch (implementer sonnet, BASE 060634a) — docker ARM64; instrucción: si falta binfmt NO correr contenedores privileged, reportar BLOCKED (decisión del humano)
Task 5: el usuario autorizó instalar binfmt (docker run --privileged tonistiigi/binfmt --install arm64); qemu-aarch64 verificado en /proc/sys/fs/binfmt_misc — el build ARM64 local es viable
Task 5: implementer DONE_WITH_CONCERNS (51f5fef; smoke OK/OK en 2ª corrida, 12/12, imagen 471MB, import ~28s bajo QEMU) — 2 concerns, ambos defectos del plan
Ruling: (1) el polling del smoke sube de 30×1s a 60×2s — bajo QEMU el arranque (~30s) quedaba al filo y el smoke flakeaba en frío; (2) el comando de medición del Step 5 pasa a `uv run --no-dev python -c` (el python pelado no ve el venv) — el implementer ya lo había hecho bien en la práctica. Además: la medición queda anotada como cota superior bajo QEMU, no como cold start productivo (en ARM real es mucho menor). Plan corregido (2 copias), brief 5 regenerado. Costo si está mal: un smoke más lento en el peor caso (+90s de presupuesto).
Task 5: implementer DONE tras ajustes (51f5fef+e5b99de; smoke OK/OK, 12/12, 471MB, ~28s QEMU); dispatch task-review (haiku, 060634a..e5b99de)
Task 5: review spec ✅ / Approved, 0 findings; ⚠️ (a) smoke OK/OK y (b) suite 12/12 con FAKE_LLM — (a) resuelto por evidencia del reporte (salida completa pegada, dos corridas) y (b) verificado por el controlador corriendo pytest post-commit
Task 5: complete (commits 060634a..e5b99de, review clean)
Task 6: dispatch (implementer haiku, BASE e5b99de) — transcripción: workspace npm + verify.ts, arranca la mitad TS
Task 6: implementer DONE (afe30b3, 5/5, jose 6.2.9 / ts 7.0.2 / vitest 4.1.11); dispatch task-review (sonnet, e5b99de..afe30b3)
Task 6: review spec ✅ estructural / Needs fixes — 5 Importants (4 plan-mandated en mi código de referencia + lockfile desincronizado) + 4 minors. Sin vulnerabilidad explotable (jose bloquea alg:none y la confusión RS256→HS256 por tipo de clave).
Ruling: los 4 plan-mandated se FIXEAN (frontera de confianza: el estándar es el más alto del sistema): (1) allowlist explícita de algoritmos por rama — HS256 para hmac; RS256/ES256/PS256/EdDSA para jwks; (2) `sub` exige typeof string no vacío; (3) el catch loguea errores no-jose antes de fallar cerrado (observabilidad: caída de JWKS ≠ token adulterado) manteniendo fail-closed; (4) se elimina el `as never` ramificando la llamada — cada tipo de clave con su allowlist. Plan corregido en origen (2 copias), brief 6 regenerado.
Ruling: el minor del `.name` vs `.code` se PLIEGA al fix 3 — el catch se reescribe entero de todos modos y dejar el `.name` frágil para cambiarlo de nuevo en el review final es churn; la detección pasa a `.code === "ERR_JWT_EXPIRED"` (estable ante minificación). Excepción deliberada a "minors nunca entran al loop", registrada acá.
Ruling: lockfile — regenerar con npm install y PROBAR `npm ci` en limpio; el lockfile quedó generado con el nombre default previo al rename de package.json.
Task 6: minor (deferred): cache JWKS unbounded — confirmar en el review final que ningún caller construye Verifier.url desde input del request
Task 6: minor (deferred): sin test del camino JWKS ni de algoritmo incorrecto (el brief mandaba solo los 5 HMAC); decidir extensión en el review final
Task 6: minor (deferred): line counts del reporte no coinciden con el diff (cosmético)
Task 6: fix round 1/5 — hardening + lockfile (4489d78, 6/6); dispatch re-review scoped (haiku, afe30b3..4489d78)
Task 6: fix round 1/5 (5 addressed, 0 open; commits afe30b3..4489d78) — allowlists, sub tipado, catch observable, sin as never, lockfile con npm ci verde
Task 6: complete (commits e5b99de..4489d78, review clean)
Task 7: dispatch (implementer haiku, BASE 4489d78) — transcripción: ndjson.ts con test de línea partida
Task 7: implementer DONE (bc0ea52, 12/12); dispatch task-review (haiku, 4489d78..bc0ea52)
Task 7: review spec ✅ / Approved, 0 Important, 2 minors
Task 7: minor (deferred): sin flush final del TextDecoder (`dec.decode()` sin args) — para NDJSON el caso degrada a evento de error, aceptable
Task 7: minor (deferred): CRLF manejado por trim pero sin test
Task 7: complete (commits 4489d78..bc0ea52, review clean)
Task 8: dispatch (implementer sonnet, BASE bc0ea52) — integración: handler + config adapters; el sessionId derivado del principal es la pieza de seguridad clave
Task 8: implementer DONE_WITH_CONCERNS (0530de2, 20/20, typecheck limpio) — el exclude del tsconfig no corta el grafo de imports (comportamiento documentado de TS); agregó @ts-nocheck documentado en resource.ts
Ruling: acepto el @ts-nocheck como puente HASTA la Task 10, que ahora debe eliminarlo además de quitar el exclude — quedar en nocheck permanente sería el mismo agujero que el `as never` de T6. Plan actualizado (2 copias), brief 10 regenerado. Costo si está mal: nada — T10 typechequea con sst instalado.
Task 8: dispatch task-review (sonnet, bc0ea52..0530de2)
Task 8: review spec ✅ / Approved con 1 Important plan-mandated (el generator de frames no captura errores DURANTE la iteración: microVM caída a mitad de respuesta → excepción sin frame terminal; mismo agujero en el lambda.ts de T10) + 3 minors
Ruling: se fixea ahora en T8 (try/catch en la iteración → frame {"type":"error","code":"agent_unavailable"}, con test de stream que muere a mitad) y el plan de T10 gana además: parse del body con try/catch (Function URL pública: body malformado no puede tirar la Lambda) y write-loop con try/finally que garantiza end(). Es el gemelo del fix de T4 en el core — el principio "nada tumba la conversación" aplica en cada capa. Plan (2 copias) y briefs 8 y 10 regenerados. Costo si está mal: un frame de error de más en un caso rarísimo.
Task 8: minor (deferred): fallback "default" del hilo sin test (lógica sonda y estable)
Task 8: minor (deferred): resource.ts dice "JWKS preferido" pero el código chequea hmacSecret primero — si ambos están seteados gana HMAC; alinear código o wording en el review final
Task 8: minor (deferred): el test de aislamiento no asserta simétricamente que recibido[1] no contenga "B" (trivial)
Task 8: fix round 1/5 — catch en iteración del stream (e23f3d0, 21/21 RED->GREEN); dispatch re-review scoped (haiku, 0530de2..e23f3d0)
Task 8: fix round 1/5 (1 addressed, 0 open; commits 0530de2..e23f3d0) — catch no intercepta return() del consumidor, happy path intacto
Task 8: complete (commits bc0ea52..e23f3d0, review clean)
Task 9: dispatch (implementer sonnet, BASE e23f3d0) — widget: DOM + SSE reader + retry de token
Task 9: implementer DONE (4892bbb; 6/6, typecheck limpio, dist/widget.js IIFE; vite 8.2.1/vitest 4.1.11/happy-dom 20.11.2). Divergencia pre-autorizada: defineConfig de vitest/config (vite 8 no tipa `test`) — plan alineado en origen (2 copias).
Nota operativa: las correcciones del plan/spec en el working tree del repo están sin commitear a propósito; se commitean juntas al cierre de la fase como "docs: plan corregido durante la ejecución".
Task 9: dispatch task-review (sonnet, e23f3d0..4892bbb)
Task 9: review spec ✅ / Approved con 3 Importants plan-mandated + 2 minors
Ruling: (1) done ignorado → SE FIXEA: el done trae el texto autoritativo y reconcilia la burbuja; (2) sin r.ok en el fetch de chat → SE FIXEA pero NO como short-circuit por status (el 401 del BFF trae frames SSE con expired_token): la guarda es "ningún frame llegó → errorGenerico", que además cubre body vacío; (3) stream truncado sin \n\n final → PARKED: la conducta actual ("muestra lo recibido") es exactamente lo que la tabla de errores del spec pide para esta fase; la reconexión pertenece a 2b junto con la persistencia del turno. Plan (2 copias) y brief 9 regenerados; 2 tests nuevos en el plan.
Task 9: minor (deferred): dedupe concurrente de TokenSource sin test directo (solo secuencial)
Task 9: minor (deferred): fetch de chat que RECHAZA (red caída) propaga sin MENSAJES fallback; evaluar en hardening
Task 9: fix round 1/5 — done reconcilia + guarda huboEventos (10c90ac, 8/8 RED->GREEN); dispatch re-review scoped (haiku, 4892bbb..10c90ac)
Task 9: fix round 1/5 (2 addressed, 0 open, 1 parked; commits 4892bbb..10c90ac) — retry path limpio de la guarda nueva
Task 9: complete (commits e23f3d0..10c90ac, review clean, 1 parked)
Ruling: Task 10 se ejecuta LOCAL-ONLY — los Steps de secrets/push/deploy/smoke real quedan fuera del alcance del subagente: no hay remote de GitHub, no hay cuenta AWS elegida, y un deploy es acción externa que decide el humano. El subagente entrega: Step 0 (verificación de nombres de recursos AgentCore en los tipos del provider), CONTRACT.md, infra SST, lambda.ts, workflow de CI, tsconfig sin exclude, typecheck completo. Costo si está mal: el deploy se valida después, con el humano.
Ruling: como `sst-env.d.ts` solo lo genera un deploy/diff real (requiere AWS), el puente tipado interino es un `sst-env.d.ts` ESCRITO A MANO con las dos linkables (AgentRuntime.arn, ClientAuth.jwksUrl/hmacSecret), commiteado con comentario de que el primer deploy lo regenera — así el @ts-nocheck de resource.ts SÍ se elimina y el archivo typechequea de verdad. Mejor tipos reales interinos que nocheck permanente. Costo si está mal: divergencia entre el d.ts a mano y el generado — se detecta en el primer deploy.
Task 10: dispatch (implementer sonnet, BASE 10c90ac)
Task 10: implementer DONE (ea8db0c) — HALLAZGO CLAVE: bedrockagentcore EXISTE en @pulumi/aws-native 1.68.0 (riesgo 1 del spec resuelto para el sabor SST; señal fuerte para awscc/Terraform). Desviaciones: awsnative.* global (no aws.native), @pulumi/docker-build import explícito, .agentRuntimeArn, .region, cast as awsnative.Region, skipLibCheck en bff, CI con pytest. Typecheck+tests verdes (21/21 bff, 8/8 widget, 12/12 core).
Task 10: dispatch task-review (sonnet, 10c90ac..ea8db0c) — foco: skipLibCheck esconde errores de .d.ts (¿incluye el sst-env.d.ts a mano?), el cast de Region, y el error "preexistente" filtrado de .sst/platform
Task 10: review spec ✅ (alcance local) / Approved con 3 Importants (2 plan-mandated: sin setup-buildx el primer CI ARM64 falla, wildcard en InvokeAgentRuntime; 1 del implementer: el tsconfig raíz de infra no está cableado a CI ni a script) + 4 minors. skipLibCheck VERIFICADO como workaround legítimo de defecto de sst@4.17.1 (reproducido con import "sst" pelado); filtro de .sst/platform verificado como incapaz de ocultar errores propios.
Ruling: los 3 se fixean ahora — el buildx y el scope son de mi plan (corregidos en origen, brief 10 regenerado); el cableado del typecheck de infra entra como script `typecheck:infra` (replica el filtro documentado con semántica de exit correcta) + paso de CI. Costo si está mal: un paso de CI de más.
Task 10: minor (deferred): logs sobre Resource:* (estándar; una versión log-group-scoped sería mejor)
Task 10: minor (deferred): CONTRACT.md no lista bedrock:InvokeModel que la policy sí otorga (drift de doc, heredado del plan)
Task 10: minor (deferred): cast `out.response as AsyncIterable` pasa por alto la opcionalidad del SDK (riesgo bajo, verbatim del plan)
Task 10: minor (watch-item para el primer deploy): si el patrón foundation-model/* single-region alcanza para inference profiles us.* cross-region
Task 10: fix round 1/5 — buildx + typecheck:infra cableado (con evidencia de fallo ante error deliberado y ante .sst ausente) + scope IAM (cc6c22d). El implementer detectó y cerró un gap propio del CI: npx sst install antes del gate (.sst gitignoreado). Plan alineado (2 copias). Dispatch re-review scoped (haiku, ea8db0c..cc6c22d)
Task 10: fix round 1/5 (3 addressed, 0 open; commits ea8db0c..cc6c22d) — exit semantics trazadas caso por caso, orden del CI verificado
Task 10: complete (commits 10c90ac..cc6c22d, review clean)
Ruling: Task 11 también LOCAL-ONLY — su Step 8 (smoke visual end-to-end contra CHAT_URL desplegada) queda diferido junto con el deploy; el subagente entrega Steps 1-7 (paquete, sign.mjs con TDD, server.mjs, index.html, README) y los tests locales. Costo si está mal: el smoke visual se corre después con el humano.
Task 11: dispatch (implementer haiku, BASE cc6c22d) — transcripción con código completo en el brief
Task 11: implementer DONE (bf5b2d4, 32/32 JS/TS); dispatch task-review (haiku, cc6c22d..bf5b2d4)
Task 11: review spec ✅ / Approved, 0 Important, 1 minor
Task 11: minor (deferred): el comentario de /chat-token implica pero no declara "DEMO ONLY: sin auth, firma para cualquiera" (una línea lo cierra)
Task 11: complete (commits cc6c22d..bf5b2d4, review clean)
== Las 11 tareas completas. Commit de correcciones del plan + review final de rama ==
Incidente resuelto: tres implementers corrieron git stash sobre las correcciones del plan en curso (stash@{0..2}, solo el archivo del plan en los tres, verificado por stat). El working tree quedó con una mezcla parcial. Restaurado desde la copia canónica de aersa (verificados 6 marcadores), commiteado como docs, y los 3 stashes dropeados tras verificar que eran subconjuntos superseded. El spec estaba idéntico en ambas copias.
Ruling: para futuras fases, el dispatch del implementer debe prohibir git stash (o el controlador commitea sus correcciones de docs inmediatamente en vez de dejarlas en el working tree — causa raíz mía). Costo si está mal: nulo; todo verificado antes de dropear.
Review final (fable, aaba1c1..a6231e1): With fixes — 1 Critical (C1: core emite SSE, BFF parsea NDJSON, AgentCore relaya bytes tal cual → happy path 100% roto en el primer deploy; premisa falsa de mi plan, nunca adjudicada, y contradice §8 del spec), 5 Importants (I1 status/content-type muertos en lambda.ts, I2 IAM single-region vs profiles us.*, I3 Dockerfile 3.12 vs requires-python 3.13 → doble runtime, I4 invariante GUARDRAIL_VERSION sin validar, I5 sin README raíz), 11 minors. Triage del ledger completo: ningún ítem bloquea solo; ningún ruling mío resultó incorrecto; el watch-item de T10 sube a I2 con evidencia documental.
Ruling: fix wave ÚNICA con C1+I1-I5+batch de minors "arreglar-no-bloquea" (todos de minutos; el reviewer los recomendó en esta fase). C1 se cierra con parser tolerante en el BFF y NO con NDJSON puro en el core: el content-type text/event-stream es lo que engancha el streaming de AgentCore — cambiar el core arriesgaría respuesta buffereada. Brief completo en fix-wave-brief.md. Costo si está mal: el parser tolera un formato de más (inofensivo).
Ruling: el plan NO se re-edita bloque por bloque para reflejar el fix wave (ya no quedan tareas que generen briefs de él); se corrige SOLO la Global Constraint con la premisa falsa y se agrega nota de post-ejecución apuntando al repo como canónico. El documento histórico honesto vale más que uno retro-perfeccionado.
Fix wave: DONE (a7f507e C1, e7b8478 I1-I5, 41c0a3d minors; 14+24+9+3, typechecks limpios); dispatch re-review scoped (sonnet, a6231e1..41c0a3d)
Fix wave: re-review — todo ADDRESSED (C1, I1-I5, M1-M11, T3, T9), sin breakage; suites re-verificadas independientemente (14/24/9/3, typechecks limpios)
Ruling (residual 1): el test del flush del decoder no pinea de verdad la línea del flush (verificado empíricamente por el re-reviewer; el implementer ya lo había declarado). El código del fix es correcto; queda como deuda de diseño de test para 2b. Parked, no extiende el wave.
Ruling (residual 2): el plan quedó modificado sin commitear en el working tree (mi nota post-ejecución + corrección de la constraint C1, previas al wave) — se commitea ahora como docs.
== CIERRE: rama fase-2a completa: 11 tareas + fix wave, review final With fixes → fixes aplicados y re-verificados ==

## Addendum post-fase (2026-08-20)

Tarea suelta: modo mock del demo-client (regla nueva del spec §16: toda capacidad con
entorno local mockeado). Commit 19c9118. Review: Approved, 0 Critical/Important.
Minors aceptados sin fix (herramienta de demo local): (1) el mock responde 200 también
para expired_token donde el BFF real usa 401 — el widget ramifica por frame, no por
status; (2) Map de `vencido` sin bound — proceso local que se reinicia; (3) una línea
en blanco extra en el HTML de modo real por el placeholder del hint.
