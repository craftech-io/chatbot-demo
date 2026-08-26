// AgentCore Runtime + su imagen. La imagen DEBE ser ARM64: el Runtime no acepta
// otra arquitectura, y el fallo aparece recién al desplegar.
//
// Nombres reales verificados contra `.sst/platform` (Step 0, ver infra/CONTRACT.md):
// - el recurso de Cloud Control vive en el global `awsnative`, no en `aws.native`
//   (`aws` es solo el provider classic; `awsnative` es el ambient global que
//   expone `@pulumi/aws-native`).
// - la imagen se construye con el paquete `@pulumi/docker-build` (no hay global
//   ambiental para esto, a diferencia de `aws`/`awsnative`/`sst`): se importa
//   explícito.
import * as dockerbuild from "@pulumi/docker-build";
import { guardrail } from "./guardrail";
import { memoria } from "./memoria";
import { gateway } from "./gateway";
import { apiClienteDemoUrl } from "./api-cliente";

// `.name` en GetRegionResult está deprecado a favor de `.region` (mismo valor).
const region = aws.getRegionOutput().region;
const accountId = aws.getCallerIdentityOutput().accountId;

const repo = new aws.ecr.Repository("CoreRepo", {
  // ECR exige nombres en minúsculas y el autoname de Pulumi parte del nombre
  // lógico (CoreRepo) — lo rechaza. Nombre físico explícito y saneado.
  name: `craftech-ai-chat-core-${$app.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
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
        // Nombres de acción: mejor hipótesis del plan (no hay evidencia local
        // de los tipos o docs) — verificar en el smoke.
        Effect: "Allow",
        Action: ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents"],
        Resource: [$interpolate`${memoria.memoryArn}*`],
      },
      {
        // Tools de tenant (2d): el core firma los requests MCP al Gateway con
        // SigV4 (inbound AWS_IAM). Además del ARN pelado va el wildcard de
        // sub-recursos: misma lección que el runtime-endpoint/* de 2a (el
        // authz puede evaluar el target como sub-recurso del gateway) — sigue
        // acotado al gateway PROPIO, no sobre-otorga.
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
  agentRuntimeName: $interpolate`craftechAiChat${$app.stage.replace(/[^a-zA-Z0-9_]/g, "_")}`,
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
    MODEL_ID: "us.anthropic.claude-sonnet-4-6",
    // Encienden el guardrail de salida (sync) que el core ya soporta desde 2a.
    GUARDRAIL_ID: guardrail.guardrailId,
    GUARDRAIL_VERSION: guardrail.version,
    // Memoria de conversación gestionada (AgentCore Memory, ver ./memoria.ts).
    MEMORY_ID: memoria.memoryId,
    // Tools (2d). GATEWAY_URL: el endpoint MCP del gateway — el recurso lo
    // expone como atributo `gatewayUrl` (verificado en gateway.d.ts, 1.68.0).
    // CLIENT_API_URL: base de la API del cliente (acá, la demo) SIN barra
    // final. Vacías/ausentes ⇒ el core corre sin esas tools (contrato 2d).
    GATEWAY_URL: gateway.gatewayUrl,
    CLIENT_API_URL: apiClienteDemoUrl,
  },
});

export const runtimeLink = new sst.Linkable("AgentRuntime", {
  properties: { arn: runtime.agentRuntimeArn },
});
