// El worker de la mensajería asíncrona (spec §8 v2, Task 5 fase 2c): consume
// MensajesCola y corre el turno del agente en background (packages/worker).
// Sufijo "Db"/"Queue" no aplica acá — "Worker" es un nombre de componente
// libre en toda la app (verificado con grep, ver infra/CONTRACT.md).
import { messagesTableLink, mensajesCola } from "./mensajeria";
import { runtime, runtimeLink } from "./runtime";

export const worker = new sst.aws.Function("Worker", {
  handler: "packages/worker/src/lambda.handler",
  runtime: "nodejs24.x",
  // El turno completo (invoke al Runtime + espera del stream) puede tardar
  // bastante más que un request HTTP normal: mismo timeout largo que Chat
  // tenía en el modo streaming.
  timeout: "3 minutes",
  // messagesTableLink ya da Query/PutItem scoped a MessagesTable (`include`
  // en infra/sst/mensajeria.ts) — suficiente, no hace falta repetir el
  // permiso acá. runtimeLink solo expone el ARN como property (no auto-grant,
  // ver el permiso de InvokeAgentRuntime abajo).
  link: [messagesTableLink, runtimeLink],
  permissions: [
    {
      // Acotado al Runtime propio, MÁS el sub-recurso runtime-endpoint/*: el
      // invoke real apunta ahí, no al ARN pelado del runtime — sin el
      // wildcard da AccessDenied (lección del smoke de 2a, ver CONTRACT.md).
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      resources: [runtime.agentRuntimeArn, $interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`],
    },
    {
      // El worker se suscribe pasando el ARN de ESTA Function ya creada (ver
      // el subscribe más abajo), no un handler/FunctionArgs inline — por eso
      // NO hereda el auto-grant de permisos SQS que sst.aws.Queue arma para
      // el subscriber cuando lo crea ella misma (QueueLambdaSubscriber,
      // ver CONTRACT.md). Se declaran a mano, mismo set de acciones que ese
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
