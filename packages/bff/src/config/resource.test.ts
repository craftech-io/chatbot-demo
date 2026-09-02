// Con JWKS activo y solo UNO de issuer/audience configurado ("half-pin"), lo
// más probable es un secret olvidado — y con un emisor multi-app (Cognito) eso
// deja pasar tokens de OTRAS apps del mismo pool. fromResource() avisa por
// console.warn; no corta, porque pinear solo issuer es legítimo para emisores
// cuyos tokens no traen `aud`. Acá el proxy Resource de sst se reemplaza por un
// objeto plano.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: {
    ClientAuth: { jwksUrl: "", hmacSecret: "", issuer: "", audience: "" },
    Guardrail: { id: "g-1", version: "1" },
    SessionsTable: { name: "sesiones" },
    LimitsTable: { name: "limites" },
    MessagesTable: { name: "mensajes" },
    MensajesCola: { url: "https://sqs.example/cola" },
  },
}));

import { Resource } from "sst";
import { fromResource } from "./resource";

// El mock de arriba es un objeto plano: se muta por caso y se restaura acá.
function configurarClientAuth(valores: Partial<(typeof Resource)["ClientAuth"]>) {
  Object.assign(Resource.ClientAuth, { jwksUrl: "", hmacSecret: "", issuer: "", audience: "" }, valores);
}

const HMAC_VALIDO = "un-secreto-de-al-menos-32-bytes!!";

describe("fromResource: aviso de pineo JWKS incompleto (half-pin)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("issuer sin audience → warn que nombra ClientTokenAudience", () => {
    configurarClientAuth({ jwksUrl: "https://emisor/jwks.json", issuer: "https://emisor" });
    fromResource();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("ClientTokenAudience");
  });

  it("audience sin issuer → warn que nombra ClientTokenIssuer", () => {
    configurarClientAuth({ jwksUrl: "https://emisor/jwks.json", audience: "cliente-1" });
    fromResource();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("ClientTokenIssuer");
  });

  it("ambos seteados → sin warn, y el verifier los lleva", () => {
    configurarClientAuth({
      jwksUrl: "https://emisor/jwks.json",
      issuer: "https://emisor",
      audience: "cliente-1",
    });
    const cfg = fromResource();
    expect(warn).not.toHaveBeenCalled();
    expect(cfg.verifier).toMatchObject({ kind: "jwks", issuer: "https://emisor", audience: "cliente-1" });
  });

  it("ninguno seteado → sin warn (compat con emisores JWKS sin OIDC estricto)", () => {
    configurarClientAuth({ jwksUrl: "https://emisor/jwks.json" });
    const cfg = fromResource();
    expect(warn).not.toHaveBeenCalled();
    expect(cfg.verifier).toMatchObject({ kind: "jwks", issuer: undefined, audience: undefined });
  });

  it("con hmac activo no hay warn aunque falte un claim (el pineo no aplica)", () => {
    configurarClientAuth({ jwksUrl: "https://emisor/jwks.json", hmacSecret: HMAC_VALIDO, issuer: "https://emisor" });
    const cfg = fromResource();
    expect(warn).not.toHaveBeenCalled();
    expect(cfg.verifier).toMatchObject({ kind: "hmac" });
  });
});

describe("fromResource: largo del secreto HMAC", () => {
  it("corta si el secreto es más corto que el hash de HS256", () => {
    configurarClientAuth({ hmacSecret: "corto" });
    expect(() => fromResource()).toThrow(/mínimo es 32/);
  });
});
