# craftech-ai-chat

Template de chatbot + agent core sobre Amazon Bedrock AgentCore. La idea es
que un cliente lo adopte como punto de partida para su propio chat: el core
(Python) corre el agente en un contenedor BYOC, un BFF (TypeScript) media
entre el navegador y el Runtime, y un widget embebible se monta en el sitio
del cliente. Se despliega en la cuenta de AWS del cliente, no en una cuenta
compartida — ver `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md`
para las razones de esa decisión y del resto del diseño.

Aersa es el primer cliente que lo usa, pero el template en sí es genérico: lo
específico de cada cliente (orígenes de CORS, textos, branding) vive en un
`client.config.ts` propio, no acá.

## Mapa del monorepo

| Carpeta | Qué es |
|---|---|
| `core/` | El agente (Python/LlamaIndex Workflows), su contrato HTTP BYOC (`/ping`, `/invocations`) y su Dockerfile ARM64 |
| `packages/bff/` | El BFF (TypeScript): verifica el token del cliente, invoca el AgentCore Runtime y relaya el streaming |
| `packages/widget/` | El widget que el cliente monta en su página, sin framework |
| `infra/` | El IaC. `infra/CONTRACT.md` es el contrato entre el producto y CUALQUIER sabor de IaC (SST, Terraform, Pulumi); `infra/sst/` es el primer sabor implementado |
| `examples/demo-client/` | Una app mínima que integra el widget, para probar el flujo completo sin un cliente real |

## Correr los tests

```bash
uv run pytest core/tests/ -v      # core (Python)
npm test                          # BFF, widget, demo-client (TypeScript)
npm run typecheck                 # typecheck de los workspaces de npm
./core/smoke.sh                   # smoke del contenedor del core (FAKE_LLM=1)
```

`npm run typecheck:infra` typechequea `sst.config.ts` e `infra/` (no lo cubre
el typecheck de workspaces).

## Dónde seguir leyendo

- `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md` — el diseño completo.
- `infra/CONTRACT.md` — el contrato multi-IaC: qué recursos y variables debe
  proveer cualquier sabor de infraestructura.
- `examples/demo-client/README.md` — cómo integra el chat una app cliente.
