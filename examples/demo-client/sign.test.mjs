import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { signChatToken } from "./sign.mjs";

const SECRETO = "un-secreto-de-al-menos-32-bytes!!";
const clave = new TextEncoder().encode(SECRETO);

describe("signChatToken", () => {
  it("produce un token que jose verifica: es interoperable con el BFF", async () => {
    const token = signChatToken("4821", SECRETO);
    const { payload } = await jwtVerify(token, clave);
    expect(payload.sub).toBe("4821");
  });

  it("respeta el TTL y vence", async () => {
    const token = signChatToken("4821", SECRETO, -1);
    await expect(jwtVerify(token, clave)).rejects.toMatchObject({
      name: "JWTExpired",
    });
  });

  it("un token firmado con otro secreto no verifica", async () => {
    const token = signChatToken("4821", "otro-secreto-de-32-bytes-o-mas!!");
    await expect(jwtVerify(token, clave)).rejects.toBeTruthy();
  });
});
