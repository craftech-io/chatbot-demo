// Interfaz de config del BFF, agnóstica del IaC. El resto del código consume
// SOLO esto: así cambiar de SST a Terraform toca un archivo, no el producto.
import type { Verifier } from "../auth/verify";

export type BffConfig = {
  // En modo jwks puede traer `issuer`/`audience` pineados (OIDC estricto,
  // p. ej. Cognito); ausentes ⇒ solo se valida la firma. Ver auth/verify.ts.
  verifier: Verifier;
  // Opcional: un sabor puede no tener el Guardrail linkeado. Si falta,
  // lambda.ts no construye el dep `guard` y el handler corre sin filtro de
  // entrada.
  guardrail?: { id: string; version: string };
  // Opcional: un sabor puede no tener las tablas linkeadas. Si falta,
  // lambda.ts no construye el dep `limites` ni registra el índice de hilos.
  tablas?: { sesiones: string; limites: string };
  // Topes de uso: con default si el sabor no los trae seteados.
  topes?: { diario: number; porSesion: number };
  // Mensajería asíncrona: tabla de transcripción y cola FIFO de debounce.
  // Opcional por el mismo motivo que `tablas` arriba: un sabor sin este linkeo
  // corre sin la API de mensajes.
  mensajes?: { tabla: string; colaUrl: string; debounceSegundos: number };
};

export async function loadConfig(): Promise<BffConfig> {
  // Por defecto, el sabor de referencia (SST). Los otros sabores reemplazan este
  // módulo por ./env.ts, que lee el contrato de infra/CONTRACT.md desde el entorno.
  const { fromResource } = await import("./resource");
  return fromResource();
}
