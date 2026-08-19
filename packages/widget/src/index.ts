// El widget: lo que el cliente pega en su app. Sin framework, para no chocar con
// su stack. Toda la UI es DOM plano; los textos visibles viven en MENSAJES.
import { TokenSource } from "./token";

// Registro de textos visibles: el producto es en español y los literales no se
// dispersan por el código.
const MENSAJES = {
  agenteCaido: "El asistente no está disponible en este momento. Probá de nuevo en unos minutos.",
  errorGenerico: "Hubo un problema al responder. Probá de nuevo.",
} as const;

export function mount(
  el: HTMLElement,
  opts: { tokenUrl: string; chatUrl: string },
): { send: (texto: string) => Promise<void> } {
  const tokens = new TokenSource(opts.tokenUrl);
  const hilo = document.createElement("div");
  hilo.className = "cc-hilo";
  el.append(hilo);

  async function enviar(texto: string, reintentado = false): Promise<void> {
    const burbuja = document.createElement("p");
    burbuja.className = "cc-respuesta";
    hilo.append(burbuja);

    const r = await fetch(opts.chatUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await tokens.get()}`,
      },
      body: JSON.stringify({ message: texto, sessionId: sesion() }),
    });

    for await (const ev of leerSse(r)) {
      if (ev.type === "delta") {
        burbuja.textContent += String(ev.text ?? "");
      } else if (ev.type === "error") {
        // El token venció mientras el usuario escribía: se renueva y se reintenta
        // UNA vez. Más de una sería un loop ante un token mal emitido.
        if (ev.code === "expired_token" && !reintentado) {
          tokens.invalidate();
          burbuja.remove();
          return enviar(texto, true);
        }
        burbuja.textContent =
          ev.code === "agent_unavailable" ? MENSAJES.agenteCaido : MENSAJES.errorGenerico;
      }
    }
  }

  return { send: (texto: string) => enviar(texto) };
}

// Un id de sesión por pestaña: el hilo sobrevive a un reload, no se mezcla entre
// pestañas.
function sesion(): string {
  const clave = "cc-session";
  let id = sessionStorage.getItem(clave);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(clave, id);
  }
  return id;
}

async function* leerSse(r: Response): AsyncIterable<Record<string, unknown>> {
  const reader = r.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let corte: number;
    while ((corte = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);
      if (frame.startsWith("data: ")) {
        try {
          yield JSON.parse(frame.slice(6)) as Record<string, unknown>;
        } catch {
          yield { type: "error", code: "frame_ilegible" };
        }
      }
    }
  }
}
