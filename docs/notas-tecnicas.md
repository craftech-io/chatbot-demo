# Notas técnicas

Comportamiento del paquete que conviene conocer antes de desplegarlo o de tocar
sus knobs. Es lo que quedó verificado en vivo, no estimaciones.

## Cold start del contenedor

El core es una imagen con LlamaIndex y sus dependencias: el import del workflow y
del adaptador de LLM es la parte pesada del arranque.

- **En ARM real (CI y AgentCore Runtime) el cold start es despreciable**: un
  primer mensaje de una conversación nueva no se distingue de un mensaje
  siguiente en la misma conversación.
- **Bajo emulación QEMU** (build o corrida de una imagen ARM64 sobre un host
  amd64) ese mismo import tarda decenas de segundos, y el boot hasta `/ping`
  puede irse al minuto. Es un artefacto de la emulación: sirve como cota
  superior, no como número representativo. No hay que dimensionar timeouts ni
  escalar el riesgo de cold start con esos valores.
- Además, AgentCore mantiene **viva la microVM de la sesión** entre
  invocaciones, así que el arranque se paga a lo sumo una vez por conversación.

**Imagen:** la base de `core/Dockerfile` tiene que coincidir con el
`requires-python` de `pyproject.toml`. Si no coincide, `uv sync` baja un segundo
intérprete managed durante el build y la imagen termina con dos runtimes adentro,
bastante más grande sin ninguna ventaja.

## Latencia percibida de un turno

El flujo es asíncrono (spec §8 v2): no hay streaming palabra por palabra, sino
una respuesta entera cuando está lista. Lo que el usuario espera es la suma de
tres cosas:

| Parte | Valor por defecto | Dónde se cambia |
|---|---|---|
| Debounce de la cola | 6 s | `delay` de `MensajesColaQueue`, en `infra/sst/mensajeria.ts` |
| Turno del agente | ver abajo | — |
| Intervalo de polling del widget | ~1,5 s | `POLL_MS_DEFECTO` en `packages/widget/src/index.ts` |

Con esos defaults, y contra una microVM caliente:

- **Turno sin tools:** ~8–13 s end-to-end (6 de ellos son el debounce).
- **Turno con tools:** ~30 s. La diferencia **no es el Gateway**: es que el
  camino con tools no streamea y hace dos llamadas al modelo — una para decidir
  la tool, otra para redactar con el resultado — más la llamada HTTP intermedia.
- Con `CLIENT_API_URL` configurada, **todo** turno pasa por el camino con tools,
  así que también sube el turno que no las necesita. Si molesta, el corte es
  decidir por heurística (o por un primer paso barato) si a ese mensaje conviene
  ofrecerle tools.

El **debounce es el knob principal** de latencia percibida en la web. Bajarlo
mejora la sensación de respuesta inmediata; el trade-off es agrupar menos los
mensajes que el usuario escribe seguidos, que es justamente lo que hace viable
un canal tipo WhatsApp.

## Cliente MCP para las tools de tenant

Las tools de tenant hablan con el AgentCore Gateway usando el **cliente MCP
oficial** (`mcp`), no el wrapper de LlamaIndex: `llama-index-tools-mcp` 0.5.0 es
incompatible con `mcp` 2.x — desempaca tres valores del transporte
streamable-http, que yieldea dos. Si se cambia alguno de los dos paquetes, la
verificación no es que las versiones *resuelvan*: es un `tools/list` real contra
un servidor.

## Conocimiento y escalamiento: qué esperar

**Ingesta.** Indexar un corpus chico (4 documentos markdown con sus sidecars de
metadata) tarda menos de un minuto de punta a punta. Bedrock no sincroniza solo:
cada vez que cambian los documentos hay que disparar un ingestion job — el
workflow `ingesta` es el camino recomendado (corre con el rol de deploy, así que
nadie necesita credenciales de Bedrock en su máquina).

