"""Única puerta a la configuración del core.

El core NO conoce el IaC que lo desplegó: recibe todo por variables de entorno,
según el contrato de `infra/CONTRACT.md`. Un `import` de SST acá es un error.
"""

from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Falta configuración obligatoria: es preferible no arrancar."""


@dataclass(frozen=True)
class Config:
    model_id: str
    guardrail_id: str | None
    guardrail_version: str | None
    region: str
    memory_id: str | None
    # Tools, ambas opcionales: sin GATEWAY_URL no hay tools de tenant; sin
    # CLIENT_API_URL no hay tools de usuario. El chat sigue igual.
    gateway_url: str | None
    client_api_url: str | None
    # Política de comportamiento del agente (no inventar, citar la fuente,
    # ofrecer derivar). Opcional: sin prompt el modelo responde con su
    # comportamiento por defecto, igual que antes de que esto existiera.
    prompt_sistema: str | None


def load_config(env: Mapping[str, str]) -> Config:
    model_id = env.get("MODEL_ID")
    if not model_id:
        raise ConfigError(
            "Falta MODEL_ID. Lo inyecta el IaC según infra/CONTRACT.md."
        )
    guardrail_id = env.get("GUARDRAIL_ID") or None
    guardrail_version = env.get("GUARDRAIL_VERSION") or None
    if guardrail_id and not guardrail_version:
        # Invariante de infra/CONTRACT.md: GUARDRAIL_VERSION es "requerida si hay
        # GUARDRAIL_ID". Bedrock la exige para aplicar el guardrail; mejor fallar
        # al arrancar que a mitad de la primera conversación.
        raise ConfigError(
            "Falta GUARDRAIL_VERSION: es obligatoria cuando hay GUARDRAIL_ID "
            "(ver infra/CONTRACT.md)."
        )
    return Config(
        model_id=model_id,
        guardrail_id=guardrail_id,
        guardrail_version=guardrail_version,
        region=env.get("AWS_REGION", "us-east-1"),
        memory_id=env.get("MEMORY_ID") or None,
        gateway_url=env.get("GATEWAY_URL") or None,
        client_api_url=env.get("CLIENT_API_URL") or None,
        # Se strippea antes de decidir: un prompt de solo espacios es lo mismo
        # que no tener prompt, y mandarlo generaría un bloque `system` vacío
        # que Converse rechaza.
        prompt_sistema=(env.get("PROMPT_SISTEMA") or "").strip() or None,
    )
