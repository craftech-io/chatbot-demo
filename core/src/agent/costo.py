"""Costo estimado del turno a partir del uso de tokens que devuelve el adaptador.

Dos piezas:

- `costo_usd(uso, tarifas)` es puro: tokens + precios → USD.
- `costo_estimado(uso, model_id, region)` resuelve las tarifas contra la Price
  List API de AWS (`AmazonBedrockFoundationModels`) y cachea el resultado a
  nivel módulo — los precios no cambian a mitad de la vida del contenedor.

**Todo el archivo es fail-open.** Si la tarifa no se puede resolver —modelo que
no está en la tabla, región que no está en la tabla, la API no responde, el rol
no tiene `pricing:GetProducts`, una unidad que no sabemos convertir, dos precios
distintos para el mismo componente— el resultado es `None`: el turno se loguea
con el uso y SIN costo. Nunca una excepción al turno, nunca un precio inventado.
"""

import json
import logging
from dataclasses import dataclass, replace

logger = logging.getLogger(__name__)

# El identificador útil de la Price List API para Bedrock es `servicename`: el
# spike verificó que los atributos `model` y `tokenType` vienen VACÍOS.
#
# **Esto es lo único que hay que ampliar al agregar un modelo.** La clave es el
# model id SIN el prefijo de inference profile (`us.`, `eu.`, `apac.`,
# `global.`) y sin el sufijo de fecha/versión (`-20260101-v1:0`).
#
# Para conseguir el servicename exacto de un modelo nuevo:
#   aws pricing get-products --region us-east-1 \
#     --service-code AmazonBedrockFoundationModels \
#     --filters Type=TERM_MATCH,Field=servicename,Value="<nombre>" | head
# Si el servicename no matchea, la API devuelve una lista vacía y el turno se
# loguea sin costo (fail-open): un valor equivocado degrada la métrica, no el chat.
SERVICENAME_POR_MODELO = {
    "anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6 (Amazon Bedrock Edition)",
    "anthropic.claude-sonnet-4-5": "Claude Sonnet 4.5 (Amazon Bedrock Edition)",
    "anthropic.claude-haiku-4-5": "Claude Haiku 4.5 (Amazon Bedrock Edition)",
    "anthropic.claude-opus-4-1": "Claude Opus 4.1 (Amazon Bedrock Edition)",
}

# Los usagetype de la Price List API llevan el prefijo de facturación de la
# región (`USE1-MP:USE1_InputTokenCount-Units`), y ese prefijo NO se deriva del
# nombre de la región (ap-south-1 factura como APS3). Es una tabla aparte de la
# de modelos: se amplía al desplegar en una región que no esté acá, y una región
# ausente deja el turno sin costo en vez de mezclar el precio de otra región.
PREFIJO_USAGETYPE_POR_REGION = {
    "us-east-1": "USE1",
    "us-east-2": "USE2",
    "us-west-1": "USW1",
    "us-west-2": "USW2",
    "ca-central-1": "CAN1",
    "eu-central-1": "EUC1",
    "eu-west-1": "EUW1",
    "eu-west-2": "EUW2",
    "eu-west-3": "EUW3",
    "eu-north-1": "EUN1",
    "ap-northeast-1": "APN1",
    "ap-northeast-2": "APN2",
    "ap-northeast-3": "APN3",
    "ap-southeast-1": "APS1",
    "ap-southeast-2": "APS2",
    "ap-south-1": "APS3",
    "sa-east-1": "SAE1",
}

# Componente del usagetype → campo de `Tarifas`.
#
# El usagetype tiene la forma `<PREFIJO>-MP:<PREFIJO>_<Componente>`, y el
# componente se matchea EXACTO, no por sufijo. Que no sea por sufijo es la
# lección de un costo mal calculado en producción: `CacheReadInputTokenCount` y
# `CacheWrite1hInputTokenCount` TERMINAN los dos con `InputTokenCount`, así que
# un match por sufijo le asigna a "entrada" el precio de la escritura de cache a
# una hora (5x más caro) y la ambigüedad deja el turno sin costo. Ordenar por
# longitud tapa una de las variantes pero no las que todavía no existen: exacto
# es la única forma que no se rompe cuando AWS agrega un componente nuevo.
CAMPO_POR_COMPONENTE_USAGETYPE = {
    "InputTokenCount-Units": "entrada_por_1k",
    "OutputTokenCount-Units": "salida_por_1k",
    "CacheReadInputTokenCount-Units": "cache_lectura_por_1k",
    "CacheWriteInputTokenCount-Units": "cache_escritura_por_1k",
}


def _componente_de(usagetype: str) -> str:
    """El componente del usagetype: lo que sigue al último `_`.

    `USE1-MP:USE1_InputTokenCount-Units` → `InputTokenCount-Units`.
    """
    return usagetype.rsplit("_", 1)[-1]