**Latencia de un turno con conocimiento.** Entre 16 y 27 segundos: el agente
hace una llamada al modelo para decidir la tool, la búsqueda en la knowledge
base, y otra llamada para redactar la respuesta con los pasajes. Un turno con
escalamiento suma otra ronda del loop de tools. Está en el mismo orden que
cualquier turno con tools (ver arriba); la búsqueda vectorial en sí es la parte
rápida.

**Las citas dependen de los sidecars.** Sin `<archivo>.metadata.json`, lo único
citable es la URI del documento — es decir, el nombre del bucket interno en el
chat del usuario. Con el sidecar, el agente cita el título y ofrece el link
público. Es la diferencia entre "según s3://<bucket-de-documentos>/politica.md" y
"según la Política de devoluciones", así que vale la pena poblarlos.

**Costo del vector store en reposo:** centavos por mes con S3 Vectors, contra
cientos con OpenSearch Serverless. Es la razón por la que el conector nativo de
Confluence (que exige OpenSearch) queda fuera del núcleo.

## Portar el CI a Bitbucket Pipelines

El CI del template es GitHub Actions. Portarlo a Bitbucket tiene tres puntos duros
que no se deducen de la documentación y que cuestan una corrida cada uno:

**`options.runtime.cloud.version: 3` es obligatorio.** La imagen del core es
`linux/arm64` porque lo exige AgentCore Runtime, y en el runtime clásico de
Pipelines `buildx`, `--platform` y `--privileged` están deshabilitados en los
runners cloud: la imagen no se puede construir. La KB de Atlassian sobre builds
multi-arquitectura dice que hacen falta runners self-hosted — eso describe el
runtime clásico, no v3. Runtime v3 tampoco monta el Docker CLI, así que hay que
instalarlo en el step junto con buildx y `binfmt --install arm64`.

**`sst install` necesita `--stage`.** En el runner de Bitbucket el comando corta
con `No stage specified` al terminar de bajar pulumi y bun, antes de llegar al
typecheck — `.sst/stage` es gitignoreado y ahí no existe. En GitHub Actions **no**
pasa: el mismo comando sin `--stage` corre bien (verificado en corridas reales de
este repo), y no pudimos reproducir el fallo en local ni borrando `.sst/` ni sin
`USER`. Qué diferencia hay entre los dos runners quedó sin determinar, así que el
`--stage` explícito va en los dos: es una línea y saca la inferencia del medio.

**La trust policy del rol solo puede condicionar por `aud` y `sub`.** Bitbucket
emite claims propios (`branchName`, `repositoryUuid`, `commitSha`) y se ven en el
payload del token, pero IAM no los resuelve como claves de condición: la condición
evalúa a falso y devuelve `AccessDenied: Not authorized to perform
sts:AssumeRoleWithWebIdentity`, indistinguible de una policy mal escrita. El `sub`
es `{repositoryUuid}:{stepUuid}`, así que se acota el repo con `StringLike` y
`{<uuid>}:*` (las llaves son parte del valor).

Para diagnosticar un `AccessDenied` de OIDC, el dato que discrimina está en
CloudTrail: si el evento trae `userIdentity.type: WebIdentityUser` con el
principal completo, STS validó la firma del token y el problema es de
autorización — eso descarta de una el thumbprint, el audience y el provider.

## Observabilidad: qué se ve y qué se prende

### Prerequisito de cuenta: búsqueda de transacciones

