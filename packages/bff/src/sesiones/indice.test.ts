import { describe, expect, it, vi } from "vitest";
import { registrarTurnoEnIndice } from "./indice";

describe("registrarTurnoEnIndice", () => {
  it("hace upsert con ADD de turnos y devuelve el contador", async () => {
    // El parámetro `_cmd` no se usa (el mock siempre devuelve lo mismo): está
    // declarado solo para que `send.mock.calls[0][0]` no choque con la tupla
    // vacía que TS infiere de un mock sin argumentos declarados.
    const send = vi.fn(async (_cmd: any) => ({ Attributes: { turnos: { N: "3" } } }));
    const n = await registrarTurnoEnIndice(
      { ddb: { send } as never, tabla: "Sessions" },
      "u1", "s1", "hola, tengo una consulta larga…",
    );
    expect(n).toBe(3);
    const cmd = send.mock.calls[0][0].input;
    expect(cmd.TableName).toBe("Sessions");
    expect(cmd.Key.userId.S).toBe("u1");
    expect(cmd.Key.sessionId.S).toBe("s1");
    expect(cmd.UpdateExpression).toContain("ADD turnos");
    expect(cmd.UpdateExpression).toContain("if_not_exists(titulo");
  });

  it("fail-open: un fallo del índice no molesta al turno", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = { send: vi.fn(async () => { throw new Error("dynamo caída"); }) } as never;
    const n = await registrarTurnoEnIndice({ ddb: roto, tabla: "S" }, "u", "s", "x");
    expect(n).toBe(0);
    err.mockRestore();
  });
});
