// Interfaz de config del BFF, agnóstica del IaC. El resto del código consume
// SOLO esto: así cambiar de SST a Terraform toca un archivo, no el producto.
import type { Verifier } from "../auth/verify";

export type BffConfig = {
  runtimeArn: string;
  verifier: Verifier;
};

export async function loadConfig(): Promise<BffConfig> {
  // Por defecto, el sabor de referencia (SST). Los otros sabores reemplazan este
  // módulo por ./env.ts, que lee el contrato de infra/CONTRACT.md desde el entorno.
  const { fromResource } = await import("./resource");
  return fromResource();
}