Las trazas del agente no aparecen en CloudWatch hasta que la cuenta tiene
habilitada la búsqueda de transacciones de X-Ray. Se activa **una vez por cuenta
y región**, igual que habilitar los modelos en Bedrock:

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs
aws xray get-trace-segment-destination        # Status debería decir ACTIVE
```

No lo hace el stack a propósito: es configuración de cuenta, y si un stack la
declara cuando ya está activa —o cuando otro stage ya la declaró— el deploy
corta con `AlreadyExists`. Quien quiera tenerla bajo IaC pone su stage en
`observabilidad.stageQueAdministraLaBusqueda`.

Ojo con el modo de falla: **sin este paso el deploy sigue verde** y las trazas
simplemente no aparecen en ningún lado.

El *por qué* de las tres capas está en la spec §17. Acá está el cómo: qué mirar
sin tocar nada, qué knob mueve qué, y las dos formas de pagar de más.

### Lo que ya está publicado, sin instrumentar nada

Las métricas del servicio están en CloudWatch desde el primer deploy, en el
namespace **`AWS/Bedrock-AgentCore`** (con guion — no `AWS/BedrockAgentCore`, y
buscarlo mal es la primera media hora perdida de cualquiera):

| Fuente | Métricas | Dimensión útil |
|---|---|---|
| Runtime | `Sessions`, `Invocations`, `Latency`, `Errors`, `Throttles`, `CPUUsed-vCPUHours`, `MemoryUsed-GBHours` | — |
| Gateway | las mismas + `TargetExecutionTime` | `Name=<target>___<tool>`, `Method=tools/call` |
| Memory | `Invocations`, `Latency` | `Operation` |
| Modelo (namespace `AWS/Bedrock`) | `InputTokenCount`, `OutputTokenCount` | `ModelId` (la única que hay) |

El dashboard que crea el template se arma sobre eso y nada más: resolución vs
derivación, latencia del Runtime por percentil, errores y throttles, tokens por
modelo, invocaciones por tool. No hay nada que instrumentar para que esos números
existan; sí hay que esperar tráfico, porque son métricas de invocación y un
dashboard recién desplegado está vacío por eso y no por estar mal armado.

Lo que **no** se ve así es el interior del turno: el servicio emite un solo span
por invocación (`InvokeAgentRuntime`) y nada de lo que pasa adentro. Los spans por
paso del workflow, por tool y por llamada al modelo salen de la instrumentación
del contenedor.

Aparte de las métricas, el core cierra cada turno con **una línea de log JSON**:
`sessionId`, tokens, costo estimado y si hubo escalamiento — sin el texto de la
conversación. Es lo que hace la métrica de costo consultable con Logs Insights
aunque las trazas se vayan a otro destino. Si la tarifa del modelo no se puede
resolver contra la Pricing API, la línea sale igual con el uso y sin costo: no se
inventa un precio ni se cae el turno.

### Resolución vs derivación: cómo se lee

La señal de derivación es la invocación de **nuestra propia tool**: en el Gateway,
`Invocations` con `Name=escalamiento___escalar_a_humano`. El nombre lleva el
prefijo del target y **tres** guiones bajos (el target se llama `escalamiento`, la
tool `escalar_a_humano`); con dos, la métrica no devuelve datos y parece que nadie
deriva nunca.

El denominador sale del Runtime, y cuál elegís cambia la pregunta que estás
contestando: contra `Invocations` son derivaciones por **turno**; contra
`Sessions`, por **conversación**, que es la que se le muestra a un cliente.

Tres cosas que conviene tener presentes al leer ese número:

- **Cuenta llamadas a la tool, no casos derivados.** Si el modelo la llama dos
  veces en el mismo turno, la métrica cuenta dos.
- **Mide intento, no resultado.** Sube cuando la tool se invoca, no cuando el
  escalamiento queda creado: si el webhook no está configurado o falla, la tool
  responde que no hay destino y no postea. La confirmación efectiva está en el log
  de la Lambda de la tool, que a propósito no loguea el URL del webhook (ese URL
  *es* el secreto).
- **"No derivó" no es "resolvió".** Un turno sin `escalar_a_humano` también puede
  ser alguien que se fue. Se lee como tendencia entre semanas, no como una tasa de
  éxito exacta.

Del lado de las trazas, la cadena `BFF → worker → Runtime` queda unida en una sola
porque las Lambdas del stack van con tracing activo. Sin eso la traza se corta
justo en el debounce de la cola, que es exactamente donde uno quiere mirar cuando
un mensaje "no llegó".

### El contenido de la conversación en las trazas

`observabilidad.contenidoEnTrazas` en `client.config.ts`, `false` por default. Con
el default, la infra manda al contenedor `OPENINFERENCE_HIDE_INPUTS`,
`OPENINFERENCE_HIDE_OUTPUTS`, `OPENINFERENCE_HIDE_INPUT_MESSAGES` y
`OPENINFERENCE_HIDE_OUTPUT_MESSAGES` en `true`, más
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` (que cubre el camino de
botocore por si alguien lo reactiva).

