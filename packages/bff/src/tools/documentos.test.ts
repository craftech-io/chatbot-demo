import { describe, expect, it, vi } from "vitest";
import type { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import {
  crearConsultarDocumentos,
  NOTA_ERROR,
  NOTA_SIN_CONSULTA,
  NOTA_SIN_RESULTADOS,
  TOP_K_DEFAULT,
} from "./documentos";

const KB_ID = "kb-de-prueba";

// Pasaje crudo como lo devuelve Retrieve. `metadata` es el mapa PLANO que
// arma Bedrock: los atributos que declaró el cliente en el sidecar
// `<archivo>.metadata.json` MÁS los que inyecta el servicio.
function pasaje(texto: string, score: number, uri: string, metadata?: Record<string, unknown>) {
  return {
    content: { text: texto },
    score,
    location: { s3Location: { uri } },
    ...(metadata ? { metadata } : {}),
  };
}

// Cliente falso del data-plane de Bedrock: se inyecta por factory, no se mockea
// la librería (patrón de guardrail/entrada.test.ts).
function clienteFalso(retrievalResults: unknown[]) {
  const send = vi.fn(async (_cmd: RetrieveCommand) => ({ retrievalResults }));
  return { send, cliente: { send } as never };
}

function numberOfResults(send: ReturnType<typeof clienteFalso>["send"]) {
  return send.mock.calls[0]![0].input.retrievalConfiguration?.managedSearchConfiguration
    ?.numberOfResults;
}

describe("consultar_documentos", () => {
  it("aplana los pasajes del KB a {texto, score, fuente}", async () => {
    const { send, cliente } = clienteFalso([
      pasaje("Las devoluciones se aceptan hasta 30 días.", 0.82, "s3://docs/devoluciones.md"),
      pasaje("La garantía cubre 12 meses.", 0.61, "s3://docs/garantia.md"),
    ]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "  ¿cuántos días tengo para devolver?  " });

    expect(r).toEqual({
      resultados: [
        {
          texto: "Las devoluciones se aceptan hasta 30 días.",
          score: 0.82,
          fuente: "s3://docs/devoluciones.md",
        },
        { texto: "La garantía cubre 12 meses.", score: 0.61, fuente: "s3://docs/garantia.md" },
      ],
    });
    // La consulta va trimeada y contra el KB que inyectó la infra.
    const input = send.mock.calls[0]![0].input;
    expect(input.knowledgeBaseId).toBe(KB_ID);
    expect(input.retrievalQuery).toEqual({ text: "¿cuántos días tengo para devolver?" });
  });

  // La metadata del sidecar es la ÚNICA forma de citar por título (spec §11):
  // sin esto los `.metadata.json` de documentos son inertes y la regla
  // "citá con el título" del prompt del sistema no se puede cumplir.
  it("superficializa los atributos del cliente: `title` -> titulo, `url` -> url", async () => {
    const { cliente } = clienteFalso([
      pasaje("Tenés 30 días corridos.", 0.9, "s3://docs/politica-devoluciones.md", {
        title: "  Política de devoluciones  ",
        url: "https://ayuda.ciclosaurora.example/devoluciones",
      }),
    ]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "devoluciones" });

    expect(r.resultados[0]).toEqual({
      texto: "Tenés 30 días corridos.",
      score: 0.9,
      fuente: "s3://docs/politica-devoluciones.md",
      titulo: "Política de devoluciones",
      url: "https://ayuda.ciclosaurora.example/devoluciones",
    });
  });

  it("los demás atributos del cliente viajan en `metadata` (no se tiran)", async () => {
    const { cliente } = clienteFalso([
      pasaje("Cambio sin uso.", 0.7, "s3://docs/x.md", {
        title: "Devoluciones",
        vigencia: "2026-01-01",
        publico: true,
      }),
    ]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "devoluciones" });

    expect(r.resultados[0]!.metadata).toEqual({ vigencia: "2026-01-01", publico: true });
  });

  it("descarta la metadata que inyecta Bedrock (AMAZON_BEDROCK_*, x-amz-bedrock-*)", async () => {
    const { cliente } = clienteFalso([
      pasaje("Horario de 9 a 18.", 0.5, "s3://docs/horarios.md", {
        AMAZON_BEDROCK_TEXT: "Horario de 9 a 18.",
        AMAZON_BEDROCK_METADATA: '{"source":"s3://docs/horarios.md"}',
        "x-amz-bedrock-kb-chunk-id": "1%3A0%3Aabcd",
        "x-amz-bedrock-kb-data-source-id": "DS123",
        "x-amz-bedrock-kb-source-uri": "s3://docs/horarios.md",
        title: "Horarios de atención",
      }),
    ]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "horarios" });

    // Solo lo del cliente: ni una clave del servicio, ni un `metadata` vacío.
    expect(r.resultados[0]).toEqual({
      texto: "Horario de 9 a 18.",
      score: 0.5,
      fuente: "s3://docs/horarios.md",
      titulo: "Horarios de atención",
    });
  });

  it("un pasaje sin metadata no rompe ni agrega claves vacías", async () => {
    const { cliente } = clienteFalso([
      pasaje("Sin sidecar.", 0.4, "s3://docs/sin-sidecar.md"),
      pasaje("Sidecar vacío.", 0.3, "s3://docs/vacio.md", {}),
    ]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "cualquier cosa" });

    expect(r.resultados).toEqual([
      { texto: "Sin sidecar.", score: 0.4, fuente: "s3://docs/sin-sidecar.md" },
      { texto: "Sidecar vacío.", score: 0.3, fuente: "s3://docs/vacio.md" },
    ]);
  });

  it("sin resultados devuelve la nota humana (el agente ofrece derivar)", async () => {
    const { cliente } = clienteFalso([]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "cómo cancelo mi suscripción" });

    expect(r.resultados).toEqual([]);
    expect(r.nota).toBe(NOTA_SIN_RESULTADOS);
  });

  it("fail-open: un error del SDK vuelve como nota, no como excepción", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = {
      send: vi.fn(async () => {
        throw new Error("bedrock caído");
      }),
    } as never;
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente: roto });

    const r = await consultar({ consulta: "horarios de atención" });

    expect(r).toEqual({ resultados: [], nota: NOTA_ERROR });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("respeta el topK del input", async () => {
    const { send, cliente } = clienteFalso([]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    await consultar({ consulta: "garantía", topK: 2 });

    expect(numberOfResults(send)).toBe(2);
  });

  it("sin topK en el input usa el default del cliente, y sin ese el del proyecto", async () => {
    const conDefault = clienteFalso([]);
    await crearConsultarDocumentos({
      knowledgeBaseId: KB_ID,
      cliente: conDefault.cliente,
      topKDefault: 8,
    })({ consulta: "garantía" });
    expect(numberOfResults(conDefault.send)).toBe(8);

    const sinDefault = clienteFalso([]);
    await crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente: sinDefault.cliente })({
      consulta: "garantía",
    });
    expect(numberOfResults(sinDefault.send)).toBe(TOP_K_DEFAULT);
  });

  it("un topK absurdo (0, negativo, no numérico) cae al default", async () => {
    for (const topK of [0, -3, 1.7, "3" as unknown as number, NaN]) {
      const { send, cliente } = clienteFalso([]);
      await crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente, topKDefault: 5 })({
        consulta: "garantía",
        topK,
      });
      // 1.7 se trunca a 1 (es un topK válido); el resto cae al default.
      expect(numberOfResults(send)).toBe(topK === 1.7 ? 1 : 5);
    }
  });

  it("una consulta vacía no llama al KB", async () => {
    const { send, cliente } = clienteFalso([]);
    const consultar = crearConsultarDocumentos({ knowledgeBaseId: KB_ID, cliente });

    const r = await consultar({ consulta: "   " });

    expect(send).not.toHaveBeenCalled();
    expect(r).toEqual({ resultados: [], nota: NOTA_SIN_CONSULTA });
  });
});

