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
        // A diferencia del provider "aws" (region: string), "aws-native" tipa
        // `region` como el literal `awsnative.Region`: un string plano no
        // satisface ese tipo y hay que castearlo, sin cambiar el valor.
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
    // El worker linkea messagesTableLink/runtimeLink desde ./mensajeria y
    // ./runtime — ambos módulos ya se ejecutaron por los imports de arriba
    // (Node cachea el módulo, no se duplican recursos).
    await import("./infra/sst/worker");
    // `awsnative.bedrockagentcore.Runtime` no expone un `.arn` genérico: el
    // output con el ARN se llama `agentRuntimeArn`.
    return { runtimeArn: runtime.agentRuntimeArn };
  },
});
