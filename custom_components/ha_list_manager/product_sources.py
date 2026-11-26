"""Validate and redact product-source settings without exposing credentials."""
from urllib.parse import urlsplit, urlunsplit

from .localization import text


def normalize_product_api_url(value):
    url = str(value or "").strip().rstrip("/")
    if not url:
        return None
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in {"http", "https"} and parsed.hostname
                 and parsed.username is None and parsed.password is None and not parsed.query
                 and not parsed.fragment and not any(c.isspace() for c in url))
        parsed.port  # Validate a malformed or out-of-range port before saving.
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(text("lookup.invalid_url"))
    return urlunsplit(parsed)


def product_source_settings(options, values):
    """Merge optional settings. Omission keeps a key; explicit null clears it."""
    result = dict(options)
    for key in ("product_data_source", "product_fallback_missing", "product_fallback_error"):
        if key in values:
            result[key] = values[key]
    if "product_api_url" in values:
        result["product_api_url"] = normalize_product_api_url(values["product_api_url"])
        if result["product_api_url"] != options.get("product_api_url"):
            result["product_api_key"] = ""  # Never send an old credential to a different server.
    if "product_api_key" in values:
        key = str(values["product_api_key"] or "").strip()
        if len(key) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in key):
            raise ValueError(text("lookup.invalid_key"))
        result["product_api_key"] = key
    if result.get("product_data_source", "off") == "custom" and not result.get("product_api_url"):
        raise ValueError(text("lookup.invalid_url"))
    return result


def public_source_settings(options):
    return {
        "product_data_source": options.get("product_data_source", "off"),
        "product_api_url": options.get("product_api_url"),
        "product_api_key_configured": bool(options.get("product_api_key")),
        "product_fallback_missing": bool(options.get("product_fallback_missing", False)),
        "product_fallback_error": bool(options.get("product_fallback_error", False)),
    }
