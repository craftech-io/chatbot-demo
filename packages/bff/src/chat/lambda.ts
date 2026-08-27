// Entrypoint de la Function URL en modo clásico (JSON): router de /mensajes.
// El flujo de mensajes es asíncrono, así que el handler no mantiene la conexión
// HTTP abierta mientras el agente responde: el worker procesa el turno en
// background y el widget pollea con GET.
// Todo lo testeable vive en mensajes/api.ts; acá solo está el pegamento con
// Lambda y los SDKs (Dynamo, SQS, Bedrock Guardrail).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../config/index";
import { evaluarEntrada } from "../guardrail/entrada";
import { verificarYConsumirTope } from "../limites/topes";
import { getMensajes, postMensaje } from "../mensajes/api";
import { escribirMensaje, listarMensajes, type Mensaje } from "../mensajes/store";
import { registrarTurnoEnIndice, turnosDeSesion } from "../sesiones/indice";

// Un solo cliente por SDK y por contenedor caliente, reusado entre requests:
// abrir uno por invocación es gasto sin beneficio, ninguno guarda estado por
// request.
const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

// La config se resuelve una vez por contenedor caliente, no una vez por
// request.
let cfgCache: Awaited<ReturnType<typeof loadConfig>> | undefined;
async function cfg() {
  cfgCache ??= await loadConfig();
  return cfgCache;
}

// Solo si el sabor tiene las tablas de topes linkeadas: un sabor sin
// `cfg.tablas` corre sin tope de uso (deps.limites queda undefined en el
// router, más abajo).
async function limites(
  userId: string,
  conversationId: string,
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
    conversationId,
    // `hoy` se calcula ACÁ, por request: si se calculara a nivel módulo, un
    // contenedor caliente que sobreviviera la medianoche seguiría contando
    // contra el período de ayer.
    new Date().toISOString().slice(0, 10),
  );
}

// Fire-and-forget en el POST exitoso: el contador de turnos de sesión cuenta
// mensajes ACEPTADOS, no turnos de agente — coherente con el tope, que también
// cuenta mensajes.
async function registrarTurno(userId: string, conversationId: string, texto: string): Promise<number> {
  const c = await cfg();
  if (!c.tablas) return 0;
  return registrarTurnoEnIndice({ ddb, tabla: c.tablas.sesiones }, userId, conversationId, texto);
}

// Atado a MessagesTable vía config: siempre linkeada en el sabor SST, ver
// config/resource.ts.
const store = {
  async escribir(m: Omit<Mensaje, "orden">): Promise<Mensaje> {
    const c = await cfg();
    if (!c.mensajes) throw new Error("mensajería no configurada: falta cfg.mensajes");
    return escribirMensaje({ ddb, tabla: c.mensajes.tabla }, m);
  },
  async listar(conversationId: string, desde?: string): Promise<Mensaje[]> {
    const c = await cfg();
    if (!c.mensajes) return [];
    return listarMensajes({ ddb, tabla: c.mensajes.tabla }, conversationId, desde);
  },
};

// Publica el turno en la cola FIFO. MessageGroupId serializa los turnos de una
// misma conversación; MessageDeduplicationId evita duplicar el turno si SQS
// reentrega el mensaje (at-least-once).
// El `actToken` va en el body del mensaje (cifrado en reposo en SQS) y de ahí al
// payload del invoke — NUNCA se loguea ni se escribe en Dynamo.
async function encolar(payload: {
  conversationId: string;
  msgId: string;
  userId: string;
  actToken?: string;
}): Promise<void> {
  const c = await cfg();
  if (!c.mensajes) throw new Error("mensajería no configurada: falta cfg.mensajes");
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: c.mensajes.colaUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: payload.conversationId,
      MessageDeduplicationId: payload.msgId,
    }),
  );
}

// Forma mínima del evento de una Function URL clásica (payload format 2.0):
// solo los campos que este router lee. No hay @types/aws-lambda en el repo.
type FunctionUrlEvent = {
  rawPath?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string;
};

type JsonResponse = { statusCode: number; headers: { "content-type": string }; body: string };

function json(status: number, body: unknown): JsonResponse {
  return { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function token(event: FunctionUrlEvent): string | undefined {
  const h = event.headers ?? {};
  const raw = h.authorization ?? h.Authorization ?? "";
  return raw.replace(/^Bearer /, "") || undefined;
}

// La Function URL va en modo buffered, no response streaming: el handler
// devuelve la respuesta completa {statusCode, headers, body}, no un stream.
export async function handler(event: FunctionUrlEvent): Promise<JsonResponse> {
  const path = event.rawPath ?? "";
  const method = event.requestContext?.http?.method ?? "GET";
  if (path !== "/mensajes") return json(404, { error: { code: "not_found" } });

  const c = await cfg();

  if (method === "POST") {
    // La Function URL es pública: un body malformado no puede tirar la
    // Lambda. Si no parsea, queda {} y postMensaje responde 400 por falta de
    // texto.
    let body: { texto?: string; hilo?: string };
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }
    const r = await postMensaje(
      { token: token(event), texto: body.texto, hilo: body.hilo },
      {
        cfg: c,
        store,
        encolar,
        // Solo si el sabor tiene el Guardrail linkeado: un sabor sin
        // `cfg.guardrail` corre sin filtro de entrada.
        guard: c.guardrail ? (t) => evaluarEntrada(t, c.guardrail!) : undefined,
        limites: c.tablas ? limites : undefined,
        registrarTurno: c.tablas ? registrarTurno : undefined,
      },
    );
    return json(r.status, r.body);
  }

  if (method === "GET") {
    const qs = event.queryStringParameters ?? {};
    const r = await getMensajes({ token: token(event), hilo: qs?.hilo, desde: qs?.desde }, { cfg: c, store });
    return json(r.status, r.body);
  }

  return json(404, { error: { code: "not_found" } });
}
