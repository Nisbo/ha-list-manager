"""Synchronize externally owned shopping lists with local HA-LM metadata."""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import replace
import logging
from collections.abc import Iterable
from typing import Any
import unicodedata

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from .localization import text as localized_text
from .bring_quantity import (
    format_bring_description,
    parse_bring_details,
    parse_bring_quantity,
)
from .const import EVENT_ITEMS_CHANGED
from .database import HaListManagerDatabase
from .models import ListItemRecord, ListRecord

_LOGGER = logging.getLogger(__name__)


class ExternalListError(HomeAssistantError):
    """Raised when an external shopping list cannot be synchronized."""


class ExternalListManager:
    """Keep Bring entries and locally stored categories/labels together."""

    def __init__(
        self, hass: HomeAssistant, database: HaListManagerDatabase
    ) -> None:
        self._hass = hass
        self._database = database
        self._locks: dict[str, asyncio.Lock] = {}
        self._unsubscribe_state = None

    async def async_start(self) -> None:
        """Refresh linked lists when their official Bring entity changes."""
        if self._unsubscribe_state is not None:
            return

        @callback
        def handle_state_changed(event: Event) -> None:
            entity_id = str(event.data.get("entity_id") or "")
            if not entity_id.startswith("todo."):
                return
            registry_entry = er.async_get(self._hass).async_get(entity_id)
            if registry_entry is None or registry_entry.platform != "bring":
                return
            self._hass.async_create_task(self._async_sync_entity(entity_id))

        self._unsubscribe_state = self._hass.bus.async_listen(
            "state_changed", handle_state_changed
        )

    async def async_stop(self) -> None:
        """Stop listening for Bring entity updates."""
        if self._unsubscribe_state is not None:
            self._unsubscribe_state()
            self._unsubscribe_state = None

    def validate_bring_entity(self, entity_id: str) -> None:
        """Require an existing Bring To-do entity, not an HA-LM proxy entity."""
        if not entity_id.startswith("todo."):
            raise ValueError(localized_text("backend.bring_todo_required"))
        registry_entry = er.async_get(self._hass).async_get(entity_id)
        if registry_entry is None or registry_entry.platform != "bring":
            raise ValueError(localized_text("backend.bring_entity_required"))

    async def async_sync(
        self, list_id: str, *, refresh_source: bool = True
    ) -> list[ListItemRecord]:
        """Refresh one external list and reconcile its local metadata rows."""
        async with self._lock(list_id):
            record = await self._require_bring_list(list_id)
            await self._database.async_mark_external_sync_attempt(list_id)
            try:
                remote_items = await self._fetch_items(
                    record, refresh_source=refresh_source
                )
                changed = await self._reconcile(record, remote_items)
            except Exception as error:
                try:
                    await self._database.async_mark_external_sync_error(
                        list_id, str(error)
                    )
                except Exception:
                    _LOGGER.exception(
                        "Could not persist Bring sync error for %s", list_id
                    )
                raise
            await self._database.async_mark_external_sync_success(
                list_id, changed=changed
            )
            if changed:
                self._fire_changed(list_id)
            return [
                self._public_item(item)
                for item in await self._database.async_list_items(list_id)
            ]

    async def async_create_item(
        self,
        list_id: str,
        *,
        name: str,
        description: str | None,
        quantity: int,
        category_id: str | None,
        category: str | None,
        label_ids: list[str],
        product_id: str | None,
        offer_only: bool = False,
    ) -> ListItemRecord:
        """Create a clean Bring item and keep HA-LM metadata locally."""
        async with self._lock(list_id):
            record = await self._require_bring_list(list_id)
            before = await self._fetch_items(record)
            if record.capitalize_first_letter and not product_id:
                name = name[:1].upper() + name[1:]
            remote_description = self._description_for_quantity(quantity, description)
            await self._call_todo(
                "add_item",
                record.external_entity_id,
                {"item": name, "description": remote_description},
            )
            after = await self._fetch_items(record)
            external = self._find_created(before, after, name)
            if external is None:
                raise ExternalListError(
                    localized_text("backend.bring_item_id_missing")
                )
            created = await self._database.async_create_item(
                list_id,
                name,
                remote_description,
                quantity,
                category_id,
                category,
                None,
                label_ids,
                product_id,
                self._uid(external),
                offer_only=offer_only,
            )
            await self._database.async_mark_external_sync_success(
                list_id, changed=True
            )
            self._fire_changed(list_id)
            return self._public_item(created)

    async def async_update_item(
        self, item_id: str, **updates: Any
    ) -> ListItemRecord:
        """Update Bring first, then retain local metadata on the same row."""
        existing = await self._database.async_get_item(item_id)
        async with self._lock(existing.list_id):
            list_record = await self._require_bring_list(existing.list_id)
            if not existing.external_uid:
                await self._reconcile(list_record, await self._fetch_items(list_record))
                existing = await self._database.async_get_item(item_id)
            if not existing.external_uid:
                raise ExternalListError(localized_text("backend.local_bring_id_missing"))

            before = await self._fetch_items(list_record)
            name = str(updates["name"])
            if list_record.capitalize_first_letter and not updates.get("product_id", existing.product_id):
                name = name[:1].upper() + name[1:]
                updates["name"] = name
            quantity = int(updates["quantity"])
            description = self._description_for_quantity(
                quantity, updates.get("description")
            )
            service_data: dict[str, Any] = {
                "item": existing.external_uid,
                "status": "completed" if updates["completed"] else "needs_action",
                "description": description,
            }
            if name != existing.name:
                service_data["rename"] = name
            await self._call_todo(
                "update_item", list_record.external_entity_id, service_data
            )
            after = await self._fetch_items(list_record)
            external_uid = existing.external_uid
            if not any(self._uid(item) == external_uid for item in after):
                renamed = self._find_created(before, after, name)
                if renamed is None:
                    raise ExternalListError(
                        localized_text("backend.bring_changed_id_ambiguous")
                    )
                external_uid = self._uid(renamed)

            updates["description"] = description
            updates["external_uid"] = external_uid
            updated = await self._database.async_update_item(item_id, **updates)
            await self._database.async_mark_external_sync_success(
                updated.list_id, changed=True
            )
            self._fire_changed(updated.list_id)
            return self._public_item(updated)

    async def async_set_completed(
        self, item_id: str, completed: bool
    ) -> ListItemRecord:
        """Move a Bring item between active and recently used."""
        existing = await self._database.async_get_item(item_id)
        async with self._lock(existing.list_id):
            list_record = await self._require_bring_list(existing.list_id)
            if not existing.external_uid:
                raise ExternalListError(localized_text("backend.local_bring_id_missing"))
            await self._call_todo(
                "update_item",
                list_record.external_entity_id,
                {
                    "item": existing.external_uid,
                    "status": "completed" if completed else "needs_action",
                },
            )
            updated = await self._database.async_set_item_completed(item_id, completed)
            await self._database.async_mark_external_sync_success(
                updated.list_id, changed=True
            )
            self._fire_changed(updated.list_id)
            return self._public_item(updated)

    async def async_delete_item(self, item_id: str) -> str:
        """Permanently remove an item from Bring and the local metadata store."""
        existing = await self._database.async_get_item(item_id)
        async with self._lock(existing.list_id):
            list_record = await self._require_bring_list(existing.list_id)
            if existing.external_uid:
                await self._call_todo(
                    "remove_item",
                    list_record.external_entity_id,
                    {"item": existing.external_uid},
                )
            list_id = await self._database.async_delete_item(item_id)
            await self._database.async_delete_external_item_metadata(
                list_id, self._match_key(existing.name)
            )
            await self._database.async_mark_external_sync_success(
                list_id, changed=True
            )
            self._fire_changed(list_id)
            return list_id

    async def _reconcile(
        self, list_record: ListRecord, remote_items: list[dict[str, Any]]
    ) -> bool:
        local_items = await self._database.async_list_items(list_record.id)
        local_by_uid = {
            item.external_uid: item for item in local_items if item.external_uid
        }
        remote_by_uid = {
            self._uid(item): item for item in remote_items if self._uid(item)
        }
        changed = False

        missing_locals = [
            local for uid, local in local_by_uid.items() if uid not in remote_by_uid
        ]
        missing_name_counts = Counter(
            self._match_key(local.name) for local in missing_locals
        )
        for local in missing_locals:
            match_key = self._match_key(local.name)
            if match_key and missing_name_counts[match_key] == 1:
                await self._database.async_archive_external_item(local.id, match_key)
            else:
                _LOGGER.warning(
                    "Not archiving ambiguous Bring metadata for %s in %s",
                    local.name,
                    list_record.id,
                )
                await self._database.async_delete_item(local.id)
            changed = True

        remote_name_counts = Counter(
            self._match_key(self._summary(remote))
            for remote in remote_by_uid.values()
        )

        for uid, remote in remote_by_uid.items():
            local = local_by_uid.get(uid)
            description = self._description(remote)
            quantity = self._quantity(description)
            completed = self._completed(remote)
            name = self._summary(remote)
            if local is None:
                match_key = self._match_key(name)
                metadata = None
                if match_key and remote_name_counts[match_key] == 1:
                    metadata = await self._database.async_get_external_item_metadata(
                        list_record.id, match_key
                    )
                elif match_key:
                    _LOGGER.warning(
                        "Not restoring ambiguous Bring metadata for %s in %s",
                        name,
                        list_record.id,
                    )
                await self._database.async_create_item(
                    list_record.id,
                    name,
                    description,
                    quantity,
                    metadata["category_id"] if metadata else None,
                    metadata["category"] if metadata else None,
                    None,
                    metadata["label_ids"] if metadata else [],
                    metadata["product_id"] if metadata else None,
                    uid,
                )
                if metadata:
                    await self._database.async_delete_external_item_metadata(
                        list_record.id, match_key
                    )
                changed = True
                continue
            if (
                local.name != name
                or local.description != description
                or local.quantity != quantity
                or local.completed != completed
            ):
                await self._database.async_update_item(
                    local.id,
                    name=name,
                    description=description,
                    quantity=quantity,
                    category_id=local.category_id,
                    category=local.category,
                    due_at=local.due_at,
                    completed=completed,
                    label_ids=[label.id for label in local.labels],
                    product_id=local.product_id,
                    external_uid=uid,
                )
                changed = True

        return changed

    async def _fetch_items(
        self, record: ListRecord, *, refresh_source: bool = True
    ) -> list[dict[str, Any]]:
        entity_id = record.external_entity_id
        if not entity_id:
            raise ExternalListError(localized_text("backend.bring_entity_missing"))
        try:
            if refresh_source:
                await self._hass.services.async_call(
                    "homeassistant",
                    "update_entity",
                    {"entity_id": [entity_id]},
                    blocking=True,
                )
            items: dict[str, dict[str, Any]] = {}
            for status in ("needs_action", "completed"):
                response = await self._hass.services.async_call(
                    "todo",
                    "get_items",
                    {"status": status},
                    target={"entity_id": entity_id},
                    blocking=True,
                    return_response=True,
                )
                for item in self._response_items(response, entity_id):
                    uid = self._uid(item)
                    if uid:
                        items[uid] = item
        except HomeAssistantError as error:
            raise ExternalListError(
                localized_text("backend.bring_update_failed", p0=entity_id, p1=error)
            ) from error
        return list(items.values())

    async def _call_todo(
        self, service: str, entity_id: str | None, data: dict[str, Any]
    ) -> None:
        if not entity_id:
            raise ExternalListError(localized_text("backend.bring_entity_missing"))
        try:
            await self._hass.services.async_call(
                "todo", service, data, target={"entity_id": entity_id}, blocking=True
            )
        except HomeAssistantError as error:
            raise ExternalListError(
                localized_text("backend.bring_list_update_failed", p0=entity_id, p1=error)
            ) from error

    async def _async_sync_entity(self, entity_id: str) -> None:
        """Synchronize every local link that points at one changed Bring entity."""
        records = await self._database.async_list_lists()
        for record in records:
            if record.provider != "bring" or record.external_entity_id != entity_id:
                continue
            try:
                await self.async_sync(record.id, refresh_source=False)
            except ExternalListError as error:
                _LOGGER.warning("Could not synchronize %s: %s", entity_id, error)

    async def _require_bring_list(self, list_id: str) -> ListRecord:
        record = await self._database.async_get_list(list_id)
        if record.provider != "bring":
            raise ExternalListError(localized_text("backend.not_bring_list"))
        return record

    def _lock(self, list_id: str) -> asyncio.Lock:
        return self._locks.setdefault(list_id, asyncio.Lock())

    def _fire_changed(self, list_id: str) -> None:
        self._hass.bus.async_fire(EVENT_ITEMS_CHANGED, {"list_id": list_id})

    @classmethod
    def _response_items(cls, response: Any, entity_id: str) -> Iterable[dict[str, Any]]:
        # Missing or malformed results are not an empty remote list. Treating
        # them as empty would let reconciliation remove valid local entries.
        if not isinstance(response, dict):
            raise ExternalListError(localized_text("backend.bring_response_invalid"))
        payload = response.get(entity_id, response)
        if not isinstance(payload, dict):
            raise ExternalListError(localized_text("backend.bring_response_invalid"))
        values = payload.get("items")
        if not isinstance(values, list) or any(
            not isinstance(item, dict) or not cls._uid(item) for item in values
        ):
            raise ExternalListError(localized_text("backend.bring_response_invalid"))
        return values

    @staticmethod
    def _uid(item: dict[str, Any]) -> str:
        return str(item.get("uid") or "").strip()

    @staticmethod
    def _summary(item: dict[str, Any]) -> str:
        return str(item.get("summary") or "").strip()

    @staticmethod
    def _match_key(name: str) -> str:
        """Create a stable exact-name key without guessing fuzzy matches."""
        normalized = unicodedata.normalize("NFKC", str(name or ""))
        return " ".join(normalized.casefold().split())

    @staticmethod
    def _description(item: dict[str, Any]) -> str | None:
        value = str(item.get("description") or "").strip()
        return value or None

    @staticmethod
    def _completed(item: dict[str, Any]) -> bool:
        status = item.get("status")
        value = getattr(status, "value", status)
        return str(value) == "completed"

    @staticmethod
    def _quantity(description: str | None) -> int:
        return parse_bring_quantity(description)

    @staticmethod
    def _description_for_quantity(
        quantity: int, description: str | None
    ) -> str | None:
        return format_bring_description(quantity, description)

    @staticmethod
    def _public_item(item: ListItemRecord) -> ListItemRecord:
        """Expose Bring details without its serialized item-count prefix."""
        return replace(item, description=parse_bring_details(item.description))

    @classmethod
    def _find_created(
        cls,
        before: list[dict[str, Any]],
        after: list[dict[str, Any]],
        name: str,
    ) -> dict[str, Any] | None:
        before_uids = {cls._uid(item) for item in before}
        candidates = [
            item
            for item in after
            if cls._uid(item) not in before_uids
            and cls._summary(item).casefold() == name.casefold()
        ]
        return candidates[0] if len(candidates) == 1 else None
