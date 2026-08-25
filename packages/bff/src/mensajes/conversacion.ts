// Deriva el id de conversación a partir del principal ya verificado y el hilo
// opcional que manda el browser. Vive acá (y no en chat/handler.ts, su lugar
// original) porque el mismo id cumple DOS roles desde la fase 2c: es el
// runtimeSessionId con el que AgentCore Runtime provisiona la microVM (spec
// v1) Y el conversationId con el que se particiona MessagesTable (spec §8
// v2) — postMensaje/getMensajes (mensajes/api.ts) y handleChat (chat/handler.ts)
// tienen que llegar al MISMO id para compartir conversación. No puede venir
// crudo del browser: quien adivinara el id de otro leería sus mensajes o
// caería en su microVM caliente. Se deriva del principal y se hashea para no
// filtrar el userId en un identificador que viaja fuera del BFF.
import { createHash } from "node:crypto";

export function runtimeSessionId(userId: string, hiloDelBrowser?: string): string {
  return createHash("sha256")
    .update(`${userId}:${hiloDelBrowser ?? "default"}`)
    .digest("hex");
}
