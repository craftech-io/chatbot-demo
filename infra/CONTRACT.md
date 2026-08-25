# Contrato de infraestructura

Cualquier sabor de IaC (SST, Terraform, Pulumi) debe crear estos recursos e
inyectar estas variables. El código del producto no conoce el sabor: cambiar de
uno a otro es reimplementar esta lista, nada más.

## Recursos

| Recurso | Para qué | Notas |
|---|---|---|
| AgentCore Runtime | corre el contenedor del agente | imagen **ARM64**; `/ping` y `/invocations` en `:8080` |
| Repositorio ECR | aloja la imagen del core | |
| Rol de ejecución del Runtime | lo asume `bedrock-agentcore.amazonaws.com` | permisos: `bedrock:InvokeModelWithResponseStream`, `bedrock:InvokeModel` (foundation-model + inference-profile), `bedrock:ApplyGuardrail` (statement propio, scoped al `guardrailArn` — NO al statement de modelos, que no matchea ese recurso), `bedrock-agentcore:CreateEvent`, `bedrock-agentcore:ListEvents` |
| Lambda del BFF + Function URL | chat con response streaming | permisos: `bedrock-agentcore:InvokeAgentRuntime` (ARN del Runtime propio); `bedrock:ApplyGuardrail` (scoped al `guardrailArn`); `dynamodb:GetItem`+`dynamodb:UpdateItem` sobre SessionsTable y sobre LimitsTable (vía `include` en los `sst.Linkable` de `infra/sst/tablas.ts` — un Linkable pelado NO hereda el auto-grant de `sst.aws.Dynamo`); `dynamodb:Query`+`dynamodb:PutItem` sobre MessagesTable y `sqs:SendMessage` sobre MensajesCola (vía `include` en `infra/sst/mensajeria.ts`, mismo patrón) |
| Secreto del emisor de tokens | verificar el token del cliente | JWKS URL o secreto HMAC |
| Guardrail de Bedrock | filtro de contenido entrada+salida | mensajes desde packages/shared |
| AgentCore Memory | historial de conversación | (actorId, sessionId) |
| SessionsTable (DynamoDB) | índice de hilos por usuario | pk: userId, sk: sessionId |
| LimitsTable (DynamoDB) | contadores de tope por usuario y período | pk: userId, sk: periodo |
| MessagesTable (DynamoDB) | fuente de verdad de la transcripción (spec §8 v2) | pk: conversationId, sk: orden (`${ts ISO}#${msgId}` — el orden lexicográfico ES el cronológico) |
| MensajesCola (SQS FIFO) | serializa el procesamiento de mensajes por conversación; el delay de cola es la ventana de debounce | `MessageGroupId = conversationId`; `delaySeconds` 6 (hardcodeado en la infra, ver nota de mapeo abajo); redirige a MensajesDlq tras 3 intentos; `visibilityTimeout` 6 minutos — **invariante: siempre ≥ 2x el `timeout` del worker** (hoy 3 minutos, `infra/sst/worker.ts`), o SQS re-entrega el mensaje mientras el primer invoke sigue corriendo y el segundo `procesarMensaje` concurrente pasa el debounce (nada cambió) → doble invocación al agente, doble respuesta, sin error ni DLQ que lo delate (fix round 1, Task 5) |
| MensajesDlq (SQS FIFO) | destino de mensajes que MensajesCola no pudo entregar tras 3 intentos | también FIFO — SQS no permite que una cola FIFO redirija a una DLQ estándar (ni al revés) |
| Lambda del worker (`Worker`) | consume MensajesCola (batch size 1) y corre el turno del agente en background: debounce + agregación de pendientes + invoke a AgentCore Runtime + escritura de la respuesta en MessagesTable (spec §8 v2) | permisos: `bedrock-agentcore:InvokeAgentRuntime` (ARN del Runtime propio + sub-recurso `runtime-endpoint/*`); `sqs:ChangeMessageVisibility`+`sqs:DeleteMessage`+`sqs:GetQueueAttributes`+`sqs:GetQueueUrl`+`sqs:ReceiveMessage` sobre MensajesCola (a mano — ver nota de mapeo abajo, `subscribe` por ARN no los auto-otorga); `dynamodb:Query`+`dynamodb:PutItem` sobre MessagesTable heredado de `messagesTableLink` (mismo Linkable que usa el BFF, `include` en `infra/sst/mensajeria.ts`); timeout 3 minutos (el turno puede tardar tanto como el invoke completo al Runtime) |

