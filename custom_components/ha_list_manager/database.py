"""SQLite persistence for HA List Manager."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import copy_context
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
import logging
import math
from pathlib import Path
import re
import sqlite3
import time
from dataclasses import replace
from typing import TYPE_CHECKING, Any, TypeVar
import unicodedata
from uuid import uuid4

from .localization import async_use_language, text as localized_text
from .const import (
    DATABASE_SCHEMA_VERSION,
    EVENT_ITEM_MUTATED,
    EVENT_SCRIPT_ACTION,
    LIST_TYPES,
    SCANNER_ACTIONS,
    SCANNER_ROUTING,
)
from .script_events import SCRIPT_OPERATION, SCRIPT_CHAIN, event_options, item_script_action
from .models import (
    CategoryRecord,
    ChipRecord,
    DishItemRecord,
    DishRecord,
    EntityStateRecord,
    InventoryGroupRecord,
    InventoryRecord,
    InventoryRestockSettingsRecord,
    LabelRecord,
    ListItemRecord,
    ListNotificationAssignmentRecord,
    ListRecord,
    NotificationPendingBatchRecord,
    NotificationProfileRecord,
    ProductCategoryAssignmentRecord,
    ProductRecord,
    ScannerRecord,
    ScannerTargetRecord,
    ScanHistoryRecord,
    TrackedEntityRecord,
)

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

_T = TypeVar("_T")
_UNSET = object()
_ALEXA_HISTORY_COLUMNS = (
    "source_id,uid,source_entity_id,target_list_id,item_id,original_name,"
    "name,description,quantity,cleanup_action,cleanup_status,created_at,cleaned_at,last_error"
)


def _product_text(value: str | None) -> str:
    """Compare products without changing their stored spelling or accents."""
    return "".join(
        character
        for character in unicodedata.normalize("NFKD", (value or "").casefold())
        if not unicodedata.combining(character)
    )


class HaListManagerDatabaseError(Exception):
    """Base class for database errors."""


class DuplicateListNameError(HaListManagerDatabaseError):
    """Raised when a list name already exists."""


class ListNotFoundError(HaListManagerDatabaseError):
    """Raised when a list no longer exists."""


class ListItemNotFoundError(HaListManagerDatabaseError):
    """Raised when a list item no longer exists."""


class ProductNotFoundError(HaListManagerDatabaseError):
    """Raised when a product no longer exists."""


class DuplicateEANError(HaListManagerDatabaseError):
    """Raised when an EAN is already assigned to another product."""


class CategoryNotFoundError(HaListManagerDatabaseError):
    """Raised when a category no longer exists."""


class DuplicateCategoryError(HaListManagerDatabaseError):
    """Raised when a category name already exists in the selected scope."""


class LabelNotFoundError(HaListManagerDatabaseError):
    """Raised when a label no longer exists."""


class DuplicateLabelError(HaListManagerDatabaseError):
    """Raised when a label name already exists."""


class ChipNotFoundError(HaListManagerDatabaseError):
    """Raised when a chip no longer exists."""


class DuplicateChipError(HaListManagerDatabaseError):
    """Raised when a chip name already exists in the selected scope."""


class DishNotFoundError(HaListManagerDatabaseError):
    """Raised when a dish no longer exists."""


class DuplicateDishError(HaListManagerDatabaseError):
    """Raised when a normalized dish name already exists."""


class DishesDisabledError(HaListManagerDatabaseError):
    """Raised when dishes are unavailable for the selected list."""


class ScopeChangeConfirmationRequired(HaListManagerDatabaseError):
    """Raised before scope settings would rewrite existing assignments."""

    def __init__(self, impact: dict[str, Any]) -> None:
        super().__init__(localized_text("backend.scope_change_affects_assignments"))
        self.impact = impact


class InventoryEntryNotFoundError(HaListManagerDatabaseError):
    """Raised when an inventory assignment no longer exists."""


class DuplicateInventoryProductError(HaListManagerDatabaseError):
    """Raised when a product is already assigned to an inventory list."""


class InventoryListRequiredError(HaListManagerDatabaseError):
    """Raised when inventory data is requested for another list type."""


class InventoryGroupNotFoundError(HaListManagerDatabaseError):
    """Raised when an inventory group no longer exists."""


class DuplicateInventoryGroupError(HaListManagerDatabaseError):
    """Raised when an inventory group name is already used in a list."""


class InvalidInventoryGroupMembersError(HaListManagerDatabaseError):
    """Raised when a group has invalid or too few members."""


class ScannerNotFoundError(HaListManagerDatabaseError):
    """Raised when a scanner no longer exists."""


class DuplicateScannerAddressError(HaListManagerDatabaseError):
    """Raised when a scanner address is already configured."""


class NotificationProfileNotFoundError(HaListManagerDatabaseError):
    """Raised when a notification profile no longer exists."""


class DuplicateNotificationProfileNameError(HaListManagerDatabaseError):
    """Raised when a notification profile name is already configured."""


class UnsupportedSchemaVersionError(HaListManagerDatabaseError):
    """Raised when a newer database is opened by older integration code."""


class EntityHistoryRenameConflictError(HaListManagerDatabaseError):
    """Raised when a renamed history source would overwrite another archive."""


class HaListManagerDatabase:
    """Small asynchronous wrapper around a local SQLite database."""

    def __init__(self, hass: HomeAssistant, path: Path) -> None:
        self._hass = hass
        self.path = path
        self._lock = asyncio.Lock()
        self._retired = False

    def _check_available(self) -> None:
        if self._retired:
            raise HaListManagerDatabaseError(localized_text("backup.maintenance"))

    async def async_initialize(self) -> None:
        """Create the database or validate its current schema."""
        await self._async_run(self._initialize)

    async def async_schema_version(self) -> int:
        """Return the installed database schema version."""
        return await self._async_run(self._schema_version)

    async def async_overview_statistics(self) -> dict[str, int]:
        """Return aggregate values used by the administration overview."""
        return await self._async_run(self._overview_statistics)

    async def async_list_label_filters(self, user_id, list_id):
        """Return only the current user's saved filters for this list."""
        return await self._async_run(self._list_label_filters, user_id, list_id)

    async def async_save_label_filter(self, user_id, list_id, filter_id, name,
                                     label_ids, include_unlabeled, revision=None):
        return await self._async_run(self._save_label_filter, user_id, list_id,
                                    filter_id, name, label_ids, include_unlabeled, revision)

    async def async_delete_label_filter(self, user_id, list_id, filter_id, revision):
        await self._async_run(self._delete_label_filter, user_id, list_id, filter_id, revision)

    async def async_list_user_favorites(self, user_id: str) -> list[dict[str, Any]]:
        """Return navigation favorites belonging to one Home Assistant user."""
        return await self._async_run(self._list_user_favorites, user_id)

    async def async_set_user_favorite(
        self,
        user_id: str,
        section: str,
        tab: str | None,
        target_id: str | None,
        enabled: bool,
    ) -> list[dict[str, Any]]:
        """Add or remove one user-specific navigation favorite."""
        return await self._async_run(
            self._set_user_favorite,
            user_id,
            section,
            tab,
            target_id,
            enabled,
        )

    async def async_list_tracked_entities(self) -> list[TrackedEntityRecord]:
        """Return configured entity-history sources and their sample counts."""
        return await self._async_run(self._list_tracked_entities)

    async def async_get_entity_history_options(self, entity_id: str) -> dict[str, Any]:
        """Read one source's preferences without counting every archive."""
        return await self._async_run(self._get_entity_history_options, entity_id)

    async def async_set_entity_tracking(
        self,
        entity_id: str,
        enabled: bool | None = None,
        registry_entry_id: str | None = None,
        ignore_unavailable: bool | None = None,
        use_ha_precision: bool | None = None,
    ) -> TrackedEntityRecord:
        """Persist recording options without deleting existing samples."""
        return await self._async_run(
            self._set_entity_tracking, entity_id, enabled, registry_entry_id,
            ignore_unavailable, use_ha_precision,
        )

    async def async_set_entity_registry_id(
        self, entity_id: str, registry_entry_id: str
    ) -> None:
        """Attach the stable Home Assistant registry ID to a history source."""
        await self._async_run(
            self._set_entity_registry_id, entity_id, registry_entry_id
        )

    async def async_rename_tracked_entity(
        self,
        old_entity_id: str,
        new_entity_id: str,
        registry_entry_id: str,
    ) -> bool:
        """Move one tracked source and all its samples to a renamed entity ID."""
        return await self._async_run(
            self._rename_tracked_entity,
            old_entity_id,
            new_entity_id,
            registry_entry_id,
        )

    async def async_delete_entity_history(self, entity_id: str) -> None:
        """Delete one source and its independently stored samples."""
        await self._async_run(self._delete_entity_history, entity_id)

    async def async_hide_unavailable_entity_states(self, entity_id: str) -> int:
        """Hide recorded unavailable states while retaining their original rows."""
        return await self._async_run(self._hide_unavailable_entity_states, entity_id)

    async def async_record_entity_state(
        self,
        *,
        entity_id: str,
        state: str,
        attributes: dict[str, Any],
        last_changed: str,
        last_updated: str,
        last_reported: str | None,
        initial: bool = False,
    ) -> bool:
        """Store a new report, or capture an initial snapshot without duplication."""
        return await self._async_run(
            self._record_entity_state,
            entity_id,
            state,
            attributes,
            last_changed,
            last_updated,
            last_reported,
            initial,
        )

    async def async_import_entity_states(
        self, entity_id: str, states: list[dict[str, Any]], source: str
    ) -> dict[str, int]:
        """Import historical snapshots idempotently and return row counters."""
        return await self._async_run(
            self._import_entity_states, entity_id, states, source
        )

    async def async_get_entity_history(
        self,
        entity_id: str,
        start_time: str | None,
        end_time: str | None,
        limit: int,
        latest: bool = False,
        attribute: str | None = None,
        min_value: float | None = None,
        max_value: float | None = None,
        before_id: int | None = None,
    ) -> tuple[list[EntityStateRecord], bool]:
        """Return chronological snapshots and whether the result was truncated."""
        return await self._async_run(
            self._get_entity_history,
            entity_id,
            start_time,
            end_time,
            limit,
            latest,
            attribute,
            min_value,
            max_value,
            before_id,
        )

    async def async_query_entity_history(
        self, entity_id: str, start_time: str | None, end_time: str | None,
        limit: int, latest: bool, attribute: str | None,
        min_value: float | None, max_value: float | None, before_id: int | None,
        include_hidden: bool = False,
    ) -> tuple[list[EntityStateRecord], bool, bool]:
        """Return samples, pagination status and a distinct safety-scan status."""
        return await self._async_run(
            self._query_entity_history, entity_id, start_time, end_time, limit,
            latest, attribute, min_value, max_value, before_id, include_hidden,
        )

    async def async_save_entity_sample(
        self, entity_id: str, state: str, attributes: dict[str, Any],
        timestamp: str, record_id: int | None = None,
        hidden: bool | None = None,
    ) -> int:
        """Add a manual sample or save a correction without changing its original."""
        return await self._async_run(
            self._save_entity_sample, entity_id, state, attributes, timestamp, record_id, hidden
        )

    async def async_delete_entity_sample(self, entity_id: str, record_id: int) -> None:
        """Delete only a manually added measurement, including its corrections."""
        await self._async_run(self._delete_entity_sample, entity_id, record_id)

    async def async_list_lists(self) -> list[ListRecord]:
        """Return all configured lists."""
        return await self._async_run(self._list_lists)

    async def async_get_legacy_import_result(self, import_id: str) -> dict[str, Any] | None:
        """Return a persisted import receipt before creating another safety backup."""
        return await self._async_run(self._get_legacy_import_result, import_id)

    async def async_import_legacy(self, plan: dict[str, Any], import_id: str) -> dict[str, Any]:
        """Import a verified preview atomically, without running list automations."""
        return await self._async_run(self._import_legacy, plan, import_id)

    async def async_create_list(
        self, name: str, list_type: str, icon: str | None,
        provider: str = "local", external_entity_id: str | None = None,
        label_conflict_policy: str = "specific",
        use_global_categories: bool = True,
        use_type_categories: bool = True,
        use_global_labels: bool = True,
        use_type_labels: bool = True,
        use_list_labels: bool = True,
        use_global_chips: bool = True,
        use_type_chips: bool = True,
        use_dishes: bool = False,
        use_tandoor: bool = False,
        tandoor_skip_small_units: bool = False,
        tandoor_include_ingredients: bool = True,
        tandoor_excluded_units: str = "",
        tandoor_result_limit: int = 100,
        capitalize_first_letter: bool = False,
        auto_delete_completed: bool = False,
        auto_delete_delay_minutes: int = 0,
        auto_delete_confirm: bool = False,
    ) -> ListRecord:
        """Create and return a list."""
        return await self._async_run(
            self._create_list, name, list_type, icon, provider, external_entity_id,
            label_conflict_policy,
            use_global_labels, use_type_labels, use_list_labels,
            use_global_categories, use_type_categories,
            use_global_chips, use_type_chips,
            use_dishes, use_tandoor, tandoor_skip_small_units,
            tandoor_include_ingredients, tandoor_excluded_units,
            tandoor_result_limit,
            capitalize_first_letter,
            auto_delete_completed, auto_delete_delay_minutes, auto_delete_confirm,
        )

    async def async_get_list(self, list_id: str) -> ListRecord:
        """Return one configured list."""
        return await self._async_run(self._get_list, list_id)

    async def async_update_list(
        self,
        list_id: str,
        *,
        name: str | None = None,
        icon: str | None = None,
        enabled: bool | None = None,
        external_entity_id: str | None | object = _UNSET,
        label_conflict_policy: str | None = None,
        use_global_categories: bool | None = None,
        use_type_categories: bool | None = None,
        use_global_labels: bool | None = None,
        use_type_labels: bool | None = None,
        use_list_labels: bool | None = None,
        use_global_chips: bool | None = None,
        use_type_chips: bool | None = None,
        use_dishes: bool | None = None,
        use_tandoor: bool | None = None,
        tandoor_skip_small_units: bool | None = None,
        tandoor_include_ingredients: bool | None = None,
        tandoor_excluded_units: str | None = None,
        tandoor_result_limit: int | None = None,
        confirm_scope_changes: bool = False,
        capitalize_first_letter: bool | None = None,
        auto_delete_completed: bool | None = None,
        auto_delete_delay_minutes: int | None = None,
        auto_delete_confirm: bool | None = None,
    ) -> ListRecord:
        """Update and return a list."""
        return await self._async_run(
            self._update_list,
            list_id,
            name,
            icon,
            enabled,
            external_entity_id,
            label_conflict_policy,
            use_global_categories,
            use_type_categories,
            use_global_labels,
            use_type_labels,
            use_list_labels,
            use_global_chips,
            use_type_chips,
            confirm_scope_changes,
            use_dishes,
            use_tandoor,
            tandoor_skip_small_units,
            tandoor_include_ingredients,
            tandoor_excluded_units,
            tandoor_result_limit,
            capitalize_first_letter,
            auto_delete_completed, auto_delete_delay_minutes, auto_delete_confirm,
        )

    async def async_preview_list_scope_changes(
        self,
        list_id: str,
        *,
        use_global_categories: bool,
        use_type_categories: bool,
        use_global_labels: bool,
        use_type_labels: bool,
        use_global_chips: bool,
        use_type_chips: bool,
    ) -> dict[str, Any]:
        """Describe assignment changes caused by proposed scope settings."""
        return await self._async_run(
            self._preview_list_scope_changes,
            list_id,
            use_global_categories,
            use_type_categories,
            use_global_labels,
            use_type_labels,
            use_global_chips,
            use_type_chips,
        )

    async def async_delete_list(self, list_id: str) -> None:
        """Delete a list."""
        await self._async_run(self._delete_list, list_id)

    async def async_list_items(self, list_id: str) -> list[ListItemRecord]:
        """Return all entries of one list."""
        return await self._async_run(self._list_items, list_id)

    async def async_get_item_category_names(self, list_id: str) -> dict[str, str]:
        """Expose permanent display names without rewriting an item's assignment."""
        return await self._async_run(self._get_item_category_names, list_id)

    async def async_get_item(self, item_id: str) -> ListItemRecord:
        """Return one list entry."""
        return await self._async_run(self._get_item, item_id)

    async def async_get_alexa_state(self) -> dict[str, Any]:
        """Return the single Alexa connection and recent intake diagnostics."""
        return await self._async_run(self._get_alexa_state)

    async def async_set_alexa_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Save connection preferences without discarding processed source IDs."""
        return await self._async_run(self._set_alexa_settings, settings)

    async def async_update_alexa_status(self, status: dict[str, Any]) -> None:
        """Merge runtime diagnostics while preserving connection preferences."""
        await self._async_run(self._update_alexa_status, status)

    async def async_get_alexa_receipts(
        self, source_id: str, uids: list[str],
    ) -> dict[str, dict[str, Any]]:
        """Read processing receipts for one observed source snapshot."""
        return await self._async_run(self._get_alexa_receipts, source_id, uids)

    async def async_list_alexa_pending_receipts(self) -> list[dict[str, Any]]:
        """Return already imported items whose optional source cleanup needs retry."""
        return await self._async_run(self._list_alexa_pending_receipts)

    async def async_list_alexa_links(self, source_id: str) -> list[dict[str, Any]]:
        """Return active source links with their restart-safe synchronization journal."""
        return await self._async_run(self._list_alexa_links, source_id)

    async def async_list_alexa_outbox(
        self, source_id: str | None = None, target_list_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return durable local-create jobs, including uncertain cloud requests."""
        return await self._async_run(self._list_alexa_outbox, source_id, target_list_id)

    async def async_update_alexa_outbox(
        self, job_id: str, state: str, payload: dict[str, Any] | None = None,
        expected_state: str | None = None,
    ) -> dict[str, Any] | None:
        """Persist a cloud intent before attempting a non-idempotent create."""
        return await self._async_run(self._update_alexa_outbox, job_id, state, payload, expected_state)

    async def async_remove_alexa_outbox(self, job_id: str) -> None:
        """Remove a job that never sent or whose remote identity is accounted for."""
        await self._async_run(self._remove_alexa_outbox, job_id)

    async def async_bind_alexa_outbox(
        self, job_id: str, uid: str, summary: str, status: str,
    ) -> bool:
        """Link a created Alexa ID without importing it or adding its quantity."""
        return await self._async_run(self._bind_alexa_outbox, job_id, uid, summary, status)

    async def async_update_alexa_link(
        self, source_id: str, uid: str, sync: dict[str, Any],
        original_name: str | None = None, *, cleanup_action: str | None = None,
        cleanup_status: str | None = None,
    ) -> None:
        """Update an existing link, never recreate a link removed by reconciliation."""
        await self._async_run(self._update_alexa_link, source_id, uid, sync,
                              original_name, cleanup_action, cleanup_status)

    async def async_remove_alexa_links(self, source_id: str, uids: list[str]) -> None:
        """Forget confirmed deleted source identities; retain the bounded activity log."""
        await self._async_run(self._remove_alexa_links, source_id, uids)

    async def async_has_alexa_history(self, source_id: str, uids: list[str]) -> set[str]:
        """Recognize recent processed IDs, including expiring cloud-echo guards."""
        return await self._async_run(self._has_alexa_history, source_id, uids)

    async def async_prune_alexa_tombstones(self) -> int:
        """Remove expired minimal cloud-echo guards during periodic housekeeping."""
        return await self._async_run(self._prune_alexa_tombstones)

    async def async_apply_alexa_sync_local(
        self, item_id: str, expected_updated_at: str,
        completed: bool | None = None, delete: bool = False,
    ) -> dict[str, Any]:
        """Apply a cloud status only while the observed local revision still matches."""
        return await self._async_run(self._apply_alexa_sync_local, item_id,
                                     expected_updated_at, completed, delete)

    async def async_ignore_alexa_items(
        self, source_id: str, uids: list[str], *, source_entity_id: str | None = None,
    ) -> None:
        """Remember an initial snapshot without importing existing entries."""
        await self._async_run(self._ignore_alexa_items, source_id, uids, source_entity_id)

    async def async_accept_alexa_item(
        self, source_id: str, uid: str, target_list_id: str, name: str,
        description: str | None, quantity: int, cleanup_action: str,
        original_name: str, *, include_existing: bool = False,
        source_entity_id: str | None = None,
        match_products: bool = False, has_unit: bool = False,
        product_id: str | None = None,
    ) -> dict[str, Any]:
        """Commit an item and its source receipt in the same transaction."""
        return await self._async_run(
            self._accept_alexa_item, source_id, uid, target_list_id, name,
            description, quantity, cleanup_action, original_name,
            include_existing, source_entity_id, match_products, has_unit, product_id,
        )

    async def async_preview_alexa_item(
        self, target_list_id: str | None, name: str, description: str | None,
        quantity: int, *, match_products: bool = False, has_unit: bool = False,
        product_id: str | None = None,
    ) -> dict[str, Any]:
        """Resolve an incoming item without adding it or reserving its source ID."""
        return await self._async_run(
            self._preview_alexa_item, target_list_id, name, description,
            quantity, match_products, has_unit, product_id,
        )

    async def async_update_alexa_receipt(
        self, source_id: str, uid: str, cleanup_status: str,
        last_error: str | None = None,
    ) -> None:
        """Record cleanup progress independently of the local item's lifetime."""
        await self._async_run(
            self._update_alexa_receipt, source_id, uid, cleanup_status, last_error,
        )

    async def async_create_item(
        self,
        list_id: str,
        name: str,
        description: str | None,
        quantity: int,
        category_id: str | None,
        category: str | None,
        due_at: str | None,
        label_ids: list[str],
        product_id: str | None = None,
        external_uid: str | None = None,
        recurrence_interval: int | None = None,
        recurrence_unit: str | None = None,
        offer_only: bool | object = False,
        remember_product_category: bool = False,
        remember_product_labels: bool = False,
    ) -> ListItemRecord:
        """Create and return a list item."""
        record = await self._async_run(
            self._create_item,
            list_id,
            name,
            description,
            quantity,
            category_id,
            category,
            due_at,
            label_ids,
            product_id,
            external_uid,
            recurrence_interval,
            recurrence_unit,
            offer_only,
            remember_product_category,
            remember_product_labels,
        )
        self._fire_item_mutated(None, record)
        return record

    async def async_create_item_action_chip(
        self, list_id: str, name: str, product_id: str | None = None,
    ) -> tuple[ChipRecord, bool]:
        """Create a list-local quick chip without replacing an existing one."""
        return await self._async_run(self._create_item_action_chip, list_id, name, product_id)

    async def async_create_item_action_rule(
        self, list_id: str, name: str, category_id: str,
    ) -> tuple[CategoryRecord, bool]:
        """Append one exact, list-local rule, retaining inherited definitions."""
        return await self._async_run(self._create_item_action_rule, list_id, name, category_id)

    async def async_send_item_action(
        self, source_list_id: str, source_item_id: str | None,
        source_entry_id: str | None, target_list_id: str, quantity: int,
    ) -> tuple[ListItemRecord, bool, ListRecord]:
        """Copy a saved article; publish only its committed target mutation."""
        record, before, target = await self._async_run(
            self._send_item_action, source_list_id, source_item_id,
            source_entry_id, target_list_id, quantity,
        )
        self._fire_item_mutated(before, record)
        return record, before is not None, target

    @staticmethod
    def _item_action_list(connection: sqlite3.Connection, list_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM lists WHERE id = ?", (list_id,)).fetchone()
        if row is None:
            raise ListNotFoundError(list_id)
        if not row["enabled"] or row["list_type"] not in {"shopping", "inventory"}:
            raise ValueError(localized_text("actions.article_list_required"))
        return row

    def _create_item_action_chip(
        self, list_id: str, name: str, product_id: str | None,
    ) -> tuple[ChipRecord, bool]:
        name = " ".join(name.strip().split())
        if not name or len(name) > 100:
            raise ValueError(localized_text("actions.chip_name_length"))
        key = self._normalize_priority_name(name)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._item_action_list(connection, list_id)
            if product_id is not None:
                self._require_product(connection, product_id)
            row = connection.execute(
                "SELECT chips.*, products.name AS product_name FROM chips "
                "LEFT JOIN products ON products.id = chips.product_id "
                "WHERE chips.scope = 'list' AND chips.list_id = ? "
                "AND chips.chip_kind = 'entry' AND chips.priority_name = ?",
                (list_id, key),
            ).fetchone()
            if row is not None:
                return self._chip_record_from_row(row), False
            now, chip_id = self._now(), str(uuid4())
            connection.execute(
                "INSERT INTO chips(id,name,priority_name,chip_kind,icon,color,scope,"
                "list_type,list_id,product_id,template_json,created_at,updated_at) "
                "VALUES(?,?,?,'entry',NULL,NULL,'list',NULL,?,?,NULL,?,?)",
                (chip_id, name, key, list_id, product_id, now, now),
            )
            row = connection.execute(
                "SELECT chips.*, products.name AS product_name FROM chips "
                "LEFT JOIN products ON products.id = chips.product_id WHERE chips.id = ?",
                (chip_id,),
            ).fetchone()
            return self._chip_record_from_row(row), True

    def _create_item_action_rule(
        self, list_id: str, name: str, category_id: str,
    ) -> tuple[CategoryRecord, bool]:
        name = " ".join(name.strip().split())
        if not name or len(name) > 100:
            raise ValueError(localized_text("actions.rule_name_length"))
        if "*" in name:
            raise ValueError(localized_text("actions.exact_rule_required"))
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            target = self._item_action_list(connection, list_id)
            category = connection.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
            if category is None or not (
                category["scope"] == "list" and category["list_id"] == list_id
                or category["scope"] == "global" and target["use_global_categories"]
                or category["scope"] == "list_type" and category["list_type"] == target["list_type"] and target["use_type_categories"]
            ):
                raise CategoryNotFoundError(category_id)
            local = connection.execute(
                "SELECT * FROM categories WHERE scope = 'list' AND list_id = ? AND name = ? COLLATE NOCASE",
                (list_id, category["name"]),
            ).fetchone()
            local_id = local["id"] if local else str(uuid4())
            self._ensure_category_rules_unique_in_scope(connection, local_id, [name], "list", None, list_id)
            now = self._now()
            if local is None:
                connection.execute(
                    "INSERT INTO categories(id,name,scope,list_type,list_id,icon,color,position,created_at,updated_at) "
                    "VALUES(?,?,'list',NULL,?,?,?,?,?,?)",
                    (local_id, category["name"], list_id, category["icon"], category["color"], category["position"], now, now),
                )
            rows = connection.execute("SELECT pattern FROM category_rules WHERE category_id = ?", (local_id,)).fetchall()
            created = not any(row["pattern"].casefold() == name.casefold() for row in rows)
            if created:
                if len(rows) >= 100:
                    raise ValueError(localized_text("backend.category_rule_limit"))
                position = connection.execute("SELECT COALESCE(MAX(position),-1)+1 FROM category_rules WHERE category_id = ?", (local_id,)).fetchone()[0]
                connection.execute(
                    "INSERT INTO category_rules(id,category_id,pattern,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                    (str(uuid4()), local_id, name, position, now, now),
                )
            result = connection.execute("SELECT * FROM categories WHERE id = ?", (local_id,)).fetchone()
            return self._category_record_from_row(result), created

    def _send_item_action(
        self, source_list_id: str, source_item_id: str | None,
        source_entry_id: str | None, target_list_id: str, quantity: int,
    ) -> tuple[ListItemRecord, ListItemRecord | None, ListRecord]:
        if bool(source_item_id) == bool(source_entry_id):
            raise ValueError(localized_text("actions.source_required"))
        if source_list_id == target_list_id:
            raise ValueError(localized_text("actions.different_list_required"))
        if type(quantity) is not int or not 1 <= quantity <= 1000000:
            raise ValueError(localized_text("backend.quantity_range"))
        now = self._now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            source_list = self._item_action_list(connection, source_list_id)
            target = self._item_action_list(connection, target_list_id)
            if target["list_type"] != "shopping" or target["provider"] != "local":
                raise ValueError(localized_text("actions.shopping_target_required"))
            if source_item_id:
                source = connection.execute("SELECT * FROM list_items WHERE id = ? AND list_id = ?", (source_item_id, source_list_id)).fetchone()
                if source is None:
                    raise ListItemNotFoundError(source_item_id)
                if source_list["list_type"] != "shopping":
                    raise ValueError(localized_text("actions.article_list_required"))
                product_id, name, description = source["product_id"], source["name"], source["description"]
                offer_only = bool(source["offer_only"])
                source_labels = [row[0] for row in connection.execute(
                    "SELECT labels.name FROM list_item_labels JOIN labels ON labels.id = list_item_labels.label_id WHERE item_id = ?", (source_item_id,)
                )]
            else:
                source = connection.execute(
                    "SELECT inventory_entries.product_id, products.name FROM inventory_entries "
                    "JOIN products ON products.id = inventory_entries.product_id WHERE inventory_entries.id = ? AND inventory_entries.list_id = ?",
                    (source_entry_id, source_list_id),
                ).fetchone()
                if source is None:
                    raise InventoryEntryNotFoundError(source_entry_id)
                if source_list["list_type"] != "inventory":
                    raise ValueError(localized_text("actions.article_list_required"))
                product_id, name, description, offer_only, source_labels = source["product_id"], source["name"], None, False, []
            if product_id:
                source_labels.extend(row[0] for row in connection.execute(
                    "SELECT labels.name FROM product_labels JOIN labels ON labels.id = product_labels.label_id WHERE product_id = ?", (product_id,)
                ))
            allowed_ids = self._applicable_label_ids(connection, target_list_id)
            allowed_labels = {row["name"].casefold(): row["id"] for row in connection.execute("SELECT id,name FROM labels") if row["id"] in allowed_ids}
            label_ids = list(dict.fromkeys(allowed_labels[name.casefold()] for name in source_labels if name.casefold() in allowed_labels))
            # Only a known identical product with the same item details is safe to merge.
            existing = connection.execute(
                "SELECT * FROM list_items WHERE list_id = ? AND product_id = ? AND completed = 0 "
                "AND COALESCE(description,'') = COALESCE(?,'') AND offer_only = ? ORDER BY position,id LIMIT 1",
                (target_list_id, product_id, description, int(offer_only)),
            ).fetchone() if product_id else None
            before = None
            if existing:
                if int(existing["quantity"]) + quantity > 1000000:
                    raise ValueError(localized_text("backend.quantity_range"))
                labels = self._labels_for(connection, "list_item_labels", "item_id", existing["id"], target_list_id)
                before = self._item_record_from_row(existing, labels)
                item_id = existing["id"]
                connection.execute("UPDATE list_items SET quantity = quantity + ?, updated_at = ? WHERE id = ?", (quantity, now, item_id))
                # Merge allowed incoming labels while retaining every stored target assignment.
                connection.executemany(
                    "INSERT OR IGNORE INTO list_item_labels(item_id,label_id) VALUES(?,?)",
                    [(item_id, label_id) for label_id in label_ids],
                )
            else:
                category_id, category = (None, None)
                if product_id:
                    category_id, category = self._resolve_product_category_for_list(connection, product_id, target_list_id)
                if category_id is None:
                    category_id, category = self._resolve_category_rule_for_list(connection, target_list_id, name)
                item_id = str(uuid4())
                position = connection.execute("SELECT COALESCE(MAX(position),-1)+1 FROM list_items WHERE list_id = ?", (target_list_id,)).fetchone()[0]
                connection.execute(
                    "INSERT INTO list_items(id,list_id,product_id,external_uid,name,description,quantity,category_id,category,due_at,"
                    "recurrence_interval,recurrence_unit,completed,position,created_at,updated_at,offer_only) "
                    "VALUES(?,?,?,NULL,?,?,?,?,?,NULL,NULL,NULL,0,?,?,?,?)",
                    (item_id, target_list_id, product_id, name, description, quantity, category_id, category, position, now, now, int(offer_only)),
                )
                self._replace_labels(connection, "list_item_labels", "item_id", item_id, label_ids)
            row = connection.execute("SELECT * FROM list_items WHERE id = ?", (item_id,)).fetchone()
            labels = self._labels_for(connection, "list_item_labels", "item_id", item_id, target_list_id)
            return self._item_record_from_row(row, labels), before, self._record_from_row(target)

    async def async_update_item(
        self,
        item_id: str,
        *,
        name: str,
        description: str | None,
        quantity: int,
        category_id: str | None,
        category: str | None,
        due_at: str | None,
        completed: bool,
        label_ids: list[str],
        product_id: str | None | object = _UNSET,
        external_uid: str | None | object = _UNSET,
        recurrence_interval: int | None = None,
        recurrence_unit: str | None = None,
        offer_only: bool | object = _UNSET,
        remember_product_category: bool = False,
        remember_product_labels: bool = False,
    ) -> ListItemRecord:
        """Update and return a list item."""
        before = await self._async_run(self._get_item, item_id)
        record = await self._async_run(
            self._update_item,
            item_id,
            name,
            description,
            quantity,
            category_id,
            category,
            due_at,
            completed,
            label_ids,
            product_id,
            external_uid,
            recurrence_interval,
            recurrence_unit,
            offer_only,
            remember_product_category,
            remember_product_labels,
        )
        self._fire_item_mutated(before, record)
        return record

    async def async_set_item_completed(
        self, item_id: str, completed: bool
    ) -> ListItemRecord:
        """Set the completed state of a list item."""
        before = await self._async_run(self._get_item, item_id)
        record = await self._async_run(self._set_item_completed, item_id, completed)
        self._fire_item_mutated(before, record)
        return record

    async def async_reorder_items(
        self, list_id: str, item_ids: list[str]
    ) -> list[ListItemRecord]:
        """Persist the complete item order of one local list."""
        return await self._async_run(self._reorder_items, list_id, item_ids)

    async def async_delete_item(self, item_id: str) -> str:
        """Delete a list item and return its parent list ID."""
        before = await self._async_run(self._get_item, item_id)
        list_id = await self._async_run(self._delete_item, item_id)
        self._fire_item_mutated(before, None)
        return list_id

    async def async_archive_external_item(
        self, item_id: str, match_key: str
    ) -> str:
        """Archive local metadata before removing an external item."""
        before = await self._async_run(self._get_item, item_id)
        list_id = await self._async_run(
            self._archive_external_item, item_id, match_key
        )
        self._fire_item_mutated(before, None)
        return list_id

    async def async_get_external_item_metadata(
        self, list_id: str, match_key: str
    ) -> dict[str, Any] | None:
        """Return archived metadata for one unambiguous external item name."""
        return await self._async_run(
            self._get_external_item_metadata, list_id, match_key
        )

    async def async_delete_external_item_metadata(
        self, list_id: str, match_key: str
    ) -> None:
        """Forget metadata after it has been restored successfully."""
        await self._async_run(
            self._delete_external_item_metadata, list_id, match_key
        )

    async def async_list_external_sync_statuses(self) -> dict[str, dict[str, Any]]:
        """Return the persisted synchronization state for external lists."""
        return await self._async_run(self._list_external_sync_statuses)

    async def async_mark_external_sync_attempt(self, list_id: str) -> None:
        """Record that synchronization of an external list has started."""
        await self._async_run(self._mark_external_sync_attempt, list_id)

    async def async_mark_external_sync_success(
        self, list_id: str, *, changed: bool
    ) -> dict[str, Any]:
        """Record a successful synchronization or external mutation."""
        return await self._async_run(
            self._mark_external_sync_success, list_id, changed
        )

    async def async_mark_external_sync_error(
        self, list_id: str, error: str
    ) -> dict[str, Any]:
        """Record a failed external-list synchronization."""
        return await self._async_run(
            self._mark_external_sync_error, list_id, error
        )

    async def async_list_notification_profiles(self) -> list[NotificationProfileRecord]:
        """Return all reusable notification destinations."""
        return await self._async_run(self._list_notification_profiles)

    async def async_create_notification_profile(
        self, *, name: str, provider: str, target: str,
        title: str | None, click_url: str | None,
        message_format: str, enabled: bool,
    ) -> NotificationProfileRecord:
        """Create a reusable notification destination."""
        return await self._async_run(
            self._create_notification_profile, name, provider, target,
            title, click_url, message_format, enabled,
        )

    async def async_update_notification_profile(
        self, profile_id: str, *, name: str, provider: str, target: str,
        title: str | None, click_url: str | None,
        message_format: str, enabled: bool,
    ) -> NotificationProfileRecord:
        """Update a reusable notification destination."""
        return await self._async_run(
            self._update_notification_profile, profile_id, name, provider,
            target, title, click_url, message_format, enabled,
        )

    async def async_delete_notification_profile(self, profile_id: str) -> None:
        """Delete a notification destination and its list assignments."""
        await self._async_run(self._delete_notification_profile, profile_id)

    async def async_list_notification_assignments(
        self, list_id: str | None = None
    ) -> list[ListNotificationAssignmentRecord]:
        """Return notification assignments, optionally for one list."""
        return await self._async_run(self._list_notification_assignments, list_id)

    async def async_set_notification_assignments(
        self, list_id: str, assignments: list[dict[str, Any] | str]
    ) -> list[ListNotificationAssignmentRecord]:
        """Replace notification destinations and their list-specific settings."""
        return await self._async_run(
            self._set_notification_assignments, list_id, assignments
        )

    async def async_list_notification_pending_batches(
        self,
    ) -> list[NotificationPendingBatchRecord]:
        """Return every durable notification batch awaiting delivery."""
        return await self._async_run(self._list_notification_pending_batches)

    async def async_get_notification_pending_batch(
        self, list_id: str, profile_id: str
    ) -> NotificationPendingBatchRecord | None:
        """Return one waiting notification batch."""
        return await self._async_run(
            self._get_notification_pending_batch, list_id, profile_id
        )

    async def async_upsert_notification_pending_batch(
        self, list_id: str, profile_id: str, due_at: str, changes_json: str
    ) -> NotificationPendingBatchRecord:
        """Create or replace one waiting notification batch."""
        return await self._async_run(
            self._upsert_notification_pending_batch,
            list_id,
            profile_id,
            due_at,
            changes_json,
        )

    async def async_delete_notification_pending_batch(
        self, list_id: str, profile_id: str
    ) -> None:
        """Remove a delivered or obsolete notification batch."""
        await self._async_run(
            self._delete_notification_pending_batch, list_id, profile_id
        )

    async def async_list_products(
        self, search: str | None = None, label_id: str | None = None
    ) -> list[ProductRecord]:
        """Return products, optionally filtered by a search term."""
        return await self._async_run(self._list_products, search, label_id)

    async def async_list_recent_products(self, limit: int = 100) -> list[ProductRecord]:
        """Return the most recently updated products."""
        return await self._async_run(self._list_recent_products, limit)

    async def async_get_products_by_ids(self, product_ids: list[str]) -> list[ProductRecord]:
        """Resolve referenced products without loading the entire product catalog."""
        return await self._async_run(self._get_products_by_ids, product_ids)

    async def async_list_products_page(
        self,
        search: str | None,
        label_id: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[ProductRecord], int]:
        """Return one filtered product page and the complete filtered count."""
        return await self._async_run(
            self._list_products_page, search, label_id, limit, offset
        )

    async def async_get_product_by_ean(self, ean: str) -> ProductRecord | None:
        """Return the product assigned to an EAN, if present."""
        return await self._async_run(self._get_product_by_ean, ean)

    async def async_create_product(
        self,
        *,
        ean: str | None,
        name: str,
        original_name: str | None,
        brand: str | None,
        package_quantity: str | None,
        category: str | None,
        image_url: str | None,
        source: str,
        label_ids: list[str],
        category_ids: list[str] | None = None,
    ) -> ProductRecord:
        """Create and return a product."""
        return await self._async_run(
            self._create_product,
            ean,
            name,
            original_name,
            brand,
            package_quantity,
            category,
            image_url,
            source,
            label_ids,
            category_ids or [],
        )

    async def async_update_product(
        self,
        product_id: str,
        *,
        ean: str | None,
        name: str,
        original_name: str | None,
        brand: str | None,
        package_quantity: str | None,
        category: str | None,
        image_url: str | None,
        label_ids: list[str],
        category_ids: list[str] | None = None,
        list_id: str | None = None,
    ) -> ProductRecord:
        """Update a product, retaining labels hidden in an optional list context."""
        return await self._async_run(
            self._update_product,
            product_id,
            ean,
            name,
            original_name,
            brand,
            package_quantity,
            category,
            image_url,
            label_ids,
            category_ids,
            list_id,
        )

    async def async_delete_product(self, product_id: str) -> None:
        """Delete a product."""
        await self._async_run(self._delete_product, product_id)

    async def async_list_products_for_category(
        self, category_id: str
    ) -> list[ProductRecord]:
        """Return products explicitly assigned to one permanent category."""
        return await self._async_run(self._list_products_for_category, category_id)

    async def async_set_product_list_category(
        self,
        product_id: str,
        list_id: str,
        category_id: str | None,
        replace_existing: bool,
    ) -> tuple[ProductRecord, CategoryRecord | None, bool, str]:
        """Set one product's category override for a concrete list."""
        return await self._async_run(
            self._set_product_list_category,
            product_id,
            list_id,
            category_id,
            replace_existing,
        )

    async def async_list_categories(
        self, list_id: str | None = None
    ) -> list[CategoryRecord]:
        """Return all permanent categories."""
        return await self._async_run(self._list_categories, list_id)

    async def async_list_dynamic_categories(self) -> list[dict[str, Any]]:
        """Return category names used by list items but not stored permanently."""
        return await self._async_run(self._list_dynamic_categories)

    async def async_list_category_rules(
        self, category_id: str
    ) -> list[dict[str, Any]]:
        """Return the automatic name rules belonging to one category."""
        return await self._async_run(self._list_category_rules, category_id)

    async def async_replace_category_rules(
        self, category_id: str, patterns: list[str]
    ) -> list[dict[str, Any]]:
        """Replace all automatic name rules belonging to one category."""
        return await self._async_run(
            self._replace_category_rules, category_id, patterns
        )

    async def async_resolve_category_rule(
        self, list_id: str, name: str
    ) -> CategoryRecord | None:
        """Return the category selected by an automatic item-name rule."""
        return await self._async_run(self._resolve_category_rule, list_id, name)

    async def async_resolve_chip_categories(
        self, list_id: str, candidates: list[dict[str, str | None]]
    ) -> dict[str, CategoryRecord | None]:
        """Return the effective category for several quick-add chips."""
        return await self._async_run(
            self._resolve_chip_categories, list_id, candidates
        )

    async def async_create_category(
        self,
        *,
        name: str,
        scope: str,
        list_type: str | None,
        list_id: str | None,
        icon: str | None,
        color: str | None,
        position: int | None = None,
    ) -> CategoryRecord:
        """Create and return a permanent category."""
        return await self._async_run(
            self._create_category, name, scope, list_type, list_id, icon, color, position
        )

    async def async_update_category(
        self,
        category_id: str,
        *,
        name: str,
        scope: str,
        list_type: str | None,
        list_id: str | None,
        icon: str | None,
        color: str | None,
        position: int | None,
    ) -> CategoryRecord:
        """Update and return a permanent category."""
        return await self._async_run(
            self._update_category,
            category_id,
            name,
            scope,
            list_type,
            list_id,
            icon,
            color,
            position,
        )

    async def async_delete_category(self, category_id: str) -> None:
        """Delete a permanent category definition."""
        await self._async_run(self._delete_category, category_id)

    async def async_get_category_order(self, list_id: str) -> list[CategoryRecord]:
        """Return the combined permanent category order for one list."""
        return await self._async_run(self._get_category_order, list_id)

    async def async_has_custom_category_order(self, list_id: str) -> bool:
        """Return whether one list has a complete combined order override."""
        return await self._async_run(self._has_custom_category_order, list_id)

    async def async_get_category_base_order(
        self, scope: str, list_id: str | None, list_type: str | None = None
    ) -> list[CategoryRecord]:
        """Return the base order for global or list-specific categories."""
        return await self._async_run(
            self._get_category_base_order, scope, list_id, list_type
        )

    async def async_set_category_base_order(
        self, scope: str, list_id: str | None, category_ids: list[str],
        list_type: str | None = None,
    ) -> list[CategoryRecord]:
        """Replace a global or list-specific base category order."""
        return await self._async_run(
            self._set_category_base_order, scope, list_id, category_ids, list_type
        )

    async def async_set_category_order(
        self, list_id: str, category_ids: list[str]
    ) -> list[CategoryRecord]:
        """Replace the combined permanent category order for one list."""
        return await self._async_run(self._set_category_order, list_id, category_ids)

    async def async_reset_category_order(
        self, list_id: str
    ) -> list[CategoryRecord]:
        """Remove one list's combined order override."""
        return await self._async_run(self._reset_category_order, list_id)

    async def async_list_labels(self, list_id: str | None = None) -> list[LabelRecord]:
        """Return all reusable labels."""
        return await self._async_run(self._list_labels, list_id)

    async def async_create_label(
        self, *, name: str, icon: str | None, color: str | None,
        scope: str = "global", list_type: str | None = None,
        list_id: str | None = None,
    ) -> LabelRecord:
        """Create and return a reusable label."""
        return await self._async_run(
            self._create_label, name, icon, color, scope, list_type, list_id
        )

    async def async_update_label(
        self, label_id: str, *, name: str, icon: str | None, color: str | None,
        scope: str = "global", list_type: str | None = None,
        list_id: str | None = None,
    ) -> LabelRecord:
        """Update and return a reusable label."""
        return await self._async_run(
            self._update_label, label_id, name, icon, color, scope, list_type, list_id
        )

    async def async_delete_label(self, label_id: str) -> None:
        """Delete a reusable label and its assignments."""
        await self._async_run(self._delete_label, label_id)

    async def async_list_chips(self, list_id: str | None = None) -> list[ChipRecord]:
        """Return all chips or the effective chips for one list."""
        return await self._async_run(self._list_chips, list_id)

    async def async_create_chip(
        self, *, name: str, color: str | None, scope: str = "global",
        list_type: str | None = None, list_id: str | None = None,
        product_id: str | None = None, chip_kind: str = "entry",
        icon: str | None = None, template_data: dict[str, Any] | None = None,
    ) -> ChipRecord:
        """Create and return a reusable quick-add chip."""
        return await self._async_run(
            self._create_chip, name, color, scope, list_type, list_id, product_id,
            chip_kind, icon, template_data,
        )

    async def async_update_chip(
        self, chip_id: str, *, name: str, color: str | None,
        scope: str = "global", list_type: str | None = None,
        list_id: str | None = None, product_id: str | None = None,
        replace_existing: bool = False, chip_kind: str = "entry",
        icon: str | None = None, template_data: dict[str, Any] | None = None,
    ) -> ChipRecord:
        """Update and return a reusable quick-add chip."""
        return await self._async_run(
            self._update_chip, chip_id, name, color, scope, list_type, list_id,
            product_id, replace_existing, chip_kind, icon, template_data,
        )

    async def async_delete_chip(self, chip_id: str) -> None:
        """Delete a reusable quick-add chip."""
        await self._async_run(self._delete_chip, chip_id)

    async def async_list_dishes(self, list_id: str | None = None) -> list[DishRecord]:
        """Return all dishes or those enabled for one shopping list."""
        return await self._async_run(self._list_dishes, list_id)

    async def async_create_dish(
        self, *, name: str, color: str | None, items: list[dict[str, Any]]
    ) -> DishRecord:
        """Create a central dish and its ordered ingredients."""
        return await self._async_run(self._create_dish, name, color, items)

    async def async_update_dish(
        self, dish_id: str, *, name: str, color: str | None,
        items: list[dict[str, Any]],
    ) -> DishRecord:
        """Update a central dish and replace its ordered ingredients."""
        return await self._async_run(self._update_dish, dish_id, name, color, items)

    async def async_delete_dish(self, dish_id: str) -> None:
        """Delete a dish and its ingredients."""
        await self._async_run(self._delete_dish, dish_id)

    async def async_add_dish_to_list(
        self, dish_id: str, list_id: str,
        selected_items: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Add selected dish ingredients to one shopping list in one transaction."""
        return await self._async_run(
            self._add_dish_to_list, dish_id, list_id, selected_items
        )

    async def async_list_important_chip_assignments(
        self, list_id: str
    ) -> list[dict[str, str]]:
        """Return persistent important-chip targets for one list."""
        return await self._async_run(self._list_important_chip_assignments, list_id)

    async def async_set_important_chip_assignment(
        self, list_id: str, target_type: str, target_id: str, important: bool
    ) -> None:
        """Add or remove one list-specific important-chip target."""
        await self._async_run(
            self._set_important_chip_assignment,
            list_id,
            target_type,
            target_id,
            important,
        )

    async def async_list_inventory_lists(self) -> list[ListRecord]:
        """Return enabled backend lists configured for inventory."""
        return await self._async_run(self._list_inventory_lists)

    async def async_list_inventory(self, list_id: str) -> list[InventoryRecord]:
        """Return the product inventory of one list."""
        return await self._async_run(self._list_inventory, list_id)

    async def async_create_inventory_entry(
        self,
        *,
        list_id: str,
        product_id: str,
        stock: int,
        minimum_stock: int | None,
        restock_quantity: int = 1,
        restock_mode: str | None = None,
        category_id: str | None = None,
        category: str | None = None,
        hidden: bool = False,
    ) -> InventoryRecord:
        """Assign a product to an inventory list."""
        return await self._async_run(
            self._create_inventory_entry,
            list_id,
            product_id,
            stock,
            minimum_stock,
            category_id,
            category,
            hidden,
            restock_quantity,
            restock_mode,
        )

    async def async_update_inventory_entry(
        self,
        entry_id: str,
        *,
        stock: int,
        minimum_stock: int | None,
        restock_quantity: int | None = None,
        restock_mode: str | None = None,
        category_id: str | None = None,
        category: str | None = None,
        hidden: bool = False,
        label_ids: list[str] | None = None,
    ) -> InventoryRecord:
        """Update stock settings and optional product labels atomically."""
        return await self._async_run(
            self._update_inventory_entry,
            entry_id,
            stock,
            minimum_stock,
            category_id,
            category,
            hidden,
            restock_quantity,
            restock_mode,
            label_ids,
        )

    async def async_set_inventory_hidden(
        self, entry_id: str, hidden: bool
    ) -> InventoryRecord:
        """Show or hide one inventory assignment."""
        return await self._async_run(self._set_inventory_hidden, entry_id, hidden)

    async def async_adjust_inventory_entry(
        self, entry_id: str, delta: int
    ) -> InventoryRecord:
        """Increase or decrease stock without allowing negative values."""
        return await self._async_run(self._adjust_inventory_entry, entry_id, delta)

    async def async_get_inventory_restock_settings(
        self, list_id: str
    ) -> InventoryRestockSettingsRecord:
        """Return the automatic restock settings of one inventory."""
        return await self._async_run(self._get_inventory_restock_settings, list_id)

    async def async_set_inventory_restock_settings(
        self, list_id: str, target_list_id: str | None, enabled: bool,
        mode: str | None, fixed_quantity: int | None,
    ) -> InventoryRestockSettingsRecord:
        """Persist automatic restock settings for one inventory."""
        return await self._async_run(
            self._set_inventory_restock_settings, list_id, target_list_id,
            enabled, mode, fixed_quantity,
        )

    async def async_adjust_inventory_with_restock(
        self, entry_id: str, delta: int, *, minimum_stock: int | None = None,
        restock_quantity: int | None = None, restock_mode: str | None = None,
        category_id: str | None = None, category: str | None = None,
    ) -> dict[str, Any]:
        """Adjust stock, optional scanner metadata and the restock rule atomically."""
        return await self._async_run(
            self._adjust_inventory_with_restock, entry_id, delta, minimum_stock,
            restock_quantity, restock_mode, category_id, category,
        )

    async def async_preview_inventory_restock(self, list_id: str) -> dict[str, Any]:
        """Preview all current shortages without changing data."""
        return await self._async_run(self._preview_inventory_restock, list_id)

    async def async_apply_inventory_restock(self, list_id: str) -> dict[str, Any]:
        """Transfer all current shortages after an explicit preview."""
        return await self._async_run(self._apply_inventory_restock, list_id)

    async def async_reset_inventory_restock_latch(
        self, list_id: str, source_type: str, source_id: str
    ) -> None:
        """Reset one fixed-quantity restock latch."""
        await self._async_run(
            self._reset_inventory_restock_latch, list_id, source_type, source_id
        )

    async def async_confirm_zero_stock_restock(
        self, entry_id: str, quantity: int
    ) -> dict[str, Any]:
        """Add an explicitly confirmed removal at stock zero to the target list."""
        return await self._async_run(
            self._confirm_zero_stock_restock, entry_id, quantity
        )

    async def async_delete_inventory_entry(self, entry_id: str) -> str:
        """Remove a product from an inventory list."""
        return await self._async_run(self._delete_inventory_entry, entry_id)

    async def async_list_inventory_groups(
        self, list_id: str
    ) -> list[InventoryGroupRecord]:
        """Return all explicit variant groups of an inventory list."""
        return await self._async_run(self._list_inventory_groups, list_id)

    async def async_create_inventory_group(
        self,
        *,
        list_id: str,
        name: str,
        minimum_stock: int | None,
        category_id: str | None,
        category: str | None,
        member_ids: list[str],
        restock_quantity: int = 1,
        restock_mode: str | None = None,
    ) -> InventoryGroupRecord:
        """Create a list-local group and assign its members."""
        return await self._async_run(
            self._create_inventory_group,
            list_id,
            name,
            minimum_stock,
            category_id,
            category,
            member_ids,
            restock_quantity,
            restock_mode,
        )

    async def async_update_inventory_group(
        self,
        group_id: str,
        *,
        name: str,
        minimum_stock: int | None,
        category_id: str | None,
        category: str | None,
        member_ids: list[str],
        restock_quantity: int | None = None,
        restock_mode: str | None = None,
    ) -> InventoryGroupRecord:
        """Update a group and replace its member assignment."""
        return await self._async_run(
            self._update_inventory_group,
            group_id,
            name,
            minimum_stock,
            category_id,
            category,
            member_ids,
            restock_quantity,
            restock_mode,
        )

    async def async_delete_inventory_group(self, group_id: str) -> str:
        """Dissolve a group without deleting inventory entries."""
        return await self._async_run(self._delete_inventory_group, group_id)

    async def async_list_scanners(self) -> list[ScannerRecord]:
        """Return all configured barcode scanners."""
        return await self._async_run(self._list_scanners)

    async def async_get_scanner_by_address(self, address: str) -> ScannerRecord | None:
        """Return one enabled scanner by its normalized address."""
        return await self._async_run(self._get_scanner_by_address, address)

    async def async_create_scanner(
        self, *, name: str, address: str, enabled: bool, routing: str,
        list_id: str | None, action: str | None,
    ) -> ScannerRecord:
        """Create and return a scanner configuration."""
        return await self._async_run(
            self._create_scanner, name, address, enabled, routing, list_id, action
        )

    async def async_update_scanner(
        self, scanner_id: str, *, name: str, address: str, enabled: bool,
        routing: str, list_id: str | None, action: str | None,
    ) -> ScannerRecord:
        """Update and return a scanner configuration."""
        return await self._async_run(
            self._update_scanner, scanner_id, name, address, enabled, routing,
            list_id, action,
        )

    async def async_delete_scanner(self, scanner_id: str) -> None:
        """Delete a scanner configuration."""
        await self._async_run(self._delete_scanner, scanner_id)

    async def async_get_scanner_target(self) -> ScannerTargetRecord | None:
        """Return the currently active card target, if one is set."""
        return await self._async_run(self._get_scanner_target)

    async def async_set_scanner_target(
        self, list_id: str, action: str
    ) -> ScannerTargetRecord:
        """Persist the single active scanner target."""
        return await self._async_run(self._set_scanner_target, list_id, action)

    async def async_clear_scanner_target(self) -> None:
        """Clear the active scanner target."""
        await self._async_run(self._clear_scanner_target)

    async def async_add_scan_history(
        self, *, scanner_id: str | None, scanner_name: str | None,
        scanner_address: str | None, source: str, ean: str,
        action: str | None, list_id: str | None, product_id: str | None,
        product_name: str | None, inventory_entry_id: str | None,
        quantity: int, stock_before: int | None, stock_after: int | None,
        status: str, message: str | None,
    ) -> ScanHistoryRecord:
        """Append one scan result to the audit log."""
        return await self._async_run(
            self._add_scan_history, scanner_id, scanner_name, scanner_address,
            source, ean, action, list_id, product_id, product_name,
            inventory_entry_id, quantity, stock_before, stock_after, status,
            message,
        )

    async def async_list_scan_history(
        self, limit: int = 100, offset: int = 0
    ) -> tuple[list[ScanHistoryRecord], int]:
        """Return recent scan results, newest first."""
        return await self._async_run(self._list_scan_history, limit, offset)

    async def async_get_scan_history_record(self, scan_id: str) -> ScanHistoryRecord | None:
        """Read one persisted scan, including its terminal status."""
        return await self._async_run(self._get_scan_history_record, scan_id)

    async def async_list_pending_scans(self) -> list[ScanHistoryRecord]:
        """Return scans that still need user input."""
        return await self._async_run(self._list_pending_scans)

    async def async_claim_pending_scan(self, scan_id: str) -> ScanHistoryRecord | None:
        """Atomically claim a pending scan so it can only be applied once."""
        return await self._async_run(self._claim_pending_scan, scan_id)

    async def async_hold_offered_scan(self, scan_id: str) -> ScanHistoryRecord | None:
        """Let one visible card reserve a scan before automatic processing."""
        return await self._async_run(self._hold_offered_scan, scan_id)

    async def async_queue_offered_scan(self, scan_id: str) -> ScanHistoryRecord | None:
        """Move an unclaimed card offer into the persistent wait queue."""
        return await self._async_run(self._queue_offered_scan, scan_id)

    async def async_finish_pending_scan(
        self, scan_id: str, status: str, message: str | None
    ) -> None:
        """Mark a claimed scan as resolved, dismissed, or pending again."""
        await self._async_run(self._finish_pending_scan, scan_id, status, message)

    async def _async_run(self, target: Callable[..., _T], *args: Any) -> _T:
        """Serialize writes; capture committed booking events in the same lock."""
        mutations = {
            "_create_inventory_entry", "_update_inventory_entry", "_adjust_inventory_entry",
            "_adjust_inventory_with_restock", "_undo_inventory_booking", "_delete_inventory_entry",
            "_apply_inventory_restock", "_confirm_zero_stock_restock", "_reset_inventory_restock_latch",
        }
        events = []
        cancelled = None
        async with async_use_language(self._hass), self._lock:
            self._check_available()
            if target.__name__ == "_add_dish_to_list":
                worker, worker_args = self._scripted_dish_write, (target, args)
            elif target.__name__ in mutations:
                worker, worker_args = self._scripted_inventory_write, (target, args)
            else:
                worker, worker_args = target, args
            future = asyncio.ensure_future(self._hass.async_add_executor_job(
                copy_context().run, worker, *worker_args,
            ))
            while True:
                try:
                    outcome = await asyncio.shield(future)
                    break
                except asyncio.CancelledError as error:
                    if future.cancelled():
                        raise
                    # Cancelling an await cannot stop an executing SQLite worker.
                    # Retain the lock and publish committed events before cancelling.
                    cancelled = error
            if worker is target:
                result = outcome
            else:
                result, events = outcome
        for data in events:
            try:
                operation = SCRIPT_OPERATION.get()
                self._hass.bus.async_fire(EVENT_SCRIPT_ACTION, {
                    **(operation or {}), **data, "event_id": str(uuid4()),
                    "script_chain": list(SCRIPT_CHAIN.get()),
                })
            except Exception:
                logging.getLogger(__name__).exception("Unable to publish a committed script action")
        if ((target.__name__ == "_accept_alexa_item" and result.get("accepted"))
                or (target.__name__ == "_apply_alexa_sync_local" and result.get("applied"))):
            # A cancellation cannot undo the SQLite commit. Publish its one
            # mutation before propagating cancellation, just like bookings.
            self._fire_item_mutated(result.pop("_before"), result.pop("_after"))
        if target.__name__ == "_delete_due_completed_items":
            for before in result["items"]:
                self._fire_item_mutated(before, None)
        if cancelled is not None:
            raise cancelled
        return result

    def _scripted_dish_write(self, target, args):
        before = {record.id: record.as_dict() for record in self._list_items(args[1])}
        result = target(*args)
        events = []
        for record in self._list_items(args[1]):
            previous, current = before.get(record.id), record.as_dict()
            if previous is None or any(previous.get(key) != current.get(key) for key in {"quantity", "completed", "name"}):
                events.append(item_script_action(previous, current, "dish"))
        return result, events

    def _script_inventory_entry(self, entry_id):
        if not entry_id:
            return None
        with self._connect() as connection:
            row = connection.execute(f"{self._inventory_select()} WHERE inventory_entries.id=?", (entry_id,)).fetchone()
            return self._inventory_record_from_row(connection, row).as_dict() if row else None

    def _scripted_inventory_write(self, target, args):
        """Snapshot a booking without exposing SQLite or undo snapshots to scripts."""
        command = target.__name__
        entry_id = None if command in {"_create_inventory_entry", "_apply_inventory_restock", "_reset_inventory_restock_latch"} else args[0]
        if command == "_undo_inventory_booking":
            entry_id = getattr(self, "_inventory_bookings", {}).get(args[0], {}).get("entry_id")
        before = self._script_inventory_entry(entry_id)
        undo_shopping = None
        if command == "_undo_inventory_booking" and args[1]:
            rows = getattr(self, "_inventory_bookings", {}).get(args[0], {}).get("after", {}).get("shopping", [])
            undo_shopping = rows[0] if rows else None
        result = target(*args)
        events = []
        try:
            if command in {"_apply_inventory_restock", "_confirm_zero_stock_restock"}:
                list_id = args[0] if command == "_apply_inventory_restock" else before["list_id"]
                transfers = result["items"] if command == "_apply_inventory_restock" else [result]
                events = [{"event": "restock_manual", "list_id": list_id, "target_list_id": result["target_list_id"], **transfer} for transfer in transfers]
            elif command == "_reset_inventory_restock_latch":
                source_type, source_id = args[1:]
                with self._connect() as connection:
                    if source_type == "group":
                        row = connection.execute("SELECT name FROM inventory_groups WHERE id=? AND list_id=?", (source_id, args[0])).fetchone()
                        name = row["name"] if row else ""
                    else:
                        entry = self._script_inventory_entry(source_id)
                        name = entry["product"]["name"] if entry else ""
                events = [{"event": "restock_lock_reset", "list_id": args[0], "name": name}]
            else:
                after = result.as_dict() if hasattr(result, "as_dict") else result.get("entry") if isinstance(result, dict) else None
                record = after or before
                if record:
                    old_stock = before["stock"] if before else 0
                    new_stock = after["stock"] if after else 0
                    if command == "_undo_inventory_booking":
                        event = "inventory_undo_completed"
                    elif command == "_delete_inventory_entry":
                        event = "inventory_removed"
                    elif command == "_create_inventory_entry":
                        event = "inventory_registered"
                    elif old_stock == new_stock:
                        event = None
                    elif command == "_update_inventory_entry":
                        event = "inventory_corrected"
                    else:
                        event = "inventory_in" if new_stock > old_stock else "inventory_out"
                    if event:
                        events.append({"event": event, "list_id": record["list_id"], "entry_id": record["id"],
                            "product": record["product"], "name": record["product"]["name"],
                            "category": (record.get("category") or {}).get("name") or record.get("category_name") or "",
                            "stock_before": old_stock, "stock_after": new_stock, "quantity": abs(new_stock - old_stock),
                            "was_existing": before is not None,
                            "transfer_kept": bool(result.get("transfer_kept")) if isinstance(result, dict) else False})
                    if isinstance(result, dict) and result.get("transfer"):
                        events.append({"event": "restock_automatic", "list_id": record["list_id"], **result["transfer"]})
        except Exception:
            logging.getLogger(__name__).exception("Unable to describe a committed inventory booking")
        if undo_shopping and isinstance(result, dict) and result.get("target_list_id"):
            try:
                after_shopping = self._get_item(undo_shopping["id"]).as_dict()
            except ListItemNotFoundError:
                after_shopping = None
            events.append(item_script_action(undo_shopping, after_shopping, "inventory_undo"))
        # A restock is a separate action on the source and a single mutation on
        # the destination. It must not create a duplicate booking on the source.
        for event in tuple(events):
            if event["event"] in {"restock_manual", "restock_automatic"}:
                previous = event.get("target_previous_quantity", 0)
                events.append({**event, "list_id": event["target_list_id"],
                    "event": "item_added" if event.get("target_item_created") else "item_quantity_changed",
                    "source": "restock", "quantity": previous + event["quantity"],
                    "previous_quantity": previous, "changed_fields": ["quantity"]})
        return result, events

    async def async_get_script_product(self, product_id):
        return await self._async_run(self._script_product_by_id, product_id)

    def _script_product_by_id(self, product_id):
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
        return dict(row) if row else {}

    async def async_get_list_script_settings(self, list_id: str) -> dict[str, Any]:
        return await self._async_run(self._get_list_script_settings, list_id)

    async def async_set_list_script_settings(self, list_id: str, enabled: bool, script_entity: str | None, events: list[str]) -> dict[str, Any]:
        return await self._async_run(self._set_list_script_settings, list_id, enabled, script_entity, events)

    @staticmethod
    def _create_list_scripts_schema(connection):
        connection.execute("""CREATE TABLE IF NOT EXISTS list_script_settings (
            list_id TEXT PRIMARY KEY REFERENCES lists(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
            script_entity TEXT, events TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL)""")

    def _get_list_script_settings(self, list_id):
        record = self._get_list(list_id)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM list_script_settings WHERE list_id=?", (list_id,)).fetchone()
        settings = dict(row) if row else {"list_id": list_id, "enabled": False, "script_entity": None, "events": []}
        settings["enabled"] = bool(settings["enabled"])
        if isinstance(settings["events"], str):
            settings["events"] = json.loads(settings["events"])
        options = event_options(record.list_type)
        allowed = {option["event"] for option in options}
        settings["events"] = [event for event in settings["events"] if event in allowed]
        return {"settings": settings, "options": options}

    def _set_list_script_settings(self, list_id, enabled, script_entity, events):
        record = self._get_list(list_id)
        allowed = {option["event"] for option in event_options(record.list_type)}
        script_entity = str(script_entity or "").strip() or None
        if (not isinstance(enabled, bool) or not isinstance(events, list) or
            any(not isinstance(event, str) or event not in allowed for event in events) or
            (script_entity is not None and not re.fullmatch(r"script\.[a-z0-9_]+", script_entity)) or
            (enabled and (not script_entity or not events))):
            raise ValueError(localized_text("scripts.settings_invalid"))
        events = list(dict.fromkeys(events))
        with self._connect() as connection:
            connection.execute("""INSERT INTO list_script_settings(list_id,enabled,script_entity,events,updated_at)
                VALUES(?,?,?,?,?) ON CONFLICT(list_id) DO UPDATE SET enabled=excluded.enabled,
                script_entity=excluded.script_entity, events=excluded.events, updated_at=excluded.updated_at""",
                (list_id, int(enabled), script_entity, json.dumps(events), self._now()))
        return self._get_list_script_settings(list_id)

    def _fire_item_mutated(
        self, before: ListItemRecord | None, after: ListItemRecord | None
    ) -> None:
        """Publish one committed list-item mutation for backend consumers."""
        record = after or before
        if record is None:
            return
        self._hass.bus.async_fire(
            EVENT_ITEM_MUTATED,
            {
                "list_id": record.list_id,
                "item_id": record.id,
                "before": before.as_dict() if before else None,
                "after": after.as_dict() if after else None,
                "event_id": str(uuid4()), "script_chain": list(SCRIPT_CHAIN.get()),
                **(SCRIPT_OPERATION.get() or {}),
            },
        )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            connection.row_factory = sqlite3.Row
            connection.create_function("product_text", 1, _product_text, deterministic=True)
            connection.execute("PRAGMA foreign_keys = ON")
            # SQLite's transaction context commits/rolls back but does not close.
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            tables = {
                row["name"] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%'"
                )
            }
            if tables:
                if "schema_metadata" not in tables:
                    raise UnsupportedSchemaVersionError(
                        "The existing database has no supported schema metadata"
                    )
                version = self._read_schema_version(connection)
                if version not in (1, 2, 3, 4, 5, DATABASE_SCHEMA_VERSION):
                    raise UnsupportedSchemaVersionError(
                        f"Database schema {version} is not supported; "
                        f"expected {DATABASE_SCHEMA_VERSION}"
                    )
            else:
                version = 0

            # Check existing data before changing journal mode or creating tables.
            connection.execute("PRAGMA journal_mode = WAL")
            if version == 0:
                connection.execute(
                    "CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
                )
                self._create_schema(connection)
                connection.execute(
                    "INSERT INTO schema_metadata(key, value) VALUES('schema_version', ?)",
                    (str(DATABASE_SCHEMA_VERSION),),
                )
            elif version < DATABASE_SCHEMA_VERSION:
                # Additive upgrades preserve existing records and IDs. All DDL
                # and the version marker commit together or roll back together.
                connection.execute("BEGIN IMMEDIATE")
                if version == 1:
                    self._create_alexa_schema(connection)
                if version < 3:
                    connection.execute("ALTER TABLE lists ADD COLUMN capitalize_first_letter "
                                       "INTEGER NOT NULL DEFAULT 0 CHECK(capitalize_first_letter IN (0,1))")
                    if version == 2:
                        connection.execute("ALTER TABLE alexa_receipts ADD COLUMN sync_json TEXT NOT NULL DEFAULT '{}'")
                    self._create_alexa_history_schema(connection)
                    self._create_alexa_tombstone_schema(connection)
                    self._seed_alexa_history(connection)
                if version < 4:
                    self._create_alexa_outbox_schema(connection)
                if version < 5:
                    self._create_label_filters_schema(connection)
                self._create_completed_cleanup_schema(connection)
                connection.execute(
                    "UPDATE schema_metadata SET value = ? WHERE key = 'schema_version'",
                    (str(DATABASE_SCHEMA_VERSION),),
                )
            self._prune_alexa_tombstones_in(connection, self._now())

    @staticmethod
    def _create_completed_cleanup_schema(connection):
        connection.execute("ALTER TABLE lists ADD COLUMN auto_delete_completed INTEGER NOT NULL DEFAULT 0 CHECK(auto_delete_completed IN (0,1))")
        connection.execute("ALTER TABLE lists ADD COLUMN auto_delete_delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK(auto_delete_delay_minutes BETWEEN 0 AND 525600)")
        connection.execute("ALTER TABLE lists ADD COLUMN auto_delete_confirm INTEGER NOT NULL DEFAULT 0 CHECK(auto_delete_confirm IN (0,1))")
        connection.execute("ALTER TABLE list_items ADD COLUMN completed_delete_at TEXT")
        connection.execute("CREATE INDEX list_items_cleanup_due ON list_items(completed_delete_at) WHERE completed_delete_at IS NOT NULL")
        # Every producer (cards, Alexa, automation) uses the same atomic transition.
        # Inserts and repeated completed=1 writes intentionally do not schedule old imports.
        connection.execute("""CREATE TRIGGER completed_cleanup_changed AFTER UPDATE OF completed ON list_items
          WHEN NEW.completed != OLD.completed BEGIN
          UPDATE list_items SET completed_delete_at = CASE WHEN NEW.completed=1 AND EXISTS(
            SELECT 1 FROM lists WHERE id=NEW.list_id AND list_type='shopping' AND provider='local'
            AND enabled=1 AND auto_delete_completed=1)
            THEN strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('+%d minutes',
              (SELECT auto_delete_delay_minutes FROM lists WHERE id=NEW.list_id))) ELSE NULL END
          WHERE id=NEW.id; END""")
        connection.execute("""CREATE TRIGGER completed_cleanup_disabled AFTER UPDATE OF auto_delete_completed,enabled ON lists
          WHEN NEW.auto_delete_completed=0 OR NEW.enabled=0 BEGIN
          UPDATE list_items SET completed_delete_at=NULL WHERE list_id=NEW.id AND completed_delete_at IS NOT NULL; END""")

    @staticmethod
    def _validate_completed_cleanup(list_type, provider, enabled, minutes, confirm):
        if (type(minutes) is not int or not 0 <= minutes <= 525600 or
                (list_type != "shopping" or provider != "local") and (enabled or confirm or minutes)):
            raise ValueError(localized_text("cleanup.invalid"))

    async def async_delete_due_completed_items(self):
        """Commit due deletions and publish mutations before releasing cancellation."""
        return await self._async_run(self._delete_due_completed_items)

    def _delete_due_completed_items(self):
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("""SELECT i.* FROM list_items i JOIN lists l ON l.id=i.list_id
              WHERE i.completed=1 AND i.completed_delete_at IS NOT NULL AND julianday(i.completed_delete_at)<=julianday(?)
              AND l.list_type='shopping' AND l.provider='local' AND l.enabled=1 AND l.auto_delete_completed=1
              ORDER BY i.completed_delete_at LIMIT 100""",(self._now(),)).fetchall()
            records = [self._item_record_from_row(row,self._labels_for(connection,"list_item_labels","item_id",row["id"],row["list_id"])) for row in rows]
            connection.executemany("DELETE FROM list_items WHERE id=?",[(row["id"],) for row in rows])
            deadline = connection.execute("""SELECT MIN(i.completed_delete_at) FROM list_items i JOIN lists l ON l.id=i.list_id
              WHERE i.completed=1 AND julianday(i.completed_delete_at) IS NOT NULL AND l.auto_delete_completed=1
              AND l.enabled=1 AND l.provider='local' AND l.list_type='shopping'""").fetchone()[0]
        return {"items": records, "next_deadline": deadline}

    def _create_schema(self, connection: sqlite3.Connection) -> None:
        """Create the complete current schema for a first installation."""
        connection.executescript(
            """
CREATE TABLE lists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                capitalize_first_letter INTEGER NOT NULL DEFAULT 0
                    CHECK (capitalize_first_letter IN (0, 1)),
                list_type TEXT NOT NULL CHECK (
                    list_type IN ('shopping', 'todo', 'inventory')
                ),
                icon TEXT,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                provider TEXT NOT NULL DEFAULT 'local'
                    CHECK (provider IN ('local', 'bring')),
                external_entity_id TEXT,
                label_conflict_policy TEXT NOT NULL DEFAULT 'specific'
                    CHECK (label_conflict_policy IN ('specific', 'separate', 'global')),
                use_global_categories INTEGER NOT NULL DEFAULT 1
                    CHECK (use_global_categories IN (0, 1)),
                use_type_categories INTEGER NOT NULL DEFAULT 1
                    CHECK (use_type_categories IN (0, 1)),
                use_global_labels INTEGER NOT NULL DEFAULT 1
                    CHECK (use_global_labels IN (0, 1)),
                use_type_labels INTEGER NOT NULL DEFAULT 1
                    CHECK (use_type_labels IN (0, 1)),
                use_list_labels INTEGER NOT NULL DEFAULT 1
                    CHECK (use_list_labels IN (0, 1)),
                use_global_chips INTEGER NOT NULL DEFAULT 1
                    CHECK (use_global_chips IN (0, 1)),
                use_type_chips INTEGER NOT NULL DEFAULT 1
                    CHECK (use_type_chips IN (0, 1)),
                use_dishes INTEGER NOT NULL DEFAULT 0
                    CHECK (use_dishes IN (0, 1)),
                use_tandoor INTEGER NOT NULL DEFAULT 0
                    CHECK (use_tandoor IN (0, 1)),
                tandoor_skip_small_units INTEGER NOT NULL DEFAULT 0
                    CHECK (tandoor_skip_small_units IN (0, 1)),
                tandoor_include_ingredients INTEGER NOT NULL DEFAULT 1
                    CHECK (tandoor_include_ingredients IN (0, 1)),
                tandoor_excluded_units TEXT NOT NULL DEFAULT '',
                tandoor_result_limit INTEGER NOT NULL DEFAULT 100
                    CHECK (tandoor_result_limit IN (10, 25, 50, 100)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE list_items (
                offer_only INTEGER NOT NULL DEFAULT 0 CHECK (offer_only IN (0, 1)),
                id TEXT PRIMARY KEY,
                list_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
                category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
                category TEXT,
                due_at TEXT,
                recurrence_interval INTEGER CHECK (
                    recurrence_interval IS NULL OR recurrence_interval >= 1
                ),
                recurrence_unit TEXT CHECK (
                    recurrence_unit IS NULL OR recurrence_unit IN ('H', 'D', 'M')
                ),
                completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                position INTEGER NOT NULL DEFAULT 0,
                product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
                external_uid TEXT,
                inventory_source_type TEXT CHECK (
                    inventory_source_type IS NULL OR inventory_source_type IN ('entry', 'group')
                ),
                inventory_source_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
            );

CREATE TABLE products (
                id TEXT PRIMARY KEY,
                ean TEXT,
                name TEXT NOT NULL COLLATE NOCASE,
                original_name TEXT,
                brand TEXT,
                package_quantity TEXT,
                category TEXT,
                image_url TEXT,
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE categories (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                scope TEXT NOT NULL CHECK (scope IN ('global', 'list_type', 'list')),
                list_type TEXT CHECK (
                    list_type IS NULL OR list_type IN ('shopping', 'todo', 'inventory')
                ),
                list_id TEXT,
                icon TEXT,
                color TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                CHECK (
                    (scope = 'global' AND list_type IS NULL AND list_id IS NULL)
                    OR (scope = 'list_type' AND list_type IS NOT NULL AND list_id IS NULL)
                    OR (scope = 'list' AND list_type IS NULL AND list_id IS NOT NULL)
                ),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
            );

CREATE TABLE product_category_assignments (
                product_id TEXT NOT NULL,
                category_id TEXT NOT NULL,
                PRIMARY KEY (product_id, category_id),
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
            );

CREATE TABLE category_rules (
                id TEXT PRIMARY KEY,
                category_id TEXT NOT NULL,
                pattern TEXT NOT NULL COLLATE NOCASE,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(category_id, pattern COLLATE NOCASE),
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
            );

CREATE TABLE labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                icon TEXT,
                color TEXT,
                scope TEXT NOT NULL DEFAULT 'global'
                    CHECK (scope IN ('global', 'list_type', 'list')),
                list_type TEXT CHECK (
                    list_type IS NULL OR list_type IN ('shopping', 'todo', 'inventory')
                ),
                list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                CHECK (
                    (scope = 'global' AND list_type IS NULL AND list_id IS NULL)
                    OR (scope = 'list_type' AND list_type IS NOT NULL AND list_id IS NULL)
                    OR (scope = 'list' AND list_type IS NULL AND list_id IS NOT NULL)
                )
            );

CREATE TABLE chips (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                priority_name TEXT NOT NULL,
                chip_kind TEXT NOT NULL DEFAULT 'entry'
                    CHECK (chip_kind IN ('entry', 'todo_template')),
                icon TEXT,
                color TEXT,
                scope TEXT NOT NULL DEFAULT 'global'
                    CHECK (scope IN ('global', 'list_type', 'list')),
                list_type TEXT CHECK (
                    list_type IS NULL OR list_type IN ('shopping', 'todo', 'inventory')
                ),
                list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
                product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
                template_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                CHECK (
                    (scope = 'global' AND list_type IS NULL AND list_id IS NULL)
                    OR (scope = 'list_type' AND list_type IS NOT NULL AND list_id IS NULL)
                    OR (scope = 'list' AND list_type IS NULL AND list_id IS NOT NULL)
                )
            );

CREATE TABLE important_chip_assignments (
                list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
                target_type TEXT NOT NULL CHECK (target_type IN ('chip', 'product')),
                target_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (list_id, target_type, target_id)
            );
CREATE INDEX important_chip_assignments_list_idx
    ON important_chip_assignments(list_id, created_at);

CREATE TABLE dishes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                normalized_name TEXT NOT NULL,
                color TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE dish_items (
                id TEXT PRIMARY KEY,
                dish_id TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
                position INTEGER NOT NULL DEFAULT 0
            );
CREATE UNIQUE INDEX dishes_normalized_name_unique ON dishes(normalized_name);
CREATE INDEX dish_items_dish_order_idx ON dish_items(dish_id, position);

CREATE TABLE product_labels (
                product_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                PRIMARY KEY (product_id, label_id),
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
            );

CREATE TABLE list_item_labels (
                item_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                PRIMARY KEY (item_id, label_id),
                FOREIGN KEY (item_id) REFERENCES list_items(id) ON DELETE CASCADE,
                FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
            );

CREATE TABLE inventory_entries (
                id TEXT PRIMARY KEY,
                list_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
                minimum_stock INTEGER CHECK (
                    minimum_stock IS NULL OR minimum_stock >= 0
                ),
                restock_quantity INTEGER NOT NULL DEFAULT 1 CHECK (
                    restock_quantity >= 1
                ),
                restock_mode TEXT CHECK (
                    restock_mode IS NULL OR restock_mode IN ('disabled', 'continuous', 'fixed', 'one_to_one')
                ),
                category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
                category TEXT,
                hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (list_id, product_id),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            );

CREATE TABLE inventory_groups (
                id TEXT PRIMARY KEY,
                list_id TEXT NOT NULL,
                name TEXT NOT NULL COLLATE NOCASE,
                minimum_stock INTEGER CHECK (
                    minimum_stock IS NULL OR minimum_stock >= 0
                ),
                restock_quantity INTEGER NOT NULL DEFAULT 1 CHECK (
                    restock_quantity >= 1
                ),
                restock_mode TEXT CHECK (
                    restock_mode IS NULL OR restock_mode IN ('disabled', 'continuous', 'fixed', 'one_to_one')
                ),
                category_id TEXT,
                category TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (list_id, name),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
            );

CREATE TABLE inventory_group_members (
                group_id TEXT NOT NULL,
                inventory_entry_id TEXT NOT NULL UNIQUE,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (group_id, inventory_entry_id),
                FOREIGN KEY (group_id) REFERENCES inventory_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (inventory_entry_id) REFERENCES inventory_entries(id) ON DELETE CASCADE
            );

CREATE TABLE inventory_restock_settings (
                list_id TEXT PRIMARY KEY,
                target_list_id TEXT,
                enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
                default_mode TEXT CHECK (
                    default_mode IS NULL OR default_mode IN ('continuous', 'fixed', 'one_to_one')
                ),
                default_restock_quantity INTEGER CHECK (
                    default_restock_quantity IS NULL OR default_restock_quantity >= 1
                ),
                updated_at TEXT NOT NULL,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (target_list_id) REFERENCES lists(id) ON DELETE SET NULL
            );

CREATE TABLE inventory_restock_state (
                list_id TEXT NOT NULL,
                source_type TEXT NOT NULL CHECK (source_type IN ('entry', 'group')),
                source_id TEXT NOT NULL,
                latched INTEGER NOT NULL DEFAULT 0 CHECK (latched IN (0, 1)),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (list_id, source_type, source_id),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
            );

CREATE TABLE scanners (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                address TEXT NOT NULL COLLATE NOCASE,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                routing TEXT NOT NULL CHECK (routing IN ('active_target', 'fixed')),
                list_id TEXT,
                action TEXT CHECK (action IN ('add', 'remove', 'register', 'correct')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (address),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                CHECK (
                    (routing = 'active_target' AND list_id IS NULL AND action IS NULL)
                    OR (routing = 'fixed' AND list_id IS NOT NULL AND action IS NOT NULL)
                )
            );

CREATE TABLE scanner_target (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                list_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('add', 'remove', 'register', 'correct')),
                updated_at TEXT NOT NULL,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
            );

CREATE TABLE scan_history (
                id TEXT PRIMARY KEY,
                scanned_at TEXT NOT NULL,
                scanner_id TEXT,
                scanner_name TEXT,
                scanner_address TEXT,
                source TEXT NOT NULL,
                ean TEXT NOT NULL,
                action TEXT,
                list_id TEXT,
                product_id TEXT,
                product_name TEXT,
                inventory_entry_id TEXT,
                quantity INTEGER NOT NULL DEFAULT 1,
                stock_before INTEGER,
                stock_after INTEGER,
                status TEXT NOT NULL,
                message TEXT,
                FOREIGN KEY (scanner_id) REFERENCES scanners(id) ON DELETE SET NULL,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE SET NULL,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
                FOREIGN KEY (inventory_entry_id) REFERENCES inventory_entries(id) ON DELETE SET NULL
            );

CREATE TABLE list_category_order (
                list_id TEXT NOT NULL,
                category_id TEXT NOT NULL,
                position INTEGER NOT NULL CHECK (position >= 0),
                PRIMARY KEY (list_id, category_id),
                UNIQUE (list_id, position),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
            );

CREATE TABLE notification_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE,
                provider TEXT NOT NULL CHECK (
                    provider IN (
                        'notify_entity', 'notify_service', 'ntfy', 'persistent'
                    )
                ),
                target TEXT NOT NULL,
                title TEXT,
                click_url TEXT,
                message_format TEXT NOT NULL DEFAULT 'plain' CHECK (
                    message_format IN ('plain', 'markdown', 'html')
                ),
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE list_notification_profiles (
                list_id TEXT NOT NULL,
                profile_id TEXT NOT NULL,
                manual_enabled INTEGER NOT NULL DEFAULT 1 CHECK (
                    manual_enabled IN (0, 1)
                ),
                automatic_mode TEXT NOT NULL DEFAULT 'off' CHECK (
                    automatic_mode IN ('off', 'changes', 'full', 'changes_and_full')
                ),
                delay_seconds INTEGER NOT NULL DEFAULT 15
                    CHECK (delay_seconds BETWEEN 0 AND 86400),
                notify_on_add INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_add IN (0, 1)),
                notify_on_increase INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_increase IN (0, 1)),
                notify_on_decrease INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_decrease IN (0, 1)),
                notify_on_edit INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_edit IN (0, 1)),
                notify_on_complete INTEGER NOT NULL DEFAULT 0 CHECK (notify_on_complete IN (0, 1)),
                notify_on_reopen INTEGER NOT NULL DEFAULT 0 CHECK (notify_on_reopen IN (0, 1)),
                notify_on_delete INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_delete IN (0, 1)),
                PRIMARY KEY (list_id, profile_id),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (profile_id) REFERENCES notification_profiles(id)
                    ON DELETE CASCADE
            );

CREATE TABLE notification_pending_batches (
                list_id TEXT NOT NULL,
                profile_id TEXT NOT NULL,
                due_at TEXT NOT NULL,
                changes_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (list_id, profile_id),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (profile_id) REFERENCES notification_profiles(id)
                    ON DELETE CASCADE
            );

CREATE TABLE external_item_metadata (
                list_id TEXT NOT NULL,
                match_key TEXT NOT NULL,
                last_name TEXT NOT NULL,
                category_id TEXT,
                category TEXT,
                product_id TEXT,
                label_ids_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (list_id, match_key),
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
            );

CREATE TABLE external_list_sync_status (
                list_id TEXT PRIMARY KEY,
                status TEXT NOT NULL CHECK (status IN ('syncing', 'ok', 'error')),
                last_attempt_at TEXT NOT NULL,
                last_success_at TEXT,
                last_change_at TEXT,
                last_error TEXT,
                FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
            );

CREATE UNIQUE INDEX lists_name_unique ON lists(name COLLATE NOCASE);

CREATE INDEX list_items_list_id_idx ON list_items(list_id);

CREATE INDEX list_items_order_idx ON list_items(list_id, completed, position, created_at);

CREATE UNIQUE INDEX products_ean_unique ON products(ean) WHERE ean IS NOT NULL;

CREATE INDEX products_name_idx ON products(name COLLATE NOCASE);

CREATE UNIQUE INDEX categories_global_name_unique ON categories(name COLLATE NOCASE) WHERE scope = 'global';

CREATE UNIQUE INDEX categories_type_name_unique ON categories(list_type, name COLLATE NOCASE) WHERE scope = 'list_type';

CREATE UNIQUE INDEX categories_list_name_unique ON categories(list_id, name COLLATE NOCASE) WHERE scope = 'list';

CREATE INDEX categories_order_idx ON categories(scope, list_type, list_id, position, name COLLATE NOCASE);

CREATE INDEX product_category_assignments_category_idx
    ON product_category_assignments(category_id, product_id);

CREATE INDEX category_rules_category_idx
    ON category_rules(category_id, position);

CREATE INDEX list_items_category_id_idx ON list_items(category_id);

CREATE INDEX product_labels_label_idx ON product_labels(label_id, product_id);

CREATE INDEX list_item_labels_label_idx ON list_item_labels(label_id, item_id);

CREATE INDEX inventory_entries_list_order_idx ON inventory_entries(list_id, position, created_at);

CREATE INDEX inventory_entries_product_idx ON inventory_entries(product_id);

CREATE INDEX inventory_entries_category_idx ON inventory_entries(list_id, category_id);

CREATE INDEX inventory_groups_list_order_idx ON inventory_groups(list_id, position, name COLLATE NOCASE);

CREATE INDEX inventory_group_members_order_idx ON inventory_group_members(group_id, position);

CREATE UNIQUE INDEX scanners_address_unique ON scanners(address COLLATE NOCASE);

CREATE INDEX scan_history_time_idx ON scan_history(scanned_at DESC);

CREATE INDEX list_items_product_id_idx ON list_items(product_id);

CREATE UNIQUE INDEX notification_profiles_name_unique ON notification_profiles(name COLLATE NOCASE);

CREATE INDEX notification_pending_due_idx ON notification_pending_batches(due_at);

CREATE UNIQUE INDEX lists_external_entity_unique ON lists(external_entity_id) WHERE external_entity_id IS NOT NULL;

CREATE UNIQUE INDEX list_items_external_uid_unique ON list_items(list_id, external_uid) WHERE external_uid IS NOT NULL;

CREATE UNIQUE INDEX labels_global_name_unique ON labels(name COLLATE NOCASE) WHERE scope = 'global';

CREATE UNIQUE INDEX labels_type_name_unique ON labels(list_type, name COLLATE NOCASE) WHERE scope = 'list_type';

CREATE UNIQUE INDEX labels_list_name_unique ON labels(list_id, name COLLATE NOCASE) WHERE scope = 'list';

CREATE UNIQUE INDEX chips_global_name_unique ON chips(priority_name) WHERE scope = 'global';

CREATE UNIQUE INDEX chips_type_name_unique ON chips(list_type, priority_name) WHERE scope = 'list_type';

CREATE UNIQUE INDEX chips_list_name_unique ON chips(list_id, priority_name) WHERE scope = 'list';
            """
        )
        self._create_entity_history_schema(connection)
        self._create_user_favorites_schema(connection)
        self._create_inventory_restock_transfers_schema(connection)
        self._create_list_scripts_schema(connection)
        self._create_alexa_schema(connection)
        self._create_alexa_outbox_schema(connection)
        self._create_label_filters_schema(connection)
        self._create_completed_cleanup_schema(connection)

    @staticmethod
    def _create_label_filters_schema(connection: sqlite3.Connection) -> None:
        connection.execute("""CREATE TABLE IF NOT EXISTS user_label_filters (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
            name TEXT NOT NULL COLLATE NOCASE,
            label_ids_json TEXT NOT NULL,
            include_unlabeled INTEGER NOT NULL CHECK(include_unlabeled IN (0,1)),
            revision INTEGER NOT NULL DEFAULT 1,
            UNIQUE(user_id, list_id, name)
        )""")

    @staticmethod
    def _create_alexa_schema(connection: sqlite3.Connection) -> None:
        """Keep one connection and durable per-source processing receipts."""
        connection.execute("""CREATE TABLE IF NOT EXISTS alexa_inbox (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            settings_json TEXT NOT NULL DEFAULT '{}',
            status_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL)""")
        # No foreign keys to list_items/lists: deleting an imported item must
        # never make its still-visible Amazon source eligible for import again.
        connection.execute("""CREATE TABLE IF NOT EXISTS alexa_receipts (
            source_id TEXT NOT NULL,
            uid TEXT NOT NULL,
            source_entity_id TEXT,
            target_list_id TEXT,
            item_id TEXT,
            original_name TEXT,
            name TEXT,
            description TEXT,
            quantity INTEGER,
            cleanup_action TEXT NOT NULL CHECK(cleanup_action IN ('keep','complete','delete')),
            cleanup_status TEXT NOT NULL CHECK(cleanup_status IN ('ignored','kept','pending','done','error')),
            created_at TEXT NOT NULL,
            cleaned_at TEXT,
            last_error TEXT,
            sync_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY(source_id, uid))""")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS alexa_cleanup_idx "
            "ON alexa_receipts(cleanup_status, created_at)"
        )
        HaListManagerDatabase._create_alexa_history_schema(connection)
        HaListManagerDatabase._create_alexa_tombstone_schema(connection)

    @staticmethod
    def _create_alexa_tombstone_schema(connection: sqlite3.Connection) -> None:
        connection.execute("""CREATE TABLE IF NOT EXISTS alexa_tombstones (
            source_id TEXT NOT NULL, uid_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
            PRIMARY KEY(source_id,uid_hash))""")
        connection.execute("CREATE INDEX IF NOT EXISTS alexa_tombstone_expiry ON alexa_tombstones(expires_at)")

    @staticmethod
    def _create_alexa_outbox_schema(connection: sqlite3.Connection) -> None:
        """Queue new local rows in their original transaction, never backfill."""
        # Keep attempted jobs after local deletion: a lost cloud response may
        # still need a remote ID attached before its orphan can be removed.
        connection.execute("""CREATE TABLE IF NOT EXISTS alexa_outbox (
            id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_entity_id TEXT NOT NULL,
            target_list_id TEXT NOT NULL, item_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'queued'
                CHECK(state IN ('queued','attempted','uncertain','cancelled')),
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(source_id,target_list_id,item_id))""")
        connection.execute("CREATE INDEX IF NOT EXISTS alexa_outbox_source ON alexa_outbox(source_id,target_list_id,state)")
        # This covers card, API, backend, scanner and transfer inserts equally.
        # Alexa intake commits its receipt in the same transaction, allowing
        # that transient queue row to be removed before any sender sees it.
        connection.execute("""CREATE TRIGGER IF NOT EXISTS alexa_outbox_item_created
AFTER INSERT ON list_items
WHEN NEW.completed=0 AND NEW.external_uid IS NULL
BEGIN
    INSERT OR IGNORE INTO alexa_outbox(
        id,source_id,source_entity_id,target_list_id,item_id,payload_json,created_at,updated_at)
    SELECT lower(hex(randomblob(16))),json_extract(settings_json,'$.source_registry_id'),
        json_extract(settings_json,'$.source_entity_id'),NEW.list_id,NEW.id,
        json_object('local',json_object('id',NEW.id,'name',NEW.name,'description',NEW.description,
            'quantity',NEW.quantity,'completed',json('false'),'updated_at',NEW.updated_at)),
        NEW.created_at,NEW.created_at
    FROM alexa_inbox JOIN lists ON lists.id=NEW.list_id
    WHERE alexa_inbox.id=1 AND lists.provider='local' AND lists.list_type='shopping'
        AND lists.enabled=1 AND json_extract(settings_json,'$.enabled')=1
        AND json_extract(settings_json,'$.mode')='coupled'
        AND json_extract(settings_json,'$.send_local_items')=1
        AND json_extract(settings_json,'$.target_list_id')=NEW.list_id
        AND length(json_extract(settings_json,'$.source_registry_id'))>0
        AND length(json_extract(settings_json,'$.source_entity_id'))>0;
END""")
        connection.execute("""CREATE TRIGGER IF NOT EXISTS alexa_outbox_item_deleted
AFTER DELETE ON list_items
BEGIN
    DELETE FROM alexa_outbox WHERE item_id=OLD.id AND state='queued';
END""")

    @staticmethod
    def _prune_alexa_tombstones_in(connection: sqlite3.Connection, now: str) -> int:
        return connection.execute("DELETE FROM alexa_tombstones WHERE expires_at<=?", (now,)).rowcount

    def _prune_alexa_tombstones(self) -> int:
        with self._connect() as connection:
            return self._prune_alexa_tombstones_in(connection, self._now())

    @staticmethod
    def _create_alexa_history_schema(connection: sqlite3.Connection) -> None:
        connection.execute("""CREATE TABLE IF NOT EXISTS alexa_history (
            source_id TEXT NOT NULL, uid TEXT NOT NULL, source_entity_id TEXT,
            target_list_id TEXT, item_id TEXT, original_name TEXT, name TEXT,
            description TEXT, quantity INTEGER, cleanup_action TEXT NOT NULL,
            cleanup_status TEXT NOT NULL, created_at TEXT NOT NULL,
            cleaned_at TEXT, last_error TEXT, PRIMARY KEY(source_id,uid))""")

    @staticmethod
    def _seed_alexa_history(connection: sqlite3.Connection) -> None:
        connection.execute(f"INSERT OR IGNORE INTO alexa_history({_ALEXA_HISTORY_COLUMNS}) SELECT {_ALEXA_HISTORY_COLUMNS} "
                           "FROM alexa_receipts WHERE cleanup_status!='ignored' "
                           "ORDER BY created_at DESC,source_id,uid LIMIT 20")

    @staticmethod
    def _create_inventory_restock_transfers_schema(
        connection: sqlite3.Connection,
    ) -> None:
        """Keep the last manual and automatic transfers independently of locks."""
        connection.executescript(
            """
CREATE TABLE IF NOT EXISTS inventory_restock_transfers (
    list_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('entry', 'group')),
    source_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'automatic')),
    transferred_at TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 1),
    target_list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
    target_list_name TEXT NOT NULL,
    mode TEXT,
    PRIMARY KEY (list_id, source_type, source_id, origin),
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
    CHECK (
        (origin = 'manual' AND mode IS NULL)
        OR (origin = 'automatic' AND mode IS NOT NULL
            AND mode IN ('continuous', 'fixed', 'one_to_one'))
    )
);
CREATE TRIGGER IF NOT EXISTS inventory_restock_transfers_entry_deleted
AFTER DELETE ON inventory_entries
BEGIN
    DELETE FROM inventory_restock_transfers
    WHERE list_id = OLD.list_id AND source_type = 'entry' AND source_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS inventory_restock_transfers_group_deleted
AFTER DELETE ON inventory_groups
BEGIN
    DELETE FROM inventory_restock_transfers
    WHERE list_id = OLD.list_id AND source_type = 'group' AND source_id = OLD.id;
END;
"""
        )

    def _create_user_favorites_schema(
        self, connection: sqlite3.Connection
    ) -> None:
        """Add user-specific shortcuts without coupling them to one browser."""
        connection.executescript(
            """
CREATE TABLE IF NOT EXISTS user_favorites (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                section TEXT NOT NULL,
                tab TEXT NOT NULL DEFAULT '',
                target_id TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(user_id, section, tab, target_id)
            );
CREATE INDEX IF NOT EXISTS user_favorites_user_order_idx
    ON user_favorites(user_id, position, created_at);
            """
        )

    def _create_entity_history_schema(self, connection: sqlite3.Connection) -> None:
        """Create the tables owned by the independent entity-history feature."""
        connection.executescript(
            """
CREATE TABLE IF NOT EXISTS tracked_entities (
                entity_id TEXT PRIMARY KEY COLLATE NOCASE,
                registry_entry_id TEXT,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE IF NOT EXISTS entity_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id TEXT NOT NULL COLLATE NOCASE,
                state TEXT NOT NULL,
                attributes_json TEXT NOT NULL,
                last_changed TEXT NOT NULL,
                last_updated TEXT NOT NULL,
                last_reported TEXT,
                recorded_at TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'live',
                FOREIGN KEY (entity_id) REFERENCES tracked_entities(entity_id)
                    ON DELETE CASCADE
            );

CREATE INDEX IF NOT EXISTS entity_states_entity_time_idx
ON entity_states(entity_id, last_updated, id);

CREATE TABLE IF NOT EXISTS entity_state_corrections (
                id INTEGER PRIMARY KEY,
                state TEXT NOT NULL,
                attributes_json TEXT NOT NULL,
                last_updated TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                FOREIGN KEY (id) REFERENCES entity_states(id) ON DELETE CASCADE
            );

CREATE UNIQUE INDEX IF NOT EXISTS tracked_entities_registry_entry_unique
ON tracked_entities(registry_entry_id)
WHERE registry_entry_id IS NOT NULL;
            """
        )
        self._create_entity_visibility_schema(connection)


    def _create_entity_visibility_schema(self, connection: sqlite3.Connection) -> None:
        connection.execute("""CREATE TABLE IF NOT EXISTS entity_state_visibility (
            id INTEGER PRIMARY KEY,
            hidden_at TEXT NOT NULL,
            FOREIGN KEY (id) REFERENCES entity_states(id) ON DELETE CASCADE
        )""")

    def _list_tracked_entities(self) -> list[TrackedEntityRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT tracked_entities.*,
                       COUNT(entity_states.id) - COUNT(v.id) AS sample_count,
                       COUNT(v.id) AS hidden_count,
                       SUM(CASE WHEN v.id IS NULL AND entity_states.source != 'manual'
                           AND lower(trim(COALESCE(c.state, entity_states.state)))
                               IN ('unknown', 'unavailable') THEN 1 ELSE 0 END) AS unavailable_count,
                       options.value AS history_options,
                       MIN(CASE WHEN v.id IS NULL THEN entity_states.last_updated END) AS first_recorded_at,
                       MAX(CASE WHEN v.id IS NULL THEN entity_states.last_updated END) AS last_recorded_at
                FROM tracked_entities
                LEFT JOIN entity_states
                  ON entity_states.entity_id = tracked_entities.entity_id
                LEFT JOIN entity_state_visibility AS v ON v.id = entity_states.id
                LEFT JOIN entity_state_corrections AS c ON c.id = entity_states.id
                LEFT JOIN schema_metadata AS options
                  ON options.key = 'entity_history_options:' || lower(tracked_entities.entity_id)
                GROUP BY tracked_entities.entity_id
                ORDER BY tracked_entities.entity_id COLLATE NOCASE
                """
            ).fetchall()
        return [
            TrackedEntityRecord(
                entity_id=row["entity_id"],
                registry_entry_id=row["registry_entry_id"],
                enabled=bool(row["enabled"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                sample_count=int(row["sample_count"]),
                hidden_count=int(row["hidden_count"]),
                first_recorded_at=row["first_recorded_at"],
                last_recorded_at=row["last_recorded_at"],
                ignore_unavailable=self._entity_history_ignore_option(row["history_options"]),
                unavailable_count=int(row["unavailable_count"]),
                use_ha_precision=self._entity_history_options(row["history_options"]).get("use_ha_precision") is True,
            )
            for row in rows
        ]

    @staticmethod
    def _entity_history_options_key(entity_id: str) -> str:
        return f"entity_history_options:{entity_id.casefold()}"

    @staticmethod
    def _entity_history_options(value: str | None) -> dict[str, Any]:
        if value is not None:
            try:
                options = json.loads(value)
                if isinstance(options, dict):
                    return options
            except (TypeError, ValueError):
                pass
        return {}

    @classmethod
    def _entity_history_ignore_option(cls, value: str | None) -> bool:
        option = cls._entity_history_options(value).get("ignore_unavailable")
        return option if isinstance(option, bool) else True

    def _entity_history_ignores_unavailable(
        self, connection: sqlite3.Connection, entity_id: str
    ) -> bool:
        row = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = ?",
            (self._entity_history_options_key(entity_id),),
        ).fetchone()
        return self._entity_history_ignore_option(row["value"] if row else None)

    def _get_entity_history_options(self, entity_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = ?",
                (self._entity_history_options_key(entity_id),),
            ).fetchone()
        return self._entity_history_options(row["value"] if row else None)

    def _set_entity_tracking(
        self,
        entity_id: str,
        enabled: bool | None = None,
        registry_entry_id: str | None = None,
        ignore_unavailable: bool | None = None,
        use_ha_precision: bool | None = None,
    ) -> TrackedEntityRecord:
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            if enabled is None:
                row = connection.execute(
                    "SELECT enabled FROM tracked_entities WHERE entity_id = ?", (entity_id,)
                ).fetchone()
                if row is None:
                    raise ValueError(localized_text("history.source_missing"))
                enabled = bool(row["enabled"])
            connection.execute(
                """
                INSERT INTO tracked_entities(
                    entity_id, registry_entry_id, enabled, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(entity_id) DO UPDATE SET
                    registry_entry_id = COALESCE(
                        excluded.registry_entry_id,
                        tracked_entities.registry_entry_id
                    ),
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
                """,
                (entity_id, registry_entry_id, int(enabled), now, now),
            )
            if ignore_unavailable is not None or use_ha_precision is not None:
                key = self._entity_history_options_key(entity_id)
                row = connection.execute(
                    "SELECT value FROM schema_metadata WHERE key = ?", (key,)
                ).fetchone()
                options = self._entity_history_options(row["value"] if row else None)
                # Independent preferences share this key; updating one must not
                # reset the others, including options from future versions.
                if ignore_unavailable is not None:
                    options["ignore_unavailable"] = ignore_unavailable
                if use_ha_precision is not None:
                    options["use_ha_precision"] = use_ha_precision
                connection.execute(
                    """INSERT INTO schema_metadata(key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                    (key, json.dumps(options)),
                )
        return next(
            item for item in self._list_tracked_entities()
            if item.entity_id.casefold() == entity_id.casefold()
        )

    def _set_entity_registry_id(
        self, entity_id: str, registry_entry_id: str
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE tracked_entities
                SET registry_entry_id = ?, updated_at = ?
                WHERE entity_id = ?
                """,
                (registry_entry_id, datetime.now(UTC).isoformat(), entity_id),
            )

    def _rename_tracked_entity(
        self,
        old_entity_id: str,
        new_entity_id: str,
        registry_entry_id: str,
    ) -> bool:
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            source = connection.execute(
                "SELECT * FROM tracked_entities WHERE entity_id = ?",
                (old_entity_id,),
            ).fetchone()
            if source is None:
                return False
            if old_entity_id.casefold() == new_entity_id.casefold():
                connection.execute(
                    """
                    UPDATE tracked_entities
                    SET registry_entry_id = ?, updated_at = ?
                    WHERE entity_id = ?
                    """,
                    (registry_entry_id, now, old_entity_id),
                )
                return True
            target = connection.execute(
                "SELECT 1 FROM tracked_entities WHERE entity_id = ?",
                (new_entity_id,),
            ).fetchone()
            if target is not None:
                raise EntityHistoryRenameConflictError(
                    localized_text("backend.history_rename_conflict", old_entity=old_entity_id, new_entity=new_entity_id)
                )

            # The registry ID is unique. Release it from the old row inside the
            # same transaction before inserting its renamed replacement.
            connection.execute(
                """
                UPDATE tracked_entities SET registry_entry_id = NULL
                WHERE entity_id = ?
                """,
                (old_entity_id,),
            )
            connection.execute(
                """
                INSERT INTO tracked_entities(
                    entity_id, registry_entry_id, enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    new_entity_id,
                    registry_entry_id,
                    int(source["enabled"]),
                    source["created_at"],
                    now,
                ),
            )
            connection.execute(
                "UPDATE entity_states SET entity_id = ? WHERE entity_id = ?",
                (new_entity_id, old_entity_id),
            )
            connection.execute(
                "UPDATE schema_metadata SET key = ? WHERE key = ?",
                (self._entity_history_options_key(new_entity_id),
                 self._entity_history_options_key(old_entity_id)),
            )
            connection.execute(
                "DELETE FROM tracked_entities WHERE entity_id = ?",
                (old_entity_id,),
            )
        return True

    def _record_entity_state(
        self,
        entity_id: str,
        state: str,
        attributes: dict[str, Any],
        last_changed: str,
        last_updated: str,
        last_reported: str | None,
        initial: bool = False,
    ) -> bool:
        attributes_json = json.dumps(
            attributes, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        with self._connect() as connection:
            source = connection.execute(
                "SELECT enabled FROM tracked_entities WHERE entity_id = ?",
                (entity_id,),
            ).fetchone()
            if source is None or not bool(source["enabled"]):
                return False
            if state.strip().casefold() in {"unknown", "unavailable"} and self._entity_history_ignores_unavailable(connection, entity_id):
                return False
            duplicate = connection.execute(
                """SELECT 1 FROM entity_states
                WHERE entity_id = ? AND last_updated = ?
                    AND state = ? AND attributes_json = ?
                    AND source IN ('live', 'recorder') LIMIT 1""",
                (entity_id, last_updated, state, attributes_json),
            ).fetchone()
            if duplicate:
                return False
            # Only an initial capture/restore is content-deduplicated. A later
            # HA report is a new sample even when its value is identical.
            if initial:
                latest = connection.execute(
                    """SELECT state, attributes_json FROM entity_states
                    WHERE entity_id = ? AND source IN ('live', 'recorder')
                    ORDER BY last_updated DESC, id DESC LIMIT 1""",
                    (entity_id,),
                ).fetchone()
                if latest and latest["state"] == state and latest["attributes_json"] == attributes_json:
                    return False
            connection.execute(
                """
                INSERT INTO entity_states(
                    entity_id, state, attributes_json, last_changed,
                    last_updated, last_reported, recorded_at, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'live')
                """,
                (
                    entity_id, state, attributes_json, last_changed,
                    last_updated, last_reported, datetime.now(UTC).isoformat(),
                ),
            )
        return True

    def _import_entity_states(
        self, entity_id: str, states: list[dict[str, Any]], source: str
    ) -> dict[str, int]:
        if source not in {"recorder", "long_term_statistics"}:
            raise ValueError(localized_text("backend.history_import_source_unsupported"))
        imported = updated = already_stored = unchanged = ignored = 0
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            tracked = connection.execute(
                "SELECT 1 FROM tracked_entities WHERE entity_id = ?", (entity_id,)
            ).fetchone()
            if tracked is None:
                raise ValueError(localized_text("backend.history_entity_not_configured"))
            ignore_unavailable = self._entity_history_ignores_unavailable(connection, entity_id)
            for snapshot in states:
                if ignore_unavailable and str(snapshot["state"]).strip().casefold() in {"unknown", "unavailable"}:
                    ignored += 1
                    continue
                attributes_json = json.dumps(
                    snapshot.get("attributes") or {},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                existing = connection.execute(
                    """
                    SELECT id, source, EXISTS(
                        SELECT 1 FROM entity_state_corrections AS c
                        WHERE c.id = entity_states.id
                    ) AS corrected FROM entity_states
                    WHERE entity_id = ? AND last_updated = ?
                    ORDER BY CASE source
                        WHEN 'live' THEN 0 WHEN 'recorder' THEN 1 ELSE 2 END, id
                    LIMIT 1
                    """,
                    (entity_id, snapshot["last_updated"]),
                ).fetchone()
                if existing:
                    # Exact Recorder data may replace an aggregate at the same
                    # timestamp. Live and Recorder rows always win over statistics.
                    if source == "recorder" and existing["source"] == "long_term_statistics" and not existing["corrected"]:
                        connection.execute(
                            """
                            UPDATE entity_states SET state = ?, attributes_json = ?,
                                last_changed = ?, last_reported = ?, recorded_at = ?,
                                source = 'recorder'
                            WHERE id = ?
                            """,
                            (
                                str(snapshot["state"]), attributes_json,
                                snapshot["last_changed"], snapshot.get("last_reported"),
                                now, int(existing["id"]),
                            ),
                        )
                        updated += 1
                    else:
                        already_stored += 1
                    continue
                connection.execute(
                    """
                    INSERT INTO entity_states(
                        entity_id, state, attributes_json, last_changed,
                        last_updated, last_reported, recorded_at, source
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entity_id, str(snapshot["state"]), attributes_json,
                        snapshot["last_changed"], snapshot["last_updated"],
                        snapshot.get("last_reported"), now, source,
                    ),
                )
                imported += 1
        return {
            "imported": imported,
            "updated": updated,
            "already_stored": already_stored,
            "unchanged": unchanged,
            "ignored": ignored,
            # Retain the combined field for older frontend builds.
            "skipped": already_stored + unchanged + ignored,
        }

    def _hide_unavailable_entity_states(self, entity_id: str) -> int:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute(
                "SELECT 1 FROM tracked_entities WHERE entity_id = ?", (entity_id,)
            ).fetchone():
                raise ValueError(localized_text("history.source_missing"))
            # Corrections are the displayed value. Keep repaired measurements
            # visible, and retain hidden IDs so reimports cannot resurrect them.
            cursor = connection.execute(
                """INSERT INTO entity_state_visibility(id, hidden_at)
                SELECT s.id, ? FROM entity_states AS s
                LEFT JOIN entity_state_corrections AS c ON c.id = s.id
                LEFT JOIN entity_state_visibility AS v ON v.id = s.id
                WHERE s.entity_id = ? AND s.source != 'manual' AND v.id IS NULL
                  AND lower(trim(COALESCE(c.state, s.state))) IN ('unknown', 'unavailable')""",
                (datetime.now(UTC).isoformat(), entity_id),
            )
            return cursor.rowcount

    def _delete_entity_history(self, entity_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM tracked_entities WHERE entity_id = ?", (entity_id,)
            )
            connection.execute(
                "DELETE FROM schema_metadata WHERE key = ?",
                (self._entity_history_options_key(entity_id),),
            )

    def _same_entity_attributes(self, left: Any, right: Any) -> bool:
        # JSON/JS round trips render 0.0 as 0. Numeric equality is intentional;
        # booleans must still remain distinct from numbers (True != 1 here).
        if isinstance(left, bool) or isinstance(right, bool):
            return type(left) is type(right) and left == right
        if isinstance(left, dict) and isinstance(right, dict):
            return left.keys() == right.keys() and all(self._same_entity_attributes(left[key], right[key]) for key in left)
        if isinstance(left, list) and isinstance(right, list):
            return len(left) == len(right) and all(self._same_entity_attributes(a, b) for a, b in zip(left, right))
        return left == right

    def _save_entity_sample(
        self, entity_id: str, state: str, attributes: dict[str, Any],
        timestamp: str, record_id: int | None, hidden: bool | None = None,
    ) -> int:
        if not isinstance(state, str) or not state.strip() or len(state) > 255:
            raise ValueError(localized_text("history.invalid_state"))
        if not isinstance(attributes, dict):
            raise ValueError(localized_text("history.backend_attributes_invalid"))
        try:
            attributes_json = json.dumps(attributes, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError) as error:
            raise ValueError(localized_text("history.backend_attributes_invalid")) from error
        if len(attributes_json.encode("utf-8")) > 65536:
            raise ValueError(localized_text("history.backend_attributes_invalid"))
        try:
            parsed = datetime.fromisoformat(timestamp)
            if parsed.tzinfo is None:
                raise ValueError(localized_text("backend.timezone_required"))
            timestamp = parsed.astimezone(UTC).isoformat()
        except (TypeError, ValueError) as error:
            raise ValueError(localized_text("history.invalid_zoned_time")) from error
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute("SELECT 1 FROM tracked_entities WHERE entity_id = ?", (entity_id,)).fetchone():
                raise ValueError(localized_text("history.source_missing"))
            existing = None
            if record_id is not None:
                existing = connection.execute(
                    """SELECT COALESCE(c.last_updated, s.last_updated) AS last_updated,
                        COALESCE(c.state, s.state) AS state,
                        COALESCE(c.attributes_json, s.attributes_json) AS attributes_json,
                        s.source, s.state AS original_state,
                        s.attributes_json AS original_attributes_json, s.last_updated AS original_last_updated
                    FROM entity_states AS s LEFT JOIN entity_state_corrections AS c ON c.id = s.id
                    WHERE s.entity_id = ? AND s.id = ?""", (entity_id, record_id)
                ).fetchone()
                if existing is None:
                    raise ValueError(localized_text("history.sample_missing"))
            if hidden is not None and (existing is None or existing["source"] == "manual"):
                raise ValueError(localized_text("history.manual_visibility"))
            duplicate = None
            # Existing archives may already contain simultaneous measurements.
            # Correcting their values must not require moving their timestamps.
            if existing is None or existing["last_updated"] != timestamp:
                duplicate = connection.execute(
                    """SELECT s.id FROM entity_states AS s
                    LEFT JOIN entity_state_corrections AS c ON c.id = s.id
                    WHERE s.entity_id = ? AND COALESCE(c.last_updated, s.last_updated) = ?
                    AND s.id != ? LIMIT 1""", (entity_id, timestamp, record_id or -1)
                ).fetchone()
            if duplicate:
                raise ValueError(localized_text("history.duplicate_time"))
            if record_id is None:
                cursor = connection.execute(
                    """INSERT INTO entity_states(entity_id, state, attributes_json,
                    last_changed, last_updated, recorded_at, source)
                    VALUES (?, ?, ?, ?, ?, ?, 'manual')""",
                    (entity_id, state, attributes_json, timestamp, timestamp, now),
                )
                return int(cursor.lastrowid)
            # Visibility alone must not turn an unmodified original into a correction.
            original_unchanged = (
                existing["original_state"] == state and existing["original_last_updated"] == timestamp
                and self._same_entity_attributes(json.loads(existing["original_attributes_json"]), attributes)
            )
            if original_unchanged:
                # Returning to the original removes only the now-redundant overlay.
                connection.execute("DELETE FROM entity_state_corrections WHERE id = ?", (record_id,))
            elif not (
                existing["state"] == state and existing["last_updated"] == timestamp
                and self._same_entity_attributes(json.loads(existing["attributes_json"]), attributes)
            ):
                connection.execute(
                    """INSERT INTO entity_state_corrections(id, state, attributes_json, last_updated, modified_at)
                    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
                    state = excluded.state, attributes_json = excluded.attributes_json,
                    last_updated = excluded.last_updated, modified_at = excluded.modified_at""",
                    (record_id, state, attributes_json, timestamp, now),
                )
            if hidden is True:
                connection.execute(
                    "INSERT INTO entity_state_visibility(id, hidden_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
                    (record_id, now),
                )
            elif hidden is False:
                connection.execute("DELETE FROM entity_state_visibility WHERE id = ?", (record_id,))
            return record_id

    def _delete_entity_sample(self, entity_id: str, record_id: int) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            record = connection.execute(
                "SELECT source FROM entity_states WHERE entity_id = ? AND id = ?",
                (entity_id, record_id),
            ).fetchone()
            if record is None:
                raise ValueError(localized_text("history.sample_missing"))
            if record["source"] != "manual":
                raise ValueError(localized_text("history.original_delete"))
            connection.execute("DELETE FROM entity_states WHERE id = ?", (record_id,))

    def _get_entity_history(
        self,
        entity_id: str,
        start_time: str | None,
        end_time: str | None,
        limit: int,
        latest: bool,
        attribute: str | None,
        min_value: float | None,
        max_value: float | None,
        before_id: int | None = None,
    ) -> tuple[list[EntityStateRecord], bool]:
        records, truncated, _ = self._query_entity_history(
            entity_id, start_time, end_time, limit, latest, attribute,
            min_value, max_value, before_id,
        )
        return records, truncated

    def _query_entity_history(
        self, entity_id: str, start_time: str | None, end_time: str | None,
        limit: int, latest: bool, attribute: str | None,
        min_value: float | None, max_value: float | None,
        before_id: int | None = None, include_hidden: bool = False,
    ) -> tuple[list[EntityStateRecord], bool, bool]:
        clauses = ["s.entity_id = ?"]
        parameters: list[Any] = [entity_id]
        if not include_hidden:
            clauses.append("v.id IS NULL")
        if start_time:
            clauses.append("COALESCE(c.last_updated, s.last_updated) >= ?")
            parameters.append(start_time)
        if end_time:
            clauses.append("COALESCE(c.last_updated, s.last_updated) <= ?")
            parameters.append(end_time)
        if before_id is not None:
            clauses.append("""(COALESCE(c.last_updated, s.last_updated), s.id) < (
                SELECT COALESCE(pc.last_updated, ps.last_updated), ps.id
                FROM entity_states AS ps LEFT JOIN entity_state_corrections AS pc ON pc.id = ps.id
                WHERE ps.entity_id = ? AND ps.id = ?)""")
            parameters.extend((entity_id, before_id))
        numeric_filter = min_value is not None or max_value is not None
        # Numeric filtering happens here in the backend so `latest + limit`
        # counts matching samples rather than rows later discarded by the card.
        # The safety ceiling prevents an unbounded scan of a very large archive.
        scan_limit = min(200_001, limit + 1 if not numeric_filter else 200_001)
        parameters.append(scan_limit)
        order = "DESC" if latest else "ASC"
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT s.id, s.entity_id,
                    COALESCE(c.state, s.state) AS state,
                    COALESCE(c.attributes_json, s.attributes_json) AS attributes_json,
                    CASE WHEN c.id IS NULL THEN s.last_changed ELSE c.last_updated END AS last_changed,
                    COALESCE(c.last_updated, s.last_updated) AS last_updated,
                    s.last_reported, s.recorded_at,
                    CASE WHEN c.id IS NULL THEN s.source ELSE 'corrected' END AS source,
                    s.source AS original_source, c.modified_at, v.id IS NOT NULL AS hidden,
                    s.state AS original_state, s.attributes_json AS original_attributes_json,
                    s.last_updated AS original_last_updated
                FROM entity_states AS s LEFT JOIN entity_state_corrections AS c ON c.id = s.id
                LEFT JOIN entity_state_visibility AS v ON v.id = s.id
                WHERE {' AND '.join(clauses)}
                ORDER BY last_updated {order}, s.id {order}
                LIMIT ?
                """,
                tuple(parameters),
            ).fetchall()
        selected_rows: list[sqlite3.Row] = []
        if numeric_filter:
            path = [part for part in (attribute or "").split(".") if part]
            for row in rows:
                raw_value: Any = row["state"]
                if path:
                    raw_value = json.loads(row["attributes_json"])
                    for part in path:
                        if not isinstance(raw_value, dict) or part not in raw_value:
                            raw_value = None
                            break
                        raw_value = raw_value[part]
                if isinstance(raw_value, bool):
                    continue
                try:
                    numeric_value = float(raw_value)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(numeric_value):
                    continue
                if min_value is not None and numeric_value < min_value:
                    continue
                if max_value is not None and numeric_value > max_value:
                    continue
                selected_rows.append(row)
                if len(selected_rows) > limit:
                    break
        else:
            selected_rows = list(rows[: limit + 1])
        more_matching = len(selected_rows) > limit
        # Once the requested number is found, the selection is complete even
        # if the safety scan cannot determine whether another page exists.
        scan_exhausted = bool(numeric_filter and len(rows) == scan_limit)
        query_limited = scan_exhausted and len(selected_rows) < limit
        truncated = more_matching or scan_exhausted
        selected_rows = selected_rows[:limit]
        if latest:
            selected_rows = list(reversed(selected_rows))
        return ([
            EntityStateRecord(
                id=int(row["id"]), entity_id=row["entity_id"], state=row["state"],
                attributes=json.loads(row["attributes_json"]),
                last_changed=row["last_changed"], last_updated=row["last_updated"],
                last_reported=row["last_reported"], recorded_at=row["recorded_at"],
                source=row["source"], hidden=bool(row["hidden"]),
                original_source=row["original_source"] if row["modified_at"] else None,
                modified_at=row["modified_at"],
                original={"state": row["original_state"], "attributes": json.loads(row["original_attributes_json"]),
                          "last_updated": row["original_last_updated"]} if row["modified_at"] else None,
            )
            for row in selected_rows
        ], truncated, query_limited)

    def _read_schema_version(self, connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'"
        ).fetchone()
        return int(row["value"]) if row else 0

    def _schema_version(self) -> int:
        with self._connect() as connection:
            return self._read_schema_version(connection)

    @staticmethod
    def _label_filter_record(row):
        return {"id": row["id"], "name": row["name"],
                "label_ids": json.loads(row["label_ids_json"]),
                "include_unlabeled": bool(row["include_unlabeled"]),
                "revision": row["revision"]}

    def _list_label_filters(self, user_id, list_id):
        self._get_list(list_id)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM user_label_filters WHERE user_id=? AND list_id=? "
                "ORDER BY name COLLATE NOCASE, id", (user_id, list_id)).fetchall()
        return [self._label_filter_record(row) for row in rows]

    def _save_label_filter(self, user_id, list_id, filter_id, name,
                           label_ids, include_unlabeled, revision=None):
        # Keep ownership in every SQL predicate, including requests from admins.
        if not user_id or self._get_list(list_id).list_type not in ("shopping", "bring", "inventory", "todo"):
            raise ValueError(localized_text("filters.supported_lists"))
        name = str(name).strip()
        if not name or len(name) > 80:
            raise ValueError(localized_text("filters.name_required"))
        if not isinstance(label_ids, list) or len(label_ids) > 100 or any(not isinstance(x, str) for x in label_ids):
            raise ValueError(localized_text("filters.invalid_labels"))
        label_ids = list(dict.fromkeys(label_ids))
        available = {label.id for label in self._list_labels(list_id)}
        if not set(label_ids) <= available:
            raise ValueError(localized_text("filters.invalid_labels"))
        if not label_ids and not include_unlabeled:
            raise ValueError(localized_text("filters.choose_labels"))
        updating = bool(filter_id)
        with self._connect() as connection:
            if updating:
                row = connection.execute(
                    "SELECT * FROM user_label_filters WHERE id=? AND user_id=? AND list_id=?",
                    (filter_id, user_id, list_id)).fetchone()
                if row is None or row["revision"] != revision:
                    raise ValueError(localized_text("filters.changed_elsewhere"))
            else:
                if connection.execute("SELECT COUNT(*) FROM user_label_filters WHERE user_id=? AND list_id=?",
                                      (user_id, list_id)).fetchone()[0] >= 50:
                    raise ValueError(localized_text("filters.limit"))
                filter_id = str(uuid4())
            try:
                if updating:
                    result = connection.execute("UPDATE user_label_filters SET name=?, label_ids_json=?, "
                                       "include_unlabeled=?, revision=revision+1 WHERE id=? AND user_id=? AND list_id=? AND revision=?",
                                       (name, json.dumps(label_ids), int(include_unlabeled), filter_id, user_id, list_id, revision))
                    if not result.rowcount:
                        raise ValueError(localized_text("filters.changed_elsewhere"))
                else:
                    connection.execute("INSERT INTO user_label_filters "
                                       "(id,user_id,list_id,name,label_ids_json,include_unlabeled) VALUES(?,?,?,?,?,?)",
                                       (filter_id, user_id, list_id, name, json.dumps(label_ids), int(include_unlabeled)))
            except sqlite3.IntegrityError as error:
                raise ValueError(localized_text("filters.duplicate_name")) from error
            row = connection.execute("SELECT * FROM user_label_filters WHERE id=?", (filter_id,)).fetchone()
        return self._label_filter_record(row)

    def _delete_label_filter(self, user_id, list_id, filter_id, revision):
        with self._connect() as connection:
            result = connection.execute("DELETE FROM user_label_filters WHERE id=? AND user_id=? "
                                        "AND list_id=? AND revision=?", (filter_id, user_id, list_id, revision))
            if not result.rowcount:
                raise ValueError(localized_text("filters.changed_elsewhere"))

    def _list_user_favorites(self, user_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, section, tab, target_id, position, created_at, updated_at
                FROM user_favorites
                WHERE user_id = ?
                ORDER BY position, created_at, id
                """,
                (user_id,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "section": row["section"],
                "tab": row["tab"] or None,
                "target_id": row["target_id"] or None,
                "position": row["position"],
            }
            for row in rows
        ]

    def _set_user_favorite(
        self,
        user_id: str,
        section: str,
        tab: str | None,
        target_id: str | None,
        enabled: bool,
    ) -> list[dict[str, Any]]:
        user_id = user_id.strip()
        section = section.strip()
        normalized_tab = (tab or "").strip()
        normalized_target = (target_id or "").strip()
        if not user_id or not section:
            raise ValueError(localized_text("backend.user_scope_required"))
        now = self._now()
        with self._connect() as connection:
            if enabled:
                position = connection.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM user_favorites "
                    "WHERE user_id = ?",
                    (user_id,),
                ).fetchone()[0]
                connection.execute(
                    """
                    INSERT INTO user_favorites(
                        id, user_id, section, tab, target_id, position,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(user_id, section, tab, target_id)
                    DO UPDATE SET updated_at = excluded.updated_at
                    """,
                    (
                        str(uuid4()), user_id, section, normalized_tab,
                        normalized_target, position, now, now,
                    ),
                )
            else:
                connection.execute(
                    """
                    DELETE FROM user_favorites
                    WHERE user_id = ? AND section = ? AND tab = ? AND target_id = ?
                    """,
                    (user_id, section, normalized_tab, normalized_target),
                )
        return self._list_user_favorites(user_id)

    def _overview_statistics(self) -> dict[str, int]:
        """Collect overview counters in one database worker call."""
        with self._connect() as connection:
            def count(query: str, parameters: tuple[Any, ...] = ()) -> int:
                row = connection.execute(query, parameters).fetchone()
                return int(row[0] or 0)

            product_count = count("SELECT COUNT(*) FROM products")
            assigned_products = count(
                """
                SELECT COUNT(*) FROM (
                    SELECT product_id FROM list_items WHERE product_id IS NOT NULL
                    UNION
                    SELECT product_id FROM inventory_entries
                )
                """
            )
            return {
                "lists_total": count("SELECT COUNT(*) FROM lists"),
                "lists_enabled": count("SELECT COUNT(*) FROM lists WHERE enabled = 1"),
                "lists_shopping": count(
                    "SELECT COUNT(*) FROM lists WHERE list_type = 'shopping' AND provider = 'local'"
                ),
                "lists_bring": count("SELECT COUNT(*) FROM lists WHERE provider = 'bring'"),
                "lists_todo": count("SELECT COUNT(*) FROM lists WHERE list_type = 'todo'"),
                "lists_inventory": count(
                    "SELECT COUNT(*) FROM lists WHERE list_type = 'inventory'"
                ),
                "items_total": count("SELECT COUNT(*) FROM list_items"),
                "items_open": count("SELECT COUNT(*) FROM list_items WHERE completed = 0"),
                "items_completed": count(
                    "SELECT COUNT(*) FROM list_items WHERE completed = 1"
                ),
                "items_shopping": count(
                    """
                    SELECT COUNT(*) FROM list_items
                    JOIN lists ON lists.id = list_items.list_id
                    WHERE lists.list_type = 'shopping' AND lists.provider = 'local'
                    """
                ),
                "items_bring": count(
                    """
                    SELECT COUNT(*) FROM list_items
                    JOIN lists ON lists.id = list_items.list_id
                    WHERE lists.provider = 'bring'
                    """
                ),
                "items_todo": count(
                    """
                    SELECT COUNT(*) FROM list_items
                    JOIN lists ON lists.id = list_items.list_id
                    WHERE lists.list_type = 'todo'
                    """
                ),
                "products_total": product_count,
                "products_with_ean": count(
                    "SELECT COUNT(*) FROM products WHERE ean IS NOT NULL AND TRIM(ean) != ''"
                ),
                "products_assigned": assigned_products,
                "products_unassigned": max(0, product_count - assigned_products),
                "product_item_links": count(
                    "SELECT COUNT(*) FROM list_items WHERE product_id IS NOT NULL"
                ),
                "inventory_entries": count("SELECT COUNT(*) FROM inventory_entries"),
                "inventory_stock": count("SELECT COALESCE(SUM(stock), 0) FROM inventory_entries"),
                "inventory_below_minimum": count(
                    """
                    SELECT COUNT(*) FROM inventory_entries
                    WHERE minimum_stock IS NOT NULL AND stock < minimum_stock
                    """
                ),
                "categories_saved": count("SELECT COUNT(*) FROM categories"),
                "categories_dynamic": count(
                    """
                    WITH dynamic_categories AS (
                        SELECT list_id, category AS name FROM list_items
                        WHERE category_id IS NULL
                        UNION ALL
                        SELECT list_id, category AS name FROM inventory_entries
                        WHERE category_id IS NULL
                        UNION ALL
                        SELECT list_id, category AS name FROM inventory_groups
                        WHERE category_id IS NULL
                    )
                    SELECT COUNT(*) FROM (
                        SELECT i.list_id, LOWER(TRIM(i.name)) AS normalized
                        FROM dynamic_categories AS i
                        JOIN lists AS l ON l.id = i.list_id
                        WHERE i.name IS NOT NULL
                          AND TRIM(i.name) != ''
                          AND NOT EXISTS (
                              SELECT 1 FROM categories AS c
                              WHERE LOWER(c.name) = LOWER(i.name)
                                AND ((c.scope = 'global' AND l.use_global_categories)
                                     OR (c.scope = 'list_type' AND c.list_type = l.list_type AND l.use_type_categories)
                                     OR (c.scope = 'list' AND c.list_id = i.list_id))
                          )
                        GROUP BY i.list_id, LOWER(TRIM(i.name))
                    )
                    """
                ),
                "labels_total": count("SELECT COUNT(*) FROM labels"),
                "label_assignments": count("SELECT COUNT(*) FROM product_labels")
                + count("SELECT COUNT(*) FROM list_item_labels"),
                "scanners_total": count("SELECT COUNT(*) FROM scanners"),
                "scanners_enabled": count("SELECT COUNT(*) FROM scanners WHERE enabled = 1"),
                "scans_pending": count(
                    """SELECT COUNT(*) FROM scan_history
                    WHERE status IN ('queued', 'offered', 'needs_input', 'processing')"""
                ),
                "scans_total": count("SELECT COUNT(*) FROM scan_history"),
                "notification_profiles": count("SELECT COUNT(*) FROM notification_profiles"),
                "notification_assignments": count(
                    "SELECT COUNT(*) FROM list_notification_profiles"
                ),
            }

    def _list_lists(self) -> list[ListRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, name, list_type, provider, external_entity_id,
                       icon, label_conflict_policy, use_global_categories,
                       use_type_categories, use_global_labels, use_type_labels,
                       use_list_labels, use_global_chips, use_type_chips, use_dishes,
                       use_tandoor, tandoor_skip_small_units,
                       tandoor_include_ingredients, tandoor_excluded_units,
                       tandoor_result_limit, capitalize_first_letter,
                       auto_delete_completed, auto_delete_delay_minutes, auto_delete_confirm,
                       enabled, created_at, updated_at
                FROM lists
                ORDER BY name COLLATE NOCASE
                """
            ).fetchall()
        return [self._record_from_row(row) for row in rows]

    @staticmethod
    def _legacy_import_key(import_id: str) -> str:
        from .legacy_import import LegacyImportError

        if not isinstance(import_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", import_id):
            raise LegacyImportError("invalid_import_id")
        return f"legacy_import:{import_id}"

    def _get_legacy_import_result(self, import_id: str) -> dict[str, Any] | None:
        key = self._legacy_import_key(import_id)
        with self._connect() as connection:
            row = connection.execute("SELECT value FROM schema_metadata WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        return {**json.loads(row["value"])["result"], "replayed": True}

    def _import_legacy(self, plan: dict[str, Any], import_id: str) -> dict[str, Any]:
        """Keep lists, their definitions, entries and the retry receipt in one commit.

        The plan comes exclusively from the server-side preview. Individual create
        methods intentionally are not used: each opens its own transaction, and
        normal item mutations may schedule notifications or script calls.
        """
        from hashlib import sha256
        from .legacy_import import LegacyImportError, MAX_CARDS, MAX_ITEMS

        key = self._legacy_import_key(import_id)
        payload = {name: value for name, value in plan.items() if name != "fingerprint"}
        fingerprint = sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if plan.get("version") != 1 or plan.get("fingerprint") != fingerprint:
            raise LegacyImportError("import_changed")
        lists = plan.get("lists")
        if not isinstance(lists, list) or not 1 <= len(lists) <= MAX_CARDS:
            raise LegacyImportError("invalid_config")
        if sum(len(row["items"]) for row in lists) > MAX_ITEMS:
            raise LegacyImportError("too_many_items")
        if plan.get("can_import") is False or any(
            not conflict.get("selected")
            for source in lists for conflict in source.get("ean_conflicts", [])
        ):
            raise LegacyImportError("ean_unresolved")
        ean_products = plan.get("ean_products", [])
        if not isinstance(ean_products, list) or len(ean_products) > MAX_ITEMS:
            raise LegacyImportError("ean_source_invalid")
        now = self._now()
        result = {"lists": [], "counts": dict(plan["counts"]), "replayed": False}
        with self._connect() as connection:
            # The database lock serializes integration writes; BEGIN also makes
            # checking names and writing the receipt one SQLite transaction.
            connection.execute("BEGIN IMMEDIATE")
            receipt = connection.execute("SELECT value FROM schema_metadata WHERE key = ?", (key,)).fetchone()
            if receipt is not None:
                stored = json.loads(receipt["value"])
                if stored["fingerprint"] != fingerprint:
                    raise LegacyImportError("import_changed")
                return {**stored["result"], "replayed": True}
            # EAN products belong to the shared catalog, including those without
            # stock. Reusing an EAN never replaces an existing product's data.
            ean_product_ids = {}
            ean_created = 0
            for product in ean_products:
                if not isinstance(product, dict):
                    raise LegacyImportError("ean_source_invalid")
                ean = product.get("ean")
                if (not isinstance(ean, str) or not ean.isascii() or not ean.isdecimal()
                        or len(ean) not in {8, 12, 13, 14} or ean in ean_product_ids):
                    raise LegacyImportError("ean_source_invalid")
                name = product.get("name")
                if not isinstance(name, str) or not name.strip() or len(name) > 200:
                    raise LegacyImportError("ean_source_invalid")
                existing = connection.execute("SELECT id FROM products WHERE ean = ?", (ean,)).fetchone()
                if existing is not None:
                    ean_product_ids[ean] = existing["id"]
                    continue
                product_id = str(uuid4())
                connection.execute(
                    """INSERT INTO products(
                        id, ean, name, original_name, brand, package_quantity,
                        image_url, source, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)""",
                    (product_id, ean, name, product.get("original_name"),
                     product.get("brand"), product.get("package_quantity"),
                     product.get("image_url"), now, now),
                )
                ean_product_ids[ean] = product_id
                ean_created += 1
            if ean_products or any(source.get("ean_enabled") for source in lists):
                result["ean_counts"] = {
                    "total": len(ean_product_ids), "created": ean_created,
                    "reused": len(ean_product_ids) - ean_created,
                }
                result["ean_product_ids"] = list(ean_product_ids.values())
            names = {row["name"].casefold() for row in connection.execute("SELECT name FROM lists")}
            for source in lists:
                name, list_type = source["name"], source["list_type"]
                if not isinstance(name, str) or not name.strip() or len(name) > 200 or list_type not in {"shopping", "todo", "inventory"}:
                    raise LegacyImportError("invalid_target")
                if name.casefold() in names:
                    raise DuplicateListNameError(name)
                names.add(name.casefold())
                list_id = str(uuid4())
                connection.execute(
                    """INSERT INTO lists(
                        id, name, list_type, icon, provider,
                        use_global_categories, use_type_categories,
                        use_global_labels, use_type_labels,
                        use_global_chips, use_type_chips, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'local', 0, 0, 0, 0, 0, 0, ?, ?)""",
                    (list_id, name, list_type, source["icon"], now, now),
                )
                category_ids = {}
                for position, category in enumerate(source["categories"]):
                    category_id = str(uuid4())
                    category_ids[category["name"].casefold()] = category_id
                    connection.execute(
                        """INSERT INTO categories(
                            id, name, scope, list_id, icon, color, position, created_at, updated_at
                        ) VALUES (?, ?, 'list', ?, ?, ?, ?, ?, ?)""",
                        (category_id, category["name"], list_id, category["icon"], category["color"], position, now, now),
                    )
                    for rule_position, pattern in enumerate(category["rules"]):
                        connection.execute(
                            """INSERT INTO category_rules(
                                id, category_id, pattern, position, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?)""",
                            (str(uuid4()), category_id, pattern, rule_position, now, now),
                        )
                for chip in source["chips"]:
                    template = self._validate_todo_template_data(chip["chip_kind"], chip["template_data"], chip["name"])
                    if template and template["category_name"]:
                        template["category_id"] = category_ids.get(template["category_name"].casefold())
                    connection.execute(
                        """INSERT INTO chips(
                            id, name, priority_name, chip_kind, icon, color, scope,
                            list_id, template_json, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, 'list', ?, ?, ?, ?)""",
                        (str(uuid4()), chip["name"], self._normalize_priority_name(chip["name"]),
                         chip["chip_kind"], chip["icon"], chip["color"], list_id,
                         json.dumps(template) if template is not None else None, now, now),
                    )
                for ean, category_name in source.get("ean_product_categories", {}).items():
                    category_id = category_ids.get(category_name.casefold())
                    product_id = ean_product_ids.get(ean)
                    if category_id is None or product_id is None or list_type != "inventory":
                        raise LegacyImportError("ean_source_invalid")
                    connection.execute(
                        "INSERT OR IGNORE INTO product_category_assignments(product_id, category_id) VALUES (?, ?)",
                        (product_id, category_id),
                    )
                product_ids = []
                seen_product_ids = set()
                for item in source["items"]:
                    category_id = category_ids.get(item["category"].casefold()) if item["category"] and item["category_saved"] else None
                    if list_type == "inventory":
                        stock = item["stock"]
                        self._validate_stock(stock, None)
                        ean = item.get("product_ean")
                        product_id = ean_product_ids.get(ean) if ean else None
                        if ean and (not source.get("ean_enabled") or product_id is None):
                            raise LegacyImportError("ean_choice_invalid")
                        if product_id is None:
                            # Without an EAN choice the established simplified import
                            # remains independent from existing catalog records.
                            product_id = str(uuid4())
                            connection.execute(
                                """INSERT INTO products(id, name, source, created_at, updated_at)
                                   VALUES (?, ?, 'manual', ?, ?)""",
                                (product_id, item["name"], now, now),
                            )
                        previous = None
                        if product_id in seen_product_ids:
                            previous = connection.execute(
                                "SELECT id, stock, hidden FROM inventory_entries WHERE list_id = ? AND product_id = ?",
                                (list_id, product_id),
                            ).fetchone()
                        else:
                            product_ids.append(product_id)
                            seen_product_ids.add(product_id)
                        if previous is not None:
                            # A product has one stock record per list. Even if old
                            # category names differ, its quantities must not multiply.
                            stock += previous["stock"]
                            self._validate_stock(stock, None)
                            connection.execute(
                                "UPDATE inventory_entries SET stock = ?, hidden = ? WHERE id = ?",
                                (stock, int(bool(previous["hidden"]) and item["hidden"]), previous["id"]),
                            )
                            continue
                        connection.execute(
                            """INSERT INTO inventory_entries(
                                id, list_id, product_id, stock, category_id, category,
                                hidden, position, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (str(uuid4()), list_id, product_id, stock, category_id, item["category"],
                             int(item["hidden"]), item["position"], now, now),
                        )
                    else:
                        connection.execute(
                            """INSERT INTO list_items(
                                id, list_id, name, description, quantity, category_id, category,
                                due_at, recurrence_interval, recurrence_unit, completed,
                                position, offer_only, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (str(uuid4()), list_id, item["name"], item["description"], item["quantity"],
                             category_id, item["category"], item["due_at"], item["recurrence_interval"],
                             item["recurrence_unit"], int(item["completed"]), item["position"],
                             int(item["offer_only"]), now, now),
                        )
                imported_list = {"source_entity": source["source_entity"], "list_id": list_id,
                                 "name": name, "list_type": list_type}
                if list_type == "inventory":
                    imported_list["product_ids"] = product_ids
                result["lists"].append(imported_list)
            connection.execute(
                "INSERT INTO schema_metadata(key, value) VALUES (?, ?)",
                (key, json.dumps({"fingerprint": fingerprint, "result": result})),
            )
        return result

    def _create_list(
        self, name: str, list_type: str, icon: str | None,
        provider: str, external_entity_id: str | None,
        label_conflict_policy: str,
        use_global_labels: bool,
        use_type_labels: bool,
        use_list_labels: bool,
        use_global_categories: bool = True,
        use_type_categories: bool = True,
        use_global_chips: bool = True,
        use_type_chips: bool = True,
        use_dishes: bool = False,
        use_tandoor: bool = False,
        tandoor_skip_small_units: bool = False,
        tandoor_include_ingredients: bool = True,
        tandoor_excluded_units: str = "",
        tandoor_result_limit: int = 100,
        capitalize_first_letter: bool = False,
        auto_delete_completed: bool = False,
        auto_delete_delay_minutes: int = 0,
        auto_delete_confirm: bool = False,
    ) -> ListRecord:
        self._validate_list_type(list_type)
        self._validate_list_provider(list_type, provider, external_entity_id)
        self._validate_label_conflict_policy(label_conflict_policy)
        if tandoor_result_limit not in {10, 25, 50, 100}:
            raise ValueError(localized_text("backend.tandoor_limit_invalid"))
        self._validate_completed_cleanup(list_type, provider, auto_delete_completed, auto_delete_delay_minutes, auto_delete_confirm)
        now = self._now()
        record = ListRecord(
            id=str(uuid4()),
            name=name,
            list_type=list_type,
            provider=provider,
            external_entity_id=external_entity_id,
            icon=icon,
            label_conflict_policy="specific",
            use_global_categories=use_global_categories,
            use_type_categories=use_type_categories,
            use_global_labels=use_global_labels,
            use_type_labels=use_type_labels,
            use_list_labels=True,
            use_global_chips=use_global_chips,
            use_type_chips=use_type_chips,
            use_dishes=use_dishes if list_type == "shopping" and provider == "local" else False,
            use_tandoor=use_tandoor if list_type == "shopping" and provider == "local" else False,
            tandoor_skip_small_units=tandoor_skip_small_units if list_type == "shopping" and provider == "local" else False,
            tandoor_include_ingredients=tandoor_include_ingredients if list_type == "shopping" and provider == "local" else True,
            tandoor_excluded_units=tandoor_excluded_units if list_type == "shopping" and provider == "local" else "",
            tandoor_result_limit=tandoor_result_limit if list_type == "shopping" and provider == "local" else 100,
            enabled=True,
            created_at=now,
            updated_at=now,
            capitalize_first_letter=capitalize_first_letter,
            auto_delete_completed=auto_delete_completed,
            auto_delete_delay_minutes=auto_delete_delay_minutes,
            auto_delete_confirm=auto_delete_confirm,
        )
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO lists(
                        id, name, list_type, provider, external_entity_id,
                        icon, label_conflict_policy, use_global_categories,
                        use_type_categories, use_global_labels, use_type_labels,
                        use_list_labels, use_global_chips, use_type_chips, use_dishes,
                        use_tandoor, tandoor_skip_small_units,
                        tandoor_include_ingredients, tandoor_excluded_units,
                        tandoor_result_limit,
                        capitalize_first_letter,
                        enabled, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.name,
                        record.list_type,
                        record.provider,
                        record.external_entity_id,
                        record.icon,
                        record.label_conflict_policy,
                        int(record.use_global_categories),
                        int(record.use_type_categories),
                        int(record.use_global_labels),
                        int(record.use_type_labels),
                        int(record.use_list_labels),
                        int(record.use_global_chips),
                        int(record.use_type_chips),
                        int(record.use_dishes),
                        int(record.use_tandoor),
                        int(record.tandoor_skip_small_units),
                        int(record.tandoor_include_ingredients),
                        record.tandoor_excluded_units,
                        record.tandoor_result_limit,
                        int(record.capitalize_first_letter),
                        int(record.enabled),
                        record.created_at,
                        record.updated_at,
                    ),
                )
                connection.execute("UPDATE lists SET auto_delete_completed=?,auto_delete_delay_minutes=?,auto_delete_confirm=? WHERE id=?",
                                   (int(auto_delete_completed),auto_delete_delay_minutes,int(auto_delete_confirm),record.id))
        except sqlite3.IntegrityError as error:
            if "lists.name" in str(error) or "lists_name_unique" in str(error):
                raise DuplicateListNameError(name) from error
            if "lists.external_entity_id" in str(error) or "lists_external_entity_unique" in str(error):
                raise ValueError(localized_text("backend.bring_already_linked")) from error
            raise
        return record

    def _update_list(
        self,
        list_id: str,
        name: str | None,
        icon: str | None,
        enabled: bool | None,
        external_entity_id: str | None | object,
        label_conflict_policy: str | None,
        use_global_categories: bool | None,
        use_type_categories: bool | None,
        use_global_labels: bool | None,
        use_type_labels: bool | None,
        use_list_labels: bool | None,
        use_global_chips: bool | None,
        use_type_chips: bool | None,
        confirm_scope_changes: bool = False,
        use_dishes: bool | None = None,
        use_tandoor: bool | None = None,
        tandoor_skip_small_units: bool | None = None,
        tandoor_include_ingredients: bool | None = None,
        tandoor_excluded_units: str | None = None,
        tandoor_result_limit: int | None = None,
        capitalize_first_letter: bool | None = None,
        auto_delete_completed: bool | None = None,
        auto_delete_delay_minutes: int | None = None,
        auto_delete_confirm: bool | None = None,
    ) -> ListRecord:
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT * FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if existing is None:
                raise ListNotFoundError(list_id)

            cleanup = (existing["auto_delete_completed"] if auto_delete_completed is None else int(auto_delete_completed),
                       existing["auto_delete_delay_minutes"] if auto_delete_delay_minutes is None else auto_delete_delay_minutes,
                       existing["auto_delete_confirm"] if auto_delete_confirm is None else int(auto_delete_confirm))
            self._validate_completed_cleanup(existing["list_type"], existing["provider"], *cleanup)
            next_name = name if name is not None else existing["name"]
            next_capitalize = (int(capitalize_first_letter) if capitalize_first_letter is not None
                               else existing["capitalize_first_letter"])
            next_icon = icon
            next_enabled = int(enabled) if enabled is not None else existing["enabled"]
            next_external_entity_id = (
                existing["external_entity_id"]
                if external_entity_id is _UNSET
                else external_entity_id
            )
            next_label_conflict_policy = "specific"
            next_use_global_categories = (
                int(use_global_categories) if use_global_categories is not None
                else existing["use_global_categories"]
            )
            next_use_type_categories = (
                int(use_type_categories) if use_type_categories is not None
                else existing["use_type_categories"]
            )
            next_use_global_labels = (
                int(use_global_labels) if use_global_labels is not None
                else existing["use_global_labels"]
            )
            next_use_type_labels = (
                int(use_type_labels) if use_type_labels is not None
                else existing["use_type_labels"]
            )
            next_use_list_labels = 1
            next_use_global_chips = (
                int(use_global_chips) if use_global_chips is not None
                else existing["use_global_chips"]
            )
            next_use_type_chips = (
                int(use_type_chips) if use_type_chips is not None
                else existing["use_type_chips"]
            )
            next_use_dishes = (
                int(use_dishes) if use_dishes is not None
                else existing["use_dishes"]
            )
            next_use_tandoor = (
                int(use_tandoor) if use_tandoor is not None
                else existing["use_tandoor"]
            )
            next_tandoor_skip_small_units = (
                int(tandoor_skip_small_units) if tandoor_skip_small_units is not None
                else existing["tandoor_skip_small_units"]
            )
            next_tandoor_include_ingredients = (
                int(tandoor_include_ingredients) if tandoor_include_ingredients is not None
                else existing["tandoor_include_ingredients"]
            )
            next_tandoor_excluded_units = (
                tandoor_excluded_units if tandoor_excluded_units is not None
                else existing["tandoor_excluded_units"]
            )
            next_tandoor_result_limit = (
                tandoor_result_limit if tandoor_result_limit is not None
                else existing["tandoor_result_limit"]
            )
            if next_tandoor_result_limit not in {10, 25, 50, 100}:
                raise ValueError(localized_text("backend.tandoor_limit_invalid"))
            if existing["list_type"] != "shopping" or existing["provider"] != "local":
                next_use_dishes = 0
                next_use_tandoor = 0
                next_tandoor_skip_small_units = 0
                next_tandoor_include_ingredients = 1
                next_tandoor_excluded_units = ""
                next_tandoor_result_limit = 100
            scope_settings_changed = any(
                value is not None
                for value in (
                    use_global_categories, use_type_categories,
                    use_global_labels, use_type_labels,
                    use_global_chips, use_type_chips,
                )
            ) and any(
                (
                    int(value) != int(existing[column])
                    if value is not None else False
                )
                for value, column in (
                    (use_global_categories, "use_global_categories"),
                    (use_type_categories, "use_type_categories"),
                    (use_global_labels, "use_global_labels"),
                    (use_type_labels, "use_type_labels"),
                    (use_global_chips, "use_global_chips"),
                    (use_type_chips, "use_type_chips"),
                )
            )
            if scope_settings_changed:
                impact = self._scope_change_impact(
                    connection, list_id,
                    bool(next_use_global_categories), bool(next_use_type_categories),
                    bool(next_use_global_labels), bool(next_use_type_labels),
                    bool(next_use_global_chips), bool(next_use_type_chips),
                    apply=False,
                )
                if impact["affected_total"] and not confirm_scope_changes:
                    raise ScopeChangeConfirmationRequired(impact)
                if impact["affected_total"]:
                    self._scope_change_impact(
                        connection, list_id,
                        bool(next_use_global_categories), bool(next_use_type_categories),
                        bool(next_use_global_labels), bool(next_use_type_labels),
                        bool(next_use_global_chips), bool(next_use_type_chips),
                        apply=True,
                    )
            self._validate_label_conflict_policy(next_label_conflict_policy)
            self._validate_list_provider(
                existing["list_type"], existing["provider"], next_external_entity_id
            )
            updated_at = self._now()
            try:
                connection.execute(
                    """
                    UPDATE lists
                    SET name = ?, icon = ?, enabled = ?, external_entity_id = ?,
                        label_conflict_policy = ?, use_global_labels = ?,
                        use_type_labels = ?, use_list_labels = ?,
                        use_global_categories = ?, use_type_categories = ?,
                        use_global_chips = ?, use_type_chips = ?, use_dishes = ?,
                        use_tandoor = ?, tandoor_skip_small_units = ?,
                        tandoor_include_ingredients = ?, tandoor_excluded_units = ?,
                        tandoor_result_limit = ?,
                        capitalize_first_letter = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        next_name,
                        next_icon,
                        next_enabled,
                        next_external_entity_id,
                        next_label_conflict_policy,
                        next_use_global_labels,
                        next_use_type_labels,
                        next_use_list_labels,
                        next_use_global_categories,
                        next_use_type_categories,
                        next_use_global_chips,
                        next_use_type_chips,
                        next_use_dishes,
                        next_use_tandoor,
                        next_tandoor_skip_small_units,
                        next_tandoor_include_ingredients,
                        next_tandoor_excluded_units,
                        next_tandoor_result_limit,
                        next_capitalize,
                        updated_at,
                        list_id,
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "lists.name" in str(error) or "lists_name_unique" in str(error):
                    raise DuplicateListNameError(next_name) from error
                if "lists.external_entity_id" in str(error) or "lists_external_entity_unique" in str(error):
                    raise ValueError(localized_text("backend.bring_already_linked")) from error
                raise

            connection.execute("UPDATE lists SET auto_delete_completed=?,auto_delete_delay_minutes=?,auto_delete_confirm=? WHERE id=?", (*cleanup,list_id))
            row = connection.execute(
                "SELECT * FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
        return self._record_from_row(row)

    def _get_list(self, list_id: str) -> ListRecord:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if row is None:
                raise ListNotFoundError(list_id)
        return self._record_from_row(row)

    def _delete_list(self, list_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM labels WHERE scope = 'list' AND list_id = ?", (list_id,)
            )
            cursor = connection.execute("DELETE FROM lists WHERE id = ?", (list_id,))
            if cursor.rowcount != 1:
                raise ListNotFoundError(list_id)

    def _list_items(self, list_id: str) -> list[ListItemRecord]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            rows = connection.execute(
                """
                SELECT id, list_id, product_id, external_uid, name, description, quantity, category_id, category,
                       due_at, recurrence_interval, recurrence_unit, completed, position,
                       inventory_source_type, inventory_source_id, created_at, updated_at, offer_only, completed_delete_at
                FROM list_items
                WHERE list_id = ?
                ORDER BY completed, position, created_at
                """,
                (list_id,),
            ).fetchall()
            records = [
                self._item_record_from_row(
                    row, self._labels_for(connection, "list_item_labels", "item_id", row["id"], list_id)
                )
                for row in rows
            ]
        return records

    def _get_item_category_names(self, list_id: str) -> dict[str, str]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            return {row["id"]: row["name"] for row in connection.execute(
                "SELECT DISTINCT categories.id,categories.name FROM categories "
                "JOIN list_items ON list_items.category_id = categories.id WHERE list_items.list_id = ?",
                (list_id,),
            )}

    def _get_item(self, item_id: str) -> ListItemRecord:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM list_items WHERE id = ?", (item_id,)
            ).fetchone()
            if row is None:
                raise ListItemNotFoundError(item_id)
            labels = self._labels_for(
                connection, "list_item_labels", "item_id", item_id, row["list_id"]
            )
        return self._item_record_from_row(row, labels)

    def _get_alexa_state(self) -> dict[str, Any]:
        with self._connect() as connection:
            self._prune_alexa_tombstones_in(connection, self._now())
            row = connection.execute("SELECT * FROM alexa_inbox WHERE id = 1").fetchone()
            receipts = connection.execute(
                "SELECT * FROM alexa_history ORDER BY created_at DESC, source_id, uid LIMIT 20"
            ).fetchall()
        return {
            "settings": json.loads(row["settings_json"]) if row else {},
            "status": json.loads(row["status_json"]) if row else {},
            "receipts": [dict(receipt) for receipt in receipts],
        }

    def _set_alexa_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        # Copy through JSON so callers cannot mutate already persisted values.
        encoded = json.dumps(settings, ensure_ascii=False, allow_nan=False)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO alexa_inbox(id,settings_json,status_json,updated_at) "
                "VALUES(1,?,'{}',?) ON CONFLICT(id) DO UPDATE SET "
                "settings_json=excluded.settings_json,updated_at=excluded.updated_at",
                (encoded, self._now()),
            )
            # Never backfill or resume unsent rows after an option/mapping is
            # disabled. Attempted creates remain durable until accounted for.
            eligible = (settings.get("enabled") is True and settings.get("mode") == "coupled"
                        and settings.get("send_local_items") is True)
            if eligible:
                connection.execute(
                    "DELETE FROM alexa_outbox WHERE state='queued' AND "
                    "(source_id!=? OR target_list_id!=?)",
                    (settings.get("source_registry_id") or "", settings.get("target_list_id") or ""),
                )
            else:
                connection.execute("DELETE FROM alexa_outbox WHERE state='queued'")
        return self._get_alexa_state()

    def _update_alexa_status(self, status: dict[str, Any]) -> None:
        with self._connect() as connection:
            row = connection.execute("SELECT status_json FROM alexa_inbox WHERE id=1").fetchone()
            values = json.loads(row[0]) if row else {}
            values.update(status)
            encoded = json.dumps(values, ensure_ascii=False, allow_nan=False)
            connection.execute(
                "INSERT INTO alexa_inbox(id,settings_json,status_json,updated_at) "
                "VALUES(1,'{}',?,?) ON CONFLICT(id) DO UPDATE SET "
                "status_json=excluded.status_json,updated_at=excluded.updated_at",
                (encoded, self._now()),
            )

    def _get_alexa_receipts(
        self, source_id: str, uids: list[str],
    ) -> dict[str, dict[str, Any]]:
        found = {}
        with self._connect() as connection:
            for offset in range(0, len(uids), 400):
                chunk = uids[offset:offset + 400]
                rows = connection.execute(
                    "SELECT * FROM alexa_receipts WHERE source_id=? AND uid IN ("
                    + ",".join("?" for _ in chunk) + ")", (source_id, *chunk),
                ).fetchall()
                found.update({row["uid"]: dict(row) for row in rows})
        return found

    def _list_alexa_pending_receipts(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM alexa_receipts WHERE cleanup_status IN ('pending','error') "
                "ORDER BY created_at,source_id,uid"
            ).fetchall()
        return [dict(row) for row in rows]

    def _list_alexa_links(self, source_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM alexa_receipts WHERE source_id=? ORDER BY created_at,uid",
                (source_id,),
            ).fetchall()
        result = []
        for row in rows:
            record = dict(row)
            record["sync"] = json.loads(record.pop("sync_json"))
            result.append(record)
        return result

    @staticmethod
    def _alexa_outbox_record(row) -> dict[str, Any]:
        result = dict(row)
        result["payload"] = json.loads(result.pop("payload_json"))
        return result

    def _list_alexa_outbox(self, source_id=None, target_list_id=None) -> list[dict[str, Any]]:
        predicates, parameters = [], []
        for column, value in (("source_id", source_id), ("target_list_id", target_list_id)):
            if value is not None:
                predicates.append(f"{column}=?")
                parameters.append(value)
        where = " WHERE " + " AND ".join(predicates) if predicates else ""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM alexa_outbox" + where + " ORDER BY created_at,id", parameters,
            ).fetchall()
        return [self._alexa_outbox_record(row) for row in rows]

    def _update_alexa_outbox(self, job_id, state, payload=None, expected_state=None):
        allowed = {"queued", "attempted", "uncertain", "cancelled"}
        if state not in allowed or expected_state is not None and expected_state not in allowed:
            raise ValueError("Invalid Alexa outbox state")
        if payload is not None and not isinstance(payload, dict):
            raise TypeError("Alexa outbox payload must be a mapping")
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False) if payload is not None else None
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM alexa_outbox WHERE id=?", (job_id,)).fetchone()
            if row is None or expected_state is not None and row["state"] != expected_state:
                return None
            # Once a request may have reached Alexa, it must never become a
            # fresh create automatically after a retry, restart or old callback.
            if state == "queued" and row["state"] != "queued":
                raise ValueError("Attempted Alexa create cannot be queued again")
            connection.execute(
                "UPDATE alexa_outbox SET state=?,payload_json=COALESCE(?,payload_json),updated_at=? WHERE id=?",
                (state, encoded, self._now(), job_id),
            )
            return self._alexa_outbox_record(connection.execute(
                "SELECT * FROM alexa_outbox WHERE id=?", (job_id,),
            ).fetchone())

    def _remove_alexa_outbox(self, job_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM alexa_outbox WHERE id=?", (job_id,))

    def _bind_alexa_outbox(self, job_id, uid, summary, status) -> bool:
        if (not isinstance(uid, str) or not uid or len(uid) > 1000
                or not isinstance(summary, str) or not summary.strip() or len(summary) > 2000
                or status not in {"needs_action", "completed"}):
            raise ValueError("Invalid Alexa create acknowledgement")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM alexa_outbox WHERE id=?", (job_id,)).fetchone()
            if row is None or row["state"] == "queued":
                return False
            job = self._alexa_outbox_record(row)
            if uid in job["payload"].get("before_uids", []):
                return False
            # Never attach a guessed UID that is already consumed elsewhere.
            if (connection.execute("SELECT 1 FROM alexa_receipts WHERE source_id=? AND uid=?", (row["source_id"], uid)).fetchone()
                    or connection.execute("SELECT 1 FROM alexa_history WHERE source_id=? AND uid=?", (row["source_id"], uid)).fetchone()
                    or connection.execute("SELECT 1 FROM alexa_tombstones WHERE source_id=? AND uid_hash=? AND expires_at>?",
                        (row["source_id"], sha256(uid.encode("utf-8")).hexdigest(), self._now())).fetchone()):
                return False
            local = job["payload"].get("local")
            if not isinstance(local, dict) or local.get("id") != row["item_id"]:
                raise ValueError("Alexa outbox has no matching local snapshot")
            # todo.add_item creates an open position. A completed observation
            # already represents a later user action and must reach normal
            # reconciliation rather than being swallowed into its baseline.
            sync = {"local": local, "remote": {"summary": summary, "status": "needs_action"}}
            connection.execute(
                "INSERT INTO alexa_receipts(source_id,uid,source_entity_id,target_list_id,item_id,"
                "original_name,name,description,quantity,cleanup_action,cleanup_status,created_at,sync_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,'keep','kept',?,?)",
                (row["source_id"], uid, row["source_entity_id"], row["target_list_id"], row["item_id"],
                 summary, local.get("name"), local.get("description"), local.get("quantity"), self._now(),
                 json.dumps(sync, ensure_ascii=False, allow_nan=False)),
            )
            connection.execute("DELETE FROM alexa_outbox WHERE id=?", (job_id,))
        # No list-item mutation, script event, or inbound activity count: this
        # is an acknowledgement for an item that was already locally stored.
        return True

    def _update_alexa_link(
        self, source_id: str, uid: str, sync: dict[str, Any],
        original_name: str | None, cleanup_action: str | None, cleanup_status: str | None,
    ) -> None:
        if not isinstance(sync, dict):
            raise TypeError("Alexa synchronization journal must be a mapping")
        encoded = json.dumps(sync, ensure_ascii=False, allow_nan=False)
        if cleanup_action is not None and cleanup_action not in {"keep", "complete", "delete"}:
            raise ValueError(localized_text("alexa.invalid_cleanup"))
        if cleanup_status is not None and cleanup_status not in {"ignored", "kept", "pending", "done", "error"}:
            raise ValueError(localized_text("alexa.invalid_cleanup"))
        with self._connect() as connection:
            connection.execute(
                "UPDATE alexa_receipts SET sync_json=?,original_name=COALESCE(?,original_name),"
                "cleanup_action=COALESCE(?,cleanup_action),cleanup_status=COALESCE(?,cleanup_status),"
                "last_error=CASE WHEN ? IS NOT NULL THEN NULL ELSE last_error END "
                "WHERE source_id=? AND uid=?",
                (encoded, original_name, cleanup_action, cleanup_status, cleanup_status, source_id, uid),
            )
            if cleanup_action is not None or cleanup_status is not None:
                connection.execute(
                    "UPDATE alexa_history SET cleanup_action=COALESCE(?,cleanup_action),"
                    "cleanup_status=COALESCE(?,cleanup_status),last_error=NULL WHERE source_id=? AND uid=?",
                    (cleanup_action, cleanup_status, source_id, uid),
                )

    def _remove_alexa_links(self, source_id: str, uids: list[str]) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = self._now()
            self._prune_alexa_tombstones_in(connection, now)
            expires = (datetime.fromisoformat(now) + timedelta(minutes=10)).isoformat()
            for uid in set(uids):
                if connection.execute("SELECT 1 FROM alexa_receipts WHERE source_id=? AND uid=?", (source_id, uid)).fetchone():
                    connection.execute("INSERT OR REPLACE INTO alexa_tombstones(source_id,uid_hash,expires_at) VALUES(?,?,?)",
                                       (source_id, sha256(uid.encode("utf-8")).hexdigest(), expires))
            connection.executemany("DELETE FROM alexa_receipts WHERE source_id=? AND uid=?",
                                   [(source_id, uid) for uid in set(uids)])

    def _has_alexa_history(self, source_id: str, uids: list[str]) -> set[str]:
        found = set()
        with self._connect() as connection:
            now = self._now()
            for offset in range(0, len(uids), 400):
                chunk = uids[offset:offset + 400]
                found.update(row[0] for row in connection.execute(
                    "SELECT uid FROM alexa_history WHERE source_id=? AND uid IN ("
                    + ",".join("?" for _ in chunk) + ")", (source_id, *chunk)))
            guards = {row[0] for row in connection.execute(
                "SELECT uid_hash FROM alexa_tombstones WHERE source_id=? AND expires_at>?", (source_id, now))}
            found.update(uid for uid in uids if sha256(uid.encode("utf-8")).hexdigest() in guards)
        return found

    def _ignore_alexa_items(
        self, source_id: str, uids: list[str], source_entity_id: str | None,
    ) -> None:
        if not source_id or not isinstance(source_id, str):
            raise ValueError(localized_text("alexa.invalid_source"))
        if any(not isinstance(uid, str) or not uid or len(uid) > 1000 for uid in uids):
            raise ValueError(localized_text("alexa.invalid_source"))
        with self._connect() as connection:
            connection.executemany(
                "INSERT OR IGNORE INTO alexa_receipts("
                "source_id,uid,source_entity_id,cleanup_action,cleanup_status,created_at) "
                "VALUES(?,?,?,'keep','ignored',?)",
                [(source_id, uid, source_entity_id, self._now()) for uid in set(uids)],
            )

    @staticmethod
    def _alexa_match_text(value: str | None) -> str:
        return " ".join((value or "").split()).casefold()

    @staticmethod
    def _validate_alexa_item_input(
        name: str, description: str | None, quantity: int,
    ) -> tuple[str, str | None]:
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError(localized_text("alexa.item_invalid"))
        if description is not None and (not isinstance(description, str) or len(description) > 2000):
            raise ValueError(localized_text("backend.description_too_long"))
        if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 1_000_000:
            raise ValueError(localized_text("backend.quantity_range"))
        return name.strip(), description.strip() or None if description is not None else None

    def _resolve_alexa_product(
        self, connection: sqlite3.Connection, name: str,
        match_products: bool, has_unit: bool,
        product_id: str | None = None,
    ) -> dict[str, Any]:
        resolution = {
            "product_id": None, "product_name": None,
            "reason": "unit" if has_unit else "disabled", "match_count": 0,
        }
        if product_id is not None:
            product = connection.execute("SELECT id,name FROM products WHERE id=?", (product_id,)).fetchone()
            if product is None:
                raise ValueError(localized_text("alexa.alias_product_missing"))
            resolution.update(product_id=None if has_unit else product["id"],
                              product_name=product["name"], match_count=1,
                              reason="unit" if has_unit else "alias_product")
            return resolution
        if match_products and not has_unit:
            key = self._alexa_match_text(unicodedata.normalize("NFKC", name))
            products = [row for row in connection.execute("SELECT id,name FROM products")
                        if self._alexa_match_text(unicodedata.normalize("NFKC", row["name"])) == key]
            resolution["match_count"] = len(products)
            resolution["reason"] = "no_match" if not products else "multiple_products"
            if len(products) == 1:
                product = products[0]
                resolution.update(product_id=product["id"], product_name=product["name"], reason="unique_product")
        return resolution

    def _resolve_alexa_item(
        self, connection: sqlite3.Connection, target_list_id: str,
        name: str, description: str | None, quantity: int,
        match_products: bool, has_unit: bool,
        product_id: str | None = None,
    ) -> tuple[dict[str, Any], sqlite3.Row | None]:
        self._require_list(connection, target_list_id)
        target = connection.execute("SELECT * FROM lists WHERE id=?", (target_list_id,)).fetchone()
        if target["list_type"] != "shopping" or target["provider"] != "local" or not target["enabled"]:
            raise ValueError(localized_text("backend.local_shopping_target_required"))
        resolution = self._resolve_alexa_product(connection, name, match_products, has_unit, product_id)
        if product_id is not None:
            name = resolution["product_name"]
        name = self._format_list_item_name(connection, target_list_id, name, resolution["product_id"])
        match = None
        if resolution["product_id"] is not None:
            linked = connection.execute(
                "SELECT * FROM list_items WHERE list_id=? AND completed=0 AND product_id=? "
                "AND external_uid IS NULL AND inventory_source_type IS NULL AND inventory_source_id IS NULL "
                "ORDER BY position,created_at,id", (target_list_id, resolution["product_id"]),
            ).fetchall()
            if len(linked) > 1:
                resolution.update(product_id=None,
                                  product_name=resolution["product_name"] if product_id is not None else None,
                                  reason="multiple_items")
            else:
                match = linked[0] if linked else None
        if resolution["product_id"] is None:
            # Unit-qualified orders must never become package counts. Ambiguous
            # products retain the established free-item merge behavior as well.
            candidates = connection.execute(
                "SELECT * FROM list_items WHERE list_id=? AND completed=0 "
                "AND product_id IS NULL AND external_uid IS NULL "
                "AND inventory_source_type IS NULL AND inventory_source_id IS NULL "
                "ORDER BY position,created_at,id", (target_list_id,),
            ).fetchall()
            match = next((row for row in candidates
                if self._alexa_match_text(row["name"]) == self._alexa_match_text(name)
                and self._alexa_match_text(row["description"]) == self._alexa_match_text(description)), None)
        total = quantity + (match["quantity"] if match else 0)
        if total > 1_000_000:
            raise ValueError(localized_text("backend.quantity_range"))
        resolution.update(
            action=("product" if resolution["product_id"] else "free") + ("_increase" if match else "_add"),
            item_id=match["id"] if match else None,
            quantity=quantity, result_quantity=total, target_missing=False,
            name=resolution["product_name"] if resolution["product_id"] else name,
        )
        return resolution, match

    def _preview_alexa_item(
        self, target_list_id: str | None, name: str, description: str | None,
        quantity: int, match_products: bool = False, has_unit: bool = False,
        product_id: str | None = None,
    ) -> dict[str, Any]:
        name, description = self._validate_alexa_item_input(name, description, quantity)
        with self._connect() as connection:
            # Resolve against one read snapshot without creating assignments or
            # reserving a source ID while the user inspects the preview.
            connection.execute("BEGIN")
            if target_list_id is None:
                resolution = self._resolve_alexa_product(connection, name, match_products, has_unit, product_id)
                resolution.update(action="target_required", target_missing=True, quantity=quantity,
                                  name=resolution["product_name"] or name)
            else:
                resolution, _ = self._resolve_alexa_item(
                    connection, target_list_id, name, description, quantity,
                    match_products, has_unit, product_id,
                )
        return resolution

    def _accept_alexa_item(
        self, source_id: str, uid: str, target_list_id: str, name: str,
        description: str | None, quantity: int, cleanup_action: str,
        original_name: str, include_existing: bool = False,
        source_entity_id: str | None = None,
        match_products: bool = False, has_unit: bool = False,
        product_id: str | None = None,
    ) -> dict[str, Any]:
        if (not isinstance(source_id, str) or not source_id or len(source_id) > 1000
            or not isinstance(uid, str) or not uid or len(uid) > 1000):
            raise ValueError(localized_text("alexa.invalid_source"))
        name, description = self._validate_alexa_item_input(name, description, quantity)
        if cleanup_action not in ("keep", "complete", "delete"):
            raise ValueError(localized_text("alexa.invalid_cleanup"))
        now = self._now()
        before = None
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._prune_alexa_tombstones_in(connection, now)
            if connection.execute(
                "SELECT 1 FROM alexa_tombstones WHERE source_id=? AND uid_hash=?",
                (source_id, sha256(uid.encode("utf-8")).hexdigest()),
            ).fetchone():
                return {"accepted": False, "receipt": {"source_id": source_id, "uid": uid,
                        "cleanup_status": "done"}, "item": None, "resolution": None}
            previous = connection.execute(
                "SELECT * FROM alexa_receipts WHERE source_id=? AND uid=?", (source_id, uid),
            ).fetchone()
            if previous is None or previous["cleanup_status"] == "ignored":
                historical = connection.execute(
                    "SELECT * FROM alexa_history WHERE source_id=? AND uid=?", (source_id, uid),
                ).fetchone()
                if historical is not None:
                    previous = historical
            if previous is not None and not (include_existing and previous["cleanup_status"] == "ignored"):
                row = connection.execute("SELECT * FROM list_items WHERE id=?", (previous["item_id"],)).fetchone()
                item = self._item_record_from_row(
                    row, self._labels_for(connection, "list_item_labels", "item_id", row["id"], row["list_id"])
                ).as_dict() if row else None
                return {"accepted": False, "receipt": dict(previous), "item": item, "resolution": None}

            resolution, match = self._resolve_alexa_item(
                connection, target_list_id, name, description, quantity,
                match_products, has_unit, product_id,
            )
            name = resolution["name"]
            if match:
                before = self._item_record_from_row(
                    match, self._labels_for(connection, "list_item_labels", "item_id", match["id"], target_list_id)
                )
                item_id = match["id"]
                connection.execute(
                    "UPDATE list_items SET quantity=quantity+?,updated_at=? WHERE id=?",
                    (quantity, now, item_id),
                )
            else:
                product_id = resolution["product_id"]
                item_name = resolution["product_name"] if product_id else name
                item_name = self._format_list_item_name(connection, target_list_id, item_name, product_id)
                category_id = category = None
                if product_id:
                    category_id, category = self._resolve_product_category_for_list(connection, product_id, target_list_id)
                if category_id is None and category is None:
                    category_id, category = self._resolve_category_rule_for_list(connection, target_list_id, item_name)
                category_id, category = self._resolve_item_category(connection, target_list_id, category_id, category)
                position = connection.execute(
                    "SELECT COALESCE(MAX(position),-1)+1 FROM list_items WHERE list_id=?", (target_list_id,),
                ).fetchone()[0]
                item_id = str(uuid4())
                connection.execute(
                    "INSERT INTO list_items(id,list_id,product_id,name,description,quantity,category_id,category,"
                    "completed,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?)",
                    (item_id, target_list_id, product_id, item_name, description, quantity, category_id, category, position, now, now),
                )
                if product_id:
                    labels = self._labels_for(connection, "product_labels", "product_id", product_id, target_list_id)
                    self._replace_labels(connection, "list_item_labels", "item_id", item_id, [label.id for label in labels])
            cleanup_status = "kept" if cleanup_action == "keep" else "pending"
            connection.execute(
                "INSERT INTO alexa_receipts(source_id,uid,source_entity_id,target_list_id,item_id,"
                "original_name,name,description,quantity,cleanup_action,cleanup_status,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,uid) DO UPDATE SET "
                "source_entity_id=excluded.source_entity_id,target_list_id=excluded.target_list_id,"
                "item_id=excluded.item_id,original_name=excluded.original_name,name=excluded.name,"
                "description=excluded.description,quantity=excluded.quantity,cleanup_action=excluded.cleanup_action,"
                "cleanup_status=excluded.cleanup_status,created_at=excluded.created_at,cleaned_at=NULL,last_error=NULL",
                (source_id, uid, source_entity_id, target_list_id, item_id, original_name,
                 name, description, quantity, cleanup_action, cleanup_status, now),
            )
            connection.execute(
                "DELETE FROM alexa_outbox WHERE source_id=? AND target_list_id=? AND item_id=? AND state='queued'",
                (source_id, target_list_id, item_id),
            )
            row = connection.execute("SELECT * FROM list_items WHERE id=?", (item_id,)).fetchone()
            connection.execute(
                f"INSERT OR REPLACE INTO alexa_history({_ALEXA_HISTORY_COLUMNS}) "
                f"SELECT {_ALEXA_HISTORY_COLUMNS} FROM alexa_receipts WHERE source_id=? AND uid=?",
                (source_id, uid),
            )
            connection.execute("DELETE FROM alexa_history WHERE rowid NOT IN "
                               "(SELECT rowid FROM alexa_history ORDER BY created_at DESC,source_id,uid LIMIT 20)")
            after = self._item_record_from_row(
                row, self._labels_for(connection, "list_item_labels", "item_id", item_id, target_list_id)
            )
            receipt = dict(connection.execute(
                "SELECT * FROM alexa_receipts WHERE source_id=? AND uid=?", (source_id, uid),
            ).fetchone())
        return {"accepted": True, "receipt": receipt, "item": after.as_dict(), "resolution": resolution, "_before": before, "_after": after}

    def _update_alexa_receipt(
        self, source_id: str, uid: str, cleanup_status: str, last_error: str | None,
    ) -> None:
        if cleanup_status not in ("pending", "done", "error", "kept"):
            raise ValueError(localized_text("alexa.invalid_cleanup"))
        cleaned_at = self._now() if cleanup_status == "done" else None
        with self._connect() as connection:
            connection.execute(
                "UPDATE alexa_receipts SET cleanup_status=?,last_error=?,cleaned_at=? "
                "WHERE source_id=? AND uid=? AND cleanup_status!='ignored'",
                (cleanup_status, last_error, cleaned_at, source_id, uid),
            )
            connection.execute(
                "UPDATE alexa_history SET cleanup_status=?,last_error=?,cleaned_at=? "
                "WHERE source_id=? AND uid=?",
                (cleanup_status, last_error, cleaned_at, source_id, uid),
            )

    def _apply_alexa_sync_local(
        self, item_id: str, expected_updated_at: str,
        completed: bool | None, delete: bool,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM list_items WHERE id=?", (item_id,)).fetchone()
            if row is None:
                return {"applied": False, "item": None, "list_id": None}
            labels = self._labels_for(connection, "list_item_labels", "item_id", item_id, row["list_id"])
            before = self._item_record_from_row(row, labels)
            result = {"applied": False, "item": before.as_dict(), "list_id": row["list_id"]}
            target = connection.execute("SELECT provider,list_type FROM lists WHERE id=?", (row["list_id"],)).fetchone()
            if row["updated_at"] != expected_updated_at or target["provider"] != "local" or target["list_type"] != "shopping":
                return result
            if delete:
                connection.execute("DELETE FROM list_items WHERE id=?", (item_id,))
                after = None
            elif completed is not None and bool(row["completed"]) != completed:
                connection.execute("UPDATE list_items SET completed=?,updated_at=? WHERE id=?",
                                   (int(completed), self._now(), item_id))
                after = self._item_record_from_row(connection.execute(
                    "SELECT * FROM list_items WHERE id=?", (item_id,)).fetchone(), labels)
            else:
                return result
            return {"applied": True, "item": after.as_dict() if after else None,
                    "list_id": before.list_id, "_before": before, "_after": after}

    @staticmethod
    def _format_list_item_name(
        connection: sqlite3.Connection, list_id: str, name: str,
        product_id: str | None, external_uid: str | None = None,
    ) -> str:
        if product_id is not None or external_uid is not None or not name:
            return name
        row = connection.execute("SELECT provider,capitalize_first_letter FROM lists WHERE id=?", (list_id,)).fetchone()
        return name[:1].upper() + name[1:] if row and row["provider"] == "local" and row["capitalize_first_letter"] else name

    def _create_item(
        self,
        list_id: str,
        name: str,
        description: str | None,
        quantity: int,
        category_id: str | None,
        category: str | None,
        due_at: str | None,
        label_ids: list[str],
        product_id: str | None,
        external_uid: str | None,
        recurrence_interval: int | None = None,
        recurrence_unit: str | None = None,
        offer_only: bool | object = False,
        remember_product_category: bool = False,
        remember_product_labels: bool = False,
    ) -> ListItemRecord:
        now = self._now()
        recurrence_interval, recurrence_unit = self._validate_recurrence(
            recurrence_interval, recurrence_unit
        )
        with self._connect() as connection:
            if remember_product_category or remember_product_labels:
                connection.execute("BEGIN IMMEDIATE")
            self._require_list(connection, list_id)
            name = self._format_list_item_name(connection, list_id, name, product_id, external_uid)
            kind = connection.execute("SELECT list_type FROM lists WHERE id = ?", (list_id,)).fetchone()[0]
            if offer_only and kind != "shopping":
                raise ValueError(localized_text("backend.offers_shopping_only"))
            if remember_product_category:
                category_id, category = self._remember_item_product_category(
                    connection, list_id, product_id, category_id
                )
            if remember_product_labels:
                self._remember_item_product_labels(
                    connection, list_id, product_id, label_ids
                )
            if product_id is not None:
                self._require_product(connection, product_id)
                if category_id is None and category is None:
                    category_id, category = self._resolve_product_category_for_list(
                        connection, product_id, list_id
                    )
            if category_id is None and category is None:
                category_id, category = self._resolve_category_rule_for_list(
                    connection, list_id, name
                )
            category_id, category = self._resolve_item_category(
                connection, list_id, category_id, category
            )
            row = connection.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 AS next_position "
                "FROM list_items WHERE list_id = ?",
                (list_id,),
            ).fetchone()
            record = ListItemRecord(
                id=str(uuid4()),
                list_id=list_id,
                product_id=product_id,
                external_uid=external_uid,
                name=name,
                description=description,
                quantity=quantity,
                category_id=category_id,
                category=category,
                due_at=due_at,
                recurrence_interval=recurrence_interval,
                recurrence_unit=recurrence_unit,
                completed=False,
                position=int(row["next_position"]),
                created_at=now,
                updated_at=now,
                labels=(),
            )
            connection.execute(
                """
                INSERT INTO list_items(
                    id, list_id, product_id, external_uid, name, description, quantity, category_id, category, due_at,
                    recurrence_interval, recurrence_unit, completed, position, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.list_id,
                    record.product_id,
                    record.external_uid,
                    record.name,
                    record.description,
                    record.quantity,
                    record.category_id,
                    record.category,
                    record.due_at,
                    record.recurrence_interval,
                    record.recurrence_unit,
                    int(record.completed),
                    record.position,
                    record.created_at,
                    record.updated_at,
                ),
            )
            connection.execute("UPDATE list_items SET offer_only = ? WHERE id = ?", (int(bool(offer_only)), record.id))
            self._replace_labels(
                connection, "list_item_labels", "item_id", record.id, label_ids
            )
            labels = self._labels_for(
                connection, "list_item_labels", "item_id", record.id, list_id
            )
        return self._item_record_from_row(
            {
                "offer_only": bool(offer_only),
                "id": record.id,
                "list_id": record.list_id,
                "product_id": record.product_id,
                "external_uid": record.external_uid,
                "name": record.name,
                "description": record.description,
                "quantity": record.quantity,
                "category_id": record.category_id,
                "category": record.category,
                "due_at": record.due_at,
                "recurrence_interval": record.recurrence_interval,
                "recurrence_unit": record.recurrence_unit,
                "completed": record.completed,
                "position": record.position,
                "created_at": record.created_at,
                "updated_at": record.updated_at,
                "inventory_source_type": None,
                "inventory_source_id": None,
            },
            labels,
        )

    def _update_item(
        self,
        item_id: str,
        name: str,
        description: str | None,
        quantity: int,
        category_id: str | None,
        category: str | None,
        due_at: str | None,
        completed: bool,
        label_ids: list[str],
        product_id: str | None | object,
        external_uid: str | None | object,
        recurrence_interval: int | None = None,
        recurrence_unit: str | None = None,
        offer_only: bool | object = _UNSET,
        remember_product_category: bool = False,
        remember_product_labels: bool = False,
    ) -> ListItemRecord:
        recurrence_interval, recurrence_unit = self._validate_recurrence(
            recurrence_interval, recurrence_unit
        )
        with self._connect() as connection:
            if remember_product_category or remember_product_labels:
                connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT list_id, product_id, external_uid FROM list_items WHERE id = ?", (item_id,)
            ).fetchone()
            if existing is None:
                raise ListItemNotFoundError(item_id)
            if offer_only is not _UNSET:
                kind = connection.execute("SELECT list_type FROM lists WHERE id = ?", (existing["list_id"],)).fetchone()[0]
                if offer_only and kind != "shopping":
                    raise ValueError(localized_text("backend.offers_shopping_only"))
                connection.execute("UPDATE list_items SET offer_only = ? WHERE id = ?", (int(bool(offer_only)), item_id))
            next_product_id = existing["product_id"] if product_id is _UNSET else product_id
            next_external_uid = existing["external_uid"] if external_uid is _UNSET else external_uid
            name = self._format_list_item_name(connection, existing["list_id"], name, next_product_id, next_external_uid)
            if next_product_id is not None:
                self._require_product(connection, next_product_id)
            category_id, category = self._resolve_item_category(
                connection, existing["list_id"], category_id, category
            )
            if remember_product_category:
                category_id, category = self._remember_item_product_category(
                    connection, existing["list_id"], next_product_id, category_id
                )
            if remember_product_labels:
                self._remember_item_product_labels(
                    connection, existing["list_id"], next_product_id, label_ids,
                    item_id,
                )
            connection.execute(
                """
                UPDATE list_items
                SET product_id = ?, external_uid = ?, name = ?, description = ?, quantity = ?, category_id = ?, category = ?,
                    due_at = ?, recurrence_interval = ?, recurrence_unit = ?, completed = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    next_product_id,
                    next_external_uid,
                    name,
                    description,
                    quantity,
                    category_id,
                    category,
                    due_at,
                    recurrence_interval,
                    recurrence_unit,
                    int(completed),
                    self._now(),
                    item_id,
                ),
            )
            row = connection.execute(
                "SELECT * FROM list_items WHERE id = ?", (item_id,)
            ).fetchone()
            label_ids = self._list_context_label_ids(
                connection, "list_item_labels", "item_id", item_id,
                label_ids, existing["list_id"],
            )
            self._replace_labels(
                connection, "list_item_labels", "item_id", item_id, label_ids
            )
            labels = self._labels_for(connection, "list_item_labels", "item_id", item_id, existing["list_id"])
        return self._item_record_from_row(row, labels)

    def _set_item_completed(
        self, item_id: str, completed: bool
    ) -> ListItemRecord:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE list_items SET completed = ?, updated_at = ? WHERE id = ?",
                (int(completed), self._now(), item_id),
            )
            if cursor.rowcount != 1:
                raise ListItemNotFoundError(item_id)
            row = connection.execute(
                "SELECT * FROM list_items WHERE id = ?", (item_id,)
            ).fetchone()
            labels = self._labels_for(connection, "list_item_labels", "item_id", item_id, row["list_id"])
        return self._item_record_from_row(row, labels)

    def _delete_item(self, item_id: str) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT list_id FROM list_items WHERE id = ?", (item_id,)
            ).fetchone()
            if row is None:
                raise ListItemNotFoundError(item_id)
            cursor = connection.execute(
                "DELETE FROM list_items WHERE id = ?", (item_id,)
            )
            if cursor.rowcount != 1:
                raise ListItemNotFoundError(item_id)
            return row["list_id"]

    def _reorder_items(
        self, list_id: str, item_ids: list[str]
    ) -> list[ListItemRecord]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            current = connection.execute(
                "SELECT id FROM list_items WHERE list_id = ? ORDER BY position, created_at",
                (list_id,),
            ).fetchall()
            current_ids = [row["id"] for row in current]
            if len(item_ids) != len(set(item_ids)) or set(item_ids) != set(current_ids):
                raise ValueError(localized_text("backend.item_order_complete_required"))
            now = self._now()
            connection.executemany(
                "UPDATE list_items SET position = ?, updated_at = ? WHERE id = ? AND list_id = ?",
                [(position, now, item_id, list_id) for position, item_id in enumerate(item_ids)],
            )
        return self._list_items(list_id)

    def _archive_external_item(self, item_id: str, match_key: str) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM list_items WHERE id = ?", (item_id,)
            ).fetchone()
            if row is None:
                raise ListItemNotFoundError(item_id)
            labels = self._labels_for(
                connection, "list_item_labels", "item_id", item_id
            )
            connection.execute(
                """
                INSERT INTO external_item_metadata(
                    list_id, match_key, last_name, category_id, category,
                    product_id, label_ids_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(list_id, match_key) DO UPDATE SET
                    last_name = excluded.last_name,
                    category_id = excluded.category_id,
                    category = excluded.category,
                    product_id = excluded.product_id,
                    label_ids_json = excluded.label_ids_json,
                    updated_at = excluded.updated_at
                """,
                (
                    row["list_id"],
                    match_key,
                    row["name"],
                    row["category_id"],
                    row["category"],
                    row["product_id"],
                    json.dumps([label.id for label in labels]),
                    self._now(),
                ),
            )
            connection.execute("DELETE FROM list_items WHERE id = ?", (item_id,))
            return row["list_id"]

    def _get_external_item_metadata(
        self, list_id: str, match_key: str
    ) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT list_id, match_key, last_name, category_id, category,
                       product_id, label_ids_json, updated_at
                FROM external_item_metadata
                WHERE list_id = ? AND match_key = ?
                """,
                (list_id, match_key),
            ).fetchone()
            if row is None:
                return None
            try:
                stored_label_ids = json.loads(row["label_ids_json"])
            except (TypeError, ValueError):
                stored_label_ids = []
            label_ids = []
            if stored_label_ids:
                placeholders = ",".join("?" for _ in stored_label_ids)
                label_ids = [
                    value["id"]
                    for value in connection.execute(
                        f"SELECT id FROM labels WHERE id IN ({placeholders})",
                        tuple(stored_label_ids),
                    ).fetchall()
                ]
            return {
                "category_id": row["category_id"],
                "category": row["category"],
                "product_id": row["product_id"],
                "label_ids": label_ids,
            }

    def _delete_external_item_metadata(
        self, list_id: str, match_key: str
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM external_item_metadata "
                "WHERE list_id = ? AND match_key = ?",
                (list_id, match_key),
            )

    def _list_external_sync_statuses(self) -> dict[str, dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM external_list_sync_status"
            ).fetchall()
        return {row["list_id"]: dict(row) for row in rows}

    def _mark_external_sync_attempt(self, list_id: str) -> None:
        now = self._now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO external_list_sync_status(
                    list_id, status, last_attempt_at, last_success_at,
                    last_change_at, last_error
                ) VALUES (?, 'syncing', ?, NULL, NULL, NULL)
                ON CONFLICT(list_id) DO UPDATE SET
                    status = 'syncing',
                    last_attempt_at = excluded.last_attempt_at,
                    last_error = NULL
                """,
                (list_id, now),
            )

    def _mark_external_sync_success(
        self, list_id: str, changed: bool
    ) -> dict[str, Any]:
        now = self._now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO external_list_sync_status(
                    list_id, status, last_attempt_at, last_success_at,
                    last_change_at, last_error
                ) VALUES (?, 'ok', ?, ?, ?, NULL)
                ON CONFLICT(list_id) DO UPDATE SET
                    status = 'ok',
                    last_attempt_at = excluded.last_attempt_at,
                    last_success_at = excluded.last_success_at,
                    last_change_at = CASE
                        WHEN ? THEN excluded.last_change_at
                        ELSE external_list_sync_status.last_change_at
                    END,
                    last_error = NULL
                """,
                (list_id, now, now, now if changed else None, int(changed)),
            )
            row = connection.execute(
                "SELECT * FROM external_list_sync_status WHERE list_id = ?",
                (list_id,),
            ).fetchone()
        return dict(row)

    def _mark_external_sync_error(
        self, list_id: str, error: str
    ) -> dict[str, Any]:
        now = self._now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO external_list_sync_status(
                    list_id, status, last_attempt_at, last_success_at,
                    last_change_at, last_error
                ) VALUES (?, 'error', ?, NULL, NULL, ?)
                ON CONFLICT(list_id) DO UPDATE SET
                    status = 'error',
                    last_attempt_at = excluded.last_attempt_at,
                    last_error = excluded.last_error
                """,
                (list_id, now, error[:1000]),
            )
            row = connection.execute(
                "SELECT * FROM external_list_sync_status WHERE list_id = ?",
                (list_id,),
            ).fetchone()
        return dict(row)

    def _list_notification_profiles(self) -> list[NotificationProfileRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM notification_profiles ORDER BY name COLLATE NOCASE"
            ).fetchall()
        return [self._notification_profile_from_row(row) for row in rows]

    def _create_notification_profile(
        self, name: str, provider: str, target: str, title: str | None,
        click_url: str | None, message_format: str, enabled: bool,
    ) -> NotificationProfileRecord:
        self._validate_notification_profile(provider, message_format)
        now = self._now()
        profile_id = str(uuid4())
        try:
            with self._connect() as connection:
                connection.execute(
                    """INSERT INTO notification_profiles(
                        id, name, provider, target, title, click_url,
                        message_format, enabled, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (profile_id, name, provider, target, title, click_url,
                     message_format, int(enabled), now, now),
                )
                row = connection.execute(
                    "SELECT * FROM notification_profiles WHERE id = ?",
                    (profile_id,),
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "notification_profiles.name" in str(error) or "notification_profiles_name_unique" in str(error):
                raise DuplicateNotificationProfileNameError(name) from error
            raise
        return self._notification_profile_from_row(row)

    def _update_notification_profile(
        self, profile_id: str, name: str, provider: str, target: str,
        title: str | None, click_url: str | None,
        message_format: str, enabled: bool,
    ) -> NotificationProfileRecord:
        self._validate_notification_profile(provider, message_format)
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    """UPDATE notification_profiles SET
                        name = ?, provider = ?, target = ?, title = ?, click_url = ?,
                        message_format = ?, enabled = ?, updated_at = ?
                    WHERE id = ?""",
                    (name, provider, target, title, click_url, message_format, int(enabled),
                     self._now(), profile_id),
                )
                if cursor.rowcount != 1:
                    raise NotificationProfileNotFoundError(profile_id)
                row = connection.execute(
                    "SELECT * FROM notification_profiles WHERE id = ?",
                    (profile_id,),
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "notification_profiles.name" in str(error) or "notification_profiles_name_unique" in str(error):
                raise DuplicateNotificationProfileNameError(name) from error
            raise
        return self._notification_profile_from_row(row)

    def _delete_notification_profile(self, profile_id: str) -> None:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM notification_profiles WHERE id = ?", (profile_id,)
            )
            if cursor.rowcount != 1:
                raise NotificationProfileNotFoundError(profile_id)

    def _list_notification_assignments(
        self, list_id: str | None
    ) -> list[ListNotificationAssignmentRecord]:
        with self._connect() as connection:
            if list_id is not None:
                self._require_list(connection, list_id)
            where = "WHERE a.list_id = ?" if list_id is not None else ""
            parameters = (list_id,) if list_id is not None else ()
            rows = connection.execute(
                f"""SELECT a.list_id, a.profile_id, a.manual_enabled,
                    a.automatic_mode, a.delay_seconds,
                    a.notify_on_add,
                    CASE WHEN l.list_type = 'todo' THEN 0
                         ELSE a.notify_on_increase END AS notify_on_increase,
                    CASE WHEN l.list_type = 'todo' THEN 0
                         ELSE a.notify_on_decrease END AS notify_on_decrease,
                    a.notify_on_edit,
                    a.notify_on_complete, a.notify_on_reopen,
                    a.notify_on_delete,
                    p.id, p.name, p.provider, p.target, p.title, p.click_url,
                    p.message_format, p.enabled, p.created_at, p.updated_at
                FROM list_notification_profiles AS a
                JOIN notification_profiles AS p ON p.id = a.profile_id
                JOIN lists AS l ON l.id = a.list_id
                {where}
                ORDER BY a.list_id, p.name COLLATE NOCASE""",
                parameters,
            ).fetchall()
        return [
            ListNotificationAssignmentRecord(
                list_id=row["list_id"], profile_id=row["profile_id"],
                manual_enabled=bool(row["manual_enabled"]),
                automatic_mode=row["automatic_mode"],
                delay_seconds=int(row["delay_seconds"]),
                notify_on_add=bool(row["notify_on_add"]),
                notify_on_increase=bool(row["notify_on_increase"]),
                notify_on_decrease=bool(row["notify_on_decrease"]),
                notify_on_edit=bool(row["notify_on_edit"]),
                notify_on_complete=bool(row["notify_on_complete"]),
                notify_on_reopen=bool(row["notify_on_reopen"]),
                notify_on_delete=bool(row["notify_on_delete"]),
                profile=self._notification_profile_from_row(row),
            )
            for row in rows
        ]

    def _set_notification_assignments(
        self, list_id: str, assignments: list[dict[str, Any] | str]
    ) -> list[ListNotificationAssignmentRecord]:
        with self._connect() as connection:
            list_row = connection.execute(
                "SELECT list_type FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if list_row is None:
                raise ListNotFoundError(list_id)
        supports_quantity_events = list_row["list_type"] != "todo"
        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()
        for value in assignments:
            config = {"profile_id": value} if isinstance(value, str) else dict(value)
            profile_id = str(config.get("profile_id") or "")
            if not profile_id or profile_id in seen:
                continue
            seen.add(profile_id)
            mode = str(config.get("automatic_mode") or "off")
            if mode not in {"off", "changes", "full", "changes_and_full"}:
                raise ValueError(localized_text("backend.notification_mode_unsupported", mode=mode))
            delay = int(config.get("delay_seconds", 15))
            if delay < 0 or delay > 86400:
                raise ValueError(localized_text("backend.notification_delay_range"))
            normalized.append({
                "profile_id": profile_id,
                "manual_enabled": bool(config.get("manual_enabled", True)),
                "automatic_mode": mode,
                "delay_seconds": delay,
                "notify_on_add": bool(config.get("notify_on_add", True)),
                "notify_on_increase": supports_quantity_events
                and bool(config.get("notify_on_increase", True)),
                "notify_on_decrease": supports_quantity_events
                and bool(config.get("notify_on_decrease", True)),
                "notify_on_edit": bool(config.get("notify_on_edit", True)),
                "notify_on_complete": bool(config.get("notify_on_complete", False)),
                "notify_on_reopen": bool(config.get("notify_on_reopen", False)),
                "notify_on_delete": bool(config.get("notify_on_delete", True)),
            })
            if mode != "off" and not any(
                normalized[-1][field]
                for field in (
                    "notify_on_add", "notify_on_increase", "notify_on_decrease",
                    "notify_on_edit", "notify_on_complete", "notify_on_reopen",
                    "notify_on_delete",
                )
            ):
                raise ValueError(
                    localized_text("backend.notification_event_required")
                )
        unique_ids = [config["profile_id"] for config in normalized]
        with self._connect() as connection:
            self._require_list(connection, list_id)
            if unique_ids:
                placeholders = ",".join("?" for _ in unique_ids)
                count = connection.execute(
                    f"SELECT COUNT(*) AS count FROM notification_profiles WHERE id IN ({placeholders})",
                    unique_ids,
                ).fetchone()["count"]
                if count != len(unique_ids):
                    raise NotificationProfileNotFoundError(localized_text("backend.profile_assignment_unknown"))
            connection.execute(
                "DELETE FROM list_notification_profiles WHERE list_id = ?",
                (list_id,),
            )
            connection.executemany(
                """INSERT INTO list_notification_profiles(
                    list_id, profile_id, manual_enabled, automatic_mode,
                    delay_seconds, notify_on_add, notify_on_increase,
                    notify_on_decrease, notify_on_edit, notify_on_complete,
                    notify_on_reopen, notify_on_delete
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [(
                    list_id, config["profile_id"], int(config["manual_enabled"]),
                    config["automatic_mode"], config["delay_seconds"],
                    int(config["notify_on_add"]), int(config["notify_on_increase"]),
                    int(config["notify_on_decrease"]), int(config["notify_on_edit"]),
                    int(config["notify_on_complete"]), int(config["notify_on_reopen"]),
                    int(config["notify_on_delete"]),
                ) for config in normalized],
            )
            if unique_ids:
                placeholders = ",".join("?" for _ in unique_ids)
                connection.execute(
                    f"""DELETE FROM notification_pending_batches
                    WHERE list_id = ? AND profile_id NOT IN ({placeholders})""",
                    (list_id, *unique_ids),
                )
                disabled_ids = [
                    config["profile_id"] for config in normalized
                    if config["automatic_mode"] == "off"
                ]
                if disabled_ids:
                    disabled_placeholders = ",".join("?" for _ in disabled_ids)
                    connection.execute(
                        f"""DELETE FROM notification_pending_batches
                        WHERE list_id = ? AND profile_id IN ({disabled_placeholders})""",
                        (list_id, *disabled_ids),
                    )
            else:
                connection.execute(
                    "DELETE FROM notification_pending_batches WHERE list_id = ?",
                    (list_id,),
                )
        return self._list_notification_assignments(list_id)

    def _list_notification_pending_batches(
        self,
    ) -> list[NotificationPendingBatchRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM notification_pending_batches ORDER BY due_at"
            ).fetchall()
        return [self._notification_pending_batch_from_row(row) for row in rows]

    def _get_notification_pending_batch(
        self, list_id: str, profile_id: str
    ) -> NotificationPendingBatchRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT * FROM notification_pending_batches
                WHERE list_id = ? AND profile_id = ?""",
                (list_id, profile_id),
            ).fetchone()
        return self._notification_pending_batch_from_row(row) if row else None

    def _upsert_notification_pending_batch(
        self, list_id: str, profile_id: str, due_at: str, changes_json: str
    ) -> NotificationPendingBatchRecord:
        now = self._now()
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO notification_pending_batches(
                    list_id, profile_id, due_at, changes_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(list_id, profile_id) DO UPDATE SET
                    due_at = excluded.due_at,
                    changes_json = excluded.changes_json,
                    updated_at = excluded.updated_at""",
                (list_id, profile_id, due_at, changes_json, now, now),
            )
            row = connection.execute(
                """SELECT * FROM notification_pending_batches
                WHERE list_id = ? AND profile_id = ?""",
                (list_id, profile_id),
            ).fetchone()
        return self._notification_pending_batch_from_row(row)

    def _delete_notification_pending_batch(
        self, list_id: str, profile_id: str
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """DELETE FROM notification_pending_batches
                WHERE list_id = ? AND profile_id = ?""",
                (list_id, profile_id),
            )

    def _remember_item_product_labels(
        self,
        connection: sqlite3.Connection,
        list_id: str,
        product_id: str | None,
        label_ids: list[str],
        item_id: str | None = None,
    ) -> None:
        """Replace only direct product assignments editable in this list."""
        target = connection.execute(
            "SELECT list_type, provider FROM lists WHERE id = ?", (list_id,),
        ).fetchone()
        if target is None:
            raise ListNotFoundError(list_id)
        if target["list_type"] != "shopping" or target["provider"] != "local":
            raise ValueError(localized_text("backend.local_shopping_target_required"))
        if product_id is None:
            raise ProductNotFoundError(product_id)
        self._require_product(connection, product_id)
        self._validate_label_ids(connection, label_ids)
        visible_ids = self._applicable_label_ids(connection, list_id)
        stored_ids = {
            label.id for label in self._labels_for(
                connection, "product_labels", "product_id", product_id
            )
        }
        selected_ids = set(label_ids)
        retained_item_ids = {
            label.id for label in self._labels_for(
                connection, "list_item_labels", "item_id", item_id
            )
        } if item_id is not None else set()
        # Drafts can retain unavailable assignments, but cannot introduce a
        # label from another list, a disabled scope or a shadowed definition.
        if selected_ids - visible_ids - stored_ids - retained_item_ids:
            raise LabelNotFoundError(localized_text("backend.label_assignment_unknown"))
        next_ids = (stored_ids - visible_ids) | (selected_ids & visible_ids)
        if next_ids != stored_ids:
            self._replace_labels(
                connection, "product_labels", "product_id", product_id,
                sorted(next_ids),
            )
            connection.execute(
                "UPDATE products SET updated_at = ? WHERE id = ?",
                (self._now(), product_id),
            )

    def _remember_item_product_category(
        self,
        connection: sqlite3.Connection,
        list_id: str,
        product_id: str | None,
        category_id: str | None,
    ) -> tuple[str, str]:
        """Store the saved item's default only in this product/list context."""
        target = connection.execute(
            "SELECT list_type, provider, use_global_categories, use_type_categories "
            "FROM lists WHERE id = ?", (list_id,),
        ).fetchone()
        if target is None:
            raise ListNotFoundError(list_id)
        if target["list_type"] != "shopping" or target["provider"] != "local":
            raise ValueError(localized_text("backend.local_shopping_target_required"))
        if product_id is None:
            raise ProductNotFoundError(product_id)
        self._require_product(connection, product_id)
        category = connection.execute(
            "SELECT * FROM categories WHERE id = ?", (category_id,),
        ).fetchone()
        if category is None or not (
            category["scope"] == "list" and category["list_id"] == list_id
            or category["scope"] == "global" and target["use_global_categories"]
            or category["scope"] == "list_type" and category["list_type"] == "shopping"
            and target["use_type_categories"]
        ):
            raise CategoryNotFoundError(category_id)
        local = connection.execute(
            "SELECT * FROM categories WHERE scope = 'list' AND list_id = ? "
            "AND name = ? COLLATE NOCASE", (list_id, category["name"]),
        ).fetchone()
        local_id = local["id"] if local else str(uuid4())
        if local is None:
            now = self._now()
            connection.execute(
                "INSERT INTO categories(id,name,scope,list_type,list_id,icon,color,"
                "position,created_at,updated_at) VALUES(?,?,'list',NULL,?,?,?,?,?,?)",
                (local_id, category["name"], list_id, category["icon"],
                 category["color"], category["position"], now, now),
            )
        # Unlike category administration, this opt-in save must never move
        # sibling entries or overwrite the product's broader defaults.
        connection.execute(
            "DELETE FROM product_category_assignments WHERE product_id = ? "
            "AND category_id IN (SELECT id FROM categories "
            "WHERE scope = 'list' AND list_id = ?)",
            (product_id, list_id),
        )
        connection.execute(
            "INSERT INTO product_category_assignments(product_id, category_id) VALUES (?, ?)",
            (product_id, local_id),
        )
        return local_id, local["name"] if local else category["name"]

    @staticmethod
    def _resolve_item_category(
        connection: sqlite3.Connection,
        list_id: str,
        category_id: str | None,
        category: str | None,
    ) -> tuple[str | None, str | None]:
        """Resolve a permanent category ID or preserve a dynamic category name."""
        if category_id is None:
            return None, category
        row = connection.execute(
            "SELECT id, name, scope, list_type, list_id FROM categories WHERE id = ?",
            (category_id,),
        ).fetchone()
        if row is None:
            raise CategoryNotFoundError(category_id)
        if row["scope"] == "list" and row["list_id"] != list_id:
            raise CategoryNotFoundError(category_id)
        if row["scope"] == "list_type":
            target = connection.execute(
                "SELECT list_type FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if target is None or target["list_type"] != row["list_type"]:
                raise CategoryNotFoundError(category_id)
        return row["id"], row["name"]

    def _product_filter(
        self, search: str | None, label_id: str | None
    ) -> tuple[str, list[str]]:
        clauses: list[str] = []
        parameters: list[str] = []
        if search:
            clauses.append(
                "(instr(product_text(name), ?) > 0 "
                "OR instr(product_text(original_name), ?) > 0 "
                "OR instr(product_text(ean), ?) > 0 "
                "OR instr(product_text(brand), ?) > 0 "
                "OR instr(product_text(category), ?) > 0 "
                "OR EXISTS (SELECT 1 FROM product_category_assignments pca "
                "JOIN categories pc ON pc.id = pca.category_id "
                "WHERE pca.product_id = products.id "
                "AND instr(product_text(pc.name), ?) > 0) "
                "OR EXISTS (SELECT 1 FROM product_labels pl "
                "JOIN labels l ON l.id = pl.label_id "
                "WHERE pl.product_id = products.id "
                "AND instr(product_text(l.name), ?) > 0))"
            )
            parameters.extend([_product_text(search)] * 7)
        if label_id:
            clauses.append(
                "EXISTS (SELECT 1 FROM product_labels pl "
                "WHERE pl.product_id = products.id AND pl.label_id = ?)"
            )
            parameters.append(label_id)
        return (f"WHERE {' AND '.join(clauses)}" if clauses else "", parameters)

    def _list_products(
        self, search: str | None, label_id: str | None
    ) -> list[ProductRecord]:
        with self._connect() as connection:
            where, parameters = self._product_filter(search, label_id)
            rows = connection.execute(
                f"SELECT * FROM products {where} "
                "ORDER BY product_text(name), product_text(brand), id",
                parameters,
            ).fetchall()
            records = [
                self._product_record_from_row(
                    row,
                    self._labels_for(connection, "product_labels", "product_id", row["id"]),
                    self._product_category_assignments(connection, row["id"]),
                )
                for row in rows
            ]
        return records

    def _list_recent_products(self, limit: int) -> list[ProductRecord]:
        limit = max(1, min(100, int(limit)))
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM products "
                "ORDER BY updated_at DESC, product_text(name), product_text(brand), id "
                "LIMIT ?",
                (limit,),
            ).fetchall()
            return [
                self._product_record_from_row(
                    row,
                    self._labels_for(
                        connection, "product_labels", "product_id", row["id"]
                    ),
                    self._product_category_assignments(connection, row["id"]),
                )
                for row in rows
            ]

    def _get_products_by_ids(self, product_ids: list[str]) -> list[ProductRecord]:
        if not product_ids:
            return []
        with self._connect() as connection:
            placeholders = ",".join("?" for _ in product_ids)
            rows = connection.execute(
                f"SELECT * FROM products WHERE id IN ({placeholders}) "
                "ORDER BY product_text(name), product_text(brand), id",
                product_ids,
            ).fetchall()
            return [self._product_record_from_row(
                row, self._labels_for(connection, "product_labels", "product_id", row["id"]),
                self._product_category_assignments(connection, row["id"])) for row in rows]

    def _list_products_page(
        self,
        search: str | None,
        label_id: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[ProductRecord], int]:
        with self._connect() as connection:
            where, parameters = self._product_filter(search, label_id)
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) AS value FROM products {where}", parameters
                ).fetchone()["value"]
            )
            rows = connection.execute(
                f"SELECT * FROM products {where} "
                "ORDER BY product_text(name), product_text(brand), id "
                "LIMIT ? OFFSET ?",
                [*parameters, limit, offset],
            ).fetchall()
            records = [
                self._product_record_from_row(
                    row,
                    self._labels_for(
                        connection, "product_labels", "product_id", row["id"]
                    ),
                    self._product_category_assignments(connection, row["id"]),
                )
                for row in rows
            ]
        return records, total

    def _get_product_by_ean(self, ean: str) -> ProductRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM products WHERE ean = ?", (ean,)
            ).fetchone()
            labels = (
                self._labels_for(connection, "product_labels", "product_id", row["id"])
                if row is not None
                else ()
            )
            category_assignments = (
                self._product_category_assignments(connection, row["id"])
                if row is not None
                else ()
            )
        return (
            self._product_record_from_row(row, labels, category_assignments)
            if row is not None else None
        )

    def _create_product(
        self,
        ean: str | None,
        name: str,
        original_name: str | None,
        brand: str | None,
        package_quantity: str | None,
        category: str | None,
        image_url: str | None,
        source: str,
        label_ids: list[str],
        category_ids: list[str] | None = None,
    ) -> ProductRecord:
        now = self._now()
        record = ProductRecord(
            id=str(uuid4()),
            ean=ean,
            name=name,
            original_name=original_name,
            brand=brand,
            package_quantity=package_quantity,
            category=category,
            image_url=image_url,
            source=source,
            created_at=now,
            updated_at=now,
            labels=(),
        )
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO products(
                        id, ean, name, original_name, brand, package_quantity, category,
                        image_url, source, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.ean,
                        record.name,
                        record.original_name,
                        record.brand,
                        record.package_quantity,
                        record.category,
                        record.image_url,
                        record.source,
                        record.created_at,
                        record.updated_at,
                    ),
                )
                self._replace_labels(
                    connection, "product_labels", "product_id", record.id, label_ids
                )
                self._replace_product_category_assignments(
                    connection, record.id, category_ids or []
                )
                row = connection.execute(
                    "SELECT * FROM products WHERE id = ?", (record.id,)
                ).fetchone()
                labels = self._labels_for(
                    connection, "product_labels", "product_id", record.id
                )
                category_assignments = self._product_category_assignments(
                    connection, record.id
                )
        except sqlite3.IntegrityError as error:
            if "products.ean" in str(error) or "products_ean_unique" in str(error):
                raise DuplicateEANError(ean) from error
            raise
        return self._product_record_from_row(row, labels, category_assignments)

    def _update_product(
        self,
        product_id: str,
        ean: str | None,
        name: str,
        original_name: str | None,
        brand: str | None,
        package_quantity: str | None,
        category: str | None,
        image_url: str | None,
        label_ids: list[str],
        category_ids: list[str] | None,
        list_id: str | None = None,
    ) -> ProductRecord:
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    """
                    UPDATE products
                    SET ean = ?, name = ?, original_name = ?, brand = ?, package_quantity = ?,
                        category = ?, image_url = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        ean,
                        name,
                        original_name,
                        brand,
                        package_quantity,
                        category,
                        image_url,
                        self._now(),
                        product_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise ProductNotFoundError(product_id)
                row = connection.execute(
                    "SELECT * FROM products WHERE id = ?", (product_id,)
                ).fetchone()
                if list_id is not None:
                    self._require_list(connection, list_id)
                    label_ids = self._list_context_label_ids(
                        connection, "product_labels", "product_id", product_id,
                        label_ids, list_id,
                    )
                self._replace_labels(
                    connection, "product_labels", "product_id", product_id, label_ids
                )
                if category_ids is not None:
                    self._replace_product_category_assignments(
                        connection, product_id, category_ids
                    )
                labels = self._labels_for(
                    connection, "product_labels", "product_id", product_id
                )
                category_assignments = self._product_category_assignments(
                    connection, product_id
                )
        except sqlite3.IntegrityError as error:
            if "products.ean" in str(error) or "products_ean_unique" in str(error):
                raise DuplicateEANError(ean) from error
            raise
        return self._product_record_from_row(row, labels, category_assignments)

    def _delete_product(self, product_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM important_chip_assignments "
                "WHERE target_type = 'product' AND target_id = ?",
                (product_id,),
            )
            cursor = connection.execute(
                "DELETE FROM products WHERE id = ?", (product_id,)
            )
            if cursor.rowcount != 1:
                raise ProductNotFoundError(product_id)

    def _list_products_for_category(
        self, category_id: str
    ) -> list[ProductRecord]:
        with self._connect() as connection:
            if connection.execute(
                "SELECT 1 FROM categories WHERE id = ?", (category_id,)
            ).fetchone() is None:
                raise CategoryNotFoundError(category_id)
            rows = connection.execute(
                """
                SELECT products.*
                FROM products
                JOIN product_category_assignments AS assignments
                  ON assignments.product_id = products.id
                WHERE assignments.category_id = ?
                ORDER BY product_text(products.name), product_text(products.brand), products.id
                """,
                (category_id,),
            ).fetchall()
            return [
                self._product_record_from_row(
                    row,
                    self._labels_for(
                        connection, "product_labels", "product_id", row["id"]
                    ),
                    self._product_category_assignments(connection, row["id"]),
                )
                for row in rows
            ]

    def _set_product_list_category(
        self,
        product_id: str,
        list_id: str,
        category_id: str | None,
        replace_existing: bool,
    ) -> tuple[ProductRecord, CategoryRecord | None, bool, str]:
        """Replace only the list-specific product category and synchronize live rows."""
        with self._connect() as connection:
            self._require_product(connection, product_id)
            list_row = connection.execute(
                "SELECT list_type FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if list_row is None:
                raise ListNotFoundError(list_id)
            if list_row["list_type"] == "todo":
                raise ValueError(
                    localized_text("backend.todo_product_categories_unavailable")
                )
            target_row = None
            if category_id is not None:
                target_row = connection.execute(
                    "SELECT * FROM categories WHERE id = ? AND scope = 'list' AND list_id = ?",
                    (category_id, list_id),
                ).fetchone()
                if target_row is None:
                    raise CategoryNotFoundError(category_id)
            current_row = connection.execute(
                """
                SELECT categories.*
                FROM product_category_assignments AS assignments
                JOIN categories ON categories.id = assignments.category_id
                WHERE assignments.product_id = ?
                  AND categories.scope = 'list' AND categories.list_id = ?
                """,
                (product_id, list_id),
            ).fetchone()
            current = (
                self._category_record_from_row(current_row)
                if current_row is not None else None
            )
            if current_row is not None and category_id is not None:
                if current_row["id"] == category_id or not replace_existing:
                    product_row = connection.execute(
                        "SELECT * FROM products WHERE id = ?", (product_id,)
                    ).fetchone()
                    product = self._product_record_from_row(
                        product_row,
                        self._labels_for(
                            connection, "product_labels", "product_id", product_id
                        ),
                        self._product_category_assignments(connection, product_id),
                    )
                    return product, current, False, list_row["list_type"]

            connection.execute(
                """
                DELETE FROM product_category_assignments
                WHERE product_id = ? AND category_id IN (
                    SELECT id FROM categories WHERE scope = 'list' AND list_id = ?
                )
                """,
                (product_id, list_id),
            )
            if category_id is not None:
                connection.execute(
                    "INSERT INTO product_category_assignments(product_id, category_id) VALUES (?, ?)",
                    (product_id, category_id),
                )
                resolved_id, resolved_name = category_id, target_row["name"]
            else:
                resolved_id, resolved_name = self._resolve_product_category_for_list(
                    connection, product_id, list_id
                )
            now = self._now()
            for table in ("list_items", "inventory_entries"):
                connection.execute(
                    f"UPDATE {table} SET category_id = ?, category = ?, updated_at = ? "
                    "WHERE list_id = ? AND product_id = ?",
                    (resolved_id, resolved_name, now, list_id, product_id),
                )
            connection.execute(
                "UPDATE external_item_metadata SET category_id = ?, category = ?, updated_at = ? "
                "WHERE list_id = ? AND product_id = ?",
                (resolved_id, resolved_name, now, list_id, product_id),
            )
            product_row = connection.execute(
                "SELECT * FROM products WHERE id = ?", (product_id,)
            ).fetchone()
            product = self._product_record_from_row(
                product_row,
                self._labels_for(
                    connection, "product_labels", "product_id", product_id
                ),
                self._product_category_assignments(connection, product_id),
            )
            return product, current, True, list_row["list_type"]

    def _list_categories(self, list_id: str | None = None) -> list[CategoryRecord]:
        with self._connect() as connection:
            parameters: tuple[Any, ...] = ()
            where = ""
            if list_id is not None:
                self._require_list(connection, list_id)
                list_row = connection.execute(
                    "SELECT list_type, use_global_categories, use_type_categories "
                    "FROM lists WHERE id = ?", (list_id,)
                ).fetchone()
                clauses = ["(scope = 'list' AND list_id = ?)"]
                values: list[Any] = [list_id]
                if list_row["use_type_categories"]:
                    clauses.append("(scope = 'list_type' AND list_type = ?)")
                    values.append(list_row["list_type"])
                if list_row["use_global_categories"]:
                    clauses.append("scope = 'global'")
                where = "WHERE " + " OR ".join(clauses)
                parameters = tuple(values)
            rows = connection.execute(
                f"""
                SELECT * FROM categories
                {where}
                ORDER BY name COLLATE NOCASE,
                         CASE scope WHEN 'list' THEN 0 WHEN 'list_type' THEN 1 ELSE 2 END,
                         position
                """, parameters
            ).fetchall()
        records = [self._category_record_from_row(row) for row in rows]
        if list_id is None:
            return records
        return self._resolve_scoped_records(records)

    def _list_dynamic_categories(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                WITH dynamic_categories AS (
                    SELECT list_id, category AS name FROM list_items
                    WHERE category_id IS NULL
                    UNION ALL
                    SELECT list_id, category AS name FROM inventory_entries
                    WHERE category_id IS NULL
                    UNION ALL
                    SELECT list_id, category AS name FROM inventory_groups
                    WHERE category_id IS NULL
                )
                SELECT i.list_id, l.name AS list_name, i.name,
                       COUNT(*) AS item_count
                FROM dynamic_categories AS i
                JOIN lists AS l ON l.id = i.list_id
                WHERE i.name IS NOT NULL
                  AND trim(i.name) != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM categories AS c
                      WHERE lower(c.name) = lower(i.name)
                        AND ((c.scope = 'global' AND l.use_global_categories)
                             OR (c.scope = 'list_type' AND c.list_type = l.list_type AND l.use_type_categories)
                             OR (c.scope = 'list' AND c.list_id = i.list_id))
                  )
                GROUP BY i.list_id, l.name, lower(i.name)
                ORDER BY l.name COLLATE NOCASE, i.name COLLATE NOCASE
                """
            ).fetchall()
        return [
            {
                "list_id": row["list_id"],
                "list_name": row["list_name"],
                "name": row["name"],
                "item_count": row["item_count"],
            }
            for row in rows
        ]

    def _list_category_rules(self, category_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            if connection.execute(
                "SELECT 1 FROM categories WHERE id = ?", (category_id,)
            ).fetchone() is None:
                raise CategoryNotFoundError(category_id)
            rows = connection.execute(
                "SELECT id, category_id, pattern, position, created_at, updated_at "
                "FROM category_rules WHERE category_id = ? "
                "ORDER BY position, pattern COLLATE NOCASE",
                (category_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _replace_category_rules(
        self, category_id: str, patterns: list[str]
    ) -> list[dict[str, Any]]:
        normalized = self._normalize_category_rules(patterns)
        now = self._now()
        with self._connect() as connection:
            category = connection.execute(
                "SELECT * FROM categories WHERE id = ?", (category_id,)
            ).fetchone()
            if category is None:
                raise CategoryNotFoundError(category_id)
            self._ensure_category_rules_unique_in_scope(
                connection,
                category_id,
                normalized,
                category["scope"],
                category["list_type"],
                category["list_id"],
            )
            existing = {
                row["pattern"].casefold(): row
                for row in connection.execute(
                    "SELECT * FROM category_rules WHERE category_id = ?",
                    (category_id,),
                ).fetchall()
            }
            connection.execute(
                "DELETE FROM category_rules WHERE category_id = ?", (category_id,)
            )
            for position, pattern in enumerate(normalized):
                previous = existing.get(pattern.casefold())
                connection.execute(
                    """INSERT INTO category_rules(
                        id, category_id, pattern, position, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        previous["id"] if previous else str(uuid4()),
                        category_id,
                        pattern,
                        position,
                        previous["created_at"] if previous else now,
                        now,
                    ),
                )
            rows = connection.execute(
                "SELECT id, category_id, pattern, position, created_at, updated_at "
                "FROM category_rules WHERE category_id = ? ORDER BY position",
                (category_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _create_category(
        self,
        name: str,
        scope: str,
        list_type: str | None,
        list_id: str | None,
        icon: str | None,
        color: str | None,
        position: int | None,
    ) -> CategoryRecord:
        scope, list_type, list_id = self._validate_category_scope(
            scope, list_type, list_id
        )
        now = self._now()
        with self._connect() as connection:
            if list_id is not None:
                self._require_list(connection, list_id)
            row = connection.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 AS next_position "
                "FROM categories WHERE scope = ? AND list_type IS ? AND list_id IS ?",
                (scope, list_type, list_id),
            ).fetchone()
            next_position = int(row["next_position"])
            resolved_position = next_position if position is None else min(position, next_position)
            if position is not None:
                connection.execute(
                    "UPDATE categories SET position = position + 1 "
                    "WHERE scope = ? AND list_type IS ? AND list_id IS ? AND position >= ?",
                    (scope, list_type, list_id, resolved_position),
                )
            record = CategoryRecord(
                id=str(uuid4()),
                name=name,
                scope=scope,
                list_type=list_type,
                list_id=list_id,
                icon=icon,
                color=color,
                position=resolved_position,
                created_at=now,
                updated_at=now,
            )
            try:
                connection.execute(
                    """
                    INSERT INTO categories(
                        id, name, scope, list_type, list_id, icon, color, position,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.name,
                        record.scope,
                        record.list_type,
                        record.list_id,
                        record.icon,
                        record.color,
                        record.position,
                        record.created_at,
                        record.updated_at,
                    ),
                )
                self._insert_category_into_saved_orders(
                    connection,
                    record.id,
                    scope,
                    list_id,
                    resolved_position,
                )
            except sqlite3.IntegrityError as error:
                if "categories" in str(error):
                    raise DuplicateCategoryError(name) from error
                raise
        return record

    def _update_category(
        self,
        category_id: str,
        name: str,
        scope: str,
        list_type: str | None,
        list_id: str | None,
        icon: str | None,
        color: str | None,
        position: int | None,
    ) -> CategoryRecord:
        scope, list_type, list_id = self._validate_category_scope(
            scope, list_type, list_id
        )
        try:
            with self._connect() as connection:
                if list_id is not None:
                    self._require_list(connection, list_id)
                existing = connection.execute(
                    "SELECT * FROM categories WHERE id = ?", (category_id,)
                ).fetchone()
                if existing is None:
                    raise CategoryNotFoundError(category_id)
                old_scope = existing["scope"]
                old_list_type = existing["list_type"]
                old_list_id = existing["list_id"]
                old_position = int(existing["position"])
                same_bucket = (
                    old_scope == scope
                    and old_list_type == list_type
                    and old_list_id == list_id
                )
                if not same_bucket:
                    patterns = [
                        row["pattern"]
                        for row in connection.execute(
                            "SELECT pattern FROM category_rules "
                            "WHERE category_id = ? ORDER BY position",
                            (category_id,),
                        ).fetchall()
                    ]
                    self._ensure_category_rules_unique_in_scope(
                        connection,
                        category_id,
                        patterns,
                        scope,
                        list_type,
                        list_id,
                    )
                if same_bucket:
                    count = connection.execute(
                        "SELECT COUNT(*) AS value FROM categories "
                        "WHERE scope = ? AND list_type IS ? AND list_id IS ?",
                        (scope, list_type, list_id),
                    ).fetchone()["value"]
                    resolved_position = old_position if position is None else min(position, max(0, int(count) - 1))
                    if resolved_position < old_position:
                        connection.execute(
                            "UPDATE categories SET position = position + 1 "
                            "WHERE scope = ? AND list_type IS ? AND list_id IS ? "
                            "AND position >= ? AND position < ?",
                            (scope, list_type, list_id, resolved_position, old_position),
                        )
                    elif resolved_position > old_position:
                        connection.execute(
                            "UPDATE categories SET position = position - 1 "
                            "WHERE scope = ? AND list_type IS ? AND list_id IS ? "
                            "AND position > ? AND position <= ?",
                            (scope, list_type, list_id, old_position, resolved_position),
                        )
                else:
                    connection.execute(
                        "UPDATE categories SET position = position - 1 "
                        "WHERE scope = ? AND list_type IS ? AND list_id IS ? AND position > ?",
                        (old_scope, old_list_type, old_list_id, old_position),
                    )
                    next_position = int(connection.execute(
                        "SELECT COALESCE(MAX(position), -1) + 1 AS value FROM categories "
                        "WHERE scope = ? AND list_type IS ? AND list_id IS ?",
                        (scope, list_type, list_id),
                    ).fetchone()["value"])
                    resolved_position = next_position if position is None else min(position, next_position)
                    if position is not None:
                        connection.execute(
                            "UPDATE categories SET position = position + 1 "
                            "WHERE scope = ? AND list_type IS ? AND list_id IS ? AND position >= ?",
                            (scope, list_type, list_id, resolved_position),
                        )
                now = self._now()
                cursor = connection.execute(
                    """
                    UPDATE categories
                    SET name = ?, scope = ?, list_type = ?, list_id = ?, icon = ?, color = ?, position = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (name, scope, list_type, list_id, icon, color, resolved_position, now, category_id),
                )
                if cursor.rowcount != 1:
                    raise CategoryNotFoundError(category_id)
                if not same_bucket:
                    connection.execute(
                        "DELETE FROM list_category_order WHERE category_id = ?",
                        (category_id,),
                    )
                    self._insert_category_into_saved_orders(
                        connection,
                        category_id,
                        scope,
                        list_id,
                        resolved_position,
                    )
                    self._normalize_saved_category_orders(connection)
                if existing["name"].casefold() != name.casefold():
                    if existing["scope"] == "global":
                        connection.execute(
                            "UPDATE list_items SET category = ?, updated_at = ? "
                            "WHERE category_id = ? OR "
                            "(category_id IS NULL AND lower(category) = lower(?))",
                            (name, now, category_id, existing["name"]),
                        )
                        connection.execute(
                            "UPDATE products SET category = ?, updated_at = ? "
                            "WHERE lower(category) = lower(?)",
                            (name, now, existing["name"]),
                        )
                        connection.execute(
                            "UPDATE inventory_entries SET category = ?, updated_at = ? "
                            "WHERE category_id = ? OR "
                            "(category_id IS NULL AND lower(category) = lower(?))",
                            (name, now, category_id, existing["name"]),
                        )
                        connection.execute(
                            "UPDATE inventory_groups SET category = ?, updated_at = ? "
                            "WHERE category_id = ? OR "
                            "(category_id IS NULL AND lower(category) = lower(?))",
                            (name, now, category_id, existing["name"]),
                        )
                    else:
                        connection.execute(
                            "UPDATE list_items SET category = ?, updated_at = ? "
                            "WHERE category_id = ? OR "
                            "(category_id IS NULL AND list_id = ? "
                            "AND lower(category) = lower(?))",
                            (
                                name,
                                now,
                                category_id,
                                existing["list_id"],
                                existing["name"],
                            ),
                        )
                        connection.execute(
                            "UPDATE inventory_entries SET category = ?, updated_at = ? "
                            "WHERE category_id = ? OR "
                            "(category_id IS NULL AND list_id = ? "
                            "AND lower(category) = lower(?))",
                            (
                                name,
                                now,
                                category_id,
                                existing["list_id"],
                                existing["name"],
                            ),
                        )
                        connection.execute(
                            "UPDATE inventory_groups SET category = ?, updated_at = ? "
                            "WHERE category_id = ? OR "
                            "(category_id IS NULL AND list_id = ? "
                            "AND lower(category) = lower(?))",
                            (
                                name,
                                now,
                                category_id,
                                existing["list_id"],
                                existing["name"],
                            ),
                        )
                row = connection.execute(
                    "SELECT * FROM categories WHERE id = ?", (category_id,)
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "categories" in str(error):
                raise DuplicateCategoryError(name) from error
            raise
        return self._category_record_from_row(row)

    def _insert_category_into_saved_orders(
        self,
        connection: sqlite3.Connection,
        category_id: str,
        scope: str,
        list_id: str | None,
        position: int,
    ) -> None:
        """Insert a category into each already customized compatible list order."""
        target_lists = connection.execute(
            "SELECT DISTINCT list_id FROM list_category_order "
            "WHERE (? = 'global') OR list_id = ?",
            (scope, list_id),
        ).fetchall()
        for target_list in target_lists:
            ordered_list_id = target_list["list_id"]
            count = int(
                connection.execute(
                    "SELECT COUNT(*) AS value FROM list_category_order WHERE list_id = ?",
                    (ordered_list_id,),
                ).fetchone()["value"]
            )
            insert_at = min(position, count)
            connection.execute(
                "UPDATE list_category_order SET position = position + 1000001 "
                "WHERE list_id = ? AND position >= ?",
                (ordered_list_id, insert_at),
            )
            connection.execute(
                "UPDATE list_category_order SET position = position - 1000000 "
                "WHERE list_id = ? AND position >= ?",
                (ordered_list_id, insert_at + 1000001),
            )
            connection.execute(
                "INSERT INTO list_category_order(list_id, category_id, position) "
                "VALUES (?, ?, ?)",
                (ordered_list_id, category_id, insert_at),
            )

    def _normalize_saved_category_orders(
        self, connection: sqlite3.Connection
    ) -> None:
        """Remove gaps and stale rows from every customized list order."""
        list_ids = [
            row["list_id"]
            for row in connection.execute(
                "SELECT DISTINCT list_id FROM list_category_order"
            ).fetchall()
        ]
        for ordered_list_id in list_ids:
            rows = connection.execute(
                """
                SELECT category_order.category_id
                FROM list_category_order AS category_order
                JOIN categories ON categories.id = category_order.category_id
                JOIN lists ON lists.id = category_order.list_id
                WHERE category_order.list_id = ?
                  AND (categories.scope = 'global'
                       OR (categories.scope = 'list_type' AND categories.list_type = lists.list_type)
                       OR categories.list_id = ?)
                ORDER BY category_order.position
                """,
                (ordered_list_id, ordered_list_id),
            ).fetchall()
            category_ids = [row["category_id"] for row in rows]
            connection.execute(
                "DELETE FROM list_category_order WHERE list_id = ?",
                (ordered_list_id,),
            )
            connection.executemany(
                "INSERT INTO list_category_order(list_id, category_id, position) "
                "VALUES (?, ?, ?)",
                [
                    (ordered_list_id, saved_category_id, position)
                    for position, saved_category_id in enumerate(category_ids)
                ],
            )

    def _delete_category(self, category_id: str) -> None:
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT scope, list_type, list_id, position FROM categories WHERE id = ?", (category_id,)
            ).fetchone()
            if existing is None:
                raise CategoryNotFoundError(category_id)
            now = self._now()
            for table, key_column in (
                ("list_items", "id"),
                ("inventory_entries", "id"),
            ):
                rows = connection.execute(
                    f"SELECT {key_column} AS row_id, list_id, product_id FROM {table} "
                    "WHERE category_id = ?",
                    (category_id,),
                ).fetchall()
                for row in rows:
                    fallback_id, fallback_name = (None, None)
                    if row["product_id"]:
                        fallback_id, fallback_name = self._resolve_product_category_for_list(
                            connection, row["product_id"], row["list_id"], category_id
                        )
                    connection.execute(
                        f"UPDATE {table} SET category_id = ?, category = ?, updated_at = ? "
                        f"WHERE {key_column} = ?",
                        (fallback_id, fallback_name, now, row["row_id"]),
                    )
            metadata_rows = connection.execute(
                "SELECT list_id, match_key, product_id FROM external_item_metadata "
                "WHERE category_id = ?",
                (category_id,),
            ).fetchall()
            for row in metadata_rows:
                fallback_id, fallback_name = (None, None)
                if row["product_id"]:
                    fallback_id, fallback_name = self._resolve_product_category_for_list(
                        connection, row["product_id"], row["list_id"], category_id
                    )
                connection.execute(
                    "UPDATE external_item_metadata SET category_id = ?, category = ?, updated_at = ? "
                    "WHERE list_id = ? AND match_key = ?",
                    (fallback_id, fallback_name, now, row["list_id"], row["match_key"]),
                )
            connection.execute(
                "UPDATE inventory_groups SET category_id = NULL, category = NULL, updated_at = ? "
                "WHERE category_id = ?",
                (now, category_id),
            )
            cursor = connection.execute(
                "DELETE FROM categories WHERE id = ?", (category_id,)
            )
            if cursor.rowcount != 1:
                raise CategoryNotFoundError(category_id)
            connection.execute(
                "UPDATE categories SET position = position - 1 "
                "WHERE scope = ? AND list_type IS ? AND list_id IS ? AND position > ?",
                (existing["scope"], existing["list_type"], existing["list_id"], existing["position"]),
            )
            self._normalize_saved_category_orders(connection)

    def _get_category_order(self, list_id: str) -> list[CategoryRecord]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            list_row = connection.execute(
                "SELECT list_type, use_global_categories, use_type_categories "
                "FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            rows = connection.execute(
                """
                SELECT * FROM categories
                WHERE (scope = 'list' AND list_id = ?)
                   OR (scope = 'list_type' AND list_type = ? AND ?)
                   OR (scope = 'global' AND ?)
                ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'list_type' THEN 1 ELSE 2 END,
                         position, name COLLATE NOCASE
                """,
                (list_id, list_row["list_type"], list_row["use_type_categories"],
                 list_row["use_global_categories"]),
            ).fetchall()
            records = self._resolve_scoped_records(
                [self._category_record_from_row(row) for row in rows]
            )
            positions = {
                row["category_id"]: int(row["position"])
                for row in connection.execute(
                    "SELECT category_id, position FROM list_category_order WHERE list_id = ?",
                    (list_id,),
                ).fetchall()
            }
            if records and all(record.id in positions for record in records):
                records.sort(key=lambda record: positions[record.id])
            else:
                scope_order = {"global": 0, "list_type": 1, "list": 2}
                records.sort(key=lambda record: (
                    scope_order[record.scope], record.position, record.name.casefold()
                ))
        return records

    def _has_custom_category_order(self, list_id: str) -> bool:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            return self._has_custom_category_order_in_connection(connection, list_id)

    def _has_custom_category_order_in_connection(
        self, connection: sqlite3.Connection, list_id: str
    ) -> bool:
        eligible_ids = {record.id for record in self._get_category_order(list_id)}
        saved_ids = {
            row["category_id"] for row in connection.execute(
                "SELECT category_id FROM list_category_order WHERE list_id = ?",
                (list_id,),
            ).fetchall()
        }
        return bool(eligible_ids) and saved_ids == eligible_ids

    def _get_category_base_order(
        self, scope: str, list_id: str | None, list_type: str | None = None
    ) -> list[CategoryRecord]:
        scope, list_type, list_id = self._validate_category_scope(
            scope, list_type, list_id
        )
        with self._connect() as connection:
            if list_id is not None:
                self._require_list(connection, list_id)
            rows = connection.execute(
                "SELECT * FROM categories WHERE scope = ? AND list_type IS ? AND list_id IS ? "
                "ORDER BY position, name COLLATE NOCASE",
                (scope, list_type, list_id),
            ).fetchall()
        return [self._category_record_from_row(row) for row in rows]

    def _set_category_base_order(
        self, scope: str, list_id: str | None, category_ids: list[str],
        list_type: str | None = None,
    ) -> list[CategoryRecord]:
        scope, list_type, list_id = self._validate_category_scope(
            scope, list_type, list_id
        )
        with self._connect() as connection:
            if list_id is not None:
                self._require_list(connection, list_id)
            eligible_rows = connection.execute(
                "SELECT id FROM categories WHERE scope = ? AND list_type IS ? AND list_id IS ?",
                (scope, list_type, list_id),
            ).fetchall()
            eligible = {row["id"] for row in eligible_rows}
            ordered = list(dict.fromkeys(category_ids))
            if set(ordered) != eligible or len(ordered) != len(eligible):
                raise ValueError(
                    localized_text("backend.category_scope_order_complete")
                )
            connection.executemany(
                "UPDATE categories SET position = ? WHERE id = ?",
                [(position, category_id) for position, category_id in enumerate(ordered)],
            )
            rows = connection.execute(
                "SELECT * FROM categories WHERE scope = ? AND list_type IS ? AND list_id IS ? "
                "ORDER BY position, name COLLATE NOCASE",
                (scope, list_type, list_id),
            ).fetchall()
        return [self._category_record_from_row(row) for row in rows]

    def _set_category_order(
        self, list_id: str, category_ids: list[str]
    ) -> list[CategoryRecord]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            eligible = {record.id for record in self._get_category_order(list_id)}
            ordered = list(dict.fromkeys(category_ids))
            if set(ordered) != eligible or len(ordered) != len(eligible):
                raise ValueError(localized_text("backend.category_order_complete"))
            connection.execute("DELETE FROM list_category_order WHERE list_id = ?", (list_id,))
            connection.executemany(
                "INSERT INTO list_category_order(list_id, category_id, position) VALUES (?, ?, ?)",
                [(list_id, category_id, position) for position, category_id in enumerate(ordered)],
            )
        return self._get_category_order(list_id)

    def _reset_category_order(self, list_id: str) -> list[CategoryRecord]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            connection.execute(
                "DELETE FROM list_category_order WHERE list_id = ?", (list_id,)
            )
        return self._get_category_order(list_id)

    def _preview_list_scope_changes(
        self, list_id: str,
        use_global_categories: bool, use_type_categories: bool,
        use_global_labels: bool, use_type_labels: bool,
        use_global_chips: bool, use_type_chips: bool,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            return self._scope_change_impact(
                connection, list_id,
                use_global_categories, use_type_categories,
                use_global_labels, use_type_labels,
                use_global_chips, use_type_chips,
                apply=False,
            )

    def _scope_change_impact(
        self, connection: sqlite3.Connection, list_id: str,
        use_global_categories: bool, use_type_categories: bool,
        use_global_labels: bool, use_type_labels: bool,
        use_global_chips: bool, use_type_chips: bool,
        *, apply: bool,
    ) -> dict[str, Any]:
        """Preview or apply assignment rewrites for one list's scope switches."""
        list_row = connection.execute(
            "SELECT list_type FROM lists WHERE id = ?", (list_id,)
        ).fetchone()
        list_type = list_row["list_type"]

        def included(scope: str, scoped_type: str | None, scoped_list: str | None,
                     global_enabled: bool, type_enabled: bool) -> bool:
            return (
                (scope == "list" and scoped_list == list_id)
                or (scope == "list_type" and scoped_type == list_type and type_enabled)
                or (scope == "global" and global_enabled)
            )

        category_rows = connection.execute("SELECT * FROM categories").fetchall()
        category_records = [
            self._category_record_from_row(row) for row in category_rows
            if included(
                row["scope"], row["list_type"], row["list_id"],
                use_global_categories, use_type_categories,
            )
        ]
        category_winners = {
            record.name.casefold(): record
            for record in self._resolve_scoped_records(category_records)
        }
        category_by_id = {row["id"]: row for row in category_rows}
        category_reassigned = 0
        category_cleared = 0
        for table in ("list_items", "inventory_entries", "inventory_groups"):
            has_product = table != "inventory_groups"
            rows = connection.execute(
                f"SELECT id, category_id{', product_id' if has_product else ''} FROM {table} "
                "WHERE list_id = ? AND category_id IS NOT NULL", (list_id,)
            ).fetchall()
            for row in rows:
                source = category_by_id.get(row["category_id"])
                if source is None:
                    continue
                winner = category_winners.get(source["name"].casefold())
                if has_product and row["product_id"]:
                    product_category_id, _product_category_name = self._resolve_product_category_for_list(
                        connection,
                        row["product_id"],
                        list_id,
                        use_global_categories=use_global_categories,
                        use_type_categories=use_type_categories,
                    )
                    if product_category_id:
                        winner = next(
                            (record for record in category_records if record.id == product_category_id),
                            winner,
                        )
                if winner is not None and winner.id == row["category_id"]:
                    continue
                if winner is None:
                    category_cleared += 1
                    if apply:
                        connection.execute(
                            f"UPDATE {table} SET category_id = NULL, category = NULL, "
                            "updated_at = ? WHERE id = ?",
                            (self._now(), row["id"]),
                        )
                else:
                    category_reassigned += 1
                    if apply:
                        connection.execute(
                            f"UPDATE {table} SET category_id = ?, category = ?, "
                            "updated_at = ? WHERE id = ?",
                            (winner.id, winner.name, self._now(), row["id"]),
                        )

        metadata_categories = connection.execute(
            "SELECT match_key, category_id, product_id FROM external_item_metadata "
            "WHERE list_id = ? AND category_id IS NOT NULL", (list_id,)
        ).fetchall()
        for metadata in metadata_categories:
            source = category_by_id.get(metadata["category_id"])
            if source is None:
                continue
            winner = category_winners.get(source["name"].casefold())
            if metadata["product_id"]:
                product_category_id, _product_category_name = self._resolve_product_category_for_list(
                    connection,
                    metadata["product_id"],
                    list_id,
                    use_global_categories=use_global_categories,
                    use_type_categories=use_type_categories,
                )
                if product_category_id:
                    winner = next(
                        (record for record in category_records if record.id == product_category_id),
                        winner,
                    )
            if winner is not None and winner.id == metadata["category_id"]:
                continue
            if winner is None:
                category_cleared += 1
                if apply:
                    connection.execute(
                        "UPDATE external_item_metadata SET category_id = NULL, "
                        "category = NULL, updated_at = ? "
                        "WHERE list_id = ? AND match_key = ?",
                        (self._now(), list_id, metadata["match_key"]),
                    )
            else:
                category_reassigned += 1
                if apply:
                    connection.execute(
                        "UPDATE external_item_metadata SET category_id = ?, "
                        "category = ?, updated_at = ? "
                        "WHERE list_id = ? AND match_key = ?",
                        (winner.id, winner.name, self._now(), list_id,
                         metadata["match_key"]),
                    )

        label_rows = connection.execute("SELECT * FROM labels").fetchall()
        label_records = [
            self._label_record_from_row({**dict(row), "product_count": 0, "item_count": 0})
            for row in label_rows
            if included(
                row["scope"], row["list_type"], row["list_id"],
                use_global_labels, use_type_labels,
            )
        ]
        label_winners = {
            record.name.casefold(): record
            for record in self._resolve_scoped_records(label_records)
        }
        label_by_id = {row["id"]: row for row in label_rows}
        assignments = connection.execute(
            """
            SELECT list_item_labels.item_id, list_item_labels.label_id
            FROM list_item_labels
            JOIN list_items ON list_items.id = list_item_labels.item_id
            WHERE list_items.list_id = ?
            """, (list_id,)
        ).fetchall()
        label_reassigned = 0
        label_removed = 0
        for assignment in assignments:
            source = label_by_id.get(assignment["label_id"])
            if source is None:
                continue
            winner = label_winners.get(source["name"].casefold())
            if winner is not None and winner.id == assignment["label_id"]:
                continue
            if winner is None:
                label_removed += 1
            else:
                label_reassigned += 1
                if apply:
                    connection.execute(
                        "INSERT OR IGNORE INTO list_item_labels(item_id, label_id) "
                        "VALUES (?, ?)", (assignment["item_id"], winner.id)
                    )
            if apply:
                connection.execute(
                    "DELETE FROM list_item_labels WHERE item_id = ? AND label_id = ?",
                    (assignment["item_id"], assignment["label_id"]),
                )

        metadata_rows = connection.execute(
            "SELECT match_key, label_ids_json FROM external_item_metadata "
            "WHERE list_id = ?", (list_id,)
        ).fetchall()
        for metadata in metadata_rows:
            source_ids = json.loads(metadata["label_ids_json"] or "[]")
            next_ids: list[str] = []
            changed = False
            for label_id in source_ids:
                source = label_by_id.get(label_id)
                if source is None:
                    changed = True
                    continue
                winner = label_winners.get(source["name"].casefold())
                if winner is None:
                    label_removed += 1
                    changed = True
                    continue
                if winner.id != label_id:
                    label_reassigned += 1
                    changed = True
                if winner.id not in next_ids:
                    next_ids.append(winner.id)
            if apply and changed:
                connection.execute(
                    "UPDATE external_item_metadata SET label_ids_json = ?, updated_at = ? "
                    "WHERE list_id = ? AND match_key = ?",
                    (json.dumps(next_ids), self._now(), list_id, metadata["match_key"]),
                )

        result = {
            "category_reassigned": category_reassigned,
            "category_cleared": category_cleared,
            "label_reassigned": label_reassigned,
            "label_removed": label_removed,
            "chips_hidden": sum(
                1 for row in connection.execute("SELECT * FROM chips").fetchall()
                if (
                    (row["scope"] == "global" and not use_global_chips)
                    or (row["scope"] == "list_type" and row["list_type"] == list_type
                        and not use_type_chips)
                )
            ),
        }
        result["affected_total"] = sum(
            result[key] for key in (
                "category_reassigned", "category_cleared",
                "label_reassigned", "label_removed",
            )
        )
        return result

    def _list_labels(self, list_id: str | None = None) -> list[LabelRecord]:
        with self._connect() as connection:
            parameters: tuple[Any, ...] = ()
            where = ""
            list_row = None
            if list_id is not None:
                self._require_list(connection, list_id)
                list_row = connection.execute(
                    "SELECT list_type, use_global_labels, use_type_labels "
                    "FROM lists WHERE id = ?",
                    (list_id,),
                ).fetchone()
                clauses = []
                values: list[Any] = []
                if list_row["use_global_labels"]:
                    clauses.append("labels.scope = 'global'")
                if list_row["use_type_labels"]:
                    clauses.append("(labels.scope = 'list_type' AND labels.list_type = ?)")
                    values.append(list_row["list_type"])
                clauses.append("(labels.scope = 'list' AND labels.list_id = ?)")
                values.append(list_id)
                where = "WHERE " + " OR ".join(clauses) if clauses else "WHERE 0"
                parameters = tuple(values)
            rows = connection.execute(
                f"""
                SELECT labels.*,
                       (SELECT COUNT(*)
                        FROM product_labels
                        WHERE product_labels.label_id = labels.id) AS product_count,
                       (SELECT COUNT(*)
                        FROM list_item_labels
                        WHERE list_item_labels.label_id = labels.id) AS item_count
                FROM labels
                {where}
                ORDER BY labels.name COLLATE NOCASE
                """,
                parameters,
            ).fetchall()
            records = [self._label_record_from_row(row) for row in rows]
            if list_row is not None:
                records = self._resolve_scoped_records(records)
        return records

    def _create_label(
        self, name: str, icon: str | None, color: str | None,
        scope: str, list_type: str | None, list_id: str | None,
    ) -> LabelRecord:
        scope, list_type, list_id = self._validate_label_scope(
            scope, list_type, list_id
        )
        now = self._now()
        record = LabelRecord(
            id=str(uuid4()),
            name=name,
            icon=icon,
            color=color,
            scope=scope,
            list_type=list_type,
            list_id=list_id,
            created_at=now,
            updated_at=now,
        )
        try:
            with self._connect() as connection:
                if scope == "list":
                    self._require_list(connection, list_id)
                connection.execute(
                    """
                    INSERT INTO labels(
                        id, name, icon, color, scope, list_type, list_id,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.name,
                        record.icon,
                        record.color,
                        record.scope,
                        record.list_type,
                        record.list_id,
                        record.created_at,
                        record.updated_at,
                    ),
                )
        except sqlite3.IntegrityError as error:
            if "labels" in str(error):
                raise DuplicateLabelError(name) from error
            raise
        return record

    def _update_label(
        self, label_id: str, name: str, icon: str | None, color: str | None,
        scope: str, list_type: str | None, list_id: str | None,
    ) -> LabelRecord:
        scope, list_type, list_id = self._validate_label_scope(
            scope, list_type, list_id
        )
        try:
            with self._connect() as connection:
                if scope == "list":
                    self._require_list(connection, list_id)
                cursor = connection.execute(
                    """
                    UPDATE labels
                    SET name = ?, icon = ?, color = ?, scope = ?, list_type = ?,
                        list_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (name, icon, color, scope, list_type, list_id, self._now(), label_id),
                )
                if cursor.rowcount != 1:
                    raise LabelNotFoundError(label_id)
                row = connection.execute(
                    "SELECT labels.*, 0 AS product_count, 0 AS item_count "
                    "FROM labels WHERE id = ?", (label_id,)
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "labels" in str(error):
                raise DuplicateLabelError(name) from error
            raise
        return self._label_record_from_row(row)

    def _delete_label(self, label_id: str) -> None:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM labels WHERE id = ?", (label_id,))
            if cursor.rowcount != 1:
                raise LabelNotFoundError(label_id)

    def _list_chips(self, list_id: str | None = None) -> list[ChipRecord]:
        with self._connect() as connection:
            parameters: tuple[Any, ...] = ()
            where = ""
            if list_id is not None:
                self._require_list(connection, list_id)
                list_row = connection.execute(
                    "SELECT list_type, use_global_chips, use_type_chips "
                    "FROM lists WHERE id = ?", (list_id,)
                ).fetchone()
                expected_kind = "todo_template" if list_row["list_type"] == "todo" else "entry"
                clauses = ["(chips.scope = 'list' AND chips.list_id = ?)"]
                values: list[Any] = [list_id]
                if list_row["use_type_chips"]:
                    clauses.append("(chips.scope = 'list_type' AND chips.list_type = ?)")
                    values.append(list_row["list_type"])
                if list_row["use_global_chips"] and list_row["list_type"] != "todo":
                    clauses.append("chips.scope = 'global'")
                where = "WHERE chips.chip_kind = ? AND (" + " OR ".join(clauses) + ")"
                parameters = (expected_kind, *values)
            rows = connection.execute(
                f"""
                SELECT chips.*, products.name AS product_name
                FROM chips
                LEFT JOIN products ON products.id = chips.product_id
                {where}
                ORDER BY chips.name COLLATE NOCASE
                """,
                parameters,
            ).fetchall()
            records = [self._chip_record_from_row(row) for row in rows]
        if list_id is None:
            return records
        return self._resolve_scoped_records(records, key_attribute="priority_name")

    def _create_chip(
        self, name: str, color: str | None, scope: str,
        list_type: str | None, list_id: str | None, product_id: str | None,
        chip_kind: str = "entry", icon: str | None = None,
        template_data: dict[str, Any] | None = None,
    ) -> ChipRecord:
        scope, list_type, list_id = self._validate_chip_scope(
            scope, list_type, list_id
        )
        now = self._now()
        chip_id = str(uuid4())
        try:
            with self._connect() as connection:
                self._validate_chip_target(
                    connection, chip_kind, scope, list_type, list_id, product_id
                )
                template_data = self._validate_todo_template_data(
                    chip_kind, template_data, name
                )
                if product_id is not None:
                    self._require_product(connection, product_id)
                connection.execute(
                    """
                    INSERT INTO chips(
                        id, name, priority_name, chip_kind, icon, color, scope,
                        list_type, list_id, product_id, template_json,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (chip_id, name, self._normalize_priority_name(name), chip_kind,
                     icon, color, scope, list_type, list_id, product_id,
                     json.dumps(template_data) if template_data is not None else None,
                     now, now),
                )
                row = connection.execute(
                    "SELECT chips.*, products.name AS product_name FROM chips "
                    "LEFT JOIN products ON products.id = chips.product_id "
                    "WHERE chips.id = ?", (chip_id,),
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "chips" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateChipError(name) from error
            raise
        return self._chip_record_from_row(row)

    def _update_chip(
        self, chip_id: str, name: str, color: str | None, scope: str,
        list_type: str | None, list_id: str | None, product_id: str | None,
        replace_existing: bool = False, chip_kind: str = "entry",
        icon: str | None = None, template_data: dict[str, Any] | None = None,
    ) -> ChipRecord:
        scope, list_type, list_id = self._validate_chip_scope(
            scope, list_type, list_id
        )
        try:
            with self._connect() as connection:
                existing = connection.execute(
                    "SELECT chip_kind FROM chips WHERE id = ?", (chip_id,)
                ).fetchone()
                if existing is None:
                    raise ChipNotFoundError(chip_id)
                if existing["chip_kind"] != chip_kind:
                    raise ValueError(localized_text("backend.chip_type_immutable"))
                self._validate_chip_target(
                    connection, chip_kind, scope, list_type, list_id, product_id
                )
                template_data = self._validate_todo_template_data(
                    chip_kind, template_data, name
                )
                if product_id is not None:
                    self._require_product(connection, product_id)
                priority_name = self._normalize_priority_name(name)
                conflict = self._find_chip_conflict(
                    connection, priority_name, scope, list_type, list_id, chip_id
                )
                if conflict is not None:
                    if not replace_existing:
                        raise DuplicateChipError(name)
                    connection.execute("DELETE FROM chips WHERE id = ?", (conflict["id"],))
                cursor = connection.execute(
                    """
                    UPDATE chips
                    SET name = ?, priority_name = ?, icon = ?, color = ?, scope = ?,
                        list_type = ?, list_id = ?, product_id = ?, template_json = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (name, priority_name, icon, color, scope, list_type, list_id,
                     product_id, json.dumps(template_data) if template_data is not None else None,
                     self._now(), chip_id),
                )
                if cursor.rowcount != 1:
                    raise ChipNotFoundError(chip_id)
                row = connection.execute(
                    "SELECT chips.*, products.name AS product_name FROM chips "
                    "LEFT JOIN products ON products.id = chips.product_id "
                    "WHERE chips.id = ?", (chip_id,),
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "chips" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateChipError(name) from error
            raise
        return self._chip_record_from_row(row)

    def _delete_chip(self, chip_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM important_chip_assignments "
                "WHERE target_type = 'chip' AND target_id = ?",
                (chip_id,),
            )
            cursor = connection.execute("DELETE FROM chips WHERE id = ?", (chip_id,))
            if cursor.rowcount != 1:
                raise ChipNotFoundError(chip_id)

    @staticmethod
    def _normalize_dish_name(name: str) -> str:
        return re.sub(r"\s+", " ", name.strip()).casefold()

    @staticmethod
    def _dish_items_for(
        connection: sqlite3.Connection, dish_id: str
    ) -> tuple[DishItemRecord, ...]:
        rows = connection.execute(
            """
            SELECT dish_items.*, products.name AS product_name,
                   products.brand AS product_brand,
                   products.package_quantity AS product_package_quantity,
                   products.ean AS product_ean
            FROM dish_items
            LEFT JOIN products ON products.id = dish_items.product_id
            WHERE dish_items.dish_id = ?
            ORDER BY dish_items.position, dish_items.id
            """,
            (dish_id,),
        ).fetchall()
        return tuple(
            DishItemRecord(
                id=row["id"], dish_id=row["dish_id"], name=row["name"],
                product_id=row["product_id"], product_name=row["product_name"],
                product_brand=row["product_brand"],
                product_package_quantity=row["product_package_quantity"],
                product_ean=row["product_ean"],
                quantity=int(row["quantity"]), position=int(row["position"]),
            )
            for row in rows
        )

    @classmethod
    def _dish_record_from_row(
        cls, connection: sqlite3.Connection, row: sqlite3.Row
    ) -> DishRecord:
        return DishRecord(
            id=row["id"], name=row["name"], normalized_name=row["normalized_name"],
            color=row["color"], created_at=row["created_at"],
            updated_at=row["updated_at"],
            items=cls._dish_items_for(connection, row["id"]),
        )

    def _prepare_dish_items(
        self, connection: sqlite3.Connection, items: list[dict[str, Any]]
    ) -> list[tuple[str, str | None, int, int]]:
        if not isinstance(items, list) or not items:
            raise ValueError(localized_text("backend.dish_needs_ingredient"))
        if len(items) > 200:
            raise ValueError(localized_text("backend.dish_ingredient_limit"))
        prepared: list[tuple[str, str | None, int, int]] = []
        seen: set[tuple[str, str]] = set()
        for position, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(localized_text("backend.ingredient_invalid"))
            product_id = item.get("product_id") or None
            product_name: str | None = None
            if product_id is not None:
                product = connection.execute(
                    "SELECT name FROM products WHERE id = ?", (str(product_id),)
                ).fetchone()
                if product is None:
                    raise ProductNotFoundError(str(product_id))
                product_id = str(product_id)
                product_name = product["name"]
            name = re.sub(r"\s+", " ", str(item.get("name") or product_name or "").strip())
            if not name:
                raise ValueError(localized_text("backend.ingredient_name_required"))
            if len(name) > 200:
                raise ValueError(localized_text("backend.ingredient_name_limit"))
            try:
                quantity = int(item.get("quantity", 1))
            except (TypeError, ValueError) as error:
                raise ValueError(localized_text("backend.ingredient_quantity_integer")) from error
            if quantity < 1 or quantity > 1000000:
                raise ValueError(localized_text("backend.quantity_range"))
            key = ("product", product_id) if product_id else (
                "name", self._normalize_dish_name(name)
            )
            if key in seen:
                raise ValueError(localized_text("backend.duplicate_ingredient", name=name))
            seen.add(key)
            prepared.append((name, product_id, quantity, position))
        return prepared

    def _list_dishes(self, list_id: str | None = None) -> list[DishRecord]:
        with self._connect() as connection:
            if list_id is not None:
                target = connection.execute(
                    "SELECT list_type, provider, use_dishes FROM lists WHERE id = ?",
                    (list_id,),
                ).fetchone()
                if target is None:
                    raise ListNotFoundError(list_id)
                if (target["list_type"] != "shopping" or target["provider"] != "local"
                        or not target["use_dishes"]):
                    return []
            rows = connection.execute(
                "SELECT * FROM dishes ORDER BY name COLLATE NOCASE, id"
            ).fetchall()
            return [self._dish_record_from_row(connection, row) for row in rows]

    def _create_dish(
        self, name: str, color: str | None, items: list[dict[str, Any]]
    ) -> DishRecord:
        name = re.sub(r"\s+", " ", name.strip())
        if not name or len(name) > 100:
            raise ValueError(localized_text("backend.name_length"))
        now = self._now()
        dish_id = str(uuid4())
        try:
            with self._connect() as connection:
                prepared = self._prepare_dish_items(connection, items)
                connection.execute(
                    "INSERT INTO dishes(id, name, normalized_name, color, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (dish_id, name, self._normalize_dish_name(name), color, now, now),
                )
                connection.executemany(
                    "INSERT INTO dish_items(id, dish_id, name, product_id, quantity, position) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    [(str(uuid4()), dish_id, item_name, product_id, quantity, position)
                     for item_name, product_id, quantity, position in prepared],
                )
                row = connection.execute(
                    "SELECT * FROM dishes WHERE id = ?", (dish_id,)
                ).fetchone()
                return self._dish_record_from_row(connection, row)
        except sqlite3.IntegrityError as error:
            if "dishes" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateDishError(name) from error
            raise

    def _update_dish(
        self, dish_id: str, name: str, color: str | None,
        items: list[dict[str, Any]],
    ) -> DishRecord:
        name = re.sub(r"\s+", " ", name.strip())
        if not name or len(name) > 100:
            raise ValueError(localized_text("backend.name_length"))
        try:
            with self._connect() as connection:
                if connection.execute(
                    "SELECT 1 FROM dishes WHERE id = ?", (dish_id,)
                ).fetchone() is None:
                    raise DishNotFoundError(dish_id)
                prepared = self._prepare_dish_items(connection, items)
                connection.execute(
                    "UPDATE dishes SET name = ?, normalized_name = ?, color = ?, updated_at = ? "
                    "WHERE id = ?",
                    (name, self._normalize_dish_name(name), color, self._now(), dish_id),
                )
                connection.execute("DELETE FROM dish_items WHERE dish_id = ?", (dish_id,))
                connection.executemany(
                    "INSERT INTO dish_items(id, dish_id, name, product_id, quantity, position) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    [(str(uuid4()), dish_id, item_name, product_id, quantity, position)
                     for item_name, product_id, quantity, position in prepared],
                )
                row = connection.execute(
                    "SELECT * FROM dishes WHERE id = ?", (dish_id,)
                ).fetchone()
                return self._dish_record_from_row(connection, row)
        except sqlite3.IntegrityError as error:
            if "dishes" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateDishError(name) from error
            raise

    def _delete_dish(self, dish_id: str) -> None:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM dishes WHERE id = ?", (dish_id,))
            if cursor.rowcount != 1:
                raise DishNotFoundError(dish_id)

    def _add_dish_to_list(
        self, dish_id: str, list_id: str,
        selected_items: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            target = connection.execute(
                "SELECT * FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if target is None:
                raise ListNotFoundError(list_id)
            if (target["list_type"] != "shopping" or target["provider"] != "local"
                    or not target["use_dishes"]):
                raise DishesDisabledError(list_id)
            dish_row = connection.execute(
                "SELECT * FROM dishes WHERE id = ?", (dish_id,)
            ).fetchone()
            if dish_row is None:
                raise DishNotFoundError(dish_id)
            dish_items = {item.id: item for item in self._dish_items_for(connection, dish_id)}
            chosen: list[tuple[DishItemRecord, int, object, object]] = []
            if selected_items is None:
                chosen = [(item, item.quantity, _UNSET, _UNSET) for item in dish_items.values()]
            else:
                seen_ids: set[str] = set()
                for selection in selected_items:
                    item_id = str(selection.get("item_id", ""))
                    if item_id not in dish_items or item_id in seen_ids:
                        raise ValueError(localized_text("backend.ingredient_selection_invalid"))
                    seen_ids.add(item_id)
                    try:
                        quantity = int(selection.get("quantity", dish_items[item_id].quantity))
                    except (TypeError, ValueError) as error:
                        raise ValueError(localized_text("backend.quantity_integer")) from error
                    if quantity < 1 or quantity > 1000000:
                        raise ValueError(localized_text("backend.quantity_range"))
                    category_override: object = _UNSET
                    category_name_override: object = _UNSET
                    if "category_id" in selection:
                        value = selection.get("category_id")
                        category_override = str(value) if value else None
                    if "category" in selection:
                        value = selection.get("category")
                        category_name_override = str(value).strip() if value else None
                    chosen.append((dish_items[item_id], quantity, category_override, category_name_override))
            now = self._now()
            created = updated = 0
            for item, quantity, category_override, category_name_override in chosen:
                product = None
                if item.product_id:
                    product = connection.execute(
                        "SELECT id, name FROM products WHERE id = ?", (item.product_id,)
                    ).fetchone()
                product_id = product["id"] if product else None
                item_name = product["name"] if product else item.name
                if product_id:
                    existing = connection.execute(
                        "SELECT * FROM list_items WHERE list_id = ? AND product_id = ? "
                        "ORDER BY completed, position LIMIT 1", (list_id, product_id)
                    ).fetchone()
                else:
                    existing = connection.execute(
                        "SELECT * FROM list_items WHERE list_id = ? AND product_id IS NULL "
                        "AND lower(trim(name)) = lower(trim(?)) ORDER BY completed, position LIMIT 1",
                        (list_id, item_name),
                    ).fetchone()
                if existing:
                    connection.execute(
                        "UPDATE list_items SET quantity = quantity + ?, completed = 0, updated_at = ? "
                        "WHERE id = ?", (quantity, now, existing["id"]),
                    )
                    updated += 1
                    continue
                if category_override is not _UNSET or category_name_override is not _UNSET:
                    category_id, category = self._resolve_item_category(
                        connection, list_id,
                        None if category_override is _UNSET else category_override,
                        None if category_name_override is _UNSET else category_name_override,
                    )
                else:
                    category_id = category = None
                    if product_id:
                        category_id, category = self._resolve_product_category_for_list(
                            connection, product_id, list_id
                        )
                    if category_id is None and category is None:
                        category_id, category = self._resolve_category_rule_for_list(
                            connection, list_id, item_name
                        )
                    category_id, category = self._resolve_item_category(
                        connection, list_id, category_id, category
                    )
                position = int(connection.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS value FROM list_items WHERE list_id = ?",
                    (list_id,),
                ).fetchone()["value"])
                list_item_id = str(uuid4())
                connection.execute(
                    """INSERT INTO list_items(
                        id, list_id, product_id, external_uid, name, description, quantity,
                        category_id, category, due_at, recurrence_interval, recurrence_unit,
                        completed, position, created_at, updated_at
                    ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)""",
                    (list_item_id, list_id, product_id, item_name, quantity,
                     category_id, category, position, now, now),
                )
                if product_id:
                    labels = self._labels_for(
                        connection, "product_labels", "product_id", product_id, list_id
                    )
                    connection.executemany(
                        "INSERT OR IGNORE INTO list_item_labels(item_id, label_id) VALUES (?, ?)",
                        [(list_item_id, label.id) for label in labels],
                    )
                created += 1
            return {
                "dish": self._dish_record_from_row(connection, dish_row).as_dict(),
                "created": created, "updated": updated,
            }

    def _list_important_chip_assignments(
        self, list_id: str
    ) -> list[dict[str, str]]:
        with self._connect() as connection:
            self._require_list(connection, list_id)
            rows = connection.execute(
                """
                SELECT target_type, target_id
                FROM important_chip_assignments AS assignments
                WHERE list_id = ? AND (
                    (target_type = 'chip' AND EXISTS (
                        SELECT 1 FROM chips WHERE chips.id = assignments.target_id
                    )) OR
                    (target_type = 'product' AND EXISTS (
                        SELECT 1 FROM products WHERE products.id = assignments.target_id
                    ))
                )
                ORDER BY created_at, target_type, target_id
                """,
                (list_id,),
            ).fetchall()
        return [
            {"target_type": row["target_type"], "target_id": row["target_id"]}
            for row in rows
        ]

    def _set_important_chip_assignment(
        self, list_id: str, target_type: str, target_id: str, important: bool
    ) -> None:
        if target_type not in {"chip", "product"}:
            raise ValueError(localized_text("backend.important_chip_target_invalid"))
        with self._connect() as connection:
            self._require_list(connection, list_id)
            list_row = connection.execute(
                "SELECT list_type FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            table = "chips" if target_type == "chip" else "products"
            target_row = connection.execute(
                f"SELECT * FROM {table} WHERE id = ?", (target_id,)
            ).fetchone()
            if target_row is None:
                if target_type == "chip":
                    raise ChipNotFoundError(target_id)
                raise ProductNotFoundError(target_id)
            if target_type == "chip":
                expected_kind = "todo_template" if list_row["list_type"] == "todo" else "entry"
                if target_row["chip_kind"] != expected_kind:
                    raise ValueError(localized_text("backend.chip_list_type_mismatch"))
            if important:
                connection.execute(
                    "INSERT OR IGNORE INTO important_chip_assignments("
                    "list_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)",
                    (list_id, target_type, target_id, self._now()),
                )
            else:
                connection.execute(
                    "DELETE FROM important_chip_assignments "
                    "WHERE list_id = ? AND target_type = ? AND target_id = ?",
                    (list_id, target_type, target_id),
                )

    @staticmethod
    def _normalize_priority_name(name: str) -> str:
        """Normalize a visible chip name without changing what the user sees."""
        return " ".join(name.split()).casefold()

    @staticmethod
    def _find_chip_conflict(
        connection: sqlite3.Connection, priority_name: str, scope: str,
        list_type: str | None, list_id: str | None, exclude_id: str,
    ) -> sqlite3.Row | None:
        if scope == "global":
            return connection.execute(
                "SELECT id FROM chips WHERE scope = 'global' AND priority_name = ? AND id != ?",
                (priority_name, exclude_id),
            ).fetchone()
        if scope == "list_type":
            return connection.execute(
                "SELECT id FROM chips WHERE scope = 'list_type' AND list_type = ? AND priority_name = ? AND id != ?",
                (list_type, priority_name, exclude_id),
            ).fetchone()
        return connection.execute(
            "SELECT id FROM chips WHERE scope = 'list' AND list_id = ? AND priority_name = ? AND id != ?",
            (list_id, priority_name, exclude_id),
        ).fetchone()

    def _list_inventory_lists(self) -> list[ListRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, name, list_type, provider, external_entity_id,
                       icon, label_conflict_policy, use_global_categories,
                       use_type_categories, use_global_labels, use_type_labels,
                       use_list_labels, use_global_chips, use_type_chips, use_dishes,
                       use_tandoor, tandoor_skip_small_units,
                       tandoor_include_ingredients, tandoor_excluded_units,
                       tandoor_result_limit, capitalize_first_letter,
                       auto_delete_completed, auto_delete_delay_minutes, auto_delete_confirm,
                       enabled,
                       created_at, updated_at
                FROM lists
                WHERE list_type = 'inventory' AND enabled = 1
                ORDER BY name COLLATE NOCASE
                """
            ).fetchall()
        return [self._record_from_row(row) for row in rows]

    def _list_inventory(self, list_id: str) -> list[InventoryRecord]:
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            rows = connection.execute(
                f"{self._inventory_select()} WHERE inventory_entries.list_id = ? "
                "ORDER BY inventory_entries.position, products.name COLLATE NOCASE",
                (list_id,),
            ).fetchall()
            records = [self._inventory_record_from_row(connection, row) for row in rows]
        return records

    def _create_inventory_entry(
        self,
        list_id: str,
        product_id: str,
        stock: int,
        minimum_stock: int | None,
        category_id: str | None,
        category: str | None,
        hidden: bool,
        restock_quantity: int = 1,
        restock_mode: str | None = None,
    ) -> InventoryRecord:
        self._validate_stock(stock, minimum_stock)
        self._validate_restock_quantity(restock_quantity)
        restock_mode = None if restock_mode == "inherit" else restock_mode
        self._validate_restock_mode(restock_mode)
        self._validate_fixed_restock_threshold(restock_mode, minimum_stock)
        now = self._now()
        entry_id = str(uuid4())
        try:
            with self._connect() as connection:
                self._require_inventory_list(connection, list_id)
                product_row = connection.execute(
                    "SELECT name FROM products WHERE id = ?", (product_id,)
                ).fetchone()
                if product_row is None:
                    raise ProductNotFoundError(product_id)
                if category_id is None and category is None:
                    category_id, category = self._resolve_product_category_for_list(
                        connection, product_id, list_id
                    )
                if category_id is None and category is None:
                    category_id, category = self._resolve_category_rule_for_list(
                        connection, list_id, product_row["name"]
                    )
                category_id, category = self._resolve_item_category(
                    connection, list_id, category_id, category
                )
                next_position = connection.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS value "
                    "FROM inventory_entries WHERE list_id = ?",
                    (list_id,),
                ).fetchone()["value"]
                undo_before = self._inventory_booking_snapshot(connection, entry_id, list_id)
                connection.execute(
                    """
                    INSERT INTO inventory_entries(
                        id, list_id, product_id, stock, minimum_stock, restock_quantity, restock_mode,
                        category_id, category, hidden, position, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry_id,
                        list_id,
                        product_id,
                        stock,
                        minimum_stock,
                        restock_quantity,
                        restock_mode,
                        category_id,
                        category,
                        int(hidden),
                        int(next_position),
                        now,
                        now,
                    ),
                )
                undo_token = self._remember_inventory_booking(connection, entry_id, list_id, undo_before)
                row = connection.execute(
                    f"{self._inventory_select()} WHERE inventory_entries.id = ?",
                    (entry_id,),
                ).fetchone()
                labels = self._labels_for(
                    connection, "product_labels", "product_id", product_id, list_id
                )
                category_assignments = self._product_category_assignments(
                    connection, product_id
                )
        except sqlite3.IntegrityError as error:
            if "inventory_entries.list_id" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateInventoryProductError(product_id) from error
            raise
        return replace(self._inventory_record_from_row_data(
            row, labels, category_assignments
        ), undo_token=undo_token)

    def _update_inventory_entry(
        self,
        entry_id: str,
        stock: int,
        minimum_stock: int | None,
        category_id: str | None,
        category: str | None,
        hidden: bool,
        restock_quantity: int | None = None,
        restock_mode: str | None = None,
        label_ids: list[str] | None = None,
    ) -> InventoryRecord:
        self._validate_stock(stock, minimum_stock)
        with self._connect() as connection:
            existing = connection.execute(
                """SELECT inventory_entries.list_id, inventory_entries.product_id,
                          inventory_entries.stock,
                          inventory_entries.restock_quantity, inventory_entries.restock_mode,
                          inventory_group_members.group_id
                   FROM inventory_entries
                   LEFT JOIN inventory_group_members ON
                       inventory_group_members.inventory_entry_id = inventory_entries.id
                   WHERE inventory_entries.id = ?""", (entry_id,)
            ).fetchone()
            if existing is None:
                raise InventoryEntryNotFoundError(entry_id)
            if restock_quantity is None:
                restock_quantity = int(existing["restock_quantity"])
            self._validate_restock_quantity(restock_quantity)
            if restock_mode is None:
                restock_mode = existing["restock_mode"]
            elif restock_mode == "inherit":
                restock_mode = None
            self._validate_restock_mode(restock_mode)
            self._validate_fixed_restock_threshold(restock_mode, minimum_stock)
            category_id, category = self._resolve_item_category(
                connection, existing["list_id"], category_id, category
            )
            undo_before = self._inventory_booking_snapshot(connection, entry_id, existing["list_id"])
            cursor = connection.execute(
                """
                UPDATE inventory_entries
                SET stock = ?, minimum_stock = ?, restock_quantity = ?, restock_mode = ?, category_id = ?, category = ?, hidden = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (stock, minimum_stock, restock_quantity, restock_mode, category_id, category, int(hidden), self._now(), entry_id),
            )
            if cursor.rowcount != 1:
                raise InventoryEntryNotFoundError(entry_id)
            if label_ids is not None:
                # Validate before resolving scope: an unknown ID must reject
                # the complete stock correction rather than disappear silently.
                self._validate_label_ids(connection, label_ids)
                scoped_labels = self._list_context_label_ids(
                    connection, "product_labels", "product_id", existing["product_id"],
                    label_ids, existing["list_id"],
                )
                self._replace_labels(
                    connection, "product_labels", "product_id", existing["product_id"],
                    scoped_labels,
                )
                connection.execute(
                    "UPDATE products SET updated_at = ? WHERE id = ?",
                    (self._now(), existing["product_id"]),
                )
            if int(existing["stock"]) != stock:
                connection.execute(
                    "DELETE FROM inventory_restock_state WHERE list_id = ? AND ((source_type = 'entry' AND source_id = ?) OR (source_type = 'group' AND source_id = ?))",
                    (existing["list_id"], entry_id, existing["group_id"]),
                )
            row = connection.execute(
                f"{self._inventory_select()} WHERE inventory_entries.id = ?",
                (entry_id,),
            ).fetchone()
            undo_token = self._remember_inventory_booking(connection, entry_id, existing["list_id"], undo_before)
            return replace(self._inventory_record_from_row(connection, row), undo_token=undo_token)

    def _set_inventory_hidden(
        self, entry_id: str, hidden: bool
    ) -> InventoryRecord:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE inventory_entries SET hidden = ?, updated_at = ? WHERE id = ?",
                (int(hidden), self._now(), entry_id),
            )
            if cursor.rowcount != 1:
                raise InventoryEntryNotFoundError(entry_id)
            row = connection.execute(
                f"{self._inventory_select()} WHERE inventory_entries.id = ?",
                (entry_id,),
            ).fetchone()
            return self._inventory_record_from_row(connection, row)

    def _adjust_inventory_entry(self, entry_id: str, delta: int) -> InventoryRecord:
        if delta == 0 or abs(delta) > 1000000:
            raise ValueError(localized_text("backend.stock_delta_range"))
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE inventory_entries
                SET stock = MAX(0, stock + ?), updated_at = ?
                WHERE id = ?
                """,
                (delta, self._now(), entry_id),
            )
            if cursor.rowcount != 1:
                raise InventoryEntryNotFoundError(entry_id)
            row = connection.execute(
                f"{self._inventory_select()} WHERE inventory_entries.id = ?",
                (entry_id,),
            ).fetchone()
            return self._inventory_record_from_row(connection, row)

    def _get_inventory_restock_settings(
        self, list_id: str
    ) -> InventoryRestockSettingsRecord:
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            row = connection.execute(
                "SELECT * FROM inventory_restock_settings WHERE list_id = ?",
                (list_id,),
            ).fetchone()
        if row is None:
            return InventoryRestockSettingsRecord(
                list_id=list_id, target_list_id=None, enabled=False,
                mode=None, fixed_quantity=None, updated_at="",
            )
        return InventoryRestockSettingsRecord(
            list_id=row["list_id"], target_list_id=row["target_list_id"],
            enabled=bool(row["enabled"]), mode=row["default_mode"],
            fixed_quantity=(int(row["default_restock_quantity"])
                            if row["default_restock_quantity"] is not None else None),
            updated_at=row["updated_at"],
        )

    def _set_inventory_restock_settings(
        self, list_id: str, target_list_id: str | None, enabled: bool,
        mode: str | None, fixed_quantity: int | None,
    ) -> InventoryRestockSettingsRecord:
        if mode not in {None, "continuous", "fixed", "one_to_one"}:
            raise ValueError(localized_text("backend.restock_mode_invalid"))
        if fixed_quantity is not None and (
            isinstance(fixed_quantity, bool) or not 1 <= fixed_quantity <= 1000000
        ):
            raise ValueError(localized_text("backend.default_quantity_minimum"))
        if enabled and not target_list_id:
            raise ValueError(localized_text("backend.select_shopping_target"))
        now = self._now()
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            if target_list_id:
                target = connection.execute(
                    "SELECT list_type, provider FROM lists WHERE id = ? AND enabled = 1",
                    (target_list_id,),
                ).fetchone()
                if target is None or target["list_type"] != "shopping" or target["provider"] != "local":
                    raise ValueError(localized_text("backend.local_shopping_target_required"))
                if target_list_id == list_id:
                    raise ValueError(localized_text("backend.inventory_target_identical"))
            connection.execute(
                """INSERT INTO inventory_restock_settings(
                       list_id, target_list_id, enabled,
                       default_mode, default_restock_quantity, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(list_id) DO UPDATE SET
                       target_list_id=excluded.target_list_id,
                       enabled=excluded.enabled, default_mode=excluded.default_mode,
                       default_restock_quantity=excluded.default_restock_quantity,
                       updated_at=excluded.updated_at""",
                (list_id, target_list_id, int(enabled), mode, fixed_quantity, now),
            )
        return self._get_inventory_restock_settings(list_id)

    async def async_undo_inventory_booking(self, token: str, include_transfer: bool = False) -> dict[str, Any]:
        """Undo one short-lived booking under the same lock as other inventory writes."""
        return await self._async_run(self._undo_inventory_booking, token, include_transfer)

    def _inventory_booking_snapshot(self, connection, entry_id, list_id):
        def rows(sql, args):
            return [dict(row) for row in connection.execute(sql, args)]
        entry = rows("SELECT * FROM inventory_entries WHERE id = ?", (entry_id,))
        group = rows("SELECT g.* FROM inventory_groups g JOIN inventory_group_members m ON m.group_id=g.id WHERE m.inventory_entry_id=?", (entry_id,))
        source_type, source_id = ("group", group[0]["id"]) if group else ("entry", entry_id)
        members = rows("SELECT e.* FROM inventory_entries e JOIN inventory_group_members m ON m.inventory_entry_id=e.id WHERE m.group_id=? ORDER BY e.id", (source_id,)) if group else entry
        key = (list_id, source_type, source_id)
        shopping = []
        if entry:
            source = self._restock_source(connection, entry_id)
            settings = self._restock_settings_row(connection, list_id)
            if settings and settings["target_list_id"]:
                shopping = rows("SELECT * FROM list_items WHERE list_id=? AND completed=0 AND name=? COLLATE NOCASE ORDER BY position LIMIT 1", (settings["target_list_id"], source["name"]))
        return {"entry": entry, "group": group, "members": members, "key": key,
                "state": rows("SELECT * FROM inventory_restock_state WHERE list_id=? AND source_type=? AND source_id=?", key),
                "history": rows("SELECT * FROM inventory_restock_transfers WHERE list_id=? AND source_type=? AND source_id=? ORDER BY origin", key),
                "shopping": shopping}

    def _remember_inventory_booking(self, connection, entry_id, list_id, before, transfer=None):
        after = self._inventory_booking_snapshot(connection, entry_id, list_id)
        if before["entry"] and before["entry"][0]["stock"] == after["entry"][0]["stock"]:
            return None
        # Tokens are deliberately short-lived and disappear on restart. Never accept
        # a client-supplied stock snapshot as authority for an undo.
        bookings = getattr(self, "_inventory_bookings", {})
        now = time.monotonic()
        bookings = {key: value for key, value in bookings.items() if value["expires"] > now}
        if len(bookings) >= 100:
            bookings.pop(next(iter(bookings)))
        token = str(uuid4())
        bookings[token] = {"expires": now + 60, "entry_id": entry_id, "list_id": list_id,
                           "before": before, "after": after, "transfer": transfer}
        self._inventory_bookings = bookings
        return token

    def _undo_inventory_booking(self, token, include_transfer=False):
        booking = getattr(self, "_inventory_bookings", {}).get(token)
        if not booking or booking["expires"] <= time.monotonic():
            raise ValueError(localized_text("backend.inventory_undo_expired"))
        before, after = booking["before"], booking["after"]
        with self._connect() as connection:
            current = self._inventory_booking_snapshot(connection, booking["entry_id"], booking["list_id"])
            if any(current[key] != after[key] for key in ("entry", "group", "members", "key", "state", "history")):
                raise ValueError(localized_text("backend.undo_item_changed"))
            transfer = booking["transfer"]
            if transfer and include_transfer:
                row = connection.execute("SELECT * FROM list_items WHERE id=?", (transfer["item_id"],)).fetchone()
                expected = after["shopping"]
                if not row or not expected or dict(row) != expected[0]:
                    raise ValueError(localized_text("backend.undo_stock_only"))
                if before["shopping"]:
                    original = before["shopping"][0]
                    columns = [key for key in original if key != "id"]
                    connection.execute("UPDATE list_items SET " + ", ".join(key + "=?" for key in columns) + " WHERE id=?", [original[key] for key in columns] + [original["id"]])
                else:
                    connection.execute("DELETE FROM list_items WHERE id=?", (transfer["item_id"],))
            if before["entry"]:
                connection.execute("UPDATE inventory_entries SET stock=?, updated_at=? WHERE id=?", (before["entry"][0]["stock"], self._now(), booking["entry_id"]))
            else:
                connection.execute("DELETE FROM inventory_entries WHERE id=?", (booking["entry_id"],))
            if not transfer or include_transfer:
                for table, field in (("inventory_restock_state", "state"), ("inventory_restock_transfers", "history")):
                    connection.execute(f"DELETE FROM {table} WHERE list_id=? AND source_type=? AND source_id=?", after["key"])
                    for original in before[field]:
                        columns = list(original)
                        connection.execute(f"INSERT INTO {table} (" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")", [original[key] for key in columns])
            row = connection.execute(f"{self._inventory_select()} WHERE inventory_entries.id=?", (booking["entry_id"],)).fetchone()
            result = {"entry": self._inventory_record_from_row(connection, row).as_dict() if row else None,
                      "list_id": booking["list_id"], "target_list_id": transfer["target_list_id"] if transfer and include_transfer else None,
                      "transfer_kept": bool(transfer and not include_transfer)}
        self._inventory_bookings.pop(token, None)
        return result

    @staticmethod
    def _restock_settings_row(
        connection: sqlite3.Connection, list_id: str
    ) -> sqlite3.Row | None:
        return connection.execute(
            "SELECT * FROM inventory_restock_settings WHERE list_id = ?",
            (list_id,),
        ).fetchone()

    @staticmethod
    def _effective_restock_mode(
        settings: sqlite3.Row | None, source: dict[str, Any]
    ) -> str | None:
        """Resolve a source override before the optional list default."""
        if source.get("restock_mode") is not None:
            return source["restock_mode"]
        return settings["default_mode"] if settings else None

    def _restock_source(
        self, connection: sqlite3.Connection, entry_id: str
    ) -> dict[str, Any]:
        entry = connection.execute(
            """SELECT inventory_entries.*, products.name AS product_name,
                      products.id AS source_product_id,
                      categories.name AS saved_category_name
               FROM inventory_entries
               JOIN products ON products.id = inventory_entries.product_id
               LEFT JOIN categories ON categories.id = inventory_entries.category_id
               WHERE inventory_entries.id = ?""",
            (entry_id,),
        ).fetchone()
        if entry is None:
            raise InventoryEntryNotFoundError(entry_id)
        group = connection.execute(
            """SELECT inventory_groups.*,
                      categories.name AS saved_category_name,
                      COALESCE(SUM(inventory_entries.stock), 0) AS combined_stock
               FROM inventory_group_members
               JOIN inventory_groups ON inventory_groups.id = inventory_group_members.group_id
               JOIN inventory_entries ON inventory_entries.id = inventory_group_members.inventory_entry_id
               LEFT JOIN categories ON categories.id = inventory_groups.category_id
               WHERE inventory_groups.id = (
                   SELECT group_id FROM inventory_group_members
                   WHERE inventory_entry_id = ?
               )
               GROUP BY inventory_groups.id""",
            (entry_id,),
        ).fetchone()
        row = group or entry
        options = None
        if group:
            options = localized_text("backend.product_options", names=", ".join(
                member["name"] for member in connection.execute(
                    """SELECT products.name FROM inventory_group_members
                       JOIN inventory_entries ON inventory_entries.id = inventory_group_members.inventory_entry_id
                       JOIN products ON products.id = inventory_entries.product_id
                       WHERE inventory_group_members.group_id = ?
                       ORDER BY inventory_group_members.position, products.name COLLATE NOCASE""",
                    (group["id"],),
                )
            ))
        return {
            "list_id": entry["list_id"],
            "source_type": "group" if group else "entry",
            "source_id": row["id"],
            "name": row["name"] if group else row["product_name"],
            "stock": int(row["combined_stock"] if group else row["stock"]),
            "minimum_stock": row["minimum_stock"],
            "restock_quantity": int(row["restock_quantity"]),
            "restock_mode": row["restock_mode"],
            "category": row["saved_category_name"] or row["category"],
            "product_id": None if group else entry["source_product_id"],
            "options": options,
        }

    @staticmethod
    def _restock_latched(
        connection: sqlite3.Connection, source: dict[str, Any]
    ) -> bool:
        row = connection.execute(
            """SELECT latched FROM inventory_restock_state
               WHERE list_id = ? AND source_type = ? AND source_id = ?""",
            (source["list_id"], source["source_type"], source["source_id"]),
        ).fetchone()
        return bool(row and row["latched"])

    def _set_restock_latched(
        self, connection: sqlite3.Connection, source: dict[str, Any], latched: bool
    ) -> None:
        connection.execute(
            """INSERT INTO inventory_restock_state(
                   list_id, source_type, source_id, latched, updated_at
               ) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(list_id, source_type, source_id) DO UPDATE SET
                   latched=excluded.latched, updated_at=excluded.updated_at""",
            (source["list_id"], source["source_type"], source["source_id"],
             int(latched), self._now()),
        )

    def _append_restock_item(
        self, connection: sqlite3.Connection, target_list_id: str,
        source: dict[str, Any], quantity: int, *, origin: str, mode: str | None,
    ) -> dict[str, Any]:
        existing_open = connection.execute(
            """SELECT COALESCE(SUM(quantity), 0) AS quantity FROM list_items
               WHERE list_id = ? AND completed = 0 AND name = ? COLLATE NOCASE""",
            (target_list_id, source["name"]),
        ).fetchone()["quantity"]
        existing = connection.execute(
            """SELECT * FROM list_items WHERE list_id = ? AND completed = 0
               AND name = ? COLLATE NOCASE ORDER BY position LIMIT 1""",
            (target_list_id, source["name"]),
        ).fetchone()
        now = self._now()
        if existing:
            connection.execute(
                """UPDATE list_items SET quantity = quantity + ?,
                       description = COALESCE(?, description), inventory_source_type = ?, inventory_source_id = ?, updated_at = ?
                   WHERE id = ?""",
                (quantity, source.get("options"), source["source_type"], source["source_id"], now, existing["id"]),
            )
            item_id = existing["id"]
        else:
            category_id, category = self._resolve_item_category(
                connection, target_list_id, None, source["category"]
            )
            item_id = str(uuid4())
            position = connection.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 AS value FROM list_items WHERE list_id = ?",
                (target_list_id,),
            ).fetchone()["value"]
            connection.execute(
                """INSERT INTO list_items(
                       id, list_id, product_id, name, description, quantity, category_id, category,
                       completed, position, inventory_source_type, inventory_source_id,
                       created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
                (item_id, target_list_id, source["product_id"], source["name"], source.get("options"), quantity,
                 category_id, category, int(position), source["source_type"],
                 source["source_id"], now, now),
            )
        target_name = connection.execute(
            "SELECT name FROM lists WHERE id = ?", (target_list_id,)
        ).fetchone()["name"]
        connection.execute(
            """INSERT INTO inventory_restock_transfers(
                   list_id, source_type, source_id, origin, transferred_at,
                   quantity, target_list_id, target_list_name, mode
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(list_id, source_type, source_id, origin) DO UPDATE SET
                   transferred_at=excluded.transferred_at,
                   quantity=excluded.quantity,
                   target_list_id=excluded.target_list_id,
                   target_list_name=excluded.target_list_name,
                   mode=excluded.mode""",
            (source["list_id"], source["source_type"], source["source_id"], origin,
             now, quantity, target_list_id, target_name, mode),
        )
        return {
            "item_id": item_id, "name": source["name"], "quantity": quantity,
            "already_open": int(existing_open), "source_type": source["source_type"],
            "source_id": source["source_id"], "product_id": source.get("product_id"),
            "target_list_id": target_list_id, "target_previous_quantity": int(existing["quantity"]) if existing else 0,
            "target_item_created": existing is None, "origin": origin,
        }

    def _adjust_inventory_with_restock(
        self, entry_id: str, delta: int, minimum_stock: int | None = None,
        restock_quantity: int | None = None, restock_mode: str | None = None,
        category_id: str | None = None, category: str | None = None,
    ) -> dict[str, Any]:
        if delta == 0 or abs(delta) > 1000000:
            raise ValueError(localized_text("backend.stock_delta_range"))
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            before_source = self._restock_source(connection, entry_id)
            existing = connection.execute(
                "SELECT * FROM inventory_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            before_stock = existing["stock"]
            if delta < 0 and before_stock == 0:
                settings = self._restock_settings_row(connection, before_source["list_id"])
                effective_mode = self._effective_restock_mode(settings, before_source)
                fixed_configured = effective_mode != "fixed" or bool(
                    before_source["restock_mode"] == "fixed"
                    or (settings and settings["default_restock_quantity"] is not None)
                )
                row = connection.execute(
                    f"{self._inventory_select()} WHERE inventory_entries.id = ?", (entry_id,)
                ).fetchone()
                return {
                    "entry": self._inventory_record_from_row(connection, row).as_dict(),
                    "stock_before": int(before_stock), "stock_after": int(before_stock),
                    "needs_confirmation": bool(
                        settings and settings["enabled"] and settings["target_list_id"]
                        and effective_mode not in {None, "disabled"} and fixed_configured
                    ),
                    "confirmation": {
                        "name": before_source["name"], "quantity": abs(delta),
                        "message": localized_text("backend.zero_stock_add_anyway"),
                    },
                    "transfer": None,
                }
            undo_before = self._inventory_booking_snapshot(connection, entry_id, before_source["list_id"])
            if any(value is not None for value in (
                minimum_stock, restock_quantity, restock_mode, category_id, category,
            )):
                minimum_stock = existing["minimum_stock"] if minimum_stock is None else minimum_stock
                restock_quantity = existing["restock_quantity"] if restock_quantity is None else restock_quantity
                restock_mode = existing["restock_mode"] if restock_mode is None else restock_mode
                if restock_mode == "inherit":
                    restock_mode = None
                self._validate_stock(before_stock, minimum_stock)
                self._validate_restock_quantity(restock_quantity)
                self._validate_restock_mode(restock_mode)
                self._validate_fixed_restock_threshold(restock_mode, minimum_stock)
                if category_id is None and category is None:
                    category_id, category = existing["category_id"], existing["category"]
                else:
                    category_id, category = self._resolve_item_category(
                        connection, existing["list_id"], category_id, category
                    )
                connection.execute(
                    "UPDATE inventory_entries SET minimum_stock = ?, restock_quantity = ?, "
                    "restock_mode = ?, category_id = ?, category = ? WHERE id = ?",
                    (minimum_stock, restock_quantity, restock_mode, category_id, category, entry_id),
                )
            actual_delta = delta if delta > 0 else -min(abs(delta), int(before_stock))
            connection.execute(
                "UPDATE inventory_entries SET stock = stock + ?, updated_at = ? WHERE id = ?",
                (actual_delta, self._now(), entry_id),
            )
            source = self._restock_source(connection, entry_id)
            if actual_delta > 0:
                self._set_restock_latched(connection, source, False)
            transfer = None
            settings = self._restock_settings_row(connection, source["list_id"])
            if actual_delta < 0 and settings and settings["enabled"] and settings["target_list_id"]:
                removed = abs(actual_delta)
                mode = self._effective_restock_mode(settings, source)
                quantity = 0
                if mode == "disabled" or mode is None:
                    quantity = 0
                elif mode == "one_to_one":
                    quantity = removed
                elif source["minimum_stock"] is not None and source["stock"] < source["minimum_stock"]:
                    if mode == "continuous":
                        quantity = removed
                    elif mode == "fixed" and not self._restock_latched(connection, source):
                        configured_quantity = (
                            source["restock_quantity"] if source["restock_mode"] == "fixed"
                            else settings["default_restock_quantity"]
                        )
                        if configured_quantity is not None:
                            quantity = int(configured_quantity)
                            self._set_restock_latched(connection, source, True)
                if quantity:
                    transfer = self._append_restock_item(
                        connection, settings["target_list_id"], source, quantity,
                        origin="automatic", mode=mode,
                    )
                    transfer["target_list_id"] = settings["target_list_id"]
                    transfer["mode"] = mode
            undo_token = self._remember_inventory_booking(connection, entry_id, source["list_id"], undo_before, transfer)
            row = connection.execute(
                f"{self._inventory_select()} WHERE inventory_entries.id = ?", (entry_id,)
            ).fetchone()
            return {"undo_token": undo_token,
                "entry": self._inventory_record_from_row(connection, row).as_dict(),
                "stock_before": int(before_stock), "stock_after": int(before_stock) + actual_delta,
                "needs_confirmation": False, "transfer": transfer,
            }

    def _confirm_zero_stock_restock(
        self, entry_id: str, quantity: int
    ) -> dict[str, Any]:
        if isinstance(quantity, bool) or not 1 <= quantity <= 1000000:
            raise ValueError(localized_text("backend.quantity_minimum"))
        with self._connect() as connection:
            source = self._restock_source(connection, entry_id)
            settings = self._restock_settings_row(connection, source["list_id"])
            if not settings or not settings["target_list_id"]:
                raise ValueError(localized_text("backend.configure_shopping_target"))
            result = self._append_restock_item(
                connection, settings["target_list_id"], source, quantity,
                origin="manual", mode=None,
            )
            result["target_list_id"] = settings["target_list_id"]
            return result

    def _restock_preview_rows(
        self, connection: sqlite3.Connection, list_id: str
    ) -> list[dict[str, Any]]:
        settings = self._restock_settings_row(connection, list_id)
        last_transfers = {
            (row["source_type"], row["source_id"], row["origin"]): {
                key: row[key] for key in (
                    "transferred_at", "quantity", "target_list_id", "target_list_name", "mode"
                )
            }
            for row in connection.execute(
                "SELECT * FROM inventory_restock_transfers WHERE list_id = ?", (list_id,)
            )
        }
        entry_ids = [row["id"] for row in connection.execute(
            "SELECT id FROM inventory_entries WHERE list_id = ? ORDER BY position", (list_id,)
        )]
        seen: set[tuple[str, str]] = set()
        rows: list[dict[str, Any]] = []
        for entry_id in entry_ids:
            source = self._restock_source(connection, entry_id)
            key = (source["source_type"], source["source_id"])
            if key in seen:
                continue
            seen.add(key)
            minimum = source["minimum_stock"]
            if minimum is None or source["stock"] >= minimum:
                continue
            source["quantity"] = int(minimum) - int(source["stock"])
            source["latched"] = self._restock_latched(connection, source)
            source["skipped"] = source["latched"]
            for origin in ("manual", "automatic"):
                source[f"last_{origin}_transfer"] = last_transfers.get((*key, origin))
            source["effective_mode"] = self._effective_restock_mode(settings, source)
            if source["effective_mode"] == "fixed":
                source["effective_fixed_quantity"] = (
                    source["restock_quantity"] if source["restock_mode"] == "fixed"
                    else settings["default_restock_quantity"]
                )
            rows.append(source)
        return rows

    def _preview_inventory_restock(self, list_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            settings = self._restock_settings_row(connection, list_id)
            target_id = settings["target_list_id"] if settings else None
            rows = self._restock_preview_rows(connection, list_id)
            if target_id:
                for row in rows:
                    row["already_open"] = int(connection.execute(
                        """SELECT COALESCE(SUM(quantity), 0) AS value FROM list_items
                           WHERE list_id = ? AND completed = 0 AND name = ? COLLATE NOCASE""",
                        (target_id, row["name"]),
                    ).fetchone()["value"])
            target = connection.execute("SELECT name FROM lists WHERE id = ?", (target_id,)).fetchone() if target_id else None
            return {"target_list_id": target_id, "target_list_name": target["name"] if target else None, "items": rows}

    def _apply_inventory_restock(self, list_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            settings = self._restock_settings_row(connection, list_id)
            if not settings or not settings["target_list_id"]:
                raise ValueError(localized_text("backend.configure_shopping_target"))
            rows = self._restock_preview_rows(connection, list_id)
            transferred = []
            for row in rows:
                if row["skipped"]:
                    continue
                transfer = self._append_restock_item(
                    connection, settings["target_list_id"], row, row["quantity"],
                    origin="manual", mode=None,
                )
                if row["effective_mode"] == "fixed":
                    self._set_restock_latched(connection, row, True)
                transferred.append(transfer)
            return {"target_list_id": settings["target_list_id"], "items": transferred}

    def _reset_inventory_restock_latch(
        self, list_id: str, source_type: str, source_id: str
    ) -> None:
        if source_type not in {"entry", "group"}:
            raise ValueError(localized_text("backend.restock_source_invalid"))
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            connection.execute(
                "DELETE FROM inventory_restock_state WHERE list_id = ? AND source_type = ? AND source_id = ?",
                (list_id, source_type, source_id),
            )

    def _delete_inventory_entry(self, entry_id: str) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT inventory_entries.list_id, inventory_group_members.group_id "
                "FROM inventory_entries "
                "LEFT JOIN inventory_group_members ON "
                "inventory_group_members.inventory_entry_id = inventory_entries.id "
                "WHERE inventory_entries.id = ?",
                (entry_id,),
            ).fetchone()
            if row is None:
                raise InventoryEntryNotFoundError(entry_id)
            cursor = connection.execute(
                "DELETE FROM inventory_entries WHERE id = ?", (entry_id,)
            )
            if cursor.rowcount != 1:
                raise InventoryEntryNotFoundError(entry_id)
            connection.execute(
                "DELETE FROM inventory_restock_state "
                "WHERE list_id = ? AND source_type = 'entry' AND source_id = ?",
                (row["list_id"], entry_id),
            )
            if row["group_id"] is not None:
                connection.execute(
                    "DELETE FROM inventory_restock_state "
                    "WHERE list_id = ? AND source_type = 'group' AND source_id = ?",
                    (row["list_id"], row["group_id"]),
                )
                self._cleanup_small_inventory_groups(connection, [row["group_id"]])
            return row["list_id"]

    def _list_inventory_groups(self, list_id: str) -> list[InventoryGroupRecord]:
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            rows = connection.execute(
                f"{self._inventory_group_select()} "
                "WHERE inventory_groups.list_id = ? "
                "ORDER BY inventory_groups.position, inventory_groups.name COLLATE NOCASE",
                (list_id,),
            ).fetchall()
            return [self._inventory_group_record_from_row(connection, row) for row in rows]

    def _create_inventory_group(
        self,
        list_id: str,
        name: str,
        minimum_stock: int | None,
        category_id: str | None,
        category: str | None,
        member_ids: list[str],
        restock_quantity: int = 1,
        restock_mode: str | None = None,
    ) -> InventoryGroupRecord:
        self._validate_stock(0, minimum_stock)
        self._validate_restock_quantity(restock_quantity)
        restock_mode = None if restock_mode == "inherit" else restock_mode
        self._validate_restock_mode(restock_mode)
        self._validate_fixed_restock_threshold(restock_mode, minimum_stock)
        group_id = str(uuid4())
        now = self._now()
        try:
            with self._connect() as connection:
                self._require_inventory_list(connection, list_id)
                category_id, category = self._resolve_item_category(
                    connection, list_id, category_id, category
                )
                members = self._validate_inventory_group_members(
                    connection, list_id, member_ids
                )
                old_group_ids = self._inventory_group_ids_for_members(
                    connection, members
                )
                next_position = connection.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS value "
                    "FROM inventory_groups WHERE list_id = ?",
                    (list_id,),
                ).fetchone()["value"]
                connection.execute(
                    """
                    INSERT INTO inventory_groups(
                        id, list_id, name, minimum_stock, restock_quantity, restock_mode,
                        category_id, category, position, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        group_id, list_id, name, minimum_stock, restock_quantity, restock_mode, category_id,
                        category, int(next_position), now, now,
                    ),
                )
                self._replace_inventory_group_members(connection, group_id, members)
                for source_group_id in old_group_ids:
                    connection.execute(
                        "DELETE FROM inventory_restock_state "
                        "WHERE list_id = ? AND source_type = 'group' AND source_id = ?",
                        (list_id, source_group_id),
                    )
                for member_id in members:
                    connection.execute(
                        "DELETE FROM inventory_restock_state "
                        "WHERE list_id = ? AND source_type = 'entry' AND source_id = ?",
                        (list_id, member_id),
                    )
                self._cleanup_small_inventory_groups(connection, old_group_ids)
                return self._get_inventory_group(connection, group_id)
        except sqlite3.IntegrityError as error:
            if "inventory_groups.list_id" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateInventoryGroupError(name) from error
            raise

    def _update_inventory_group(
        self,
        group_id: str,
        name: str,
        minimum_stock: int | None,
        category_id: str | None,
        category: str | None,
        member_ids: list[str],
        restock_quantity: int | None = None,
        restock_mode: str | None = None,
    ) -> InventoryGroupRecord:
        self._validate_stock(0, minimum_stock)
        try:
            with self._connect() as connection:
                existing = connection.execute(
                    "SELECT list_id, restock_quantity, restock_mode FROM inventory_groups WHERE id = ?", (group_id,)
                ).fetchone()
                if existing is None:
                    raise InventoryGroupNotFoundError(group_id)
                if restock_quantity is None:
                    restock_quantity = int(existing["restock_quantity"])
                self._validate_restock_quantity(restock_quantity)
                if restock_mode is None:
                    restock_mode = existing["restock_mode"]
                elif restock_mode == "inherit":
                    restock_mode = None
                self._validate_restock_mode(restock_mode)
                self._validate_fixed_restock_threshold(restock_mode, minimum_stock)
                list_id = existing["list_id"]
                category_id, category = self._resolve_item_category(
                    connection, list_id, category_id, category
                )
                members = self._validate_inventory_group_members(
                    connection, list_id, member_ids
                )
                old_group_ids = [
                    value for value in self._inventory_group_ids_for_members(connection, members)
                    if value != group_id
                ]
                cursor = connection.execute(
                    """
                    UPDATE inventory_groups
                    SET name = ?, minimum_stock = ?, restock_quantity = ?, restock_mode = ?, category_id = ?, category = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (name, minimum_stock, restock_quantity, restock_mode, category_id, category, self._now(), group_id),
                )
                if cursor.rowcount != 1:
                    raise InventoryGroupNotFoundError(group_id)
                self._replace_inventory_group_members(connection, group_id, members)
                for source_group_id in [group_id, *old_group_ids]:
                    connection.execute(
                        "DELETE FROM inventory_restock_state "
                        "WHERE list_id = ? AND source_type = 'group' AND source_id = ?",
                        (list_id, source_group_id),
                    )
                for member_id in members:
                    connection.execute(
                        "DELETE FROM inventory_restock_state "
                        "WHERE list_id = ? AND source_type = 'entry' AND source_id = ?",
                        (list_id, member_id),
                    )
                self._cleanup_small_inventory_groups(connection, old_group_ids)
                return self._get_inventory_group(connection, group_id)
        except sqlite3.IntegrityError as error:
            if "inventory_groups.list_id" in str(error) or "UNIQUE constraint" in str(error):
                raise DuplicateInventoryGroupError(name) from error
            raise

    def _delete_inventory_group(self, group_id: str) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT list_id FROM inventory_groups WHERE id = ?", (group_id,)
            ).fetchone()
            if row is None:
                raise InventoryGroupNotFoundError(group_id)
            connection.execute("DELETE FROM inventory_groups WHERE id = ?", (group_id,))
            connection.execute(
                "DELETE FROM inventory_restock_state "
                "WHERE list_id = ? AND source_type = 'group' AND source_id = ?",
                (row["list_id"], group_id),
            )
            return row["list_id"]

    def _list_scanners(self) -> list[ScannerRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM scanners ORDER BY name COLLATE NOCASE"
            ).fetchall()
        return [self._scanner_record_from_row(row) for row in rows]

    def _get_scanner_by_address(self, address: str) -> ScannerRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM scanners WHERE enabled = 1 AND address = ? COLLATE NOCASE",
                (address,),
            ).fetchone()
        return self._scanner_record_from_row(row) if row else None

    def _validate_scanner_route(
        self, connection: sqlite3.Connection, routing: str,
        list_id: str | None, action: str | None,
    ) -> None:
        if routing not in SCANNER_ROUTING:
            raise ValueError(localized_text("backend.scanner_routing_unsupported", routing=routing))
        if routing == "active_target":
            if list_id is not None or action is not None:
                raise ValueError(localized_text("backend.active_scanner_fixed_route_forbidden"))
            return
        if list_id is None or action not in SCANNER_ACTIONS:
            raise ValueError(localized_text("backend.fixed_scanner_route_required"))
        self._require_inventory_list(connection, list_id)

    def _create_scanner(
        self, name: str, address: str, enabled: bool, routing: str,
        list_id: str | None, action: str | None,
    ) -> ScannerRecord:
        now = self._now()
        try:
            with self._connect() as connection:
                self._validate_scanner_route(connection, routing, list_id, action)
                scanner_id = str(uuid4())
                connection.execute(
                    """INSERT INTO scanners(
                        id, name, address, enabled, routing, list_id, action,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (scanner_id, name, address, int(enabled), routing, list_id,
                     action, now, now),
                )
                row = connection.execute(
                    "SELECT * FROM scanners WHERE id = ?", (scanner_id,)
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "scanners.address" in str(error) or "scanners_address_unique" in str(error):
                raise DuplicateScannerAddressError(address) from error
            raise
        return self._scanner_record_from_row(row)

    def _update_scanner(
        self, scanner_id: str, name: str, address: str, enabled: bool,
        routing: str, list_id: str | None, action: str | None,
    ) -> ScannerRecord:
        try:
            with self._connect() as connection:
                self._validate_scanner_route(connection, routing, list_id, action)
                cursor = connection.execute(
                    """UPDATE scanners
                    SET name = ?, address = ?, enabled = ?, routing = ?,
                        list_id = ?, action = ?, updated_at = ? WHERE id = ?""",
                    (name, address, int(enabled), routing, list_id, action,
                     self._now(), scanner_id),
                )
                if cursor.rowcount != 1:
                    raise ScannerNotFoundError(scanner_id)
                row = connection.execute(
                    "SELECT * FROM scanners WHERE id = ?", (scanner_id,)
                ).fetchone()
        except sqlite3.IntegrityError as error:
            if "scanners.address" in str(error) or "scanners_address_unique" in str(error):
                raise DuplicateScannerAddressError(address) from error
            raise
        return self._scanner_record_from_row(row)

    def _delete_scanner(self, scanner_id: str) -> None:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM scanners WHERE id = ?", (scanner_id,))
            if cursor.rowcount != 1:
                raise ScannerNotFoundError(scanner_id)

    def _get_scanner_target(self) -> ScannerTargetRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT list_id, action, updated_at FROM scanner_target WHERE singleton = 1"
            ).fetchone()
        return self._scanner_target_from_row(row) if row else None

    def _set_scanner_target(self, list_id: str, action: str) -> ScannerTargetRecord:
        if action not in SCANNER_ACTIONS:
            raise ValueError(localized_text("backend.scanner_action_unsupported", action=action))
        now = self._now()
        with self._connect() as connection:
            self._require_inventory_list(connection, list_id)
            connection.execute(
                """INSERT INTO scanner_target(singleton, list_id, action, updated_at)
                VALUES (1, ?, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                    list_id = excluded.list_id, action = excluded.action,
                    updated_at = excluded.updated_at""",
                (list_id, action, now),
            )
            row = connection.execute(
                "SELECT list_id, action, updated_at FROM scanner_target WHERE singleton = 1"
            ).fetchone()
        return self._scanner_target_from_row(row)

    def _clear_scanner_target(self) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM scanner_target WHERE singleton = 1")

    def _add_scan_history(
        self, scanner_id: str | None, scanner_name: str | None,
        scanner_address: str | None, source: str, ean: str,
        action: str | None, list_id: str | None, product_id: str | None,
        product_name: str | None, inventory_entry_id: str | None,
        quantity: int, stock_before: int | None, stock_after: int | None,
        status: str, message: str | None,
    ) -> ScanHistoryRecord:
        record = ScanHistoryRecord(
            id=str(uuid4()), scanned_at=self._now(), scanner_id=scanner_id,
            scanner_name=scanner_name, scanner_address=scanner_address,
            source=source, ean=ean, action=action, list_id=list_id,
            product_id=product_id, product_name=product_name,
            inventory_entry_id=inventory_entry_id, quantity=quantity,
            stock_before=stock_before, stock_after=stock_after,
            status=status, message=message,
        )
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO scan_history(
                    id, scanned_at, scanner_id, scanner_name, scanner_address,
                    source, ean, action, list_id, product_id, product_name,
                    inventory_entry_id, quantity, stock_before, stock_after,
                    status, message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (record.id, record.scanned_at, record.scanner_id,
                 record.scanner_name, record.scanner_address, record.source,
                 record.ean, record.action, record.list_id, record.product_id,
                 record.product_name, record.inventory_entry_id, record.quantity,
                 record.stock_before, record.stock_after, record.status,
                 record.message),
            )
        return record

    def _list_scan_history(
        self, limit: int, offset: int
    ) -> tuple[list[ScanHistoryRecord], int]:
        limit = max(1, min(100, int(limit)))
        offset = max(0, int(offset))
        with self._connect() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM scan_history").fetchone()[0])
            rows = connection.execute(
                "SELECT * FROM scan_history ORDER BY scanned_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [self._scan_history_from_row(row) for row in rows], total

    def _get_scan_history_record(self, scan_id: str) -> ScanHistoryRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM scan_history WHERE id = ?", (scan_id,)).fetchone()
        return self._scan_history_from_row(row) if row else None

    def _list_pending_scans(self) -> list[ScanHistoryRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM scan_history WHERE status IN ('queued', 'offered', 'needs_input', 'processing') "
                "ORDER BY scanned_at DESC"
            ).fetchall()
        return [self._scan_history_from_row(row) for row in rows]

    def _claim_pending_scan(self, scan_id: str) -> ScanHistoryRecord | None:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE scan_history SET status = 'processing' "
                "WHERE id = ? AND status IN ('queued', 'offered', 'needs_input')",
                (scan_id,),
            )
            if cursor.rowcount != 1:
                return None
            row = connection.execute(
                "SELECT * FROM scan_history WHERE id = ?", (scan_id,)
            ).fetchone()
        return self._scan_history_from_row(row) if row else None

    def _hold_offered_scan(self, scan_id: str) -> ScanHistoryRecord | None:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE scan_history SET status = 'needs_input', "
                "message = ? "
                "WHERE id = ? AND status = 'offered'", (localized_text("backend.scan_waiting_for_save"), scan_id),
            )
            if cursor.rowcount != 1:
                return None
            row = connection.execute(
                "SELECT * FROM scan_history WHERE id = ?", (scan_id,)
            ).fetchone()
        return self._scan_history_from_row(row) if row else None

    def _queue_offered_scan(self, scan_id: str) -> ScanHistoryRecord | None:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE scan_history SET status = 'queued', "
                "message = CASE WHEN message IS NULL OR message = '' THEN '' ELSE message || ' ' END || "
                "? "
                "WHERE id = ? AND status = 'offered'", (localized_text("backend.scan_waiting_in_queue"), scan_id),
            )
            if cursor.rowcount != 1:
                return None
            row = connection.execute(
                "SELECT * FROM scan_history WHERE id = ?", (scan_id,)
            ).fetchone()
        return self._scan_history_from_row(row) if row else None

    def _finish_pending_scan(
        self, scan_id: str, status: str, message: str | None
    ) -> None:
        if status not in {"queued", "offered", "needs_input", "resolved", "dismissed"}:
            raise ValueError(localized_text("backend.pending_scan_status_invalid"))
        with self._connect() as connection:
            connection.execute(
                "UPDATE scan_history SET status = ?, message = ? WHERE id = ?",
                (status, message, scan_id),
            )

    @staticmethod
    def _inventory_group_ids_for_members(
        connection: sqlite3.Connection, member_ids: list[str]
    ) -> list[str]:
        placeholders = ",".join("?" for _ in member_ids)
        rows = connection.execute(
            f"SELECT DISTINCT group_id FROM inventory_group_members "
            f"WHERE inventory_entry_id IN ({placeholders})",
            member_ids,
        ).fetchall()
        return [row["group_id"] for row in rows]

    @staticmethod
    def _validate_inventory_group_members(
        connection: sqlite3.Connection, list_id: str, member_ids: list[str]
    ) -> list[str]:
        members = list(dict.fromkeys(member_ids))
        if len(members) < 2:
            raise InvalidInventoryGroupMembersError(localized_text("backend.group_needs_two_members"))
        placeholders = ",".join("?" for _ in members)
        rows = connection.execute(
            f"SELECT id FROM inventory_entries WHERE list_id = ? "
            f"AND id IN ({placeholders})",
            (list_id, *members),
        ).fetchall()
        if len(rows) != len(members):
            raise InvalidInventoryGroupMembersError(
                localized_text("backend.group_member_inventory_required")
            )
        return members

    @staticmethod
    def _replace_inventory_group_members(
        connection: sqlite3.Connection, group_id: str, member_ids: list[str]
    ) -> None:
        connection.execute(
            "DELETE FROM inventory_group_members WHERE group_id = ?", (group_id,)
        )
        for position, entry_id in enumerate(member_ids):
            connection.execute(
                "DELETE FROM inventory_group_members WHERE inventory_entry_id = ?",
                (entry_id,),
            )
            connection.execute(
                "INSERT INTO inventory_group_members(group_id, inventory_entry_id, position) "
                "VALUES (?, ?, ?)",
                (group_id, entry_id, position),
            )

    @staticmethod
    def _cleanup_small_inventory_groups(
        connection: sqlite3.Connection, group_ids: list[str]
    ) -> None:
        for group_id in dict.fromkeys(group_ids):
            row = connection.execute(
                "SELECT list_id FROM inventory_groups WHERE id = ?", (group_id,)
            ).fetchone()
            cursor = connection.execute(
                "DELETE FROM inventory_groups WHERE id = ? AND "
                "(SELECT COUNT(*) FROM inventory_group_members WHERE group_id = ?) < 2",
                (group_id, group_id),
            )
            if row is not None and cursor.rowcount:
                connection.execute(
                    "DELETE FROM inventory_restock_state "
                    "WHERE list_id = ? AND source_type = 'group' AND source_id = ?",
                    (row["list_id"], group_id),
                )

    def _get_inventory_group(
        self, connection: sqlite3.Connection, group_id: str
    ) -> InventoryGroupRecord:
        row = connection.execute(
            f"{self._inventory_group_select()} WHERE inventory_groups.id = ?",
            (group_id,),
        ).fetchone()
        if row is None:
            raise InventoryGroupNotFoundError(group_id)
        return self._inventory_group_record_from_row(connection, row)

    @staticmethod
    def _inventory_group_select() -> str:
        return """
            SELECT inventory_groups.*,
                   categories.id AS category_record_id,
                   categories.name AS category_record_name,
                   categories.scope AS category_scope,
                   categories.list_type AS category_list_type,
                   categories.list_id AS category_list_id,
                   categories.icon AS category_icon,
                   categories.color AS category_color,
                   categories.position AS category_position,
                   categories.created_at AS category_created_at,
                   categories.updated_at AS category_updated_at
            FROM inventory_groups
            LEFT JOIN categories ON categories.id = inventory_groups.category_id
        """

    @staticmethod
    def _inventory_group_record_from_row(
        connection: sqlite3.Connection, row: sqlite3.Row
    ) -> InventoryGroupRecord:
        member_rows = connection.execute(
            "SELECT inventory_entry_id FROM inventory_group_members "
            "WHERE group_id = ? ORDER BY position, inventory_entry_id",
            (row["id"],),
        ).fetchall()
        category_record = None
        if row["category_record_id"] is not None:
            category_record = CategoryRecord(
                id=row["category_record_id"],
                name=row["category_record_name"],
                scope=row["category_scope"],
                list_type=row["category_list_type"],
                list_id=row["category_list_id"],
                icon=row["category_icon"],
                color=row["category_color"],
                position=int(row["category_position"]),
                created_at=row["category_created_at"],
                updated_at=row["category_updated_at"],
            )
        return InventoryGroupRecord(
            id=row["id"],
            list_id=row["list_id"],
            name=row["name"],
            minimum_stock=row["minimum_stock"],
            restock_quantity=int(row["restock_quantity"]),
            restock_mode=row["restock_mode"],
            category_id=row["category_id"],
            category_name=row["category"],
            category=category_record,
            position=int(row["position"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            member_ids=tuple(member["inventory_entry_id"] for member in member_rows),
        )

    @staticmethod
    def _inventory_select() -> str:
        return """
            SELECT inventory_entries.*,
                   products.ean AS product_ean,
                   products.name AS product_name,
                   products.original_name AS product_original_name,
                   products.brand AS product_brand,
                   products.package_quantity AS product_package_quantity,
                   products.category AS product_category,
                   products.image_url AS product_image_url,
                   products.source AS product_source,
                   products.created_at AS product_created_at,
                   products.updated_at AS product_updated_at
                   , categories.id AS category_record_id
                   , categories.name AS category_record_name
                   , categories.scope AS category_scope
                   , categories.list_type AS category_list_type
                   , categories.list_id AS category_list_id
                   , categories.icon AS category_icon
                   , categories.color AS category_color
                   , categories.position AS category_position
                   , categories.created_at AS category_created_at
                   , categories.updated_at AS category_updated_at
            FROM inventory_entries
            JOIN products ON products.id = inventory_entries.product_id
            LEFT JOIN categories ON categories.id = inventory_entries.category_id
        """

    @staticmethod
    def _inventory_record_from_row(
        connection: sqlite3.Connection, row: sqlite3.Row
    ) -> InventoryRecord:
        labels = HaListManagerDatabase._labels_for(
            connection, "product_labels", "product_id", row["product_id"], row["list_id"]
        )
        assignments = HaListManagerDatabase._product_category_assignments(
            connection, row["product_id"]
        )
        return HaListManagerDatabase._inventory_record_from_row_data(
            row, labels, assignments
        )

    @staticmethod
    def _inventory_record_from_row_data(
        row: sqlite3.Row,
        labels: tuple[LabelRecord, ...] = (),
        category_assignments: tuple[ProductCategoryAssignmentRecord, ...] = (),
    ) -> InventoryRecord:
        product = ProductRecord(
            id=row["product_id"],
            ean=row["product_ean"],
            name=row["product_name"],
            original_name=row["product_original_name"],
            brand=row["product_brand"],
            package_quantity=row["product_package_quantity"],
            category=row["product_category"],
            image_url=row["product_image_url"],
            source=row["product_source"],
            created_at=row["product_created_at"],
            updated_at=row["product_updated_at"],
            labels=labels,
            category_assignments=category_assignments,
        )
        category = None
        if row["category_record_id"] is not None:
            category = CategoryRecord(
                id=row["category_record_id"],
                name=row["category_record_name"],
                scope=row["category_scope"],
                list_type=row["category_list_type"],
                list_id=row["category_list_id"],
                icon=row["category_icon"],
                color=row["category_color"],
                position=int(row["category_position"]),
                created_at=row["category_created_at"],
                updated_at=row["category_updated_at"],
            )
        return InventoryRecord(
            id=row["id"],
            list_id=row["list_id"],
            product_id=row["product_id"],
            stock=int(row["stock"]),
            minimum_stock=row["minimum_stock"],
            restock_quantity=int(row["restock_quantity"]),
            restock_mode=row["restock_mode"],
            category_id=row["category_id"],
            category_name=row["category"],
            category=category,
            hidden=bool(row["hidden"]),
            position=int(row["position"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            product=product,
        )

    @staticmethod
    def _validate_stock(stock: int, minimum_stock: int | None) -> None:
        if stock < 0 or stock > 1000000:
            raise ValueError(localized_text("backend.stock_range"))
        if minimum_stock is not None and (
            minimum_stock < 0 or minimum_stock > 1000000
        ):
            raise ValueError(localized_text("backend.minimum_stock_range"))

    @staticmethod
    def _validate_restock_quantity(restock_quantity: int) -> None:
        if isinstance(restock_quantity, bool) or not 1 <= restock_quantity <= 1000000:
            raise ValueError(localized_text("backend.fixed_restock_quantity_range"))

    @staticmethod
    def _validate_restock_mode(restock_mode: str | None) -> None:
        if restock_mode not in {None, "disabled", "continuous", "fixed", "one_to_one"}:
            raise ValueError(localized_text("backend.invalid_restock_rule"))

    @staticmethod
    def _validate_fixed_restock_threshold(
        restock_mode: str | None, minimum_stock: int | None
    ) -> None:
        if restock_mode == "fixed" and minimum_stock is None:
            raise ValueError(
                localized_text("backend.fixed_restock_needs_minimum")
            )

    @staticmethod
    def _require_inventory_list(
        connection: sqlite3.Connection, list_id: str
    ) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM lists WHERE id = ?", (list_id,)
        ).fetchone()
        if row is None:
            raise ListNotFoundError(list_id)
        if row["list_type"] != "inventory":
            raise InventoryListRequiredError(list_id)
        return row

    @staticmethod
    def _list_context_label_ids(
        connection: sqlite3.Connection, assignment_table: str, owner_column: str,
        owner_id: str, label_ids: list[str], list_id: str,
    ) -> list[str]:
        """Apply visible selections while preserving hidden and inherited IDs."""
        available = HaListManagerDatabase._applicable_label_records(connection, list_id)
        visible_ids = {label.id for label in available}
        selected_names = {
            label.name.casefold() for label in available if label.id in label_ids
        }
        stored = HaListManagerDatabase._labels_for(
            connection, assignment_table, owner_column, owner_id
        )
        stored_visible_names = {
            label.name.casefold() for label in stored if label.id in visible_ids
        }
        effective = HaListManagerDatabase._resolve_scoped_records(available)
        # A selected inherited name keeps its stored ID even when a more
        # specific definition supplies its appearance. Hidden scopes survive.
        return list(dict.fromkeys([
            *(label.id for label in stored if label.id not in visible_ids
              or label.name.casefold() in selected_names),
            *(label.id for label in effective if label.name.casefold() in
              selected_names - stored_visible_names),
        ]))

    @staticmethod
    def _labels_for(
        connection: sqlite3.Connection,
        assignment_table: str,
        owner_column: str,
        owner_id: str,
        list_id: str | None = None,
    ) -> tuple[LabelRecord, ...]:
        rows = connection.execute(
            f"""
            SELECT l.*, 0 AS product_count, 0 AS item_count FROM labels AS l
            JOIN {assignment_table} AS a ON a.label_id = l.id
            WHERE a.{owner_column} = ?
            ORDER BY l.name COLLATE NOCASE
            """,
            (owner_id,),
        ).fetchall()
        records = [HaListManagerDatabase._label_record_from_row(row) for row in rows]
        if list_id is not None:
            available = HaListManagerDatabase._applicable_label_records(connection, list_id)
            available_ids = {label.id for label in available}
            effective = {
                label.name.casefold(): label
                for label in HaListManagerDatabase._resolve_scoped_records(available)
            }
            records = list({
                label.name.casefold(): effective[label.name.casefold()]
                for label in records if label.id in available_ids
            }.values())
            records.sort(key=lambda label: label.name.casefold())
        return tuple(records)

    @staticmethod
    def _validate_label_ids(
        connection: sqlite3.Connection,
        label_ids: list[str],
    ) -> None:
        unique_ids = list(dict.fromkeys(label_ids))
        if unique_ids:
            placeholders = ",".join("?" for _ in unique_ids)
            count = connection.execute(
                f"SELECT COUNT(*) AS count FROM labels WHERE id IN ({placeholders})",
                unique_ids,
            ).fetchone()["count"]
            if count != len(unique_ids):
                raise LabelNotFoundError(localized_text("backend.label_assignment_unknown"))

    @staticmethod
    def _replace_labels(
        connection: sqlite3.Connection,
        assignment_table: str,
        owner_column: str,
        owner_id: str,
        label_ids: list[str],
    ) -> None:
        unique_ids = list(dict.fromkeys(label_ids))
        HaListManagerDatabase._validate_label_ids(connection, unique_ids)
        connection.execute(
            f"DELETE FROM {assignment_table} WHERE {owner_column} = ?", (owner_id,)
        )
        connection.executemany(
            f"INSERT INTO {assignment_table}({owner_column}, label_id) VALUES (?, ?)",
            [(owner_id, label_id) for label_id in unique_ids],
        )

    @staticmethod
    def _product_category_assignments(
        connection: sqlite3.Connection, product_id: str
    ) -> tuple[ProductCategoryAssignmentRecord, ...]:
        rows = connection.execute(
            """
            SELECT categories.*
            FROM product_category_assignments
            JOIN categories ON categories.id = product_category_assignments.category_id
            WHERE product_category_assignments.product_id = ?
            ORDER BY CASE categories.scope
                WHEN 'global' THEN 1 WHEN 'list_type' THEN 2 ELSE 3 END,
                categories.list_type, categories.name COLLATE NOCASE
            """,
            (product_id,),
        ).fetchall()
        return tuple(
            ProductCategoryAssignmentRecord(
                product_id=product_id,
                category_id=row["id"],
                scope=row["scope"],
                list_type=row["list_type"],
                list_id=row["list_id"],
                category=HaListManagerDatabase._category_record_from_row(row),
            )
            for row in rows
        )

    @staticmethod
    def _replace_product_category_assignments(
        connection: sqlite3.Connection, product_id: str, category_ids: list[str]
    ) -> None:
        unique_ids = list(dict.fromkeys(category_ids))
        rows: list[sqlite3.Row] = []
        if unique_ids:
            placeholders = ",".join("?" for _ in unique_ids)
            rows = connection.execute(
                f"""
                SELECT categories.*, lists.list_type AS target_list_type
                FROM categories
                LEFT JOIN lists ON lists.id = categories.list_id
                WHERE categories.id IN ({placeholders})
                """,
                unique_ids,
            ).fetchall()
            if len(rows) != len(unique_ids):
                raise CategoryNotFoundError(localized_text("backend.product_category_assignment_unknown"))
        contexts: set[tuple[str, str]] = set()
        for row in rows:
            context = (
                ("global", "") if row["scope"] == "global"
                else ("list_type", row["list_type"]) if row["scope"] == "list_type"
                else ("list", row["list_id"])
            )
            target_type = row["list_type"] if row["scope"] == "list_type" else row["target_list_type"]
            if target_type == "todo":
                raise ValueError(localized_text("backend.todo_product_categories_unavailable"))
            if context in contexts:
                raise ValueError(localized_text("backend.one_category_per_scope"))
            contexts.add(context)
        connection.execute(
            "DELETE FROM product_category_assignments WHERE product_id = ?",
            (product_id,),
        )
        connection.executemany(
            "INSERT INTO product_category_assignments(product_id, category_id) VALUES (?, ?)",
            [(product_id, category_id) for category_id in unique_ids],
        )

    @staticmethod
    def _resolve_product_category_for_list(
        connection: sqlite3.Connection,
        product_id: str,
        list_id: str,
        excluded_category_id: str | None = None,
        use_global_categories: bool | None = None,
        use_type_categories: bool | None = None,
    ) -> tuple[str | None, str | None]:
        list_row = connection.execute(
            "SELECT list_type, use_global_categories, use_type_categories "
            "FROM lists WHERE id = ?",
            (list_id,),
        ).fetchone()
        if list_row is None:
            raise ListNotFoundError(list_id)
        if list_row["list_type"] == "todo":
            return None, None
        global_enabled = (
            bool(list_row["use_global_categories"])
            if use_global_categories is None else use_global_categories
        )
        type_enabled = (
            bool(list_row["use_type_categories"])
            if use_type_categories is None else use_type_categories
        )
        rows = connection.execute(
            """
            SELECT categories.*
            FROM product_category_assignments
            JOIN categories ON categories.id = product_category_assignments.category_id
            WHERE product_category_assignments.product_id = ?
            """,
            (product_id,),
        ).fetchall()
        candidates = [
            row for row in rows
            if row["id"] != excluded_category_id and (
                (row["scope"] == "list" and row["list_id"] == list_id)
                or (
                    row["scope"] == "list_type"
                    and type_enabled
                    and row["list_type"] == list_row["list_type"]
                )
                or (row["scope"] == "global" and global_enabled)
            )
        ]
        rank = {"global": 1, "list_type": 2, "list": 3}
        if candidates:
            winner = max(candidates, key=lambda row: rank[row["scope"]])
            # Equal names describe the same logical category. Use the most
            # specific definition visible in this list so its icon, color and
            # ordering win over the broader product assignment.
            effective = connection.execute(
                """
                SELECT * FROM categories
                WHERE lower(name) = lower(?)
                  AND id != COALESCE(?, '')
                  AND ((scope = 'list' AND list_id = ?)
                    OR (scope = 'list_type' AND list_type = ? AND ?)
                    OR (scope = 'global' AND ?))
                ORDER BY CASE scope
                    WHEN 'list' THEN 3
                    WHEN 'list_type' THEN 2
                    ELSE 1
                END DESC
                LIMIT 1
                """,
                (
                    winner["name"], excluded_category_id, list_id,
                    list_row["list_type"], int(type_enabled), int(global_enabled),
                ),
            ).fetchone()
            if effective:
                return effective["id"], effective["name"]
            return winner["id"], winner["name"]
        return None, None

    @staticmethod
    def _normalize_category_rules(patterns: list[str]) -> list[str]:
        """Validate and de-duplicate user-facing wildcard rules."""
        if len(patterns) > 100:
            raise ValueError(localized_text("backend.category_rule_limit"))
        normalized: list[str] = []
        seen: set[str] = set()
        for value in patterns:
            pattern = " ".join(str(value).strip().split())
            if not pattern:
                continue
            if len(pattern) > 100:
                raise ValueError(localized_text("backend.mapping_rule_too_long"))
            if not pattern.replace("*", "").strip():
                raise ValueError(localized_text("backend.assignment_word_required"))
            key = pattern.casefold()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(pattern)
        return normalized

    @staticmethod
    def _category_rule_matches(pattern: str, name: str) -> bool:
        """Match one normalized item name against a simple asterisk pattern."""
        normalized_pattern = " ".join(pattern.casefold().split())
        normalized_name = " ".join(name.casefold().split())
        expression = re.escape(normalized_pattern).replace(r"\*", ".*")
        return re.fullmatch(expression, normalized_name) is not None

    @staticmethod
    def _category_rules_conflict(first: str, second: str) -> bool:
        """Detect direct text conflicts without inventing combined item names."""
        # Arbitrary pattern intersection would reject every pair of contains
        # rules: '*Sauce*' and '*Erdbeeren*' could both match 'Erdbeeren Sauce'.
        # Compare the rules' own literal text instead; real combined names use
        # the normal category priority when they are added.
        return (
            HaListManagerDatabase._category_rule_matches(first, second.replace("*", ""))
            or HaListManagerDatabase._category_rule_matches(second, first.replace("*", ""))
        )

    @staticmethod
    def _ensure_category_rules_unique_in_scope(
        connection: sqlite3.Connection,
        category_id: str,
        patterns: list[str],
        scope: str,
        list_type: str | None,
        list_id: str | None,
    ) -> None:
        """Reject direct rule conflicts on two categories in one scope bucket."""
        if not patterns:
            return
        rows = connection.execute(
            """
            SELECT rules.pattern, categories.name
            FROM category_rules AS rules
            JOIN categories ON categories.id = rules.category_id
            WHERE categories.id != ?
              AND categories.scope = ?
              AND categories.list_type IS ?
              AND categories.list_id IS ?
            """,
            (category_id, scope, list_type, list_id),
        ).fetchall()
        for pattern in patterns:
            for row in rows:
                if HaListManagerDatabase._category_rules_conflict(
                    pattern, row["pattern"]
                ):
                    raise ValueError(
                        localized_text("backend.category_rule_overlap", p0=pattern, p1=row["pattern"], p2=row["name"])
                    )

    def _resolve_category_rule(
        self, list_id: str, name: str
    ) -> CategoryRecord | None:
        """Resolve an automatic rule for frontend previews."""
        with self._connect() as connection:
            category_id, _category_name = self._resolve_category_rule_for_list(
                connection, list_id, name
            )
            if category_id is None:
                return None
            row = connection.execute(
                "SELECT * FROM categories WHERE id = ?", (category_id,)
            ).fetchone()
        return self._category_record_from_row(row)

    def _resolve_chip_categories(
        self, list_id: str, candidates: list[dict[str, str | None]]
    ) -> dict[str, CategoryRecord | None]:
        """Resolve product assignments and name rules for chip presentation."""
        resolved: dict[str, CategoryRecord | None] = {}
        with self._connect() as connection:
            self._require_list(connection, list_id)
            for candidate in candidates:
                key = str(candidate["key"])
                product_id = candidate.get("product_id")
                rule_name = str(candidate["name"])
                if product_id:
                    category_id, _category_name = self._resolve_product_category_for_list(
                        connection, str(product_id), list_id
                    )
                    product_row = connection.execute(
                        "SELECT name FROM products WHERE id = ?", (str(product_id),)
                    ).fetchone()
                    if product_row:
                        rule_name = product_row["name"]
                else:
                    category_id = None
                if category_id is None:
                    category_id, _category_name = self._resolve_category_rule_for_list(
                        connection, list_id, rule_name
                    )
                if category_id is None:
                    resolved[key] = None
                    continue
                row = connection.execute(
                    "SELECT * FROM categories WHERE id = ?", (category_id,)
                ).fetchone()
                resolved[key] = self._category_record_from_row(row) if row else None
        return resolved

    @staticmethod
    def _resolve_category_rule_for_list(
        connection: sqlite3.Connection, list_id: str, name: str
    ) -> tuple[str | None, str | None]:
        """Resolve the strongest visible automatic rule for a new list item."""
        list_row = connection.execute(
            "SELECT list_type, use_global_categories, use_type_categories "
            "FROM lists WHERE id = ?", (list_id,)
        ).fetchone()
        if list_row is None:
            raise ListNotFoundError(list_id)
        rows = connection.execute(
            """
            SELECT rules.pattern, rules.position AS rule_position,
                   categories.*
            FROM category_rules AS rules
            JOIN categories ON categories.id = rules.category_id
            WHERE (categories.scope = 'list' AND categories.list_id = ?)
               OR (categories.scope = 'list_type' AND categories.list_type = ? AND ?)
               OR (categories.scope = 'global' AND ?)
            ORDER BY categories.position, categories.name COLLATE NOCASE,
                     categories.id, rules.position
            """,
            (
                list_id,
                list_row["list_type"],
                int(bool(list_row["use_type_categories"])),
                int(bool(list_row["use_global_categories"])),
            ),
        ).fetchall()
        matches = [
            row for row in rows
            if HaListManagerDatabase._category_rule_matches(row["pattern"], name)
        ]
        if not matches:
            return None, None
        scope_rank = {"global": 1, "list_type": 2, "list": 3}
        winner = max(
            matches,
            key=lambda row: (
                scope_rank[row["scope"]],
                int("*" not in row["pattern"]),
                len(row["pattern"].replace("*", "")),
                -int(row["rule_position"]),
            ),
        )
        effective = connection.execute(
            """
            SELECT * FROM categories
            WHERE lower(name) = lower(?)
              AND ((scope = 'list' AND list_id = ?)
                OR (scope = 'list_type' AND list_type = ? AND ?)
                OR (scope = 'global' AND ?))
            ORDER BY CASE scope
                WHEN 'list' THEN 3
                WHEN 'list_type' THEN 2
                ELSE 1
            END DESC
            LIMIT 1
            """,
            (
                winner["name"], list_id, list_row["list_type"],
                int(bool(list_row["use_type_categories"])),
                int(bool(list_row["use_global_categories"])),
            ),
        ).fetchone()
        selected = effective or winner
        return selected["id"], selected["name"]

    @staticmethod
    def _applicable_label_ids(
        connection: sqlite3.Connection, list_id: str
    ) -> set[str]:
        labels = HaListManagerDatabase._applicable_label_records(connection, list_id)
        return {
            label.id for label in HaListManagerDatabase._resolve_scoped_records(labels)
        }

    @staticmethod
    def _applicable_label_records(
        connection: sqlite3.Connection, list_id: str
    ) -> list[LabelRecord]:
        """Return permitted definitions before resolving same-name priority."""
        list_row = connection.execute(
            "SELECT list_type, use_global_labels, use_type_labels "
            "FROM lists WHERE id = ?",
            (list_id,),
        ).fetchone()
        if list_row is None:
            return []
        clauses = []
        values: list[Any] = []
        if list_row["use_global_labels"]:
            clauses.append("scope = 'global'")
        if list_row["use_type_labels"]:
            clauses.append("(scope = 'list_type' AND list_type = ?)")
            values.append(list_row["list_type"])
        clauses.append("(scope = 'list' AND list_id = ?)")
        values.append(list_id)
        rows = connection.execute(
            "SELECT labels.*, 0 AS product_count, 0 AS item_count FROM labels WHERE "
            + " OR ".join(clauses), values
        ).fetchall()
        return [HaListManagerDatabase._label_record_from_row(row) for row in rows]

    @staticmethod
    def _require_list(connection: sqlite3.Connection, list_id: str) -> None:
        if connection.execute(
            "SELECT 1 FROM lists WHERE id = ?", (list_id,)
        ).fetchone() is None:
            raise ListNotFoundError(list_id)

    @staticmethod
    def _require_product(connection: sqlite3.Connection, product_id: str) -> None:
        if connection.execute(
            "SELECT 1 FROM products WHERE id = ?", (product_id,)
        ).fetchone() is None:
            raise ProductNotFoundError(product_id)

    @staticmethod
    def _record_from_row(row: sqlite3.Row) -> ListRecord:
        return ListRecord(
            id=row["id"],
            name=row["name"],
            list_type=row["list_type"],
            provider=row["provider"],
            external_entity_id=row["external_entity_id"],
            icon=row["icon"],
            label_conflict_policy=row["label_conflict_policy"],
            use_global_categories=bool(row["use_global_categories"]),
            use_type_categories=bool(row["use_type_categories"]),
            use_global_labels=bool(row["use_global_labels"]),
            use_type_labels=bool(row["use_type_labels"]),
            use_list_labels=bool(row["use_list_labels"]),
            use_global_chips=bool(row["use_global_chips"]),
            use_type_chips=bool(row["use_type_chips"]),
            use_dishes=bool(row["use_dishes"]),
            use_tandoor=bool(row["use_tandoor"]),
            tandoor_skip_small_units=bool(row["tandoor_skip_small_units"]),
            tandoor_include_ingredients=bool(row["tandoor_include_ingredients"]),
            tandoor_excluded_units=str(row["tandoor_excluded_units"] or ""),
            tandoor_result_limit=int(row["tandoor_result_limit"]),
            enabled=bool(row["enabled"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            capitalize_first_letter=bool(row["capitalize_first_letter"]),
            auto_delete_completed=bool(row["auto_delete_completed"]),
            auto_delete_delay_minutes=int(row["auto_delete_delay_minutes"]),
            auto_delete_confirm=bool(row["auto_delete_confirm"]),
        )

    @staticmethod
    def _scanner_record_from_row(row: sqlite3.Row) -> ScannerRecord:
        return ScannerRecord(
            id=row["id"], name=row["name"], address=row["address"],
            enabled=bool(row["enabled"]), routing=row["routing"],
            list_id=row["list_id"], action=row["action"],
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    @staticmethod
    def _scanner_target_from_row(row: sqlite3.Row) -> ScannerTargetRecord:
        return ScannerTargetRecord(
            list_id=row["list_id"], action=row["action"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _notification_profile_from_row(
        row: sqlite3.Row,
    ) -> NotificationProfileRecord:
        return NotificationProfileRecord(
            id=row["id"], name=row["name"], provider=row["provider"],
            target=row["target"], title=row["title"],
            click_url=row["click_url"],
            message_format=row["message_format"], enabled=bool(row["enabled"]),
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    @staticmethod
    def _notification_pending_batch_from_row(
        row: sqlite3.Row,
    ) -> NotificationPendingBatchRecord:
        return NotificationPendingBatchRecord(
            list_id=row["list_id"], profile_id=row["profile_id"],
            due_at=row["due_at"], changes_json=row["changes_json"],
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    @staticmethod
    def _validate_notification_profile(provider: str, message_format: str) -> None:
        if provider not in {"notify_entity", "notify_service", "ntfy", "persistent"}:
            raise ValueError(localized_text("backend.notification_provider_unsupported", provider=provider))
        if message_format not in {"plain", "markdown", "html"}:
            raise ValueError(localized_text("backend.message_format_unsupported", format=message_format))
        if provider in {"persistent", "ntfy"} and message_format == "html":
            raise ValueError(localized_text("backend.provider_html_unsupported", provider=provider))

    @staticmethod
    def _scan_history_from_row(row: sqlite3.Row) -> ScanHistoryRecord:
        return ScanHistoryRecord(
            id=row["id"], scanned_at=row["scanned_at"],
            scanner_id=row["scanner_id"], scanner_name=row["scanner_name"],
            scanner_address=row["scanner_address"], source=row["source"],
            ean=row["ean"], action=row["action"], list_id=row["list_id"],
            product_id=row["product_id"], product_name=row["product_name"],
            inventory_entry_id=row["inventory_entry_id"],
            quantity=int(row["quantity"]), stock_before=row["stock_before"],
            stock_after=row["stock_after"], status=row["status"],
            message=row["message"],
        )

    @staticmethod
    def _category_record_from_row(row: sqlite3.Row) -> CategoryRecord:
        return CategoryRecord(
            id=row["id"],
            name=row["name"],
            scope=row["scope"],
            list_type=row["list_type"],
            list_id=row["list_id"],
            icon=row["icon"],
            color=row["color"],
            position=row["position"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _validate_recurrence(
        interval: int | None, unit: str | None
    ) -> tuple[int | None, str | None]:
        if interval is None and unit is None:
            return None, None
        if not isinstance(interval, int) or isinstance(interval, bool) or interval < 1 or interval > 1000000:
            raise ValueError(localized_text("backend.recurrence_interval_range"))
        normalized_unit = str(unit or "").upper()
        if normalized_unit not in {"H", "D", "M"}:
            raise ValueError(localized_text("backend.recurrence_unit_invalid"))
        return interval, normalized_unit

    @staticmethod
    def _validate_category_scope(
        scope: str, list_type: str | None, list_id: str | None
    ) -> tuple[str, str | None, str | None]:
        if scope not in {"global", "list_type", "list"}:
            raise ValueError(localized_text("backend.category_scope_invalid"))
        if scope == "list_type":
            if list_type not in {"shopping", "inventory", "todo"}:
                raise ValueError(localized_text("backend.select_valid_list_type"))
            return scope, list_type, None
        if scope == "list":
            if not list_id:
                raise ValueError(localized_text("backend.select_list"))
            return scope, None, list_id
        return "global", None, None

    @staticmethod
    def _resolve_scoped_records(
        records: list[_T], key_attribute: str = "name"
    ) -> list[_T]:
        """Keep the most specific same-named definition."""
        rank = {"global": 1, "list_type": 2, "list": 3}
        selected: dict[str, _T] = {}
        for record in records:
            key = getattr(record, key_attribute).casefold()
            current = selected.get(key)
            if current is None or rank[record.scope] > rank[current.scope]:
                selected[key] = record
        return sorted(selected.values(), key=lambda item: item.name.casefold())

    @staticmethod
    def _item_record_from_row(
        row: sqlite3.Row | dict[str, Any], labels: tuple[LabelRecord, ...] = ()
    ) -> ListItemRecord:
        keys = row.keys()
        return ListItemRecord(
            id=row["id"],
            list_id=row["list_id"],
            product_id=row["product_id"],
            external_uid=row["external_uid"],
            name=row["name"],
            description=row["description"],
            quantity=int(row["quantity"]),
            category_id=row["category_id"],
            category=row["category"],
            due_at=row["due_at"],
            recurrence_interval=(
                int(row["recurrence_interval"])
                if row["recurrence_interval"] is not None else None
            ),
            recurrence_unit=row["recurrence_unit"],
            completed=bool(row["completed"]),
            position=int(row["position"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            inventory_source_type=(
                row["inventory_source_type"] if "inventory_source_type" in keys else None
            ),
            inventory_source_id=(
                row["inventory_source_id"] if "inventory_source_id" in keys else None
            ),
            offer_only=bool(row["offer_only"]) if "offer_only" in keys else False,
            completed_delete_at=row["completed_delete_at"] if "completed_delete_at" in keys else None,
            labels=labels,
        )

    @staticmethod
    def _product_record_from_row(
        row: sqlite3.Row,
        labels: tuple[LabelRecord, ...] = (),
        category_assignments: tuple[ProductCategoryAssignmentRecord, ...] = (),
    ) -> ProductRecord:
        return ProductRecord(
            id=row["id"],
            ean=row["ean"],
            name=row["name"],
            original_name=row["original_name"],
            brand=row["brand"],
            package_quantity=row["package_quantity"],
            category=row["category"],
            image_url=row["image_url"],
            source=row["source"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            labels=labels,
            category_assignments=category_assignments,
        )

    @staticmethod
    def _label_record_from_row(row: sqlite3.Row) -> LabelRecord:
        return LabelRecord(
            id=row["id"],
            name=row["name"],
            icon=row["icon"],
            color=row["color"],
            scope=row["scope"],
            list_type=row["list_type"],
            list_id=row["list_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            product_count=row["product_count"],
            item_count=row["item_count"],
        )

    @staticmethod
    def _chip_record_from_row(row: sqlite3.Row) -> ChipRecord:
        template_data = None
        if row["template_json"]:
            try:
                decoded = json.loads(row["template_json"])
                template_data = decoded if isinstance(decoded, dict) else None
            except (TypeError, ValueError):
                template_data = None
        return ChipRecord(
            id=row["id"],
            name=row["name"],
            priority_name=row["priority_name"],
            chip_kind=row["chip_kind"],
            icon=row["icon"],
            color=row["color"],
            scope=row["scope"],
            list_type=row["list_type"],
            list_id=row["list_id"],
            product_id=row["product_id"],
            product_name=row["product_name"],
            template_data=template_data,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _validate_list_type(list_type: str) -> None:
        if list_type not in LIST_TYPES:
            raise ValueError(localized_text("backend.list_type_unsupported", type=list_type))

    @staticmethod
    def _validate_label_conflict_policy(policy: str) -> None:
        if policy not in {"specific", "separate", "global"}:
            raise ValueError(localized_text("backend.duplicate_label_setting_invalid"))

    @staticmethod
    def _validate_label_scope(
        scope: str, list_type: str | None, list_id: str | None
    ) -> tuple[str, str | None, str | None]:
        if scope not in {"global", "list_type", "list"}:
            raise ValueError(localized_text("backend.invalid_label_scope"))
        if scope == "list_type":
            if list_type not in {"shopping", "inventory", "todo"}:
                raise ValueError(localized_text("backend.select_valid_list_type"))
            return scope, list_type, None
        if scope == "list":
            if not list_id:
                raise ValueError(localized_text("backend.select_list"))
            return scope, None, list_id
        return "global", None, None

    @staticmethod
    def _validate_chip_scope(
        scope: str, list_type: str | None, list_id: str | None
    ) -> tuple[str, str | None, str | None]:
        if scope not in {"global", "list_type", "list"}:
            raise ValueError(localized_text("backend.invalid_chip_scope"))
        if scope == "list_type":
            if list_type not in {"shopping", "inventory", "todo"}:
                raise ValueError(localized_text("backend.select_valid_list_type"))
            return scope, list_type, None
        if scope == "list":
            if not list_id:
                raise ValueError(localized_text("backend.select_list"))
            return scope, None, list_id
        return "global", None, None

    @staticmethod
    def _validate_todo_template_data(
        chip_kind: str, template_data: dict[str, Any] | None, fallback_name: str
    ) -> dict[str, Any] | None:
        if chip_kind == "entry":
            if template_data:
                raise ValueError(localized_text("backend.item_chip_todo_template"))
            return None
        if chip_kind != "todo_template":
            raise ValueError(localized_text("backend.chip_type_invalid"))
        data = dict(template_data or {})
        item_name = str(data.get("item_name") or fallback_name).strip()
        if not item_name or len(item_name) > 200:
            raise ValueError(localized_text("backend.task_name_invalid"))
        description = str(data.get("description") or "").strip() or None
        if description and len(description) > 2000:
            raise ValueError(localized_text("backend.description_too_long"))
        due_mode = str(data.get("due_mode") or "none")
        if due_mode not in {"none", "today", "tomorrow", "offset", "next_weekday"}:
            raise ValueError(localized_text("backend.invalid_due_rule"))
        due_time = str(data.get("due_time") or "").strip() or None
        if due_time and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", due_time):
            raise ValueError(localized_text("backend.time_format_required"))
        offset_value = data.get("due_offset_value")
        if due_mode == "offset":
            if not isinstance(offset_value, int) or not 1 <= offset_value <= 1000000:
                raise ValueError(localized_text("backend.due_offset_range"))
        else:
            offset_value = None
        offset_unit = str(data.get("due_offset_unit") or "D")
        if offset_unit not in {"H", "D", "M"}:
            raise ValueError(localized_text("backend.due_offset_unit_invalid"))
        weekday = data.get("due_weekday")
        if due_mode == "next_weekday":
            if not isinstance(weekday, int) or not 0 <= weekday <= 6:
                raise ValueError(localized_text("backend.weekday_invalid"))
        else:
            weekday = None
        recurrence_interval = data.get("recurrence_interval")
        recurrence_unit = data.get("recurrence_unit")
        if recurrence_interval in (None, ""):
            recurrence_interval = None
            recurrence_unit = None
        elif (
            not isinstance(recurrence_interval, int)
            or not 1 <= recurrence_interval <= 1000000
            or recurrence_unit not in {"H", "D", "M"}
        ):
            raise ValueError(localized_text("backend.repeat_interval_invalid"))
        add_mode = str(data.get("add_mode") or "direct")
        if add_mode not in {"direct", "edit"}:
            raise ValueError(localized_text("backend.invalid_add_behavior"))
        label_ids = data.get("label_ids") or []
        if not isinstance(label_ids, list) or any(not isinstance(value, str) for value in label_ids):
            raise ValueError(localized_text("backend.label_selection_invalid"))
        return {
            "item_name": item_name,
            "description": description,
            "category_id": str(data.get("category_id") or "").strip() or None,
            "category_name": str(data.get("category_name") or "").strip() or None,
            "label_ids": list(dict.fromkeys(label_ids)),
            "due_mode": due_mode,
            "due_time": due_time,
            "due_offset_value": offset_value,
            "due_offset_unit": offset_unit,
            "due_weekday": weekday,
            "recurrence_interval": recurrence_interval,
            "recurrence_unit": recurrence_unit,
            "add_mode": add_mode,
        }

    @staticmethod
    def _validate_chip_target(
        connection: sqlite3.Connection, chip_kind: str, scope: str,
        list_type: str | None, list_id: str | None, product_id: str | None,
    ) -> None:
        target_type = list_type
        if scope == "list":
            row = connection.execute(
                "SELECT list_type FROM lists WHERE id = ?", (list_id,)
            ).fetchone()
            if row is None:
                raise ListNotFoundError(str(list_id))
            target_type = row["list_type"]
        if chip_kind == "todo_template":
            if scope == "global" or target_type != "todo":
                raise ValueError(localized_text("backend.todo_templates_wrong_list"))
            if product_id is not None:
                raise ValueError(localized_text("backend.todo_template_product_forbidden"))
        elif chip_kind == "entry":
            if target_type == "todo":
                raise ValueError(localized_text("backend.item_chips_todo_forbidden"))
        else:
            raise ValueError(localized_text("backend.chip_type_invalid"))

    @staticmethod
    def _validate_list_provider(
        list_type: str, provider: str, external_entity_id: str | None
    ) -> None:
        if provider not in {"local", "bring"}:
            raise ValueError(localized_text("backend.list_provider_unsupported", provider=provider))
        if provider == "bring":
            if list_type != "shopping":
                raise ValueError(localized_text("backend.bring_shopping_only"))
            if not external_entity_id or not external_entity_id.startswith("todo."):
                raise ValueError(localized_text("backend.bring_todo_required"))
        elif external_entity_id is not None:
            raise ValueError(localized_text("backend.local_external_entity_forbidden"))

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()
