# craftech-ai-chat — Diseño del paquete base de chatbot + agent core

**Fecha:** 2026-08-19
**Estado:** diseño aprobado, pendiente de plan de implementación

## 1. Objetivo

Construir un **paquete base reusable** (repo template) que entregue a un cliente un
chatbot que interactúa con su propia aplicación: chat con memoria y streaming,
respuestas con un LLM, RAG sobre su documentación y tools de lectura contra su API.

El paquete es el producto que se le entrega a todo cliente que llega buscando
asesoría de IA. **El diseño no incorpora nada específico de ningún cliente**: su
negocio se refleja únicamente en la parametrización (`client.config.ts`), no en la
arquitectura.

Reusa un stack y patrones ya probados en producción (AgentCore, proxy SSE, Gateway
MCP, KB sobre S3 Vectors, guardrails), que es la ventaja real: la diferencia entre
entregar en semanas o en meses.

## 2. Decisiones tomadas

| Decisión | Elección | Razón |
|---|---|---|
| Entregable | Propuesta/spec (fase 1) → template (fase 2) | Validar arquitectura con equipo y cliente antes de escribir código |
| Superficies | Widget embebible **y** app standalone, mismo backend | El widget es lo vendible; el standalone es demo comercial y entorno de prueba |
| Runtime del agent core | Python en contenedor BYOC sobre AgentCore Runtime | LlamaIndex Workflows es Python-first: durabilidad, checkpointing, human-in-the-loop y streaming de eventos maduros. El Runtime es un contenedor: el lenguaje es indistinto para la infra |
| Framework del harness | LlamaIndex Workflows | El loop del agente es un grafo de pasos y eventos explícito, no una caja negra: testeable paso a paso |
| Alcance v1 | Chat + LLM + memoria + streaming + guardrails + tools de lectura + RAG | Es lo que el cliente de asesoría IA pide primero |
| IaC | SST v4 como sabor de referencia; Terraform como segundo | Máxima velocidad reusando patrones ya probados; el contrato explícito habilita los otros sabores |
| Despliegue | En la cuenta AWS del cliente | Él paga su consumo de Bedrock. Es lo que explica por qué el sabor de IaC importa: se le entrega a él |
| Repos | Un template propio, y un repo por cliente que lo clona | Un repo con el nombre de un cliente conteniendo el producto genérico sería una confusión permanente |
| Enfoque general | AgentCore completo, con adaptador de LLM y capa de config agnóstica | El lock-in a Memory/Gateway se acepta a conciencia: reemplazarlos después es un módulo, no el producto |

`craftech-ai-chat` es el nombre de trabajo del template; renombrarlo no afecta ninguna
decisión de este documento.

## 3. Alcance

**Dentro del v1:** conversación con memoria persistente y streaming; guardrails de
entrada y salida; tools de lectura de dos clases (tenant y usuario); RAG con citas;
widget embebible; app standalone; topes de uso; observabilidad básica; IaC en SST;
contrato de infra documentado.

**Fuera del v1**, con punto de extensión definido pero sin implementar: acciones de
**escritura** sobre la app del cliente con human-in-the-loop; memoria long-term
(resúmenes y preferencias); el sabor Pulumi; la modalidad de despliegue hosteada en la
cuenta del proveedor; proveedores de LLM distintos de Bedrock; canales fuera de la web
(WhatsApp, Slack).

## 4. Arquitectura

Un stack por cliente, en su cuenta AWS. **No hay multitenancy de organizaciones**: el
aislamiento es la cuenta, lo que simplifica todo — no hay `orgId` atravesando cada
query.

