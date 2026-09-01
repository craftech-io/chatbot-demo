# craftech-ai-chat

Template de chatbot + agent core sobre Amazon Bedrock AgentCore. La idea es
que un cliente lo adopte como punto de partida para su propio chat: el core
(Python) corre el agente en un contenedor BYOC, un BFF (TypeScript) media
entre el navegador y el Runtime, y un widget embebible se monta en el sitio
del cliente. Se despliega en la cuenta de AWS del cliente, no en una cuenta
compartida — ver `docs/diseno.md`
para las razones de esa decisión y del resto del diseño.

El template es genérico: lo específico de cada cliente vive en
`client.config.ts`, en la raíz — ver [Adoptar el template](#adoptar-el-template).

## Levantarlo en local

### Sin AWS (modo mock)

```bash
npm ci
npm run dev     # http://localhost:3000
```

No hace falta cuenta de AWS, credenciales ni deploy. El server responde
`POST/GET /mensajes` por su cuenta con respuestas escritas a mano
(`examples/demo-client/mock.mjs`), y la UI muestra chips con las palabras que disparan cada
escenario —búsqueda en documentos, escalamiento, error— para recorrer el
comportamiento del bot sin gastar un centavo de Bedrock.

Es el modo para trabajar la UI, el widget y la integración en un sitio. El build
del widget lo dispara `npm run dev` solo, no hay un paso previo que olvidar.

### Contra un deploy real

El mismo server, apuntado al stack desplegado. Cambia según cómo esté
configurado el emisor de tokens:

```bash
# Con HMAC
API_URL="<Function URL del BFF>" \
CHAT_HMAC_SECRET="<el mismo secreto del stack>" \
  npm start -w @craftech-ai-chat/demo-client

# Con Cognito u otro IdP por JWKS
API_URL="<Function URL del BFF>" \
COGNITO_CLIENT_ID="<client id del pool>" \
  npm start -w @craftech-ai-chat/demo-client
```

**El modo se elige por las variables**, no por un flag: sin `API_URL` es mock;
con `API_URL` y sin `COGNITO_CLIENT_ID` es HMAC; con `COGNITO_CLIENT_ID` es login
real. La Function URL sale del output `Chat` del deploy.

El detalle de los tres modos, con el mini-login y cómo integrar el widget en una
app propia, está en [`examples/demo-client/README.md`](examples/demo-client/README.md).

## Mapa del monorepo

| Carpeta / archivo | Qué es |
|---|---|
| `client.config.ts` | La configuración por cliente: el único archivo que se edita al adoptar el template |
| `core/` | El agente (Python/LlamaIndex Workflows), su contrato HTTP BYOC (`/ping`, `/invocations`) y su Dockerfile ARM64 |
| `packages/bff/` | El BFF (TypeScript): verifica el token del cliente, encolá los mensajes en MensajesCola e índexalos en MessagesTable |
| `packages/worker/` | El worker (TypeScript) que consume MensajesCola en background: agrega mensajes pendientes, invoca el AgentCore Runtime (con streaming SSE interno), parsea la respuesta y la escribe en MessagesTable |
| `packages/widget/` | El widget que el cliente monta en su página, sin framework; hace polling a `/mensajes` GET para ver las respuestas |
| `infra/` | El IaC. `infra/CONTRACT.md` es el contrato entre el producto y CUALQUIER sabor de IaC (SST, Terraform, Pulumi); `infra/sst/` es el primer sabor implementado |
| `examples/demo-client/` | Una app mínima que integra el widget, para probar el flujo completo sin un cliente real |

## Adoptar el template

Al clonar el template en el repo de un cliente, lo único que se edita del IaC es
**`client.config.ts`**:

> El paso a paso completo —de una cuenta de AWS vacía a un chat andando, con los
> prerequisitos de cuenta que el stack **no** hace y sus modos de falla— está en
> **[`docs/adopcion.md`](docs/adopcion.md)**. Esta sección es solo el mapa de qué
> define cada campo.

| Campo | Qué define |
|---|---|
| `slug` | Nombre de la app de SST y prefijo de TODOS los nombres físicos: repo ECR, Guardrail, Gateway, AgentCore Runtime y Memory |
| `modelo` | El `MODEL_ID` de Bedrock que recibe el core |
| `region` | La región del deploy (`AWS_REGION` del entorno la pisa) |
| `topes` | `LIMITE_DIARIO` y `LIMITE_POR_SESION` del BFF |
| `origenesCors` | Los orígenes permitidos en la Function URL del BFF |
| `retencionHistorialDias` | Días que se conserva la transcripción (TTL de DynamoDB). Es también cuánto "recuerda" el chat |
| `promptSistema` | La POLÍTICA del agente (spec §11.2): tono, alcance, cuándo buscar en los documentos y cuándo derivar. Viaja al core como `PROMPT_SISTEMA`. **El default habla de "la empresa" en genérico: es lo primero que se toca** |
| `observabilidad` | La capa de TRAZAS (spec §17): `muestreo`, si viajan con el contenido de la conversación, y a dónde van (`cloudwatch` u `otlp`). Las métricas del dashboard no dependen de nada de acá |
| `documentos` | `topK` de la búsqueda y el `reranking` opcional de los pasajes |
| `guardrail` | `regexPii`: los identificadores locales de datos personales (CUIT/DNI, RFC/CURP, NIF) |
| `confluence` | Allowlist de espacios a ingestar, el sitio y si se suben los adjuntos |

`infra/sst/nombres.ts` traduce el `slug` a los alfabetos distintos que exige cada
servicio (ECR/Guardrail/Gateway: minúsculas con guiones; Runtime y Memory:
camelCase, que acepta `_` y no `-`) y valida su forma en synth. Es la única
lógica de nombres del repo: ningún módulo de `infra/sst/` repite un prefijo
literal.

OJO: cambiar el `slug` de un stack YA desplegado cambia esos nombres físicos y
RECREA los recursos. Se elige una vez, al clonar.

### Lo que NO va en `client.config.ts`

- **Los secretos.** El emisor de tokens del cliente (JWKS o HMAC, más `iss` y
  `aud`) vive en `sst.Secret` (`npx sst secret set ClientJwksUrl ...`), porque
  el config se commitea.
- **La cuenta de AWS y el registry de ECR.** No aparecen en ningún archivo del
  repo: el deploy asume `secrets.DEPLOY_ROLE_ARN` y el workflow deriva en
  runtime la cuenta (`aws sts get-caller-identity`), la región (su propio env
  `AWS_REGION`) y el nombre del repo ECR (el output `repoCore` que publica el
  deploy). Un clon solo cambia el secret del rol.
- **El tuning interno del stack**: timeouts de las Lambdas, la ventana de
  debounce y el `visibilityTimeout` de la cola FIFO, los retries de la DLQ. Son
  valores acoplados entre sí (`visibilityTimeout` tiene que ser mayor que el
  timeout del worker) y están documentados en el módulo donde viven.
- **El stage.** El workflow despliega `--stage staging` porque este repo es el
  template y su showcase es un solo ambiente; un clon elige los stages que
  quiera.
- **La identidad del repo**: el `name` de `package.json` y `pyproject.toml` y el
  scope `@craftech-ai-chat/*` de los workspaces npm. No forman parte de ningún
  nombre desplegado — renombrarlos es opcional y cosmético.

## Correr los tests

```bash
uv run pytest core/tests/ -v      # core (Python)
npm test                          # BFF, widget, demo-client (TypeScript)
npm run typecheck                 # typecheck de los workspaces de npm
./core/smoke.sh                   # smoke del contenedor del core (FAKE_LLM=1)
```

`npm run typecheck:infra` typechequea `sst.config.ts`, `client.config.ts` e
`infra/` (no los cubre el typecheck de workspaces).

## Dónde seguir leyendo

- `docs/langfuse.md` — mandar las trazas del agente a Langfuse: los dos
  secretos, la trampa del header y las dos decisiones previas.
- `docs/arquitectura.excalidraw` — el diagrama de la arquitectura (un turno de
  punta a punta). Lo genera `docs/arquitectura.mjs`, que es donde conviene
  tocarlo para que el diff se lea.
- `docs/adopcion.md` — el paso a paso para adoptarlo en el repo de un cliente:
  prerequisitos de cuenta, rol de deploy, secretos, ingesta y verificación.
- `docs/diseno.md` — el diseño completo.
- `docs/notas-tecnicas.md` — expectativas operativas: latencias, cold start,
  tamaño de la imagen, la observabilidad (qué se ve sin instrumentar nada, cómo
  se lee resolución vs derivación, cómo se apuntan las trazas a otro destino) y
  los knobs que mueven todo eso.
- `infra/CONTRACT.md` — el contrato multi-IaC: qué recursos y variables debe
  proveer cualquier sabor de infraestructura.
- `examples/demo-client/README.md` — cómo integra el chat una app cliente.
