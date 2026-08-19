// Function URL de chat, en modo response streaming. Es el portero: valida el
// token, arma el payload CONFIABLE para el Runtime y relata el stream de vuelta.
// No tiene lógica de agente.
import { createHash } from "node:crypto";
import { AuthError, verifyUserToken } from "../auth/verify";
import type { BffConfig } from "../config/index";
import { parseNdjson, toSse } from "./ndjson";

// AgentCore Runtime provisiona una microVM de Firecracker POR SESIÓN y la mantiene
// VIVA entre invocaciones, ruteando por este id. Por eso no puede venir crudo del
// browser: quien adivinara el id de otro caería en SU microVM caliente, con su
// filesystem y su memoria. Se deriva del principal ya verificado, y se hashea para
// no filtrar el userId en un identificador que viaja a AWS.
function runtimeSessionId(userId: string, hiloDelBrowser?: string): string {
  return createHash("sha256")
    .update(`${userId}:${hiloDelBrowser ?? "default"}`)
    .digest("hex");
}

export type InvokePayload = {
  userId: string;
  actToken?: string;
  message: string;
  sessionId: string;
};

type Deps = {
  cfg: BffConfig;
  invoke: (p: InvokePayload) => Promise<AsyncIterable<Uint8Array>>;
};

type Result = { status: number; frames: AsyncIterable<string> };

function unFrame(event: Record<string, unknown>): AsyncIterable<string> {
  return (async function* () {
    yield toSse(event);
  })();
}

export async function handleChat(
  input: { token?: string; message?: string; sessionId?: string },
  deps: Deps,
): Promise<Result> {
  if (!input.token) {
    return { status: 401, frames: unFrame({ type: "error", code: "invalid_token" }) };
  }
  if (!input.message) {
    return { status: 400, frames: unFrame({ type: "error", code: "empty_message" }) };
  }

  let principal;
  try {
    principal = await verifyUserToken(input.token, deps.cfg.verifier);
  } catch (e) {
    // El code viaja al widget para que sepa si conviene renovar el token y
    // reintentar una vez, o si el token está mal de origen.
    const code = e instanceof AuthError ? e.code : "invalid_token";
    return { status: 401, frames: unFrame({ type: "error", code }) };
  }

  // El userId sale SIEMPRE del token verificado, nunca del cuerpo del request:
  // el browser no es confiable. El payload que se manda al Runtime va con IAM,
  // así que del otro lado se considera confiable.
  const payload: InvokePayload = {
    userId: principal.userId,
    actToken: principal.actToken,
    message: input.message,
    sessionId: runtimeSessionId(principal.userId, input.sessionId),
  };

  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await deps.invoke(payload);
  } catch (e) {
    console.error("invoke del runtime falló", e);
    // Nada tumba la conversación: el widget muestra un mensaje, no un stack.
    return { status: 200, frames: unFrame({ type: "error", code: "agent_unavailable" }) };
  }

  return {
    status: 200,
    frames: (async function* () {
      // El stream puede morir DESPUÉS de que el invoke resolvió (la microVM se
      // cae a mitad de la respuesta). También ahí la conversación no se tumba:
      // se loguea y el widget recibe un frame de error parseable.
      try {
        for await (const ev of parseNdjson(stream)) yield toSse(ev);
      } catch (e) {
        console.error("stream del runtime cortado a mitad de la respuesta", e);
        yield toSse({ type: "error", code: "agent_unavailable" });
      }
    })(),
  };
}
