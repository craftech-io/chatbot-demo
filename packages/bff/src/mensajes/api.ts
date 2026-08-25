// API de mensajes (spec §8 v2): el POST escribe el mensaje del usuario y
// encola el turno para que un worker lo procese en background; el GET pollea
// la transcripción. Reemplaza el patrón síncrono de chat/handler.ts (que
// bloqueaba la Function URL hasta que el modelo terminara de responder) por
// uno asíncrono: la latencia del agente ya no ata la conexión HTTP del widget.
//
// Todas las deps son inyectables (`store`/`encolar` ya vienen atados a su
// tabla/cola concreta, igual que `guard`/`limites` en handler.ts) — este
// módulo no importa ningún SDK de AWS.
import { randomUUID } from "node:crypto";
import { MENSAJES_GUARDRAIL } from "@craftech-ai-chat/shared/mensajes";
import { AuthError, verifyUserToken } from "../auth/verify";
import type { BffConfig } from "../config/index";
import { runtimeSessionId } from "./conversacion";
import type { Mensaje } from "./store";

// Mismo contrato que escribirMensaje/listarMensajes (mensajes/store.ts), pero
// ya atado a `{ddb, tabla}` por el caller (lambda.ts en la Task 4) — acá no
// hace falta un DynamoDBClient para testear.
type StoreDeps = {
  escribir(m: Omit<Mensaje, "orden">): Promise<Mensaje>;
  listar(conversationId: string, desde?: string): Promise<Mensaje[]>;
};

type Deps = {
  cfg: BffConfig;
  store: StoreDeps;
  // Publica el turno en la cola FIFO. groupId=conversationId serializa los
  // turnos de una misma conversación; dedupId=msgId evita duplicar el turno
  // si SQS reintrega el mensaje.
  encolar: (payload: { conversationId: string; msgId: string; userId: string }) => Promise<void>;
  // Opcional: igual que en handler.ts, sabores/mocks viejos sin Guardrail
  // linkeado corren sin filtro de entrada.
  guard?: (texto: string) => Promise<{ bloqueada: boolean }>;
  // Opcional: igual que en handler.ts, sabores/mocks viejos sin las tablas de
  // topes linkeadas corren sin tope de uso.
  limites?: (
    userId: string,
    conversationId: string,
  ) => Promise<{ permitido: boolean; motivo?: "dia" | "sesion" }>;
  // Opcional: fire-and-forget, igual que en chat/lambda.ts hoy — el índice de
  // hilos es metadata para listar conversaciones (la standalone de 2e), no
  // algo que el turno tenga que esperar. Si el sabor no tiene la tabla
  // linkeada, no hay dónde escribir.
  registrarTurno?: (userId: string, conversationId: string, texto: string) => Promise<number>;
};

type ErrorBody = { code: string; motivo?: "dia" | "sesion" };

export type PostMensajeResult = {
  status: number;
  body: { msgId?: string; conversationId?: string; orden?: string; error?: ErrorBody };
};

export type GetMensajesResult = {
  status: number;
  body: { mensajes?: Mensaje[]; error?: ErrorBody };
};

async function autenticar(
  token: string | undefined,
  cfg: BffConfig,
): Promise<{ userId: string } | { error: ErrorBody }> {
  if (!token) return { error: { code: "invalid_token" } };
  try {
    const principal = await verifyUserToken(token, cfg.verifier);
    return { userId: principal.userId };
  } catch (e) {
    const code = e instanceof AuthError ? e.code : "invalid_token";
    return { error: { code } };
  }
}

