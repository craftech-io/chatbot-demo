# Integrar el chat en tu app

De tu lado hacen falta dos cosas.

## 1. Un endpoint que emita el token del chat

Tu backend ya sabe quién es el usuario porque está logueado en tu app. Lo único que
agrega es firmar un pase corto que el widget presenta a nuestro backend. Nunca nos
mandás credenciales y tu usuario no se loguea dos veces.

Ver `sign.mjs` para el firmado completo (HS256, sin dependencias). En resumen:

```js
app.get("/chat-token", requireLogin, (req, res) => {
  res.json({ token: signChatToken(req.user.id, process.env.CHAT_HMAC_SECRET) });
});
```

Si tu identity provider habla OIDC, mejor: publicá tu JWKS y nos das la URL. Así no
compartimos ningún secreto.

## 2. Montar el widget

```html
<div id="chat"></div>
<script src="https://<tu-cdn>/widget.js"></script>
<script>
  CraftechChat.mount(document.getElementById("chat"), {
    tokenUrl: "/chat-token",
    chatUrl: "https://<url-del-chat>",
  });
</script>
```

## Correr este demo

### Quick start: modo mock, sin AWS

Sin backend desplegado, sin secretos, sin variables de entorno. Sirve para
probar la UI/UX del chat (streaming, errores, renovación de token) contra
respuestas simuladas por el propio server:

```bash
npm run dev
```

Abrir http://localhost:3000. El mensaje que escribís dispara un escenario según
si contiene alguna de estas palabras (no importan mayúsculas):

- `error` → el asistente no está disponible (`agent_unavailable`).
- `vencido` → la primera vez simula un token vencido (`expired_token`); el
  widget renueva el token solo y reintenta, y esa segunda vez sí fluye normal.
- `lento` → una respuesta normal pero con streaming más pausado.
- cualquier otro mensaje → streaming palabra por palabra de una respuesta que
  saluda por tu usuario.

Con `?user=A` y `?user=B` en dos pestañas se ve que cada usuario tiene su
propia conversación.

La fase 2b agregó memoria, topes de uso y un guardrail de entrada; el mock
los hace visibles sin AWS con tres escenarios más:

- `memoria` → la respuesta dice cuántos turnos lleva la conversación y cuál
  fue tu mensaje anterior. El server guarda ese historial en memoria de proceso
  (`historialPorSesion`, por `sessionId`) — se pierde al reiniciar el server;
  es la versión mockeada de la memoria real en AgentCore Memory.
- `tope` → simula haber llegado al límite de uso (`limit_reached`, motivo
  `dia`): un único frame de error, la conversación no sigue.
- `bloqueado` → simula al guardrail de entrada rechazando el mensaje. No es
  un error: es un `done` con un texto de política, como respondería el BFF
  real (el mock emula el espíritu del mensaje canónico, no lo importa —
  no hay build en este ejemplo).

### Modo real: contra un deploy

Primero, generar el secreto compartido (una sola vez por stage) y guardarlo
fuera del repo:

```bash
openssl rand -base64 32 > ../../.secreto-demo.local
```

Ese mismo valor tiene que coincidir con el `ClientHmacSecret` del stage:

```bash
npx sst secret set ClientHmacSecret "$(cat ../../.secreto-demo.local)" --stage <stage>
```

Y recién ahí correr el demo:

```bash
npm run build -w @craftech-ai-chat/widget
CHAT_HMAC_SECRET="$(cat ../../.secreto-demo.local)" \
CHAT_URL="<la Function URL del deploy>" \
  npm start -w @craftech-ai-chat/demo-client
```

Abrir http://localhost:3000. Con `?user=A` y `?user=B` en dos pestañas se ve que cada
usuario tiene su propia conversación.
