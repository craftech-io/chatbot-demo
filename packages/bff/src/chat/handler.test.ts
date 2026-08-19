import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { handleChat, type InvokePayload } from "./handler";

const SECRET = "un-secreto-de-al-menos-32-bytes!!";
const cfg = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/x",
  verifier: { kind: "hmac", secret: SECRET } as const,
};
const enc = new TextEncoder();

async function token(claims: Record<string, unknown> = { sub: "4821" }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

function invokeFalso(recibido: InvokePayload[]) {
  return async (p: InvokePayload) => {
    recibido.push(p);
    return (async function* () {
      yield enc.encode('{"type":"delta","text":"Hola"}\n');
      yield enc.encode('{"type":"done","text":"Hola"}\n');
    })();
  };
}

async function frames(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe("handleChat", () => {
  it("traduce el stream del runtime a frames SSE", async () => {
    const recibido: InvokePayload[] = [];
    const r = await handleChat(
      { token: await token(), message: "¿hola?", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido) },
    );
    expect(r.status).toBe(200);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"delta","text":"Hola"}\n\n',
      'data: {"type":"done","text":"Hola"}\n\n',
    ]);
  });

  it("le pasa al runtime el userId del token, nunca uno del request", async () => {
    const recibido: InvokePayload[] = [];
    await handleChat(
      { token: await token({ sub: "4821", act_token: "tok" }), message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso(recibido) },
    );
    expect(recibido[0]).toMatchObject({ userId: "4821", actToken: "tok", message: "hola" });
  });

  it("aisla la microVM por usuario: mismo sessionId del browser, sesiones distintas", async () => {
    // AgentCore rutea por runtimeSessionId y mantiene VIVA la microVM entre
    // invocaciones. Si el id viniera crudo del browser, un usuario podría pedir la
    // microVM caliente de otro, con su filesystem y su memoria.
    const recibido: InvokePayload[] = [];
    const invoke = invokeFalso(recibido);
    await handleChat({ token: await token({ sub: "A" }), message: "hola", sessionId: "s1" }, { cfg, invoke });
    await handleChat({ token: await token({ sub: "B" }), message: "hola", sessionId: "s1" }, { cfg, invoke });

    expect(recibido[0].sessionId).not.toBe(recibido[1].sessionId);
    // Y el id no filtra el userId: es un hash, no una concatenación.
    expect(recibido[0].sessionId).not.toContain("A");
    expect(recibido[0].sessionId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el mismo usuario en el mismo hilo reusa la misma microVM", async () => {
    const recibido: InvokePayload[] = [];
    const invoke = invokeFalso(recibido);
    await handleChat({ token: await token({ sub: "A" }), message: "1", sessionId: "s1" }, { cfg, invoke });
    await handleChat({ token: await token({ sub: "A" }), message: "2", sessionId: "s1" }, { cfg, invoke });
    expect(recibido[0].sessionId).toBe(recibido[1].sessionId);
  });

  it("responde 401 sin token", async () => {
    const r = await handleChat(
      { message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso([]) },
    );
    expect(r.status).toBe(401);
  });

  it("responde 401 con code expired_token para que el widget renueve", async () => {
    const vencido = await new SignJWT({ sub: "4821" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("-1m")
      .sign(new TextEncoder().encode(SECRET));
    const r = await handleChat(
      { token: vencido, message: "hola", sessionId: "s1" },
      { cfg, invoke: invokeFalso([]) },
    );
    expect(r.status).toBe(401);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"error","code":"expired_token"}\n\n',
    ]);
  });

  it("responde 400 sin mensaje", async () => {
    const r = await handleChat(
      { token: await token(), sessionId: "s1" },
      { cfg, invoke: invokeFalso([]) },
    );
    expect(r.status).toBe(400);
  });

  it("si el stream muere a mitad de la respuesta, emite un frame de error", async () => {
    const r = await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      {
        cfg,
        invoke: async () =>
          (async function* () {
            yield enc.encode('{"type":"delta","text":"Hola"}\n');
            throw new Error("microVM caída");
          })(),
      },
    );
    expect(r.status).toBe(200);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"delta","text":"Hola"}\n\n',
      'data: {"type":"error","code":"agent_unavailable"}\n\n',
    ]);
  });

  it("si el runtime falla, emite un evento de error en vez de tirar", async () => {
    const r = await handleChat(
      { token: await token(), message: "hola", sessionId: "s1" },
      {
        cfg,
        invoke: async () => {
          throw new Error("runtime caído");
        },
      },
    );
    expect(r.status).toBe(200);
    expect(await frames(r.frames)).toEqual([
      'data: {"type":"error","code":"agent_unavailable"}\n\n',
    ]);
  });
});
