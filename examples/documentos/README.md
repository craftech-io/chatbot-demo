# Documentos del cliente (corpus de ejemplo)

Este directorio es el **corpus ficticio** con el que se prueba el conocimiento
(RAG) del agente: cuatro documentos de una empresa inventada, **Ciclos Aurora**
(accesorios de ciclismo, la misma tienda de fantasía que sirve la demo API de
`examples/api-cliente`). En un deploy para un cliente real esto **no se sube**:
se reemplaza por sus documentos, con sus títulos y sus URLs.

Nada de acá es dato de nadie: los precios, los horarios, la dirección y los
dominios (`*.example`, un TLD reservado) son inventados a propósito.

| Documento | Título (metadata) | De qué habla |
|---|---|---|
| `politica-devoluciones.md` | Política de devoluciones | plazo de 30 días, condiciones, reintegro |
| `horarios-atencion.md` | Horarios de atención | atención al cliente, local, taller |
| `garantia.md` | Garantía | plazos por producto, qué cubre y qué no |
| `envios.md` | Envíos y plazos de entrega | costos, plazos, entregas fallidas |

## Los sidecars `.metadata.json`

Junto a cada documento va un `<archivo>.metadata.json` con el **mismo nombre
más el sufijo**, en el **mismo prefijo del bucket**. Bedrock lo reconoce como
metadata del documento (no lo indexa como un documento más) y este es su
formato real:

```json
{
  "metadataAttributes": {
    "title": {
      "value": { "type": "STRING", "stringValue": "Política de devoluciones" },
      "includeForEmbedding": true
    },
    "url": {
      "value": {
        "type": "STRING",
        "stringValue": "https://ayuda.ciclosaurora.example/devoluciones"
      },
      "includeForEmbedding": false
    }
  }
}
```

Por qué existen: sin ellos, lo único que la tool `consultar_documentos` puede
citar es la **URI del documento** en S3 — la metadata que Bedrock inyecta sola
trae ids de chunk y de data source, nada legible (ver `docs/diseno.md` §11). El
título y el link legibles se aportan acá, y la tool los pasa al agente como
`titulo` y `url` de cada pasaje (los nombres de atributo que reconoce con
nombre propio son exactamente `title` y `url`; cualquier otro atributo que
declares viaja en `metadata`). Es lo que hace posible la regla "citá con el
título" del `promptSistema`.

- `includeForEmbedding: true` mete el valor del atributo **en el texto que se
  embedea**, así que suma al recall: una pregunta por "devoluciones" matchea
  mejor un chunk cuyo embedding incluye el título. Va en `title`.
- `includeForEmbedding: false` es metadata pura: vuelve en la respuesta de
  `Retrieve` para poder citarla, pero no ensucia el embedding. Va en `url`.
- Los tipos válidos de `value` son `STRING` (`stringValue`), `NUMBER`
  (`numberValue`), `BOOLEAN` (`booleanValue`) y `STRING_LIST`
  (`stringListValue`).

## Disparar la ingesta

Bedrock no sincroniza solo: subir un documento al bucket no lo indexa. Hay dos
formas de disparar el ingestion job:

- **Desde CI (recomendado):** el workflow `ingesta` (Actions → ingesta → Run
  workflow) lo dispara con el rol de deploy y espera el resultado. Nadie
  necesita credenciales de AWS en su máquina.
- **A mano**, si tenés permisos de Bedrock Agent en la cuenta: los comandos de
  abajo.


## Subir el corpus y disparar la ingesta

Bedrock **no sincroniza solo**: subir un archivo al bucket no lo indexa. Hay
que correr un ingestion job cada vez que el corpus cambia (agregar, editar o
borrar un documento).

Los tres identificadores salen del deploy (o de la consola):

```bash
aws bedrock-agent list-knowledge-bases
aws bedrock-agent list-data-sources --knowledge-base-id <knowledge-base-id>
```

Desde este directorio:

```bash
# 1. Subir los documentos y sus sidecars (el README no es parte del corpus).
aws s3 cp . s3://<bucket-de-documentos>/ --recursive --exclude "README.md"

# 2. Indexar.
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <knowledge-base-id> \
  --data-source-id <data-source-id>

# 3. Seguir el job (statistics dice cuántos documentos entraron o fallaron).
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id <knowledge-base-id> \
  --data-source-id <data-source-id> \
  --ingestion-job-id <ingestion-job-id>
```

Agendar el paso 2 (EventBridge Scheduler con el target universal
`aws-sdk:bedrockagent:startIngestionJob`, sin Lambda de por medio) es una
mejora opcional por cliente, no parte del template.

## Verlo sin AWS

El modo local del chat (`examples/demo-client`, `npm run dev`) trae las dos
capacidades mockeadas, con textos que citan **estos** documentos: el chip
`documento` responde con la cita de la política de devoluciones, y `escalar`
arranca el flujo de consentimiento (dice que no lo encontró y pregunta si
deriva; contestale "sí" y crea el escalamiento). Si el corpus cambia, hay que
actualizar esos textos en `examples/demo-client/mock.mjs` — mock y realidad
cuentan la misma historia.
