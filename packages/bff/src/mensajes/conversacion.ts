// Deriva el id de conversación a partir del principal ya verificado y el hilo
// opcional que manda el browser. El mismo id cumple DOS roles: es el
// runtimeSessionId con el que AgentCore Runtime provisiona la microVM Y el
// conversationId con el que se particiona MessagesTable — todo lo que atienda
// una conversación (postMensaje/getMensajes en mensajes/api.ts, el invoke del
// worker) tiene que derivar el MISMO id o deja de compartirla. No puede venir
// crudo del browser: quien adivinara el id de otro leería sus mensajes o
// caería en su microVM caliente. Se hashea para no filtrar el userId en un
// identificador que viaja fuera del BFF.
import { createHash } from "node:crypto";

export function runtimeSessionId(userId: string, hiloDelBrowser?: string): string {
  return createHash("sha256")
    .update(`${userId}:${hiloDelBrowser ?? "default"}`)
    .digest("hex");
}
