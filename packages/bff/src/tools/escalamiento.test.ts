import { describe, expect, it, vi } from "vitest";
import {
  crearEscalarAHumano,
  NOTA_FALLO,
  NOTA_REDIRECCION,
  NOTA_SIN_REFERENCIA,
  NOTA_SIN_RESUMEN,
  NOTA_SIN_WEBHOOK,
} from "./escalamiento";

// El URL del webhook ES el secreto (los webhooks suelen llevar el token en el
// path): este valor lleva una marca que los tests buscan en los logs.
const WEBHOOK = "https://webhook.ejemplo/escalamientos/t0k3n-secreto";

function respuesta(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("body no es JSON");
      return body;
    },
  } as unknown as Response;
}

// `fetch` inyectado por factory: nada de mocks de librería ni red en los tests.
function fetchFalso(devuelve: (url: string, init: RequestInit) => Promise<Response>) {
  const espia = vi.fn(devuelve);
  return { espia, fetch: espia as unknown as typeof globalThis.fetch };
}

function cuerpoDelPost(espia: ReturnType<typeof fetchFalso>["espia"]) {
  return JSON.parse(String(espia.mock.calls[0]![1].body));
}

const CASO = {
  resumen: "El usuario pide el estado de una garantía que no está en los documentos",
  detalle: "Producto XR-200, comprado en marzo",
};

