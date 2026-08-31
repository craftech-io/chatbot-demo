# Adoptar el template en el repo de un cliente

De una cuenta de AWS vacía a un chat andando. El orden importa: varios pasos son
prerequisitos de cuenta que el stack **no** hace a propósito, y su modo de falla
no siempre es un deploy rojo — a veces es un deploy verde al que le falta algo.

Lo que se edita del repo es `client.config.ts`. El resto de los pasos son cosas
que se hacen **fuera** del repo: en la cuenta de AWS, en GitHub y en la consola.

Referencias: `README.md` (qué campo define qué), `infra/CONTRACT.md` (el contrato
de infraestructura), `docs/notas-tecnicas.md` (expectativas operativas).

---

## 0. Prerequisitos de cuenta (una vez por cuenta y región)

Ninguno de estos lo hace el stack. Los tres primeros son bloqueantes.

### 0.1 Habilitar el modelo en Bedrock

El modelo de `client.config.ts` tiene que estar habilitado en **la cuenta y la
región del deploy**. Se hace desde la consola de Bedrock, en *Model access*.

```bash
aws bedrock list-foundation-models --query 'modelSummaries[?contains(modelId, `claude`)].modelId'
```

Con un inference profile (los `us.`), el modelo tiene que estar habilitado en
las regiones hermanas del profile, no solo en la del deploy.

Modo de falla: el deploy sale verde y el primer mensaje devuelve `AccessDenied`
de Bedrock desde adentro del contenedor.

### 0.2 Búsqueda de transacciones de X-Ray

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs
aws xray get-trace-segment-destination        # Status: ACTIVE
```

Modo de falla: **el deploy sigue verde** y las trazas no aparecen en ningún
lado. El detalle y el porqué de que esto no esté en el stack están en
`docs/notas-tecnicas.md`, "Prerequisito de cuenta: búsqueda de transacciones".

Si ya está activa y un stack la declara, el deploy corta con `AlreadyExists`;
por eso `observabilidad.stageQueAdministraLaBusqueda` viene en `""`.

### 0.3 Rol de deploy con OIDC para GitHub Actions

Los dos workflows (`deploy.yml`, `ingesta.yml`) asumen un rol vía OIDC: no hay
claves de acceso en ningún lado. Hace falta el proveedor OIDC de GitHub en la
cuenta (`token.actions.githubusercontent.com`) y un rol cuya trust policy acote
`sub` al repo del cliente:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<cuenta>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:*" }
  }
}
```

**Sobre los permisos del rol**: el stack toca ECR, Lambda, SQS, DynamoDB, IAM
(crea roles), S3, S3 Vectors, Bedrock (`bedrock-agent` y `bedrock-agentcore`),
CloudWatch Logs, X-Ray y SSM (donde SST guarda los secretos), más el bucket de
state de SST. El template se desplegó con un rol amplio: **acotarlo a una policy
mínima es trabajo del cliente y no está hecho acá.** Si el cliente exige menor
privilegio, la lista de recursos de `infra/CONTRACT.md` es el inventario a
cubrir; conviene derivarla de un deploy real con CloudTrail, no a mano.

El ARN del rol va en el repo del cliente como secret de GitHub
**`DEPLOY_ROLE_ARN`**. Es el único secret de GitHub que necesita el template.

### 0.4 Región

`AWS_REGION` está fijo en `us-east-1` en los dos workflows (`env:` arriba de
todo) y también en `client.config.ts`. Si el cliente despliega en otra región,
**se cambia en los tres lugares**: el env de cada workflow pisa al config.

---

## 1. Clonar y elegir el slug

```bash
git clone <este-repo> <repo-del-cliente> && cd <repo-del-cliente>
git remote set-url origin <repo-del-cliente-en-github>
npm ci && npx sst install
```

Después, en `client.config.ts`, el campo que no se puede cambiar de opinión
después:

```ts
slug: "acme-chat",
```

El `slug` es el prefijo de **todos** los nombres físicos (repo ECR, Guardrail,
Gateway, Runtime, Memory, vector bucket). Kebab-case, corto — el nombre del
Gateway es `<slug>-gw-<stage>` y el servicio lo limita a 48 caracteres.
`infra/sst/nombres.ts` valida la forma en synth.

**Cambiarlo sobre un stack ya desplegado recrea los recursos.** Se elige una vez.

---

## 2. Configurar el cliente

Todo en `client.config.ts`; cada campo está documentado en su propio comentario.
Lo que sí o sí se toca:

