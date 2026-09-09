import { beforeEach, describe, expect, it, vi } from "vitest";
import { SesionVencida, TokenSource } from "./token";

describe("TokenSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pide el token al backend del cliente una sola vez y lo cachea", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "t1" })));
    vi.stubGlobal("fetch", fetchMock);

    const src = new TokenSource("/chat-token");
    expect(await src.get()).toBe("t1");
    expect(await src.get()).toBe("t1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tras invalidate pide uno nuevo", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: `t${++n}` }))));

    const src = new TokenSource("/chat-token");
    expect(await src.get()).toBe("t1");
    src.invalidate();
    expect(await src.get()).toBe("t2");
  });

  it("si el backend del cliente no da token, falla con un mensaje claro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    await expect(new TokenSource("/chat-token").get()).rejects.toThrow(/chat-token/);
  });

  // El 401 tiene su propio tipo: el host lo distingue de una caída de red para
  // mandar a la persona al login en vez de mostrar "hubo un problema".
  it("un 401 falla con SesionVencida, no con un Error genérico", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(new TokenSource("/chat-token").get()).rejects.toBeInstanceOf(SesionVencida);
  });

  it("un 403 NO es SesionVencida: no manda al login por un permiso", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    await expect(new TokenSource("/chat-token").get()).rejects.not.toBeInstanceOf(SesionVencida);
  });
});
