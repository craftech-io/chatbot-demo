import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenSource } from "./token";

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
});
