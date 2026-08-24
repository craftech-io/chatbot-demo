// Topes de uso (spec §12): el cliente paga su Bedrock; los topes evitan la
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
        UpdateExpression: "ADD #c :uno",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":uno": { N: "1" } },
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
