"""Bilingual catalog and generated-resource regression checks."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

import pytest

from native_translation_test_support import native_catalog

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"
CATALOGS = {language: native_catalog(language) for language in ("de", "en")}


def test_native_catalogs_replace_generated_frontend_build():
    source = (INTEGRATION / "localization.py").read_text()
    assert "async_get_translations" in source
    assert "async_get_cached_translations" in source
    assert "read_text" not in source
    assert "import json" not in source
    assert "_CATALOGS" not in source
    for language in ("de", "en"):
        catalog = json.loads((INTEGRATION / "translations" / f"{language}.json").read_text())
        assert {"common", "config_panel", "exceptions"} <= catalog.keys()


@pytest.mark.parametrize("language", ["de", "en"])
def test_backend_catalog_preserves_inserted_values_and_unicode(language):
    spec = importlib.util.spec_from_file_location("ha_list_manager_localization_test", INTEGRATION / "localization.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    messages = CATALOGS[language]["backend"]
    key = next(key for key, value in messages.items() if "{p0}" in value)
    template = messages[key]
    value = 'Milch {p1} „Bio“ <script>'
    actual = module.text(key, language=language, p0=value)
    assert value in actual
    assert actual == template.replace("{p0}", value)
    assert module.text("backend.scan_waiting_for_save", language=language) == messages["backend.scan_waiting_for_save"]


def test_backend_message_references_exist():
    for path in INTEGRATION.glob("*.py"):
        for key in re.findall(r'(?<![\w.])(?:german_text|localized_text|system_text|text)\(\s*["\']([^"\']+)["\'](?=\s*[,\)])', path.read_text()):
            for language, catalog in CATALOGS.items():
                assert key in catalog["backend"], (path.name, language, key)


def test_static_source_inspections_preserve_interpolated_calls(tmp_path):
    spec = importlib.util.spec_from_file_location("localization_source_test", Path(__file__).with_name("localization_source.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source_path = tmp_path / "card.js"
    for context in ("this._hass", "hass", "undefined", "language"):
        source_path.write_text('${haListManagerTestText("ui.cancel", {}, ' + context + ')}')
        assert module.localized_source(source_path) == CATALOGS["de"]["frontend"]["ui.cancel"]
    dynamic = 'haListManagerTestText("ui.cancel", {p0: user.name}, this._hass)'
    source_path.write_text(dynamic)
    assert module.localized_source(source_path).splitlines()[0] == dynamic
