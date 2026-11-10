"""One-way intake from an existing Alexa Devices list, without Amazon login."""
from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_time_interval

from .alexa_parser import (
    AlexaParseError, AlexaParser, alexa_language_rules,
    available_alexa_languages, default_alexa_languages,
)
from .const import EVENT_ALEXA_CHANGED, EVENT_ITEMS_CHANGED
from .localization import text

DEFAULT_SETTINGS = {
    "enabled": False,
    "source_entity_id": None,
    "target_list_id": None,
    "recognize_numbers": False,
    "recognize_units": False,
    "match_products": False,
    "languages": None,
    "number_mappings": "",
    "unit_mappings": "",
    "exceptions": "",
    "cleanup_action": "keep",
}


class AlexaInboxError(ValueError):
    """A safe, translatable configuration or intake failure."""


class AlexaInboxManager:
    """Own one fixed source/target and durably acknowledge each source UID once."""

    def __init__(self, hass, database) -> None:
        self._hass = hass
        self._database = database
        self._settings = dict(DEFAULT_SETTINGS)
        self._lock = asyncio.Lock()
        self._unsubs = []
        self._source_unsub = None
        self._source_object = None
        self._worker = None
        self._requested = False
        self._stopped = True
        self._generation = 0
        self._cleanup_cursor = None
        self._languages_loaded = False

    async def _warm_languages(self) -> None:
        if not self._languages_loaded:
            await self._hass.async_add_executor_job(available_alexa_languages)
            self._languages_loaded = True

    def _default_languages(self):
        return default_alexa_languages(getattr(self._hass.config, "language", None))

    async def async_start(self) -> None:
        await self._warm_languages()
        self._settings = {**DEFAULT_SETTINGS, **(await self._database.async_get_alexa_state())["settings"]}
        if self._settings["languages"] is None:
            self._settings["languages"] = self._default_languages()
        self._stopped = False

        @callback
        def changed(event) -> None:
            entity_id = event.data.get("entity_id")
            if entity_id == self._source_entity_id():
                self._subscribe_source()
                self._schedule()

        @callback
        def started(_event) -> None:
            self._subscribe_source()
            self._schedule()

        @callback
        def retry(_now) -> None:
            self._subscribe_source()
            self._schedule()

        self._unsubs.append(self._hass.bus.async_listen("state_changed", changed))
        self._unsubs.append(self._hass.bus.async_listen("entity_registry_updated", started))
        self._unsubs.append(async_track_time_interval(self._hass, retry, timedelta(minutes=1)))
        if getattr(self._hass, "is_running", True):
            self._subscribe_source()
            self._schedule()
        else:
            self._unsubs.append(self._hass.bus.async_listen_once("homeassistant_started", started))

    async def async_stop(self) -> None:
        self._stopped = True
        self._generation += 1
        if self._source_unsub:
            self._source_unsub()
        self._source_unsub = self._source_object = None
        for unsubscribe in self._unsubs:
            unsubscribe()
        self._unsubs.clear()
        if self._worker:
            await asyncio.gather(self._worker, return_exceptions=True)
        self._worker = None

    def _source_entry(self, settings=None):
        selected = settings if settings is not None else self._settings
        registry = er.async_get(self._hass)
        registry_id = selected.get("source_registry_id")
        entry = registry.async_get(registry_id) if registry_id else None
        if entry is None and not registry_id:
            entry = registry.async_get(selected.get("source_entity_id") or "")
        return entry

    def _source_entity_id(self):
        entry = self._source_entry()
        return entry.entity_id if entry else self._settings.get("source_entity_id")

    @staticmethod
    def _valid_source(entry) -> bool:
        return bool(entry and entry.platform == "alexa_devices" and entry.entity_id.startswith("todo.") and not entry.disabled_by)

    def _available(self, entity_id: str | None) -> bool:
        state = self._hass.states.get(entity_id) if entity_id else None
        return bool(state and state.state not in {"unavailable", "unknown"})

    @callback
    def _subscribe_source(self) -> None:
        component = self._hass.data.get("todo")
        entity = component.get_entity(self._source_entity_id()) if component and self._settings["enabled"] and not self._stopped else None
        if entity is self._source_object:
            return
        if self._source_unsub:
            self._source_unsub()
        self._source_unsub = None
        self._source_object = entity
        # Native To-do updates also cover changes whose open-item count stays equal.
        if entity is not None:
            self._source_unsub = entity.async_subscribe_updates(lambda _items: self._schedule())

    @callback
    def _schedule(self) -> None:
        if self._stopped or not self._settings["enabled"]:
            return
        self._requested = True
        if self._worker is None or self._worker.done():
            self._worker = self._hass.async_create_task(self._run())

    async def _run(self) -> None:
        while self._requested and not self._stopped:
            self._requested = False
            try:
                await self.async_process()
            except Exception:
                # async_process persists a localized diagnostic; events can retry.
                pass

    def _notify(self) -> None:
        self._hass.bus.async_fire(EVENT_ALEXA_CHANGED)

    def _check_generation(self, generation: int) -> None:
        # Manual WebSocket retries do not run in _worker. Invalidate their
        # pending source reads as well when the integration is unloaded.
        if generation != self._generation:
            raise asyncio.CancelledError

    async def async_get(self) -> dict[str, Any]:
        await self._warm_languages()
        stored = await self._database.async_get_alexa_state()
        settings = {key: self._settings.get(key, value) for key, value in DEFAULT_SETTINGS.items()}
        if settings["languages"] is None:
            settings["languages"] = self._default_languages()
        entry = self._source_entry()
        if entry:
            settings["source_entity_id"] = entry.entity_id
        sources = []
        for candidate in er.async_get(self._hass).entities.values():
            if candidate.platform == "alexa_devices" and candidate.entity_id.startswith("todo."):
                state = self._hass.states.get(candidate.entity_id)
                sources.append({"entity_id": candidate.entity_id, "name": (state.attributes.get("friendly_name") if state else None) or candidate.name or candidate.original_name or candidate.entity_id, "available": self._valid_source(candidate) and self._available(candidate.entity_id)})
        targets = [{"id": record.id, "name": record.name} for record in await self._database.async_list_lists() if record.enabled and record.provider == "local" and record.list_type == "shopping"]
        pending = await self._database.async_list_alexa_pending_receipts()
        status = {**stored["status"], "enabled": settings["enabled"], "source_available": self._valid_source(entry) and self._available(settings["source_entity_id"]), "target_available": any(target["id"] == settings["target_list_id"] for target in targets), "source_name": next((source["name"] for source in sources if source["entity_id"] == settings["source_entity_id"]), None), "target_name": next((target["name"] for target in targets if target["id"] == settings["target_list_id"]), None), "pending_cleanup": len(pending)}
        return {"settings": settings, "languages": available_alexa_languages(), "sources": sorted(sources, key=lambda row: row["name"].casefold()), "targets": targets, "status": status, "receipts": [receipt for receipt in stored["receipts"] if receipt.get("cleanup_status") != "ignored"][:20]}

    def _validate_settings(self, values):
        if not isinstance(values, dict) or set(values) - set(DEFAULT_SETTINGS):
            raise AlexaInboxError(text("alexa.settings_invalid"))
        settings = {**DEFAULT_SETTINGS, **values}
        for key in ("enabled", "recognize_numbers", "recognize_units", "match_products"):
            if type(settings[key]) is not bool:
                raise AlexaInboxError(text("alexa.settings_invalid"))
        if settings["cleanup_action"] not in {"keep", "complete", "delete"}:
            raise AlexaInboxError(text("alexa.settings_invalid"))
        for key in ("source_entity_id", "target_list_id"):
            value = settings[key]
            if value is not None and (not isinstance(value, str) or len(value) > 255):
                raise AlexaInboxError(text("alexa.settings_invalid"))
            settings[key] = value.strip() or None if value is not None else None
        if settings["languages"] is None:
            settings["languages"] = self._default_languages()
        try:
            AlexaParser(settings)
        except AlexaParseError as error:
            raise AlexaInboxError(text(error.key, **error.placeholders)) from error
        return settings

    async def async_set(self, values: dict[str, Any]) -> dict[str, Any]:
        await self._warm_languages()
        async with self._lock:
            settings = self._validate_settings(values)
            if settings["enabled"] and settings["target_list_id"]:
                await self._require_target(settings["target_list_id"])
            elif settings["enabled"]:
                raise AlexaInboxError(text("alexa.target_required"))
            entry = self._source_entry(settings)
            if settings["enabled"] and ((entry is not None and not self._valid_source(entry)) or (settings["source_entity_id"] and entry is None)):
                raise AlexaInboxError(text("alexa.source_invalid"))
            if settings["enabled"] and entry is None:
                raise AlexaInboxError(text("alexa.source_required"))
            if entry:
                settings["source_registry_id"] = entry.id
            changed_mapping = any(settings.get(key) != self._settings.get(key) for key in ("source_registry_id", "target_list_id"))
            if settings["enabled"] and (not self._settings["enabled"] or changed_mapping):
                items = await self._read_source(entry.entity_id)
                await self._database.async_ignore_alexa_items(entry.id, [row["uid"] for row in items], source_entity_id=entry.entity_id)
            await self._database.async_set_alexa_settings(settings)
            self._settings = settings
            self._subscribe_source()
            self._notify()
            self._schedule()
        return await self.async_get()

    async def _require_target(self, target_id):
        try:
            record = await self._database.async_get_list(target_id)
        except Exception as error:
            raise AlexaInboxError(text("alexa.target_invalid")) from error
        if not record.enabled or record.provider != "local" or record.list_type != "shopping":
            raise AlexaInboxError(text("alexa.target_invalid"))
        return record

    async def _read_source(self, entity_id: str) -> list[dict[str, str]]:
        entry = er.async_get(self._hass).async_get(entity_id)
        if not self._valid_source(entry):
            raise AlexaInboxError(text("alexa.source_invalid"))
        if not self._available(entity_id):
            raise AlexaInboxError(text("alexa.source_unavailable"))
        async with asyncio.timeout(30):
            response = await self._hass.services.async_call("todo", "get_items", {"entity_id": entity_id}, blocking=True, return_response=True)
        payload = response.get(entity_id) if isinstance(response, Mapping) else None
        items = payload.get("items") if isinstance(payload, Mapping) else None
        if not isinstance(items, list):
            raise AlexaInboxError(text("alexa.invalid_response"))
        seen = set()
        for row in items:
            if (not isinstance(row, Mapping) or not isinstance(row.get("uid"), str) or not row["uid"] or len(row["uid"]) > 1000 or row["uid"] in seen or not isinstance(row.get("summary"), str) or not row["summary"].strip() or len(row["summary"]) > 2000 or row.get("status") not in {"needs_action", "completed"}):
                raise AlexaInboxError(text("alexa.invalid_response"))
            seen.add(row["uid"])
        return items

    def _parsed(self, row, parser):
        item = parser.parse(row["summary"])
        if not item.name.strip() or len(item.name) > 200 or (item.description and len(item.description) > 2000):
            raise AlexaInboxError(text("alexa.item_invalid"))
        return item

    async def async_rules(self, *, language_code, kind, query="", offset=0, limit=50):
        """Browse shipped rules without loading every language into the page."""
        await self._warm_languages()
        try:
            return alexa_language_rules(language_code, kind, query, offset, limit)
        except AlexaParseError as error:
            raise AlexaInboxError(text(error.key, **error.placeholders)) from error

    async def async_test(self, *, settings, input_text):
        """Preview the unsaved draft without reading or changing Alexa's list."""
        await self._warm_languages()
        values = self._validate_settings(settings)
        if not isinstance(input_text, str) or not input_text.strip() or len(input_text) > 2000:
            raise AlexaInboxError(text("alexa.item_invalid"))
        item = self._parsed({"summary": input_text}, AlexaParser(values))
        resolution = await self._database.async_preview_alexa_item(
            values["target_list_id"], item.name, item.description, item.quantity,
            match_products=values["match_products"], has_unit=item.has_unit,
        )
        return {"parsed": {"name": item.name, "quantity": item.quantity,
            "description": item.description, "has_unit": item.has_unit}, "resolution": resolution}

    async def async_preview(self) -> dict[str, Any]:
        async with self._lock:
            entry = self._source_entry()
            if not entry:
                raise AlexaInboxError(text("alexa.source_required"))
            await self._require_target(self._settings["target_list_id"])
            rows = await self._read_source(entry.entity_id)
            receipts = await self._database.async_get_alexa_receipts(entry.id, [row["uid"] for row in rows])
            parser = AlexaParser(self._settings)
            items = []
            for row in rows:
                if row["status"] != "needs_action":
                    continue
                receipt = receipts.get(row["uid"])
                result = {"uid": row["uid"], "original_name": row["summary"], "already_processed": bool(receipt and receipt["cleanup_status"] != "ignored")}
                try:
                    item = self._parsed(row, parser)
                    resolution = await self._database.async_preview_alexa_item(
                        self._settings["target_list_id"], item.name, item.description,
                        item.quantity, match_products=self._settings["match_products"],
                        has_unit=item.has_unit,
                    )
                    result.update(name=item.name, quantity=item.quantity, description=item.description,
                                  has_unit=item.has_unit, resolution=resolution)
                except ValueError as error:
                    result.update(name=row["summary"], quantity=1, description=None, error=str(error))
                items.append(result)
            return {"items": items, "count": sum(not item["already_processed"] and not item.get("error") for item in items)}

    async def async_process(self, *, include_existing: bool = False) -> dict[str, Any]:
        processed = 0
        generation = self._generation
        async with self._lock:
            self._check_generation(generation)
            if not self._settings["enabled"]:
                return {**(await self.async_get()), "processed": 0}
            try:
                entry = self._source_entry()
                if not entry:
                    raise AlexaInboxError(text("alexa.source_invalid"))
                await self._require_target(self._settings["target_list_id"])
                self._check_generation(generation)
                rows = await self._read_source(entry.entity_id)
                self._check_generation(generation)
                receipts = await self._database.async_get_alexa_receipts(entry.id, [row["uid"] for row in rows])
                self._check_generation(generation)
                parser = AlexaParser(self._settings)
                errors = []
                for row in rows:
                    self._check_generation(generation)
                    receipt = receipts.get(row["uid"])
                    if row["status"] != "needs_action" or (receipt and (receipt["cleanup_status"] != "ignored" or not include_existing)):
                        continue
                    try:
                        item = self._parsed(row, parser)
                        result = await self._database.async_accept_alexa_item(entry.id, row["uid"], self._settings["target_list_id"], item.name, item.description, item.quantity, self._settings["cleanup_action"], row["summary"], source_entity_id=entry.entity_id, include_existing=include_existing, match_products=self._settings["match_products"], has_unit=item.has_unit)
                        if result["accepted"]:
                            processed += 1
                            self._hass.bus.async_fire(EVENT_ITEMS_CHANGED, {"list_id": self._settings["target_list_id"]})
                    except Exception as error:
                        errors.append(str(error) or str(text("alexa.processing_failed")))
                # Source cleanup is deliberately a separate step after the commit.
                errors.extend(await self._cleanup_pending(generation))
                self._check_generation(generation)
                now = datetime.now(UTC).isoformat()
                stored = await self._database.async_get_alexa_state()
                self._check_generation(generation)
                status = {"last_checked": now, "last_error": errors[0] if errors else None, "imported_total": int(stored["status"].get("imported_total", 0)) + processed}
                if processed:
                    status["last_success"] = now
                await self._database.async_update_alexa_status(status)
            except Exception as error:
                self._check_generation(generation)
                await self._database.async_update_alexa_status({"last_checked": datetime.now(UTC).isoformat(), "last_error": str(error) or str(text("alexa.processing_failed"))})
                self._notify()
                raise
            self._notify()
        return {**(await self.async_get()), "processed": processed}

    async def _cleanup_pending(self, generation: int | None = None) -> list[str]:
        generation = self._generation if generation is None else generation
        self._check_generation(generation)
        errors = []
        snapshots = {}
        unavailable_sources = set()
        registry = er.async_get(self._hass)
        # A cloud outage must not hold a configuration save or HA unload for
        # minutes per receipt. The durable remainder is retried next minute.
        deadline = asyncio.get_running_loop().time() + 20
        pending = await self._database.async_list_alexa_pending_receipts()
        self._check_generation(generation)
        # Rotate retries so old, permanently failing rows cannot starve newer
        # receipts. The ledger remains durable; the cursor only orders work.
        if self._cleanup_cursor:
            offset = next((index + 1 for index, row in enumerate(pending)
                           if (row["source_id"], row["uid"]) == self._cleanup_cursor), 0)
            pending = pending[offset:] + pending[:offset]
        for receipt in pending[:10]:
            self._check_generation(generation)
            self._cleanup_cursor = (receipt["source_id"], receipt["uid"])
            if receipt["source_id"] in unavailable_sources:
                continue
            if asyncio.get_running_loop().time() >= deadline:
                break
            try:
                entry = registry.async_get(receipt["source_id"])
                if not self._valid_source(entry):
                    raise AlexaInboxError(text("alexa.source_invalid"))
                entity_id = entry.entity_id
                if entity_id not in snapshots:
                    try:
                        async with asyncio.timeout(max(0.01, deadline - asyncio.get_running_loop().time())):
                            snapshots[entity_id] = {row["uid"]: row for row in await self._read_source(entity_id)}
                    except Exception:
                        unavailable_sources.add(receipt["source_id"])
                        raise
                self._check_generation(generation)
                row = snapshots[entity_id].get(receipt["uid"])
                if row is not None:
                    if row["summary"] != receipt["original_name"]:
                        raise AlexaInboxError(text("alexa.cleanup_changed"))
                    action = receipt["cleanup_action"]
                    if action != "complete" or row["status"] != "completed":
                        data = {"entity_id": entity_id, "item": receipt["uid"]}
                        if action == "complete":
                            data["status"] = "completed"
                        async with asyncio.timeout(min(10, max(0.01, deadline - asyncio.get_running_loop().time()))):
                            await self._hass.services.async_call("todo", "update_item" if action == "complete" else "remove_item", data, blocking=True)
                await self._database.async_update_alexa_receipt(receipt["source_id"], receipt["uid"], "done")
            except Exception as error:
                self._check_generation(generation)
                message = str(error) or str(text("alexa.cleanup_failed"))
                await self._database.async_update_alexa_receipt(receipt["source_id"], receipt["uid"], "error", message)
                errors.append(message)
                if isinstance(error, TimeoutError):
                    break
        return errors
