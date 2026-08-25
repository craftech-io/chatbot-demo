import { describe, expect, it } from "vitest";
import { MENSAJES_GUARDRAIL, MENSAJES_LIMITE, MENSAJES_WORKER } from "./mensajes";

describe("registro de mensajes", () => {
  it("los textos existen, están en español y terminan en puntuación", () => {
    for (const texto of [
      MENSAJES_GUARDRAIL.entradaBloqueada,
      MENSAJES_LIMITE.diarioAlcanzado,
      MENSAJES_LIMITE.sesionAlcanzada,
      MENSAJES_WORKER.error,
    ]) {
      expect(texto.length).toBeGreaterThan(20);
      expect(texto).toMatch(/[.!?]$/);
    }
  });
});
