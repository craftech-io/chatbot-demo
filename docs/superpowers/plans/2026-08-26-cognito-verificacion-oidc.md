# Verificación OIDC con Cognito (mini-fase) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El BFF valida tokens de Cognito (JWKS con `issuer` y `audience` pineados) y el demo-client obtiene tokens reales con un login contra el pool compartido de la cuenta de demos.

**Architecture:** El camino JWKS del BFF ya existe (`packages/bff/src/auth/verify.ts`); esta fase lo endurece (pinear emisor y audiencia) y le da un emisor real: un app client propio (`craftech-ai-chat-demo`) en el User Pool compartido `us-east-1_kLcJsB3IG` (creado por el POC betwarrior; hoy con DeletionProtection ACTIVE — es infra compartida de la cuenta de demos, un usuario sirve para todas las demos). El demo-client gana un mini-login: `POST /login` → `InitiateAuth USER_PASSWORD_AUTH` → el ID token viaja en una cookie HttpOnly y `/chat-token` lo devuelve. El widget no cambia: mismo contrato `tokenUrl`.

**Tech Stack:** jose (ya en el bff), Cognito IdP por HTTP plano (`x-amz-json-1.1`, sin SDK nuevo), SST secrets.

**Spec:** `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md` §6 (identidad y autenticación).

## Global Constraints

- Todo en español: código, comentarios, tests, mensajes de commit.
- TDD estricto: test en rojo antes de cada implementación.
- NUNCA `git stash`. NUNCA commitear `.secreto-demo.local` ni `.cognito-demo.local`.
- El widget (`packages/widget`) NO se toca en esta fase.
- Los valores reales del entorno demo (no inventar otros):
  - Pool: `us-east-1_kLcJsB3IG` · región `us-east-1`
  - Issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_kLcJsB3IG`
  - JWKS: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_kLcJsB3IG/.well-known/jwks.json`
  - Audience (client_id): `747e12f5l0kkg7pmpmp8rt4mim`
  - Credenciales demo: en `.cognito-demo.local` (gitignoreado), claves `COGNITO_*`.

## Paralelización

- **Ola 1 (en paralelo, archivos disjuntos):** Task 1 (bff+infra) ∥ Task 2 (demo-client). Un worktree por agente (`wt/c1`, `wt/c2`); merges seriales del controlador con suite completa después de cada merge.
- **Ola 2:** Task 3 (controlador + humano): secrets de staging, deploy y smoke.

---

### Task 1: Pinear issuer y audience en el verificador JWKS (bff + infra)

**Files:**
- Modify: `packages/bff/src/auth/verify.ts` (tipo `Verifier` y rama jwks, ~líneas 19-63)
- Modify: `packages/bff/src/auth/verify.test.ts`
- Modify: `packages/bff/src/config/index.ts` (tipo del campo `auth`)
- Modify: `packages/bff/src/config/resource.ts` (~línea 13, lee `Resource.ClientAuth`)
- Modify: `infra/sst/bff.ts` (~líneas 8-16: secrets y Linkable `ClientAuth`)
- Modify: `sst-env.d.ts` (agregar `issuer`/`audience` a `ClientAuth` a mano; el próximo deploy lo regenera igual)
- Modify: `CONTRACT.md` (documentar los dos secrets nuevos)
- Modify: `docs/superpowers/specs/2026-08-19-craftech-ai-chat-design.md` §6 (dos líneas: el camino OIDC pinea `iss`/`aud`; la cuenta demo usa el pool compartido)

**Interfaces:**
- Produces: `Verifier` = `{ kind: "hmac"; secret: string } | { kind: "jwks"; url: string; issuer?: string; audience?: string }`. Secrets SST nuevos: `ClientTokenIssuer`, `ClientTokenAudience` (default `""`); Linkable `ClientAuth` suma props `issuer` y `audience`. `""` en el secret ⇒ `undefined` en config ⇒ no se exige ese claim (compat con emisores sin OIDC estricto).
- Consumes: nada de otras tareas.

- [ ] **Step 1: Tests en rojo.** En `verify.test.ts`, junto a los tests jwks existentes (seguir su patrón de emisión local de tokens RS256), agregar:

```ts
// dado un token RS256 firmado con la clave local, emitido con
// { iss: "https://emisor-bueno", aud: "cliente-bueno" }:

it("jwks: con issuer y audience configurados, un token correcto pasa", ...);
it("jwks: rechaza issuer distinto con invalid_token", ...);   // config issuer "https://otro"
it("jwks: rechaza audience distinta con invalid_token", ...); // config audience "otro-cliente"
it("jwks: sin issuer/audience configurados valida solo la firma (compat)", ...);
```

