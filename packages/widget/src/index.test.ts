import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./index";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Fetch stub del transporte del widget (POST + polling, todo JSON): distingue
// el pedido de token, el POST a /mensajes y los GET de polling por método —
// las tres rutas comparten hostname/base en producción. Cada función recibe
// el número de llamada (1-based) a esa ruta, para simular secuencias (ej. dos
// polls vacíos y el tercero con la respuesta).
function crearFetchMock(rutas: {
  token?: (n: number) => Response;
  post?: (n: number) => Response | Promise<Response>;
  get?: (n: number) => Response;
}) {
  let tokenN = 0;
  let postN = 0;
  let getN = 0;
  const llamadasGet: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("chat-token")) {
      tokenN++;
      return rutas.token ? rutas.token(tokenN) : json({ token: `t${tokenN}` });
    }
    if (init?.method === "POST") {
      postN++;
      return rutas.post!(postN);
    }
    getN++;
    llamadasGet.push(u);
    return rutas.get!(getN);
  });
  return { fn, llamadasGet, postCount: () => postN, getCount: () => getN };
}

describe("mount", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("hace polling hasta encontrar la respuesta del asistente y renderiza su texto", async () => {
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1", orden: "o1" }),
      get: (n) =>
        n < 3
          ? json({ mensajes: [] })
          : json({ mensajes: [{ rol: "user", texto: "eco", orden: "o1" }, { rol: "assistant", texto: "Hola mundo", orden: "o2" }] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("¿hola?");

    expect(mock.getCount()).toBe(3);
    expect(el.querySelector(".cc-respuesta")?.textContent).toBe("Hola mundo");
    // El primer poll usa el `orden` que devolvió el POST como cursor `desde`,
    // y el `hilo` de la sesión.
    expect(mock.llamadasGet[0]).toContain("hilo=");
    expect(mock.llamadasGet[0]).toContain("desde=o1");
  });

  it("normaliza la barra final de apiUrl: nunca pide //mensajes", async () => {
    // La Function URL de Lambda se suele copiar con barra final
    // (https://….on.aws/). Sin normalizar, `${apiUrl}/mensajes` arma
    // //mensajes, que el router del BFF no matchea (404) — y el usuario ve el
    // error genérico en todos los mensajes.
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1", orden: "o1" }),
      get: () => json({ mensajes: [{ rol: "assistant", texto: "ok", orden: "o2" }] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api/", _pollMs: 1 }).send("hola");

    const urls = mock.fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("mensajes"));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain("/api/mensajes");
      expect(u).not.toContain("//mensajes");
    }
  });

  it("ante expired_token renueva el token y reintenta UNA vez", async () => {
    const mock = crearFetchMock({
      post: (n) => (n === 1 ? json({ error: { code: "expired_token" } }, 401) : json({ msgId: "m1", conversationId: "c1", orden: "o1" })),
      get: () => json({ mensajes: [{ rol: "assistant", texto: "listo", orden: "o2" }] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    expect(mock.postCount()).toBe(2);
    expect(el.textContent).toContain("listo");
  });

  it("ante un 401 sin expired_token (invalid_token) NO reintenta y muestra el error genérico", async () => {
    const mock = crearFetchMock({
      post: () => json({ error: { code: "invalid_token" } }, 401),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    expect(mock.postCount()).toBe(1);
    expect(el.textContent).toMatch(/problema al responder/i);
  });

  it("ante limit_reached (429) muestra el mensaje del registro según el motivo", async () => {
    const mock = crearFetchMock({
      post: () => json({ error: { code: "limit_reached", motivo: "dia" } }, 429),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    expect(el.textContent).toMatch(/límite de mensajes de hoy/i);
  });

  it("ante una respuesta HTTP inesperada (5xx, sin JSON) muestra el error genérico", async () => {
    const mock = crearFetchMock({
      post: () => new Response("Internal Server Error", { status: 500 }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    expect(el.textContent).toMatch(/problema al responder/i);
    expect(mock.getCount()).toBe(0);
  });

  it("ante una falla de red (fetch que rechaza) muestra el error generico, no una rejection sin manejar", async () => {
    const mock = crearFetchMock({
      post: () => Promise.reject(new Error("red caida")),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await expect(
      mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola"),
    ).resolves.toBeUndefined();

    expect(el.textContent).toMatch(/problema al responder/i);
  });

  it("si el POST 200 no trae `orden` (contrato incumplido) muestra el error genérico sin arrancar el polling", async () => {
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1" }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    expect(el.textContent).toMatch(/problema al responder/i);
    expect(mock.getCount()).toBe(0);
  });

  it("ante timeout de polling (nunca llega la respuesta) muestra el error genérico", async () => {
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1", orden: "o1" }),
      get: () => json({ mensajes: [] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1, _pollTimeoutMs: 3 }).send("hola");

    expect(el.textContent).toMatch(/problema al responder/i);
    // El número de intentos se deriva de pollTimeoutMs/pollMs (determinístico
    // en tests, sin depender de que el reloj de pared avance esos ms).
    expect(mock.getCount()).toBe(3);
  });

  it("dos sends concurrentes (el debounce del server los agrega) no abren un segundo poller ni duplican la respuesta", async () => {
    const mock = crearFetchMock({
      // Ambos POST salen bien (el server los necesita a los dos para agregar
      // el turno) — pero solo debe existir UN poller.
      post: (n) => json({ msgId: `m${n}`, conversationId: "c1", orden: `o${n}` }),
      get: (n) =>
        n < 2 ? json({ mensajes: [] }) : json({ mensajes: [{ rol: "assistant", texto: "Hola a los dos", orden: "o3" }] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    const widget = mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 });

    // Sin await entre medio: el segundo send() se dispara mientras el primero
    // todavía no resolvió su POST.
    const p1 = widget.send("hola");
    const p2 = widget.send("qué tal");
    await Promise.all([p1, p2]);

    expect(mock.postCount()).toBe(2);
    expect(el.querySelectorAll(".cc-usuario").length).toBe(2);
    expect(el.querySelectorAll(".cc-respuesta").length).toBe(1);
    expect(el.querySelector(".cc-respuesta")?.textContent).toBe("Hola a los dos");
    expect(el.querySelectorAll(".cc-punto").length).toBe(0);
  });

  it("ante 401 persistente en el polling renueva el token UNA vez y, si sigue fallando, corta con el error genérico sin esperar el timeout", async () => {
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1", orden: "o1" }),
      get: () => json({ error: { code: "expired_token" } }, 401), // siempre 401, incluso tras renovar
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    // pollTimeoutMs alto a propósito: si el 401 se tratara como "todavía no",
    // este test tardaría en agotar el timeout. El corte debe ser inmediato.
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1, _pollTimeoutMs: 1000 }).send("hola");

    expect(el.textContent).toMatch(/problema al responder/i);
    // Un solo ciclo del loop: el GET original + el reintento tras renovar
    // token — muy por debajo del máximo (1000/1 = 1000 intentos).
    expect(mock.getCount()).toBe(2);
  });

  it("renderiza la burbuja del usuario con el texto enviado", async () => {
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1", orden: "o1" }),
      get: () => json({ mensajes: [{ rol: "assistant", texto: "Hola", orden: "o2" }] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    const hilo = el.querySelector(".cc-hilo");
    const hijos = hilo ? Array.from(hilo.children) : [];
    const idxUsuario = hijos.findIndex((h) => h.classList.contains("cc-usuario"));
    const idxRespuesta = hijos.findIndex((h) => h.classList.contains("cc-respuesta"));

    expect(el.querySelector(".cc-usuario")?.textContent).toBe("hola");
    expect(idxUsuario).toBeGreaterThanOrEqual(0);
    expect(idxUsuario).toBeLessThan(idxRespuesta);
  });

  it("no duplica la burbuja del usuario en el retry de expired_token", async () => {
    const mock = crearFetchMock({
      post: (n) => (n === 1 ? json({ error: { code: "expired_token" } }, 401) : json({ msgId: "m1", conversationId: "c1", orden: "o1" })),
      get: () => json({ mensajes: [{ rol: "assistant", texto: "listo", orden: "o2" }] }),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    await mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    expect(mock.postCount()).toBe(2);
    expect(el.querySelectorAll(".cc-usuario").length).toBe(1);
    expect(el.querySelector(".cc-usuario")?.textContent).toBe("hola");
  });

  it("muestra el indicador de escribiendo hasta que llega la respuesta del polling", async () => {
    const mock = crearFetchMock({
      post: () => json({ msgId: "m1", conversationId: "c1", orden: "o1" }),
      get: (n) => (n < 2 ? json({ mensajes: [] }) : json({ mensajes: [{ rol: "assistant", texto: "Hola", orden: "o2" }] })),
    });
    vi.stubGlobal("fetch", mock.fn);

    const el = document.createElement("div");
    document.body.append(el);
    const promesa = mount(el, { tokenUrl: "/chat-token", apiUrl: "/api", _pollMs: 1 }).send("hola");

    // enviar() corre sincrónico hasta su primer await: justo después de llamar
    // a send(), la burbuja de respuesta ya nació con el indicador de
    // escribiendo. Esto no depende del timing de happy-dom (es semántica de
    // async functions), así que se verifica el estado "antes" además del
    // estado final.
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

    mount(el1, { tokenUrl: "/chat-token", apiUrl: "/api" });
    mount(el2, { tokenUrl: "/chat-token", apiUrl: "/api" });

    expect(document.querySelectorAll("#cc-estilos").length).toBe(1);
    // El CSS vive en @layer: así, sin importar el orden de inyección ni la
    // especificidad, un <style> sin capa del host (ej. la demo) le gana
    // siempre a este — la cascada de capas no depende de quién se inyectó
    // último en el <head>.
    expect(document.getElementById("cc-estilos")?.textContent?.trim().startsWith("@layer cc-widget")).toBe(
      true,
    );
  });

  it("los colores salen de las --cc-*, no de literales: si no, la marca del host no llega", () => {
    const el = document.createElement("div");
    document.body.append(el);
    mount(el, { tokenUrl: "/chat-token", apiUrl: "/api" });

    const css = document.getElementById("cc-estilos")?.textContent ?? "";
    const conColor = css.split("\n").filter((l) => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(l));

    // Un color literal solo puede estar donde se declara el DEFAULT de una
    // custom property. En una regla concreta (una tabla, una cita) dejaría de
    // seguir al host.
    expect(conColor.filter((l) => !l.trim().startsWith("--cc-"))).toEqual([]);
  });
});