describe("escalar_a_humano", () => {
  it("postea el payload del escalamiento y devuelve la referencia del webhook", async () => {
    const { espia, fetch } = fetchFalso(async () =>
      respuesta(201, { referencia: "ESC-42", link: "https://portal.ejemplo/ESC-42" }),
    );
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    const r = await escalar(CASO);

    expect(r).toEqual({
      creado: true,
      referencia: "ESC-42",
      link: "https://portal.ejemplo/ESC-42",
    });
    const [url, init] = espia.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    // Timeout duro: el turno del agente no puede quedarse colgado esperando
    // al sistema del cliente.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(cuerpoDelPost(espia)).toEqual(CASO);
  });

  // Una referencia INVENTADA con el formato de un ticket real (`ESC-` + hex) es
  // indistinguible de una que el usuario puede reclamar por el canal de
  // soporte, y el schema le dice al modelo que se la pase. Sin referencia del
  // webhook, el caso está creado pero no hay identificador que dar.
  it("un 2xx sin referencia NO inventa una: creado con la nota de que llega por soporte", async () => {
    const { fetch } = fetchFalso(async () => respuesta(200, { ok: true }));
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    const r = await escalar(CASO);

    expect(r).toEqual({ creado: true, nota: NOTA_SIN_REFERENCIA });
    expect(r).not.toHaveProperty("referencia");
    // Nada con forma de ticket en lo que vuelve.
    expect(JSON.stringify(r)).not.toMatch(/ESC-/);
  });

  it("un cuerpo que no es JSON no rompe el 2xx: sigue creado, tampoco con referencia inventada", async () => {
    const { fetch } = fetchFalso(async () => respuesta(204));
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    const r = await escalar(CASO);

    expect(r).toEqual({ creado: true, nota: NOTA_SIN_REFERENCIA });
    expect(r).not.toHaveProperty("referencia");
  });

  it("NUNCA dice creado si el POST no fue 2xx", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [400, 401, 404, 500, 502]) {
      const { fetch } = fetchFalso(async () => respuesta(status, { referencia: "ESC-mentira" }));
      const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

      const r = await escalar(CASO);

      expect(r).toEqual({ creado: false, nota: NOTA_FALLO });
    }
    err.mockRestore();
  });

  // `redirect: "follow"` (el default de fetch) produce un `creado: true` FALSO:
  // en 301/302/303 el método pasa a GET y el body se descarta, así que el POST
  // se pierde, el GET devuelve 200 y `respuesta.ok` es true. Pasa con un
  // secreto seteado con `http://` o con barra final que el server normaliza.
  it("pide redirect manual: con `follow` el POST se convertiría en un GET", async () => {
    const { espia, fetch } = fetchFalso(async () => respuesta(201, { referencia: "ESC-1" }));

    await crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch })(CASO);

    expect(espia.mock.calls[0]![1].redirect).toBe("manual");
  });

  it("un 3xx NUNCA es creado, y la nota dice que el destino redirige", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [301, 302, 303, 307, 308]) {
      const { fetch } = fetchFalso(async () =>
        respuesta(status, { referencia: "ESC-mentira" }),
      );
      const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

      expect(await escalar(CASO)).toEqual({ creado: false, nota: NOTA_REDIRECCION });
    }
    err.mockRestore();
  });

  it("un opaqueredirect (status 0, el filtrado del spec) tampoco es creado", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // undici devuelve el 3xx real, pero el spec de fetch permite devolver una
    // respuesta filtrada `opaqueredirect` con status 0: no se asume ninguna de
    // las dos formas.
    const { fetch } = fetchFalso(async () => ({
      ok: false,
      status: 0,
      type: "opaqueredirect",
      json: async () => ({}),
    }) as unknown as Response);
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    expect(await escalar(CASO)).toEqual({ creado: false, nota: NOTA_REDIRECCION });
    err.mockRestore();
  });

  it("webhook caído: creado false con nota humana, no lanza", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch } = fetchFalso(async () => {
      throw new TypeError("fetch failed");
    });
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    expect(await escalar(CASO)).toEqual({ creado: false, nota: NOTA_FALLO });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("el secreto del webhook NUNCA se loguea (ni por el mensaje de la excepción)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const caido = fetchFalso(async () => {
      // Node mete el host —y una librería podría meter el URL entero— en el
      // mensaje de la excepción de red: por eso no se loguea el mensaje.
      throw new TypeError(`request to ${WEBHOOK} failed, reason: ECONNREFUSED`);
    });
    await crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch: caido.fetch })(CASO);

    const noOk = fetchFalso(async () => respuesta(500, {}));
    await crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch: noOk.fetch })(CASO);

    const logueado = JSON.stringify(
      err.mock.calls.map((args) => args.map((a) => (a instanceof Error ? [a.name, a.message] : a))),
    );
    expect(logueado).not.toContain("t0k3n-secreto");
    expect(logueado).not.toContain("webhook.ejemplo");
    err.mockRestore();
  });

  // Contracara del test de arriba: el secreto no se filtra por el LOG, pero
  // tampoco puede filtrarse por el VALOR DE RETORNO — que es peor, porque el
  // schema le dice al modelo que le pase el link al usuario. Un catch-hook de
  // Zapier (y los "webhook testers" en general) devuelve el hook COMPLETO, con
  // token, en el cuerpo de su 200.
  it("el secreto del webhook NUNCA sale por el valor de retorno", async () => {
    const cuerposQueReflejanElHook = [
      { url: WEBHOOK },
      { self: WEBHOOK },
      { link: WEBHOOK },
      { referencia: WEBHOOK },
      { status: "success", url: `${WEBHOOK}?attempt=1`, request_id: "0f7b" },
      { key: `${WEBHOOK}/hooks/catch/1`, link: `${WEBHOOK}/portal` },
    ];

    for (const cuerpo of cuerposQueReflejanElHook) {
      const { fetch } = fetchFalso(async () => respuesta(200, cuerpo));
      const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

      const devuelto = JSON.stringify(await escalar(CASO));

      expect(devuelto).not.toContain("t0k3n-secreto");
      expect(devuelto).not.toContain("webhook.ejemplo");
    }
  });

  it("un link de OTRO origen sí llega al usuario (el filtro no es un tapón)", async () => {
    const { fetch } = fetchFalso(async () =>
      respuesta(201, { referencia: "ESC-7", link: "https://portal.ejemplo/ESC-7" }),
    );
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    expect(await escalar(CASO)).toEqual({
      creado: true,
      referencia: "ESC-7",
      link: "https://portal.ejemplo/ESC-7",
    });
  });

  it("sin webhook configurado no postea nada y avisa", async () => {
    const { espia, fetch } = fetchFalso(async () => respuesta(200, {}));
    const escalar = crearEscalarAHumano({ webhookUrl: "", fetch });

    expect(await escalar(CASO)).toEqual({ creado: false, nota: NOTA_SIN_WEBHOOK });
    expect(espia).not.toHaveBeenCalled();
  });

  it("sin resumen no postea nada y pide el resumen", async () => {
    const { espia, fetch } = fetchFalso(async () => respuesta(200, {}));
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    expect(await escalar({ resumen: "   " })).toEqual({
      creado: false,
      nota: NOTA_SIN_RESUMEN,
    });
    expect(espia).not.toHaveBeenCalled();
  });

  // `usuario` y `conversacion` salieron del schema: el core manda al Gateway
  // SOLO los argumentos que armó el modelo, y el modelo no tiene el actor ni la
  // sesión en contexto, así que llegaban vacíos o inventados. Si igual los
  // manda, no viajan: un ticket con una identidad inventada es peor que uno sin
  // identidad. (Inyectarlos del lado del servidor es otra fase.)
  it("no reenvía identidades que el modelo pudiera inventar", async () => {
    const { espia, fetch } = fetchFalso(async () => respuesta(200, { referencia: "ESC-1" }));
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    await escalar({
      ...CASO,
      usuario: "juan.perez@ejemplo",
      conversacion: "hilo-inventado",
    } as never);

    expect(cuerpoDelPost(espia)).toEqual(CASO);
  });

  it("los campos opcionales ausentes no viajan como undefined en el payload", async () => {
    const { espia, fetch } = fetchFalso(async () => respuesta(200, { referencia: "ESC-1" }));
    const escalar = crearEscalarAHumano({ webhookUrl: WEBHOOK, fetch });

    await escalar({ resumen: "  solo el resumen  " });

    expect(cuerpoDelPost(espia)).toEqual({ resumen: "solo el resumen" });
  });
});
