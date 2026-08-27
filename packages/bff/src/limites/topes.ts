// Topes de uso: el cliente paga su Bedrock; los topes evitan la
// factura sorpresa. Estrategia: incremento atómico (ADD) y verificación del
// valor resultante — en el borde sobrecuenta 1, aceptable y sin carrera.
// Fail-open: si Dynamo falla, el chat sigue (disponibilidad > contabilidad).
import { UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

type Deps = {
  ddb: DynamoDBClient;
  tabla: string;
  topeDiario: number;
  topeSesion: number;
  sesiones: { turnos(userId: string, sessionId: string): Promise<number> };
};

export async function verificarYConsumirTope(
  deps: Deps,
  userId: string,
  sessionId: string,
  hoy: string,
): Promise<{ permitido: true } | { permitido: false; motivo: "dia" | "sesion" }> {
  try {
    const turnosSesion = await deps.sesiones.turnos(userId, sessionId);
    if (turnosSesion >= deps.topeSesion) return { permitido: false, motivo: "sesion" };

    const out = await deps.ddb.send(
      new UpdateItemCommand({
        TableName: deps.tabla,
        Key: { userId: { S: userId }, periodo: { S: hoy } },
        // El TTL (`expiraAt`) se setea SOLO si no existe: no hay que
        // refrescarlo en cada turno, y no queremos que un turno tardío
        // extienda la vida del item más allá del período que ya expiró.
        // 48h en vez de 24h: cubre el día completo del período (que puede
        // arrancar en cualquier huso horario respecto al reloj del server)
        // más margen para que un consumidor lento del stream de Dynamo (o
        // un reintento) todavía vea el item antes de que TTL lo borre.
        UpdateExpression: "ADD #c :uno SET expiraAt = if_not_exists(expiraAt, :expira)",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: {
          ":uno": { N: "1" },
          ":expira": { N: String(Math.floor(Date.now() / 1000) + 172_800) },
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const count = Number(out.Attributes?.count?.N ?? "0");
    if (count > deps.topeDiario) return { permitido: false, motivo: "dia" };
    return { permitido: true };
  } catch (e) {
    console.error("verificación de topes falló (fail-open)", e);
    return { permitido: true };
  }
}
