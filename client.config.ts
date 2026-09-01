// Configuración del proyecto: el ÚNICO archivo con valores propios. Los consumen
// `sst.config.ts` e `infra/sst/*`; no queda ningún valor de configuración suelto
// en el resto del IaC.
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
   * Días que se conserva la transcripción en MessagesTable, vía TTL de DynamoDB.
   *
   * No es solo housekeeping: esa tabla es también el historial que ve el modelo,
   * así que este número decide cuánto tiempo el chat "recuerda" y cuánto tiempo
   * quedan guardadas las conversaciones de los usuarios finales. Es una decisión
   * de política de datos del cliente.
   */
  retencionHistorialDias: number;

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
   * Es lo primero que se toca al configurar el proyecto: acá van el nombre de la
   * empresa, el tono, y qué está y qué no está en alcance.
   */
  promptSistema: string;

  /**
   * Observabilidad del agente (spec §17): cuánto resuelve, cuánto deriva, cuánto
   * cuesta y con qué detalle se puede mirar el interior de un turno.
   *
   * Las MÉTRICAS del servicio (el dashboard de `infra/sst/observabilidad.ts`) no
   * dependen de nada de acá: existen sin instrumentar. Lo que se configura acá es
   * la capa de TRAZAS — qué proporción se guarda, cuánto se ve de la
   * conversación, y a dónde van.
   */
  observabilidad: {
    /**
     * Proporción de trazas que se conserva, entre 0 y 1 (0.05 = 5%). Lo aplica el
     * contenedor como sampler (`parentbased_traceidratio`), así que la decisión se
     * toma una vez por conversación: la traza entera queda completa o no existe,
     * no se parte por la mitad.
     *
     * 1 (todo) es el default del SDK y **es la trampa de costo** de esta
     * capacidad: sin collector, exportar el 100% de los spans puede multiplicar
     * por veinte lo que cuesta la observabilidad. 0.05 alcanza para ver cómo se
     * comporta el agente; para perseguir un problema puntual se sube, se mira y
     * se baja.
     */
    muestreo: number;

    /**
     * Si las trazas llevan el CONTENIDO de la conversación (los mensajes del
     * usuario, la respuesta del modelo, el prompt de sistema) además de la forma
     * del turno.
     *
     * `false` por default, y es lo que corresponde: con esto apagado las trazas
     * siguen mostrando qué tools se llamaron, cuánto tardó cada paso y cuántos
     * tokens se gastaron —lo que hace falta para entender un turno— pero el texto
     * viaja redactado.
     *
     * Prenderlo con `destino: "otlp"` es una DECISIÓN DE RESIDENCIA DE DATOS, no
     * un ajuste de verbosidad: la conversación de los usuarios finales del
     * cliente sale de su cuenta de AWS y queda en un servicio de terceros. Se
     * acuerda con el cliente antes de tocar este campo, y suele necesitar que su
     * política de privacidad lo contemple.
     */
    contenidoEnTrazas: boolean;

    /**
     * A dónde van las trazas.
     *
     * - `"cloudwatch"`: a la cuenta del propio cliente (X-Ray / Transaction
     *   Search). Es el default y no necesita ningún secreto.
     * - `"otlp"`: a un endpoint OTLP externo. El endpoint y el header de auth van
     *   como secretos (`npx sst secret set ...`), nunca en este archivo: **el
     *   header lleva la credencial**.
     *
     * Solo mueve las TRAZAS. Las métricas y los logs siguen en CloudWatch: los
     * endpoints nativos son por señal, no uno solo para todo.
     */
    destino: "cloudwatch" | "otlp";

    /**
     * Porcentaje de spans que CloudWatch indexa para búsqueda (Transaction
     * Search, `AWS::XRay::TransactionSearchConfig`), entre 1 y 100.
     *
     * No es el sampler: `muestreo` decide qué spans se emiten, esto decide qué
     * proporción de los que llegaron se puede buscar después. Con un muestreo ya
     * bajo, indexar parcial es apostar dos veces al mismo azar: la traza que
     * buscás puede haber llegado y no estar indexada. Default 100.
     *
     * **Es un valor de CUENTA, no de stage:** dos stages en la misma cuenta
     * comparten la configuración y gana el último deploy (ver
     * `infra/sst/observabilidad.ts`).
     */
    indexadoTrazas: number;

    /**
     * Qué stage declara la configuración de búsqueda de transacciones de X-Ray.
     *
     * Esa configuración es de CUENTA, no de stage: si dos stages de la misma
     * cuenta la declaran, el segundo deploy corta con un AlreadyExists. Acá se
     * nombra al stage que la administra; los demás la consumen sin declararla,
     * porque ya está activa en la cuenta.
     *
     * El default (`""`) es que NADIE la declare: es un prerequisito de cuenta
     * que se activa una vez, fuera del stack (`aws xray
     * update-trace-segment-destination --destination CloudWatchLogs`), igual
     * que habilitar los modelos en Bedrock. Si ya está activa —lo normal— y un
     * stack la declara, el deploy corta con AlreadyExists.
     *
     * Poné acá el nombre de un stage solo si querés que ESE stack sea dueño de
     * la configuración de toda la cuenta.
     */
    stageQueAdministraLaBusqueda: string;
  };

  /** Guardrail de contenido y datos personales (`infra/sst/guardrail.ts`). */
  guardrail: {
    /**
     * Patrones propios de datos personales, además de las entidades que Bedrock
     * ya reconoce (email, teléfono, nombre, dirección, tarjetas, contraseñas).
     * Acá van los identificadores locales, que dependen del país.
     *
     * `accion`: `ANONYMIZE` deja seguir la conversación con el dato tapado;
     * `BLOCK` corta el turno.
     *
     * Ojo con los patrones amplios: un patrón de 7-8 dígitos sueltos anonimiza
     * números de pedido, importes y códigos de producto, y el agente pierde
     * justo el dato que necesita para responder.
     */
    regexPii: { nombre: string; patron: string; descripcion?: string; accion: "ANONYMIZE" | "BLOCK" }[];
  };

  /**
   * Ingesta de documentos desde Confluence. Las CREDENCIALES no van acá (son
   * `sst.Secret`): esto es la configuración de qué se ingesta.
   */
  confluence: {
    /**
     * Allowlist de espacios por su key (p. ej. `["SOP", "RRHH"]`). Vacía ⇒ el
     * ingestor no hace nada, que es el default: nadie ingesta un espacio por
     * accidente.
     */
    espacios: string[];
    /** URL público del sitio, para armar el link de cada página en la metadata. */
    sitioUrl: string;
    /**
     * Si también se ingestan los adjuntos de cada página (PDF, DOCX, planillas).
     * Suma una llamada por página y descarga binarios: con muchos adjuntos la
     * corrida se alarga bastante.
     */
    adjuntos: boolean;

    /**
     * Cuándo corre la ingesta, en formato cron de EventBridge Scheduler
     * (`cron(minutos horas díaDelMes mes díaDeLaSemana año)`).
     *
     * De madrugada: la corrida golpea la API de Confluence y dispara una
     * re-indexación, y ninguna de las dos cosas conviene en horario de uso.
     */
    horario: string;

    /**
     * Zona horaria del `horario`, en formato IANA. Es la razón de usar
     * EventBridge Scheduler y no una regla de EventBridge: las reglas corren
     * siempre en UTC, así que "3 de la mañana" se corre solo dos veces al año.
     */
    zonaHoraria: string;

    /**
     * Tope de pedidos por segundo contra la API de Confluence. El ingestor
     * espera entre llamadas para no pasarse, y ante un 429 reintenta respetando
     * el `Retry-After`.
     *
     * Ojo con bajarlo mucho: la Lambda corta a los 10 minutos, así que el rate
     * fija cuántas páginas entran en una corrida. A 5 req/s son ~250 páginas en
     * menos de un minuto; a 0,1 req/s no llegan ni 60.
     */
    maxReqPorSegundo: number;
  };

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

    /**
     * Reranking gestionado de los pasajes recuperados (spec §11). Un reranker
     * reordena lo que devolvió la búsqueda por relevancia real a la pregunta.
     *
     * En una Knowledge Base gestionada no hay modelo que elegir ni acceso que
     * habilitar: AWS lo opera. Es `true` por default porque mejora la relevancia
     * sin costo de configuración; se apaga si se quiere el orden crudo de la
     * búsqueda o para comparar.
     */
    rerankingGestionado: boolean;
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
  retencionHistorialDias: 30,
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
    "5. Derivá SOLO si la persona acepta explícitamente. Recién ahí usá la tool `escalar_a_humano`, y pasale lo que la tool confirme: la referencia del escalamiento si la devolvió, o si no, la nota que explica por dónde le va a llegar. No inventes una referencia.",
    "6. Nunca digas que derivaste una consulta si la tool no confirmó que el escalamiento se creó. Si falló, decile que no pudiste derivarla y qué puede hacer mientras tanto.",
    "7. No pidas ni repitas datos sensibles (tarjetas, contraseñas, documentos de identidad). Si te los mandan, seguí sin usarlos.",
  ].join("\n"),
  observabilidad: {
    // 5% de las conversaciones. Ver el doc del campo: subirlo a 1 es la forma
    // más rápida de multiplicar la factura de observabilidad.
    muestreo: 0.05,
    // Redactado por default. Prenderlo es una decisión de residencia de datos,
    // no un ajuste de verbosidad.
    contenidoEnTrazas: false,
    // A la cuenta del cliente. `"otlp"` exige los dos secretos del endpoint.
    destino: "cloudwatch",
    // Indexar todo lo que llega: con el muestreo al 5% no sobra nada.
    indexadoTrazas: 100,
    stageQueAdministraLaBusqueda: "",
  },
  guardrail: {
    // Vacío: los identificadores locales los declara el cliente.
    regexPii: [],
  },
  confluence: {
    espacios: [],
    sitioUrl: "",
    adjuntos: false,
    horario: "cron(0 3 * * ? *)",
    zonaHoraria: "UTC",
    maxReqPorSegundo: 5,
  },
  documentos: {
    topK: 5,
    rerankingGestionado: true,
  },
};
