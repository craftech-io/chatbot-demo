// Ingestor de Confluence: lee las páginas de una allowlist de espacios y las
// deja en el bucket de la Knowledge Base como texto + sidecar de metadata.
//
// Por qué un ingestor propio y no el conector nativo de Bedrock: ese conector
// está en preview y exige OpenSearch Serverless (~US$350/mes contra ~US$0,015 de
// S3 Vectors). Escribiendo a S3 el vector store no cambia.
//
// Con OAuth la API de Confluence NO va en el dominio del sitio: va por
// api.atlassian.com/ex/confluence/<cloudId>. Scopes: read:space:confluence y
// read:page:confluence.
//
// Es un refresh COMPLETO e idempotente, no un sync incremental: con un corpus
// del orden de cientos de páginas cuesta menos que mantener un cursor, y no
// puede desincronizarse. Si el corpus crece a miles, acá entra el incremental.

const base = (cloudId: string) => `https://api.atlassian.com/ex/confluence/${cloudId}`;
export const LIMITE_PAGINA = 100;

// Extensiones que la Knowledge Base parsea. Subir otra cosa gasta espacio y no
// aporta un solo pasaje recuperable.
export const EXTENSIONES_SOPORTADAS = [
  "pdf", "doc", "docx", "txt", "md", "csv", "xls", "xlsx", "html",
];
// Bedrock corta en 50 MB por archivo; 25 deja margen y evita que un video
// subido a una página se lleve la corrida entera.
export const MAX_ADJUNTO_BYTES = 25 * 1024 * 1024;

export type PaginaConfluence = {
  id: string;
  titulo: string;
  espacio: string;
  texto: string;
  url: string;
};

export const MAX_REINTENTOS_429 = 3;
// Techo por si el header viene con un valor absurdo: preferimos fallar la
// corrida a que la Lambda se quede dormida hasta el timeout.
export const MAX_ESPERA_MS = 60_000;

export type DepsConfluence = {
  cloudId: string;
  /** Access token de la service account (OAuth client_credentials). */
  token: string;
  /** Keys de los espacios permitidos. Vacío ⇒ no se ingesta nada. */
  espacios: string[];
  /** URL público del sitio, para armar el link de cada página. */
  sitioUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Tope de pedidos por segundo contra la API. 0 o ausente ⇒ sin límite. */
  maxReqPorSegundo?: number;
  /** Inyectables para testear sin esperas reales. */
  dormir?: (ms: number) => Promise<void>;
  ahora?: () => number;
};