describe("busqueda gestionada", () => {
  function configDelRetrieve(send: ReturnType<typeof clienteFalso>["send"]) {
    return send.mock.calls[0]![0].input.retrievalConfiguration;
  }

  it("usa managedSearchConfiguration y no vectorSearchConfiguration", async () => {
    // Una KB gestionada rechaza el segundo con un ValidationException.
    const { cliente, send } = clienteFalso([]);
    await crearConsultarDocumentos({ knowledgeBaseId: "kb", cliente })({ consulta: "x" });
    const cfg = configDelRetrieve(send);
    expect(cfg?.vectorSearchConfiguration).toBeUndefined();
    expect(cfg?.managedSearchConfiguration?.numberOfResults).toBe(TOP_K_DEFAULT);
  });

  it("el reranking gestionado viene prendido", async () => {
    const { cliente, send } = clienteFalso([]);
    await crearConsultarDocumentos({ knowledgeBaseId: "kb", cliente })({ consulta: "x" });
    expect(configDelRetrieve(send)?.managedSearchConfiguration?.rerankingModelType).toBe("MANAGED");
  });

  it("se puede apagar", async () => {
    const { cliente, send } = clienteFalso([]);
    await crearConsultarDocumentos({
      knowledgeBaseId: "kb", cliente, rerankingGestionado: false,
    })({ consulta: "x" });
    expect(configDelRetrieve(send)?.managedSearchConfiguration?.rerankingModelType).toBe("NONE");
  });
});
