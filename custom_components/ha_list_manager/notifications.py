"""Central Home Assistant notification delivery for backend-managed lists."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from html import escape
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later

from .localization import async_prepare, system_text as localized_text
from .const import EVENT_ITEM_MUTATED
from .database import HaListManagerDatabase
from .models import (
    ListItemRecord,
    ListNotificationAssignmentRecord,
    ListRecord,
    NotificationPendingBatchRecord,
    NotificationProfileRecord,
)

_LOGGER = logging.getLogger(__name__)
_TELEGRAM_MARKDOWN_ESCAPES = str.maketrans(
    {character: f"\\{character}" for character in r"\_*[]()~`>#+-=|{}.!"}
)


class NotificationManager:
    """Format lists and dispatch them through configured Home Assistant services."""

    def __init__(self, hass: HomeAssistant, database: HaListManagerDatabase) -> None:
        self._hass = hass
        self._database = database
        self._timers: dict[tuple[str, str], Callable[[], None]] = {}
        self._unsubscribe: Callable[[], None] | None = None
        self._batch_locks: dict[tuple[str, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._tasks: set[asyncio.Task[Any]] = set()
        self._stopped = False

    async def async_start(self) -> None:
        """Subscribe to item changes and restore waiting deliveries."""
        if self._unsubscribe is not None:
            return
        self._stopped = False
        self._unsubscribe = self._hass.bus.async_listen(
            EVENT_ITEM_MUTATED, self._handle_item_mutated
        )
        for batch in await self._database.async_list_notification_pending_batches():
            self._schedule_batch(batch)

    async def async_stop(self) -> None:
        """Stop listeners and in-memory timers; durable batches remain stored."""
        self._stopped = True
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        for cancel in self._timers.values():
            cancel()
        self._timers.clear()
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        self._tasks.clear()

    def _create_task(self, coroutine: Any, name: str) -> None:
        task = self._hass.async_create_task(coroutine, name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @callback
    def _handle_item_mutated(self, event: Event) -> None:
        if self._stopped:
            return
        self._create_task(
            self._async_record_change(event.data),
            "ha_list_manager notification batching",
        )

    async def _async_record_change(self, data: dict[str, Any]) -> None:
        list_id = str(data.get("list_id") or "")
        item_id = str(data.get("item_id") or "")
        before = data.get("before")
        after = data.get("after")
        if not list_id or not item_id or (before is None and after is None):
            return
        mutation_types = self._mutation_types(before, after)
        assignments = await self._database.async_list_notification_assignments(list_id)
        for assignment in assignments:
            if assignment.automatic_mode == "off" or not assignment.profile.enabled:
                continue
            # Read/merge/write is one operation per destination. Otherwise
            # simultaneous changes overwrite each other's JSON snapshot.
            async with self._batch_locks[(list_id, assignment.profile_id)]:
                batch = await self._database.async_get_notification_pending_batch(
                    list_id, assignment.profile_id
                )
                changes = self._decode_changes(batch)
                existing = changes.get(item_id)
                if existing is None and not any(
                    self._event_enabled(assignment, event_name)
                    for event_name in mutation_types
                ):
                    continue
                initial = existing.get("before") if existing else before
                changes[item_id] = {"before": initial, "after": after}
                if self._same_item_state(initial, after):
                    changes.pop(item_id, None)
                if not changes:
                    await self._database.async_delete_notification_pending_batch(
                        list_id, assignment.profile_id
                    )
                    self._cancel_timer(list_id, assignment.profile_id)
                    continue
                due = datetime.now(UTC) + timedelta(seconds=assignment.delay_seconds)
                saved = await self._database.async_upsert_notification_pending_batch(
                    list_id,
                    assignment.profile_id,
                    due.isoformat(),
                    json.dumps(changes, ensure_ascii=False, separators=(",", ":")),
                )
                self._schedule_batch(saved)

    def _schedule_batch(self, batch: NotificationPendingBatchRecord) -> None:
        if self._stopped:
            return
        key = (batch.list_id, batch.profile_id)
        self._cancel_timer(*key)
        try:
            due = datetime.fromisoformat(batch.due_at.replace("Z", "+00:00"))
        except ValueError:
            due = datetime.now(UTC)
        if due.tzinfo is None:
            due = due.replace(tzinfo=UTC)
        delay = max(0.0, (due - datetime.now(UTC)).total_seconds())

        @callback
        def deliver(_now: datetime) -> None:
            self._timers.pop(key, None)
            if self._stopped:
                return
            self._create_task(
                self._async_deliver_batch(*key),
                "ha_list_manager notification delivery",
            )

        self._timers[key] = async_call_later(self._hass, delay, deliver)

    def _cancel_timer(self, list_id: str, profile_id: str) -> None:
        cancel = self._timers.pop((list_id, profile_id), None)
        if cancel:
            cancel()

    async def _async_deliver_batch(self, list_id: str, profile_id: str) -> None:
        # Keep a new change from replacing the batch being sent and then
        # disappearing when that older delivery removes its row.
        async with self._batch_locks[(list_id, profile_id)]:
            await async_prepare(self._hass)
            batch = await self._database.async_get_notification_pending_batch(
                list_id, profile_id
            )
            if batch is None:
                return
            assignments = await self._database.async_list_notification_assignments(list_id)
            assignment = next(
                (item for item in assignments if item.profile_id == profile_id), None
            )
            if (
                assignment is None
                or assignment.automatic_mode == "off"
                or not assignment.profile.enabled
            ):
                await self._database.async_delete_notification_pending_batch(
                    list_id, profile_id
                )
                return
            lists = await self._database.async_list_lists()
            list_record = next((item for item in lists if item.id == list_id), None)
            if list_record is None:
                await self._database.async_delete_notification_pending_batch(
                    list_id, profile_id
                )
                return
            changes = self._decode_changes(batch)
            telegram = self._is_telegram_profile(assignment.profile)
            change_message = self._format_changes(
                changes, assignment, assignment.profile.message_format,
                telegram=telegram,
            )
            message = ""
            if assignment.automatic_mode in {"changes", "changes_and_full"}:
                message = change_message
            if assignment.automatic_mode in {"full", "changes_and_full"}:
                items = await self._database.async_list_items(list_id)
                full = self._format_list(
                    list_record, items, assignment.profile.message_format,
                    telegram=telegram,
                )
                if message:
                    separator = "<hr>" if assignment.profile.message_format == "html" else "\n\n---\n\n"
                    if telegram and assignment.profile.message_format == "markdown":
                        separator = "\n\n—\n\n"
                    message += separator + full
                else:
                    message = full
            if not message:
                await self._database.async_delete_notification_pending_batch(
                    list_id, profile_id
                )
                return
            try:
                await self._async_send(
                    assignment.profile,
                    assignment.profile.title or localized_text("backend.value_changed", p0=list_record.name),
                    message,
                )
            except Exception:  # Home Assistant services may fail temporarily.
                _LOGGER.exception(
                    "Automatic list notification failed for list %s and profile %s",
                    list_id,
                    profile_id,
                )
                retry = await self._database.async_upsert_notification_pending_batch(
                    list_id,
                    profile_id,
                    (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
                    batch.changes_json,
                )
                self._schedule_batch(retry)
                return
            await self._database.async_delete_notification_pending_batch(
                list_id, profile_id
            )

    @staticmethod
    def _decode_changes(
        batch: NotificationPendingBatchRecord | None,
    ) -> dict[str, dict[str, Any]]:
        if batch is None:
            return {}
        try:
            value = json.loads(batch.changes_json)
        except (TypeError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _mutation_types(
        before: dict[str, Any] | None, after: dict[str, Any] | None
    ) -> set[str]:
        if before is None:
            return {"add"}
        if after is None:
            return {"delete"}
        result: set[str] = set()
        old_quantity = int(before.get("quantity") or 0)
        new_quantity = int(after.get("quantity") or 0)
        if new_quantity > old_quantity:
            result.add("increase")
        elif new_quantity < old_quantity:
            result.add("decrease")
        if bool(before.get("completed")) != bool(after.get("completed")):
            result.add("complete" if after.get("completed") else "reopen")
        metadata = (
            "name", "description", "category_id", "category", "due_at",
            "recurrence_interval", "recurrence_unit", "product_id", "labels", "offer_only",
        )
        if any(
            NotificationManager._item_value(before, key)
            != NotificationManager._item_value(after, key)
            for key in metadata
        ):
            result.add("edit")
        return result

    @staticmethod
    def _event_enabled(
        assignment: ListNotificationAssignmentRecord, event_name: str
    ) -> bool:
        return bool(getattr(assignment, f"notify_on_{event_name}", False))

    @staticmethod
    def _same_item_state(
        before: dict[str, Any] | None, after: dict[str, Any] | None
    ) -> bool:
        if before is None or after is None:
            return before is after
        relevant = (
            "product_id", "name", "description", "quantity", "category_id",
            "category", "due_at", "recurrence_interval", "recurrence_unit",
            "completed", "labels", "offer_only",
        )
        return all(
            NotificationManager._item_value(before, key)
            == NotificationManager._item_value(after, key)
            for key in relevant
        )

    @staticmethod
    def _item_value(item: dict[str, Any], key: str) -> Any:
        """Return a stable comparable item value across event and JSON storage."""
        value = item.get(key)
        if key != "labels" or not isinstance(value, (list, tuple)):
            return value
        return tuple(
            sorted(
                str(label.get("id") or label.get("name") or "")
                if isinstance(label, dict)
                else str(label)
                for label in value
            )
        )

    @staticmethod
    def _short_text(value: Any, limit: int = 120) -> str:
        """Keep change details useful without producing oversized notifications."""
        text = " ".join(str(value or "").split())
        return text if len(text) <= limit else f"{text[: limit - 1].rstrip()}…"

    @staticmethod
    def _format_due_at(value: Any) -> str:
        """Render stored ISO dates using the Home Assistant system language."""
        raw = str(value or "").strip()
        if not raw:
            return ""
        try:
            due = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return raw
        date = localized_text(
            "backend.notification_date",
            day=f"{due.day:02d}", month=f"{due.month:02d}", year=f"{due.year:04d}",
        )
        if "T" not in raw and " " not in raw:
            return date
        return localized_text(
            "backend.notification_datetime", date=date, time=due.strftime("%H:%M")
        )

    @staticmethod
    def _label_names(item: dict[str, Any]) -> set[str]:
        """Return readable label names from item snapshots."""
        result: set[str] = set()
        for label in item.get("labels") or ():
            value = (
                label.get("name") or label.get("id")
                if isinstance(label, dict)
                else label
            )
            if value:
                result.add(str(value))
        return result

    @staticmethod
    def _format_recurrence(item: dict[str, Any]) -> str:
        """Render the recurrence pair used by To-do entries."""
        interval = item.get("recurrence_interval")
        unit = item.get("recurrence_unit")
        if not interval or unit not in {"H", "D", "M"}:
            return ""
        number = int(interval)
        units = {"H": "hour", "D": "day", "M": "month"}
        suffix = "one" if number == 1 else "many"
        return localized_text(
            f"backend.notification_repeat_{units[unit]}_{suffix}", count=number
        )

    @classmethod
    def _edit_change_details(
        cls, before: dict[str, Any], after: dict[str, Any]
    ) -> list[tuple[str, str]]:
        """Describe each changed field instead of emitting a generic edit message."""
        details: list[tuple[str, str]] = []
        old_name = str(before.get("name") or localized_text("backend.unknown_item"))
        new_name = str(after.get("name") or old_name)

        if bool(before.get("offer_only")) != bool(after.get("offer_only")):
            offer_key = "enabled" if after.get("offer_only") else "disabled"
            details.append((
                "offer_only_changed",
                localized_text(f"backend.notification_offer_{offer_key}", name=new_name),
            ))
        if old_name != new_name:
            details.append(("name_changed", f"{old_name} → {new_name}"))

        old_description = cls._short_text(before.get("description"))
        new_description = cls._short_text(after.get("description"))
        if old_description != new_description:
            if not old_description:
                details.append(("description_added", localized_text(
                    "backend.notification_description_value", name=new_name, description=new_description
                )))
            elif not new_description:
                details.append(("description_removed", localized_text(
                    "backend.notification_description_value", name=new_name, description=old_description
                )))
            else:
                details.append(
                    (
                        "description_changed",
                        localized_text(
                            "backend.notification_description_change",
                            name=new_name, before=old_description, after=new_description,
                        ),
                    )
                )

        old_due = cls._format_due_at(before.get("due_at"))
        new_due = cls._format_due_at(after.get("due_at"))
        if old_due != new_due:
            if not old_due:
                details.append(("due_added", f"{new_name}: {new_due}"))
            elif not new_due:
                details.append(("due_removed", localized_text(
                    "backend.notification_previous_value", name=new_name, value=old_due
                )))
            else:
                details.append(("due_changed", f"{new_name}: {old_due} → {new_due}"))

        # Compare stored names before formatting the unassigned display label.
        old_category = before.get("category") or None
        new_category = after.get("category") or None
        if old_category != new_category:
            old_display = str(old_category) if old_category is not None else localized_text("backend.general")
            new_display = str(new_category) if new_category is not None else localized_text("backend.general")
            details.append(
                ("category_changed", f"{new_name}: {old_display} → {new_display}")
            )

        old_labels = cls._label_names(before)
        new_labels = cls._label_names(after)
        if old_labels != new_labels:
            parts: list[str] = []
            added = sorted(new_labels - old_labels, key=str.casefold)
            removed = sorted(old_labels - new_labels, key=str.casefold)
            if added:
                parts.append(localized_text("backend.added_items", p0=', '.join(added)))
            if removed:
                parts.append(localized_text("backend.notification_removed_labels", labels=", ".join(removed)))
            details.append(("labels_changed", f"{new_name}: {'; '.join(parts)}"))

        old_recurrence = cls._format_recurrence(before)
        new_recurrence = cls._format_recurrence(after)
        if old_recurrence != new_recurrence:
            if not old_recurrence:
                details.append(("recurrence_added", f"{new_name}: {new_recurrence}"))
            elif not new_recurrence:
                details.append(
                    ("recurrence_removed", localized_text(
                        "backend.notification_previous_value", name=new_name, value=old_recurrence
                    ))
                )
            else:
                details.append(
                    (
                        "recurrence_changed",
                        f"{new_name}: {old_recurrence} → {new_recurrence}",
                    )
                )

        if before.get("product_id") != after.get("product_id"):
            details.append(("product_changed", new_name))
        return details

    @classmethod
    def _format_changes(
        cls,
        changes: dict[str, dict[str, Any]],
        assignment: ListNotificationAssignmentRecord,
        message_format: str,
        *,
        telegram: bool = False,
    ) -> str:
        groups: dict[str, list[str]] = defaultdict(list)
        labels = {
            "add": localized_text("backend.added"),
            "increase": localized_text("backend.count_increased"),
            "decrease": localized_text("backend.count_decreased"),
            "name_changed": localized_text("backend.name_changed"),
            "offer_only_changed": localized_text("backend.sale_flag_changed"),
            "description_added": localized_text("backend.description_added"),
            "description_changed": localized_text("backend.description_changed"),
            "description_removed": localized_text("backend.description_removed"),
            "due_added": localized_text("backend.due_date_set"),
            "due_changed": localized_text("backend.due_date_changed"),
            "due_removed": localized_text("backend.due_date_removed"),
            "category_changed": localized_text("backend.category_changed"),
            "labels_changed": localized_text("backend.labels_changed"),
            "recurrence_added": localized_text("backend.recurrence_set"),
            "recurrence_changed": localized_text("backend.repeat_changed"),
            "recurrence_removed": localized_text("backend.recurrence_removed"),
            "product_changed": localized_text("backend.product_assignment_changed"),
            "complete": localized_text("backend.completed"),
            "reopen": localized_text("backend.reopened"),
            "delete": localized_text("backend.deleted"),
        }
        for change in changes.values():
            before = change.get("before")
            after = change.get("after")
            mutation_types = cls._mutation_types(before, after)
            for event_name in (
                "add", "increase", "decrease", "edit", "complete", "reopen", "delete"
            ):
                if event_name not in mutation_types or not cls._event_enabled(
                    assignment, event_name
                ):
                    continue
                current = after or before or {}
                name = str(current.get("name") or localized_text("backend.unknown_item"))
                if event_name in {"add", "delete"}:
                    quantity = int(current.get("quantity") or 1)
                    text = f"{quantity}× {name}" if quantity != 1 else name
                elif event_name in {"increase", "decrease"}:
                    text = localized_text(
                        "backend.notification_quantity_change", name=name,
                        before=before.get("quantity", 0), after=after.get("quantity", 0),
                    )
                elif event_name == "edit":
                    for detail_type, detail_text in cls._edit_change_details(
                        before, after
                    ):
                        groups[detail_type].append(detail_text)
                    continue
                else:
                    text = name
                groups[event_name].append(text)
        if not groups:
            return ""
        ordered_groups = (
            (event_name, groups[event_name])
            for event_name in labels
            if event_name in groups
        )
        if message_format == "html":
            return "".join(
                f"<h3>{escape(labels[event_name])}</h3><ul>"
                + "".join(f"<li>{escape(text)}</li>" for text in entries)
                + "</ul>"
                for event_name, entries in ordered_groups
            )
        markdown = message_format == "markdown"
        lines: list[str] = []
        for event_name, entries in ordered_groups:
            if lines:
                lines.append("")
            heading = labels[event_name]
            if markdown and telegram:
                lines.append(f"*{cls._telegram_markdown_text(heading)}*")
                lines.extend(f"\\- {cls._telegram_markdown_text(text)}" for text in entries)
            else:
                lines.append(f"**{heading}**" if markdown else f"{heading}:")
                lines.extend(f"- {text}" for text in entries)
        return "\n".join(lines)

    async def async_test(self, profile: NotificationProfileRecord) -> None:
        """Send a small test message without requiring a list assignment."""
        await async_prepare(self._hass)
        message = localized_text("backend.test_notification_sent")
        if self._is_telegram_profile(profile):
            if profile.message_format == "html":
                message = escape(message)
            elif profile.message_format == "markdown":
                message = self._telegram_markdown_text(message)
        await self._async_send(
            profile,
            profile.title or "HA List Manager",
            message,
        )

    async def async_send_list(
        self, list_id: str, profile_ids: list[str] | None = None
    ) -> list[str]:
        """Send the current list to its enabled manual destinations."""
        await async_prepare(self._hass)
        lists = await self._database.async_list_lists()
        list_record = next((item for item in lists if item.id == list_id), None)
        if list_record is None:
            from .database import ListNotFoundError

            raise ListNotFoundError(list_id)
        assignments = await self._database.async_list_notification_assignments(list_id)
        selected = set(profile_ids) if profile_ids is not None else None
        profiles = [
            assignment.profile
            for assignment in assignments
            if assignment.manual_enabled
            and assignment.profile.enabled
            and (selected is None or assignment.profile_id in selected)
        ]
        items = await self._database.async_list_items(list_id)
        sent: list[str] = []
        for profile in profiles:
            message = self._format_list(
                list_record, items, profile.message_format,
                telegram=self._is_telegram_profile(profile),
            )
            await self._async_send(
                profile, profile.title or list_record.name, message
            )
            sent.append(profile.id)
        return sent

    def _is_telegram_profile(self, profile: NotificationProfileRecord) -> bool:
        if profile.provider != "notify_entity":
            return False
        entry = er.async_get(self._hass).async_get(profile.target)
        return entry is not None and entry.platform == "telegram_bot"

    @staticmethod
    def _telegram_markdown_text(text: str) -> str:
        """Keep user text literal in Telegram's MarkdownV2 dialect."""
        return text.translate(_TELEGRAM_MARKDOWN_ESCAPES)

    @staticmethod
    def _telegram_html(message: str) -> str:
        """Translate our email-style markup to Telegram's supported HTML tags."""
        replacements = {
            "<h2>": "<b>", "</h2>": "</b>\n",
            "<h3>": "<b>", "</h3>": "</b>\n",
            "<ul>": "", "</ul>": "\n",
            "<li>": "• ", "</li>": "\n",
            "<br>": "\n", "<small>": "", "</small>": "",
            "<hr>": "\n—\n", "&times;": "×",
        }
        for original, replacement in replacements.items():
            message = message.replace(original, replacement)
        return message.strip()

    async def _async_send(
        self, profile: NotificationProfileRecord, title: str, message: str
    ) -> None:
        if profile.provider == "persistent":
            await self._hass.services.async_call(
                "notify", "persistent_notification",
                {"title": title, "message": message}, blocking=True,
            )
            return
        if profile.provider == "notify_entity":
            telegram = self._is_telegram_profile(profile)
            if not telegram and profile.message_format != "plain":
                raise HomeAssistantError(localized_text("backend.notify_plain_text_only"))
            if profile.click_url:
                if telegram:
                    raise HomeAssistantError(
                        localized_text("backend.open_path_companion_only")
                    )
                object_id = profile.target.partition(".")[2]
                mobile_service = f"mobile_app_{object_id}"
                if not self._hass.services.has_service("notify", mobile_service):
                    raise HomeAssistantError(
                        localized_text("backend.open_path_companion_only")
                    )
                await self._hass.services.async_call(
                    "notify", mobile_service,
                    {
                        "title": title,
                        "message": message,
                        "data": {
                            "url": profile.click_url,
                            "clickAction": profile.click_url,
                        },
                    },
                    blocking=True,
                )
                return
            if telegram:
                parse_mode = "plain_text" if profile.message_format == "plain" else profile.message_format
                if parse_mode == "markdown":
                    parse_mode = "markdownv2"
                if parse_mode == "html":
                    title = escape(title)
                    message = self._telegram_html(message)
                elif parse_mode == "markdownv2":
                    title = self._telegram_markdown_text(title)
                await self._hass.services.async_call(
                    "telegram_bot", "send_message",
                    {"entity_id": profile.target, "title": title,
                     "message": message, "parse_mode": parse_mode},
                    blocking=True,
                )
                return
            await self._hass.services.async_call(
                "notify", "send_message", {"title": title, "message": message},
                target={"entity_id": profile.target}, blocking=True,
            )
            return
        if profile.provider == "ntfy":
            await self._hass.services.async_call(
                "ntfy", "publish",
                {
                    "title": title,
                    "message": message,
                    "markdown": profile.message_format == "markdown",
                },
                target={"entity_id": profile.target}, blocking=True,
            )
            return
        service = profile.target.removeprefix("notify.")
        data: dict[str, object] = {"title": title, "message": message}
        if profile.message_format == "html":
            data = {
                "title": title,
                "message": localized_text("backend.html_message_notice"),
                "data": {"html": message},
            }
        await self._hass.services.async_call(
            "notify", service, data, blocking=True
        )

    @classmethod
    def _format_list(
        cls, list_record: ListRecord, items: list[ListItemRecord], message_format: str,
        *, telegram: bool = False,
    ) -> str:
        active = [item for item in items if not item.completed]
        grouped: dict[tuple[str, str] | None, list[ListItemRecord]] = defaultdict(list)
        category_names: dict[tuple[str, str] | None, str] = {}
        for item in active:
            # An actual category named General/Allgemein is distinct from no category.
            category_id = getattr(item, "category_id", None)
            category = item.category or None
            key = ("id", category_id) if category_id else ("name", category) if category else None
            grouped[key].append(item)
            category_names[key] = str(category) if category is not None else localized_text("backend.general")
        offer_suffix = " " + localized_text("backend.notification_offer_suffix")

        def todo_details(item: ListItemRecord) -> list[str]:
            details: list[str] = []
            description = cls._short_text(item.description)
            if description:
                details.append(description)
            if item.due_at:
                raw_due = str(item.due_at).strip()
                due_label = cls._format_due_at(raw_due)
                status = localized_text("backend.due")
                try:
                    due = datetime.fromisoformat(raw_due.replace("Z", "+00:00"))
                    date_only = "T" not in raw_due and " " not in raw_due
                    if date_only:
                        today = datetime.now().date()
                        if due.date() < today:
                            status = localized_text("backend.overdue")
                        elif due.date() == today:
                            status = localized_text("backend.due_today")
                    else:
                        now = datetime.now(due.tzinfo) if due.tzinfo else datetime.now()
                        status = localized_text("backend.overdue") if due < now else localized_text("backend.due")
                except ValueError:
                    pass
                details.append(f"{status}: {due_label}")
            recurrence = cls._format_recurrence(
                {
                    "recurrence_interval": item.recurrence_interval,
                    "recurrence_unit": item.recurrence_unit,
                }
            )
            if recurrence:
                details.append(recurrence)
            return details

        if message_format == "html":
            sections = []
            for category_key, category_items in grouped.items():
                category = category_names[category_key]
                if list_record.list_type == "todo":
                    rows = ""
                    for item in category_items:
                        details = todo_details(item)
                        detail_html = (
                            f"<br><small>{escape(' · '.join(details))}</small>"
                            if details else ""
                        )
                        rows += f"<li>{escape(item.name)}{detail_html}</li>"
                else:
                    rows = "".join(
                        f"<li>{escape(item.name)}{escape(offer_suffix) if item.offer_only else ''}"
                        f"{f' &times; {item.quantity}' if item.quantity != 1 else ''}</li>"
                        for item in category_items
                    )
                sections.append(f"<h3>{escape(category)}</h3><ul>{rows}</ul>")
            return f"<h2>{escape(list_record.name)}</h2>{''.join(sections)}"
        markdown = message_format == "markdown"
        telegram_markdown = markdown and telegram
        render_text = cls._telegram_markdown_text if telegram_markdown else str
        lines = [render_text(list_record.name)]
        for category_key, category_items in grouped.items():
            category = category_names[category_key]
            if telegram_markdown:
                heading = f"*{render_text(category)}*"
            else:
                heading = f"**{category}**" if markdown else category
            lines.extend(["", heading])
            if list_record.list_type == "todo":
                for item in category_items:
                    details = todo_details(item)
                    detail_text = f" — {' · '.join(details)}" if details else ""
                    prefix = "\\- " if telegram_markdown else "- "
                    lines.append(prefix + render_text(item.name + detail_text))
            else:
                for item in category_items:
                    text = f"{item.name}{f' × {item.quantity}' if item.quantity != 1 else ''}{offer_suffix if item.offer_only else ''}"
                    prefix = "\\- " if telegram_markdown else "- "
                    lines.append(prefix + render_text(text))
        if not active:
            lines.extend(["", render_text(localized_text("backend.list_empty"))])
        return "\n".join(lines)
