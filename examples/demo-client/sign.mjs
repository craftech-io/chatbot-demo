// Firmado del token de chat, con node:crypto y sin dependencias.
//
// ESTO ES LO QUE EL CLIENTE TIENE QUE IMPLEMENTAR DE SU LADO. Su backend ya sabe
// quién es el usuario porque está logueado en su app; lo único que agrega es firmar
// un pase corto que el widget presenta a nuestro BFF. Nosotros nunca vemos sus
// credenciales y el usuario nunca se loguea dos veces.
import { createHmac } from "node:crypto";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export function signChatToken(userId, secret, ttlSeconds = 600) {
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo =
    b64({ alg: "HS256", typ: "JWT" }) +
    "." +
    b64({ sub: userId, iat: ahora, exp: ahora + ttlSeconds });
  const firma = createHmac("sha256", secret).update(cuerpo).digest("base64url");
  return `${cuerpo}.${firma}`;
}