| Campo | Por qué se toca |
|---|---|
| `slug` | El paso 1 |
| `modelo`, `region` | Tienen que coincidir con lo habilitado en 0.1 y 0.4 |
| `promptSistema` | **El default habla de "la empresa" en genérico.** Acá va el nombre del cliente, el tono y qué está y qué no está en alcance |
| `origenesCors` | Los dominios del cliente en vez de `["*"]` |
| `topes` | El cliente paga su propio Bedrock: sin topes, la primera factura sorpresa se come la relación |

Lo que suele quedar como está: `retencionMemoriaDias`, `documentos.topK` y todo
`observabilidad` (5% de muestreo, sin contenido de conversación, a CloudWatch).

Borrar del clon lo que es del template y no del cliente:

```bash
rm -rf examples/documentos    # corpus ficticio de demo
```

`examples/demo-client/` y `examples/api-cliente/` conviene dejarlos hasta que el
cliente tenga su propia integración andando: son la forma de probar el flujo
completo sin depender de su app.

---

## 3. Primer deploy

Push a `main` dispara `deploy.yml`. **El primer deploy tarda** (~20-30 min): el
build de la imagen ARM64 corre bajo QEMU en un runner x86.

Dos fallas conocidas del primer deploy en una cuenta nueva:

- **Propagación de IAM al crear la Knowledge Base.** Bedrock valida el rol de
  ejecución antes de que IAM lo haya propagado y el create falla. **Reintentar
  el workflow lo resuelve**; no es un bug del template.
- **`AlreadyExists` en TransactionSearch**, si se saltó el paso 0.2 y algún
  stage quedó con `stageQueAdministraLaBusqueda` seteado.

Al terminar, el deploy publica los outputs (`.sst/outputs.json`, gitignoreado):
`runtimeArn` y `repoCore`. La URL del BFF sale de la consola de Lambda (Function
URL) o del state de SST.

---

## 4. Secretos del stack

Van por **stage** y con SST, no en el repo (el config se commitea):

```bash
npx sst secret set ClientJwksUrl "https://<idp>/.well-known/jwks.json" --stage <stage>
npx sst secret set ClientTokenIssuer "https://<idp>/" --stage <stage>
npx sst secret set ClientTokenAudience "<client-id>" --stage <stage>
```

El BFF verifica el token del usuario final contra el emisor del cliente. Hay dos
modos y **si están configurados los dos, gana HMAC**: para migrar de HMAC a
JWKS hay que vaciar explícitamente el otro.

```bash
npx sst secret set ClientHmacSecret "" --stage <stage>
```

Opcionales, con default `""` (sin setearlos el deploy no corta):

| Secreto | Para qué |
|---|---|
| `EscalamientoWebhookUrl` | Destino del POST de `escalar_a_humano`. **El URL es el secreto** (estos webhooks llevan el token en el path); sin setearlo la tool responde que no hay destino configurado y no postea |
| `ObservabilidadOtlpEndpoint` / `ObservabilidadOtlpHeaders` | Solo con `observabilidad.destino: "otlp"`. **El header lleva la credencial** |

Un `sst secret set` no re-despliega solo: hace falta un deploy para que el valor
llegue al recurso.

---

## 5. Documentos y primera ingesta

El bucket lo crea el stack con nombre autogenerado. La forma exacta de
descubrirlo, derivada del propio stack en vez de adivinar el nombre:

```bash
kb=$(aws bedrock-agent list-knowledge-bases \
  --query "knowledgeBaseSummaries[?name=='<slug>-conocimiento-<stage>'].knowledgeBaseId | [0]" --output text)
ds=$(aws bedrock-agent list-data-sources --knowledge-base-id "$kb" \
  --query 'dataSourceSummaries[0].dataSourceId' --output text)
aws bedrock-agent get-data-source --knowledge-base-id "$kb" --data-source-id "$ds" \
  --query 'dataSource.dataSourceConfiguration.s3Configuration.bucketArn'
```

En `<stage>` va el stage **saneado**, que es el que entra en los nombres físicos:
para los stages normales (minúsculas y guiones) es idéntico al que se pasa por
`--stage`. Los otros nombres siguen el mismo patrón: el Gateway es
`<slug>-gw-<stage>` y el dashboard `<slug>-observabilidad-<stage>`.

Se suben los documentos del cliente (con sus sidecars `.metadata.json` si se
quieren filtros) y se indexa. **Bedrock no sincroniza solo**: subir un archivo no
lo indexa.

```bash
aws s3 cp <dir-documentos> s3://<bucket>/ --recursive
```

