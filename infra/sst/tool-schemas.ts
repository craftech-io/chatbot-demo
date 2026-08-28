// Esquemas MCP de las tools de tenant que corren como Lambda detrás del
// Gateway. Cada `const` es el `inlinePayload` de un GatewayTarget: es LO QUE VE
// EL MODELO (nombre, descripción y JSON Schema de los argumentos).
//
// Las `description` son INSTRUCCIONES para el modelo, no títulos: le dicen
// cuándo usar la tool y qué hacer con el resultado. Es la mitad ejecutable de la
// política del prompt del sistema (spec §11.2) — si acá dice "citá la fuente",
// el modelo cita.
//
// Viven separados de infra/sst/tools.ts para que ese archivo cablee Lambdas,
// permisos y targets sin el ruido del JSON.

// Tipo del `inlinePayload` de un GatewayTarget MCP (espeja el contrato de
// aws-native). Anotarlo acá preserva los literales (`type: "object"`, ...) que
// exigen los enums del schema: sin la anotación, TS los ensancha a `string` al
// sacarlos del sitio de uso y el array deja de ser asignable.
type ToolSchema = awsnative.types.input.bedrockagentcore.GatewayTargetToolDefinitionArgs[];

// `consultar_documentos` → packages/bff/src/tools/documentos.ts
export const documentosToolSchema: ToolSchema = [
  {
    name: "consultar_documentos",
    description:
      "Busca en los documentos del negocio (políticas, horarios, garantías, procedimientos) y devuelve los pasajes más parecidos. Cada pasaje trae `texto`, `score`, `fuente` (la URI del documento) y, cuando el documento las declara, `titulo` y `url`. Usala SIEMPRE antes de responder cualquier cosa sobre el negocio: no contestes de memoria. Citá el pasaje que usaste por su `titulo` —si no vino, por el nombre de archivo de la `fuente`— y pasale la `url` al usuario cuando exista. Si vuelve con una nota de que no encontró nada, decilo y ofrecé derivar el caso a una persona.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description:
            "Qué buscar, en lenguaje natural. Mejor una frase con las palabras del usuario que una palabra sola.",
        },
        topK: {
          type: "integer",
          description:
            "Máximo de pasajes a traer. Omitilo salvo que necesites más contexto del habitual.",
        },
      },
      required: ["consulta"],
    },
  },
];

// `escalar_a_humano` → packages/bff/src/tools/escalamiento.ts
export const escalamientoToolSchema: ToolSchema = [
  {
    name: "escalar_a_humano",
    description:
      "Crea el escalamiento para que una persona del equipo siga el caso. Usala SOLO después de que el usuario haya aceptado explícitamente que lo derives: primero ofrecé, y recién cuando diga que sí, llamala. La persona del equipo retoma el caso por el canal que nombre el resumen (no recibe ni la identidad del usuario ni el hilo de esta conversación), así que escribí en el resumen por dónde seguirlo. Devuelve { creado: true } si el caso quedó registrado: si trae `referencia` (y `link`), pasáselos al usuario; si en cambio trae `nota`, el caso quedó recibido igual y lo que hay que transmitir es esa nota — no inventes una referencia. Si devuelve { creado: false, nota }, NO hay escalamiento confirmado — explicale al usuario lo que dice la nota, nunca le digas que ya lo derivaste.",
    inputSchema: {
      type: "object",
      properties: {
        resumen: {
          type: "string",
          description:
            "Qué necesita el usuario, en una o dos frases, escrito para que lo lea una persona del equipo.",
        },
        detalle: {
          type: "string",
          description:
            "Contexto útil del caso: qué se intentó, qué datos dio el usuario, qué no encontraste en los documentos.",
        },
      },
      required: ["resumen"],
    },
  },
];
