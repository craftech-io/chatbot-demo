#!/usr/bin/env bash
# Prepara un clon de este template para un cliente. Hace SOLO la parte mecánica
# y verificable; al final imprime lo que queda para una persona.
#
# ESTE SCRIPT NO DEBE LLEGAR AL REPO DEL CLIENTE. Se borra a sí mismo y borra el
# CLAUDE.md (el playbook de clonado, que es interno) como último paso.
#
#   bash scripts/clonar-para-cliente.sh <slug-del-cliente>
#
# El slug es IRREVERSIBLE: queda en el nombre físico de cada recurso. Ver CLAUDE.md §0.
set -euo pipefail

SLUG="${1:-}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YO="$RAIZ/scripts/clonar-para-cliente.sh"

# ── Guardas ────────────────────────────────────────────────────────────────
if [ -z "$SLUG" ]; then
  echo "uso: bash scripts/clonar-para-cliente.sh <slug-del-cliente>" >&2
  exit 1
fi
# Mismo criterio que infra/sst/nombres.ts, que lo valida en el synth.
if ! printf '%s' "$SLUG" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
  echo "✕ el slug tiene que ser kebab-case: minúsculas, dígitos y guiones ('$SLUG' no lo es)" >&2
  exit 1
fi
cd "$RAIZ"

# La guarda que más importa: no correrlo sobre el template mismo.
REMOTO="$(git remote get-url origin 2>/dev/null || echo "")"
case "$REMOTO" in
  *craftech-io/chatbot-demo*|*craftech-io%2Fchatbot-demo*)
    echo "✕ el remoto es el del TEMPLATE ($REMOTO)." >&2
    echo "  Este script se corre sobre el clon del cliente, no acá." >&2
    exit 1
    ;;
esac
if [ ! -f CLAUDE.md ]; then
  echo "✕ no está CLAUDE.md: o ya se corrió este script, o no es un clon del template." >&2
  exit 1
fi
# Aviso, no corte: se puede clonar sin el skill, pero conviene saberlo.
if [ ! -d .claude/skills/clonar-para-cliente ]; then
  echo "  (nota: no está el skill clonar-para-cliente; el clonado sigue igual)" >&2
fi
if [ -d apps ]; then
  echo "✕ ya existe apps/: parece que el renombrado ya se hizo." >&2
  exit 1
fi

echo "Preparando el clon para '$SLUG'"
echo

# `git mv` si estamos en un repo, `mv` si no (p. ej. después de un rm -rf .git).
mover() { if git rev-parse --git-dir >/dev/null 2>&1; then git mv "$1" "$2"; else mv "$1" "$2"; fi; }
# Reemplazo sobre archivos TRACKEADOS de texto, sin tocar node_modules ni el lock.
# Los valores van por ENTORNO, no interpolados en el código de perl: el patrón
# lleva `/` y el reemplazo lleva `@`, que romperían el s/// y se leerían como un
# array de perl.
reemplazar() {
  export REEMP_DE="$1" REEMP_A="$2"
  git grep -lF --untracked -- "$REEMP_DE" \
    | grep -vE '^(package-lock\.json|node_modules/)' \
    | while read -r f; do
        [ -f "$f" ] || continue
        perl -pi -e 's/\Q$ENV{REEMP_DE}\E/$ENV{REEMP_A}/g' "$f"
      done
}

# ── 1. Estructura: examples/ son las apps reales del cliente ───────────────
echo "→ estructura"
mkdir -p apps
mover examples/demo-client apps/web
mover examples/api-cliente apps/api
mover examples/documentos documentos
rmdir examples 2>/dev/null || true
# El .gitignore apunta a examples/: si no se cambia, se commitean los tipos
# generados de las apps.
perl -pi -e 's{^examples/\*/sst-env\.d\.ts$}{apps/*/sst-env.d.ts}' .gitignore
# Los workspaces de npm: sin esto apps/web y apps/api dejan de ser workspaces y
# sus tests no corren.
perl -pi -e 's{"examples/\*"}{"apps/*"}' package.json
python3 -c "import json,sys; ws=json.load(open('package.json'))['workspaces']; sys.exit(0 if 'apps/*' in ws else 1)" \
  || { echo "  ✕ no se pudo actualizar workspaces en package.json" >&2; exit 1; }
echo "  examples/demo-client → apps/web"
echo "  examples/api-cliente → apps/api"
echo "  examples/documentos  → documentos/"
echo "  .gitignore y workspaces de package.json: examples/* → apps/*"

