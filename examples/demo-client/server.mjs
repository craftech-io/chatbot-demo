// Servidor del demo: hace de "app del cliente". Sirve la página, el bundle del
// widget y el /chat-token. Es solo un ejemplo: no usarlo en producción.
//
// Modo mock: si falta API_URL (todavía no hay Messages Backend desplegado),
// el propio server contesta POST/GET /mensajes hablando el mismo contrato que
// el BFF real (spec §8 v2: mensajería asíncrona con debounce) — así se puede
// ver el chat andando en el browser sin AWS (spec §16: toda capacidad se
// entrega con su modo local mockeado). El worker que agrega mensajes con
// debounce se simula con un `setTimeout` en vez de la cola SQS FIFO real.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { signChatToken } from "./sign.mjs";
import { planificarRespuesta } from "./mock.mjs";

const PORT = Number(process.env.PORT || 3000);
// API_URL reemplaza a CHAT_URL (el Messages Backend ya no habla SSE, habla
// POST/GET /mensajes). Fallback al nombre viejo por si algún script externo
// todavía lo exporta así — retirar cuando nadie dependa de CHAT_URL.
const API_URL = process.env.API_URL || process.env.CHAT_URL;
const MOCK = !API_URL;

let SECRETO = process.env.CHAT_HMAC_SECRET;

if (!MOCK && !SECRETO) {
  // Modo real sin cambios: ambos env siguen siendo obligatorios juntos.
  console.error(
    "Faltan CHAT_HMAC_SECRET (el mismo que ClientHmacSecret del stage) y API_URL " +
      "(la Function URL del deploy).",
  );
  process.exit(1);
}

if (MOCK && !SECRETO) {
  // Nadie tiene por qué generar un secreto compartido solo para probar la UI:
  // alcanza con uno aleatorio de esta corrida (firma y verifica en el mismo proceso).
  SECRETO = randomBytes(32).toString("base64");
  console.log(
    "Modo mock: no hay CHAT_HMAC_SECRET, se generó uno aleatorio para esta corrida.",
  );
}

// El worker fake espera esto antes de "procesar" los mensajes pendientes de
// una conversación — la misma idea que el `delay` de la cola FIFO real
// (infra/sst/mensajeria.ts, spec §8 v2), acá con un setTimeout en el propio
// proceso. 1200ms alcanza para escribir dos mensajes seguidos en el browser
// y ver que el debounce los agrupa en una sola respuesta.
const DEBOUNCE_MS = 1200;

// Emula MENSAJES_WORKER.error (packages/shared/src/mensajes.ts, Task 1 de
// esta fase): la respuesta que el usuario ve cuando el worker no pudo generar
// una respuesta real. El demo es un .mjs sin build: no puede importar ese
// registro, así que sostiene el mismo texto acá (mismo riesgo de
// desincronización que TEXTO_ENTRADA_BLOQUEADA más abajo, documentado a propósito).
const TEXTO_WORKER_ERROR = "Tuve un problema para responderte. Probá de nuevo en un momento.";

// __MOCK_HINT__ en el HTML: en mock, chips clickeables con las keywords que
// disparan cada escenario del mock (el click, del lado del cliente, escribe la
// keyword en el input); en modo real, cadena vacía.
const MOCK_HINT_HTML =
  '<div class="chips-hint">' +
  '<span class="chips-label">Modo local — probá:</span>' +
  ["error", "vencido", "lento", "memoria", "tope", "bloqueado"]
    .map((palabra) => `<button type="button" class="chip-esc">${palabra}</button>`)
    .join("") +
  "</div>";

// __MODO__ en el HTML: el badge del header. En mock, aclara que no hay AWS
// detrás; en real, indica el ambiente contra el que efectivamente se habla.
const MODO_HTML = MOCK
  ? '<span class="badge mock">modo local</span>'
  : '<span class="badge live">● staging</span>';

// Estado mínimo del escenario "vencido": la PRIMERA vez que una (conversación,
// texto) contiene "vencido" se responde 401 expired_token; la segunda (el
// retry automático del widget, con un token nuevo) fluye normal. Así se ve en
// el browser el ciclo completo de renovación de token.
const vencidoYaMostrado = new Map();

// Memoria en proceso del mock (fase 2b, sigue igual en 2c): conversationId →
// array de mensajes del usuario ya respondidos, en orden. Es la versión
// mockeada de la memoria real en AgentCore Memory — por eso NO se llena con
// turnos bloqueados/rechazados por tope (el core real tampoco los persiste
// ahí), y por eso vive separada de `mensajesPorConversacion` (que sí es la
// transcripción completa, igual que MessagesTable).
const historialPorConversacion = new Map();

// La transcripción completa por conversación (la versión mockeada de
// MessagesTable, infra/sst/mensajeria.ts): TODOS los mensajes que ve el
// widget por polling, incluidos los de "bloqueado".
const mensajesPorConversacion = new Map();