## Variables que recibe el core (contenedor)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MODEL_ID` | sí | id del modelo o inference profile de Bedrock |
| `AWS_REGION` | no (default `us-east-1`) | región de Bedrock |
| `GUARDRAIL_ID` | no | si falta, el core corre sin guardrail — las inyecta la infra desde 2b |
| `GUARDRAIL_VERSION` | no | requerida si hay `GUARDRAIL_ID` — las inyecta la infra desde 2b |
| `MEMORY_ID` | no | sin ella, el core usa el history del payload (modo local/tests) |

## Variables que recibe el BFF

| Variable | Obligatoria | Descripción |
|---|---|---|
| `AGENT_RUNTIME_ARN` | sí | ARN del AgentCore Runtime a invocar |
| `CLIENT_JWKS_URL` | una de las dos | JWKS del emisor de tokens del cliente |
| `CLIENT_HMAC_SECRET` | una de las dos | secreto compartido, si el cliente no tiene OIDC |
| `GUARDRAIL_ID` | no (2b) | id del Guardrail, vía linkable en SST (`Resource.Guardrail.id`) |
| `GUARDRAIL_VERSION` | no (2b) | versión del Guardrail, vía linkable en SST (`Resource.Guardrail.version`) |
| `SESSIONS_TABLE` | sí (2b) | nombre de la tabla de sesiones, vía linkable en SST (`Resource.SessionsTable.name`) |
| `LIMITS_TABLE` | sí (2b) | nombre de la tabla de límites, vía linkable en SST (`Resource.LimitsTable.name`) |
| `LIMITE_DIARIO` | sí (2b) | número máximo de llamadas por usuario por día (default: 50) |
| `LIMITE_POR_SESION` | sí (2b) | número máximo de turnos por sesión (default: 40) |
| `MESSAGES_TABLE` | sí (2c) | nombre de la tabla de mensajes, vía linkable en SST (`Resource.MessagesTable.name`) |
| `MENSAJES_COLA_URL` | sí (2c) | URL de la cola FIFO de mensajería, vía linkable en SST (`Resource.MensajesCola.url`) |
| `DEBOUNCE_SEGUNDOS` | no (2c, default 6) | informativo para logs/tests: el delay real de debounce vive en `delaySeconds` de la cola SQS, no en esta variable — ver nota de mapeo abajo |

En el sabor SST estas variables se resuelven por linking y las lee
`packages/bff/src/config/resource.ts`. En los demás sabores se inyectan como
variables de entorno y las lee `packages/bff/src/config/env.ts` (se crea con
el segundo sabor de IaC — todavía no existe).

## Mapeo de nombres reales (Step 0, sabor SST)

El plan original de esta tarea escribió los nombres de recursos de Pulumi de
memoria, sin verificarlos contra los tipos generados. Tras `npm i -E -D sst &&
npx sst install` y greppear `.sst/platform/`, estos son los nombres reales que
usa `infra/sst/runtime.ts`:

| Nombre en el plan | Nombre real | Detalle |
|---|---|---|
| `aws.native.bedrockagentcore.Runtime` | `awsnative.bedrockagentcore.Runtime` | `.sst/platform/config.d.ts` declara dos globals ambientales: `export import aws = _aws` (provider classic, paquete `@pulumi/aws`) y `export import awsnative = _awsnative` (Cloud Control, paquete `@pulumi/aws-native`). No existe una propiedad `.native` colgando de `aws`; el namespace de AgentCore vive directo en el global `awsnative`. Confirmado además contra el sabor SST de `msp-platform` (proyecto hermano), que ya usa `awsnative.bedrockagentcore.Memory` y `awsnative.bedrockagentcore.Harness` en producción. |
| `dockerbuild.Image` | `dockerbuild.Image` (import explícito de `@pulumi/docker-build`) | El paquete real es `@pulumi/docker-build` (con guion), no hay global ambiental `dockerbuild` declarado en `.sst/platform/src/global.d.ts` (a diferencia de `aws`/`awsnative`/`sst`). El propio código fuente de SST (`.sst/platform/src/components/aws/helpers/container-builder.ts`) lo resuelve con `import { Image } from "@pulumi/docker-build"`. `infra/sst/runtime.ts` hace `import * as dockerbuild from "@pulumi/docker-build"` para mantener el nombre `dockerbuild.Image` del plan. |
| `aws.getRegionOutput().name` | `aws.getRegionOutput().region` | El campo `name` de `GetRegionResult` está marcado `@deprecated` ("Use 'region' instead. This attribute will be removed in a future version of the provider"). Se usa `.region`, que es el campo vigente y devuelve el mismo valor (típicamente `us-east-1`). |
| `runtime.arn` (en `sst.config.ts`) | `runtime.agentRuntimeArn` | El recurso `awsnative.bedrockagentcore.Runtime` no expone un `.arn` genérico (ver `RuntimeArgs`/`Runtime` arriba): el output real se llama `agentRuntimeArn`. Encontrado por `tsc`, no por el plan. |
| `region: process.env.AWS_REGION ?? "us-east-1"` en el provider `"aws-native"` | mismo valor, cast a `awsnative.Region` | El provider classic (`aws`) tipa `region` como `string`, pero el provider `aws-native` lo tipa como el literal `Input<Region>` (unión de regiones válidas). Un `string` plano no satisface ese literal; se castea `as awsnative.Region` sin cambiar el valor ni hardcodear nada. |