Con la redacción puesta:

- **Se va** el texto: `input.value` y `output.value` salen `__REDACTED__`. Ahí
  viajan el mensaje del usuario, la respuesta del agente, el prompt de sistema
  entero y los argumentos con los que se llamó cada tool.
- **Queda** la forma del turno: un span por paso del workflow, uno por tool con su
  `tool.name`, uno por llamada al modelo; las latencias; y **los contadores de
  tokens** (`llm.token_count.prompt`, `.completion`, `.total` y los de cache).
  O sea: redactar no cuesta la métrica de costo, que es la duda razonable antes de
  apagar algo.

Prenderlo sirve para una cosa concreta: entender por qué el agente eligió una tool
o contestó lo que contestó, con el texto delante. Lo que se paga es que la
conversación del usuario final empieza a viajar a donde apunten las trazas — y con
un destino externo eso es una decisión de residencia de datos, no una preferencia
de debugging: se toma con quien sea dueño de esos datos, no en un deploy de
viernes. Para leer conversaciones sin mover nada afuera ya está MessagesTable, que
es la fuente de verdad de la transcripción y vive en la cuenta del cliente.

Dos detalles para quien toque esto a mano: los doce `OPENINFERENCE_HIDE_*` de la
librería vienen en `False`, así que la redacción existe **porque la infra la setea
explícitamente** — no hay default seguro en el que apoyarse; y el template setea
cuatro de los doce, los que tapan el texto (el resto de la familia cubre otras
cosas, como los vectores de embeddings o los parámetros de invocación, si algún
día hacen falta).

### Apuntar las trazas a otro destino

`observabilidad.destino` es un adaptador con dos valores:

- **`"cloudwatch"`** (default): no se setea ningún endpoint y el distro de ADOT
  exporta a X-Ray. Depende de Transaction Search, que el template habilita.
- **`"otlp"`**: la infra pasa `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` y
  `OTEL_EXPORTER_OTLP_TRACES_HEADERS` al contenedor, y los dos valores salen de
  secretos, no del config commiteado:

```bash
npx sst secret set ObservabilidadOtlpEndpoint 'https://<host>/v1/traces'
npx sst secret set ObservabilidadOtlpHeaders  'Authorization=Basic <credencial>'
```

**El header lleva la credencial**: es secreto, no se loguea nunca y no se pega en
un issue ni en un mensaje. Mismo criterio que el URL del webhook de escalamiento.

Lo que **no** se mueve al cambiar el destino: los endpoints de OTLP son **por
señal**, así que mandar las trazas afuera deja las métricas de arriba y el log del
turno donde estaban, en CloudWatch y en la cuenta del cliente. El dashboard sigue
funcionando igual. Es la razón por la que la métrica que le muestra al cliente
cuánto resuelve el agente no queda atada a ningún proveedor de trazas.

Si alguna vez hace falta apuntar una señal a CloudWatch a mano, sus endpoints OTLP
nativos son **solo HTTP**, no hay gRPC: `https://xray.<region>.amazonaws.com/v1/traces`
(SigV4, y exige Transaction Search), `https://monitoring.<region>.amazonaws.com/v1/metrics`,
y `https://logs.<region>.amazonaws.com/v1/logs` (headers `x-aws-log-group` y
`x-aws-log-stream`, y el log group tiene que existir antes).

