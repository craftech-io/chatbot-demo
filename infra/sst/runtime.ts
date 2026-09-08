// AgentCore Runtime + su imagen. La imagen DEBE ser ARM64: el Runtime no acepta
// otra arquitectura, y el fallo aparece recién al desplegar.
//
// Dónde vive cada pieza (ver infra/CONTRACT.md):
// - el recurso de Cloud Control vive en el global `awsnative`, no en `aws.native`
//   (`aws` es solo el provider classic; `awsnative` es el ambient global que
//   expone `@pulumi/aws-native`).
// - la imagen se construye con el paquete `@pulumi/docker-build` (no hay global
//   ambiental para esto, a diferencia de `aws`/`awsnative`/`sst`): se importa
//   explícito.
import * as dockerbuild from "@pulumi/docker-build";
import { cliente } from "../../client.config";
import { slugKebab, slugCamel } from "./nombres";
import { guardrail } from "./guardrail";
import { createHash } from "node:crypto";
import { gateway } from "./gateway";
import { apiClienteDemoUrl } from "./api-cliente";

// `.name` en GetRegionResult está deprecado a favor de `.region` (mismo valor).
const region = aws.getRegionOutput().region;
const accountId = aws.getCallerIdentityOutput().accountId;

// ---------------------------------------------------------------------------
// Observabilidad del contenedor (spec §17, capa 2)
// ---------------------------------------------------------------------------
// Las trazas del interior del turno se prenden desde acá, con env: el código del
// agente no sabe que existen. Este módulo declara TODAS las env `OTEL_*` /
// `OPENINFERENCE_*` del Runtime; el resto de la infra de observabilidad (el
// Transaction Search y el dashboard) vive en ./observabilidad.ts.

/** Forma del bloque `observabilidad` de `client.config.ts`. */
type Observabilidad = {
  /** Fracción de trazas que se muestrean, 0..1. */
  muestreo: number;
  /** Si el texto de la conversación viaja en las trazas. */
  contenidoEnTrazas: boolean;
  /** Destino de los spans. */
  destino: "cloudwatch" | "otlp";
};

// El bloque lo DECLARA `client.config.ts` (con un campo más, `indexadoTrazas`,
// que consume infra/sst/observabilidad.ts y no este módulo) y lo consume acá.
const observabilidad: Observabilidad = cliente.observabilidad;

// Destino OTLP externo. Van en `sst.Secret` y no en client.config.ts porque **el
// header lleva la credencial** del backend de trazas (p. ej. un `Authorization:
// Basic ...`): se setean con `npx sst secret set ObservabilidadOtlpHeaders '...'`
// y no se loguean NUNCA — ni acá, ni en el core, ni en un `console.log` de debug.
// Default "": con `destino: "cloudwatch"` no se usan y el deploy no corta.
//
// OJO: viajan como env del Runtime, así que quedan legibles con
// `GetAgentRuntime` para quien tenga ese permiso, y en el state de Pulumi
// (cifrado). Es el mismo trade-off que cualquier credencial que necesita un
// contenedor sin sidecar; si el cliente no lo acepta, el destino es CloudWatch.
const otlpEndpoint = new sst.Secret("ObservabilidadOtlpEndpoint", "");
const otlpHeaders = new sst.Secret("ObservabilidadOtlpHeaders", "");

// Endpoint OTLP nativo de X-Ray. Es lo que elige el exporter SigV4 del distro de
// ADOT: la decisión la toma mirando ESTE valor (`_customize_span_exporter`
// compara el host con el del servicio X-Ray), no una flag aparte. Solo HTTP, no
// gRPC, y exige Transaction Search habilitado en la cuenta (./observabilidad.ts).
const endpointXray = $interpolate`https://xray.${region}.amazonaws.com/v1/traces`;

// Hash corto y estable del prompt: cambia cuando cambia el prompt y no filtra
// su contenido.
const versionDelPrompt = createHash("sha256")
  .update(cliente.promptSistema)
  .digest("hex")
  .slice(0, 12);

