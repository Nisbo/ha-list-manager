"""Stable script event names and operation context shared by backend writers."""
from __future__ import annotations

from contextvars import ContextVar
from functools import wraps
from typing import Any

from .localization import text

SCRIPT_OPERATION: ContextVar[dict[str, Any] | None] = ContextVar("ha_list_manager_script_operation", default=None)
SCRIPT_CHAIN: ContextVar[tuple[str, ...]] = ContextVar("ha_list_manager_script_chain", default=())

# Event identifiers are API values; only their labels are translated.
SCRIPT_EVENTS = {
    "item_added": ("list", "scripts.event.item_added"),
    "item_removed": ("list", "scripts.event.item_removed"),
    "item_quantity_changed": ("list", "scripts.event.item_quantity_changed"),
    "item_renamed": ("list", "scripts.event.item_renamed"),
    "item_completed": ("list", "scripts.event.item_completed"),
    "item_reopened": ("list", "scripts.event.item_reopened"),
    "item_updated": ("list", "scripts.event.item_updated"),
    "inventory_in": ("inventory", "scripts.event.inventory_in"),
    "inventory_out": ("inventory", "scripts.event.inventory_out"),
    "inventory_corrected": ("inventory", "scripts.event.inventory_corrected"),
    "inventory_registered": ("inventory", "scripts.event.inventory_registered"),
    "inventory_removed": ("inventory", "scripts.event.inventory_removed"),
    "inventory_undo_completed": ("inventory", "scripts.event.inventory_undo_completed"),
    "scanner_mode_changed": ("scanner", "scripts.event.scanner_mode_changed"),
    "scanner_disabled": ("scanner", "scripts.event.scanner_disabled"),
    "scan_needs_input": ("scanner", "scripts.event.scan_needs_input"),
    "scan_error": ("scanner", "scripts.event.scan_error"),
    "restock_manual": ("restock", "scripts.event.restock_manual"),
    "restock_automatic": ("restock", "scripts.event.restock_automatic"),
    "restock_lock_reset": ("restock", "scripts.event.restock_lock_reset"),
}


def event_options(list_type: str) -> list[dict[str, str]]:
    groups = {"inventory", "scanner", "restock"} if list_type == "inventory" else {"list"}
    return [{"event": event, "group": group, "label": text(key)}
            for event, (group, key) in SCRIPT_EVENTS.items() if group in groups]


def scanner_operation(method):
    """Attach scanner identity to the committed booking, not a second UI event."""
    @wraps(method)
    async def wrapped(self, *args, **kwargs):
        operation = {
            "source": "scanner", "scanner_source": kwargs.get("source", "simulation"),
            "scanner_address": kwargs.get("address") or "", "scanner_id": kwargs.get("scanner_id") or "",
            "scan_mode": kwargs.get("action") or "", "scan_quantity": kwargs.get("quantity", 1),
            "ean": str(kwargs.get("ean") or ""),
        }
        token = SCRIPT_OPERATION.set(operation)
        try:
            return await method(self, *args, **kwargs)
        finally:
            SCRIPT_OPERATION.reset(token)
    return wrapped


def item_script_action(before, after, source):
    record = after or before
    if not before:
        event = "item_added"
    elif not after:
        event = "item_removed"
    elif before.get("completed") != after.get("completed"):
        event = "item_completed" if after.get("completed") else "item_reopened"
    elif before.get("quantity") != after.get("quantity"):
        event = "item_quantity_changed"
    elif before.get("name") != after.get("name"):
        event = "item_renamed"
    else:
        event = "item_updated"
    changed = [key for key in record if key not in {"updated_at", "created_at", "position"} and (before or {}).get(key) != (after or {}).get(key)]
    if before and after and not changed:
        return None
    return {"event": event, "list_id": record["list_id"], "source": source,
        "name": record["name"], "product_id": record.get("product_id"),
        "quantity": (after or {}).get("quantity", 0), "previous_quantity": (before or {}).get("quantity", ""),
        "previous_name": (before or {}).get("name", ""), "category": record.get("category") or "",
        "offer_only": bool(record.get("offer_only")),
        "changed_fields": changed}

