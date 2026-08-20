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

// `.name` en GetRegionResult está deprecado a favor de `.region` (mismo valor).
const region = aws.getRegionOutput().region;
const accountId = aws.getCallerIdentityOutput().accountId;

const repo = new aws.ecr.Repository("CoreRepo", { forceDelete: true });

const image = new dockerbuild.Image("CoreImage", {
  context: { location: "." },
  dockerfile: { location: "core/Dockerfile" },
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
        Action: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel", "bedrock:ApplyGuardrail"],
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          $interpolate`arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
        Resource: "*",
      },
    ],
  }),
});

export const runtime = new awsnative.bedrockagentcore.Runtime("AgentRuntime", {
  agentRuntimeName: $interpolate`craftechAiChat${$app.stage}`,
  agentRuntimeArtifact: { containerConfiguration: { containerUri: image.ref } },
  networkConfiguration: { networkMode: "PUBLIC" },
  roleArn: role.arn,
  environmentVariables: {
    MODEL_ID: "us.anthropic.claude-sonnet-4-6",
  },
});

export const runtimeLink = new sst.Linkable("AgentRuntime", {
  properties: { arn: runtime.agentRuntimeArn },
});
