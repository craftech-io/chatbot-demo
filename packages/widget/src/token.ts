// El token del usuario lo emite el backend DEL CLIENTE en su endpoint
// /chat-token, para el usuario que ya está logueado en su app. El widget nunca
// ve credenciales: solo pide un pase firmado y lo presenta.
export class TokenSource {
  private cache: string | null = null;
  private pendiente: Promise<string> | null = null;

  constructor(private readonly tokenUrl: string) {}

  async get(): Promise<string> {
    if (this.cache) return this.cache;
    // Si dos mensajes salen juntos, comparten un solo pedido de token.
    this.pendiente ??= this.pedir();
    try {
      this.cache = await this.pendiente;
      return this.cache;
    } finally {
      this.pendiente = null;
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  private async pedir(): Promise<string> {
    const r = await fetch(this.tokenUrl, { credentials: "include" });
    if (!r.ok) {
      throw new Error(
        `no se pudo obtener el token de chat-token (${r.status}). ` +
          "Verificá que el endpoint responda al usuario logueado.",
      );
    }
    const { token } = (await r.json()) as { token?: string };
    if (!token) throw new Error("chat-token no devolvió 'token'");
    return token;
  }
}
