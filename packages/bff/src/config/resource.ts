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
  const { jwksUrl, hmacSecret, issuer, audience } = Resource.ClientAuth;
  if (!jwksUrl && !hmacSecret) {
    throw new Error(
      "Falta configurar el emisor de tokens: seteá ClientJwksUrl o ClientHmacSecret.",
    );
  }

  // Half-pin: con JWKS activo y solo UNO de issuer/audience configurado, lo
  // más probable es un secret olvidado — y con un emisor multi-app (Cognito)
  // eso deja pasar tokens de OTRAS apps del mismo pool. Aviso, no corte:
  // pinear solo issuer es legítimo para emisores cuyos tokens no traen `aud`.
  if (!hmacSecret && jwksUrl && !!issuer !== !!audience) {
    console.warn(
      `auth: pineo JWKS incompleto — falta ${issuer ? "ClientTokenAudience" : "ClientTokenIssuer"}; ` +
        "tokens de otras apps del mismo emisor podrían pasar la verificación.",
    );
  }

  return {
    // Ojo: NO leer Resource.AgentRuntime acá. T4 (fase 2c) quitó `runtimeLink`
    // de la Function del Chat a propósito — el invoke al Runtime ahora lo hace
    // el worker (packages/worker/src/lambda.ts), no el BFF. El proxy Resource
    // de sst LANZA ante un recurso no linkeado, así que leer
    // Resource.AgentRuntime.arn acá tiraba en cada request y mataba TODO
    // POST/GET del Messages Backend en el primer deploy (C1, fix-wave fase 2c).
    verifier: hmacSecret
      ? { kind: "hmac", secret: hmacSecret }
      : {
          kind: "jwks",
          url: jwksUrl,
          // "" en el secret ⇒ undefined ⇒ no se exige ese claim (compat con
          // emisores JWKS sin OIDC estricto). Con Cognito van los dos seteados.
          issuer: issuer || undefined,
          audience: audience || undefined,
        },
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
    // Ídem tablas: MessagesTable y MensajesCola están linkeadas siempre en el
    // sabor SST desde la fase 2c (Task 1). `debounceSegundos` lee env (como
    // los topes arriba): es informativo, el delay real vive en la cola
    // (infra/sst/mensajeria.ts) porque SQS FIFO no lo expone por mensaje.
    mensajes: {
      tabla: Resource.MessagesTable.name,
      colaUrl: Resource.MensajesCola.url,
      debounceSegundos: Number(process.env.DEBOUNCE_SEGUNDOS ?? "6"),
    },
  };
}
