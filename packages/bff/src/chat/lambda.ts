// Entrypoint de la Function URL en modo response streaming. Todo lo testeable
// vive en handler.ts; acá solo está el pegamento con Lambda y el SDK.
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { loadConfig } from "../config/index";
import { evaluarEntrada } from "../guardrail/entrada";
import { verificarYConsumirTope } from "../limites/topes";
import { registrarTurnoEnIndice, turnosDeSesion } from "../sesiones/indice";
import { handleChat, type InvokePayload } from "./handler";

const client = new BedrockAgentCoreClient({});
// Un solo cliente Dynamo por contenedor caliente, reusado entre requests
// (igual que el de AgentCore arriba): abrir uno por invocación es gasto sin
// beneficio, el cliente no guarda estado por request.
const ddb = new DynamoDBClient({});

// La config se resuelve una vez por contenedor caliente, no una vez por request.
let cfgCache: Awaited<ReturnType<typeof loadConfig>> | undefined;
async function cfg() {
  cfgCache ??= await loadConfig();
  return cfgCache;
}

async function invoke(p: InvokePayload): Promise<AsyncIterable<Uint8Array>> {
  const c = await cfg();
  const out = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: c.runtimeArn,
      runtimeSessionId: p.sessionId,
      payload: new TextEncoder().encode(JSON.stringify(p)),
      contentType: "application/json",
      accept: "text/event-stream",
    }),
  );
  // Fire-and-forget: el índice de hilos es metadata para listar conversaciones
  // (la standalone de 2e), no algo que el turno tenga que esperar. Si el sabor
  // no tiene la tabla linkeada, no hay dónde escribir.
  if (c.tablas) {
    registrarTurnoEnIndice(
      { ddb, tabla: c.tablas.sesiones },
      p.userId,
      p.sessionId,
      p.message,
    ).catch(console.error);
  }
  return out.response as AsyncIterable<Uint8Array>;
}

// Solo si el sabor tiene las tablas linkeadas (Task 6, fase 2b): sabores/mocks
// viejos sin `cfg.tablas` corren sin topes de uso (deps.limites queda undefined
// abajo). El default 50/40 vive en resource.ts, no acá.
async function limites(
  userId: string,
  sessionId: string,
): Promise<{ permitido: boolean; motivo?: "dia" | "sesion" }> {
  const c = await cfg();
  if (!c.tablas) return { permitido: true };
  const tablas = c.tablas;
  return verificarYConsumirTope(
    {
      ddb,
      tabla: tablas.limites,
      topeDiario: c.topes?.diario ?? 50,
      topeSesion: c.topes?.porSesion ?? 40,
      sesiones: {
        turnos: (u, s) => turnosDeSesion({ ddb, tabla: tablas.sesiones }, u, s),
      },
    },
    userId,
    sessionId,
    // `hoy` se calcula ACÁ, por request: si se calculara a nivel módulo, un
    // contenedor caliente que sobreviviera la medianoche seguiría contando
    // contra el período de ayer.
    new Date().toISOString().slice(0, 10),
  );
}

// @ts-expect-error — `awslambda` lo inyecta el runtime de Lambda, no hay tipos.
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // La Function URL es pública: un body malformado no puede tirar la Lambda.
  // Si no parsea, queda {} y handleChat responde 400 por falta de message.
  let body: { message?: string; sessionId?: string };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const c = await cfg();
  const r = await handleChat(
    { token: auth.replace(/^Bearer /, "") || undefined, message: body.message, sessionId: body.sessionId },
    {
      cfg: c,
      invoke,
      // Solo si el sabor tiene el Guardrail linkeado (fase 2b): sabores/mocks
      // viejos sin `cfg.guardrail` corren sin filtro de entrada.
      guard: c.guardrail ? (t) => evaluarEntrada(t, c.guardrail!) : undefined,
      limites: c.tablas ? limites : undefined,
    },
  );
  // HttpResponseStream.from envuelve el stream con metadata HTTP real (status,
  // headers): sin esto, la Function URL responde siempre 200 y sin
  // content-type, y el browser no dispara el modo streaming del fetch.
  // @ts-expect-error — mismo global inyectado por el runtime, sin tipos.
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: r.status,
    headers: { "content-type": "text/event-stream" },
  });
  try {
    for await (const frame of r.frames) stream.write(frame);
  } catch (e) {
    // Si el write falla (cliente desconectado) no hay a quién avisarle: solo log.
    // Los errores del agente ya llegan como frames desde handleChat.
    console.error("no se pudo escribir el stream al cliente", e);
  } finally {
    stream.end();
  }
});
