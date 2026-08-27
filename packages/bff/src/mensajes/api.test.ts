// API de mensajes: POST encola el turno, GET lo pollea. Todas las deps son
// inyectables (nada de AWS real) — `store` simula MessagesTable con arrays en
// memoria en vez de un DynamoDBClient.
import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { MENSAJES_GUARDRAIL } from "@craftech-ai-chat/shared/mensajes";
import { getMensajes, postMensaje } from "./api";
import type { Mensaje } from "./store";

const SECRET = "un-secreto-de-al-menos-32-bytes!!";
const cfg = { verifier: { kind: "hmac", secret: SECRET } as const };

async function token(claims: Record<string, unknown> = { sub: "4821" }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

// Store falso: mismo contrato de escribir/listar que la implementación real
// (mensajes/store.ts), pero en memoria — sin DynamoDBClient.
function storeFalso() {
  const mensajes: Mensaje[] = [];
  return {
    mensajes,
    escribir: vi.fn(async (m: Omit<Mensaje, "orden">) => {
      const orden = `${m.ts}#${m.msgId}`;
      const guardado: Mensaje = { ...m, orden };
      mensajes.push(guardado);
      return guardado;
    }),
    listar: vi.fn(async (conversationId: string, desde?: string) =>
      mensajes
        .filter((m) => m.conversationId === conversationId && (!desde || m.orden > desde))
        .sort((a, b) => (a.orden < b.orden ? -1 : 1)),
    ),
  };
}

function encolarFalso() {
  const encolados: { conversationId: string; msgId: string; userId: string; actToken?: string }[] = [];
  return { encolados, encolar: vi.fn(async (p: (typeof encolados)[number]) => void encolados.push(p)) };
}

describe("postMensaje", () => {
  it("responde 401 sin token, sin tocar el store", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const r = await postMensaje({ texto: "hola" }, { cfg, store, encolar });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("invalid_token");
    expect(store.mensajes).toHaveLength(0);
    expect(encolados).toHaveLength(0);
  });

  it("responde 401 con code expired_token para un token vencido", async () => {
    const vencido = await new SignJWT({ sub: "4821" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("-1m")
      .sign(new TextEncoder().encode(SECRET));
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const r = await postMensaje({ token: vencido, texto: "hola" }, { cfg, store, encolar });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("expired_token");
  });

  it("responde 400 con texto vacío", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const r = await postMensaje({ token: await token(), texto: "" }, { cfg, store, encolar });
    expect(r.status).toBe(400);
    expect(store.mensajes).toHaveLength(0);
  });

  // Un texto de solo espacios es truthy: sin el trim previo a la validación
  // llegaría al store y al guardrail como mensaje real.
  it("responde 400 con texto de solo espacios (trim antes de validar)", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const r = await postMensaje({ token: await token(), texto: "   " }, { cfg, store, encolar });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("empty_message");
    expect(store.mensajes).toHaveLength(0);
  });

  it("guarda el texto trimeado, no el crudo con espacios", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    await postMensaje({ token: await token(), texto: "  hola  " }, { cfg, store, encolar });
    expect(store.mensajes[0]).toMatchObject({ texto: "hola" });
  });

  it("un tope excedido responde 429 con motivo y no escribe NI encola nada", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const r = await postMensaje(
      { token: await token(), texto: "hola" },
      { cfg, store, encolar, limites: async () => ({ permitido: false, motivo: "sesion" }) },
    );
    expect(r.status).toBe(429);
    expect(r.body.error).toEqual({ code: "limit_reached", motivo: "sesion" });
    expect(store.mensajes).toHaveLength(0);
    expect(encolados).toHaveLength(0);
  });

  it("una entrada bloqueada escribe user+assistant, no encola, y responde 200 con el orden del user", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const r = await postMensaje(
      { token: await token(), texto: "algo horrible" },
      { cfg, store, encolar, guard: async () => ({ bloqueada: true }) },
    );
    expect(r.status).toBe(200);
    expect(store.mensajes).toHaveLength(2);
    expect(store.mensajes[0]).toMatchObject({ rol: "user", texto: "algo horrible" });
    expect(store.mensajes[1]).toMatchObject({ rol: "assistant", texto: MENSAJES_GUARDRAIL.entradaBloqueada });
    expect(encolados).toHaveLength(0);
    // El orden devuelto es el del mensaje del USUARIO: el widget
    // pollea desde ahí y encuentra la respuesta de política ya escrita.
    expect(r.body.msgId).toBe(store.mensajes[0]!.msgId);
    expect(r.body.orden).toBe(store.mensajes[0]!.orden);
    expect(r.body.conversationId).toBeTruthy();
  });

  it("un mensaje normal escribe 1 user y encola con groupId/dedupId correctos, devuelve msgId y orden", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const jwt = await token({ sub: "4821" });
    const r = await postMensaje({ token: jwt, texto: "hola" }, { cfg, store, encolar });

    expect(r.status).toBe(200);
    expect(store.mensajes).toHaveLength(1);
    expect(store.mensajes[0]).toMatchObject({ rol: "user", texto: "hola" });
    expect(encolados).toHaveLength(1);
    expect(encolados[0]).toEqual({
      conversationId: r.body.conversationId,
      msgId: store.mensajes[0]!.msgId,
      userId: "4821",
      // Sin claim act_token, viaja el mismo token que el usuario presentó
      // (el caso común).
      actToken: jwt,
    });
    expect(r.body.msgId).toBe(store.mensajes[0]!.msgId);
    expect(r.body.orden).toBe(store.mensajes[0]!.orden);
  });

  // El actToken viaja por la cola hasta el runtime.
  it("encola con actToken = claim act_token cuando el emisor lo manda", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const jwt = await token({ sub: "4821", act_token: "token-de-la-api-del-cliente" });
    const r = await postMensaje({ token: jwt, texto: "hola" }, { cfg, store, encolar });

    expect(r.status).toBe(200);
    expect(encolados).toHaveLength(1);
    expect(encolados[0]!.actToken).toBe("token-de-la-api-del-cliente");
  });

  it("encola con actToken = token crudo presentado cuando NO hay claim act_token", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const jwt = await token({ sub: "4821" });
    await postMensaje({ token: jwt, texto: "hola" }, { cfg, store, encolar });

    expect(encolados[0]!.actToken).toBe(jwt);
  });

  // PIN de seguridad: el actToken va SOLO en el body de la cola — JAMÁS
  // en MessagesTable. Se revisa el argumento de CADA escritura y el contenido
  // serializado completo: ni la clave `actToken` ni el valor del token (claim
  // o crudo) pueden aparecer en lo que se persiste en Dynamo.
  it("el item escrito en MessagesTable NO contiene el actToken (ni clave ni valor)", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const jwt = await token({ sub: "4821", act_token: "token-de-la-api-del-cliente" });
    await postMensaje({ token: jwt, texto: "hola" }, { cfg, store, encolar });

    expect(store.mensajes.length).toBeGreaterThan(0);
    for (const llamada of store.escribir.mock.calls) {
      expect(llamada[0]).not.toHaveProperty("actToken");
    }
    const serializado = JSON.stringify(store.mensajes);
    expect(serializado).not.toContain("actToken");
    expect(serializado).not.toContain("token-de-la-api-del-cliente");
    expect(serializado).not.toContain(jwt);
  });

  it("tampoco en el camino bloqueado: los dos items escritos (user+assistant) van sin actToken", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const jwt = await token({ sub: "4821", act_token: "token-de-la-api-del-cliente" });
    await postMensaje(
      { token: jwt, texto: "algo horrible" },
      { cfg, store, encolar, guard: async () => ({ bloqueada: true }) },
    );

    expect(store.mensajes).toHaveLength(2);
    const serializado = JSON.stringify(store.mensajes);
    expect(serializado).not.toContain("actToken");
    expect(serializado).not.toContain("token-de-la-api-del-cliente");
  });

  it("sin guard ni limites configurados, el flujo normal sigue intacto", async () => {
    const store = storeFalso();
    const { encolar, encolados } = encolarFalso();
    const r = await postMensaje({ token: await token(), texto: "hola" }, { cfg, store, encolar });
    expect(r.status).toBe(200);
    expect(store.mensajes).toHaveLength(1);
    expect(encolados).toHaveLength(1);
  });

  it("los topes corren antes que el guardrail (no se paga ApplyGuardrail de más)", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const guard = vi.fn(async () => ({ bloqueada: false }));
    await postMensaje(
      { token: await token(), texto: "hola" },
      { cfg, store, encolar, guard, limites: async () => ({ permitido: false, motivo: "dia" }) },
    );
    expect(guard).not.toHaveBeenCalled();
  });

  it("si el encolado falla DESPUÉS de escribir, responde 500 error_interno pero el user msg queda escrito (auto-reparación)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = storeFalso();
    const encolar = vi.fn(async () => {
      throw new Error("sqs caída");
    });
    const r = await postMensaje({ token: await token(), texto: "hola" }, { cfg, store, encolar });
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe("error_interno");
    // El mensaje del usuario SÍ quedó escrito: no se reintenta el encolado
    // acá, el job del PRÓXIMO turno lo recoge como pendiente huérfano.
    expect(store.mensajes).toHaveLength(1);
    expect(store.mensajes[0]).toMatchObject({ rol: "user", texto: "hola" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("si escribir el mensaje del usuario lanza de entrada, responde 500 y no encola nada", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = storeFalso();
    store.escribir.mockImplementationOnce(async () => {
      throw new Error("dynamo caída");
    });
    const { encolar, encolados } = encolarFalso();
    const r = await postMensaje({ token: await token(), texto: "hola" }, { cfg, store, encolar });
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe("error_interno");
    expect(encolados).toHaveLength(0);
    err.mockRestore();
  });

  it("en el camino bloqueado, el orden del assistant es estrictamente mayor al del user (desempate de ts)", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const r = await postMensaje(
      { token: await token(), texto: "algo horrible" },
      { cfg, store, encolar, guard: async () => ({ bloqueada: true }) },
    );
    expect(r.status).toBe(200);
    const [user, assistant] = store.mensajes;
    expect(user!.orden < assistant!.orden).toBe(true);
  });

  it("dispara registrarTurno con (userId, conversationId, texto) en el POST normal exitoso", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const registrarTurno = vi.fn(async () => 1);
    const r = await postMensaje(
      { token: await token({ sub: "4821" }), texto: "hola" },
      { cfg, store, encolar, registrarTurno },
    );
    expect(registrarTurno).toHaveBeenCalledWith("4821", r.body.conversationId, "hola");
  });

  it("un registrarTurno que rechaza no altera el 200 (fire-and-forget de verdad)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = storeFalso();
    const { encolar } = encolarFalso();
    const registrarTurno = vi.fn(async () => {
      throw new Error("índice caído");
    });
    const r = await postMensaje({ token: await token(), texto: "hola" }, { cfg, store, encolar, registrarTurno });
    expect(r.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("getMensajes", () => {
  it("responde 401 sin token", async () => {
    const store = storeFalso();
    const r = await getMensajes({}, { cfg, store });
    expect(r.status).toBe(401);
  });

  it("deriva el conversationId del token, nunca del query: dos usuarios, mismo hilo, listas distintas", async () => {
    const store = storeFalso();
    const { encolar } = encolarFalso();
    await postMensaje({ token: await token({ sub: "A" }), texto: "hola de A", hilo: "h1" }, { cfg, store, encolar });
    await postMensaje({ token: await token({ sub: "B" }), texto: "hola de B", hilo: "h1" }, { cfg, store, encolar });

    const rA = await getMensajes({ token: await token({ sub: "A" }), hilo: "h1" }, { cfg, store });
    const rB = await getMensajes({ token: await token({ sub: "B" }), hilo: "h1" }, { cfg, store });

    expect(rA.body.mensajes?.map((m) => m.texto)).toEqual(["hola de A"]);
    expect(rB.body.mensajes?.map((m) => m.texto)).toEqual(["hola de B"]);
  });

  it("pasa el cursor `desde` al store", async () => {
    const store = storeFalso();
    await getMensajes({ token: await token(), desde: "cursor-x" }, { cfg, store });
    expect(store.listar).toHaveBeenCalledWith(expect.any(String), "cursor-x");
  });
});
