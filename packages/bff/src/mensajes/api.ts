// API de mensajes: el POST escribe el mensaje del usuario y encola el turno
// para que un worker lo procese en background; el GET pollea la transcripción.
// El flujo es asíncrono a propósito: la latencia del agente no ata la conexión
// HTTP del widget.
//
// Todas las deps son inyectables (`store`/`encolar` ya vienen atados a su
// tabla/cola concreta, igual que `guard`/`limites`) — este módulo no importa
// ningún SDK de AWS.
import { randomUUID } from "node:crypto";
import { MENSAJES_GUARDRAIL } from "@craftech-ai-chat/shared/mensajes";
import { AuthError, verifyUserToken } from "../auth/verify";
import type { BffConfig } from "../config/index";
import { runtimeSessionId } from "./conversacion";
import type { Mensaje } from "./store";

// Mismo contrato que escribirMensaje/listarMensajes (mensajes/store.ts), pero
// ya atado a `{ddb, tabla}` por el caller (chat/lambda.ts) — acá no hace falta
// un DynamoDBClient para testear.
type StoreDeps = {
  escribir(m: Omit<Mensaje, "orden">): Promise<Mensaje>;
  listar(conversationId: string, desde?: string): Promise<Mensaje[]>;
};

type Deps = {
  cfg: BffConfig;
  store: StoreDeps;
  // Publica el turno en la cola FIFO. groupId=conversationId serializa los
  // turnos de una misma conversación; dedupId=msgId evita duplicar el turno
  // si SQS reentrega el mensaje. El `actToken` viaja SOLO por acá: cola →
  // payload del invoke — JAMÁS a MessagesTable ni a los logs.
  encolar: (payload: {
    conversationId: string;
    msgId: string;
    userId: string;
    actToken?: string;
  }) => Promise<void>;
  // Opcional: igual que en chat/lambda.ts, un sabor sin Guardrail linkeado
  // corre sin filtro de entrada.
  guard?: (texto: string) => Promise<{ bloqueada: boolean }>;
  // Opcional: igual que en chat/lambda.ts, un sabor sin las tablas de topes
  // linkeadas corre sin tope de uso.
  limites?: (
    userId: string,
    conversationId: string,
  ) => Promise<{ permitido: boolean; motivo?: "dia" | "sesion" }>;
  // Opcional y fire-and-forget: el índice de hilos es metadata para listar
  // conversaciones, no algo que el turno tenga que esperar. Si el sabor no
  // tiene la tabla linkeada, no hay dónde escribir.
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
): Promise<{ userId: string; actToken?: string } | { error: ErrorBody }> {
  if (!token) return { error: { code: "invalid_token" } };
  try {
    const principal = await verifyUserToken(token, cfg.verifier);
    return { userId: principal.userId, actToken: principal.actToken };
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

  // Trim antes de validar y de usar: un texto de solo espacios es truthy, así
  // que sin el trim pasa `!input.texto` y llega al guardrail y al store como
  // "mensaje" real. El resto de la función usa `texto` (trimeado), nunca
  // `input.texto`.
  const texto = input.texto?.trim();
  if (!texto) {
    return { status: 400, body: { error: { code: "empty_message" } } };
  }

  const conversationId = runtimeSessionId(auth.userId, input.hilo);

  // Orden fijo (pineado por test): auth → texto → topes → guardrail →
  // escrituras/encolado. Los topes van ANTES del guardrail para no pagar un
  // ApplyGuardrail de un mensaje que igual se rechaza con 429.
  if (deps.limites) {
    const l = await deps.limites(auth.userId, conversationId);
    if (!l.permitido) {
      return { status: 429, body: { error: { code: "limit_reached", motivo: l.motivo } } };
    }
  }

  const msgId = randomUUID();
  const ts = new Date().toISOString();

  if (deps.guard) {
    const g = await deps.guard(texto);
    if (g.bloqueada) {
      // Una entrada bloqueada es una RESPUESTA, no un error: se escribe la
      // respuesta de política como si fuera del assistant, NO se encola (no
      // hay turno de agente que correr), y el widget la ve por polling como
      // cualquier otro mensaje.
      try {
        const userMsg = await deps.store.escribir({
          conversationId,
          msgId,
          rol: "user",
          texto,
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
        // Riesgo conocido y aceptado: si la política no se pudo escribir tras el
        // mensaje del usuario, ese mensaje BLOQUEADO queda pendiente y el job del
        // próximo turno lo agrega SIN re-evaluar el guardrail. Es una fuga
        // estrecha (exige una falla de Dynamo entre dos escrituras consecutivas)
        // y coherente con la postura fail-open: el filtro del core
        // sigue siendo la segunda red.
        console.error("escritura del mensaje bloqueado falló", e);
        return { status: 500, body: { error: { code: "error_interno" } } };
      }
    }
  }

  let userMsg: Mensaje;
  try {
    userMsg = await deps.store.escribir({ conversationId, msgId, rol: "user", texto, ts });
  } catch (e) {
    console.error("escritura del mensaje del usuario falló", e);
    return { status: 500, body: { error: { code: "error_interno" } } };
  }
  // Regla del actToken: si el emisor mandó el claim
  // `act_token`, ese es el token para la API del cliente; si no, viaja el
  // MISMO token que el usuario presentó (su API ya lo consume). El token crudo
  // ya está en `input.token` — es el que `autenticar` acaba de verificar, no
  // hace falta pasarlo por otro camino.
  const actToken = auth.actToken ?? input.token;
  try {
    await deps.encolar({ conversationId, msgId, userId: auth.userId, actToken });
  } catch (e) {
    // Si el encolado falla DESPUÉS de escribir el mensaje del usuario, NO se
    // reintenta acá: el diseño se auto-repara — el job del PRÓXIMO mensaje agrega
    // todos los pendientes desde la última respuesta, este huérfano incluido.
    console.error("encolado del turno falló (el mensaje ya quedó escrito; se autorepara con el próximo turno)", e);
    return { status: 500, body: { error: { code: "error_interno" } } };
  }
  if (deps.registrarTurno) {
    deps.registrarTurno(auth.userId, conversationId, texto).catch((e) =>
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
  // query param: el browser no es confiable.
  const conversationId = runtimeSessionId(auth.userId, input.hilo);
  const mensajes = await deps.store.listar(conversationId, input.desde);
  return { status: 200, body: { mensajes } };
}
