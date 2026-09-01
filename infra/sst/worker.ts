// El worker de la mensajería asíncrona (spec §8): consume MensajesCola y corre
// el turno del agente en background (packages/worker). No lleva sufijo como
// MessagesTableDb/MensajesColaQueue porque ningún Linkable usa la clave
// "Worker": el nombre de componente está libre.
import { messagesTableLink, mensajesCola } from "./mensajeria";
import { cliente } from "../../client.config";
import { runtime, runtimeLink } from "./runtime";
import { permisosTrazas, trazasActivas } from "./observabilidad";

export const worker = new sst.aws.Function("Worker", {
  handler: "packages/worker/src/lambda.handler",
  runtime: "nodejs24.x",
  // El turno completo (invoke al Runtime + espera del stream) puede tardar
  // bastante más que un request HTTP normal.
  timeout: "3 minutes",
  // messagesTableLink ya da Query/PutItem scoped a MessagesTable (`include`
  // en infra/sst/mensajeria.ts) — suficiente, no hace falta repetir el
  // permiso acá. runtimeLink solo expone el ARN como property (no auto-grant,
  // ver el permiso de InvokeAgentRuntime abajo).
  environment: { RETENCION_HISTORIAL_DIAS: String(cliente.retencionHistorialDias) },
  link: [messagesTableLink, runtimeLink],
  // Tracing activo: sin esto la traza se corta en cada salto y el camino
  // BFF → cola → worker → Runtime queda como cuatro trazas sueltas. En sst no
  // hay prop `tracing`: va por `transform.function` (ver ./observabilidad.ts).
  transform: { function: trazasActivas },
  permissions: [
    // Los permisos de X-Ray no vienen con el tracing: el rol que arma sst lleva
    // solo AWSLambdaBasicExecutionRole (ver ./observabilidad.ts). Acá cierran la
    // traza del turno: es el salto donde vive el debounce.
    ...permisosTrazas,
    {
      // Acotado al Runtime propio, MÁS el sub-recurso runtime-endpoint/*: el
      // invoke real apunta ahí, no al ARN pelado del runtime — sin el wildcard
      // da AccessDenied (ver infra/CONTRACT.md).
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      resources: [runtime.agentRuntimeArn, $interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`],
    },
    {
      // El worker se suscribe pasando el ARN de ESTA Function ya creada (ver
      // el subscribe más abajo), no un handler/FunctionArgs inline — por eso
      // NO hereda el auto-grant de permisos SQS que sst.aws.Queue arma para
      // el subscriber cuando lo crea ella misma (QueueLambdaSubscriber, ver
      // infra/CONTRACT.md). Se declaran a mano, mismo set de acciones que ese
      // auto-grant usa.
      actions: [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage",
      ],
      resources: [mensajesCola.arn],
    },
  ],
});

// batch.size 1: cada mensaje se procesa solo — el turno ya agrega los
// pendientes leyendo MessagesTable (turno.ts), no agrupando records de SQS.
// Un batch mayor solo agregaría latencia (esperar más records) sin cambiar la
// lógica de agregación real.
mensajesCola.subscribe(worker.arn, { batch: { size: 1 } });
