// AgentCore Runtime responde NDJSON: una línea JSON por evento. El browser
// consume SSE. Esta es toda la traducción, aislada para poder testear el caso
// que la rompe: un chunk de red que corta una línea por la mitad.

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

  // El Runtime puede cerrar sin salto final: la última línea también cuenta.
  const ultimo = parsear(buffer);
  if (ultimo) yield ultimo;
}

function parsear(linea: string): Record<string, unknown> | null {
  const t = linea.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    // Una línea corrupta no tumba la conversación: se reporta como evento.
    return { type: "error", error: "evento ilegible del agente" };
  }
}

export function toSse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
