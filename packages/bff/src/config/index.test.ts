// Pin de tipo (C1, fix-wave fase 2c): `BffConfig` ya NO debe tener
// `runtimeArn`. T4 quitó `runtimeLink` de la Function del Chat a propósito —
// el invoke al Runtime lo hace el worker (packages/worker/src/lambda.ts), no
// el BFF. Antes de este fix, `fromResource()` leía `Resource.AgentRuntime.arn`
// sin que ese linkable existiera: el proxy Resource de sst LANZA ante un
// recurso no linkeado, y como `cfg()` corre por request, TODO POST/GET del
// Messages Backend moría en el primer deploy.
//
// No hay forma de testear ese fallo en runtime sin sst real (no inventamos un
// mock del proxy Resource): alcanza con que el campo no exista en el tipo, y
// que `tsc` bloquee la compilación si alguien lo reagrega. Este test no
// verifica nada en runtime — `expectTypeOf` es un chequeo de tiempo de
// compilación; si `runtimeArn` volviera a `BffConfig`, esta línea deja de
// tipar y `npm run typecheck` (y `vitest run`, que también typechequea al
// transformar el archivo) fallan.
import { expectTypeOf, it } from "vitest";
import type { BffConfig } from "./index";

it("BffConfig no tiene runtimeArn (pin de tipo, ver C1 del fix-wave)", () => {
  expectTypeOf<BffConfig>().not.toHaveProperty("runtimeArn");
});
