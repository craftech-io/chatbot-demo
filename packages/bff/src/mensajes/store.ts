// Store de MessagesTable: fuente de verdad de la transcripción
// para las UIs y los canales (WhatsApp, Facebook, widget) — independiente de
// el historial que ve el modelo (lo arma el worker desde acá). pk `conversationId`, sk
// `orden` (`${ts}#${msgId}`): el orden lexicográfico ES el cronológico, porque
// `ts` es ISO-8601 (orden de string == orden de fecha) y `msgId` desempata
// mensajes con el mismo `ts`.
import {
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

type Deps = { ddb: DynamoDBClient; tabla: string };

export type Mensaje = {
  conversationId: string;
  orden: string;
  msgId: string;
  rol: "user" | "assistant";
  texto: string;
  ts: string;
};

function fromItem(item: Record<string, AttributeValue>): Mensaje {
  return {
    conversationId: item.conversationId!.S!,
    orden: item.orden!.S!,
    msgId: item.msgId!.S!,
    rol: item.rol!.S as Mensaje["rol"],
    texto: item.texto!.S!,
    ts: item.ts!.S!,
  };
}

// Días que vive un mensaje. Lo inyecta el caller desde client.config.ts; el
// default es una red por si la env no llegó, no la política.
export const RETENCION_DIAS_DEFAULT = 30;

export async function escribirMensaje(deps: Deps, m: Omit<Mensaje, "orden">): Promise<Mensaje> {
  const mensaje: Mensaje = { ...m, orden: `${m.ts}#${m.msgId}` };
  // DynamoDB borra el ítem cuando el TTL pasa: epoch en SEGUNDOS, no en ms
  // (con ms el vencimiento cae en el año 57000 y el ítem no se borra nunca).
  const dias = Number(process.env.RETENCION_HISTORIAL_DIAS) || RETENCION_DIAS_DEFAULT;
  const expiraEn = Math.floor(Date.now() / 1000) + dias * 24 * 60 * 60;
  try {
    await deps.ddb.send(
      new PutItemCommand({
        TableName: deps.tabla,
        Item: {
          conversationId: { S: mensaje.conversationId },
          orden: { S: mensaje.orden },
          msgId: { S: mensaje.msgId },
          rol: { S: mensaje.rol },
          texto: { S: mensaje.texto },
          ts: { S: mensaje.ts },
          expiraEn: { N: String(expiraEn) },
        },
      }),
    );
    return mensaje;
  } catch (e) {
    // A diferencia del resto del store, ACÁ NO HAY FAIL-OPEN: perder un
    // mensaje del usuario (o la respuesta del asistente) es grave y silencioso
    // si lo tragamos. Logueamos para observabilidad y relanzamos: el caller
    // (el handler HTTP o el worker) decide cómo reaccionar — reintentar,
    // devolver 500, no encolar.
    console.error("escritura de mensaje falló", e);
    throw e;
  }
}

export async function listarMensajes(
  deps: Deps,
  conversationId: string,
  desde?: string,
): Promise<Mensaje[]> {
  try {
    const out = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tabla,
        // Alias defensivo: `orden` no es palabra reservada (la lista de Dynamo
        // es en inglés), pero el alias evita sorpresas y es el estilo del
        // repo (`#c` en topes.ts).
        KeyConditionExpression: desde ? "conversationId = :cid AND #orden > :desde" : "conversationId = :cid",
        ExpressionAttributeNames: desde ? { "#orden": "orden" } : undefined,
        ExpressionAttributeValues: {
          ":cid": { S: conversationId },
          ...(desde ? { ":desde": { S: desde } } : {}),
        },
        ScanIndexForward: true, // ascendente: orden = ts#msgId es cronológico
      }),
    );
    return (out.Items ?? []).map(fromItem);
  } catch (e) {
    // Fail-open de lectura: si Dynamo falla, el widget ve una lista vacía (o
    // parcial) en vez de que el polling reviente — disponibilidad > completitud.
    console.error("listado de mensajes falló (fail-open)", e);
    return [];
  }
}

export async function pendientesDesdeUltimaRespuesta(deps: Deps, conversationId: string): Promise<Mensaje[]> {
  try {
    const out = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tabla,
        KeyConditionExpression: "conversationId = :cid",
        ExpressionAttributeValues: { ":cid": { S: conversationId } },
        ScanIndexForward: false, // descendente: recorremos desde el mensaje más nuevo
        // El tope por sesión (40) hace inalcanzable un backlog mayor; el
        // Limit es defensa barata contra el corte de página de 1MB (sin esto,
        // ese corte se confundiría con "no hay assistant en la partición").
        // Si se recorren los 100 sin toparse con un assistant, igual
        // devolvemos lo acumulado: el Limit acota el costo, no la semántica.
        Limit: 100,
      }),
    );
    const pendientes: Mensaje[] = [];
    for (const raw of out.Items ?? []) {
      const m = fromItem(raw);
      // Cortamos apenas encontramos la última respuesta del assistant: todo lo
      // que quede antes de ella (más viejo) ya fue respondido, no es pendiente.
      if (m.rol === "assistant") break;
      pendientes.push(m);
    }
    // Veníamos acumulando en orden descendente (nuevo → viejo); el caller
    // (el worker, que arma el turno del agente) quiere cronológico.
    return pendientes.reverse();
  } catch (e) {
    console.error("cálculo de pendientes falló (fail-open)", e);
    return [];
  }
}

export async function ultimoMsgIdUsuario(deps: Deps, conversationId: string): Promise<string | null> {
  try {
    const out = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tabla,
        KeyConditionExpression: "conversationId = :cid",
        ExpressionAttributeValues: { ":cid": { S: conversationId } },
        ScanIndexForward: false, // descendente: el primer `user` que aparece es el más reciente
        // El tope por sesión (40) hace inalcanzable un backlog mayor; el
        // Limit es defensa barata contra el corte de página de 1MB.
        Limit: 100,
      }),
    );
    for (const raw of out.Items ?? []) {
      if (raw.rol?.S === "user") return raw.msgId?.S ?? null;
    }
    return null;
  } catch (e) {
    console.error("lectura de último msgId de usuario falló (fail-open)", e);
    return null;
  }
}