/** El storage format es XHTML con macros; para el RAG solo interesa el texto. */
export function aTexto(storage: string): string {
  return (
    storage
      // Las macros no son contenido del documento y su cuerpo suele ser
      // configuración (paneles, tablas de contenido, includes).
      .replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/g, " ")
      .replace(/<ac:[a-z-]+[^>]*\/>/g, " ")
      .replace(/<ac:([a-z-]+)[^>]*>[\s\S]*?<\/ac:\1>/g, " ")
      .replace(/<ri:[^>]*\/?>/g, " ")
      // Estructura que sí cambia cómo se lee un pasaje recuperado.
      .replace(/<h([1-6])[^>]*>/g, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
      .replace(/<\/h[1-6]>/g, "\n\n")
      .replace(/<li[^>]*>/g, "\n- ")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<\/(p|div|tr|table|ul|ol)>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** El sidecar que Bedrock lee junto al documento (ver documentos/). */
export function sidecarDe(pagina: {
  titulo: string;
  espacio: string;
  url: string;
}): string {
  return JSON.stringify(
    {
      metadataAttributes: {
        title: {
          value: { type: "STRING", stringValue: pagina.titulo },
          includeForEmbedding: true,
        },
        url: {
          value: { type: "STRING", stringValue: pagina.url },
          includeForEmbedding: false,
        },
        espacio: {
          value: { type: "STRING", stringValue: pagina.espacio },
          includeForEmbedding: false,
        },
      },
    },
    null,
    2,
  );
}

/** Clave en el bucket. El id de la página la hace estable ante un rename. */
export function claveDe(pagina: PaginaConfluence): string {
  return `confluence/${pagina.espacio}/${pagina.id}.md`;
}

export function crearClienteConfluence(deps: DepsConfluence) {
  const hacerFetch = deps.fetch ?? globalThis.fetch;
  const cabeceras = {
    authorization: `Bearer ${deps.token}`,
    accept: "application/json",
  };

  const dormir = deps.dormir ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const ahora = deps.ahora ?? Date.now;
  const intervaloMs = deps.maxReqPorSegundo ? 1000 / deps.maxReqPorSegundo : 0;
  // -Infinity y no 0: el primer pedido no tiene de qué espaciarse y no debe
  // pagar el intervalo. Con un rate bajo esa espera de más es de segundos.
  let ultimoPedido = Number.NEGATIVE_INFINITY;

  /** Espacia los pedidos para no pasar el tope, y reintenta los 429. */
  async function pedir(url: string): Promise<Response> {
    for (let intento = 0; ; intento++) {
      if (intervaloMs > 0) {
        const falta = intervaloMs - (ahora() - ultimoPedido);
        if (falta > 0) await dormir(falta);
      }
      ultimoPedido = ahora();
      const r = await hacerFetch(url, { headers: cabeceras });
      if (r.status !== 429 || intento >= MAX_REINTENTOS_429) return r;
      // Confluence dice cuánto esperar; si no lo dice, backoff exponencial.
      const cabecera = Number(r.headers?.get?.("retry-after"));
      const espera = Number.isFinite(cabecera) && cabecera > 0
        ? Math.min(cabecera * 1000, MAX_ESPERA_MS)
        : Math.min(1000 * 2 ** intento, MAX_ESPERA_MS);
      console.warn(
        JSON.stringify({ evento: "confluence_429", intento: intento + 1, esperaMs: espera }),
      );
      await dormir(espera);
    }
  }

  async function traer<T>(ruta: string): Promise<T> {
    const url = ruta.startsWith("http") ? ruta : `${base(deps.cloudId)}${ruta}`;
    const r = await pedir(url);
    if (!r.ok) throw new Error(`Confluence respondió ${r.status} en ${ruta.split("?")[0]}`);
    return (await r.json()) as T;
  }

  /** Keys de espacio a ids: el filtro de /pages es por id, no por key. */
  async function idsDeEspacios(): Promise<Map<string, string>> {
    const porId = new Map<string, string>();
    if (deps.espacios.length === 0) return porId;
    const query = new URLSearchParams({ keys: deps.espacios.join(","), limit: "250" });
    const r = await traer<{ results: { id: string; key: string }[] }>(
      `/wiki/api/v2/spaces?${query}`,
    );
    for (const e of r.results) porId.set(String(e.id), e.key);
    return porId;
  }

  async function* paginas(): AsyncGenerator<PaginaConfluence> {
    const espaciosPorId = await idsDeEspacios();
    if (espaciosPorId.size === 0) return;
    const query = new URLSearchParams({
      "body-format": "storage",
      limit: String(LIMITE_PAGINA),
      status: "current",
    });
    for (const id of espaciosPorId.keys()) query.append("space-id", id);

    let ruta: string | undefined = `/wiki/api/v2/pages?${query}`;
    while (ruta) {
      const r: {
        results: {
          id: string;
          title: string;
          spaceId: string;
          body?: { storage?: { value?: string } };
          _links?: { webui?: string };
        }[];
        _links?: { next?: string };
      } = await traer(ruta);

      for (const p of r.results) {
        const texto = aTexto(p.body?.storage?.value ?? "");
        // Una página vacía solo mete ruido en el índice.
        if (!texto) continue;
        yield {
          id: String(p.id),
          titulo: p.title,
          espacio: espaciosPorId.get(String(p.spaceId)) ?? String(p.spaceId),
          texto,
          url: p._links?.webui ? `${deps.sitioUrl.replace(/\/+$/, "")}/wiki${p._links.webui}` : "",
        };
      }
      // `next` viene relativo al host de la API, no al de la ruta que pedimos.
      ruta = r._links?.next ? `${base(deps.cloudId)}${r._links.next}` : undefined;
    }
  }

  /** Adjuntos ingestables de una página. */
  async function adjuntos(
    paginaId: string,
    espacio: string,
  ): Promise<AdjuntoConfluence[]> {
    const r = await traer<{
      results: {
        id: string;
        title: string;
        fileSize?: number;
        downloadLink?: string;
        _links?: { download?: string };
      }[];
    }>(`/wiki/api/v2/pages/${paginaId}/attachments?limit=250`);

    return r.results
      .filter((a) => adjuntoIngestable(a.title, a.fileSize ?? 0))
      .map((a) => {
        const enlace = a.downloadLink ?? a._links?.download ?? "";
        return {
          id: String(a.id),
          titulo: a.title,
          espacio,
          paginaId: String(paginaId),
          url: `${deps.sitioUrl.replace(/\/+$/, "")}/wiki/pages/viewpageattachments.action?pageId=${paginaId}`,
          // NO VERIFICADO contra un sitio real: la documentación no dice si el
          // downloadLink viene absoluto o relativo, así que se soportan las dos
          // formas. Si los adjuntos no aparecen, este es el primer lugar a mirar.
          descargarDesde: enlace.startsWith("http") ? enlace : `${base(deps.cloudId)}${enlace}`,
          bytes: a.fileSize ?? 0,
        };
      });
  }

  /** Binario del adjunto. Usa el mismo Bearer que el resto de la API. */
  async function descargar(adjunto: AdjuntoConfluence): Promise<Uint8Array> {
    const r = await pedir(adjunto.descargarDesde);
    if (!r.ok) throw new Error(`Confluence respondió ${r.status} al descargar un adjunto`);
    return new Uint8Array(await r.arrayBuffer());
  }

  return { paginas, idsDeEspacios, adjuntos, descargar };
}

export type AdjuntoConfluence = {
  id: string;
  titulo: string;
  espacio: string;
  paginaId: string;
  url: string;
  descargarDesde: string;
  bytes: number;
};

export function extensionDe(titulo: string): string {
  const partes = titulo.toLowerCase().split(".");
  return partes.length > 1 ? partes[partes.length - 1]! : "";
}

export function adjuntoIngestable(titulo: string, bytes: number): boolean {
  return EXTENSIONES_SOPORTADAS.includes(extensionDe(titulo)) && bytes <= MAX_ADJUNTO_BYTES;
}

export type Almacen = {
  /** Claves existentes bajo el prefijo `confluence/`. */
  listar: (prefijo: string) => Promise<string[]>;
  escribir: (clave: string, cuerpo: string | Uint8Array) => Promise<void>;
  borrar: (claves: string[]) => Promise<void>;
};

/**
 * Deja el bucket igual al corpus de Confluence: escribe cada página con su
 * sidecar y borra lo que ya no existe del otro lado.
 */
export async function sincronizar(
  cliente: Pick<ReturnType<typeof crearClienteConfluence>, "paginas" | "adjuntos" | "descargar">,
  almacen: Almacen,
  opciones: { adjuntos?: boolean } = {},
): Promise<{ escritas: number; adjuntos: number; borradas: number }> {
  const vigentes = new Set<string>();
  let escritas = 0;
  let adjuntosEscritos = 0;

  for await (const pagina of cliente.paginas()) {
    const clave = claveDe(pagina);
    await almacen.escribir(clave, `# ${pagina.titulo}\n\n${pagina.texto}\n`);
    await almacen.escribir(`${clave}.metadata.json`, sidecarDe(pagina));
    vigentes.add(clave);
    vigentes.add(`${clave}.metadata.json`);
    escritas++;

    if (!opciones.adjuntos) continue;
    for (const adjunto of await cliente.adjuntos(pagina.id, pagina.espacio)) {
      const claveAdjunto = `confluence/${adjunto.espacio}/adjuntos/${adjunto.id}-${adjunto.titulo}`;
      // Un adjunto que falla no puede abortar la corrida entera: se saltea y la
      // página ya quedó indexada.
      try {
        await almacen.escribir(claveAdjunto, await cliente.descargar(adjunto));
        await almacen.escribir(
          `${claveAdjunto}.metadata.json`,
          sidecarDe(adjunto),
        );
        vigentes.add(claveAdjunto);
        vigentes.add(`${claveAdjunto}.metadata.json`);
        adjuntosEscritos++;
      } catch (e) {
        console.error(
          JSON.stringify({
            evento: "adjunto_omitido",
            pagina: pagina.id,
            adjunto: adjunto.id,
            motivo: e instanceof Error ? e.name : "desconocido",
          }),
        );
      }
    }
  }

  // Un borrado en Confluence tiene que borrar del índice: si no, el agente sigue
  // respondiendo con una política derogada.
  const existentes = await almacen.listar("confluence/");
  const sobrantes = existentes.filter((c) => !vigentes.has(c));
  if (sobrantes.length > 0) await almacen.borrar(sobrantes);

  return { escritas, adjuntos: adjuntosEscritos, borradas: sobrantes.length };
}
