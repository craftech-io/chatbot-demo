// Genera docs/arquitectura.excalidraw. Determinístico: regenerarlo da el mismo
// archivo, así el diff se lee.
//   node docs/arquitectura.mjs docs/arquitectura.excalidraw aersa-chat
import { writeFileSync } from "node:fs";

const [salida, slug = "aersa-chat", sabor = "cliente"] = process.argv.slice(2);
// El nombre de las dos apps depende del repo: acá son paths reales, en el
// proyecto base son piezas de ejemplo.
const NOMBRE_WEB = sabor === "generico" ? "App web\ncon el widget" : "apps/web\ncon el widget";
const NOMBRE_API = sabor === "generico" ? "API del cliente\ncatálogo · pedidos" : "apps/api\ncatálogo · pedidos";

let n = 0;
const id = (p) => `${p}-${String(++n).padStart(3, "0")}`;
let semilla = 1000;
const seed = () => (semilla = (semilla * 1103515245 + 12345) % 2147483647);

const P = {
  externo: { fondo: "#e9ecef", trazo: "#868e96" },
  ts: { fondo: "#a5d8ff", trazo: "#1971c2" },
  agente: { fondo: "#eebefa", trazo: "#9c36b5" },
  datos: { fondo: "#99e9f2", trazo: "#0c8599" },
  cola: { fondo: "#ffd8a8", trazo: "#e8590c" },
  modelo: { fondo: "#b2f2bb", trazo: "#2f9e44" },
  control: { fondo: "#ffc9c9", trazo: "#e03131" },
  zona: { fondo: "transparent", trazo: "#868e96" },
};

const els = [];
const base = (tipo, extra) => ({
  id: extra.id ?? id(tipo),
  type: tipo, x: 0, y: 0, width: 0, height: 0, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
  groupIds: [], frameId: null, index: null, roundness: { type: 3 },
  seed: seed(), version: 1, versionNonce: seed(), isDeleted: false,
  boundElements: null, updated: 1, link: null, locked: false,
  ...extra,
});

function caja(nombre, { x, y, w, h, texto, paleta = P.externo, estilo = "solid" }) {
  const cid = `caja-${nombre}`, tid = `texto-${nombre}`;
  const lineas = texto.split("\n").length;
  els.push(base("rectangle", {
    id: cid, x, y, width: w, height: h,
    backgroundColor: paleta.fondo, strokeColor: paleta.trazo, strokeStyle: estilo,
    boundElements: [{ id: tid, type: "text" }],
  }));
  els.push(base("text", {
    id: tid, x: x + 8, y: y + h / 2 - (lineas * 20) / 2,
    width: w - 16, height: lineas * 20, text: texto, originalText: texto,
    fontSize: 16, fontFamily: 5, lineHeight: 1.25,
    textAlign: "center", verticalAlign: "middle",
    containerId: cid, autoResize: true, strokeColor: "#1e1e1e",
  }));
  return cid;
}

function rotulo(texto, { x, y, tam = 16, color = "#1e1e1e" }) {
  els.push(base("text", {
    x, y, width: texto.length * tam * 0.55, height: tam * 1.25,
    text: texto, originalText: texto, fontSize: tam, fontFamily: 5,
    lineHeight: 1.25, textAlign: "left", verticalAlign: "top",
    containerId: null, autoResize: true, strokeColor: color, roundness: null,
  }));
}

const anclas = { izq: [0, 0.5], der: [1, 0.5], arriba: [0.5, 0], abajo: [0.5, 1] };
const punto = (a) => (Array.isArray(a) ? a : anclas[a]);

