// Mini-login del demo: en mock es simulado (cookie cc_user, cualquier
// usuario/contraseña no vacíos); en cognito es real (InitiateAuth
// USER_PASSWORD_AUTH → ID token en cookie cc_id, HttpOnly).
//
// Los servers se levantan en puerto efímero (patrón de mock.test.mjs) y el
// modo se elige pasando el entorno a crearServer(entorno) — sin tocar
// process.env, así los dos modos conviven en el mismo proceso de test.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crearServer } from "./server.mjs";

// Decodifica el payload de un JWT sin verificar la firma (suficiente para
// asertar el `sub` que el mock firma).
function payloadDe(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("modo mock: login simulado", () => {
  let server;
  let base;

  beforeAll(async () => {
    // Entorno vacío ⇒ sin API_URL ⇒ modo mock, gane lo que gane process.env.
    server = crearServer({});
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("mock: POST /login setea cookie y /chat-token emite token para ese usuario", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usuario: "Ana", contrasena: "cualquiera" }),
    });

    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ usuario: "Ana" });

    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("cc_user=Ana");
    expect(cookie).toContain("HttpOnly");

    // El browser reenviaría la cookie sola; acá se pega a mano. La identidad
    // del token tiene que salir de la cookie, no del query.
    const tokenRes = await fetch(`${base}/chat-token`, {
      headers: { cookie: "cc_user=Ana" },
    });
    expect(tokenRes.status).toBe(200);
    const { token } = await tokenRes.json();
    expect(payloadDe(token).sub).toBe("Ana");
  });

  it("mock: POST /login sin usuario responde 401 login_invalido", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usuario: "", contrasena: "cualquiera" }),
    });

    expect(login.status).toBe(401);
    expect(await login.json()).toEqual({ error: { code: "login_invalido" } });
  });

  it("mock: /chat-token sin cookie mantiene el fallback ?user= (compat)", async () => {
    const tokenRes = await fetch(`${base}/chat-token?user=Bruno`);
    expect(tokenRes.status).toBe(200);
    const { token } = await tokenRes.json();
    expect(payloadDe(token).sub).toBe("Bruno");
  });
});

// El placeholder de auth aparece dos veces en el HTML, así que el reemplazo
// tiene que ser replaceAll: con un replace simple el del script queda sin
// reemplazar, la página arranca en un modo inexistente y el login no aparece
// nunca.
describe("el HTML servido inyecta el modo de auth", () => {
  async function htmlServidoCon(entorno) {
    const server = crearServer(entorno);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      return await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    } finally {
      server.close();
    }
  }

  it.each([
    [{}, "mock"],
    [{ API_URL: "https://api.ejemplo.test", CHAT_HMAC_SECRET: "x".repeat(32) }, "hmac"],
    [{ API_URL: "https://api.ejemplo.test", COGNITO_CLIENT_ID: "abc" }, "cognito"],
  ])("inyecta AUTH_MODO %#: %s", async (entorno, modoEsperado) => {
    const html = await htmlServidoCon(entorno);
    expect(html).toContain(`const AUTH_MODO = "${modoEsperado}"`);
    expect(html).not.toContain("__AUTH_MODO__");
  });
});

describe("modo cognito: login real contra Cognito (fetch stubbeado)", () => {
  const ID_TOKEN_FAKE = "cabecera.eyJzdWIiOiJ1c3VhcmlvLWRlLXBydWViYSJ9.firma";
  const fetchOriginal = globalThis.fetch;
  let llamadasCognito;
  let server;
  let base;

  beforeAll(async () => {
    server = crearServer({
      API_URL: "https://api.ejemplo.test",
      COGNITO_CLIENT_ID: "cliente-de-prueba",
      COGNITO_REGION: "us-east-1",
    });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // Stub selectivo: intercepta SOLO las llamadas a Cognito y deja pasar el
    // resto (los fetch del propio test contra el server local).
    globalThis.fetch = async (url, opciones) => {
      if (String(url).includes("cognito-idp.")) {
        llamadasCognito.push({ url: String(url), opciones });
        return new Response(
          JSON.stringify({ AuthenticationResult: { IdToken: ID_TOKEN_FAKE } }),
          { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } },
        );
      }
      return fetchOriginal(url, opciones);
    };
  });

  beforeEach(() => {
    llamadasCognito = [];
  });

  afterAll(() => {
    globalThis.fetch = fetchOriginal;
    server.close();
  });

  it("cognito: POST /login llama InitiateAuth y guarda el IdToken en cookie cc_id", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usuario: "usuario-de-prueba", contrasena: "s3creta!" }),
    });

    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ usuario: "usuario-de-prueba" });

    // La llamada a Cognito: endpoint regional, target InitiateAuth y el flow
    // con las credenciales tal cual las mandó el form.
    expect(llamadasCognito).toHaveLength(1);
    const [llamada] = llamadasCognito;
    expect(llamada.url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(llamada.opciones.headers["x-amz-target"]).toBe(
      "AWSCognitoIdentityProviderService.InitiateAuth",
    );
    expect(JSON.parse(llamada.opciones.body)).toEqual({
      ClientId: "cliente-de-prueba",
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "usuario-de-prueba", PASSWORD: "s3creta!" },
    });

    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain(`cc_id=${ID_TOKEN_FAKE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3300");
  });

  it("cognito: /chat-token sin cookie responde 401 login_requerido", async () => {
    const tokenRes = await fetch(`${base}/chat-token`);

    expect(tokenRes.status).toBe(401);
    expect(await tokenRes.json()).toEqual({ error: { code: "login_requerido" } });
  });

  it("cognito: /chat-token con cookie devuelve {token} con el IdToken", async () => {
    const tokenRes = await fetch(`${base}/chat-token`, {
      headers: { cookie: `cc_id=${ID_TOKEN_FAKE}` },
    });

    expect(tokenRes.status).toBe(200);
    expect(await tokenRes.json()).toEqual({ token: ID_TOKEN_FAKE });
  });

  it("cognito: credenciales rechazadas por Cognito → 401 login_invalido, sin filtrar el detalle", async () => {
    const stubAnterior = globalThis.fetch;
    globalThis.fetch = async (url, opciones) => {
      if (String(url).includes("cognito-idp.")) {
        return new Response(
          JSON.stringify({ __type: "NotAuthorizedException", message: "Incorrect username or password." }),
          { status: 400, headers: { "content-type": "application/x-amz-json-1.1" } },
        );
      }
      return fetchOriginal(url, opciones);
    };

    try {
      const login = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usuario: "usuario-de-prueba", contrasena: "mala" }),
      });

      expect(login.status).toBe(401);
      // El detalle de Cognito no viaja al browser: solo el código propio.
      expect(await login.json()).toEqual({ error: { code: "login_invalido" } });
    } finally {
      globalThis.fetch = stubAnterior;
    }
  });
});
