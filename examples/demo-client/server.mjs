// Servidor del demo: hace de "app del cliente". Sirve la página, el bundle del
// widget y el /chat-token. Es solo un ejemplo: no usarlo en producción.
//
// Modo mock: si no hay API_URL, el propio server contesta POST/GET /mensajes
// hablando el mismo contrato que el BFF real (mensajería asíncrona con
// debounce) — así se puede ver el chat andando en el browser sin AWS, que es la
// regla del proyecto: toda capacidad se entrega con su modo local. El worker
// que agrega mensajes con debounce se simula con un `setTimeout` en vez de la
// cola SQS FIFO real.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { signChatToken } from "./sign.mjs";
import { planificarRespuesta } from "./mock.mjs";
import { marca, cssDeMarca, revisarContraste } from "../../marca.mjs";

const PORT = Number(process.env.PORT || 3000);

// Assets de public/ (el logo de la marca). Sin esto un .png cae en el catch-all
// que sirve index.html y el browser recibe HTML con content-type text/html: la
// imagen se ve ROTA aunque el request devuelva 200.
const TIPOS_ESTATICOS = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// Modos del server:
// - COGNITO_CLIENT_ID seteado (+ API_URL) → "cognito": login real contra el
//   User Pool; /chat-token devuelve el ID token guardado en la cookie cc_id.
// - Sin API_URL → "mock": todo local, con el mismo mini-login pero simulado
//   (cookie cc_user) — toda capacidad se entrega con su modo local para UI/UX.
// - API_URL + CHAT_HMAC_SECRET sin COGNITO_CLIENT_ID → "hmac": el modo real,
//   sin login.
//
// Recibe el entorno como parámetro (default process.env) para que los tests
// puedan levantar un server en cada modo sin pisar el entorno del proceso.
function configDe(entorno) {
  // API_URL es la URL del Messages Backend, que habla POST/GET /mensajes.
  // CHAT_URL se acepta como alias.
  const apiUrl = entorno.API_URL || entorno.CHAT_URL || "";
  const cognitoClientId = entorno.COGNITO_CLIENT_ID || "";
  const cognitoRegion = entorno.COGNITO_REGION || "us-east-1";
  const modo = !apiUrl ? "mock" : cognitoClientId ? "cognito" : "hmac";

  let secreto = entorno.CHAT_HMAC_SECRET || "";
  let secretoGenerado = false;
  if (modo === "mock" && !secreto) {
    // Nadie tiene por qué generar un secreto compartido solo para probar la UI:
    // alcanza con uno aleatorio de esta corrida (firma y verifica en el mismo proceso).
    secreto = randomBytes(32).toString("base64");
    secretoGenerado = true;
  }

  return { modo, apiUrl, cognitoClientId, cognitoRegion, secreto, secretoGenerado, stage: entorno.STAGE || "" };
}

// El worker fake espera esto antes de "procesar" los mensajes pendientes de
// una conversación — la misma idea que el `delay` de la cola FIFO real
// (infra/sst/mensajeria.ts), acá con un setTimeout en el propio proceso.
// 1200ms alcanza para escribir dos mensajes seguidos en el browser y ver que
// el debounce los agrupa en una sola respuesta.
const DEBOUNCE_MS = 1200;

// Emula MENSAJES_WORKER.error (packages/shared/src/mensajes.ts): la respuesta
// que el usuario ve cuando el worker no pudo generar una respuesta real. El
// demo es un .mjs sin build: no puede importar ese registro, así que sostiene
// el mismo texto acá (mismo riesgo de desincronización que
// TEXTO_ENTRADA_BLOQUEADA más abajo, asumido a propósito).
const TEXTO_WORKER_ERROR = "Tuve un problema para responderte. Probá de nuevo en un momento.";

// __MOCK_HINT__ en el HTML: en mock, chips clickeables con las keywords que
// disparan cada escenario del mock (el click, del lado del cliente, escribe la
// keyword en el input); en modo real, cadena vacía.
const MOCK_HINT_HTML =
  '<div class="chips-hint">' +
  '<span class="chips-label">Modo local — probá:</span>' +
  // Con "pedido"/"catálogo" el mock responde como si el agente hubiera usado
  // sus tools (mis_pedidos / listar_catalogo). El chip lleva la tilde porque
  // así se escribe; el mock acepta las dos grafías.
  // "documento" y "escalar" son las dos capacidades de conocimiento:
  // "documento" contesta con la cita del corpus de examples/documentos, y
  // "escalar" arranca el flujo de consentimiento — hay que contestarle "sí"
  // (a mano, no hay chip) para que recién ahí cree el escalamiento.
  [
    "error",
    "error500",
    "vencido",
    "lento",
    "memoria",
    "tope",
    "bloqueado",
    "pedido",
    "catálogo",
    "documento",
    "escalar",
  ]
    .map((palabra) => `<button type="button" class="chip-esc">${palabra}</button>`)
    .join("") +
  "</div>";

