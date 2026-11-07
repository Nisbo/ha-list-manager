"""Independent, opt-in history storage for Home Assistant entities."""

from __future__ import annotations

import asyncio
from datetime import datetime
import logging
from typing import TYPE_CHECKING, Any

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import CoreState, Event, HomeAssistant, State, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_state_report_event
from homeassistant.helpers.start import async_at_started

from .database import (
    EntityHistoryRenameConflictError,
    HaListManagerDatabase,
)

if TYPE_CHECKING:
    from collections.abc import Callable

_LOGGER = logging.getLogger(__name__)


class EntityHistoryManager:
    """Record selected state-machine entities without using Recorder."""

    def __init__(
        self, hass: HomeAssistant, database: HaListManagerDatabase
    ) -> None:
        self._hass = hass
        self._database = database
        self._configured: set[str] = set()
        self._tracked: set[str] = set()
        self._unsubs: list[Callable[[], None]] = []
        self._tasks: set[asyncio.Task[Any]] = set()
        self._started = False
        self._recording = False
        self._report_unsub: Callable[[], None] | None = None
        self._report_entities: frozenset[str] = frozenset()

    async def async_start(self) -> None:
        """Load sources now; subscribe to measurements only after HA startup."""
        await self.async_refresh()
        self._unsubs = [
            self._hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED,
                self._entity_registry_updated,
            ),
        ]
        self._started = True
        await self._async_reconcile_entity_registry()
        self._unsubs.append(async_at_started(self._hass, self._start_recording))

    @callback
    def _start_recording(self, hass: HomeAssistant) -> None:
        """Startup state restoration is a baseline, never a new measurement."""
        if not self._started or self._recording:
            return
        self._recording = True
        self._unsubs.append(hass.bus.async_listen(EVENT_STATE_CHANGED, self._state_changed))
        self._refresh_report_listener()

    async def async_stop(self) -> None:
        """Stop listening and finish already queued database writes."""
        self._started = False
        self._recording = False
        if self._report_unsub:
            self._report_unsub()
            self._report_unsub = None
        self._report_entities = frozenset()
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        self._tasks.clear()

    async def async_refresh(self) -> None:
        """Refresh the small in-memory entity-id filter."""
        records = await self._database.async_list_tracked_entities()
        self._configured = {record.entity_id for record in records}
        self._tracked = {
            record.entity_id for record in records if record.enabled
        }
        if self._started:
            self._refresh_report_listener()

    @callback
    def _refresh_report_listener(self) -> None:
        """Subscribe only to tracked sources; global report listeners are forbidden."""
        entity_ids = frozenset(self._tracked) if self._recording else frozenset()
        if entity_ids == self._report_entities:
            return
        if self._report_unsub:
            self._report_unsub()
            self._report_unsub = None
        self._report_entities = entity_ids
        if entity_ids:
            self._report_unsub = async_track_state_report_event(
                self._hass, entity_ids, self._state_reported
            )

    async def async_set_tracking(
        self, entity_id: str, enabled: bool | None = None, *,
        ignore_unavailable: bool | None = None,
        use_ha_precision: bool | None = None,
    ) -> None:
        """Persist tracking state and capture the current state when enabled."""
        was_enabled = entity_id in self._tracked
        registry_entry = er.async_get(self._hass).async_get(entity_id)
        registry_entry_id = registry_entry.id if registry_entry else None
        if registry_entry_id:
            records = await self._database.async_list_tracked_entities()
            previous = next(
                (
                    record
                    for record in records
                    if record.registry_entry_id == registry_entry_id
                    and record.entity_id.casefold() != entity_id.casefold()
                ),
                None,
            )
            if previous:
                await self._database.async_rename_tracked_entity(
                    previous.entity_id, entity_id, registry_entry_id
                )
        await self._database.async_set_entity_tracking(
            entity_id, enabled, registry_entry_id,
            ignore_unavailable=ignore_unavailable, use_ha_precision=use_ha_precision,
        )
        await self.async_refresh()
        if enabled and not was_enabled and self._hass.state is CoreState.running:
            state = self._hass.states.get(entity_id)
            if state is not None:
                await self._async_record(state, initial=True)

    @callback
    def _state_changed(self, event: Event) -> None:
        entity_id = event.data.get("entity_id")
        state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if (
            not self._recording or self._hass.state is not CoreState.running
            or entity_id not in self._tracked or not isinstance(state, State)
            or old_state is None or old_state.attributes.get("restored")
        ):
            return
        self._create_task(
            self._async_record(state),
            f"{entity_id} entity history snapshot",
        )

    @callback
    def _state_reported(self, event: Event) -> None:
        state = event.data.get("new_state")
        reported_at = event.data.get("last_reported")
        if (
            not self._recording or self._hass.state is not CoreState.running
            or event.data.get("entity_id") not in self._tracked
            or not isinstance(state, State)
            or not isinstance(reported_at, datetime)
        ):
            return
        # State.last_reported is mutable: a later identical write can change it
        # before our database task runs. The event's timestamp is immutable.
        self._create_task(
            self._async_record(state, reported_at=reported_at),
            f"{state.entity_id} entity history report",
        )

    @callback
    def _entity_registry_updated(self, event: Event) -> None:
        if event.data.get("action") != "update":
            return
        old_entity_id = event.data.get("old_entity_id")
        new_entity_id = event.data.get("entity_id")
        if (
            not isinstance(old_entity_id, str)
            or not isinstance(new_entity_id, str)
            or old_entity_id not in self._configured
        ):
            return
        self._create_task(
            self._async_rename_entity(old_entity_id, new_entity_id),
            f"{old_entity_id} entity history rename",
        )

    def _create_task(self, coroutine: Any, name: str) -> None:
        task = self._hass.async_create_task(coroutine, name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _async_reconcile_entity_registry(self) -> None:
        """Backfill stable IDs and catch renames missed while unloaded."""
        registry = er.async_get(self._hass)
        entries_by_id = {entry.id: entry for entry in registry.entities.values()}
        for record in await self._database.async_list_tracked_entities():
            try:
                if record.registry_entry_id:
                    current = entries_by_id.get(record.registry_entry_id)
                    if (
                        current
                        and current.entity_id.casefold()
                        != record.entity_id.casefold()
                    ):
                        await self._database.async_rename_tracked_entity(
                            record.entity_id,
                            current.entity_id,
                            record.registry_entry_id,
                        )
                    continue
                current = registry.async_get(record.entity_id)
                if current:
                    await self._database.async_set_entity_registry_id(
                        record.entity_id, current.id
                    )
            except EntityHistoryRenameConflictError:
                _LOGGER.exception(
                    "Could not reconcile tracked entity %s with the entity registry",
                    record.entity_id,
                )
        await self.async_refresh()

    async def _async_rename_entity(
        self, old_entity_id: str, new_entity_id: str
    ) -> None:
        registry_entry = er.async_get(self._hass).async_get(new_entity_id)
        if registry_entry is None:
            _LOGGER.warning(
                "Entity registry reported rename from %s to %s without an entry",
                old_entity_id,
                new_entity_id,
            )
            return
        try:
            renamed = await self._database.async_rename_tracked_entity(
                old_entity_id, new_entity_id, registry_entry.id
            )
        except EntityHistoryRenameConflictError:
            _LOGGER.exception(
                "Could not migrate entity history from %s to %s",
                old_entity_id,
                new_entity_id,
            )
            return
        if not renamed:
            return
        await self.async_refresh()
        _LOGGER.info(
            "Migrated tracked entity history from %s to %s",
            old_entity_id,
            new_entity_id,
        )

    async def _async_record(
        self, state: State, *, initial: bool = False,
        reported_at: datetime | None = None,
    ) -> None:
        if self._hass.state is not CoreState.running or state.attributes.get("restored"):
            return
        try:
            # For an unchanged report the archive point belongs at the new
            # report time, not at the old State.last_updated time.
            timestamp = reported_at or state.last_updated
            await self._database.async_record_entity_state(
                entity_id=state.entity_id,
                state=state.state,
                attributes=dict(state.attributes),
                last_changed=state.last_changed.isoformat(),
                last_updated=timestamp.isoformat(),
                last_reported=timestamp.isoformat(),
                initial=initial,
            )
        except (TypeError, ValueError):
            _LOGGER.exception(
                "Could not serialize the state of tracked entity %s",
                state.entity_id,
            )

