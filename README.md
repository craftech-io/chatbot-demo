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

| Campo | Qué define |
|---|---|
| `slug` | Nombre de la app de SST y prefijo de TODOS los nombres físicos: repo ECR, Guardrail, Gateway, AgentCore Runtime y Memory |
| `modelo` | El `MODEL_ID` de Bedrock que recibe el core |
| `region` | La región del deploy (`AWS_REGION` del entorno la pisa) |
| `topes` | `LIMITE_DIARIO` y `LIMITE_POR_SESION` del BFF |
| `origenesCors` | Los orígenes permitidos en la Function URL del BFF |
| `retencionMemoriaDias` | Días que AgentCore Memory retiene los eventos de la conversación |

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

- `docs/diseno.md` — el diseño completo.
- `docs/notas-tecnicas.md` — expectativas operativas: latencias, cold start,
  tamaño de la imagen y los knobs que las mueven.
- `infra/CONTRACT.md` — el contrato multi-IaC: qué recursos y variables debe
  proveer cualquier sabor de infraestructura.
- `examples/demo-client/README.md` — cómo integra el chat una app cliente.