```
   App del cliente                      Standalone del paquete
   ┌──────────────┐                     ┌──────────────┐
   │ widget (SDK) │                     │ web (React)  │
   └──────┬───────┘                     └──────┬───────┘
          │  POST /chat  (SSE)                 │
          └──────────────┬─────────────────────┘
                         ▼
              ┌────────────────────────┐
              │ BFF (Lambda, tRPC)     │  valida el principal, arma el
              │ + proxy SSE            │  payload confiable, audita
              └───────────┬────────────┘
                          │ InvokeAgentRuntime (IAM, streaming)
                          ▼
      ┌─────────────────────────────────────────────┐
      │ AgentCore Runtime — BYOC :8080              │
      │   /ping · /invocations                      │
      │   ┌───────────────────────────────────┐     │
      │   │ LlamaIndex Workflow (el harness)  │     │
      │   │  eventos: Start→Guard→Agent→Tool  │     │
      │   │           →Guard→Stream           │     │
      │   └───────────────────────────────────┘     │
      └───┬──────────┬───────────┬──────────┬───────┘
          │          │           │          │
          ▼          ▼           ▼          ▼
      Bedrock    AgentCore   AgentCore   Bedrock KB
      Converse    Memory     Gateway     (S3 Vectors)
      (+Guardrail)(historial) (MCP)      RAG
                                 │
                                 ▼
                          API del cliente
```

**Sobre el aislamiento en ejecución:** el contenedor es solo el formato de entrega.
AgentCore Runtime corre la imagen dentro de una **microVM de Firecracker dedicada por
sesión**, con kernel, memoria y filesystem propios, que se destruye y sanitiza al
cerrarse la sesión. La microVM se mantiene **viva entre invocaciones** de la misma
sesión, ruteada por `runtimeSessionId`.

Eso tiene dos consecuencias de diseño:

- El cold start se paga en el primer mensaje de una conversación, no en cada mensaje.
- **El `runtimeSessionId` se deriva del principal verificado**
  (`sha256(userId + ":" + hilo)`), nunca se toma del request. Como la microVM sigue
  viva y con estado, un id tomado del browser permitiría a un usuario alcanzar la
  microVM caliente de otro.

## 5. Componentes

| Componente | Responsabilidad | Depende de |
|---|---|---|
| `core/` (Python, contenedor) | El harness: workflow de LlamaIndex con un paso por responsabilidad. Es la única pieza que un cliente con otro IaC recibe intacta | Bedrock, AgentCore Memory/Gateway, KB. Config por env/SSM — **nunca `Resource`** |
| `packages/bff/` — Messages Backend (TS, Lambda) | Frontera de confianza: valida el token, aplica topes y guardrail de entrada, escribe y lista mensajes (`MessagesTable`) y encola el turno. **Sin lógica de agente y sin invocar al Runtime** | SQS, Dynamo, guardrail |
| `packages/worker/` (TS, Lambda) | El único que invoca AgentCore: consume la cola FIFO, hace el debounce contra el store, agrega los mensajes del usuario en un turno, invoca el Runtime y escribe la respuesta en el store | SQS, AgentCore Runtime, MessagesTable |
| `packages/widget/` (TS) | Bundle embebible: un `<script>` + `mount()`. Sin React expuesto, para no chocar con el stack del cliente. Renderiza el markdown de las respuestas del agente (encabezados, párrafos, listas —anidadas incluidas—, tablas, citas, reglas, bloques de código, negrita, itálica, tachado, código inline y links) construyendo nodos con `createElement`: **nunca interpreta HTML del modelo**, y solo `http`/`https`/`mailto` pueden ser un link | BFF, `/chat-token` del cliente |
| `packages/web/` (React) | Standalone: misma UI de chat con login propio (Cognito). Demo comercial y entorno de prueba | BFF, Cognito |
| `packages/shared/` (TS) | Contratos y registros centrales compartidos entre BFF, widget y web | — |
| `infra/sst/` | Sabor de referencia del IaC | Contrato de `infra/CONTRACT.md` |

Cada unidad se entiende sin leer las internas de las otras: el BFF no sabe qué modelo
usa el core, y el core no sabe qué IaC lo desplegó.

## 6. Identidad y autenticación

