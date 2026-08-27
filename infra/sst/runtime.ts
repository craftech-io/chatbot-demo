// AgentCore Runtime + su imagen. La imagen DEBE ser ARM64: el Runtime no acepta
// otra arquitectura, y el fallo aparece recién al desplegar.
//
// Dónde vive cada pieza (ver infra/CONTRACT.md):
// - el recurso de Cloud Control vive en el global `awsnative`, no en `aws.native`
//   (`aws` es solo el provider classic; `awsnative` es el ambient global que
//   expone `@pulumi/aws-native`).
// - la imagen se construye con el paquete `@pulumi/docker-build` (no hay global
//   ambiental para esto, a diferencia de `aws`/`awsnative`/`sst`): se importa
//   explícito.
import * as dockerbuild from "@pulumi/docker-build";
import { cliente } from "../../client.config";
import { slugKebab, slugCamel } from "./nombres";
import { guardrail } from "./guardrail";
import { memoria } from "./memoria";
import { gateway } from "./gateway";
import { apiClienteDemoUrl } from "./api-cliente";

// `.name` en GetRegionResult está deprecado a favor de `.region` (mismo valor).
const region = aws.getRegionOutput().region;
const accountId = aws.getCallerIdentityOutput().accountId;

// Se exporta para publicar su nombre como output del stack: el CI lo lee de
// `.sst/outputs.json` en vez de rearmarlo a mano (ver .github/workflows/deploy.yml).
export const repo = new aws.ecr.Repository("CoreRepo", {
  // ECR exige nombres en minúsculas y el autoname de Pulumi parte del nombre
  // lógico (CoreRepo) — lo rechaza. Nombre físico explícito y saneado: el
  // prefijo sale del slug del cliente (ver infra/sst/nombres.ts).
  name: `${slugKebab}-core-${$app.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
  forceDelete: true,
});

const image = new dockerbuild.Image("CoreImage", {
  // Rutas ABSOLUTAS desde la raíz del repo: docker-build resuelve las relativas
  // contra .sst/platform (el directorio del programa Pulumi), no contra el repo.
  context: { location: $cli.paths.root },
  dockerfile: { location: `${$cli.paths.root}/core/Dockerfile` },
  platforms: ["linux/arm64"],
  push: true,
  tags: [$interpolate`${repo.repositoryUrl}:latest`],
  registries: [
    {
      address: repo.repositoryUrl,
      username: aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId }).userName,
      password: aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId }).password,
    },
  ],
});

const role = new aws.iam.Role("RuntimeRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

new aws.iam.RolePolicy("RuntimeRolePolicy", {
  role: role.name,
  policy: $jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        // El prefijo `us.` de los inference profiles rutea a otra región: hay que
        // permitir foundation-model y inference-profile, no solo uno. El
        // foundation-model va con wildcard de región (`*`): un profile `us.*`
        // invoca el modelo en cualquiera de las regiones hermanas del profile,
        // y AWS exige el permiso en CADA región destino, no solo en la propia.
        // El de inference-profile sí es regional+de cuenta: ese recurso vive
        // solo en la región y cuenta donde se creó el profile.
        Action: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          $interpolate`arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
        ],
      },
      {
        // ConverseStream con guardrailConfig exige ApplyGuardrail sobre el
        // guardrail mismo (no sobre el modelo).
        Effect: "Allow",
        Action: ["bedrock:ApplyGuardrail"],
        Resource: [guardrail.guardrailArn],
      },
      {
        // AgentCore valida al CREAR el Runtime que su execution role pueda
        // pullear la imagen de ECR (lo exige explícitamente el servicio).
        Effect: "Allow",
        Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource: [repo.arn],
      },
      {
        // GetAuthorizationToken no soporta scope por recurso.
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
        Resource: "*",
      },
      {
        // Data plane de Memory: el core lista y crea eventos de la conversación.
        // Estos nombres de acción no aparecen en los `.d.ts` de aws/aws-native:
        // no hay typecheck que los valide, un typo sale como AccessDenied.
        Effect: "Allow",
        Action: ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents"],
        Resource: [$interpolate`${memoria.memoryArn}*`],
      },
      {
        // Tools de tenant: el core firma los requests MCP al Gateway con SigV4
        // (inbound AWS_IAM). Además del ARN pelado va el wildcard de
        // sub-recursos porque el authz puede evaluar el target como
        // sub-recurso del gateway (mismo caso que el `runtime-endpoint/*` de
        // InvokeAgentRuntime en infra/sst/worker.ts) — sigue acotado al gateway
        // PROPIO, no sobre-otorga.
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeGateway"],
        Resource: [gateway.gatewayArn, $interpolate`${gateway.gatewayArn}/*`],
      },
    ],
  }),
});

export const runtime = new awsnative.bedrockagentcore.Runtime("AgentRuntime", {
  // El recurso exige `[a-zA-Z][a-zA-Z0-9_]*`: stages con guion (p.ej. `pr-123`)
  // lo violarían, así que se sanitiza cualquier carácter fuera de ese alfabeto.
  // El prefijo es el slug del cliente en camelCase (infra/sst/nombres.ts): ese
  // alfabeto no acepta `-`.
  agentRuntimeName: $interpolate`${slugCamel}${$app.stage.replace(/[^a-zA-Z0-9_]/g, "_")}`,
  agentRuntimeArtifact: {
    containerConfiguration: {
      // Digest PURO (repo@sha256:...): el ref canónico de docker-build combina
      // tag y digest (repo:latest@sha256:...) — la validación de CreateRuntime
      // lo acepta, pero el pull real de la microVM no lo resuelve y el
      // contenedor jamás arranca (health check timeout con logs vacíos).
      // El digest cambia por build, así que los updates siguen disparando.
      containerUri: image.ref.apply((r) => r.replace(/:[^@]+@/, "@")),
    },
  },
  networkConfiguration: { networkMode: "PUBLIC" },
  roleArn: role.arn,
  environmentVariables: {
    MODEL_ID: cliente.modelo,
    // Encienden el guardrail de salida (modo sync) del core.
    GUARDRAIL_ID: guardrail.guardrailId,
    GUARDRAIL_VERSION: guardrail.version,
    // Memoria de conversación gestionada (AgentCore Memory, ver ./memoria.ts).
    MEMORY_ID: memoria.memoryId,
    // GATEWAY_URL: el endpoint MCP del gateway — el recurso lo expone como
    // atributo `gatewayUrl`. CLIENT_API_URL: base de la API del cliente (acá,
    // la demo) SIN barra final. Vacías o ausentes ⇒ el core corre sin esas
    // tools (contrato del core).
    GATEWAY_URL: gateway.gatewayUrl,
    CLIENT_API_URL: apiClienteDemoUrl,
  },
});

export const runtimeLink = new sst.Linkable("AgentRuntime", {
  properties: { arn: runtime.agentRuntimeArn },
});
