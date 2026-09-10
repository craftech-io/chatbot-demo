// Renderiza el markdown que escribe el agente dentro de una burbuja del chat.
//
// La regla de seguridad de este módulo: **el modelo nunca aporta una etiqueta**.
// No se arma HTML con su salida ni se sanitiza después — se parsea a piezas y se
// construyen nodos con `createElement`, poniendo el texto siempre con
// `textContent`. Por eso no hay lista de etiquetas permitidas: la lista son los
// nodos que este archivo crea, y no hay camino por el que aparezca otro.
//
// El subconjunto está elegido midiendo lo que el agente emite de verdad sobre
// las conversaciones guardadas, no por lo que dice la especificación de
// markdown. Deliberadamente afuera: imágenes, HTML crudo y encabezados setext.
// Si el agente los usa, se ven como texto — nunca se pierde información.
//
// Sin dependencias: el widget se pega en la página de un cliente y cada KB
// cuenta.

// Protocolos que pueden ser un link. Todo lo demás (javascript:, data:,
// vbscript:, file:) se queda como texto plano: es el vector clásico de
// inyección cuando quien escribe el link es un modelo.
const PROTOCOLOS = ["http:", "https:", "mailto:"];

function esUrlSegura(url: string): boolean {
  try {
    // `new URL` normaliza mayúsculas, espacios y escapes raros
    // ("JavaScript:", " javascript:", "java\tscript:"), así que la comparación
    // se hace sobre el protocolo ya resuelto y no sobre el string crudo.
    return PROTOCOLOS.includes(new URL(url, "https://base.invalid").protocol);
  } catch {
    return false;
  }
}

function link(destino: HTMLElement, url: string, texto: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.textContent = texto;
  // El widget vive en la página del cliente: un link que abre en pestaña nueva
  // no puede quedarse con una referencia al `window` de esa página.
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  destino.append(a);
}

// Un tramo de texto plano, con las URLs sueltas convertidas en links (el agente
// las emite así: "Seguimiento: https://…").
const URL_SUELTA = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g;

function conUrls(destino: HTMLElement, texto: string): void {
  let ultimo = 0;
  for (const m of texto.matchAll(URL_SUELTA)) {
    const i = m.index ?? 0;
    if (i > ultimo) destino.append(texto.slice(ultimo, i));
    if (esUrlSegura(m[0])) link(destino, m[0], m[0]);
    else destino.append(m[0]);
    ultimo = i + m[0].length;
  }
  if (ultimo < texto.length) destino.append(texto.slice(ultimo));
}

// Marcas inline, en un solo barrido. El orden importa: el código va primero
// porque adentro de `code` no se interpreta nada más.
const INLINE =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)/;

function inline(destino: HTMLElement, texto: string): void {
  const m = INLINE.exec(texto);
  if (!m) {
    conUrls(destino, texto);
    return;
  }

  const antes = texto.slice(0, m.index);
  if (antes) conUrls(destino, antes);

  const pieza = m[0];
  if (pieza.startsWith("`")) {
    const code = document.createElement("code");
    code.textContent = pieza.slice(1, -1);
    destino.append(code);
  } else if (pieza.startsWith("[")) {
    const corte = pieza.indexOf("](");
    const etiqueta = pieza.slice(1, corte);
    const url = pieza.slice(corte + 2, -1);
    // Un link con protocolo no permitido no desaparece: se muestra tal cual lo
    // escribió el agente, para no ocultarle información al usuario.
    if (esUrlSegura(url)) link(destino, url, etiqueta);
    else destino.append(pieza);
  } else if (pieza.startsWith("**") || pieza.startsWith("__")) {
    const strong = document.createElement("strong");
    inline(strong, pieza.slice(2, -2));
    destino.append(strong);
  } else if (pieza.startsWith("~~")) {
    const del = document.createElement("del");
    inline(del, pieza.slice(2, -2));
    destino.append(del);
  } else {
    const em = document.createElement("em");
    inline(em, pieza.slice(1, -1));
    destino.append(em);
  }

  const despues = texto.slice(m.index + pieza.length);
  if (despues) inline(destino, despues);
}

// ── Bloques ────────────────────────────────────────────────────────────────

const CERCA = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;
const REGLA = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const ENCABEZADO = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const CITA = /^ {0,3}> ?(.*)$/;
const FILA = /^ {0,3}\|(.+)\|[ \t]*$/;
const SEPARADOR = /^ {0,3}\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/;
const ITEM = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/;

function esTabla(lineas: string[], i: number): boolean {
  return FILA.test(lineas[i]) && SEPARADOR.test(lineas[i + 1] ?? "");
}

/** Si en `i` empieza un bloque nuevo. Es lo que corta un párrafo sin necesidad
 *  de línea en blanco: el agente escribe "Pasos:" y sigue con la lista pegada. */
function abreBloque(lineas: string[], i: number): boolean {
  const l = lineas[i];
  return (
    l.trim() === "" ||
    CERCA.test(l) ||
    REGLA.test(l) ||
    ENCABEZADO.test(l) ||
    CITA.test(l) ||
    ITEM.test(l) ||
    esTabla(lineas, i)
  );
}

