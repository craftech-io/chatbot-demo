// Entrypoint de la Function URL en modo response streaming. Todo lo testeable
// vive en handler.ts; acá solo está el pegamento con Lambda y el SDK.
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { loadConfig } from "../config/index";
import { handleChat, type InvokePayload } from "./handler";

const client = new BedrockAgentCoreClient({});

// La config se resuelve una vez por contenedor caliente, no una vez por request.
let cfgCache: Awaited<ReturnType<typeof loadConfig>> | undefined;
async function cfg() {
  cfgCache ??= await loadConfig();
  return cfgCache;
}

async function invoke(p: InvokePayload): Promise<AsyncIterable<Uint8Array>> {
  const out = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: (await cfg()).runtimeArn,
      runtimeSessionId: p.sessionId,
      payload: new TextEncoder().encode(JSON.stringify(p)),
      contentType: "application/json",
      accept: "text/event-stream",
    }),
  );
  return out.response as AsyncIterable<Uint8Array>;
}

// @ts-expect-error — `awslambda` lo inyecta el runtime de Lambda, no hay tipos.
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // La Function URL es pública: un body malformado no puede tirar la Lambda.
  // Si no parsea, queda {} y handleChat responde 400 por falta de message.
  let body: { message?: string; sessionId?: string };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const r = await handleChat(
    { token: auth.replace(/^Bearer /, "") || undefined, message: body.message, sessionId: body.sessionId },
    { cfg: await cfg(), invoke },
  );
  // HttpResponseStream.from envuelve el stream con metadata HTTP real (status,
  // headers): sin esto, la Function URL responde siempre 200 y sin
  // content-type, y el browser no dispara el modo streaming del fetch.
  // @ts-expect-error — mismo global inyectado por el runtime, sin tipos.
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: r.status,
    headers: { "content-type": "text/event-stream" },
  });
  try {
    for await (const frame of r.frames) stream.write(frame);
  } catch (e) {
    // Si el write falla (cliente desconectado) no hay a quién avisarle: solo log.
    // Los errores del agente ya llegan como frames desde handleChat.
    console.error("no se pudo escribir el stream al cliente", e);
  } finally {
    stream.end();
  }
});
