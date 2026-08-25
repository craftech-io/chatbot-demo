// El widget: lo que el cliente pega en su app. Sin framework, para no chocar con
// su stack. Toda la UI es DOM plano; los textos visibles viven en MENSAJES.
import { TokenSource } from "./token";
import { MENSAJES_LIMITE } from "@craftech-ai-chat/shared/mensajes";

// Registro de textos visibles: el producto es en español y los literales no se
// dispersan por el código.
//
// Nota: no hay más un texto propio para "agente caído" — en la arquitectura
// async (spec §8 v2) esa falla la maneja el worker, que escribe su propio
// mensaje de assistant (MENSAJES_WORKER.error) directo al store. El widget lo
// recibe por polling como cualquier otra respuesta; no hay código de error que
// distinguirlo acá.
const MENSAJES = {
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
//
// TODO el CSS del widget vive en @layer: los estilos SIN capa del host le ganan
// SIEMPRE a los de una capa, sin importar orden de inyección ni especificidad.
// Ese es el contrato de theming: la página anfitriona redefine las --cc-* con
// cualquier selector simple y gana, aunque este <style> se inyecte último.
const CSS_WIDGET = `
@layer cc-widget {
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

// Cuánto se espera entre polls y cuánto se tolera sin respuesta antes de
// rendirse (spec §8 v2: 1500ms / 90s). Inyectables SOLO para que los tests
// sean determinísticos y rápidos — el default es el real.
const POLL_MS_DEFECTO = 1500;
const POLL_TIMEOUT_MS_DEFECTO = 90_000;

export function mount(
  el: HTMLElement,
  opts: { tokenUrl: string; apiUrl: string; _pollMs?: number; _pollTimeoutMs?: number },
): { send: (texto: string) => Promise<void> } {
  inyectarEstilos();
  const tokens = new TokenSource(opts.tokenUrl);
  const pollMs = opts._pollMs ?? POLL_MS_DEFECTO;
  const pollTimeoutMs = opts._pollTimeoutMs ?? POLL_TIMEOUT_MS_DEFECTO;
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
  // vive hasta que el polling trae la respuesta del asistente o se da por
  // vencido (error o timeout) — ya no hay deltas que lo corten antes.
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

  function apagarEscribiendo(burbuja: HTMLElement): void {
    if (burbuja.classList.contains("cc-escribiendo")) {
      burbuja.classList.remove("cc-escribiendo");
      burbuja.textContent = "";
    }
  }

  function mostrarError(burbuja: HTMLElement, texto: string): void {
    apagarEscribiendo(burbuja);
    burbuja.textContent = texto;
    autoScroll();
  }

  // Body de una Response que puede no ser JSON (ej. un 5xx de un proxy
  // devolviendo texto plano): nunca tira, para que el catch de enviar() no se
  // coma un error de parseo confundiéndolo con uno de red.
  async function leerJson(r: Response): Promise<Record<string, unknown> | null> {
    try {
      return (await r.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // Un solo poll: GET .../mensajes?hilo=&desde= y busca un rol=assistant en la
  // respuesta. El store ya filtra `orden > desde` server-side (Task 2/3), así
  // que cualquier assistant en la lista es la respuesta que se espera.
  // Cualquier falla (red, status no-ok, JSON roto) se trata como "todavía no
  // hay respuesta" — un poll transitoriamente fallido no aborta el polling; el
  // timeout de afuera es la única salida por error.
  async function unPoll(idHilo: string, desde: string): Promise<string | null> {
    try {
      const r = await fetch(
        `${opts.apiUrl}/mensajes?hilo=${encodeURIComponent(idHilo)}&desde=${encodeURIComponent(desde)}`,
        { headers: { authorization: `Bearer ${await tokens.get()}` } },
      );
      if (!r.ok) return null;
      const cuerpo = await leerJson(r);
      const mensajes = Array.isArray(cuerpo?.mensajes) ? (cuerpo!.mensajes as Array<Record<string, unknown>>) : [];
      const respuesta = mensajes.find((m) => m?.rol === "assistant");
      return respuesta ? String(respuesta.texto ?? "") : null;
    } catch (e) {
      console.error("fallo un poll de mensajes del chat", e);
      return null;
    }
  }

  function esperar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // El número de intentos se deriva de pollTimeoutMs/pollMs en vez de medir
  // reloj de pared: determinístico bajo tests con intervalos cortos (no
  // depende de que Date.now() avance realmente esos ms), y equivalente en
  // producción con los defaults reales.
  async function preguntarHastaRespuesta(burbuja: HTMLElement, idHilo: string, desde: string): Promise<void> {
    const intentos = Math.max(1, Math.ceil(pollTimeoutMs / pollMs));
    for (let i = 0; i < intentos; i++) {
      await esperar(pollMs);
      const texto = await unPoll(idHilo, desde);
      if (texto !== null) {
        apagarEscribiendo(burbuja);
        burbuja.textContent = texto;
        autoScroll();
        return;
      }
    }
    mostrarError(burbuja, MENSAJES.errorGenerico);
  }

  async function enviar(texto: string, reintentado = false): Promise<void> {
    const burbuja = crearBurbujaRespuesta();
    const idHilo = sesion();

    try {
      const r = await fetch(`${opts.apiUrl}/mensajes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await tokens.get()}`,
        },
        body: JSON.stringify({ texto, hilo: idHilo }),
      });
      const cuerpo = await leerJson(r);
      const error = cuerpo?.error as { code?: string; motivo?: string } | undefined;

      if (r.status === 401) {
        // El token venció mientras el usuario escribía: se renueva y se
        // reintenta UNA vez. Más de una sería un loop ante un token mal
        // emitido. Cualquier otro 401 (ej. invalid_token) no tiene retry
        // posible — es genérico.
        if (error?.code === "expired_token" && !reintentado) {
          tokens.invalidate();
          burbuja.remove();
          return enviar(texto, true);
        }
        mostrarError(burbuja, MENSAJES.errorGenerico);
        return;
      }

      if (r.status === 429) {
        mostrarError(
          burbuja,
          error?.motivo === "sesion" ? MENSAJES_LIMITE.sesionAlcanzada : MENSAJES_LIMITE.diarioAlcanzado,
        );
        return;
      }

      if (!r.ok) {
        mostrarError(burbuja, MENSAJES.errorGenerico);
        return;
      }

      const orden = cuerpo?.orden;
      if (typeof orden !== "string") {
        // Contrato incumplido (200 sin `orden`): no hay desde donde arrancar
        // el polling.
        mostrarError(burbuja, MENSAJES.errorGenerico);
        return;
      }

      await preguntarHastaRespuesta(burbuja, idHilo, orden);
    } catch (e) {
      // La red cayó, el fetch rechazó, o algo de lo anterior tiró: sin este
      // catch, la promesa de enviar() rechaza sin manejar y el usuario se
      // queda mirando una burbuja vacía para siempre.
      if (burbuja.isConnected) {
        mostrarError(burbuja, MENSAJES.errorGenerico);
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
