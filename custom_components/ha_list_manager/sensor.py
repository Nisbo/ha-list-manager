"""Stable list-anchor sensors for HA List Manager."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import EVENT_INVENTORY_CHANGED, EVENT_ITEMS_CHANGED, EVENT_LISTS_CHANGED
from .models import ListRecord
from .runtime import HaListManagerRuntime


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry[HaListManagerRuntime],
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Expose each enabled backend list as one non-owning sensor anchor."""
    runtime = entry.runtime_data
    entities: dict[str, HaListManagerListSensor] = {}

    async def sync_entities() -> None:
        records = {
            record.id: record
            for record in await runtime.database.async_list_lists()
            if record.enabled
        }
        for list_id, entity in list(entities.items()):
            if list_id not in records:
                entities.pop(list_id)
                await entity.async_remove()
                continue
            entity.update_record(records[list_id])
        additions = [
            HaListManagerListSensor(runtime, record)
            for list_id, record in records.items()
            if list_id not in entities
        ]
        if additions:
            entities.update({entity.list_id: entity for entity in additions})
            async_add_entities(additions, True)

    await sync_entities()

    @callback
    def handle_lists_changed(_event: Event) -> None:
        hass.async_create_task(sync_entities())

    entry.async_on_unload(hass.bus.async_listen(EVENT_LISTS_CHANGED, handle_lists_changed))


class HaListManagerListSensor(SensorEntity):
    """Summary entity and stable selector target for one backend list."""

    _attr_has_entity_name = False
    _attr_should_poll = False
    _attr_icon = "mdi:package-variant-closed"

    def __init__(self, runtime: HaListManagerRuntime, record: ListRecord) -> None:
        self._runtime = runtime
        self._record = record
        self._entries: list[Any] = []
        self._attr_unique_id = (
            f"inventory_{record.id}"
            if record.list_type == "inventory"
            else f"list_{record.id}"
        )
        self._apply_record()

    @property
    def list_id(self) -> str:
        """Return the backend list identifier."""
        return self._record.id

    def update_record(self, record: ListRecord) -> None:
        """Apply an updated list name or icon without recreating the entity."""
        self._record = record
        self._apply_record()
        if self.hass:
            self.async_write_ha_state()

    def _apply_record(self) -> None:
        self._attr_name = self._record.name
        semantic_type = self._semantic_type
        self._attr_icon = self._record.icon or {
            "shopping": "mdi:cart-outline",
            "bring": "mdi:cart-arrow-down",
            "todo": "mdi:checkbox-marked-outline",
            "inventory": "mdi:package-variant-closed",
        }.get(semantic_type, "mdi:format-list-bulleted")

    @property
    def _semantic_type(self) -> str:
        return "bring" if self._record.provider == "bring" else self._record.list_type

    @property
    def native_value(self) -> int:
        """Return stock rows or open list entries, depending on list type."""
        if self._record.list_type == "inventory":
            return len(self._entries)
        return sum(not item.completed for item in self._entries)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the backend identity used by the Lovelace card."""
        attributes = {
            "list_id": self._record.id,
            "list_type": self._semantic_type,
            "provider": self._record.provider,
            "external_entity_id": self._record.external_entity_id,
        }
        if self._record.list_type == "inventory":
            attributes.update(
                {
                    "total_stock": sum(item.stock for item in self._entries),
                    "below_minimum": sum(
                        item.minimum_stock is not None
                        and item.stock < item.minimum_stock
                        for item in self._entries
                    ),
                }
            )
        else:
            attributes.update(
                {
                    "total_items": len(self._entries),
                    "completed_items": sum(
                        item.completed for item in self._entries
                    ),
                }
            )
        return attributes

    async def async_added_to_hass(self) -> None:
        """Listen for content changes affecting this list."""
        await super().async_added_to_hass()

        @callback
        def handle_list_changed(event: Event) -> None:
            if event.data.get("list_id") == self.list_id:
                self.hass.async_create_task(self.async_update_ha_state(True))

        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_INVENTORY_CHANGED, handle_list_changed)
        )
        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_ITEMS_CHANGED, handle_list_changed)
        )

    async def async_update(self) -> None:
        """Refresh summary data from the integration database."""
        if self._record.list_type == "inventory":
            self._entries = await self._runtime.database.async_list_inventory(self.list_id)
        else:
            self._entries = await self._runtime.database.async_list_items(self.list_id)
