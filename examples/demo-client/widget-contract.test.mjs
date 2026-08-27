// El server sirve packages/widget/dist/widget.js tal cual (ver server.mjs), y
// un dist desactualizado en disco se serviría sin que nada se queje: el widget
// montado con {apiUrl} haría fetch(undefined) y mostraría "Hubo un problema al
// responder" en todos los mensajes. Este test pinea que el bundle sea el
// asíncrono (monta con apiUrl y habla POST/GET /mensajes); el build fresco lo
// garantizan los hooks prestart/pretest de package.json.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("contrato del bundle del widget que sirve el demo", () => {
  it("es el widget asíncrono: apiUrl + /mensajes, sin la opción chatUrl", async () => {
    const js = await readFile(
      new URL("../../packages/widget/dist/widget.js", import.meta.url),
      "utf8",
    );

    expect(js).toContain("/mensajes");
    expect(js).toContain("apiUrl");
    expect(js).not.toContain("chatUrl");
  });
});
