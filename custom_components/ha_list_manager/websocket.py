"""Authenticated card operations and administrator-only management API."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import UTC, datetime
from functools import wraps
from typing import Any

import probatio

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from .localization import (
    async_use_language,
    error_translation_metadata,
    system_language,
    text as localized_text,
)
from .const import (
    DATABASE_SCHEMA_VERSION,
    DATA_WEBSOCKET_REGISTERED,
    DOMAIN,
    EVENT_INVENTORY_CHANGED,
    EVENT_ITEMS_CHANGED,
    EVENT_LISTS_CHANGED,
    EVENT_SCAN_PROCESSED,
    EVENT_SCANNER_TARGET_CHANGED,
    LIST_TYPES,
    SCANNER_ACTIONS,
    SCANNER_ROUTING,
)
from .database import (
    CategoryNotFoundError,
    ChipNotFoundError,
    DuplicateEANError,
    DuplicateCategoryError,
    DuplicateChipError,
    DishNotFoundError,
    DishesDisabledError,
    DuplicateDishError,
    DuplicateInventoryProductError,
    DuplicateInventoryGroupError,
    DuplicateListNameError,
    DuplicateNotificationProfileNameError,
    DuplicateLabelError,
    InventoryEntryNotFoundError,
    InventoryGroupNotFoundError,
    InventoryListRequiredError,
    InvalidInventoryGroupMembersError,
    LabelNotFoundError,
    ListItemNotFoundError,
    ListNotFoundError,
    NotificationProfileNotFoundError,
    ProductNotFoundError,
    DuplicateScannerAddressError,
    ScannerNotFoundError,
    ScopeChangeConfirmationRequired,
)
from .open_facts import OpenFactsLookupError, async_lookup_open_facts
from .external_lists import ExternalListError
from .entity_history_import import async_import_entity_history
from .runtime import HaListManagerRuntime
from .scanner import normalize_scanner_address
from .tandoor import TandoorClient, TandoorError, normalize_tandoor_url

NOTIFICATION_PROVIDERS = {"notify_entity", "notify_service", "ntfy", "persistent"}
NOTIFICATION_FORMATS = {"plain", "markdown", "html"}


def localized_command(schema):
    """Accept a UI language without changing command IDs or permissions."""
    def decorate(handler):
        @websocket_api.async_response
        @wraps(handler)
        async def localized_handler(hass, connection, msg):
            request = {key: value for key, value in msg.items() if key != "language"}
            async with async_use_language(hass, msg.get("language") or system_language()):
                return await handler(hass, connection, request)
        return websocket_api.websocket_command({**schema, probatio.Optional("language"): str})(localized_handler)
    return decorate


def _runtime(hass: HomeAssistant) -> HaListManagerRuntime:
    return hass.data[DOMAIN]


def _entity_history_display_options(hass, entity_id, use_ha_precision) -> dict[str, Any]:
    """Read current HA presentation metadata without altering stored samples."""
    registry_entry = er.async_get(hass).async_get(entity_id)
    entry_options = getattr(registry_entry, "options", None)
    options = entry_options.get("sensor") if isinstance(entry_options, Mapping) else None
    precision = None
    if isinstance(options, Mapping):
        precision = options.get("display_precision")
        if precision is None:
            precision = options.get("suggested_display_precision")
        if type(precision) is not int or precision < 0:
            precision = None
    return {
        "use_ha_precision": use_ha_precision,
        "display_precision": precision,
    }


def _send_error(connection, msg_id, code, message):
    """Keep API error codes while supplying HA's standard translation fields."""
    metadata = error_translation_metadata(message)
    if isinstance(message, HomeAssistantError) and getattr(message, "translation_key", None):
        metadata = {
            "translation_domain": message.translation_domain,
            "translation_key": message.translation_key,
            "translation_placeholders": message.translation_placeholders,
        }
    connection.send_error(msg_id, code, str(message), **metadata)


def _require_list_context(connection, msg: dict[str, Any]) -> bool:
    """Expose effective list choices without opening unscoped administration."""
    if connection.user.is_admin or str(msg.get("list_id") or "").strip():
        return True
    _send_error(connection, msg["id"], "unauthorized", localized_text("errors.unauthorized"))
    return False


def _clean_text(value: Any, *, maximum: int, required: bool) -> str | None:
    if value is None:
        if required:
            raise ValueError(localized_text("errors.value_required"))
        return None
    cleaned = str(value).strip()
    if required and not cleaned:
        raise ValueError(localized_text("errors.value_required"))
    if len(cleaned) > maximum:
        raise ValueError(localized_text("errors.text_too_long", maximum=maximum))
    return cleaned or None


def _send_input_error(
    connection: websocket_api.ActiveConnection, msg: dict[str, Any], error: Exception
) -> None:
    _send_error(connection, msg["id"], websocket_api.ERR_INVALID_FORMAT, error)


def _fire_lists_changed(hass: HomeAssistant, list_id: str | None = None) -> None:
    """Notify entity platforms and open administration panels about list changes."""
    hass.bus.async_fire(EVENT_LISTS_CHANGED, {"list_id": list_id})


def _fire_items_changed(hass: HomeAssistant, list_id: str) -> None:
    """Notify the matching To-do entity after an item mutation."""
    hass.bus.async_fire(EVENT_ITEMS_CHANGED, {"list_id": list_id})


async def _alexa_result(hass, connection, msg, operation, **kwargs) -> None:
    """Keep the fixed Alexa intake administrative, including its diagnostics."""
    try:
        manager = _runtime(hass).alexa
        result = await getattr(manager, operation)(**kwargs)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except HomeAssistantError as error:
        _send_error(connection, msg["id"], "alexa_error", error)
        return
    except Exception:
        _send_error(connection, msg["id"], "alexa_error", localized_text("alexa.processing_failed"))
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@localized_command({probatio.Required("type"): f"{DOMAIN}/alexa/get"})
async def websocket_alexa_get(hass, connection, msg) -> None:
    """Return settings, eligible sources and the durable intake status."""
    await _alexa_result(hass, connection, msg, "async_get")


@websocket_api.require_admin
@localized_command({probatio.Required("type"): f"{DOMAIN}/alexa/set", probatio.Required("settings"): dict})
async def websocket_alexa_set(hass, connection, msg) -> None:
    """Configure one source and one fixed local shopping target."""
    await _alexa_result(hass, connection, msg, "async_set", values=msg["settings"])


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/alexa/aliases/set",
    probatio.Required("aliases"): list,
    probatio.Required("expected_aliases"): list,
})
async def websocket_alexa_aliases_set(hass, connection, msg) -> None:
    """Persist alias CRUD without overwriting settings from other editors."""
    await _alexa_result(hass, connection, msg, "async_set_aliases",
                       aliases=msg["aliases"], expected_aliases=msg["expected_aliases"])


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/alexa/outbox/resolve",
    probatio.Required("job_id"): str,
    probatio.Required("action"): probatio.In({"bind", "cancel"}),
    probatio.Optional("uid"): str,
})
async def websocket_alexa_outbox_resolve(hass, connection, msg) -> None:
    """Resolve a create acknowledgement without retrying the cloud create."""
    await _alexa_result(hass, connection, msg, "async_resolve_outbox",
                       job_id=msg["job_id"], action=msg["action"], uid=msg.get("uid"))


@websocket_api.require_admin
@localized_command({probatio.Required("type"): f"{DOMAIN}/alexa/preview"})
async def websocket_alexa_preview(hass, connection, msg) -> None:
    """Preview existing open entries without importing or cleaning anything."""
    await _alexa_result(hass, connection, msg, "async_preview")