Para indexar, el workflow `ingesta` (Actions → ingesta → Run workflow) hace el
`start-ingestion-job` y espera el resultado con el mismo rol OIDC, así nadie
necesita credenciales de admin en su máquina. Se corre **cada vez que el corpus
cambia**. El formato de los documentos y los sidecars está en
`examples/documentos/README.md`.

---

## 6. Montar el widget

El widget se sirve desde el sitio del cliente y necesita dos cosas: la URL del
BFF y un token del usuario final emitido por el IdP del cliente (el mismo cuyo
JWKS se configuró en el paso 4). `examples/demo-client/README.md` tiene la
integración completa, incluido el modo local mockeado para trabajar la UI sin
tocar AWS.

---

## 7. Verificar

En orden, porque cada uno depende del anterior:

1. **El contenedor vive**: el deploy corre su propio smoke (`/ping`) contra la
   imagen recién pusheada; si el job salió verde, está.
2. **Un turno de punta a punta**: mandar un mensaje desde el demo-client y ver
   la respuesta. Si vuelve un error genérico, los logs del worker dicen por qué.
3. **La búsqueda anda**: preguntar algo que solo esté en los documentos. Si
   responde de memoria o dice que no sabe, la ingesta no corrió o no completó.
4. **El escalamiento anda**: pedir explícitamente hablar con una persona y
   confirmar. Sin `EscalamientoWebhookUrl` seteado la tool avisa que no hay
   destino — que también es una respuesta correcta.
5. **Se ve**: el dashboard `<slug>-observabilidad-<stage>` en CloudWatch. Las
   métricas están sin instrumentar nada; las **trazas** solo si se hizo el paso
   0.2.
6. **El costo por turno**: cada turno cerrado deja una línea JSON en los logs
   del worker con `tokensEntrada`, `tokensSalida` y `costoUsd`. La referencia
   medida está en `docs/notas-tecnicas.md`, "Números medidos".

---

## Lo que este template no trae y el cliente probablemente quiera

- **El adaptador del escalamiento.** `escalar_a_humano` postea a un webhook
  genérico. Conectarlo a Jira Service Management, Zendesk o lo que use el
  cliente es código nuevo en su clon.
- **La ingesta desde su gestor documental.** El data source es un bucket de S3.
  Confluence, Drive o SharePoint necesitan un conector aparte.
- **Canales que no sean web** (WhatsApp, Messenger).
- **Una app standalone**: hoy el chat se embebe en el sitio del cliente.

---

## Escalamiento a Jira Service Management

La tool `escalar_a_humano` tiene dos adaptadores y elige solo: si los cinco
secretos de JSM están seteados crea el pedido en el portal de soporte; si falta
alguno, cae al webhook genérico (`EscalamientoWebhookUrl`).

**Auth por OAuth 2.0 `client_credentials` con una service account**, no API token
con Basic auth: los API tokens de Atlassian vencen cada año por política y el
escalamiento se caería sin aviso.

1. En *Atlassian Administration → Directory → Service accounts*, crear la service
   account y su credencial OAuth 2.0. Anotar el `client_id` y el `client_secret`.
2. Darle el scope **`write:servicedesk-request`** y acceso al proyecto del service
   desk.
3. Sacar el `cloudId` de `https://<sitio>.atlassian.net/_edge/tenant_info`.
4. Sacar el `serviceDeskId` y el `requestTypeId` del service desk
   (`GET /rest/servicedeskapi/servicedesk` y
   `GET /rest/servicedeskapi/servicedesk/{id}/requesttype`).
5. Setear los cinco secretos y desplegar:

```bash
npx sst secret set JsmClientId     "<client_id>"     --stage <stage>
npx sst secret set JsmClientSecret "<client_secret>" --stage <stage>
npx sst secret set JsmCloudId      "<cloud_id>"      --stage <stage>
npx sst secret set JsmServiceDeskId "<id>"           --stage <stage>
npx sst secret set JsmRequestTypeId "<id>"           --stage <stage>
```

El adaptador manda `summary` y `description`. **Si el tipo de pedido tiene otros
campos obligatorios, JSM responde 400/422** y la tool le dice al usuario que no
pudo derivar el caso: los campos requeridos se consultan con
`GET /rest/servicedeskapi/servicedesk/{sdId}/requesttype/{rtId}/field`.

Con OAuth la API no se llama en el dominio del sitio sino en
`api.atlassian.com/ex/jira/<cloudId>`. El token dura 60 minutos y el adaptador lo
cachea entre invocaciones, renovándolo 5 minutos antes de vencer.

---

## Documentos desde Confluence

El corpus se sincroniza con una Lambda propia (`packages/bff/src/ingesta/`) que
lee la API de Confluence y escribe las páginas en el bucket de la Knowledge Base.
Un cron la corre **una vez por día** y dispara la re-indexación.

