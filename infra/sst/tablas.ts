// SessionsTable: índice de hilos por usuario — SOLO metadata (título, timestamps,
// contador de turnos). La transcripción vive en MessagesTable, nunca acá.
// Sufijo Db en el nombre del componente: los nombres de componentes SST son
// únicos en toda la app y el Linkable de abajo ya usa "SessionsTable" (la clave
// de Resource).
export const sessionsTable = new sst.aws.Dynamo("SessionsTableDb", {
  fields: { userId: "string", sessionId: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "sessionId" },
});

// LimitsTable: contadores de tope por usuario y período (día). El cliente paga
// su Bedrock: sin topes, la primera factura sorpresa se come la relación (§12).
// TTL en `expiraAt`: sin esto los períodos vencidos se acumulan para siempre —
// el campo lo escribe topes.ts al primer UpdateItem de cada período.
export const limitsTable = new sst.aws.Dynamo("LimitsTableDb", {
  fields: { userId: "string", periodo: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "periodo" },
  ttl: "expiraAt",
});

// Los wrappers de sst.Linkable NO heredan el auto-grant que sst.aws.Dynamo le
// daría a un link directo del componente: hay que declarar el permiso scoped
// a mano vía `include`, o el UpdateItem/GetItem real da AccessDenied y el
// fail-open de topes.ts/indice.ts lo traga en silencio (ver infra/CONTRACT.md).
export const sessionsTableLink = new sst.Linkable("SessionsTable", {
  properties: { name: sessionsTable.name },
  include: [
    sst.aws.permission({
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [sessionsTable.arn],
    }),
  ],
});

export const limitsTableLink = new sst.Linkable("LimitsTable", {
  properties: { name: limitsTable.name },
  include: [
    sst.aws.permission({
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [limitsTable.arn],
    }),
  ],
});
