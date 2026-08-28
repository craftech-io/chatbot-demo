// Observabilidad (spec §17), capa 1 y la infra que habilita la capa 2.
//
// Tres piezas, y ninguna instrumenta el código del agente:
//   1. `busquedaDeTransacciones` (`AWS::XRay::TransactionSearchConfig`): sin esto
//      AgentCore no publica sus spans en CloudWatch. Es un recurso de CUENTA —
//      ver la nota larga abajo, es la trampa de este archivo.
//   2. `trazasActivas` + `permisosTrazas`: lo que cada Lambda del stack pone en
//      sus args para que X-Ray una la traza de punta a punta (BFF → cola →
//      worker → Runtime). Sin esto la traza se corta justo en el debounce.
//   3. `crearDashboard()`: el tablero que lee las métricas que el servicio YA
//      emite (namespace `AWS/Bedrock-AgentCore`), sin agregar un solo span
//      nuestro. Es lo que el cliente mira.
//
// POR QUÉ ESTE MÓDULO NO IMPORTA NINGÚN OTRO DE infra/sst (salvo ./nombres):
// las cuatro Lambdas del stack importan `trazasActivas` de acá, y una de ellas
// es `./api-cliente`, de la que cuelga `./gateway` y de ahí `./runtime` y
// `./tools`. Si este módulo importara esos para armar el dashboard, el ciclo
// `api-cliente → observabilidad → gateway → api-cliente` rompería la carga de
// módulos (los módulos de infra crean recursos como efecto de importarse). Por
// eso el dashboard es una FUNCIÓN que recibe los nombres ya resueltos, y la
// llama `sst.config.ts`, que es el único lugar donde todos los módulos ya están
// cargados. Los nombres siguen saliendo de los módulos de infra: ninguno se
// escribe a mano acá.
import { cliente } from "../../client.config";
import { slugKebab } from "./nombres";

// Namespaces de CloudWatch. `AWS/Bedrock-AgentCore` va con GUION, no con
// barra ni con `AgentCore` pegado: es el nombre real y no lo valida nada
// (un namespace inexistente da un widget vacío, no un error de deploy).
const NS_AGENTCORE = "AWS/Bedrock-AgentCore";
// Los tokens del modelo NO los publica AgentCore: los publica Bedrock, en su
// propio namespace y con `ModelId` como única dimensión.
const NS_BEDROCK = "AWS/Bedrock";

