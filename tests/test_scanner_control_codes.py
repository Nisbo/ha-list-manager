"""Regression tests for backend-owned inventory control QR codes."""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sys
import types


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _scanner_module():
    package_name = "ha_list_manager_scanner_control_test"
    package = types.ModuleType(package_name)
    package.__path__ = [str(INTEGRATION)]
    sys.modules[package_name] = package

    homeassistant = types.ModuleType("homeassistant")
    config_entries = types.ModuleType("homeassistant.config_entries")
    config_entries.ConfigEntry = object
    core = types.ModuleType("homeassistant.core")
    core.Event = object
    core.HomeAssistant = object
    core.callback = lambda function: function
    sys.modules.update({
        "homeassistant": homeassistant,
        "homeassistant.config_entries": config_entries,
        "homeassistant.core": core,
    })

    constants = types.ModuleType(f"{package_name}.const")
    constants.EVENT_INVENTORY_CHANGED = "inventory_changed"
    constants.EVENT_ITEMS_CHANGED = "ha_list_manager_items_changed"
    constants.EVENT_SCAN_PROCESSED = "scan_processed"
    constants.EVENT_SCANNER_TARGET_CHANGED = "scanner_target_changed"
    constants.SCANNER_ACTIONS = {"add", "remove", "register", "correct"}
    database = types.ModuleType(f"{package_name}.database")
    for name in (
        "DuplicateEANError", "DuplicateInventoryProductError",
        "InventoryListRequiredError", "ListNotFoundError",
    ):
        setattr(database, name, type(name, (Exception,), {}))
    database.HaListManagerDatabase = object
    models = types.ModuleType(f"{package_name}.models")
    models.ScanHistoryRecord = object
    models.ScannerRecord = object
    open_facts = types.ModuleType(f"{package_name}.open_facts")
    open_facts.OpenFactsLookupError = type("OpenFactsLookupError", (Exception,), {})

    async def _unused_lookup(*_args, **_kwargs):
        raise AssertionError("Control codes must not query Open Food Facts")

    open_facts.async_lookup_open_facts = _unused_lookup
    sys.modules.update({
        f"{package_name}.const": constants,
        f"{package_name}.database": database,
        f"{package_name}.models": models,
        f"{package_name}.open_facts": open_facts,
    })
    qualified_name = f"{package_name}.scanner"
    specification = importlib.util.spec_from_file_location(
        qualified_name, INTEGRATION / "scanner.py"
    )
    module = importlib.util.module_from_spec(specification)
    sys.modules[qualified_name] = module
    assert specification.loader is not None
    specification.loader.exec_module(module)
    return module


class _Target:
    def __init__(self, list_id: str, action: str) -> None:
        self.list_id = list_id
        self.action = action

    def as_dict(self):
        return {"list_id": self.list_id, "action": self.action}


class _History:
    def __init__(self, values) -> None:
        self.values = values

    def as_dict(self):
        return dict(self.values)


class _Database:
    def __init__(self, target: _Target | None = None) -> None:
        self.target = target
        self.set_calls = []

    async def async_list_scanners(self):
        return []

    async def async_get_scanner_by_address(self, _address):
        return None

    async def async_get_scanner_target(self):
        return self.target

    async def async_set_scanner_target(self, list_id, action):
        self.set_calls.append((list_id, action))
        self.target = _Target(list_id, action)
        return self.target

    async def async_add_scan_history(self, **values):
        return _History(values)


class _Bus:
    def __init__(self) -> None:
        self.events = []

    def async_fire(self, event, data):
        self.events.append((event, data))


def test_control_code_parser_supports_scoped_and_legacy_codes() -> None:
    module = _scanner_module()
    assert module.parse_inventory_control_code(
        "HA-LM:INVENTORY:pantry:ADD"
    ) == ("pantry", "add")
    assert module.parse_inventory_control_code(
        "ha-lm:inventory:REMOVE"
    ) == (None, "remove")
    assert module.parse_inventory_control_code("HA-LM:INVENTORY:pantry:UNKNOWN") is None
    assert module.parse_inventory_control_code("4062139025398") is None


def test_scoped_control_code_changes_target_without_product_lookup() -> None:
    module = _scanner_module()
    database = _Database(_Target("old-list", "remove"))
    hass = types.SimpleNamespace(bus=_Bus())
    manager = module.ScannerManager(
        hass, database, types.SimpleNamespace(options={})
    )
    result = asyncio.run(manager.async_process_scan(
        ean="HA-LM:INVENTORY:pantry:REGISTER", source="simulation"
    ))

    assert database.set_calls == [("pantry", "register")]
    assert result["control"] is True
    assert result["target"] == {"list_id": "pantry", "action": "register"}
    assert ("scanner_target_changed", result["target"]) in hass.bus.events


def test_legacy_control_code_uses_existing_target_list() -> None:
    module = _scanner_module()
    database = _Database(_Target("active-list", "add"))
    manager = module.ScannerManager(
        types.SimpleNamespace(bus=_Bus()), database,
        types.SimpleNamespace(options={}),
    )
    result = asyncio.run(manager.async_process_scan(
        ean="HA-LM:INVENTORY:CORRECT", source="simulation"
    ))

    assert database.set_calls == [("active-list", "correct")]
    assert result["history"]["status"] == "success"
