"""Read-only conversion of the original card's supported list data.

Only whitelisted fields survive parsing.  In particular, the old export token,
notification destinations and scanner/transfer configuration are never retained.
The caller reads HA sources and owns preview expiration and authorization.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime
import hashlib
import json
from pathlib import PurePosixPath
import re
import unicodedata
from typing import Any
from urllib.parse import urlsplit

import yaml

MAX_YAML_BYTES = 256 * 1024
MAX_FILE_BYTES = 256 * 1024
MAX_CARDS = 20
MAX_CATEGORIES = 200
MAX_CHIPS = 2000
MAX_ITEMS = 20000
MAX_RULES = 10000
_ENTITY = re.compile(r"todo\.[a-z0-9_]+")
_ICON = re.compile(r"mdi:[a-z0-9-]+")
_OFFER = re.compile(r"\s*\[\[ISL:OFFER_ONLY\]\]\s*", re.I)
_INTERVAL = re.compile(r"\{\{\s*(\d+)\s*([HDM])\s*\}\}")

# Standard CSS named colors. Values are converted to the backend's RGB format.
_CSS_COLORS = {
    "aliceblue": "#f0f8ff",
    "antiquewhite": "#faebd7",
    "aqua": "#00ffff",
    "aquamarine": "#7fffd4",
    "azure": "#f0ffff",
    "beige": "#f5f5dc",
    "bisque": "#ffe4c4",
    "black": "#000000",
    "blanchedalmond": "#ffebcd",
    "blue": "#0000ff",
    "blueviolet": "#8a2be2",
    "brown": "#a52a2a",
    "burlywood": "#deb887",
    "cadetblue": "#5f9ea0",
    "chartreuse": "#7fff00",
    "chocolate": "#d2691e",
    "coral": "#ff7f50",
    "cornflowerblue": "#6495ed",
    "cornsilk": "#fff8dc",
    "crimson": "#dc143c",
    "cyan": "#00ffff",
    "darkblue": "#00008b",
    "darkcyan": "#008b8b",
    "darkgoldenrod": "#b8860b",
    "darkgray": "#a9a9a9",
    "darkgreen": "#006400",
    "darkgrey": "#a9a9a9",
    "darkkhaki": "#bdb76b",
    "darkmagenta": "#8b008b",
    "darkolivegreen": "#556b2f",
    "darkorange": "#ff8c00",
    "darkorchid": "#9932cc",
    "darkred": "#8b0000",
    "darksalmon": "#e9967a",
    "darkseagreen": "#8fbc8f",
    "darkslateblue": "#483d8b",
    "darkslategray": "#2f4f4f",
    "darkslategrey": "#2f4f4f",
    "darkturquoise": "#00ced1",
    "darkviolet": "#9400d3",
    "deeppink": "#ff1493",
    "deepskyblue": "#00bfff",
    "dimgray": "#696969",
    "dimgrey": "#696969",
    "dodgerblue": "#1e90ff",
    "firebrick": "#b22222",
    "floralwhite": "#fffaf0",
    "forestgreen": "#228b22",
    "fuchsia": "#ff00ff",
    "gainsboro": "#dcdcdc",
    "ghostwhite": "#f8f8ff",
    "gold": "#ffd700",
    "goldenrod": "#daa520",
    "gray": "#808080",
    "green": "#008000",
    "greenyellow": "#adff2f",
    "grey": "#808080",
    "honeydew": "#f0fff0",
    "hotpink": "#ff69b4",
    "indianred": "#cd5c5c",
    "indigo": "#4b0082",
    "ivory": "#fffff0",
    "khaki": "#f0e68c",
    "lavender": "#e6e6fa",
    "lavenderblush": "#fff0f5",
    "lawngreen": "#7cfc00",
    "lemonchiffon": "#fffacd",
    "lightblue": "#add8e6",
    "lightcoral": "#f08080",
    "lightcyan": "#e0ffff",
    "lightgoldenrodyellow": "#fafad2",
    "lightgray": "#d3d3d3",
    "lightgreen": "#90ee90",
    "lightgrey": "#d3d3d3",
    "lightpink": "#ffb6c1",
    "lightsalmon": "#ffa07a",
    "lightseagreen": "#20b2aa",
    "lightskyblue": "#87cefa",
    "lightslategray": "#778899",
    "lightslategrey": "#778899",
    "lightsteelblue": "#b0c4de",
    "lightyellow": "#ffffe0",
    "lime": "#00ff00",
    "limegreen": "#32cd32",
    "linen": "#faf0e6",
    "magenta": "#ff00ff",
    "maroon": "#800000",
    "mediumaquamarine": "#66cdaa",
    "mediumblue": "#0000cd",
    "mediumorchid": "#ba55d3",
    "mediumpurple": "#9370db",
    "mediumseagreen": "#3cb371",
    "mediumslateblue": "#7b68ee",
    "mediumspringgreen": "#00fa9a",
    "mediumturquoise": "#48d1cc",
    "mediumvioletred": "#c71585",
    "midnightblue": "#191970",
    "mintcream": "#f5fffa",
    "mistyrose": "#ffe4e1",
    "moccasin": "#ffe4b5",
    "navajowhite": "#ffdead",
    "navy": "#000080",
    "oldlace": "#fdf5e6",
    "olive": "#808000",
    "olivedrab": "#6b8e23",
    "orange": "#ffa500",
    "orangered": "#ff4500",
    "orchid": "#da70d6",
    "palegoldenrod": "#eee8aa",
    "palegreen": "#98fb98",
    "paleturquoise": "#afeeee",
    "palevioletred": "#db7093",
    "papayawhip": "#ffefd5",
    "peachpuff": "#ffdab9",
    "peru": "#cd853f",
    "pink": "#ffc0cb",
    "plum": "#dda0dd",
    "powderblue": "#b0e0e6",
    "purple": "#800080",
    "rebeccapurple": "#663399",
    "red": "#ff0000",
    "rosybrown": "#bc8f8f",
    "royalblue": "#4169e1",
    "saddlebrown": "#8b4513",
    "salmon": "#fa8072",
    "sandybrown": "#f4a460",
    "seagreen": "#2e8b57",
    "seashell": "#fff5ee",
    "sienna": "#a0522d",
    "silver": "#c0c0c0",
    "skyblue": "#87ceeb",
    "slateblue": "#6a5acd",
    "slategray": "#708090",
    "slategrey": "#708090",
    "snow": "#fffafa",
    "springgreen": "#00ff7f",
    "steelblue": "#4682b4",
    "tan": "#d2b48c",
    "teal": "#008080",
    "thistle": "#d8bfd8",
    "tomato": "#ff6347",
    "turquoise": "#40e0d0",
    "violet": "#ee82ee",
    "wheat": "#f5deb3",
    "white": "#ffffff",
    "whitesmoke": "#f5f5f5",
    "yellow": "#ffff00",
    "yellowgreen": "#9acd32",
}


class LegacyImportError(ValueError):
    """An import error with a native-translation key and safe parameters."""

    def __init__(self, code: str, **values: Any) -> None:
        super().__init__(code)
        self.code = code
        self.values = values
        self.translation_key = f"import.{code}"


class _Loader(yaml.SafeLoader):
    """Reject duplicate keys instead of silently importing a different config."""

    def construct_mapping(self, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in mapping:
                raise LegacyImportError("invalid_yaml", line=key_node.start_mark.line + 1)
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


def _text(value: Any, maximum: int, *, required: bool = False, code="invalid_config") -> str | None:
    if value is None:
        if required:
            raise LegacyImportError(code)
        return None
    if not isinstance(value, str) or len(value) > maximum:
        raise LegacyImportError(code)
    value = value.strip()
    if required and not value:
        raise LegacyImportError(code)
    return value or None


def _item_text(value, maximum, field, *, required=False):
    """Keep validation limits while identifying an invalid source field safely."""
    try:
        return _text(value, maximum, required=required, code="invalid_item")
    except LegacyImportError as error:
        error.values["field"] = field
        if isinstance(value, str) and len(value) > maximum:
            error.values.update(length=len(value), maximum=maximum)
        raise


def _warning(code: str, source: str | None = None, field: str | None = None, count: int | None = None):
    result = {"code": code}
    if source:
        result["source"] = source
    if field:
        result["field"] = field
    if count is not None:
        result["count"] = count
    return result


def _icon(value: Any) -> str | None:
    return value if isinstance(value, str) and len(value) <= 100 and _ICON.fullmatch(value) else None


def normalize_legacy_color(value: Any) -> tuple[str | None, str | None]:
    """Normalize CSS RGB colors, explicitly flagging unsupported transparency."""
    if value in (None, ""):
        return None, None
    if not isinstance(value, str) or len(value) > 80:
        return None, "color_invalid"
    color = value.strip().lower()
    if color == "transparent":
        return None, "color_alpha"
    color = _CSS_COLORS.get(color, color)
    if re.fullmatch(r"#[0-9a-f]{3,4}", color):
        color = "#" + "".join(char * 2 for char in color[1:])
    if re.fullmatch(r"#[0-9a-f]{8}", color):
        if color[-2:] != "ff":
            return None, "color_alpha"
        color = color[:7]
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        return None, "color_invalid"
    return color.upper(), None


def _color(value, warnings, source, field):
    color, code = normalize_legacy_color(value)
    if code:
        warnings.append(_warning(code, source, field))
    return color


def _file_text(reference, files, field, source, warnings):
    """Read only supplied file contents, never a path or URL on the HA host."""
    if not reference:
        return None
    if not isinstance(reference, str) or len(reference) > 2000:
        raise LegacyImportError("invalid_config")
    try:
        path = urlsplit(reference).path
    except ValueError:
        raise LegacyImportError("invalid_config") from None
    basename = PurePosixPath(path).name
    matches = [key for key in files if key == reference]
    if not matches:
        matches = [key for key in files if PurePosixPath(str(key)).name == basename]
    if len(matches) != 1:
        warnings.append(_warning("missing_file", source, field))
        return None
    content = files[matches[0]]
    if isinstance(content, dict):
        content = content.get("text")
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE_BYTES:
        raise LegacyImportError("invalid_config")
    return content


def _file_categories(text):
    categories = []
    for block in re.split(r"\n(?=\[)", text):
        match = re.match(r"\[([^\]\r\n]+)\]", block.strip())
        if not match:
            continue
        category = {"name": match.group(1).strip(), "items": []}
        for line in block.splitlines()[1:]:
            key, separator, value = line.partition("=")
            if separator and key.strip() in {"icon", "bgcolor", "color", "items"}:
                key = key.strip()
                category[key] = [item.strip() for item in value.split(",") if item.strip()] if key == "items" else value.strip()
        categories.append(category)
    return categories


def _categories(value, source, warnings):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_CATEGORIES:
        raise LegacyImportError("invalid_category")
    result = []
    seen = set()
    for row in value:
        if not isinstance(row, dict):
            raise LegacyImportError("invalid_category")
        name = _text(row.get("name"), 100, required=True, code="invalid_category")
        if name.casefold() in seen:
            warnings.append(_warning("duplicate_category", source, "categories"))
            continue
        seen.add(name.casefold())
        items = row.get("items", [])
        if items is None:
            items = []
        if not isinstance(items, list) or len(items) > MAX_RULES:
            raise LegacyImportError("invalid_category")
        rules = list(dict.fromkeys(_text(item, 200, required=True, code="invalid_category") for item in items))
        color = _color(row.get("bgcolor"), warnings, source, "categories.bgcolor")
        if row.get("color"):
            warnings.append(_warning("ignored_setting", source, "categories.color"))
        result.append({"name": name, "icon": _icon(row.get("icon")), "color": color, "rules": rules})
    return result


_BOOLEAN_OPTIONS = {
    "show_quantity_box", "show_quantity_one", "show_submit_button", "show_input_mask",
    "show_plus_minus", "show_descriptions", "show_title_info", "show_title_info_icon",
    "show_todo_filter_menu", "allow_filter", "allow_suggestions",
}
_TODO_OPTIONS = {"show_input_mask", "show_descriptions", "show_title_info", "show_title_info_icon", "show_todo_filter_menu", "sort_mode", "todo_filter"}
_SHOPPING_OPTIONS = {"show_quantity_box", "show_quantity_one", "show_plus_minus", "allow_suggestions"}
_INVENTORY_OPTIONS = {
    "show_quantity_box", "show_submit_button", "allow_filter", "allow_suggestions",
    "show_plus_minus", "quantity_position", "input_row_position", "option_row_position",
    "chips_position", "item_font_size", "filter_chips",
}
_SIMPLE_OPTIONS = {
    "acknowledged": {"show", "end", "hide"},
    "sort_mode": {"alpha", "manual", "none", "due"},
    "chips_position": {"auto", "bottom", "right"},
    "input_row_position": {"top", "bottom"},
    "option_row_position": {"top", "bottom"},
    "todo_filter": {"all", "today", "overdue", "overdue_include_today", "upcoming", "dated", "undated"},
}
_DATA_FIELDS = {"type", "entity", "mode", "title", "title_icon", "categories", "chips", "chip_file", "category_file"}


def _options(config, mode, source, warnings):
    result = {}
    consumed = set(_DATA_FIELDS)
    for key in _BOOLEAN_OPTIONS:
        if mode == "inventory" and key not in _INVENTORY_OPTIONS:
            continue
        if (mode == "shopping" and key in _TODO_OPTIONS) or (mode == "todo" and key in _SHOPPING_OPTIONS):
            continue
        if type(config.get(key)) is bool:
            result[key] = config[key]
            consumed.add(key)
    for key, allowed in _SIMPLE_OPTIONS.items():
        if mode == "inventory" and key not in _INVENTORY_OPTIONS:
            continue
        if mode == "shopping" and key in _TODO_OPTIONS:
            continue
        if key in config and isinstance(config[key], str) and config[key] in allowed:
            result[key] = config[key]
            consumed.add(key)
    if isinstance(config.get("quantity"), str) and config["quantity"] in {"beginning", "end"}:
        consumed.add("quantity")
        if mode in {"shopping", "inventory"}:
            result["quantity_position"] = config["quantity"]
    if config.get("chips_position") == "auto_panel":
        result["chips_position"] = "auto"
        consumed.add("chips_position")
        warnings.append(_warning("option_adjusted", source, "chips_position"))
    if isinstance(config.get("list_font_size"), (int, float)) and not isinstance(config["list_font_size"], bool) and 8 <= config["list_font_size"] <= 40:
        result["item_font_size"] = min(24, max(12, config["list_font_size"]))
        consumed.add("list_font_size")
        if result["item_font_size"] != config["list_font_size"]:
            warnings.append(_warning("option_adjusted", source, "list_font_size"))
    if type(config.get("allow_filter_chips")) is bool:
        result["filter_chips"] = config["allow_filter_chips"]
        consumed.add("allow_filter_chips")
    for key in config:
        if key in consumed:
            continue
        safe_key = key if re.fullmatch(r"[a-z_][a-z0-9_]{0,79}", key) else "other"
        secret = re.search(r"token|password|secret|credential|authorization|api_key", key, re.I)
        warnings.append(_warning("secret_discarded" if secret else "ignored_setting", source, safe_key))
    return result


def parse_legacy_configs(yaml_text: str, files: dict[str, Any] | None = None) -> dict[str, Any]:
    """Parse one card, a card list, or multiple YAML documents into safe specs."""
    if not isinstance(yaml_text, str) or len(yaml_text.encode("utf-8")) > MAX_YAML_BYTES:
        raise LegacyImportError("yaml_too_large")
    if files is None:
        files = {}
    if not isinstance(files, dict) or len(files) > 20:
        raise LegacyImportError("invalid_config")
    try:
        # Aliases can create cycles and expansion bombs even with SafeLoader.
        depth = 0
        for event in yaml.parse(yaml_text):
            if isinstance(event, yaml.events.AliasEvent):
                raise LegacyImportError("yaml_reference")
            if isinstance(event, (yaml.events.MappingStartEvent, yaml.events.SequenceStartEvent)):
                depth += 1
                if depth > 40:
                    raise LegacyImportError("invalid_config")
            elif isinstance(event, (yaml.events.MappingEndEvent, yaml.events.SequenceEndEvent)):
                depth -= 1
        documents = list(yaml.load_all(yaml_text, Loader=_Loader))
    except LegacyImportError:
        raise
    except (yaml.YAMLError, ValueError, RecursionError) as error:
        mark = getattr(error, "problem_mark", None)
        raise LegacyImportError("invalid_yaml", line=(mark.line + 1) if mark else 0) from None
    configs = []
    def collect(value, depth=0):
        if depth > 8:
            raise LegacyImportError("invalid_config")
        if isinstance(value, list):
            for row in value:
                collect(row, depth + 1)
        elif isinstance(value, dict):
            if isinstance(value.get("type"), str) and value["type"] in {"vertical-stack", "horizontal-stack", "grid"} and isinstance(value.get("cards"), list):
                collect(value["cards"], depth + 1)
            else:
                configs.append(value)
                if len(configs) > MAX_CARDS:
                    raise LegacyImportError("too_many_cards")
        elif value is not None:
            raise LegacyImportError("invalid_config")
    for document in documents:
        collect(document)
    if not configs:
        raise LegacyImportError("invalid_config")
    cards, warnings, excluded = [], [], set()
    for number, config in enumerate(configs, 1):
        source = f"card-{number}"
        if config.get("type") != "custom:ha-shopping-list-improved":
            raise LegacyImportError("unsupported_card")
        for field in ("ean_database_entity", "ean_transfer_entity"):
            value = config.get(field)
            if isinstance(value, str) and _ENTITY.fullmatch(value):
                excluded.add(value)
        mode = config.get("mode", "shopping")
        if not isinstance(mode, str) or mode not in {"shopping", "todo", "inventory"}:
            warnings.append(_warning("unsupported_mode", source, "mode"))
            continue
        own_warnings = []
        if "mode" not in config:
            own_warnings.append(_warning("default_mode", source, "mode"))
        entity = _text(config.get("entity"), 255)
        if entity is not None and not _ENTITY.fullmatch(entity):
            raise LegacyImportError("source_invalid")
        title = _text(config.get("title"), 200)
        name = title or (entity.partition(".")[2].replace("_", " ") if entity else None)
        categories = _categories(config.get("categories"), source, own_warnings)
        category_text = _file_text(config.get("category_file"), files, "category_file", source, own_warnings)
        if category_text is not None:
            categories.extend(_categories(_file_categories(category_text), source, own_warnings))
        chips = config.get("chips", [])
        if chips is None:
            chips = []
        if isinstance(chips, str):
            chips = [value.strip() for value in re.split(r"[,;]", chips) if value.strip()]
        if not isinstance(chips, list):
            raise LegacyImportError("invalid_chip")
        chip_text = _file_text(config.get("chip_file"), files, "chip_file", source, own_warnings)
        if chip_text is not None:
            chips.extend(value.strip() for value in chip_text.splitlines() if value.strip())
        if len(chips) > MAX_CHIPS:
            raise LegacyImportError("invalid_chip")
        chips = [_text(value, 200, required=True, code="invalid_chip") for value in chips]
        options = _options(config, mode, source, own_warnings)
        card = {"id": source, "source_entity": entity, "mode": mode, "title": title,
                "target_name": name, "icon": _icon(config.get("title_icon")),
                "ean_source_entity": config.get("ean_database_entity") if isinstance(config.get("ean_database_entity"), str) and _ENTITY.fullmatch(config["ean_database_entity"]) else None,
                "categories": categories, "chips": chips, "options": options,
                "warnings": own_warnings}
        cards.append(card)
        warnings.extend(own_warnings)
    if not cards:
        raise LegacyImportError("unsupported_mode")
    return {"cards": cards, "warnings": warnings, "excluded_sources": sorted(excluded)}


def _is_gtin(value: str) -> bool:
    """Recognize a GS1 check digit without looking up or importing EAN data."""
    if len(value) not in {8, 12, 13, 14} or not value.isascii() or not value.isdecimal():
        return False
    total = sum(int(digit) * (3 if index % 2 == 0 else 1)
                for index, digit in enumerate(reversed(value[:-1])))
    return (-total) % 10 == int(value[-1])


def _legacy_name(value: str, *, allow_zero: bool = False) -> dict[str, Any]:
    offer = bool(_OFFER.search(value))
    value = _OFFER.sub(" ", value).strip()
    sort_match = re.match(r"^\[\[(\d+)\]\]\s*", value)
    position = int(sort_match[1]) if sort_match else None
    value = re.sub(r"^\[\[\d+\]\]\s*", "", value).strip()
    category_match = re.match(r"^@(.+?)@\s*", value)
    category = category_match[1].strip() if category_match else None
    # The old card uses @none@ to opt out of both explicit and rule categories.
    uncategorized = bool(category and category.casefold() == "none")
    if uncategorized:
        category = None
    if category_match:
        value = value[category_match.end():]
    prefix_quantity = re.match(r"^(\d+)×\s*", value)
    suffix_quantity = re.search(r"\((\d+)\)$", value)
    # Old lists sometimes retain a barcode in parentheses. A checked GTIN that
    # cannot be a supported count stays literal, rather than losing source text.
    literal_suffix = bool(suffix_quantity and int(suffix_quantity[1]) > 1000000
                          and _is_gtin(suffix_quantity[1]))
    quantity_match = prefix_quantity or (None if literal_suffix else suffix_quantity)
    quantity = int(quantity_match[1]) if quantity_match else 1
    value = re.sub(r"^\d+×\s*", "", value)
    if not literal_suffix:
        value = re.sub(r"\s*\(\d+\)$", "", value)
    interval_match = _INTERVAL.search(value)
    interval = int(interval_match[1]) if interval_match else None
    unit = interval_match[2] if interval_match else None
    value = re.sub(r"\s*\{\{.*?\}\}\s*$", "", value).strip()
    _item_text(value, 200, "name", required=True)
    if not (0 if allow_zero else 1) <= quantity <= 1000000:
        raise LegacyImportError("invalid_item", field="quantity")
    if interval is not None and not 1 <= interval <= 1000000:
        raise LegacyImportError("invalid_item", field="recurrence_interval")
    if category and len(category) > 100:
        raise LegacyImportError("invalid_item", field="category", length=len(category), maximum=100)
    return {"name": value, "quantity": quantity, "category": category, "position": position,
            "recurrence_interval": interval, "recurrence_unit": unit, "offer_only": offer,
            "_uncategorized": uncategorized, "_numeric_suffix_preserved": literal_suffix}


def _due(value):
    if value in (None, ""):
        return None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if not isinstance(value, str) or len(value) > 64:
        raise LegacyImportError("invalid_item")
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return date.fromisoformat(value).isoformat()
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except ValueError:
        raise LegacyImportError("invalid_item") from None


def _is_excluded_metadata(description, *, allow_inventory=False):
    if not description or not description.lstrip().startswith("{"):
        return False
    try:
        data = json.loads(description)
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict) or data.get("schema") != 1:
        return False
    if "transferId" in data:
        return True
    if data.get("type") == "isl_inventory_variant":
        return not allow_inventory
    return "ean" in data and "name" in data


def _is_inventory_metadata(description):
    if not description:
        return False
    try:
        data = json.loads(description)
    except (ValueError, TypeError):
        return False
    return isinstance(data, dict) and data.get("schema") == 1 and data.get("type") == "isl_inventory_variant"


def _inventory_items(items, warnings, source):
    """Merge stock per selected product, retaining the generic-import fallback."""
    grouped = {}
    visibility_conflicts = 0
    for item in items:
        key = ("ean", item["product_ean"]) if item.get("product_ean") else (
            "name", " ".join(item["name"].split()).casefold(),
            " ".join((item["category"] or "").split()).casefold())
        if key not in grouped:
            grouped[key] = {**item, "stock": item["quantity"],
                            "hidden": item["completed"], "completed": False,
                            "merged_count": 1, "_hidden_count": int(item["completed"])}
            continue
        target = grouped[key]
        if item.get("product_ean") and target["category"] != item["category"]:
            warnings.append(_warning("ean_category_conflict", source, "category"))
        target["stock"] += item["quantity"]
        if target["stock"] > 1000000:
            raise LegacyImportError("invalid_item")
        target["quantity"] = target["stock"]
        target["merged_count"] += 1
        target["_hidden_count"] += int(item["completed"])
        target["hidden"] = target["hidden"] and item["completed"]
    result = list(grouped.values())
    merged_sources = 0
    for position, item in enumerate(result):
        item["position"] = position
        if item["merged_count"] > 1:
            merged_sources += item["merged_count"]
            if 0 < item["_hidden_count"] < item["merged_count"]:
                visibility_conflicts += 1
        del item["_hidden_count"]
    if merged_sources:
        warnings.append(_warning("inventory_merged", source, count=merged_sources))
    if visibility_conflicts:
        warnings.append(_warning("inventory_visibility_merged", source, count=visibility_conflicts))
    return result


def _category_for(name, categories):
    for category in categories:
        if any(rule.casefold() == name.casefold() for rule in category["legacy_rules"]):
            return category["name"]
    return None


_EAN_PRODUCT_FIELDS = ("ean", "name", "original_name", "brand", "package_quantity", "image_url")


def _ean_valid(value):
    return isinstance(value, str) and len(value) in {8, 12, 13, 14} and value.isascii() and value.isdecimal()


def _ean_name_key(value):
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def _ean_catalog(rows, source):
    """Read only the old product JSON fields; never retain configuration or fetch URLs."""
    if not isinstance(rows, list):
        raise LegacyImportError("ean_source_invalid", source=source, index=0, field="items")
    if len(rows) > MAX_ITEMS:
        raise LegacyImportError("too_many_items")
    products, rules_omitted = {}, 0
    for index, row in enumerate(rows, 1):
        field = "description"
        try:
            if not isinstance(row, dict) or not isinstance(row.get("description"), str) or len(row["description"]) > 16384:
                raise ValueError
            data = json.loads(row["description"])
            if not isinstance(data, dict) or type(data.get("schema")) is not int or data.get("schema") != 1 or data.get("type") or "transferId" in data:
                raise ValueError
            field = "ean"
            ean = data.get("ean")
            if not _ean_valid(ean):
                raise ValueError
            product = {"ean": ean}
            for field, key, maximum, required in (
                ("name", "name", 200, True), ("originalName", "original_name", 200, False),
                ("brand", "brand", 200, False), ("quantity", "package_quantity", 200, False),
                ("imageUrl", "image_url", 2048, False), ("category", "category", 100, False),
            ):
                product[key] = _text(data.get(field), maximum, required=required, code="ean_source_invalid")
            if product["category"] and product["category"].casefold() == "none":
                product["category"] = None
            field = "imageUrl"
            if product["image_url"]:
                url = urlsplit(product["image_url"])
                if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
                    raise ValueError
            field = "ean"
            if ean in products and products[ean] != product:
                raise ValueError
            products[ean] = product
            if data.get("minimumStock") not in (None, "") or data.get("automaticTransferDisabled") is True:
                rules_omitted += 1
        except (ValueError, TypeError, RecursionError):
            raise LegacyImportError("ean_source_invalid", source=source, index=index, field=field) from None
    return products, rules_omitted


def _inventory_product_ean(item, uid, description, name_index, choices, conflicts):
    # Explicit variant IDs take precedence over names shared by several products.
    if _is_inventory_metadata(description):
        value = json.loads(description).get("ean")
        if value not in (None, ""):
            if not _ean_valid(value):
                raise LegacyImportError("invalid_item", field="ean")
            return value
    candidates = name_index.get(_ean_name_key(item["name"]), [])
    if len(candidates) == 1:
        return candidates[0]["ean"]
    if not candidates:
        return None
    selected = choices.get(uid)
    if selected is not None and selected != "generic" and selected not in {product["ean"] for product in candidates}:
        raise LegacyImportError("ean_choice_invalid")
    conflicts.append({"source_uid": uid, "name": item["name"], "stock": item["quantity"],
                      "candidates": [{key: product[key] for key in ("ean", "name", "brand", "package_quantity")} for product in candidates],
                      "selected": selected})
    return None if selected in (None, "generic") else selected


def build_import_plan(parsed: dict[str, Any], source_items_by_entity: dict[str, list[dict[str, Any]]], selections=None, *, include_items: bool = True, ean_items_by_entity=None) -> dict[str, Any]:
    """Build a snapshot without changing HA sources or the integration database."""
    if not isinstance(include_items, bool):
        raise LegacyImportError("invalid_config")
    selected = {row["card_id"]: row for row in (selections or []) if isinstance(row, dict) and isinstance(row.get("card_id"), str)}
    groups = {}
    ean_products = {}
    ean_placeholders = set()
    ean_catalogs = {}
    warnings = deepcopy(parsed.get("warnings", []))
    for card in parsed["cards"]:
        choice = selected.get(card["id"], {})
        list_type = choice.get("list_type", card["mode"])
        allowed_types = {"shopping", "inventory"} if card["mode"] == "shopping" else {card["mode"]}
        if not isinstance(list_type, str) or list_type not in allowed_types:
            raise LegacyImportError("unsupported_mode")
        options = card["options"]
        if list_type == "inventory":
            options = {key: value for key, value in options.items() if key in _INVENTORY_OPTIONS}
            if card["mode"] != "inventory":
                warnings = [warning for warning in warnings if not (
                    warning["code"] == "default_mode" and warning.get("source") == card["id"])]
                for key in card["options"].keys() - options.keys():
                    warnings.append(_warning("ignored_setting", card["id"], key))
        effective_card = {**card, "options": options}
        entity = choice.get("entity_id", card["source_entity"]) if include_items else card["source_entity"]
        if include_items:
            if not entity:
                raise LegacyImportError("source_required")
            if not isinstance(entity, str) or not _ENTITY.fullmatch(entity):
                raise LegacyImportError("source_invalid")
            if entity in parsed.get("excluded_sources", []):
                raise LegacyImportError("unsupported_source")
        name = _text(choice.get("target_name", card["target_name"]), 200, required=True, code="invalid_target")
        # Without a source, unrelated cards still need separate target lists.
        group_key = entity or f"card:{card['id']}"
        if group_key not in groups:
            groups[group_key] = {"source_entity": entity, "name": name, "list_type": list_type, "icon": card["icon"], "source_cards": [], "include_items": include_items}
        elif groups[group_key]["list_type"] != list_type:
            raise LegacyImportError("source_mode_conflict")
        elif groups[group_key]["name"] != name:
            raise LegacyImportError("source_target_conflict")
        ean_entity = choice.get("ean_entity_id")
        if ean_entity:
            if list_type != "inventory" or not isinstance(ean_entity, str) or not _ENTITY.fullmatch(ean_entity) or ean_entity == entity:
                raise LegacyImportError("ean_source_invalid", source=ean_entity or "", index=0, field="entity")
            choices = choice.get("ean_choices", {})
            if not isinstance(choices, dict):
                raise LegacyImportError("ean_choice_invalid")
            group_choices = groups[group_key].setdefault("_ean_choices", {})
            for uid, value in choices.items():
                if not isinstance(uid, str) or not uid or len(uid) > 255 or (value != "generic" and not _ean_valid(value)):
                    raise LegacyImportError("ean_choice_invalid")
                if uid in group_choices and group_choices[uid] != value:
                    raise LegacyImportError("ean_choice_invalid")
                group_choices[uid] = value
            groups[group_key].setdefault("_ean_sources", set()).add(ean_entity)
        groups[group_key]["source_cards"].append(effective_card)
    lists = []
    all_items = 0
    target_names = set()
    for group in groups.values():
        entity = group["source_entity"]
        if group["name"].casefold() in target_names:
            raise LegacyImportError("invalid_target")
        target_names.add(group["name"].casefold())
        cards = group.pop("source_cards")
        ean_sources = sorted(group.pop("_ean_sources", ()))
        ean_choices = group.pop("_ean_choices", {})
        catalog = {}
        for ean_source in ean_sources:
            if ean_source not in ean_catalogs:
                ean_catalogs[ean_source] = _ean_catalog((ean_items_by_entity or {}).get(ean_source), ean_source)
            source_catalog, rules_omitted = ean_catalogs[ean_source]
            for ean, product in source_catalog.items():
                if ean in catalog and catalog[ean] != product:
                    raise LegacyImportError("ean_source_invalid", source=ean_source, index=0, field="ean")
                catalog[ean] = product
                central = {field: product[field] for field in _EAN_PRODUCT_FIELDS}
                if ean in ean_products and ean not in ean_placeholders and ean_products[ean] != central:
                    raise LegacyImportError("ean_source_invalid", source=ean_source, index=0, field="ean")
                ean_products[ean] = central
                ean_placeholders.discard(ean)
            if rules_omitted:
                warnings.append(_warning("ean_rules_omitted", entity, count=rules_omitted))
        ean_name_index = {}
        for product in catalog.values():
            ean_name_index.setdefault(_ean_name_key(product["name"]), []).append(product)
        if ean_sources:
            card_ids = {card["id"] for card in cards}
            warnings = [warning for warning in warnings if not (
                warning.get("source") in card_ids and warning.get("field") == "ean_database_entity")]
            warnings.append(_warning("inventory_ean", entity))

        if len(cards) > 1:
            warnings.append(_warning("shared_source", entity, count=len(cards)))
        categories, by_category, rules_seen = [], {}, set()
        for card in cards:
            for row in card["categories"]:
                normalized = row["name"].casefold()
                if normalized in by_category:
                    category = by_category[normalized]
                    if (row["icon"], row["color"]) != (category["icon"], category["color"]):
                        warnings.append(_warning("category_conflict", entity, "categories"))
                    category["legacy_rules"].extend(row["rules"])
                else:
                    category = {**deepcopy(row), "legacy_rules": list(row["rules"]), "rules": []}
                    by_category[normalized] = category
                    categories.append(category)
        for product in catalog.values():
            category_name = product["category"]
            if category_name and category_name.casefold() not in by_category:
                category = {"name": category_name, "icon": None, "color": None, "rules": [], "legacy_rules": []}
                by_category[category_name.casefold()] = category
                categories.append(category)
        if len(categories) > MAX_CATEGORIES:
            raise LegacyImportError("invalid_category")
        for category in categories:
            for rule in category["legacy_rules"]:
                if rule.casefold() in rules_seen:
                    warnings.append(_warning("duplicate_rule", entity, "categories.items"))
                    continue
                rules_seen.add(rule.casefold())
                if "*" in rule:
                    warnings.append(_warning("rule_unsupported", entity, "categories.items"))
                else:
                    category["rules"].append(rule)
        if len(rules_seen) > MAX_RULES:
            raise LegacyImportError("invalid_category")
        source_items = source_items_by_entity.get(entity) if include_items else []
        if not isinstance(source_items, list):
            raise LegacyImportError("source_unavailable")
        all_items += len(source_items)
        if all_items > MAX_ITEMS:
            raise LegacyImportError("too_many_items")
        inventory = group["list_type"] == "inventory"
        if inventory and not ean_sources:
            warnings.append(_warning("inventory_simple", entity))
        ean_conflicts = []
        omitted_descriptions = 0
        numeric_suffixes = 0
        items, source_uids = [], set()
        for index, source_item in enumerate(source_items):
            field = "entry"
            try:
                if not isinstance(source_item, dict):
                    raise LegacyImportError("invalid_item")
                uid = _item_text(source_item.get("uid"), 255, "uid", required=True)
                if uid in source_uids:
                    raise LegacyImportError("invalid_item", field="uid")
                source_uids.add(uid)
                summary = _item_text(source_item.get("summary", source_item.get("name")), 1000, "summary", required=True)
                item = _legacy_name(summary, allow_zero=inventory)
                numeric_suffixes += int(item.pop("_numeric_suffix_preserved"))
                description = _item_text(source_item.get("description"), 2000, "description")
                if _is_excluded_metadata(description, allow_inventory=inventory):
                    raise LegacyImportError("unsupported_source")
                if inventory:
                    if ean_sources:
                        product_ean = _inventory_product_ean(item, uid, description, ean_name_index, ean_choices, ean_conflicts)
                        item["product_ean"] = product_ean
                        if product_ean and product_ean not in ean_products:
                            ean_placeholders.add(product_ean)
                            ean_products[product_ean] = {"ean": product_ean, "name": item["name"], "original_name": None,
                                "brand": None, "package_quantity": None, "image_url": None}
                    if description and not _is_inventory_metadata(description):
                        omitted_descriptions += 1
                    description = None
                status = source_item.get("status", "completed" if source_item.get("completed") else "needs_action")
                if not isinstance(status, str) or status not in {"completed", "needs_action"}:
                    raise LegacyImportError("invalid_item", field="status")
                uncategorized = item.pop("_uncategorized")
                if inventory and ean_sources:
                    item["_ean_uncategorized"] = uncategorized
                category = None if uncategorized else item["category"] or _category_for(item["name"], categories)
                saved = by_category.get(category.casefold()) if category else None
                field = "due"
                due_at = None if inventory else _due(source_item.get("due"))
            except LegacyImportError as error:
                if error.code == "invalid_item":
                    error.values.update(source=entity, index=index + 1)
                    error.values.setdefault("field", field)
                    error.translation_key = "import.item_too_long" if "maximum" in error.values else "import.item_field_invalid"
                raise
            item.update({"source_uid": uid, "description": description, "category": saved["name"] if saved else category,
                         "category_saved": saved is not None, "due_at": due_at,
                         "completed": status == "completed", "position": item["position"] if item["position"] is not None else index,
                         "offer_only": bool(item["offer_only"] and group["list_type"] == "shopping")})
            if group["list_type"] != "todo":
                item["recurrence_interval"] = item["recurrence_unit"] = None
            items.append(item)
        items.sort(key=lambda item: item["position"])
        for position, item in enumerate(items):
            item["position"] = position
        if inventory:
            items = _inventory_items(items, warnings, entity)
            if omitted_descriptions:
                warnings.append(_warning("inventory_description_omitted", entity, count=omitted_descriptions))
        chips, chip_seen = [], set()
        for card in cards:
            for value in card["chips"]:
                chip_item = _legacy_name(value, allow_zero=inventory)
                uncategorized = chip_item.pop("_uncategorized")
                numeric_suffixes += int(chip_item.pop("_numeric_suffix_preserved"))
                chip_key = " ".join(chip_item["name"].split()).casefold()
                if chip_key in chip_seen:
                    warnings.append(_warning("duplicate_chip", entity, "chips"))
                    continue
                chip_seen.add(chip_key)
                template = None
                if group["list_type"] == "todo":
                    template = {"item_name": chip_item["name"], "description": None,
                                "category_name": None if uncategorized else chip_item["category"] or _category_for(chip_item["name"], categories),
                                "category_id": None, "label_ids": [], "due_mode": "none", "add_mode": "direct",
                                "recurrence_interval": chip_item["recurrence_interval"], "recurrence_unit": chip_item["recurrence_unit"]}
                else:
                    category_name = chip_item["category"]
                    category = by_category.get(category_name.casefold()) if category_name else None
                    existing_category = _category_for(chip_item["name"], categories)
                    if category and existing_category is None:
                        category["rules"].append(chip_item["name"])
                        category["legacy_rules"].append(chip_item["name"])
                    missing_category = category_name and (not category or (existing_category and existing_category.casefold() != category_name.casefold()))
                    if missing_category or (uncategorized and existing_category) or chip_item["quantity"] != 1 or chip_item["offer_only"] or chip_item["recurrence_interval"]:
                        warnings.append(_warning("chip_metadata", entity, "chips"))
                chips.append({"name": chip_item["name"], "chip_kind": "todo_template" if template else "entry", "icon": None, "color": None, "template_data": template})
        if len(chips) > MAX_CHIPS:
            raise LegacyImportError("invalid_chip")
        if numeric_suffixes:
            warnings.append(_warning("numeric_suffix_preserved", entity, count=numeric_suffixes))
        for category in categories:
            del category["legacy_rules"]
        if sum(len(category["rules"]) for category in categories) > MAX_RULES:
            raise LegacyImportError("invalid_category")
        counts = {"lists": 1, "cards": len(cards), "items": len(items), "completed": sum(item["completed"] for item in items),
                  "categories": len(categories), "dynamic_categories": len({item["category"].casefold() for item in items if item["category"] and not item["category_saved"]}),
                  "chips": len(chips), "rules": sum(len(category["rules"]) for category in categories),
                  "products": len(items) if inventory else 0,
                  "hidden": sum(item["hidden"] for item in items) if inventory else 0,
                  "merged": len(source_items) - len(items) if inventory else 0,
                  "source_items": len(source_items)}
        suppressed_eans = {item.get("product_ean") for item in items if item.pop("_ean_uncategorized", False)}
        ean_fields = {"ean_enabled": True, "ean_conflicts": ean_conflicts,
                      "ean_product_categories": {ean: by_category[product["category"].casefold()]["name"]
                                                 for ean, product in catalog.items() if product["category"] and ean not in suppressed_eans}} if ean_sources else {}
        lists.append({**group, **ean_fields, "categories": categories, "chips": chips, "items": items,
                      "cards": [{"title": card["title"], "title_icon": card["icon"], "options": card["options"]} for card in cards], "counts": counts})
    counts = {key: sum(row["counts"][key] for row in lists) for key in ("lists", "cards", "items", "completed", "categories", "dynamic_categories", "chips", "rules", "products", "hidden", "merged", "source_items")}
    plan = {"version": 1, "lists": lists, "warnings": warnings, "counts": counts, "include_items": include_items}
    if ean_catalogs:
        if len(ean_products) > MAX_ITEMS:
            raise LegacyImportError("too_many_items")
        plan["ean_products"] = list(ean_products.values())
        plan["can_import"] = not any(conflict["selected"] is None for row in lists for conflict in row.get("ean_conflicts", ()))
    plan["fingerprint"] = hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return plan
