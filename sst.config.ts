/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  // El nombre de la app y la región salen de client.config.ts (ver ese archivo
  // para qué se toca al adoptar el template). El import va DINÁMICO y adentro
  // de la función: sst rechaza cualquier import top-level en este archivo
  // ("Your sst.config.ts has top level imports - this is not allowed"), y
  // `app()` acepta devolver una promesa.
  async app(input) {
    const { cliente } = await import("./client.config");
    return {
      name: cliente.slug,
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: {
        // Pin explícito: el bundle tiene que ser determinístico entre local y CI.
        // `AWS_REGION` del entorno pisa a `cliente.region` (CI o una prueba
        // local pueden apuntar a otra región sin editar el config).
        aws: { version: "7.32.0", region: process.env.AWS_REGION ?? cliente.region },
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
          region: (process.env.AWS_REGION ?? cliente.region) as awsnative.Region,
        },
      },
    };
  },
  async run() {
    const { runtime, repo } = await import("./infra/sst/runtime");
    await import("./infra/sst/bff");
    // El worker linkea messagesTableLink/runtimeLink desde ./mensajeria y
    // ./runtime — ambos módulos ya se ejecutaron por los imports de arriba
    // (Node cachea el módulo, no se duplican recursos).
    await import("./infra/sst/worker");
    // `awsnative.bedrockagentcore.Runtime` no expone un `.arn` genérico: el
    // output con el ARN se llama `agentRuntimeArn`.
    //
    // `repoCore`: el nombre del repo ECR del core. Se publica como output
    // (sst lo escribe en `.sst/outputs.json` en cada deploy exitoso) para que el
    // CI lo consuma de la MISMA fuente que lo define, sin rearmar el nombre ni
    // hardcodear cuenta y repo.
    return { runtimeArn: runtime.agentRuntimeArn, repoCore: repo.name };
  },
});
