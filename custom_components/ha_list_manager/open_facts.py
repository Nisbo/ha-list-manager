"""Product lookup through the universal Open Food Facts API."""

from __future__ import annotations

from html import unescape
import re
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import VERSION

_API_URL = "https://world.openfoodfacts.org/api/v3/product/{ean}.json"
_FIELDS = (
    "product_name",
    "product_name_en",
    "brands",
    "quantity",
    "product_quantity",
    "product_quantity_unit",
    "image_front_thumb_url",
    "product_type",
)


class OpenFactsLookupError(Exception):
    """Raised when Open Food Facts cannot be reached or returns invalid data."""


def _clean_text(value: Any) -> str | None:
    """Return a decoded, stripped string or None."""
    if not isinstance(value, str):
        return None
    value = unescape(value).strip()
    return value or None


def _first_brand(value: Any) -> str | None:
    """Return the first usable brand from the Open Food Facts brand string."""
    brands = _clean_text(value)
    if not brands:
        return None
    return next((brand.strip() for brand in brands.split(",") if brand.strip()), None)


def _format_quantity(value: str | None, language: str) -> str | None:
    """Format common package quantities for display."""
    if not value or "unknown" in value.casefold():
        return None
    value = re.sub(r"(\d)\s*(ml|cl|dl|l|mg|g|kg)\b", r"\1 \2", value, flags=re.I)
    value = re.sub(
        r"\b(ML|CL|DL|L|MG|G|KG)\b",
        lambda match: match.group(1).lower(),
        value,
        flags=re.I,
    )
    if language == "de":
        value = re.sub(r"(?<=\d)\.(?=\d)", ",", value)
    return value.strip() or None


def parse_open_facts_product(
    product: dict[str, Any], language: str
) -> dict[str, str | None] | None:
    """Normalize the small subset of Open Food Facts data used by the integration."""
    language = (language or "en").split("-", 1)[0].lower()
    name = (
        _clean_text(product.get(f"product_name_{language}"))
        or _clean_text(product.get("product_name_en"))
        or _clean_text(product.get("product_name"))
    )
    if not name:
        return None

    quantity = _clean_text(product.get("quantity"))
    if not quantity:
        amount = product.get("product_quantity")
        unit = _clean_text(product.get("product_quantity_unit"))
        if amount is not None and unit:
            quantity = f"{amount} {unit}"

    return {
        "name": name,
        "brand": _first_brand(product.get("brands")),
        "package_quantity": _format_quantity(quantity, language),
        "image_url": _clean_text(product.get("image_front_thumb_url")),
    }


async def async_lookup_open_facts(
    hass: HomeAssistant, ean: str
) -> dict[str, str | None] | None:
    """Look up one EAN through the universal Open Food Facts product endpoint."""
    language = (hass.config.language or "en").split("-", 1)[0].lower()
    fields = list(_FIELDS)
    localized_name = f"product_name_{language}"
    if localized_name not in fields:
        fields.append(localized_name)

    session = async_get_clientsession(hass)
    try:
        async with session.get(
            _API_URL.format(ean=ean),
            params={"product_type": "all", "fields": ",".join(fields)},
            headers={
                "Accept": "application/json",
                "User-Agent": f"ha-list-manager/{VERSION}",
            },
            timeout=aiohttp.ClientTimeout(total=12),
        ) as response:
            if response.status == 404:
                return None
            response.raise_for_status()
            payload = await response.json(content_type=None)
    except (TimeoutError, aiohttp.ClientError, ValueError) as error:
        raise OpenFactsLookupError from error

    if not isinstance(payload, dict):
        raise OpenFactsLookupError
    product = payload.get("product")
    if not isinstance(product, dict):
        return None
    return parse_open_facts_product(product, language)
