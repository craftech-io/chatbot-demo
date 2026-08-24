// El widget: lo que el cliente pega en su app. Sin framework, para no chocar con
// su stack. Toda la UI es DOM plano; los textos visibles viven en MENSAJES.
import { TokenSource } from "./token";
import { MENSAJES_LIMITE } from "@craftech-ai-chat/shared/mensajes";

// Registro de textos visibles: el producto es en español y los literales no se
// dispersan por el código.
const MENSAJES = {
  agenteCaido: "El asistente no está disponible en este momento. Probá de nuevo en unos minutos.",
  errorGenerico: "Hubo un problema al responder. Probá de nuevo.",
} as const;

const ID_ESTILOS = "cc-estilos";

// Estilos de fábrica del widget: se ven bien en cualquier página del cliente
// sin que tenga que escribir una sola línea de CSS. Todo lo variable son
// custom properties `--cc-*` con default acá mismo, para que el HOST (la app
// del cliente) pueda pisarlas sin tocar este archivo.
//
// A propósito NO hay @media (prefers-color-scheme) acá adentro: el modo oscuro
// lo decide la página anfitriona redefiniendo las `--cc-*` (la demo lo hace en
// su propio <style>). El widget no asume que toda página oscura quiere los
// mismos colores.
const CSS_WIDGET = `
.cc-hilo {
  --cc-acento: #0E7568;
  --cc-acento-texto: #fff;
  --cc-fondo-resp: #f1f3f2;
  --cc-texto-resp: #1c2422;
  --cc-radio: 14px;
  --cc-fuente: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  display: flex;
  flex-direction: column;
  gap: .5rem;
  overflow-y: auto;
  padding: 1rem;
  scroll-behavior: smooth;
  font-family: var(--cc-fuente);
}

.cc-usuario {
  align-self: flex-end;
  background: var(--cc-acento);
  color: var(--cc-acento-texto);
  border-radius: var(--cc-radio) var(--cc-radio) 4px var(--cc-radio);
  max-width: 80%;
  padding: .55rem .9rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cc-respuesta {
  align-self: flex-start;
  background: var(--cc-fondo-resp);
  color: var(--cc-texto-resp);
  border-radius: var(--cc-radio) var(--cc-radio) var(--cc-radio) 4px;
  max-width: 85%;
  padding: .55rem .9rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cc-escribiendo .cc-punto {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: .35;
  animation: cc-pulso 1s ease-in-out infinite;
}

.cc-escribiendo .cc-punto:nth-child(2) { animation-delay: .15s; }
.cc-escribiendo .cc-punto:nth-child(3) { animation-delay: .3s; }

@keyframes cc-pulso {
  0%, 80%, 100% { opacity: .35; }
  40% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .cc-escribiendo .cc-punto {
    animation: none;
    opacity: .6;
  }
}
`;

// Se inyecta UNA sola vez por document (guard por id): si la página monta el
// widget más de una vez (varios chats, o un re-mount), no se duplica el <style>.
function inyectarEstilos(): void {
  if (document.getElementById(ID_ESTILOS)) return;
  const estilo = document.createElement("style");
  estilo.id = ID_ESTILOS;
  estilo.textContent = CSS_WIDGET;
  document.head.append(estilo);
}

