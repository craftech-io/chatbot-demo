/// <reference path="../../../../sst-env.d.ts" />
// EL ÚNICO archivo del BFF que importa `Resource` de SST. Cualquier otro import
// de "sst" en packages/bff es un error de revisión: rompe la portabilidad que
// vende el paquete.
//
// @ts-nocheck — temporal hasta la Task 10: `tsconfig.json` excluye este archivo
// de `include`, pero TypeScript igual lo suma al programa porque `config/index.ts`
// lo importa dinámicamente (el `exclude` de tsconfig no rompe el grafo de imports,
// solo filtra el glob de `include`). Sin este pragma, sus propios diagnósticos
// (falta "sst" y falta `sst-env.d.ts`) igual aparecerían pese al exclude. La
// Task 10 instala `sst`, genera `sst-env.d.ts` y quita esta línea junto con el
// exclude del tsconfig.
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