@websocket_api.require_admin
@localized_command({probatio.Required("type"): f"{DOMAIN}/alexa/process", probatio.Optional("include_existing", default=False): bool})
async def websocket_alexa_process(hass, connection, msg) -> None:
    """Retry intake, or explicitly include the entries excluded at activation."""
    await _alexa_result(hass, connection, msg, "async_process", include_existing=msg.get("include_existing", False))


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/alexa/test",
    probatio.Required("settings"): dict,
    probatio.Required("text"): str,
})
async def websocket_alexa_test(hass, connection, msg) -> None:
    """Test an unsaved recognition draft without changing lists or settings."""
    await _alexa_result(hass, connection, msg, "async_test", settings=msg["settings"], input_text=msg["text"])


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/alexa/rules",
    probatio.Required("language_code"): str,
    probatio.Required("kind"): probatio.In({"numbers", "units"}),
    probatio.Optional("query", default=""): str,
    probatio.Optional("offset", default=0): int,
    probatio.Optional("limit", default=50): int,
})
async def websocket_alexa_rules(hass, connection, msg) -> None:
    """Return one bounded page of shipped recognition rules for a language."""
    await _alexa_result(hass, connection, msg, "async_rules", language_code=msg["language_code"],
                       kind=msg["kind"], query=msg["query"], offset=msg["offset"], limit=msg["limit"])


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register commands once for the current Home Assistant process."""
    if hass.data.get(DATA_WEBSOCKET_REGISTERED):
        return
    hass.data[DATA_WEBSOCKET_REGISTERED] = True

    websocket_api.async_register_command(hass, websocket_alexa_get)
    websocket_api.async_register_command(hass, websocket_alexa_set)
    websocket_api.async_register_command(hass, websocket_alexa_aliases_set)
    websocket_api.async_register_command(hass, websocket_alexa_outbox_resolve)
    websocket_api.async_register_command(hass, websocket_alexa_preview)
    websocket_api.async_register_command(hass, websocket_alexa_process)
    websocket_api.async_register_command(hass, websocket_alexa_test)
    websocket_api.async_register_command(hass, websocket_alexa_rules)

    websocket_api.async_register_command(hass, websocket_subscribe)
    websocket_api.async_register_command(hass, websocket_get_list_script_settings)
    websocket_api.async_register_command(hass, websocket_set_list_script_settings)
    websocket_api.async_register_command(hass, websocket_info)
    websocket_api.async_register_command(hass, websocket_list_favorites)
    websocket_api.async_register_command(hass, websocket_set_favorite)
    websocket_api.async_register_command(hass, websocket_list_lists)
    websocket_api.async_register_command(hass, websocket_create_list)
    websocket_api.async_register_command(hass, websocket_update_list)
    websocket_api.async_register_command(hass, websocket_list_scope_impact)
    websocket_api.async_register_command(hass, websocket_delete_list)
    websocket_api.async_register_command(hass, websocket_sync_external_list)
    websocket_api.async_register_command(hass, websocket_list_items)
    websocket_api.async_register_command(hass, websocket_create_item)
    websocket_api.async_register_command(hass, websocket_item_action_chip)
    websocket_api.async_register_command(hass, websocket_item_action_rule)
    websocket_api.async_register_command(hass, websocket_item_action_send)
    websocket_api.async_register_command(hass, websocket_update_item)
    websocket_api.async_register_command(hass, websocket_set_item_completed)
    websocket_api.async_register_command(hass, websocket_reorder_items)
    websocket_api.async_register_command(hass, websocket_delete_item)
    websocket_api.async_register_command(hass, websocket_list_products)
    websocket_api.async_register_command(hass, websocket_lookup_product)
    websocket_api.async_register_command(hass, websocket_create_product)
    websocket_api.async_register_command(hass, websocket_update_product)
    websocket_api.async_register_command(hass, websocket_list_category_products)
    websocket_api.async_register_command(hass, websocket_set_product_list_category)
    websocket_api.async_register_command(hass, websocket_delete_product)
    websocket_api.async_register_command(hass, websocket_get_settings)
    websocket_api.async_register_command(hass, websocket_update_settings)
    websocket_api.async_register_command(hass, websocket_test_tandoor)
    websocket_api.async_register_command(hass, websocket_list_tandoor_categories)
    websocket_api.async_register_command(hass, websocket_search_tandoor_recipes)
    websocket_api.async_register_command(hass, websocket_get_tandoor_recipe)
    websocket_api.async_register_command(hass, websocket_list_categories)
    websocket_api.async_register_command(hass, websocket_list_category_rules)
    websocket_api.async_register_command(hass, websocket_set_category_rules)
    websocket_api.async_register_command(hass, websocket_resolve_category_rule)
    websocket_api.async_register_command(hass, websocket_resolve_chip_categories)
    websocket_api.async_register_command(hass, websocket_create_category)
    websocket_api.async_register_command(hass, websocket_update_category)
    websocket_api.async_register_command(hass, websocket_delete_category)
    websocket_api.async_register_command(hass, websocket_get_category_order)
    websocket_api.async_register_command(hass, websocket_set_category_order)
    websocket_api.async_register_command(hass, websocket_reset_category_order)
    websocket_api.async_register_command(hass, websocket_list_labels)
    websocket_api.async_register_command(hass, websocket_create_label)
    websocket_api.async_register_command(hass, websocket_update_label)
    websocket_api.async_register_command(hass, websocket_delete_label)
    websocket_api.async_register_command(hass, websocket_list_chips)
    websocket_api.async_register_command(hass, websocket_create_chip)
    websocket_api.async_register_command(hass, websocket_update_chip)
    websocket_api.async_register_command(hass, websocket_delete_chip)
    websocket_api.async_register_command(hass, websocket_list_dishes)
    websocket_api.async_register_command(hass, websocket_create_dish)
    websocket_api.async_register_command(hass, websocket_update_dish)
    websocket_api.async_register_command(hass, websocket_delete_dish)
    websocket_api.async_register_command(hass, websocket_add_dish_to_list)
    websocket_api.async_register_command(hass, websocket_list_label_filters)
    websocket_api.async_register_command(hass, websocket_save_label_filter)
    websocket_api.async_register_command(hass, websocket_delete_label_filter)
    websocket_api.async_register_command(hass, websocket_list_important_chips)
    websocket_api.async_register_command(hass, websocket_set_important_chip)
    websocket_api.async_register_command(hass, websocket_list_inventory_lists)
    websocket_api.async_register_command(hass, websocket_list_inventory)
    websocket_api.async_register_command(hass, websocket_inventory_options)
    websocket_api.async_register_command(hass, websocket_inventory_lookup_product)
    websocket_api.async_register_command(hass, websocket_add_inventory_product)
    websocket_api.async_register_command(hass, websocket_create_inventory_entry)
    websocket_api.async_register_command(hass, websocket_update_inventory_entry)
    websocket_api.async_register_command(hass, websocket_adjust_inventory_entry)
    websocket_api.async_register_command(hass, websocket_undo_inventory_booking)
    websocket_api.async_register_command(hass, websocket_get_inventory_restock_settings)
    websocket_api.async_register_command(hass, websocket_set_inventory_restock_settings)
    websocket_api.async_register_command(hass, websocket_preview_inventory_restock)
    websocket_api.async_register_command(hass, websocket_apply_inventory_restock)
    websocket_api.async_register_command(hass, websocket_reset_inventory_restock_latch)
    websocket_api.async_register_command(hass, websocket_confirm_zero_stock_restock)
    websocket_api.async_register_command(hass, websocket_set_inventory_hidden)
    websocket_api.async_register_command(hass, websocket_delete_inventory_entry)
    websocket_api.async_register_command(hass, websocket_list_inventory_groups)
    websocket_api.async_register_command(hass, websocket_create_inventory_group)
    websocket_api.async_register_command(hass, websocket_update_inventory_group)
    websocket_api.async_register_command(hass, websocket_delete_inventory_group)
    websocket_api.async_register_command(hass, websocket_list_scanners)
    websocket_api.async_register_command(hass, websocket_create_scanner)
    websocket_api.async_register_command(hass, websocket_update_scanner)
    websocket_api.async_register_command(hass, websocket_delete_scanner)
    websocket_api.async_register_command(hass, websocket_get_scanner_target)
    websocket_api.async_register_command(hass, websocket_set_scanner_target)
    websocket_api.async_register_command(hass, websocket_clear_scanner_target)
    websocket_api.async_register_command(hass, websocket_simulate_scan)
    websocket_api.async_register_command(hass, websocket_pending_scans)
    websocket_api.async_register_command(hass, websocket_pending_scans_for_list)
    websocket_api.async_register_command(hass, websocket_hold_pending_scan)
    websocket_api.async_register_command(hass, websocket_view_pending_scan)
    websocket_api.async_register_command(hass, websocket_edit_pending_scan)
    websocket_api.async_register_command(hass, websocket_release_pending_scan)
    websocket_api.async_register_command(hass, websocket_discard_pending_scan)
    websocket_api.async_register_command(hass, websocket_resolve_pending_scan)
    websocket_api.async_register_command(hass, websocket_dismiss_pending_scan)
    websocket_api.async_register_command(hass, websocket_scan_history)
    websocket_api.async_register_command(hass, websocket_list_notification_profiles)
    websocket_api.async_register_command(hass, websocket_create_notification_profile)
    websocket_api.async_register_command(hass, websocket_update_notification_profile)
    websocket_api.async_register_command(hass, websocket_delete_notification_profile)
    websocket_api.async_register_command(hass, websocket_list_notification_assignments)
    websocket_api.async_register_command(hass, websocket_set_notification_assignments)
    websocket_api.async_register_command(hass, websocket_test_notification_profile)
    websocket_api.async_register_command(hass, websocket_send_list_notification)
    websocket_api.async_register_command(hass, websocket_list_tracked_entities)
    websocket_api.async_register_command(hass, websocket_set_entity_tracking)
    websocket_api.async_register_command(hass, websocket_delete_entity_history)
    websocket_api.async_register_command(hass, websocket_hide_unavailable_entity_states)
    websocket_api.async_register_command(hass, websocket_get_entity_history)
    websocket_api.async_register_command(hass, websocket_save_entity_sample)
    websocket_api.async_register_command(hass, websocket_delete_entity_sample)
    websocket_api.async_register_command(hass, websocket_import_entity_history)
    websocket_api.async_register_command(hass, websocket_legacy_import_analyze)
    websocket_api.async_register_command(hass, websocket_legacy_import_preview)
    websocket_api.async_register_command(hass, websocket_legacy_import_apply)


def _legacy_import_manager(hass):
    from .legacy_import_manager import LegacyImportManager
    runtime = _runtime(hass)
    if runtime.legacy_import is None:
        runtime.legacy_import = LegacyImportManager(hass, runtime)
    return runtime.legacy_import


async def _legacy_import_response(connection, msg, operation):
    from .data_backup import BackupError
    from .legacy_import import LegacyImportError
    try:
        result = await operation
    except LegacyImportError as error:
        values = error.values
        field_key = {
            "entry": "import.field_entry", "uid": "import.field_uid",
            "summary": "import.field_summary", "name": "import.field_name",
            "description": "import.field_description", "category": "import.field_category",
            "quantity": "import.field_quantity", "recurrence_interval": "import.field_interval",
            "status": "import.field_status", "due": "import.field_due",
        }.get(values.get("field"))
        if field_key:
            values = {**values, "field": localized_text(field_key)}
        _send_error(connection, msg["id"], error.code,
                    localized_text(error.translation_key, **values))
    except DuplicateListNameError:
        _send_error(connection, msg["id"], "target_exists", localized_text("import.target_exists"))
    except BackupError:
        _send_error(connection, msg["id"], "backup_failed", localized_text("import.backup_failed"))
    except Exception:
        # Parser/service exceptions may contain old YAML or credentials.
        _send_error(connection, msg["id"], "import_failed", localized_text("import.import_failed"))
    else:
        connection.send_result(msg["id"], result)


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/legacy_import/analyze",
    probatio.Required("yaml"): str,
    probatio.Optional("files"): dict,
})
async def websocket_legacy_import_analyze(hass, connection, msg):
    """Retain only supported, sanitized legacy configuration fields."""
    await _legacy_import_response(connection, msg, _legacy_import_manager(hass).analyze(
        connection.user.id, msg["yaml"], msg.get("files"),
    ))


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/legacy_import/preview",
    probatio.Required("draft_id"): str,
    probatio.Required("sources"): [dict],
    probatio.Optional("include_items", default=True): bool,
})
async def websocket_legacy_import_preview(hass, connection, msg):
    """Read selected To-do sources without modifying any data."""
    await _legacy_import_response(connection, msg, _legacy_import_manager(hass).preview(
        connection.user.id, msg["draft_id"], msg["sources"], msg.get("include_items", True),
    ))


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/legacy_import/apply",
    probatio.Required("plan_id"): str,
    probatio.Required("confirm"): bool,
})
async def websocket_legacy_import_apply(hass, connection, msg):
    """Commit one confirmed preview, even if its browser disconnects."""
    if msg["confirm"] is not True:
        _send_error(connection, msg["id"], "confirmation_required", localized_text("import.confirmation_required"))
        return
    task = hass.async_create_task(
        _legacy_import_manager(hass).apply(connection.user.id, msg["plan_id"]),
        "HA List Manager legacy import",
    )
    await _legacy_import_response(connection, msg, asyncio.shield(task))


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/subscribe",
    probatio.Required("event_type"): probatio.In({
        EVENT_ITEMS_CHANGED,
        EVENT_LISTS_CHANGED,
        EVENT_INVENTORY_CHANGED,
        EVENT_SCANNER_TARGET_CHANGED,
        EVENT_SCAN_PROCESSED,
    }),
})
async def websocket_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Subscribe cards to their own updates without exposing the HA event bus."""
    @callback
    def forward_event(event) -> None:
        data = event.as_dict().get("data", {})
        if data.get("label_filters") and data.get("user_id") != connection.user.id:
            return
        connection.send_message(websocket_api.event_message(msg["id"], event.as_dict()))

    connection.subscriptions[msg["id"]] = hass.bus.async_listen(
        msg["event_type"], forward_event
    )
    connection.send_result(msg["id"])


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/entity_history/list"}
)
async def websocket_list_tracked_entities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return every configured independent history source."""
    records = await _runtime(hass).database.async_list_tracked_entities()
    connection.send_result(
        msg["id"], {"entities": [
            {**record.as_dict(), **_entity_history_display_options(hass, record.entity_id, record.use_ha_precision)}
            for record in records
        ]}
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/set",
        probatio.Required("entity_id"): str,
        probatio.Optional("enabled"): bool,
        probatio.Optional("ignore_unavailable"): bool,
        probatio.Optional("use_ha_precision"): bool,
    }
)
async def websocket_set_entity_tracking(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Enable or pause storage for one entity without deleting its archive."""
    entity_id = msg["entity_id"].strip().lower()
    if not entity_id or "." not in entity_id:
        _send_error(connection,
            msg["id"], websocket_api.ERR_INVALID_FORMAT, localized_text("errors.entity_id_invalid")
        )
        return
    runtime = _runtime(hass)
    if runtime.entity_history is None:
        _send_error(connection,
            msg["id"], websocket_api.ERR_UNKNOWN_ERROR, localized_text("errors.history_unavailable")
        )
        return
    options = {key: msg[key] for key in ("ignore_unavailable", "use_ha_precision") if key in msg}
    try:
        await runtime.entity_history.async_set_tracking(entity_id, msg.get("enabled"), **options)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    records = await runtime.database.async_list_tracked_entities()
    record = next(item for item in records if item.entity_id == entity_id)
    connection.send_result(msg["id"], {"entity": {
        **record.as_dict(), **_entity_history_display_options(hass, entity_id, record.use_ha_precision),
    }})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/hide_unavailable",
        probatio.Required("entity_id"): str,
    }
)
async def websocket_hide_unavailable_entity_states(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Hide unavailable originals without deleting their import identities."""
    entity_id = msg["entity_id"].strip().lower()
    database = _runtime(hass).database
    try:
        hidden = await database.async_hide_unavailable_entity_states(entity_id)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    records = await database.async_list_tracked_entities()
    record = next(item for item in records if item.entity_id == entity_id)
    connection.send_result(msg["id"], {"hidden": hidden, "entity": record.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/delete",
        probatio.Required("entity_id"): str,
    }
)
async def websocket_delete_entity_history(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete one explicitly selected archive."""
    entity_id = msg["entity_id"].strip().lower()
    runtime = _runtime(hass)
    await runtime.database.async_delete_entity_history(entity_id)
    if runtime.entity_history:
        await runtime.entity_history.async_refresh()
    connection.send_result(msg["id"], {"deleted": True})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/get",
        probatio.Required("entity_id"): str,
        probatio.Optional("start_time"): str,
        probatio.Optional("end_time"): str,
        probatio.Optional("limit", default=10000): int,
        probatio.Optional("latest", default=False): bool,
        probatio.Optional("attribute"): str,
        probatio.Optional("min_value"): probatio.Any(int, float),
        probatio.Optional("max_value"): probatio.Any(int, float),
        probatio.Optional("before_id"): int,
        probatio.Optional("include_hidden", default=False): bool,
    }
)
async def websocket_get_entity_history(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return stored snapshots if the user may read the source entity."""
    entity_id = msg["entity_id"].strip().lower()
    if msg.get("include_hidden") and not connection.user.is_admin:
        _send_error(connection, msg["id"], "unauthorized", localized_text("errors.unauthorized"))
        return
    if not connection.user.permissions.check_entity(entity_id, POLICY_READ):
        _send_error(connection,
            msg["id"], "unauthorized", localized_text("errors.unauthorized")
        )
        return
    limit = max(1, min(int(msg["limit"]), 20000))
    min_value = float(msg["min_value"]) if "min_value" in msg else None
    max_value = float(msg["max_value"]) if "max_value" in msg else None
    if min_value is not None and max_value is not None and min_value > max_value:
        _send_error(connection,
            msg["id"], websocket_api.ERR_INVALID_FORMAT,
            localized_text("errors.numeric_range_invalid"),
        )
        return
    database = _runtime(hass).database
    records, truncated, query_limited = await database.async_query_entity_history(
        entity_id,
        msg.get("start_time"),
        msg.get("end_time"),
        limit,
        msg["latest"],
        msg.get("attribute"),
        min_value,
        max_value,
        msg.get("before_id"),
        msg.get("include_hidden", False),
    )
    options = await database.async_get_entity_history_options(entity_id)
    connection.send_result(
        msg["id"],
        {
            "entity_id": entity_id,
            "states": [record.as_dict() for record in records],
            "truncated": truncated,
            "query_limited": query_limited,
            **_entity_history_display_options(hass, entity_id, options.get("use_ha_precision") is True),
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/sample/save",
        probatio.Required("entity_id"): str,
        probatio.Required("state"): str,
        probatio.Required("attributes"): dict,
        probatio.Required("timestamp"): str,
        probatio.Optional("record_id"): int,
        probatio.Optional("hidden"): bool,
    }
)
async def websocket_save_entity_sample(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Allow administrators to add or correct archived measurements only."""
    try:
        record_id = await _runtime(hass).database.async_save_entity_sample(
            msg["entity_id"].strip().lower(), msg["state"], msg["attributes"],
            msg["timestamp"], msg.get("record_id"),
            msg.get("hidden"),
        )
    except (TypeError, ValueError) as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"record_id": record_id})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/sample/delete",
        probatio.Required("entity_id"): str,
        probatio.Required("record_id"): int,
    }
)
async def websocket_delete_entity_sample(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a manual measurement; original sources must be hidden instead."""
    try:
        await _runtime(hass).database.async_delete_entity_sample(
            msg["entity_id"].strip().lower(), msg["record_id"]
        )
    except (TypeError, ValueError) as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"deleted": True})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/entity_history/import",
        probatio.Required("entity_id"): str,
        probatio.Optional("start_time"): str,
        probatio.Optional("end_time"): str,
        probatio.Optional("include_recorder", default=True): bool,
        probatio.Optional("include_long_term_statistics", default=False): bool,
    }
)
async def websocket_import_entity_history(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Backfill one independent archive from Home Assistant Recorder data."""
    entity_id = msg["entity_id"].strip().lower()
    if not entity_id or "." not in entity_id:
        _send_error(connection,
            msg["id"], websocket_api.ERR_INVALID_FORMAT, localized_text("errors.entity_id_invalid")
        )
        return
    if not msg["include_recorder"] and not msg["include_long_term_statistics"]:
        _send_error(connection,
            msg["id"], websocket_api.ERR_INVALID_FORMAT,
            localized_text("errors.history_source_required"),
        )
        return

    def parse_time(value: str | None, fallback: datetime | None) -> datetime | None:
        if not value:
            return fallback
        parsed = dt_util.parse_datetime(value)
        if parsed is None:
            raise ValueError(localized_text("errors.datetime_invalid"))
        return dt_util.as_utc(parsed)

    try:
        start_time = parse_time(msg.get("start_time"), datetime(1970, 1, 1, tzinfo=UTC))
        end_time = parse_time(msg.get("end_time"), None)
        assert start_time is not None
        if end_time is not None and end_time <= start_time:
            raise ValueError(localized_text("errors.time_range_invalid"))
        result = await async_import_entity_history(
            hass,
            _runtime(hass).database,
            entity_id=entity_id,
            start_time=start_time,
            end_time=end_time,
            include_recorder=msg["include_recorder"],
            include_long_term_statistics=msg["include_long_term_statistics"],
        )
    except (HomeAssistantError, RuntimeError, ValueError) as error:
        _send_error(connection,
            msg["id"], websocket_api.ERR_UNKNOWN_ERROR, error
        )
        return
    records = await _runtime(hass).database.async_list_tracked_entities()
    record = next((item for item in records if item.entity_id == entity_id), None)
    connection.send_result(
        msg["id"], {**result, "entity": record.as_dict() if record else None}
    )


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/info"}
)
async def websocket_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return basic backend status."""
    runtime = _runtime(hass)
    lists = await runtime.database.async_list_lists()
    products = await runtime.database.async_list_products()
    categories = await runtime.database.async_list_categories()
    labels = await runtime.database.async_list_labels()
    chips = await runtime.database.async_list_chips()
    dishes = await runtime.database.async_list_dishes()
    statistics = await runtime.database.async_overview_statistics()
    connection.send_result(
        msg["id"],
        {
            "database_ready": True,
            "database_file": runtime.database.path.name,
            "schema_version": await runtime.database.async_schema_version(),
            "supported_schema_version": DATABASE_SCHEMA_VERSION,
            "list_count": len(lists),
            "product_count": len(products),
            "category_count": len(categories),
            "label_count": len(labels),
            "chip_count": len(chips),
            "dish_count": len(dishes),
            "statistics": statistics,
        },
    )


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/favorites/list"}
)
async def websocket_list_favorites(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return navigation favorites for the authenticated Home Assistant user."""
    favorites = await _runtime(hass).database.async_list_user_favorites(
        connection.user.id
    )
    connection.send_result(msg["id"], {"favorites": favorites})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/favorites/set",
        probatio.Required("section"): str,
        probatio.Optional("tab"): probatio.Any(str, None),
        probatio.Optional("target_id"): probatio.Any(str, None),
        probatio.Required("enabled"): bool,
    }
)
async def websocket_set_favorite(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Add or remove one navigation favorite for the authenticated user."""
    allowed_sections = {
        "lists", "products", "categories", "labels", "chips", "dishes", "inventory",
        "entity_history", "history", "notifications", "alexa", "settings", "backup", "statistics",
    }
    section = msg["section"].strip()
    if section not in allowed_sections:
        _send_error(connection,
            msg["id"], websocket_api.ERR_INVALID_FORMAT, localized_text("errors.favorite_section_invalid")
        )
        return
    try:
        tab = _clean_text(msg.get("tab"), maximum=50, required=False)
        target_id = _clean_text(
            msg.get("target_id"), maximum=100, required=False
        )
        favorites = await _runtime(hass).database.async_set_user_favorite(
            connection.user.id, section, tab, target_id, msg["enabled"]
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"favorites": favorites})


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/notifications/profiles/list"}
)
async def websocket_list_notification_profiles(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all reusable notification destinations."""
    records = await _runtime(hass).database.async_list_notification_profiles()
    connection.send_result(
        msg["id"], {"profiles": [record.as_dict() for record in records]}
    )


def _notification_profile_values(hass: HomeAssistant, msg: dict[str, Any]) -> dict[str, Any]:
    values = {
        "name": _clean_text(msg["name"], maximum=100, required=True),
        "provider": msg["provider"],
        "target": _clean_text(msg["target"], maximum=255, required=True),
        "title": _clean_text(msg.get("title"), maximum=200, required=False),
        "click_url": _clean_text(msg.get("click_url"), maximum=1000, required=False),
        "message_format": msg["message_format"],
        "enabled": msg.get("enabled", True),
    }
    if values["provider"] == "notify_entity" and values["message_format"] != "plain":
        entity = er.async_get(hass).async_get(values["target"])
        if entity is None or entity.platform != "telegram_bot":
            raise ValueError(localized_text("backend.notify_plain_text_only"))
    return values


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/profiles/create",
    probatio.Required("name"): str,
    probatio.Required("provider"): probatio.In(NOTIFICATION_PROVIDERS),
    probatio.Required("target"): str,
    probatio.Optional("title"): probatio.Any(str, None),
    probatio.Optional("click_url"): probatio.Any(str, None),
    probatio.Required("message_format"): probatio.In(NOTIFICATION_FORMATS),
    probatio.Optional("enabled", default=True): bool,
})
async def websocket_create_notification_profile(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a reusable notification destination."""
    try:
        record = await _runtime(hass).database.async_create_notification_profile(
            **_notification_profile_values(hass, msg)
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateNotificationProfileNameError:
        _send_error(connection, msg["id"], "already_exists", localized_text("backend.name_already_used"))
        return
    connection.send_result(msg["id"], {"profile": record.as_dict()})


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/profiles/update",
    probatio.Required("profile_id"): str,
    probatio.Required("name"): str,
    probatio.Required("provider"): probatio.In(NOTIFICATION_PROVIDERS),
    probatio.Required("target"): str,
    probatio.Optional("title"): probatio.Any(str, None),
    probatio.Optional("click_url"): probatio.Any(str, None),
    probatio.Required("message_format"): probatio.In(NOTIFICATION_FORMATS),
    probatio.Optional("enabled", default=True): bool,
})
async def websocket_update_notification_profile(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a reusable notification destination."""
    try:
        record = await _runtime(hass).database.async_update_notification_profile(
            msg["profile_id"], **_notification_profile_values(hass, msg)
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateNotificationProfileNameError:
        _send_error(connection, msg["id"], "already_exists", localized_text("backend.name_already_used"))
        return
    except NotificationProfileNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.delivery_target_missing"))
        return
    connection.send_result(msg["id"], {"profile": record.as_dict()})


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/profiles/delete",
    probatio.Required("profile_id"): str,
})
async def websocket_delete_notification_profile(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete one notification destination."""
    try:
        await _runtime(hass).database.async_delete_notification_profile(msg["profile_id"])
    except NotificationProfileNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.delivery_target_missing"))
        return
    connection.send_result(msg["id"])


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/assignments/list",
    probatio.Optional("list_id"): str,
})
async def websocket_list_notification_assignments(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the configured list-to-destination assignments."""
    if not _require_list_context(connection, msg):
        return
    try:
        records = await _runtime(hass).database.async_list_notification_assignments(
            msg.get("list_id")
        )
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    assignments = [record.as_dict() for record in records]
    if not connection.user.is_admin:
        # Cards only need the assigned destination's display name and availability.
        assignments = [
            {
                "list_id": record["list_id"],
                "profile_id": record["profile_id"],
                "manual_enabled": record["manual_enabled"],
                "profile": {key: record["profile"][key] for key in ("id", "name", "enabled")},
            }
            for record in assignments
        ]
    connection.send_result(msg["id"], {"assignments": assignments})


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/assignments/set",
    probatio.Required("list_id"): str,
    probatio.Optional("profile_ids"): [str],
    probatio.Optional("assignments"): [{
        probatio.Required("profile_id"): str,
        probatio.Optional("manual_enabled", default=True): bool,
        probatio.Optional("automatic_mode", default="off"): probatio.In(
            {"off", "changes", "full", "changes_and_full"}
        ),
        probatio.Optional("delay_seconds", default=15): int,
        probatio.Optional("notify_on_add", default=True): bool,
        probatio.Optional("notify_on_increase", default=True): bool,
        probatio.Optional("notify_on_decrease", default=True): bool,
        probatio.Optional("notify_on_edit", default=True): bool,
        probatio.Optional("notify_on_complete", default=False): bool,
        probatio.Optional("notify_on_reopen", default=False): bool,
        probatio.Optional("notify_on_delete", default=True): bool,
    }],
})
async def websocket_set_notification_assignments(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Replace the notification destinations assigned to one list."""
    try:
        assignments = msg.get("assignments")
        if assignments is None:
            assignments = msg.get("profile_ids", [])
        records = await _runtime(hass).database.async_set_notification_assignments(
            msg["list_id"], assignments
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except (ListNotFoundError, NotificationProfileNotFoundError) as error:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, error)
        return
    connection.send_result(
        msg["id"], {"assignments": [record.as_dict() for record in records]}
    )


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/test",
    probatio.Required("profile_id"): str,
})
async def websocket_test_notification_profile(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Send one test message through a configured destination."""
    runtime = _runtime(hass)
    profiles = await runtime.database.async_list_notification_profiles()
    profile = next((item for item in profiles if item.id == msg["profile_id"]), None)
    if profile is None:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.delivery_target_missing"))
        return
    try:
        await runtime.notifications.async_test(profile)
    except HomeAssistantError as error:
        _send_error(connection, msg["id"], "send_failed", error)
        return
    connection.send_result(msg["id"], {"sent": True})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/notifications/send_list",
    probatio.Required("list_id"): str,
    probatio.Optional("profile_ids"): [str],
})
async def websocket_send_list_notification(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Send a list manually to its assigned destinations."""
    runtime = _runtime(hass)
    try:
        sent = await runtime.notifications.async_send_list(
            msg["list_id"], msg.get("profile_ids")
        )
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    except HomeAssistantError as error:
        _send_error(connection, msg["id"], "send_failed", error)
        return
    connection.send_result(msg["id"], {"sent_profile_ids": sent})


@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/lists/list"}
)
async def websocket_list_lists(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all backend lists."""
    database = _runtime(hass).database
    records = await database.async_list_lists()
    statuses = await database.async_list_external_sync_statuses()
    result = []
    for record in records:
        data = record.as_dict()
        if record.provider == "bring":
            data["sync_status"] = statuses.get(record.id, {
                "status": "never",
                "last_attempt_at": None,
                "last_success_at": None,
                "last_change_at": None,
                "last_error": None,
            })
        result.append(data)
    connection.send_result(msg["id"], {"lists": result})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/lists/create",
        probatio.Required("name"): str,
        probatio.Optional("capitalize_first_letter", default=False): bool,
        probatio.Required("list_type"): probatio.In((*LIST_TYPES, "bring")),
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("external_entity_id"): probatio.Any(str, None),
        probatio.Optional("label_conflict_policy", default="specific"): probatio.In(
            {"specific", "separate", "global"}
        ),
        probatio.Optional("use_global_categories", default=True): bool,
        probatio.Optional("use_type_categories", default=True): bool,
        probatio.Optional("use_global_labels", default=True): bool,
        probatio.Optional("use_type_labels", default=True): bool,
        probatio.Optional("use_list_labels", default=True): bool,
        probatio.Optional("use_global_chips", default=True): bool,
        probatio.Optional("use_type_chips", default=True): bool,
        probatio.Optional("use_dishes", default=False): bool,
        probatio.Optional("use_tandoor", default=False): bool,
        probatio.Optional("tandoor_skip_small_units", default=False): bool,
        probatio.Optional("tandoor_include_ingredients", default=True): bool,
        probatio.Optional("tandoor_excluded_units", default=""): str,
        probatio.Optional("tandoor_result_limit", default=100): probatio.In({10, 25, 50, 100}),
        probatio.Optional("auto_delete_completed"): bool,
        probatio.Optional("auto_delete_delay_minutes"): probatio.All(int, probatio.Range(min=0,max=525600)),
        probatio.Optional("auto_delete_confirm"): bool,
    }
)
async def websocket_create_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a backend list."""
    try:
        name = _clean_text(msg["name"], maximum=100, required=True)
        icon = _clean_text(msg.get("icon"), maximum=100, required=False)
        requested_type = msg["list_type"]
        provider = "bring" if requested_type == "bring" else "local"
        list_type = "shopping" if provider == "bring" else requested_type
        external_entity_id = _clean_text(
            msg.get("external_entity_id"), maximum=255, required=provider == "bring"
        )
        if provider == "bring":
            _runtime(hass).external_lists.validate_bring_entity(external_entity_id)
        tandoor_excluded_units = _clean_text(
            msg.get("tandoor_excluded_units"), maximum=500, required=False
        ) or ""
        record = await _runtime(hass).database.async_create_list(
            auto_delete_completed=msg.get("auto_delete_completed", False),
            auto_delete_delay_minutes=msg.get("auto_delete_delay_minutes", 0),
            auto_delete_confirm=msg.get("auto_delete_confirm", False),
            name=name,
            list_type=list_type,
            icon=icon,
            provider=provider,
            capitalize_first_letter=msg["capitalize_first_letter"],
            external_entity_id=external_entity_id,
            label_conflict_policy=msg["label_conflict_policy"],
            use_global_categories=msg["use_global_categories"],
            use_type_categories=msg["use_type_categories"],
            use_global_labels=msg["use_global_labels"],
            use_type_labels=msg["use_type_labels"],
            use_list_labels=msg["use_list_labels"],
            use_global_chips=msg["use_global_chips"],
            use_type_chips=msg["use_type_chips"],
            use_dishes=msg["use_dishes"],
            use_tandoor=msg["use_tandoor"],
            tandoor_skip_small_units=msg["tandoor_skip_small_units"],
            tandoor_include_ingredients=msg["tandoor_include_ingredients"],
            tandoor_excluded_units=tandoor_excluded_units,
            tandoor_result_limit=msg["tandoor_result_limit"],
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateListNameError:
        _send_error(connection,
            msg["id"], "already_exists", localized_text("errors.list_name_exists")
        )
        return

    _fire_lists_changed(hass, record.id)
    connection.send_result(msg["id"], {"list": record.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/lists/update",
        probatio.Required("list_id"): str,
        probatio.Optional("name"): str,
        probatio.Optional("capitalize_first_letter"): bool,
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("enabled"): bool,
        probatio.Optional("external_entity_id"): probatio.Any(str, None),
        probatio.Optional("label_conflict_policy"): probatio.In(
            {"specific", "separate", "global"}
        ),
        probatio.Optional("use_global_categories"): bool,
        probatio.Optional("use_type_categories"): bool,
        probatio.Optional("use_global_labels"): bool,
        probatio.Optional("use_type_labels"): bool,
        probatio.Optional("use_list_labels"): bool,
        probatio.Optional("use_global_chips"): bool,
        probatio.Optional("use_type_chips"): bool,
        probatio.Optional("use_dishes"): bool,
        probatio.Optional("use_tandoor"): bool,
        probatio.Optional("tandoor_skip_small_units"): bool,
        probatio.Optional("tandoor_include_ingredients"): bool,
        probatio.Optional("tandoor_excluded_units"): str,
        probatio.Optional("tandoor_result_limit"): probatio.In({10, 25, 50, 100}),
        probatio.Optional("confirm_scope_changes", default=False): bool,
        probatio.Optional("auto_delete_completed"): bool,
        probatio.Optional("auto_delete_delay_minutes"): probatio.All(int, probatio.Range(min=0,max=525600)),
        probatio.Optional("auto_delete_confirm"): bool,
    }
)
async def websocket_update_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a backend list."""
    try:
        name = (
            _clean_text(msg["name"], maximum=100, required=True)
            if "name" in msg
            else None
        )
        icon = _clean_text(msg.get("icon"), maximum=100, required=False)
        tandoor_excluded_units = (
            _clean_text(msg.get("tandoor_excluded_units"), maximum=500, required=False) or ""
            if "tandoor_excluded_units" in msg else None
        )
        updates: dict[str, Any] = {
            "auto_delete_completed": msg.get("auto_delete_completed"),
            "auto_delete_delay_minutes": msg.get("auto_delete_delay_minutes"),
            "auto_delete_confirm": msg.get("auto_delete_confirm"),
            "name": name,
            "icon": icon,
            "enabled": msg.get("enabled"),
            "capitalize_first_letter": msg.get("capitalize_first_letter"),
            "label_conflict_policy": msg.get("label_conflict_policy"),
            "use_global_categories": msg.get("use_global_categories"),
            "use_type_categories": msg.get("use_type_categories"),
            "use_global_labels": msg.get("use_global_labels"),
            "use_type_labels": msg.get("use_type_labels"),
            "use_list_labels": msg.get("use_list_labels"),
            "use_global_chips": msg.get("use_global_chips"),
            "use_type_chips": msg.get("use_type_chips"),
            "use_dishes": msg.get("use_dishes"),
            "use_tandoor": msg.get("use_tandoor"),
            "tandoor_skip_small_units": msg.get("tandoor_skip_small_units"),
            "tandoor_include_ingredients": msg.get("tandoor_include_ingredients"),
            "tandoor_excluded_units": tandoor_excluded_units,
            "tandoor_result_limit": msg.get("tandoor_result_limit"),
            "confirm_scope_changes": msg["confirm_scope_changes"],
        }
        if "external_entity_id" in msg:
            external_entity_id = _clean_text(
                msg.get("external_entity_id"), maximum=255, required=True
            )
            _runtime(hass).external_lists.validate_bring_entity(external_entity_id)
            updates["external_entity_id"] = external_entity_id
        record = await _runtime(hass).database.async_update_list(
            msg["list_id"],
            **updates,
        )
    except ScopeChangeConfirmationRequired as error:
        _send_error(connection,
            msg["id"], "scope_change_confirmation_required",
            error,
        )
        return
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateListNameError:
        _send_error(connection,
            msg["id"], "already_exists", localized_text("errors.list_name_exists")
        )
        return
    except ListNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found")
        )
        return

    _fire_lists_changed(hass, record.id)
    connection.send_result(msg["id"], {"list": record.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/lists/scope-impact",
        probatio.Required("list_id"): str,
        probatio.Required("use_global_categories"): bool,
        probatio.Required("use_type_categories"): bool,
        probatio.Required("use_global_labels"): bool,
        probatio.Required("use_type_labels"): bool,
        probatio.Required("use_global_chips"): bool,
        probatio.Required("use_type_chips"): bool,
    }
)
async def websocket_list_scope_impact(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Preview concrete assignments changed by list scope switches."""
    try:
        impact = await _runtime(hass).database.async_preview_list_scope_changes(
            msg["list_id"],
            use_global_categories=msg["use_global_categories"],
            use_type_categories=msg["use_type_categories"],
            use_global_labels=msg["use_global_labels"],
            use_type_labels=msg["use_type_labels"],
            use_global_chips=msg["use_global_chips"],
            use_type_chips=msg["use_type_chips"],
        )
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    connection.send_result(msg["id"], {"impact": impact})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/lists/delete",
        probatio.Required("list_id"): str,
    }
)
async def websocket_delete_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a backend list."""
    try:
        await _runtime(hass).database.async_delete_list(msg["list_id"])
    except ListNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found")
        )
        return
    _fire_lists_changed(hass, msg["list_id"])
    connection.send_result(msg["id"])


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/lists/sync",
        probatio.Required("list_id"): str,
    }
)
async def websocket_sync_external_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Synchronize one external list immediately and return diagnostics."""
    runtime = _runtime(hass)
    try:
        records = await runtime.external_lists.async_sync(msg["list_id"])
        statuses = await runtime.database.async_list_external_sync_statuses()
    except ListNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found")
        )
        return
    except ExternalListError as error:
        _send_error(connection, msg["id"], "external_list_error", error)
        return
    connection.send_result(msg["id"], {
        "items": [item.as_dict() for item in records],
        "sync_status": statuses.get(msg["list_id"]),
    })


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/items/list",
        probatio.Required("list_id"): str,
    }
)
async def websocket_list_items(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the entries belonging to one backend list."""
    try:
        list_record = await _runtime(hass).database.async_get_list(msg["list_id"])
        if list_record.provider == "bring":
            records = await _runtime(hass).external_lists.async_sync(msg["list_id"])
        else:
            records = await _runtime(hass).database.async_list_items(msg["list_id"])
    except ListNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found")
        )
        return
    except ExternalListError as error:
        _send_error(connection, msg["id"], "external_list_error", error)
        return
    category_names = await _runtime(hass).database.async_get_item_category_names(msg["list_id"])
    result: dict[str, Any] = {"items": [
        {**item.as_dict(), "category_name": category_names.get(item.category_id)}
        for item in records
    ]}
    if list_record.provider == "bring":
        statuses = await _runtime(hass).database.async_list_external_sync_statuses()
        result["sync_status"] = statuses.get(list_record.id)
    connection.send_result(msg["id"], result)


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/items/create",
        probatio.Required("list_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("description"): probatio.Any(str, None),
        probatio.Required("quantity"): int,
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("due_at"): probatio.Any(str, None),
        probatio.Optional("recurrence_interval"): probatio.Any(int, None),
        probatio.Optional("recurrence_unit"): probatio.Any(
            probatio.In({"H", "D", "M"}), None
        ),
        probatio.Optional("label_ids"): [str],
        probatio.Optional("product_id"): probatio.Any(str, None),
        probatio.Optional("offer_only"): bool,
        probatio.Optional("remember_product_category"): bool,
        probatio.Optional("remember_product_labels"): bool,
    }
)
async def websocket_create_item(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create an entry in a backend list."""
    try:
        list_record = await _runtime(hass).database.async_get_list(msg["list_id"])
        values = {
            "offer_only": msg.get("offer_only", False),
            "name": _clean_text(msg["name"], maximum=200, required=True),
            "description": _clean_text(msg.get("description"), maximum=2000, required=False),
            "quantity": _clean_quantity(msg["quantity"]),
            "category_id": _clean_text(msg.get("category_id"), maximum=64, required=False),
            "category": _clean_text(msg.get("category"), maximum=100, required=False),
            "label_ids": _clean_label_ids(msg.get("label_ids")),
            "product_id": _clean_text(msg.get("product_id"), maximum=64, required=False),
        }
        recurrence_interval, recurrence_unit = _clean_recurrence(
            msg.get("recurrence_interval"), msg.get("recurrence_unit")
        )
        if list_record.list_type != "todo" and recurrence_interval is not None:
            raise ValueError(localized_text("errors.recurrence_todo_only"))
        if list_record.provider == "bring":
            if msg.get("remember_product_category", False) or msg.get("remember_product_labels", False):
                raise ValueError(localized_text("backend.local_shopping_target_required"))
            record = await _runtime(hass).external_lists.async_create_item(
                msg["list_id"], **values
            )
        else:
            record = await _runtime(hass).database.async_create_item(
                msg["list_id"],
                values["name"], values["description"], values["quantity"],
                values["category_id"], values["category"],
                _clean_text(msg.get("due_at"), maximum=40, required=False),
                values["label_ids"], values["product_id"], None,
                recurrence_interval, recurrence_unit, values["offer_only"],
                msg.get("remember_product_category", False),
                msg.get("remember_product_labels", False),
            )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found")
        )
        return
    except ExternalListError as error:
        _send_error(connection, msg["id"], "external_list_error", error)
        return
    except (CategoryNotFoundError, LabelNotFoundError, ProductNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_definition_missing")
        )
        return
    if list_record.provider != "bring":
        _fire_items_changed(hass, record.list_id)
        if msg.get("remember_product_labels", False):
            _fire_lists_changed(hass)
        elif msg.get("remember_product_category", False):
            _fire_lists_changed(hass, record.list_id)
    connection.send_result(msg["id"], {"item": record.as_dict()})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/item_actions/chip",
    probatio.Required("list_id"): str,
    probatio.Required("name"): str,
    probatio.Optional("product_id"): probatio.Any(str, None),
})
async def websocket_item_action_chip(hass, connection, msg) -> None:
    """Save an entry chip only for the list operated by the card."""
    try:
        chip, created = await _runtime(hass).database.async_create_item_action_chip(
            _clean_text(msg["list_id"], maximum=64, required=True),
            _clean_text(msg["name"], maximum=100, required=True),
            _clean_text(msg.get("product_id"), maximum=64, required=False),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except (ListNotFoundError, ProductNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_definition_missing"))
        return
    if created:
        _fire_lists_changed(hass, msg["list_id"])
    connection.send_result(msg["id"], {"chip": chip.as_dict(), "created": created})


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/item_actions/rule",
    probatio.Required("list_id"): str,
    probatio.Required("name"): str,
    probatio.Required("category_id"): str,
})
async def websocket_item_action_rule(hass, connection, msg) -> None:
    """Append an exact rule without mutating shared category definitions."""
    try:
        category, created = await _runtime(hass).database.async_create_item_action_rule(
            _clean_text(msg["list_id"], maximum=64, required=True),
            _clean_text(msg["name"], maximum=100, required=True),
            _clean_text(msg["category_id"], maximum=64, required=True),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except (ListNotFoundError, CategoryNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_or_list_missing"))
        return
    if created:
        _fire_lists_changed(hass, msg["list_id"])
    connection.send_result(msg["id"], {"category": category.as_dict(), "created": created})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/item_actions/send",
    probatio.Required("source_list_id"): str,
    probatio.Optional("source_item_id"): str,
    probatio.Optional("source_entry_id"): str,
    probatio.Required("target_list_id"): str,
    probatio.Required("quantity"): int,
})
async def websocket_item_action_send(hass, connection, msg) -> None:
    """Copy one persisted article into another local shopping list."""
    try:
        item, merged, target = await _runtime(hass).database.async_send_item_action(
            _clean_text(msg["source_list_id"], maximum=64, required=True),
            _clean_text(msg.get("source_item_id"), maximum=64, required=False),
            _clean_text(msg.get("source_entry_id"), maximum=64, required=False),
            _clean_text(msg["target_list_id"], maximum=64, required=True),
            _clean_quantity(msg["quantity"]),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except (ListNotFoundError, ListItemNotFoundError, InventoryEntryNotFoundError, ProductNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_definition_missing"))
        return
    _fire_items_changed(hass, target.id)
    connection.send_result(msg["id"], {"item": item.as_dict(), "merged": merged, "list": target.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/items/update",
        probatio.Required("item_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("description"): probatio.Any(str, None),
        probatio.Required("quantity"): int,
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("due_at"): probatio.Any(str, None),
        probatio.Optional("recurrence_interval"): probatio.Any(int, None),
        probatio.Optional("recurrence_unit"): probatio.Any(
            probatio.In({"H", "D", "M"}), None
        ),
        probatio.Required("completed"): bool,
        probatio.Optional("label_ids"): [str],
        probatio.Optional("product_id"): probatio.Any(str, None),
        probatio.Optional("offer_only"): bool,
        probatio.Optional("remember_product_category"): bool,
        probatio.Optional("remember_product_labels"): bool,
    }
)
async def websocket_update_item(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update an entry in a backend list."""
    try:
        updates = {
            "name": _clean_text(msg["name"], maximum=200, required=True),
            "description": _clean_text(
                msg.get("description"), maximum=2000, required=False
            ),
            "quantity": _clean_quantity(msg["quantity"]),
            "category_id": _clean_text(
                msg.get("category_id"), maximum=64, required=False
            ),
            "category": _clean_text(msg.get("category"), maximum=100, required=False),
            "due_at": _clean_text(msg.get("due_at"), maximum=40, required=False),
            "completed": msg["completed"],
            "label_ids": _clean_label_ids(msg.get("label_ids")),
        }
        if "offer_only" in msg:
            updates["offer_only"] = msg["offer_only"]
        if "product_id" in msg:
            updates["product_id"] = _clean_text(
                msg["product_id"], maximum=64, required=False
            )
        existing = await _runtime(hass).database.async_get_item(msg["item_id"])
        list_record = await _runtime(hass).database.async_get_list(existing.list_id)
        if "recurrence_interval" in msg or "recurrence_unit" in msg:
            recurrence_interval, recurrence_unit = _clean_recurrence(
                msg.get("recurrence_interval"), msg.get("recurrence_unit")
            )
        else:
            recurrence_interval = existing.recurrence_interval
            recurrence_unit = existing.recurrence_unit
        if list_record.list_type != "todo" and recurrence_interval is not None:
            raise ValueError(localized_text("errors.recurrence_todo_only"))
        updates["recurrence_interval"] = recurrence_interval
        updates["recurrence_unit"] = recurrence_unit
        if list_record.provider == "bring":
            if msg.get("remember_product_category", False) or msg.get("remember_product_labels", False):
                raise ValueError(localized_text("backend.local_shopping_target_required"))
            record = await _runtime(hass).external_lists.async_update_item(
                msg["item_id"], **updates
            )
        else:
            record = await _runtime(hass).database.async_update_item(
                msg["item_id"], **updates,
                remember_product_category=msg.get("remember_product_category", False),
                remember_product_labels=msg.get("remember_product_labels", False),
            )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListItemNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.item_not_found")
        )
        return
    except ExternalListError as error:
        _send_error(connection, msg["id"], "external_list_error", error)
        return
    except (CategoryNotFoundError, LabelNotFoundError, ProductNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_definition_missing")
        )
        return
    if list_record.provider != "bring":
        _fire_items_changed(hass, record.list_id)
        if msg.get("remember_product_labels", False):
            _fire_lists_changed(hass)
        elif msg.get("remember_product_category", False):
            _fire_lists_changed(hass, record.list_id)
    connection.send_result(msg["id"], {"item": record.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/items/set_completed",
        probatio.Required("item_id"): str,
        probatio.Required("completed"): bool,
    }
)
async def websocket_set_item_completed(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set the completed state of an entry."""
    try:
        existing = await _runtime(hass).database.async_get_item(msg["item_id"])
        list_record = await _runtime(hass).database.async_get_list(existing.list_id)
        if list_record.provider == "bring":
            record = await _runtime(hass).external_lists.async_set_completed(
                msg["item_id"], msg["completed"]
            )
        else:
            record = await _runtime(hass).database.async_set_item_completed(
                msg["item_id"], msg["completed"]
            )
    except ListItemNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.item_not_found")
        )
        return
    except ExternalListError as error:
        _send_error(connection, msg["id"], "external_list_error", error)
        return
    if list_record.provider != "bring":
        _fire_items_changed(hass, record.list_id)
    connection.send_result(msg["id"], {"item": record.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/items/reorder",
        probatio.Required("list_id"): str,
        probatio.Required("item_ids"): [str],
    }
)
async def websocket_reorder_items(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Persist the manual order of a local list."""
    try:
        list_record = await _runtime(hass).database.async_get_list(msg["list_id"])
        if list_record.provider != "local":
            raise ValueError(localized_text("errors.external_reorder_unavailable"))
        records = await _runtime(hass).database.async_reorder_items(
            msg["list_id"], msg["item_ids"]
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    _fire_items_changed(hass, msg["list_id"])
    connection.send_result(msg["id"], {"items": [item.as_dict() for item in records]})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/items/delete",
        probatio.Required("item_id"): str,
    }
)
async def websocket_delete_item(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete an entry from a backend list."""
    try:
        existing = await _runtime(hass).database.async_get_item(msg["item_id"])
        list_record = await _runtime(hass).database.async_get_list(existing.list_id)
        if list_record.provider == "bring":
            list_id = await _runtime(hass).external_lists.async_delete_item(
                msg["item_id"]
            )
        else:
            list_id = await _runtime(hass).database.async_delete_item(msg["item_id"])
    except ListItemNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.item_not_found")
        )
        return
    except ExternalListError as error:
        _send_error(connection, msg["id"], "external_list_error", error)
        return
    if list_record.provider != "bring":
        _fire_items_changed(hass, list_id)
    connection.send_result(msg["id"])


def _clean_quantity(value: int) -> int:
    """Validate a list-item quantity."""
    if isinstance(value, bool) or value < 0 or value > 1_000_000:
        raise ValueError(localized_text("errors.quantity_invalid"))
    return value


def _clean_recurrence(
    interval: int | None, unit: str | None
) -> tuple[int | None, str | None]:
    """Validate an optional To-do recurrence."""
    if interval is None and unit is None:
        return None, None
    if (
        not isinstance(interval, int)
        or isinstance(interval, bool)
        or interval < 1
        or interval > 1_000_000
    ):
        raise ValueError(localized_text("errors.recurrence_interval_invalid"))
    normalized_unit = str(unit or "").upper()
    if normalized_unit not in {"H", "D", "M"}:
        raise ValueError(localized_text("errors.recurrence_unit_invalid"))
    return interval, normalized_unit


def _clean_label_ids(value: Any) -> list[str]:
    """Normalize a list of label IDs while preserving its order."""
    if value is None:
        return []
    cleaned = [
        _clean_text(label_id, maximum=64, required=True) for label_id in value
    ]
    return list(dict.fromkeys(cleaned))


def _clean_category_ids(value: Any) -> list[str]:
    """Normalize product-category assignments while preserving priority input."""
    if value is None:
        return []
    cleaned = [
        _clean_text(category_id, maximum=64, required=True)
        for category_id in value
    ]
    return list(dict.fromkeys(cleaned))


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/products/list",
        probatio.Optional("search"): str,
        probatio.Optional("label_id"): probatio.Any(str, None),
        probatio.Optional("limit"): int,
        probatio.Optional("offset"): int,
    }
)
async def websocket_list_products(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return products matching an optional search term."""
    search = _clean_text(msg.get("search"), maximum=200, required=False)
    label_id = _clean_text(msg.get("label_id"), maximum=64, required=False)
    limit = msg.get("limit")
    offset = msg.get("offset", 0)
    database = _runtime(hass).database
    if limit is not None:
        if isinstance(limit, bool) or limit not in (10, 25, 50, 100):
            _send_input_error(connection, msg, ValueError(localized_text("errors.product_page_size_invalid")))
            return
        if isinstance(offset, bool) or offset < 0:
            _send_input_error(connection, msg, ValueError(localized_text("errors.product_offset_invalid")))
            return
        products, total = await database.async_list_products_page(
            search, label_id, limit, offset
        )
    else:
        products = await database.async_list_products(search, label_id)
        total = len(products)
    connection.send_result(
        msg["id"],
        {
            "products": [product.as_dict() for product in products],
            "total": total,
            "limit": limit,
            "offset": offset,
        },
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/products/lookup",
        probatio.Required("ean"): str,
        probatio.Optional("product_id"): probatio.Any(str, None),
    }
)
async def websocket_lookup_product(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Check for a duplicate and otherwise resolve an EAN from Open Food Facts."""
    try:
        ean = _clean_ean(msg["ean"])
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    if ean is None:
        _send_input_error(connection, msg, ValueError(localized_text("errors.ean_required")))
        return

    database = _runtime(hass).database
    product = await database.async_get_product_by_ean(ean)
    if product is not None and product.id != msg.get("product_id"):
        connection.send_result(
            msg["id"], {"duplicate": product.as_dict(), "product": None}
        )
        return

    try:
        lookup = await async_lookup_open_facts(hass, ean)
    except OpenFactsLookupError:
        _send_error(connection,
            msg["id"], "lookup_unavailable", localized_text("errors.open_facts_unavailable")
        )
        return
    if lookup is None:
        _send_error(connection,
            msg["id"], "product_not_found", localized_text("errors.ean_product_missing")
        )
        return

    connection.send_result(
        msg["id"], {"duplicate": None, "product": {"ean": ean, **lookup}}
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/products/create",
        probatio.Optional("ean"): probatio.Any(str, None),
        probatio.Required("name"): str,
        probatio.Optional("original_name"): probatio.Any(str, None),
        probatio.Optional("brand"): probatio.Any(str, None),
        probatio.Optional("package_quantity"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("category_ids"): [str],
        probatio.Optional("image_url"): probatio.Any(str, None),
        probatio.Optional("label_ids"): [str],
    }
)
async def websocket_create_product(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a product."""
    try:
        product = await _runtime(hass).database.async_create_product(
            ean=_clean_ean(msg.get("ean")),
            name=_clean_text(msg["name"], maximum=200, required=True),
            original_name=_clean_text(
                msg.get("original_name"), maximum=200, required=False
            ),
            brand=_clean_text(msg.get("brand"), maximum=200, required=False),
            package_quantity=_clean_text(
                msg.get("package_quantity"), maximum=100, required=False
            ),
            category=_clean_text(msg.get("category"), maximum=100, required=False),
            image_url=_clean_text(msg.get("image_url"), maximum=1000, required=False),
            source="open_food_facts" if msg.get("original_name") else "manual",
            label_ids=_clean_label_ids(msg.get("label_ids")),
            category_ids=_clean_category_ids(msg.get("category_ids")),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateEANError:
        _send_error(connection,
            msg["id"], "ean_already_exists", localized_text("errors.ean_assigned")
        )
        return
    except (LabelNotFoundError, CategoryNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_or_label_missing"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"product": product.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/products/update",
        probatio.Required("product_id"): str,
        probatio.Optional("list_id"): str,
        probatio.Optional("ean"): probatio.Any(str, None),
        probatio.Required("name"): str,
        probatio.Optional("original_name"): probatio.Any(str, None),
        probatio.Optional("brand"): probatio.Any(str, None),
        probatio.Optional("package_quantity"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("category_ids"): [str],
        probatio.Optional("image_url"): probatio.Any(str, None),
        probatio.Optional("label_ids"): [str],
    }
)
async def websocket_update_product(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a product."""
    try:
        product = await _runtime(hass).database.async_update_product(
            msg["product_id"],
            ean=_clean_ean(msg.get("ean")),
            name=_clean_text(msg["name"], maximum=200, required=True),
            original_name=_clean_text(
                msg.get("original_name"), maximum=200, required=False
            ),
            brand=_clean_text(msg.get("brand"), maximum=200, required=False),
            package_quantity=_clean_text(
                msg.get("package_quantity"), maximum=100, required=False
            ),
            category=_clean_text(msg.get("category"), maximum=100, required=False),
            image_url=_clean_text(msg.get("image_url"), maximum=1000, required=False),
            label_ids=_clean_label_ids(msg.get("label_ids")),
            list_id=msg.get("list_id"),
            category_ids=(
                _clean_category_ids(msg.get("category_ids"))
                if "category_ids" in msg else None
            ),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateEANError:
        _send_error(connection,
            msg["id"], "ean_already_exists", localized_text("errors.ean_assigned")
        )
        return
    except ProductNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_not_found")
        )
        return
    except (LabelNotFoundError, CategoryNotFoundError, ListNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_or_label_missing"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"product": product.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/products/list",
        probatio.Required("category_id"): str,
        probatio.Optional("search"): str,
    }
)
async def websocket_list_category_products(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return explicit members and optional product-search matches."""
    try:
        search = _clean_text(msg.get("search"), maximum=200, required=False)
        database = _runtime(hass).database
        assigned = await database.async_list_products_for_category(msg["category_id"])
        matches = (
            await database.async_list_products(search)
            if search
            else await database.async_list_recent_products(100)
        )
    except CategoryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_not_found")
        )
        return
    connection.send_result(
        msg["id"],
        {
            "assigned": [product.as_dict() for product in assigned],
            "products": [product.as_dict() for product in matches[:100]],
            "total": len(matches),
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/products/category/set",
        probatio.Required("product_id"): str,
        probatio.Required("list_id"): str,
        probatio.Required("category_id"): probatio.Any(str, None),
        probatio.Optional("replace_existing", default=False): bool,
    }
)
async def websocket_set_product_list_category(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set one list-specific product category without rewriting other scopes."""
    try:
        product, previous, changed, list_type = (
            await _runtime(hass).database.async_set_product_list_category(
                msg["product_id"],
                msg["list_id"],
                msg["category_id"],
                msg["replace_existing"],
            )
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except (ProductNotFoundError, CategoryNotFoundError, ListNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_category_list_missing")
        )
        return
    conflict = bool(
        previous is not None
        and msg["category_id"] is not None
        and previous.id != msg["category_id"]
        and not changed
    )
    if changed:
        _fire_items_changed(hass, msg["list_id"])
        if list_type == "inventory":
            _fire_inventory_changed(hass, list_id=msg["list_id"], entry_id=None)
    connection.send_result(
        msg["id"],
        {
            "product": product.as_dict(),
            "changed": changed,
            "conflict": previous.as_dict() if conflict else None,
        },
    )


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/settings/get"}
)
async def websocket_get_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return backend product-name defaults."""
    options = _runtime(hass).config_entry.options
    connection.send_result(
        msg["id"],
        {
            "append_brand_to_product_name": bool(
                options.get("append_brand_to_product_name", False)
            ),
            "append_quantity_to_product_name": bool(
                options.get("append_quantity_to_product_name", False)
            ),
            "scanner_default_list_id": options.get("scanner_default_list_id"),
            "scanner_default_action": options.get("scanner_default_action", "add"),
            "tandoor_url": options.get("tandoor_url"),
            "tandoor_token_configured": bool(options.get("tandoor_token")),
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/settings/update",
        probatio.Required("append_brand_to_product_name"): bool,
        probatio.Required("append_quantity_to_product_name"): bool,
        probatio.Optional("scanner_default_list_id"): probatio.Any(str, None),
        probatio.Optional("scanner_default_action"): probatio.In(SCANNER_ACTIONS),
        probatio.Optional("tandoor_url"): probatio.Any(str, None),
        probatio.Optional("tandoor_token"): probatio.Any(str, None),
    }
)
async def websocket_update_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update backend product-name defaults."""
    runtime = _runtime(hass)
    options = dict(runtime.config_entry.options)
    tandoor_url = (
        normalize_tandoor_url(msg.get("tandoor_url"))
        if "tandoor_url" in msg
        else options.get("tandoor_url")
    )
    tandoor_token = str(msg.get("tandoor_token") or "").strip()
    options.update(
        {
            "append_brand_to_product_name": msg["append_brand_to_product_name"],
            "append_quantity_to_product_name": msg[
                "append_quantity_to_product_name"
            ],
            "scanner_default_list_id": _clean_text(
                msg.get("scanner_default_list_id"), maximum=64, required=False
            ),
            "scanner_default_action": msg.get("scanner_default_action", "add"),
            "tandoor_url": tandoor_url,
            "tandoor_token": (
                tandoor_token if tandoor_token
                else options.get("tandoor_token", "") if tandoor_url
                else ""
            ),
        }
    )
    hass.config_entries.async_update_entry(runtime.config_entry, options=options)
    connection.send_result(
        msg["id"],
        {
            **{key: value for key, value in options.items() if key != "tandoor_token"},
            "tandoor_token_configured": bool(options.get("tandoor_token")),
        },
    )


def _tandoor_client(hass: HomeAssistant) -> TandoorClient:
    runtime = _runtime(hass)
    options = runtime.config_entry.options
    config = (
        str(options.get("tandoor_url") or ""),
        str(options.get("tandoor_token") or ""),
    )
    if runtime.tandoor is None or runtime.tandoor_config != config:
        runtime.tandoor = TandoorClient(hass, *config)
        runtime.tandoor_config = config
    return runtime.tandoor


def _relay_tandoor_image(hass: HomeAssistant, recipe: dict[str, Any]) -> dict[str, Any]:
    """Replace a private Tandoor URL with the local, token-protected image relay."""
    if not recipe.get("image") or recipe.get("id") is None:
        return recipe
    runtime = _runtime(hass)
    return {
        **recipe,
        "image": (
            f"/api/{DOMAIN}/tandoor/image/{int(recipe['id'])}"
            f"?token={runtime.tandoor_image_token}"
        ),
    }


async def _require_tandoor_list(hass: HomeAssistant, list_id: str) -> Any:
    record = await _runtime(hass).database.async_get_list(list_id)
    if record.list_type != "shopping" or record.provider != "local" or not record.use_tandoor:
        raise ValueError(localized_text("backend.tandoor_disabled"))
    return record


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/tandoor/test",
        probatio.Optional("url"): probatio.Any(str, None),
        probatio.Optional("token"): probatio.Any(str, None),
    }
)
async def websocket_test_tandoor(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Test the stored Tandoor connection without returning credentials."""
    try:
        options = _runtime(hass).config_entry.options
        url = normalize_tandoor_url(msg.get("url")) if "url" in msg else options.get("tandoor_url")
        token = str(msg.get("token") or options.get("tandoor_token") or "").strip()
        result = await TandoorClient(hass, str(url or ""), token).async_test()
    except (TandoorError, ValueError) as error:
        _send_error(connection, msg["id"], "tandoor_error", error)
        return
    connection.send_result(msg["id"], result)


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/tandoor/categories/list",
        probatio.Required("list_id"): str,
    }
)
async def websocket_list_tandoor_categories(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return up to 100 Tandoor recipe books as optional search categories."""
    try:
        await _require_tandoor_list(hass, msg["list_id"])
        categories = await _tandoor_client(hass).async_categories(limit=100)
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    except (TandoorError, ValueError) as error:
        _send_error(connection, msg["id"], "tandoor_error", error)
        return
    connection.send_result(msg["id"], {"categories": categories})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/tandoor/recipes/search",
        probatio.Required("list_id"): str,
        probatio.Optional("query", default=""): str,
        probatio.Optional("category_id"): int,
        probatio.Optional("include_ingredients", default=True): bool,
    }
)
async def websocket_search_tandoor_recipes(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Search recipes for a shopping list that explicitly enables Tandoor."""
    try:
        record = await _require_tandoor_list(hass, msg["list_id"])
        recipes = await _tandoor_client(hass).async_search(
            msg["query"],
            limit=record.tandoor_result_limit,
            category_id=msg.get("category_id"),
            include_ingredients=msg["include_ingredients"],
        )
        recipes = [_relay_tandoor_image(hass, recipe) for recipe in recipes]
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    except (TandoorError, ValueError) as error:
        _send_error(connection, msg["id"], "tandoor_error", error)
        return
    connection.send_result(msg["id"], {"recipes": recipes})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/tandoor/recipes/get",
        probatio.Required("list_id"): str,
        probatio.Required("recipe_id"): int,
    }
)
async def websocket_get_tandoor_recipe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return one recipe and structured ingredients."""
    try:
        await _require_tandoor_list(hass, msg["list_id"])
        recipe = await _tandoor_client(hass).async_recipe(msg["recipe_id"])
        recipe = _relay_tandoor_image(hass, recipe)
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    except (TandoorError, ValueError) as error:
        _send_error(connection, msg["id"], "tandoor_error", error)
        return
    connection.send_result(msg["id"], {"recipe": recipe})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/products/delete",
        probatio.Required("product_id"): str,
    }
)
async def websocket_delete_product(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a product."""
    try:
        await _runtime(hass).database.async_delete_product(msg["product_id"])
    except ProductNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_not_found")
        )
        return
    connection.send_result(msg["id"])


