// La "API del cliente" de ejemplo. Es una PIEZA DE EJEMPLO: juega el rol de la
// API que un cliente real YA TIENE en producción — para un cliente de verdad
// esta pieza no se despliega (ver README.md).
//
// Contrato (el mock del demo-client expone los mismos endpoints con estos
// mismos datos):
// - GET /catalogo → 200 con los productos, SIN auth (dato de tenant: es lo
//   mismo para todos, por eso este endpoint sí entra al AgentCore Gateway).
// - GET /pedidos  → exige `Authorization: Bearer <actToken>`; sin header →
//   401. Dato per-usuario: NUNCA pasa por el gateway (regla dura del spec §7),
//   lo llama el core por HTTP directo con el actToken del usuario.
// - POST /escalamientos → recibe el escalamiento que crea la tool
//   `escalar_a_humano` y devuelve una referencia. Hace de "sistema de soporte
//   del cliente": es el destino al que apunta el secreto
//   EscalamientoWebhookUrl, para poder demostrar el flujo completo sin
//   depender de un servicio de terceros.
//
// Lambda pelada (sin framework), payload v2 de Function URL — mismo espíritu
// que el server del demo-client: node puro, cero dependencias.

const CATALOGO = {
  productos: [
    { id: "p-1", nombre: "Casco MTB", precio: 45000 },
    { id: "p-2", nombre: "Luz trasera USB", precio: 12000 },
    { id: "p-3", nombre: "Kit de parches", precio: 3500 },
  ],
};

const PEDIDOS = {
  pedidos: [
    { id: "A-1001", estado: "en camino", eta: "mañana" },
    { id: "A-0997", estado: "entregado" },
  ],
};

function respuesta(statusCode, cuerpo) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  };
}

export async function handler(event) {
  const metodo = event.requestContext?.http?.method ?? "";
  // rawPath viene de la Function URL; se normaliza la barra final para que
  // /catalogo y /catalogo/ respondan igual.
  const ruta = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";

  if (metodo === "GET" && ruta === "/catalogo") {
    return respuesta(200, CATALOGO);
  }

  if (metodo === "GET" && ruta === "/pedidos") {
    // Los headers de Function URL llegan en minúsculas. DEMO ONLY: solo se
    // exige que el Bearer exista — el `sub` del token NO se valida y los
    // pedidos son fijos. En la API real del cliente este endpoint verifica el
    // token y devuelve los pedidos DEL usuario del token.
    const auth = event.headers?.authorization ?? "";
    if (!/^Bearer\s+\S+/i.test(auth)) {
      return respuesta(401, { error: "falta el token" });
    }
    return respuesta(200, PEDIDOS);
  }

  if (metodo === "POST" && ruta === "/escalamientos") {
    // DEMO ONLY: no se persiste nada ni se valida el cuerpo; la referencia se
    // arma con el reloj para que sea distinta en cada llamada. El sistema real
    // del cliente crearía acá el ticket y devolvería SU identificador.
    const referencia = `SOP-${String(Date.now()).slice(-6)}`;
    return respuesta(201, {
      referencia,
      link: `https://soporte.example/casos/${referencia}`,
    });
  }

  return respuesta(404, { error: "no existe" });
}