Cualquier backend que hable OTLP/HTTP entra por ese par de variables. A modo de
**ejemplo de la forma que tiene un destino así** —no como recomendación, y el
template no hospeda ninguno—: las plataformas de trazas de LLM leen el vocabulario
de OpenInference sin traducción, y cada una pide sus propios datos de ingesta.
Langfuse, por caso, recibe en `/api/public/otel`, autentica con
`Basic base64(public_key:secret_key)` y además necesita el header
`x-langfuse-ingestion-version: 4`; sin ese header la ingesta igual funciona, pero
con demoras de varios minutos. Ese es el tipo de detalle que hay que ir a buscar a
la doc del destino antes de declarar la integración rota.

### Ver los spans en local

No hace falta desplegar ni tener credenciales para ver la forma de una traza: el
exporter a consola imprime los spans por stdout.

```bash
docker build --platform linux/arm64 -f core/Dockerfile -t craftech-ai-chat-core:dev .
docker run --rm -p 8080:8080 \
  -e MODEL_ID=fake -e FAKE_LLM=1 \
  -e TRAZAS_OPENINFERENCE=1 \
  -e OTEL_TRACES_EXPORTER=console \
  -e OTEL_TRACES_SAMPLER=always_on \
  craftech-ai-chat-core:dev
```

Y contra eso, un turno cualquiera (el mismo que hace `core/smoke.sh`):

```bash
curl -sfN localhost:8080/invocations -H 'content-type: application/json' \
  -d '{"message":"hola","history":[]}'
```

En el stdout del contenedor sale un JSON por span: `ChatWorkflow.run` y
`ChatWorkflow.responder` (`CHAIN`) y, si hay tools configuradas,
`FunctionTool.acall` (`TOOL`, con `tool.name` y los argumentos). El sampler
explícito está porque el default del template muestrea bajo y en local querés ver
todas las trazas, no el 5% de ellas.

Con `FAKE_LLM=1` **no** hay span de llamada al modelo ni contadores de tokens:
no hay llamada a Bedrock que instrumentar. Para verlos hay que correr contra el
modelo de verdad (sin `FAKE_LLM`, con un `MODEL_ID` real y credenciales con
`bedrock:InvokeModel`); ahí aparecen los spans del adaptador con
`llm.token_count.*`.

### Las dos trampas de costo

**1. El sampler al 100%.** Sin un collector adelante, el default de OpenTelemetry
es capturar **todas** las trazas; AWS documenta hasta 20x de costo de ingesta
contra una configuración con muestreo. El template no se apoya en ese default:
setea `OTEL_TRACES_SAMPLER=parentbased_traceidratio` y `OTEL_TRACES_SAMPLER_ARG`
con `observabilidad.muestreo` de `client.config.ts`. Subirlo a 1 para perseguir un
bug puntual está bien; **dejarlo** en 1 es la factura del mes siguiente. Y no
confundirlo con el `IndexingPercentage` de Transaction Search: ese es el
porcentaje de spans que X-Ray indexa para poder buscarlos, es otra palanca y otro
cargo, y además es un recurso **de cuenta** — dos stages en la misma cuenta
comparten el mismo valor, así que cambiarlo no es una decisión local a un stage.

**2. `Application Signals` prendido.** El distro de ADOT lo puede activar solo;
con Transaction Search habilitado se termina pagando dos veces por el mismo span.
El template deja `OTEL_AWS_APPLICATION_SIGNALS_ENABLED=false` explícito. Si
alguien lo prende buscando el mapa de servicios, que sepa que está duplicando la
ingesta, no agregando una señal gratis.

Y una que no es de costo pero se confunde con una: ADOT auto-instrumenta
`botocore`, y eso **duplica** el span de la llamada al modelo (uno de
OpenInference con los tokens, otro de botocore sin ellos). El template lo apaga
con `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS=botocore`. Si ves dos spans por cada
llamada a Bedrock, esa variable se perdió en el camino.

### Los knobs, todos juntos