// __MODO__ en el HTML: el badge del header. En mock, aclara que no hay AWS
// detrás; en real (hmac o cognito), indica el ambiente contra el que
// efectivamente se habla.
function headerDeMarca(m = marca) {
  const logo = m.logo
    // alt vacío: el <h1> de al lado ya dice el nombre, así que el logo es
    // decorativo y repetirlo se lo hace leer dos veces a un lector de pantalla.
    ? `<img src="${m.logo}" alt="" style="height:${m.logoAlto};width:auto" />`
    : "";
  // Un solo hijo del flex: `.fila-titulo` usa space-between, y con el logo y el
  // h1 sueltos quedaban tres hijos — el logo se iba al borde izquierdo y el
  // título al centro, separados.
  return `<span class="marca">${logo}<h1>${m.nombre}</h1></span>`;
}

// El nombre del ambiente sale de STAGE, no hardcodeado: un badge que dice
// "staging" mientras se habla con production hace creer que las conversaciones
// son de prueba cuando se están guardando de verdad.
function badgeDe(modo, stage) {
  if (modo === "mock") return '<span class="badge mock">modo local</span>';
  return `<span class="badge live">● ${stage || "en vivo"}</span>`;
}

// Estado mínimo del escenario "vencido": la PRIMERA vez que una (conversación,
// texto) contiene "vencido" se responde 401 expired_token; la segunda (el
// retry automático del widget, con un token nuevo) fluye normal. Así se ve en
// el browser el ciclo completo de renovación de token.
const vencidoYaMostrado = new Map();

// Memoria en proceso del mock: conversationId → array de mensajes del usuario
// ya respondidos, en orden. Es la versión mockeada de la memoria real en
// AgentCore Memory — por eso NO se llena con turnos bloqueados/rechazados por
// tope (el core real tampoco los persiste ahí), y por eso vive separada de
// `mensajesPorConversacion` (que sí es la transcripción completa, igual que
// MessagesTable).
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

// Cookies parseadas a mano del header (sin dependencia nueva): "a=1; b=2" →
// { a: "1", b: "2" }. Los valores viajan URL-encodeados (ver cookieSesion).
function cookiesDe(req) {
  const jar = {};
  for (const parte of String(req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i === -1) continue;
    try {
      jar[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
    } catch {
      // Un valor malformado no tira el request: esa cookie simplemente no está.
    }
  }
  return jar;
}

// La cookie de sesión del demo: HttpOnly (el JS de la página nunca la ve),
// SameSite=Lax y Max-Age 3300 (un toque menos que la hora de vida del ID
// token de Cognito, para no servir un token ya vencido).
// Va SIN `Secure` y /login no tiene protección CSRF: solo vale porque esto es
// un demo en localhost http (Secure rompería la cookie ahí, y SameSite=Lax no
// frena un login-CSRF). En producción real: Secure + CSRF. No copiar tal cual.
function cookieSesion(nombre, valor) {
  return `${nombre}=${encodeURIComponent(valor)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3300`;
}

/**
 * Quién está logueado según las cookies, o `undefined`.
 *
 * En cognito decodifica el ID token y CHEQUEA `exp`: la cookie tiene Max-Age
 * propio, pero si el reloj del browser va atrasado o la cookie sobrevive por
 * cualquier motivo, arrancar el chat con un token ya muerto le da al usuario un
 * error en el primer mensaje en vez de un login.
 */
function usuarioDeLaSesion(req, config) {
  const cookies = cookiesDe(req);
  if (config.modo !== "cognito") return cookies.cc_user || undefined;
  const token = cookies.cc_id;
  if (!token) return undefined;
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (typeof p.exp === "number" && p.exp * 1000 <= Date.now()) return undefined;
    return p.email || p["cognito:username"] || undefined;
  } catch {
    return undefined;
  }
}

