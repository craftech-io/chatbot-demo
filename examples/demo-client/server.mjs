// Servidor del demo: hace de "app del cliente". Sirve la página, el bundle del
// widget y el /chat-token. Es solo un ejemplo: no usarlo en producción.
//
// Modo mock: si falta CHAT_URL (todavía no hay backend desplegado), el propio
// server contesta /chat hablando el mismo contrato SSE que el BFF real — así se
// puede ver el chat andando en el browser (spec §16: toda capacidad se entrega
// con su modo local mockeado).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { signChatToken } from "./sign.mjs";
import { planificarRespuesta } from "./mock.mjs";

const PORT = Number(process.env.PORT || 3000);
const CHAT_URL = process.env.CHAT_URL;
const MOCK = !CHAT_URL;

let SECRETO = process.env.CHAT_HMAC_SECRET;

if (!MOCK && !SECRETO) {
  // Modo real sin cambios: ambos env siguen siendo obligatorios juntos.
  console.error(
    "Faltan CHAT_HMAC_SECRET (el mismo que ClientHmacSecret del stage) y CHAT_URL " +
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

// Estado mínimo del escenario "vencido": la PRIMERA vez que un (sessionId, mensaje)
// contiene "vencido" se responde expired_token; la segunda (el retry automático
// del widget, con un token nuevo) fluye normal. Así se ve en el browser el ciclo
// completo de renovación de token.
const vencidoYaMostrado = new Map();

// Memoria en proceso del mock (fase 2b): sessionId → array de mensajes del
// usuario, en orden. Vive solo en este proceso (se pierde al reiniciar el
// server) — es la versión mockeada de la memoria real en AgentCore Memory.
const historialPorSesion = new Map();

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

function enviarFrame(res, evento) {
  res.write(`data: ${JSON.stringify(evento)}\n\n`);
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function manejarChatMock(req, res) {
  const cuerpo = await leerCuerpo(req);
  const mensaje = String(cuerpo.message ?? "");
  const sessionId = String(cuerpo.sessionId ?? "sin-sesion");
  const sub = subDelBearer(req.headers.authorization);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });

  const clave = `${sessionId}::${mensaje}`;
  if (mensaje.toLowerCase().includes("vencido") && !vencidoYaMostrado.has(clave)) {
    vencidoYaMostrado.set(clave, true);
    enviarFrame(res, { type: "error", code: "expired_token" });
    res.end();
    return;
  }

  // El contexto se arma con el historial ANTES de planificar (turnos = lo que
  // ya se conversó, sin contar este mensaje); el mensaje se pushea DESPUÉS de
  // responder, para que el turno actual no se cuente a sí mismo.
  const historial = historialPorSesion.get(sessionId) ?? [];
  const contexto = { turnos: historial.length, historial };

  const { demoraMs, frames, persistible } = planificarRespuesta(mensaje, sub, contexto);
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) await esperar(demoraMs);
    enviarFrame(res, frames[i]);
  }
  res.end();

  // Los turnos bloqueados/rechazados no van al historial — el core real
  // tampoco los persiste (no llegan a invocar al modelo ni a la Memory).
  if (persistible !== false) {
    historial.push(mensaje);
    historialPorSesion.set(sessionId, historial);
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (MOCK && req.method === "POST" && url.pathname === "/chat") {
    await manejarChatMock(req, res);
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
      .replace("__CHAT_URL__", MOCK ? "/chat" : CHAT_URL)
      .replace("__MOCK_HINT__", MOCK ? MOCK_HINT_HTML : "")
      .replace("__MODO__", MODO_HTML),
  );
}).listen(PORT, () =>
  console.log(
    `demo-client en http://localhost:${PORT}` + (MOCK ? " (modo mock, sin AWS)" : ""),
  ),
);
