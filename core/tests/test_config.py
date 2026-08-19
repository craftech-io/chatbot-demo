import pytest

from agent.config import ConfigError, load_config


def test_falla_con_mensaje_claro_si_falta_el_modelo():
    with pytest.raises(ConfigError, match="MODEL_ID"):
        load_config({})


def test_lee_el_modelo_y_el_guardrail():
    cfg = load_config(
        {
            "MODEL_ID": "us.anthropic.claude-sonnet-4-6",
            "GUARDRAIL_ID": "gr-123",
            "GUARDRAIL_VERSION": "3",
            "AWS_REGION": "us-east-1",
        }
    )
    assert cfg.model_id == "us.anthropic.claude-sonnet-4-6"
    assert cfg.guardrail_id == "gr-123"
    assert cfg.guardrail_version == "3"
    assert cfg.region == "us-east-1"


def test_el_guardrail_es_opcional():
    cfg = load_config({"MODEL_ID": "m", "AWS_REGION": "us-east-1"})
    assert cfg.guardrail_id is None
    assert cfg.guardrail_version is None