export async function postMensaje(
  input: { token?: string; texto?: string; hilo?: string },
  deps: Deps,
): Promise<PostMensajeResult> {
  const auth = await autenticar(input.token, deps.cfg);
  if ("error" in auth) return { status: 401, body: { error: auth.error } };

  if (!input.texto) {
    return { status: 400, body: { error: { code: "empty_message" } } };
  }

  const conversationId = runtimeSessionId(auth.userId, input.hilo);

  // Orden pineado por test: auth → texto → topes → guardrail → escrituras/encolado.
  if (deps.limites) {
    const l = await deps.limites(auth.userId, conversationId);
    if (!l.permitido) {
      return { status: 429, body: { error: { code: "limit_reached", motivo: l.motivo } } };
    }
  }

  const msgId = randomUUID();
  const ts = new Date().toISOString();

  if (deps.guard) {
    const g = await deps.guard(input.texto);
    if (g.bloqueada) {
      // Una entrada bloqueada es una RESPUESTA, no un error (spec §15): se
      // escribe la respuesta de política como si fuera del assistant, NO se
      // encola (no hay turno de agente que correr), y el widget la ve por
      // polling como cualquier otro mensaje.
      try {
        const userMsg = await deps.store.escribir({
          conversationId,
          msgId,
          rol: "user",
          texto: input.texto,
          ts,
        });
        // Estrictamente posterior al del usuario: un empate de milisegundo dejaría el
        // orden a merced de dos UUIDs aleatorios y la respuesta podría listar ANTES
        // que la pregunta.
        const tsAssistant = new Date(Date.parse(ts) + 1).toISOString();
        await deps.store.escribir({
          conversationId,
          msgId: randomUUID(),
          rol: "assistant",
          texto: MENSAJES_GUARDRAIL.entradaBloqueada,
          ts: tsAssistant,
        });
        return { status: 200, body: { msgId: userMsg.msgId, conversationId, orden: userMsg.orden } };
      } catch (e) {
        // Si la política no se pudo escribir tras el mensaje del usuario, ese mensaje
        // BLOQUEADO queda pendiente y el job del próximo turno lo agregaría SIN
        // re-evaluar el guardrail — una fuga estrecha (exige una falla de Dynamo entre
        // dos escrituras consecutivas) aceptada por la postura fail-open del spec §9:
        // el guardrail de SALIDA del core sigue siendo la segunda red. Documentado
        // como riesgo conocido, no como omisión.
        console.error("escritura del mensaje bloqueado falló", e);
        return { status: 500, body: { error: { code: "error_interno" } } };
      }
    }
  }

  let userMsg: Mensaje;
  try {
    userMsg = await deps.store.escribir({ conversationId, msgId, rol: "user", texto: input.texto, ts });
  } catch (e) {
    console.error("escritura del mensaje del usuario falló", e);
    return { status: 500, body: { error: { code: "error_interno" } } };
  }
  try {
    await deps.encolar({ conversationId, msgId, userId: auth.userId });
  } catch (e) {
    // Si el encolado falla DESPUÉS de escribir el mensaje del usuario, NO se
    // reintenta acá: el diseño se auto-repara — el job del PRÓXIMO mensaje agrega
    // todos los pendientes desde la última respuesta, este huérfano incluido.
    console.error("encolado del turno falló (el mensaje ya quedó escrito; se autorepara con el próximo turno)", e);
    return { status: 500, body: { error: { code: "error_interno" } } };
  }
  if (deps.registrarTurno) {
    deps.registrarTurno(auth.userId, conversationId, input.texto).catch((e) =>
      console.error("registrarTurnoEnIndice falló (fire-and-forget)", e),
    );
  }
  return { status: 200, body: { msgId: userMsg.msgId, conversationId, orden: userMsg.orden } };
}

export async function getMensajes(
  input: { token?: string; hilo?: string; desde?: string },
  deps: Pick<Deps, "cfg" | "store">,
): Promise<GetMensajesResult> {
  const auth = await autenticar(input.token, deps.cfg);
  if ("error" in auth) return { status: 401, body: { error: auth.error } };

  // El conversationId sale SIEMPRE del principal verificado, nunca de un
  // query param: el browser no es confiable (mismo motivo que en handler.ts).
  const conversationId = runtimeSessionId(auth.userId, input.hilo);
  const mensajes = await deps.store.listar(conversationId, input.desde);
  return { status: 200, body: { mensajes } };
}
