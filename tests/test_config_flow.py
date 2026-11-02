"""The actual setup flow must serialize through HA's native schema library."""
import asyncio
import importlib.util
from pathlib import Path
import sys
from types import ModuleType

import pytest


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def test_setup_form_uses_a_serializable_native_schema(monkeypatch):
    probatio = pytest.importorskip("probatio")

    class ConfigFlow:
        def __init_subclass__(cls, *, domain):
            cls.domain = domain

        def async_show_form(self, **kwargs):
            return {"type": "form", **kwargs}

        def async_create_entry(self, **kwargs):
            return {"type": "create_entry", **kwargs}

    homeassistant = ModuleType("homeassistant")
    entries = ModuleType("homeassistant.config_entries")
    entries.ConfigFlow = ConfigFlow
    entries.ConfigFlowResult = dict
    homeassistant.config_entries = entries
    package = ModuleType("audit_config_flow")
    package.__path__ = [str(INTEGRATION)]
    constants = ModuleType("audit_config_flow.const")
    constants.DOMAIN = "ha_list_manager"
    constants.INTEGRATION_NAME = "HA List Manager"
    for name, module in {
        "homeassistant": homeassistant,
        "homeassistant.config_entries": entries,
        "audit_config_flow": package,
        "audit_config_flow.const": constants,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    spec = importlib.util.spec_from_file_location(
        "audit_config_flow.config_flow", INTEGRATION / "config_flow.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    flow = module.HaListManagerConfigFlow()
    result = asyncio.run(flow.async_step_user())
    assert result["type"] == "form" and result["step_id"] == "user"
    assert probatio.to_field_list(result["data_schema"]) == []
    assert result["data_schema"]({}) == {}
    assert asyncio.run(flow.async_step_user({})) == {
        "type": "create_entry", "title": "HA List Manager", "data": {},
    }
