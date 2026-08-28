// Renderiza el markdown que escribe el agente dentro de una burbuja del chat.
//
// La regla de seguridad de este módulo: **el modelo nunca aporta una etiqueta**.
// No se arma HTML con su salida ni se sanitiza después — se parsea a piezas y se
// construyen nodos con `createElement`, poniendo el texto siempre con
// `textContent`. Por eso no hay lista de etiquetas permitidas: la lista son los
// nodos que este archivo crea, y no hay camino por el que aparezca otro.
//
// El subconjunto está elegido por lo que el agente emite de verdad: párrafos,
// negrita, itálica, código inline, listas (con guion y numeradas) y links.
// Deliberadamente afuera: imágenes, tablas, encabezados, HTML crudo y
// blockquotes. Si el agente los usa, se ven como texto — nunca se pierde
// información.
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
const INLINE = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/;

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
  } else if (pieza.startsWith("**")) {
    const strong = document.createElement("strong");
    inline(strong, pieza.slice(2, -2));
    destino.append(strong);
  } else {
    const em = document.createElement("em");
    inline(em, pieza.slice(1, -1));
    destino.append(em);
  }

  const despues = texto.slice(m.index + pieza.length);
  if (despues) inline(destino, despues);
}

// Los saltos simples dentro de un párrafo se preservan como <br>: el agente los
// usa para separar renglones de un mismo bloque ("Referencia: …\nSeguimiento: …").
function parrafo(destino: HTMLElement, texto: string): void {
  const p = document.createElement("p");
  const renglones = texto.split("\n");
  renglones.forEach((renglon, i) => {
    if (i > 0) p.append(document.createElement("br"));
    inline(p, renglon);
  });
  destino.append(p);
}

const ITEM_GUION = /^[-*]\s+(.*)$/;
const ITEM_NUMERO = /^\d+[.)]\s+(.*)$/;

function lista(destino: HTMLElement, renglones: string[], numerada: boolean): void {
  const ul = document.createElement(numerada ? "ol" : "ul");
  for (const renglon of renglones) {
    const m = (numerada ? ITEM_NUMERO : ITEM_GUION).exec(renglon);
    if (!m) continue;
    const li = document.createElement("li");
    inline(li, m[1]);
    ul.append(li);
  }
  destino.append(ul);
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

  // Los bloques se separan por línea en blanco. Dentro de un bloque, si los
  // renglones son ítems de lista, es una lista; si no, un párrafo.
  for (const bloque of texto.trim().split(/\n\s*\n/)) {
    const renglones = bloque.split("\n").filter((r) => r.trim() !== "");
    if (renglones.length === 0) continue;

    const guiones = renglones.filter((r) => ITEM_GUION.test(r));
    const numeros = renglones.filter((r) => ITEM_NUMERO.test(r));

    if (guiones.length === renglones.length) {
      lista(destino, renglones, false);
    } else if (numeros.length === renglones.length) {
      lista(destino, renglones, true);
    } else if (guiones.length > 0 || numeros.length > 0) {
      // Bloque mixto: el texto suelto de arriba como párrafo y los ítems como
      // lista. Es el caso "Destinos disponibles:\n- Ciudad\n- Resto del país",
      // que el agente escribe sin la línea en blanco del medio.
      const corte = renglones.findIndex((r) => ITEM_GUION.test(r) || ITEM_NUMERO.test(r));
      parrafo(destino, renglones.slice(0, corte).join("\n"));
      const items = renglones.slice(corte);
      lista(destino, items, ITEM_NUMERO.test(items[0]) && !ITEM_GUION.test(items[0]));
    } else {
      parrafo(destino, bloque);
    }
  }
}
