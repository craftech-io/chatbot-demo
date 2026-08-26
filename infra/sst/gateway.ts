// AgentCore Gateway (fase 2d): expone las tools de TENANT como MCP tools para
// el core. Inbound AWS_IAM/SigV4 (verificado en el spike 2026-08-26 — sin
// prerequisito de JWT); un solo target OpenAPI con GET /catalogo de la demo
// API. /pedidos NO va al gateway: regla dura del spec §7, nada per-usuario
// pasa por acá (eso lo llama el core por HTTP directo con el actToken).
//
// Nombres de props verificados contra `.sst/platform/node_modules/@pulumi/
// aws-native/bedrockagentcore/{gateway,gatewayTarget}.d.ts` (1.68.0):
// - Gateway: args `authorizerType`/`protocolType`/`roleArn`/`name`; outputs
//   `gatewayUrl` (el endpoint MCP), `gatewayArn`, `gatewayIdentifier`.
// - GatewayTarget: args `gatewayIdentifier`, `targetConfiguration.mcp
//   .openApiSchema.inlinePayload`, `credentialProviderConfigurations[]
//   .credentialProviderType` (enum incluye "GATEWAY_IAM_ROLE").
import { apiClienteDemoUrl } from "./api-cliente";

// El nombre físico exige `([0-9a-zA-Z][-]?){1,100}` (alfanumérico con guiones
// no consecutivos, distinto del alfabeto del Runtime que acepta `_`): se
// sanitiza el stage a ese alfabeto.
const stageSaneado = $app.stage
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const gatewayRole = new aws.iam.Role("GatewayRole", {
  // Mismo principal que el RuntimeRole: el servicio AgentCore asume este rol
  // para las llamadas outbound de los targets (credencial POR TARGET, no de
  // nivel gateway — corrección del spike al spec §7).
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
// Sin policy de permisos a propósito: el único target es la Function URL
// pública de la demo API (auth NONE) — GATEWAY_IAM_ROLE firma el request
// outbound con este rol, pero no hay ninguna API de AWS que autorizar.

export const gateway = new awsnative.bedrockagentcore.Gateway("Gateway", {
  name: `craftech-ai-chat-gw-${stageSaneado}`,
  description: "Tools de tenant del chat (catalogo) via MCP",
  // Inbound SigV4: el core firma cada request MCP con las credenciales del
  // RuntimeRole (SigV4Auth en core/src/agent/tools.py, T1).
  authorizerType: "AWS_IAM",
  // El .d.ts tipa protocolType como `any` (el enum vive en el schema de
  // CloudFormation): "MCP" es el único protocolo del recurso hoy.
  protocolType: "MCP",
  roleArn: gatewayRole.arn,
});

// El OpenAPI del target: SOLO /catalogo. El operationId nombra la tool
// (contrato de la fase: `listar_catalogo`). Ojo para el smoke de T5: AgentCore
// suele prefijar las tools MCP con el nombre del target (`<target>___<op>`) —
// el core lista las tools dinámicamente así que no rompe nada, pero el nombre
// visto en logs puede llevar el prefijo.
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

new awsnative.bedrockagentcore.GatewayTarget("GatewayTarget", {
  // El .d.ts lo marca opcional, pero sin él Cloud Control no sabe de qué
  // gateway colgar el target: va siempre. (Si además es createOnly en el
  // registry — no verificable local, sin creds — pasarlo explícito también es
  // lo correcto; lo confirma el deploy de T5.)
  gatewayIdentifier: gateway.gatewayIdentifier,
  name: "api-cliente",
  description: "GET /catalogo de la demo API (dato de tenant)",
  targetConfiguration: {
    mcp: { openApiSchema: { inlinePayload: openApiCatalogo } },
  },
  // Credencial POR TARGET: el gateway firma el outbound con su propio rol.
  credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
});
