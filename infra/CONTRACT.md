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
| Lambda del BFF + Function URL | encolá los mensajes en MessagesTable y MensajesCola (spec §8, async) | permisos: `bedrock:ApplyGuardrail` (scoped al `guardrailArn`); `dynamodb:GetItem`+`dynamodb:UpdateItem` sobre SessionsTable y sobre LimitsTable (vía `include` en los `sst.Linkable` de `infra/sst/tablas.ts` — un Linkable pelado NO hereda el auto-grant de `sst.aws.Dynamo`); `dynamodb:Query`+`dynamodb:PutItem` sobre MessagesTable y `sqs:SendMessage` sobre MensajesCola (vía `include` en `infra/sst/mensajeria.ts`, mismo patrón) |
| Secreto del emisor de tokens | verificar el token del cliente | JWKS URL o secreto HMAC |
| Guardrail de Bedrock | filtro de contenido entrada+salida | mensajes desde packages/shared |
| AgentCore Memory | historial de conversación | (actorId, sessionId) |
| SessionsTable (DynamoDB) | índice de hilos por usuario | pk: userId, sk: sessionId |
| LimitsTable (DynamoDB) | contadores de tope por usuario y período | pk: userId, sk: periodo |
| MessagesTable (DynamoDB) | fuente de verdad de la transcripción (spec §8) | pk: conversationId, sk: orden (`${ts ISO}#${msgId}` — el orden lexicográfico ES el cronológico) |
| MensajesCola (SQS FIFO) | serializa el procesamiento de mensajes por conversación; el delay de cola es la ventana de debounce | `MessageGroupId = conversationId`; `delaySeconds` 6 (hardcodeado en la infra, ver las notas del sabor SST abajo); redirige a MensajesDlq tras 3 intentos; `visibilityTimeout` 6 minutos — **invariante: siempre ≥ 2x el `timeout` del worker** (hoy 3 minutos, `infra/sst/worker.ts`), o SQS re-entrega el mensaje mientras el primer invoke sigue corriendo y el segundo `procesarMensaje` concurrente pasa el debounce (nada cambió) → doble invocación al agente, doble respuesta, sin error ni DLQ que lo delate |
| MensajesDlq (SQS FIFO) | destino de mensajes que MensajesCola no pudo entregar tras 3 intentos | también FIFO — SQS no permite que una cola FIFO redirija a una DLQ estándar (ni al revés) |
| Lambda del worker (`Worker`) | consume MensajesCola (batch size 1) y corre el turno del agente en background: debounce + agregación de pendientes + invoke a AgentCore Runtime + escritura de la respuesta en MessagesTable (spec §8) | permisos: `bedrock-agentcore:InvokeAgentRuntime` (ARN del Runtime propio + sub-recurso `runtime-endpoint/*`); `sqs:ChangeMessageVisibility`+`sqs:DeleteMessage`+`sqs:GetQueueAttributes`+`sqs:GetQueueUrl`+`sqs:ReceiveMessage` sobre MensajesCola (a mano — `subscribe` por ARN no los auto-otorga, ver las notas del sabor SST abajo); `dynamodb:Query`+`dynamodb:PutItem` sobre MessagesTable heredado de `messagesTableLink` (mismo Linkable que usa el BFF, `include` en `infra/sst/mensajeria.ts`); timeout 3 minutos (el turno puede tardar tanto como el invoke completo al Runtime) |

## Variables que recibe el core (contenedor)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MODEL_ID` | sí | id del modelo o inference profile de Bedrock |
| `AWS_REGION` | no (default `us-east-1`) | región de Bedrock |
| `GUARDRAIL_ID` | no | si falta, el core corre sin guardrail — la inyecta la infra |
| `GUARDRAIL_VERSION` | no | requerida si hay `GUARDRAIL_ID` — la inyecta la infra |
| `MEMORY_ID` | no | sin ella, el core usa el history del payload (modo local/tests) |
| `GATEWAY_URL` | no | endpoint MCP del AgentCore Gateway (`gatewayUrl` del recurso). Vacía o ausente ⇒ el agente corre sin tools de tenant. El core firma cada request con SigV4 (rol del Runtime), así que el rol necesita `bedrock-agentcore:InvokeGateway` |
| `CLIENT_API_URL` | no | base URL de la API del cliente para las tools de usuario (sin barra final). Vacía o ausente ⇒ el agente corre sin tools de usuario. **Es una frontera de confianza:** a esta URL se le manda el `actToken` del usuario final como `Authorization: Bearer` en cada llamada de tool, así que solo puede apuntar a la API del cliente — una URL mal apuntada exfiltra credenciales de usuarios |

