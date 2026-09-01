/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  // El nombre de la app y la región salen de client.config.ts (ver ese archivo
  // para qué se toca de cada campo). El import va DINÁMICO y adentro
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
          version: "1.77.0",
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
    // La Knowledge Base va importada acá y no desde ./runtime: el Runtime no
    // consume ningún output suyo (la política del agente le llega por
    // `PROMPT_SISTEMA`, que sale de client.config.ts), así que colgarla de ese
    // import sería inventar una dependencia.
    await import("./infra/sst/conocimiento");
    // Las tools de tenant que son Lambda propia (documentos + escalamiento).
    // Va después: consume la knowledge base de arriba y el gateway (ya
    // ejecutado por ./runtime). Node cachea los módulos, no se duplican recursos.
    const { nombreMcpEscalamiento } = await import("./infra/sst/tools");
    // Ingesta de Confluence por cron: consume la knowledge base de arriba.
    await import("./infra/sst/ingesta");
    // Observabilidad (spec §17). El módulo ya está cargado —lo importan las
    // Lambdas para prender el tracing, y de ahí sale también el recurso de
    // Transaction Search— pero el DASHBOARD se arma acá, llamando a
    // `crearDashboard`: ese módulo no puede importar ./gateway, ./runtime ni
    // ./tools sin cerrar un ciclo (`api-cliente → observabilidad → gateway →
    // api-cliente`), así que recibe los nombres desde el único lugar donde todos
    // los módulos ya se ejecutaron. Los nombres siguen saliendo de los módulos
    // de infra: ninguno se escribe a mano.
    const { gateway } = await import("./infra/sst/gateway");
    const { crearDashboard } = await import("./infra/sst/observabilidad");
    crearDashboard({
      runtimeArn: runtime.agentRuntimeArn,
      gatewayArn: gateway.gatewayArn,
      toolEscalamiento: nombreMcpEscalamiento,
    });
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
