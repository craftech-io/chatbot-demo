/* Puente tipado INTERINO escrito a mano: el primer `sst deploy`/`sst dev` lo
 * regenera con los tipos reales. Si la infra cambia sus linkables, actualizá
 * esto o corré un deploy. */
import "sst";
declare module "sst" {
  export interface Resource {
    AgentRuntime: { arn: string };
    ClientAuth: { jwksUrl: string; hmacSecret: string };
    Guardrail: { id: string; version: string };
    SessionsTable: { name: string };
    LimitsTable: { name: string };
    MessagesTable: { name: string };
    MensajesCola: { url: string };
  }
}
