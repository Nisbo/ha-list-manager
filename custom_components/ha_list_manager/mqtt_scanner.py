"""MQTT payload mapping and unambiguous scanner configuration."""
from __future__ import annotations

import json
import re
from .localization import text

_PATH = re.compile(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\Z")
_FIELDS = {"topic", "format", "ean_path", "scanner_path", "scanner_value", "scan_id_path"}


def validate_config(config):
    if not isinstance(config, dict) or set(config) - _FIELDS:
        raise ValueError(text("mqtt.config_invalid"))
    result = {key: str(config.get(key) or "").strip() for key in _FIELDS}
    topic = result["topic"]
    if not topic or len(topic.encode()) > 512 or any(c in topic for c in "+#\x00") or topic.startswith("$share/"):
        raise ValueError(text("mqtt.topic_invalid"))
    if result["format"] not in {"json", "text"}:
        raise ValueError(text("mqtt.config_invalid"))
    if len(result["scanner_value"]) > 200:
        raise ValueError(text("mqtt.config_invalid"))
    for key in ("ean_path", "scanner_path", "scan_id_path"):
        value = result[key]
        if value and (len(value) > 200 or not _PATH.fullmatch(value)):
            raise ValueError(text("mqtt.path_invalid"))
    if result["format"] == "json" and not result["ean_path"]:
        raise ValueError(text("mqtt.ean_required"))
    if bool(result["scanner_path"]) != bool(result["scanner_value"]):
        raise ValueError(text("mqtt.identity_required"))
    if result["format"] == "text":
        if result["scanner_path"] or result["scan_id_path"]:
            raise ValueError(text("mqtt.json_required"))
        result["ean_path"] = ""
    return result


def validate_shared_topic(config, peers):
    for peer in peers:
        if peer["topic"] != config["topic"]:
            continue
        if not peer["scanner_path"] or not config["scanner_path"]:
            raise ValueError(text("mqtt.topic_exclusive"))
        if any(peer[key] != config[key] for key in ("format", "scanner_path", "ean_path", "scan_id_path")):
            raise ValueError(text("mqtt.topic_mapping"))
        if peer["scanner_value"] == config["scanner_value"]:
            raise ValueError(text("mqtt.identity_duplicate"))


def _field(data, path):
    for part in path.split("."):
        if not isinstance(data, dict) or part not in data:
            raise ValueError(text("mqtt.field_missing", field=path))
        data = data[part]
    if isinstance(data, bool) or not isinstance(data, (str, int)):
        raise ValueError(text("mqtt.field_invalid", field=path))
    value = str(data).strip()
    if not value or len(value) > 512:
        raise ValueError(text("mqtt.field_invalid", field=path))
    return value


def extract_scan(config, payload):
    """Return strings without evaluating templates or changing leading zeroes."""
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8")
    if not isinstance(payload, str) or len(payload.encode()) > 16384:
        raise ValueError(text("mqtt.payload_invalid"))
    if config["format"] == "text":
        return {"ean": payload.strip(), "scanner": None, "scan_id": None}
    try:
        data = json.loads(payload)
    except (ValueError, TypeError) as error:
        raise ValueError(text("mqtt.payload_invalid")) from error
    return {"ean": _field(data, config["ean_path"]),
            "scanner": _field(data, config["scanner_path"]) if config["scanner_path"] else None,
            "scan_id": _field(data, config["scan_id_path"]) if config["scan_id_path"] else None}