def _clean_ean(value: Any) -> str | None:
    """Normalize and validate an optional barcode."""
    ean = _clean_text(value, maximum=32, required=False)
    if ean is not None and (not ean.isdigit() or len(ean) < 4):
        raise ValueError(localized_text("errors.ean_invalid"))
    return ean


def _clean_color(value: Any) -> str | None:
    """Normalize and validate an optional RGB hex color."""
    color = _clean_text(value, maximum=7, required=False)
    if color is not None:
        if not color.startswith("#") or len(color) != 7:
            raise ValueError(localized_text("errors.color_invalid"))
        try:
            int(color[1:], 16)
        except ValueError as error:
            raise ValueError(localized_text("errors.color_invalid")) from error
        color = color.upper()
    return color


def _clean_category_scope(
    msg: dict[str, Any]
) -> tuple[str, str | None, str | None]:
    """Validate a category scope and its optional list reference."""
    scope = msg["scope"]
    list_type = _clean_text(msg.get("list_type"), maximum=20, required=False)
    list_id = _clean_text(msg.get("list_id"), maximum=64, required=False)
    if scope == "global":
        list_type = None
        list_id = None
    elif scope == "list_type":
        if list_type not in LIST_TYPES:
            raise ValueError(localized_text("backend.select_valid_list_type"))
        list_id = None
    elif list_id is None:
        raise ValueError(localized_text("errors.category_list_required"))
    else:
        list_type = None
    return scope, list_type, list_id