// Redacción. El default es REDACTADO: los ~14 `OPENINFERENCE_HIDE_*`
// vienen en `False` de fábrica, o sea que sin estas env la conversación completa
// y el prompt de sistema viajan en los spans.
//
// `HIDE_INPUTS`/`HIDE_OUTPUTS` solos ya tapan casi todo (en el `mask()` del
// paquete cubren `input.value`, `output.value`, `llm.input_messages.*`,
// `llm.output_messages.*`, `llm.tools`, `llm.prompts`, `llm.choices` y los
// documentos del reranker). Las demás van igual, por el criterio de que en
// redacción se pone la env de más: si mañana el instrumentor mueve un atributo
// de lugar, la que sobra ya lo cubre.
//
// Lo que sobrevive a propósito: los contadores de tokens
// (`llm.token_count.*`), que son la base del costo por conversación, los nombres
// de las tools y las latencias. La traza sigue sirviendo para ver QUÉ pasó en el
// turno; lo que no se ve es lo que se dijo.
//
// Las dos últimas no son de OpenInference y cierran los caminos que sus flags no
// gobiernan:
// - `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` tapa el camino de
//   botocore/GenAI. Hace falta explícita: el distro de ADOT hace
//   `setdefault(..., "true")` cuando `AGENT_OBSERVABILITY_ENABLED` está prendido.
// - `AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT=true` apaga el LLOHandler del distro,
//   que EXTRAE `input.value`/`output.value`/`llm.*_messages.*.message.content`
//   de los spans y los emite como LOG RECORDS a CloudWatch. O sea: sin esto, el
//   contenido puede salir por logs aunque uno solo haya pensado en trazas.
const envRedaccion = {
  OPENINFERENCE_HIDE_INPUTS: "true",
  OPENINFERENCE_HIDE_OUTPUTS: "true",
  OPENINFERENCE_HIDE_INPUT_MESSAGES: "true",
  OPENINFERENCE_HIDE_OUTPUT_MESSAGES: "true",
  OPENINFERENCE_HIDE_INPUT_TEXT: "true",
  OPENINFERENCE_HIDE_OUTPUT_TEXT: "true",
  OPENINFERENCE_HIDE_INPUT_IMAGES: "true",
  OPENINFERENCE_HIDE_PROMPTS: "true",
  OPENINFERENCE_HIDE_CHOICES: "true",
  OPENINFERENCE_HIDE_EMBEDDINGS_TEXT: "true",
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
  AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT: "true",
};

