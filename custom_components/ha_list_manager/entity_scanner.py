"""Entity scanner configuration and backend-only Home Assistant listeners."""
from __future__ import annotations

import asyncio
from hashlib import sha256
import logging
import re
from typing import Any

from .localization import async_prepare, text

_LOGGER = logging.getLogger(__name__)
SOURCE_TYPES = {"entity", "usb_mqtt"}


def validate_config(config: Any, source_type: str) -> dict:
    """Persist explicit attribute names, never executable templates or paths."""
    if not isinstance(config, dict):
        raise ValueError(text("entityscan.invalid"))
    entity_id = str(config.get("entity_id") or "").strip()
    if not re.fullmatch(r"[a-z_]+\.[a-z0-9_]+", entity_id):
        raise ValueError(text("entityscan.invalid"))
    result = {"entity_id": entity_id}
    for key in ("registry_entry_id", "barcode_attribute", "scan_id_attribute"):
        value = config.get(key) or ""
        if not isinstance(value, str) or len(value) > 200:
            raise ValueError(text("entityscan.invalid"))
        result[key] = value.strip()
    if source_type == "usb_mqtt":
        result.update(barcode_attribute="barcode", scan_id_attribute="scan_id")
    return result


def usb_scanners(hass) -> list[dict]:
    """Match the scanner's discovery identity, excluding manual lookup sensors."""
    from homeassistant.helpers import device_registry as dr, entity_registry as er

    devices = dr.async_get(hass)
    result = []
    for entity in er.async_get(hass).entities.values():
        if entity.platform != "mqtt" or not entity.entity_id.startswith("sensor."):
            continue
        device = devices.async_get(entity.device_id) if entity.device_id else None
        if not device or device.manufacturer != "Nisbo" or device.model != "USB HID MQTT Scanner":
            continue
        identifiers = {value for domain, value in device.identifiers
                       if domain == "mqtt" and value.startswith("usb_scanner_mqtt_")}
        if entity.unique_id not in {identifier + "_barcode" for identifier in identifiers}:
            continue
        result.append({"entity_id": entity.entity_id, "registry_entry_id": entity.id})
    return sorted(result, key=lambda item: item["entity_id"])


def prepare_config(hass, config, source_type):
    """Resolve and pin the registry identity on the HA event loop."""
    from homeassistant.helpers import entity_registry as er

    result = validate_config(config, source_type)
    registry = er.async_get(hass)
    # A registry ID from an existing binding wins over a now outdated entity ID.
    entry = (next((item for item in registry.entities.values() if item.id == result["registry_entry_id"]), None)
             if result["registry_entry_id"] else registry.async_get(result["entity_id"]))
    if result["registry_entry_id"] and entry is None:
        raise ValueError(text("entityscan.invalid"))
    if entry:
        result.update(entity_id=entry.entity_id, registry_entry_id=entry.id)
    elif hass.states.get(result["entity_id"]) is None:
        raise ValueError(text("entityscan.invalid"))
    if source_type == "usb_mqtt" and result["entity_id"] not in {row["entity_id"] for row in usb_scanners(hass)}:
        raise ValueError(text("entityscan.not_usb"))
    return result


