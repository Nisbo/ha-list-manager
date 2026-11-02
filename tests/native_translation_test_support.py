"""Native catalog fixtures for isolated tests without a Home Assistant install.

Production never uses this loader. The transport test doubles below stand in
for HA's bootstrap-preloaded translation service; tests exercise the production
adapter and real catalog contents rather than the removed generated bundles.
"""
from functools import lru_cache
import json
from pathlib import Path
import sys
from types import ModuleType

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def flatten(data, prefix=""):
    result = {}
    for key, value in data.items():
        if isinstance(value, dict):
            result.update(flatten(value, f"{prefix}{key}."))
        else:
            result[f"{prefix}{key}"] = value
    return result


@lru_cache
def native_catalog(language):
    catalog = json.loads((INTEGRATION / "translations" / f"{language}.json").read_text(encoding="utf-8"))
    return {
        "frontend": flatten(catalog["config_panel"]),
        "backend": {key.replace("_", ".", 2 if key.startswith(("scripts_mode_", "scripts_event_")) else 1): value for key, value in catalog["common"].items()},
    }


@lru_cache
def resources(language, category, domain="ha_list_manager"):
    english = json.loads((INTEGRATION / "translations/en.json").read_text(encoding="utf-8"))
    result = flatten(english.get(category, {}), f"component.{domain}.{category}.")
    translated = INTEGRATION / "translations" / f"{language}.json"
    if language != "en" and translated.exists():
        catalog = json.loads(translated.read_text(encoding="utf-8"))
        result.update(flatten(catalog.get(category, {}), f"component.{domain}.{category}."))
    return result


def install_native_helpers():
    """Supply only the external HA translation service for isolated tests."""
    name = "homeassistant.helpers.translation"
    if name in sys.modules:
        return
    module = ModuleType(name)

    def async_get_cached_translations(hass, language, category, integration=None):
        return resources(language, category, integration or "ha_list_manager")

    async def async_get_translations(hass, language, category, integrations=None, config_flow=None):
        domain = next(iter(integrations)) if integrations else "ha_list_manager"
        return resources(language, category, domain)

    module.async_get_cached_translations = async_get_cached_translations
    module.async_get_translations = async_get_translations
    sys.modules[name] = module
