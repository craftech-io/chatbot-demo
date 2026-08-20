#!/usr/bin/env bash
# Typecheck de sst.config.ts + infra/. Filtra el único error preexistente de
# .sst/platform (vendored, gitignoreado, reproducible con su propio tsc) y
# falla si queda cualquier otro error.
set -uo pipefail
salida=$(npx tsc --noEmit -p tsconfig.json 2>&1)
resto=$(printf '%s\n' "$salida" | grep -v '^\.sst/platform/' | grep 'error TS' || true)
if [ -n "$resto" ]; then
  printf '%s\n' "$resto"
  exit 1
fi
echo "typecheck de infra OK"