def _clean_category_position(value: Any) -> int | None:
    """Validate an optional user-controlled category sort position."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 1_000_000:
        raise ValueError(localized_text("errors.category_position_invalid"))
    return value


def _clean_category_rules(value: Any) -> list[str]:
    """Validate the transport shape of simple category wildcard rules."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(localized_text("backend.assignment_rules_require_list"))
    if len(value) > 100:
        raise ValueError(localized_text("backend.category_rule_limit"))
    patterns = [
        _clean_text(pattern, maximum=100, required=True)
        for pattern in value
        if isinstance(pattern, str) and pattern.strip()
    ]
    if any(not pattern.replace("*", "").strip() for pattern in patterns):
        raise ValueError(localized_text("errors.rule_word_required"))
    return patterns


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/rules/list",
        probatio.Required("category_id"): str,
    }
)
async def websocket_list_category_rules(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return automatic item-name rules for one category."""
    try:
        rules = await _runtime(hass).database.async_list_category_rules(
            msg["category_id"]
        )
    except CategoryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_not_found")
        )
        return
    connection.send_result(msg["id"], {"rules": rules})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/rules/set",
        probatio.Required("category_id"): str,
        probatio.Required("patterns"): [str],
    }
)
async def websocket_set_category_rules(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Replace automatic item-name rules for one category."""
    try:
        rules = await _runtime(hass).database.async_replace_category_rules(
            msg["category_id"], _clean_category_rules(msg["patterns"])
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except CategoryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_not_found")
        )
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"rules": rules})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/rules/resolve",
        probatio.Required("list_id"): str,
        probatio.Required("name"): str,
    }
)
async def websocket_resolve_category_rule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Resolve the automatic category shown in a list-item dialog."""
    try:
        category = await _runtime(hass).database.async_resolve_category_rule(
            _clean_text(msg["list_id"], maximum=64, required=True),
            _clean_text(msg["name"], maximum=200, required=True),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    connection.send_result(
        msg["id"], {"category": category.as_dict() if category else None}
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/chips/resolve",
        probatio.Required("list_id"): str,
        probatio.Required("candidates"): [{
            probatio.Required("key"): str,
            probatio.Required("name"): str,
            probatio.Optional("product_id"): probatio.Any(str, None),
        }],
    }
)
async def websocket_resolve_chip_categories(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Resolve category-chip groups in one request."""
    try:
        raw_candidates = msg["candidates"]
        if len(raw_candidates) > 2000:
            raise ValueError(localized_text("backend.chip_query_limit"))
        candidates = [
            {
                "key": _clean_text(candidate["key"], maximum=200, required=True),
                "name": _clean_text(candidate["name"], maximum=200, required=True),
                "product_id": _clean_text(
                    candidate.get("product_id"), maximum=64, required=False
                ),
            }
            for candidate in raw_candidates
        ]
        resolved = await _runtime(hass).database.async_resolve_chip_categories(
            _clean_text(msg["list_id"], maximum=64, required=True), candidates
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    connection.send_result(
        msg["id"],
        {
            "resolutions": [
                {"key": key, "category": category.as_dict() if category else None}
                for key, category in resolved.items()
            ]
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/list",
        probatio.Optional("list_id"): str,
    }
)
async def websocket_list_categories(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return permanent and dynamically detected categories."""
    database = _runtime(hass).database
    list_id = msg.get("list_id")
    categories = await database.async_list_categories(list_id)
    dynamic = [] if list_id else await database.async_list_dynamic_categories()
    connection.send_result(
        msg["id"],
        {
            "categories": [category.as_dict() for category in categories],
            "dynamic": dynamic,
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/create",
        probatio.Required("name"): str,
        probatio.Required("scope"): probatio.In(("global", "list_type", "list")),
        probatio.Optional("list_type"): probatio.Any(str, None),
        probatio.Optional("list_id"): probatio.Any(str, None),
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Optional("position"): probatio.Any(int, None),
        probatio.Optional("rules"): [str],
    }
)
async def websocket_create_category(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a permanent category."""
    category = None
    database = _runtime(hass).database
    try:
        scope, list_type, list_id = _clean_category_scope(msg)
        patterns = _clean_category_rules(msg.get("rules"))
        category = await database.async_create_category(
            name=_clean_text(msg["name"], maximum=100, required=True),
            scope=scope,
            list_type=list_type,
            list_id=list_id,
            icon=_clean_text(msg.get("icon"), maximum=100, required=False),
            color=_clean_color(msg.get("color")),
            position=_clean_category_position(msg.get("position")),
        )
        rules = await database.async_replace_category_rules(category.id, patterns)
    except ValueError as error:
        if category is not None:
            await database.async_delete_category(category.id)
        _send_input_error(connection, msg, error)
        return
    except DuplicateCategoryError:
        _send_error(connection,
            msg["id"], "category_already_exists", localized_text("errors.category_exists")
        )
        return
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    _fire_lists_changed(hass)
    connection.send_result(
        msg["id"], {"category": category.as_dict(), "rules": rules}
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/update",
        probatio.Required("category_id"): str,
        probatio.Required("name"): str,
        probatio.Required("scope"): probatio.In(("global", "list_type", "list")),
        probatio.Optional("list_type"): probatio.Any(str, None),
        probatio.Optional("list_id"): probatio.Any(str, None),
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Optional("position"): probatio.Any(int, None),
        probatio.Optional("rules"): [str],
    }
)
async def websocket_update_category(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a permanent category."""
    try:
        scope, list_type, list_id = _clean_category_scope(msg)
        database = _runtime(hass).database
        category = await database.async_update_category(
            msg["category_id"],
            name=_clean_text(msg["name"], maximum=100, required=True),
            scope=scope,
            list_type=list_type,
            list_id=list_id,
            icon=_clean_text(msg.get("icon"), maximum=100, required=False),
            color=_clean_color(msg.get("color")),
            position=_clean_category_position(msg.get("position")),
        )
        rules = (
            await database.async_replace_category_rules(
                category.id, _clean_category_rules(msg.get("rules"))
            )
            if "rules" in msg
            else await database.async_list_category_rules(category.id)
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateCategoryError:
        _send_error(connection,
            msg["id"], "category_already_exists", localized_text("errors.category_exists")
        )
        return
    except (CategoryNotFoundError, ListNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_or_list_missing")
        )
        return
    _fire_lists_changed(hass)
    connection.send_result(
        msg["id"], {"category": category.as_dict(), "rules": rules}
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/delete",
        probatio.Required("category_id"): str,
    }
)
async def websocket_delete_category(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a permanent category definition."""
    try:
        await _runtime(hass).database.async_delete_category(msg["category_id"])
    except CategoryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_not_found")
        )
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"])


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/order/get",
        probatio.Optional("scope"): probatio.In(("global", "list_type", "list")),
        probatio.Optional("list_type"): str,
        probatio.Optional("list_id"): str,
    }
)
async def websocket_get_category_order(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return a base category order or one list's effective combined order."""
    if not _require_list_context(connection, msg):
        return
    if "scope" in msg and not connection.user.is_admin:
        _send_error(connection, msg["id"], "unauthorized", localized_text("errors.unauthorized"))
        return
    try:
        database = _runtime(hass).database
        if "scope" in msg:
            scope, list_type, list_id = _clean_category_scope(msg)
            categories = await database.async_get_category_base_order(
                scope, list_id, list_type
            )
            custom = False
        else:
            list_id = _clean_text(msg.get("list_id"), maximum=64, required=True)
            categories = await database.async_get_category_order(list_id)
            custom = await database.async_has_custom_category_order(list_id)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    connection.send_result(
        msg["id"],
        {
            "categories": [category.as_dict() for category in categories],
            "custom": custom,
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/order/set",
        probatio.Optional("scope"): probatio.In(("global", "list_type", "list")),
        probatio.Optional("list_type"): str,
        probatio.Optional("list_id"): str,
        probatio.Required("category_ids"): [str],
    }
)
async def websocket_set_category_order(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Store a base category order or a combined override for one list."""
    try:
        database = _runtime(hass).database
        if "scope" in msg:
            scope, list_type, list_id = _clean_category_scope(msg)
            categories = await database.async_set_category_base_order(
                scope, list_id, msg["category_ids"], list_type
            )
            custom = False
        else:
            list_id = _clean_text(msg.get("list_id"), maximum=64, required=True)
            categories = await database.async_set_category_order(
                list_id, msg["category_ids"]
            )
            custom = True
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    _fire_lists_changed(hass, msg.get("list_id") if "scope" not in msg else None)
    connection.send_result(
        msg["id"],
        {
            "categories": [category.as_dict() for category in categories],
            "custom": custom,
        },
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/categories/order/reset",
        probatio.Required("list_id"): str,
    }
)
async def websocket_reset_category_order(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Remove one list's combined override and return its inherited order."""
    try:
        categories = await _runtime(hass).database.async_reset_category_order(
            msg["list_id"]
        )
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.list_not_found"))
        return
    _fire_lists_changed(hass, msg.get("list_id") if "scope" not in msg else None)
    connection.send_result(
        msg["id"],
        {
            "categories": [category.as_dict() for category in categories],
            "custom": False,
        },
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/labels/list",
        probatio.Optional("list_id"): str,
    }
)
async def websocket_list_labels(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all reusable labels."""
    if not _require_list_context(connection, msg):
        return
    try:
        labels = await _runtime(hass).database.async_list_labels(msg.get("list_id"))
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    connection.send_result(
        msg["id"], {"labels": [label.as_dict() for label in labels]}
    )


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/labels/create",
        probatio.Required("name"): str,
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Optional("scope", default="global"): probatio.In(
            {"global", "list_type", "list"}
        ),
        probatio.Optional("list_type"): probatio.Any(
            probatio.In({"shopping", "inventory", "todo"}), None
        ),
        probatio.Optional("list_id"): probatio.Any(str, None),
    }
)
async def websocket_create_label(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a reusable label."""
    try:
        label = await _runtime(hass).database.async_create_label(
            name=_clean_text(msg["name"], maximum=100, required=True),
            icon=_clean_text(msg.get("icon"), maximum=100, required=False),
            color=_clean_color(msg.get("color")),
            scope=msg["scope"],
            list_type=msg.get("list_type"),
            list_id=msg.get("list_id"),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateLabelError:
        _send_error(connection, msg["id"], "label_already_exists", localized_text("errors.label_exists"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"label": label.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/labels/update",
        probatio.Required("label_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Optional("scope", default="global"): probatio.In(
            {"global", "list_type", "list"}
        ),
        probatio.Optional("list_type"): probatio.Any(
            probatio.In({"shopping", "inventory", "todo"}), None
        ),
        probatio.Optional("list_id"): probatio.Any(str, None),
    }
)
async def websocket_update_label(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a reusable label."""
    try:
        label = await _runtime(hass).database.async_update_label(
            msg["label_id"],
            name=_clean_text(msg["name"], maximum=100, required=True),
            icon=_clean_text(msg.get("icon"), maximum=100, required=False),
            color=_clean_color(msg.get("color")),
            scope=msg["scope"],
            list_type=msg.get("list_type"),
            list_id=msg.get("list_id"),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateLabelError:
        _send_error(connection, msg["id"], "label_already_exists", localized_text("errors.label_exists"))
        return
    except LabelNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.label_not_found"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"label": label.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/labels/delete",
        probatio.Required("label_id"): str,
    }
)
async def websocket_delete_label(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a reusable label and all of its assignments."""
    try:
        await _runtime(hass).database.async_delete_label(msg["label_id"])
    except LabelNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.label_not_found"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"])


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/chips/list",
        probatio.Optional("list_id"): str,
    }
)
async def websocket_list_chips(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all chips or the effective chips for one list."""
    if not _require_list_context(connection, msg):
        return
    try:
        chips = await _runtime(hass).database.async_list_chips(msg.get("list_id"))
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    connection.send_result(msg["id"], {"chips": [chip.as_dict() for chip in chips]})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/chips/create",
        probatio.Required("name"): str,
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Optional("scope", default="global"): probatio.In(
            {"global", "list_type", "list"}
        ),
        probatio.Optional("list_type"): probatio.Any(
            probatio.In({"shopping", "inventory", "todo"}), None
        ),
        probatio.Optional("list_id"): probatio.Any(str, None),
        probatio.Optional("product_id"): probatio.Any(str, None),
        probatio.Optional("chip_kind", default="entry"): probatio.In(
            {"entry", "todo_template"}
        ),
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("template_data"): probatio.Any(dict, None),
    }
)
async def websocket_create_chip(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a reusable quick-add chip."""
    if not _require_list_context(connection, msg):
        return
    if msg.get("scope", "global") != "list" and not connection.user.is_admin:
        _send_error(connection, msg["id"], "unauthorized", localized_text("errors.unauthorized"))
        return
    try:
        chip = await _runtime(hass).database.async_create_chip(
            name=_clean_text(msg["name"], maximum=100, required=True),
            color=_clean_color(msg.get("color")),
            scope=msg["scope"],
            list_type=msg.get("list_type"),
            list_id=msg.get("list_id"),
            product_id=msg.get("product_id"),
            chip_kind=msg["chip_kind"],
            icon=_clean_text(msg.get("icon"), maximum=100, required=False),
            template_data=msg.get("template_data"),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateChipError:
        _send_error(connection, msg["id"], "chip_already_exists", localized_text("errors.chip_exists"))
        return
    except ProductNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.product_not_found"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"chip": chip.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/chips/update",
        probatio.Required("chip_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Optional("scope", default="global"): probatio.In(
            {"global", "list_type", "list"}
        ),
        probatio.Optional("list_type"): probatio.Any(
            probatio.In({"shopping", "inventory", "todo"}), None
        ),
        probatio.Optional("list_id"): probatio.Any(str, None),
        probatio.Optional("product_id"): probatio.Any(str, None),
        probatio.Optional("chip_kind", default="entry"): probatio.In(
            {"entry", "todo_template"}
        ),
        probatio.Optional("icon"): probatio.Any(str, None),
        probatio.Optional("template_data"): probatio.Any(dict, None),
        probatio.Optional("replace_existing", default=False): bool,
    }
)
async def websocket_update_chip(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a reusable quick-add chip."""
    try:
        chip = await _runtime(hass).database.async_update_chip(
            msg["chip_id"],
            name=_clean_text(msg["name"], maximum=100, required=True),
            color=_clean_color(msg.get("color")),
            scope=msg["scope"],
            list_type=msg.get("list_type"),
            list_id=msg.get("list_id"),
            product_id=msg.get("product_id"),
            replace_existing=msg["replace_existing"],
            chip_kind=msg["chip_kind"],
            icon=_clean_text(msg.get("icon"), maximum=100, required=False),
            template_data=msg.get("template_data"),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateChipError:
        _send_error(connection, msg["id"], "chip_already_exists", localized_text("errors.chip_exists"))
        return
    except (ChipNotFoundError, ProductNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.chip_or_product_missing"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"chip": chip.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/chips/delete",
        probatio.Required("chip_id"): str,
    }
)
async def websocket_delete_chip(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a reusable quick-add chip."""
    try:
        await _runtime(hass).database.async_delete_chip(msg["chip_id"])
    except ChipNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.chip_not_found"))
        return
    _fire_lists_changed(hass)
    connection.send_result(msg["id"])


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/dishes/list",
        probatio.Optional("list_id"): str,
    }
)
async def websocket_list_dishes(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all dishes or the dishes enabled for one list."""
    if not _require_list_context(connection, msg):
        return
    try:
        dishes = await _runtime(hass).database.async_list_dishes(msg.get("list_id"))
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    connection.send_result(msg["id"], {"dishes": [dish.as_dict() for dish in dishes]})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/dishes/create",
        probatio.Required("name"): str,
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Required("items"): list,
    }
)
async def websocket_create_dish(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a central reusable dish."""
    try:
        dish = await _runtime(hass).database.async_create_dish(
            name=_clean_text(msg["name"], maximum=100, required=True),
            color=_clean_color(msg.get("color")), items=msg["items"],
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateDishError:
        _send_error(connection, msg["id"], "dish_already_exists", localized_text("backend.dish_already_exists"))
        return
    except ProductNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.product_not_found"))
        return
    connection.send_result(msg["id"], {"dish": dish.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/dishes/update",
        probatio.Required("dish_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("color"): probatio.Any(str, None),
        probatio.Required("items"): list,
    }
)
async def websocket_update_dish(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a central reusable dish."""
    try:
        dish = await _runtime(hass).database.async_update_dish(
            msg["dish_id"],
            name=_clean_text(msg["name"], maximum=100, required=True),
            color=_clean_color(msg.get("color")), items=msg["items"],
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateDishError:
        _send_error(connection, msg["id"], "dish_already_exists", localized_text("backend.dish_already_exists"))
        return
    except (DishNotFoundError, ProductNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.dish_or_product_not_found"))
        return
    connection.send_result(msg["id"], {"dish": dish.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/dishes/delete",
        probatio.Required("dish_id"): str,
    }
)
async def websocket_delete_dish(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete one central dish."""
    try:
        await _runtime(hass).database.async_delete_dish(msg["dish_id"])
    except DishNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.dish_not_found"))
        return
    connection.send_result(msg["id"])


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/dishes/add_to_list",
        probatio.Required("dish_id"): str,
        probatio.Required("list_id"): str,
        probatio.Optional("items"): list,
    }
)
async def websocket_add_dish_to_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Add selected ingredients of one dish to a shopping list."""
    try:
        result = await _runtime(hass).database.async_add_dish_to_list(
            msg["dish_id"], msg["list_id"], msg.get("items")
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except (DishNotFoundError, ListNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.dish_or_list_missing"))
        return
    except DishesDisabledError:
        _send_error(connection, msg["id"], "dishes_disabled", localized_text("backend.dishes_disabled"))
        return
    _fire_items_changed(hass, msg["list_id"])
    connection.send_result(msg["id"], result)


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/label_filters/list",
    probatio.Required("list_id"): str,
})
async def websocket_list_label_filters(hass, connection, msg) -> None:
    try:
        filters = await _runtime(hass).database.async_list_label_filters(connection.user.id, msg["list_id"])
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    connection.send_result(msg["id"], {"filters": filters})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/label_filters/save",
    probatio.Required("list_id"): str,
    probatio.Optional("filter_id"): str,
    probatio.Required("name"): str,
    probatio.Required("label_ids"): [str],
    probatio.Required("include_unlabeled"): bool,
    probatio.Optional("revision"): int,
})
async def websocket_save_label_filter(hass, connection, msg) -> None:
    try:
        record = await _runtime(hass).database.async_save_label_filter(
            connection.user.id, msg["list_id"], msg.get("filter_id"), msg["name"],
            msg["label_ids"], msg["include_unlabeled"], msg.get("revision"))
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    hass.bus.async_fire(EVENT_LISTS_CHANGED, {"list_id": msg["list_id"],
                        "user_id": connection.user.id, "label_filters": True})
    connection.send_result(msg["id"], {"filter": record})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/label_filters/delete",
    probatio.Required("list_id"): str,
    probatio.Required("filter_id"): str,
    probatio.Required("revision"): int,
})
async def websocket_delete_label_filter(hass, connection, msg) -> None:
    try:
        await _runtime(hass).database.async_delete_label_filter(
            connection.user.id, msg["list_id"], msg["filter_id"], msg["revision"])
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    hass.bus.async_fire(EVENT_LISTS_CHANGED, {"list_id": msg["list_id"],
                        "user_id": connection.user.id, "label_filters": True})
    connection.send_result(msg["id"])


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/chips/important/list",
        probatio.Required("list_id"): str,
    }
)
async def websocket_list_important_chips(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return list-specific important chip and product targets."""
    try:
        assignments = await _runtime(
            hass
        ).database.async_list_important_chip_assignments(msg["list_id"])
    except ListNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.list_not_found"))
        return
    connection.send_result(msg["id"], {"assignments": assignments})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/chips/important/set",
        probatio.Required("list_id"): str,
        probatio.Required("target_type"): probatio.In({"chip", "product"}),
        probatio.Required("target_id"): str,
        probatio.Required("important"): bool,
    }
)
async def websocket_set_important_chip(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Add or remove a list-specific important-chip target."""
    try:
        await _runtime(hass).database.async_set_important_chip_assignment(
            msg["list_id"],
            msg["target_type"],
            msg["target_id"],
            msg["important"],
        )
    except (ListNotFoundError, ChipNotFoundError, ProductNotFoundError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("backend.chip_not_found"))
        return
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    _fire_items_changed(hass, msg["list_id"])
    connection.send_result(msg["id"])


def _clean_stock(value: Any, *, optional: bool = False) -> int | None:
    """Validate stock values received from the frontend."""
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(localized_text("errors.stock_integer_required"))
    if value < 0 or value > 1000000:
        raise ValueError(localized_text("errors.stock_invalid"))
    return value


def _inventory_product_name(
    hass: HomeAssistant, name: str, brand: str | None, quantity: str | None
) -> str:
    """Apply the configured product-name defaults without duplicating a brand."""
    options = _runtime(hass).config_entry.options
    parts = [name]
    if (
        options.get("append_brand_to_product_name", False)
        and brand
        and brand.casefold() not in name.casefold()
    ):
        parts.append(brand)
    if options.get("append_quantity_to_product_name", False) and quantity:
        parts.append(quantity)
    return " – ".join(parts)


def _fire_inventory_changed(
    hass: HomeAssistant, *, list_id: str, entry_id: str | None
) -> None:
    """Notify open cards after a persisted inventory change."""
    hass.bus.async_fire(
        EVENT_INVENTORY_CHANGED,
        {"list_id": list_id, "entry_id": entry_id},
    )


@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/inventory/lists"}
)
async def websocket_list_inventory_lists(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return inventory lists available to a card."""
    records = await _runtime(hass).database.async_list_inventory_lists()
    connection.send_result(msg["id"], {"lists": [record.as_dict() for record in records]})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/list",
        probatio.Required("list_id"): str,
    }
)
async def websocket_list_inventory(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all product stock records of an inventory list."""
    try:
        records = await _runtime(hass).database.async_list_inventory(msg["list_id"])
    except (ListNotFoundError, InventoryListRequiredError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_missing")
        )
        return
    connection.send_result(
        msg["id"], {"entries": [record.as_dict() for record in records]}
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/options",
        probatio.Required("list_id"): str,
        probatio.Optional("search"): str,
    }
)
async def websocket_inventory_options(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return products and permitted categories for the inventory input."""
    database = _runtime(hass).database
    list_id = msg["list_id"]
    try:
        inventory_lists = await database.async_list_inventory_lists()
        inventory_list = next((record for record in inventory_lists if record.id == list_id), None)
        if inventory_list is None:
            raise InventoryListRequiredError(list_id)
        products = await database.async_list_products(
            _clean_text(msg.get("search"), maximum=200, required=False), None
        )
        ordered_categories = await database.async_get_category_order(list_id)
        labels = await database.async_list_labels(list_id)
    except (ListNotFoundError, InventoryListRequiredError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_missing")
        )
        return
    allowed_categories = [
        {**category.as_dict(), "manual_position": position}
        for position, category in enumerate(ordered_categories)
    ]
    effective_labels = {label.name.casefold(): label for label in labels}

    def product_labels(product):
        return list({
            label.name.casefold(): effective_labels[label.name.casefold()].as_dict()
            for label in product.labels
            if label.name.casefold() in effective_labels and (
                label.scope == "global" and inventory_list.use_global_labels
                or label.scope == "list_type" and label.list_type == inventory_list.list_type
                and inventory_list.use_type_labels
                or label.scope == "list" and label.list_id == list_id
            )
        }.values())

    connection.send_result(
        msg["id"],
        {
            "products": [
                {**product.as_dict(), "labels": product_labels(product)} for product in products
            ],
            "categories": allowed_categories,
            "labels": [label.as_dict() for label in labels],
        },
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/lookup",
        probatio.Required("ean"): str,
    }
)
async def websocket_inventory_lookup_product(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Resolve an EAN for the inventory dialog without persisting it."""
    try:
        ean = _clean_ean(msg["ean"])
        if ean is None:
            raise ValueError(localized_text("errors.ean_required"))
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    database = _runtime(hass).database
    local_product = await database.async_get_product_by_ean(ean)
    if local_product is not None:
        connection.send_result(
            msg["id"], {"local": True, "product": local_product.as_dict()}
        )
        return
    try:
        lookup = await async_lookup_open_facts(hass, ean)
    except OpenFactsLookupError:
        _send_error(connection,
            msg["id"], "lookup_unavailable", localized_text("errors.open_facts_unavailable")
        )
        return
    if lookup is None:
        _send_error(connection,
            msg["id"], "product_not_found", localized_text("errors.ean_product_missing")
        )
        return
    connection.send_result(
        msg["id"],
        {
            "local": False,
            "product": {
                "ean": ean,
                "name": _inventory_product_name(
                    hass,
                    lookup["name"],
                    lookup.get("brand"),
                    lookup.get("package_quantity"),
                ),
                "original_name": lookup["name"],
                "brand": lookup.get("brand"),
                "package_quantity": lookup.get("package_quantity"),
                "image_url": lookup.get("image_url"),
            },
        },
    )


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/add",
        probatio.Required("list_id"): str,
        probatio.Required("value"): str,
        probatio.Required("quantity"): int,
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("product_id"): probatio.Any(str, None),
        probatio.Optional("ean"): probatio.Any(str, None),
        probatio.Optional("name"): probatio.Any(str, None),
        probatio.Optional("original_name"): probatio.Any(str, None),
        probatio.Optional("brand"): probatio.Any(str, None),
        probatio.Optional("package_quantity"): probatio.Any(str, None),
        probatio.Optional("image_url"): probatio.Any(str, None),
        probatio.Optional("label_ids"): [str],
    }
)
async def websocket_add_inventory_product(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Resolve a product name or EAN and add it to one inventory list."""
    try:
        value = _clean_text(msg["value"], maximum=200, required=True)
        quantity = _clean_stock(msg["quantity"])
        category_id = _clean_text(
            msg.get("category_id"), maximum=64, required=False
        )
        category = _clean_text(msg.get("category"), maximum=100, required=False)
        minimum_stock = _clean_stock(msg.get("minimum_stock"), optional=True)
        product_id = _clean_text(msg.get("product_id"), maximum=64, required=False)
        explicit_ean = _clean_ean(msg.get("ean"))
        explicit_name = _clean_text(msg.get("name"), maximum=200, required=False)
        explicit_original_name = _clean_text(
            msg.get("original_name"), maximum=200, required=False
        )
        explicit_brand = _clean_text(msg.get("brand"), maximum=200, required=False)
        explicit_quantity = _clean_text(
            msg.get("package_quantity"), maximum=100, required=False
        )
        explicit_image = _clean_text(
            msg.get("image_url"), maximum=1000, required=False
        )
        labels_supplied = "label_ids" in msg
        explicit_label_ids = _clean_label_ids(msg.get("label_ids"))
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return

    database = _runtime(hass).database
    product = None
    is_ean = explicit_ean is not None or (value.isdigit() and 4 <= len(value) <= 32)
    try:
        inventory_entries = await database.async_list_inventory(msg["list_id"])
        products = await database.async_list_products(None, None)
        if product_id:
            product = next((item for item in products if item.id == product_id), None)
            if product is None:
                raise ProductNotFoundError(product_id)
        elif is_ean:
            ean = explicit_ean or value
            product = await database.async_get_product_by_ean(ean)
            if product is None:
                lookup = await async_lookup_open_facts(hass, ean)
                if lookup is None:
                    if not explicit_name:
                        _send_error(connection,
                            msg["id"], "product_not_found", localized_text("errors.ean_product_missing")
                        )
                        return
                    lookup = {
                        "name": explicit_original_name or explicit_name,
                        "brand": explicit_brand,
                        "package_quantity": explicit_quantity,
                        "image_url": explicit_image,
                    }
                original_name = explicit_original_name or lookup.get("name") or explicit_name or ean
                brand = explicit_brand or lookup.get("brand")
                package_quantity = explicit_quantity or lookup.get("package_quantity")
                product = await database.async_create_product(
                    ean=ean,
                    name=explicit_name or _inventory_product_name(
                        hass, original_name, brand, package_quantity
                    ),
                    original_name=original_name,
                    brand=brand,
                    package_quantity=package_quantity,
                    category=None,
                    image_url=explicit_image or lookup.get("image_url"),
                    source="open_food_facts",
                    label_ids=explicit_label_ids,
                )
        else:
            matches = products
            product = next(
                (item for item in matches if item.name.casefold() == value.casefold()),
                None,
            )
            if product is None:
                product = await database.async_create_product(
                    ean=None,
                    name=explicit_name or value,
                    original_name=explicit_original_name,
                    brand=explicit_brand,
                    package_quantity=explicit_quantity,
                    category=None,
                    image_url=explicit_image,
                    source="manual",
                    label_ids=explicit_label_ids,
                )

        if product is not None and labels_supplied:
            product = await database.async_update_product(
                product.id,
                ean=product.ean,
                name=product.name,
                original_name=product.original_name,
                brand=product.brand,
                package_quantity=product.package_quantity,
                category=None,
                image_url=product.image_url,
                label_ids=explicit_label_ids,
                list_id=msg["list_id"],
            )
            _fire_lists_changed(hass)

        existing = next(
            (
                entry
                for entry in inventory_entries
                if entry.product_id == product.id
            ),
            None,
        )
        if existing is not None:
            record = await database.async_update_inventory_entry(
                existing.id,
                stock=existing.stock + quantity,
                minimum_stock=minimum_stock if minimum_stock is not None else existing.minimum_stock,
                category_id=category_id if category_id is not None else existing.category_id,
                category=category if category is not None else existing.category_name,
                hidden=False,
            )
        else:
            record = await database.async_create_inventory_entry(
                list_id=msg["list_id"],
                product_id=product.id,
                stock=quantity,
                minimum_stock=minimum_stock,
                category_id=category_id,
                category=category,
            )
    except OpenFactsLookupError:
        _send_error(connection,
            msg["id"], "lookup_unavailable", localized_text("errors.open_facts_unavailable")
        )
        return
    except (ListNotFoundError, InventoryListRequiredError, ProductNotFoundError, CategoryNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_assignment_missing")
        )
        return
    except (DuplicateEANError, DuplicateInventoryProductError):
        _send_error(connection, msg["id"], "duplicate", localized_text("errors.product_exists"))
        return
    _fire_inventory_changed(hass, list_id=record.list_id, entry_id=record.id)
    connection.send_result(msg["id"], {"entry": record.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/create",
        probatio.Required("list_id"): str,
        probatio.Required("product_id"): str,
        probatio.Required("stock"): int,
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("restock_quantity"): int,
        probatio.Optional("restock_mode"): probatio.Any(str, None),
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("hidden"): bool,
    }
)
async def websocket_create_inventory_entry(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Assign a product to an inventory list."""
    try:
        record = await _runtime(hass).database.async_create_inventory_entry(
            list_id=msg["list_id"],
            product_id=msg["product_id"],
            stock=_clean_stock(msg["stock"]),
            minimum_stock=_clean_stock(msg.get("minimum_stock"), optional=True),
            restock_quantity=_clean_stock(msg.get("restock_quantity", 1)),
            restock_mode=msg.get("restock_mode", "inherit"),
            category_id=_clean_text(msg.get("category_id"), maximum=64, required=False),
            category=_clean_text(msg.get("category"), maximum=100, required=False),
            hidden=msg.get("hidden", False),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateInventoryProductError:
        _send_error(connection,
            msg["id"], "inventory_product_exists", localized_text("errors.inventory_product_exists")
        )
        return
    except (ListNotFoundError, InventoryListRequiredError, ProductNotFoundError, CategoryNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_product_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=record.list_id, entry_id=record.id)
    connection.send_result(msg["id"], {"entry": record.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/update",
        probatio.Required("entry_id"): str,
        probatio.Required("stock"): int,
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("restock_quantity"): int,
        probatio.Optional("restock_mode"): probatio.Any(str, None),
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("hidden"): bool,
        probatio.Optional("label_ids"): [str],
    }
)
async def websocket_update_inventory_entry(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Correct stock, configure restocking and optionally edit product labels."""
    try:
        record = await _runtime(hass).database.async_update_inventory_entry(
            msg["entry_id"],
            stock=_clean_stock(msg["stock"]),
            minimum_stock=_clean_stock(msg.get("minimum_stock"), optional=True),
            restock_quantity=_clean_stock(msg.get("restock_quantity"), optional=True),
            restock_mode=msg.get("restock_mode"),
            category_id=_clean_text(msg.get("category_id"), maximum=64, required=False),
            category=_clean_text(msg.get("category"), maximum=100, required=False),
            hidden=msg.get("hidden", False),
            label_ids=_clean_label_ids(msg["label_ids"]) if "label_ids" in msg else None,
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except LabelNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.category_or_label_missing")
        )
        return
    except (InventoryEntryNotFoundError, CategoryNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_entry_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=record.list_id, entry_id=record.id)
    if "label_ids" in msg:
        _fire_lists_changed(hass)
    connection.send_result(msg["id"], {"entry": record.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/visibility",
        probatio.Required("entry_id"): str,
        probatio.Required("hidden"): bool,
    }
)
async def websocket_set_inventory_hidden(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Persist the visible state selected from an inventory card."""
    try:
        record = await _runtime(hass).database.async_set_inventory_hidden(
            msg["entry_id"], msg["hidden"]
        )
    except InventoryEntryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_entry_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=record.list_id, entry_id=record.id)
    connection.send_result(msg["id"], {"entry": record.as_dict()})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/undo",
    probatio.Required("token"): str,
    probatio.Optional("include_transfer", default=False): bool,
})
async def websocket_undo_inventory_booking(hass, connection, msg) -> None:
    """Reverse only a still-current booking, never a newer user's change."""
    try:
        result = await _runtime(hass).database.async_undo_inventory_booking(msg["token"], msg["include_transfer"])
    except (ValueError, InventoryEntryNotFoundError) as error:
        _send_input_error(connection, msg, error)
        return
    _fire_inventory_changed(hass, list_id=result["list_id"], entry_id=result["entry"]["id"] if result["entry"] else None)
    if result["target_list_id"]:
        _fire_items_changed(hass, result["target_list_id"])
    connection.send_result(msg["id"], result)


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/adjust",
        probatio.Required("entry_id"): str,
        probatio.Required("delta"): int,
    }
)
async def websocket_adjust_inventory_entry(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Adjust stock from an inventory card."""
    delta = msg["delta"]
    if isinstance(delta, bool) or delta == 0 or abs(delta) > 1000000:
        _send_input_error(connection, msg, ValueError(localized_text("errors.delta_invalid")))
        return
    try:
        result = await _runtime(hass).database.async_adjust_inventory_with_restock(
            msg["entry_id"], delta
        )
    except InventoryEntryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_entry_missing")
        )
        return
    record = result["entry"]
    _fire_inventory_changed(hass, list_id=record["list_id"], entry_id=record["id"])
    if result.get("transfer"):
        _fire_items_changed(hass, result["transfer"]["target_list_id"])
    connection.send_result(msg["id"], result)


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/restock/settings/get",
    probatio.Required("list_id"): str,
})
async def websocket_get_inventory_restock_settings(hass, connection, msg) -> None:
    """Return automatic restock settings."""
    try:
        settings = await _runtime(hass).database.async_get_inventory_restock_settings(msg["list_id"])
    except (ListNotFoundError, InventoryListRequiredError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_missing"))
        return
    connection.send_result(msg["id"], {"settings": settings.as_dict()})


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/restock/settings/set",
    probatio.Required("list_id"): str,
    probatio.Optional("target_list_id"): probatio.Any(str, None),
    probatio.Required("enabled"): bool,
    probatio.Optional("mode"): probatio.Any(str, None),
    probatio.Optional("fixed_quantity"): probatio.Any(int, None),
})
async def websocket_set_inventory_restock_settings(hass, connection, msg) -> None:
    """Persist automatic restock settings."""
    try:
        settings = await _runtime(hass).database.async_set_inventory_restock_settings(
            msg["list_id"], msg.get("target_list_id"), msg["enabled"],
            msg.get("mode"), _clean_stock(msg.get("fixed_quantity"), optional=True),
        )
    except (ValueError, ListNotFoundError, InventoryListRequiredError) as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"settings": settings.as_dict()})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/restock/preview",
    probatio.Required("list_id"): str,
})
async def websocket_preview_inventory_restock(hass, connection, msg) -> None:
    """Preview current shortages and existing open quantities."""
    try:
        result = await _runtime(hass).database.async_preview_inventory_restock(msg["list_id"])
    except (ListNotFoundError, InventoryListRequiredError) as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], result)


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/restock/apply",
    probatio.Required("list_id"): str,
})
async def websocket_apply_inventory_restock(hass, connection, msg) -> None:
    """Transfer current shortages after an explicit card confirmation."""
    try:
        result = await _runtime(hass).database.async_apply_inventory_restock(msg["list_id"])
    except (ValueError, ListNotFoundError, InventoryListRequiredError) as error:
        _send_input_error(connection, msg, error)
        return
    _fire_items_changed(hass, result["target_list_id"])
    connection.send_result(msg["id"], result)


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/restock/latch/reset",
    probatio.Required("list_id"): str,
    probatio.Required("source_type"): str,
    probatio.Required("source_id"): str,
})
async def websocket_reset_inventory_restock_latch(hass, connection, msg) -> None:
    """Reset a fixed-mode latch."""
    try:
        await _runtime(hass).database.async_reset_inventory_restock_latch(
            msg["list_id"], msg["source_type"], msg["source_id"]
        )
    except (ValueError, ListNotFoundError, InventoryListRequiredError) as error:
        _send_input_error(connection, msg, error)
        return
    _fire_inventory_changed(hass, list_id=msg["list_id"], entry_id=None)
    connection.send_result(msg["id"], {"success": True})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/inventory/restock/confirm_zero",
    probatio.Required("entry_id"): str,
    probatio.Required("quantity"): int,
})
async def websocket_confirm_zero_stock_restock(hass, connection, msg) -> None:
    """Confirm adding a removal attempted while stock was already zero."""
    try:
        result = await _runtime(hass).database.async_confirm_zero_stock_restock(
            msg["entry_id"], msg["quantity"]
        )
    except (ValueError, InventoryEntryNotFoundError) as error:
        _send_input_error(connection, msg, error)
        return
    _fire_items_changed(hass, result["target_list_id"])
    connection.send_result(msg["id"], {"transfer": result})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/delete",
        probatio.Required("entry_id"): str,
    }
)
async def websocket_delete_inventory_entry(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Remove a product from an inventory list."""
    try:
        list_id = await _runtime(hass).database.async_delete_inventory_entry(
            msg["entry_id"]
        )
    except InventoryEntryNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_entry_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=list_id, entry_id=None)
    connection.send_result(msg["id"], {"success": True})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/groups/list",
        probatio.Required("list_id"): str,
    }
)
async def websocket_list_inventory_groups(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all explicit variant groups of an inventory list."""
    try:
        groups = await _runtime(hass).database.async_list_inventory_groups(
            msg["list_id"]
        )
    except (ListNotFoundError, InventoryListRequiredError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_missing")
        )
        return
    connection.send_result(
        msg["id"], {"groups": [group.as_dict() for group in groups]}
    )


def _inventory_group_payload(msg: dict[str, Any]) -> dict[str, Any]:
    """Validate the shared group create/update payload."""
    return {
        "name": _clean_text(msg["name"], maximum=200, required=True),
        "minimum_stock": _clean_stock(msg.get("minimum_stock"), optional=True),
        "restock_quantity": _clean_stock(
            msg.get("restock_quantity", None if "group_id" in msg else 1),
            optional="group_id" in msg,
        ),
        "restock_mode": msg.get("restock_mode", None if "group_id" in msg else "inherit"),
        "category_id": _clean_text(
            msg.get("category_id"), maximum=64, required=False
        ),
        "category": _clean_text(msg.get("category"), maximum=100, required=False),
        "member_ids": list(dict.fromkeys(msg["member_ids"])),
    }


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/groups/create",
        probatio.Required("list_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("restock_quantity"): int,
        probatio.Optional("restock_mode"): probatio.Any(str, None),
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Required("member_ids"): [str],
    }
)
async def websocket_create_inventory_group(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create a list-local inventory group."""
    try:
        group = await _runtime(hass).database.async_create_inventory_group(
            list_id=msg["list_id"], **_inventory_group_payload(msg)
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except InvalidInventoryGroupMembersError as error:
        _send_error(connection, msg["id"], "invalid_group_members", error)
        return
    except DuplicateInventoryGroupError:
        _send_error(connection,
            msg["id"], "duplicate_inventory_group", localized_text("errors.group_name_exists")
        )
        return
    except (ListNotFoundError, InventoryListRequiredError, CategoryNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_category_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=group.list_id, entry_id=None)
    connection.send_result(msg["id"], {"group": group.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/groups/update",
        probatio.Required("group_id"): str,
        probatio.Required("name"): str,
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("restock_quantity"): int,
        probatio.Optional("restock_mode"): probatio.Any(str, None),
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Required("member_ids"): [str],
    }
)
async def websocket_update_inventory_group(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update a list-local inventory group and its members."""
    try:
        group = await _runtime(hass).database.async_update_inventory_group(
            msg["group_id"], **_inventory_group_payload(msg)
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except InvalidInventoryGroupMembersError as error:
        _send_error(connection, msg["id"], "invalid_group_members", error)
        return
    except DuplicateInventoryGroupError:
        _send_error(connection,
            msg["id"], "duplicate_inventory_group", localized_text("errors.group_name_exists")
        )
        return
    except (InventoryGroupNotFoundError, CategoryNotFoundError):
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_group_category_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=group.list_id, entry_id=None)
    connection.send_result(msg["id"], {"group": group.as_dict()})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/inventory/groups/delete",
        probatio.Required("group_id"): str,
    }
)
async def websocket_delete_inventory_group(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Dissolve an inventory group without deleting its products."""
    try:
        list_id = await _runtime(hass).database.async_delete_inventory_group(
            msg["group_id"]
        )
    except InventoryGroupNotFoundError:
        _send_error(connection,
            msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_group_missing")
        )
        return
    _fire_inventory_changed(hass, list_id=list_id, entry_id=None)
    connection.send_result(msg["id"])


def _clean_scanner_address(value: Any) -> str:
    address = normalize_scanner_address(
        _clean_text(value, maximum=100, required=True)
    )
    if not address:
        raise ValueError(localized_text("errors.scanner_address_required"))
    return address


def _scanner_route_values(msg: dict[str, Any]) -> tuple[str, str | None, str | None]:
    routing = msg["routing"]
    list_id = _clean_text(msg.get("list_id"), maximum=64, required=False)
    action = msg.get("action")
    if routing == "active_target":
        return routing, None, None
    if list_id is None or action not in SCANNER_ACTIONS:
        raise ValueError(localized_text("errors.scanner_route_required"))
    return routing, list_id, action


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/scanners/list"}
)
async def websocket_list_scanners(hass, connection, msg) -> None:
    records = await _runtime(hass).database.async_list_scanners()
    connection.send_result(msg["id"], {"scanners": [item.as_dict() for item in records]})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanners/create",
        probatio.Required("name"): str,
        probatio.Required("address"): str,
        probatio.Required("enabled"): bool,
        probatio.Required("routing"): probatio.In(SCANNER_ROUTING),
        probatio.Optional("list_id"): probatio.Any(str, None),
        probatio.Optional("action"): probatio.Any(probatio.In(SCANNER_ACTIONS), None),
    }
)
async def websocket_create_scanner(hass, connection, msg) -> None:
    try:
        routing, list_id, action = _scanner_route_values(msg)
        record = await _runtime(hass).database.async_create_scanner(
            name=_clean_text(msg["name"], maximum=100, required=True),
            address=_clean_scanner_address(msg["address"]),
            enabled=msg["enabled"], routing=routing,
            list_id=list_id, action=action,
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateScannerAddressError:
        _send_error(connection, msg["id"], "scanner_exists", localized_text("errors.scanner_address_exists"))
        return
    except (ListNotFoundError, InventoryListRequiredError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_missing"))
        return
    connection.send_result(msg["id"], {"scanner": record.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanners/update",
        probatio.Required("scanner_id"): str,
        probatio.Required("name"): str,
        probatio.Required("address"): str,
        probatio.Required("enabled"): bool,
        probatio.Required("routing"): probatio.In(SCANNER_ROUTING),
        probatio.Optional("list_id"): probatio.Any(str, None),
        probatio.Optional("action"): probatio.Any(probatio.In(SCANNER_ACTIONS), None),
    }
)
async def websocket_update_scanner(hass, connection, msg) -> None:
    try:
        routing, list_id, action = _scanner_route_values(msg)
        record = await _runtime(hass).database.async_update_scanner(
            msg["scanner_id"],
            name=_clean_text(msg["name"], maximum=100, required=True),
            address=_clean_scanner_address(msg["address"]),
            enabled=msg["enabled"], routing=routing,
            list_id=list_id, action=action,
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    except DuplicateScannerAddressError:
        _send_error(connection, msg["id"], "scanner_exists", localized_text("errors.scanner_address_exists"))
        return
    except (ScannerNotFoundError, ListNotFoundError, InventoryListRequiredError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.scanner_inventory_missing"))
        return
    connection.send_result(msg["id"], {"scanner": record.as_dict()})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanners/delete",
        probatio.Required("scanner_id"): str,
    }
)
async def websocket_delete_scanner(hass, connection, msg) -> None:
    try:
        await _runtime(hass).database.async_delete_scanner(msg["scanner_id"])
    except ScannerNotFoundError:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.scanner_not_found"))
        return
    connection.send_result(msg["id"])


@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/scanner/target/get"}
)
async def websocket_get_scanner_target(hass, connection, msg) -> None:
    target = await _runtime(hass).database.async_get_scanner_target()
    connection.send_result(msg["id"], {"target": target.as_dict() if target else None})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/target/set",
        probatio.Required("list_id"): str,
        probatio.Required("action"): probatio.In(SCANNER_ACTIONS),
    }
)
async def websocket_set_scanner_target(hass, connection, msg) -> None:
    try:
        target = await _runtime(hass).scanner.async_set_target(
            msg["list_id"], msg["action"]
        )
    except (ListNotFoundError, InventoryListRequiredError):
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.inventory_list_missing"))
        return
    connection.send_result(msg["id"], {"target": target.as_dict()})


