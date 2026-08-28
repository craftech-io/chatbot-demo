// Conocimiento (RAG): Bedrock Knowledge Base VECTOR sobre S3 Vectors, con un
// bucket de S3 como fuente de los documentos del cliente (spec §11).
//
// Mismo diseño que ya corre en producción en el proyecto hermano
// `msp-platform` (`infra/agent-kb.ts`). Piezas:
//   - sst.aws.Bucket                              : fuente (los documentos)  [nativo SST]
//   - awsnative.s3vectors.VectorBucket + Index    : el vector store          [Cloud Control]
//   - aws.iam.Role/RolePolicy                     : rol de ejecución de la KB [classic]
//   - awsnative.bedrock.KnowledgeBase + DataSource: la KB y su data source   [Cloud Control]
//
// El provider classic `aws` no expone la Knowledge Base: va por `awsnative`
// (espeja el tipo CFN `AWS::Bedrock::KnowledgeBase`, que sí soporta
// `S3VectorsConfiguration`). Ver infra/CONTRACT.md, "Providers y globals".
//
// La ingesta NO es automática: subir documentos al bucket no los indexa. Hay que
// disparar un ingestion job (`aws bedrock-agent start-ingestion-job`) — ver
// examples/documentos/README.md.
//
// OJO, propiedades createOnly (Cloud Control las marca así: cambiarlas RECREA el
// recurso, no lo actualiza):
//   - `storageConfiguration` y `knowledgeBaseConfiguration.vectorKnowledgeBaseConfiguration`
//     de la KnowledgeBase — cambiar de vector store o de modelo de embeddings
//     borra y recrea la KB, y con ella se va todo lo ya indexado.
//   - `dataSourceConfiguration` y `vectorIngestionConfiguration.chunkingConfiguration`
//     del DataSource — por eso acá NO se declara chunking: se toma el default del
//     servicio (fixed-size), y el día que haga falta tunearlo hay que asumir la
//     recreación del data source + una reingesta completa.
import { slugKebab } from "./nombres";

// Región del provider activo, sin hardcodes: el deploy la toma de
// `AWS_REGION` o de `cliente.region` (ver sst.config.ts).
// `.name` en GetRegionResult está deprecado a favor de `.region` (mismo valor).
const awsRegion = aws.getRegionOutput().region;

// Titan Text Embeddings v2. La dimensión del índice de S3 Vectors y la del
// modelo tienen que coincidir: 1024 es el default de Titan v2.
const EMBED_MODEL_ARN = $interpolate`arn:aws:bedrock:${awsRegion}::foundation-model/amazon.titan-embed-text-v2:0`;
const EMBED_DIMS = 1024;

// Alfabeto de S3 Vectors (bucket y índice): minúsculas, dígitos y guiones — NO
// acepta mayúsculas ni `_`, así que el stage se sanea (un stage `PR_12` haría
// fallar el create). El prefijo sale del slug del cliente (infra/sst/nombres.ts).
const stageSaneado = $app.stage
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Bucket fuente: acá viven los documentos del cliente. El contenido se sube
// post-deploy (el template no lleva datos de ningún cliente).
export const kbSource = new sst.aws.Bucket("Documentos");

// Vector store: S3 Vectors (bucket + índice).
const vectorBucket = new awsnative.s3vectors.VectorBucket("VectorBucket", {
  vectorBucketName: `${slugKebab}-${stageSaneado}-vec`,
});

const vectorIndex = new awsnative.s3vectors.Index("VectorIndex", {
  // El recurso tipa `vectorBucketName` como `Output<string | undefined>`
  // (CloudFormation lo autogenera si no se lo pasás); acá siempre lo pasamos,
  // así que el `!` es seguro.
  vectorBucketName: vectorBucket.vectorBucketName.apply((n) => n!),
  indexName: "documentos",
  dataType: "float32",
  dimension: EMBED_DIMS,
  distanceMetric: "cosine",
  // Bedrock KB guarda el texto del chunk y su metadata en estas dos claves: si
  // quedan filtrables se comen el presupuesto de metadata del índice.
  metadataConfiguration: {
    nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"],
  },
});

// El nombre del rol de ejecución de la KB es un REQUISITO DE BEDROCK, no una
// convención nuestra: `CreateKnowledgeBase` valida que el ARN del rol empiece
// con `AmazonBedrockExecutionRoleForKnowledgeBase_` y si no, responde
// ValidationException. Lo dice también el `.d.ts` del recurso.
const PREFIJO_ROL_KB = "AmazonBedrockExecutionRoleForKnowledgeBase_";

// Cuenta del presupuesto: IAM limita el nombre de un rol a 64 caracteres y el
// prefijo obligatorio se come 43, así que quedan 21 para el sufijo. Con el slug
// del template (`craftech-ai-chat`, 16) y un stage largo (`production`, 10) el
// nombre completo se pasaría — y el error saldría recién al crear el rol.
// Se recorta el SLUG y se preserva el stage entero: dentro de una misma cuenta
// (el template es BYOC, una cuenta por cliente) lo que distingue dos stacks es
// el stage, y dos roles con el mismo nombre serían el mismo recurso.
const PRESUPUESTO_SUFIJO = 64 - PREFIJO_ROL_KB.length;
const sufijoCompleto = `${slugKebab}-${stageSaneado}`;
const sufijoRolKb =
  sufijoCompleto.length <= PRESUPUESTO_SUFIJO
    ? sufijoCompleto
    : `${slugKebab
        .slice(0, Math.max(1, PRESUPUESTO_SUFIJO - stageSaneado.length - 1))
        // Si el recorte cae justo en un guion quedaría `craftech--production`:
        // IAM lo acepta, pero no se lee.
        .replace(/-+$/, "")}-${stageSaneado}`.slice(0, PRESUPUESTO_SUFIJO);

