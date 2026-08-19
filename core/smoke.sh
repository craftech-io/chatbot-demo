#!/usr/bin/env bash
# Smoke del contenedor: levanta la imagen y verifica el contrato del Runtime.
# Usa FAKE_LLM=1 para no pegarle a Bedrock.
set -euo pipefail

docker build --platform linux/arm64 -f core/Dockerfile -t craftech-ai-chat-core:dev .
cid=$(docker run -d -p 8080:8080 -e MODEL_ID=fake -e FAKE_LLM=1 craftech-ai-chat-core:dev)
trap 'docker rm -f "$cid" >/dev/null' EXIT

# Presupuesto generoso: bajo QEMU (build multi-arch en x86) el arranque tarda
# ~30s; en ARM real es mucho menor. 60×2s cubre ambos con margen.
for _ in $(seq 1 60); do
  if curl -sf localhost:8080/ping >/dev/null; then break; fi
  sleep 2
done

echo "== /ping =="
curl -sf localhost:8080/ping | grep -q Healthy && echo OK

echo "== /invocations =="
curl -sfN localhost:8080/invocations -H 'content-type: application/json' \
  -d '{"message":"hola","history":[]}' | grep -q '"type": "done"' && echo OK