@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/scanner/target/clear"}
)
async def websocket_clear_scanner_target(hass, connection, msg) -> None:
    await _runtime(hass).scanner.async_clear_target()
    connection.send_result(msg["id"], {"target": None})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/simulate",
        probatio.Required("ean"): str,
        probatio.Required("list_id"): str,
        probatio.Required("action"): probatio.In(SCANNER_ACTIONS),
        probatio.Optional("scanner_id"): probatio.Any(str, None),
        probatio.Optional("quantity", default=1): int,
        probatio.Optional("corrected_stock"): probatio.Any(int, None),
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("delay_seconds", default=0): int,
    }
)
async def websocket_simulate_scan(hass, connection, msg) -> None:
    quantity = msg.get("quantity", 1)
    corrected_stock = msg.get("corrected_stock")
    delay_seconds = msg.get("delay_seconds", 0)
    if isinstance(quantity, bool) or not 1 <= quantity <= 1_000_000:
        _send_input_error(connection, msg, ValueError(localized_text("errors.positive_quantity_invalid")))
        return
    if corrected_stock is not None and (
        isinstance(corrected_stock, bool) or not 0 <= corrected_stock <= 1_000_000
    ):
        _send_input_error(connection, msg, ValueError(localized_text("errors.stock_invalid")))
        return
    if isinstance(delay_seconds, bool) or not 0 <= delay_seconds <= 300:
        _send_input_error(connection, msg, ValueError(localized_text("errors.delay_invalid")))
        return
    scan = {
        "ean": msg["ean"], "source": "simulation",
        "scanner_id": msg.get("scanner_id"), "list_id": msg["list_id"],
        "action": msg["action"], "quantity": quantity,
        "corrected_stock": corrected_stock,
    }
    if delay_seconds:
        hass.async_create_task(_async_delayed_simulation(hass, delay_seconds, scan))
        connection.send_result(msg["id"], {
            "scheduled": True, "delay_seconds": delay_seconds,
            "message": localized_text("backend.scan_scheduled", p0=delay_seconds),
        })
        return
    result = await _runtime(hass).scanner.async_process_scan(
        **scan,
    )
    connection.send_result(msg["id"], result)


