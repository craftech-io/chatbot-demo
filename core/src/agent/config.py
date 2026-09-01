"""Única puerta a la configuración del core.

El core NO conoce el IaC que lo desplegó: recibe todo por variables de entorno,
según el contrato de `infra/CONTRACT.md`. Un `import` de SST acá es un error.
"""

import base64
import binascii
import logging
from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Falta configuración obligatoria: es preferible no arrancar."""


@dataclass(frozen=True)
class Config:
    model_id: str
    region: str
    # Tools, ambas opcionales: sin GATEWAY_URL no hay tools de tenant; sin
    # CLIENT_API_URL no hay tools de usuario. El chat sigue igual.
    gateway_url: str | None
    client_api_url: str | None
    # Política de comportamiento del agente (no inventar, citar la fuente,
    # ofrecer derivar). Opcional: sin prompt el modelo responde con su
    # comportamiento por defecto, igual que antes de que esto existiera.
    prompt_sistema: str | None


def _prompt_sistema(env: Mapping[str, str]) -> str | None:
    """El prompt del sistema, en claro o decodificado de base64.

    AgentCore Runtime RECHAZA caracteres de control en los valores de sus env
    vars ("Environment variable value contains invalid control characters"), y
    este prompt es multilínea por naturaleza: una regla por línea. Por eso la
    infra lo manda en base64 (`PROMPT_SISTEMA_B64`). Se sigue aceptando
    `PROMPT_SISTEMA` en claro para los sabores de IaC y los entornos locales
    donde el salto de línea no molesta, y gana esa por ser la más explícita.

    Se strippea antes de decidir: un prompt de solo espacios es lo mismo que no
    tener prompt, y mandarlo generaría un bloque `system` vacío que Converse
    rechaza.
    """
    en_claro = (env.get("PROMPT_SISTEMA") or "").strip()
    if en_claro:
        return en_claro

    codificado = (env.get("PROMPT_SISTEMA_B64") or "").strip()
    if not codificado:
        return None
    try:
        return base64.b64decode(codificado, validate=True).decode("utf-8").strip() or None
    except (binascii.Error, UnicodeDecodeError) as exc:
        # Fail-open: un prompt mal codificado no puede tumbar el arranque del
        # contenedor y dejar el chat entero caído. Sin prompt sigue respondiendo.
        logging.getLogger(__name__).error(
            "PROMPT_SISTEMA_B64 no se pudo decodificar, el agente corre sin prompt: %s", exc
        )
        return None


def load_config(env: Mapping[str, str]) -> Config:
    model_id = env.get("MODEL_ID")
    if not model_id:
        raise ConfigError(
            "Falta MODEL_ID. Lo inyecta el IaC según infra/CONTRACT.md."
        )
    return Config(
        model_id=model_id,
        region=env.get("AWS_REGION", "us-east-1"),
        gateway_url=env.get("GATEWAY_URL") or None,
        client_api_url=env.get("CLIENT_API_URL") or None,
        prompt_sistema=_prompt_sistema(env),
    )