No se toca la auth del cliente. Él expone un endpoint propio, `/chat-token`, que para
el usuario ya logueado en su app emite un JWT corto (5–15 min) con `sub`, `email` y
los claims de scope que decida, más — cuando quiera tools de usuario — un `actToken`
para actuar en su nombre contra su API.

**En el caso más común es un solo token.** Si la API del cliente ya se consume con
JWTs de acceso, el mismo token responde las dos preguntas — quién es el usuario y con
qué permiso leer sus datos — y `/chat-token` devuelve ese. Los dos tokens separados son
el caso especial: solo hacen falta si su API usa otro esquema de auth.

El widget pide ese token y lo envía al BFF, que lo valida:

- **Con OIDC:** por firma pública contra el JWKS del cliente (`CLIENT_JWKS_URL`),
  pineando además `iss` y `aud` (`CLIENT_TOKEN_ISSUER`/`CLIENT_TOKEN_AUDIENCE`): la
  firma sola no alcanza si el mismo emisor firma para varias apps. Es el camino
  preferido: no hay secreto compartido.
- **Sin OIDC:** por HMAC con un secreto en Secrets Manager (`CLIENT_HMAC_SECRET_ARN`).

El standalone usa Cognito propio y produce un principal equivalente. El BFF tiene así
**un solo concepto de principal con dos emisores**. Para las demos alcanza un User Pool
de Cognito con un app client propio: el id del pool y del app client son configuración
del stage, nunca literales en el código.

Implementar `/chat-token` es la única tarea de desarrollo que se le pide al cliente.

## 7. Tools: dos clases y una regla dura

> **Una tool que devuelve datos de un usuario específico no puede pasar por una
> credencial compartida.**

|  | Tools de tenant | Tools de usuario |
|---|---|---|
| Devuelven | lo mismo para todos: docs, catálogo, FAQ, cálculos | datos del usuario final: sus pedidos, su cuenta |
| Camino | **AgentCore Gateway** (MCP), target OpenAPI o Lambda | el core las llama **directo por HTTP** |
| Credencial | fija, configurada por target del gateway *(corregido 2026-08-26: la API real la ata al target, no al gateway)* | `actToken` del usuario, propagado en el payload confiable |

La razón de no mandar todo al Gateway: su auth outbound es por gateway, no por
request. Meter ahí datos per-usuario es una fuga entre usuarios esperando a pasar.

Para las tools de tenant basta el OpenAPI del cliente y las tools salen casi gratis;
el adaptador Lambda queda como escape hatch cuando su API no es REST limpia.

## 8. Flujo de un mensaje (arquitectura v2 — mensajería asíncrona, 2026-08-25)

**Decisión que motivó la v2:** el producto es multicanal (WhatsApp y Facebook no
tienen streaming), así que el streaming web se sacrifica a cambio de una arquitectura
de mensajes desacoplada: el frontend/backend de mensajes de un lado, el chatbot
(cola + worker + AgentCore) del otro.

```
widget → /chat-token (backend del cliente)      → JWT + actToken
widget → Messages Backend POST /mensajes        → valida firma, topes,
                                                   guardrail de entrada
       → escribe el mensaje (rol=user) en MessagesTable
       → encola {conversationId, msgId} en SQS FIFO (delay = ventana de debounce)
widget → Messages Backend GET /mensajes?desde=… → polling (~1,5 s) hasta que
                                                   aparece la respuesta
SQS    → Worker Lambda (grupo FIFO = conversationId → serial por conversación)
       → debounce: ¿soy el ÚLTIMO mensaje del usuario? si no, descarto
         (el job del último procesa todos juntos)
       → agrega los mensajes del usuario desde la última respuesta
       → InvokeAgentRuntime (IAM, mismo contrato de siempre)
core   → Memory + Workflow + ConverseStream(guardrail sync)  [SIN CAMBIOS]
worker → consume el stream completo, escribe la respuesta (rol=assistant)
         en MessagesTable
```

