/// <reference path="../../../../sst-env.d.ts" />
// Tool de TENANT `consultar_documentos` (spec §11): RAG sobre la Knowledge Base
// del cliente. La invoca el AgentCore Gateway como target Lambda (no hay
// Function URL): el `event` son los argumentos crudos que armó el modelo y lo
// que devolvemos —JSON-serializable— el Gateway lo envuelve como toolResult.
//
// Es `Retrieve`, NO `RetrieveAndGenerate`: recuperamos pasajes y la síntesis la
// hace el agente. Así el prompt controla la respuesta y puede CITAR la fuente,
// que es el punto de todo esto: una respuesta sobre el negocio del cliente sin
// fuente no sirve. Citable hay dos cosas y son distintas:
//   - `fuente`: la URI del documento en S3, que existe siempre;
//   - `titulo`/`url`: los atributos que el CLIENTE declara en el sidecar
//     `<archivo>.metadata.json` (ver documentos/). Son lo legible, y
//     por eso se superficializan: sin ellos, "citá con el título" (regla 3 del
//     `promptSistema`) solo se puede cumplir pegando la URI de un bucket
//     interno.
//
// Sobre `Resource` en packages/bff: la regla del paquete (ver
// config/resource.ts) es que el código de producto no toque SST. Acá se cumple
// igual — toda la lógica vive en `crearConsultarDocumentos`, que recibe el KB y
// el cliente inyectados; el único punto que lee `Resource` es el `handler` del
// final, el borde de infra de esta Lambda. No pasa por `config/resource.ts`
// porque ese módulo arma el `BffConfig` del backend de mensajes, que es OTRA
// Function con otro linkeo (ver la excepción sancionada en ese archivo).
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { Resource } from "sst";

// Default si no se configuró `documentos.topK`. Más
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
  /** URI del documento en S3. Existe siempre; legible, no tanto. */
  fuente?: string;
  /** `title` del sidecar del documento: con esto se cita por título. */
  titulo?: string;
  /** `url` del sidecar: link público al documento, si el cliente lo declaró. */
  url?: string;
  /** El resto de los atributos que el cliente declaró en el sidecar. */
  metadata?: Record<string, unknown>;
};

export type RespuestaDocumentos = { resultados: ResultadoDocumento[]; nota?: string };

type DepsDocumentos = {
  knowledgeBaseId: string;
  /**
   * Reranking gestionado: la KB reordena los pasajes por relevancia con un
   * reranker que opera AWS. `false` devuelve el orden crudo de la búsqueda.
   */
  rerankingGestionado?: boolean;
  cliente: BedrockAgentRuntimeClient;
  /** Default por cliente (`documentos.topK`). Ausente o absurdo ⇒ TOP_K_DEFAULT. */
  topKDefault?: number;
};

// La metadata de un pasaje llega MEZCLADA: los atributos que declaró el cliente
// en el sidecar `<archivo>.metadata.json` conviven con los que INYECTA Bedrock
// (`AMAZON_BEDROCK_TEXT`/`_METADATA` y los `x-amz-bedrock-kb-*`: ids de chunk y
// de data source, la URI de origen). Los del servicio no son legibles para nadie
// y solo gastarían tokens del turno; los del cliente son justamente el dato que
// hace citable la respuesta. Se filtra por PREFIJO y no por lista de claves:
// Bedrock agrega claves nuevas sin avisar, y una clave del cliente jamás
// arranca así.
const PREFIJOS_METADATA_BEDROCK = ["AMAZON_BEDROCK_", "x-amz-bedrock-"];

/**
 * Parte la metadata cruda del pasaje en lo que el modelo puede usar: `title` y
 * `url` salen con nombre propio (son los que el prompt del sistema pide citar) y
 * cualquier otro atributo del cliente viaja tal cual en `metadata`.
 */
function atributosDelCliente(
  cruda: Record<string, unknown> | undefined,
): Pick<ResultadoDocumento, "titulo" | "url" | "metadata"> {
  const conNombre: { titulo?: string; url?: string } = {};
  const resto: Record<string, unknown> = {};

  for (const [clave, valor] of Object.entries(cruda ?? {})) {
    if (PREFIJOS_METADATA_BEDROCK.some((prefijo) => clave.startsWith(prefijo))) continue;
    // Solo un string no vacío puede citarse: un `title` numérico o nulo no se
    // pierde, cae en `metadata` como cualquier otro atributo.
    const alias = clave === "title" ? "titulo" : clave === "url" ? "url" : undefined;
    const limpio = typeof valor === "string" ? valor.trim() : "";
    if (alias && limpio) conNombre[alias] = limpio;
    else resto[clave] = valor;
  }

  return {
    ...conNombre,
    ...(Object.keys(resto).length > 0 ? { metadata: resto } : {}),
  };
}

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
            // Una Knowledge Base GESTIONADA rechaza `vectorSearchConfiguration`
            // ("not supported for managed knowledge bases"): la búsqueda se
            // configura acá, y la estrategia la decide el servicio.
            managedSearchConfiguration: {
              numberOfResults: topK,
              rerankingModelType: deps.rerankingGestionado === false ? "NONE" : "MANAGED",
            },
          },
        }),
      );

      // Se aplana a lo útil para el modelo: el texto del chunk, su score, la
      // URI de origen y los atributos que el cliente declaró en el sidecar
      // (ver `atributosDelCliente`, que es lo que descarta la metadata del
      // servicio).
      const resultados = (salida.retrievalResults ?? []).map((r) => ({
        texto: r.content?.text,
        score: r.score,
        fuente: r.location?.s3Location?.uri,
        ...atributosDelCliente(r.metadata),
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
    // `KNOWLEDGE_BASE_ID` primero y el linkable después: la env es lo que declara
    // infra/CONTRACT.md (el contrato es multi-IaC y un sabor sin SST inyecta la
    // env), y el linkable es cómo la resuelve el sabor SST. Con `??`, si la env
    // está seteada no se toca `Resource` — que en un sabor sin SST lanzaría.
    knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID ?? Resource.KnowledgeBase.id,
    cliente: clienteDefault,
    // La infra la setea desde `documentos.topK` de client.config.ts. Ausente o
    // vacía ⇒ NaN ⇒ el default del proyecto.
    topKDefault: Number(process.env.DOCUMENTOS_TOP_K),
    rerankingGestionado: process.env.RERANK_MODO !== "NONE",
  });
  return consultar(event ?? {});
};