El resto de los nombres del plan (`aws.ecr.Repository`, `aws.iam.Role`,
`aws.iam.RolePolicy`, `aws.ecr.getAuthorizationTokenOutput`, los campos de
`RuntimeArgs` — `agentRuntimeName`, `agentRuntimeArtifact.containerConfiguration.containerUri`,
`networkConfiguration.networkMode: "PUBLIC"`, `roleArn`, `environmentVariables`,
el output `agentRuntimeArn` —, `sst.Linkable`, `sst.Secret`, `sst.aws.Function`
con `streaming`, `url.cors`, `link`, `permissions`) se verificaron contra
`.sst/platform/node_modules/@pulumi/{aws,aws-native,docker-build}/**/*.d.ts` y
coinciden exactamente con el plan.

Versiones de providers instaladas por `sst install` (pineadas en `sst.config.ts`):
`@pulumi/aws@7.32.0`, `@pulumi/aws-native@1.68.0` — sin desviación de versión.

## Mapeo de nombres reales (fase 2b, Guardrail)

`infra/sst/guardrail.ts` usa el provider classic (`aws.bedrock.Guardrail`, no
Cloud Control). Se verificó contra
`.sst/platform/node_modules/@pulumi/aws/bedrock/guardrail.d.ts` y
`.sst/platform/node_modules/@pulumi/aws/types/input.d.ts` (interfaces
`GuardrailContentPolicyConfig`/`GuardrailContentPolicyConfigFiltersConfig`):
todos los nombres que asumió el plan (`aws.bedrock.Guardrail`,
`blockedInputMessaging`, `blockedOutputsMessaging`, `contentPolicyConfig`,
`filtersConfigs`, `type`, `inputStrength`, `outputStrength`, `guardrailId`,
`version`) coinciden exactamente con los tipos instalados — sin mapeo,
sin desvío.

Extra encontrado (no estaba en el plan): la clase `Guardrail` también expone
`guardrailArn` como output. Se usó ese output para acotar el permiso
`bedrock:ApplyGuardrail` del BFF al Guardrail propio (`resources:
[guardrail.guardrailArn]`), en vez de armar el ARN a mano con `$interpolate`
o dejar `"*"` — ambas alternativas que el plan contemplaba como fallback.

## Mapeo de nombres reales (fase 2b, AgentCore Memory)

Step 0 (gate obligatorio de esta tarea): `awsnative.bedrockagentcore.Memory`
SÍ existe en `@pulumi/aws-native@1.68.0` — confirmado con
`grep -rio "bedrockagentcore\.Memory" .sst/platform/` (aparece en
`bedrockagentcore/memory.d.ts`, `getMemory.d.ts` y en `types/input.d.ts`/
`types/output.d.ts`) y con `grep -rn "class Memory"
.sst/platform/node_modules/@pulumi/aws-native/bedrockagentcore/` (declara
`export declare class Memory extends pulumi.CustomResource`). Se leyó
`bedrockagentcore/memory.d.ts` completo: los campos que asumió el plan
(`name`, `eventExpiryDuration` como inputs; `memoryId`, `memoryArn` como
outputs) coinciden exactamente con `MemoryArgs`/`Memory` — sin mapeo,
sin desvío.

Los nombres de acción IAM del data plane (`bedrock-agentcore:CreateEvent`,
`bedrock-agentcore:ListEvents`) NO tienen evidencia local: no hay paquete
`@aws-sdk/client-bedrock-agentcore*` instalado en `.sst/platform/node_modules`
ni referencias a esas acciones en los `.d.ts` de `aws`/`aws-native` (solo
aparece `bedrock-agentcore:InvokeAgentRuntime`, ya usado por el BFF, en
`aws/bedrock/agentcoreResourcePolicy.d.ts`). Quedan los nombres del plan tal
cual, marcados en `infra/sst/runtime.ts` para verificar en el smoke.

