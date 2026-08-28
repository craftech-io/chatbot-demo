import json
import logging

from agent import costo as modulo_costo
from agent.costo import Tarifas, UsoTokens, costo_estimado, costo_usd

MODELO = "us.anthropic.claude-sonnet-4-6"
REGION = "us-east-1"

# Números redondos a propósito: el cálculo se verifica a mano en el test.
TARIFAS = Tarifas(
    entrada_por_1k=3.0,
    salida_por_1k=15.0,
    cache_lectura_por_1k=0.3,
    cache_escritura_por_1k=3.75,
)


def setup_function():
    # El cache es a nivel módulo (una consulta por microVM): cada test arranca limpio.
    modulo_costo.limpiar_cache_de_tarifas()


# --- cálculo puro ---


def test_calcula_el_costo_con_entrada_salida_y_las_dos_patas_del_cache():
    uso = UsoTokens(entrada=1000, salida=500, cache_lectura=2000, cache_escritura=400)
    # 1000/1k*3 + 500/1k*15 + 2000/1k*0.3 + 400/1k*3.75 = 3 + 7.5 + 0.6 + 1.5
    assert costo_usd(uso, TARIFAS) == 12.6


def test_un_componente_sin_tokens_no_necesita_tarifa():
    uso = UsoTokens(entrada=1000, salida=500)
    solo_texto = Tarifas(entrada_por_1k=3.0, salida_por_1k=15.0)
    assert costo_usd(uso, solo_texto) == 10.5


def test_sin_tarifas_no_hay_costo_y_no_hay_excepcion():
    assert costo_usd(UsoTokens(entrada=1000, salida=500), None) is None
    assert costo_usd(UsoTokens(entrada=1000, salida=500), Tarifas()) is None


def test_un_componente_con_tokens_y_sin_tarifa_no_inventa_un_precio():
    # Hubo escritura de cache pero no sabemos cuánto cuesta: el costo entero es
    # desconocido, no "el costo sin esa pata".
    uso = UsoTokens(entrada=1000, salida=500, cache_escritura=400)
    sin_cache = Tarifas(entrada_por_1k=3.0, salida_por_1k=15.0)
    assert costo_usd(uso, sin_cache) is None


def test_sin_uso_no_hay_costo():
    assert costo_usd(None, TARIFAS) is None


def test_los_usos_se_suman_para_acumular_el_turno():
    total = UsoTokens(entrada=1, salida=2) + UsoTokens(entrada=10, salida=20, cache_lectura=3)
    assert total == UsoTokens(entrada=11, salida=22, cache_lectura=3, cache_escritura=0)


# --- descubrimiento de tarifas contra la Price List API ---


def _producto(usagetype: str, precio: str, unidad: str = "1K tokens") -> str:
    """Un producto de la Price List API, con la forma real: JSON en un string."""
    return json.dumps(
        {
            "product": {
                "attributes": {
                    # El spike verificó que `model` y `tokenType` vienen VACÍOS:
                    # lo único que identifica al componente es el usagetype.
                    "model": "",
                    "tokenType": "",
                    "servicename": "Claude Sonnet 4.6 (Amazon Bedrock Edition)",
                    "usagetype": usagetype,
                }
            },
            "terms": {
                "OnDemand": {
                    "TERM": {
                        "priceDimensions": {
                            "DIM": {"unit": unidad, "pricePerUnit": {"USD": precio}}
                        }
                    }
                }
            },
        }
    )


PRODUCTOS_SONNET = [
    _producto("USE1-MP:USE1_InputTokenCount-Units", "0.0030000000"),
    _producto("USE1-MP:USE1_OutputTokenCount-Units", "0.0150000000"),
    _producto("USE1-MP:USE1_CacheReadInputTokenCount-Units", "0.0003000000"),
    _producto("USE1-MP:USE1_CacheWriteInputTokenCount-Units", "0.0037500000"),
    # Otra región del mismo modelo: no es la nuestra y no debe mezclarse.
    _producto("EUC1-MP:EUC1_InputTokenCount-Units", "0.0099000000"),
]


class FakePricing:
    """Doble del cliente `pricing` de boto3: devuelve páginas y registra llamadas."""

    def __init__(self, paginas: list[list[str]] | None = None, explota: bool = False):
        self.paginas = paginas if paginas is not None else [PRODUCTOS_SONNET]
        self.explota = explota
        self.llamadas: list[dict] = []

    def get_products(self, **kwargs):
        if self.explota:
            raise RuntimeError("AccessDeniedException simulada")
        self.llamadas.append(kwargs)
        indice = int(kwargs.get("NextToken") or 0)
        salida = {"PriceList": self.paginas[indice]}
        if indice + 1 < len(self.paginas):
            salida["NextToken"] = str(indice + 1)
        return salida


def test_descubre_las_tarifas_del_modelo_filtrando_por_servicename():
    pricing = FakePricing()
    uso = UsoTokens(entrada=1000, salida=500, cache_lectura=2000, cache_escritura=400)

    # Precios reales del fixture: USD por 1K tokens (0.003 / 0.015 / 0.0003 / 0.00375).
    assert costo_estimado(uso, MODELO, REGION, cliente=pricing) == 0.0126

    (llamada,) = pricing.llamadas
    assert llamada["ServiceCode"] == "AmazonBedrockFoundationModels"
    filtros = {f["Field"]: f["Value"] for f in llamada["Filters"]}
    assert filtros == {"servicename": "Claude Sonnet 4.6 (Amazon Bedrock Edition)"}
    assert all(f["Type"] == "TERM_MATCH" for f in llamada["Filters"])


