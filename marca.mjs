// Identidad visual del cliente: el ÚNICO lugar donde se edita el branding.
//
// En el TEMPLATE estos valores son los de fábrica. Al clonar para un cliente se
// reemplazan por los suyos — el skill `marca-del-cliente` conduce ese trabajo:
// saca la paleta de su logo, verifica contraste y avisa cuando el color de marca
// no se puede usar tal cual.
//
// Es `.mjs` y no parte de `client.config.ts` a propósito: lo consume
// `examples/demo-client/server.mjs`, que es JavaScript plano sin build. Un `.ts` obligaría a
// type stripping (experimental en Node < 22.18) o a un paso de compilación solo
// para leer cuatro colores. `client.config.ts` lo importa y lo expone como
// `cliente.marca`, así que sigue habiendo un solo lugar por tema.
//
// Los colores del widget son custom properties `--cc-*` dentro de un `@layer`:
// la página anfitriona los pisa con cualquier selector y gana (ver el contrato
// de theming en packages/widget/src/index.ts). Por eso alcanza con redefinirlos
// acá; el widget no se toca.

export const marca = {
  /** Nombre visible: va al `<title>` y al encabezado de la app. */
  nombre: "Asistente",   // ← el nombre que ve el usuario del cliente

  /**
   * Logo. Ruta servida por la app (`examples/demo-client/public/…`) o un data URI.
   * Vacío ⇒ solo se muestra el nombre, sin hueco ni imagen rota.
   *
   */
  logo: "",

  /** Alto del logo en el encabezado. Un SVG escala; un PNG conviene a 2x. */
  logoAlto: "28px",

  /**
   * Paleta del modo claro. `acento` es el color de las burbujas del usuario y
   * de los botones; `acentoTexto` es lo que se escribe ENCIMA del acento, así
   * que su contraste contra `acento` es el que hay que mirar, no contra el
   * fondo.
   */
  claro: {
    fondo: "#F7F8F6",
    tarjeta: "#ffffff",
    texto: "#1C2422",
    linea: "#DBE1DD",
    acento: "#0E7568",
    acentoTexto: "#ffffff",
    /** Fondo de la burbuja del asistente. No se deriva de `tarjeta`: quiere un
     *  contraste apenas distinto para que las dos burbujas se distingan. */
    fondoResp: "#f1f3f2",
  },

  /**
   * Paleta del modo oscuro. La decide la página, no el widget: no toda página
   * oscura quiere los mismos colores. Un acento pensado para fondo claro suele
   * quedar apagado acá, por eso se declara aparte en vez de derivarse.
   */
  oscuro: {
    fondo: "#131917",
    tarjeta: "#1A211E",
    texto: "#E7ECE9",
    linea: "#2B342F",
    acento: "#3CB8A6",
    acentoTexto: "#0E1512",
    fondoResp: "#232B27",
  },

  /** Tipografía. Conviene dejar el stack del sistema al final como fallback. */
  fuente: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',

  /** Redondeo de las burbujas del chat. */
  radio: "14px",
};

/**
 * Contraste WCAG entre dos colores. El par que importa es `acentoTexto` sobre
 * `acento`: es el texto de las burbujas del usuario y de los botones. Un acento
 * de marca con texto blanco encima suele quedar en 2:1 y nadie lo nota hasta
 * que alguien no puede leerlo.
 */
function contraste(hex1, hex2) {
  const lum = (hex) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [a, b] = [lum(hex1), lum(hex2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/**
 * Avisa —no corta— si un par no llega a 4.5:1, el mínimo de WCAG AA para texto
 * normal. No corta porque la marca del cliente es la marca del cliente: la
 * decisión de usar un color con poco contraste es suya, pero tiene que ser
 * consciente y no un descubrimiento del primer usuario.
 */
export function revisarContraste(m = marca) {
  const avisos = [];
  for (const modo of ["claro", "oscuro"]) {
    const p = m[modo];
    for (const [sobre, texto, que] of [
      [p.acento, p.acentoTexto, "acentoTexto sobre acento"],
      [p.fondoResp, p.textoResp ?? p.texto, "texto sobre fondoResp"],
      [p.fondo, p.texto, "texto sobre fondo"],
    ]) {
      const r = contraste(sobre, texto);
      if (r < 4.5) avisos.push(`${modo}: ${que} da ${r.toFixed(2)}:1 (mínimo 4.5)`);
    }
  }
  return avisos;
}

/**
 * Las custom properties que la página inyecta, derivadas de `marca`.
 *
 * Pisa las `--cc-*` del widget en LOS DOS modos, no solo en oscuro: en claro el
 * widget usa sus defaults de fábrica, así que sin esto el marco de la página
 * toma el color de la marca y las burbujas del chat se quedan con el verde
 * original.
 *
 * Este CSS va SIN `@layer` a propósito: el del widget vive en `@layer
 * cc-widget` y las reglas sin capa le ganan siempre, sin importar el orden en
 * que `mount()` haya inyectado su `<style>`.
 */
export function cssDeMarca(m = marca) {
  const marco = (p) => `
    --bg: ${p.fondo};
    --tarjeta: ${p.tarjeta};
    --texto: ${p.texto};
    --linea: ${p.linea};
    --acento: ${p.acento};
    --acento-texto: ${p.acentoTexto};`;
  const burbujas = (p) => `
      --cc-acento: ${p.acento};
      --cc-acento-texto: ${p.acentoTexto};
      --cc-fondo-resp: ${p.fondoResp};
      --cc-texto-resp: ${p.texto};
      --cc-fuente: ${m.fuente};
      --cc-radio: ${m.radio};`;
  return `
  :root {${marco(m.claro)}
  }

  .cc-hilo {${burbujas(m.claro)}
  }

  @media (prefers-color-scheme: dark) {
    :root {${marco(m.oscuro)}
    }

    .cc-hilo {${burbujas(m.oscuro)}
    }

    .badge.live { background: ${m.oscuro.tarjeta}; }
  }`;
}
