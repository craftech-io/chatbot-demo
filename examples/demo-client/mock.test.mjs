import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planificarRespuesta } from "./mock.mjs";
import { crearServer } from "./server.mjs";

describe("planificarRespuesta", () => {
  it("mensaje normal: termina en done, el done concatena los deltas y el primer delta saluda por el sub", () => {
    const { frames } = planificarRespuesta("Hola, ¿qué tal?", "4821");

    const ultimo = frames.at(-1);
    expect(ultimo.type).toBe("done");

    const deltas = frames.filter((f) => f.type === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.text).join("")).toBe(ultimo.text);

    expect(deltas[0].text).toContain("4821");
  });

  it('mensaje con "error": exactamente un frame agent_unavailable, sin done', () => {
    const { frames } = planificarRespuesta("dame un error por favor", "4821");

    expect(frames).toEqual([{ type: "error", code: "agent_unavailable" }]);
    expect(frames.some((f) => f.type === "done")).toBe(false);
  });

  it('mensaje con "lento": demoraMs 400; un mensaje normal: demoraMs 40', () => {
    const lento = planificarRespuesta("respondé lento por favor", "4821");
    const normal = planificarRespuesta("Hola, ¿qué tal?", "4821");

    expect(lento.demoraMs).toBe(400);
    expect(normal.demoraMs).toBe(40);
  });

  it('es case-insensitive: "ERROR por favor" dispara el escenario de error', () => {
    const { frames } = planificarRespuesta("ERROR por favor", "4821");

    expect(frames).toEqual([{ type: "error", code: "agent_unavailable" }]);
  });
});

const ctx = { turnos: 0, historial: [] };

describe("escenarios de memoria, topes y guardrail", () => {
  it("'tope' produce el frame de límite con motivo", () => {
    const { frames } = planificarRespuesta("quiero ver el tope", "A", ctx);
    expect(frames).toEqual([{ type: "error", code: "limit_reached", motivo: "dia" }]);
  });

  it("'bloqueado' responde un done de política (respuesta, no error)", () => {
    const { frames } = planificarRespuesta("bloqueado por favor", "A", ctx);
    expect(frames.at(-1).type).toBe("done");
    expect(frames.at(-1).text.length).toBeGreaterThan(20);
  });

  it("'memoria' usa el contexto: menciona los turnos y el mensaje previo", () => {
    const { frames } = planificarRespuesta("memoria", "A", {
      turnos: 2,
      historial: ["hola", "¿cómo estás?"],
    });
    const texto = frames.at(-1).text;
    expect(texto).toContain("2");
    expect(texto).toContain("¿cómo estás?");
  });

  it("'memoria' con historial vacío no imprime undefined", () => {
    const { frames } = planificarRespuesta("memoria", "A", { turnos: 0, historial: [] });
    const texto = frames.at(-1).text;
    expect(texto).not.toContain("undefined");
    expect(texto).toMatch(/primer mensaje/i);
  });

  // Paridad con el sistema real: el core nunca persiste turnos bloqueados o
  // rechazados por tope (no llegan a la Memory real). El plan lo marca con
  // `persistible: false` para que el server sepa no pushearlo al historial.
  it("'tope' y 'bloqueado' no son persistibles; un mensaje normal no declara el campo", () => {
    const tope = planificarRespuesta("quiero ver el tope", "A", ctx);
    const bloqueado = planificarRespuesta("bloqueado por favor", "A", ctx);
    const normal = planificarRespuesta("Hola, ¿qué tal?", "A", ctx);

    expect(tope.persistible).toBe(false);
    expect(bloqueado.persistible).toBe(false);
    expect(normal.persistible).toBeUndefined();
  });
});

// Modo local de las tools: el mock responde como si el agente hubiera usado
// las tools reales (mis_pedidos / listar_catalogo), citando los DATOS FIJOS de
// la demo API: pedidos A-1001/A-0997 y los 3 productos del catálogo. Los
// textos se pinean exactos a propósito — mock y realidad tienen que decir lo
// mismo.
describe("escenarios de tools", () => {
  it("'pedido' responde como si hubiera usado mis_pedidos: cita A-1001 y A-0997, turno normal (persistible)", () => {
    const plan = planificarRespuesta("¿dónde está mi pedido?", "A", ctx);

    expect(plan.frames).toEqual([
      {
        type: "done",
        text: "Consulté tus pedidos: A-1001 está en camino (llega mañana) y A-0997 ya fue entregado.",
      },
    ]);
    // Es un turno del agente, no un corte: pasa por el debounce y se persiste.
    expect(plan.persistible).toBeUndefined();
  });

  it("'catalogo' y 'catálogo' matchean ambos y citan los 3 productos del catálogo demo", () => {
    const textoEsperado =
      "Tenemos 3 productos: Casco MTB ($45.000), Luz trasera USB ($12.000) y Kit de parches ($3.500).";

    const sinTilde = planificarRespuesta("mostrame el catalogo", "A", ctx);
    const conTilde = planificarRespuesta("mostrame el CATÁLOGO", "A", ctx);

    expect(sinTilde.frames).toEqual([{ type: "done", text: textoEsperado }]);
    expect(conTilde.frames).toEqual([{ type: "done", text: textoEsperado }]);
  });
});

