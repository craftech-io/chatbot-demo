# ARM64 es OBLIGATORIO: AgentCore Runtime no acepta otra arquitectura.
# 3.13 porque pyproject.toml exige >=3.13: con 3.12 de base, `uv sync` bajaba
# ADEMÁS un Python 3.13 managed en build (dos runtimes en la misma imagen).
FROM --platform=linux/arm64 python:3.13-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

COPY core/ ./core/
ENV PYTHONPATH=/app/core/src

EXPOSE 8080
# El python del venv DIRECTO, sin uv en runtime: `uv run` intenta verificar y
# sincronizar el entorno al arrancar, y en la microVM de AgentCore (FS
# restringido, sin cache escribible) eso muere antes de loguear una línea.
# El venv ya quedó completo en build time con `uv sync --frozen`.
CMD ["/app/.venv/bin/python", "core/server.py"]
