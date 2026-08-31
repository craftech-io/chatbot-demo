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
//   entrada  { resumen, detalle? }
//   salida   { creado: true, referencia?, link?, nota? } | { creado: false, nota }
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
// Por qué la entrada NO lleva `usuario` ni `conversacion`: el core le manda al
// Gateway solo los argumentos que armó el MODELO, y el modelo no tiene el actor
// ni el id de sesión en contexto — declararlos en el schema los volvía campos
// que llegan vacíos o inventados. Hoy el humano retoma el caso por el canal que
// nombre el `resumen`. Inyectarlos del lado del servidor (el core sí los tiene)
// es una fase futura, no un olvido.
//
// Regla dura: si el POST no fue 2xx, esta tool NUNCA dice que creó el
// escalamiento. Mentirle al usuario ("ya te derivé") cuando el ticket no
// existe es el peor resultado posible de esta capacidad. La otra mitad de la
// misma regla: si el webhook no devolvió referencia, la tool NO se la inventa
// —una referencia con formato de ticket que ningún sistema conoce es una
// mentira igual de cara— y avisa por dónde llega.
//
// Sobre `Resource` en packages/bff: igual que en ./documentos.ts — la lógica
// recibe el webhook inyectado y solo el `handler` del final lee SST, como borde
// de infra de ESTA Lambda (ver la excepción sancionada en config/resource.ts).
import { Resource } from "sst";
import { configuradoJsm, crearAdaptadorJsm } from "./jsm";

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
// 2xx sin referencia en el cuerpo: el caso ESTÁ creado (por eso `creado: true`),
// pero no hay identificador que darle al usuario. Es texto para transmitir tal
// cual, no un error.
export const NOTA_SIN_REFERENCIA =
  "El caso quedó recibido, pero el sistema de soporte no devolvió una referencia para darle al usuario: le va a llegar por el canal de soporte.";
// Nota propia para el 3xx: no es una caída del sistema de soporte, es el URL
// configurado. Lo dice explícito para que el operador que lea la conversación
// (o el log) sepa dónde mirar en vez de reintentar contra un destino que jamás
// va a recibir el POST.
export const NOTA_REDIRECCION =
  "No pude confirmar el escalamiento: el destino configurado redirige a otra dirección, así que el pedido nunca llegó. Hay que revisar el URL del webhook de escalamiento (suele ser `http://` en vez de `https://`, o una barra final de más).";

export type EntradaEscalamiento = {
  /** Qué necesita el usuario, en una o dos frases. Obligatorio. */
  resumen?: string;
  /** Contexto adicional del caso. */
  detalle?: string;
};

export type RespuestaEscalamiento =
  // `referencia` es opcional a propósito: hay webhooks que aceptan el caso y no
  // devuelven identificador. En ese caso viaja `nota` en su lugar.
  | { creado: true; referencia?: string; link?: string; nota?: string }
  | { creado: false; nota: string };