const kbRole = new aws.iam.Role("KbRole", {
  name: `${PREFIJO_ROL_KB}${sufijoRolKb}`,
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
});

const kbRolePolicy = new aws.iam.RolePolicy("KbRolePolicy", {
  role: kbRole.id,
  policy: $resolve([
    kbSource.arn,
    vectorBucket.vectorBucketArn,
    vectorIndex.indexArn,
    EMBED_MODEL_ARN,
  ]).apply(([sourceArn, vbArn, idxArn, embedArn]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          // La KB invoca el modelo de embeddings en cada ingesta y en cada
          // retrieve. Acotado al ARN del modelo que declara la KB.
          Sid: "Embeddings",
          Effect: "Allow",
          Action: ["bedrock:InvokeModel"],
          Resource: [embedArn],
        },
        {
          // Wildcard de ACCIÓN, acotado por RECURSO al vector bucket y al índice
          // propios. Deliberado: los nombres de acción de S3 Vectors no los
          // valida ningún `.d.ts` (mismo caso que el data plane de Memory, ver
          // infra/CONTRACT.md) y una acción que falte de la lista explícita sale
          // como un fallo opaco a mitad de la ingesta, no como error de deploy.
          // Es la forma que ya corre en producción en msp-platform.
          Sid: "S3Vectors",
          Effect: "Allow",
          Action: ["s3vectors:*"],
          Resource: [vbArn, idxArn],
        },
        {
          // ListBucket va sobre el bucket; GetObject sobre las claves. Cubre
          // también los sidecars `<archivo>.metadata.json` del data source.
          Sid: "LeerFuente",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [sourceArn],
        },
        {
          Sid: "LeerDocumentos",
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [`${sourceArn}/*`],
        },
      ],
    }),
  ),
});

export const kb = new awsnative.bedrock.KnowledgeBase("Conocimiento", {
  // `^([0-9a-zA-Z][_-]?){1,100}$`: el slug saneado y el stage saneado ya cumplen.
  name: `${slugKebab}-conocimiento-${stageSaneado}`,
  roleArn: kbRole.arn,
  knowledgeBaseConfiguration: {
    type: "VECTOR",
    vectorKnowledgeBaseConfiguration: {
      embeddingModelArn: EMBED_MODEL_ARN,
    },
  },
  storageConfiguration: {
    type: "S3_VECTORS",
    s3VectorsConfiguration: {
      vectorBucketArn: vectorBucket.vectorBucketArn,
      indexArn: vectorIndex.indexArn,
    },
  },
  // `dependsOn` explícito sobre la POLICY (no sobre el rol): `CreateKnowledgeBase`
  // valida en el momento que el rol pueda leer el bucket y escribir en el vector
  // store. Sin esto Pulumi puede crear la KB en paralelo con la policy y el
  // create falla con un permisos-insuficientes que no se reproduce al reintentar.
}, { dependsOn: [kbRolePolicy] });

export const kbDataSource = new awsnative.bedrock.DataSource("KbDataSource", {
  knowledgeBaseId: kb.knowledgeBaseId,
  name: "documentos",
  dataSourceConfiguration: {
    type: "S3",
    s3Configuration: {
      bucketArn: kbSource.arn,
    },
  },
  // RETAIN y no el default (DELETE): al borrar el data source, `DELETE` le pide
  // a Bedrock que además borre los vectores ya indexados, y si esa limpieza
  // falla la KB queda en `DELETE_UNSUCCESSFUL` — con el stack a medio borrar y
  // sin forma limpia de retomarlo (pasó en una cuenta real). Con RETAIN los
  // vectores quedan en el vector bucket, que se borra como cualquier otro
  // recurso del stack.
  dataDeletionPolicy: "RETAIN",
});

// La KB como Linkable: es un recurso crudo de aws-native (no auto-linkable),
// así que lo envolvemos para exponer su id por `Resource.KnowledgeBase.id`. Lo
// consume la Lambda de la tool `consultar_documentos`.
//
// La clave del `Resource` (`KnowledgeBase`) se la queda el Linkable y el
// recurso de la KB se llama `Conocimiento`: la validación de unicidad de
// nombres de SST solo mira los tipos `sst:*` y los tipos envueltos, así que un
// recurso crudo de aws-native podría reusar el nombre sin que nada se queje —
// pero dos cosas distintas con el mismo nombre en el diff del deploy y en los
// logs de Pulumi no se leen. Nombres distintos, a propósito.
//
// Un Linkable pelado NO otorga permisos: la Lambda que lo linkee necesita
// declarar `bedrock:Retrieve` sobre `kb.knowledgeBaseArn` en sus `permissions`.
// No va como `include` acá porque el ARN de la KB también hace falta suelto
// para otros scopes, y el módulo de las tools es el que decide qué otorga.
export const kbLink = new sst.Linkable("KnowledgeBase", {
  properties: { id: kb.knowledgeBaseId },
});