La frontera de confianza no se mueve: el Messages Backend valida el principal y todo
lo que entra a la cola es confiable. Los canales nuevos (WhatsApp, Facebook) serán
adapters que POSTean al mismo Messages Backend — el lado del chatbot no los conoce.

**El debounce**, que es lo que hace viable WhatsApp (la gente escribe en varios
mensajes seguidos): cola FIFO con `MessageGroupId = conversationId` y delay a nivel
cola; al consumir, el worker verifica contra el store si su mensaje sigue siendo el
último del usuario — si llegó uno más nuevo, descarta y deja que el job de ese último
agregue todo en un solo turno del agente.

## 9. Guardrails

Repartidos a propósito:

- **Entrada: en el BFF**, con `ApplyGuardrail`. Es barato y corta antes de pagar
  Runtime y modelo.
- **Salida: en el core**, con `guardrailConfig` en `ConverseStream` en modo `sync`, de
  modo que Bedrock evalúe cada chunk **antes** de emitirlo. Aplicarlo a mano sobre
  texto ya streameado llegaría tarde.

Política de fallo **fail-open**: si el guardrail falla, se loguea y el chat sigue. Se
prefiere disponibilidad a censura dura.

Los mensajes de bloqueo viven en un registro compartido, no como literales.

## 10. Memoria

AgentCore Memory con el par `(actorId, sessionId)` — `actorId` es el usuario,
`sessionId` el hilo. Solo short-term en v1; los resúmenes long-term quedan como
extensión con su punto de enganche en `core/src/agent/memory.py`.

**Dos stores con roles distintos (v2):** `MessagesTable` es la fuente de verdad de la
transcripción para las UIs y los canales (el "listado por conversation_id" que hace
posible el polling y, a futuro, WhatsApp); AgentCore Memory sigue siendo la memoria
DEL AGENTE (lo que el modelo ve como historial). Conviven a propósito: la duplicación
es el precio de que el lado del chatbot y el de mensajes sean independientes.
`SESSIONS_TABLE` conserva el índice de hilos (metadata).

## 11. Conocimiento (RAG)

Bedrock Knowledge Base **VECTOR sobre S3 Vectors**, con data source **S3**: el cliente
sube documentos a un bucket y el data source los indexa. Embeddings con Titan Text v2
(1024 dimensiones, distancia coseno).

Por qué S3 Vectors y no OpenSearch: en reposo cuesta centavos por mes contra cientos, y
el cliente paga su propia cuenta — un vector store que cuesta más que el resto del
stack junto hace invendible el producto. El precio de esa elección está declarado:
S3 Vectors hace **búsqueda semántica, no híbrida**, y no expone número de página.

Se expone al agente como tool de tenant **`consultar_documentos`**, un target Lambda
del Gateway (§7) que llama `Retrieve` — **no `RetrieveAndGenerate`**: recupera pasajes
y el agente sintetiza, así el workflow controla la respuesta y puede **citar la
fuente**. En asesoría IA una respuesta sin fuente no sirve. La tool devuelve, por
pasaje, el texto, el score, la URI del documento y los atributos que el cliente
haya declarado en el sidecar de metadata (típicamente `titulo` y `url`, que es lo
que hace citable la respuesta en lenguaje humano y no con la ruta del bucket).

Lo citable de forma fiable es la **URI del documento**, no el título ni la página: la
metadata que Bedrock inyecta trae ids de chunk y de data source, nada legible. El
título se aporta con un sidecar `<archivo>.metadata.json` junto a cada documento
(`metadataAttributes`, con `includeForEmbedding` para que sume al recall).

