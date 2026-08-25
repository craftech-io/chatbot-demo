import { guardrail, guardrailLink } from "./guardrail";
import { sessionsTableLink, limitsTableLink } from "./tablas";
import { messagesTableLink, mensajesColaLink } from "./mensajeria";

// El emisor de tokens del cliente: JWKS (preferido) o HMAC. Los dos llevan default
// vacío para que se setee SOLO el que aplica sin que el deploy corte por el otro.
// En el paquete final esto sale de client.config.ts.
const clientJwksUrl = new sst.Secret("ClientJwksUrl", "");
const clientHmacSecret = new sst.Secret("ClientHmacSecret", "");

export const clientAuth = new sst.Linkable("ClientAuth", {
  properties: {
    jwksUrl: clientJwksUrl.value,
    hmacSecret: clientHmacSecret.value,
  },
});

// Desde la Task 4 (fase 2c) esta Function ya NO invoca AgentCore Runtime
// directamente: solo escribe en MessagesTable y encola en MensajesCola (JSON
// clásico, sin streaming). El invoke al Runtime pasa al worker (Task 5), que
// linkea `runtimeLink` en su propio stack.
export const chat = new sst.aws.Function("Chat", {
  handler: "packages/bff/src/chat/lambda.handler",
  runtime: "nodejs24.x",
  // 30s alcanza de sobra: el router hace auth + 2 PutItem + 1 SendMessage
  // (nada de invoke al agente, eso lo hace el worker en background). El
  // timeout de 5 minutos era herencia del modo streaming viejo, que sí
  // mantenía la conexión abierta esperando al agente.
  timeout: "30 seconds",
  // CORS abierto: el token del chat (JWKS/HMAC) es lo que protege, no el origen.
  // En el paquete final para un cliente concreto, los orígenes salen de
  // client.config.ts en vez de "*".
  url: { cors: { allowOrigins: ["*"], allowHeaders: ["content-type", "authorization"] } },
  link: [clientAuth, guardrailLink, sessionsTableLink, limitsTableLink, messagesTableLink, mensajesColaLink],
  permissions: [
    {
      // Acotado al propio Guardrail: el recurso expone `guardrailArn` como
      // output, así que no hace falta armar el ARN a mano.
      actions: ["bedrock:ApplyGuardrail"],
      resources: [guardrail.guardrailArn],
    },
  ],
  environment: {
    // Topes por defecto del template; por cliente se ajustan acá (client.config
    // los absorberá en 2e).
    LIMITE_DIARIO: "50",
    LIMITE_POR_SESION: "40",
    // Informativo: el delay real (la ventana de debounce) vive en la cola
    // (MensajesCola.delay, infra/sst/mensajeria.ts) — SQS FIFO no expone el
    // delay como env de la cola. Esta var es para logs/tests del BFF, no
    // controla el comportamiento real.
    DEBOUNCE_SEGUNDOS: "6",
  },
});
