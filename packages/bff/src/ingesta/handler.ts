/// <reference path="../../../../sst-env.d.ts" />
// Borde de infra del ingestor: Lambda que sincroniza Confluence al bucket de la
// Knowledge Base y dispara la re-indexación. La corre el Cron de
// infra/sst/ingesta.ts.
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { BedrockAgentClient, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { Resource } from "sst";
import { crearProveedorDeToken } from "../atlassian";
import { crearClienteConfluence, sincronizar, type Almacen } from "./confluence";

const s3 = new S3Client({});
const bedrock = new BedrockAgentClient({});

function almacenS3(bucket: string): Almacen {
  return {
    async listar(prefijo) {
      const claves: string[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo, ContinuationToken: token }),
        );
        for (const o of r.Contents ?? []) if (o.Key) claves.push(o.Key);
        token = r.NextContinuationToken;
      } while (token);
      return claves;
    },
    async escribir(clave, cuerpo) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: clave,
          Body: cuerpo,
          ContentType: clave.endsWith(".json") ? "application/json" : "text/markdown",
        }),
      );
    },
    async borrar(claves) {
      // DeleteObjects acepta 1000 por request.
      for (let i = 0; i < claves.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: claves.slice(i, i + 1000).map((Key) => ({ Key })) },
          }),
        );
      }
    },
  };
}

export const handler = async () => {
  const espacios = (process.env.CONFLUENCE_ESPACIOS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (espacios.length === 0) {
    console.log(JSON.stringify({ evento: "ingesta_omitida", motivo: "sin espacios configurados" }));
    return { escritas: 0, borradas: 0 };
  }

  const token = await crearProveedorDeToken({
    clientId: Resource.AtlassianClientId.value,
    clientSecret: Resource.AtlassianClientSecret.value,
  }).obtener();
  if (!token) throw new Error("no se pudo obtener el token de Atlassian");

  const cliente = crearClienteConfluence({
    cloudId: Resource.AtlassianCloudId.value,
    token,
    espacios,
    sitioUrl: process.env.CONFLUENCE_SITIO_URL ?? "",
    maxReqPorSegundo: Number(process.env.CONFLUENCE_MAX_RPS) || undefined,
  });

  const resultado = await sincronizar(cliente, almacenS3(Resource.Documentos.name), {
    adjuntos: Boolean(process.env.CONFLUENCE_ADJUNTOS),
  });

  // Subir al bucket no indexa: la ingesta hay que dispararla.
  const job = await bedrock.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: process.env.KB_ID,
      dataSourceId: process.env.DATA_SOURCE_ID,
    }),
  );
  console.log(
    JSON.stringify({
      evento: "ingesta_confluence",
      espacios: espacios.length,
      ...resultado,
      job: job.ingestionJob?.ingestionJobId,
    }),
  );
  return resultado;
};