**Otras fuentes** (Confluence, SharePoint, web) existen como data sources nativos pero
hoy están en preview y **solo funcionan con OpenSearch Serverless**, así que quedan
fuera: contradicen la decisión de costo. Para ingerir de un sistema externo sin pagar
ese peaje, el camino es un data source `CUSTOM` alimentado por un ingestor propio
(`IngestKnowledgeBaseDocuments`), que además permite adjuntar título y deep-link
reales. Es una extensión por cliente, no parte del núcleo.

**Ingesta:** no existe sincronización automática en Bedrock — hay que disparar
`StartIngestionJob`. Se documenta el comando; agendarlo (EventBridge Scheduler con el
target universal `aws-sdk:bedrockagent:startIngestionJob`, sin Lambda intermedia) es
una mejora opcional por cliente.

**Trampas de IaC a respetar:** el storage y la configuración vectorial de la KB son
`createOnly` — cambiar de vector store o de modelo de embeddings **recrea la KB** (y
`ChunkingConfiguration` recrea el data source). Y `DataDeletionPolicy` va en `RETAIN`:
con el default, borrar el stack puede dejar la KB en `DELETE_UNSUCCESSFUL`.

## 11.1. Escalamiento a un humano

Cuando el agente no encuentra la respuesta en los documentos, **no inventa y no escala
solo**: dice que no lo encontró y ofrece derivar a una persona. El ticket se crea
únicamente si el usuario acepta. Esa doble regla vive en el prompt (§11.2), y la
ejecución en la tool de tenant **`escalar_a_humano`** (target Lambda del Gateway), que
recibe un resumen del caso y devuelve la referencia y el link del ticket **cuando el
destino los informa** — si el destino confirma la recepción sin devolver un
identificador, la tool lo dice en vez de inventar una referencia con formato de ticket
que soporte no podría buscar. La tool NO recibe la identidad del usuario: el agente
solo puede pasarle lo que tiene en la conversación, así que el resumen es lo que
permite retomar el caso.

El destino es un **adaptador**: la interfaz de la tool es genérica y cada cliente
enchufa el suyo. El adaptador de referencia es un **webhook** (POST con el payload del
escalamiento a una URL configurable), que sirve tal cual o como puente hacia lo que el
cliente ya usa. Los adaptadores de sistemas concretos (Jira Service Management, Jira,
Slack, email) se implementan en el clon del cliente, donde existen las credenciales
para probarlos: un adaptador sin verificar en el template es peor que ninguno, porque
parece listo.

Nota de auth para quien implemente el adaptador de Atlassian: los API tokens con Basic
auth vencen anualmente por política de Atlassian. El camino sostenible es OAuth 2.0
`client_credentials` con una service account, cacheando el access token de 60 minutos y
renovándolo con margen. Y crear el ticket por la API de service desk, no por la de
Jira core, es lo que lo hace aparecer como pedido en el portal con su SLA.

**El token del sistema externo nunca toca el core:** vive en la Lambda detrás del
Gateway. El agente pide "escalá esto" y no ve credencial alguna.

## 11.2. Política de comportamiento (prompt del sistema)

El agente necesita instrucciones explícitas, no solo tools: no inventar sobre el
negocio del cliente, citar la fuente cuando responde desde los documentos, y ofrecer
derivar cuando no encuentra la respuesta. Eso es el prompt del sistema, y es
**configuración de cliente** (el tono y las reglas de uno no son los de otro): vive en
`client.config.ts`, no hardcodeado en el core.

## 12. Límites de costo

El cliente paga su propio Bedrock, así que el paquete trae topes de mensajes por
usuario y por sesión en Dynamo (`LIMITS_TABLE`), aplicados en el BFF antes de invocar
el Runtime. Sin eso, la primera factura sorpresa se come la relación.

## 13. Portabilidad: contrato de infra y adaptadores

El multi-sabor no se abstrae con código: **se declara**. `infra/CONTRACT.md` lista los
recursos que cualquier sabor debe crear y las variables que debe inyectar — al core y
al BFF, según cuál las consuma. Cambiar de SST a Terraform es reimplementar esa lista,
nada más:

