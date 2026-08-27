import { describe, expect, it, vi } from "vitest";
import { evaluarEntrada } from "./entrada";

const cfg = { id: "gr-1", version: "DRAFT" };

function clienteFalso(action: string) {
  return { send: vi.fn(async () => ({ action })) } as never;
}

describe("evaluarEntrada", () => {
  it("bloqueada cuando el guardrail interviene", async () => {
    const r = await evaluarEntrada("texto", cfg, clienteFalso("GUARDRAIL_INTERVENED"));
    expect(r.bloqueada).toBe(true);
  });

  it("pasa cuando no interviene", async () => {
    const r = await evaluarEntrada("texto", cfg, clienteFalso("NONE"));
    expect(r.bloqueada).toBe(false);
  });

  it("fail-open: si el guardrail revienta, deja pasar y loguea", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const roto = { send: vi.fn(async () => { throw new Error("bedrock caído"); }) } as never;
    const r = await evaluarEntrada("texto", cfg, roto);
    expect(r.bloqueada).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("texto vacío no llama al guardrail", async () => {
    const c = clienteFalso("NONE");
    await evaluarEntrada("   ", cfg, c);
    expect((c as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
});
