// Índice de hilos por usuario — SOLO metadata: título, timestamps y contador de
// turnos. La transcripción vive en MessagesTable. Este índice es lo que una
// UI usa para listar conversaciones.
import { GetItemCommand, UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

type Deps = { ddb: DynamoDBClient; tabla: string };

export async function registrarTurnoEnIndice(
  deps: Deps,
  userId: string,
  sessionId: string,
  primerMensaje: string,
): Promise<number> {
  try {
    const out = await deps.ddb.send(
      new UpdateItemCommand({
        TableName: deps.tabla,
        Key: { userId: { S: userId }, sessionId: { S: sessionId } },
        UpdateExpression:
          "ADD turnos :uno SET titulo = if_not_exists(titulo, :titulo), ultimoTurnoAt = :ahora",
        ExpressionAttributeValues: {
          ":uno": { N: "1" },
          ":titulo": { S: primerMensaje.slice(0, 80) },
          ":ahora": { S: new Date().toISOString() },
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(out.Attributes?.turnos?.N ?? "0");
  } catch (e) {
    console.error("índice de sesiones falló (fail-open)", e);
    return 0;
  }
}

export async function turnosDeSesion(
  deps: Deps,
  userId: string,
  sessionId: string,
): Promise<number> {
  try {
    const out = await deps.ddb.send(
      new GetItemCommand({
        TableName: deps.tabla,
        Key: { userId: { S: userId }, sessionId: { S: sessionId } },
        ProjectionExpression: "turnos",
      }),
    );
    return Number(out.Item?.turnos?.N ?? "0");
  } catch (e) {
    console.error("lectura de turnos falló (fail-open)", e);
    return 0;
  }
}