# ── 2. Slug y scope npm ────────────────────────────────────────────────────
echo "→ slug y scope"
perl -pi -e "s/slug: \"craftech-ai-chat\"/slug: \"$SLUG\"/" client.config.ts
grep -q "slug: \"$SLUG\"" client.config.ts || { echo "  ✕ no se pudo setear el slug" >&2; exit 1; }
reemplazar "@craftech-ai-chat/" "@$SLUG/"
perl -pi -e "s/\"name\": \"craftech-ai-chat\"/\"name\": \"$SLUG\"/" package.json
# El paquete de la app web se llamaba demo-client.
perl -pi -e "s/\"\@$SLUG\/demo-client\"/\"\@$SLUG\/web\"/" apps/web/package.json 2>/dev/null || true
# El nombre pelado (sin @scope) aparece en tres lugares mecánicos. La prosa de
# README y docs/ NO se toca acá: necesita reescritura, no renombrado.
for f in pyproject.toml core/smoke.sh apps/web/public/index.html; do
  [ -f "$f" ] || continue
  REEMP_DE="craftech-ai-chat" REEMP_A="$SLUG" \
    perl -pi -e 's/\Q$ENV{REEMP_DE}\E/$ENV{REEMP_A}/g' "$f"
done
echo "  client.config.ts → $SLUG"
echo "  scope npm → @$SLUG/*"
echo "  pyproject.toml, core/smoke.sh y el título de apps/web → $SLUG"

# ── 3. El corpus de ejemplo ────────────────────────────────────────────────
# Son documentos de una empresa inventada. Si alguien corre una ingesta, el
# chatbot del cliente contesta sobre una tienda que no existe. El README se
# queda: documenta el formato de los sidecars.
echo "→ corpus de ejemplo"
BORRADOS=0
for f in documentos/*.md documentos/*.metadata.json; do
  [ -f "$f" ] || continue
  case "$f" in */README.md) continue ;; esac
  rm -- "$f"; BORRADOS=$((BORRADOS + 1))
done
echo "  $BORRADOS archivos borrados (README.md conservado)"

# ── 4. El diagrama, con el slug y las rutas reales ─────────────────────────
echo "→ diagrama"
node docs/arquitectura.mjs docs/arquitectura.excalidraw "$SLUG" cliente >/dev/null
echo "  docs/arquitectura.excalidraw regenerado para $SLUG"

# ── 5. Este script y el playbook NO van al repo del cliente ────────────────
echo "→ piezas internas"
rm -f CLAUDE.md
echo "  CLAUDE.md borrado (playbook interno de Craftech)"
# El skill que conduce este clonado también es interno.
if [ -d .claude ]; then
  rm -rf .claude
  echo "  .claude/ borrado (skills internos de Craftech)"
fi
# Antes del grep de control, para no listarse a sí mismo.
rm -f "$YO"
echo "  scripts/clonar-para-cliente.sh borrado (este script)"

# ── Control ────────────────────────────────────────────────────────────────
echo
echo "── lo que queda, para revisar a mano ─────────────────────────────────"
echo
PENDIENTES="$(git grep -lI "craftech-ai-chat\|craftech-io\|chatbot-demo" -- . 2>/dev/null \
  | grep -vE '^(package-lock\.json)$' || true)"
if [ -n "$PENDIENTES" ]; then
  echo "1. Menciones al template en prosa (el renombrado mecánico no las toca):"
  printf '     %s\n' $PENDIENTES
else
  echo "1. Sin menciones al template. ✓"
fi
cat <<'PENDIENTE'

2. Historia de git: el clon arranca con un commit inicial limpio.
     rm -rf .git && git init && git branch -M main
     git config user.email "<el del remoto del cliente>"   # LOCAL, no global
   Verificá `git log --format=%ae -1` ANTES del primer push.

3. apps/web/mock.mjs: tiene textos VISIBLES AL USUARIO que citan el corpus de
   ejemplo que se acaba de borrar. Si quedan, el modo local le habla al cliente
   de otra empresa. Hay tests que pinean esos textos.

4. docs/diseno.md: sacar las secciones internas (plan de fases de entrega y
   riesgos comerciales del producto). Son planificación de Craftech.

5. marca.mjs: la identidad visual quedó con los valores de fábrica (nombre
   "Asistente", acento teal). El nombre visible, el logo y la paleta del cliente
   van ahí — el skill `marca-del-cliente` conduce ese trabajo: saca los colores
   del logo, verifica contraste y avisa si el color de marca no se puede usar.

6. client.config.ts: repasar TODOS los campos, no solo el slug — prompt del
   sistema, topes de uso, origenesCors (viene en ["*"]), retención, regex de PII.

7. El stage tiene que llamarse `production` o se pierden `retain` y `protect`
   (sst.config.ts compara el string exacto).

8. CI: el template usa GitHub Actions. Si el cliente usa otro remoto, portarlo.

9. Prerequisitos de la cuenta del cliente y primer deploy DESDE LOCAL.

Los detalles de 2 a 9 estaban en el CLAUDE.md que este script acaba de borrar:
está en el template, en la raíz.

Para verificar que el clon quedó sano, en este orden:

     npm install
     npx sst install --stage production   # sin esto typecheck:infra falla por
     npm run typecheck                    #   `Cannot find namespace 'awsnative'`
     npm run typecheck:infra
     npm test

   Y confirmá que `sst-env.d.ts` (raíz) tenga contenido: declara el tipo
   `Resource` y si queda con `Resource {}` vacío el typecheck del CI falla con
   ~20 errores TS2339. Se llena con `sst deploy`, no con `sst install`.
PENDIENTE
echo
echo "✓ listo."
