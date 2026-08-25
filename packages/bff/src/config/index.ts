// Interfaz de config del BFF, agnóstica del IaC. El resto del código consume
// SOLO esto: así cambiar de SST a Terraform toca un archivo, no el producto.
import type { Verifier } from "../auth/verify";

export type BffConfig = {
  verifier: Verifier;
  // Opcional: sabores/mocks viejos pueden no tener el Guardrail linkeado
  // (Task 2, fase 2b). Si falta, lambda.ts no construye el dep `guard` y el
  // handler sigue sin filtro de entrada.
  guardrail?: { id: string; version: string };
  // Opcional: sabores/mocks viejos pueden no tener las tablas linkeadas
  // (Task 6/7, fase 2b). Si falta, lambda.ts no construye el dep `limites` ni
  // registra el índice de hilos.
  tablas?: { sesiones: string; limites: string };
  // Topes de uso (spec §12): con default si el sabor no los trae seteados.
  topes?: { diario: number; porSesion: number };
  // Mensajería asíncrona (spec §8 v2, Task 1/2/3 fase 2c): tabla de
  // transcripción y cola FIFO de debounce. Opcional por el mismo motivo que
  // `tablas` arriba: sabores/mocks viejos sin este linkeo corren sin la API
  // de mensajes.
  mensajes?: { tabla: string; colaUrl: string; debounceSegundos: number };
};

export async function loadConfig(): Promise<BffConfig> {
  // Por defecto, el sabor de referencia (SST). Los otros sabores reemplazan este
  // módulo por ./env.ts, que lee el contrato de infra/CONTRACT.md desde el entorno.
  const { fromResource } = await import("./resource");
  return fromResource();
}
