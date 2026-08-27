// Configuración por cliente: el ÚNICO archivo que se toca al adoptar el
// template en el repo de un cliente. Todo lo específico de un cliente se
// declara acá y lo consumen `sst.config.ts` e `infra/sst/*`; no queda ningún
// valor de cliente suelto en el resto del IaC.
//
// A propósito NO depende de los globals de SST (`$app`, `aws`, `awsnative`,
// `$interpolate`, ...) ni de nada de `infra/`: es dato plano, así lo puede leer
// cualquier sabor de IaC (ver `infra/CONTRACT.md`) y no solo `infra/sst/`.
//
// Los nombres FÍSICOS de los recursos se derivan del `slug` en
// `infra/sst/nombres.ts`, que traduce ese único valor a los alfabetos distintos
// que exige AWS (ECR/Guardrail/Gateway en minúsculas con guiones; AgentCore
// Runtime y Memory en camelCase, que acepta `_` y no `-`). OJO: cambiar el
// `slug` de un stack YA desplegado cambia esos nombres físicos y RECREA los
// recursos (el Runtime, el Gateway, la Memory y el repo ECR). Se elige una vez,
// al clonar.

export interface ConfigCliente {
  /**
   * Identificador del cliente. Se usa como nombre de la app de SST (y por lo
   * tanto como prefijo de los nombres autogenerados) y como prefijo de los
   * nombres físicos que se declaran a mano.
   *
   * Forma exigida: kebab-case en minúsculas empezando por letra
   * (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), p.ej. `acme-chat`. Con esa forma las
   * traducciones de `infra/sst/nombres.ts` son seguras en los tres alfabetos;
   * `infra/sst/nombres.ts` la valida en synth para no comerse un
   * ValidationException opaco al crear el recurso.
   *
   * Corto, además: el nombre del Gateway es `<slug>-gw-<stage>` y el servicio
   * lo limita a 48 caracteres.
   */
  slug: string;

  /**
   * `MODEL_ID` de Bedrock que recibe el core (ver `infra/CONTRACT.md`): un
   * foundation model o un inference profile. El prefijo `us.` de los inference
   * profiles rutea a las regiones hermanas del profile — la policy del
   * RuntimeRole ya contempla ese caso.
   *
   * El modelo tiene que estar habilitado en Bedrock en la cuenta y la región
   * del deploy.
   */
  modelo: string;

  /**
   * Región de AWS donde se despliega todo. `AWS_REGION` del entorno tiene
   * precedencia sobre este valor, para que CI o una prueba local puedan
   * apuntar a otra región sin editar el archivo.
   */
  region: string;

  /**
   * Topes de uso por usuario que aplica el BFF (`LIMITE_DIARIO` y
   * `LIMITE_POR_SESION`, ver `infra/CONTRACT.md`). El cliente paga su propio
   * Bedrock: sin topes, la primera factura sorpresa se come la relación.
   */
  topes: {
    /** Máximo de llamadas por usuario por día. */
    diario: number;
    /** Máximo de turnos por sesión. */
    porSesion: number;
  };

  /**
   * Orígenes permitidos en la Function URL del BFF. `["*"]` acepta cualquiera:
   * lo que protege el chat es el token del cliente (JWKS/HMAC), no el origen.
   * Un cliente con dominios fijos los lista acá (`["https://www.acme.com"]`)
   * para cerrar también esa puerta.
   */
  origenesCors: string[];

  /**
   * Días que AgentCore Memory retiene los eventos de la conversación
   * (short-term). 30 alinea con la retención típica de un chat; subirlo o
   * bajarlo es una decisión de política de datos del cliente.
   */
  retencionMemoriaDias: number;
}

export const cliente: ConfigCliente = {
  slug: "craftech-ai-chat",
  modelo: "us.anthropic.claude-sonnet-4-6",
  region: "us-east-1",
  topes: {
    diario: 50,
    porSesion: 40,
  },
  origenesCors: ["*"],
  retencionMemoriaDias: 30,
};
