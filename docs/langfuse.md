# Trazas del agente en Langfuse

No hace falta código nuevo. El core ya instrumenta con
`openinference-instrumentation-llama-index`, que es **la instrumentación que
Langfuse recomienda para LlamaIndex**, y el destino de trazas es un adaptador de
una sola variable (`observabilidad.destino` en `client.config.ts`). Pasar a
Langfuse es configuración.

## El paso a paso

**1. Crear el proyecto en Langfuse** y sacar el par de claves (`pk-lf-…` /
`sk-lf-…`).

**2. Armar el header de autenticación.** Acá está la trampa:

```bash
AUTH=$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 -w0)
echo "Authorization=Basic%20${AUTH},x-langfuse-ingestion-version=4"
```

El `%20` **no es opcional**. La documentación de Langfuse muestra
`Authorization=Basic <base64>` con un espacio literal, y con ese valor el SDK de
OpenTelemetry para Python **descarta el header completo** (`Header format
invalid! Header values in environment variables must be URL encoded`). El
exporter sale sin credenciales, Langfuse responde 401 y el error queda en un log
del contenedor que nadie mira: deploy verde y ninguna traza. El padding `==` del
base64, en cambio, es indiferente.

`infra/sst/runtime.ts` tiene una guarda que corta el synth si el secreto trae un
espacio literal, para que esto no pueda pasar en silencio.

**3. Setear los dos secretos** (por stage):

```bash
npx sst secret set ObservabilidadOtlpEndpoint \
  "https://cloud.langfuse.com/api/public/otel/v1/traces" --stage <stage>
npx sst secret set ObservabilidadOtlpHeaders \
  "Authorization=Basic%20${AUTH},x-langfuse-ingestion-version=4" --stage <stage>
```

El endpoint es **por señal** (`/v1/traces`): mover el de trazas no mueve las
métricas ni los logs, que siguen en CloudWatch. Por región: `cloud.langfuse.com`
(EU), `us.cloud.langfuse.com`, `jp.cloud.langfuse.com`, o el propio si es
self-hosted (v3.22.0+). Langfuse no soporta gRPC; el core ya manda
`http/protobuf`.

**4. En `client.config.ts`:**

```ts
observabilidad: {
  destino: "otlp",
  contenidoEnTrazas: true,   // ver abajo: sin esto Langfuse sirve de poco
  muestreo: 1,               // ver abajo
  ...
}
```

**5. Desplegar.** Un `sst secret set` no re-despliega solo.

## Las dos decisiones que hay que tomar antes

**`contenidoEnTrazas`.** Viene en `false`, y con eso las trazas llegan a Langfuse
**sin los prompts ni las respuestas**: se ve la forma del turno (qué tools se
llamaron, latencias, tokens) pero no lo que se dijo. O sea, casi nada de lo que
hace útil a Langfuse. Ponerlo en `true` es una **decisión de residencia de
datos**, no un ajuste de verbosidad: la conversación de los usuarios finales sale
de la cuenta de AWS y queda en un servicio de terceros. Se acuerda con el cliente
y su política de privacidad tiene que contemplarlo. Con Langfuse self-hosted en
la cuenta del cliente el problema no existe.

**`muestreo`.** Está en `0.05`: Langfuse recibiría 1 de cada 20 conversaciones,
que en una demo se lee como "no funciona". Para un PoC va `1`; para producción se
baja. Ojo con el costo: exportar el 100% de los spans es la forma más rápida de
multiplicar la factura de observabilidad (ver `docs/notas-tecnicas.md`).

## Qué se ve y qué no

En Langfuse se ve **el interior del turno del agente**: el Runtime, sus llamadas
al modelo, las tools y los tokens. El destino OTLP solo afecta al contenedor del
agente.

Lo que **no** se ve ahí: la cadena `BFF → cola → worker → Runtime`. Las Lambdas
tracean a X-Ray y se siguen mirando en CloudWatch. Tampoco el costo por turno,
que el worker calcula y escribe como línea JSON en sus logs.

Langfuse mapea los atributos de OpenInference a su modelo, pero su propia
documentación avisa que algunos pueden quedar en el `metadata` de la observación
en vez de mapearse a los campos de usage y costo. Si el costo por observación
importa, hay que verificarlo con trazas reales antes de prometerlo.

## Verificar que llegó

1. Mandar un mensaje al chat.
2. En Langfuse, la traza aparece en segundos. Si no aparece: los logs del
   contenedor del Runtime en CloudWatch dicen si el exporter falló (401 = header
   mal armado; revisar el `%20`).
3. Con `contenidoEnTrazas: false` la traza llega pero los campos de entrada y
   salida dicen `REDACTED`. Eso es la redacción funcionando, no un error.

## Verificado localmente, sin claves

El camino completo se puede probar sin cuenta de Langfuse, con
`scripts/receptor-otlp.py` como destino:

```bash
python3 scripts/receptor-otlp.py /tmp/recibido.json &

AUTH=$(printf 'pk-lf-demo:sk-lf-demo' | base64 -w0)
env MODEL_ID=fake FAKE_LLM=1 PYTHONPATH="$PWD/core/src" TRAZAS_OPENINFERENCE=1 \
    OTEL_SERVICE_NAME=<slug>-agente OTEL_TRACES_EXPORTER=otlp \
    OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none \
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf \
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
    OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic%20${AUTH},x-langfuse-ingestion-version=4" \
    OTEL_TRACES_SAMPLER=parentbased_traceidratio OTEL_TRACES_SAMPLER_ARG=1 \
    AGENT_OBSERVABILITY_ENABLED=false \
    uv run opentelemetry-instrument python core/server.py

curl -sN localhost:8080/invocations -H 'content-type: application/json' \
  -d '{"message":"hola","history":[]}'
```

Resultado de esa corrida, que es la evidencia de que la configuración es correcta:

| Qué | Resultado |
|---|---|
| POST a `/v1/traces` | 2, `application/x-protobuf` |
| Header `authorization` | `Basic cGstbGYt…` — llega **decodificado**, el `%20` ya convertido en espacio |
| `x-langfuse-ingestion-version` | `4` |
| Texto del usuario en el cuerpo, sin redacción | **viaja** |
| Texto del usuario, con las `OPENINFERENCE_HIDE_*` | **no viaja**; aparece `REDACTED` |

La última fila es la que sirve para la conversación con el cliente: con
`contenidoEnTrazas: false` se puede afirmar, con evidencia, que la conversación
no sale de su cuenta.
