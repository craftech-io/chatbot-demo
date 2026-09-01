import pytest

from agent.config import ConfigError, load_config


def test_falla_con_mensaje_claro_si_falta_el_modelo():
    with pytest.raises(ConfigError, match="MODEL_ID"):
        load_config({})


def test_lee_el_modelo_y_la_region():
    cfg = load_config({"MODEL_ID": "us.anthropic.claude-sonnet-4-6", "AWS_REGION": "us-east-1"})
    assert cfg.model_id == "us.anthropic.claude-sonnet-4-6"
    assert cfg.region == "us-east-1"


def test_falla_con_model_id_vacio():
    with pytest.raises(ConfigError, match="MODEL_ID"):
        load_config({"MODEL_ID": ""})


def test_las_urls_de_tools_son_opcionales():
    cfg = load_config({"MODEL_ID": "m"})
    assert cfg.gateway_url is None
    assert cfg.client_api_url is None
    # Vacía cuenta como ausente.
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


# AgentCore Runtime RECHAZA caracteres de control en los valores de sus env vars
# ("Environment variable value contains invalid control characters"), y el prompt
# del sistema es multilínea por naturaleza (una regla por línea). Por eso viaja
# en base64 por `PROMPT_SISTEMA_B64`. Se sigue aceptando `PROMPT_SISTEMA` en
# claro para los sabores de IaC y los entornos locales donde el salto de línea
# no molesta; si están las dos, gana la de claro (es la más explícita de leer).
def test_lee_el_prompt_del_sistema_en_base64():
    import base64

    prompt = "Regla 1.\nRegla 2."
    cfg = load_config(
        {
            "MODEL_ID": "m",
            "PROMPT_SISTEMA_B64": base64.b64encode(prompt.encode("utf-8")).decode("ascii"),
        }
    )

    assert cfg.prompt_sistema == prompt


def test_el_prompt_en_claro_le_gana_al_base64():
    import base64

    cfg = load_config(
        {
            "MODEL_ID": "m",
            "PROMPT_SISTEMA": "en claro",
            "PROMPT_SISTEMA_B64": base64.b64encode(b"en base64").decode("ascii"),
        }
    )

    assert cfg.prompt_sistema == "en claro"


def test_un_base64_ilegible_no_tumba_el_arranque():
    # Fallar el arranque del contenedor por un prompt mal codificado dejaría el
    # chat entero caído; sin prompt sigue respondiendo.
    cfg = load_config({"MODEL_ID": "m", "PROMPT_SISTEMA_B64": "no-es-base64-valido!!"})

    assert cfg.prompt_sistema is None