const envObservabilidad = {
  // Prende el instrumentor de OpenInference DENTRO del core: los spans del
  // interior del turno (workflow, tools, LLM con contadores de tokens) no los
  // da `opentelemetry-instrument`, hay que llamar al instrumentor a mano y esta
  // env es la guarda de esa llamada (ver `_instrumentar_trazas` en core/server.py).
  TRAZAS_OPENINFERENCE: "1",

  // Los DOS distros están instalados en el venv (`opentelemetry-distro` viene
  // como dependencia de `aws-opentelemetry-distro`) y sus entry points compiten:
  // `_load_distro` usa "el primero que aparezca" si nadie elige. Sin estas dos,
  // qué distro gana depende del orden de los entry points — o sea, del azar del
  // install — y con el genérico no hay exporter SigV4 ni endpoint de X-Ray.
  OTEL_PYTHON_DISTRO: "aws_distro",
  OTEL_PYTHON_CONFIGURATOR: "aws_configurator",

  // Nombre del servicio en las trazas, y el stage para poder separarlas: el
  // índice de Transaction Search es de CUENTA, así que dos stages de la misma
  // cuenta caen en el mismo lugar.
  OTEL_SERVICE_NAME: `${slugKebab}-agente`,
  // `prompt.version` es un hash corto del prompt de sistema. Sirve para lo que
  // el PoC llama prompts versionados: comparar dos períodos sabiendo si el
  // prompt cambió en el medio, sin que el TEXTO del prompt viaje en la traza.
  OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${$app.stage},prompt.version=${versionDelPrompt}`,

  // Muestreo. Sin collector el default del SDK es `parentbased_always_on`, o sea
  // el 100% de las trazas ("hasta 20x más volumen de ingesta y costo", palabras
  // de la doc de AWS). `parentbased_*` y no `traceidratio` pelado para que la
  // decisión del BFF/worker se respete: la cadena queda en una sola traza en vez
  // de cortarse justo en el contenedor.
  OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
  OTEL_TRACES_SAMPLER_ARG: String(observabilidad.muestreo),

  // `AGENT_OBSERVABILITY_ENABLED` en false EXPLÍCITO, y no ausente: con esa flag
  // prendida el configurador de ADOT agrega un `BatchUnsampledSpanProcessor`
  // ("we always send 100% spans to AgentCore Runtime platform", dice su
  // comentario) que exporta TODOS los spans y deja al sampler de arriba sin
  // efecto. Prenderla también reactivaría el LLOHandler que manda el contenido a
  // logs. Si algún día se quiere la experiencia nativa de AgentCore, se cambia
  // acá — sabiendo que el muestreo deja de aplicar.
  AGENT_OBSERVABILITY_ENABLED: "false",

  // Application Signals incluye Transaction Search: con las dos prendidas se
  // paga dos veces por lo mismo. `false` es además el default del distro; va
  // explícito para que un cambio de default no nos duplique la factura.
  OTEL_AWS_APPLICATION_SIGNALS_ENABLED: "false",

  // ADOT auto-instrumenta `botocore` y eso DUPLICA el span del LLM (uno de
  // OpenInference con la semántica buena, otro de botocore con el HTTP crudo).
  // Solo apaga la instrumentación: el exporter SigV4 sigue usando botocore como
  // librería para firmar, que es otra cosa.
  //
  // `jinja2` va en la misma lista porque LlamaIndex compila templates y cada
  // compilación es un span: en una corrida local de UN turno salieron 10
  // `jinja2.compile`. Es ruido puro y se paga por span ingestado. (ADOT también
  // lo apaga en su propia lista por default.)
  // `aws_llama-index` y `aws_mcp` son los instrumentors PROPIOS del distro de
  // AWS, y apagarlos es una medida de PRIVACIDAD, no de ruido: emiten
  // `gen_ai.system_instructions`, `gen_ai.input.messages`,
  // `gen_ai.output.messages`, `gen_ai.tool.call.arguments` y
  // `gen_ai.tool.call.result` con el texto completo — el prompt de sistema, el
  // historial, la respuesta del modelo, los argumentos de las tools y los
  // documentos que devuelve la Knowledge Base por MCP.
  //
  // Las `OPENINFERENCE_HIDE_*` NO los gobiernan: usan un tracer pelado, no el
  // de OpenInference con su `mask()`. Y el propio distro tiene un skip para no
  // cargarlos, pero está adentro de un `if agent_observability_enabled`, que
  // acá va en false (por el muestreo, ver más arriba), así que el skip nunca
  // corre. Dos decisiones correctas que se combinan mal.
  //
  // Van FUERA del bloque de redacción: con `contenidoEnTrazas: true` también
  // hay que apagarlos, porque duplican cada span del LLM y de las tools.
  OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: "botocore,jinja2,aws_llama-index,aws_mcp",

  // El health check de AgentCore pega a `/ping` sin parar, y cada llamada son 3
  // spans (el request más los `http send` del ASGI). Excluirlo no pierde nada:
  // que el contenedor está vivo lo dice el Runtime, no una traza.
  OTEL_PYTHON_STARLETTE_EXCLUDED_URLS: "/ping",

  // Solo trazas. Sin esto el SDK levanta también los pipelines de métricas y de
  // logs apuntando al OTLP de localhost, que en la microVM no existe: son
  // errores de export cada 60 segundos, por nada.
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
  // Los endpoints nativos de CloudWatch son HTTP, no gRPC. Es el default del
  // distro; explícito porque si no coincide, el exporter SigV4 no se elige y el
  // aviso queda en un warning que nadie lee.
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",

  // Destino. Es un adaptador de una sola env: misma clave, otro valor.
  ...(observabilidad.destino === "otlp"
    ? {
        // El segundo argumento de `sst.Secret` es un PLACEHOLDER, no un default:
        // sin `sst secret set` el valor es "" y el deploy no cortaría. Un
        // endpoint vacío deja un exporter que falla en cada export, en un log que
        // nadie mira — semanas sin una sola traza y todo "verde". Mejor fallar en
        // el synth, que es donde se puede leer el mensaje.
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlpEndpoint.value.apply((url) => {
          if (!url) {
            throw new Error(
              'observabilidad.destino es "otlp" pero el secreto ObservabilidadOtlpEndpoint está vacío. ' +
                "Seteálo con: npx sst secret set ObservabilidadOtlpEndpoint <url> --stage <stage>",
            );
          }
          return url;
        }),
        // Un espacio literal hace que el SDK descarte el header ENTERO
        // ("Header format invalid!") y el exporter salga sin auth: 401 en un log
        // que nadie mira. El caso típico es `Authorization=Basic <base64>`, que
        // es como lo documenta Langfuse; va `Basic%20<base64>`.
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: otlpHeaders.value.apply((h) => {
          if (h.includes(" ")) {
            throw new Error(
              "ObservabilidadOtlpHeaders tiene un espacio literal. El SDK de OTEL exige los valores " +
                "URL-encodeados y descarta el header si no lo están. Usá %20: " +
                "Authorization=Basic%20<base64>",
            );
          }
          return h;
        }),
      }
    : { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpointXray }),

  // Redacción por default. El opt-in es de una sola línea en client.config.ts, y
  // con un destino externo es además una decisión de residencia de datos.
  ...(observabilidad.contenidoEnTrazas ? {} : envRedaccion),
};

// Cloud Control topea CADA variable de entorno del Runtime en 2048 caracteres, y
// el base64 infla un 33%: el techo real del prompt es ~1530 caracteres de texto.
// Sin esta guarda el límite aparece recién en el UpdateResource, como un
// ValidationException que no nombra `promptSistema` — y con el deploy a mitad.
const MAX_ENV_AGENTCORE = 2048;

function promptEnBase64(prompt: string): string {
  const b64 = Buffer.from(prompt, "utf8").toString("base64");
  if (b64.length > MAX_ENV_AGENTCORE) {
    const sobra = Math.ceil((b64.length - MAX_ENV_AGENTCORE) * 0.75);
    throw new Error(
      `promptSistema mide ${prompt.length} caracteres y no entra en una variable de ` +
        `entorno de AgentCore (${b64.length} en base64, el límite es ${MAX_ENV_AGENTCORE}). ` +
        `Recortá unos ${sobra} caracteres.`,
    );
  }
  return b64;
}

// Se exporta para publicar su nombre como output del stack: el CI lo lee de
// `.sst/outputs.json` en vez de rearmarlo a mano (ver bitbucket-pipelines.yml).
export const repo = new aws.ecr.Repository("CoreRepo", {
  // ECR exige nombres en minúsculas y el autoname de Pulumi parte del nombre
  // lógico (CoreRepo) — lo rechaza. Nombre físico explícito y saneado: el
  // prefijo sale del slug del cliente (ver infra/sst/nombres.ts).
  name: `${slugKebab}-core-${$app.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
  forceDelete: true,
});