No usamos el conector nativo de Bedrock: está en preview y exige OpenSearch
Serverless (~US$350/mes contra ~US$0,015 de S3 Vectors). Escribiendo a S3 el
vector store no cambia.

Es un **refresh completo e idempotente**, no un sync incremental: con cientos de
páginas cuesta menos que mantener un cursor y no puede desincronizarse. Una
página borrada en Confluence se borra del bucket — si no, el agente seguiría
respondiendo con una política derogada.

Usa la misma service account que JSM, con dos scopes más:
**`read:space:confluence`** y **`read:page:confluence`**.

```bash
npx sst secret set ConfluenceEspacios  "SOP,RRHH"                    --stage <stage>
npx sst secret set ConfluenceSitioUrl  "https://<sitio>.atlassian.net" --stage <stage>
```

`ConfluenceEspacios` es la allowlist, separada por comas. **Vacía ⇒ el ingestor
no hace nada**, que es el default: nadie ingesta un espacio por accidente.

Para correrla a mano sin esperar el cron, se invoca la Lambda
`IngestorConfluence` desde la consola con un payload vacío.

Lo que **no** hace todavía: adjuntos (PDF, imágenes) y páginas de más de un
nivel de macros anidadas, cuyo contenido se descarta junto con la macro. Si el
corpus de Aersa depende de adjuntos, eso es trabajo aparte.

---

## Datos personales en el guardrail

El guardrail anonimiza email, teléfono, nombre y dirección, y **bloquea**
tarjetas, CVV y contraseñas. Los identificadores locales (CUIT/DNI, RFC/CURP,
NIF) se declaran en `guardrail.regexPii` de `client.config.ts`, que viene vacío.

Por qué anonimizar y no bloquear los datos de contacto: la gente da su email o
su teléfono para que la atiendan, y bloquear el turno dejaría el chat
inservible. Anonimizado, la conversación sigue y el dato no queda en el
historial, ni en los logs, ni en las trazas.

Si agregás una regex de documento de identidad, **anclala a una palabra clave**: un
patrón de 7-8 dígitos sueltos anonimizaría números de pedido, importes y códigos
de producto, y el agente perdería justo el dato que necesita para responder. La
de CUIT se apoya en los prefijos (20/23/24/27 personas, 30/33/34 empresas), que
es lo que la distingue de un número de 11 dígitos cualquiera.

## Reranking de los pasajes

`documentos.reranking` en `client.config.ts`. Viene **apagado**, y prenderlo no
es solo cambiar el flag:

1. Habilitar el modelo de reranking en Bedrock (`amazon.rerank-v1:0` es de AWS;
   `cohere.rerank-v3-5:0` es de un tercero y además pide suscripción en
   Marketplace más los permisos `aws-marketplace:ViewSubscriptions` y
   `Subscribe`).
2. Verificar que el modelo exista en la región del deploy: **el reranking no
   está en todas**.

El permiso `bedrock:Rerank` lo necesita **el rol de servicio de la Knowledge
Base**, no la Lambda que llama al Retrieve — `infra/sst/conocimiento.ts` ya lo
agrega cuando el flag está prendido. Puesto en el rol de la Lambda, cada consulta
falla con AccessDenied.

**Hybrid search no tiene camino hoy**: exige un vector store con campo de texto
filtrable, o sea OpenSearch Serverless. Con S3 Vectors solo hay búsqueda
semántica. Si el cliente lo pide, la conversación es sobre los ~US$350/mes de AOSS.

## Adjuntos de Confluence

`confluence.adjuntos: true` en `client.config.ts`. Sube al bucket los adjuntos
cuyo tipo la Knowledge Base parsea (pdf, doc, docx, txt, md, csv, xls, xlsx,
html) y que pesen menos de 25 MB — Bedrock corta en 50 y el margen evita que un
video subido a una página se lleve la corrida.

Un adjunto que falla no aborta la corrida: se loguea `adjunto_omitido` y la
página queda indexada igual.

**No verificado contra un sitio real**: la documentación de Confluence no dice si
el `downloadLink` viene absoluto o relativo, así que el código soporta las dos
formas. Si los adjuntos no aparecen, ese es el primer lugar a mirar.

## Versión del prompt en las trazas

Cada traza lleva `prompt.version`, un hash corto del prompt de sistema. Permite
comparar dos períodos sabiendo si el prompt cambió en el medio, sin que el texto
del prompt viaje en la traza. Es lo que el PoC llama prompts versionados, en su
forma mínima: no hay gestión de versiones ni rollback.
