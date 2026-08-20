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

/**
 * Decide qué le contesta el mock a un mensaje. No sabe nada de sockets ni de
 * tiempo real: devuelve un plan `{ demoraMs, frames }` para que el server lo
 * ejecute.
 *
 * @param {string} mensaje - texto que escribió el usuario
 * @param {string} sub - identidad del usuario (el `sub` del token)
 * @returns {{ demoraMs: number, frames: Array<Record<string, unknown>> }}
 */
export function planificarRespuesta(mensaje, sub) {
  const texto = String(mensaje ?? "");
  const minusculas = texto.toLowerCase();
  const demoraMs = minusculas.includes("lento") ? DEMORA_LENTA_MS : DEMORA_NORMAL_MS;

  if (minusculas.includes("error")) {
    return {
      demoraMs,
      frames: [{ type: "error", code: "agent_unavailable" }],
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
