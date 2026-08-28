# ARM64 es OBLIGATORIO: AgentCore Runtime no acepta otra arquitectura.
# 3.13 porque pyproject.toml exige >=3.13: con una base 3.12, `uv sync` baja
# ADEMÁS un Python 3.13 managed en build y la imagen queda con dos runtimes.
FROM --platform=linux/arm64 python:3.13-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

COPY core/ ./core/
ENV PYTHONPATH=/app/core/src

# Sin configuración, la imagen NO exporta telemetría: `opentelemetry-instrument`
# instrumenta el proceso igual, pero los tres exporters quedan en `none`. Hace
# falta ponerlo: el default del SDK es OTLP contra `localhost:4318`, que en la
# microVM no existe, y el arranque se llena de "Connection refused ... retrying"
# cada pocos segundos, para nada (verificado corriendo la imagen sin env).
# `infra/sst/runtime.ts` pisa el de trazas con `otlp`, y el modo local con
# `console` (ver docs/notas-tecnicas.md).
ENV OTEL_TRACES_EXPORTER=none OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none

EXPOSE 8080
# El python del venv DIRECTO, sin uv en runtime: `uv run` intenta verificar y
# sincronizar el entorno al arrancar, y en la microVM de AgentCore (FS
# restringido, sin cache escribible) eso muere antes de loguear una línea.
# El venv ya quedó completo en build time con `uv sync --frozen`.
#
# Envuelto en `opentelemetry-instrument` (entrypoint del distro de ADOT, spec
# §17 capa 2): auto-instrumenta el proceso ANTES de importar la app, que es la
# única forma de que enganche starlette/httpx sin tocar el código. No exporta
# nada por su cuenta si no hay env que lo configuren, así que el contenedor
# sigue arrancando igual sin ellas (ver infra/CONTRACT.md).
#
# Los spans del INTERIOR del turno no los da este entrypoint: los da el
# instrumentor de OpenInference, que `core/server.py` llama a mano detrás de
# `TRAZAS_OPENINFERENCE=1`.
#
# Rutas absolutas al venv en los dos: `opentelemetry-instrument` hace `which`
# del comando y lo `execl`ea, así que el `python` tiene que ser el del venv y no
# el del sistema. El script preserva el `PYTHONPATH` de arriba (le agrega su
# propio directorio, no lo reemplaza), así que `agent.*` sigue importándose.
CMD ["/app/.venv/bin/opentelemetry-instrument", "/app/.venv/bin/python", "core/server.py"]
