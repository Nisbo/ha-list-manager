"""Explain legacy import decisions without retaining configuration values.

The old option names are useful for review, but an omitted option does not mean
that its feature is unavailable. These reasons distinguish missing mappings,
different configuration locations and deliberately excluded data.
"""

from __future__ import annotations

import re
from collections.abc import Mapping


_SECRET_FIELD = re.compile(r"token|password|secret|credential|authorization|api_key", re.I)

_SETTING_REASONS = {
    "chip_click": ("appearance", "chip_actions"),
    "sub_text": ("appearance", "subtitle"),
    "chips_width": ("appearance", "chip_geometry"),
    "chip_font_size": ("appearance", "chip_geometry"),
    "title_font_size": ("appearance", "title_size"),
    "chip_merge": ("appearance", "chip_scopes"),
    "highlight_words": ("appearance", "important_chips"),
    "show_cat_popup": ("appearance", "category_dialog"),
    "show_export_button": ("excluded", "html_export"),
    "show_export_button_pdf": ("appearance", "pdf_export"),
    "show_message_button": ("appearance", "share_button"),
    "local_chips": ("excluded", "browser_chips"),
    "ean_database_entity": ("excluded", "ean_data"),
    "ean_file": ("excluded", "ean_data"),
    "ean_database_suggestions": ("appearance", "ean_display"),
    "show_ean_database_badge": ("appearance", "ean_display"),
    "show_ean_quantity": ("appearance", "product_quantity"),
    "ean_scanner_mac": ("backend", "scanner"),
    "ean_remove_mode": ("backend", "scanner_actions"),
    "inventory_default_action": ("appearance", "inventory_controls"),
    "inventory_mode_timeout": ("appearance", "inventory_controls"),
    "inventory_group_variants": ("inventory", "inventory_groups"),
    "allow_dynamic_categories": ("backend", "dynamic_categories"),
    "category_merge_mode": ("backend", "category_scopes"),
    "show_category_chips": ("appearance", "category_chips"),
    "capitalize_first_letter": ("appearance", "capitalization"),
    "categories.color": ("appearance", "category_text_color"),
    "own_css": ("appearance", "custom_styles"),
}

_CODE_REASONS = {
    "secret_discarded": ("security", "credentials"),
    "unsupported_mode": ("excluded", "unsupported_mode"),
    "inventory_simple": ("inventory", "inventory_simple"),
    "inventory_ean": ("inventory", "inventory_ean"),
    "ean_rules_omitted": ("inventory", "ean_rules_omitted"),
    "ean_category_conflict": ("review", "ean_category_conflict"),
    "inventory_merged": ("inventory", "inventory_merged"),
    "inventory_visibility_merged": ("review", "inventory_visibility"),
    "inventory_description_omitted": ("inventory", "inventory_description"),
}

_EXISTING_MESSAGES = {
    "default_mode": "adjusted",
    "missing_file": "review",
    "color_alpha": "review",
    "color_invalid": "review",
    "duplicate_category": "review",
    "category_conflict": "review",
    "duplicate_rule": "review",
    "rule_unsupported": "review",
    "duplicate_chip": "adjusted",
    "shared_source": "adjusted",
    "option_adjusted": "adjusted",
    "chip_metadata": "review",
    "numeric_suffix_preserved": "review",
}


def _reason(group: str, name: str) -> dict[str, str]:
    return {"group": group, "reason": name, "message_key": f"import.reason_{name}"}


def classify_import_warning(warning) -> dict[str, str]:
    """Return only fixed reason identifiers, never user-supplied option values."""
    if not isinstance(warning, Mapping):
        return _reason("review", "unknown_note")
    code = warning.get("code")
    field = warning.get("field")
    field = field if isinstance(field, str) else ""
    list_type = warning.get("list_type")
    if code == "secret_discarded" or _SECRET_FIELD.search(field):
        return _reason("security", "credentials")
    if code == "ignored_setting":
        if field in _SETTING_REASONS:
            return _reason(*_SETTING_REASONS[field])
        if field.startswith(("notify_", "ntfy_", "notification_", "smtp_")):
            return _reason("backend", "notifications")
        if field.startswith("list_script_"):
            return _reason("backend", "scripts")
        if field.startswith("ean_transfer_"):
            return _reason("excluded", "transfers")
        if field == "show_qrscan_button":
            return _reason("appearance", "camera_inventory" if list_type == "inventory" else "camera_other")
        if field == "show_input_mask":
            return _reason("appearance", "input_mask") if list_type != "todo" else _reason("unmapped", "unmapped")
        if field == "show_descriptions":
            return _reason("appearance", "descriptions") if list_type != "todo" else _reason("unmapped", "unmapped")
        if field == "category_display":
            return _reason("appearance", "category_display_inventory" if list_type == "inventory" else "category_display")
        return _reason("unmapped", "unmapped")
    if code == "option_adjusted" and field == "chips_position":
        return _reason("adjusted", "chip_position")
    if code == "option_adjusted" and field in {"list_font_size", "item_font_size"}:
        return _reason("adjusted", "font_range")
    if code == "default_mode" and list_type == "inventory":
        return _reason("adjusted", "inventory_selected")
    if isinstance(code, str) and code in _CODE_REASONS:
        return _reason(*_CODE_REASONS[code])
    if isinstance(code, str) and code in _EXISTING_MESSAGES:
        return {"group": _EXISTING_MESSAGES[code], "reason": code, "message_key": f"import.warning_{code}"}
    return _reason("review", "unknown_note")
