// Servidor del demo: hace de "app del cliente". Sirve la página, el bundle del
// widget y el /chat-token. Es solo un ejemplo: no usarlo en producción.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { signChatToken } from "./sign.mjs";

const PORT = Number(process.env.PORT || 3000);
const SECRETO = process.env.CHAT_HMAC_SECRET;
const CHAT_URL = process.env.CHAT_URL;

if (!SECRETO || !CHAT_URL) {
  console.error(
    "Faltan CHAT_HMAC_SECRET (el mismo que ClientHmacSecret del stage) y CHAT_URL " +
      "(la Function URL del deploy).",
  );
  process.exit(1);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

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
  res.end(html.replace("__CHAT_URL__", CHAT_URL));
}).listen(PORT, () => console.log(`demo-client en http://localhost:${PORT}`));
