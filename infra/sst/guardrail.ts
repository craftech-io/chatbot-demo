// Guardrail de contenido del template. Se aplica DOS veces: entrada en el BFF
// (ApplyGuardrail, barato, corta antes de pagar Runtime) y salida en el core
// (guardrail_stream_processing_mode="sync", ya cableado en fase 2a).
import { MENSAJES_GUARDRAIL } from "../../packages/shared/src/mensajes";

const FILTROS = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT", "PROMPT_ATTACK"] as const;

export const guardrail = new aws.bedrock.Guardrail("Guardrail", {
  name: `craftech-ai-chat-${$app.stage}`,
  // Mensajes canónicos del registro compartido: los mismos que emite el BFF.
  blockedInputMessaging: MENSAJES_GUARDRAIL.entradaBloqueada,
  blockedOutputsMessaging: MENSAJES_GUARDRAIL.entradaBloqueada,
  contentPolicyConfig: {
    filtersConfigs: FILTROS.map((type) => ({
      type,
      inputStrength: type === "PROMPT_ATTACK" ? "HIGH" : "MEDIUM",
      // PROMPT_ATTACK solo admite outputStrength NONE.
      outputStrength: type === "PROMPT_ATTACK" ? "NONE" : "MEDIUM",
    })),
  },
});

export const guardrailLink = new sst.Linkable("Guardrail", {
  properties: { id: guardrail.guardrailId, version: guardrail.version },
});
