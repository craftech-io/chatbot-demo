// Token de Atlassian Cloud por OAuth 2.0 client_credentials (service account).
// Lo comparten el adaptador de JSM y el ingestor de Confluence: es la misma
// service account y el mismo endpoint, cambian los scopes.
//
// NO API token con Basic auth: esos vencen cada año por política de Atlassian.

const URL_TOKEN = "https://auth.atlassian.com/oauth/token";
// El token dura 3600s; se renueva con margen para no perder una operación por
// una carrera entre la expiración y la llamada.
const MARGEN_RENOVACION_MS = 5 * 60 * 1000;

export type DepsToken = {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  ahora?: () => number;
};

/** Nunca el mensaje ni el body de la excepción: llevarían el client_secret. */
export function motivoDeError(e: unknown): string {
  if (!(e instanceof Error)) return "error desconocido";
  const codigo = (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof codigo === "string" ? `${e.name} (${codigo})` : e.name;
}

export function crearProveedorDeToken(deps: DepsToken) {
  const hacerFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const ahora = deps.ahora ?? Date.now;

  // Cacheado entre invocaciones: la Lambda se reusa.
  let token: string | undefined;
  let vence = 0;

  return {
    /** Descarta el token cacheado: se llama cuando la API responde 401/403. */
    invalidar() {
      token = undefined;
    },
    async obtener(): Promise<string | undefined> {
      if (token && ahora() < vence - MARGEN_RENOVACION_MS) return token;
      let r: Response;
      try {
        r = await hacerFetch(URL_TOKEN, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: deps.clientId,
            client_secret: deps.clientSecret,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        console.error("el token de Atlassian falló:", motivoDeError(e));
        return undefined;
      }
      if (!r.ok) {
        console.error("el token de Atlassian respondió con status", r.status);
        return undefined;
      }
      const cuerpo = (await r.json().catch(() => undefined)) as
        | { access_token?: string; expires_in?: number }
        | undefined;
      if (!cuerpo?.access_token) {
        console.error("el token de Atlassian llegó sin access_token");
        return undefined;
      }
      token = cuerpo.access_token;
      vence = ahora() + (cuerpo.expires_in ?? 3600) * 1000;
      return token;
    },
  };
}
