import { describe, expect, it, vi } from "vitest";
import {
  adjuntoIngestable,
  aTexto,
  MAX_ADJUNTO_BYTES,
  MAX_ESPERA_MS,
  MAX_REINTENTOS_429,
  claveDe,
  crearClienteConfluence,
  sidecarDe,
  sincronizar,
  type Almacen,
} from "./confluence";

describe("aTexto", () => {
  it("conserva la estructura que cambia como se lee un pasaje", () => {
    const storage =
      "<h2>Devoluciones</h2><p>Tenés <strong>30 días</strong>.</p><ul><li>sin uso</li><li>con ticket</li></ul>";
    expect(aTexto(storage)).toBe(
      "## Devoluciones\n\nTenés 30 días.\n\n- sin uso\n- con ticket",
    );
  });

  it("descarta las macros de Confluence con su cuerpo", () => {
    const storage =
      '<p>Antes</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro><p>Después</p>';
    const texto = aTexto(storage);
    expect(texto).toContain("Antes");
    expect(texto).toContain("Después");
    expect(texto).not.toContain("maxLevel");
    expect(texto).not.toContain("ac:");
  });

  it("decodifica entidades y no deja etiquetas", () => {
    expect(aTexto("<p>Ma&ntilde;ana &amp; tarde &lt;ok&gt;</p>")).toBe("Ma&ntilde;ana & tarde <ok>");
    expect(aTexto("<p>a&nbsp;b</p>")).toBe("a b");
  });

  it("una pagina vacia da texto vacio", () => {
    expect(aTexto("<p></p>")).toBe("");
    expect(aTexto("")).toBe("");
  });
});

describe("sidecar", () => {
  it("usa los atributos que consume la tool de documentos", () => {
    const s = JSON.parse(sidecarDe({ titulo: "Garantía", espacio: "SOP", url: "https://a/b" }));
    expect(s.metadataAttributes.title.value.stringValue).toBe("Garantía");
    expect(s.metadataAttributes.title.includeForEmbedding).toBe(true);
    expect(s.metadataAttributes.url.value.stringValue).toBe("https://a/b");
    expect(s.metadataAttributes.url.includeForEmbedding).toBe(false);
  });
});

const ESPACIOS = { results: [{ id: "77", key: "SOP" }] };
function pagina(id: string, title: string, cuerpo: string) {
  return {
    id,
    title,
    spaceId: "77",
    body: { storage: { value: cuerpo } },
    _links: { webui: `/spaces/SOP/pages/${id}` },
  };
}

function clienteFalso(...respuestas: unknown[]) {
  const fetch = vi.fn();
  for (const body of respuestas) {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body } as Response);
  }
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    espia: fetch,
    cliente: crearClienteConfluence({
      cloudId: "cid",
      token: "at-1",
      espacios: ["SOP"],
      sitioUrl: "https://acme.atlassian.net/",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
  };
}

