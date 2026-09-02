/// <reference path="../../../../sst-env.d.ts" />
// El único lugar del BFF que traduce SST (`Resource`, `process.env`) al
// `BffConfig` que consume el backend de mensajes. El código de producto habla
// solo con `BffConfig`, así que cambiar de sabor de IaC toca este archivo y
// nada más.
//
// Bordes de infra sancionados, fuera de esta traducción: los handlers de las
// tools de tenant (`src/tools/documentos.ts` y `src/tools/escalamiento.ts`)
// también leen `Resource`/`process.env`, cada uno en su propio `handler` del
// final del archivo. No rompen la regla: cada tool es SU PROPIA Lambda, con su
// propio linkeo, y no comparte el `BffConfig` de la Function del chat — que es
// justamente lo que no se puede compartir, porque el proxy `Resource` LANZA al
// leer un recurso que la Function no tiene linkeado y `fromResource()` corre por
// request (ver infra/CONTRACT.md, "Variables que recibe el worker"). Meter el
// KnowledgeBase o el webhook acá mataría todos los requests del chat.
//
// Cualquier OTRO import de "sst" (o lectura de env) en packages/bff sigue siendo
// un error de revisión: rompe la portabilidad que vende el paquete.
import { Resource } from "sst";
import type { BffConfig } from "./index";

const MIN_BYTES_HMAC = 32;

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

  // HS256 firma con el secreto crudo: uno más corto que su hash se rompe
  // offline con el token en mano, y nada más en el sistema lo avisaría.
  if (hmacSecret && hmacSecret.length < MIN_BYTES_HMAC) {
    throw new Error(
      `ClientHmacSecret tiene ${hmacSecret.length} caracteres y el mínimo es ${MIN_BYTES_HMAC}. ` +
        "Generá uno con: openssl rand -base64 48",
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
    // Ojo: NO leer Resource.AgentRuntime acá. El invoke al Runtime lo hace el
    // worker (packages/worker/src/lambda.ts), no el BFF, así que la Function del
    // Chat NO tiene ese recurso linkeado — y el proxy Resource de sst LANZA ante
    // un recurso no linkeado. Como `cfg()` corre por request, una lectura de
    // Resource.AgentRuntime.arn acá tira en CADA request y mata todo POST/GET
    // del backend de mensajes.
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
    // El linkable Guardrail existe siempre en el sabor SST: no hace falta
    // try/catch. El campo es opcional en BffConfig por los otros sabores, no
    // por este.
    guardrail: { id: Resource.Guardrail.id, version: Resource.Guardrail.version },
    // Ídem tablas: siempre linkeadas en el sabor SST.
    tablas: {
      sesiones: Resource.SessionsTable.name,
      limites: Resource.LimitsTable.name,
    },
    // Env, igual que los Resource de arriba: la config del backend de mensajes
    // se arma toda acá. Los topes son el default del template — client.config.ts los ajusta por
    // cliente.
    topes: {
      diario: Number(process.env.LIMITE_DIARIO ?? "50"),
      porSesion: Number(process.env.LIMITE_POR_SESION ?? "40"),
    },
    // Ídem tablas: MessagesTable y MensajesCola están linkeadas siempre en el
    // sabor SST. `debounceSegundos` lee env (como los topes arriba) y es solo
    // informativo: el delay real vive en la cola (infra/sst/mensajeria.ts),
    // porque SQS FIFO no expone el delay por mensaje.
    mensajes: {
      tabla: Resource.MessagesTable.name,
      colaUrl: Resource.MensajesCola.url,
      debounceSegundos: Number(process.env.DEBOUNCE_SEGUNDOS ?? "6"),
    },
  };
}
