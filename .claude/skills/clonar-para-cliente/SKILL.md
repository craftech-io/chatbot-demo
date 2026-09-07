---
name: clonar-para-cliente
description: Conduce el clonado de este template para un cliente nuevo — hace la entrevista de las decisiones que ramifican (slug, remoto, IdP, de dónde salen los documentos, escalamiento, observabilidad), ejecuta la parte mecánica y deja el clon listo para el primer deploy. Usalo cuando alguien diga que va a clonar el template, arrancar con un cliente nuevo, preparar un repo de cliente, o mencione "clonar para <cliente>".
---

# Clonar el template para un cliente

Este repo es el template; el entregable es el clon. Tu trabajo es conducir el
clonado: **preguntar lo que ramifica, ejecutar lo mecánico, y no dejar decisiones
tomadas en silencio.**

`CLAUDE.md` (raíz) tiene el detalle de cada paso y los porqués. No lo dupliques
acá: leelo cuando necesites el fundamento de algo.

## Antes de empezar

Verificá que estás sobre **el clon**, no sobre el template:

```bash
git remote get-url origin
```

Si el remoto es `craftech-io/chatbot-demo`, pará: el clonado se hace sobre el repo
del cliente. El script tiene la misma guarda.

## 1. La entrevista

Preguntá en prosa lo que es texto libre y con **AskUserQuestion** lo que es una
opción u otra. No inventes ninguna de estas respuestas ni asumas un default.

**Texto libre, preguntalo directamente:**

- **Nombre del cliente**, como va a verse en la app web (`<title>` y `<h1>`).
- **Slug**: proponé uno derivado del nombre (kebab-case, típicamente
  `<cliente>-chat`) y pedí confirmación. Aclaralo: **es irreversible**, queda en el
  nombre físico de cada recurso y cambiarlo obliga a recrear el stack.

**Decisiones que ramifican — usá AskUserQuestion:**

| Pregunta | Opciones | Qué cambia |
|---|---|---|
| ¿Dónde vive el repo del cliente? | GitHub / Bitbucket / otro | Bitbucket u otro ⇒ hay que **portar el CI** (ver `docs/notas-tecnicas.md`, "Portar el CI a Bitbucket Pipelines") |
| ¿Con qué autentica a sus usuarios? | Su IdP por JWKS / No tiene, le creamos un Cognito / HMAC para arrancar | Define qué secretos setear y si hay que crear un pool fuera del IaC |
| ¿De dónde salen los documentos? | Confluence / Archivos que ellos nos pasan / Todavía no se sabe | Confluence ⇒ hace falta la service account de Atlassian y llenar `confluence.espacios` |
| ¿A dónde van los escalamientos? | Jira Service Management / Un webhook propio / Todavía no se sabe | JSM ⇒ los 5 secretos de Atlassian; webhook ⇒ solo `EscalamientoWebhookUrl` |
| ¿Trazas del agente? | Solo CloudWatch / Langfuse | Langfuse ⇒ 2 secretos, y `destino: "otlp"` **reemplaza** X-Ray para la traza del agente |

Si la respuesta a alguna es "todavía no se sabe", **no la fuerces**: seguí, y
anotala en la lista final de lo que falta. El stack despliega igual con esos
secretos vacíos, y las capacidades avisan que no están configuradas en vez de
fallar.

## 2. La parte mecánica

```bash
bash scripts/clonar-para-cliente.sh <slug>
```

Hace estructura, slug, scope npm, workspaces, `.gitignore`, borra el corpus de
ejemplo, regenera el diagrama, y **se borra a sí mismo junto con `CLAUDE.md` y
`.claude/`** (este skill incluido: son documentación interna de Craftech).

Leé su salida: al final imprime lo que queda para una persona. Lo que sigue es
cómo cerrar cada punto.

## 3. Lo que el script no puede hacer

**Historia de git.** No lo automatiza a propósito: `rm -rf .git` es irreversible.
Confirmalo con quien te pidió el clonado antes de correrlo, y configurá la
identidad **local al repo** si el remoto del cliente usa otra que la del día a día.
Verificá `git log --format=%ae -1` **antes** del primer push.

**Los textos del modo mockeado.** `apps/web/mock.mjs` tiene strings visibles al
usuario que citan el corpus de ejemplo que el script acaba de borrar. Reescribilos
neutros — sin nombrar ninguna empresa. Hay tests que los pinean: actualizalos, y
cuando un test se cae acá es porque el comportamiento cambió de verdad, no porque
el test esté mal.

**El nombre visible de la app web.** El script dejó el slug en el `<title>` y el
`<h1>` de `apps/web/public/index.html`. Poné el nombre del cliente que preguntaste.

**Las secciones internas del spec.** Sacá de `docs/diseno.md` el plan de fases de
entrega y los riesgos comerciales del producto. Es planificación de Craftech.

**La prosa que menciona el template.** El script lista los archivos. Necesitan
reescritura, no renombrado: leé cada mención y decidí si va el nombre del cliente
o si la oración entera sobraba.

**`client.config.ts` completo.** Repasá todos los campos con las respuestas de la
entrevista, no solo el slug: prompt del sistema, topes de uso (el cliente paga su
propio Bedrock), `origenesCors` (viene en `["*"]`), retención del historial, regex
de PII según el país, y los campos de Confluence si aplica.

**El CI**, si el remoto no es GitHub.

## 4. Verificar el clon

En este orden, y no sigas si algo falla:

```bash
npm install
npx sst install --stage production
npm run typecheck
npm run typecheck:infra
npm test
```

Confirmá también que `sst-env.d.ts` (raíz) tenga contenido: declara el tipo
`Resource` y si queda con `Resource {}` vacío el typecheck del CI falla con ~20
errores `TS2339`. Solo `sst deploy` y `sst dev` lo llenan.

## 5. Cerrar con lo que falta

Terminá con dos cosas concretas, no con un "listo":

**Lo que hace falta de la cuenta del cliente**, con la verificación que vale para
cada prerequisito (están en `CLAUDE.md` §6). Los tres bloqueantes **fallan en
silencio**: el deploy sale verde y algo no funciona.

**Los mensajes para pedirle al cliente lo que falta**, redactados y listos para
mandar, según lo que quedó en "todavía no se sabe". Uno por tema, simples, con el
dato de dónde encontrar cada cosa — no una lista de nombres de secretos. Si la
respuesta fue Confluence y JSM, va **un solo** pedido: es una sola service account
de Atlassian con los scopes de las dos cosas.

Y decí explícitamente qué va a pasar en el primer deploy: **el chat va a rechazar
todos los mensajes hasta que el emisor de tokens esté configurado**, y con la
Knowledge Base vacía el agente va a contestar "no lo tengo" a todo lo sustantivo.
Las dos cosas son el comportamiento correcto, pero quien lo vea sin aviso va a
pensar que está roto.

## Reglas de este repo

Aplican mientras trabajás acá y siguen aplicando en el clon:

- **Comentarios escasos**: solo lo que no se deduce del código — una restricción de
  la plataforma, un modo de falla silencioso, una decisión contraintuitiva. Los
  porqués largos van a `docs/`.
- Todo en **español**, incluidos código, comentarios y tests.
- **Toda capacidad nueva incluye su modo local/mockeado.**
- **Verificá contra la API antes de escribir, y otra vez en un deploy real.**
  "Deploy verde" no significa que funcione: después de cada deploy, chequeá el
  estado real del Runtime, del Gateway y de la KB, y mandá un turno de verdad.
