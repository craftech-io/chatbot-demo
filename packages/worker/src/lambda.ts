/// <reference path="../../../sst-env.d.ts" />
// Entrypoint SQS del worker: consume el batch (size 1, ver
// infra/sst/worker.ts) y corre turno.ts por cada registro. Todo lo testeable
// vive en turno.ts; acá solo está el pegamento con Lambda y los SDKs (Dynamo,
// AgentCore).
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Resource } from "sst";
import {
  escribirMensaje,
  listarMensajes,
  pendientesDesdeUltimaRespuesta,
  ultimoMsgIdUsuario,
} from "../../bff/src/mensajes/store";
import { procesarMensaje, type Deps, type EventoTurno } from "./turno";

// Un solo cliente por SDK y por contenedor caliente, reusado entre
// invocaciones: mismo patrón que packages/bff/src/chat/lambda.ts.
const client = new BedrockAgentCoreClient({});
const ddb = new DynamoDBClient({});

// MessagesTable y el Runtime están linkeados siempre en el sabor SST
// (infra/sst/worker.ts): a diferencia del BFF, el worker no soporta sabores sin
// mensajería, así que lee los recursos sin guardas.
const tabla = Resource.MessagesTable.name;

// El payload completo (actToken incluido, si vino en el evento) se serializa al
// body del invoke: es el único destino del token además de la cola. NUNCA se
// loguea (el console.log de handler solo emite ids).
async function invocar(payload: {
  message: string;
  userId: string;
  sessionId: string;
  actToken?: string;
}): Promise<AsyncIterable<Uint8Array>> {
  const out = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: Resource.AgentRuntime.arn,
      runtimeSessionId: payload.sessionId,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
      contentType: "application/json",
      accept: "text/event-stream",
    }),
  );
  return out.response as AsyncIterable<Uint8Array>;
}

const deps: Deps = {
  store: {
    ultimoMsgIdUsuario: (conversationId) => ultimoMsgIdUsuario({ ddb, tabla }, conversationId),
    pendientesDesdeUltimaRespuesta: (conversationId) =>
      pendientesDesdeUltimaRespuesta({ ddb, tabla }, conversationId),
    listar: (conversationId) => listarMensajes({ ddb, tabla }, conversationId),
  },
  invocar,
  escribir: (m) => escribirMensaje({ ddb, tabla }, m),
};

// Forma mínima del evento SQS que este handler lee. No hay @types/aws-lambda
// en el repo (mismo motivo que FunctionUrlEvent en packages/bff/src/chat/lambda.ts).
type SqsRecord = { body: string; messageId?: string };
type SqsEvent = { Records?: SqsRecord[] };

// El handler JAMÁS lanza: un throw acá le indica a SQS que reintente la
// entrega del batch, y en una cola FIFO eso bloquea el grupo (la conversación
// entera) hasta agotar los reintentos y mandar todo a la DLQ. `batch: {size:
// 1}` (infra/sst/worker.ts) hace que Records tenga a lo sumo un elemento en la
// práctica, pero el for secuencial es correcto igual si algún día cambia.
export async function handler(event: SqsEvent): Promise<void> {
  for (const record of event.Records ?? []) {
    try {
      const evento = JSON.parse(record.body) as EventoTurno;
      const resultado = await procesarMensaje(evento, deps);
      console.log("turno del worker", {
        resultado,
        conversationId: evento.conversationId,
        msgId: evento.msgId,
      });
    } catch (e) {
      // procesarMensaje ya jamás lanza (ver turno.ts) — esto solo atrapa un
      // body malformado (JSON.parse) u otro fallo imprevisto antes de
      // llegar ahí. Igual no debe reventar el batch: se loguea y se sigue.
      //
      // Se loguea SOLO el nombre del error, nunca el objeto: el SyntaxError de
      // JSON.parse incluye un fragmento del texto que no pudo parsear, y el
      // body de la cola lleva el actToken del usuario — volcar ese fragmento a
      // CloudWatch sería filtrar una credencial.
      console.error("registro del batch SQS no se pudo procesar (se descarta, no se relanza)", {
        error: (e as Error)?.name ?? "desconocido",
      });
    }
  }
}