describe("cliente de Confluence", () => {
  it("llama a api.atlassian.com con el cloudId y filtra por id de espacio", async () => {
    const { cliente, espia } = clienteFalso(ESPACIOS, {
      results: [pagina("1", "Garantía", "<p>hola</p>")],
    });
    const paginas = [];
    for await (const p of cliente.paginas()) paginas.push(p);

    expect(espia.mock.calls[0]![0]).toContain(
      "https://api.atlassian.com/ex/confluence/cid/wiki/api/v2/spaces?keys=SOP",
    );
    const urlPaginas = String(espia.mock.calls[1]![0]);
    expect(urlPaginas).toContain("/wiki/api/v2/pages?");
    expect(urlPaginas).toContain("space-id=77");
    expect(urlPaginas).toContain("body-format=storage");

    expect(paginas).toEqual([
      {
        id: "1",
        titulo: "Garantía",
        espacio: "SOP",
        texto: "hola",
        url: "https://acme.atlassian.net/wiki/spaces/SOP/pages/1",
      },
    ]);
  });

  it("sigue la paginacion por _links.next", async () => {
    const { cliente, espia } = clienteFalso(
      ESPACIOS,
      {
        results: [pagina("1", "Uno", "<p>a</p>")],
        _links: { next: "/wiki/api/v2/pages?cursor=abc" },
      },
      { results: [pagina("2", "Dos", "<p>b</p>")] },
    );
    const ids = [];
    for await (const p of cliente.paginas()) ids.push(p.id);
    expect(ids).toEqual(["1", "2"]);
    expect(String(espia.mock.calls[2]![0])).toBe(
      "https://api.atlassian.com/ex/confluence/cid/wiki/api/v2/pages?cursor=abc",
    );
  });

  it("saltea paginas sin contenido", async () => {
    const { cliente } = clienteFalso(ESPACIOS, {
      results: [pagina("1", "Vacía", "<p></p>"), pagina("2", "Con texto", "<p>algo</p>")],
    });
    const ids = [];
    for await (const p of cliente.paginas()) ids.push(p.id);
    expect(ids).toEqual(["2"]);
  });

  it("sin espacios en la allowlist no ingesta nada", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const cliente = crearClienteConfluence({
      cloudId: "cid", token: "t", espacios: [], sitioUrl: "https://a", fetch,
    });
    const ids = [];
    for await (const p of cliente.paginas()) ids.push(p.id);
    expect(ids).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("un error de la API corta en vez de dejar el corpus a medias", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
    const cliente = crearClienteConfluence({
      cloudId: "cid", token: "t", espacios: ["SOP"],
      sitioUrl: "https://a", fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(async () => {
      for await (const _ of cliente.paginas());
    }).rejects.toThrow("403");
  });
});

describe("sincronizar", () => {
  function almacenFalso(
    existentes: string[] = [],
  ): Almacen & { escrito: Map<string, string | Uint8Array>; borrado: string[] } {
    const escrito = new Map<string, string | Uint8Array>();
    const borrado: string[] = [];
    return {
      escrito,
      borrado,
      listar: async () => existentes,
      escribir: async (c, cuerpo) => void escrito.set(c, cuerpo),
      borrar: async (claves) => void borrado.push(...claves),
    };
  }

  const unaPagina = {
    async *paginas() {
      yield { id: "1", titulo: "Garantía", espacio: "SOP", texto: "cubre 6 meses", url: "https://a/1" };
    },
    adjuntos: async () => [],
    descargar: async () => new Uint8Array(),
  };

  it("escribe el documento y su sidecar", async () => {
    const almacen = almacenFalso();
    const r = await sincronizar(unaPagina, almacen);
    expect(r).toEqual({ escritas: 1, adjuntos: 0, borradas: 0 });
    expect(almacen.escrito.get("confluence/SOP/1.md")).toBe("# Garantía\n\ncubre 6 meses\n");
    expect(almacen.escrito.has("confluence/SOP/1.md.metadata.json")).toBe(true);
  });

  it("borra del bucket lo que ya no esta en Confluence", async () => {
    // Una página borrada del otro lado tiene que salir del índice: si no, el
    // agente sigue respondiendo con una política derogada.
    const almacen = almacenFalso([
      "confluence/SOP/1.md",
      "confluence/SOP/1.md.metadata.json",
      "confluence/SOP/9.md",
      "confluence/SOP/9.md.metadata.json",
    ]);
    const r = await sincronizar(unaPagina, almacen);
    expect(r.borradas).toBe(2);
    expect(almacen.borrado.sort()).toEqual([
      "confluence/SOP/9.md",
      "confluence/SOP/9.md.metadata.json",
    ]);
  });

  it("es idempotente: correrlo dos veces no borra nada", async () => {
    const almacen = almacenFalso([claveDe({ id: "1", espacio: "SOP" } as never), "confluence/SOP/1.md.metadata.json"]);
    const r = await sincronizar(unaPagina, almacen);
    expect(r.borradas).toBe(0);
  });
});

describe("adjuntos", () => {
  it("solo ingesta los tipos que la Knowledge Base parsea", () => {
    expect(adjuntoIngestable("manual.pdf", 1000)).toBe(true);
    expect(adjuntoIngestable("planilla.xlsx", 1000)).toBe(true);
    expect(adjuntoIngestable("captura.png", 1000)).toBe(false);
    expect(adjuntoIngestable("demo.mp4", 1000)).toBe(false);
    expect(adjuntoIngestable("sin-extension", 1000)).toBe(false);
  });

  it("descarta lo que pasa el limite de tamaño", () => {
    expect(adjuntoIngestable("grande.pdf", MAX_ADJUNTO_BYTES + 1)).toBe(false);
    expect(adjuntoIngestable("justo.pdf", MAX_ADJUNTO_BYTES)).toBe(true);
  });

  it("escribe el binario y su sidecar cuando estan habilitados", async () => {
    const escrito = new Map<string, string | Uint8Array>();
    const almacen: Almacen = {
      listar: async () => [],
      escribir: async (c, cuerpo) => void escrito.set(c, cuerpo),
      borrar: async () => {},
    };
    const cliente = {
      async *paginas() {
        yield { id: "1", titulo: "Manuales", espacio: "SOP", texto: "ver adjunto", url: "https://a/1" };
      },
      adjuntos: async () => [
        {
          id: "9", titulo: "manual.pdf", espacio: "SOP", paginaId: "1",
          url: "https://a/adj", descargarDesde: "https://a/dl", bytes: 10,
        },
      ],
      descargar: async () => new Uint8Array([1, 2, 3]),
    };
    const r = await sincronizar(cliente, almacen, { adjuntos: true });
    expect(r).toEqual({ escritas: 1, adjuntos: 1, borradas: 0 });
    expect(escrito.get("confluence/SOP/adjuntos/9-manual.pdf")).toEqual(new Uint8Array([1, 2, 3]));
    expect(escrito.has("confluence/SOP/adjuntos/9-manual.pdf.metadata.json")).toBe(true);
  });

  it("un adjunto que falla no aborta la corrida", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const almacen: Almacen = { listar: async () => [], escribir: async () => {}, borrar: async () => {} };
    const cliente = {
      async *paginas() {
        yield { id: "1", titulo: "P", espacio: "SOP", texto: "t", url: "u" };
      },
      adjuntos: async () => [
        { id: "9", titulo: "roto.pdf", espacio: "SOP", paginaId: "1", url: "u", descargarDesde: "d", bytes: 10 },
      ],
      descargar: async () => {
        throw new Error("403");
      },
    };
    const r = await sincronizar(cliente, almacen, { adjuntos: true });
    // La página se indexó igual; solo el adjunto quedó afuera.
    expect(r).toEqual({ escritas: 1, adjuntos: 0, borradas: 0 });
    expect(error.mock.calls.flat().join(" ")).toContain("adjunto_omitido");
    error.mockRestore();
  });
});

describe("rate limit y reintentos", () => {
  function respuesta(status: number, body: unknown = {}, retryAfter?: number): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "retry-after" && retryAfter ? String(retryAfter) : null,
      },
      json: async () => body,
    } as unknown as Response;
  }

  it("espacia los pedidos segun maxReqPorSegundo", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(respuesta(200, ESPACIOS))
      .mockResolvedValueOnce(respuesta(200, { results: [pagina("1", "P", "<p>t</p>")] }));
    const esperas: number[] = [];
    let reloj = 0;
    const cliente = crearClienteConfluence({
      cloudId: "cid", token: "t", espacios: ["SOP"], sitioUrl: "https://a",
      fetch: fetch as never,
      maxReqPorSegundo: 2, // uno cada 500ms
      dormir: async (ms) => { esperas.push(ms); reloj += ms; },
      ahora: () => reloj,
    });
    for await (const _ of cliente.paginas());
    // El segundo pedido sale inmediatamente después del primero, así que
    // tiene que haber esperado el intervalo completo.
    expect(esperas).toEqual([500]);
  });

  it("reintenta un 429 respetando Retry-After", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(respuesta(429, {}, 7))
      .mockResolvedValueOnce(respuesta(200, ESPACIOS))
      .mockResolvedValueOnce(respuesta(200, { results: [] }));
    const esperas: number[] = [];
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cliente = crearClienteConfluence({
      cloudId: "cid", token: "t", espacios: ["SOP"], sitioUrl: "https://a",
      fetch: fetch as never, dormir: async (ms) => void esperas.push(ms), ahora: () => 0,
    });
    for await (const _ of cliente.paginas());
    expect(esperas).toEqual([7000]);
    expect(aviso.mock.calls.flat().join(" ")).toContain("confluence_429");
    aviso.mockRestore();
  });

  it("sin Retry-After usa backoff exponencial y se rinde tras el tope", async () => {
    const fetch = vi.fn().mockResolvedValue(respuesta(429, {}));
    const esperas: number[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cliente = crearClienteConfluence({
      cloudId: "cid", token: "t", espacios: ["SOP"], sitioUrl: "https://a",
      fetch: fetch as never, dormir: async (ms) => void esperas.push(ms), ahora: () => 0,
    });
    await expect(async () => {
      for await (const _ of cliente.paginas());
    }).rejects.toThrow("429");
    expect(esperas).toEqual([1000, 2000, 4000]);
    expect(fetch).toHaveBeenCalledTimes(MAX_REINTENTOS_429 + 1);
    vi.restoreAllMocks();
  });

  it("una espera absurda del servidor se recorta", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(respuesta(429, {}, 99999))
      .mockResolvedValueOnce(respuesta(200, ESPACIOS))
      .mockResolvedValueOnce(respuesta(200, { results: [] }));
    const esperas: number[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cliente = crearClienteConfluence({
      cloudId: "cid", token: "t", espacios: ["SOP"], sitioUrl: "https://a",
      fetch: fetch as never, dormir: async (ms) => void esperas.push(ms), ahora: () => 0,
    });
    for await (const _ of cliente.paginas());
    expect(esperas).toEqual([MAX_ESPERA_MS]);
    vi.restoreAllMocks();
  });
});
