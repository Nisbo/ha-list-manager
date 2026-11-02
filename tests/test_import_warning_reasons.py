"""Import explanations distinguish feature availability from omitted mappings."""

import importlib.util
import json
from pathlib import Path
import re

import pytest


BASE = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"
SPEC = importlib.util.spec_from_file_location("import_warning_reasons_test", BASE / "legacy_import_warnings.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
classify = MODULE.classify_import_warning


@pytest.mark.parametrize("field,group,reason", [
    ("notify_entity", "backend", "notifications"),
    ("notify_entity_smtp", "backend", "notifications"),
    ("notify_on_change_time", "backend", "notifications"),
    ("ntfy_format", "backend", "notifications"),
    ("list_script_entity", "backend", "scripts"),
    ("list_script_enabled", "backend", "scripts"),
    ("ean_scanner_mac", "backend", "scanner"),
    ("ean_database_entity", "excluded", "ean_data"),
    ("ean_transfer_target_entity", "excluded", "transfers"),
    ("local_chips", "excluded", "browser_chips"),
    ("show_export_button", "excluded", "html_export"),
    ("show_export_button_pdf", "appearance", "pdf_export"),
    ("show_category_chips", "appearance", "category_chips"),
    ("show_cat_popup", "appearance", "category_dialog"),
    ("highlight_words", "appearance", "important_chips"),
    ("chip_font_size", "appearance", "chip_geometry"),
    ("chip_click", "appearance", "chip_actions"),
    ("category_merge_mode", "backend", "category_scopes"),
    ("allow_dynamic_categories", "backend", "dynamic_categories"),
])
def test_known_omissions_explain_the_specific_reason(field, group, reason):
    assert classify({"code": "ignored_setting", "field": field}) == {
        "group": group, "reason": reason, "message_key": "import.reason_" + reason,
    }


def test_related_notification_and_script_settings_share_one_explanation():
    notes = [classify({"code": "ignored_setting", "field": field}) for field in (
        "notify_entity", "notify_on_change", "notify_on_change_all", "notify_on_change_time", "notify_entity_smtp",
    )]
    assert len({note["message_key"] for note in notes}) == 1
    assert notes[0]["group"] == "backend"
    assert classify({"code": "ignored_setting", "field": "list_script_entity"}) != notes[0]


@pytest.mark.parametrize("list_type,reason", [
    ("inventory", "camera_inventory"), ("shopping", "camera_other"), ("todo", "camera_other"),
])
def test_camera_explanation_distinguishes_the_actual_inventory_camera_option(list_type, reason):
    note = classify({"code": "ignored_setting", "field": "show_qrscan_button", "list_type": list_type})
    assert note["reason"] == reason


@pytest.mark.parametrize("field", ["show_input_mask", "show_descriptions"])
def test_existing_todo_switch_is_not_mislabeled_as_a_missing_feature(field):
    assert classify({"code": "ignored_setting", "field": field, "list_type": "todo"})["group"] == "unmapped"
    assert classify({"code": "ignored_setting", "field": field, "list_type": "shopping"})["group"] == "appearance"


def test_default_shopping_detection_is_not_repeated_after_explicit_inventory_selection():
    note = classify({"code": "default_mode", "list_type": "inventory"})
    assert note["message_key"] == "import.reason_inventory_selected"
    assert classify({"code": "default_mode", "list_type": "shopping"})["message_key"] == "import.warning_default_mode"


@pytest.mark.parametrize("warning", [
    {"code": "ignored_setting", "field": "notify_api_token", "value": "FAKE_PRIVATE_VALUE"},
    {"code": "secret_discarded", "field": "longlived_token", "source": "FAKE_PRIVATE_VALUE"},
    {"code": "ignored_setting", "field": "private_password", "message": "FAKE_PRIVATE_VALUE"},
])
def test_credentials_get_a_fixed_security_reason_without_any_values(warning):
    note = classify(warning)
    assert note == {"group": "security", "reason": "credentials", "message_key": "import.reason_credentials"}
    assert "FAKE_PRIVATE_VALUE" not in json.dumps(note)


@pytest.mark.parametrize("warning", [None, [], {"code": ["not-a-code"]}, {"code": "FAKE_PRIVATE_VALUE"}])
def test_unknown_notes_do_not_construct_translation_keys_from_untrusted_values(warning):
    assert classify(warning) == {"group": "review", "reason": "unknown_note", "message_key": "import.reason_unknown_note"}


def test_unknown_setting_does_not_claim_deprecation_or_technical_impossibility():
    assert classify({"code": "ignored_setting", "field": "new_unknown_option"}) == {
        "group": "unmapped", "reason": "unmapped", "message_key": "import.reason_unmapped",
    }


@pytest.mark.parametrize("code,group,reason", [
    ("inventory_simple", "inventory", "inventory_simple"),
    ("inventory_merged", "inventory", "inventory_merged"),
    ("inventory_visibility_merged", "review", "inventory_visibility"),
    ("inventory_description_omitted", "inventory", "inventory_description"),
])
def test_simplified_inventory_notices_explain_the_deliberate_losses(code, group, reason):
    assert classify({"code": code}) == {
        "group": group, "reason": reason, "message_key": "import.reason_" + reason,
    }


def test_font_adjustment_and_automatic_chip_layout_have_different_reasons():
    assert classify({"code": "option_adjusted", "field": "chips_position"})["reason"] == "chip_position"
    assert classify({"code": "option_adjusted", "field": "list_font_size"})["reason"] == "font_range"


def test_explanations_match_the_features_actually_exposed_by_current_cards():
    sources = {name: (BASE / "frontend" / f"ha-list-manager-{name}-card.js").read_text()
               for name in ("inventory", "shopping", "todo")}
    for source in sources.values():
        assert 'name: "show_pdf_export_button"' in source
    assert 'name: "show_camera_scan_button"' in sources["inventory"]
    assert 'name: "show_camera_scan_button"' not in sources["shopping"]
    assert 'name: "show_camera_scan_button"' not in sources["todo"]
    assert 'name: "show_input_mask"' in sources["todo"]
    assert 'name: "show_descriptions"' in sources["todo"]
    assert 'name: "show_input_mask"' not in sources["shopping"]
    assert 'name: "show_descriptions"' not in sources["shopping"]
    assert 'name: "category_chip_layout"' in sources["shopping"]
    assert 'name: "add_dialog_behavior"' in sources["shopping"]


def test_native_catalogs_cover_every_classified_reason_with_matching_placeholders():
    samples = [{"code": "ignored_setting", "field": field, "list_type": list_type}
               for field in (*MODULE._SETTING_REASONS, "notify_entity", "list_script_entity",
                             "ean_transfer_entity", "show_qrscan_button", "show_input_mask",
                             "show_descriptions", "category_display", "unknown_option")
               for list_type in ("inventory", "shopping", "todo")]
    samples += [{"code": code} for code in (*MODULE._CODE_REASONS, *MODULE._EXISTING_MESSAGES)]
    samples += [{"code": "default_mode", "list_type": "inventory"},
                {"code": "option_adjusted", "field": "chips_position"},
                {"code": "option_adjusted", "field": "list_font_size"},
                {"code": "unknown_code"}]
    catalogs = {language: json.loads((BASE / "translations" / f"{language}.json").read_text())["common"]
                for language in ("de", "en")}
    for key in {classify(warning)["message_key"].replace(".", "_") for warning in samples}:
        de, en = (catalogs[language][key] for language in ("de", "en"))
        assert sorted(re.findall(r"\{(\w+)\}", de)) == sorted(re.findall(r"\{(\w+)\}", en)), key
