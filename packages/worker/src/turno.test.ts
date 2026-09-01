import { describe, expect, it, vi } from "vitest";
import { MENSAJES_WORKER } from "@craftech-ai-chat/shared/mensajes";
import { historialParaElTurno, MAX_MENSAJES_HISTORIAL, procesarMensaje, type Deps } from "./turno";
import type { Mensaje } from "../../bff/src/mensajes/store";

const enc = new TextEncoder();

// Arma un stream NDJSON crudo a partir de frames ya parseados: el mismo
// contrato que emite el core (ver packages/worker/src/ndjson.ts).
async function* streamDe(...frames: Record<string, unknown>[]): AsyncIterable<Uint8Array> {
  for (const f of frames) yield enc.encode(`${JSON.stringify(f)}\n`);
}

function mensaje(msgId: string, texto: string): Mensaje {
  return { conversationId: "c1", orden: `t#${msgId}`, msgId, rol: "user", texto, ts: "t" };
}

function depsBase(overrides: Partial<Deps> = {}): Deps {
  return {
    store: {
      ultimoMsgIdUsuario: vi.fn(async () => "m1"),
      pendientesDesdeUltimaRespuesta: vi.fn(async () => [mensaje("m1", "hola")]),
      listar: vi.fn(async () => []),
    },
    invocar: vi.fn(async () => streamDe({ type: "done", text: "listo" })),
    escribir: vi.fn(async (m) => ({ ...m, orden: `${m.ts}#${m.msgId}` }) as Mensaje),
    ...overrides,
  };
}

const evento = { conversationId: "c1", msgId: "m1", userId: "u1" };

