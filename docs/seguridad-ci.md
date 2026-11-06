# Seguridad del CI: rol de deploy con mínimo privilegio

Decisión, alcance y forma de revertir del rol que usa GitHub Actions para
desplegar. La forma de aplicarlo está en `docs/adopcion.md` §0.3.

## Contexto

El template se desplegaba con un rol de IAM creado a mano, con la política
administrada `AdministratorAccess` y una trust policy que aceptaba cualquier
referencia del repo (`repo:<org>/<repo>:*`). Eso significa que cualquier rama,
tag o workflow del repo podía obtener credenciales de administrador de la cuenta:
alcanza con permiso de escritura en el repo para controlar la cuenta entera.

La propia guía de GitHub recomienda acotar el claim `sub` a la rama o al
environment que despliega ([GitHub: OIDC en AWS](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)),
y AWS recomienda usar permissions boundaries cuando se delega la creación de
roles ([AWS: permissions boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)).

## Decisión

El rol de CI pasa a ser IaC (`infra/bootstrap/ci-role.yaml`, un stack de
CloudFormation aparte, que se aplica con un admin) y queda así:

| Control | Cómo |
|---|---|
| Quién lo asume | Solo `ref:refs/heads/<rama de deploy>`, en los dos formatos de `sub` (clásico e inmutable con IDs). Ni otras ramas, ni pull requests, ni tags. |
| Qué recursos toca | Los que llevan el tag `sst:app=<slug>`, o los que empiezan con `<slug>-<stage>-` (tablas, colas, bucket, ECR, dashboard). AgentCore se acota por nombre porque Cloud Control no le pone los tags de SST. |
| IAM | Solo crea o edita roles con tag `sst:app=<slug>` **y** con la boundary `<slug>-ci-boundary`. Solo adjunta `AWSLambdaBasicExecutionRole`, `AWSLambdaVPCAccessExecutionRole` y `AWSXrayWriteOnlyAccess`. `iam:PassRole` solo a Lambda, Bedrock, AgentCore y Scheduler. |
| Techo de los roles de la app | La boundary permite solo los recursos de la app y prohíbe `iam:*` y `sts:AssumeRole`. Aunque alguien escriba una policy inline con `"*"`, el rol no sale de ahí. |
| Auto-modificación | Denegado tocar el propio rol de CI, sus políticas, la boundary, el proveedor OIDC, y crear usuarios o access keys. |

`sst.config.ts` aplica la boundary a todo `aws.iam.Role` con `$transform`
([SST: `$transform`](https://sst.dev/docs/reference/global/#transform)).

## Riesgo residual (aceptado)

- **Knowledge Base**: se crea por Cloud Control y su ARN usa un ID aleatorio, sin
  tag. El rol puede leer, actualizar o borrar cualquier Knowledge Base de la
  cuenta en la región. Mitigación futura: pasarle tags `sst:app` en
  `infra/sst/conocimiento.ts` y condicionar por tag.
- **Transaction Search de X-Ray** (`xray:UpdateTraceSegmentDestination`,
  `logs:PutResourcePolicy`) es configuración de cuenta, no de la app.
- **Lectura amplia sin nivel de recurso**: `ecr:DescribeRepositories`,
  `logs:DescribeLogGroups`, `bedrock:List*`. Son metadatos, no datos.

- **`iam:PassRole`**: se acota por el path IAM de la app (`role/<app>/*`), donde viven
  todos sus roles (`$transform` en `sst.config.ts`), con `iam:PassedToService` por
  servicio. No se acota por tag del rol porque AWS advierte que `aws:ResourceTag` con
  `iam:PassRole` no da resultados confiables
  ([AWS IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_tags.html)); un
  primer intento con prefijos de nombre quedó reemplazado por el path (2026-11-06),
  porque algunos prefijos eran genéricos. Crear, editar y borrar roles también se
  limita al path.

## Cómo se validó

Antes de cambiar nada en la cuenta:

1. **Simulación contra uso real**: cada llamada que el rol anterior hizo en sus
   deploys (historial de CloudTrail de 90 días) se evaluó con
   `aws iam simulate-custom-policy` contra las políticas nuevas, con los tags
   reales de cada recurso. Las únicas denegadas corresponden a recursos que ya
   no están en el código (una regla de EventBridge reemplazada por Scheduler) y
   a un ARN de política inexistente que ya había fallado.
2. **Pruebas negativas**: crear un rol sin boundary, editar roles de otras apps,
   adjuntar `AdministratorAccess`, pasar un rol sin tag, borrar el proveedor
   OIDC, crear access keys, leer buckets o tablas ajenas, operar en otra región:
   todas denegadas.
3. **Boundary contra los permisos actuales** de cada rol de la app: todos
   siguen permitidos.
4. **`sst diff`** con y sin el `$transform`: la única diferencia es
   `permissionsBoundary` en los roles de la app, actualizados en el lugar, sin
   reemplazos.

> Nota del `sst diff` local: aparece `Deleted WorkerFunction` también **sin**
> este cambio. Es un artefacto del preview (la función depende del ARN del
> Runtime, que queda desconocido cuando la imagen construida localmente difiere
> de la desplegada). Después del deploy real hay que verificar que la función
> siga existiendo.

### Lección del primer deploy (2026-11-06)

El primer deploy con el rol nuevo falló con `AccessDenied` en
`UpdateAgentRuntime`, sin cambios en la app (el Runtime siguió `READY` con la
versión anterior). La causa fue `bedrock-agentcore:PassCapacityProvider`: una
autorización que AgentCore evalúa del lado del servicio, como `iam:PassRole`, y
que **no aparece como evento propio en CloudTrail**, así que la simulación contra
CloudTrail no la podía ver.

Desde entonces, la validación incluye un paso más: para cada tipo que se crea
por Cloud Control, los permisos de `handlers.{create,read,update,delete}.permissions`
del schema (`aws cloudformation describe-type --type RESOURCE --type-name <tipo>`)
se simulan contra las políticas. Los permisos que dependen de VPC o de claves KMS
propias se omiten porque el stack no los usa. Esos permisos viven en la política
`<slug>-ci-deploy-agentcore`.

## Orden de aplicación (sin cortar el deploy)

1. Aplicar `infra/bootstrap/ci-role.yaml`: crea la boundary y el rol nuevo. No
   toca el rol anterior ni nada desplegado.
2. Mergear el `$transform`. Ese deploy todavía corre con el rol anterior y le
   agrega la boundary a los roles existentes (`PutRolePermissionsBoundary`).
3. Cambiar el secret `DEPLOY_ROLE_ARN` al output `DeployRoleArn` y relanzar el
   último deploy de la rama de deploy. Ese deploy es la validación real.
4. Verificar: Runtime `READY`, targets del Gateway `READY`, KB `ACTIVE`, la
   función del worker existe, y un turno real del chat.
5. Recién entonces borrar el rol anterior.

**Rollback**: hasta el paso 5, volver el secret `DEPLOY_ROLE_ARN` al ARN
anterior. La boundary no se revierte: ya está validada contra los permisos de
los roles y no cambia lo que hacen.
