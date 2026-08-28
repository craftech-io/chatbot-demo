// Configuración por cliente: el ÚNICO archivo que se toca al adoptar el
// template en el repo de un cliente. Todo lo específico de un cliente se
// declara acá y lo consumen `sst.config.ts` e `infra/sst/*`; no queda ningún
// valor de cliente suelto en el resto del IaC.
//
// A propósito NO depende de los globals de SST (`$app`, `aws`, `awsnative`,
// `$interpolate`, ...) ni de nada de `infra/`: es dato plano, así lo puede leer
// cualquier sabor de IaC (ver `infra/CONTRACT.md`) y no solo `infra/sst/`.
//
// Los nombres FÍSICOS de los recursos se derivan del `slug` en
// `infra/sst/nombres.ts`, que traduce ese único valor a los alfabetos distintos
// que exige AWS (ECR/Guardrail/Gateway en minúsculas con guiones; AgentCore
// Runtime y Memory en camelCase, que acepta `_` y no `-`). OJO: cambiar el
// `slug` de un stack YA desplegado cambia esos nombres físicos y RECREA los
// recursos (el Runtime, el Gateway, la Memory y el repo ECR). Se elige una vez,
// al clonar.

export interface ConfigCliente {
  /**
   * Identificador del cliente. Se usa como nombre de la app de SST (y por lo
   * tanto como prefijo de los nombres autogenerados) y como prefijo de los
   * nombres físicos que se declaran a mano.
   *
   * Forma exigida: kebab-case en minúsculas empezando por letra
   * (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), p.ej. `acme-chat`. Con esa forma las
   * traducciones de `infra/sst/nombres.ts` son seguras en los tres alfabetos;
   * `infra/sst/nombres.ts` la valida en synth para no comerse un
   * ValidationException opaco al crear el recurso.
   *
   * Corto, además: el nombre del Gateway es `<slug>-gw-<stage>` y el servicio
   * lo limita a 48 caracteres.
   */
  slug: string;

  /**
   * `MODEL_ID` de Bedrock que recibe el core (ver `infra/CONTRACT.md`): un
   * foundation model o un inference profile. El prefijo `us.` de los inference
   * profiles rutea a las regiones hermanas del profile — la policy del
   * RuntimeRole ya contempla ese caso.
   *
   * El modelo tiene que estar habilitado en Bedrock en la cuenta y la región
   * del deploy.
   */
  modelo: string;

  /**
   * Región de AWS donde se despliega todo. `AWS_REGION` del entorno tiene
   * precedencia sobre este valor, para que CI o una prueba local puedan
   * apuntar a otra región sin editar el archivo.
   */
  region: string;

  /**
   * Topes de uso por usuario que aplica el BFF (`LIMITE_DIARIO` y
   * `LIMITE_POR_SESION`, ver `infra/CONTRACT.md`). El cliente paga su propio
   * Bedrock: sin topes, la primera factura sorpresa se come la relación.
   */
  topes: {
    /** Máximo de llamadas por usuario por día. */
    diario: number;
    /** Máximo de turnos por sesión. */
    porSesion: number;
  };

  /**
   * Orígenes permitidos en la Function URL del BFF. `["*"]` acepta cualquiera:
   * lo que protege el chat es el token del cliente (JWKS/HMAC), no el origen.
   * Un cliente con dominios fijos los lista acá (`["https://www.acme.com"]`)
   * para cerrar también esa puerta.
   */
  origenesCors: string[];

  /**
   * Días que AgentCore Memory retiene los eventos de la conversación
   * (short-term). 30 alinea con la retención típica de un chat; subirlo o
   * bajarlo es una decisión de política de datos del cliente.
   */
  retencionMemoriaDias: number;

  /**
   * Prompt del sistema del agente: la POLÍTICA de comportamiento (spec §11.2).
   * Viaja al core como `PROMPT_SISTEMA` (ver `infra/CONTRACT.md`) y entra como
   * mensaje `system` al principio de cada turno.
   *
   * Vacío ⇒ el core corre sin mensaje de sistema (el comportamiento previo a
   * esta capacidad). El default codifica la política del spec: no inventar,
   * citar la fuente, y ofrecer derivar a una persona cuando la respuesta no
   * está en los documentos.
   *
   * Es lo primero que se toca al adoptar el template: acá van el nombre de la
   * empresa, el tono, y qué está y qué no está en alcance.
   */
  promptSistema: string;

  /** Ajustes de la búsqueda en los documentos (la Knowledge Base, spec §11). */
  documentos: {
    /**
     * Cuántos pasajes devuelve cada búsqueda (el `numberOfResults` del Retrieve
     * de Bedrock) cuando la llamada de la tool no pide otro número.
     *
     * Trade-off: más pasajes = más contexto y menos chance de que el dato bueno
     * quede afuera, pero también más ruido (pasajes apenas relacionados que el
     * modelo puede tomar como respuesta), más tokens de entrada y más latencia.
     * 5 es el punto razonable para un corpus chico de documentos de negocio;
     * con un corpus grande y homogéneo conviene subirlo.
     */
    topK: number;
  };
}

export const cliente: ConfigCliente = {
  slug: "craftech-ai-chat",
  modelo: "us.anthropic.claude-sonnet-4-6",
  region: "us-east-1",
  topes: {
    diario: 50,
    porSesion: 40,
  },
  origenesCors: ["*"],
  retencionMemoriaDias: 30,
  // Se arma con `join("\n")` y no con un template literal multilínea para que la
  // indentación del archivo no se cuele en el prompt (el modelo la lee como
  // parte del texto). Sigue siendo dato plano: sin globals de SST, sin imports.
  //
  // Las tools se nombran por su nombre exacto (`consultar_documentos`,
  // `escalar_a_humano`). Ojo: AgentCore suele prefijar las tools MCP con el
  // nombre del target (`<target>___<tool>`), así que lo que ve el modelo puede
  // llevar prefijo — igual reconoce el sufijo, y el punto del prompt es CUÁNDO
  // usar cada una, no clavar el identificador.
  promptSistema: [
    "Sos el asistente virtual de la empresa. Respondés en el idioma en el que te escriben, con precisión y sin rodeos.",
    "",
    "Reglas que no se negocian:",
    "",
    "1. Antes de responder cualquier cosa sobre la empresa, sus productos, sus precios, sus plazos o sus políticas, buscá en los documentos con la tool `consultar_documentos`. No respondas de memoria ni por sentido común.",
    "2. Respondé SOLO con lo que digan los documentos o lo que devuelvan las tools. Si el dato no está ahí, no lo sabés: no lo completes, no lo estimes y no lo generalices desde un caso parecido.",
    "3. Citá siempre de dónde sacaste el dato, con el título o el nombre del documento, para que la persona pueda verificarlo.",
    "4. Si los documentos no tienen la respuesta, decilo con claridad —sin disculpas largas— y ofrecé derivar la consulta a una persona del equipo.",
    "5. Derivá SOLO si la persona acepta explícitamente. Recién ahí usá la tool `escalar_a_humano`, y devolvele la referencia del escalamiento que la tool confirme.",
    "6. Nunca digas que derivaste una consulta si la tool no confirmó que el escalamiento se creó. Si falló, decile que no pudiste derivarla y qué puede hacer mientras tanto.",
    "7. No pidas ni repitas datos sensibles (tarjetas, contraseñas, documentos de identidad). Si te los mandan, seguí sin usarlos.",
  ].join("\n"),
  documentos: {
    topK: 5,
  },
};