const image = new dockerbuild.Image("CoreImage", {
  // Rutas ABSOLUTAS desde la raíz del repo: docker-build resuelve las relativas
  // contra .sst/platform (el directorio del programa Pulumi), no contra el repo.
  context: { location: $cli.paths.root },
  dockerfile: { location: `${$cli.paths.root}/core/Dockerfile` },
  platforms: ["linux/arm64"],
  push: true,
  tags: [$interpolate`${repo.repositoryUrl}:latest`],
  registries: [
    {
      address: repo.repositoryUrl,
      username: aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId }).userName,
      password: aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId }).password,
    },
  ],
});

const role = new aws.iam.Role("RuntimeRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

new aws.iam.RolePolicy("RuntimeRolePolicy", {
  role: role.name,
  policy: $jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        // El prefijo `us.` de los inference profiles rutea a otra región: hay que
        // permitir foundation-model y inference-profile, no solo uno. El
        // foundation-model va con wildcard de región (`*`): un profile `us.*`
        // invoca el modelo en cualquiera de las regiones hermanas del profile,
        // y AWS exige el permiso en CADA región destino, no solo en la propia.
        // El de inference-profile sí es regional+de cuenta: ese recurso vive
        // solo en la región y cuenta donde se creó el profile.
        Action: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          $interpolate`arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
        ],
      },
      {
        // ConverseStream con guardrailConfig exige ApplyGuardrail sobre el
        // guardrail mismo (no sobre el modelo).
        Effect: "Allow",
        Action: ["bedrock:ApplyGuardrail"],
        Resource: [guardrail.guardrailArn],
      },
      {
        // AgentCore valida al CREAR el Runtime que su execution role pueda
        // pullear la imagen de ECR (lo exige explícitamente el servicio).
        Effect: "Allow",
        Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource: [repo.arn],
      },
      {
        // GetAuthorizationToken no soporta scope por recurso.
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
        Resource: "*",
      },
      {
        // Tarifas para el costo por conversación (`core/src/agent/costo.py`).
        // La Price List API NO soporta scoping por recurso: `"*"` es lo único
        // que existe. Es read-only y devuelve el catálogo PÚBLICO de precios de
        // AWS, no datos de la cuenta.
        //
        // Sin este permiso la falla es silenciosa y cara de diagnosticar: el
        // costo sale siempre `null` con un warning por microVM, el chat funciona
        // igual y el deploy no se queja. Aparece semanas después, cuando alguien
        // pregunta por qué el dashboard no tiene costos.
        Effect: "Allow",
        Action: ["pricing:GetProducts"],
        Resource: "*",
      },
      {
        // Tools de tenant: el core firma los requests MCP al Gateway con SigV4
        // (inbound AWS_IAM). Además del ARN pelado va el wildcard de
        // sub-recursos porque el authz puede evaluar el target como
        // sub-recurso del gateway (mismo caso que el `runtime-endpoint/*` de
        // InvokeAgentRuntime en infra/sst/worker.ts) — sigue acotado al gateway
        // PROPIO, no sobre-otorga.
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeGateway"],
        Resource: [gateway.gatewayArn, $interpolate`${gateway.gatewayArn}/*`],
      },
    ],
  }),
});

// Escritura de spans al endpoint OTLP de X-Ray (spec §17, capa 2). Va como la
// policy ADMINISTRADA `AWSXrayWriteOnlyAccess` y no como statement propio a
// propósito: es la que la doc de AWS indica para el camino collector-less de
// ADOT, y el set de acciones que necesita ese endpoint lo fue cambiando
// (`xray:PutTraceSegments` y después `xray:PutSpans`) — una lista escrita a mano
// se queda vieja y el fallo sale como un 403 del exporter, en un log que nadie
// mira, sin ningún síntoma en el turno.
//
// Solo con `destino: "cloudwatch"`: con un destino OTLP externo el contenedor no
// le habla a X-Ray y el permiso sobraría.
if (observabilidad.destino === "cloudwatch") {
  new aws.iam.RolePolicyAttachment("RuntimeXrayWrite", {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess",
  });
}

export const runtime = new awsnative.bedrockagentcore.Runtime("AgentRuntime", {
  // El recurso exige `[a-zA-Z][a-zA-Z0-9_]*`: stages con guion (p.ej. `pr-123`)
  // lo violarían, así que se sanitiza cualquier carácter fuera de ese alfabeto.
  // El prefijo es el slug del cliente en camelCase (infra/sst/nombres.ts): ese
  // alfabeto no acepta `-`.
  agentRuntimeName: $interpolate`${slugCamel}${$app.stage.replace(/[^a-zA-Z0-9_]/g, "_")}`,
  agentRuntimeArtifact: {
    containerConfiguration: {
      // Digest PURO (repo@sha256:...): el ref canónico de docker-build combina
      // tag y digest (repo:latest@sha256:...) — la validación de CreateRuntime
      // lo acepta, pero el pull real de la microVM no lo resuelve y el
      // contenedor jamás arranca (health check timeout con logs vacíos).
      // El digest cambia por build, así que los updates siguen disparando.
      containerUri: image.ref.apply((r) => r.replace(/:[^@]+@/, "@")),
    },
  },
  networkConfiguration: { networkMode: "PUBLIC" },
  roleArn: role.arn,
  environmentVariables: {
    MODEL_ID: cliente.modelo,
    // GATEWAY_URL: el endpoint MCP del gateway — el recurso lo expone como
    // atributo `gatewayUrl`. CLIENT_API_URL: base de la API del cliente (acá,
    // la app web) SIN barra final. Vacías o ausentes ⇒ el core corre sin esas
    // tools (contrato del core).
    GATEWAY_URL: gateway.gatewayUrl,
    CLIENT_API_URL: apiClienteDemoUrl,
    // Política de comportamiento del agente (spec §11.2): sale de
    // `client.config.ts` y el core la usa como mensaje `system`. Vacía o
    // ausente ⇒ el core corre sin mensaje de sistema (contrato del core).
    //
    // Viaja en BASE64, y no en claro: AgentCore rechaza caracteres de control en
    // los valores de sus env vars ("Environment variable value contains invalid
    // control characters") y este prompt es multilínea por naturaleza — una
    // regla por línea. El core acepta las dos variantes y prefiere la de claro
    // (ver `_prompt_sistema` en core/src/agent/config.py).
    //
    // Spread condicional y no la clave pelada: el prompt vacío es un modo
    // SOPORTADO (lo documentan client.config.ts e infra/CONTRACT.md), y ausente
    // es exactamente lo que el core espera para ese modo.
    ...(cliente.promptSistema
      ? { PROMPT_SISTEMA_B64: promptEnBase64(cliente.promptSistema) }
      : {}),
    // Observabilidad del contenedor: todas las env están armadas y comentadas
    // arriba, derivadas de `cliente.observabilidad`.
    ...envObservabilidad,
  },
});

export const runtimeLink = new sst.Linkable("AgentRuntime", {
  properties: { arn: runtime.agentRuntimeArn },
});
