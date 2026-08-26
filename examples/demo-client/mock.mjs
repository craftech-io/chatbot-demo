// Escenarios del modo mock: qué le contesta el chat cuando no hay ningún agente
// real del otro lado. Pura y testeable: no toca timers ni I/O — el server aplica
// el `demoraMs` del plan con setTimeout entre frames.
//
// El contrato de cada frame es el mismo que habla el BFF real (ver
// packages/bff/src/chat/ndjson.ts): {type:"delta",text} / {type:"done",text} /
// {type:"error",code}.

const DEMORA_LENTA_MS = 400;
const DEMORA_NORMAL_MS = 40;

const RESTO_DE_LA_RESPUESTA =
  "Esto es el modo local (mock) del chat: no hay ningún agente real del otro " +
  "lado, esta respuesta se arma de a poco para que veas el streaming en el navegador.";

// Texto de la entrada bloqueada: EMULA al registro compartido de la fase 2b
// (packages/shared/src/mensajes.ts, MENSAJES_GUARDRAIL.entradaBloqueada). El
// mock es un .mjs sin build: no puede importar ese .ts, y duplicar el texto
// real lo dejaría desincronizado en silencio si cambia allá. Por eso el mock
// se limita a sostener el mismo espíritu (una respuesta de política, en
// español, no un error) con su propio texto.
const TEXTO_ENTRADA_BLOQUEADA =
  "No puedo ayudarte con esa consulta tal como la planteás. Probá reformularla " +
  "y seguimos conversando (esto emula al mensaje real de MENSAJES_GUARDRAIL).";

// Fase 2d: el modo local de las tools. Estos textos responden como si el
// agente real hubiera usado sus tools (mis_pedidos vía HTTP con el actToken,
// listar_catalogo vía el Gateway MCP) y citan los DATOS FIJOS de la demo API
// (examples/api-cliente, contrato del plan 2d) — mock y realidad cuentan la
// misma historia. Si cambian los datos de la demo API, cambiar acá también.
const TEXTO_MIS_PEDIDOS =
  "Consulté tus pedidos: A-1001 está en camino (llega mañana) y A-0997 ya fue entregado.";
const TEXTO_LISTAR_CATALOGO =
  "Tenemos 3 productos: Casco MTB ($45.000), Luz trasera USB ($12.000) y Kit de parches ($3.500).";

/**
 * Decide qué le contesta el mock a un mensaje. No sabe nada de sockets ni de
 * tiempo real: devuelve un plan `{ demoraMs, frames }` para que el server lo
 * ejecute.
 *
 * @param {string} mensaje - texto que escribió el usuario
 * @param {string} sub - identidad del usuario (el `sub` del token)
 * @param {{ turnos: number, historial: string[] }} [contexto] - memoria en
 *   proceso de la sesión: cuántos turnos lleva y los mensajes previos. Lo
 *   arma el server (fase 2b: memoria en proceso, sin AWS).
 * @returns {{ demoraMs: number, frames: Array<Record<string, unknown>> }}
 */
export function planificarRespuesta(mensaje, sub, contexto = { turnos: 0, historial: [] }) {
  const texto = String(mensaje ?? "");
  const minusculas = texto.toLowerCase();
  const demoraMs = minusculas.includes("lento") ? DEMORA_LENTA_MS : DEMORA_NORMAL_MS;

  if (minusculas.includes("error")) {
    return {
      demoraMs,
      frames: [{ type: "error", code: "agent_unavailable" }],
    };
  }

  if (minusculas.includes("tope")) {
    // Emula el 429 de topes de uso del BFF real (Task 7): un único frame de
    // error, sin done — la conversación no sigue hasta que se libere el tope.
    // persistible:false — el core real nunca persiste turnos rechazados por
    // tope (no llegan a la Memory real); el server no debe pushearlo.
    return {
      demoraMs,
      persistible: false,
      frames: [{ type: "error", code: "limit_reached", motivo: "dia" }],
    };
  }

  if (minusculas.includes("bloqueado")) {
    // Una entrada bloqueada por el guardrail es una RESPUESTA, no un error
    // (spec §15): termina en `done` con el texto de política, igual que el
    // BFF real.
    // persistible:false — el core real tampoco persiste turnos bloqueados
    // por el guardrail de entrada (nunca llegan a invocar al modelo/Memory).
    return {
      demoraMs,
      persistible: false,
      frames: [{ type: "done", text: TEXTO_ENTRADA_BLOQUEADA }],
    };
  }

  if (minusculas.includes("memoria")) {
    // Primer mensaje de la sesión: no hay turno previo que citar.
    const textoMemoria =
      contexto.historial.length === 0
        ? "Este es nuestro primer mensaje de la conversación."
        : `Llevamos ${contexto.turnos} turnos; lo último que me dijiste fue: "${contexto.historial.at(-1)}"`;
    return {
      demoraMs,
      frames: [{ type: "done", text: textoMemoria }],
    };
  }

  // Escenarios de tools (fase 2d): turnos normales del agente — un solo
  // `done`, pasan por el debounce y se persisten como cualquier respuesta.
  // Lección del escenario "error500": el matching por inclusión puede pisarse
  // entre palabras; "pedido" y "catalogo" no son substring de ninguna otra
  // keyword ni la contienen, así que acá no hace falta un orden especial.
  if (minusculas.includes("pedido")) {
    return {
      demoraMs,
      frames: [{ type: "done", text: TEXTO_MIS_PEDIDOS }],
    };
  }

  // "catálogo" y "catalogo" valen igual: toLowerCase() no saca tildes, así
  // que se aceptan las dos grafías a mano.
  if (minusculas.includes("catalogo") || minusculas.includes("catálogo")) {
    return {
      demoraMs,
      frames: [{ type: "done", text: TEXTO_LISTAR_CATALOGO }],
    };
  }

  const saludo = `Hola, ${sub}.`;
  const deltas = [
    { type: "delta", text: saludo },
    ...RESTO_DE_LA_RESPUESTA.split(" ").map((palabra) => ({
      type: "delta",
      text: ` ${palabra}`,
    })),
  ];
  const textoCompleto = deltas.reduce((acc, d) => acc + d.text, "");

  return {
    demoraMs,
    frames: [...deltas, { type: "done", text: textoCompleto }],
  };
}