function flecha(desdeId, haciaId, { de = "der", a = "izq", etiqueta = "", doble = false, asinc = false } = {}) {
  const A = els.find((e) => e.id === desdeId), B = els.find((e) => e.id === haciaId);
  const fpA = punto(de), fpB = punto(a);
  const x1 = A.x + A.width * fpA[0], y1 = A.y + A.height * fpA[1];
  const x2 = B.x + B.width * fpB[0], y2 = B.y + B.height * fpB[1];
  const aid = id("flecha");
  const bound = [];
  if (etiqueta) {
    const tid = `${aid}-txt`;
    bound.push({ id: tid, type: "text" });
    els.push(base("text", {
      id: tid, x: (x1 + x2) / 2 - etiqueta.length * 3.5, y: (y1 + y2) / 2 - 10,
      width: etiqueta.length * 7, height: 20, text: etiqueta, originalText: etiqueta,
      fontSize: 14, fontFamily: 5, lineHeight: 1.25, textAlign: "center",
      verticalAlign: "middle", containerId: aid, autoResize: true,
      strokeColor: "#495057", roundness: null,
    }));
  }
  els.push(base("arrow", {
    id: aid, x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
    points: [[0, 0], [x2 - x1, y2 - y1]],
    startBinding: { elementId: desdeId, fixedPoint: fpA, mode: "orbit" },
    endBinding: { elementId: haciaId, fixedPoint: fpB, mode: "orbit" },
    startArrowhead: doble ? "arrow" : null, endArrowhead: "arrow", elbowed: false,
    roundness: { type: 2 }, strokeColor: "#495057",
    strokeStyle: asinc ? "dashed" : "solid",
    boundElements: bound.length ? bound : null,
  }));
  for (const el of [A, B]) el.boundElements = [...(el.boundElements ?? []), { id: aid, type: "arrow" }];
}

// ─────────────────────────── diagrama ───────────────────────────
rotulo(`${slug} — arquitectura`, { x: 60, y: 40, tam: 28 });
rotulo("Un turno completo: del widget al modelo y de vuelta", { x: 60, y: 88, tam: 16, color: "#495057" });

els.push(base("rectangle", {
  id: "marco-cuenta", x: 330, y: 170, width: 1530, height: 940,
  backgroundColor: "transparent", strokeStyle: "dashed", strokeColor: "#868e96",
}));
rotulo("Cuenta de AWS del cliente", { x: 352, y: 186, tam: 15, color: "#868e96" });

// Fuera del stack.
const web = caja("web", { x: 60, y: 280, w: 250, h: 90, texto: NOMBRE_WEB });
const idp = caja("idp", { x: 60, y: 470, w: 250, h: 80, texto: "IdP del cliente\nJWKS / HMAC" });
const langfuse = caja("langfuse", { x: 1630, y: 30, w: 230, h: 90, estilo: "dashed", texto: "Langfuse\ntrazas del agente" });
const jsm = caja("jsm", { x: 1940, y: 800, w: 200, h: 80, texto: "Jira Service\nManagement" });
const confluence = caja("confluence", { x: 20, y: 960, w: 230, h: 80, texto: "Confluence\nespacios permitidos" });

// El camino del mensaje.
const bff = caja("bff", { x: 390, y: 280, w: 200, h: 90, texto: "BFF\nFunction URL", paleta: P.ts });
const cola = caja("cola", { x: 720, y: 280, w: 180, h: 90, texto: "MensajesCola\nSQS FIFO", paleta: P.cola });
const worker = caja("worker", { x: 1030, y: 280, w: 190, h: 90, texto: "Worker", paleta: P.ts });
const runtime = caja("runtime", { x: 1350, y: 265, w: 240, h: 120, texto: "AgentCore Runtime\ncontenedor BYOC\nARM64", paleta: P.agente });
const bedrock = caja("bedrock", { x: 1660, y: 280, w: 180, h: 90, texto: "Bedrock\nel modelo", paleta: P.modelo });

const tabla = caja("tabla", { x: 390, y: 470, w: 200, h: 80, texto: "MessagesTable\nDynamoDB", paleta: P.datos });
const guardrail = caja("guardrail", { x: 720, y: 470, w: 180, h: 80, texto: "Guardrails\nentrada · PII", paleta: P.control });

caja("obs", { x: 390, y: 640, w: 280, h: 110, paleta: P.zona, estilo: "dashed",
  texto: "Observabilidad\nCloudWatch · X-Ray\nmétricas, trazas, costo" });