async def _async_delayed_simulation(
    hass: HomeAssistant, delay_seconds: int, scan: dict[str, Any]
) -> None:
    """Run a simulated scan independently of the administration frontend."""
    await asyncio.sleep(delay_seconds)
    await _runtime(hass).scanner.async_process_scan(**scan)


@websocket_api.require_admin
@localized_command(
    {probatio.Required("type"): f"{DOMAIN}/scanner/queue/list"}
)
async def websocket_pending_scans(hass, connection, msg) -> None:
    """Return scans waiting for product data or a corrected stock value."""
    records = await _runtime(hass).scanner.async_pending_scans()
    connection.send_result(msg["id"], {"scans": records})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/queue/list_for_list",
        probatio.Required("list_id"): str,
    }
)
async def websocket_pending_scans_for_list(hass, connection, msg) -> None:
    """Return actionable scans for one inventory card."""
    scans = await _runtime(hass).scanner.async_pending_scans(msg["list_id"])
    connection.send_result(msg["id"], {"scans": scans})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/queue/hold",
        probatio.Required("scan_id"): str,
    }
)
async def websocket_hold_pending_scan(hass, connection, msg) -> None:
    """Legacy view notification; opening a scan never claims its editor slot."""
    record = await _runtime(hass).database.async_get_scan_history_record(msg["scan_id"])
    if record is None or record.status not in {"queued", "offered", "needs_input"}:
        _send_error(connection, msg["id"], websocket_api.ERR_NOT_FOUND, localized_text("errors.offered_scan_missing"))
        return
    connection.send_result(msg["id"], {"scan": record.as_dict()})


