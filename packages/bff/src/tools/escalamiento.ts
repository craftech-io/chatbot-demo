/// <reference path="../../../../sst-env.d.ts" />
// Tool de TENANT `escalar_a_humano` (spec §11.1): crea el escalamiento cuando el
// agente no encontró la respuesta en los documentos Y el usuario aceptó ser
// derivado. La invoca el AgentCore Gateway como target Lambda.
//
// ADAPTADOR DE REFERENCIA — leer antes de tocar esto:
// El destino del escalamiento es un adaptador y ESTE es el de referencia: un
// POST con el payload del caso a un webhook configurable. Sirve tal cual (o
// como puente hacia lo que el cliente ya usa: Zapier, n8n, una Lambda propia).
// Lo que es contrato NO es el webhook, es la INTERFAZ de la tool:
//   entrada  { resumen, detalle?, usuario?, conversacion? }
//   salida   { creado: true, referencia, link? } | { creado: false, nota }
// Un adaptador de un sistema concreto (Jira Service Management, Jira, Slack,
// email) se implementa en el clon del cliente, donde existen las credenciales
// para probarlo: un adaptador sin verificar en el template es peor que ninguno,
// porque parece listo.
//
// Nota de auth para quien implemente el adaptador de Atlassian (spec §11.1): los
// API tokens con Basic auth VENCEN cada año por política de Atlassian, así que
// no son el camino. El sostenible es OAuth 2.0 `client_credentials` con una
// service account, cacheando el access token de 60 minutos y renovándolo con
// margen. Y el ticket se crea por la API de service desk, no por la de Jira
// core: es lo que lo hace aparecer como pedido en el portal, con su SLA.
//
// El token del sistema externo NUNCA toca el core: vive acá, detrás del
// Gateway. El agente pide "escalá esto" y no ve credencial alguna.
//
// Regla dura: si el POST no fue 2xx, esta tool NUNCA dice que creó el
// escalamiento. Mentirle al usuario ("ya te derivé") cuando el ticket no
// existe es el peor resultado posible de esta capacidad.
//
// Sobre `Resource` en packages/bff: igual que en ./documentos.ts — la lógica
// recibe el webhook inyectado y solo el `handler` del final lee SST.
import { randomUUID } from "node:crypto";
import { Resource } from "sst";

// El turno del agente no puede quedarse colgado esperando al sistema del
// cliente: 10s y se corta.
export const TIMEOUT_MS = 10_000;

// Notas en texto HUMANO: el modelo las lee y se las explica al usuario.
export const NOTA_SIN_RESUMEN =
  "Necesito un resumen del caso para poder derivarlo a una persona.";
export const NOTA_SIN_WEBHOOK =
  "No hay un destino de escalamiento configurado, así que no pude derivar el caso a una persona.";
// Dice "no pude confirmar" y no "no quedó registrado" a propósito: un POST que
// falló pudo haber llegado igual (un 500 después de crear el ticket, una
// conexión cortada al leer la respuesta). Lo único que la tool sabe con
// certeza es que NO tiene una referencia que darle al usuario.
export const NOTA_FALLO =
  "No pude confirmar el escalamiento: el sistema de soporte no respondió bien y no hay una referencia para darle al usuario. Conviene reintentar en un rato.";

export type EntradaEscalamiento = {
  /** Qué necesita el usuario, en una o dos frases. Obligatorio. */
  resumen?: string;
  /** Contexto adicional del caso. */
  detalle?: string;
  /** Identificador del usuario final. */
  usuario?: string;
  /** Identificador de la conversación, para que el humano pueda leer el hilo. */
  conversacion?: string;
};

export type RespuestaEscalamiento =
  | { creado: true; referencia: string; link?: string }
  | { creado: false; nota: string };

type DepsEscalamiento = {
  /** URL del webhook. Vacía ⇒ la tool avisa que no hay destino y no postea. */
  webhookUrl: string;
  /** Inyectable para testear sin red. */
  fetch?: typeof globalThis.fetch;
  /** Inyectable para testear; por defecto una referencia local `ESC-xxxxxxxx`. */
  generarReferencia?: () => string;
  timeoutMs?: number;
};

function texto(valor: unknown): string | undefined {
  if (typeof valor === "string") return valor.trim() || undefined;
  // Varios sistemas devuelven ids numéricos.
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return undefined;
}

