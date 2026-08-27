// El Runtime relaya tal cual lo que emite el contenedor: nuestro contenedor
// (core/server.py) emite SSE (`data: {...}\n\n`), no NDJSON puro. Este parser
// tolera ambos formatos, línea a línea: para NDJSON puro cada línea ya es el
// JSON; para SSE stripea el prefijo `data:` (y descarta `event:`/comentarios).
// Aislado del resto para poder testear el caso que rompe cualquiera de los
// dos: un chunk de red que corta una línea (o un carácter multibyte) por la
// mitad.

export async function* parseNdjson(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const dec = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    // stream: true mantiene el estado del decoder entre chunks, para no partir
    // un carácter multibyte (los acentos del español, justamente).
    buffer += dec.decode(chunk, { stream: true });
    let corte: number;
    while ((corte = buffer.indexOf("\n")) !== -1) {
      const linea = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 1);
      const ev = parsear(linea);
      if (ev) yield ev;
    }
  }

  // Flush del decoder: drena un carácter multibyte cortado al final del stream
  // (sin esto, un resto pendiente en el decoder nunca llega al buffer).
  buffer += dec.decode();

  // El Runtime puede cerrar sin salto final: la última línea también cuenta.
  const ultimo = parsear(buffer);
  if (ultimo) yield ultimo;
}

function parsear(linea: string): Record<string, unknown> | null {
  const t = linea.trim();
  if (!t) return null;
  // Frames SSE: "event:" y los comentarios (": keepalive") no son datos, se ignoran.
  if (t.startsWith("event:") || t.startsWith(":")) return null;
  // "data:" (con o sin espacio siguiente) es el prefijo real de cada frame SSE.
  const json = t.startsWith("data:") ? t.slice("data:".length).trimStart() : t;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    // Una línea corrupta no tumba la conversación: se reporta como evento.
    return { type: "error", error: "evento ilegible del agente" };
  }
}
