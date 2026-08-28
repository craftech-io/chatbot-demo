// La "API del cliente" de ejemplo: una Lambda con Function URL que juega el rol
// de la API que un cliente real ya tiene (ver examples/api-cliente/README.md —
// en un deploy real esta pieza no existe y el Gateway/las tools apuntan a la
// API del cliente).
import { permisosTrazas, trazasActivas } from "./observabilidad";

export const apiClienteDemo = new sst.aws.Function("ApiClienteDemo", {
  // Formato de sst: ruta al archivo sin extensión + export (mismo patrón que
  // Chat/Worker), no el nombre del archivo con su `.mjs`.
  handler: "examples/api-cliente/handler.handler",
  runtime: "nodejs24.x",
  // Dos GET de datos fijos: 10s sobra.
  timeout: "10 seconds",
  // Tracing activo: los segmentos de esta Lambda cuelgan del span que el Gateway
  // emite por el target, así que sin esto la traza del turno llega hasta el
  // Gateway y ahí se corta. En sst no hay prop `tracing`: va por
  // `transform.function` (ver ./observabilidad.ts).
  transform: { function: trazasActivas },
  // Los permisos de X-Ray no vienen con el tracing: el rol que arma sst lleva
  // solo AWSLambdaBasicExecutionRole (ver ./observabilidad.ts).
  permissions: [...permisosTrazas],
  // URL pública sin auth de IAM: /catalogo es abierto a propósito (dato de
  // tenant) y /pedidos se protege solo con el Bearer que el propio handler
  // exige — igual que la API real de un cliente, que vive en la internet
  // pública con su propia auth.
  url: true,
});

// Base URL SIN barra final: el core arma `{CLIENT_API_URL}/pedidos` y el
// OpenAPI del gateway hace el mismo join con /catalogo — con la barra final
// de la Function URL quedaría `//pedidos`, que no matchea ninguna ruta.
export const apiClienteDemoUrl = apiClienteDemo.url.apply((u) => u.replace(/\/+$/, ""));
