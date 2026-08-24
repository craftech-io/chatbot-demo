# SDD ledger — plan: docs/superpowers/plans/2026-08-21-fase-2b-memoria-guardrails-topes.md

Spec: docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md (§9, §10, §12, §15, §16)
Repo: /home/lautaro/Craftech/craftech-ai-chat · rama fase-2a · BASE 7004205
Task 10 (smoke real) es del controlador+humano, no se despacha.

## Pre-flight scan

### Pares que comparten archivo o interfaz

| Par | Produce → consume | Hallazgo |
|---|---|---|
| T1 → T3,T8 | `@craftech-ai-chat/shared/mensajes` (exports → .ts fuente) | OK — patrón source-linking; vite/esbuild/tsc bundler lo resuelven |
| T1 → T2 | infra importa mensajes por RUTA RELATIVA (no package name) | OK, deliberado (bundling de sst.config) |
| T2 → T3 | linkable Guardrail {id,version} + sst-env.d.ts en T2 | OK, orden correcto |
| T2 → core | GUARDRAIL_ID/VERSION al Runtime | OK — config.py de 2a ya los soporta |
| T4 → T5 | MEMORY_ID; Step 0 verifica que awsnative.bedrockagentcore.Memory exista | GATE explícito: si no existe → BLOCKED |
| T5 | payload.userId — InvokePayload de 2a ya lo manda (lambda serializa p entero) | OK |
| T5 | registrar_turno ANTES del frame done; tests 2a sin memoria no cambian | OK |
| T6 → T7 | linkables .name + env LIMITE_* leídos SOLO en resource.ts | OK |
| T7 | orden: payload (sessionId derivado) debe construirse antes del check de límites | Anotado en el plan; el implementer mueve la construcción si hace falta |
| T7 → T8 | frame {type:error,code:limit_reached,motivo} | OK, consistente |
| T3+T7 → handler | orden final: auth → mensaje → topes → guardrail → invoke (test lo pinea) | OK |
| T9 | planificarRespuesta gana 3er parámetro con default; los 4 tests de 2b-mock previos siguen | OK |
| T8 | regex del test matchea el texto de MENSAJES_LIMITE.diarioAlcanzado | OK |

### Auto-consistencia

Todas las tareas traen su código y tests verbatim; T2/T4/T5 llevan instrucción de verificar nombres reales del provider/boto3 antes de asumir (lección 2a). Sin contradicciones detectadas.

## Rulings (pre-flight)

Ruling: el scan salió limpio; sin correcciones pre-ejecución. Los puntos inciertos (campos del Guardrail classic, existencia de Memory en aws-native 1.68, data plane de boto3) tienen gates de verificación en sus tareas — el implementer verifica y reporta, no improvisa. Costo si está mal: un NEEDS_CONTEXT más en el loop.

## Progreso

