import { describe, expect, it, vi } from "vitest";
import {
  crearAdaptadorJsm,
  configuradoJsm,
  NOTA_CAMPOS,
  NOTA_FALLO,
  NOTA_SIN_AUTH,
  NOTA_SIN_RESUMEN,
} from "./jsm";

const SECRETO = "cl13nt-s3cr3t-de-la-service-account";
const CONFIG = {
  clientId: "cid-123",
  clientSecret: SECRETO,
  cloudId: "cloud-abc",
  serviceDeskId: "10",
  requestTypeId: "25",
};

function respuesta(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    type: "default",
    json: async () => {
      if (body === undefined) throw new SyntaxError("body no es JSON");
      return body;
    },
  } as unknown as Response;
}

const TOKEN_OK = { access_token: "at-xyz", expires_in: 3600 };
const TICKET_OK = {
  issueId: "107001",
  issueKey: "HELPDESK-1",
  _links: { web: "https://acme.atlassian.net/servicedesk/customer/portal/10/HELPDESK-1" },
};

/** fetch falso que responde por URL: primero el token, después la API. */
function fetchFalso(...respuestas: Response[]) {
  const fn = vi.fn();
  for (const r of respuestas) fn.mockResolvedValueOnce(r);
  return fn as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
}

describe("configuradoJsm", () => {
  it("exige los cinco valores", () => {
    expect(configuradoJsm(CONFIG)).toBe(true);
    expect(configuradoJsm({ ...CONFIG, requestTypeId: "" })).toBe(false);
    expect(configuradoJsm({})).toBe(false);
  });
});

describe("escalar a JSM", () => {
  it("sin resumen no toca la red", async () => {
    const fetch = fetchFalso();
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    expect(await escalar({})).toEqual({ creado: false, nota: NOTA_SIN_RESUMEN });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("crea el pedido y devuelve la referencia y el link del portal", async () => {
    const fetch = fetchFalso(respuesta(200, TOKEN_OK), respuesta(201, TICKET_OK));
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    expect(await escalar({ resumen: "no encuentro mi factura", detalle: "de marzo" })).toEqual({
      creado: true,
      referencia: "HELPDESK-1",
      link: TICKET_OK._links.web,
    });

    // El POST va por api.atlassian.com con el cloudId, no por el dominio del sitio.
    const [url, opciones] = fetch.mock.calls[1]!;
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-abc/rest/servicedeskapi/request");
    expect(JSON.parse(opciones.body as string)).toEqual({
      serviceDeskId: "10",
      requestTypeId: "25",
      requestFieldValues: { summary: "no encuentro mi factura", description: "de marzo" },
    });
    expect((opciones.headers as Record<string, string>).authorization).toBe("Bearer at-xyz");
  });

  it("reusa el token entre escalamientos", async () => {
    const fetch = fetchFalso(
      respuesta(200, TOKEN_OK),
      respuesta(201, TICKET_OK),
      respuesta(201, TICKET_OK),
    );
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    await escalar({ resumen: "uno" });
    await escalar({ resumen: "dos" });
    // 1 token + 2 POST, no 2 tokens.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("renueva el token cuando esta por vencer", async () => {
    const fetch = fetchFalso(
      respuesta(200, { access_token: "at-1", expires_in: 3600 }),
      respuesta(201, TICKET_OK),
      respuesta(200, { access_token: "at-2", expires_in: 3600 }),
      respuesta(201, TICKET_OK),
    );
    let t = 0;
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch, ahora: () => t });
    await escalar({ resumen: "uno" });
    // Dentro del margen de renovación (quedan menos de 5 min).
    t = 3600_000 - 60_000;
    await escalar({ resumen: "dos" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((fetch.mock.calls[3]![1]!.headers as Record<string, string>).authorization).toBe(
      "Bearer at-2",
    );
  });

  it("un 401 no confirma el escalamiento y descarta el token cacheado", async () => {
    const fetch = fetchFalso(
      respuesta(200, TOKEN_OK),
      respuesta(401),
      respuesta(200, { access_token: "at-nuevo", expires_in: 3600 }),
      respuesta(201, TICKET_OK),
    );
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    expect(await escalar({ resumen: "uno" })).toEqual({ creado: false, nota: NOTA_SIN_AUTH });
    // El siguiente intento pide token de nuevo en vez de reusar el rechazado.
    await escalar({ resumen: "dos" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("un 400 dice que falta configuracion, no que fallo el sistema", async () => {
    const fetch = fetchFalso(respuesta(200, TOKEN_OK), respuesta(400));
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    expect(await escalar({ resumen: "uno" })).toEqual({ creado: false, nota: NOTA_CAMPOS });
  });

  it("un 500 nunca dice que creo el escalamiento", async () => {
    const fetch = fetchFalso(respuesta(200, TOKEN_OK), respuesta(500));
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    expect(await escalar({ resumen: "uno" })).toEqual({ creado: false, nota: NOTA_FALLO });
  });

  it("si el token no se obtiene, no postea", async () => {
    const fetch = fetchFalso(respuesta(500));
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    expect(await escalar({ resumen: "uno" })).toEqual({ creado: false, nota: NOTA_SIN_AUTH });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("el client_secret no aparece en los logs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValue(
      // El mensaje de una excepción de red puede arrastrar el cuerpo del request.
      Object.assign(new Error(`connect ECONNREFUSED body=${SECRETO}`), {
        name: "TypeError",
        cause: { code: "ECONNREFUSED" },
      }),
    ) as unknown as typeof globalThis.fetch;
    const escalar = crearAdaptadorJsm({ ...CONFIG, fetch });
    await escalar({ resumen: "uno" });
    const loggeado = error.mock.calls.flat().join(" ");
    expect(loggeado).not.toContain(SECRETO);
    expect(loggeado).toContain("ECONNREFUSED");
    error.mockRestore();
  });
});