describe("procesarMensaje", () => {
  it("descarta el turno si el mensaje no es el último del usuario", async () => {
    const deps = depsBase({
      store: {
        ultimoMsgIdUsuario: vi.fn(async () => "m2-mas-nuevo"),
        pendientesDesdeUltimaRespuesta: vi.fn(),
        listar: vi.fn(async () => []),
      },
    });

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("descartado");
    expect(deps.store.pendientesDesdeUltimaRespuesta).not.toHaveBeenCalled();
    expect(deps.invocar).not.toHaveBeenCalled();
    expect(deps.escribir).not.toHaveBeenCalled();
  });

  it("agrega los pendientes con salto de línea antes de invocar al agente", async () => {
    const deps = depsBase({
      store: {
        ultimoMsgIdUsuario: vi.fn(async () => "m2"),
        pendientesDesdeUltimaRespuesta: vi.fn(async () => [mensaje("m1", "hola"), mensaje("m2", "que tal")]),
        listar: vi.fn(async () => []),
      },
    });

    await procesarMensaje({ ...evento, msgId: "m2" }, deps);

    expect(deps.invocar).toHaveBeenCalledWith({
      message: "hola\nque tal",
      userId: "u1",
      sessionId: "c1",
      history: [],
    });
  });

  it("escribe el texto del frame done como mensaje del assistant y devuelve procesado", async () => {
    const deps = depsBase();

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("procesado");
    expect(deps.escribir).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", rol: "assistant", texto: "listo" }),
    );
  });

  it("un frame de error del core se trata como fallo: assistant con MENSAJES_WORKER.error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = depsBase({
      invocar: vi.fn(async () => streamDe({ type: "error", code: "agent_unavailable" })),
    });

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("error_respondido");
    expect(deps.escribir).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", rol: "assistant", texto: MENSAJES_WORKER.error }),
    );
    err.mockRestore();
  });

  it("si invocar lanza, escribe el mensaje de error del worker y NO relanza", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = depsBase({
      invocar: vi.fn(async () => {
        throw new Error("el runtime rechazó el invoke");
      }),
    });

    await expect(procesarMensaje(evento, deps)).resolves.toBe("error_respondido");
    expect(deps.escribir).toHaveBeenCalledWith(
      expect.objectContaining({ rol: "assistant", texto: MENSAJES_WORKER.error }),
    );
    err.mockRestore();
  });

  it("PIN: si el stream corta sin frame done (solo deltas), se trata como fallo y NO relanza", async () => {
    // turno.ts cubre este caso con el mismo catch que atrapa
    // invoke/parseo/PutItem: `texto` queda `undefined` si el for-await termina
    // sin ver `type:"done"`, y eso dispara el error path. El test lo blinda
    // ante un refactor.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = depsBase({
      invocar: vi.fn(async () => streamDe({ type: "delta", text: "Hola" }, { type: "delta", text: " mundo" })),
    });

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("error_respondido");
    expect(deps.escribir).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", rol: "assistant", texto: MENSAJES_WORKER.error }),
    );
    err.mockRestore();
  });

  it("si el PutItem de la respuesta del assistant falla, loguea y NO relanza", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = depsBase({
      escribir: vi.fn(async () => {
        throw new Error("dynamo caída");
      }),
    });

    await expect(procesarMensaje(evento, deps)).resolves.toBe("error_respondido");
    // Se intentó escribir la respuesta feliz Y, tras fallar, el mensaje de
    // error — ambos intentos fallan acá, y aun así no se relanza.
    expect(deps.escribir).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  // Sin pendientes no hay nada que responder (redelivery post-crash, o
  // fail-open del store): el assistant ya está escrito o lo trae otro job. El
  // mock local (apps/web/server.mjs) tiene la misma guarda.
  it("si no hay pendientes, descarta el turno sin invocar ni escribir", async () => {
    const deps = depsBase({
      store: {
        ultimoMsgIdUsuario: vi.fn(async () => "m1"),
        pendientesDesdeUltimaRespuesta: vi.fn(async () => []),
        listar: vi.fn(async () => []),
      },
    });

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("descartado");
    expect(deps.invocar).not.toHaveBeenCalled();
    expect(deps.escribir).not.toHaveBeenCalled();
  });

  // El actToken llega en el evento SQS y viaja al invoke.
  it("pasa el actToken del evento al invocar (payload del runtime)", async () => {
    const deps = depsBase();

    await procesarMensaje({ ...evento, actToken: "token-de-la-api-del-cliente" }, deps);

    expect(deps.invocar).toHaveBeenCalledWith({
      message: "hola",
      userId: "u1",
      sessionId: "c1",
      history: [],
      actToken: "token-de-la-api-del-cliente",
    });
  });

  it("un evento SIN actToken (cola vieja, canal futuro) invoca sin el campo, sin romper", async () => {
    const deps = depsBase();

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("procesado");
    const payload = (deps.invocar as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect("actToken" in payload).toBe(false);
  });

  // PIN de seguridad: la respuesta del assistant que el worker escribe en
  // MessagesTable JAMÁS contiene el actToken — ni la clave ni el valor.
  it("lo que el worker escribe en MessagesTable no contiene el actToken", async () => {
    const deps = depsBase();

    await procesarMensaje({ ...evento, actToken: "token-de-la-api-del-cliente" }, deps);

    const escrituras = (deps.escribir as ReturnType<typeof vi.fn>).mock.calls;
    expect(escrituras.length).toBeGreaterThan(0);
    const serializado = JSON.stringify(escrituras);
    expect(serializado).not.toContain("actToken");
    expect(serializado).not.toContain("token-de-la-api-del-cliente");
  });

  // `ultimoMsgIdUsuario` devolviendo `null` solo puede ser un fallo de lectura
  // del store (el evento implica que el mensaje del usuario existe) — ante la
  // duda se responde: un descarte acá sería silencio para el usuario. Si además
  // el store no puede leer pendientes, degrada a "descartado" en vez de invocar
  // al agente con un mensaje vacío.
  it("si ultimoMsgIdUsuario devuelve null, procesa el turno igual (no descarta)", async () => {
    const deps = depsBase({
      store: {
        ultimoMsgIdUsuario: vi.fn(async () => null),
        pendientesDesdeUltimaRespuesta: vi.fn(async () => [mensaje("m1", "hola")]),
        listar: vi.fn(async () => []),
      },
    });

    const resultado = await procesarMensaje(evento, deps);

    expect(resultado).toBe("procesado");
    expect(deps.invocar).toHaveBeenCalledWith({
      message: "hola",
      userId: "u1",
      sessionId: "c1",
      history: [],
    });
  });
});

describe("historialParaElTurno", () => {
  function msg(msgId: string, rol: "user" | "assistant", texto: string): Mensaje {
    return { conversationId: "c1", orden: `t#${msgId}`, msgId, rol, texto, ts: "t" };
  }

  it("excluye los mensajes que este turno va a responder", () => {
    // Los pendientes viajan como `message`; repetirlos en el historial le
    // mostraría al modelo la misma pregunta dos veces.
    const conversacion = [
      msg("m1", "user", "hola"),
      msg("m2", "assistant", "buenas"),
      msg("m3", "user", "y el envío?"),
    ];
    const h = historialParaElTurno(conversacion, [msg("m3", "user", "y el envío?")]);
    expect(h).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "buenas" },
    ]);
  });

  it("corta en los ultimos MAX_MENSAJES_HISTORIAL", () => {
    const largo = Array.from({ length: 40 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", `t${i}`));
    const h = historialParaElTurno(largo, []);
    expect(h).toHaveLength(MAX_MENSAJES_HISTORIAL);
    // Se queda con los MÁS RECIENTES, no con los primeros.
    expect(h[h.length - 1]!.content).toBe("t39");
  });

  it("una conversacion nueva no manda historial", () => {
    expect(historialParaElTurno([], [])).toEqual([]);
  });
});
