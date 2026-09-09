---
name: marca-del-cliente
description: Arma la identidad visual del chat con la marca del cliente — saca la paleta de su logo, verifica contraste WCAG y llena marca.mjs. Usalo cuando alguien pida brandear, personalizar o poner los colores del cliente en la web o el widget, o diga que la app se ve genérica.
---

# La marca del cliente en el chat

Todo el branding vive en **`marca.mjs`**, en la raíz: nombre visible, logo, paleta
clara y oscura, tipografía y radio. La página lo inyecta como custom properties
(`cssDeMarca`).

**El widget no se toca.** Su CSS vive en `@layer cc-widget` y las reglas sin capa
de la página le ganan siempre, sin importar el orden de inyección. Ese contrato
está documentado en `packages/widget/src/index.ts`.

## 1. Preguntar de quién es la marca

No lo asumas. Si el chat da soporte sobre un **producto** del cliente, el usuario
que lo abre está pidiendo ayuda sobre ese producto, no sobre la empresa. Pero si
va a atender varias cosas, la marca corporativa tiene más sentido. Preguntalo con
AskUserQuestion y mostrá cómo queda el encabezado en cada caso.

Preguntá también **cómo se escribe** el nombre. El `<title>` de su web es la
fuente más confiable: es común que la documentación interna use mayúsculas
(`TALOS KB`) y la marca sea otra cosa (`Talos`).

## 2. Sacar la paleta del LOGO, no del CSS de la web

Este es el paso donde es fácil equivocarse.

Un sitio en WordPress trae **decenas de hex que no son la marca**: los colores de
los botones de share (Twitter, WhatsApp, GitLab…) y la paleta default de
Gutenberg (`#FF6900`, `#FCB900`, `#7BDCB5`, `#00D084`, `#8ED1FC`, `#0693E3`,
`#9B51E0`…). Contar frecuencias sobre el HTML te da esos, no la marca.

El logo sí es confiable. Bajalo y sacale los colores dominantes, filtrando:

```bash
# grises, blancos y negros afuera; agrupá para que el antialias no domine
python3 - <<'PY'
from PIL import Image
from collections import Counter
im = Image.open("logo.png").convert("RGBA")
c = Counter()
for r, g, b, a in im.getdata():
    if a < 200: continue
    if max(r,g,b) - min(r,g,b) < 25: continue
    c[(r//12*12, g//12*12, b//12*12)] += 1
for (r, g, b), n in c.most_common(6):
    print(f"#{r:02X}{g:02X}{b:02X}  ×{n}")
PY
```

Después **cruzá** el resultado con los hex del CSS: el que aparece en los dos es
el acento de marca.

**Si el sitio no carga**, mirá el error antes de rendirte. Una cadena de
certificado incompleta hace fallar `WebFetch` pero no a `curl -k`, y para una
página pública de marketing eso es aceptable — es un GET sin credenciales. Decilo
en la respuesta, y avisale al cliente: ese error también lo ven sus usuarios.

## 3. Verificar contraste ANTES de usar el color

**El color de marca muchas veces no se puede usar tal cual.** Pasa seguido: un
acento pensado para un logo sobre blanco da 3:1 con texto blanco encima, y las
burbujas del usuario quedan difíciles de leer. Nadie lo nota hasta que alguien se
queja.

`revisarContraste()` en `marca.mjs` mide los tres pares que importan y avisa al
arrancar el server. El par crítico es **`acentoTexto` sobre `acento`**: se mide
contra el acento, no contra el fondo. Es el error clásico.

Cuando el color de marca no llega, **no lo reemplaces por otro color**: buscá
otro de los tonos dominantes del mismo logo. Sigue siendo la marca y se lee.

## 4. El modo oscuro va aparte

No lo derives del claro. Un acento oscuro sobre fondo oscuro se apaga, y el texto
encima cambia de blanco a oscuro. Son dos decisiones, y `marca.mjs` las declara
separadas a propósito.

Los neutros conviene teñirlos apenas hacia el tono de la marca, para que se lea
como un sistema y no como un botón de color sobre una página gris.

## 5. Verificar el render, no solo el archivo

```bash
cd examples/demo-client   # apps/web en un clon
PORT=4300 node server.mjs
curl -s http://localhost:4300/ | grep -oE "__[A-Z_]+__"          # sin placeholders
curl -s http://localhost:4300/ | grep -oE "\-\-cc-acento: [^;]*" # DOS veces
```

Que `--cc-acento` aparezca **dos veces** es el chequeo que importa: una por modo.
Si aparece una sola, las burbujas del chat no siguen a la marca en el otro modo —
el marco de la página cambia de color y el chat se queda con el default de
fábrica.

## 6. El logo: casi nunca sirve el que te dan

Los clientes mandan el **lockup horizontal** — la marca completa con el nombre y
una o dos líneas de bajada. A los 28px de alto del encabezado esa bajada queda
ilegible y el logo se lee como una mancha.

Casi siempre hay una **marca compacta** adentro: el escudo, el isotipo, el
símbolo. Separala del wordmark buscando el hueco de tinta más ancho entre
bloques de columnas, recortala con un poco de padding y usá esa. Guardá el
lockup completo también, por si hace falta en otro lugar.

Un beneficio extra: el isotipo suele tener los colores de marca más saturados y
en su forma exacta, así que **sacale la paleta de ahí** en vez de del lockup, que
mezcla el gris del wordmark.

Va en el `public/` de la app web y se referencia desde `marca.mjs`. SVG escala
solo; un PNG conviene a 2x.

Y poné `alt=""`: el `<h1>` de al lado ya dice el nombre, así que el logo es
decorativo y repetirlo se lo hace leer dos veces a un lector de pantalla.

Si el cliente no tiene logo del producto —pasa cuando el chat brandea un producto
y solo existe el logo corporativo— dejá `logo: ""`. El encabezado muestra solo el
nombre, sin hueco ni imagen rota. Es mejor que poner el logo de la empresa
cuando se eligió marca de producto: pedíselo y mientras tanto queda limpio.

## 7. Cerrar contando las decisiones

Decí explícitamente qué elegiste y por qué, sobre todo si tocaste el color de
marca. "Usé #607824 en lugar del #79952A de su web porque ese da 3.42:1 con texto
blanco y no llega a WCAG AA; #607824 es otro tono dominante del mismo logo y da
4.99:1" es una decisión que el cliente puede revisar. "Le puse verde" no.

Y si aprendiste algo del negocio del cliente en el camino —a qué se dedica el
producto, quiénes son sus usuarios— eso suele valer más que los colores: revisá si
el `promptSistema` de `client.config.ts` describe ese dominio o quedó con el
genérico del template.