## Mapeo de nombres reales (fix-wave fase 2b, permisos de DynamoDB en Linkables)

Verificado contra `.sst/platform/src/components/linkable.ts` y
`.sst/platform/src/components/aws/permission.ts`: la interfaz `Definition` de
`sst.Linkable` expone un campo opcional `include: { type: string; [key:
string]: any }[]`, y `sst.aws.permission({ actions, resources })` devuelve
`{ type: "aws.permission", actions, resources }`. La forma coincide
exactamente con la que documenta el JSDoc del propio archivo (`sst.Linkable`
con `include: [sst.aws.permission({ actions: [...], resources: [...] })]`) —
sin mapeo, sin desvío. Se usó para scopear `sessionsTableLink`/`limitsTableLink`
en `infra/sst/tablas.ts` a `dynamodb:GetItem`+`dynamodb:UpdateItem` sobre el
ARN de cada tabla: un `sst.Linkable` pelado (solo `properties`) NO hereda el
auto-grant que da linkear el componente `sst.aws.Dynamo` directo, así que sin
`include` la Lambda del BFF quedaba sin permisos de Dynamo (AccessDenied
tragado por el fail-open de `topes.ts`/`indice.ts`).

También verificado contra `.sst/platform/src/components/aws/dynamo.ts`: el
campo `ttl?: Input<string>` existe con esa forma exacta (ejemplo del propio
JSDoc: `ttl: "expireAt"`) — se usó para `LimitsTable.ttl = "expiraAt"`.

## Mapeo de nombres reales (fase 2c, sst.aws.Queue)

Gate obligatorio de esta tarea (spec §8 v2, mensajería asíncrona). Verificado
contra `.sst/platform/src/components/aws/queue.ts` (leído completo) y
`.sst/platform/src/components/duration.ts`:

- `fifo?: Input<boolean | { contentBasedDeduplication?: Input<boolean> }>`
  (queue.ts:47-58) — `fifo: true` del plan coincide exactamente.
- `delay?: Input<DurationMinutes>`, default `"0 seconds"` (queue.ts:59-72);
  `DurationMinutes` acepta el literal `${number} ${"second"|"seconds"|...}`
  (duration.ts:13-19) — `delay: "6 seconds"` del plan coincide exactamente.
- `dlq?: Input<string | { queue: Input<string>; retry: Input<number> }>`,
  default `retry: 3` si se pasa solo el ARN como string (queue.ts:121-134) —
  `dlq: { queue: dlq.arn, retry: 3 }` del plan coincide exactamente.
