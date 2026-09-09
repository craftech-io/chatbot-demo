# Clonar este template para un cliente

Este repo es el **template** que Craftech vende: se clona una vez por cliente y se
despliega en **la cuenta AWS del cliente** (BYOC). El template no es el entregable —
el entregable es el clon. Todo lo específico de un cliente vive en
`client.config.ts`; si algo específico aparece en otro archivo, es un bug del
template.

Lo que sigue es el procedimiento, en orden, con las trampas que ya nos costaron
tiempo al menos una vez. Está escrito a partir del primer clon real (2026-09).

---

## La parte mecánica la hace un script

```bash
bash scripts/clonar-para-cliente.sh <slug-del-cliente>
```

Sobre el clon, **no sobre este repo** (tiene una guarda que lo verifica por el
remoto). Hace los pasos 1 a 4 de acá abajo —estructura, slug, scope, workspaces,
`.gitignore`, corpus de ejemplo, diagrama—, corre el grep de control y al final
**imprime lo que queda para una persona**.

Como último paso **se borra a sí mismo, borra este CLAUDE.md y borra `.claude/`**:
nada de eso va al repo del cliente. Son documentación y herramientas internas de
Craftech, y hablan del proceso, no del producto.

En `.claude/skills/` hay dos skills. **`marca-del-cliente`** arma la identidad
visual: saca la paleta del logo del cliente, verifica contraste WCAG y llena
`marca.mjs`. Vale leerlo aunque no lo invoques — el color de marca de un cliente
muchas veces NO se puede usar tal cual porque no llega al mínimo de contraste con
el texto que va encima, y eso no se ve hasta que alguien no puede leer el chat.

Y **`clonar-para-cliente`**, que **conduce** el clonado:
hace la entrevista de las decisiones que ramifican (slug, remoto, IdP, de dónde
salen los documentos, escalamiento, observabilidad), corre el script y cierra con
los mensajes para pedirle al cliente lo que falte. Es el punto de entrada
recomendado; este documento es su material de referencia.

Lo que sigue es el detalle: lo que el script hace (para poder revisarlo) y lo que
no puede hacer.

---

## 0. Decisiones antes de tocar nada

**El slug es irreversible.** Queda incrustado en el nombre físico de cada recurso
(el repo ECR, las URLs, los log groups). Cambiarlo después obliga a recrear el stack
entero. Tiene que ser kebab-case; `infra/sst/nombres.ts` lo valida en el synth.

**El stage se llama `production` o se pierden las protecciones.** `sst.config.ts`
compara el string exacto:

```ts
removal: input?.stage === "production" ? "retain" : "remove",
protect: input?.stage === "production",
```

Un stage llamado `prod`, `prd` o cualquier otra cosa queda con `removal: remove`: un
`sst remove` se lleva las tablas con las conversaciones. El template usa `staging`
a propósito (es el showcase interno); **un clon de cliente va a `production`**.

**Con qué autentica el cliente a sus usuarios.** Definilo antes del primer deploy,
porque sin emisor de tokens el BFF rechaza todos los mensajes. Tres caminos:
JWKS de su IdP (lo correcto), HMAC (secreto compartido, sirve para arrancar), o un
pool Cognito propio si no tienen IdP (ver §6).

---

## 1. Historia de git

El clon arranca con **un commit inicial limpio**: la historia del template son ~200
commits de construcción del producto, con decisiones internas y nombres de otros
clientes. No es información del cliente.

```bash
rm -rf .git && git init && git branch -M main
```

**Identidad del repo.** Configurala **local al repo**, no global, si el remoto del
cliente usa otra identidad que la de tu día a día:

```bash
git config user.email "<tu-email-del-remoto-del-cliente>"
git config user.name "<tu nombre>"
```

Verificá con `git log --format=%ae -1` **antes** del primer push: reescribir autores
después obliga a un force-push sobre el repo del cliente.

---

## 2. Renombrar: slug, scope y estructura

Tres renombrados mecánicos. El grep de control es
`git grep -l "craftech-ai-chat\|craftech-io\|chatbot-demo"` — al terminar tiene que
dar **cero** archivos (excepto `package-lock.json`, que se regenera con `npm i`).

**a) El slug** en `client.config.ts` (`slug: "<slug-del-cliente>"`).

**b) El scope npm** `@craftech-ai-chat/*` → `@<slug>/*` en el `package.json` raíz,
en `packages/*/package.json` y en cada import que lo use. Después `npm install` para
regenerar el lock.

**c) `examples/` → apps reales.** En el template son piezas de ejemplo; en el clon
son las apps del cliente:

| Template | Clon |
|---|---|
| `examples/demo-client` | `apps/web` |
| `examples/api-cliente` | `apps/api` |
| `examples/documentos` | `documentos/` (a la raíz) |

**No te olvides del `.gitignore`**: la línea `examples/*/sst-env.d.ts` tiene que
pasar a `apps/*/sst-env.d.ts`, o los tipos generados de las apps se commitean.

