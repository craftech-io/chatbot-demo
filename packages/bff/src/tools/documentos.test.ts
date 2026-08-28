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

// Pasaje crudo como lo devuelve Retrieve: solo los campos que la tool aplana.
function pasaje(texto: string, score: number, uri: string) {
  return { content: { text: texto }, score, location: { s3Location: { uri } } };
}

// Cliente falso del data-plane de Bedrock: se inyecta por factory, no se mockea
// la librería (patrón de guardrail/entrada.test.ts).
function clienteFalso(retrievalResults: unknown[]) {
  const send = vi.fn(async (_cmd: RetrieveCommand) => ({ retrievalResults }));
  return { send, cliente: { send } as never };
}

function numberOfResults(send: ReturnType<typeof clienteFalso>["send"]) {
  return send.mock.calls[0]![0].input.retrievalConfiguration?.vectorSearchConfiguration
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

  it("sin topK en el input usa el default del cliente, y sin ese el del template", async () => {
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
