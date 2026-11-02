"""Regression tests for the optional Tandoor list capability."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types


import runpy as _localization_runpy
_localized_source = _localization_runpy.run_path(str(Path(__file__).with_name('localization_source.py')))['localized_source']

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _database_module():
    package_name = "ha_list_manager_tandoor_test"
    package = types.ModuleType(package_name)
    package.__path__ = [str(INTEGRATION)]
    sys.modules[package_name] = package
    for module_name in ("const", "models", "database"):
        qualified_name = f"{package_name}.{module_name}"
        specification = importlib.util.spec_from_file_location(
            qualified_name, INTEGRATION / f"{module_name}.py"
        )
        module = importlib.util.module_from_spec(specification)
        sys.modules[qualified_name] = module
        assert specification.loader is not None
        specification.loader.exec_module(module)
    return sys.modules[f"{package_name}.database"]


def _client_module():
    """Load the client without requiring a full Home Assistant test runtime."""
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.ClientError = type("ClientError", (Exception,), {})
    aiohttp.ClientResponseError = type("ClientResponseError", (aiohttp.ClientError,), {})
    aiohttp.ClientTimeout = type("ClientTimeout", (), {"__init__": lambda self, **kwargs: None})
    homeassistant = types.ModuleType("homeassistant")
    core = types.ModuleType("homeassistant.core")
    core.HomeAssistant = object
    helpers = types.ModuleType("homeassistant.helpers")
    aiohttp_client = types.ModuleType("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda hass: None
    sys.modules["aiohttp"] = aiohttp
    sys.modules["homeassistant"] = homeassistant
    sys.modules["homeassistant.core"] = core
    sys.modules["homeassistant.helpers"] = helpers
    sys.modules["homeassistant.helpers.aiohttp_client"] = aiohttp_client
    package_name = "ha_list_manager_tandoor_client_test"
    package = types.ModuleType(package_name)
    package.__path__ = [str(INTEGRATION)]
    sys.modules[package_name] = package
    specification = importlib.util.spec_from_file_location(
        f"{package_name}.tandoor", INTEGRATION / "tandoor.py"
    )
    module = importlib.util.module_from_spec(specification)
    assert specification.loader is not None
    specification.loader.exec_module(module)
    return module


def test_tandoor_can_only_be_enabled_for_local_shopping_lists() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase.__new__(module.HaListManagerDatabase)
        database.path = Path(directory) / "shopping.db"
        database._initialize()
        shopping = database._create_list(
            "Einkauf", "shopping", None, "local", None, "specific",
            True, True, True, True, True, True, True, False, True,
        )
        inventory = database._create_list(
            "Inventar", "inventory", None, "local", None, "specific",
            True, True, True, True, True, True, True, False, True,
        )
        assert shopping.use_tandoor is True
        assert inventory.use_tandoor is False


def test_recipe_search_starts_with_cookbooks_and_optional_ingredient_search() -> None:
    shopping_card = _localized_source(INTEGRATION / "frontend" / "ha-list-manager-shopping-card.js")
    websocket = _localized_source(INTEGRATION / "websocket.py")
    client = _localized_source(INTEGRATION / "tandoor.py")

    assert 'data-tandoor-cookbook="${esc(category.id)}"' in shopping_card
    assert "data-tandoor-include-ingredients" in shopping_card
    assert "Zutaten durchsuchen" in shopping_card
    assert "data-tandoor-all-recipes" in shopping_card
    assert "data-tandoor-clear" in shopping_card
    assert 'haListManagerShoppingCardText("recipes.result_limit", {p0:(esc(dialog.resultLimit))}, this._hass)' in shopping_card
    assert "Tandoor-Kategorie (optional)" not in shopping_card
    assert 'probatio.Optional("include_ingredients", default=True): bool' in websocket
    assert '"/api/ingredient/", params={"page_size": 100}' in client
    assert "limit=record.tandoor_result_limit" in websocket
    assert "_get_cached" in client
    assert "asyncio.gather" in client
    assert 'title="Zurück zur Rezeptauswahl"' in shopping_card
    assert 'querySelectorAll("[data-tandoor-back]")' in shopping_card
    assert "_renderTandoorRecipePreservingScroll" in shopping_card
    assert "tandoor_skip_small_units" in shopping_card
    assert "Kleine Rezeptmengen standardmäßig nicht vorauswählen" in _localized_source(INTEGRATION / "frontend" / "ha-list-manager-panel.js")
    assert "data-tandoor-select-all" in shopping_card
    assert "data-tandoor-select-none" in shopping_card
    assert "data-tandoor-skip-small-units" in shopping_card
    assert "tandoor_include_ingredients" in shopping_card
    assert "tandoor_excluded_units" in shopping_card
    assert "tandoor_result_limit" in shopping_card
    assert "tandoor-recipe-small-units" in shopping_card
    assert 'data-tandoor-recipe-tab="ingredients"' in shopping_card
    assert 'data-tandoor-recipe-tab="preparation"' in shopping_card
    assert "tandoor-steps" in shopping_card
    assert "data-tandoor-category-search" in shopping_card
    assert "_configureTandoorCategorySelectors" in shopping_card
    assert "ingredientCategories" in shopping_card
    assert "category_id: matchedCategory && !matchedCategory.dynamic" in shopping_card
    assert '"steps": steps' in client
    assert "_plain_tandoor_text" in client


def test_private_tandoor_images_are_relayed_without_exposing_the_api_token() -> None:
    websocket = _localized_source(INTEGRATION / "websocket.py")
    client = _localized_source(INTEGRATION / "tandoor.py")
    image_view = _localized_source(INTEGRATION / "tandoor_image.py")

    assert "_relay_tandoor_image" in websocket
    assert "runtime.tandoor_image_token" in websocket
    assert "async_recipe_image" in client
    assert 'image.netloc != base.netloc' in client
    assert 'content_type.startswith("image/")' in client
    assert "10 * 1024 * 1024" in client
    assert "requires_auth = False" in image_view
    assert "secrets.compare_digest" in image_view
    assert "Authorization" not in image_view


def test_tandoor_instructions_are_converted_to_safe_readable_text() -> None:
    module = _client_module()
    assert module._plain_tandoor_text(
        "<p>Ofen &amp; Pfanne</p><ol><li>Mischen</li><li>Servieren</li></ol>"
    ) == "Ofen & Pfanne\nMischen\nServieren"
