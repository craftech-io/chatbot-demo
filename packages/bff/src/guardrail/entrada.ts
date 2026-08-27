// Guardrail de ENTRADA: se corre en el BFF porque es barato y corta antes de
// pagar Runtime y modelo. El de SALIDA vive en el core (modo sync). Política de
// fallo: fail-open — se prefiere disponibilidad a censura dura.
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";

const clienteDefault = new BedrockRuntimeClient({});

export async function evaluarEntrada(
  texto: string,
  cfg: { id: string; version: string },
  cliente: BedrockRuntimeClient = clienteDefault,
): Promise<{ bloqueada: boolean }> {
  if (!texto.trim()) return { bloqueada: false };
  try {
    const out = await cliente.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: cfg.id,
        guardrailVersion: cfg.version,
        source: "INPUT",
        content: [{ text: { text: texto } }],
      }),
    );
    return { bloqueada: out.action === "GUARDRAIL_INTERVENED" };
  } catch (e) {
    console.error("guardrail de entrada falló (fail-open)", e);
    return { bloqueada: false };
  }
}