# Cuántos tokens cuesta una unidad del precio. La API declara la unidad y no la
# adivinamos: una unidad que no esté acá deja la tarifa sin resolver (y el log
# dice cuál vino, así se agrega en una línea).
TOKENS_POR_UNIDAD = {
    "token": 1,
    "tokens": 1,
    "1ktokens": 1_000,
    "1000tokens": 1_000,
    "1mtokens": 1_000_000,
    "1000000tokens": 1_000_000,
}

# La Price List API vive en un puñado de regiones y sirve los precios de todas
# (es un catálogo global): esta región es la del endpoint, no la del deploy.
REGION_PRICING_API = "us-east-1"

SERVICE_CODE = "AmazonBedrockFoundationModels"


@dataclass(frozen=True)
class UsoTokens:
    """Tokens de un turno (o de una llamada). Neutral al proveedor: el adaptador
    traduce lo que reporte el suyo a estos cuatro números."""

    entrada: int = 0
    salida: int = 0
    cache_lectura: int = 0
    cache_escritura: int = 0

    def __add__(self, otro: "UsoTokens") -> "UsoTokens":
        """Un turno puede tener varias llamadas al modelo (el loop de tools):
        el uso del turno es la suma."""
        if not isinstance(otro, UsoTokens):
            return NotImplemented
        return UsoTokens(
            entrada=self.entrada + otro.entrada,
            salida=self.salida + otro.salida,
            cache_lectura=self.cache_lectura + otro.cache_lectura,
            cache_escritura=self.cache_escritura + otro.cache_escritura,
        )


@dataclass(frozen=True)
class Tarifas:
    """Precios en USD por 1000 tokens. `None` = tarifa desconocida (no es cero)."""

    entrada_por_1k: float | None = None
    salida_por_1k: float | None = None
    cache_lectura_por_1k: float | None = None
    cache_escritura_por_1k: float | None = None


# (modelo normalizado, región) → tarifas. Cachea también el fracaso (`None`):
# sin permiso de Pricing o sin el modelo en la tabla, no tiene sentido pagar una
# llamada por turno. Un contenedor nuevo vuelve a intentar.
_CACHE_TARIFAS: dict[tuple[str, str], Tarifas | None] = {}

# Cada componente: (tokens del uso, tarifa, nombre para el log).
_COMPONENTES = (
    ("entrada", "entrada_por_1k"),
    ("salida", "salida_por_1k"),
    ("cache_lectura", "cache_lectura_por_1k"),
    ("cache_escritura", "cache_escritura_por_1k"),
)


def limpiar_cache_de_tarifas() -> None:
    """Vacía el cache de tarifas. Existe para los tests."""
    _CACHE_TARIFAS.clear()


def costo_usd(uso: UsoTokens | None, tarifas: Tarifas | None) -> float | None:
    """USD del uso, o `None` si falta alguna tarifa que el uso necesita.

    "Que el uso necesita": un componente con 0 tokens no exige tarifa (0 por
    cualquier precio es 0). Uno con tokens y sin tarifa deja el costo ENTERO en
    `None` — un total al que le falta una pata sería un precio inventado.

    Se redondea a 6 decimales: esto es una estimación para el log, no un asiento
    contable, y así el número no arrastra la basura del punto flotante.
    """
    if uso is None or tarifas is None:
        return None
    total = 0.0
    for campo_uso, campo_tarifa in _COMPONENTES:
        tokens = getattr(uso, campo_uso)
        if not tokens:
            continue
        precio = getattr(tarifas, campo_tarifa)
        if precio is None:
            logger.warning(
                "sin tarifa para %s (%s tokens): el turno se loguea sin costo",
                campo_tarifa,
                tokens,
            )
            return None
        total += tokens / 1000 * precio
    return round(total, 6)


def costo_estimado(
    uso: UsoTokens | None, model_id: str, region: str, cliente=None
) -> float | None:
    """Costo del turno: resuelve las tarifas (cacheadas) y calcula. Nunca lanza."""
    if uso is None:
        return None
    try:
        return costo_usd(uso, tarifas_de_modelo(model_id, region, cliente=cliente))
    except Exception:
        # Red de seguridad: la observabilidad no puede tumbar un turno.
        logger.exception("no se pudo estimar el costo del turno (fail-open)")
        return None


def tarifas_de_modelo(model_id: str, region: str, cliente=None) -> Tarifas | None:
    """Tarifas on-demand del modelo en esa región, o `None` si no se resuelven."""
    modelo = _normalizar_model_id(model_id)
    clave = (modelo, region)
    if clave in _CACHE_TARIFAS:
        return _CACHE_TARIFAS[clave]
    tarifas = _descubrir_tarifas(modelo, region, cliente)
    _CACHE_TARIFAS[clave] = tarifas
    return tarifas