const gateway = caja("gateway", { x: 1350, y: 640, w: 240, h: 90, texto: "AgentCore Gateway\nMCP", paleta: P.agente });

// Las tools.
const toolDocs = caja("tool-docs", { x: 980, y: 810, w: 220, h: 80, texto: "consultar_documentos", paleta: P.ts });
const apiNegocio = caja("api", { x: 1240, y: 810, w: 200, h: 80, texto: NOMBRE_API, paleta: P.ts });
const toolEsc = caja("tool-esc", { x: 1490, y: 810, w: 210, h: 80, texto: "escalar_a_humano", paleta: P.ts });

// Conocimiento.
const ingestor = caja("ingestor", { x: 390, y: 960, w: 230, h: 80, texto: "Ingestor\nEventBridge Scheduler", paleta: P.ts });
const bucket = caja("bucket", { x: 700, y: 960, w: 190, h: 80, texto: "Bucket\nDocumentos", paleta: P.datos });
const kb = caja("kb", { x: 970, y: 960, w: 220, h: 80, texto: "Knowledge Base\ngestionada", paleta: P.datos });

// Flujo.
flecha(web, bff, { de: [1, 0.28], a: [0, 0.28], etiqueta: "POST" });
flecha(bff, web, { de: [0, 0.78], a: [1, 0.78], etiqueta: "polling", asinc: true });
flecha(idp, bff, { de: "der", a: [0, 1], etiqueta: "verifica el token" });
flecha(bff, cola, { etiqueta: "encola", asinc: true });
flecha(cola, worker, { asinc: true });
flecha(worker, runtime, { etiqueta: "Invoke" });
flecha(runtime, bedrock, {});
flecha(bff, tabla, { de: "abajo", a: "arriba", etiqueta: "escribe" });
flecha(worker, tabla, { de: [0.15, 1], a: [1, 0.25], etiqueta: "respuesta" });
flecha(tabla, worker, { de: [1, 0.9], a: [0.6, 1], etiqueta: "historial" });
flecha(bff, guardrail, { de: [0.85, 1], a: [0.2, 0], etiqueta: "antes de invocar" });
flecha(runtime, gateway, { de: "abajo", a: "arriba", etiqueta: "MCP · SigV4" });
flecha(gateway, toolDocs, { de: [0.15, 1], a: "arriba" });
flecha(gateway, apiNegocio, { de: [0.5, 1], a: "arriba" });
flecha(gateway, toolEsc, { de: [0.85, 1], a: "arriba" });
flecha(toolDocs, kb, { de: "abajo", a: "arriba", etiqueta: "Retrieve" });
flecha(bucket, kb, { etiqueta: "ingesta" });
flecha(toolEsc, jsm, { de: [1, 0.3], a: [0, 0.3], etiqueta: "crea el ticket" });
flecha(confluence, ingestor, { etiqueta: "páginas" });
flecha(ingestor, bucket, {});
flecha(runtime, langfuse, { de: [0.8, 0], a: [0.5, 1], etiqueta: "OTLP · opt-in", asinc: true });

// Leyenda.
const leyenda = [
  ["Fuera del stack", P.externo, 60], ["TypeScript", P.ts, 330],
  ["AgentCore", P.agente, 540], ["Datos", P.datos, 770],
  ["Cola (async)", P.cola, 940], ["Control", P.control, 1180], ["Modelo", P.modelo, 1360],
];
for (const [texto, par, x] of leyenda) {
  els.push(base("rectangle", { x, y: 1150, width: 24, height: 24, backgroundColor: par.fondo, strokeColor: par.trazo }));
  rotulo(texto, { x: x + 34, y: 1153, tam: 14, color: "#495057" });
}

writeFileSync(salida, JSON.stringify({
  type: "excalidraw", version: 2, source: "https://excalidraw.com",
  elements: els, appState: { gridSize: null, viewBackgroundColor: "#ffffff" }, files: {},
}, null, 2));
console.log(`${els.length} elementos`);
