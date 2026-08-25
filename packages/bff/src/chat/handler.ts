// Function URL de chat, en modo response streaming. Es el portero: valida el
// token, arma el payload CONFIABLE para el Runtime y relata el stream de vuelta.
// No tiene lógica de agente.
import { MENSAJES_GUARDRAIL } from "@craftech-ai-chat/shared/mensajes";
import { AuthError, verifyUserToken } from "../auth/verify";
import type { BffConfig } from "../config/index";
// La derivación vive en mensajes/conversacion.ts desde la fase 2c: el mismo id
// hace de runtimeSessionId (acá) y de conversationId de MessagesTable
// (mensajes/api.ts). Este import se retira cuando la Task 4 jubile este
// handler en favor del flujo asíncrono.
import { runtimeSessionId } from "../mensajes/conversacion";
import { parseNdjson, toSse } from "./ndjson";

export type InvokePayload = {
  userId: string;
  actToken?: string;
  message: string;
  sessionId: string;
};

type Deps = {
  cfg: BffConfig;
  invoke: (p: InvokePayload) => Promise<AsyncIterable<Uint8Array>>;
  // Opcional: si no está seteado (sabor viejo, mock, etc.) el flujo sigue sin
  // filtro de entrada. Orden final: auth → mensaje → topes → guardrail →
  // invoke.
  guard?: (texto: string) => Promise<{ bloqueada: boolean }>;
  // Opcional: si no está seteado (sabor viejo, mock, etc.) el flujo sigue sin
  // topes de uso. Corre ANTES del guard: si el tope ya se superó, no vale la
  // pena pagar el ApplyGuardrail de la entrada.
  limites?: (
    userId: string,
    sessionId: string,
  ) => Promise<{ permitido: boolean; motivo?: "dia" | "sesion" }>;
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

  // Los topes van ACÁ, entre el armado del payload y el guardrail. Orden
  // final: auth → mensaje → topes → guardrail → invoke.
  if (deps.limites) {
    const l = await deps.limites(principal.userId, payload.sessionId);
    if (!l.permitido) {
      return {
        status: 429,
        frames: unFrame({ type: "error", code: "limit_reached", motivo: l.motivo }),
      };
    }
  }

  if (deps.guard) {
    const g = await deps.guard(input.message);
    if (g.bloqueada) {
      // Una entrada bloqueada es una RESPUESTA, no un error (spec §15): el
      // widget la muestra como burbuja normal con el texto canónico.
      return {
        status: 200,
        frames: unFrame({ type: "done", text: MENSAJES_GUARDRAIL.entradaBloqueada }),
      };
    }
  }

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