def test_recorre_las_paginas_de_la_pricing_api():
    pricing = FakePricing(paginas=[PRODUCTOS_SONNET[:2], PRODUCTOS_SONNET[2:]])
    uso = UsoTokens(entrada=1000, salida=500, cache_lectura=2000, cache_escritura=400)

    assert costo_estimado(uso, MODELO, REGION, cliente=pricing) == 0.0126
    assert len(pricing.llamadas) == 2


def test_las_tarifas_se_cachean_a_nivel_modulo():
    pricing = FakePricing()
    uso = UsoTokens(entrada=1000, salida=500)

    assert costo_estimado(uso, MODELO, REGION, cliente=pricing) == 0.0105
    assert costo_estimado(uso, MODELO, REGION, cliente=pricing) == 0.0105

    # Una consulta por (modelo, región) y por microVM: los precios no cambian
    # a mitad de la vida del contenedor.
    assert len(pricing.llamadas) == 1


def test_un_modelo_que_no_esta_en_la_tabla_no_pega_a_la_pricing_api(caplog):
    pricing = FakePricing()
    with caplog.at_level(logging.WARNING):
        assert costo_estimado(UsoTokens(entrada=10), "fake", REGION, cliente=pricing) is None
    assert pricing.llamadas == []
    assert "fake" in caplog.text


def test_una_region_que_no_esta_en_la_tabla_no_adivina_la_tarifa(caplog):
    pricing = FakePricing()
    with caplog.at_level(logging.WARNING):
        assert (
            costo_estimado(UsoTokens(entrada=10), MODELO, "xx-north-9", cliente=pricing)
            is None
        )
    assert "xx-north-9" in caplog.text


def test_si_la_pricing_api_falla_el_turno_se_loguea_sin_costo(caplog):
    pricing = FakePricing(explota=True)
    with caplog.at_level(logging.WARNING):
        assert costo_estimado(UsoTokens(entrada=1000), MODELO, REGION, cliente=pricing) is None
    assert "AccessDeniedException simulada" in caplog.text


def test_una_unidad_que_no_sabemos_convertir_no_se_convierte(caplog):
    pricing = FakePricing(
        paginas=[[_producto("USE1-MP:USE1_InputTokenCount-Units", "1.0", unidad="Requests")]]
    )
    with caplog.at_level(logging.WARNING):
        assert costo_estimado(UsoTokens(entrada=1000), MODELO, REGION, cliente=pricing) is None
    assert "Requests" in caplog.text


def test_dos_precios_distintos_para_el_mismo_componente_no_se_adivinan(caplog):
    pricing = FakePricing(
        paginas=[
            [
                _producto("USE1-MP:USE1_InputTokenCount-Units", "0.0030000000"),
                _producto("USE1-Something:USE1_InputTokenCount-Units", "0.0060000000"),
            ]
        ]
    )
    with caplog.at_level(logging.WARNING):
        assert costo_estimado(UsoTokens(entrada=1000), MODELO, REGION, cliente=pricing) is None
    assert "entrada_por_1k" in caplog.text


def test_un_precio_repetido_igual_no_es_ambiguo():
    pricing = FakePricing(
        paginas=[
            [
                _producto("USE1-MP:USE1_InputTokenCount-Units", "0.0030000000"),
                _producto("USE1-Otro:USE1_InputTokenCount-Units", "0.0030000000"),
            ]
        ]
    )
    assert costo_estimado(UsoTokens(entrada=1000), MODELO, REGION, cliente=pricing) == 0.003


def test_sin_uso_no_se_consulta_la_pricing_api():
    pricing = FakePricing()
    assert costo_estimado(None, MODELO, REGION, cliente=pricing) is None
    assert pricing.llamadas == []


# El bug que apareció en producción: el costo salía siempre null porque
# `CacheWrite1hInputTokenCount-Units` TERMINA con `InputTokenCount-Units`, y el
# match por sufijo le daba a "entrada" dos precios (3,30 y 6,60 por millón) →
# ambigüedad → turno sin costo. Con match exacto por componente, el usagetype
# que no está en la tabla simplemente no aporta.
def test_un_componente_desconocido_no_contamina_la_tarifa_de_entrada():
    from agent.costo import _tarifas_de_productos

    productos = [
        json.loads(_producto("USE1-MP:USE1_InputTokenCount-Units", "3.30", "1M tokens")),
        # el que rompía: mismo sufijo, otro componente, 5x el precio
        json.loads(_producto("USE1-MP:USE1_CacheWrite1hInputTokenCount-Units", "6.60", "1M tokens")),
        json.loads(_producto("USE1-MP:USE1_OutputTokenCount-Units", "16.50", "1M tokens")),
    ]

    tarifas = _tarifas_de_productos(productos, "USE1", "un modelo")

    assert tarifas is not None, "la ambigüedad falsa dejaba el turno sin costo"
    assert round(tarifas.entrada_por_1k, 6) == 0.0033
    assert round(tarifas.salida_por_1k, 6) == 0.0165
