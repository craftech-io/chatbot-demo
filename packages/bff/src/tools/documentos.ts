/// <reference path="../../../../sst-env.d.ts" />
// Tool de TENANT `consultar_documentos` (spec §11): RAG sobre la Knowledge Base
// del cliente. La invoca el AgentCore Gateway como target Lambda (no hay
// Function URL): el `event` son los argumentos crudos que armó el modelo y lo
// que devolvemos —JSON-serializable— el Gateway lo envuelve como toolResult.
//
// Es `Retrieve`, NO `RetrieveAndGenerate`: recuperamos pasajes y la síntesis la
// hace el agente. Así el prompt controla la respuesta y puede CITAR la fuente
// (`fuente` = URI del documento en S3), que es el punto de todo esto: una
// respuesta sobre el negocio del cliente sin fuente no sirve.
//
// Sobre `Resource` en packages/bff: la regla del paquete (ver
// config/resource.ts) es que el código de producto no toque SST. Acá se cumple
// igual — toda la lógica vive en `crearConsultarDocumentos`, que recibe el KB y
// el cliente inyectados; el único punto que lee `Resource` es el `handler` del
// final, que es el borde de infra de esta Lambda (mismo rol que
// chat/lambda.ts).
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { Resource } from "sst";

// Default del template si el cliente no configuró `documentos.topK`. Más
// pasajes = más contexto pero también más ruido y más tokens por turno.
export const TOP_K_DEFAULT = 5;

// Las notas son texto HUMANO para el agente, no códigos de error: el modelo las
// lee y las convierte en su respuesta al usuario. La de "no encontré nada" es
// la que dispara el ofrecimiento de derivar a una persona (spec §11.1).
export const NOTA_SIN_CONSULTA = "Falta el parámetro 'consulta'.";
export const NOTA_SIN_RESULTADOS = "No encontré nada sobre eso en los documentos.";
export const NOTA_ERROR =
  "No pude consultar los documentos en este momento; el servicio no respondió.";

export type EntradaDocumentos = {
  /** Consulta en lenguaje natural que armó el modelo. */
  consulta?: string;
  /** Máximo de pasajes a traer. Ausente ⇒ el default del cliente. */
  topK?: number;
};

export type ResultadoDocumento = {
  texto?: string;
  score?: number;
  /** URI del documento en S3: es lo único citable de forma fiable (spec §11). */
  fuente?: string;
};

export type RespuestaDocumentos = { resultados: ResultadoDocumento[]; nota?: string };

type DepsDocumentos = {
  knowledgeBaseId: string;
  cliente: BedrockAgentRuntimeClient;
  /** Default por cliente (`documentos.topK`). Ausente o absurdo ⇒ TOP_K_DEFAULT. */
  topKDefault?: number;
};

// El topK llega de dos lados poco confiables: el modelo (que puede mandar
// cualquier cosa) y la config del cliente. Un valor no numérico, cero o
// negativo cae al default en vez de viajar al SDK y volver como
// ValidationException.
function saneaTopK(valor: unknown): number | undefined {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return undefined;
  const entero = Math.floor(valor);
  return entero > 0 ? entero : undefined;
}

/**
 * Fábrica de la tool: recibe el KB y el cliente ya resueltos, así la lógica se
 * testea sin SST ni AWS (mismo patrón que `crear_tools_usuario` del core).
 */
export function crearConsultarDocumentos(deps: DepsDocumentos) {
  const topKPorDefecto = saneaTopK(deps.topKDefault) ?? TOP_K_DEFAULT;

  return async function consultarDocumentos(
    entrada: EntradaDocumentos,
  ): Promise<RespuestaDocumentos> {
    const consulta = typeof entrada.consulta === "string" ? entrada.consulta.trim() : "";
    if (!consulta) return { resultados: [], nota: NOTA_SIN_CONSULTA };

    const topK = saneaTopK(entrada.topK) ?? topKPorDefecto;

    try {
      const salida = await deps.cliente.send(
        new RetrieveCommand({
          knowledgeBaseId: deps.knowledgeBaseId,
          retrievalQuery: { text: consulta },
          retrievalConfiguration: {
            vectorSearchConfiguration: { numberOfResults: topK },
          },
        }),
      );

      // Se aplana a lo mínimo útil para el modelo: el texto del chunk, su score
      // y la URI de origen. La metadata que inyecta Bedrock
      // (AMAZON_BEDROCK_*, ids de chunk y de data source) no es legible y solo
      // gastaría tokens.
      const resultados = (salida.retrievalResults ?? []).map((r) => ({
        texto: r.content?.text,
        score: r.score,
        fuente: r.location?.s3Location?.uri,
      }));

      if (resultados.length === 0) {
        return { resultados: [], nota: NOTA_SIN_RESULTADOS };
      }
      return { resultados };
    } catch (e) {
      // Fail-open conversacional (misma postura que el core y el guardrail de
      // entrada): un error del SDK vuelve como nota humana, JAMÁS como
      // excepción — una tool que revienta le corta el turno al agente.
      console.error("el Retrieve sobre la Knowledge Base falló (fail-open)", e);
      return { resultados: [], nota: NOTA_ERROR };
    }
  };
}

// ── Borde de infra: de acá para abajo, el pegamento con Lambda y SST ────────

// Un solo cliente por contenedor caliente: no guarda estado por invocación.
const clienteDefault = new BedrockAgentRuntimeClient({});

let consultar: ReturnType<typeof crearConsultarDocumentos> | undefined;

// Esta Lambda implementa UNA sola tool, así que no hay nada que rutear: el
// nombre que manda el Gateway (`${target}___${tool}` en
// `clientContext.custom.bedrockAgentCoreToolName`) no se lee.
export const handler = async (event: EntradaDocumentos): Promise<RespuestaDocumentos> => {
  consultar ??= crearConsultarDocumentos({
    knowledgeBaseId: Resource.KnowledgeBase.id,
    cliente: clienteDefault,
    // La infra la setea desde `documentos.topK` de client.config.ts. Ausente o
    // vacía ⇒ NaN ⇒ el default del template.
    topKDefault: Number(process.env.DOCUMENTOS_TOP_K),
  });
  return consultar(event ?? {});
};
