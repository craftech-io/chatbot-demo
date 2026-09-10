// Escenarios del modo mock: qué le contesta el chat cuando no hay ningún agente
// real del otro lado. Pura y testeable: no toca timers ni I/O — el server es el
// que aplica el `demoraMs` del plan con setTimeout.
//
// El contrato de cada frame es el mismo que emite el core y parsea el worker
// (ver packages/worker/src/ndjson.ts): {type:"delta",text} /
// {type:"done",text} / {type:"error",code}.

const DEMORA_LENTA_MS = 400;
const DEMORA_NORMAL_MS = 40;

const RESTO_DE_LA_RESPUESTA =
  "Esto es el modo local (mock) del chat: no hay ningún agente real del otro " +
  "lado, la respuesta la escribe este mismo server para que puedas probar la UI.";

// Texto de la entrada bloqueada: EMULA al registro compartido
// (packages/shared/src/mensajes.ts, MENSAJES_GUARDRAIL.entradaBloqueada). El
// mock es un .mjs sin build: no puede importar ese .ts, y duplicar el texto
// real lo dejaría desincronizado en silencio si cambia allá. Por eso el mock
// se limita a sostener el mismo espíritu (una respuesta de política, en
// español, no un error) con su propio texto.
const TEXTO_ENTRADA_BLOQUEADA =
  "No puedo ayudarte con esa consulta tal como la planteás. Probá reformularla " +
  "y seguimos conversando (esto emula al mensaje real de MENSAJES_GUARDRAIL).";

// Modo local de las tools: estos textos responden como si el agente real
// hubiera usado sus tools (mis_pedidos vía HTTP con el actToken,
// listar_catalogo vía el Gateway MCP) y citan los DATOS FIJOS de la demo API
// (examples/api-cliente) — mock y realidad dicen lo mismo. Si cambian los
// datos de la demo API, cambiar acá también.
const TEXTO_MIS_PEDIDOS =
  "Consulté tus pedidos: A-1001 está en camino (llega mañana) y A-0997 ya fue entregado.";
const TEXTO_LISTAR_CATALOGO =
  "Tenemos 3 productos: Casco MTB ($45.000), Luz trasera USB ($12.000) y Kit de parches ($3.500).";

// Modo local del conocimiento (RAG) y del escalamiento: los mismos textos que
// daría el agente real usando `consultar_documentos` y `escalar_a_humano`,
// citando el CORPUS FICTICIO de examples/documentos (la empresa inventada
// Ciclos Aurora). Si ese corpus cambia, cambiar acá también — mock y realidad
// cuentan la misma historia. La cita nombra el título del sidecar
// `.metadata.json` y el nombre del archivo, que es exactamente lo que la tool
// real le da al modelo: `titulo` (el `title` del sidecar) y `fuente` (la URI del
// documento en S3, cuyo último segmento es ese archivo) — ver
// packages/bff/src/tools/documentos.ts y docs/diseno.md §11.
const TEXTO_CONSULTAR_DOCUMENTOS =
  "Según *Política de devoluciones* (`politica-devoluciones.md`): tenés 30 días " +
  "corridos desde que recibís el pedido para iniciar el cambio o la devolución, " +
  "con el producto sin uso y en su embalaje original. El reintegro sale por el " +
  "mismo medio de pago dentro de los 10 días hábiles.";

// Paso 1 del escalamiento: no encontró la respuesta, NO inventa y NO escala
// solo — ofrece derivar y espera (docs/diseno.md §11.1). Enumera el corpus para
// que se vea qué sí sabe contestar.
const TEXTO_SIN_RESPUESTA_EN_DOCUMENTOS =
  "No encontré nada sobre eso en los documentos de Ciclos Aurora (tengo la " +
  "política de devoluciones, los horarios de atención, la garantía y los " +
  "envíos) y no te voy a improvisar una respuesta. ¿Querés que derive tu " +
  "consulta a una persona del equipo?";

// Paso 2: recién ahora "crea" el escalamiento. La referencia es fija porque el
// mock es un fixture y los tests la pinean; en el sistema real la devuelve el
// webhook del adaptador de escalamiento.
const TEXTO_ESCALAMIENTO_CREADO =
  "Listo: derivé tu consulta a una persona del equipo con la referencia " +
  "ESC-2043. Te van a contactar en el próximo día hábil (atención al cliente: " +
  "lunes a viernes de 9 a 18).";

// Modo local del formato: una respuesta que usa TODO el markdown que el agente
// real emite, para poder mirar el render sin desplegar. Cada bloque de acá
// existe porque apareció en respuestas reales de un agente en producción.
const TEXTO_FORMATO = [
  "## Cambios y devoluciones",
  "",
  "Tenés **30 días corridos** desde que recibís el pedido, con el producto *sin uso*.",
  "",
  "---",
  "",
  "### Estado de tus pedidos",
  "",
  "| Pedido | Estado | Total |",
  "|--------|--------|------:|",
  "| A-1042 | En camino | 45.000 |",
  "| A-1043 | Entregado | 12.000 |",
  "",
  "#### Cómo iniciar el cambio",
  "",
  "1. Escribinos con el número de pedido.",
  "2. Prepará el paquete:",
  "   - En su embalaje original.",
  "   - Con los accesorios y las etiquetas.",
  "3. Confirmá con el código `A-####`.",
  "",
  "> El plazo corre desde que recibís el pedido, no desde la compra.",
  "",
  "Referencia: [Política de devoluciones](https://ejemplo.invalid/devoluciones)",
].join("\n");

