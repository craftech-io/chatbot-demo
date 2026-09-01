// La mensajería asíncrona (spec §8): el store es la fuente de verdad de la
// transcripción para UIs y canales; la cola FIFO serializa por conversación.
// El orden lexicográfico de `orden` (`${ts ISO}#${msgId}`) ES el cronológico:
// no hace falta un GSI ni ordenar en memoria para paginar la transcripción.
// Sufijo Db: los nombres de componentes SST son únicos entre sí en toda la
// app, y el Linkable de abajo ya usa "MessagesTable" (la clave de Resource) —
// mismo patrón que SessionsTableDb/LimitsTableDb en infra/sst/tablas.ts.
export const messagesTable = new sst.aws.Dynamo("MessagesTableDb", {
  fields: { conversationId: "string", orden: "string" },
  primaryIndex: { hashKey: "conversationId", rangeKey: "orden" },
  // La transcripción es también el historial que ve el modelo, así que su
  // retención es una decisión de política de datos: la fija
  // `retencionHistorialDias` en client.config.ts y la aplica DynamoDB borrando
  // los ítems vencidos. Antes esto lo hacía el `eventExpiryDuration` de
  // AgentCore Memory, que se sacó del stack.
  ttl: "expiraEn",
});

// DLQ propia y también FIFO: SQS no permite que una cola FIFO redirija a una
// DLQ estándar (ni al revés) — deben coincidir en tipo.
const dlq = new sst.aws.Queue("MensajesDlq", { fifo: true });

// Sufijo Queue: mismo motivo que MessagesTableDb arriba — el nombre de
// componente SST tiene que ser único en toda la app, y el Linkable de abajo
// ya usa "MensajesCola" (la clave de Resource). Sin el sufijo, el componente
// y el Linkable colisionan (`VisibleError: Component name MensajesCola is
// not unique`) recién en runtime de Pulumi, al desplegar — ningún typecheck
// lo detecta.
export const mensajesCola = new sst.aws.Queue("MensajesColaQueue", {
  fifo: true,
  // FIFO no soporta delay POR MENSAJE: el delay de la cola ES la ventana de
  // debounce — todo mensaje espera estos segundos antes de ser visible. El
  // valor está hardcodeado acá (no lee env de deploy): DEBOUNCE_SEGUNDOS en
  // el BFF es solo informativo, ver bff.ts.
  delay: "6 seconds",
  dlq: { queue: dlq.arn, retry: 3 },
  // SIEMPRE mayor que el timeout del worker (3 min, infra/sst/worker.ts): con
  // el default de 30s, SQS re-entrega el mensaje MIENTRAS el primer invoke
  // sigue corriendo (60-90s típico) → un segundo procesarMensaje concurrente
  // e idéntico pasa el debounce (nada cambió entre uno y otro) → doble
  // invocación al agente → doble respuesta silenciosa, sin error ni DLQ. 2x
  // el timeout del worker alcanza porque el handler jamás lanza (turno.ts:
  // la redelivery real solo ocurre ante un crash duro del contenedor, no por
  // un fallo de negocio) y un múltiplo mayor bloquearía la conversación FIFO
  // demasiado tiempo tras ese crash.
  visibilityTimeout: "6 minutes",
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
