// SessionsTable: índice de hilos por usuario — SOLO metadata (título, timestamps,
// contador de turnos). La transcripción vive en AgentCore Memory, nunca acá.
export const sessionsTable = new sst.aws.Dynamo("SessionsTable", {
  fields: { userId: "string", sessionId: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "sessionId" },
});

// LimitsTable: contadores de tope por usuario y período (día). El cliente paga
// su Bedrock: sin topes, la primera factura sorpresa se come la relación (§12).
export const limitsTable = new sst.aws.Dynamo("LimitsTable", {
  fields: { userId: "string", periodo: "string" },
  primaryIndex: { hashKey: "userId", rangeKey: "periodo" },
});

export const sessionsTableLink = new sst.Linkable("SessionsTable", {
  properties: { name: sessionsTable.name },
});

export const limitsTableLink = new sst.Linkable("LimitsTable", {
  properties: { name: limitsTable.name },
});
