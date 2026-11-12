"""Central barcode scanner processing for HA List Manager."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from time import monotonic
from uuid import uuid4
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback

from .localization import async_prepare, text as localized_text
from .const import (
    EVENT_INVENTORY_CHANGED,
    EVENT_ITEMS_CHANGED,
    EVENT_LISTS_CHANGED,
    EVENT_SCAN_PROCESSED,
    EVENT_SCANNER_TARGET_CHANGED,
    SCANNER_ACTIONS,
)
from .database import (
    DuplicateEANError,
    DuplicateInventoryProductError,
    InventoryListRequiredError,
    ListNotFoundError,
    HaListManagerDatabase,
)
from .models import ScanHistoryRecord, ScannerRecord
from .open_facts import OpenFactsLookupError, async_lookup_open_facts
from .script_events import SCRIPT_OPERATION, scanner_operation

SCANNER_EVENT = "eyoyo_barcode_scanned"
INVENTORY_CONTROL_PREFIX = "HA-LM:INVENTORY:"


def normalize_scanner_address(value: Any) -> str:
    """Normalize MAC-like scanner identifiers for reliable matching."""
    compact = "".join(character for character in str(value or "") if character.isalnum())
    if len(compact) == 12:
        compact = compact.upper()
        return ":".join(compact[index:index + 2] for index in range(0, 12, 2))
    return str(value or "").strip().upper()


def normalize_ean(value: Any) -> str:
    """Validate one numeric product code."""
    ean = str(value or "").strip()
    if not ean.isdigit() or not 4 <= len(ean) <= 32:
        raise ValueError(localized_text("backend.ean_digits_required"))
    return ean


def parse_inventory_control_code(value: Any) -> tuple[str | None, str] | None:
    """Return the optional list and action encoded in an inventory control QR."""
    code = str(value or "").strip()
    if not code.upper().startswith(INVENTORY_CONTROL_PREFIX):
        return None
    parts = code.split(":")
    if len(parts) == 3:
        list_id = None
        action = parts[2]
    elif len(parts) == 4:
        list_id = parts[2].strip() or None
        action = parts[3]
    else:
        return None
    normalized_action = action.strip().lower()
    if normalized_action not in SCANNER_ACTIONS:
        return None
    return list_id, normalized_action


class ScannerManager:
    """Listen once for scanner events and route them through the backend."""

    def __init__(
        self,
        hass: HomeAssistant,
        database: HaListManagerDatabase,
        config_entry: ConfigEntry,
    ) -> None:
        self.hass = hass
        self.database = database
        self.config_entry = config_entry
        self._unsubscribe = None
        self._scan_views: dict[str, dict[str, dict[str, Any]]] = {}
        self._scan_editors: dict[str, dict[str, Any]] = {}
        self._scan_operations: dict[str, list[Any]] = {}
        self._collaboration_task: asyncio.Task | None = None
        self._offer_tasks: set[asyncio.Task] = set()
        self._scan_tasks: set[asyncio.Task] = set()
        self._stopped = False
        self._lease_seconds = 45
        self._collaboration_revision = 0
        self._collaboration_epoch = str(uuid4())
        self._scan_connection_callbacks: dict[tuple[int, str], tuple[Any, Any, Any]] = {}

    async def async_start(self) -> None:
        """Start the single backend event listener."""
        self._stopped = False
        if self._unsubscribe is None:
            self._unsubscribe = self.hass.bus.async_listen(
                SCANNER_EVENT, self._handle_scanner_event
            )

    async def async_stop(self) -> None:
        """Stop new scans and finish bookings before clearing their dialogs."""
        self._stopped = True
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None

        cancelled = None
        if self._scan_tasks:
            # Cancelling after a booking commits can leave its history pending.
            # Drain first so any newly created offers join the cleanup below.
            drained = asyncio.gather(*tuple(self._scan_tasks), return_exceptions=True)
            while True:
                try:
                    await asyncio.shield(drained)
                    break
                except asyncio.CancelledError as error:
                    cancelled = error
        self._scan_tasks.clear()
        tasks = [task for task in [self._collaboration_task, *self._offer_tasks] if task]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._collaboration_task = None
        self._offer_tasks.clear()
        self._scan_views.clear()
        self._scan_editors.clear()
        for connection, key, callback in self._scan_connection_callbacks.values():
            subscriptions = getattr(connection, "subscriptions", {})
            if subscriptions.get(key) is callback:
                subscriptions.pop(key, None)
        self._scan_connection_callbacks.clear()
        if cancelled is not None:
            raise cancelled

    @asynccontextmanager
    async def _scan_operation(self, scan_id: str):
        # One operation spans validation, booking and completion. A discard
        # cannot slip between a successful claim and the actual stock change.
        operation = self._scan_operations.setdefault(scan_id, [asyncio.Lock(), 0])
        operation[1] += 1
        try:
            async with operation[0]:
                yield
        finally:
            operation[1] -= 1
            if not operation[1]:
                self._scan_operations.pop(scan_id, None)

    def _forget_idle_scan_session(self, connection: Any, session_id: str, *, closed: bool = False) -> None:
        if any(view.get(session_id, {}).get("connection") is connection for view in self._scan_views.values()):
            return
        owned = self._scan_connection_callbacks.pop((id(connection), session_id), None)
        if owned is not None and not closed:
            _, key, callback = owned
            subscriptions = getattr(connection, "subscriptions", {})
            if subscriptions.get(key) is callback:
                subscriptions.pop(key, None)

    def _clear_scan_sessions(self, scan_id: str) -> None:
        views = self._scan_views.pop(scan_id, {})
        self._scan_editors.pop(scan_id, None)
        for session_id, view in views.items():
            self._forget_idle_scan_session(view["connection"], session_id)

    def _prune_scan_sessions(self, scan_id: str) -> None:
        now = monotonic()
        views = self._scan_views.get(scan_id, {})
        for session, view in tuple(views.items()):
            response = getattr(view["connection"], "ws_response", None)
            if view["expires"] <= now or getattr(response, "closed", False) is True:
                del views[session]
                self._forget_idle_scan_session(view["connection"], session)
        if not views:
            self._scan_views.pop(scan_id, None)
        editor = self._scan_editors.get(scan_id)
        if editor and (editor["expires"] <= now or editor["session_id"] not in views):
            self._scan_editors.pop(scan_id, None)

    def _scan_collaboration(self, scan_id: str) -> dict[str, Any]:
        editor = self._scan_editors.get(scan_id)
        return {"viewers": len(self._scan_views.get(scan_id, {})),
                "editor_session": editor["session_id"] if editor else None,
                "lease_seconds": self._lease_seconds,
                "revision": self._collaboration_revision, "epoch": self._collaboration_epoch}

    def _scan_payload(self, record: ScanHistoryRecord) -> dict[str, Any]:
        return {**record.as_dict(), "queued": record.status in {"queued", "offered", "needs_input", "processing"},
                "collaboration": self._scan_collaboration(record.id)}

    def _emit_scan_update(self, record: ScanHistoryRecord) -> dict[str, Any]:
        self._collaboration_revision += 1
        payload = {**self._scan_payload(record), "collaboration_update": True}
        self.hass.bus.async_fire(EVENT_SCAN_PROCESSED, payload)
        return payload

    def _register_scan_view(self, scan_id: str, session_id: str, connection: Any) -> None:
        views = self._scan_views.setdefault(scan_id, {})
        existing = views.get(session_id)
        if existing and existing["connection"] is not connection:
            raise ValueError(localized_text("backend.scan_session_invalid"))
        views[session_id] = {"connection": connection, "expires": monotonic() + self._lease_seconds}
        subscriptions = getattr(connection, "subscriptions", None)
        key = ("ha_list_manager", "scan-session", session_id)
        if subscriptions is not None and key not in subscriptions:
            # ActiveConnection invokes subscription callbacks on disconnect.
            # Keep its dictionary untouched while HA iterates those callbacks.
            def closed() -> None:
                self.hass.async_create_task(self._close_scan_connection(connection, session_id))
            subscriptions[key] = closed
            self._scan_connection_callbacks[(id(connection), session_id)] = (connection, key, closed)
        if self._collaboration_task is None or self._collaboration_task.done():
            self._collaboration_task = asyncio.create_task(self._expire_scan_sessions())

    async def _close_scan_connection(self, connection: Any, session_id: str) -> None:
        for scan_id in tuple(self._scan_views):
            async with self._scan_operation(scan_id):
                views = self._scan_views.get(scan_id, {})
                view = views.get(session_id)
                if view is None or view["connection"] is not connection:
                    continue
                del views[session_id]
                if not views:
                    self._scan_views.pop(scan_id, None)
                editor = self._scan_editors.get(scan_id)
                if editor and editor["session_id"] == session_id:
                    self._scan_editors.pop(scan_id, None)
                record = await self.database.async_get_scan_history_record(scan_id)
                if record:
                    self._emit_scan_update(record)
        # Do not mutate ActiveConnection.subscriptions from its close callback;
        # HA may still be iterating it when this coroutine starts eagerly.
        self._forget_idle_scan_session(connection, session_id, closed=True)

    async def _pending_scan(self, scan_id: str) -> ScanHistoryRecord:
        record = await self.database.async_get_scan_history_record(scan_id)
        if record is None or record.status not in {"queued", "offered", "needs_input"}:
            raise ValueError(localized_text("backend.scan_already_handled"))
        return record

    async def _expire_scan_sessions(self) -> None:
        while self._scan_views or self._scan_editors:
            await asyncio.sleep(5)
            for scan_id in tuple(set(self._scan_views) | set(self._scan_editors)):
                async with self._scan_operation(scan_id):
                    previous = self._scan_collaboration(scan_id)
                    self._prune_scan_sessions(scan_id)
                    if previous == self._scan_collaboration(scan_id):
                        continue
                    record = await self.database.async_get_scan_history_record(scan_id)
                    if record:
                        self._emit_scan_update(record)

    async def async_pending_scans(self, list_id: str | None = None) -> list[dict[str, Any]]:
        records = await self.database.async_list_pending_scans()
        scans = []
        for record in records:
            if list_id is not None and record.list_id != list_id:
                continue
            async with self._scan_operation(record.id):
                # The initial query can overlap a completion. Never stamp its
                # stale pending row with a newer collaboration revision.
                current = await self.database.async_get_scan_history_record(record.id)
                if current and current.status in {"queued", "offered", "needs_input", "processing"}:
                    previous = self._scan_collaboration(record.id)
                    self._prune_scan_sessions(record.id)
                    if previous != self._scan_collaboration(record.id):
                        scans.append(self._emit_scan_update(current))
                    else:
                        scans.append(self._scan_payload(current))
        return scans

    async def async_view_pending_scan(self, scan_id: str, session_id: str, connection: Any, opened: bool = True) -> dict[str, Any]:
        async with self._scan_operation(scan_id):
            record = await self.database.async_get_scan_history_record(scan_id)
            if record is None:
                raise ValueError(localized_text("backend.scan_already_handled"))
            previous = self._scan_collaboration(scan_id)
            self._prune_scan_sessions(scan_id)
            if opened:
                if record.status not in {"queued", "offered", "needs_input"}:
                    raise ValueError(localized_text("backend.scan_already_handled"))
                self._register_scan_view(scan_id, session_id, connection)
                editor = self._scan_editors.get(scan_id)
                if editor and editor["session_id"] == session_id:
                    editor["expires"] = monotonic() + self._lease_seconds
            else:
                view = self._scan_views.get(scan_id, {}).get(session_id)
                if view and view["connection"] is not connection:
                    raise ValueError(localized_text("backend.scan_session_invalid"))
                self._scan_views.get(scan_id, {}).pop(session_id, None)
                editor = self._scan_editors.get(scan_id)
                if editor and editor["session_id"] == session_id:
                    self._scan_editors.pop(scan_id, None)
                if not self._scan_views.get(scan_id):
                    self._scan_views.pop(scan_id, None)
                self._forget_idle_scan_session(connection, session_id)
            if previous != self._scan_collaboration(scan_id):
                self._emit_scan_update(record)
            return self._scan_payload(record)

    async def async_edit_pending_scan(self, scan_id: str, session_id: str, connection: Any) -> dict[str, Any]:
        async with self._scan_operation(scan_id):
            record = await self._pending_scan(scan_id)
            self._prune_scan_sessions(scan_id)
            self._register_scan_view(scan_id, session_id, connection)
            editor = self._scan_editors.get(scan_id)
            if editor and (editor["session_id"] != session_id or editor["connection"] is not connection):
                raise ValueError(localized_text("backend.scan_edit_locked"))
            self._scan_editors[scan_id] = {"session_id": session_id, "connection": connection,
                                          "expires": monotonic() + self._lease_seconds}
            return self._emit_scan_update(record)

    async def async_release_pending_scan(self, scan_id: str, session_id: str, connection: Any) -> dict[str, Any]:
        async with self._scan_operation(scan_id):
            record = await self.database.async_get_scan_history_record(scan_id)
            if record is None:
                raise ValueError(localized_text("backend.scan_already_handled"))
            self._prune_scan_sessions(scan_id)
            view = self._scan_views.get(scan_id, {}).get(session_id)
            if view and view["connection"] is not connection:
                raise ValueError(localized_text("backend.scan_session_invalid"))
            editor = self._scan_editors.get(scan_id)
            if editor and editor["session_id"] == session_id:
                self._scan_editors.pop(scan_id, None)
                self._emit_scan_update(record)
            return self._scan_payload(record)

    def _require_scan_editor(self, scan_id: str, session_id: str | None, connection: Any) -> None:
        self._prune_scan_sessions(scan_id)
        editor = self._scan_editors.get(scan_id)
        if session_id is None and connection is None:
            return  # Trusted internal calls and existing backend tests.
        if session_id is None and getattr(getattr(connection, "user", None), "is_admin", False) and not editor:
            return  # Old administration clients may resolve only an unlocked scan.
        if not editor or editor["session_id"] != session_id or editor["connection"] is not connection:
            raise ValueError(localized_text("backend.scan_edit_required"))

    async def async_discard_pending_scan(self, scan_id: str, *, session_id: str | None = None, connection: Any = None) -> dict[str, Any]:
        async with self._scan_operation(scan_id):
            record = await self._pending_scan(scan_id)
            self._prune_scan_sessions(scan_id)
            if session_id is not None:
                self._register_scan_view(scan_id, session_id, connection)
            await self.database.async_finish_pending_scan(scan_id, "dismissed", localized_text("backend.queued_scan_discarded"))
            self._clear_scan_sessions(scan_id)
            return self._emit_scan_update(replace(record, status="dismissed", message=localized_text("backend.queued_scan_discarded")))

    @callback
    def _handle_scanner_event(self, event: Event) -> None:
        if self._stopped:
            return
        data = event.data or {}
        task = self.hass.async_create_task(
            self.async_process_scan(
                ean=data.get("code"),
                address=data.get("address"),
                source=str(data.get("source") or SCANNER_EVENT),
            )
        )
        self._scan_tasks.add(task)
        task.add_done_callback(self._scan_tasks.discard)

    def _product_name(
        self, original_name: str, brand: str | None, quantity: str | None
    ) -> str:
        options = self.config_entry.options
        parts = [original_name]
        if (
            options.get("append_brand_to_product_name", False)
            and brand
            and brand.casefold() not in original_name.casefold()
        ):
            parts.append(brand)
        if options.get("append_quantity_to_product_name", False) and quantity:
            parts.append(quantity)
        return " – ".join(parts)

    async def _route(
        self,
        scanner: ScannerRecord | None,
        explicit_list_id: str | None,
        explicit_action: str | None,
    ) -> tuple[str | None, str | None]:
        if explicit_list_id and explicit_action in SCANNER_ACTIONS:
            return explicit_list_id, explicit_action
        if scanner and scanner.routing == "fixed":
            return scanner.list_id, scanner.action
        target = await self.database.async_get_scanner_target()
        if target:
            return target.list_id, target.action
        options = self.config_entry.options
        list_id = options.get("scanner_default_list_id")
        action = options.get("scanner_default_action")
        return (
            str(list_id) if list_id else None,
            str(action) if action in SCANNER_ACTIONS else None,
        )

    async def _history(
        self,
        *, scanner: ScannerRecord | None, address: str | None, source: str,
        ean: str, action: str | None, list_id: str | None,
        product_id: str | None = None, product_name: str | None = None,
        entry_id: str | None = None, quantity: int = 1,
        stock_before: int | None = None, stock_after: int | None = None,
        status: str, message: str | None, event_extra: dict[str, Any] | None = None,
    ) -> ScanHistoryRecord:
        history = await self.database.async_add_scan_history(
            scanner_id=scanner.id if scanner else None,
            scanner_name=scanner.name if scanner else None,
            scanner_address=address,
            source=source,
            ean=ean,
            action=action,
            list_id=list_id,
            product_id=product_id,
            product_name=product_name,
            inventory_entry_id=entry_id,
            quantity=quantity,
            stock_before=stock_before,
            stock_after=stock_after,
            status=status,
            message=message,
        )
        self.hass.bus.async_fire(
            EVENT_SCAN_PROCESSED, {**history.as_dict(), **(event_extra or {})}
        )
        return history

    @scanner_operation
    async def async_process_scan(
        self,
        *, ean: Any, address: Any = None, source: str = "simulation",
        scanner_id: str | None = None, list_id: str | None = None,
        action: str | None = None, quantity: int = 1,
        corrected_stock: int | None = None,
        resolved_stock: int | None = None,
        minimum_stock: int | None = None,
        restock_quantity: int | None = None,
        restock_mode: str | None = None,
        category_id: str | None = None, category: str | None = None,
        product_data: dict[str, Any] | None = None,
        product_label_ids: list[str] | None = None,
        queue_on_failure: bool = True,
        offer_to_card: bool = True,
    ) -> dict[str, Any]:
        """Resolve and process a real or simulated scan exactly once."""
        await async_prepare(self.hass)
        normalized_address = normalize_scanner_address(address) or None
        control = parse_inventory_control_code(ean)
        if control is not None:
            return await self._async_process_control_code(
                code=str(ean or "").strip(), control=control,
                address=normalized_address, source=source, scanner_id=scanner_id,
            )
        try:
            normalized_ean = normalize_ean(ean)
        except ValueError as error:
            history = await self._history(
                scanner=None, address=normalized_address, source=source,
                ean=str(ean or "").strip(), action=action, list_id=list_id,
                quantity=quantity, status="error", message=str(error),
            )
            return {"history": history.as_dict()}

        scanners = await self.database.async_list_scanners()
        scanner = next((item for item in scanners if item.id == scanner_id), None)
        if scanner is None and normalized_address:
            scanner = await self.database.async_get_scanner_by_address(normalized_address)
        if source not in {"simulation", "queue", "offer_fallback"} and scanner is None:
            history = await self._history(
                scanner=None, address=normalized_address, source=source,
                ean=normalized_ean, action=None, list_id=None, quantity=quantity,
                status="ignored", message=localized_text("backend.scanner_unavailable"),
            )
            return {"history": history.as_dict()}

        target_list_id, target_action = await self._route(scanner, list_id, action)
        if SCRIPT_OPERATION.get() is not None:
            SCRIPT_OPERATION.get()["scan_mode"] = target_action
        if not target_list_id or target_action not in SCANNER_ACTIONS:
            history = await self._history(
                scanner=scanner, address=normalized_address, source=source,
                ean=normalized_ean, action=target_action, list_id=target_list_id,
                quantity=quantity, status="error",
                message=localized_text("backend.inventory_target_missing"),
            )
            return {"history": history.as_dict()}

        try:
            entries = await self.database.async_list_inventory(target_list_id)
        except (ListNotFoundError, InventoryListRequiredError):
            history = await self._history(
                scanner=scanner, address=normalized_address, source=source,
                ean=normalized_ean, action=target_action,
                list_id=target_list_id, quantity=quantity, status="error",
                message=localized_text("backend.inventory_target_unavailable"),
            )
            return {"history": history.as_dict()}

        product = await self.database.async_get_product_by_ean(normalized_ean)
        if product is None and product_data and product_data.get("name"):
            try:
                product = await self.database.async_create_product(
                    ean=normalized_ean,
                    name=str(product_data["name"]).strip(),
                    original_name=product_data.get("original_name"),
                    brand=product_data.get("brand"),
                    package_quantity=product_data.get("package_quantity"),
                    category=product_data.get("product_category"),
                    image_url=product_data.get("image_url"),
                    source="manual",
                    label_ids=list(product_data.get("label_ids") or []),
                )
            except DuplicateEANError:
                product = await self.database.async_get_product_by_ean(normalized_ean)
        if product is None:
            try:
                lookup = await async_lookup_open_facts(self.hass, normalized_ean)
            except OpenFactsLookupError:
                status = "queued" if queue_on_failure else "error"
                history = await self._history(
                    scanner=scanner, address=normalized_address, source=source,
                    ean=normalized_ean, action=target_action,
                    list_id=target_list_id, quantity=quantity, status=status,
                    message=localized_text("backend.off_unavailable"),
                    event_extra={"queued": queue_on_failure},
                )
                return {"history": history.as_dict()}
            if not lookup:
                status = "queued" if queue_on_failure else "not_found"
                history = await self._history(
                    scanner=scanner, address=normalized_address, source=source,
                    ean=normalized_ean, action=target_action,
                    list_id=target_list_id, quantity=quantity,
                    status=status,
                    message=localized_text("backend.ean_product_not_found"),
                    event_extra={"queued": queue_on_failure},
                )
                return {"history": history.as_dict()}
            original_name = lookup["name"]
            try:
                product = await self.database.async_create_product(
                    ean=normalized_ean,
                    name=self._product_name(
                        original_name, lookup.get("brand"),
                        lookup.get("package_quantity"),
                    ),
                    original_name=original_name,
                    brand=lookup.get("brand"),
                    package_quantity=lookup.get("package_quantity"),
                    category=None,
                    image_url=lookup.get("image_url"),
                    source="open_food_facts",
                    label_ids=[],
                )
            except DuplicateEANError:
                product = await self.database.async_get_product_by_ean(normalized_ean)

        if product is not None and product_label_ids is not None:
            product = await self.database.async_update_product(
                product.id,
                ean=product.ean,
                name=product.name,
                original_name=product.original_name,
                brand=product.brand,
                package_quantity=product.package_quantity,
                category=None,
                image_url=product.image_url,
                label_ids=product_label_ids,
                list_id=target_list_id,
            )
            self.hass.bus.async_fire(EVENT_LISTS_CHANGED, {"list_id": None})

        entry = next((item for item in entries if item.product_id == product.id), None)
        before = entry.stock if entry else None
        booking_after = None
        message = None

        # Existing stock changes are safe to apply headlessly. New inventory
        # assignments and ambiguous removals must remain reviewable instead of
        # silently creating or clamping an entry without an open dashboard.
        needs_review = (
            target_action in {"add", "remove", "register"}
            and (
                entry is None
                or (target_action == "remove" and entry.stock < quantity)
            )
        )
        if offer_to_card and needs_review:
            if entry is None:
                review_message = localized_text("backend.product_not_assigned")
            else:
                review_message = localized_text("backend.insufficient_stock")
            history = await self._history(
                scanner=scanner, address=normalized_address, source=source,
                ean=normalized_ean, action=target_action, list_id=target_list_id,
                product_id=product.id, product_name=product.name,
                entry_id=entry.id if entry else None, quantity=quantity,
                stock_before=before, stock_after=before, status="offered",
                message=review_message,
                event_extra={"queued": True, "product": product.as_dict()},
            )
            task = self.hass.async_create_task(self._async_queue_unclaimed_offer(history.id))
            self._offer_tasks.add(task)
            task.add_done_callback(self._offer_tasks.discard)
            return {
                "history": history.as_dict(), "product": product.as_dict(),
                "entry": entry.as_dict() if entry else None, "offered": True,
            }

        try:
            if target_action == "add":
                if entry:
                    if resolved_stock is None:
                        adjustment = await self.database.async_adjust_inventory_with_restock(
                            entry.id, quantity, minimum_stock=minimum_stock,
                            restock_quantity=restock_quantity, restock_mode=restock_mode,
                            category_id=category_id, category=category,
                        )
                        before = adjustment["stock_before"]
                        booking_after = adjustment["stock_after"]
                        entry = next(
                            item for item in await self.database.async_list_inventory(target_list_id)
                            if item.id == entry.id
                        )
                        entry = replace(entry, undo_token=adjustment.get("undo_token"))
                    else:
                        entry = await self.database.async_update_inventory_entry(
                            entry.id, stock=resolved_stock,
                            minimum_stock=entry.minimum_stock if minimum_stock is None else minimum_stock,
                            restock_quantity=restock_quantity,
                            restock_mode=restock_mode,
                            category_id=entry.category_id,
                            category=entry.category_name, hidden=entry.hidden,
                        )
                else:
                    entry = await self.database.async_create_inventory_entry(
                        list_id=target_list_id, product_id=product.id,
                        stock=quantity if resolved_stock is None else resolved_stock,
                        minimum_stock=minimum_stock, category_id=category_id,
                        restock_quantity=1 if restock_quantity is None else restock_quantity,
                        restock_mode=restock_mode,
                        category=category if category_id is None else None,
                    )
                message = localized_text("backend.stock_increased")
            elif target_action == "remove":
                if entry is None:
                    history = await self._history(
                        scanner=scanner, address=normalized_address, source=source,
                        ean=normalized_ean, action=target_action,
                        list_id=target_list_id, product_id=product.id,
                        product_name=product.name, quantity=quantity,
                        status="error", message=localized_text("backend.product_not_in_inventory"),
                    )
                    return {"history": history.as_dict(), "product": product.as_dict()}
                if resolved_stock is None:
                    adjustment = await self.database.async_adjust_inventory_with_restock(
                        entry.id, -quantity, minimum_stock=minimum_stock,
                        restock_quantity=restock_quantity, restock_mode=restock_mode,
                        category_id=category_id, category=category,
                    )
                    before = adjustment["stock_before"]
                    booking_after = adjustment["stock_after"]
                    if adjustment.get("transfer"):
                        self.hass.bus.async_fire(
                            EVENT_ITEMS_CHANGED,
                            {"list_id": adjustment["transfer"]["target_list_id"]},
                        )
                    if adjustment.get("needs_confirmation"):
                        history = await self._history(
                            scanner=scanner, address=normalized_address, source=source,
                            ean=normalized_ean, action=target_action,
                            list_id=target_list_id, product_id=product.id,
                            product_name=product.name, entry_id=entry.id, quantity=quantity,
                            stock_before=before, stock_after=before, status="queued",
                            message=localized_text("backend.zero_stock_add_prompt"),
                            event_extra={"queued": True, "restock_zero": True},
                        )
                        return {"history": history.as_dict(), "product": product.as_dict(), "entry": entry.as_dict()}
                    entry = next(
                        item for item in await self.database.async_list_inventory(target_list_id)
                        if item.id == entry.id
                    )
                    entry = replace(entry, undo_token=adjustment.get("undo_token"))
                else:
                    entry = await self.database.async_update_inventory_entry(
                        entry.id, stock=resolved_stock,
                        minimum_stock=entry.minimum_stock if minimum_stock is None else minimum_stock,
                        restock_quantity=restock_quantity,
                        restock_mode=restock_mode,
                        category_id=entry.category_id,
                        category=entry.category_name, hidden=entry.hidden,
                    )
                message = localized_text("backend.stock_reduced")
            elif target_action == "register":
                if entry is None:
                    entry = await self.database.async_create_inventory_entry(
                        list_id=target_list_id, product_id=product.id, stock=0,
                        minimum_stock=minimum_stock, category_id=category_id,
                        restock_quantity=1 if restock_quantity is None else restock_quantity,
                        restock_mode=restock_mode,
                        category=category if category_id is None else None,
                    )
                    message = localized_text("backend.product_registered_zero_stock")
                else:
                    message = localized_text("backend.product_already_registered")
            else:
                if corrected_stock is None:
                    history = await self._history(
                        scanner=scanner, address=normalized_address, source=source,
                        ean=normalized_ean, action=target_action,
                        list_id=target_list_id, product_id=product.id,
                        product_name=product.name,
                        entry_id=entry.id if entry else None, quantity=quantity,
                        stock_before=before, stock_after=before,
                        status="needs_input",
                        message=localized_text("backend.correction_stock_required"),
                        event_extra={"queued": queue_on_failure},
                    )
                    return {"history": history.as_dict(), "product": product.as_dict()}
                if entry:
                    entry = await self.database.async_update_inventory_entry(
                        entry.id, stock=corrected_stock,
                        minimum_stock=entry.minimum_stock if minimum_stock is None else minimum_stock,
                        restock_quantity=restock_quantity,
                        restock_mode=restock_mode,
                        category_id=entry.category_id,
                        category=entry.category_name,
                        hidden=entry.hidden,
                    )
                else:
                    entry = await self.database.async_create_inventory_entry(
                        list_id=target_list_id, product_id=product.id,
                        stock=corrected_stock, minimum_stock=minimum_stock,
                        restock_quantity=1 if restock_quantity is None else restock_quantity,
                        restock_mode=restock_mode,
                        category_id=category_id,
                        category=category if category_id is None else None,
                    )
                message = localized_text("backend.stock_corrected", p0=before or 0, p1=corrected_stock)
        except DuplicateInventoryProductError:
            entries = await self.database.async_list_inventory(target_list_id)
            entry = next((item for item in entries if item.product_id == product.id), None)
            if entry is None:
                raise
            # Another scan may have created this assignment after our initial
            # snapshot. Keep this scan's booking instead of reporting success
            # while silently dropping its quantity.
            before = entry.stock
            if target_action == "add" and resolved_stock is None:
                adjustment = await self.database.async_adjust_inventory_with_restock(
                    entry.id, quantity, minimum_stock=minimum_stock,
                    restock_quantity=restock_quantity, restock_mode=restock_mode,
                    category_id=category_id, category=category,
                )
                before = adjustment["stock_before"]
                booking_after = adjustment["stock_after"]
                entry = next(
                    item for item in await self.database.async_list_inventory(target_list_id)
                    if item.id == entry.id
                )
                entry = replace(entry, undo_token=adjustment.get("undo_token"))
            elif target_action in {"add", "correct"}:
                entry = await self.database.async_update_inventory_entry(
                    entry.id, stock=resolved_stock if target_action == "add" else corrected_stock,
                    minimum_stock=entry.minimum_stock if minimum_stock is None else minimum_stock,
                    restock_quantity=restock_quantity, restock_mode=restock_mode,
                    category_id=entry.category_id, category=entry.category_name,
                    hidden=entry.hidden,
                )
            if target_action == "add":
                message = localized_text("backend.stock_increased")
            elif target_action == "correct":
                message = localized_text("backend.stock_corrected", p0=before, p1=corrected_stock)
            else:
                message = localized_text("backend.product_already_registered")

        # Delta bookings already saved these options atomically. Re-saving their
        # old stock snapshot here could overwrite another concurrent scan.
        if entry and booking_after is None and ((category_id is not None and category_id != entry.category_id) or (category is not None and category != entry.category_name)):
            entry = await self.database.async_update_inventory_entry(
                entry.id, stock=entry.stock, minimum_stock=entry.minimum_stock,
                restock_quantity=restock_quantity,
                restock_mode=restock_mode,
                category_id=category_id,
                category=category if category_id is None else None,
                hidden=entry.hidden,
            )

        after = booking_after if booking_after is not None else entry.stock if entry else before
        self.hass.bus.async_fire(
            EVENT_INVENTORY_CHANGED,
            {"list_id": target_list_id, "entry_id": entry.id if entry else None},
        )
        history = await self._history(
            scanner=scanner, address=normalized_address, source=source,
            ean=normalized_ean, action=target_action, list_id=target_list_id,
            product_id=product.id, product_name=product.name,
            entry_id=entry.id if entry else None, quantity=quantity,
            stock_before=before, stock_after=after, status="success",
            message=message,
        )
        return {
            "history": history.as_dict(), "product": product.as_dict(),
            "entry": entry.as_dict() if entry else None,
        }

    async def _async_process_control_code(
        self, *, code: str, control: tuple[str | None, str],
        address: str | None, source: str, scanner_id: str | None,
    ) -> dict[str, Any]:
        """Change the active inventory target from a scanned control QR code."""
        scanners = await self.database.async_list_scanners()
        scanner = next(
            (item for item in scanners if item.id == scanner_id and item.enabled), None
        )
        if scanner is None and address:
            scanner = await self.database.async_get_scanner_by_address(address)
        if source not in {"simulation", "queue", "offer_fallback"} and scanner is None:
            history = await self._history(
                scanner=None, address=address, source=source, ean=code,
                action=None, list_id=None, status="ignored", quantity=1,
                message=localized_text("backend.scanner_unavailable"),
            )
            return {"history": history.as_dict(), "control": True}
        if scanner is not None and scanner.routing == "fixed":
            history = await self._history(
                scanner=scanner, address=address, source=source, ean=code,
                action=scanner.action, list_id=scanner.list_id, status="ignored",
                quantity=1,
                message=localized_text("backend.scanner_fixed_route_ignores_mode"),
            )
            return {"history": history.as_dict(), "control": True}

        encoded_list_id, target_action = control
        target = await self.database.async_get_scanner_target()
        target_list_id = encoded_list_id or (target.list_id if target else None)
        if not target_list_id:
            history = await self._history(
                scanner=scanner, address=address, source=source, ean=code,
                action=target_action, list_id=None, status="error", quantity=1,
                message=localized_text("backend.mode_code_needs_target"),
            )
            return {"history": history.as_dict(), "control": True}
        try:
            next_target = await self.database.async_set_scanner_target(
                target_list_id, target_action
            )
        except (ListNotFoundError, InventoryListRequiredError):
            history = await self._history(
                scanner=scanner, address=address, source=source, ean=code,
                action=target_action, list_id=target_list_id, status="error",
                quantity=1,
                message=localized_text("backend.qr_inventory_unavailable"),
            )
            return {"history": history.as_dict(), "control": True}

        self.hass.bus.async_fire(
            EVENT_SCANNER_TARGET_CHANGED, next_target.as_dict()
        )
        history = await self._history(
            scanner=scanner, address=address, source=source, ean=code,
            action=target_action, list_id=target_list_id, status="success",
            quantity=1, message=localized_text("backend.scanner_target_mode_changed"),
            event_extra={"control": True},
        )
        return {
            "history": history.as_dict(), "control": True,
            "target": next_target.as_dict(),
        }

    async def _async_queue_unclaimed_offer(self, scan_id: str) -> None:
        """Keep an unclaimed scan pending instead of changing stock silently."""
        await asyncio.sleep(1.5)
        queued = await self.database.async_queue_offered_scan(scan_id)
        if queued is not None:
            self._emit_scan_update(queued)

    async def async_resolve_pending_scan(
        self, scan_id: str, *, session_id: str | None = None, connection: Any = None,
        **details: Any,
    ) -> dict[str, Any]:
        """Serialize completion against discard and require the current editor."""
        async with self._scan_operation(scan_id):
            await self._pending_scan(scan_id)
            self._require_scan_editor(scan_id, session_id, connection)
            result = await self._async_apply_pending_scan(scan_id, **details)
            record = await self.database.async_get_scan_history_record(scan_id)
            if record and record.status == "resolved":
                self._clear_scan_sessions(scan_id)
            if record:
                self._collaboration_revision += 1
                payload = self._scan_payload(record)
                outcome = result.get("history", {})
                if record.status == "resolved":
                    for key in ("stock_before", "stock_after", "product_id", "product_name", "inventory_entry_id", "quantity", "action"):
                        if key in outcome:
                            payload[key] = outcome[key]
                    payload["resolved_history_id"] = outcome.get("id")
                    if result.get("transfer"):
                        payload["transfer"] = result["transfer"]
                self.hass.bus.async_fire(EVENT_SCAN_PROCESSED, payload)
            return result

    async def _async_apply_pending_scan(
        self, scan_id: str, *, corrected_stock: int | None = None,
        minimum_stock: int | None = None,
        restock_quantity: int | None = None,
        restock_mode: str | None = None,
        category_id: str | None = None, category: str | None = None,
        product_data: dict[str, Any] | None = None,
        product_label_ids: list[str] | None = None,
        restock_zero: bool = False,
    ) -> dict[str, Any]:
        """Resolve one queued scan and apply its original action at most once."""
        await async_prepare(self.hass)
        pending = await self.database.async_claim_pending_scan(scan_id)
        if pending is None:
            raise ValueError(localized_text("backend.scan_already_handled"))
        previous_status = "needs_input" if pending.action == "correct" else "queued"
        try:
            if restock_zero and pending.action == "remove" and pending.inventory_entry_id:
                transfer = await self.database.async_confirm_zero_stock_restock(
                    pending.inventory_entry_id, pending.quantity
                )
                await self.database.async_finish_pending_scan(
                    scan_id, "resolved", localized_text("backend.zero_stock_added")
                )
                self.hass.bus.async_fire(
                    EVENT_ITEMS_CHANGED, {"list_id": transfer["target_list_id"]}
                )
                return {"history": {**pending.as_dict(), "status": "success"}, "transfer": transfer}
            # The dialog's untouched default expresses this scan's addition,
            # not an absolute correction. Another queued scan of the same EAN
            # may already have increased stock while this dialog was open.
            resolved_stock = corrected_stock if pending.action != "correct" else None
            if pending.action == "add" and corrected_stock == (pending.stock_before or 0) + pending.quantity:
                resolved_stock = None
            result = await self.async_process_scan(
                ean=pending.ean,
                address=pending.scanner_address,
                source="queue",
                scanner_id=pending.scanner_id,
                list_id=pending.list_id,
                action=pending.action,
                quantity=pending.quantity,
                corrected_stock=corrected_stock if pending.action == "correct" else None,
                resolved_stock=resolved_stock,
                minimum_stock=minimum_stock,
                restock_quantity=restock_quantity,
                restock_mode=restock_mode,
                category_id=category_id,
                category=category,
                product_data=product_data,
                product_label_ids=product_label_ids,
                queue_on_failure=False,
                offer_to_card=False,
            )
            status = result.get("history", {}).get("status")
            if status != "success":
                await self.database.async_finish_pending_scan(
                    scan_id, previous_status,
                    result.get("history", {}).get("message"),
                )
                return result
            await self.database.async_finish_pending_scan(
                scan_id, "resolved", localized_text("backend.queued_scan_processed")
            )
            return result
        except Exception:
            await self.database.async_finish_pending_scan(
                scan_id, previous_status, pending.message
            )
            raise

    async def async_set_target(self, list_id: str, action: str):
        """Set the one persistent target shared by all active-target scanners."""
        target = await self.database.async_set_scanner_target(list_id, action)
        self.hass.bus.async_fire(EVENT_SCANNER_TARGET_CHANGED, target.as_dict())
        return target

    async def async_clear_target(self) -> None:
        """Disable the active target without changing the configured fallback."""
        await self.database.async_clear_scanner_target()
        self.hass.bus.async_fire(EVENT_SCANNER_TARGET_CHANGED, {"target": None})
