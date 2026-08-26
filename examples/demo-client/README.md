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
    apiUrl: "https://<url-del-messages-backend>",
  });
</script>
```

## Correr este demo

### Quick start: modo mock, sin AWS

Sin backend desplegado, sin secretos, sin variables de entorno. Sirve para
probar la UI/UX del chat (envío, errores, renovación de token) contra
respuestas simuladas por el propio server:

```bash
npm run dev
```

Abrir http://localhost:3000. La página arranca con un mini-login simulado
(cualquier usuario y contraseña no vacíos sirven — la propia página lo
aclara): es la versión local del login real del modo Cognito, para poder
probar el flujo completo de UI/UX sin AWS. El usuario con el que entrás queda
en una cookie y es la identidad que firma el `/chat-token` (los links
`?user=Ana` / `?user=Bruno` prefillean el campo usuario).

Desde la fase 2c el chat es asíncrono (spec §8
v2): al mandar un mensaje el widget hace `POST /mensajes` y después hace
polling con `GET /mensajes` hasta que aparece la respuesta — no hay más
streaming palabra por palabra, la respuesta llega entera cuando está lista.
El mock simula el worker real con un `setTimeout` de 1200ms: si mandás dos
mensajes seguidos antes de que pase ese tiempo, el debounce los agrupa y
contestás una sola vez (se ve en el chat: dos burbujas de usuario, una sola
respuesta).

El mensaje que escribís dispara un escenario según si contiene alguna de
estas palabras (no importan mayúsculas):

- `error` → el worker no pudo generar una respuesta (`agent_unavailable`); el
  usuario igual ve un mensaje, no silencio (texto de fallback).
- `error500` → falla temprana y síncrona del BFF (no del worker): el POST responde `500 {error:{code:"error_interno"}}` de una, sin escribir nada.
- `vencido` → la primera vez simula un token vencido (`expired_token`, 401 en
  el POST); el widget renueva el token solo y reintenta, y esa segunda vez sí
  fluye normal.
- `lento` → una respuesta normal pero que tarda un poco más en aparecer.
- cualquier otro mensaje → una respuesta que saluda por tu usuario, visible
  después del debounce.

Con `?user=A` y `?user=B` en dos pestañas se ve que cada usuario tiene su
propia conversación.

La fase 2b agregó memoria, topes de uso y un guardrail de entrada; el mock
los hace visibles sin AWS con tres escenarios más:

- `memoria` → la respuesta dice cuántos turnos lleva la conversación y cuál
  fue tu mensaje anterior. El server guarda ese historial en memoria de proceso
  (`historialPorConversacion`, por conversación) — se pierde al reiniciar el
  server; es la versión mockeada de la memoria real en AgentCore Memory.
- `tope` → simula haber llegado al límite de uso: `429` en el propio POST,
  con `{error:{code:"limit_reached",motivo:"dia"}}`. No se guarda ni se
  encola nada, la conversación no sigue.
- `bloqueado` → simula al guardrail de entrada rechazando el mensaje. No es
  un error: el POST responde 200 y el usuario y la respuesta de política ya
  quedan escritos de una, sin pasar por el debounce (el mock emula el
  espíritu del mensaje canónico, no lo importa — no hay build en este
  ejemplo).

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
API_URL="<la Function URL del Messages Backend>" \
  npm start -w @craftech-ai-chat/demo-client
```

(`API_URL` reemplaza al viejo `CHAT_URL` de la fase con streaming; el server
todavía lee `CHAT_URL` como fallback si `API_URL` no está seteada, por las
dudas de que algún script externo lo siga exportando así.)

Abrir http://localhost:3000. Con `?user=A` y `?user=B` en dos pestañas se ve que cada
usuario tiene su propia conversación.

### Modo Cognito: login real contra el User Pool

Cuando el stage está configurado para validar tokens de Cognito (JWKS con
issuer y audience pineados), el demo ya no firma tokens por HMAC: muestra un
login real. `POST /login` habla con Cognito (`InitiateAuth`, sin SDK), guarda
el ID token en una cookie HttpOnly y `/chat-token` devuelve ese token — el JS
de la página nunca lo tiene en la mano.

Las credenciales del entorno demo viven en `.cognito-demo.local` (en el root
del repo, gitignoreado, claves `COGNITO_*`). Desde el root:

```bash
set -a; source .cognito-demo.local; set +a
API_URL="<function url de staging>" npm start -w @craftech-ai-chat/demo-client
```

Con `COGNITO_CLIENT_ID` seteado el server entra en modo cognito y
`CHAT_HMAC_SECRET` ya no hace falta (`COGNITO_REGION` es opcional, default
`us-east-1`).

Dos notas del entorno demo:

- El User Pool es **compartido de la cuenta de demos** (lo creó el POC de
  betwarrior y tiene DeletionProtection): un usuario demo sirve para todas
  las demos, no hace falta crear uno por proyecto.
- Dos pestañas del mismo browser **comparten la cookie de sesión** (a
  diferencia del modo mock con `?user=`): para el momento "aislamiento entre
  usuarios" de la demo, abrí una ventana de incógnito y entrá con otro
  usuario del pool.