export function mount(
  el: HTMLElement,
  opts: { tokenUrl: string; chatUrl: string },
): { send: (texto: string) => Promise<void> } {
  inyectarEstilos();
  const tokens = new TokenSource(opts.tokenUrl);
  const hilo = document.createElement("div");
  hilo.className = "cc-hilo";
  el.append(hilo);

  // El hilo hace scroll propio (overflow-y: auto, ver estilos inyectados): tras
  // cualquier cambio visible, se lleva al final.
  function autoScroll(): void {
    hilo.scrollTop = hilo.scrollHeight;
  }

  // La burbuja del usuario se crea UNA sola vez por cada send() del llamador
  // (no en enviar(), que se reinvoca a sí misma en el retry de expired_token):
  // así el retry no la duplica.
  function crearBurbujaUsuario(texto: string): void {
    const burbuja = document.createElement("p");
    burbuja.className = "cc-usuario";
    burbuja.textContent = texto;
    hilo.append(burbuja);
    autoScroll();
  }

  // Nace con el indicador de "escribiendo" (3 puntos por DOM, sin innerHTML):
  // se quita en cuanto llega el primer frame de la respuesta.
  function crearBurbujaRespuesta(): HTMLParagraphElement {
    const burbuja = document.createElement("p");
    burbuja.className = "cc-respuesta cc-escribiendo";
    for (let i = 0; i < 3; i++) {
      const punto = document.createElement("span");
      punto.className = "cc-punto";
      burbuja.append(punto);
    }
    hilo.append(burbuja);
    autoScroll();
    return burbuja;
  }

  // Al primer frame (delta, done o error) se apaga el indicador y se vacían los
  // puntos: de ahí en más la burbuja se escribe como texto normal.
  function apagarEscribiendo(burbuja: HTMLElement): void {
    if (burbuja.classList.contains("cc-escribiendo")) {
      burbuja.classList.remove("cc-escribiendo");
      burbuja.textContent = "";
    }
  }

  async function enviar(texto: string, reintentado = false): Promise<void> {
    const burbuja = crearBurbujaRespuesta();

    try {
      const r = await fetch(opts.chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await tokens.get()}`,
        },
        body: JSON.stringify({ message: texto, sessionId: sesion() }),
      });

      // Nota: NO se corta por r.ok — el 401 del BFF trae frames SSE parseables
      // (expired_token viaja ahí). La guarda correcta es "ningún frame llegó".
      let huboEventos = false;
      for await (const ev of leerSse(r)) {
        huboEventos = true;
        apagarEscribiendo(burbuja);
        if (ev.type === "delta") {
          burbuja.textContent += String(ev.text ?? "");
          autoScroll();
        } else if (ev.type === "done") {
          // El texto del done es el autoritativo: reconcilia la burbuja por si
          // los deltas y el texto final divergieran (renormalización, retries).
          if (typeof ev.text === "string") burbuja.textContent = ev.text;
          autoScroll();
        } else if (ev.type === "error") {
          // El token venció mientras el usuario escribía: se renueva y se reintenta
          // UNA vez. Más de una sería un loop ante un token mal emitido.
          if (ev.code === "expired_token" && !reintentado) {
            tokens.invalidate();
            burbuja.remove();
            return enviar(texto, true);
          } else if (ev.code === "limit_reached") {
            burbuja.textContent =
              ev.motivo === "sesion"
                ? MENSAJES_LIMITE.sesionAlcanzada
                : MENSAJES_LIMITE.diarioAlcanzado;
          } else {
            burbuja.textContent =
              ev.code === "agent_unavailable" ? MENSAJES.agenteCaido : MENSAJES.errorGenerico;
          }
          autoScroll();
        }
      }
      if (!huboEventos) {
        // Una respuesta sin ni un frame SSE (el 5xx de un proxy, un body vacío)
        // no puede dejar la burbuja vacía para siempre.
        apagarEscribiendo(burbuja);
        burbuja.textContent = MENSAJES.errorGenerico;
        autoScroll();
      }
    } catch (e) {
      // La red cayó, el fetch rechazó, o algo de lo anterior tiró: sin este
      // catch, la promesa de enviar() rechaza sin manejar y el usuario se
      // queda mirando una burbuja vacía para siempre.
      if (burbuja.isConnected) {
        apagarEscribiendo(burbuja);
        burbuja.textContent = MENSAJES.errorGenerico;
        autoScroll();
      }
      console.error("fallo al enviar el mensaje del chat", e);
    }
  }

  return {
    send: (texto: string) => {
      crearBurbujaUsuario(texto);
      return enviar(texto);
    },
  };
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
