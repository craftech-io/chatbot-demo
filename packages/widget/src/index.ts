// El widget: lo que el cliente pega en su app. Sin framework, para no chocar con
// su stack. Toda la UI es DOM plano; los textos visibles viven en MENSAJES.
import { SesionVencida, TokenSource } from "./token";
import { renderMarkdown } from "./markdown";
import { MENSAJES_LIMITE } from "@craftech-ai-chat/shared/mensajes";

// Registro de textos visibles: el producto es en español y los literales no se
// dispersan por el código.
//
// No hay un texto propio para "agente caído": esa falla la maneja el worker,
// que escribe su propio mensaje de assistant (MENSAJES_WORKER.error) directo
// al store. El widget lo recibe por polling como cualquier otra respuesta, así
// que acá no hay ningún código de error que lo distinga.
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

  /* Los nodos que produce markdown.ts. La burbuja conserva white-space
     pre-wrap para los saltos que no son párrafo, así que el primero y el
     último van sin margen: si no, se suma el espacio del bloque al del wrap y
     la burbuja queda con aire de más. */
  .cc-respuesta p,
  .cc-respuesta ul,
  .cc-respuesta ol {
    margin: .5em 0;
  }
  .cc-respuesta > :first-child { margin-top: 0; }
  .cc-respuesta > :last-child { margin-bottom: 0; }

  .cc-respuesta ul,
  .cc-respuesta ol {
    padding-left: 1.35em;
  }
  .cc-respuesta li { margin: .15em 0; }
  /* Una sublista respira menos que una lista de primer nivel. */
  .cc-respuesta li > ul,
  .cc-respuesta li > ol { margin: .2em 0; }

  .cc-respuesta code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .9em;
    /* color-mix sobre el fondo de la burbuja: el chip de código funciona igual
       si el host redefine --cc-fondo-resp (contrato de theming). */
    background: color-mix(in srgb, var(--cc-texto-resp) 8%, transparent);
    padding: .1em .3em;
    border-radius: 4px;
  }

  .cc-respuesta a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .cc-respuesta h3,
  .cc-respuesta h4,
  .cc-respuesta h5,
  .cc-respuesta h6 {
    margin: .9em 0 .35em;
    font-weight: 600;
    line-height: 1.25;
  }
  .cc-respuesta h3 { font-size: 1.25em; }
  .cc-respuesta h4 { font-size: 1.15em; }
  .cc-respuesta h5 { font-size: 1.03em; }
  .cc-respuesta h6 { font-size: .92em; opacity: .85; }

  .cc-respuesta hr {
    margin: .8em 0;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--cc-texto-resp) 18%, transparent);
  }

  .cc-respuesta blockquote {
    margin: .5em 0;
    padding-left: .7em;
    border-left: 3px solid color-mix(in srgb, var(--cc-texto-resp) 25%, transparent);
    opacity: .9;
  }
  .cc-respuesta blockquote > :first-child { margin-top: 0; }
  .cc-respuesta blockquote > :last-child { margin-bottom: 0; }

  .cc-respuesta pre {
    margin: .5em 0;
    padding: .55em .7em;
    border-radius: 6px;
    background: color-mix(in srgb, var(--cc-texto-resp) 8%, transparent);
    /* La burbuja es pre-wrap; acá se quiere lo contrario: el código no se
       corta a mitad de línea, scrollea. */
    white-space: pre;
    overflow-x: auto;
  }
  .cc-respuesta pre code {
    background: none;
    padding: 0;
    font-size: .88em;
  }

  /* La burbuja es angosta: una tabla ancha scrollea sola en vez de estirarla. */
  .cc-tabla {
    margin: .5em 0;
    overflow-x: auto;
    max-width: 100%;
  }
  .cc-respuesta table {
    border-collapse: collapse;
    font-size: .94em;
    /* Sin esto pre-wrap parte las celdas en una columna de letras. */
    white-space: normal;
  }
  .cc-respuesta th,
  .cc-respuesta td {
    border: 1px solid color-mix(in srgb, var(--cc-texto-resp) 20%, transparent);
    padding: .3em .6em;
    text-align: left;
    vertical-align: top;
  }
  .cc-respuesta th {
    font-weight: 600;
    background: color-mix(in srgb, var(--cc-texto-resp) 7%, transparent);
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
// rendirse. Inyectables SOLO para que los tests sean determinísticos y
// rápidos — el default es el de producción.
const POLL_MS_DEFECTO = 1500;
const POLL_TIMEOUT_MS_DEFECTO = 90_000;

export function mount(
  el: HTMLElement,
  opts: {
    tokenUrl: string;
    apiUrl: string;
    /**
     * La sesión venció o no hay: el host manda a la persona al login. Sin
     * esto el widget solo puede mostrar su error genérico, y el usuario no se
     * entera de que tiene que volver a entrar.
     */
    onSesionVencida?: () => void;
    _pollMs?: number;
    _pollTimeoutMs?: number;
  },
): { send: (texto: string) => Promise<void> } {
  inyectarEstilos();
  const tokens = new TokenSource(opts.tokenUrl);
  // La Function URL de Lambda se suele copiar con barra final: sin esto,
  // `${apiUrl}/mensajes` armaría //mensajes y el router del BFF devolvería
  // 404 en todos los mensajes.
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
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
  // vencido (error o timeout).
  // Es un <div> y no un <p> a propósito: markdown.ts le mete párrafos y listas
  // adentro, y un <p> no puede contener <p> ni <ul> (anidado inválido). Los
  // estilos van por la clase, así que el cambio de etiqueta no los toca.
  function crearBurbujaRespuesta(): HTMLDivElement {
    const burbuja = document.createElement("div");
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

  // El error de un send CONCURRENTE (mientras ya hay un poller dueño
  // esperando) no tiene burbuja de "escribiendo" propia — nace directo con el
  // texto final, sin indicador, y no toca la burbuja del dueño.
  function mostrarErrorSuelto(texto: string): void {
    const burbuja = document.createElement("p");
    burbuja.className = "cc-respuesta";
    burbuja.textContent = texto;
    hilo.append(burbuja);
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

  // Poller ÚNICO por mount: el server colapsa por debounce varios mensajes
  // rápidos en UNA sola respuesta assistant. Si cada send() abriera su propio
  // loop de polling, dos sends concurrentes matchearían esa misma respuesta y
  // la pintarían dos veces. `pollerActivo` es el mutex síncrono que decide, en
  // el momento de llamar a enviar() (antes de cualquier await), si ESTE send
  // es el "dueño" del poller; `cursorInicial` es el `orden` del primer mensaje
  // sin responder — el cursor que usa el poller del dueño, sin importar
  // cuántos sends concurrentes se agreguen después.
  //
  // Limitación conocida y aceptada: hay una ventana de pocos milisegundos
  // entre que preguntarHastaRespuesta ENCUENTRA la respuesta y recién ahí baja
  // `pollerActivo` (la línea de abajo del `if` en el loop). Un send()
  // concurrente que caiga justo en esa ventana todavía ve
  // `pollerActivo === true`, no se vuelve dueño, y confía en un poller que ya
  // está por terminar (encontró SU respuesta) y no va a volver a preguntar:
  // ese mensaje queda sin quien lo pollee hasta el próximo send().
  let pollerActivo = false;
  let cursorInicial: string | null = null;

  type ResultadoPoll = { tipo: "respuesta"; texto: string } | { tipo: "todavia_no" } | { tipo: "fatal" };

  // Un solo poll: GET .../mensajes?hilo=&desde= y busca un rol=assistant en la
  // respuesta. El store ya filtra `orden > desde` server-side, así que
  // cualquier assistant en la lista es la respuesta que se espera.
  //
  // Un 401 NO es "todavía no": es simétrico al POST — se renueva el token UNA
  // vez y se reintenta; si el reintento TAMBIÉN da 401, no tiene sentido
  // seguir esperando el timeout completo (la sesión no va a poder leer
  // nunca), así que corta como "fatal". Cualquier otro !ok (red, 5xx, JSON
  // roto) sí es transitorio y se sigue polleando — el timeout de afuera es la
  // única salida por ese tipo de error.
  async function unPoll(idHilo: string, desde: string, reintentado = false): Promise<ResultadoPoll> {
    try {
      const r = await fetch(
        `${apiUrl}/mensajes?hilo=${encodeURIComponent(idHilo)}&desde=${encodeURIComponent(desde)}`,
        { headers: { authorization: `Bearer ${await tokens.get()}` } },
      );
      if (r.status === 401) {
        if (!reintentado) {
          tokens.invalidate();
          return unPoll(idHilo, desde, true);
        }
        return { tipo: "fatal" };
      }
      if (!r.ok) return { tipo: "todavia_no" };
      const cuerpo = await leerJson(r);
      const mensajes = Array.isArray(cuerpo?.mensajes) ? (cuerpo!.mensajes as Array<Record<string, unknown>>) : [];
      const respuesta = mensajes.find((m) => m?.rol === "assistant");
      return respuesta ? { tipo: "respuesta", texto: String(respuesta.texto ?? "") } : { tipo: "todavia_no" };
    } catch (e) {
      // La sesión vencida SÍ propaga: si se tragara acá, el poll seguiría
      // reintentando con un token muerto hasta el timeout de 90s y el usuario
      // vería "no respondió" en vez de que lo manden al login.
      if (e instanceof SesionVencida) throw e;
      console.error("fallo un poll de mensajes del chat", e);
      return { tipo: "todavia_no" };
    }
  }

  function esperar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // El número de intentos se deriva de pollTimeoutMs/pollMs en vez de medir
  // reloj de pared: determinístico bajo tests con intervalos cortos (no
  // depende de que Date.now() avance realmente esos ms), y equivalente en
  // producción con los defaults reales. Al terminar (éxito, fatal o
  // timeout) SIEMPRE libera el poller: un send() posterior puede volver a
  // ser dueño.
  async function preguntarHastaRespuesta(burbuja: HTMLElement, idHilo: string, desde: string): Promise<void> {
    const intentos = Math.max(1, Math.ceil(pollTimeoutMs / pollMs));
    for (let i = 0; i < intentos; i++) {
      await esperar(pollMs);
      const resultado = await unPoll(idHilo, desde);
      if (resultado.tipo === "respuesta") {
        pollerActivo = false;
        cursorInicial = null;
        apagarEscribiendo(burbuja);
        // La respuesta del agente viene en markdown: se renderiza a nodos (ver
        // markdown.ts, que nunca interpreta HTML del modelo). Los mensajes
        // propios del widget —errores, límites— siguen con textContent: son
        // literales nuestros y no tienen markdown que interpretar.
        renderMarkdown(burbuja, resultado.texto);
        autoScroll();
        return;
      }
      if (resultado.tipo === "fatal") {
        pollerActivo = false;
        cursorInicial = null;
        mostrarError(burbuja, MENSAJES.errorGenerico);
        return;
      }
      // "todavia_no": sigue polleando.
    }
    pollerActivo = false;
    cursorInicial = null;
    mostrarError(burbuja, MENSAJES.errorGenerico);
  }

  // Resuelve un error de POST según quién lo disparó: el dueño lo muestra en
  // SU burbuja (con indicador que se apaga) y libera el poller; un send
  // concurrente no tiene burbuja propia — el suyo va suelto, sin tocar al
  // dueño, que sigue esperando la respuesta agregada.
  function resolverErrorDePost(esDueño: boolean, burbuja: HTMLElement | null, texto: string): void {
    if (esDueño) {
      pollerActivo = false;
      cursorInicial = null;
      mostrarError(burbuja!, texto);
    } else {
      mostrarErrorSuelto(texto);
    }
  }

  async function enviar(texto: string, reintentado = false): Promise<void> {
    // Claim SÍNCRONO, antes de cualquier await: si dos send() se llaman
    // seguidos sin await entre medio (el caso del debounce del server), el
    // primero en ejecutar esta línea es el dueño y el segundo ya lo ve
    // tomado — no hay ventana de carrera porque nada de esto cede el hilo
    // todavía.
    const esDueño = !pollerActivo;
    if (esDueño) pollerActivo = true;

    const idHilo = sesion();
    const burbuja = esDueño ? crearBurbujaRespuesta() : null;

    try {
      const r = await fetch(`${apiUrl}/mensajes`, {
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
        // posible — es genérico. El retry aplica igual seas dueño o no: es
        // por-POST, no por-poller.
        if (error?.code === "expired_token" && !reintentado) {
          tokens.invalidate();
          if (esDueño) {
            burbuja!.remove();
            pollerActivo = false; // el reintento de abajo reclama el poller de nuevo
          }
          return enviar(texto, true);
        }
        resolverErrorDePost(esDueño, burbuja, MENSAJES.errorGenerico);
        return;
      }

      if (r.status === 429) {
        resolverErrorDePost(
          esDueño,
          burbuja,
          error?.motivo === "sesion" ? MENSAJES_LIMITE.sesionAlcanzada : MENSAJES_LIMITE.diarioAlcanzado,
        );
        return;
      }

      if (!r.ok) {
        resolverErrorDePost(esDueño, burbuja, MENSAJES.errorGenerico);
        return;
      }

      if (!esDueño) {
        // El server ya tiene el mensaje para agregarlo al turno en curso — no
        // hay nada más que hacer acá: el poller del dueño va a encontrar la
        // respuesta agregada.
        return;
      }

      const orden = cuerpo?.orden;
      if (typeof orden !== "string") {
        // Contrato incumplido (200 sin `orden`): no hay desde donde arrancar
        // el polling.
        resolverErrorDePost(true, burbuja, MENSAJES.errorGenerico);
        return;
      }

      cursorInicial = orden;
      await preguntarHastaRespuesta(burbuja!, idHilo, cursorInicial);
    } catch (e) {
      // Sesión vencida: no es un error a mostrar, es un cambio de estado. El
      // host decide qué hacer (mandar al login) y la burbuja se va, para no
      // dejar un mensaje "fallido" que en realidad nunca se intentó.
      if (e instanceof SesionVencida) {
        pollerActivo = false;
        cursorInicial = null;
        if (esDueño && burbuja!.isConnected) burbuja!.remove();
        opts.onSesionVencida?.();
        return;
      }
      // La red cayó, el fetch rechazó, o algo de lo anterior tiró: sin este
      // catch, la promesa de enviar() rechaza sin manejar y el usuario se
      // queda mirando una burbuja vacía para siempre.
      if (esDueño) {
        pollerActivo = false;
        cursorInicial = null;
        if (burbuja!.isConnected) mostrarError(burbuja!, MENSAJES.errorGenerico);
      } else {
        mostrarErrorSuelto(MENSAJES.errorGenerico);
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
