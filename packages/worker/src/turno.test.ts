import { describe, expect, it, vi } from "vitest";
import { MENSAJES_WORKER } from "@craftech-ai-chat/shared/mensajes";
import { procesarMensaje, type Deps } from "./turno";
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
      },
    });

    await procesarMensaje({ ...evento, msgId: "m2" }, deps);

    expect(deps.invocar).toHaveBeenCalledWith({ message: "hola\nque tal", userId: "u1", sessionId: "c1" });
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
    // Nace verde: turno.ts ya cubre este caso por el mismo catch que atrapa
    // invoke/parseo/PutItem — `texto` queda `undefined` si el for-await
    // termina sin ver `type:"done"`, y eso dispara el error path. Test fijado
    // para blindar el comportamiento ante un futuro refactor.
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
});
