import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./index";

function sse(...frames: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200 },
  );
}

describe("mount", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renderiza los deltas a medida que llegan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"delta","text":"Hola"}\n\n', 'data: {"type":"delta","text":" mundo"}\n\n'),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("¿hola?");

    expect(el.textContent).toContain("Hola mundo");
  });

  it("ante expired_token renueva el token y reintenta UNA vez", async () => {
    let chats = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("chat-token")) {
        return new Response(JSON.stringify({ token: `t${chats}` }));
      }
      chats++;
      return chats === 1
        ? sse('data: {"type":"error","code":"expired_token"}\n\n')
        : sse('data: {"type":"delta","text":"listo"}\n\n');
    });
    vi.stubGlobal("fetch", fetchMock);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(chats).toBe(2);
    expect(el.textContent).toContain("listo");
  });

  it("ante agent_unavailable muestra un mensaje al usuario, no un stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"error","code":"agent_unavailable"}\n\n'),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(el.textContent).toMatch(/no est(á|a) disponible/i);
  });
});
