// El agente responde en markdown y la burbuja lo mostraba literal (asteriscos y
// links crudos a la vista del usuario). Estos tests fijan el contrato del
// renderizador: qué se convierte en nodos y —sobre todo— qué NO puede pasar.
//
// La defensa no es una lista de etiquetas permitidas: el modelo nunca aporta
// una etiqueta. Solo aporta texto, que va dentro de nodos que crea este módulo.
// Los tests de inyección de abajo son el pin de esa propiedad.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

function html(md: string): string {
  const destino = document.createElement("div");
  renderMarkdown(destino, md);
  return destino.innerHTML;
}

function texto(md: string): string {
  const destino = document.createElement("div");
  renderMarkdown(destino, md);
  return destino.textContent ?? "";
}

describe("renderMarkdown: nada del modelo se interpreta como HTML", () => {
  it("una etiqueta en la respuesta se ve como texto, no se ejecuta", () => {
    const salida = html("<script>alert(1)</script> y <img src=x onerror=alert(1)>");

    expect(salida).not.toContain("<script");
    expect(salida).not.toContain("<img");
    expect(salida).toContain("&lt;script&gt;");
    expect(texto("<b>ojo</b>")).toBe("<b>ojo</b>");
  });

  it("un link con protocolo javascript: NO se convierte en link", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, "[hacé click](javascript:alert(1))");

    expect(destino.querySelector("a")).toBeNull();
    // El texto sigue visible, sin perder información.
    expect(destino.textContent).toContain("hacé click");
  });

  it("tampoco pasan data:, vbscript: ni file:", () => {
    for (const url of ["data:text/html,<script>x</script>", "vbscript:msgbox", "file:///etc/passwd"]) {
      const destino = document.createElement("div");
      renderMarkdown(destino, `[x](${url})`);
      expect(destino.querySelector("a"), url).toBeNull();
    }
  });

  it("un javascript: con mayúsculas o espacios tampoco pasa", () => {
    for (const url of ["JavaScript:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)"]) {
      const destino = document.createElement("div");
      renderMarkdown(destino, `[x](${url})`);
      expect(destino.querySelector("a"), url).toBeNull();
    }
  });

  it("los links http(s) que sí pasan no le dan acceso al opener", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, "[soporte](https://soporte.example/casos/SOP-1)");
    const a = destino.querySelector("a");

    expect(a?.getAttribute("href")).toBe("https://soporte.example/casos/SOP-1");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.textContent).toBe("soporte");
  });
});

describe("renderMarkdown: el subconjunto que el agente emite", () => {
  it("negrita, itálica y código inline", () => {
    expect(html("Tenés **30 días** corridos")).toContain("<strong>30 días</strong>");
    expect(html("es *importante*")).toContain("<em>importante</em>");
    expect(html("el formato `A-####`")).toContain("<code>A-####</code>");
  });

  it("los asteriscos ya no se ven en el texto", () => {
    expect(texto("Tenés **30 días corridos** desde que recibís")).toBe(
      "Tenés 30 días corridos desde que recibís",
    );
  });

  it("párrafos separados por línea en blanco", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, "Primero.\n\nSegundo.");

    expect(destino.querySelectorAll("p")).toHaveLength(2);
    expect(destino.querySelectorAll("p")[1].textContent).toBe("Segundo.");
  });

  it("un salto simple queda como salto de línea dentro del párrafo", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, "Referencia: SOP-1\nSeguimiento: pendiente");

    expect(destino.querySelectorAll("p")).toHaveLength(1);
    expect(destino.querySelectorAll("br")).toHaveLength(1);
  });

  it("listas con guion y numeradas", () => {
    const conGuion = document.createElement("div");
    renderMarkdown(conGuion, "Destinos:\n\n- Ciudad\n- Resto del país\n- Retiro en el local");
    expect(conGuion.querySelectorAll("ul li")).toHaveLength(3);
    expect(conGuion.querySelectorAll("ul li")[1].textContent).toBe("Resto del país");

    const numerada = document.createElement("div");
    renderMarkdown(numerada, "1. Primero\n2. Segundo");
    expect(numerada.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("el markdown dentro de un ítem de lista también se renderiza", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, "- El producto debe estar **sin uso**");

    expect(destino.querySelector("li strong")?.textContent).toBe("sin uso");
  });

  it("una URL suelta se convierte en link (el agente las emite así)", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, "Seguimiento: https://soporte.example/casos/SOP-851809");
    const a = destino.querySelector("a");

    expect(a?.getAttribute("href")).toBe("https://soporte.example/casos/SOP-851809");
    expect(a?.textContent).toBe("https://soporte.example/casos/SOP-851809");
  });

  it("un texto sin nada de markdown queda igual", () => {
    const plano = "No pude derivar la consulta porque no hay un destino configurado.";
    expect(texto(plano)).toBe(plano);
  });

  it("render sobre una burbuja que ya tenía contenido lo reemplaza, no lo apila", () => {
    const destino = document.createElement("div");
    destino.textContent = "viejo";
    renderMarkdown(destino, "nuevo");

    expect(destino.textContent).toBe("nuevo");
  });

  it("un asterisco solo o sin cerrar no rompe ni desaparece", () => {
    expect(texto("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(texto("esto **quedó sin cerrar")).toBe("esto **quedó sin cerrar");
  });
});

// Golden con la respuesta REAL del agente en staging (copiada de MessagesTable):
// es el caso que motivó esta capacidad. Pinea que lo que el usuario lee no tiene
// sintaxis a la vista y que las piezas quedaron como nodos.
describe("renderMarkdown: la respuesta real que motivó esto", () => {
  const REAL = [
    "Tenés **30 días corridos** desde que recibís el pedido para iniciar un cambio o devolución.",
    "",
    "Algunas condiciones importantes (según la **[Política de devoluciones](https://ayuda.ciclosaurora.example/devoluciones)**):",
    "",
    "- El producto debe estar **sin uso**, en su **embalaje original**, con todos sus accesorios y etiquetas.",
    "- Los consumibles abiertos no tienen cambio.",
    "",
    "Para iniciarla, escribí con el número de pedido (formato `A-####`).",
  ].join("\n");

  it("el usuario no ve asteriscos, corchetes ni backticks", () => {
    const visible = texto(REAL);

    expect(visible).toContain("30 días corridos");
    expect(visible).not.toContain("**");
    expect(visible).not.toContain("](");
    expect(visible).not.toContain("`");
  });

  it("las piezas quedaron como nodos, y el link apunta al documento", () => {
    const destino = document.createElement("div");
    renderMarkdown(destino, REAL);

    expect(destino.querySelectorAll("p")).toHaveLength(3);
    expect(destino.querySelectorAll("li")).toHaveLength(2);
    expect(destino.querySelectorAll("strong").length).toBeGreaterThanOrEqual(4);
    expect(destino.querySelector("code")?.textContent).toBe("A-####");
    expect(destino.querySelector("a")?.getAttribute("href")).toBe(
      "https://ayuda.ciclosaurora.example/devoluciones",
    );
  });
});
