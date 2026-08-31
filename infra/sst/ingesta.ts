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
    CONFLUENCE_MAX_RPS: String(cliente.confluence.maxReqPorSegundo),
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

// Bedrock no sincroniza solo y el corpus del cliente cambia sin avisar.
//
// EventBridge Scheduler y no `sst.aws.Cron`: ese componente crea una regla de
// EventBridge, que corre SIEMPRE en UTC y con `rate(...)` cuenta desde que se
// creó el recurso — o sea que la ingesta caía a la hora del deploy y se movía
// sola en cada recreación. El Scheduler acepta zona horaria, reintentos y una
// cola de descarte.
const colaFallos = new sst.aws.Queue("IngestaFallida");

const rolScheduler = new aws.iam.Role("IngestaSchedulerRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "scheduler.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

new aws.iam.RolePolicy("IngestaSchedulerPolicy", {
  role: rolScheduler.id,
  policy: $jsonStringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [ingestorConfluence.arn] },
      { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: [colaFallos.arn] },
    ],
  }),
});

export const scheduleIngesta = new aws.scheduler.Schedule("IngestaConfluence", {
  scheduleExpression: cliente.confluence.horario,
  scheduleExpressionTimezone: cliente.confluence.zonaHoraria,
  // Sin ventana de flexibilidad: la corrida es de madrugada y no compite con
  // nada, así que no hay razón para que AWS la mueva.
  flexibleTimeWindow: { mode: "OFF" },
  target: {
    arn: ingestorConfluence.arn,
    roleArn: rolScheduler.arn,
    // Un fallo de INVOCACIÓN (throttling, permisos) no se pierde en silencio.
    // No cubre que la ingesta falle adentro: eso sale por los logs.
    retryPolicy: { maximumRetryAttempts: 3 },
    deadLetterConfig: { arn: colaFallos.arn },
  },
});
