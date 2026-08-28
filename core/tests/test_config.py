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


def test_falla_si_hay_guardrail_id_sin_version():
    with pytest.raises(ConfigError, match="GUARDRAIL_VERSION"):
        load_config({"MODEL_ID": "m", "GUARDRAIL_ID": "gr-123"})


def test_falla_con_model_id_vacio():
    with pytest.raises(ConfigError, match="MODEL_ID"):
        load_config({"MODEL_ID": ""})


def test_memory_id_es_opcional():
    assert load_config({"MODEL_ID": "m"}).memory_id is None
    assert load_config({"MODEL_ID": "m", "MEMORY_ID": "mem-1"}).memory_id == "mem-1"


def test_las_urls_de_tools_son_opcionales():
    cfg = load_config({"MODEL_ID": "m"})
    assert cfg.gateway_url is None
    assert cfg.client_api_url is None
    # Vacía cuenta como ausente (mismo criterio que el guardrail y la memoria).
    cfg = load_config({"MODEL_ID": "m", "GATEWAY_URL": "", "CLIENT_API_URL": ""})
    assert cfg.gateway_url is None
    assert cfg.client_api_url is None


def test_lee_las_urls_de_tools_del_entorno():
    cfg = load_config(
        {"MODEL_ID": "m", "GATEWAY_URL": "https://gw/mcp", "CLIENT_API_URL": "http://api"}
    )
    assert cfg.gateway_url == "https://gw/mcp"
    assert cfg.client_api_url == "http://api"


def test_el_prompt_del_sistema_es_opcional():
    # Sin PROMPT_SISTEMA el agente se comporta como siempre: sin mensaje de
    # sistema. Vacía (o con solo espacios) cuenta como ausente, mismo criterio
    # que el guardrail y la memoria.
    assert load_config({"MODEL_ID": "m"}).prompt_sistema is None
    assert load_config({"MODEL_ID": "m", "PROMPT_SISTEMA": ""}).prompt_sistema is None
    assert load_config({"MODEL_ID": "m", "PROMPT_SISTEMA": "   \n"}).prompt_sistema is None


def test_lee_el_prompt_del_sistema_del_entorno():
    cfg = load_config({"MODEL_ID": "m", "PROMPT_SISTEMA": "Sos el asistente de Acme."})
    assert cfg.prompt_sistema == "Sos el asistente de Acme."
