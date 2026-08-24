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

  it("el done reconcilia la burbuja con el texto autoritativo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse(
              'data: {"type":"delta","text":"Hola mund"}\n\n',
              'data: {"type":"done","text":"Hola mundo"}\n\n',
            ),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(el.querySelector(".cc-respuesta")?.textContent).toBe("Hola mundo");
  });

  it("una respuesta sin ningún frame SSE muestra el error genérico", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : new Response("Internal Server Error", { status: 500 }),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    expect(el.textContent).toMatch(/problema al responder/i);
  });

  it("ante una falla de red (fetch que rechaza) muestra el error generico, no una rejection sin manejar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : Promise.reject(new Error("red caida")),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await expect(
      mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola"),
    ).resolves.toBeUndefined();

    expect(el.textContent).toMatch(/problema al responder/i);
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

  it("ante limit_reached muestra el mensaje del registro según el motivo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"error","code":"limit_reached","motivo":"dia"}\n\n'),
      ),
    );
    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");
    expect(el.textContent).toMatch(/límite de mensajes de hoy/i);
  });

  it("renderiza la burbuja del usuario con el texto enviado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("chat-token")
          ? new Response(JSON.stringify({ token: "t1" }))
          : sse('data: {"type":"delta","text":"Hola"}\n\n'),
      ),
    );

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    const hilo = el.querySelector(".cc-hilo");
    const hijos = hilo ? Array.from(hilo.children) : [];
    const idxUsuario = hijos.findIndex((h) => h.classList.contains("cc-usuario"));
    const idxRespuesta = hijos.findIndex((h) => h.classList.contains("cc-respuesta"));

    expect(el.querySelector(".cc-usuario")?.textContent).toBe("hola");
    expect(idxUsuario).toBeGreaterThanOrEqual(0);
    expect(idxUsuario).toBeLessThan(idxRespuesta);
  });

  it("no duplica la burbuja del usuario en el retry de expired_token", async () => {
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
    expect(el.querySelectorAll(".cc-usuario").length).toBe(1);
    expect(el.querySelector(".cc-usuario")?.textContent).toBe("hola");
  });

  it("muestra el indicador de escribiendo hasta el primer delta", async () => {
    const enc = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("chat-token")) {
          return new Response(JSON.stringify({ token: "t1" }));
        }
        return new Response(
          new ReadableStream({
            async start(c) {
              // El primer delta llega recién tras un tick: simula la demora real
              // de la red para poder observar el estado "escribiendo".
              await Promise.resolve();
              c.enqueue(enc.encode('data: {"type":"delta","text":"Hola"}\n\n'));
              c.close();
            },
          }),
          { status: 200 },
        );
      }),
    );

    const el = document.createElement("div");
    document.body.append(el);
    const promesa = mount(el, { tokenUrl: "/chat-token", chatUrl: "/chat" }).send("hola");

    // enviar() corre sincrónico hasta su primer await: justo después de llamar a
    // send(), la burbuja de respuesta ya nació con el indicador de escribiendo.
    // Esto no depende del timing de happy-dom (es semántica de async functions),
    // así que se verifica el estado "antes" además del estado final.
    const burbuja = el.querySelector(".cc-respuesta");
    expect(burbuja?.classList.contains("cc-escribiendo")).toBe(true);
    expect(el.querySelectorAll(".cc-punto").length).toBe(3);

    await promesa;

    expect(el.querySelector(".cc-respuesta")?.classList.contains("cc-escribiendo")).toBe(false);
    expect(el.querySelector(".cc-respuesta")?.textContent).toBe("Hola");
  });

  it("inyecta los estilos una sola vez", () => {
    const el1 = document.createElement("div");
    const el2 = document.createElement("div");
    document.body.append(el1, el2);

    mount(el1, { tokenUrl: "/chat-token", chatUrl: "/chat" });
    mount(el2, { tokenUrl: "/chat-token", chatUrl: "/chat" });

    expect(document.querySelectorAll("#cc-estilos").length).toBe(1);
    // El CSS vive en @layer: así, sin importar el orden de inyección ni la
    // especificidad, un <style> sin capa del host (ej. la demo) le gana
    // siempre a este — la cascada de capas no depende de quién se inyectó
    // último en el <head>.
    expect(document.getElementById("cc-estilos")?.textContent?.trim().startsWith("@layer cc-widget")).toBe(
      true,
    );
  });
});
