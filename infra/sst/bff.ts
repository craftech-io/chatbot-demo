import { guardrail, guardrailLink } from "./guardrail";
import { sessionsTableLink, limitsTableLink } from "./tablas";
import { messagesTableLink, mensajesColaLink } from "./mensajeria";
import { cliente } from "../../client.config";
import { permisosTrazas, trazasActivas } from "./observabilidad";

// El emisor de tokens del cliente: JWKS (preferido) o HMAC. Los dos llevan default
// vacío para que se setee SOLO el que aplica sin que el deploy corte por el otro.
// Son SECRETOS y por eso viven en `sst.Secret` (`npx sst secret set ...`), no en
// client.config.ts, que se commitea.
const clientJwksUrl = new sst.Secret("ClientJwksUrl", "");
const clientHmacSecret = new sst.Secret("ClientHmacSecret", "");
// Con emisor OIDC real (Cognito) se pinean `iss` y `aud` del token. Default ""
// = no exigir ese claim (compat con emisores JWKS sin OIDC estricto).
const clientTokenIssuer = new sst.Secret("ClientTokenIssuer", "");
const clientTokenAudience = new sst.Secret("ClientTokenAudience", "");

export const clientAuth = new sst.Linkable("ClientAuth", {
  properties: {
    jwksUrl: clientJwksUrl.value,
    hmacSecret: clientHmacSecret.value,
    issuer: clientTokenIssuer.value,
    audience: clientTokenAudience.value,
  },
});

// Esta Function NO invoca el AgentCore Runtime: solo escribe en MessagesTable
// y encola en MensajesCola (JSON clásico, sin streaming). El invoke al Runtime
// lo hace el worker, que linkea `runtimeLink` en su propio módulo
// (infra/sst/worker.ts).
export const chat = new sst.aws.Function("Chat", {
  handler: "packages/bff/src/chat/lambda.handler",
  runtime: "nodejs24.x",
  // 30s alcanza de sobra: el router hace auth + 2 PutItem + 1 SendMessage
  // (nada de invoke al agente, eso lo hace el worker en background).
  timeout: "30 seconds",
  // Los orígenes salen de client.config.ts. El default es "*" (abierto): el
  // token del chat (JWKS/HMAC) es lo que protege, no el origen — un cliente con
  // dominios fijos los lista en su config.
  url: {
    cors: {
      allowOrigins: cliente.origenesCors,
      allowHeaders: ["content-type", "authorization"],
    },
  },
  link: [clientAuth, guardrailLink, sessionsTableLink, limitsTableLink, messagesTableLink, mensajesColaLink],
  // Tracing activo: sin esto la traza se corta en cada salto y el camino
  // BFF → cola → worker → Runtime queda como cuatro trazas sueltas. En sst no
  // hay prop `tracing`: va por `transform.function` (ver ./observabilidad.ts).
  transform: { function: trazasActivas },
  permissions: [
    // Los permisos de X-Ray no vienen con el tracing: el rol que arma sst lleva
    // solo AWSLambdaBasicExecutionRole (ver ./observabilidad.ts).
    ...permisosTrazas,
    {
      // Acotado al propio Guardrail: el recurso expone `guardrailArn` como
      // output, así que no hace falta armar el ARN a mano.
      actions: ["bedrock:ApplyGuardrail"],
      resources: [guardrail.guardrailArn],
    },
  ],
  environment: {
    RETENCION_HISTORIAL_DIAS: String(cliente.retencionHistorialDias),
    // Topes de uso: se ajustan en client.config.ts.
    LIMITE_DIARIO: String(cliente.topes.diario),
    LIMITE_POR_SESION: String(cliente.topes.porSesion),
    // Informativo: el delay real (la ventana de debounce) vive en la cola
    // (MensajesCola.delay, infra/sst/mensajeria.ts) — SQS FIFO no expone el
    // delay como env de la cola. Esta var es para logs/tests del BFF, no
    // controla el comportamiento real.
    DEBOUNCE_SEGUNDOS: "6",
  },
});
