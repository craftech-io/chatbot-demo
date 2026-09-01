// Conocimiento (RAG): Bedrock Knowledge Base GESTIONADA. AWS opera el modelo de
// embeddings, el reranker y el almacén de vectores; acá solo se declara el
// bucket con los documentos y el conector que los lee.
//
// Recursos:
//   - sst.aws.Bucket                              : fuente (los documentos)  [nativo SST]
//   - aws.iam.Role/RolePolicy                     : rol de ejecución de la KB [classic]
//   - awsnative.bedrock.KnowledgeBase + DataSource: la KB y su data source   [Cloud Control]
//
// El provider classic `aws` no expone la Knowledge Base: va por `awsnative`
// (espeja el tipo CFN `AWS::Bedrock::KnowledgeBase`, que sí soporta
// `S3VectorsConfiguration`). Ver infra/CONTRACT.md, "Providers y globals".
//
// La ingesta NO es automática: subir documentos al bucket no los indexa. Hay que
// disparar un ingestion job (`aws bedrock-agent start-ingestion-job`) — ver
// documentos/README.md.
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
import { createHash } from "node:crypto";
import { cliente } from "../../client.config";
import { slugKebab } from "./nombres";

// Región del provider activo, sin hardcodes: el deploy la toma de
// `AWS_REGION` o de `cliente.region` (ver sst.config.ts).
// `.name` en GetRegionResult está deprecado a favor de `.region` (mismo valor).
const awsRegion = aws.getRegionOutput().region;


// acepta mayúsculas ni `_`, así que el stage se sanea (un stage `PR_12` haría
// fallar el create). El prefijo sale del slug del cliente (infra/sst/nombres.ts).
const stageSaneado = $app.stage
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Bucket fuente: acá viven los documentos. El contenido se sube post-deploy,
// desde `documentos/` o desde el ingestor de Confluence.
export const kbSource = new sst.aws.Bucket("Documentos");

// El nombre del rol de ejecución de la KB es un REQUISITO DE BEDROCK, no una
// convención nuestra: `CreateKnowledgeBase` valida que el ARN del rol empiece
// con `AmazonBedrockExecutionRoleForKnowledgeBase_` y si no, responde
// ValidationException. Lo dice también el `.d.ts` del recurso.
const PREFIJO_ROL_KB = "AmazonBedrockExecutionRoleForKnowledgeBase_";

// Cuenta del presupuesto: IAM limita el nombre de un rol a 64 caracteres y el
// prefijo obligatorio se come 43, así que quedan 21 para el sufijo. Con el slug
// `aersa-chat` (10) y un stage largo (`production`, 10) entra justo; con un slug
// más largo el nombre se pasaría, y el error saldría recién al crear el rol.
//
// Qué se sacrifica y en qué orden. Lo que distingue dos stacks dentro de una
// misma cuenta (el despliegue es BYOC, una cuenta por cliente) es el STAGE, y dos
// roles con el mismo nombre son el mismo recurso, así que el stage es lo último
// que se toca:
//   1. si `slug-stage` entra, va entero;
//   2. si no, se recorta el SLUG y el stage viaja completo;
//   3. y si ni el stage solo entra en el presupuesto, NO se lo trunca: se lo
//      recorta y se le cuelga un hash corto del stage COMPLETO. Truncarlo sería
//      peor que ilegible: dos stages que comparten los primeros caracteres
//      (`pr-1234-una-rama-muy-larga` y `pr-1234-una-rama-muy-corta`) darían el
//      MISMO nombre de rol — el segundo deploy muere con EntityAlreadyExists, y
//      borrar el primer stack se llevaría el rol del segundo.
const PRESUPUESTO_SUFIJO = 64 - PREFIJO_ROL_KB.length;

// No es criptografía, es desambiguación: 8 hex de sha256 alcanzan para que dos
// stages distintos no compartan nombre de rol, y el nombre sigue siendo
// determinístico (mismo stage ⇒ mismo rol, sin recrearlo en cada deploy).
const LARGO_HASH_STAGE = 8;
const hashStage = createHash("sha256")
  .update(stageSaneado)
  .digest("hex")
  .slice(0, LARGO_HASH_STAGE);

// Recorta y saca los guiones que queden al final: `aersa--production` IAM lo
// acepta, pero no se lee.
const recorta = (valor: string, largo: number) =>
  valor.slice(0, Math.max(0, largo)).replace(/-+$/, "");

const sufijoCompleto = `${slugKebab}-${stageSaneado}`;
const espacioParaElSlug = PRESUPUESTO_SUFIJO - stageSaneado.length - 1;
const sufijoRolKb =
  sufijoCompleto.length <= PRESUPUESTO_SUFIJO
    ? sufijoCompleto
    : espacioParaElSlug >= 1
      ? `${recorta(slugKebab, espacioParaElSlug)}-${stageSaneado}`
      : `${recorta(stageSaneado, PRESUPUESTO_SUFIJO - LARGO_HASH_STAGE - 1)}-${hashStage}`;

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
  policy: kbSource.arn.apply((sourceArn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          // Con embeddings y reranking GESTIONADOS, AWS elige los modelos y no
          // publica cuáles: no hay ARN al que acotar el permiso. Es el precio
          // de que el pipeline sea gestionado.
          Sid: "ModelosGestionados",
          Effect: "Allow",
          Action: ["bedrock:InvokeModel", "bedrock:Rerank"],
          Resource: "*",
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
    // Gestionada: AWS elige y opera el modelo de embeddings, el reranker y el
    // almacén de vectores. No hay `storageConfiguration` que declarar.
    type: "MANAGED",
    managedKnowledgeBaseConfiguration: { embeddingModelType: "MANAGED" },
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
    // Una KB gestionada rechaza el data source S3 clásico: usa sus conectores.
    // `connectorParameters` es un documento libre y su forma NO está en el
    // schema; esta es la que acepta el servicio (verificada contra la API).
    type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
    managedKnowledgeBaseConnectorConfiguration: {
      deletionProtectionConfiguration: { deletionProtectionStatus: "DISABLED" },
      connectorParameters: $util.all([kbSource.nodes.bucket.bucket, aws.getCallerIdentityOutput().accountId])
        .apply(([bucketName, cuenta]) => ({
          type: "S3",
          version: "1",
          connectionConfiguration: { bucketName, bucketOwnerAccountId: cuenta },
        })),
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