function parrafo(destino: HTMLElement, lineas: string[], i: number): number {
  const p = document.createElement("p");
  // Los saltos simples se preservan como <br>: el agente los usa para separar
  // renglones de un mismo bloque ("Referencia: …\nSeguimiento: …").
  for (let primero = true; i < lineas.length && !abreBloque(lineas, i); i++, primero = false) {
    if (!primero) p.append(document.createElement("br"));
    inline(p, lineas[i]);
  }
  destino.append(p);
  return i;
}

function encabezado(destino: HTMLElement, m: RegExpExecArray): void {
  // Desplazados dos niveles: el widget se monta DENTRO de la página del
  // cliente, que ya tiene su h1. Un "## Compras" del agente es contenido
  // subordinado, no una sección del documento anfitrión.
  const h = document.createElement(`h${Math.min(m[1].length + 2, 6)}`);
  inline(h, m[2]);
  destino.append(h);
}

function codigo(destino: HTMLElement, lineas: string[], i: number): number {
  const cerca = CERCA.exec(lineas[i])![1];
  const cuerpo: string[] = [];
  let j = i + 1;
  for (; j < lineas.length; j++) {
    const m = CERCA.exec(lineas[j]);
    if (m && m[1][0] === cerca[0] && m[1].length >= cerca.length && !m[2]) break;
    cuerpo.push(lineas[j]);
  }
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = cuerpo.join("\n");
  pre.append(code);
  destino.append(pre);
  return j + 1;
}

function cita(destino: HTMLElement, lineas: string[], i: number): number {
  const adentro: string[] = [];
  for (; i < lineas.length; i++) {
    const m = CITA.exec(lineas[i]);
    if (!m) break;
    adentro.push(m[1]);
  }
  const bq = document.createElement("blockquote");
  bloques(bq, adentro);
  destino.append(bq);
  return i;
}

function celdas(fila: string): string[] {
  // Los pipes de los bordes son opcionales en markdown; el agente los pone.
  return fila.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function tabla(destino: HTMLElement, lineas: string[], i: number): number {
  const alineacion = celdas(lineas[i + 1]).map((c) =>
    c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "",
  );
  const fila = (celdasDe: string[], etiqueta: "th" | "td"): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    celdasDe.forEach((texto, col) => {
      const celda = document.createElement(etiqueta);
      if (alineacion[col]) celda.style.textAlign = alineacion[col];
      inline(celda, texto);
      tr.append(celda);
    });
    return tr;
  };

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.append(fila(celdas(lineas[i]), "th"));
  table.append(thead);

  const tbody = document.createElement("tbody");
  let j = i + 2;
  for (; j < lineas.length && FILA.test(lineas[j]); j++) tbody.append(fila(celdas(lineas[j]), "td"));
  table.append(tbody);

  // La burbuja del chat es angosta: la tabla scrollea sola en vez de estirarla.
  const caja = document.createElement("div");
  caja.className = "cc-tabla";
  caja.append(table);
  destino.append(caja);
  return j;
}

function sangria(s: string): number {
  let n = 0;
  for (const c of s) n += c === "\t" ? 4 : 1;
  return n;
}

function lista(destino: HTMLElement, lineas: string[], i: number): number {
  const primero = ITEM.exec(lineas[i])!;
  const base = sangria(primero[1]);
  const numerada = /^\d/.test(primero[2]);
  const ul = document.createElement(numerada ? "ol" : "ul");

  while (i < lineas.length) {
    const m = ITEM.exec(lineas[i]);
    if (!m) break;
    const nivel = sangria(m[1]);
    if (nivel < base) break;
    if (nivel > base && ul.lastElementChild) {
      i = lista(ul.lastElementChild as HTMLElement, lineas, i);
      continue;
    }
    if (/^\d/.test(m[2]) !== numerada) break;
    const li = document.createElement("li");
    inline(li, m[3]);
    ul.append(li);
    i++;
  }

  destino.append(ul);
  return i;
}

function bloques(destino: HTMLElement, lineas: string[]): void {
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (l.trim() === "") {
      i++;
    } else if (CERCA.test(l)) {
      i = codigo(destino, lineas, i);
    } else if (REGLA.test(l)) {
      destino.append(document.createElement("hr"));
      i++;
    } else if (ENCABEZADO.test(l)) {
      encabezado(destino, ENCABEZADO.exec(l)!);
      i++;
    } else if (CITA.test(l)) {
      i = cita(destino, lineas, i);
    } else if (esTabla(lineas, i)) {
      i = tabla(destino, lineas, i);
    } else if (ITEM.test(l)) {
      i = lista(destino, lineas, i);
    } else {
      i = parrafo(destino, lineas, i);
    }
  }
}

/**
 * Reemplaza el contenido de `destino` por el markdown de `texto` renderizado.
 *
 * Solo se usa para las respuestas del agente. Los mensajes del propio widget
 * (errores, límites) siguen yendo por `textContent`: son literales nuestros y no
 * tienen markdown que interpretar.
 */
export function renderMarkdown(destino: HTMLElement, texto: string): void {
  destino.textContent = "";
  bloques(destino, texto.replace(/\r\n?/g, "\n").trim().split("\n"));
}
