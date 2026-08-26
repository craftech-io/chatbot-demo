// El server sirve packages/widget/dist/widget.js tal cual (ver server.mjs).
// Este test pinea que ese bundle sea el widget v2 (asíncrono: monta con
// apiUrl y habla POST/GET /mensajes). Bug real que motiva el pin: un dist
// viejo de la fase 2a (streaming, opción chatUrl) quedó en disco y el demo lo
// sirvió sin quejarse — el widget montado con {apiUrl} hacía fetch(undefined)
// y mostraba "Hubo un problema al responder" en todos los mensajes. El build
// fresco lo garantizan los hooks prestart/pretest de package.json.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("contrato del bundle del widget que sirve el demo", () => {
  it("es el widget v2: apiUrl + /mensajes, sin rastros del streaming (chatUrl)", async () => {
    const js = await readFile(
      new URL("../../packages/widget/dist/widget.js", import.meta.url),
      "utf8",
    );

    expect(js).toContain("/mensajes");
    expect(js).toContain("apiUrl");
    expect(js).not.toContain("chatUrl");
  });
});
