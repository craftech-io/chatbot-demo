import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AuthError, verifyUserToken } from "./verify";

const SECRET = new TextEncoder().encode("un-secreto-de-al-menos-32-bytes!!");
const verifier = { kind: "hmac", secret: "un-secreto-de-al-menos-32-bytes!!" } as const;

async function firmar(claims: Record<string, unknown>, exp = "10m") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(SECRET);
}

describe("verifyUserToken", () => {
  it("devuelve el principal de un token HMAC valido", async () => {
    const token = await firmar({ sub: "4821", email: "juan@empresa.com" });
    const p = await verifyUserToken(token, verifier);
    expect(p).toEqual({ userId: "4821", email: "juan@empresa.com", actToken: undefined });
  });

  it("propaga el actToken cuando viene en el claim", async () => {
    const token = await firmar({ sub: "4821", act_token: "tok-api-cliente" });
    const p = await verifyUserToken(token, verifier);
    expect(p.actToken).toBe("tok-api-cliente");
  });

  it("rechaza un token SIN exp: sin vencimiento serviría para siempre", async () => {
    const sinExp = await new SignJWT({ sub: "4821" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(SECRET);
    await expect(verifyUserToken(sinExp, verifier)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rechaza un token expirado con code expired_token", async () => {
    const token = await firmar({ sub: "4821" }, "-1m");
    await expect(verifyUserToken(token, verifier)).rejects.toMatchObject({
      code: "expired_token",
    });
  });

  it("rechaza una firma que no corresponde", async () => {
    const token = await firmar({ sub: "4821" });
    const otro = { kind: "hmac", secret: "otro-secreto-de-32-bytes-o-mas!!" } as const;
    await expect(verifyUserToken(token, otro)).rejects.toBeInstanceOf(AuthError);
  });

  it("rechaza un token sin sub: sin identidad no hay principal", async () => {
    const token = await firmar({ email: "juan@empresa.com" });
    await expect(verifyUserToken(token, verifier)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rechaza un token HMAC presentado a un verifier JWKS", async () => {
    const token = await firmar({ sub: "4821" });
    const jwksVerifier = { kind: "jwks", url: "https://example.invalid/jwks.json" } as const;
    await expect(verifyUserToken(token, jwksVerifier)).rejects.toBeInstanceOf(AuthError);
  });
});

// Emisor OIDC simulado: un par RS256 local cuyo JWKS se sirve stubeando el
// fetch global (jose ≥5 resuelve el JWKS remoto con fetch). OJO: verify.ts
// cachea el JWKSet por URL a nivel módulo, así que TODOS los casos usan la
// MISMA URL y el MISMO par de claves — el fetch real puede ocurrir una sola
// vez, por eso acá no se aserta cantidad de llamadas al stub.
describe("verifyUserToken (jwks con issuer y audience pineados)", () => {
  const JWKS_URL = "https://emisor-bueno.example/.well-known/jwks.json";
  const ISSUER = "https://emisor-bueno";
  const AUDIENCE = "cliente-bueno";

  let clavePrivada: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const par = await generateKeyPair("RS256");
    clavePrivada = par.privateKey;
    const jwksJson = JSON.stringify({ keys: [await exportJWK(par.publicKey)] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(jwksJson, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // Todos los tokens salen con iss/aud correctos: lo que varía entre casos es
  // qué exige la config del verifier, no el token.
  async function firmarRs256(claims: Record<string, unknown>) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("10m")
      .sign(clavePrivada);
  }

  it("jwks: con issuer y audience configurados, un token correcto pasa", async () => {
    const token = await firmarRs256({ sub: "u-1", email: "ana@empresa.com" });
    const v = { kind: "jwks", url: JWKS_URL, issuer: ISSUER, audience: AUDIENCE } as const;
    const p = await verifyUserToken(token, v);
    expect(p).toEqual({ userId: "u-1", email: "ana@empresa.com", actToken: undefined });
  });

  it("jwks: rechaza issuer distinto con invalid_token", async () => {
    const token = await firmarRs256({ sub: "u-1" });
    const v = { kind: "jwks", url: JWKS_URL, issuer: "https://otro", audience: AUDIENCE } as const;
    await expect(verifyUserToken(token, v)).rejects.toMatchObject({
      name: "AuthError",
      code: "invalid_token",
    });
  });

  it("jwks: rechaza audience distinta con invalid_token", async () => {
    const token = await firmarRs256({ sub: "u-1" });
    const v = { kind: "jwks", url: JWKS_URL, issuer: ISSUER, audience: "otro-cliente" } as const;
    await expect(verifyUserToken(token, v)).rejects.toMatchObject({
      name: "AuthError",
      code: "invalid_token",
    });
  });

  it("jwks: sin issuer/audience configurados valida solo la firma (compat)", async () => {
    const token = await firmarRs256({ sub: "u-1" });
    const v = { kind: "jwks", url: JWKS_URL } as const;
    const p = await verifyUserToken(token, v);
    expect(p.userId).toBe("u-1");
  });
});