## Variables que recibe el BFF

| Variable | Obligatoria | Descripción |
|---|---|---|
| `CLIENT_JWKS_URL` | una de las dos | JWKS del emisor de tokens del cliente |
| `CLIENT_HMAC_SECRET` | una de las dos | secreto compartido, si el cliente no tiene OIDC. **Precedencia: si ambas están seteadas gana HMAC** (deliberado: es el modo del primer arranque). Migrar a OIDC exige vaciar esta (`sst secret set ClientHmacSecret ""`) — si queda seteada, el secreto compartido sigue emitiendo identidades válidas |
| `CLIENT_TOKEN_ISSUER` | no | `iss` exigido al token en modo JWKS (OIDC estricto, p. ej. Cognito). `""` ⇒ no se exige el claim. En SST: secret `ClientTokenIssuer`, vía linkable (`Resource.ClientAuth.issuer`) |
| `CLIENT_TOKEN_AUDIENCE` | no | `aud` exigido al token en modo JWKS (el client_id de la app). `""` ⇒ no se exige el claim. En SST: secret `ClientTokenAudience`, vía linkable (`Resource.ClientAuth.audience`) |
| `GUARDRAIL_ID` | no | id del Guardrail, vía linkable en SST (`Resource.Guardrail.id`) |
| `GUARDRAIL_VERSION` | no | versión del Guardrail, vía linkable en SST (`Resource.Guardrail.version`) |
| `SESSIONS_TABLE` | sí | nombre de la tabla de sesiones, vía linkable en SST (`Resource.SessionsTable.name`) |
| `LIMITS_TABLE` | sí | nombre de la tabla de límites, vía linkable en SST (`Resource.LimitsTable.name`) |
| `LIMITE_DIARIO` | sí | número máximo de llamadas por usuario por día (default: 50) |
| `LIMITE_POR_SESION` | sí | número máximo de turnos por sesión (default: 40) |
| `MESSAGES_TABLE` | sí | nombre de la tabla de mensajes, vía linkable en SST (`Resource.MessagesTable.name`) |
| `MENSAJES_COLA_URL` | sí | URL de la cola FIFO de mensajería, vía linkable en SST (`Resource.MensajesCola.url`) |
| `DEBOUNCE_SEGUNDOS` | no (default 6) | informativo para logs/tests: el delay real de debounce vive en `delaySeconds` de la cola SQS, no en esta variable |

En el sabor SST estas variables se resuelven por linking y las lee
`packages/bff/src/config/resource.ts`. En los demás sabores se inyectan como
variables de entorno y las lee `packages/bff/src/config/env.ts` (se crea con
el segundo sabor de IaC — todavía no existe).

## Variables que recibe el worker

| Variable | Obligatoria | Descripción |
|---|---|---|
| `AGENT_RUNTIME_ARN` | sí | ARN del AgentCore Runtime a invocar, vía linkable en SST (`Resource.AgentRuntime.arn`) — leído directo en `packages/worker/src/lambda.ts` (el worker no tiene un módulo de config separado, a diferencia del BFF) |

El BFF NO recibe este ARN y no debe leerlo: el invoke al Runtime lo hace el
worker. **Regla del sabor SST:** el proxy `Resource` de sst lanza al leer un
recurso que la Function no tiene en su `link`, y `packages/bff/src/config/
resource.ts` resuelve la config POR REQUEST — leer un linkable que la infra no
linkeó no falla en el deploy ni en el typecheck, mata en runtime TODOS los
requests de esa Function, no solo los que usan ese dato.

