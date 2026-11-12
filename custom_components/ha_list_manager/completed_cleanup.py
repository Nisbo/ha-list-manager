"""Delete completed local shopping entries at their persisted deadlines."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import logging

from homeassistant.core import callback

from .const import EVENT_ITEM_MUTATED, EVENT_ITEMS_CHANGED, EVENT_LISTS_CHANGED

_LOGGER = logging.getLogger(__name__)


class CompletedCleanupManager:
    """Own one cancellable worker; no per-item tasks or open database handles."""

    def __init__(self, hass, database, entry):
        self.hass, self.database, self.entry = hass, database, entry
        self._wake = asyncio.Event()
        self._unsubs = []
        self._task = None
        self._stopped = False

    async def async_start(self):
        for event in (EVENT_ITEM_MUTATED, EVENT_ITEMS_CHANGED, EVENT_LISTS_CHANGED):
            self._unsubs.append(self.hass.bus.async_listen(event, self._changed))
        if self.hass.is_running:
            self._start_worker()
        else:
            self._unsubs.append(self.hass.bus.async_listen_once("homeassistant_started", self._start_worker))

    @callback
    def _start_worker(self, _event=None):
        if not self._stopped and self._task is None:
            self._task = self.entry.async_create_background_task(
                self.hass, self._run(), "HA List Manager completed-item cleanup"
            )

    @callback
    def _changed(self, _event):
        self._wake.set()

    async def async_stop(self):
        self._stopped = True
        for unsubscribe in self._unsubs:
            unsubscribe()
        self._unsubs.clear()
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _run(self):
        while not self._stopped:
            self._wake.clear()
            try:
                result = await self.database.async_delete_due_completed_items()
                for list_id in {item.list_id for item in result["items"]}:
                    self.hass.bus.async_fire(EVENT_ITEMS_CHANGED, {"list_id": list_id})
                deadline = result["next_deadline"]
                # Recheck pending deadlines each minute to handle clock corrections.
                timeout = min(60, max(0, (datetime.fromisoformat(deadline) - datetime.now(UTC)).total_seconds())) if deadline else None
            except asyncio.CancelledError:
                raise
            except Exception:
                _LOGGER.exception("Could not process completed-item cleanup; retrying")
                timeout = 30
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
            except TimeoutError:
                pass