Los rechazos deben ser `AuthError` con `code: "invalid_token"` (jose tira `ERR_JWT_CLAIM_VALIDATION_FAILED`, que ya empieza con `ERR_` — cae en la rama existente).

- [ ] **Step 2: Correr y ver fallar.** `npx vitest run --root packages/bff auth` → los 3 primeros FAIL (opciones no existen).

- [ ] **Step 3: Implementación mínima.**

```ts
export type Verifier =
  | { kind: "hmac"; secret: string }
  | { kind: "jwks"; url: string; issuer?: string; audience?: string };

// en la rama jwks de verifyUserToken:
: await jwtVerify(token, jwks(v.url), {
    algorithms: JWKS_ALGS,
    // Con emisor OIDC real (Cognito) se pinean emisor y audiencia: la firma
    // sola no alcanza si el mismo emisor firma para varias apps.
    ...(v.issuer ? { issuer: v.issuer } : {}),
    ...(v.audience ? { audience: v.audience } : {}),
  }));
```

- [ ] **Step 4: Config e infra.** En `infra/sst/bff.ts`:

```ts
const clientTokenIssuer = new sst.Secret("ClientTokenIssuer", "");
const clientTokenAudience = new sst.Secret("ClientTokenAudience", "");

export const clientAuth = new sst.Linkable("ClientAuth", {
  properties: {
    jwksUrl: clientJwksUrl.value,
    hmacSecret: clientHmacSecret.value,
    issuer: clientTokenIssuer.value,
    audience: clientTokenAudience.value,
  },
});
```

En `resource.ts`: leer `issuer`/`audience` de `Resource.ClientAuth`, mapear `""` → `undefined`, pasarlos al `Verifier` jwks. En `config/index.ts`: reflejar el tipo. En `sst-env.d.ts`: sumar `"issuer": string` y `"audience": string` a `ClientAuth`.

- [ ] **Step 5: Verificación completa.** `npm run typecheck && npx vitest run --root packages/bff` → verde. `npx tsc --noEmit -p infra` si existe (usar `npm run typecheck:infra`).

- [ ] **Step 6: Docs.** CONTRACT.md: tabla de variables del BFF suma `ClientTokenIssuer`/`ClientTokenAudience` con su semántica (`""` = no exigir). Spec §6: las dos líneas descritas arriba.

- [ ] **Step 7: Commit.** `fix(bff): pinear issuer y audience en la verificación JWKS`

### Task 2: Modo Cognito del demo-client (login + cookie + /chat-token)

**Files:**
- Modify: `examples/demo-client/server.mjs`
- Modify: `examples/demo-client/public/index.html`
- Modify: `examples/demo-client/mock.mjs` (si el /login mock queda mejor ahí, a criterio; el routing vive en server.mjs)
- Create: `examples/demo-client/login.test.mjs`
- Modify: `examples/demo-client/README.md`

**Interfaces:**
- Consumes: nada de la Task 1 (el demo habla con Cognito y con el BFF ya desplegado, no con código del bff).
- Produces: `POST /login` body `{usuario, contrasena}` → 200 `{usuario}` + `Set-Cookie` HttpOnly; 401 `{error:{code:"login_invalido"}}`. `GET /chat-token` en modo cognito: 200 `{token}` (el ID token de la cookie) o 401 `{error:{code:"login_requerido"}}`. Placeholder nuevo `__AUTH_MODO__` en el HTML: `"cognito" | "mock" | "hmac"`.

**Modos del server (decisión cerrada, no improvisar):**
- `COGNITO_CLIENT_ID` seteado (+ `API_URL`) → modo **cognito**: login real, `/chat-token` devuelve el ID token de la cookie `cc_id` (HttpOnly, SameSite=Lax, Max-Age 3300). `CHAT_HMAC_SECRET` no hace falta.
- Sin `API_URL` → modo **mock** como hoy, PERO con el mismo mini-login (simulado: acepta cualquier usuario/contraseña no vacíos, cookie `cc_user=<usuario>`; `/chat-token` mock usa esa cookie como identidad, con `?user=` de fallback). Es la regla del proyecto: toda capacidad con su modo local para UI/UX.
- `API_URL` + `CHAT_HMAC_SECRET` sin `COGNITO_CLIENT_ID` → modo **hmac** actual, sin login (no romper lo que ya anda).

- [ ] **Step 1: Tests en rojo** (`login.test.mjs`, patrón de `mock.test.mjs`: `crearServer()` + `.listen(0)`):

