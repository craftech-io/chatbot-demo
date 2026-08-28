# API del cliente (ejemplo)

Esta Lambda juega el rol de **la API que un cliente real ya tiene**: en un
deploy para un cliente de verdad, esta pieza **no se deploya** — el Gateway y
las tools del core apuntan a la API existente del cliente. Acá existe solo para
que las tools del agente tengan algo real contra qué demostrar el circuito
completo en staging.

## Endpoints

| Endpoint | Auth | Quién la consume | Respuesta |
|---|---|---|---|
| `GET /catalogo` | ninguna | el agente vía **AgentCore Gateway** (MCP, tool `listar_catalogo`) | `{"productos":[{"id":"p-1","nombre":"Casco MTB","precio":45000},{"id":"p-2","nombre":"Luz trasera USB","precio":12000},{"id":"p-3","nombre":"Kit de parches","precio":3500}]}` |
| `GET /pedidos` | `Authorization: Bearer <actToken>` | el core **por HTTP directo** (tool local `mis_pedidos`) con el actToken del usuario | con token: `{"pedidos":[{"id":"A-1001","estado":"en camino","eta":"mañana"},{"id":"A-0997","estado":"entregado"}]}` — sin token: 401 `{"error":"falta el token"}` |

La división no es casual: `/catalogo` es dato de **tenant** (lo mismo para
todos) y por eso entra al Gateway; `/pedidos` es dato **per-usuario** y la
regla dura del spec (§7) es que nada per-usuario pasa por el gateway — lo llama
el core con el token del usuario.

## Limitaciones deliberadas (es un demo)

- `/pedidos` solo exige que el Bearer **exista**: no verifica la firma ni el
  `sub` del token, y los pedidos son fijos. En la API real del cliente este
  endpoint valida el token y devuelve los pedidos del usuario autenticado.
- Sin paginación, sin filtros, sin POST: lo mínimo para que las dos tools
  tengan algo que contar.

## Infra

La deploya `infra/sst/api-cliente.ts` como `sst.aws.Function` con Function URL
pública; `infra/sst/gateway.ts` registra `/catalogo` como target OpenAPI del
Gateway, y `infra/sst/runtime.ts` le pasa la base URL al core como
`CLIENT_API_URL`.

## `POST /escalamientos`

Recibe el escalamiento que crea la tool `escalar_a_humano` y devuelve una
referencia con su link. Hace de "sistema de soporte del cliente": es el destino
al que se apunta el secreto `EscalamientoWebhookUrl` para poder demostrar el
flujo completo sin depender de un servicio de terceros.

DEMO ONLY: no persiste nada ni valida el cuerpo. En un cliente real este
endpoint es su mesa de ayuda (Jira Service Management, Zendesk, un webhook de
Slack), y el adaptador se implementa contra su API — ver `docs/diseno.md` §11.1.
