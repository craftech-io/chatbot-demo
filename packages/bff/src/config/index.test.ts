// Pin de tipo: `BffConfig` NO debe tener `runtimeArn`. El invoke al Runtime lo
// hace el worker (packages/worker/src/lambda.ts), no el BFF, así que la Function
// del Chat no tiene ese recurso linkeado — y el proxy Resource de sst LANZA ante
// un recurso no linkeado. Como `cfg()` corre por request, una lectura de
// `Resource.AgentRuntime.arn` desde el BFF mata todo POST/GET del backend de
// mensajes.
//
// Sin sst real no hay forma de testear ese fallo en runtime, así que alcanza con
// que el campo no exista en el tipo: `expectTypeOf` es un chequeo de tiempo de
// compilación, y si `runtimeArn` volviera a `BffConfig` esta línea deja de tipar
// y fallan `npm run typecheck` y `vitest run` (que también typechequea al
// transformar el archivo).
import { expectTypeOf, it } from "vitest";
import type { BffConfig } from "./index";

it("BffConfig no tiene runtimeArn (pin de tipo)", () => {
  expectTypeOf<BffConfig>().not.toHaveProperty("runtimeArn");
});
