// AgentCore Gateway: expone las tools de TENANT como MCP tools para el core.
// Inbound AWS_IAM/SigV4, que no exige además un JWT; un solo target OpenAPI con
// GET /catalogo de la demo API. /pedidos NO va al gateway: regla dura del spec
// §7, nada per-usuario pasa por acá (eso lo llama el core por HTTP directo con
// el actToken).
//
// El output del recurso que interesa es `gatewayUrl`: es el endpoint MCP que
// consume el core (se le pasa como GATEWAY_URL en infra/sst/runtime.ts).
import { apiClienteDemoUrl } from "./api-cliente";
import { slugKebab } from "./nombres";
import { cliente } from "../../client.config";

// El nombre físico exige `([0-9a-zA-Z][-]?){1,48}` (alfanumérico con guiones
// no consecutivos, distinto del alfabeto del Runtime que acepta `_`): se
// sanitiza el stage a ese alfabeto. Ojo con el largo: el prefijo se come tantos
// caracteres de los 48 como mida el slug del cliente (hoy 16), así que un slug
// largo + un stage de preview largo haría fallar el create.
const stageSaneado = $app.stage
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Se exporta para que ./tools.ts le cuelgue su policy: las tools de tenant que
// son Lambda propia necesitan que ESTE rol pueda invocarlas.
export const gatewayRole = new aws.iam.Role("GatewayRole", {
  // Mismo principal que el RuntimeRole: el servicio AgentCore asume este rol
  // para las llamadas outbound de los targets. La credencial outbound se
  // configura POR TARGET, no a nivel gateway.
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
// Permisos para las políticas del agente (./policy.ts). Van ACÁ y no en la
// policy de ./tools.ts por un deadlock de orden: el UPDATE del Gateway que
// adjunta el policy engine valida que este rol pueda leerlo, y la policy de
// tools.ts se crea DESPUÉS del Gateway — el deploy fallaba sin llegar nunca a
// otorgar el permiso.
//
// Las tres primeras acciones las exige el Gateway para evaluar Cedar. En
// `LOG_ONLY` la falta de `GetPolicyEngine` falla en SILENCIO y solo aparece al
// pasar a `ENFORCE`. `GetWorkloadAccessToken` es aparte y solo hace falta con
// políticas TEMPORALES —las dos nuestras—: el Gateway mintea un token para
// propagar la sesión y sin el permiso la tool call muere en ese paso.
//
// Wildcard de recurso: el policy engine y el gateway se nombran mutuamente, así
// que acotar por ARN cierra un ciclo de dependencias en el IaC.
export const gatewayPolicyEnginePolicy = new aws.iam.RolePolicy("GatewayPolicyEngineAccess", {
  role: gatewayRole.name,
  policy: $jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:GetPolicyEngine",
          "bedrock-agentcore:AuthorizeAction",
          "bedrock-agentcore:PartiallyAuthorizeActions",
          "bedrock-agentcore:GetWorkloadAccessToken",
        ],
        Resource: "*",
      },
    ],
  }),
});

// Sin más policy en ESTE archivo: el target de acá abajo es la Function URL pública
// de la demo API (auth NONE) y va sin credencial outbound (ver GatewayTarget),
// así que no hay ninguna API de AWS que autorizar por él. La policy del rol la
// declara ./tools.ts (`lambda:InvokeFunction` acotado a las dos tool Lambdas):
// vive ahí para no armar un ciclo de imports gateway↔tools, y porque es ahí
// donde se conocen los ARNs a autorizar.

export const gateway = new awsnative.bedrockagentcore.Gateway("Gateway", {
  name: `${slugKebab}-gw-${stageSaneado}`,
  description: "Tools de tenant del chat (catalogo) via MCP",
  // Inbound SigV4: el core firma cada request MCP con las credenciales del
  // RuntimeRole (SigV4Auth en core/src/agent/tools.py).
  authorizerType: "AWS_IAM",
  // El .d.ts tipa protocolType como `any` (el enum vive en el schema de
  // CloudFormation): "MCP" es el único protocolo del recurso hoy.
  protocolType: "MCP",
  roleArn: gatewayRole.arn,
});

// El OpenAPI del target: SOLO /catalogo. El operationId nombra la tool
// (`listar_catalogo`). Ojo: AgentCore suele prefijar las tools MCP con el
// nombre del target (`<target>___<op>`) — el core lista las tools
// dinámicamente así que no rompe nada, pero el nombre visto en logs puede
// llevar el prefijo.
const openApiCatalogo = $jsonStringify({
  openapi: "3.0.3",
  info: {
    title: "API del cliente (demo) - tenant",
    version: "1.0.0",
  },
  servers: [{ url: apiClienteDemoUrl }],
  paths: {
    "/catalogo": {
      get: {
        operationId: "listar_catalogo",
        summary: "Listar el catalogo de productos",
        description:
          "Devuelve el catalogo completo de productos de la tienda, con id, nombre y precio de cada uno. No recibe parametros.",
        responses: {
          "200": {
            description: "El catalogo de productos",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    productos: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          nombre: { type: "string" },
                          precio: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

// Se exporta —sin cambiarle nada— para que los targets de ./tools.ts se creen
// DESPUÉS de este: Cloud Control falla con InternalFailure si dos targets del
// mismo gateway se crean en paralelo, así que van en cadena de `dependsOn`.
export const targetApiCliente = new awsnative.bedrockagentcore.GatewayTarget("GatewayTarget", {
  // El .d.ts lo marca opcional, pero sin él Cloud Control no sabe de qué
  // gateway colgar el target: va siempre.
  gatewayIdentifier: gateway.gatewayIdentifier,
  name: "api",
  description: "GET /catalogo de la demo API (dato de tenant)",
  targetConfiguration: {
    mcp: { openApiSchema: { inlinePayload: openApiCatalogo } },
  },
  // SIN credencial outbound ("no authorization", que la tabla de outbound-auth
  // de AgentCore permite para targets OpenAPI): el target es la Function URL
  // pública de la demo API (authType NONE), no hay nada que autenticar.
  //
  // Ojo si algún día hace falta credencial: un `credentialProviderType:
  // "GATEWAY_IAM_ROLE"` pelado NO es válido sobre un target OpenAPI — ahí ese
  // tipo significa "firmá el outbound con SigV4" y la API exige además
  // `credentialProvider.iamCredentialProvider.service`; sin eso
  // CreateGatewayTarget responde ValidationException. GATEWAY_IAM_ROLE pelado
  // solo aplica a targets Lambda/ApiGateway/Smithy/Connector.
  // Cuando un cliente real tenga su API detrás de auth, va por acá: OAUTH o
  // API_KEY con su ProviderArn (AgentCore Identity).
});