## El viaje del actToken (spec §6 y §18)

Token con el que el core llama a la API del cliente EN NOMBRE del usuario
final. El BFF lo resuelve en `postMensaje` como `actToken = principal.actToken
?? tokenCrudo`: si el emisor mandó el claim `act_token` en el chat-token, gana
ese; si no, viaja el mismo token que el usuario presentó (el caso común — su
API ya lo consume).

Contratos de forma (los produce/consume esta cadena, nadie más los renegocia):

| Tramo | Forma |
|---|---|
| Body del mensaje en MensajesCola (BFF → worker) | `{ conversationId, msgId, userId, actToken? }` — el campo es opcional: un mensaje sin él (un canal que no lo provea, un mensaje ya encolado) sigue funcionando |
| Payload de `InvokeAgentRuntime` (worker → core) | `{ message, userId, sessionId, actToken? }` — el worker hace passthrough del campo del evento; si el evento no lo trae, el payload va SIN el campo |

Reglas duras:

- El `actToken` vive SOLO en el body de la cola (cifrado en reposo en SQS) y
  en el payload del invoke. **NUNCA se escribe en DynamoDB** (MessagesTable ni
  ninguna otra tabla) y **NUNCA se loguea** — hay tests que lo pinean en
  `packages/bff/src/mensajes/api.test.ts` y `packages/worker/src/turno.test.ts`.
- Si el turno agrupa varios mensajes pendientes (debounce), vale el `actToken`
  del evento del job que se procesa — el del último mensaje del usuario, que
  es el más fresco de la ráfaga.

## Streaming SSE: solo en el camino interno

En el camino browser ↔ BFF no hay streaming: el navegador hace POST, el BFF
encola el mensaje y responde 200 enseguida, y el widget hace polling con
`GET /mensajes` hasta que la respuesta aparece en MessagesTable. La Lambda del
BFF no lleva `streaming: true`.

El SSE vive en el camino interno worker ↔ AgentCore: el contenedor del core
emite frames SSE que el worker parsea con `packages/worker/src/ndjson.ts`,
agrega los pendientes y escribe la respuesta final en MessagesTable. La latencia
percibida es debounce + turno del agente + intervalo de polling.

## Notas del sabor SST

Hechos no obvios de SST/Pulumi que este sabor necesita. Casi ninguno lo detecta
un typecheck: cada uno tiene su propio modo de fallar en el deploy o, peor, en
silencio.

### Providers y globals

- Los recursos de Cloud Control viven en el global ambiental `awsnative`
  (paquete `@pulumi/aws-native`), no en una propiedad `.native` del global `aws`
  — ese es el provider classic (`@pulumi/aws`). El namespace `bedrockagentcore`
  (`Runtime`, `Memory`, `Gateway`, `GatewayTarget`) existe solo en Cloud
  Control; el Guardrail, en cambio, es del provider classic
  (`aws.bedrock.Guardrail`).
- `@pulumi/docker-build` NO tiene global ambiental (a diferencia de
  `aws`/`awsnative`/`sst`): `infra/sst/runtime.ts` lo importa explícito. Va
  además declarado como provider `"docker-build"` en `sst.config.ts`, para que
  `sst install` lo baje a `.sst/platform` en cualquier máquina, CI incluido.
- El provider `aws` tipa `region` como `string`, pero `aws-native` lo tipa como
  el literal `Region`: el valor que sale del entorno hay que castearlo
  (`as awsnative.Region`), sin cambiarlo.
- Las versiones de los providers están pineadas en `sst.config.ts`
  (`@pulumi/aws@7.32.0`, `@pulumi/aws-native@1.68.0`) para que el bundle sea
  determinístico entre local y CI.
- `.sst/platform` es gitignoreado: sin un `sst install` previo, `sst.config.ts`
  no resuelve sus globals (`aws`, `awsnative`, `$interpolate`, ...) y el
  typecheck de infra falla por scaffolding faltante, no por un error real. Por
  eso el workflow de deploy corre `npx sst install` antes de typechequear.

