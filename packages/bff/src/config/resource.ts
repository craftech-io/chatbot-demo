/// <reference path="../../../../sst-env.d.ts" />
// EL ÚNICO archivo del BFF que importa `Resource` de SST. Cualquier otro import
// de "sst" en packages/bff es un error de revisión: rompe la portabilidad que
// vende el paquete.
import { Resource } from "sst";
import type { BffConfig } from "./index";

export function fromResource(): BffConfig {
  // El cliente se autentica por JWKS (preferido: sin secreto compartido) o por HMAC
  // (cuando no tiene OIDC — y es también el modo que usa el demo-client, porque un
  // /chat-token local no puede publicar un JWKS que Lambda alcance).
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
