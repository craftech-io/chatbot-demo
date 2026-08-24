// Interfaz de config del BFF, agnóstica del IaC. El resto del código consume
// SOLO esto: así cambiar de SST a Terraform toca un archivo, no el producto.
import type { Verifier } from "../auth/verify";

export type BffConfig = {
  runtimeArn: string;
  verifier: Verifier;
  // Opcional: sabores/mocks viejos pueden no tener el Guardrail linkeado
  // (Task 2, fase 2b). Si falta, lambda.ts no construye el dep `guard` y el
  // handler sigue sin filtro de entrada.
  guardrail?: { id: string; version: string };
};

export async function loadConfig(): Promise<BffConfig> {
  // Por defecto, el sabor de referencia (SST). Los otros sabores reemplazan este
  // módulo por ./env.ts, que lee el contrato de infra/CONTRACT.md desde el entorno.
  const { fromResource } = await import("./resource");
  return fromResource();
}
