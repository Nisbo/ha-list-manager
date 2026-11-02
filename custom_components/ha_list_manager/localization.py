"""Render messages from Home Assistant's translation resources.

Home Assistant owns catalog loading, fallback and caching. Contexts only retain
references to its resources so SQLite executor jobs never call event-loop APIs.
"""
from __future__ import annotations

from collections.abc import Mapping
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import Any

from homeassistant.helpers.translation import (
    async_get_cached_translations,
    async_get_translations,
)

_DOMAIN = "ha_list_manager"
_PREFIX = f"component.{_DOMAIN}.common."
_LANGUAGE: ContextVar[str | None] = ContextVar("ha_list_manager_language", default=None)
_RESOURCES: ContextVar[tuple[str, Mapping[str, str]] | None] = ContextVar(
    "ha_list_manager_translation_resources", default=None,
)
_SYSTEM_RESOURCES: ContextVar[tuple[str, Mapping[str, str]] | None] = ContextVar(
    "ha_list_manager_system_translation_resources", default=None,
)
_hass = None


class _PlaceholderValues(dict):
    """Let Python formatting preserve a missing value without parsing strings."""

    def __missing__(self, key):
        return "{" + key + "}"


class TranslatedText(str):
    """Keep native error translation metadata alongside an ordinary string."""

    def __new__(cls, value: str, key: str, placeholders: dict[str, Any]):
        result = super().__new__(cls, value)
        result.translation_key = key.replace(".", "_")
        result.translation_placeholders = {
            name: str(value) for name, value in placeholders.items()
        }
        return result

    def __getnewargs__(self):
        """Preserve metadata when dataclasses or callers copy a message."""
        return str(self), self.translation_key, self.translation_placeholders


def normalize_language(language: str | None) -> str:
    """Accept regional variants of the integration's existing UI languages."""
    return str(language or "en").lower().replace("_", "-").split("-", 1)[0]


async def configure(hass) -> None:
    """Load the system language before any integration managers start."""
    global _hass
    _hass = hass
    await async_prepare(hass)


def system_language() -> str:
    """Read the current HA setting, including later language changes."""
    return normalize_language(getattr(getattr(_hass, "config", None), "language", "de"))


async def async_prepare(hass, language: str | None = None) -> None:
    """Ask HA to load resources before entering synchronous rendering paths."""
    system = system_language()
    selected = normalize_language(language) if language else (_LANGUAGE.get() or system)
    await async_get_translations(hass, system, "common", {_DOMAIN})
    if selected != system:
        await async_get_translations(hass, selected, "common", {_DOMAIN})


@contextmanager
def use_language(language: str | None):
    """Bind preloaded HA resources for a request and its executor jobs."""
    system = system_language()
    selected = normalize_language(language) if language else (_LANGUAGE.get() or system)
    # Resolve both native lookups before changing the caller's context. If HA's
    # cache is unavailable, an outer request must retain its language/resources.
    resources = async_get_cached_translations(_hass, selected, "common", _DOMAIN)
    system_resources = async_get_cached_translations(_hass, system, "common", _DOMAIN)
    language_token = _LANGUAGE.set(selected)
    resources_token = _RESOURCES.set((selected, resources))
    system_token = _SYSTEM_RESOURCES.set((system, system_resources))
    try:
        yield
    finally:
        _SYSTEM_RESOURCES.reset(system_token)
        _RESOURCES.reset(resources_token)
        _LANGUAGE.reset(language_token)


@asynccontextmanager
async def async_use_language(hass, language: str | None = None):
    """Load and isolate a UI request without a private translation cache."""
    await async_prepare(hass, language)
    with use_language(language):
        yield


def text(key: str, *, language: str | None = None, **values: Any) -> str:
    """Render a native common resource, substituting user values only once."""
    selected = normalize_language(language) if language else (_LANGUAGE.get() or system_language())
    for bound in (_RESOURCES.get(), _SYSTEM_RESOURCES.get()):
        if bound is not None and bound[0] == selected:
            resources = bound[1]
            break
    else:
        resources = async_get_cached_translations(_hass, selected, "common", _DOMAIN)
    template = resources.get(f"{_PREFIX}{key.replace('.', '_')}", key)
    message = template.format_map(_PlaceholderValues(values))
    return TranslatedText(message, key, values)


def system_text(key: str, **values: Any) -> str:
    """Notifications and script messages follow HA's system language."""
    return text(key, language=system_language(), **values)


def error_translation_metadata(message: str | Exception) -> dict[str, Any]:
    """Preserve HA's native WS metadata while retaining existing error codes."""
    if isinstance(message, Exception) and len(message.args) == 1:
        message = message.args[0]
    if not isinstance(message, TranslatedText):
        return {}
    resources = async_get_cached_translations(_hass, "en", "exceptions", _DOMAIN)
    if f"component.{_DOMAIN}.exceptions.{message.translation_key}.message" not in resources:
        return {}
    return {
        "translation_domain": _DOMAIN,
        "translation_key": message.translation_key,
        "translation_placeholders": message.translation_placeholders,
    }
