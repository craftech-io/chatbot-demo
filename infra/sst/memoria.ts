// Memoria de conversación gestionada (AgentCore Memory). El core la lee y
// escribe por (actorId=userId, sessionId). Hoy solo short-term: los resúmenes
// long-term son extensión futura (spec §10).
export const memoria = new awsnative.bedrockagentcore.Memory("Memoria", {
  name: `craftechAiChatMemoria${$app.stage.replace(/[^a-zA-Z0-9_]/g, "_")}`,
  // Retención de eventos short-term (días). 30 alinea con retención típica de chats.
  eventExpiryDuration: 30,
});