| Knob | Default | Qué mueve |
|---|---|---|
| `observabilidad.muestreo` | 0,05 | Fracción de trazas que captura el SDK (`OTEL_TRACES_SAMPLER_ARG`) |
| `observabilidad.contenidoEnTrazas` | `false` | Si el texto de la conversación viaja en los spans (las cuatro `OPENINFERENCE_HIDE_*`) |
| `observabilidad.destino` | `"cloudwatch"` | X-Ray en la cuenta del cliente, o un endpoint OTLP externo |
| Secretos `ObservabilidadOtlpEndpoint` / `ObservabilidadOtlpHeaders` | vacíos | Endpoint y credencial del destino OTLP. El header es secreto |
| `IndexingPercentage` de Transaction Search | 100 | Qué porcentaje de spans indexa X-Ray para búsqueda. Recurso de CUENTA, no de stage |

Los nombres exactos de las variables de entorno que recibe el contenedor están en
la tabla de env del core de `infra/CONTRACT.md`: eso es el contrato, esto es la
guía de operación.

### Números medidos

Un turno con búsqueda en documentos, sobre un corpus chico y con el prompt del
sistema completo, mueve del orden de **5.000 tokens de entrada y 300 de salida**,
y cuesta **unos 2 centavos de dólar**. La entrada domina el costo: es el
historial de la conversación más los pasajes recuperados. Si el costo importa,
los knobs son la cantidad de pasajes (`documentos.topK`) y el largo del prompt,
no el modelo de salida.

El costo aparece en el log de cierre de cada turno (`costoUsd`), y sale `null`
—con un warning que nombra el motivo— cuando la tarifa no se pudo resolver.
Nunca se estima con un precio inventado.

Sobre la métrica de derivación: en una ventana sin derivaciones el widget se ve
vacío, igual que si estuviera roto. Para distinguirlos, mirá el widget de
invocaciones del Gateway: si ahí llegan métricas, el tablero está sano.

## El markdown que el agente emite de verdad

El widget renderiza un subconjunto de markdown, y el subconjunto **no se elige
leyendo la especificación: se mide**. Las respuestas del agente están guardadas
en `MessagesTable`; un scan de esa tabla y un puñado de expresiones regulares
dicen qué construcciones usa de verdad este agente, con este prompt, sobre este
corpus.

En el primer despliegue real esa medición dio un orden poco intuitivo: sobre 35
respuestas, tablas y reglas horizontales aparecían más seguido (5 respuestas
cada una) que los encabezados (3), aunque lo que un usuario nota primero sea el
`#` a la vista. Bloques de código: cero. Conviene repetir la medición por
cliente antes de tocar el parser — el prompt y el dominio cambian lo que el
modelo escribe.

**Los encabezados se desplazan dos niveles** (`#` → `<h3>`, y se aplastan en
`<h6>`). El widget se monta dentro de la página del cliente, que ya tiene su
`<h1>`: un "## Compras" que el modelo escribe en una burbuja de chat es
contenido subordinado, no una sección del documento anfitrión. El tamaño visual
lo decide el CSS y es independiente del nivel semántico.

**Los colores de los bloques salen de `color-mix()` sobre `--cc-texto-resp`**,
nunca de un literal. Así una tabla o una cita siguen la marca del host sin que
haya que declarar una custom property por elemento. Hay un test que falla si
aparece un color fijo en una regla concreta.

**El criterio para agregar una construcción es que no se pierda información.**
Lo que no se soporta se ve como texto: molesto, pero completo. El caso que hubo
que arreglar era el contrario — un ítem de lista indentado no matcheaba el
patrón de ítem y el renderizador lo descartaba con un `continue`, así que el
sub-ítem **desaparecía** de la respuesta. Por eso la verificación no es solo
"¿se ve bien?" sino un diff de palabras entre el markdown crudo y el DOM
renderizado, sobre las respuestas reales; lo único que puede faltar es el
marcador numérico de un `<ol>`, que lo genera el navegador.

En modo local, el mensaje "formato" dispara un escenario del mock que usa todos
los bloques a la vez: sirve para mirar el render sin desplegar.