// La cookie vencida: mismo nombre y path, Max-Age 0.
function cookieBorrada(nombre) {
  return `${nombre}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// POST /login. En mock es simulado: cualquier usuario/contraseña no vacíos
// entran y la cookie cc_user pasa a ser la identidad del /chat-token. En
// cognito es real: InitiateAuth USER_PASSWORD_AUTH por HTTP plano (sin SDK,
// spec x-amz-json-1.1) y el ID token queda en la cookie cc_id.
async function manejarLogin(req, res, config) {
  const cuerpo = await leerCuerpo(req);
  const usuario = String(cuerpo.usuario ?? "").trim();
  const contrasena = String(cuerpo.contrasena ?? "");

  if (!usuario || !contrasena) {
    responderJson(res, 401, { error: { code: "login_invalido" } });
    return;
  }

  if (config.modo === "mock") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": cookieSesion("cc_user", usuario),
    });
    res.end(JSON.stringify({ usuario }));
    return;
  }

  try {
    const r = await fetch(`https://cognito-idp.${config.cognitoRegion}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        ClientId: config.cognitoClientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: usuario, PASSWORD: contrasena },
      }),
    });

    // Sin IdToken también es login fallido (p. ej. Cognito devolvió un
    // challenge tipo NEW_PASSWORD_REQUIRED, que este demo no maneja).
    const idToken = r.ok ? (await r.json())?.AuthenticationResult?.IdToken : undefined;
    if (!idToken) {
      // El detalle del error de Cognito no se filtra al browser: al usuario
      // le alcanza con saber que no entró.
      responderJson(res, 401, { error: { code: "login_invalido" } });
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": cookieSesion("cc_id", idToken),
    });
    res.end(JSON.stringify({ usuario }));
  } catch (e) {
    // Cognito inalcanzable (red caída, DNS): mismo 401 humano — el detalle
    // técnico queda en el server (el log de abajo; NUNCA loguear credenciales)
    // para que el operador distinga "Cognito caído" de "password incorrecta".
    console.error("login: fallo hablando con Cognito", e);
    responderJson(res, 401, { error: { code: "login_invalido" } });
  }
}

