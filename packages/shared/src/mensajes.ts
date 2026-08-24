// Registro central de textos visibles al usuario (regla de parametría del
// proyecto: nunca literales dispersos). El BFF los emite, el widget los muestra
// y la infra los usa como mensajes de bloqueo del propio Guardrail.
export const MENSAJES_GUARDRAIL = {
  entradaBloqueada:
    "No puedo ayudarte con ese pedido. Reformulalo y seguimos conversando.",
} as const;

export const MENSAJES_LIMITE = {
  diarioAlcanzado:
    "Alcanzaste el límite de mensajes de hoy. Mañana podés seguir conversando.",
  sesionAlcanzada:
    "Esta conversación llegó a su límite de mensajes. Empezá una nueva para seguir.",
} as const;
