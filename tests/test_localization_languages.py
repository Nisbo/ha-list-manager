"""Language selection and catalog integrity without importing Home Assistant."""
import asyncio
from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

from native_translation_test_support import native_catalog


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _catalog(language):
    return native_catalog(language)


@pytest.fixture
def localization():
    # A fresh module keeps configured system language and ContextVars isolated.
    spec = importlib.util.spec_from_file_location("localization_language_test", INTEGRATION / "localization.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _probe():
    de, en = _catalog("de")["backend"], _catalog("en")["backend"]
    key = next(key for key in de if de[key] != en[key] and not PLACEHOLDER.search(de[key]))
    return key, de[key], en[key]


def _interpolate(template, values):
    return PLACEHOLDER.sub(lambda match: str(values[match[1]]) if match[1] in values else match[0], template)


def test_catalogs_have_matching_keys_placeholders_and_semantic_names():
    de, en = _catalog("de"), _catalog("en")
    assert de.keys() == en.keys()
    for section in de:
        assert de[section].keys() == en[section].keys(), section
        for key, german in de[section].items():
            english = en[section][key]
            assert isinstance(german, str) and isinstance(english, str), (section, key)
            assert german.strip() and english.strip(), (section, key)
            assert Counter(PLACEHOLDER.findall(german)) == Counter(PLACEHOLDER.findall(english)), (section, key)
            assert len(key) <= 55, (section, key)
            assert re.fullmatch(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+", key), (section, key)
            assert not re.search(r"_[0-9a-f]{6,}$", key), (section, key)
            assert not re.search(r"(?:^|[._])p\d+(?:[._]|$)", key), (section, key)


@pytest.mark.parametrize("language, expected_index", [
    ("de", 1), ("de-DE", 1), ("de-AT", 1),
    ("en", 2), ("en-GB", 2), ("fr-FR", 2), ("unsupported", 2),
])
def test_explicit_language_normalization(localization, language, expected_index):
    probe = _probe()
    assert localization.text(probe[0], language=language) == probe[expected_index]


def test_context_nests_resets_and_explicit_language_wins(localization):
    key, german, english = _probe()
    assert localization.text(key) == german
    with localization.use_language("en-GB"):
        assert localization.text(key) == english
        assert localization.text(key, language="de-DE") == german
        with localization.use_language("de-DE"):
            assert localization.text(key) == german
        assert localization.text(key) == english
    assert localization.text(key) == german
    with pytest.raises(RuntimeError):
        with localization.use_language("en"):
            raise RuntimeError("exercise context cleanup")
    assert localization.text(key) == german


def test_request_languages_are_isolated_between_async_tasks(localization):
    key, german, english = _probe()

    async def translate(language):
        with localization.use_language(language):
            await asyncio.sleep(0)
            return localization.text(key)

    async def both():
        return await asyncio.gather(translate("de-DE"), translate("en-GB"))

    assert asyncio.run(both()) == [german, english]
    assert localization.text(key) == german


def test_system_language_is_live_and_bypasses_request_context(localization):
    key, german, english = _probe()
    hass = SimpleNamespace(config=SimpleNamespace(language="en-GB"))
    asyncio.run(localization.configure(hass))
    assert localization.text(key) == english
    with localization.use_language("de-DE"):
        assert localization.text(key) == german
        assert localization.system_text(key) == english
    hass.config.language = "de-DE"
    assert localization.text(key) == german
    with localization.use_language("en"):
        assert localization.system_text(key) == german
    hass.config.language = "fr-FR"
    assert localization.system_text(key) == english


def test_all_backend_parameters_are_inserted_once_without_mutating_data(localization):
    user_data = {"name": "Zero Tomaten Ketchup", "category": "Getränke", "ean": "4062139025398"}
    before = dict(user_data)
    for language in ("de", "en"):
        for key, template in _catalog(language)["backend"].items():
            values = {name: f"Milk {{p0}} {{count}} <b>ä</b> {user_data['name']}" for name in PLACEHOLDER.findall(template)}
            snapshot = dict(values)
            assert localization.text(key, language=language, **values) == _interpolate(template, values), (language, key)
            assert values == snapshot
    assert user_data == before


def test_missing_parameters_remain_visible(localization):
    for language in ("de", "en"):
        key, template = next((key, value) for key, value in _catalog(language)["backend"].items() if PLACEHOLDER.search(value))
        assert localization.text(key, language=language) == template


def test_adapter_uses_native_loading_and_retains_native_resource_references(localization, monkeypatch):
    from native_translation_test_support import resources
    import threading

    main_thread = threading.get_ident()
    calls = []

    async def load(hass, language, category, integrations):
        assert threading.get_ident() == main_thread
        calls.append((language, category, integrations))
        return resources(language, category)

    def cached(hass, language, category, integration):
        assert threading.get_ident() == main_thread, "native callbacks must stay on the HA event loop"
        return resources(language, category)

    monkeypatch.setattr(localization, "async_get_translations", load)
    monkeypatch.setattr(localization, "async_get_cached_translations", cached)
    hass = SimpleNamespace(config=SimpleNamespace(language="en"))

    async def scenario():
        await localization.configure(hass)
        async with localization.async_use_language(hass, "de-DE"):
            assert localization._RESOURCES.get()[1] is resources("de", "common")
            assert localization._SYSTEM_RESOURCES.get()[1] is resources("en", "common")
            from contextvars import copy_context
            result = await asyncio.get_running_loop().run_in_executor(
                None, copy_context().run,
                lambda: (localization.text("backend.general"), localization.system_text("backend.general")),
            )
            assert result == ("Allgemein", "General")
        assert localization._RESOURCES.get() is None
        assert localization._SYSTEM_RESOURCES.get() is None

    asyncio.run(scenario())
    assert calls == [("en", "common", {"ha_list_manager"}),
                     ("en", "common", {"ha_list_manager"}),
                     ("de", "common", {"ha_list_manager"})]


def test_native_error_metadata_preserves_parameters_and_ordinary_messages(localization):
    from copy import deepcopy

    value = "Milk {maximum} & <script>"
    message = localization.text("errors.text_too_long", language="en", maximum=value)
    assert value in message
    metadata = localization.error_translation_metadata(ValueError(message))
    assert metadata == {
        "translation_domain": "ha_list_manager",
        "translation_key": "errors_text_too_long",
        "translation_placeholders": {"maximum": value},
    }
    assert localization.error_translation_metadata(deepcopy(message)) == metadata
    assert localization.error_translation_metadata(localization.text("backend.test_notification_sent")) == {}
    assert localization.error_translation_metadata(ValueError("Untranslated external failure")) == {}


def test_failed_native_context_setup_keeps_the_callers_language(localization, monkeypatch):
    """A missing native cache entry must not partially replace an outer request."""
    hass = SimpleNamespace(config=SimpleNamespace(language="de"))
    asyncio.run(localization.configure(hass))
    native_cached = localization.async_get_cached_translations

    with localization.use_language("de"):
        def unavailable_system_resources(hass, language, category, integration):
            if language == "de":
                raise RuntimeError("Native system resources unavailable")
            return native_cached(hass, language, category, integration)

        with monkeypatch.context() as patch:
            patch.setattr(localization, "async_get_cached_translations", unavailable_system_resources)
            with pytest.raises(RuntimeError, match="Native system resources unavailable"):
                with localization.use_language("en"):
                    pytest.fail("A context without resources must not open")

        assert localization.text("backend.general") == "Allgemein"
        assert localization.system_text("backend.general") == "Allgemein"