let secuenciaGlobal = 0;

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = "";
    req.on("data", (chunk) => (datos += chunk));
    req.on("end", () => {
      try {
        resolve(datos ? JSON.parse(datos) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// El mock decodifica el JWT sin verificar la firma (no tiene sentido verificar
// contra un secreto que el propio mock acaba de inventar): solo lee el `sub`
// para poder saludar por nombre, igual que haría el agente real.
function subDelBearer(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!match) return "demo";
  const partes = match[1].split(".");
  if (partes.length < 2) return "demo";
  try {
    const payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : "demo";
  } catch {
    return "demo";
  }
}

function responderJson(res, status, cuerpo) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(cuerpo));
}

// El conversationId se deriva SIEMPRE del principal autenticado + el hilo que
// manda el cliente — nunca de un id que venga directo del query. Emula (sin
// importarlo: mismo motivo de siempre, este ejemplo no tiene build)
// `runtimeSessionId` del BFF real (packages/bff/src/mensajes/conversacion.ts).
function conversationIdDe(sub, hilo) {
  return `${sub}::${hilo}`;
}

function contextoDe(conversationId) {
  const historial = historialPorConversacion.get(conversationId) ?? [];
  return { turnos: historial.length, historial };
}

function agregarMensaje(conversationId, rol, texto) {
  secuenciaGlobal += 1;
  const ts = new Date().toISOString();
  const msgId = randomBytes(6).toString("hex");
  // orden: contador monotónico + msgId. El sistema real usa `${ts}#${msgId}`
  // (el orden lexicográfico ES el cronológico, infra/sst/mensajeria.ts); acá
  // sumamos el contador porque en tests dos POST pueden caer en el mismo
  // milisegundo y un choque de timestamp rompería el orden — el contrato de
  // cara afuera (un string opaco, comparable con `>`) es el mismo.
  const orden = `${String(secuenciaGlobal).padStart(10, "0")}#${msgId}`;
  const msg = { msgId, conversationId, rol, texto, ts, orden };
  const lista = mensajesPorConversacion.get(conversationId) ?? [];
  lista.push(msg);
  mensajesPorConversacion.set(conversationId, lista);
  return msg;
}

// Los mensajes de usuario todavía no respondidos: recorre la transcripción de
// atrás para adelante y corta en el primer `assistant` — la misma semántica
// que `pendientesDesdeUltimaRespuesta` del store real (Task 2).
function pendientesDesdeUltimaRespuesta(conversationId) {
  const mensajes = mensajesPorConversacion.get(conversationId) ?? [];
  const pendientes = [];
  for (let i = mensajes.length - 1; i >= 0 && mensajes[i].rol !== "assistant"; i--) {
    pendientes.unshift(mensajes[i]);
  }
  return pendientes;
}

// msgId del último mensaje de usuario de la conversación: se DERIVA
// escaneando la transcripción hacia atrás (primer rol=user desde el final) —
// igual que `ultimoMsgIdUsuario` del store real (Task 2). A propósito no se
// cachea en un Map aparte: un Map solo se actualiza en el camino que se
// acuerda de tocarlo, y el camino "bloqueado" escribe directo a la
// transcripción sin pasar por el debounce — un cache así queda
// desincronizado. Escanear la transcripción hace que CUALQUIER escritura
// (normal, bloqueada, la que venga) cuente sola, sin coordinación extra.
function ultimoMsgIdUsuario(conversationId) {
  const mensajes = mensajesPorConversacion.get(conversationId) ?? [];
  for (let i = mensajes.length - 1; i >= 0; i--) {
    if (mensajes[i].rol === "user") return mensajes[i].msgId;
  }
  return null;
}

// El "worker" fake: dispara DEBOUNCE_MS después de CADA mensaje, pero si para
// entonces ya llegó uno más nuevo de la misma conversación, no hace nada — el
// timer del ÚLTIMO mensaje es el único que efectivamente agrega y responde a
// todos los pendientes. Así se ve el debounce en el mock: dos mensajes
// rápidos producen una sola respuesta.
function procesarComoWorker(conversationId, msgId, sub) {
  if (ultimoMsgIdUsuario(conversationId) !== msgId) return;

  const pendientes = pendientesDesdeUltimaRespuesta(conversationId);
  if (pendientes.length === 0) return; // nada pendiente — otro camino ya respondió

  const textoAgregado = pendientes.map((m) => m.texto).join("\n");
  const { demoraMs, frames, persistible } = planificarRespuesta(
    textoAgregado,
    sub,
    contextoDe(conversationId),
  );

  // demoraMs (40/400 según "lento") ya no marca el ritmo de un streaming: acá
  // es la demora extra antes de que la respuesta quede escrita y visible por
  // polling, para que "lento" se siga sintiendo más lento que lo normal.
  setTimeout(() => {
    const ultimo = frames.at(-1);
    // Un frame de error (p. ej. "error" → agent_unavailable) es una falla del
    // worker, no una respuesta: igual que el worker real, el usuario nunca ve
    // silencio — se escribe el texto de fallback como si fuera la respuesta.
    const texto = ultimo?.type === "done" ? ultimo.text : TEXTO_WORKER_ERROR;
    agregarMensaje(conversationId, "assistant", texto);

    if (persistible !== false) {
      const historial = historialPorConversacion.get(conversationId) ?? [];
      for (const p of pendientes) historial.push(p.texto);
      historialPorConversacion.set(conversationId, historial);
    }
  }, demoraMs);
}

async function manejarMensajesPost(req, res) {
  const cuerpo = await leerCuerpo(req);
  const texto = String(cuerpo.texto ?? "").trim();
  const hilo = String(cuerpo.hilo ?? "default");
  const sub = subDelBearer(req.headers.authorization);
  const conversationId = conversationIdDe(sub, hilo);

  const claveVencido = `${conversationId}::${texto}`;
  if (texto.toLowerCase().includes("vencido") && !vencidoYaMostrado.has(claveVencido)) {
    vencidoYaMostrado.set(claveVencido, true);
    responderJson(res, 401, { error: { code: "expired_token" } });
    return;
  }

  if (!texto) {
    responderJson(res, 400, { error: { code: "texto_vacio" } });
    return;
  }

  const plan = planificarRespuesta(texto, sub, contextoDe(conversationId));

  if (plan.persistible === false) {
    const frame = plan.frames[0];
    if (frame.type === "error") {
      // "tope": nada se escribe ni se encola — el core real tampoco persiste
      // turnos rechazados por límite de uso.
      responderJson(res, 429, { error: { code: frame.code, motivo: frame.motivo } });
      return;
    }
    // "bloqueado": el guardrail de entrada responde directo, SIN pasar por el
    // worker/debounce — ya se escriben el mensaje del usuario y la respuesta
    // de política, y el widget la va a ver por el próximo poll.
    const userMsg = agregarMensaje(conversationId, "user", texto);
    agregarMensaje(conversationId, "assistant", frame.text);
    responderJson(res, 200, { msgId: userMsg.msgId, conversationId, orden: userMsg.orden });
    return;
  }

  // Camino normal (incluye "memoria"/"lento"/"error"): se persiste el mensaje
  // del usuario y se programa el worker fake con debounce. El "último msgId"
  // que va a chequear ese timer se deriva de la transcripción cuando dispare
  // (ver `ultimoMsgIdUsuario`) — acá no hace falta anotar nada aparte.
  const userMsg = agregarMensaje(conversationId, "user", texto);
  setTimeout(() => procesarComoWorker(conversationId, userMsg.msgId, sub), DEBOUNCE_MS);
  responderJson(res, 200, { msgId: userMsg.msgId, conversationId, orden: userMsg.orden });
}

function manejarMensajesGet(req, res, url) {
  const hilo = url.searchParams.get("hilo") || "default";
  const desde = url.searchParams.get("desde") || "";
  const sub = subDelBearer(req.headers.authorization);
  const conversationId = conversationIdDe(sub, hilo);

  const mensajes = (mensajesPorConversacion.get(conversationId) ?? []).filter(
    (m) => !desde || m.orden > desde,
  );
  responderJson(res, 200, { mensajes });
}

// Fábrica del server: no llama a .listen() — así los tests lo levantan en un
// puerto efímero (`.listen(0)`) sin pisar al server real de `npm run dev`.
export function crearServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (MOCK && req.method === "POST" && url.pathname === "/mensajes") {
      await manejarMensajesPost(req, res);
      return;
    }

    if (MOCK && req.method === "GET" && url.pathname === "/mensajes") {
      manejarMensajesGet(req, res, url);
      return;
    }

    if (url.pathname === "/chat-token") {
      // DEMO ONLY: sin auth — firma para cualquiera que lo pida; en producción
      // este endpoint vive detrás del login del cliente.
      // En una app real, el usuario sale de la sesión. Acá viene por query para poder
      // probar el aislamiento entre usuarios: ?user=A y ?user=B.
      const userId = url.searchParams.get("user") || "demo";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: signChatToken(userId, SECRETO) }));
      return;
    }

    if (url.pathname === "/widget.js") {
      const js = await readFile(
        new URL("../../packages/widget/dist/widget.js", import.meta.url),
      );
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(js);
      return;
    }

    const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      html
        .replace("__API_URL__", MOCK ? "" : API_URL)
        .replace("__MOCK_HINT__", MOCK ? MOCK_HINT_HTML : "")
        .replace("__MODO__", MODO_HTML),
    );
  });
}

// Arrancar solo cuando este archivo se ejecuta directamente (`node server.mjs`
// / `npm start`) — al importarlo desde los tests, `crearServer` queda
// disponible sin levantar nada en el PORT real.
const esEjecutadoDirectamente =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (esEjecutadoDirectamente) {
  crearServer().listen(PORT, () =>
    console.log(
      `demo-client en http://localhost:${PORT}` + (MOCK ? " (modo mock, sin AWS)" : ""),
    ),
  );
}
