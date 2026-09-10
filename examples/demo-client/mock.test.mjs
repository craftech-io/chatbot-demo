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

// Modo local del conocimiento (RAG) y del escalamiento. Los textos citan el
// CORPUS FICTICIO de examples/documentos (la empresa inventada Ciclos Aurora),
// igual que los de tools citan los datos fijos de la demo API: mock y realidad
// cuentan la misma historia. Se pinean exactos a propósito — si el corpus
// cambia, estos tests son los que avisan.
const TEXTO_DOCUMENTO_ESPERADO =
  "Según *Política de devoluciones* (`politica-devoluciones.md`): tenés 30 días " +
  "corridos desde que recibís el pedido para iniciar el cambio o la devolución, " +
  "con el producto sin uso y en su embalaje original. El reintegro sale por el " +
  "mismo medio de pago dentro de los 10 días hábiles.";

describe("escenarios de conocimiento y escalamiento", () => {
  it("'documento' responde como si hubiera usado consultar_documentos: CON la cita, turno normal", () => {
    const plan = planificarRespuesta("¿tienen algún documento sobre devoluciones?", "A", ctx);

    expect(plan.frames).toEqual([{ type: "done", text: TEXTO_DOCUMENTO_ESPERADO }]);
    // Es un turno del agente, no un corte: pasa por el debounce y se persiste.
    expect(plan.persistible).toBeUndefined();
  });

  it("'escalar' paso 1: dice que no lo encontró, ofrece derivar y NO crea nada", () => {
    const plan = planificarRespuesta("necesito escalar esto", "A", ctx);

    const texto = plan.frames.at(-1).text;
    expect(plan.frames.at(-1).type).toBe("done");
    expect(texto).toMatch(/no encontré/i);
    // Cita el corpus: enumera los documentos que sí tiene.
    expect(texto).toContain("política de devoluciones");
    // Pregunta y espera: el consentimiento del spec §11.1.
    expect(texto).toMatch(/\?$/);
    // Sin el "sí" del usuario no hay escalamiento ni referencia.
    expect(texto).not.toContain("ESC-");
    expect(plan.persistible).toBeUndefined();
  });

  it("'escalar' paso 2: un 'sí' después del paso 1 crea el escalamiento y devuelve la referencia", () => {
    const plan = planificarRespuesta("sí, dale", "A", {
      turnos: 1,
      historial: ["necesito escalar esto"],
    });

    const texto = plan.frames.at(-1).text;
    expect(texto).toContain("ESC-2043");
    expect(texto).toMatch(/derivé/i);
  });

  it("'escalar' paso 2: el 'si' sin tilde también acepta la derivación", () => {
    const plan = planificarRespuesta("si", "A", { turnos: 1, historial: ["escalar"] });

    expect(plan.frames.at(-1).text).toContain("ESC-2043");
  });

  it("un 'sí' sin paso 1 previo no crea ningún escalamiento", () => {
    const plan = planificarRespuesta("sí", "A", { turnos: 1, historial: ["hola, ¿qué tal?"] });

    expect(plan.frames.at(-1).text).not.toContain("ESC-");
  });

  // El matching de la afirmación es por PALABRA, no por inclusión: "sí" es
  // substring de "así" y "si" de "necesito", así que un "no, dejemos así"
  // crearía un escalamiento que el usuario nunca aceptó.
  it("una negación que contiene 'sí' como substring ('dejemos así') no acepta la derivación", () => {
    const plan = planificarRespuesta("no, dejemos así", "A", {
      turnos: 1,
      historial: ["necesito escalar esto"],
    });

    expect(plan.frames.at(-1).text).not.toContain("ESC-");
  });

  // La otra mitad del mismo cuidado: el matching por palabra evita que "así"
  // cuente como "sí", pero "claro" y "ok" SON palabras de aceptación y aparecen
  // dentro de negaciones ("claro que no", "ok, pero no"). Crear el escalamiento
  // ahí es exactamente lo que este escenario existe para no hacer.
  it("una negación con una palabra de aceptación adentro no crea el escalamiento", () => {
    const negaciones = [
      "claro que no",
      "ok, pero no",
      "no, mejor no",
      "dale... no, nada",
      "si no, dejalo",
      "nada de eso",
    ];

    for (const mensaje of negaciones) {
      const plan = planificarRespuesta(mensaje, "A", {
        turnos: 1,
        historial: ["necesito escalar esto"],
      });

      expect(`${mensaje} -> ${plan.frames.at(-1).text}`).not.toContain("ESC-");
    }
  });

  it("las aceptaciones sin negación siguen creando el escalamiento", () => {
    for (const mensaje of ["claro", "ok", "dale", "acepto", "sí", "sí, dale"]) {
      const plan = planificarRespuesta(mensaje, "A", {
        turnos: 1,
        historial: ["necesito escalar esto"],
      });

      expect(`${mensaje} -> ${plan.frames.at(-1).text}`).toContain("ESC-2043");
    }
  });

  // La lección del matching por inclusión (ver el comentario de "error500" en
  // server.mjs): una keyword contenida en otra necesita orden explícito. Estas
  // dos son independientes de todas las que ya había.
  it("'documento' y 'escalar' no colisionan con las keywords existentes", () => {
    const existentes = [
      "error",
      "error500",
      "tope",
      "bloqueado",
      "memoria",
      "pedido",
      "catalogo",
      "catálogo",
      "lento",
      "vencido",
    ];

    for (const kw of existentes) {
      for (const nueva of ["documento", "escalar"]) {
        expect(`${nueva} vs ${kw}: ${nueva.includes(kw)}`).toBe(`${nueva} vs ${kw}: false`);
        expect(`${kw} vs ${nueva}: ${kw.includes(nueva)}`).toBe(`${kw} vs ${nueva}: false`);
      }
    }

    // Y los escenarios viejos siguen respondiendo lo suyo (no regresión).
    expect(planificarRespuesta("dame un error", "A", ctx).frames).toEqual([
      { type: "error", code: "agent_unavailable" },
    ]);
    expect(planificarRespuesta("mostrame el catalogo", "A", ctx).frames[0].text).toContain(
      "3 productos",
    );
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

  it("'documento': pasado el debounce, el assistant responde citando la política de devoluciones", async () => {
    const hilo = "hilo-documento";
    const post = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "¿qué dice el documento de devoluciones?", hilo }),
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
    expect(mensajes[0].texto).toBe(TEXTO_DOCUMENTO_ESPERADO);
  });

  // El flujo de consentimiento del spec §11.1, de punta a punta: son DOS turnos
  // reales (con su debounce cada uno), y el segundo depende de que el server
  // haya guardado el primero en el historial de la conversación.
  it("escalamiento en dos pasos: primero ofrece derivar, y recién con el 'sí' aparece la referencia", async () => {
    const hilo = "hilo-escalar";

    const post1 = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "quiero escalar esto con alguien", hilo }),
    });
    expect(post1.status).toBe(200);
    const { orden: orden1 } = await post1.json();

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get1 = await fetch(
      `${base}/mensajes?hilo=${encodeURIComponent(hilo)}&desde=${encodeURIComponent(orden1)}`,
    );
    const { mensajes: mensajes1 } = await get1.json();
    expect(mensajes1).toHaveLength(1);
    expect(mensajes1[0].texto).toMatch(/no encontré/i);
    // Todavía no aceptó nada: no puede haber escalamiento creado.
    expect(mensajes1[0].texto).not.toContain("ESC-");

    const post2 = await fetch(`${base}/mensajes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "sí, por favor", hilo }),
    });
    expect(post2.status).toBe(200);
    const { orden: orden2 } = await post2.json();

    await new Promise((resolve) => setTimeout(resolve, 1400));

    const get2 = await fetch(
      `${base}/mensajes?hilo=${encodeURIComponent(hilo)}&desde=${encodeURIComponent(orden2)}`,
    );
    const { mensajes: mensajes2 } = await get2.json();
    expect(mensajes2).toHaveLength(1);
    expect(mensajes2[0].rol).toBe("assistant");
    expect(mensajes2[0].texto).toContain("ESC-2043");
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

describe("escenario de formato", () => {
  it("ejercita los bloques de markdown que el agente real emite", () => {
    const { frames } = planificarRespuesta("mostrame el formato", "4821");
    const texto = frames.at(-1).text;

    // Uno por bloque: si el mock deja de cubrir alguno, el modo local deja de
    // servir para mirar el render de esa capacidad.
    expect(texto).toMatch(/^## /m); // encabezado
    expect(texto).toMatch(/^---$/m); // regla
    expect(texto).toMatch(/^\|.+\|$/m); // tabla
    expect(texto).toMatch(/^> /m); // cita
    expect(texto).toMatch(/^\s+- /m); // lista anidada
    expect(texto).toMatch(/^\d+\. /m); // lista numerada
    expect(texto).toContain("**"); // negrita
    expect(texto).toContain("`"); // código inline
    expect(texto).toMatch(/\[.+\]\(https:/); // link
  });
});