def _normalizar_model_id(model_id: str) -> str:
    """Saca el prefijo de inference profile y el sufijo de fecha/versión.

    `us.anthropic.claude-sonnet-4-6-20260101-v1:0` → `anthropic.claude-sonnet-4-6`,
    para que la tabla de servicenames tenga UNA entrada por modelo.
    """
    modelo = (model_id or "").strip()
    prefijo, _, resto = modelo.partition(".")
    if resto and prefijo in ("us", "eu", "apac", "global", "us-gov"):
        modelo = resto
    modelo = modelo.split(":", 1)[0]
    partes = modelo.split("-")
    # El sufijo de versión (`v1`) y el de fecha (`20260101`) no distinguen precios.
    while partes and (
        (partes[-1].startswith("v") and partes[-1][1:].isdigit())
        or (len(partes[-1]) == 8 and partes[-1].isdigit())
    ):
        partes.pop()
    return "-".join(partes)


def _descubrir_tarifas(modelo: str, region: str, cliente) -> Tarifas | None:
    servicename = SERVICENAME_POR_MODELO.get(modelo)
    if not servicename:
        logger.warning(
            "el modelo %s no está en SERVICENAME_POR_MODELO (agent/costo.py): "
            "los turnos se loguean sin costo",
            modelo,
        )
        return None
    prefijo = PREFIJO_USAGETYPE_POR_REGION.get(region)
    if not prefijo:
        logger.warning(
            "la región %s no está en PREFIJO_USAGETYPE_POR_REGION (agent/costo.py): "
            "los turnos se loguean sin costo",
            region,
        )
        return None
    productos = _productos(servicename, cliente)
    if productos is None:
        return None
    return _tarifas_de_productos(productos, prefijo, servicename)


def _productos(servicename: str, cliente) -> list[dict] | None:
    """Todos los productos del modelo en la Price List API (todas las páginas).

    Se filtra solo por `servicename`: el usagetype exacto tiene partes que
    varían (`-MP:`) y un filtro demasiado específico devolvería vacío sin decir
    por qué. El componente y la región se deciden acá, sobre el usagetype.
    """
    try:
        if cliente is None:
            import boto3

            cliente = boto3.client("pricing", region_name=REGION_PRICING_API)
        productos: list[dict] = []
        token = None
        while True:
            kwargs = {
                "ServiceCode": SERVICE_CODE,
                "Filters": [
                    {"Type": "TERM_MATCH", "Field": "servicename", "Value": servicename}
                ],
            }
            if token:
                kwargs["NextToken"] = token
            salida = cliente.get_products(**kwargs)
            productos += [json.loads(p) for p in salida.get("PriceList", [])]
            token = salida.get("NextToken")
            if not token:
                return productos
    except Exception as exc:
        # Sin permiso `pricing:GetProducts`, sin red, o con una respuesta que no
        # parsea: el turno se loguea con el uso y sin costo.
        logger.warning("no se pudieron leer las tarifas de %s: %s", servicename, exc)
        return None


def _tarifas_de_productos(
    productos: list[dict], prefijo: str, servicename: str
) -> Tarifas | None:
    tarifas = Tarifas()
    for producto in productos:
        atributos = (producto.get("product") or {}).get("attributes") or {}
        usagetype = atributos.get("usagetype") or ""
        if not usagetype.startswith(prefijo):
            continue  # otra región del mismo modelo
        campo = CAMPO_POR_COMPONENTE_USAGETYPE.get(_componente_de(usagetype))
        if campo is None:
            continue  # otro componente facturable que no entra en el costo del turno
        precio = _precio_por_1k(producto, usagetype)
        if precio is None:
            return None
        anterior = getattr(tarifas, campo)
        if anterior is not None and anterior != precio:
            # Dos precios distintos para el mismo componente y la misma región:
            # elegir uno sería adivinar.
            logger.warning(
                "tarifas ambiguas para %s de %s (%s y %s): el turno se loguea sin costo",
                campo,
                servicename,
                anterior,
                precio,
            )
            return None
        tarifas = replace(tarifas, **{campo: precio})
    return tarifas


def _precio_por_1k(producto: dict, usagetype: str) -> float | None:
    """USD por 1000 tokens de la dimensión on-demand del producto."""
    terminos = ((producto.get("terms") or {}).get("OnDemand") or {}).values()
    for termino in terminos:
        for dimension in (termino.get("priceDimensions") or {}).values():
            unidad = str(dimension.get("unit") or "")
            tokens_por_unidad = TOKENS_POR_UNIDAD.get(
                unidad.lower().replace(" ", "").replace("-", "").replace(",", "")
            )
            if tokens_por_unidad is None:
                logger.warning(
                    "unidad de precio desconocida %r en %s: el turno se loguea sin "
                    "costo (agregala a TOKENS_POR_UNIDAD en agent/costo.py)",
                    unidad,
                    usagetype,
                )
                return None
            usd = (dimension.get("pricePerUnit") or {}).get("USD")
            if usd is None:
                logger.warning("el precio de %s no viene en USD: sin costo", usagetype)
                return None
            return float(usd) * 1000 / tokens_por_unidad
    logger.warning("el producto de %s no trae precio on-demand: sin costo", usagetype)
    return None