// Palabras con las que el usuario acepta ser derivado. Acá el matching es por
// PALABRA, no por inclusión como el resto de las keywords: "sí" es substring de
// "así" y "si" de "necesito", así que por inclusión un "no, dejemos así"
// crearía un escalamiento que el usuario nunca aceptó — justo la decisión de
// producto que este escenario existe para mostrar.
const AFIRMACIONES = new Set(["si", "sí", "dale", "ok", "claro", "acepto"]);

// La otra mitad del mismo cuidado: "claro" y "ok" son afirmaciones y aparecen
// adentro de negaciones ("claro que no", "ok, pero no"), así que una negación
// manda sobre cualquier afirmación del mismo mensaje. Alcanza con dos palabras:
// "mejor no" y "no, dejalo" entran por "no", y "nada de eso" por "nada".
const NEGACIONES = new Set(["no", "nada"]);

function esAfirmacion(minusculas) {
  // Se parte por todo lo que no sea letra (comas, signos, espacios) para
  // comparar palabra por palabra.
  const palabras = minusculas.split(/[^a-záéíóúüñ]+/);
  if (palabras.some((palabra) => NEGACIONES.has(palabra))) return false;
  return palabras.some((palabra) => AFIRMACIONES.has(palabra));
}

// ¿El mensaje anterior de esta conversación fue el paso 1? Este escenario
// necesita estado por conversación, pero no un Map propio como el de "vencido"
// en server.mjs (ese corta el request antes de llegar hasta acá): alcanza con
// el historial que el server ya mantiene por conversación y pasa en `contexto`
// — el mismo que usa el escenario "memoria". Así `planificarRespuesta` sigue
// siendo pura.
// Se mira SOLO el mensaje inmediatamente anterior: la aceptación vale para la
// pregunta que se acaba de hacer, no para una de hace diez turnos.
function pidioEscalamiento(mensajeAnterior) {
  return String(mensajeAnterior ?? "")
    .toLowerCase()
    .includes("escalar");
}

/**
 * Decide qué le contesta el mock a un mensaje. No sabe nada de sockets ni de
 * tiempo real: devuelve un plan `{ demoraMs, frames }` para que el server lo
 * ejecute.
 *
 * @param {string} mensaje - texto que escribió el usuario
 * @param {string} sub - identidad del usuario (el `sub` del token)
 * @param {{ turnos: number, historial: string[] }} [contexto] - memoria en
 *   proceso de la sesión: cuántos turnos lleva y los mensajes previos. Lo
 *   arma el server (memoria en proceso, sin AWS).
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
    // Emula el 429 de topes de uso del BFF real: un único frame de error,
    // sin done — la conversación no sigue hasta que se libere el tope.
    // persistible:false — el core real nunca persiste turnos rechazados por
    // tope (no llegan a la Memory real); el server no debe pushearlo.
    return {
      demoraMs,
      persistible: false,
      frames: [{ type: "error", code: "limit_reached", motivo: "dia" }],
    };
  }

  if (minusculas.includes("bloqueado")) {
    // Una entrada bloqueada por el guardrail es una RESPUESTA, no un error:
    // termina en `done` con el texto de política, igual que el BFF real.
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

  // Escenarios de tools: turnos normales del agente — un solo `done`, pasan
  // por el debounce y se persisten como cualquier respuesta. El matching es
  // por inclusión, así que una keyword contenida en otra necesita orden
  // explícito ("error" dentro de "error500", ver server.mjs); "pedido" y
  // "catalogo" no son substring de ninguna otra ni la contienen, así que acá
  // el orden no importa.
  if (minusculas.includes("formato")) {
    return {
      demoraMs,
      frames: [{ type: "done", text: TEXTO_FORMATO }],
    };
  }

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

  // Conocimiento y escalamiento. Mismo cuidado con el matching por inclusión:
  // ni "documento" ni "escalar" contienen ninguna de las keywords anteriores ni
  // están contenidas en ellas (hay un test que lo fija), así que el orden entre
  // estas dos y las de arriba no cambia nada.
  if (minusculas.includes("documento")) {
    return {
      demoraMs,
      frames: [{ type: "done", text: TEXTO_CONSULTAR_DOCUMENTOS }],
    };
  }

  // Paso 2 antes que el paso 1: el mensaje de la aceptación ("sí") no trae la
  // keyword "escalar", así que se reconoce por el turno anterior. Va primero
  // para que un "sí, escalalo" no vuelva a hacer la pregunta.
  if (esAfirmacion(minusculas) && pidioEscalamiento(contexto.historial.at(-1))) {
    return {
      demoraMs,
      frames: [{ type: "done", text: TEXTO_ESCALAMIENTO_CREADO }],
    };
  }

  if (minusculas.includes("escalar")) {
    return {
      demoraMs,
      frames: [{ type: "done", text: TEXTO_SIN_RESPUESTA_EN_DOCUMENTOS }],
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
