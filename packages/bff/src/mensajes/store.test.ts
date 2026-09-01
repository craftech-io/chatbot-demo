import { describe, expect, it, vi } from "vitest";
import type { AttributeValue, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import {
  escribirMensaje,
  listarMensajes,
  pendientesDesdeUltimaRespuesta,
  ultimoMsgIdUsuario,
  type Mensaje,
} from "./store";

// Item crudo de Dynamo para una fila de MessagesTable (pk conversationId, sk orden).
function item(
  rol: Mensaje["rol"],
  msgId: string,
  ts = "2026-08-25T10:00:00.000Z",
): Record<string, AttributeValue> {
  return {
    conversationId: { S: "c1" },
    orden: { S: `${ts}#${msgId}` },
    msgId: { S: msgId },
    rol: { S: rol },
    texto: { S: `texto-${msgId}` },
    ts: { S: ts },
  };
}

describe("escribirMensaje", () => {
  it("arma orden = ts#msgId y serializa todos los campos en el Item", async () => {
    const send = vi.fn(async (_cmd: PutItemCommand) => ({}));
    const m = {
      conversationId: "c1",
      msgId: "m1",
      rol: "user" as const,
      texto: "hola",
      ts: "2026-08-25T10:00:00.000Z",
    };
    const resultado = await escribirMensaje({ ddb: { send } as never, tabla: "Messages" }, m);

    expect(resultado).toEqual({ ...m, orden: "2026-08-25T10:00:00.000Z#m1" });
    const cmd = send.mock.calls[0]![0].input;
    expect(cmd.TableName).toBe("Messages");
    expect(cmd.Item).toEqual({
      expiraEn: { N: expect.any(String) },
      conversationId: { S: "c1" },
      orden: { S: "2026-08-25T10:00:00.000Z#m1" },
      msgId: { S: "m1" },
      rol: { S: "user" },
      texto: { S: "hola" },
      ts: { S: "2026-08-25T10:00:00.000Z" },
    });
  });

  it("LANZA si dynamo falla: perder un mensaje del usuario es grave, no hay fail-open", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = {
      send: vi.fn(async () => {
        throw new Error("dynamo caída");
      }),
    };
    await expect(
      escribirMensaje(
        { ddb: roto as never, tabla: "Messages" },
        { conversationId: "c1", msgId: "m1", rol: "user", texto: "hola", ts: "2026-08-25T10:00:00.000Z" },
      ),
    ).rejects.toThrow("dynamo caída");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("listarMensajes", () => {
  it("Query ascendente por conversationId, sin cursor", async () => {
    const items = [item("user", "m1"), item("assistant", "m2", "2026-08-25T10:00:05.000Z")];
    const send = vi.fn(async (_cmd: QueryCommand) => ({ Items: items }));

    const mensajes = await listarMensajes({ ddb: { send } as never, tabla: "Messages" }, "c1");

    expect(mensajes.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    const cmd = send.mock.calls[0]![0].input;
    expect(cmd.TableName).toBe("Messages");
    expect(cmd.KeyConditionExpression).toBe("conversationId = :cid");
    expect(cmd.ExpressionAttributeValues?.[":cid"]).toEqual({ S: "c1" });
    expect(cmd.ScanIndexForward).toBe(true);
  });

  it("con cursor `desde`, agrega `orden > :desde` (orden va con #orden: ORDER es palabra reservada en Dynamo)", async () => {
    const send = vi.fn(async (_cmd: QueryCommand) => ({ Items: [] }));

    await listarMensajes({ ddb: { send } as never, tabla: "Messages" }, "c1", "cursor-x");

    const cmd = send.mock.calls[0]![0].input;
    expect(cmd.KeyConditionExpression).toBe("conversationId = :cid AND #orden > :desde");
    expect(cmd.ExpressionAttributeNames).toEqual({ "#orden": "orden" });
    expect(cmd.ExpressionAttributeValues?.[":desde"]).toEqual({ S: "cursor-x" });
  });

  it("fail-open de lectura: devuelve [] y loguea si dynamo falla", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = {
      send: vi.fn(async () => {
        throw new Error("dynamo caída");
      }),
    };
    const mensajes = await listarMensajes({ ddb: roto as never, tabla: "Messages" }, "c1");
    expect(mensajes).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("pendientesDesdeUltimaRespuesta", () => {
  it("Query descendente: corta en el primer assistant y devuelve los user en orden cronológico", async () => {
    // Descendente (el más nuevo primero): dos mensajes de usuario después de
    // la última respuesta, luego la respuesta, luego un mensaje viejo previo
    // a esa respuesta que NO debe aparecer entre los pendientes.
    const items = [item("user", "u2b"), item("user", "u2a"), item("assistant", "a1"), item("user", "u0")];
    const send = vi.fn(async (_cmd: QueryCommand) => ({ Items: items }));

    const pendientes = await pendientesDesdeUltimaRespuesta({ ddb: { send } as never, tabla: "Messages" }, "c1");

    expect(pendientes.map((m) => m.msgId)).toEqual(["u2a", "u2b"]);
    const cmd = send.mock.calls[0]![0].input;
    expect(cmd.KeyConditionExpression).toBe("conversationId = :cid");
    expect(cmd.ScanIndexForward).toBe(false);
    // Defensa barata contra el corte de página de 1MB de Dynamo: el tope por
    // sesión (40) hace inalcanzable un backlog real mayor a 100 mensajes.
    expect(cmd.Limit).toBe(100);
  });

  it("si el mensaje más reciente ya es del assistant, no hay pendientes", async () => {
    const items = [item("assistant", "a1"), item("user", "u0")];
    const send = vi.fn(async () => ({ Items: items }));

    const pendientes = await pendientesDesdeUltimaRespuesta({ ddb: { send } as never, tabla: "Messages" }, "c1");
    expect(pendientes).toEqual([]);
  });

  it("sin respuesta del assistant todavía en la conversación, devuelve todo en cronológico", async () => {
    const items = [item("user", "u2"), item("user", "u1")];
    const send = vi.fn(async () => ({ Items: items }));

    const pendientes = await pendientesDesdeUltimaRespuesta({ ddb: { send } as never, tabla: "Messages" }, "c1");
    expect(pendientes.map((m) => m.msgId)).toEqual(["u1", "u2"]);
  });

  it("fail-open de lectura: devuelve [] y loguea si dynamo falla", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = {
      send: vi.fn(async () => {
        throw new Error("dynamo caída");
      }),
    };
    const pendientes = await pendientesDesdeUltimaRespuesta({ ddb: roto as never, tabla: "Messages" }, "c1");
    expect(pendientes).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("ultimoMsgIdUsuario", () => {
  it("con mezcla de roles, devuelve el msgId del user más reciente (recorre descendente)", async () => {
    const items = [item("assistant", "a2"), item("user", "u1"), item("assistant", "a0")];
    const send = vi.fn(async () => ({ Items: items }));

    const msgId = await ultimoMsgIdUsuario({ ddb: { send } as never, tabla: "Messages" }, "c1");
    expect(msgId).toBe("u1");
  });

  it("devuelve null si no hay ningún mensaje de usuario", async () => {
    const items = [item("assistant", "a1")];
    const send = vi.fn(async () => ({ Items: items }));

    const msgId = await ultimoMsgIdUsuario({ ddb: { send } as never, tabla: "Messages" }, "c1");
    expect(msgId).toBeNull();
  });

  it("fail-open de lectura: devuelve null y loguea si dynamo falla", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = {
      send: vi.fn(async () => {
        throw new Error("dynamo caída");
      }),
    };
    const msgId = await ultimoMsgIdUsuario({ ddb: roto as never, tabla: "Messages" }, "c1");
    expect(msgId).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("retencion (TTL)", () => {
  const base = {
    conversationId: "c1", msgId: "m1", rol: "user" as const,
    texto: "hola", ts: "2026-08-25T10:00:00.000Z",
  };

  async function expiraEnDe(dias?: string) {
    const previo = process.env.RETENCION_HISTORIAL_DIAS;
    if (dias === undefined) delete process.env.RETENCION_HISTORIAL_DIAS;
    else process.env.RETENCION_HISTORIAL_DIAS = dias;
    const send = vi.fn(async (_c: PutItemCommand) => ({}));
    await escribirMensaje({ ddb: { send } as never, tabla: "Messages" }, base);
    if (previo === undefined) delete process.env.RETENCION_HISTORIAL_DIAS;
    else process.env.RETENCION_HISTORIAL_DIAS = previo;
    return Number(send.mock.calls[0]![0].input.Item!.expiraEn!.N);
  }

  it("el TTL va en SEGUNDOS, no en milisegundos", async () => {
    // Con milisegundos el vencimiento cae en el año 57000 y DynamoDB no borra
    // nunca: el chequeo es que el orden de magnitud sea de segundos.
    const ahora = Math.floor(Date.now() / 1000);
    const t = await expiraEnDe("30");
    expect(t).toBeGreaterThan(ahora);
    expect(t).toBeLessThan(ahora + 31 * 24 * 60 * 60);
  });

  it("respeta los dias configurados", async () => {
    const corto = await expiraEnDe("1");
    const largo = await expiraEnDe("90");
    expect(largo - corto).toBeCloseTo(89 * 24 * 60 * 60, -1);
  });

  it("sin la env cae al default en vez de escribir NaN", async () => {
    // Un NaN en el TTL hace que DynamoDB rechace el PutItem y se pierda el
    // mensaje: el default es una red, no la política.
    const t = await expiraEnDe(undefined);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
