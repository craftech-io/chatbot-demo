// Ingesta de Confluence a la Knowledge Base, por cron.
//
// Reemplaza al conector nativo de Bedrock, que está en preview y exige
// OpenSearch Serverless (~US$350/mes contra ~US$0,015 de S3 Vectors): esta
// Lambda escribe las páginas en el bucket y el vector store no cambia.
import { kb, kbDataSource, kbSource } from "./conocimiento";
import { permisosTrazas, trazasActivas } from "./observabilidad";
import { cliente } from "../../client.config";
import {
  atlassianClientId,
  atlassianClientSecret,
  atlassianCloudId,
} from "./secretos-atlassian";

export const ingestorConfluence = new sst.aws.Function("IngestorConfluence", {
  handler: "packages/bff/src/ingesta/handler.handler",
  runtime: "nodejs24.x",
  memory: "512 MB",
  // Un refresh completo de cientos de páginas es secuencial contra la API de
  // Confluence; el tope de Lambda es 15 minutos.
  timeout: "10 minutes",
  // El link del bucket otorga list/put/delete sobre él.
  link: [kbSource, atlassianClientId, atlassianClientSecret, atlassianCloudId],
  environment: {
    KB_ID: kb.knowledgeBaseId,
    DATA_SOURCE_ID: kbDataSource.dataSourceId,
    CONFLUENCE_ESPACIOS: cliente.confluence.espacios.join(","),
    CONFLUENCE_SITIO_URL: cliente.confluence.sitioUrl,
    CONFLUENCE_ADJUNTOS: cliente.confluence.adjuntos ? "1" : "",
  },
  transform: { function: trazasActivas },
  permissions: [
    ...permisosTrazas,
    {
      actions: ["bedrock:StartIngestionJob"],
      resources: [kb.knowledgeBaseArn],
    },
  ],
});

// Bedrock no sincroniza solo y el corpus del cliente cambia sin avisar. Diario
// es el punto razonable: más seguido no aporta (la gente no edita la base de
// conocimiento cada hora) y cada corrida re-indexa lo que cambió.
export const cronIngesta = new sst.aws.Cron("IngestaConfluence", {
  schedule: "rate(1 day)",
  function: ingestorConfluence.arn,
});
