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
público. Es la diferencia entre "según s3://…-documentos-bctazkrk/politica.md" y
"según la Política de devoluciones", así que vale la pena poblarlos.

**Costo del vector store en reposo:** centavos por mes con S3 Vectors, contra
cientos con OpenSearch Serverless. Es la razón por la que el conector nativo de
Confluence (que exige OpenSearch) queda fuera del núcleo.
