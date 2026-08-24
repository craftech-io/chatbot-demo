import { describe, expect, it, vi } from "vitest";
import type { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { verificarYConsumirTope } from "./topes";

function ddbFalso(nuevoCount: number) {
  return {
    send: vi.fn(async (_comando: UpdateItemCommand) => ({
      Attributes: { count: { N: String(nuevoCount) } },
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = (ddb: any, turnosSesion = 0) => ({
  ddb, tabla: "Limits", topeDiario: 3, topeSesion: 5,
  sesiones: { turnos: async () => turnosSesion },
});

describe("verificarYConsumirTope", () => {
  it("permite bajo el tope diario", async () => {
    const r = await verificarYConsumirTope(base(ddbFalso(2)), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: true });
  });

  it("rechaza al superar el tope diario", async () => {
    const r = await verificarYConsumirTope(base(ddbFalso(4)), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: false, motivo: "dia" });
  });

  it("rechaza al superar el tope por sesión aunque el día alcance", async () => {
    const r = await verificarYConsumirTope(base(ddbFalso(1), 6), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: false, motivo: "sesion" });
  });

  it("fail-open: si dynamo falla, permite y loguea", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = { send: vi.fn(async () => { throw new Error("dynamo caída"); }) } as never;
    const r = await verificarYConsumirTope(base(roto), "u1", "s1", "2026-08-21");
    expect(r).toEqual({ permitido: true });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("setea expiraAt (TTL) sin pisar el existente, para que Dynamo purgue períodos vencidos", async () => {
    const ddb = ddbFalso(1);
    await verificarYConsumirTope(base(ddb), "u1", "s1", "2026-08-21");
    const [comando] = ddb.send.mock.calls[0]!;
    expect(comando.input.UpdateExpression).toContain(
      "SET expiraAt = if_not_exists(expiraAt, :expira)",
    );
    expect(comando.input.ExpressionAttributeValues?.[":expira"]).toEqual({
      N: expect.stringMatching(/^\d+$/),
    });
  });
});