// El conversationId se deriva SIEMPRE del principal autenticado + el hilo que
// manda el cliente — nunca de un id que venga directo del query. Emula (sin
// importarlo: este ejemplo no tiene build) `runtimeSessionId` del BFF real
// (packages/bff/src/mensajes/conversacion.ts).
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
// que `pendientesDesdeUltimaRespuesta` del store real.
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
// igual que `ultimoMsgIdUsuario` del store real. A propósito no se cachea en
// un Map aparte: un Map solo se actualiza en el camino que se acuerda de
// tocarlo, y el camino "bloqueado" escribe directo a la transcripción sin
// pasar por el debounce — un cache así queda desincronizado. Escanear la
// transcripción hace que CUALQUIER escritura
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

  // demoraMs (40/400 según "lento") es la demora extra antes de que la
  // respuesta quede escrita y visible por polling, para que "lento" se sienta
  // más lento que lo normal.
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

  // "error500" emula una falla temprana y síncrona del BFF real (p. ej. el
  // PutItem del mensaje del usuario o el encolado fallando,
  // packages/bff/src/mensajes/api.ts) — a diferencia de "error" (que SÍ
  // escribe el mensaje del usuario y responde `agent_unavailable` como
  // assistant tras el debounce, ver mock.mjs), corta ANTES de escribir nada.
  // El chequeo va explícito antes de `planificarRespuesta`: la keyword "error"
  // está contenida en "error500", así que este camino tiene que ganarle al
  // genérico.
  if (texto.toLowerCase().includes("error500")) {
    responderJson(res, 500, { error: { code: "error_interno" } });
    return;
  }

  if (!texto) {
    // Paridad de contrato con el BFF real (packages/bff/src/mensajes/api.ts),
    // que devuelve "empty_message".
    responderJson(res, 400, { error: { code: "empty_message" } });
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
// `entorno` permite que cada test elija el modo sin tocar process.env.
export function crearServer(entorno = process.env) {
  const config = configDe(entorno);
  const esMock = config.modo === "mock";

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (esMock && req.method === "POST" && url.pathname === "/mensajes") {
      await manejarMensajesPost(req, res);
      return;
    }

    if (esMock && req.method === "GET" && url.pathname === "/mensajes") {
      manejarMensajesGet(req, res, url);
      return;
    }

    // El mini-login existe en mock (simulado) y en cognito (real). En hmac no
    // hay login: la ruta ni se registra y el HTML tampoco muestra el form.
    if (config.modo !== "hmac" && req.method === "POST" && url.pathname === "/login") {
      await manejarLogin(req, res, config);
      return;
    }

    // GET /sesion: lo llama la página al cargar. Sin esto el reload muestra el
    // login aunque la cookie siga viva — el JS no puede leerla porque es
    // HttpOnly, así que tiene que preguntar.
    if (req.method === "GET" && url.pathname === "/sesion") {
      const usuario = usuarioDeLaSesion(req, config);
      if (!usuario) {
        responderJson(res, 401, { error: { code: "login_requerido" } });
        return;
      }
      responderJson(res, 200, { usuario });
      return;
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      res.writeHead(204, { "set-cookie": [cookieBorrada("cc_id"), cookieBorrada("cc_user")] });
      res.end();
      return;
    }

    if (url.pathname === "/chat-token") {
      if (config.modo === "cognito") {
        // El token es el ID token de Cognito que dejó el login en la cookie
        // HttpOnly — el JS de la página nunca lo tuvo en la mano.
        const idToken = cookiesDe(req).cc_id;
        if (!idToken) {
          responderJson(res, 401, { error: { code: "login_requerido" } });
          return;
        }
        responderJson(res, 200, { token: idToken });
        return;
      }

      // DEMO ONLY: sin auth real — firma para cualquiera que lo pida; en
      // producción este endpoint vive detrás del login del cliente.
      // En mock la identidad sale del login simulado (cookie cc_user); el
      // ?user= queda de fallback para poder probar el aislamiento entre
      // usuarios sin loguearse (?user=A y ?user=B en dos pestañas).
      const userId =
        (esMock && cookiesDe(req).cc_user) || url.searchParams.get("user") || "demo";
      responderJson(res, 200, { token: signChatToken(userId, config.secreto) });
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

    const tipo = TIPOS_ESTATICOS[extname(url.pathname).toLowerCase()];
    if (req.method === "GET" && tipo) {
      // basename() y no la ruta cruda: descarta barras y ".." de una, así no
      // hay forma de salir de public/.
      try {
        const bytes = await readFile(new URL(`./public/${basename(url.pathname)}`, import.meta.url));
        res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" });
        res.end(bytes);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no existe");
      }
      return;
    }

    const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      // replaceAll: un placeholder puede aparecer más de una vez (p. ej.
      // citado en un comentario del HTML además del script), y un replace
      // simple dejaría el del script sin reemplazar.
      html
        .replaceAll("__API_URL__", esMock ? "" : config.apiUrl)
        .replaceAll("__MOCK_HINT__", esMock ? MOCK_HINT_HTML : "")
        .replaceAll("__MODO__", badgeDe(config.modo, config.stage))
        .replaceAll("__AUTH_MODO__", config.modo)
        .replaceAll("__MARCA_CSS__", cssDeMarca())
        .replaceAll("__MARCA_HEADER__", headerDeMarca())
        .replaceAll("__MARCA_NOMBRE__", marca.nombre),
    );
  });
}

// Arrancar solo cuando este archivo se ejecuta directamente (`node server.mjs`
// / `npm start`) — al importarlo desde los tests, `crearServer` queda
// disponible sin levantar nada en el PORT real.
const esEjecutadoDirectamente =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (esEjecutadoDirectamente) {
  const config = configDe(process.env);

  if (config.modo === "hmac" && !config.secreto) {
    // Modo real por HMAC: los dos env son obligatorios juntos (o, si el stage
    // habla OIDC, setear COGNITO_CLIENT_ID).
    console.error(
      "Faltan CHAT_HMAC_SECRET (el mismo que ClientHmacSecret del stage) y API_URL " +
        "(la Function URL del deploy).",
    );
    process.exit(1);
  }

  if (config.secretoGenerado) {
    console.log(
      "Modo mock: no hay CHAT_HMAC_SECRET, se generó uno aleatorio para esta corrida.",
    );
  }

  for (const aviso of revisarContraste()) console.warn("marca:", aviso);
  crearServer(process.env).listen(PORT, () =>
    console.log(
      `demo-client en http://localhost:${PORT}` +
        (config.modo === "mock"
          ? " (modo mock, sin AWS)"
          : config.modo === "cognito"
            ? " (modo cognito: login real contra el User Pool)"
            : ""),
    ),
  );
}
