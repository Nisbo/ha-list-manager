"""Malformed external responses must fail safely instead of looking empty."""
import asyncio
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _http_module(monkeypatch, name, payload, status=200):
    aiohttp = ModuleType("aiohttp")
    aiohttp.ClientError = type("ClientError", (Exception,), {})
    aiohttp.ClientResponseError = type("ClientResponseError", (aiohttp.ClientError,), {})
    aiohttp.ClientTimeout = lambda **_kwargs: None
    core = ModuleType("homeassistant.core")
    core.HomeAssistant = object
    helpers = ModuleType("homeassistant.helpers.aiohttp_client")

    class Response:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def raise_for_status(self):
            return None

        async def json(self, **_kwargs):
            return payload

    response = Response()
    response.status = status
    helpers.async_get_clientsession = lambda _hass: SimpleNamespace(get=lambda *_args, **_kwargs: response)
    for key, value in {"aiohttp": aiohttp, "homeassistant.core": core,
                       "homeassistant.helpers.aiohttp_client": helpers}.items():
        monkeypatch.setitem(sys.modules, key, value)
    package = ModuleType("external_response_test")
    package.__path__ = [str(INTEGRATION)]
    monkeypatch.setitem(sys.modules, package.__name__, package)
    specification = spec_from_file_location(f"{package.__name__}.{name}", INTEGRATION / f"{name}.py")
    module = module_from_spec(specification)
    monkeypatch.setitem(sys.modules, specification.name, module)
    specification.loader.exec_module(module)
    return module


@pytest.mark.parametrize("payload", [None, [], ["product"], 1, "unknown"])
def test_off_non_object_json_uses_the_existing_lookup_error(monkeypatch, payload):
    module = _http_module(monkeypatch, "open_facts", payload)
    hass = SimpleNamespace(config=SimpleNamespace(language="en"))
    with pytest.raises(module.OpenFactsLookupError):
        asyncio.run(module.async_lookup_open_facts(hass, "4062139025398"))


@pytest.mark.parametrize("payload", [{}, {"product": None}, {"product": {}}, {"product": []}])
def test_off_unknown_products_remain_not_found(monkeypatch, payload):
    module = _http_module(monkeypatch, "open_facts", payload)
    hass = SimpleNamespace(config=SimpleNamespace(language="en"))
    assert asyncio.run(module.async_lookup_open_facts(hass, "4062139025398")) is None


@pytest.mark.parametrize("ean, product, expected", [
    ("4062139025398", {"product_name_de": "Pepsi Lemon Zero", "brands": "Pepsi", "quantity": "1.25l"},
     {"name": "Pepsi Lemon Zero", "brand": "Pepsi", "package_quantity": "1,25 l", "image_url": None}),
    ("8715700117140", {"product_name_de": "Zero Tomaten Ketchup", "brands": "Heinz", "quantity": "425g"},
     {"name": "Zero Tomaten Ketchup", "brand": "Heinz", "package_quantity": "425 g", "image_url": None}),
])
def test_off_cached_http_fixtures_preserve_known_products(monkeypatch, ean, product, expected):
    module = _http_module(monkeypatch, "open_facts", {"product": product})
    hass = SimpleNamespace(config=SimpleNamespace(language="de"))
    assert asyncio.run(module.async_lookup_open_facts(hass, ean)) == expected


@pytest.mark.parametrize("payload", [None, [], 1, "recipes"])
def test_tandoor_non_object_json_raises_localized_error(monkeypatch, payload):
    module = _http_module(monkeypatch, "tandoor", payload)
    client = module.TandoorClient(SimpleNamespace(), "https://recipes.example", "test-token")
    with pytest.raises(module.TandoorError, match="ungültige Antwort"):
        asyncio.run(client.async_test())


def test_tandoor_valid_empty_search_remains_empty(monkeypatch):
    module = _http_module(monkeypatch, "tandoor", {"results": [], "count": 0})
    client = module.TandoorClient(SimpleNamespace(), "https://recipes.example", "test-token")
    assert asyncio.run(client.async_search("", include_ingredients=False)) == []


@pytest.mark.parametrize("language, category, recipe", [("en", "Category", "Recipe"), ("de", "Kategorie", "Rezept")])
def test_tandoor_missing_names_use_native_user_language(monkeypatch, language, category, recipe):
    module = _http_module(monkeypatch, "tandoor", {"id": 1, "results": [{"id": 1}]})
    localization = sys.modules[module.localized_text.__module__]
    client = module.TandoorClient(SimpleNamespace(), "https://recipes.example", "test-token")
    async def scenario():
        with localization.use_language(language):
            assert (await client.async_categories())[0]["name"] == category
            assert (await client.async_recipe(1))["name"] == recipe
    asyncio.run(scenario())


def _bring_module(monkeypatch):
    core = ModuleType("homeassistant.core")
    core.Event = core.HomeAssistant = object
    core.callback = lambda handler: handler
    exceptions = ModuleType("homeassistant.exceptions")
    exceptions.HomeAssistantError = RuntimeError
    registry = ModuleType("homeassistant.helpers.entity_registry")
    for key, value in {"homeassistant.core": core, "homeassistant.exceptions": exceptions,
                       "homeassistant.helpers.entity_registry": registry}.items():
        monkeypatch.setitem(sys.modules, key, value)
    package = ModuleType("bring_response_test")
    package.__path__ = [str(INTEGRATION)]
    monkeypatch.setitem(sys.modules, package.__name__, package)
    specification = spec_from_file_location(f"{package.__name__}.external_lists", INTEGRATION / "external_lists.py")
    module = module_from_spec(specification)
    monkeypatch.setitem(sys.modules, specification.name, module)
    specification.loader.exec_module(module)
    return module


@pytest.mark.parametrize("payload", [None, {}, {"todo.bring": {}}, {"todo.bring": {"items": None}},
    {"todo.bring": {"items": [None]}}, {"todo.bring": {"items": [{"summary": "Milk"}]}}])
def test_bring_invalid_response_never_reconciles_existing_local_items(monkeypatch, payload):
    module = _bring_module(monkeypatch)
    class Database:
        async def async_get_list(self, _list_id):
            return SimpleNamespace(id="list", provider="bring", external_entity_id="todo.bring")
        async def async_mark_external_sync_attempt(self, _list_id):
            pass
        async def async_mark_external_sync_error(self, _list_id, _message):
            pass
    async def call(*_args, **_kwargs):
        return payload
    manager = module.ExternalListManager(SimpleNamespace(services=SimpleNamespace(async_call=call)), Database())
    reconciled = []
    async def reconcile(*args):
        reconciled.append(args)
    manager._reconcile = reconcile
    with pytest.raises(module.ExternalListError):
        asyncio.run(manager.async_sync("list", refresh_source=False))
    assert reconciled == [], "An unavailable response must never be mistaken for an empty list"


@pytest.mark.parametrize("payload", [{"items": []}, {"todo.bring": {"items": []}}])
def test_bring_explicit_empty_results_remain_valid(monkeypatch, payload):
    module = _bring_module(monkeypatch)
    assert module.ExternalListManager._response_items(payload, "todo.bring") == []