Y los handlers en `infra/sst/*.ts` referencian esas rutas (`apps/api/handler.handler`,
`packages/bff/src/chat/lambda.handler`): el typecheck de infra no los valida, así que
un path viejo se descubre en el deploy.

---

## 3. Sacar todo lo que es del template y no del cliente

**El corpus de ejemplo.** `documentos/` trae documentos de una empresa inventada.
Borralos: si alguien corre una ingesta, el chatbot del cliente contesta sobre una
tienda que no existe. El `README.md` de ese directorio sí se queda — documenta el
formato de los sidecars `.metadata.json`, que es el mismo que escribe el ingestor de
Confluence.

**El texto del modo mockeado.** `apps/web/mock.mjs` tiene strings **visibles al
usuario** que citan el corpus de ejemplo. Si quedan, alguien del cliente levanta el
modo local y el chat le habla de otra empresa.

**Las secciones internas del spec.** `docs/diseno.md` tiene el plan de fases de
entrega y los riesgos comerciales del producto ("validar la cobertura antes de
prometerle el sabor Terraform a un cliente"). Eso es planificación de Craftech y no
va al repo del cliente. Las secciones de arquitectura sí se quedan: son la referencia
que se le explica al cliente con el diagrama.

**Los nombres de archivos de credenciales.** `.cognito-demo.local` y
`.secreto-demo.local` son del showcase; en el clon van con el nombre del stage
(`.cognito-production.local`). Están cubiertos por `*.local` en el `.gitignore` —
verificalo con `git check-ignore`, **nunca se commitean**.

---

## 4. El diagrama

Es generado y determinístico, así que se rehace con el slug del cliente:

```bash
node docs/arquitectura.mjs docs/arquitectura.excalidraw <slug> cliente
```

El tercer argumento es el sabor: `generico` nombra las cajas "App web" y "API del
cliente" (el template); `cliente` las nombra `apps/web` y `apps/api` (rutas reales
del clon). Regenerar da byte por byte el mismo archivo, así el diff se lee.

Revisá que las cajas describan lo que el cliente **realmente** va a tener. La del
emisor de tokens es la que más cambia: si le creaste un Cognito provisorio, decirle
"IdP del cliente" da a entender que es el suyo.

---

## 5. El CI

El template usa **GitHub Actions** (`.github/workflows/`). Si el cliente usa otro
remoto, hay que portarlo. Lo que aprendimos portándolo a Bitbucket Pipelines está en
`docs/notas-tecnicas.md`, "Portar el CI a Bitbucket Pipelines" — leelo antes, son
tres puntos duros que cuestan una corrida cada uno.

Dos cosas valen para **cualquier** CI:

**`sst install` necesita `--stage`** en el runner de Bitbucket. `.sst/stage` es
gitignoreado y ahí no existe. En GitHub Actions no hace falta, pero pasalo igual: es
una línea y saca la inferencia del medio.

**`sst-env.d.ts` de la raíz está trackeado y tiene que tener contenido.** Declara el
tipo `Resource` y **solo lo generan `sst deploy` y `sst dev`** — ni `sst install` ni
`sst diff`. En una cuenta sin desplegar queda con `Resource {}` vacío y el typecheck
del CI falla con ~20 errores `TS2339`. Por eso el **primer deploy va desde local**
(§7) y su `sst-env.d.ts` se commitea.

Y actualizá el README: su sección de CI describe el estado del template, no el del
clon.

---

## 6. Prerequisitos de la cuenta del cliente

Los tres primeros son bloqueantes y **ninguno lo hace el stack**. El detalle está en
`docs/adopcion.md` §0; acá va lo que importa recordar: **los tres fallan en silencio**
—el deploy sale verde— así que verificalos con los comandos, no con la consola.

| Prerequisito | Verificación que vale |
|---|---|
| Formulario de caso de uso de **Anthropic** | Un `converse` real. `list-foundation-models` da falso positivo, y una primera invocación puede pasar antes de que se exija el formulario |
| **Transaction Search** de X-Ray | `aws xray get-trace-segment-destination` ⇒ `CloudWatchLogs`. Si falta, no hay trazas y no se recuperan retroactivamente |
| **Rol de deploy con OIDC** | `aws iam get-role`. Con Bitbucket, la trust policy solo puede condicionar por `aud` y `sub` — ver las notas técnicas |
| Región | Coincide con `region` de `client.config.ts` |

**Si el cliente no tiene IdP**, creale un pool Cognito **fuera del IaC**: no hay
recurso Cognito en `infra/` porque el diseño supone que el emisor es externo (spec
§6). Consecuencias a tener claras: un `sst remove` no lo toca, un deploy en otra
cuenta no lo recrea, y varias propiedades del pool son inmutables en CloudFormation
—`UsernameAttributes` entre ellas—, así que tenerlo en el IaC arriesgaría reemplazarlo
y perder los usuarios. El procedimiento está en `docs/adopcion.md`.

---

## 7. El primer deploy va desde local

Dos razones, las dos verificadas:

