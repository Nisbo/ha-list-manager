"""Product lookup through the universal Open Food Facts API."""

from __future__ import annotations

from html import unescape
import re
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN, VERSION
from .localization import text
from .product_sources import normalize_product_api_url

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
    """A safe, localized failure without URLs, credentials or response bodies."""

    def __init__(self, reason="unavailable", *, custom=False):
        self.message = text(f"lookup.{reason}") if custom else text("errors.open_facts_unavailable")
        super().__init__(self.message)


class ProductLookup(dict):
    """Keep transport provenance separate from the persistent product fields."""

    lookup_source = "off"


def source_options(hass):
    runtime = getattr(hass, "data", {}).get(DOMAIN)
    return dict(getattr(getattr(runtime, "config_entry", None), "options", {}) or {})


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


async def _request_product(hass, ean, options, *, probe=False):
    language = (hass.config.language or "en").split("-", 1)[0].lower()
    custom = options.get("product_data_source", "off") == "custom"
    try:
        base = normalize_product_api_url(options.get("product_api_url")) if custom else None
    except ValueError as error:
        raise OpenFactsLookupError("invalid_url", custom=True) from error
    if custom and not base:
        raise OpenFactsLookupError("invalid_url", custom=True)
    url = f"{base}/api/v3/product/{ean}.json" if custom else _API_URL.format(ean=ean)
    fields = list(dict.fromkeys((*_FIELDS, f"product_name_{language}")))
    headers = {"Accept": "application/json", "User-Agent": f"ha-list-manager/{VERSION}"}
    if custom and options.get("product_api_key"):
        headers["Authorization"] = "Bearer " + options["product_api_key"]
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            url, params={"product_type": "all", "fields": ",".join(fields), "lc": language},
            headers=headers, timeout=aiohttp.ClientTimeout(total=12),
            allow_redirects=not custom,
        ) as response:
            if response.status in {401, 403}:
                raise OpenFactsLookupError("auth_failed", custom=custom)
            if 300 <= response.status < 400:
                raise OpenFactsLookupError("invalid_response", custom=custom)
            if response.status == 404 and not (custom or probe):
                return None
            if response.status != 404:
                response.raise_for_status()
            payload = await response.json(content_type=None)
    except OpenFactsLookupError:
        raise
    except (TimeoutError, aiohttp.ClientError) as error:
        raise OpenFactsLookupError(custom=custom) from error
    except ValueError as error:
        raise OpenFactsLookupError("invalid_response", custom=custom) from error
    if not isinstance(payload, dict):
        raise OpenFactsLookupError("invalid_response", custom=custom)
    result = payload.get("result")
    if (payload.get("status") == "failure" and isinstance(result, dict)
            and result.get("id") == "product_not_found"):
        return None
    if response.status == 404:
        raise OpenFactsLookupError("invalid_response", custom=custom)
    product = payload.get("product")
    if not isinstance(product, dict):
        if custom:
            raise OpenFactsLookupError("invalid_response", custom=True)
        return None
    parsed = parse_open_facts_product(product, language)
    if parsed is None:
        return None
    result = ProductLookup(parsed)
    result.lookup_source = "custom" if custom else "off"
    return result


async def async_lookup_open_facts(hass: HomeAssistant, ean: str, *, options=None, probe=False):
    """Use one configured OFF-v3 source for every card and scanner lookup."""
    selected = source_options(hass) if options is None else dict(options)
    custom = selected.get("product_data_source", "off") == "custom"
    try:
        result = await _request_product(hass, ean, selected, probe=probe)
    except OpenFactsLookupError:
        if not custom or probe or not selected.get("product_fallback_error", False):
            raise
    else:
        if result is not None or not custom or probe or not selected.get("product_fallback_missing", False):
            return result
    # Construct fresh headers for OFF. A private server's key never follows a fallback.
    return await _request_product(hass, ean, {"product_data_source": "off"})
