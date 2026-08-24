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

const ctx = { turnos: 0, historial: [] };

describe("escenarios de la fase 2b", () => {
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