```
MODEL_ID · GUARDRAIL_ID/VERSION · MEMORY_ID · GATEWAY_URL
KB_ID · SESSIONS_TABLE · LIMITS_TABLE · PROMPT_PARAM_PATH (SSM)
CLIENT_API_BASE_URL · CLIENT_JWKS_URL | CLIENT_HMAC_SECRET_ARN
```

**Dos adaptadores, y solo dos:**

1. **Config.** El core lee todo por `core/src/agent/config.py` (env + SSM, con cache y
   TTL) y no conoce SST. El BFF, que en el sabor de referencia sí puede usar
   `Resource`, lo hace **únicamente** dentro de `packages/bff/src/config/resource.ts`;
   `env.ts` cubre cualquier otro sabor. Un archivo por sabor, y el resto del código
   nunca sabe cuál está activo. Así se cumple la regla del workspace (usar `Resource`,
   no `process.env`) sin acoplar el producto a SST.
2. **LLM.** `core/src/agent/llm.py`: Bedrock Converse por defecto, con la puerta
   abierta a la API de Anthropic directa.

## 14. Estructura del repositorio

```
craftech-ai-chat/
├── core/                   Python — el agent core (contenedor BYOC)
│   ├── src/agent/
│   │   ├── workflow.py     el harness: eventos y pasos del Workflow
│   │   ├── steps/          guard_in · agent · tools · stream
│   │   ├── llm.py          adaptador de modelo
│   │   ├── memory.py       AgentCore Memory (actorId, sessionId)
│   │   ├── tools/          gateway_mcp · user_http · knowledge
│   │   └── config.py       env/SSM — única puerta a la config
│   ├── server.py           /ping + /invocations :8080
│   ├── Dockerfile
│   └── tests/
├── packages/
│   ├── bff/                tRPC + proxy SSE  (src/config/ = adaptador)
│   ├── widget/             bundle embebible, sin React expuesto
│   ├── web/                standalone React
│   └── shared/             contratos + registros centrales
├── infra/
│   ├── sst/                sabor de referencia
│   └── CONTRACT.md         qué debe producir cualquier sabor
├── client.config.ts        ← lo único que se toca por cliente
└── docs/
```

`client.config.ts` concentra la parametrización del cliente: dominio, modelo, prompt,
tools declaradas, OpenAPI de su API, JWKS o secreto HMAC, y topes de uso. Todo lo
demás es el paquete.

## 15. Manejo de errores

El principio: nada tumba la conversación. Cada falla se traduce a algo que el agente
pueda contarle al usuario.

| Falla | Respuesta |
|---|---|
| JWT expirado | 401 con código; el widget renueva contra `/chat-token` y reintenta una vez |
| Tope de uso excedido | 429 con mensaje al usuario, no error técnico |
| Guardrail bloquea la entrada | mensaje canónico de política del registro — es una respuesta, no un error |
| Guardrail interviene la salida | se corta el stream con el mensaje de política; el turno queda registrado |
| Tool del cliente 5xx / timeout | el workflow **no muere**: devuelve al modelo un resultado de error estructurado para que lo explique al usuario. Timeout duro y tope de reintentos por tool |
| El worker falla al invocar el Runtime | escribe un mensaje del asistente con el texto humano de error en el store — el usuario ve una respuesta, no un silencio; el turno NO se persiste en Memory *(v2)* |
| El polling no encuentra respuesta a tiempo | el widget corta a los ~90 s con el mensaje genérico; el mensaje del usuario queda en el store *(v2)* |
| Throttling de Bedrock | backoff con jitter; si persiste, mensaje al usuario |
| Guardrail caído | fail-open: se loguea y el chat sigue |

## 16. Testing

Que el harness sea un Workflow explícito y no un loop opaco es lo que lo hace
testeable: cada paso se prueba por sus eventos, con LLM y tools falsos.