def _clean_scan_session(value: str) -> str:
    return _clean_text(value, maximum=100, required=True)


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/scanner/queue/view",
    probatio.Required("scan_id"): str,
    probatio.Required("session_id"): str,
    probatio.Optional("open", default=True): bool,
})
async def websocket_view_pending_scan(hass, connection, msg) -> None:
    try:
        record = await _runtime(hass).scanner.async_view_pending_scan(
            msg["scan_id"], _clean_scan_session(msg["session_id"]), connection, msg["open"])
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"scan": record})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/scanner/queue/edit",
    probatio.Required("scan_id"): str,
    probatio.Required("session_id"): str,
})
async def websocket_edit_pending_scan(hass, connection, msg) -> None:
    try:
        record = await _runtime(hass).scanner.async_edit_pending_scan(
            msg["scan_id"], _clean_scan_session(msg["session_id"]), connection)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"scan": record})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/scanner/queue/release",
    probatio.Required("scan_id"): str,
    probatio.Required("session_id"): str,
})
async def websocket_release_pending_scan(hass, connection, msg) -> None:
    try:
        record = await _runtime(hass).scanner.async_release_pending_scan(
            msg["scan_id"], _clean_scan_session(msg["session_id"]), connection)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"scan": record})


@localized_command({
    probatio.Required("type"): f"{DOMAIN}/scanner/queue/discard",
    probatio.Required("scan_id"): str,
    probatio.Required("session_id"): str,
})
async def websocket_discard_pending_scan(hass, connection, msg) -> None:
    try:
        record = await _runtime(hass).scanner.async_discard_pending_scan(
            msg["scan_id"], session_id=_clean_scan_session(msg["session_id"]), connection=connection)
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"success": True, "scan": record})


