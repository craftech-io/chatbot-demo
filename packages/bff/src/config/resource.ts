/// <reference path="../../../../sst-env.d.ts" />
// EL ÚNICO archivo del BFF que importa `Resource` de SST o lee `process.env`
// directamente. Cualquier otro import de "sst" (o lectura de env) en
// packages/bff es un error de revisión: rompe la portabilidad que vende el
// paquete.
import { Resource } from "sst";
import type { BffConfig } from "./index";

export function fromResource(): BffConfig {
  // JWKS es el preferido para clientes con OIDC (sin secreto compartido). Si
  // el cliente no tiene OIDC, usa HMAC. Si ambos están configurados gana HMAC
  // (deliberado: es el modo del demo y del primer arranque, no un descuido).
  const { jwksUrl, hmacSecret } = Resource.ClientAuth;
  if (!jwksUrl && !hmacSecret) {
    throw new Error(
      "Falta configurar el emisor de tokens: seteá ClientJwksUrl o ClientHmacSecret.",
    );
  }
  return {
    runtimeArn: Resource.AgentRuntime.arn,
    verifier: hmacSecret
      ? { kind: "hmac", secret: hmacSecret }
      : { kind: "jwks", url: jwksUrl },
    // El linkable Guardrail existe siempre en el sabor SST desde la fase 2b:
    // no hace falta try/catch. El campo es opcional en BffConfig por otros
    // sabores/mocks, no por este.
    guardrail: { id: Resource.Guardrail.id, version: Resource.Guardrail.version },
    // Ídem tablas: siempre linkeadas en el sabor SST desde la fase 2b (Task 6).
    tablas: {
      sesiones: Resource.SessionsTable.name,
      limites: Resource.LimitsTable.name,
    },
    // Único lugar que toca env en el BFF (además de los Resource de arriba):
    // los topes son el default del template — client.config.ts los ajusta por
    // cliente en 2e.
    topes: {
      diario: Number(process.env.LIMITE_DIARIO ?? "50"),
      porSesion: Number(process.env.LIMITE_POR_SESION ?? "40"),
    },
  };
}