- **`core/`**: unitarios por paso del workflow (guard_in, agent, tools, stream) con
  dobles de LLM y de tools.
- **Contract tests de tools**: cada tool declarada en `client.config.ts` se valida
  contra el OpenAPI del cliente.
- **`bff/`**: validación de token en ambos emisores (JWKS y HMAC), aplicación de
  topes, passthrough SSE.
- **e2e contra fakes**: "pregunta → responde con cita" y "pregunta → llama tool de
  usuario", contra fakes locales de los servicios de AWS.
- **Smoke de deploy**: `/ping` más una invocación real por stage.

**Entorno local mockeado — regla del proyecto (2026-08-20):** toda capacidad se
entrega con un modo local sin nube que permita verla funcionando y probar su UI/UX,
no solo sus tests. El chat, con un `/chat` mock en el demo-client que habla el
contrato SSE real (deltas con delay, y escenarios de error activables); la memoria
(2b), con un store en memoria; las tools (2c), contra una API del cliente simulada;
el RAG (2d), contra un índice de ejemplo con documentos de muestra. **El plan de cada
fase incluye esa tarea, y una capacidad sin su modo local no se considera
terminada.**

## 17. Observabilidad

En asesoría IA la observabilidad es parte del producto, no telemetría interna: el
cliente que paga su propio Bedrock quiere ver desde el día 1 cuánto resuelve el
agente, cuánto deriva y cuánto le cuesta.

Se apoya en tres capas distintas, y conviene no confundirlas porque tienen costos y
dueños distintos.

**1. Métricas del servicio, que ya existen sin instrumentar nada.** AgentCore publica
en CloudWatch (namespace `AWS/Bedrock-AgentCore`) `Sessions`, `Invocations`, `Latency`,
`Errors` y `Throttles` del Runtime, y del Gateway las mismas **con una dimensión por
nombre de tool**. De ahí sale la métrica que justifica el producto —consultas resueltas
contra derivadas a una persona— con una expresión matemática, sin una línea de código:
la señal es la invocación de nuestras propias tools (`escalar_a_humano` llamada =
derivada). Los tokens por modelo salen gratis de `AWS/Bedrock`, agregados por `ModelId`.
El template trae un **dashboard** con eso.

**2. Trazas del interior del agente, que sí hay que instrumentar.** El servicio emite un
solo span por invocación (`InvokeAgentRuntime`) y nada de lo que pasa adentro; los spans
del Gateway por tool y los de Memory existen, pero cuelgan de una traza que tiene que
**arrancar en el contenedor**: sin instrumentar, quedan apagados. La instrumentación es
automática (OpenTelemetry + OpenInference sobre el dispatcher de LlamaIndex) y no toca
el código del agente: rinde un span por paso del workflow, uno por tool call con sus
argumentos, y uno por llamada al modelo con los contadores de tokens.

**3. Costo por conversación**, que es lo único que exige código propio: el adaptador del
LLM tiene que dejar de descartar el uso de tokens que devuelve Bedrock (en el camino de
streaming el chunk que los trae es justo el que se filtra por venir sin texto), y las
tarifas salen de la Pricing API — nunca hardcodeadas.

**El destino de las trazas es un adaptador, con default local.** Se exporta OTLP por
HTTP, y el default es CloudWatch, que ya está en la cuenta del cliente y no agrega
proveedores ni costo fijo. Un cliente que use una plataforma de observabilidad de LLM
(Langfuse y equivalentes) la enchufa por configuración —endpoint y credencial— sin
cambiar código, porque los spans salen en un vocabulario que esas plataformas leen
nativamente. Los endpoints de OTLP son **por señal**, así que mandar las trazas afuera
no mueve las métricas del punto 1: la métrica del producto sigue viviendo en la cuenta
del cliente.