- Sufijo `.fifo` automático: confirmado en
  `.sst/platform/src/components/component.ts:315-324`. El hook global de
  autonombrado de SST (que envuelve la creación de CUALQUIER recurso Pulumi,
  no solo `sst.aws.Queue`) tiene una regla explícita para
  `"aws:sqs/queue:Queue"` que agrega el sufijo `.fifo` al nombre físico
  autogenerado cuando `fifoQueue` es `true` — pero SOLO si el nombre no vino
  ya seteado (`component.ts:368`: `if (args.props[nameField] ...) return`).
  Como ni el plan ni esta implementación pasan `name`/`transform.queue.name`,
  el autonombrado aplica y el sufijo se agrega solo: confirma la hipótesis
  del plan ("no pasamos name → autoname; confirmar que el componente agrega
  `.fifo` solo").

**Desvío encontrado respecto al plan:** la sección "Produces" del brief
documenta el nombre físico literal `craftech-ai-chat-mensajes-${stage}.fifo`
para `MensajesCola`. Ese nombre NO es lo que produce el código: `QueueArgs`
(queue.ts:20-145) no tiene ningún campo `name` propio — la única forma de
fijar un nombre físico explícito es `transform.queue.name` (el `name` de
`sqs.QueueArgs` de Pulumi), que ni el plan ni esta implementación usan. Sin
esa transform, `physicalName()` (`.sst/platform/src/components/naming.ts:8-21`)
genera `${app}-${stage}-<nombre-lógico-del-componente>-${random8}.fifo` (prefijo
app+stage + nombre lógico del componente + sufijo aleatorio de 8 chars +
`.fifo`), no el nombre determinístico del brief. Se implementó tal como
aparece el Step 2 del plan (sin `name`/`transform`, autoname) porque es el
mismo patrón que ya usan `MessagesTableDb`/`SessionsTableDb`/`LimitsTableDb`
en este repo (ningún recurso de este proyecto fija nombres físicos a mano) y
porque el BFF/worker nunca hardcodean el nombre: lo obtienen del Linkable
(`Resource.MensajesCola.url`), así que el nombre físico real es irrelevante
para el código del producto. Si en el futuro se necesita el nombre
determinístico del brief (p. ej. para referenciarlo desde fuera de SST), hay
que agregar `transform: { queue: { name: <literal>+".fifo" } }` a mano — SST
no agrega el sufijo cuando el nombre viene explícito.

**Fix round 1:** el componente pasó a llamarse `MensajesColaQueue` (no
`MensajesCola`) porque colisionaba con `sst.Linkable("MensajesCola", ...)` —
los nombres de componentes SST son únicos en toda la app (misma lección que
el sufijo `Db` de `MessagesTableDb`/`SessionsTableDb`/`LimitsTableDb`, y el
mismo tipo de bug que un fix de deploy de 2b). El nombre físico autogenerado
ahora usa `MensajesColaQueue` como parte lógica (`...-MensajesColaQueue-${random8}.fifo`);
la clave del Linkable (`Resource.MensajesCola`) no cambió.

## Mapeo de nombres reales (Task 5, fase 2c: `Queue.subscribe` y su `batch`)

Gate obligatorio de esta tarea. Verificado contra
`.sst/platform/src/components/aws/queue.ts` (leído completo, incluida
`_subscribeFunction`) y `.sst/platform/src/components/aws/queue-lambda-subscriber.ts`:

- `public subscribe(subscriber: Input<string | FunctionArgs | FunctionArn>, args?: QueueSubscriberArgs, opts?)`
  (queue.ts:509-527) — el parámetro NO acepta una instancia de `sst.aws.Function`
  (el tipo público es `string | FunctionArgs | FunctionArn`, no `Function`),
  aunque el helper interno `functionBuilder` sepa manejar ese caso para otros
  callers. Sí acepta un ARN como `string` — `Output<string>` (lo que devuelve
  `worker.arn`) es asignable ahí porque `string` ya está en la unión.
- `QueueSubscriberArgs.batch?: Input<{ size?: Input<number>; window?:
  Input<DurationMinutes>; partialResponses?: Input<boolean> }>`
  (queue.ts:200-262), default `{size: 10, window: "20 seconds",
  partialResponses: false}` — `{ batch: { size: 1 } }` del plan coincide
  exactamente.
- `subscribe()` delega en el método estático `_subscribeFunction` (queue.ts:590-610),
  que crea un `QueueLambdaSubscriber` nombrado `${nombreDelComponenteQueue}Subscriber${hash}`
  — un nombre auto-derivado (nunca colisiona, no hace falta elegirlo a mano).

**Desvío encontrado respecto al plan (por qué el worker NO usa ese patrón
auto-nombrado):** si se le pasa a `subscribe()` un handler string o un objeto
`FunctionArgs` (en vez de un ARN), `QueueLambdaSubscriber.createFunction()`
(queue-lambda-subscriber.ts) crea la Function del subscriber por dentro y le
auto-otorga `sqs:ChangeMessageVisibility`/`DeleteMessage`/`GetQueueAttributes`/
`GetQueueUrl`/`ReceiveMessage` sobre la cola — pero esa Function queda con un
nombre auto-hasheado (`MensajesColaQueueSubscriber<hash>Function`), no
`"Worker"`. La ruling de esta tarea pide un componente `Function` propio
llamado `"Worker"` (verificado libre con grep en `infra/`, ver arriba), así
que `infra/sst/worker.ts` crea `new sst.aws.Function("Worker", {...})` primero
y recién después llama `mensajesCola.subscribe(worker.arn, {batch: {size:
1}})` — la rama de `functionBuilder` para un ARN NO crea una Function nueva ni
le agrega permisos (`helpers/function-builder.ts`, caso `definition.startsWith("arn:")`):
por eso `infra/sst/worker.ts` declara a mano, en el propio `permissions` de
`Worker`, el mismo set de 5 acciones SQS que el auto-grant le daría si
`subscribe()` hubiera creado la Function. Sin esto, el Lambda poller de SQS no
puede leer/borrar mensajes de la cola y el worker nunca se dispara (el
`EventSourceMapping` se crea igual, pero con `AccessDenied` silencioso del
lado del poller — no hay error de deploy que lo delate).
