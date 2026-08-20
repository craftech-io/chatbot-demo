import { describe, expect, it } from "vitest";
import { planificarRespuesta } from "./mock.mjs";

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
