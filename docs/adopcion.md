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