// Del cuerpo del webhook se rescatan la referencia y el link del ticket, con los
// nombres más habituales: `key` es lo de Atlassian, `id`/`reference` lo de casi
// todo lo demás. Si no viene ninguno, el caller genera una referencia local.
function datosDelTicket(cuerpo: unknown): { referencia?: string; link?: string } {
  if (!cuerpo || typeof cuerpo !== "object") return {};
  const c = cuerpo as Record<string, unknown>;
  return {
    referencia: texto(c.referencia) ?? texto(c.reference) ?? texto(c.key) ?? texto(c.id),
    link: texto(c.link) ?? texto(c.url) ?? texto(c.self),
  };
}

// Qué se puede loguear de un fallo: el URL del webhook ES el secreto (estos
// webhooks suelen llevar el token en el path o en el query), y el mensaje de una
// excepción de red puede traerlo entero. Por eso se loguea SOLO el nombre del
// error y su `cause.code` (ECONNREFUSED, ETIMEDOUT, ...) — nunca el mensaje,
// nunca el URL, nunca el payload.
function motivoDeError(e: unknown): string {
  if (!(e instanceof Error)) return "error desconocido";
  const codigo = (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof codigo === "string" ? `${e.name} (${codigo})` : e.name;
}

/**
 * Fábrica de la tool: recibe el webhook (y opcionalmente `fetch` y el generador
 * de referencias) inyectados, así se testea sin red ni SST.
 */
export function crearEscalarAHumano(deps: DepsEscalamiento) {
  const hacerFetch = deps.fetch ?? globalThis.fetch;
  const generarReferencia =
    deps.generarReferencia ?? (() => `ESC-${randomUUID().slice(0, 8).toUpperCase()}`);
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  return async function escalarAHumano(
    entrada: EntradaEscalamiento,
  ): Promise<RespuestaEscalamiento> {
    const resumen = typeof entrada.resumen === "string" ? entrada.resumen.trim() : "";
    if (!resumen) return { creado: false, nota: NOTA_SIN_RESUMEN };
    if (!deps.webhookUrl) return { creado: false, nota: NOTA_SIN_WEBHOOK };

    // Los opcionales ausentes no viajan: `JSON.stringify` los borraría igual,
    // pero armarlo así deja el payload explícito y evita mandar `""`.
    const payload: Record<string, string> = { resumen };
    for (const [clave, valor] of [
      ["detalle", entrada.detalle],
      ["usuario", entrada.usuario],
      ["conversacion", entrada.conversacion],
    ] as const) {
      const limpio = texto(valor);
      if (limpio) payload[clave] = limpio;
    }

    let respuesta: Response;
    try {
      respuesta = await hacerFetch(deps.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error("el POST al webhook de escalamiento falló:", motivoDeError(e));
      return { creado: false, nota: NOTA_FALLO };
    }

    if (!respuesta.ok) {
      // Solo el status: ni el URL ni el cuerpo de la respuesta (que puede
      // reflejar el token del webhook).
      console.error("el webhook de escalamiento respondió con status", respuesta.status);
      return { creado: false, nota: NOTA_FALLO };
    }

    // Un 2xx sin cuerpo JSON (204, o un webhook que responde texto) es un
    // escalamiento creado igual: se sigue con una referencia generada.
    let cuerpo: unknown;
    try {
      cuerpo = await respuesta.json();
    } catch {
      cuerpo = undefined;
    }
    const { referencia, link } = datosDelTicket(cuerpo);
    return {
      creado: true,
      referencia: referencia ?? generarReferencia(),
      ...(link ? { link } : {}),
    };
  };
}

// ── Borde de infra: de acá para abajo, el pegamento con Lambda y SST ────────

let escalar: ReturnType<typeof crearEscalarAHumano> | undefined;

// Una sola tool por Lambda: no hay nada que rutear con el nombre que manda el
// Gateway.
export const handler = async (
  event: EntradaEscalamiento,
): Promise<RespuestaEscalamiento> => {
  // El webhook es un `sst.Secret` con default "": un stack sin el secreto
  // seteado despliega igual y la tool avisa que no hay destino (NOTA_SIN_WEBHOOK)
  // en vez de fallar el deploy.
  escalar ??= crearEscalarAHumano({ webhookUrl: Resource.EscalamientoWebhookUrl.value });
  return escalar(event ?? {});
};
