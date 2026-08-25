// La mensajería asíncrona (spec §8 v2): el store es la fuente de verdad de la
// transcripción para UIs y canales; la cola FIFO serializa por conversación.
// El orden lexicográfico de `orden` (`${ts ISO}#${msgId}`) ES el cronológico:
// no hace falta un GSI ni ordenar en memoria para paginar la transcripción.
export const messagesTable = new sst.aws.Dynamo("MessagesTableDb", {
  fields: { conversationId: "string", orden: "string" },
  primaryIndex: { hashKey: "conversationId", rangeKey: "orden" },
});

// DLQ propia y también FIFO: SQS no permite que una cola FIFO redirija a una
// DLQ estándar (ni al revés) — deben coincidir en tipo (verificado más abajo).
const dlq = new sst.aws.Queue("MensajesDlq", { fifo: true });

export const mensajesCola = new sst.aws.Queue("MensajesCola", {
  fifo: true,
  // FIFO no soporta delay POR MENSAJE: el delay de la cola ES la ventana de
  // debounce — todo mensaje espera estos segundos antes de ser visible. El
  // valor está hardcodeado acá (no lee env de deploy): DEBOUNCE_SEGUNDOS en
  // el BFF es solo informativo, ver bff.ts.
  delay: "6 seconds",
  dlq: { queue: dlq.arn, retry: 3 },
});

// Los wrappers de sst.Linkable NO heredan el auto-grant que sst.aws.Dynamo/
// sst.aws.Queue le darían a un link directo del componente (mismo patrón que
// infra/sst/tablas.ts): el permiso scoped va a mano vía `include`.
export const messagesTableLink = new sst.Linkable("MessagesTable", {
  properties: { name: messagesTable.name },
  include: [
    sst.aws.permission({
      actions: ["dynamodb:Query", "dynamodb:PutItem"],
      resources: [messagesTable.arn],
    }),
  ],
});

export const mensajesColaLink = new sst.Linkable("MensajesCola", {
  properties: { url: mensajesCola.url },
  include: [
    sst.aws.permission({ actions: ["sqs:SendMessage"], resources: [mensajesCola.arn] }),
  ],
});