// Alfabeto del nombre de un dashboard: `[A-Za-z0-9_-]` (ni espacios ni `:`),
// así que el stage se sanea igual que en los otros módulos.
const stageSaneado = $app.stage
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Región del provider activo, sin hardcodes (sale de `AWS_REGION` o de
// `cliente.region`, ver sst.config.ts). Cada widget de un dashboard declara su
// propia región: sin esto CloudWatch asume la del navegador.
// `.name` en GetRegionResult está deprecado a favor de `.region`.
const region = aws.getRegionOutput().region;

// ---------------------------------------------------------------------------
// 1. Transaction Search: el interruptor de las trazas, a nivel CUENTA
// ---------------------------------------------------------------------------
//
// AgentCore no tiene NINGÚN campo de observabilidad en sus recursos (ni el
// Runtime ni el Gateway): lo único que se declara es este recurso de X-Ray, y
// sin él los spans del servicio no llegan a CloudWatch (ni los nuestros al
// endpoint OTLP de `xray.<region>.amazonaws.com`, que exige Transaction Search).
//
// ES UN RECURSO DE CUENTA, NO DE STAGE. Su identidad es la cuenta de AWS: dos
// stages en la misma cuenta (p.ej. `dev` y un `pr-123` de preview) declaran DOS
// recursos de Pulumi que apuntan a LA MISMA configuración real. Consecuencias,
// todas silenciosas:
//
//   - Borrar un stack borraría la configuración de la cuenta y dejaría ciego al
//     otro stage, sin que nada falle. De ahí `retainOnDelete: true`: al destruir
//     el stack el recurso sale del state y la configuración queda prendida.
//     No se pierde nada: este recurso no guarda datos, es un flag de cuenta.
//   - Al revés: cuando el ÚLTIMO stack de la cuenta se va, la configuración
//     queda prendida (y sigue costando el indexado). Apagarla es un acto
//     deliberado, desde la consola de CloudWatch (Transaction Search) o con la
//     API de X-Ray.
//   - `indexadoTrazas` es de cuenta también: si dos stages lo declaran distinto,
//     gana el último deploy. Es un valor por cuenta, no por stage.
//   - Si un segundo stage en la misma cuenta falla al CREAR el recurso porque ya
//     existe, el arreglo NO es bajar `retainOnDelete`: es adoptar el recurso
//     existente al state de ese stack (`sst state` / `pulumi import`, con la
//     cuenta como id) en vez de crearlo de nuevo.
//
// `indexingPercentage` es el porcentaje de spans que se INDEXAN para búsqueda,
// no el sampler del SDK (ese es `cliente.observabilidad.muestreo`, y lo aplica
// el contenedor). Con el muestreo bajo conviene indexar todo lo que llega: si
// además se indexa parcial, la traza que buscás puede no existir.
//
// El `.d.ts` del recurso expone `accountId` como OUTPUT (read-only): el único
// argumento de entrada es `indexingPercentage`. No hay nada de nuestra cuenta
// escrito acá.
// La búsqueda de transacciones de X-Ray es un **prerequisito de CUENTA**, de la
// misma familia que habilitar los modelos en Bedrock: se activa una vez por
// cuenta y región, y a partir de ahí todos los stacks la usan.
//
// Por eso el default es NO declararla, y no es timidez: modelarla como recurso
// del stack rompe de dos formas distintas, las dos verificadas en una cuenta
// real. Si dos stages la declaran, el segundo deploy corta con AlreadyExists. Y
// si alguien ya la activó a mano —lo normal, porque es el primer paso de la guía
// de AgentCore— el PRIMER deploy corta, aunque sea el único stage.
//
// Un cliente que la quiera bajo IaC pone su stage en
// `observabilidad.stageQueAdministraLaBusqueda`, sabiendo que ese stack pasa a
// ser dueño de una configuración de toda la cuenta. Con el default (`""`) nadie
// la declara y el prerequisito se cumple una vez, fuera del stack:
//
//   aws xray update-trace-segment-destination --destination CloudWatchLogs
//
// Sin ella, AgentCore no publica sus spans en CloudWatch y las trazas del agente
// no aparecen en ningún lado — el deploy sigue verde, así que conviene
// verificarla con `aws xray get-trace-segment-destination`.
export const busquedaDeTransacciones =
  cliente.observabilidad.stageQueAdministraLaBusqueda !== "" &&
  cliente.observabilidad.stageQueAdministraLaBusqueda === $app.stage
    ? new awsnative.xray.TransactionSearchConfig(
        "TransactionSearch",
        { indexingPercentage: cliente.observabilidad.indexadoTrazas },
        { retainOnDelete: true },
      )
    : undefined;

// ---------------------------------------------------------------------------
// 2. Tracing activo en las Lambdas del stack
// ---------------------------------------------------------------------------
//
// `sst.aws.Function` NO tiene una prop `tracing` (verificado en
// `.sst/platform/src/components/aws/function.ts` de sst 4.17.1: la palabra no
// aparece en el componente). El tracing se prende en el recurso de abajo, el
// `aws.lambda.Function`, por el escape hatch `transform.function` que el propio
// componente documenta — `tracingConfig.mode: "Active"`, el único valor que
// genera segmentos propios (`PassThrough` solo propaga los del llamador).
//
// Se exporta como constante compartida en vez de repetirla en los cuatro
// módulos de Lambdas: el día que cambie el modo, cambia acá.
export const trazasActivas: Partial<aws.lambda.FunctionArgs> = {
  tracingConfig: { mode: "Active" },
};

// El tracing activo NO trae sus permisos puestos: el rol que arma
// `sst.aws.Function` lleva solo `AWSLambdaBasicExecutionRole`, así que sin estas
// dos acciones Lambda no puede publicar el segmento y no hay traza — sin error
// de deploy y sin nada visible más que el dashboard vacío.
//
// `resources: ["*"]` no es una concesión: ninguna de las dos acciones de X-Ray
// soporta scope por recurso.
export const permisosTrazas = [
  {
    actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
    resources: ["*"],
  },
];

// ---------------------------------------------------------------------------
// 3. El dashboard
// ---------------------------------------------------------------------------

/** Lo que el dashboard necesita saber, todo desde los módulos de infra. */
export interface ArgsDashboard {
  /** `runtime.agentRuntimeArn` de ./runtime — dimensión `Resource` del Runtime. */
  runtimeArn: $util.Input<string>;
  /** `gateway.gatewayArn` de ./gateway — dimensión `Resource` del Gateway. */
  gatewayArn: $util.Input<string>;
  /**
   * Nombre MCP completo de la tool de escalamiento, con el prefijo del target
   * (`escalamiento___escalar_a_humano`). Sale de ./tools, que es donde se
   * declaran el target y el schema: si alguien renombra el target, el dashboard
   * lo sigue.
   */
  toolEscalamiento: $util.Input<string>;
}

// Una búsqueda de CloudWatch (`SEARCH`) y no una lista explícita de métricas con
// sus dimensiones. Por qué:
//
// El spike verificó el namespace, los nombres de métrica y las dimensiones que
// existen (`Resource` = ARN del recurso, `Name` = nombre de la tool,
// `Method` = operación MCP), pero las métricas vendidas se publican en VARIOS
// juegos de dimensiones a la vez (la doc de AgentCore muestra desde `[Resource]`
// hasta `[Operation, Protocol, Method, Resource, Name]`). Una entrada explícita
// tiene que matchear un juego EXACTO: si le sobra o le falta una dimensión, el
// widget sale vacío y parece que no hay datos. Una búsqueda matchea cualquier
// juego que contenga los pares que se le piden, así que sobrevive a que el
// servicio agregue o quite una dimensión.
//
// El scope por `Resource` (el ARN, que sale del módulo de infra) es lo que hace
// que dos stages en la misma cuenta no se sumen entre sí.
//
// Si algún widget sale vacío, el juego real de dimensiones se lista con:
//   aws cloudwatch list-metrics --namespace AWS/Bedrock-AgentCore
const busqueda = (terminos: string, estadistica: string) =>
  `SEARCH(' ${terminos} ', '${estadistica}')`;

const sesionesNuevas = (runtimeArn: string) =>
  busqueda(`Namespace="${NS_AGENTCORE}" MetricName="Sessions" Resource="${runtimeArn}"`, "Sum");

const llamadasAEscalamiento = (gatewayArn: string, tool: string) =>
  busqueda(
    `Namespace="${NS_AGENTCORE}" MetricName="Invocations" Resource="${gatewayArn}" Name="${tool}"`,
    "Sum",
  );

/**
 * Crea el dashboard del stack. Se llama desde `sst.config.ts` (ver la nota de
 * arriba sobre por qué este módulo no importa los otros).
 */
export function crearDashboard(args: ArgsDashboard) {
  const cuerpo = $resolve([args.runtimeArn, args.gatewayArn, args.toolEscalamiento, region]).apply(
    ([runtimeArn, gatewayArn, tool, reg]) => {
      const busquedaSesiones = sesionesNuevas(runtimeArn);
      const busquedaDerivaciones = llamadasAEscalamiento(gatewayArn, tool);

      // LA MÉTRICA DEL TABLERO, y el cuidado con cómo se la rotula.
      //
      // Numerador: llamadas a la tool de escalamiento en el Gateway.
      // Denominador: sesiones NUEVAS del Runtime en el mismo período.
      //
      // Eso NO es una tasa de resolución, y el rótulo no puede prometer más que
      // el dato:
      //   - el numerador mide el INTENTO de derivar, no que el escalamiento se
      //     haya creado (eso lo confirma la tool, y sale en sus logs);
      //   - una sesión puede llamar la tool más de una vez, así que el valor
      //     puede pasar de 100;
      //   - una derivación de una sesión abierta en un período anterior cae en
      //     este período y no en el de su sesión;
      //   - y "no derivó" no significa "resolvió bien": significa que no llamó
      //     la tool.
      // Sirve como cota y sobre todo como TENDENCIA: si sube, el agente está
      // resolviendo menos de lo que resolvía.
      //
      // Se escribe como UNA expresión autocontenida (con las dos búsquedas
      // adentro) en vez de dos expresiones ocultas más una división que las
      // referencia: `SUM(SEARCH(...))` colapsa la búsqueda a una sola serie y
      // dividir dos de esas es una expresión válida por sí sola, sin depender de
      // que CloudWatch permita referenciar una expresión que contiene un SEARCH.
      const porcentajeDerivacion = `100 * SUM(${busquedaDerivaciones}) / SUM(${busquedaSesiones})`;

      // Defaults de todos los widgets. Sin `stat`: cada serie lleva su
      // estadística adentro del `SEARCH`, un default acá solo confundiría.
      const comun = { region: reg, period: 300 };

      return {
        widgets: [
          {
            type: "text",
            x: 0,
            y: 0,
            width: 24,
            height: 4,
            properties: {
              markdown: [
                `## Chat del agente — \`${$app.stage}\``,
                "",
                "**Derivaciones sobre conversaciones nuevas** es el widget de acá abajo, a la izquierda:",
                "llamadas a la tool de escalamiento por cada 100 sesiones nuevas. Es una **cota y una",
                "tendencia, no una tasa de resolución**: cuenta el *intento* de derivar (no que el",
                "escalamiento se haya creado), una misma conversación puede derivar más de una vez, y que",
                "no haya derivado no significa que haya respondido bien. Si la línea sube, el agente está",
                "resolviendo menos que antes; el porqué está en las trazas.",
                "",
                "Ojo con el vacío: la métrica de la tool no existe hasta la primera derivación, así que",
                "**\"sin datos\" es también el estado bueno** (nadie derivó). Si el widget está vacío y",
                "querés distinguirlo de un problema, mirá el de invocaciones del Gateway: si ahí llegan",
                "métricas, el tablero está sano.",
                "",
                "Los tokens son del namespace `AWS/Bedrock` y son de la CUENTA, no del stage: incluyen el",
                "modelo de embeddings de la Knowledge Base y cualquier otro consumidor de Bedrock.",
              ].join("\n"),
            },
          },
          {
            type: "metric",
            x: 0,
            y: 4,
            width: 12,
            height: 7,
            properties: {
              ...comun,
              view: "timeSeries",
              title: "Derivaciones sobre conversaciones nuevas (%)",
              metrics: [
                [
                  {
                    expression: porcentajeDerivacion,
                    id: "derivPorSesion",
                    label: "Llamadas a la tool de escalamiento por 100 sesiones nuevas",
                  },
                ],
              ],
              yAxis: { left: { min: 0, label: "%", showUnits: false } },
            },
          },
          {
            type: "metric",
            x: 12,
            y: 4,
            width: 12,
            height: 7,
            properties: {
              ...comun,
              view: "singleValue",
              title: "Conversaciones y derivaciones (total del período)",
              // Los dos crudos, al lado del porcentaje: un 50% sobre 2 sesiones
              // y un 50% sobre 2000 no son el mismo dato.
              metrics: [
                [
                  {
                    expression: `SUM(${busquedaSesiones})`,
                    id: "sesiones",
                    label: "Sesiones nuevas",
                  },
                ],
                [
                  {
                    expression: `SUM(${busquedaDerivaciones})`,
                    id: "derivaciones",
                    label: `Llamadas a ${tool}`,
                  },
                ],
              ],
            },
          },
          {
            type: "metric",
            x: 0,
            y: 11,
            width: 12,
            height: 7,
            properties: {
              ...comun,
              view: "timeSeries",
              title: "Latencia del turno completo (Runtime, ms)",
              // `MAX(SEARCH(...))` y no `SEARCH(...)` pelado: la búsqueda puede
              // devolver el mismo percentil en varios juegos de dimensiones y el
              // widget mostraría líneas duplicadas. Todas las series matcheadas
              // son de ESTE runtime (la búsqueda está acotada por `Resource`),
              // así que colapsarlas con el máximo no mezcla agentes.
              metrics: (["p50", "p90", "p99"] as const).map((p) => [
                {
                  expression: `MAX(${busqueda(
                    `Namespace="${NS_AGENTCORE}" MetricName="Latency" Resource="${runtimeArn}"`,
                    p,
                  )})`,
                  id: `latencia${p}`,
                  label: p,
                },
              ]),
              yAxis: { left: { min: 0, label: "ms", showUnits: false } },
            },
          },
          {
            type: "metric",
            x: 12,
            y: 11,
            width: 12,
            height: 7,
            properties: {
              ...comun,
              view: "timeSeries",
              title: "Errores y throttles (Runtime y Gateway)",
              // Las dos ortografías a propósito: el Runtime publica `Errors` y
              // el Gateway `SystemErrors`/`UserErrors`. Con el OR el widget
              // sirve para los dos sin depender de cuál usa cada primitiva.
              // Acá NO se colapsa: distinguir un throttle de un 5xx es el punto.
              metrics: [
                [
                  {
                    expression: busqueda(
                      `Namespace="${NS_AGENTCORE}" Resource="${runtimeArn}" ` +
                        `(MetricName="Errors" OR MetricName="SystemErrors" OR ` +
                        `MetricName="UserErrors" OR MetricName="Throttles")`,
                      "Sum",
                    ),
                    id: "fallosRuntime",
                    label: "Runtime ${PROP('MetricName')}",
                  },
                ],
                [
                  {
                    expression: busqueda(
                      `Namespace="${NS_AGENTCORE}" Resource="${gatewayArn}" ` +
                        `(MetricName="Errors" OR MetricName="SystemErrors" OR ` +
                        `MetricName="UserErrors" OR MetricName="Throttles")`,
                      "Sum",
                    ),
                    id: "fallosGateway",
                    label: "Gateway ${PROP('MetricName')}",
                  },
                ],
              ],
              yAxis: { left: { min: 0, showUnits: false } },
            },
          },
          {
            type: "metric",
            x: 0,
            y: 18,
            width: 12,
            height: 7,
            properties: {
              ...comun,
              view: "timeSeries",
              title: "Invocaciones del Gateway (una línea por tool)",
              // Sin filtro por `Method` ni por `Name`: así el widget muestra
              // TODAS las series que el Gateway publica para este gateway,
              // rotuladas por sus dimensiones. Es además el diagnóstico del
              // tablero: si el widget de derivaciones sale vacío, acá se ve con
              // qué dimensiones llegan de verdad las invocaciones.
              metrics: [
                [
                  {
                    expression: busqueda(
                      `Namespace="${NS_AGENTCORE}" MetricName="Invocations" Resource="${gatewayArn}"`,
                      "Sum",
                    ),
                    id: "invocacionesGateway",
                  },
                ],
              ],
              yAxis: { left: { min: 0, showUnits: false } },
            },
          },
          {
            type: "metric",
            x: 12,
            y: 18,
            width: 12,
            height: 7,
            properties: {
              ...comun,
              view: "timeSeries",
              // El modelo configurado va en el título y no como filtro: Bedrock
              // publica en `ModelId` el id con el que se invocó, y para un
              // inference profile (`us.` en `cliente.modelo`) no está garantizado
              // que sea el mismo string. Mejor mostrar todos los modelos, cada
              // uno en su línea, que filtrar por un id que puede no matchear.
              title: `Tokens por modelo (configurado: ${cliente.modelo})`,
              // Acá sí va el esquema entre llaves: el spike verificó que estas
              // métricas se publican con `ModelId` como ÚNICA dimensión, y las
              // llaves piden ese juego exacto — una línea por modelo.
              metrics: [
                [
                  {
                    expression: `SEARCH('{${NS_BEDROCK},ModelId} MetricName="InputTokenCount"', 'Sum')`,
                    id: "tokensEntrada",
                  },
                ],
                [
                  {
                    expression: `SEARCH('{${NS_BEDROCK},ModelId} MetricName="OutputTokenCount"', 'Sum')`,
                    id: "tokensSalida",
                  },
                ],
              ],
              yAxis: { left: { min: 0, label: "tokens", showUnits: false } },
            },
          },
        ],
      };
    },
  );

  return new aws.cloudwatch.Dashboard("Observabilidad", {
    // El prefijo sale del slug del cliente (./nombres) y el sufijo del stage:
    // dos stages en la misma cuenta son dos dashboards distintos.
    dashboardName: `${slugKebab}-observabilidad-${stageSaneado}`,
    dashboardBody: $jsonStringify(cuerpo),
  });
}
