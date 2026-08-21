/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "craftech-ai-chat",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: {
        // Pin explícito: el bundle tiene que ser determinístico entre local y CI.
        aws: { version: "7.32.0", region: process.env.AWS_REGION ?? "us-east-1" },
        // El build de la imagen ARM64 (infra/sst/runtime.ts) importa
        // @pulumi/docker-build: declararlo como provider hace que `sst install`
        // lo instale en .sst/platform en CUALQUIER máquina (CI incluido).
        "docker-build": { version: "0.0.14" },
        // Cloud Control: AgentCore Runtime no está en el provider classic.
        // A diferencia del provider "aws" (region: string), el tipo de "aws-native"
        // exige el literal `awsnative.Region`: el cast documenta que el valor sigue
        // siendo el mismo string derivado del entorno, no un hardcode nuevo.
        "aws-native": {
          version: "1.68.0",
          region: (process.env.AWS_REGION ?? "us-east-1") as awsnative.Region,
        },
      },
    };
  },
  async run() {
    const { runtime } = await import("./infra/sst/runtime");
    await import("./infra/sst/bff");
    // El plan original decía `runtime.arn`: el recurso real (Step 0) expone
    // `agentRuntimeArn`, no un `.arn` genérico.
    return { runtimeArn: runtime.agentRuntimeArn };
  },
});
