import { describe, expect, it } from "vitest";
import { parseNdjson, toSse } from "./ndjson";

const enc = new TextEncoder();

async function* fuente(...partes: string[]) {
  for (const p of partes) yield enc.encode(p);
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
});

describe("toSse", () => {
  it("formatea un evento como frame SSE", () => {
    expect(toSse({ type: "delta", text: "Hola" })).toBe(
      'data: {"type":"delta","text":"Hola"}\n\n',
    );
  });
});
