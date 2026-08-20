# Contrato de infraestructura

Cualquier sabor de IaC (SST, Terraform, Pulumi) debe crear estos recursos e
inyectar estas variables. El código del producto no conoce el sabor: cambiar de
uno a otro es reimplementar esta lista, nada más.

## Recursos

| Recurso | Para qué | Notas |
|---|---|---|
| AgentCore Runtime | corre el contenedor del agente | imagen **ARM64**; `/ping` y `/invocations` en `:8080` |
| Repositorio ECR | aloja la imagen del core | |
| Rol de ejecución del Runtime | lo asume `bedrock-agentcore.amazonaws.com` | permisos: `bedrock:InvokeModelWithResponseStream`, `bedrock:InvokeModel`, `bedrock:ApplyGuardrail` |
| Lambda del BFF + Function URL | chat con response streaming | permiso `bedrock-agentcore:InvokeAgentRuntime` |
| Secreto del emisor de tokens | verificar el token del cliente | JWKS URL o secreto HMAC |

## Variables que recibe el core (contenedor)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MODEL_ID` | sí | id del modelo o inference profile de Bedrock |
| `AWS_REGION` | no (default `us-east-1`) | región de Bedrock |
| `GUARDRAIL_ID` | no | si falta, el core corre sin guardrail |
| `GUARDRAIL_VERSION` | no | requerida si hay `GUARDRAIL_ID` |

## Variables que recibe el BFF

| Variable | Obligatoria | Descripción |
|---|---|---|
| `AGENT_RUNTIME_ARN` | sí | ARN del AgentCore Runtime a invocar |
| `CLIENT_JWKS_URL` | una de las dos | JWKS del emisor de tokens del cliente |
| `CLIENT_HMAC_SECRET` | una de las dos | secreto compartido, si el cliente no tiene OIDC |

En el sabor SST estas variables se resuelven por linking y las lee
`packages/bff/src/config/resource.ts`. En los demás sabores se inyectan como
variables de entorno y las lee `packages/bff/src/config/env.ts` (se crea con
el segundo sabor de IaC — todavía no existe).

## Mapeo de nombres reales (Step 0, sabor SST)

El plan original de esta tarea escribió los nombres de recursos de Pulumi de
memoria, sin verificarlos contra los tipos generados. Tras `npm i -E -D sst &&
npx sst install` y greppear `.sst/platform/`, estos son los nombres reales que
usa `infra/sst/runtime.ts`:

| Nombre en el plan | Nombre real | Detalle |
|---|---|---|
| `aws.native.bedrockagentcore.Runtime` | `awsnative.bedrockagentcore.Runtime` | `.sst/platform/config.d.ts` declara dos globals ambientales: `export import aws = _aws` (provider classic, paquete `@pulumi/aws`) y `export import awsnative = _awsnative` (Cloud Control, paquete `@pulumi/aws-native`). No existe una propiedad `.native` colgando de `aws`; el namespace de AgentCore vive directo en el global `awsnative`. Confirmado además contra el sabor SST de `msp-platform` (proyecto hermano), que ya usa `awsnative.bedrockagentcore.Memory` y `awsnative.bedrockagentcore.Harness` en producción. |
| `dockerbuild.Image` | `dockerbuild.Image` (import explícito de `@pulumi/docker-build`) | El paquete real es `@pulumi/docker-build` (con guion), no hay global ambiental `dockerbuild` declarado en `.sst/platform/src/global.d.ts` (a diferencia de `aws`/`awsnative`/`sst`). El propio código fuente de SST (`.sst/platform/src/components/aws/helpers/container-builder.ts`) lo resuelve con `import { Image } from "@pulumi/docker-build"`. `infra/sst/runtime.ts` hace `import * as dockerbuild from "@pulumi/docker-build"` para mantener el nombre `dockerbuild.Image` del plan. |
| `aws.getRegionOutput().name` | `aws.getRegionOutput().region` | El campo `name` de `GetRegionResult` está marcado `@deprecated` ("Use 'region' instead. This attribute will be removed in a future version of the provider"). Se usa `.region`, que es el campo vigente y devuelve el mismo valor (típicamente `us-east-1`). |
| `runtime.arn` (en `sst.config.ts`) | `runtime.agentRuntimeArn` | El recurso `awsnative.bedrockagentcore.Runtime` no expone un `.arn` genérico (ver `RuntimeArgs`/`Runtime` arriba): el output real se llama `agentRuntimeArn`. Encontrado por `tsc`, no por el plan. |
| `region: process.env.AWS_REGION ?? "us-east-1"` en el provider `"aws-native"` | mismo valor, cast a `awsnative.Region` | El provider classic (`aws`) tipa `region` como `string`, pero el provider `aws-native` lo tipa como el literal `Input<Region>` (unión de regiones válidas). Un `string` plano no satisface ese literal; se castea `as awsnative.Region` sin cambiar el valor ni hardcodear nada. |

El resto de los nombres del plan (`aws.ecr.Repository`, `aws.iam.Role`,
`aws.iam.RolePolicy`, `aws.ecr.getAuthorizationTokenOutput`, los campos de
`RuntimeArgs` — `agentRuntimeName`, `agentRuntimeArtifact.containerConfiguration.containerUri`,
`networkConfiguration.networkMode: "PUBLIC"`, `roleArn`, `environmentVariables`,
el output `agentRuntimeArn` —, `sst.Linkable`, `sst.Secret`, `sst.aws.Function`
con `streaming`, `url.cors`, `link`, `permissions`) se verificaron contra
`.sst/platform/node_modules/@pulumi/{aws,aws-native,docker-build}/**/*.d.ts` y
coinciden exactamente con el plan.

Versiones de providers instaladas por `sst install` (pineadas en `sst.config.ts`):
`@pulumi/aws@7.32.0`, `@pulumi/aws-native@1.68.0` — sin desviación de versión.