### Nombres de outputs y de acciones IAM

- `awsnative.bedrockagentcore.Runtime` no expone un `.arn` genérico: el output
  con el ARN se llama `agentRuntimeArn`.
- `aws.getRegionOutput().name` está deprecado a favor de `.region` (mismo
  valor).
- `aws.bedrock.Guardrail` expone `guardrailArn`: con eso se acota
  `bedrock:ApplyGuardrail` al Guardrail propio, en vez de armar el ARN a mano o
  dejar `"*"`.
- Los nombres de acción IAM del data plane de Memory
  (`bedrock-agentcore:CreateEvent`, `bedrock-agentcore:ListEvents`) no aparecen
  en los `.d.ts` de `aws`/`aws-native`: no hay nada que los valide en tiempo de
  build y un typo sale como `AccessDenied` en runtime.

### Nombres de componentes

Los nombres de componentes SST son únicos en TODA la app, y un `sst.Linkable`
ocupa un nombre igual que un componente de recurso. Por eso los recursos llevan
sufijo cuando su clave de `Resource` ya está tomada: `SessionsTableDb`,
`LimitsTableDb`, `MessagesTableDb` y `MensajesColaQueue` conviven con los
linkables `SessionsTable`, `LimitsTable`, `MessagesTable` y `MensajesCola`. La
colisión no la ve ningún typecheck: sale como `VisibleError: Component name X is
not unique` en runtime de Pulumi, al desplegar. (`Worker` no necesita sufijo:
ningún linkable usa esa clave.)

### Lo que un Linkable NO otorga

Un `sst.Linkable` pelado (solo `properties`) NO hereda el auto-grant de permisos
que da linkear el componente directo (`sst.aws.Dynamo`, `sst.aws.Queue`): el
permiso scoped va a mano en `include: [sst.aws.permission({ actions, resources
})]`. Sin eso la Lambda queda sin permisos y el `AccessDenied` se lo traga el
fail-open de `topes.ts`/`indice.ts`.

### `Queue.subscribe` y los permisos de SQS

`subscribe()` acepta `string | FunctionArgs | FunctionArn` — no una instancia de
`sst.aws.Function`, aunque un `Output<string>` con el ARN sí entra por la rama
`string`. De qué se le pasa depende quién otorga los permisos:

- con un handler o un `FunctionArgs`, `QueueLambdaSubscriber` crea la Function
  por dentro y le auto-otorga `sqs:ChangeMessageVisibility`,
  `sqs:DeleteMessage`, `sqs:GetQueueAttributes`, `sqs:GetQueueUrl` y
  `sqs:ReceiveMessage` sobre la cola — pero esa Function queda con un nombre
  auto-hasheado.
- con un ARN no crea nada ni otorga nada. `infra/sst/worker.ts` toma este camino
  (quiere un componente propio llamado `Worker`), así que declara ese mismo set
  de 5 acciones a mano en sus `permissions`. Sin ellas el `EventSourceMapping`
  se crea igual y el poller de SQS falla con `AccessDenied` silencioso: el
  worker nunca se dispara y no hay error de deploy que lo delate.

El subscriber en sí se nombra solo (`${componenteDeLaCola}Subscriber${hash}`):
nunca colisiona y no hay que elegirle un nombre.

### Nombres físicos de las colas FIFO

SST agrega el sufijo `.fifo` al nombre físico autogenerado, pero SOLO si el
nombre no vino seteado. Sin `transform.queue.name` —que es la única forma de
fijar un nombre físico, porque `QueueArgs` no tiene campo `name` propio— el
nombre real es `${app}-${stage}-<nombre-lógico-del-componente>-${random8}.fifo`,
que no es determinístico. Da igual para el producto: ni el BFF ni el worker
hardcodean el nombre, lo obtienen del linkable (`Resource.MensajesCola.url`). Si
alguna vez hace falta un nombre fijo —para referenciar la cola desde fuera de
SST— va por `transform.queue.name`, y ahí el `.fifo` hay que escribirlo a mano.
