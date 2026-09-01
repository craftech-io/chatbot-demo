// Guardrail de contenido. Se aplica DOS veces: entrada en el BFF
// (ApplyGuardrail, barato, corta antes de pagar Runtime) y salida en el core
// entrada, en el BFF (ApplyGuardrail): corta antes de invocar el Runtime.
import { cliente } from "../../client.config";
import { MENSAJES_GUARDRAIL } from "../../packages/shared/src/mensajes";
import { slugKebab } from "./nombres";

const FILTROS = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT", "PROMPT_ATTACK"] as const;

// Datos personales. ANONYMIZE y no BLOCK en los identificadores de contacto: la
// gente da su email o su teléfono para que la atiendan, y bloquear el turno
// dejaría el chat inservible. Anonimizado el turno sigue y el dato no queda en
// el historial, ni en los logs, ni en las trazas.
const PII_ANONIMIZAR = ["EMAIL", "PHONE", "NAME", "ADDRESS"] as const;
// Estos NUNCA tienen que llegar al modelo: no hay caso de uso legítimo en un
// chat de soporte y el costo de que queden registrados es alto.
const PII_BLOQUEAR = ["CREDIT_DEBIT_CARD_NUMBER", "CREDIT_DEBIT_CARD_CVV", "PASSWORD"] as const;

export const guardrail = new aws.bedrock.Guardrail("Guardrail", {
  // `[0-9a-zA-Z-_]+`: el stage entra tal cual (a diferencia del Gateway y del
  // Runtime, que exigen sanearlo) y el prefijo sale del slug del cliente.
  name: `${slugKebab}-${$app.stage}`,
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
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfigs: [
      ...PII_ANONIMIZAR.map((type) => ({ type, action: "ANONYMIZE" })),
      ...PII_BLOQUEAR.map((type) => ({ type, action: "BLOCK" })),
    ],
    // Los identificadores locales (CUIT/DNI, RFC/CURP, NIF) dependen del país
    // y los declara el cliente en client.config.ts.
    regexesConfigs: cliente.guardrail.regexPii.map((r) => ({
      name: r.nombre,
      description: r.descripcion,
      pattern: r.patron,
      action: r.accion,
    })),
  },
});

export const guardrailLink = new sst.Linkable("Guardrail", {
  properties: { id: guardrail.guardrailId, version: guardrail.version },
});
