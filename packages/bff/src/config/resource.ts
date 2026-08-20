/// <reference path="../../../../sst-env.d.ts" />
// EL ÚNICO archivo del BFF que importa `Resource` de SST. Cualquier otro import
// de "sst" en packages/bff es un error de revisión: rompe la portabilidad que
// vende el paquete.
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
  };
}
