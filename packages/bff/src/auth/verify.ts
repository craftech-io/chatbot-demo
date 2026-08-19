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
  | { kind: "jwks"; url: string };

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

export async function verifyUserToken(
  token: string,
  v: Verifier,
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    const key =
      v.kind === "hmac" ? new TextEncoder().encode(v.secret) : jwks(v.url);
    ({ payload } = await jwtVerify(token, key as never));
  } catch (e) {
    const expirado = (e as Error).name === "JWTExpired";
    throw new AuthError(
      expirado ? "el token venció" : "token inválido",
      expirado ? "expired_token" : "invalid_token",
    );
  }

  if (!payload.sub) {
    throw new AuthError("el token no trae 'sub'", "invalid_token");
  }

  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    actToken:
      typeof payload.act_token === "string" ? payload.act_token : undefined,
  };
}
