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

El chat es asíncrono: al mandar un mensaje el widget hace `POST /mensajes` y
después hace polling con `GET /mensajes` hasta que aparece la respuesta, que
llega entera cuando está lista.
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

El chat también tiene memoria, topes de uso y un guardrail de entrada; el mock
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

#### Tools en modo local

El agente real puede usar herramientas; el mock lo hace visible con dos
escenarios más, que responden con los mismos datos fijos que sirve la demo
API (`examples/api-cliente`):

- `pedido` → responde como si el agente hubiera usado la tool `mis_pedidos`
  (tus pedidos A-1001 y A-0997). Es un turno normal: pasa por el debounce.
- `catalogo` (o `catálogo`, da igual) → ídem con `listar_catalogo`: los 3
  productos del catálogo demo.

En modo real esas tools no las simula nadie: las ejecuta el agente en AWS —
`listar_catalogo` vía el AgentCore Gateway (MCP) y `mis_pedidos` llamando a
la API del cliente por HTTP con el token del usuario.

#### Documentos y escalamiento en modo local

El agente también responde desde los documentos del cliente y, cuando no
encuentra la respuesta, ofrece derivar a una persona. Los dos escenarios citan
el corpus ficticio de `examples/documentos` (la empresa inventada Ciclos
Aurora):

- `documento` → responde como si hubiera usado la tool `consultar_documentos`,
  **con la cita**: "Según *Política de devoluciones* (`politica-devoluciones.md`)
  …". Es un turno normal: pasa por el debounce.
- `escalar` → el flujo de consentimiento, en **dos pasos**. Primero dice que no
  encontró eso en los documentos (y no improvisa) y pregunta si querés que te
  derive. Recién si contestás **"sí"** (o "si", "dale", "ok", "claro",
  "acepto") crea el escalamiento y te da la referencia `ESC-2043`. Si contestás
  cualquier otra cosa, no se crea nada: ese ida y vuelta es la regla del
  producto, no un detalle de la demo.

Un par de cosas de cómo está hecho, porque se ven en el código:

- El segundo paso se reconoce por el **mensaje anterior de la conversación**
  (el historial que el server ya guarda para el escenario `memoria`), así que
  `planificarRespuesta` sigue siendo pura. Ojo con el debounce: si mandás
  `escalar` y `sí` en menos de 1200ms se agrupan en un solo turno y el mock
  contesta el paso 1 — hay que esperar la primera respuesta.
- La aceptación se matchea **por palabra**, no por inclusión como el resto de
  las keywords: "sí" es substring de "así", y un "no, dejemos así" no puede
  crear un escalamiento que nadie aceptó.

Las respuestas se muestran **renderizadas**: el agente escribe en markdown y el
widget lo convierte en negrita, itálica, código, listas y links. Nunca interpreta
HTML del modelo — construye los nodos él mismo (`packages/widget/src/markdown.ts`)
y solo deja pasar links `http`, `https` y `mailto`.

En modo real esto tampoco lo simula nadie: `consultar_documentos` hace
`Retrieve` contra la Knowledge Base (Bedrock, S3 Vectors) y `escalar_a_humano`
postea al webhook del adaptador de escalamiento; la política de no inventar,
citar y ofrecer derivar es el prompt del sistema (`promptSistema` en
`client.config.ts`).

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

(El server también acepta `CHAT_URL` como alias de `API_URL`, si esta última
no está seteada.)

Abrir http://localhost:3000. Con `?user=A` y `?user=B` en dos pestañas se ve que cada
usuario tiene su propia conversación.

### Modo Cognito: login real contra el User Pool

Cuando el stage está configurado para validar tokens de Cognito (JWKS con
issuer y audience pineados), el demo no firma tokens por HMAC: muestra un
login real. `POST /login` habla con Cognito (`InitiateAuth`, sin SDK), guarda
el ID token en una cookie HttpOnly y `/chat-token` devuelve ese token — el JS
de la página nunca lo tiene en la mano.

Los datos del User Pool contra el que se loguea el demo van en
`.cognito-demo.local` (en el root del repo, gitignoreado, claves `COGNITO_*`).
Desde el root:

```bash
set -a; source .cognito-demo.local; set +a
API_URL="<la Function URL del Messages Backend>" \
  npm start -w @craftech-ai-chat/demo-client
```

Con `COGNITO_CLIENT_ID` seteado el server entra en modo cognito y
`CHAT_HMAC_SECRET` no hace falta (`COGNITO_REGION` es opcional, default
`us-east-1`).

Tres notas del modo cognito:

- Hay que tener en el pool un **app client sin client secret y con el flow
  `USER_PASSWORD_AUTH` habilitado** (es el que usa este demo), y un usuario con
  password permanente. El id del pool y el del app client salen del output del
  deploy, de la consola, o de la CLI:

  ```bash
  aws cognito-idp list-user-pools --max-results 20
  aws cognito-idp list-user-pool-clients --user-pool-id <tu-user-pool-id>
  ```

  Alta de un usuario para probar (el mismo `COGNITO_CLIENT_ID` que va en
  `.cognito-demo.local` tiene que ser el de ese pool):

  ```bash
  POOL_ID="<tu-user-pool-id>"   # p. ej. us-east-1_XXXXXXXXX
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
    --username <usuario> --message-action SUPPRESS
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
    --username <usuario> --password '<password>' --permanent
  ```
- Dos pestañas del mismo browser **comparten la cookie de sesión** — también
  en modo mock, donde la cookie `cc_user` le gana al `?user=` de la URL. Para
  el momento "aislamiento entre usuarios" de la demo, en cualquiera de los dos
  modos, abrí una ventana de incógnito y entrá con otro usuario.
- La sesión dura **~55 minutos** (la vida del ID token). Al vencer, el chat
  muestra el error genérico ("Hubo un problema al responder"): recargá la
  página y volvé a loguearte. El widget no distingue una sesión vencida de
  cualquier otro error.