**Las trazas llevan el contenido de la conversación, y eso es una decisión de datos.**
Las instrumentaciones de LLM mandan prompts y respuestas por default. Como el producto
se apoya en que los datos del cliente son suyos, el template va **redactado por
default**: se emiten la estructura del turno, las latencias y los contadores de tokens,
y el texto solo si el cliente lo habilita explícitamente. Habilitarlo cuando el destino
es un proveedor externo es una decisión de residencia de datos, no una preferencia de
debugging.

**Y el muestreo se declara.** Sin collector, el default de OTel es capturar el 100% de
las trazas, lo que multiplica el volumen de ingesta; el template arranca con un
porcentaje bajo y configurable.

## 18. Fases de entrega

- **Fase 1**: esta propuesta y este spec.
- **Fase 2** — el template:
  - **2a** Esqueleto vertical (streaming). ✔ desplegada.
  - **2b** Memoria, guardrails y topes de uso. ✔ desplegada.
  - **2c** *(v2, 2026-08-25)* Mensajería asíncrona: Messages Backend + SQS FIFO +
    worker con debounce; primera tanda con el widget (polling) como único canal;
    los canales (WhatsApp, Facebook) entran después como adapters, cada uno su fase corta.
    ✔ desplegada. *(mini-fase 2026-08-26: verificación OIDC con Cognito en vivo —
    JWKS con issuer/audience pineados; ledger propio.)*
  - **2d** Tools de tenant vía Gateway y tools de usuario vía HTTP con `actToken`.
    *(decisión 2026-08-26: el `actToken` viaja como campo del mensaje de SQS —
    cifrado en reposo por la cola, NUNCA persistido en MessagesTable; el worker lo
    releva al runtime en el payload confiable. Riesgo aceptado: un mensaje que agote
    reintentos cae a la DLQ con un token ya vencido o por vencer.)*
  - **2e** Standalone y docs de instalación *(reordenada 2026-08-26; antes 2f)*:
    la app propia con login sobre pool Cognito del template — el camino OIDC ya
    quedó pavimentado por la mini-fase Cognito.
  - **2f** RAG: KB sobre S3 Vectors, con citas *(reordenada 2026-08-26; antes 2e)*.
- **Fase 3**: sabor Terraform, que es lo que realmente valida el contrato.

Cada fase de la 2 es desplegable y demostrable por sí sola.

## 19. Riesgos y validaciones pendientes

1. **Cobertura de AgentCore en Terraform.** AgentCore Harness/Memory/Identity y S3
   Vectors se crean con el provider `aws-native` (Cloud Control API), no con el
   classic. El equivalente en Terraform es `hashicorp/awscc`. **Hay que validar esa
   cobertura antes de prometerle el sabor Terraform a un cliente.** Es la validación
   de mayor impacto comercial del proyecto.
2. **Cold start del contenedor** *(cerrado por medición)*. LlamaIndex y sus
   dependencias son pesadas, pero la microVM de la sesión se mantiene viva entre
   invocaciones: el arranque se paga solo en el primer mensaje de cada conversación, y
   en ARM real es despreciable. Ver `docs/notas-tecnicas.md`.
3. **Disponibilidad regional de AgentCore** en la región donde opera el cliente.
4. **Dependencia de `/chat-token`.** Si el cliente no puede implementarlo, las tools
   de usuario no existen y el alcance cae a tools de tenant más RAG. Hay que
   detectarlo en el kickoff, no en la implementación.

## 20. Reglas heredadas del workspace

- **Regla de oro de parametría**: antes de escribir un literal, buscar si ya existe un
  registro. Duplicar un literal entre archivos significa moverlo a `shared`.
- Serverless only. Todo por IaC. Región y cuenta se derivan, nunca se hardcodean.
- Máximo 400 líneas por archivo. Organización feature-based.
- Producto en español, sin i18n. Locale, timezone y moneda desde un registro.
- Deploys por CI/CD.
- Toda capacidad nueva incluye su modo local/mockeado (ver §16) — se puede probar la
  UI/UX sin cuenta de AWS.
