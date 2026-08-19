import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
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
});