class EntityScannerSources:
    """Track only configured entities; startup values never trigger a booking."""

    def __init__(self, manager):
        self.manager = manager
        self.hass = manager.hass
        self.bindings = {}
        self.baselines = {}
        self.unsubs = []
        self.listeners = []
        self.recording = False
        self.started = False
        self.lock = asyncio.Lock()

    async def async_refresh(self):
        async with self.lock:
            await self._refresh()

    async def _refresh(self):
        rows = [row for row in await self.manager.database.async_list_scanners()
                if row.enabled and row.source_type in SOURCE_TYPES]
        if self.manager._stopped:
            return
        if not rows:
            self.stop()
            return
        from homeassistant.core import callback
        from homeassistant.helpers import entity_registry as er
        from homeassistant.helpers.start import async_at_started

        bindings = {}
        for row in rows:
            try:
                config = prepare_config(self.hass, row.entity, row.source_type)
            except ValueError:
                continue  # Removed entities stay configured, but cannot book.
            bindings[config["entity_id"]] = (row, config)
        old = self.bindings
        self.bindings = bindings
        for entity_id, (row, config) in bindings.items():
            if old.get(entity_id) != (row, config):
                state = self.hass.states.get(entity_id)
                self.baselines[row.id] = self._scan_id(state, config)
                await self._remember_baseline(row, state, config)
        self.baselines = {row.id: self.baselines.get(row.id, "") for row, config in bindings.values()}
        if self.manager._stopped:
            self.stop()
            return
        if not self.started:
            self.started = True

            @callback
            def registry_updated(event):
                if not self.manager._stopped:
                    self.manager._track_scan_task(self.async_refresh())

            self.unsubs.append(self.hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, registry_updated))
            @callback
            def start(hass):
                self._start(hass)

            self.unsubs.append(async_at_started(self.hass, start))
        if self.recording:
            self._listen()

    def _start(self, hass):
        if not self.started or self.manager._stopped:
            return
        self.recording = True
        for entity_id, (row, config) in self.bindings.items():
            state = hass.states.get(entity_id)
            self.baselines[row.id] = self._scan_id(state, config)
            self.manager._track_scan_task(self._remember_baseline(row, state, config))
        self._listen()

    def _listen(self):
        from homeassistant.helpers.event import async_track_state_change_event, async_track_state_report_event
        from homeassistant.core import callback
        for unsub in self.listeners:
            unsub()
        self.listeners.clear()
        if self.bindings:
            # HA reports unchanged writes separately from changed states.
            @callback
            def handler(event):
                self._event(event)
            entities = frozenset(self.bindings)
            self.listeners.extend((async_track_state_change_event(self.hass, entities, handler),
                                   async_track_state_report_event(self.hass, entities, handler)))

    @staticmethod
    def _scan_id(state, config):
        if not state or not config["scan_id_attribute"]:
            return ""
        value = state.attributes.get(config["scan_id_attribute"])
        return str(value).strip() if isinstance(value, (str, int)) and not isinstance(value, bool) else ""

    @staticmethod
    def _identity(row, scan_id):
        source = row.entity.get("registry_entry_id") or row.entity["entity_id"]
        return sha256(("entity\0" + source + "\0" + scan_id).encode()).hexdigest()

    async def _remember_baseline(self, row, state, config):
        scan_id = self._scan_id(state, config)
        if not scan_id:
            return
        barcode = state.attributes.get(config["barcode_attribute"]) if config["barcode_attribute"] else state.state
        async with self.manager._scan_operation("entity-input"):
            # Remember ignored startup IDs too: a late retained replay after a
            # subsequent restart must not turn an old value into a new scan.
            await self.manager.database.async_claim_mqtt_scan(row.id,
                self._identity(row, scan_id), str(barcode or ""), finished=True)

    def _event(self, event):
        binding = self.bindings.get(event.data.get("entity_id"))
        state = event.data.get("new_state")
        if not self.recording or self.manager._stopped or not binding or state is None:
            return
        if state.state in {"unknown", "unavailable"} or state.attributes.get("restored"):
            return
        row, config = binding
        barcode = state.attributes.get(config["barcode_attribute"]) if config["barcode_attribute"] else state.state
        scan_id = self._scan_id(state, config)
        if config["scan_id_attribute"]:
            if not scan_id or scan_id == self.baselines.get(row.id):
                return
            self.baselines[row.id] = scan_id
        elif event.data.get("old_state") is not None:
            old = event.data["old_state"]
            old_code = old.attributes.get(config["barcode_attribute"]) if config["barcode_attribute"] else old.state
            if old_code == barcode and old.attributes != state.attributes:
                return  # Attribute-only changes without a scan ID are not scans.
            # Identical force_update state changes are genuine reports too.
        # Copy values now: State.last_reported may mutate before a task runs.
        self.manager._track_scan_task(self.async_process(row, barcode, scan_id))

    async def async_process(self, row, barcode, scan_id):
        from .scanner import normalize_ean, parse_inventory_control_code

        await async_prepare(self.hass)
        if not isinstance(barcode, str):
            return  # Numeric states lose leading zeroes; booleans are not codes.
        try:
            barcode = barcode.strip()
            if not parse_inventory_control_code(barcode):
                barcode = normalize_ean(barcode)
        except ValueError:
            return
        async with self.manager._scan_operation("entity-input"):
            # Recheck after waiting: a disabled or deleted scanner must not book.
            current = next((item for item in await self.manager.database.async_list_scanners() if item.id == row.id), None)
            if current != row:
                return
            identity = self._identity(row, scan_id) if scan_id else None
            if identity and not await self.manager.database.async_claim_mqtt_scan(row.id, identity, barcode):
                return
            try:
                return await self.manager.async_process_scan(ean=barcode, scanner_id=row.id,
                    address=row.address, source=row.source_type)
            except Exception:
                _LOGGER.exception("Entity scan failed for scanner %s", row.id)
                await self.manager._history(scanner=row, address=row.address, source=row.source_type,
                    ean=barcode, action=None, list_id=None, status="error", message=text("entityscan.failed"))
            finally:
                if identity:
                    await self.manager.database.async_finish_mqtt_scan(row.id, identity)

    def stop(self):
        self.started = self.recording = False
        for unsub in self.listeners + self.unsubs:
            unsub()
        self.listeners.clear()
        self.unsubs.clear()
        self.bindings.clear()
        self.baselines.clear()