// Contrato REST del mock: server real, levantado en un puerto efímero, contra
// el que se le pega con fetch — no se testea con dobles porque lo que hay que
// probar es justamente la orquestación entre el POST, el timer del debounce y
// el GET (server.mjs completo).
describe("contrato /mensajes (server real, puerto efímero)", () => {
  let server;
  let base;

  beforeAll(async () => {
    // Entorno vacío explícito: sin esto, una shell con API_URL exportada (el
    // flujo del README de modo Cognito) cambiaría el server de modo y estos
    // tests fallarían de forma confusa.
    server = crearServer({});
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("flujo normal: POST guarda el mensaje del usuario y, pasado el debounce, GET trae la respuesta del assistant", async () => {
    const hilo = "hilo-flujo-normal";
    const post = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "hola, ¿qué tal?", hilo }),
    });
    expect(post.status).toBe(200);
    const { msgId, conversationId, orden } = await post.json();
    expect(msgId).toBeTruthy();
    expect(conversationId).toBeTruthy();
    expect(orden).toBeTruthy();

    // El debounce (1200ms) todavía no debería haber generado nada.
    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get = await fetch(
      `${base}/mensajes?hilo=${encodeURIComponent(hilo)}&desde=${encodeURIComponent(orden)}`,
    );
    expect(get.status).toBe(200);
    const { mensajes } = await get.json();

    expect(mensajes).toHaveLength(1);
    expect(mensajes[0].rol).toBe("assistant");
  });

  it("debounce: dos POST seguidos a la misma conversación producen UNA sola respuesta que agrega a ambos pendientes", async () => {
    const hilo = "hilo-debounce";

    const post1 = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "primer mensaje", hilo }),
    });
    expect(post1.status).toBe(200);

    const post2 = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "segundo mensaje, justo después", hilo }),
    });
    expect(post2.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get = await fetch(`${base}/mensajes?hilo=${encodeURIComponent(hilo)}`);
    const { mensajes } = await get.json();

    // Dos mensajes de usuario, pero el timer del primero se descartó porque
    // para cuando disparó ya no era el último — solo el del segundo procesó,
    // y agregó a los dos pendientes en una única respuesta.
    expect(mensajes.filter((m) => m.rol === "user")).toHaveLength(2);
    expect(mensajes.filter((m) => m.rol === "assistant")).toHaveLength(1);
  });

  it("un 'bloqueado' durante la ventana de debounce de un mensaje normal no deja un assistant espurio", async () => {
    const hilo = "hilo-normal-mas-bloqueado";

    const postNormal = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "hola, ¿cómo va?", hilo }),
    });
    expect(postNormal.status).toBe(200);

    // Sin esperar nada: el timer del mensaje normal (1200ms) todavía no
    // disparó. El "bloqueado" escribe user+assistant de una, por fuera del
    // debounce.
    const postBloqueado = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "bloqueado por favor", hilo }),
    });
    expect(postBloqueado.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get = await fetch(`${base}/mensajes?hilo=${encodeURIComponent(hilo)}`);
    const { mensajes } = await get.json();

    // 2 mensajes de usuario (el normal + el bloqueado) y UN SOLO assistant:
    // el de política. Cuando el timer del mensaje normal dispara, el último
    // usuario de la transcripción ya no es el suyo (es el del bloqueado) —
    // se tiene que descartar, no generar una segunda respuesta espuria sobre
    // un intercambio que ya cerró.
    expect(mensajes.filter((m) => m.rol === "user")).toHaveLength(2);
    expect(mensajes.filter((m) => m.rol === "assistant")).toHaveLength(1);
    expect(mensajes.at(-1).rol).toBe("assistant");
  });

  // Los escenarios de tools son turnos normales del agente — pasan por el
  // debounce como cualquier respuesta (POST + esperar + GET), no son un corte
  // síncrono como "tope"/"error500".
  it("'pedido': pasado el debounce, el assistant responde con los pedidos fijos de la demo API", async () => {
    const hilo = "hilo-tools-pedido";
    const post = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "¿dónde está mi pedido?", hilo }),
    });
    expect(post.status).toBe(200);
    const { orden } = await post.json();

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get = await fetch(
      `${base}/mensajes?hilo=${encodeURIComponent(hilo)}&desde=${encodeURIComponent(orden)}`,
    );
    const { mensajes } = await get.json();

    expect(mensajes).toHaveLength(1);
    expect(mensajes[0].rol).toBe("assistant");
    expect(mensajes[0].texto).toBe(
      "Consulté tus pedidos: A-1001 está en camino (llega mañana) y A-0997 ya fue entregado.",
    );
  });

  it("'catálogo' (con tilde): pasado el debounce, el assistant responde con los 3 productos fijos", async () => {
    const hilo = "hilo-tools-catalogo";
    const post = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "mostrame el catálogo", hilo }),
    });
    expect(post.status).toBe(200);
    const { orden } = await post.json();

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get = await fetch(
      `${base}/mensajes?hilo=${encodeURIComponent(hilo)}&desde=${encodeURIComponent(orden)}`,
    );
    const { mensajes } = await get.json();

    expect(mensajes).toHaveLength(1);
    expect(mensajes[0].rol).toBe("assistant");
    expect(mensajes[0].texto).toBe(
      "Tenemos 3 productos: Casco MTB ($45.000), Luz trasera USB ($12.000) y Kit de parches ($3.500).",
    );
  });

  // "error500" emula una falla temprana y síncrona del BFF real (nada de
  // debounce/worker de por medio) — test de contrato de una sola aserción.
  it("'error500': el POST responde 500 sin escribir nada", async () => {
    const post = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "dame un error500 por favor", hilo: "hilo-error500" }),
    });

    expect({ status: post.status, body: await post.json() }).toEqual({
      status: 500,
      body: { error: { code: "error_interno" } },
    });
  });
});
