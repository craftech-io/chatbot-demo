// El worker de la mensajería asíncrona (spec §8 v2): consume UN evento de la
// cola FIFO ({conversationId, msgId, userId}), decide si todavía es el turno
// vigente (debounce) y, si lo es, corre el turno completo del agente.
//
// El debounce real es el `delay` de la cola (infra/sst/mensajeria.ts), no un
// timer acá: cada mensaje del usuario encola su propio evento con el delay de
// la cola, así que varios mensajes seguidos generan varios eventos, todos
// visibles recién después de la ventana. Cuando el primero se hace visible y
// se procesa, `ultimoMsgIdUsuario` ya puede apuntar a uno más nuevo (el
// usuario siguió escribiendo durante la ventana) — ese evento viejo se
// descarta: el evento del ÚLTIMO mensaje escrito es el único que, al
// procesarse, sigue viendo su propio msgId como el más reciente, y ese es el
// que agrega TODOS los pendientes (spec: un solo turno de agente por ráfaga).
//
// JAMÁS LANZA: lambda.ts invoca esto desde un handler de SQS — un throw acá
// reintentaría la entrega y, en una cola FIFO, bloquearía el grupo entero
// (todos los mensajes de la misma conversación) hasta agotar los reintentos.
// Cualquier fallo (descarte de un turno más nuevo aparte) termina escribiendo
// una respuesta del assistant, nunca dejando al usuario sin respuesta ni
// tumbando el batch.
import { randomUUID } from "node:crypto";
import { MENSAJES_WORKER } from "@craftech-ai-chat/shared/mensajes";
// Import relativo al paquete bff: el store de MessagesTable (Task 2, fase 2c)
// vive ahí y packages/bff/package.json no expone un `exports` map (a
// diferencia de packages/shared, que sí expone "./mensajes") — no hay forma
// "limpia" de importarlo por nombre de paquete sin agregar ese export acá,
// fuera del alcance de esta tarea. Se documenta la ruta relativa en vez de
// duplicar el store (la regla del proyecto: una sola fuente de verdad de
// MessagesTable).
import type { Mensaje } from "../../bff/src/mensajes/store";
import { parseNdjson } from "./ndjson";

export type EventoTurno = { conversationId: string; msgId: string; userId: string };

// Solo las dos lecturas de mensajes/store.ts (Task 2) que necesita el turno.
// El caller real (lambda.ts) las ata a {ddb, tabla} — acá no hace falta un
// DynamoDBClient para testear.
export type StoreDeps = {
  ultimoMsgIdUsuario(conversationId: string): Promise<string | null>;
  pendientesDesdeUltimaRespuesta(conversationId: string): Promise<Mensaje[]>;
};

export type Deps = {
  store: StoreDeps;
  // Invoca al AgentCore Runtime y devuelve el stream crudo (bytes NDJSON/SSE,
  // ver ./ndjson.ts). lambda.ts la implementa con BedrockAgentCoreClient.
  invocar(payload: { message: string; userId: string; sessionId: string }): Promise<AsyncIterable<Uint8Array>>;
  // Misma forma que StoreDeps.escribir en packages/bff/src/mensajes/api.ts:
  // ya atada a {ddb, tabla} por el caller, un solo argumento (el mensaje sin
  // `orden`) — así los tests de turno.ts no arman un DynamoDBClient falso.
  escribir(m: Omit<Mensaje, "orden">): Promise<Mensaje>;
};

export type ResultadoTurno = "procesado" | "descartado" | "error_respondido";

async function escribirRespuesta(
  deps: Pick<Deps, "escribir">,
  conversationId: string,
  texto: string,
): Promise<void> {
  await deps.escribir({
    conversationId,
    msgId: randomUUID(),
    rol: "assistant",
    texto,
    ts: new Date().toISOString(),
  });
}

export async function procesarMensaje(evento: EventoTurno, deps: Deps): Promise<ResultadoTurno> {
  const ultimo = await deps.store.ultimoMsgIdUsuario(evento.conversationId);
  // I2 (fix-wave fase 2c): `null` solo puede ser un fallo de lectura del
  // store — el evento implica que el mensaje del usuario existe (se acaba de
  // encolar). Ante la duda, responder: un descarte acá sería silencio para el
  // usuario. Solo se descarta cuando SÍ hay un último msgId y no coincide con
  // el de este evento (con I1 puesto, el caso patológico null+sin-pendientes
  // degrada a "descartado" igual, coherente).
  if (ultimo !== null && ultimo !== evento.msgId) {
    // No es el último: el usuario mandó otro mensaje durante la ventana de
    // debounce. Ese evento más nuevo (o el que YA se procesó si llegó primero)
    // es quien agrega este turno como pendiente — nada que hacer acá.
    console.log("turno descartado: no es el último mensaje del usuario en la conversación", {
      conversationId: evento.conversationId,
      msgId: evento.msgId,
      ultimo,
    });
    return "descartado";
  }

  // Es el último (o `ultimo` vino null por I2): agrega TODOS los mensajes de
  // usuario sin responder (incluido el propio) en orden cronológico.
  const pendientes = await deps.store.pendientesDesdeUltimaRespuesta(evento.conversationId);
  // I1 (fix-wave fase 2c): redelivery post-crash o fail-open del store: no hay
  // nada que responder — el assistant ya está o lo traerá otro job. Restaura
  // la paridad con el mock (examples/demo-client/server.mjs), que SÍ tiene
  // esta guarda.
  if (pendientes.length === 0) return "descartado";
  const message = pendientes.map((m) => m.texto).join("\n");

  try {
    const stream = await deps.invocar({ message, userId: evento.userId, sessionId: evento.conversationId });

    let texto: string | undefined;
    for await (const frame of parseNdjson(stream)) {
      // Un frame de error del core (o el que sintetiza parseNdjson ante JSON
      // ilegible) es un fallo del turno, no una respuesta: cae al catch de
      // abajo, que escribe MENSAJES_WORKER.error.
      if (frame.type === "error") {
        throw new Error(`el core devolvió un frame de error: ${JSON.stringify(frame)}`);
      }
      if (frame.type === "done") {
        texto = typeof frame.text === "string" ? frame.text : "";
        break;
      }
      // Los frames "delta" se ignoran: el worker no transmite en vivo, solo
      // necesita el texto final del "done" (que el core siempre emite
      // completo, no incremental).
    }
    if (texto === undefined) {
      throw new Error("el stream del core terminó sin un frame done");
    }

    await escribirRespuesta(deps, evento.conversationId, texto);
    return "procesado";
  } catch (e) {
    // Cualquier fallo del turno (invoke, stream cortado, parseo, o el propio
    // PutItem de la respuesta feliz de arriba) cae acá: el usuario nunca se
    // queda sin respuesta, ve el mensaje canónico de error.
    console.error("turno del agente falló (invoke, stream, parseo o escritura de la respuesta)", e);
    try {
      await escribirRespuesta(deps, evento.conversationId, MENSAJES_WORKER.error);
    } catch (e2) {
      // Si ni siquiera esto se pudo escribir, no hay a quién avisarle desde
      // acá: se loguea y se traga. El handler (lambda.ts) igual consume el
      // mensaje del batch — no hay retry útil para un PutItem que ya falló dos
      // veces en el mismo turno.
      console.error("tampoco se pudo escribir el mensaje de error del worker: se traga (jamás lanza)", e2);
    }
    return "error_respondido";
  }
}
