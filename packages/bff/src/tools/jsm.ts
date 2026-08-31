// Adaptador de `escalar_a_humano` para Jira Service Management: crea un pedido
// en el portal de soporte. Respeta la interfaz que declara ./escalamiento.ts
//   entrada  { resumen, detalle? }
//   salida   { creado: true, referencia?, link?, nota? } | { creado: false, nota }
//
// Auth: OAuth 2.0 client_credentials con una service account, NO Basic auth con
// API token — esos vencen cada año por política de Atlassian y el escalamiento
// se caería sin aviso. Scope necesario: write:servicedesk-request.
//
// El ticket se crea por la API de service desk y no por la de Jira core: es lo
// que lo hace aparecer como pedido en el portal, con su SLA.
import { crearProveedorDeToken, motivoDeError } from "../atlassian";
import type { EntradaEscalamiento, RespuestaEscalamiento } from "./escalamiento";

export const TIMEOUT_MS = 10_000;
// Con OAuth la API NO se llama en el dominio del sitio: va por api.atlassian.com
// con el cloudId del tenant.
const base = (cloudId: string) => `https://api.atlassian.com/ex/jira/${cloudId}`;

export const NOTA_SIN_RESUMEN =
  "Necesito un resumen del caso para poder derivarlo a una persona.";
export const NOTA_FALLO =
  "No pude confirmar el escalamiento: el sistema de soporte no respondió bien y no hay una referencia para darle al usuario. Conviene reintentar en un rato.";
export const NOTA_SIN_AUTH =
  "No pude derivar el caso: el sistema de soporte rechazó las credenciales de la integración.";
// 400/422: el tipo de pedido pide campos que este adaptador no manda. No es una
// caída, es configuración — y el usuario no puede hacer nada al respecto.
export const NOTA_CAMPOS =
  "No pude derivar el caso: el tipo de pedido configurado exige datos que la integración no está enviando. Hay que revisar la configuración del service desk.";

export type DepsJsm = {
  clientId: string;
  clientSecret: string;
  cloudId: string;
  serviceDeskId: string;
  requestTypeId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Inyectable en los tests para no depender del reloj. */
  ahora?: () => number;
};

export function configuradoJsm(d: Partial<DepsJsm>): boolean {
  return Boolean(d.clientId && d.clientSecret && d.cloudId && d.serviceDeskId && d.requestTypeId);
}

export function crearAdaptadorJsm(deps: DepsJsm) {
  const hacerFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const proveedor = crearProveedorDeToken({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs,
    ahora: deps.ahora,
  });

  return async function escalarAJsm(
    entrada: EntradaEscalamiento,
  ): Promise<RespuestaEscalamiento> {
    const resumen = typeof entrada.resumen === "string" ? entrada.resumen.trim() : "";
    if (!resumen) return { creado: false, nota: NOTA_SIN_RESUMEN };

    const acceso = await proveedor.obtener();
    if (!acceso) return { creado: false, nota: NOTA_SIN_AUTH };

    const campos: Record<string, string> = { summary: resumen };
    const detalle = typeof entrada.detalle === "string" ? entrada.detalle.trim() : "";
    if (detalle) campos.description = detalle;

    let r: Response;
    try {
      r = await hacerFetch(`${base(deps.cloudId)}/rest/servicedeskapi/request`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${acceso}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          serviceDeskId: deps.serviceDeskId,
          requestTypeId: deps.requestTypeId,
          requestFieldValues: campos,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error("el POST a JSM falló:", motivoDeError(e));
      return { creado: false, nota: NOTA_FALLO };
    }

    if (r.status === 401 || r.status === 403) {
      // Un token vencido antes de lo previsto no debe envenenar la caché.
      proveedor.invalidar();
      console.error("JSM rechazó las credenciales con status", r.status);
      return { creado: false, nota: NOTA_SIN_AUTH };
    }
    if (r.status === 400 || r.status === 422) {
      console.error("JSM rechazó el pedido por campos con status", r.status);
      return { creado: false, nota: NOTA_CAMPOS };
    }
    if (!r.ok) {
      console.error("JSM respondió con status", r.status);
      return { creado: false, nota: NOTA_FALLO };
    }

    const cuerpo = (await r.json().catch(() => undefined)) as
      | { issueKey?: string; _links?: { web?: string } }
      | undefined;
    const referencia = cuerpo?.issueKey?.trim() || undefined;
    // `_links.web` es el portal del cliente, el link útil para el usuario.
    const link = cuerpo?._links?.web?.trim() || undefined;
    return {
      creado: true,
      ...(referencia ? { referencia } : {}),
      ...(link ? { link } : {}),
      ...(referencia
        ? {}
        : { nota: "El caso quedó creado, pero el sistema no devolvió una referencia." }),
    };
  };
}
