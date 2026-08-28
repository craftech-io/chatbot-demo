// Las dos tools de tenant que son Lambda propia (spec §7 y §11): el RAG sobre
// los documentos del cliente y el escalamiento a un humano. El otro sabor de
// tool de tenant —la API del cliente vía OpenAPI— ya está en ./gateway.ts.
//
// Cómo es el camino de una de estas tools, de punta a punta:
//   1. el core (Harness) descubre las tools con `tools/list` contra el Gateway,
//      firmando con SigV4 el rol del Runtime (inbound AWS_IAM).
//   2. el modelo decide llamar una → `tools/call` al Gateway.
//   3. el Gateway resuelve el target y, con SU rol (gatewayRole, el
//      `GATEWAY_IAM_ROLE` de abajo), hace `lambda:InvokeFunction` sobre la
//      Lambda que implementa la tool.
//   4. la Lambda devuelve JSON → Gateway → de vuelta al loop del agente.
// Los dos roles son distintos a propósito: el Runtime no necesita invocar
// Lambdas y el Gateway no necesita invocar modelos.
import { cliente } from "../../client.config";
import { kb, kbLink } from "./conocimiento";
import { gateway, gatewayRole, targetApiCliente } from "./gateway";
import { documentosToolSchema, escalamientoToolSchema } from "./tool-schemas";

// Destino del escalamiento. Es un SECRETO (estos webhooks suelen llevar el token
// en el path o en el query), así que va en `sst.Secret` —
// `npx sst secret set EscalamientoWebhookUrl https://...` — y jamás en
// client.config.ts, que se commitea.
//
// Default "": un stack sin el secreto seteado despliega igual y la tool
// responde que no hay destino configurado (ver packages/bff/src/tools/
// escalamiento.ts) en vez de cortar el deploy. Mismo criterio que los secretos
// del emisor de tokens en ./bff.ts.
const escalamientoWebhookUrl = new sst.Secret("EscalamientoWebhookUrl", "");

// Cuántos pasajes trae `consultar_documentos`: default por cliente, declarado
// en client.config.ts.
const topKDocumentos = cliente.documentos.topK;

export const toolDocumentos = new sst.aws.Function("ToolDocumentos", {
  handler: "packages/bff/src/tools/documentos.handler",
  runtime: "nodejs24.x",
  memory: "256 MB",
  // Un Retrieve embebe la consulta y busca en el vector store: más lento que un
  // GetItem, mucho menos que un turno de modelo.
  timeout: "30 seconds",
  // El id del KB llega por linkable (`Resource.KnowledgeBase.id`), no por env.
  link: [kbLink],
  permissions: [
    {
      // Un Linkable pelado no otorga permisos (ver infra/CONTRACT.md): el
      // `bedrock:Retrieve` va a mano, acotado al KB propio.
      actions: ["bedrock:Retrieve"],
      resources: [kb.knowledgeBaseArn],
    },
  ],
  environment: {
    ...(topKDocumentos === undefined ? {} : { DOCUMENTOS_TOP_K: String(topKDocumentos) }),
  },
});

export const toolEscalamiento = new sst.aws.Function("ToolEscalamiento", {
  handler: "packages/bff/src/tools/escalamiento.handler",
  runtime: "nodejs24.x",
  memory: "256 MB",
  // La tool corta el POST al webhook a los 10s por su cuenta; el margen es para
  // el arranque en frío.
  timeout: "20 seconds",
  link: [escalamientoWebhookUrl],
});

// El ÚNICO permiso que necesita el rol del Gateway: invocar exactamente estas
// dos Lambdas (lista explícita de ARNs, nada de comodín). Es lo que cierra el
// paso 3 del camino de arriba; sin esto el `tools/call` falla con AccessDenied
// dentro del Gateway y el agente solo ve que la tool no anduvo.
//
// La policy vive acá y no en ./gateway.ts para no crear un ciclo de imports:
// este módulo importa el gateway y su rol, y es el que conoce las Lambdas.
const gatewayRolePolicy = new aws.iam.RolePolicy("GatewayRolePolicy", {
  role: gatewayRole.name,
  policy: $jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["lambda:InvokeFunction"],
        Resource: [toolDocumentos.arn, toolEscalamiento.arn],
      },
    ],
  }),
});

// Un target por Lambda. Anatomía (igual en los dos):
//   - gatewayIdentifier: de qué Gateway cuelga.
//   - targetConfiguration.mcp.lambda.lambdaArn: quién IMPLEMENTA las tools.
//   - toolSchema.inlinePayload: el contrato que ve el modelo (./tool-schemas.ts).
//   - credentialProviderConfigurations: con qué credencial invoca el Gateway.
//     `GATEWAY_IAM_ROLE` PELADO es válido en targets Lambda —usa el `roleArn`
//     del Gateway—; en un target OpenAPI NO lo es (ahí significa "firmá el
//     outbound con SigV4" y exige además `credentialProvider.
//     iamCredentialProvider.service`, ver el comentario en ./gateway.ts).
//
// OJO con el orden de creación: Cloud Control falla con InternalFailure si se
// crean dos targets EN PARALELO sobre el mismo gateway, así que los targets van
// en cadena de `dependsOn` — incluido el que ya existía en ./gateway.ts.
//
// El nombre de la tool que ve el modelo lleva el prefijo del target
// (`documentos___consultar_documentos`): el core lista las tools dinámicamente,
// así que no rompe nada, pero es el nombre que aparece en los logs.
export const targetDocumentos = new awsnative.bedrockagentcore.GatewayTarget(
  "ToolDocumentosTarget",
  {
    gatewayIdentifier: gateway.gatewayIdentifier,
    name: "documentos",
    description: "RAG sobre los documentos del cliente (dato de tenant)",
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn: toolDocumentos.arn,
          toolSchema: { inlinePayload: documentosToolSchema },
        },
      },
    },
    credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
  },
  // La policy primero: si el target se crea antes de que el rol pueda invocar,
  // la primera llamada del agente se come un AccessDenied.
  { dependsOn: [gatewayRolePolicy, targetApiCliente] },
);

export const targetEscalamiento = new awsnative.bedrockagentcore.GatewayTarget(
  "ToolEscalamientoTarget",
  {
    gatewayIdentifier: gateway.gatewayIdentifier,
    name: "escalamiento",
    description: "Escalamiento del caso a una persona (dato de tenant)",
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn: toolEscalamiento.arn,
          toolSchema: { inlinePayload: escalamientoToolSchema },
        },
      },
    },
    credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
  },
  { dependsOn: [gatewayRolePolicy, targetDocumentos] },
);
