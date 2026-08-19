# ARM64 es OBLIGATORIO: AgentCore Runtime no acepta otra arquitectura.
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

COPY core/ ./core/
ENV PYTHONPATH=/app/core/src

EXPOSE 8080
CMD ["uv", "run", "--no-dev", "python", "core/server.py"]