```js
// mock: el login simulado emite cookie y el chat-token la usa como identidad
it("mock: POST /login setea cookie y /chat-token emite token para ese usuario", ...);
it("mock: POST /login sin usuario responde 401 login_invalido", ...);
// cognito (con globalThis.fetch stubbeado devolviendo AuthenticationResult fake):
it("cognito: POST /login llama InitiateAuth y guarda el IdToken en cookie cc_id", ...);
it("cognito: /chat-token sin cookie responde 401 login_requerido", ...);
it("cognito: /chat-token con cookie devuelve {token} con el IdToken", ...);
```

- [ ] **Step 2: Correr y ver fallar.** `npx vitest run --root examples/demo-client login` → FAIL (ruta no existe).

- [ ] **Step 3: Implementación.** En server.mjs: leer `COGNITO_CLIENT_ID` y `COGNITO_REGION` (default `us-east-1`). El login real, sin SDK:

```js
const r = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
  method: "POST",
  headers: {
    "content-type": "application/x-amz-json-1.1",
    "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
  },
  body: JSON.stringify({
    ClientId: COGNITO_CLIENT_ID,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: usuario, PASSWORD: contrasena },
  }),
});
// r.ok → AuthenticationResult.IdToken → Set-Cookie cc_id=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=3300
// !r.ok → 401 {error:{code:"login_invalido"}} (no filtrar el detalle de Cognito al browser)
```

Cookies: parsear a mano del header (`req.headers.cookie`), sin dependencia nueva.

- [ ] **Step 4: HTML.** `public/index.html`: sección `<form id="login">` (usuario, contraseña, botón "Entrar") visible cuando `__AUTH_MODO__ !== "hmac"`; el chat y su form quedan ocultos (`hidden`) hasta el 200 de `/login`. En mock, un hint aclara "modo local: cualquier usuario y contraseña sirven". `?user=` prefillea el campo usuario. Errores de login en texto humano bajo el form. Recién tras login exitoso se llama a `CraftechChat.mount(...)` (mover el mount a una función `iniciarChat()`).

- [ ] **Step 5: Verde + suite.** `npx vitest run --root examples/demo-client` completo (los tests viejos del mock no deben romperse: el mock `/mensajes` sigue aceptando su token; solo cambia de dónde sale la identidad del `/chat-token`).

- [ ] **Step 6: README.** Sección "Modo Cognito" con el comando:

```bash
set -a; source .cognito-demo.local; set +a
API_URL="<function url de staging>" npm start -w @craftech-ai-chat/demo-client
```

y la nota de que el pool es compartido de la cuenta demos (un usuario para todas las demos), más el detalle de que dos pestañas comparten la cookie → para el momento "aislamiento" de la demo usar una ventana de incógnito con otro usuario del pool.

- [ ] **Step 7: Commit.** `feat(demo): modo Cognito con login real y login simulado en mock`

### Task 3: Staging a Cognito + smoke (controlador + humano)

**Files:** ninguno (operación).

- [ ] Secrets de staging (`sst secret set --stage staging`): `ClientJwksUrl` = JWKS del pool, `ClientTokenIssuer` = issuer, `ClientTokenAudience` = client_id (valores en Global Constraints).
- [ ] Push `fase-2a` → `staging`, CI verde.
- [ ] Smoke: (1) login real con `demo-craftech` desde el demo local en modo cognito → turno completo contra staging; (2) negativo: un token HMAC firmado con `.secreto-demo.local` ahora responde 401 (staging quedó en JWKS); (3) negativo: token de OTRO app client del mismo pool (el de betwarrior, si se puede emitir) o con `aud` adulterada → 401; (4) browser real: login + mensaje + respuesta.
- [ ] Actualizar artifact (sección seguridad/identidad), memoria de estado y runbook (pool compartido, DeletionProtection, cómo dar de alta usuarios demo).

## Self-review

- Cobertura del spec §6: camino OIDC por JWKS (T1), un solo concepto de principal con dos emisores (intacto), "el standalone usa Cognito propio" queda para 2f (fuera de alcance declarado). ✓
- Sin placeholders: cada step tiene código o comando concreto. Los `it(...)` de los tests nombran el caso completo y el patrón a seguir está citado (tests jwks existentes / mock.test.mjs). ✓
- Consistencia de tipos: `Verifier.issuer/audience` (T1) no lo consume T2 (el demo no importa código del bff). `__AUTH_MODO__` solo vive en T2. Los secrets de T3 son los que T1 crea. ✓