Task 1: dispatch (implementer haiku, BASE 7004205) — transcripción
Task 1: implementer DONE (5573cdf, 1/1 + raíz 41/41; desvío: DOM+skipLibCheck en tsconfig de shared para tipos de vitest); dispatch review (haiku)
Task 1: review Needs fixes — 1 finding sobre el tsconfig (lib DOM + skipLibCheck no verificados como necesarios; "Critical" del reviewer recalibrado: sin impacto en runtime ni consumidores, pero la necesidad no está probada y DOM es engañoso en un paquete de constantes)
Ruling: se prueba empíricamente la mínima desviación necesaria — hipótesis: skipLibCheck SOLO alcanza (los d.ts de vitest referencian DOM internamente; skipLibCheck evita chequearlos — precedente justificado del bff en 2a), y lib queda ["ES2022"]. El implementer debe pegar el error real de tsc sin cada mitigación (evidencia, no afirmación). Si skipLibCheck solo no alcanza, DOM vuelve CON el error pegado como justificación en comentario. Costo si está mal: una línea de tsconfig.
Ruling (proceso): el desvío debió reportarse como DONE_WITH_CONCERNS, no DONE — anotado, sin acción.
Task 1: fix round 1/5 — skipLibCheck solo, DOM removido, evidencia empírica (0086a5a); dispatch re-review (haiku)
Task 1: fix round 1/5 (1 addressed, 0 open; 5573cdf..0086a5a) — skipLibCheck justificado con 18 errores reales pegados, DOM removido
Task 1: complete (commits 7004205..0086a5a, review clean)
Task 2: dispatch (implementer sonnet, BASE 0086a5a) — infra con verificación de campos del provider
Task 2: implementer DONE (a196ca9; tipos verificados sin mapeo; ApplyGuardrail acotado a guardrailArn); dispatch review (haiku)
Task 2: review spec ✅ / Approved, 0 findings — permiso acotado a guardrailArn (mejor que el mínimo del brief); cadena de imports verificada
Task 2: complete (commits 0086a5a..a196ca9, review clean)
Task 3: dispatch (implementer sonnet, BASE a196ca9) — toca la frontera de confianza (handler)
Task 3: implementer DONE (b068ce4, 30/30 bff, monorepo verde); dispatch review (sonnet — frontera de confianza)
Task 3: review spec ✅ / Approved, 0 Critical/Important, 1 minor (premisa del punto 4 del reviewer no aplicaba — sin cambio). Blocked path sin fuga de contenido, slot de topes documentado, 2a byte-idéntico
Task 3: complete (commits a196ca9..b068ce4, review clean)
Task 4: dispatch (implementer sonnet, BASE b068ce4) — GATE: awsnative.bedrockagentcore.Memory debe existir en los tipos
Task 4: implementer DONE (0688220) — GATE pasó: Memory existe en aws-native 1.68.0, inputs/outputs exactos al plan. Watch-item para el smoke: nombres de acciones IAM del data plane (CreateEvent/ListEvents) sin evidencia local, comentados como "verificar en el smoke"
Task 4: dispatch review (haiku)
Task 4: review spec ✅ / Approved, 0 findings — gate documentado, 2a intacto, mapeo en CONTRACT
Task 4: complete (commits b068ce4..0688220, review clean)
Task 5: dispatch (implementer sonnet, BASE 0688220) — core Python: memoria.py + wiring del server; gate del data plane de boto3
Task 5: implementer DONE (142af23, 19/19 core + 47 raíz) — gate boto3 pasó exacto; hallazgo del implementer: includePayloads=True explícito (el default False habría devuelto historial vacío EN SILENCIO — trampa que ningún test con doble podía ver)
Task 5: dispatch review (sonnet)
Task 5: review Approved con 1 Important (wiring Memory→LLM sin test: nada pinea que el historial retornado se USE) + 2 minors. Semántica verificada por trace: turno fallido no persiste; falla de Memory no bloquea el done.
Ruling: el Important se fixea ahora. El minor de includePayloads sin assert se PLIEGA al fix (mismo archivo de test, mismos dobles, y su regresión reintroduce exactamente la trampa del historial-vacío-silencioso) — excepción deliberada a "minors nunca entran", registrada como en T6-2a. El otro minor (fallback anonimo/default) queda como está: venía del brief y es sano.
Task 5: fix round 1/5 — pins verificados nacer verdes standalone (0d1fa1a, 19/19); dispatch re-review (haiku)
Task 5: fix round 1/5 (2 addressed, 0 open; 142af23..0d1fa1a)
Task 5: complete (commits 0688220..0d1fa1a, review clean)
Task 6: dispatch (implementer haiku, BASE 0d1fa1a) — infra Dynamo, transcripción con verificación de tipos
Task 6: implementer DONE (cbbf1c5, typechecks OK); dispatch review (haiku)
Task 6: review spec ✅ / Approved, 0 findings
Task 6: complete (commits 0d1fa1a..cbbf1c5, review clean)
Task 7: dispatch (implementer sonnet, BASE cbbf1c5) — topes atómicos + índice; toca el handler otra vez
Task 7: implementer DONE_WITH_CONCERNS (b6e87d1, 38/38 bff; desvío: (_cmd: any) en mock del test por TS2493 real); dispatch review (sonnet)
Task 7: review Approved, 0 Critical/Important, 2 minors
Task 7: minor (deferred): ventana de carrera del tope por sesión — POR DISEÑO (tope suave; el diario es atómico); documentar como limitación en el spec/2e si se habilita multi-dispositivo sobre la misma sesión
Task 7: minor (deferred): (_cmd: any) del mock podría ser UpdateItemCommand — pulido de igual costo, para cuando se toque el archivo
Task 7: complete (commits cbbf1c5..b6e87d1, review clean)
Task 8: dispatch (implementer haiku, BASE b6e87d1) — widget, cambio chico verbatim
Task 8: implementer DONE (09443ad, 10/10 widget + 56 raíz); dispatch review (haiku)
Task 8: review spec ✅ / Approved, 0 findings (deps "*" consistente con T3)
Task 8: complete (commits b6e87d1..09443ad, review clean)
Task 9: dispatch (implementer sonnet, BASE 09443ad) — mock con estado por sesión; última despachable
Task 9: implementer DONE_WITH_CONCERNS (5292896, 10/10 demo + 59 raíz + curls OK) — concern 2 es defecto del PLAN: la fórmula de 'memoria' imprime undefined con historial vacío; dispatch review (haiku)
Task 9: review Approved con 1 Important plan-mandated (la fórmula de 'memoria' imprime "undefined" con historial vacío — gap de MI plan; texto visible en la demo) + 2 concerns aceptados (hint vía server, patrón preexistente; puerto 3101)
Ruling: se fixea ahora — rama para historial vacío ("Este es nuestro primer mensaje de la conversación."); plan corregido en origen. Costo si está mal: una rama en el mock.
Task 9: fix round 1/5 — rama primer mensaje (00b166a, 11/11, RED->GREEN, curl OK); dispatch re-review (haiku)
Task 9: fix round 1/5 (1 addressed, 0 open; 5292896..00b166a)
Task 9: complete (commits 09443ad..00b166a, review clean)
== Las 9 tareas completas. Review final de rama de la fase 2b ==
Review final (fable, 7004205..00b166a): With fixes — 2 CRITICAL de IAM (costuras): (C1) la Lambda del chat sin permisos Dynamo — los Linkable envueltos saltean el auto-grant del componente; topes/índice serían no-op silencioso en prod; (C2) ApplyGuardrail del RuntimeRole scoped a recursos equivocados — cada turno con guardrail daría AccessDenied. + 5 minors. Verificado deliberado (no findings): mensaje bloqueado gasta cupo diario; mock con 200 donde el real da 429.
Ruling: fix wave única con C1 (wrappers + include con permisos scoped GetItem/UpdateItem al arn de cada tabla — el ethos de scoping del template — y CONTRACT.md), C2 (statement ApplyGuardrail al guardrailArn en RuntimeRole y quitar la acción del statement de modelos donde no matchea nada), M1 (TTL expiraAt en LimitsTable) y M2 (paridad del mock: los turnos tope/bloqueado no se pushean al historial — flag persistible en el plan de respuesta). M3 (spec §15) y M4 (plan sin commitear) los hizo el controlador como docs. M5 (afordance de nueva conversación) → nota para 2e.
Task 9 addendum: divergencia del spec §15 anotada como deliberada en ambas copias.
Fix wave: DONE (763c699 C1+C2, 0dcde3c M1+M2; 39/1/10/12 + 19 core; formas sst verificadas); dispatch re-review scoped (sonnet)
Fix wave: re-review — 4/4 ADDRESSED con verificación independiente (forma del include contra el source de la plataforma; gramática ADD...SET contra los docs de AWS). Sin breakage.
Out-of-scope anotado para 2c: el escenario `error` del mock aún persiste al historial (el real no persiste turnos con invoke fallido); pasada de paridad futura.
== FASE 2B COMPLETA: 9 tareas + fix wave, review final With fixes → aplicados y re-verificados. Falta Task 10 (smoke real, controlador+humano). ==
