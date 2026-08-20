import { runtimeLink } from "./runtime";

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

export const chat = new sst.aws.Function("Chat", {
  handler: "packages/bff/src/chat/lambda.handler",
  runtime: "nodejs24.x",
  timeout: "5 minutes",
  // Response streaming: el SSE tiene que salir a medida que llega, no al final.
  streaming: true,
  url: { cors: { allowOrigins: ["*"], allowHeaders: ["content-type", "authorization"] } },
  link: [runtimeLink, clientAuth],
  permissions: [
    { actions: ["bedrock-agentcore:InvokeAgentRuntime"], resources: ["*"] },
  ],
});
