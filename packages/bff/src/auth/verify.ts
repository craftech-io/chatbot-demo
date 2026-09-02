// Verificación del token del usuario final. Es la frontera de confianza del
// sistema: todo lo que sale de acá se considera cierto, y nada que no haya pasado
// por acá llega al Runtime.
//
// El token lo emite el backend del CLIENTE en su endpoint /chat-token, para el
// usuario que ya está logueado en su app. Nosotros solo verificamos la firma:
// nunca manejamos sus credenciales ni le pedimos un segundo login al usuario.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type Principal = {
  userId: string;
  email?: string;
  // Token para llamar a la API del cliente EN NOMBRE del usuario. En la mayoría
  // de los casos es el mismo token (si su API ya usa JWTs de acceso); viaja
  // aparte solo cuando su API usa otro esquema de auth.
  actToken?: string;
};

export type Verifier =
  | { kind: "hmac"; secret: string }
  // issuer/audience opcionales: si están, se exigen como claims `iss`/`aud`
  // del token. Ausentes ⇒ solo firma (compat con emisores sin OIDC estricto).
  | { kind: "jwks"; url: string; issuer?: string; audience?: string };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_token" | "expired_token",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// Los JWKSet se cachean por URL: crear uno por request perdería el cache de
// claves de `jose` y agregaría una llamada HTTP a cada mensaje del chat.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(url: string) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

// Algoritmos permitidos por tipo de emisor. Allowlist explícita: en una frontera
// de confianza no se deja que el token elija el algoritmo.
// `exp` es OBLIGATORIO: jose valida el vencimiento solo si el claim viene, así
// que un token sin `exp` sirve para siempre. Vale para los dos modos.
const CLAIMS_OBLIGATORIOS = ["exp"];

const HMAC_ALGS = ["HS256"];
const JWKS_ALGS = ["RS256", "ES256", "PS256", "EdDSA"];

export async function verifyUserToken(
  token: string,
  v: Verifier,
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    // Sin cast: cada tipo de clave va con su allowlist en su propia rama.
    ({ payload } =
      v.kind === "hmac"
        ? await jwtVerify(token, new TextEncoder().encode(v.secret), {
            algorithms: HMAC_ALGS,
            requiredClaims: CLAIMS_OBLIGATORIOS,
          })
        : await jwtVerify(token, jwks(v.url), {
            algorithms: JWKS_ALGS,
            requiredClaims: CLAIMS_OBLIGATORIOS,
            // Con emisor OIDC real (Cognito) se pinean emisor y audiencia: la
            // firma sola no alcanza si el mismo emisor firma para varias apps.
            ...(v.issuer ? { issuer: v.issuer } : {}),
            ...(v.audience ? { audience: v.audience } : {}),
          }));
  } catch (e) {
    // jose marca sus errores con .code (estable ante minificación, a diferencia
    // de .name). Lo que no venga de jose (red, DNS, URL malformada) se loguea
    // antes de fallar cerrado: una caída del JWKS no debe quedar indistinguible
    // de un token adulterado en los logs.
    const code = (e as { code?: string }).code ?? "";
    if (!code.startsWith("ERR_")) {
      console.error("verifyUserToken: error no-JWT verificando el token", e);
    }
    const expirado = code === "ERR_JWT_EXPIRED";
    throw new AuthError(
      expirado ? "el token venció" : "token inválido",
      expirado ? "expired_token" : "invalid_token",
    );
  }

  // `sub` es la identidad misma: se exige string no vacío, no solo truthy —
  // un emisor mal configurado que mande un sub numérico no puede colarse
  // como userId en el contrato que todo lo demás considera cierto.
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new AuthError("el token no trae 'sub'", "invalid_token");
  }

  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    actToken:
      typeof payload.act_token === "string" ? payload.act_token : undefined,
  };
}