type DepsEscalamiento = {
  /** URL del webhook. Vacía ⇒ la tool avisa que no hay destino y no postea. */
  webhookUrl: string;
  /** Inyectable para testear sin red. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

function texto(valor: unknown): string | undefined {
  if (typeof valor === "string") return valor.trim() || undefined;
  // Varios sistemas devuelven ids numéricos.
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return undefined;
}

// ¿Este candidato es el webhook disfrazado de dato del ticket? La comparación es
// por ORIGEN y no por URL entera porque el token suele viajar en el path o en el
// query: `https://hooks.zapier.com/hooks/catch/123/abc` y
// `https://hooks.zapier.com/hooks/catch/123/abc/` son el mismo secreto.
function esDelWebhook(candidato: string, webhookUrl: string): boolean {
  try {
    return new URL(candidato).origin === new URL(webhookUrl).origin;
  } catch {
    // Un id que no es un URL absoluto (`ESC-42`, `12345`) no puede ser el
    // webhook. Tampoco lo es si el webhook configurado no parsea (y en ese caso
    // el POST ni salió).
    return false;
  }
}

// Del cuerpo del webhook se rescatan la referencia y el link del ticket, con los
// nombres más habituales: `key` es lo de Atlassian, `id`/`reference` lo de casi
// todo lo demás.
//
// Lo que sale de acá viaja al modelo y de ahí AL USUARIO (el schema le dice que
// le pase la referencia y el link), y el URL del webhook ES el secreto. El
// cuerpo de la respuesta no es de fiar: un catch-hook de Zapier —y los "webhook
// testers" en general— devuelve el hook COMPLETO, con token, en su 200. Por eso:
//   - el link sale SOLO de `link`, explícito: `url` y `self` son justo las
//     claves donde esos servicios reflejan el hook, no un link para el usuario;
//   - y se descarta cualquier candidato del mismo origen que el webhook
//     configurado. Cuesta un falso negativo (un ticket realmente publicado en
//     el mismo host que el webhook pierde su link) y es el lado correcto del
//     error: un link de menos se nota, un token de más no.
function datosDelTicket(
  cuerpo: unknown,
  webhookUrl: string,
): { referencia?: string; link?: string } {
  if (!cuerpo || typeof cuerpo !== "object") return {};
  const c = cuerpo as Record<string, unknown>;
  const sinSecreto = (valor: unknown) => {
    const limpio = texto(valor);
    return limpio && !esDelWebhook(limpio, webhookUrl) ? limpio : undefined;
  };
  return {
    referencia:
      sinSecreto(c.referencia) ?? sinSecreto(c.reference) ?? sinSecreto(c.key) ?? sinSecreto(c.id),
    link: sinSecreto(c.link),
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
 * Fábrica de la tool: recibe el webhook (y opcionalmente `fetch`) inyectados,
 * así se testea sin red ni SST.
 */
export function crearEscalarAHumano(deps: DepsEscalamiento) {
  const hacerFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  return async function escalarAHumano(
    entrada: EntradaEscalamiento,
  ): Promise<RespuestaEscalamiento> {
    const resumen = typeof entrada.resumen === "string" ? entrada.resumen.trim() : "";
    if (!resumen) return { creado: false, nota: NOTA_SIN_RESUMEN };
    if (!deps.webhookUrl) return { creado: false, nota: NOTA_SIN_WEBHOOK };

    // Payload explícito, campo por campo: los opcionales ausentes no viajan
    // (`JSON.stringify` los borraría igual, pero así no se manda `""`) y nada
    // que el modelo agregue por su cuenta —una identidad inventada, p. ej.—
    // llega al sistema del cliente.
    const payload: Record<string, string> = { resumen };
    const detalle = texto(entrada.detalle);
    if (detalle) payload.detalle = detalle;

    let respuesta: Response;
    try {
      respuesta = await hacerFetch(deps.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        // NO el default (`follow`): en 301/302/303 fetch cambia el método a GET
        // y descarta el body, así que el POST se pierde, el GET devuelve 200 y
        // la tool afirmaría que creó un escalamiento que no existe. Con
        // `manual` el 3xx vuelve como tal y se trata como fallo (abajo).
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error("el POST al webhook de escalamiento falló:", motivoDeError(e));
      return { creado: false, nota: NOTA_FALLO };
    }

    // Un 3xx no es "el sistema de soporte respondió mal": es el URL configurado.
    // Se chequea aparte del `!ok` de abajo por la nota, y se aceptan las dos
    // formas posibles — el 3xx crudo (lo que hace undici) y la respuesta
    // filtrada `opaqueredirect` con status 0 que permite el spec de fetch.
    const redirige =
      respuesta.type === "opaqueredirect" || (respuesta.status >= 300 && respuesta.status < 400);
    if (redirige) {
      console.error(
        "el webhook de escalamiento redirige (status",
        respuesta.status,
        "): el POST no se reenvía a un redirect, revisar el URL configurado",
      );
      return { creado: false, nota: NOTA_REDIRECCION };
    }

    if (!respuesta.ok) {
      // Solo el status: ni el URL ni el cuerpo de la respuesta (que puede
      // reflejar el token del webhook).
      console.error("el webhook de escalamiento respondió con status", respuesta.status);
      return { creado: false, nota: NOTA_FALLO };
    }

    // Un 2xx sin cuerpo JSON (204, o un webhook que responde texto) es un
    // escalamiento creado igual: lo que falta es la referencia, no el caso.
    let cuerpo: unknown;
    try {
      cuerpo = await respuesta.json();
    } catch {
      cuerpo = undefined;
    }
    const { referencia, link } = datosDelTicket(cuerpo, deps.webhookUrl);
    return {
      creado: true,
      ...(referencia ? { referencia } : { nota: NOTA_SIN_REFERENCIA }),
      ...(link ? { link } : {}),
    };
  };
}

// ── Borde de infra: de acá para abajo, el pegamento con Lambda y SST ────────

let escalar:
  | ReturnType<typeof crearEscalarAHumano>
  | ReturnType<typeof crearAdaptadorJsm>
  | undefined;

// Una sola tool por Lambda: no hay nada que rutear con el nombre que manda el
// Gateway.
export const handler = async (
  event: EntradaEscalamiento,
): Promise<RespuestaEscalamiento> => {
  // El webhook es un `sst.Secret` con default "": un stack sin el secreto
  // seteado despliega igual y la tool avisa que no hay destino (NOTA_SIN_WEBHOOK)
  // en vez de fallar el deploy.
  if (!escalar) {
    const jsm = {
      clientId: Resource.AtlassianClientId.value,
      clientSecret: Resource.AtlassianClientSecret.value,
      cloudId: Resource.AtlassianCloudId.value,
      serviceDeskId: Resource.JsmServiceDeskId.value,
      requestTypeId: Resource.JsmRequestTypeId.value,
    };
    escalar = configuradoJsm(jsm)
      ? crearAdaptadorJsm(jsm)
      : crearEscalarAHumano({ webhookUrl: Resource.EscalamientoWebhookUrl.value });
  }
  return escalar(event ?? {});
};
