import { describe, expect, it } from "vitest";
import { parseNdjson } from "./ndjson";

const enc = new TextEncoder();

async function* fuente(...partes: string[]) {
  for (const p of partes) yield enc.encode(p);
}

async function* fuenteBytes(...partes: Uint8Array[]) {
  for (const p of partes) yield p;
}

async function recolectar(it: AsyncIterable<Record<string, unknown>>) {
  const out: Record<string, unknown>[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("parseNdjson", () => {
  it("parsea una linea por evento", async () => {
    const evs = await recolectar(
      parseNdjson(fuente('{"type":"delta","text":"Hola"}\n{"type":"done"}\n')),
    );
    expect(evs).toEqual([{ type: "delta", text: "Hola" }, { type: "done" }]);
  });

  it("junta una linea partida entre dos chunks", async () => {
    // Este es EL bug de los parsers de streaming: el chunk de red no respeta
    // los límites de línea.
    const evs = await recolectar(
      parseNdjson(fuente('{"type":"delta","te', 'xt":"Hola"}\n')),
    );
    expect(evs).toEqual([{ type: "delta", text: "Hola" }]);
  });

  it("emite la ultima linea aunque no venga con salto final", async () => {
    const evs = await recolectar(parseNdjson(fuente('{"type":"done"}')));
    expect(evs).toEqual([{ type: "done" }]);
  });

  it("ignora lineas vacias", async () => {
    const evs = await recolectar(parseNdjson(fuente('\n\n{"type":"done"}\n\n')));
    expect(evs).toEqual([{ type: "done" }]);
  });

  it("ante JSON invalido emite un evento de error y sigue", async () => {
    const evs = await recolectar(parseNdjson(fuente('roto\n{"type":"done"}\n')));
    expect(evs[0]).toMatchObject({ type: "error" });
    expect(evs[1]).toEqual({ type: "done" });
  });

  it("parsea frames SSE tal como los emite el core", async () => {
    // Bytes reales de core/server.py: `data: {json.dumps(...)}\n\n`, con el
    // espacio despues de ":" que deja el json.dumps default.
    const evs = await recolectar(
      parseNdjson(
        fuente(
          'data: {"type": "delta", "text": "Hola"}\n\ndata: {"type": "done", "text": "Hola"}\n\n',
        ),
      ),
    );
    expect(evs).toEqual([
      { type: "delta", text: "Hola" },
      { type: "done", text: "Hola" },
    ]);
  });

  it("ignora lineas event: y comentarios", async () => {
    const evs = await recolectar(
      parseNdjson(fuente('event: x\n: keepalive\ndata: {"type":"done"}\n')),
    );
    expect(evs).toEqual([{ type: "done" }]);
  });

  it("flush final: multibyte cortado en el ultimo chunk sin salto final", async () => {
    // "á" son 2 bytes UTF-8 (0xC3 0xA1). Los partimos justo ahi: el penultimo
    // chunk se queda con el primer byte, el ultimo (sin "\n" final) trae el
    // segundo byte mas el resto del frame SSE.
    const frame = 'data: {"type":"done","text":"á"}';
    const bytes = enc.encode(frame);
    const idx = enc.encode(frame.slice(0, frame.indexOf("á"))).length;
    const evs = await recolectar(
      parseNdjson(fuenteBytes(bytes.slice(0, idx + 1), bytes.slice(idx + 1))),
    );
    expect(evs).toEqual([{ type: "done", text: "á" }]);
  });
});