@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/queue/resolve",
        probatio.Required("scan_id"): str,
        probatio.Optional("session_id"): str,
        probatio.Optional("corrected_stock"): probatio.Any(int, None),
        probatio.Optional("minimum_stock"): probatio.Any(int, None),
        probatio.Optional("restock_quantity"): int,
        probatio.Optional("restock_mode"): probatio.Any(str, None),
        probatio.Optional("category_id"): probatio.Any(str, None),
        probatio.Optional("category"): probatio.Any(str, None),
        probatio.Optional("name"): probatio.Any(str, None),
        probatio.Optional("original_name"): probatio.Any(str, None),
        probatio.Optional("brand"): probatio.Any(str, None),
        probatio.Optional("package_quantity"): probatio.Any(str, None),
        probatio.Optional("product_category"): probatio.Any(str, None),
        probatio.Optional("image_url"): probatio.Any(str, None),
        probatio.Optional("label_ids"): [str],
        probatio.Optional("restock_zero", default=False): bool,
    }
)
async def websocket_resolve_pending_scan(hass, connection, msg) -> None:
    """Complete one pending scan from a card or the administration panel."""
    try:
        corrected_stock = _clean_stock(msg.get("corrected_stock"), optional=True)
        product_data = None
        product_label_ids = (
            _clean_label_ids(msg["label_ids"]) if "label_ids" in msg else None
        )
        if msg.get("name") is not None:
            product_data = {
                "name": _clean_text(msg.get("name"), maximum=300, required=True),
                "original_name": _clean_text(msg.get("original_name"), maximum=300, required=False),
                "brand": _clean_text(msg.get("brand"), maximum=200, required=False),
                "package_quantity": _clean_text(msg.get("package_quantity"), maximum=100, required=False),
                "product_category": _clean_text(msg.get("product_category"), maximum=200, required=False),
                "image_url": _clean_text(msg.get("image_url"), maximum=2000, required=False),
                "label_ids": product_label_ids or [],
            }
        result = await _runtime(hass).scanner.async_resolve_pending_scan(
            msg["scan_id"], corrected_stock=corrected_stock,
            session_id=_clean_scan_session(msg["session_id"]) if "session_id" in msg else None,
            connection=connection,
            minimum_stock=_clean_stock(msg.get("minimum_stock"), optional=True),
            restock_quantity=_clean_stock(msg.get("restock_quantity"), optional=True),
            restock_mode=msg.get("restock_mode"),
            category_id=_clean_text(msg.get("category_id"), maximum=100, required=False),
            category=_clean_text(msg.get("category"), maximum=200, required=False),
            product_data=product_data,
            product_label_ids=product_label_ids,
            restock_zero=msg.get("restock_zero", False),
        )
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/queue/dismiss",
        probatio.Required("scan_id"): str,
    }
)
async def websocket_dismiss_pending_scan(hass, connection, msg) -> None:
    """Dismiss a queued scan without applying it."""
    try:
        record = await _runtime(hass).scanner.async_discard_pending_scan(msg["scan_id"])
    except ValueError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], {"success": True, "scan": record})


@websocket_api.require_admin
@localized_command(
    {
        probatio.Required("type"): f"{DOMAIN}/scanner/history",
        probatio.Optional("limit", default=100): int,
        probatio.Optional("offset", default=0): int,
    }
)
async def websocket_scan_history(hass, connection, msg) -> None:
    records, total = await _runtime(hass).database.async_list_scan_history(
        msg.get("limit", 100), msg.get("offset", 0)
    )
    connection.send_result(
        msg["id"], {"history": [item.as_dict() for item in records], "total": total}
    )


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/lists/script/get",
    probatio.Required("list_id"): str,
})
async def websocket_get_list_script_settings(hass, connection, msg):
    """Return one list's script and translated, type-specific event choices."""
    try:
        result = await _runtime(hass).database.async_get_list_script_settings(msg["list_id"])
    except ListNotFoundError as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@localized_command({
    probatio.Required("type"): f"{DOMAIN}/lists/script/set",
    probatio.Required("list_id"): str,
    probatio.Required("enabled"): bool,
    probatio.Optional("script_entity"): probatio.Any(str, None),
    probatio.Required("events"): [str],
})
async def websocket_set_list_script_settings(hass, connection, msg):
    """Only administrators may attach a Home Assistant script to a list."""
    entity_id = msg.get("script_entity")
    if msg["enabled"] and (not entity_id or hass.states.get(entity_id) is None):
        _send_input_error(connection, msg, ValueError(localized_text("scripts.script_missing")))
        return
    try:
        result = await _runtime(hass).database.async_set_list_script_settings(
            msg["list_id"], msg["enabled"], entity_id, msg["events"],
        )
    except (ValueError, ListNotFoundError) as error:
        _send_input_error(connection, msg, error)
        return
    connection.send_result(msg["id"], result)