1. Genera el `sst-env.d.ts` que el CI necesita (§5).
2. Los primeros deploys fallan por **propagación de IAM** y conviene verlo: el
   servicio valida el rol antes de que IAM lo haya propagado. Lo sufren la Knowledge
   Base y el GatewayTarget de `documentos`. **Reintentar el mismo comando lo
   resuelve** — no es un bug. La firma que lo delata: el target que no necesita
   credencial se crea igual y el que sí la necesita falla con un `InternalFailure`
   genérico.

Hace falta Docker con **buildx y emulación ARM64** (la imagen del core es `linux/arm64`
por AgentCore):

```bash
docker run --rm --privileged tonistiigi/binfmt --install arm64
docker buildx create --use --driver docker-container --name multiarch
```

**Deploy verde ≠ funciona.** Después de cada deploy, verificá el estado real:
`get-agent-runtime` tiene que decir `READY` (AgentCore no lo marca así sin pasarle su
propio health check a `/ping`), los targets del Gateway `READY`, y la KB `ACTIVE`.
Y después, un turno real: el chat puede desplegar perfecto y rechazar todos los
mensajes por un secreto sin setear.

---

## 8. Secretos y configuración

`client.config.ts` es el único archivo de config por cliente. Repasá **todos** sus
campos, no solo el slug: el prompt del sistema, los topes de uso (el cliente paga su
propio Bedrock), `origenesCors` (viene en `["*"]`), la retención del historial, las
regex de PII según el país.

Los secretos van con `sst secret set` por stage. El inventario está en
`docs/adopcion.md` §4. Tres trampas verificadas:

**Al migrar entre modos de auth hay que vaciar el otro explícitamente.** Si HMAC y
JWKS quedan los dos seteados **gana HMAC**, el chat sigue andando y parece que
migraste. Verificá en las dos direcciones: el token viejo tiene que dar **401**.

**`sst secret set` con un nombre que ningún `sst.Secret` declara no falla.** Crea un
secreto que nada lee. Es cómo un typo en el nombre deja JSM sin configurar y el
escalamiento cayéndose al webhook sin un solo error visible.

**`sst secret list` imprime los valores en claro.** Para verificar que están seteados,
usá `| cut -d= -f1`.

---

## 9. Lo que el cliente reemplaza, y hay que decírselo

- **`apps/api`** es un stand-in de la API que el cliente ya tiene. Mientras siga ahí,
  el agente ofrece "consultar tus pedidos" y "ver el catálogo" contra datos de
  ejemplo. En una demo eso se nota: decilo antes de que lo pregunten.
- **El corpus de la Knowledge Base.** Con la KB vacía el agente contesta "no lo
  tengo" a todo lo sustantivo. Eso es la regla anti-invención funcionando, no una
  falla — pero hay que enmarcarlo así.
- **El prompt del sistema**, que describe un negocio genérico.

---

## 10. Trampas que ya nos costaron tiempo

**El sufijo del log group no se deduce del nombre de la función.** SST crea la función
y su log group como recursos separados, cada uno con su autoname. Buscá el log group
por prefijo (`describe-log-groups --log-group-name-prefix`), nunca lo armes a mano.

**`Latency` y `Duration` del Runtime miden el invoke, no el turno.** Dan ~1 s cuando
el turno percibido son 12-14 s. De esos, ~6 s son la ventana de debounce de la cola
(deliberada) y el resto la generación, que es la duración de la Lambda del worker. El
widget del dashboard que las grafica se titula "latencia del turno completo" y ese
título engaña.

**El costo por turno lo escribe el core**, en el log group del Runtime
(`/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`), no el worker.

**`OTEL_EXPORTER_OTLP_TRACES_HEADERS` exige el valor URL-encodeado.** Va
`Basic%20<base64>`: un espacio literal hace que el SDK descarte el header entero y
exporte sin auth, con 401 en un log que nadie mira. El synth lo valida y corta.

**`destino: "otlp"` reemplaza X-Ray para la traza del agente, no se suma.** Las
Lambdas siguen en CloudWatch, así que la traza queda partida en dos herramientas.

**El BFF recibe el token en el header `Authorization: Bearer`,** no en el body. La
ruta es `/mensajes`; `/` devuelve 404 y no significa que esté roto.

---

## Reglas de trabajo en este repo

- **Comentarios escasos**: solo lo que no se deduce del código — una restricción de la
  plataforma, un modo de falla silencioso, el porqué de una decisión contraintuitiva.
  Los porqués largos van a `docs/`.
- Todo en **español**, incluidos código, comentarios y tests.
- **Toda capacidad nueva incluye su modo local/mockeado**, para poder probar la UI/UX
  sin cuenta de AWS. Si cambiás lo que hace una tool, cambiá también su texto en
  `apps/web/mock.mjs` — mock y realidad cuentan la misma historia, y hay tests que lo
  pinean.
- **Verificá contra la API antes de escribir, y otra vez en un deploy real.** Varias
  de las trampas de arriba aparecieron porque algo que la documentación sugería no era
  lo que el servicio hacía.
