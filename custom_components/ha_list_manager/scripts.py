"""One optional, event-filtered Home Assistant script per backend list."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import logging
from uuid import uuid4

from homeassistant.core import callback

from .const import EVENT_ITEM_MUTATED, EVENT_SCAN_PROCESSED, EVENT_SCANNER_TARGET_CHANGED, EVENT_SCRIPT_ACTION
from .database import ListNotFoundError
from .localization import async_prepare, system_text as text
from .script_events import SCRIPT_CHAIN, item_script_action

_LOGGER = logging.getLogger(__name__)


class ListScriptManager:
    def __init__(self, hass, database):
        self.hass, self.database = hass, database
        self._unsubscribes = []
        self._tasks = set()
        self._locks = {}
        self._seen = {}
        self._target_list_id = None
        self._stopped = False

    async def async_start(self):
        target = await self.database.async_get_scanner_target()
        self._target_list_id = target.list_id if target else None
        for event, handler in (
            (EVENT_SCRIPT_ACTION, self._action), (EVENT_ITEM_MUTATED, self._item),
            (EVENT_SCAN_PROCESSED, self._scan), (EVENT_SCANNER_TARGET_CHANGED, self._target),
        ):
            self._unsubscribes.append(self.hass.bus.async_listen(event, handler))

    async def async_stop(self):
        self._stopped = True
        for unsubscribe in self._unsubscribes:
            unsubscribe()
        self._unsubscribes.clear()
        for task in tuple(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def _schedule(self, data, context=None):
        if self._stopped or not data.get("list_id"):
            return
        task = self.hass.async_create_task(self._dispatch(dict(data), context), "HA List Manager list script")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @callback
    def _action(self, event):
        data = dict(event.data)
        if data.get("scan_mode") == "correct" and data.get("event", "").startswith("inventory_"):
            data["event"] = "inventory_corrected"
        elif data.get("scan_mode") in {"add", "remove"} and data.get("event") == "inventory_corrected":
            data["event"] = "inventory_in" if data["stock_after"] > data["stock_before"] else "inventory_out"
        self._schedule(data, getattr(event, "context", None))

    @callback
    def _item(self, event):
        data = event.data
        payload = item_script_action(data.get("before"), data.get("after"), data.get("source") or "backend")
        if payload:
            self._schedule({**data, **payload}, getattr(event, "context", None))

    @callback
    def _scan(self, event):
        data = event.data
        # Successful bookings are published by the database exactly once. The
        # scanned control QR is likewise already represented by the target event.
        if data.get("status") == "success":
            return
        status = data.get("status")
        if status not in {"error", "queued", "needs_input", "offered"}:
            return
        action = "scan_error" if status == "error" else "scan_needs_input"
        scan_id = data.get("id")
        self._schedule({**data, "event": action, "source": "scanner", "name": data.get("product_name") or data.get("ean") or "",
            "status": "error" if action == "scan_error" else "product_review_required" if data.get("product_id") else "product_not_found",
            "event_id": f"scan:{scan_id}:{action}" if scan_id else str(uuid4()),
            "error": data.get("message", "") if action == "scan_error" else "", "scan_mode": data.get("action") or "",
            "scanner_source": data.get("source") or "", "scan_quantity": data.get("quantity", 1)}, getattr(event, "context", None))

    @callback
    def _target(self, event):
        data = event.data
        list_id = data.get("list_id")
        if list_id:
            self._target_list_id = list_id
            self._schedule({**data, "event": "scanner_mode_changed", "scan_mode": data.get("action", ""), "source": "scanner"}, getattr(event, "context", None))
        elif data.get("target", True) is None:
            previous = self._target_list_id
            self._target_list_id = None
            self._schedule({"list_id": previous, "event": "scanner_disabled", "source": "scanner"}, getattr(event, "context", None))

    async def _dispatch(self, data, context=None):
        list_id = data["list_id"]
        if list_id in data.get("script_chain", ()):
            return
        async with self._locks.setdefault(list_id, asyncio.Lock()):
            try:
                configured = await self.database.async_get_list_script_settings(list_id)
                settings = configured["settings"]
                if not settings["enabled"] or data["event"] not in settings["events"]:
                    return
                record = await self.database.async_get_list(list_id)
                if not record.enabled:
                    return
                script_entity = settings["script_entity"]
                if self.hass.states.get(script_entity) is None:
                    _LOGGER.warning("Configured list script %s is unavailable for list %s", script_entity, list_id)
                    return
                event_id = data.get("event_id") or str(uuid4())
                dedup = (list_id, event_id)
                if dedup in self._seen:
                    return
                self._seen[dedup] = True
                if len(self._seen) > 2000:
                    self._seen.pop(next(iter(self._seen)))
                variables = await self._variables(record, {**data, "event_id": event_id})
                token = SCRIPT_CHAIN.set((*data.get("script_chain", ()), list_id))
                try:
                    await self.hass.services.async_call("script", "turn_on", {"entity_id": script_entity, "variables": variables}, blocking=True, context=context)
                finally:
                    SCRIPT_CHAIN.reset(token)
            except ListNotFoundError:
                return
            except Exception:
                # Stock/list writes already committed; never roll them back or
                # retry a script which may already have performed side effects.
                _LOGGER.exception("List script failed for list %s", list_id)

    async def _variables(self, record, data):
        await async_prepare(self.hass)
        product = data.get("product") or {}
        if not product and data.get("product_id"):
            try:
                product = await self.database.async_get_script_product(data["product_id"])
            except Exception:
                product = {}
        source = data.get("source") or "backend"
        event = data["event"]
        status = data.get("status") or event
        if event == "inventory_registered" and source == "scanner" and data.get("scan_mode") == "add":
            status = "product_added"
        elif event == "inventory_in" and source == "scanner":
            status = "product_quantity_increased" if data.get("was_existing") else "product_added"
        elif event == "inventory_out" and source == "scanner":
            status = "product_quantity_decreased"
        elif event in {"restock_manual", "restock_automatic"}:
            status = "transfer_sent"
        list_entity = record.external_entity_id or ""
        if not list_entity:
            list_entity = next((state.entity_id for state in self.hass.states.async_all() if state.attributes.get("list_id") == record.id), "")
        name = data.get("name") or product.get("name") or ""
        quantity = data.get("quantity", 0)
        before, after = data.get("stock_before", ""), data.get("stock_after", "")
        target_name = ""
        if data.get("target_list_id"):
            try:
                target_name = (await self.database.async_get_list(data["target_list_id"])).name
            except ListNotFoundError:
                pass
        if event == "item_added": args = (quantity, name, record.name)
        elif event == "item_removed": args = (name, record.name)
        elif event == "item_quantity_changed": args = (name, data.get("previous_quantity", ""), quantity)
        elif event == "item_renamed": args = (data.get("previous_name", ""), name)
        elif event in {"inventory_in", "inventory_out"}: args = (quantity, name, record.name)
        elif event == "inventory_corrected": args = (name, before, after)
        elif event == "inventory_registered": args = (name, record.name, after)
        elif event == "inventory_removed": args = (name, record.name)
        elif event == "scanner_mode_changed":
            mode = data.get("scan_mode")
            args = (text("scripts.mode." + mode) if mode in {"add", "remove", "register", "correct"} else text("scripts.mode.unknown"), record.name)
        elif event == "scanner_disabled": args = (record.name,)
        elif event == "scan_needs_input": args = (name, record.name)
        elif event == "scan_error": args = (name, data.get("error", ""))
        elif event.startswith("restock_") and event != "restock_lock_reset": args = (quantity, name, target_name)
        else: args = (name,)
        message = text("scripts." + event, **{f"p{i}": value for i, value in enumerate(args)})
        ean = data.get("ean") or product.get("ean") or ""
        return {
            "event": event, "event_id": data["event_id"], "status": status, "action": data.get("scan_mode") or event,
            "name": name, "category": data.get("category") or product.get("category") or "",
            "quantity": quantity, "previous_quantity": data.get("previous_quantity", ""), "previous_name": data.get("previous_name", ""),
            "list_entity": list_entity, "list_id": record.id, "list_name": record.name,
            "mode": record.list_type, "ean": ean, "is_ean": bool(ean), "offer_only": bool(data.get("offer_only")),
            "brand": product.get("brand") or "", "product_quantity": product.get("package_quantity") or "",
            "image_url": product.get("image_url") or "", "scan_quantity": data.get("scan_quantity", 1 if source == "scanner" else ""),
            "scanner_address": data.get("scanner_address") or "", "scanner_source": data.get("scanner_source") or "",
            "scanner_id": data.get("scanner_id") or "", "scan_mode": data.get("scan_mode") or "", "card_id": "",
            "stock_before": before, "stock_after": after, "original_action": data.get("scan_mode") or event,
            "transfer_result": "sent" if event in {"restock_manual", "restock_automatic"} else "kept" if data.get("transfer_kept") else "",
            "error": data.get("error") or "", "source": source, "message": message,
            "target_list_id": data.get("target_list_id") or "", "target_list_name": target_name,
            "changed_fields": data.get("changed_fields", []), "timestamp": datetime.now(UTC).isoformat(),
        }
