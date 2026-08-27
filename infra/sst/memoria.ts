// Memoria de conversación gestionada (AgentCore Memory). El core la lee y
// escribe por (actorId=userId, sessionId). Hoy solo short-term: los resúmenes
// long-term son extensión futura (spec §10).
import { cliente } from "../../client.config";
import { slugCamel } from "./nombres";

export const memoria = new awsnative.bedrockagentcore.Memory("Memoria", {
  // Mismo alfabeto que el Runtime (`[a-zA-Z][a-zA-Z0-9_]*`, sin `-`): prefijo
  // en camelCase desde el slug del cliente (infra/sst/nombres.ts).
  name: `${slugCamel}Memoria${$app.stage.replace(/[^a-zA-Z0-9_]/g, "_")}`,
  // Retención de eventos short-term (días), configurable por cliente.
  eventExpiryDuration: cliente.retencionMemoriaDias,
});
