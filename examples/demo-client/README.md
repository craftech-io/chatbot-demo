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

```bash
npm run build -w @craftech-ai-chat/widget
CHAT_HMAC_SECRET="$(cat ../../.secreto-demo.local)" \
CHAT_URL="<la Function URL del deploy>" \
  npm start -w @craftech-ai-chat/demo-client
```

Abrir http://localhost:3000. Con `?user=A` y `?user=B` en dos pestañas se ve que cada
usuario tiene su propia conversación.
