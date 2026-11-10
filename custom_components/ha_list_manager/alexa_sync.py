"""Reconcile linked Alexa positions without synchronizing by display name.

The durable receipt journal distinguishes requested writes from source changes.
An Alexa UID is consumed by intake only once; reopening it changes status, never
the quantity already accepted by that intake.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from time import time
from typing import Any

from .const import EVENT_ITEMS_CHANGED
from .localization import text

MISSING_GRACE_SECONDS = 2.0
_MAX_WRITES = 10
_PASS_SECONDS = 20.0


class _Deferred(Exception):
    """Leave journaled work for a later bounded reconciliation pass."""


def _record(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    return value.as_dict() if hasattr(value, "as_dict") else dict(value)


def _local(value: Any) -> dict[str, Any] | None:
    value = _record(value)
    return ({key: value.get(key) for key in
             ("id", "name", "description", "quantity", "completed", "updated_at")}
            if value is not None else None)


def _remote(row: dict[str, Any]) -> dict[str, Any]:
    return {"summary": row["summary"], "status": row["status"]}


def _semantic(snapshot):
    return {key: value for key, value in snapshot.items() if key != "updated_at"} if snapshot else None


def _summary(item: dict[str, Any]) -> str:
    name, description, quantity = item["name"], item.get("description"), item["quantity"]
    if description:
        return (f"{quantity} × {description} {name}" if quantity != 1
                else f"{description} {name}")
    return f"{quantity} {name}" if quantity != 1 else name


class AlexaSyncManager:
    """Perform reversible status changes and explicitly requested deletions."""

    def __init__(self, hass, database) -> None:
        self._hass = hass
        self._database = database
        self._cursor = None
        self._deadline = 0.0
        self._writes = 0

    def _remaining(self) -> float:
        return max(0.0, self._deadline - asyncio.get_running_loop().time())

    async def _read(self, reader, entity_id):
        remaining = self._remaining()
        if remaining <= 0:
            raise _Deferred
        async with asyncio.timeout(remaining):
            return await reader(entity_id)

    async def async_pending_count(self, source_id: str, target_list_id: str) -> int:
        links = await self._database.async_list_alexa_links(source_id)
        return sum(bool(row.get("sync", {}).get("pending")
                        or row.get("sync", {}).get("local_action")
                        or row.get("sync", {}).get("desired_status"))
                   for row in links if row.get("target_list_id") == target_list_id)

    async def async_mode_changed(self, source_id) -> None:
        """Start from observed states after explicit mode or mapping changes."""
        for link in await self._database.async_list_alexa_links(source_id):
            if link.get("sync"):
                await self._database.async_update_alexa_link(source_id, link["uid"], {})

    async def _save(self, source_id, link, check, *, original_name=None, force=False) -> None:
        check()
        if (link.get("_saved_sync") == link["sync"]
                and (original_name is None or original_name == link.get("original_name"))):
            return
        if not force and self._remaining() <= 0:
            raise _Deferred
        await self._database.async_update_alexa_link(
            source_id, link["uid"], link["sync"], original_name=original_name,
        )
        link["_saved_sync"] = deepcopy(link["sync"])
        if original_name is not None:
            link["original_name"] = original_name
        check()

    async def _missing(self, source_id, link, row, check) -> bool:
        sync = link.setdefault("sync", {})
        if row is not None:
            if sync.pop("missing", None) is not None:
                await self._save(source_id, link, check)
            return False
        missing = sync.setdefault("missing", {"since": time(), "observations": 0})
        missing["observations"] += 1
        await self._save(source_id, link, check)
        return missing["observations"] >= 2 and time() - missing["since"] >= MISSING_GRACE_SECONDS

    async def _detach_missing(self, source_id, group, missing, check):
        """Finish a rejected source deletion before advancing the local baseline."""
        removed = [link["uid"] for link in group if link["uid"] in missing]
        if removed:
            check()
            await self._database.async_remove_alexa_links(source_id, removed)
            check()
        return [link for link in group if link["uid"] not in missing]

    async def async_reconcile(
        self, source_id, entity_id, target_list_id, rows, settings,
        generation_check, read_source=None,
    ) -> list[str]:
        """Reconcile one validated complete source snapshot under manager lock.

        The caller must never substitute an empty list after a failed source
        read. A missing UID needs a later successful snapshot before pruning.
        """
        check = generation_check
        self._deadline = asyncio.get_running_loop().time() + _PASS_SECONDS
        self._writes = 0
        check()
        links = await self._database.async_list_alexa_links(source_id)
        check()
        for link in links:
            link["sync"] = deepcopy(link.get("sync") or {})
            link["_saved_sync"] = deepcopy(link["sync"])
        observed = {row["uid"]: row for row in rows}
        errors = []
        if settings.get("mode") != "coupled":
            for link in links:
                try:
                    if await self._missing(source_id, link, observed.get(link["uid"]), check):
                        check()
                        await self._database.async_remove_alexa_links(source_id, [link["uid"]])
                except _Deferred:
                    break
            return errors

        items = {item.id: item.as_dict() for item in
                 await self._database.async_list_items(target_list_id)}
        check()
        groups = {}
        for link in links:
            if (link.get("target_list_id") == target_list_id and link.get("item_id")
                    and link.get("cleanup_status") != "ignored"):
                groups.setdefault(link["item_id"], []).append(link)
            else:
                try:
                    if await self._missing(source_id, link, observed.get(link["uid"]), check):
                        await self._database.async_remove_alexa_links(source_id, [link["uid"]])
                except _Deferred:
                    break
        order = list(groups)
        if self._cursor in groups:
            offset = order.index(self._cursor) + 1
            order = order[offset:] + order[:offset]
        for item_id in order:
            check()
            if self._writes >= _MAX_WRITES or self._remaining() <= 0:
                break
            self._cursor = item_id
            group = groups[item_id]
            group.sort(key=lambda row: (row.get("created_at") or "", row["uid"]))
            try:
                await self._group(source_id, entity_id, group, items.get(item_id),
                                  observed, settings, check, read_source)
            except asyncio.CancelledError:
                raise
            except _Deferred:
                break
            except Exception:
                # The journal remains retryable; cloud errors may contain private
                # payloads, so expose only the native translated safe diagnostic.
                errors.append(str(text("alexa.processing_failed")))
        return errors

    async def _group(self, source_id, entity_id, group, item, observed, settings, check, reader):
        # A snapshot captured before our completed write can arrive afterwards.
        # Recheck it against the current HA source, instead of reading that echo
        # as an immediate user undo. Without a reader, require another snapshot.
        refreshed = None
        for link in group:
            echo, row = link["sync"].get("echo"), observed.get(link["uid"])
            if not echo or row is None:
                continue
            if _remote(row) == echo["before"] and echo["before"] != echo["after"]:
                if reader is not None:
                    if refreshed is None:
                        check()
                        refreshed = {value["uid"]: value for value in await self._read(reader, entity_id)}
                        check()
                    fresh = refreshed.get(link["uid"])
                    if fresh is not None:
                        observed[link["uid"]] = fresh
                    else:
                        observed.pop(link["uid"], None)
                elif not echo.get("stale_seen"):
                    echo["stale_seen"] = True
                    link["_awaiting_echo"] = True
                    await self._save(source_id, link, check)
                    continue
            link["sync"].pop("echo", None)
            await self._save(source_id, link, check)
        missing = set()
        for link in group:
            if await self._missing(source_id, link, observed.get(link["uid"]), check):
                missing.add(link["uid"])
        snapshot = _local(item)
        baselines = [link["sync"]["local"] for link in group if "local" in link["sync"]]
        initialized = bool(baselines)
        local_changed = initialized and _semantic(snapshot) != _semantic(baselines[0])
        delete = item is None
        # An explicit mode activation projects the local status to existing
        # links, without replaying historical source completions/deletions.
        status_action = local_changed or bool(not initialized and item is not None and any(
            row is not None and (row["status"] == "completed") != bool(item["completed"])
            for row in (observed.get(link["uid"]) for link in group)))
        status_action = status_action or any(
            link["sync"].get("desired_status")
            and _semantic(link["sync"]["desired_status"].get("local")) == _semantic(snapshot)
            for link in group)
        completed = bool(item and item["completed"])

        # A crash may happen after journaling an inbound action but before its
        # local commit. Replay only while the original local revision remains.
        action = next((link["sync"].get("local_action") for link in group
                       if link["sync"].get("local_action")), None)
        if action and item is not None:
            if _semantic(snapshot) == _semantic(action["before"]):
                delete = action["delete"]
                completed = action["completed"]
                status_action = True
            else:
                # A newer local revision wins over a delayed source action.
                local_changed = status_action = True
        elif not delete and not local_changed:
            remote_changes = []
            for link in group:
                sync, row = link["sync"], observed.get(link["uid"])
                if link.get("_awaiting_echo"):
                    continue
                pending = sync.get("pending")
                if pending and (row is not None or pending.get("reason") == "consolidate"):
                    # Replies to our own writes, including secondary-UID
                    # consolidation, are not new user actions.
                    continue
                if "remote" not in sync:
                    continue
                if row is None:
                    if link["uid"] in missing:
                        delete = True
                elif _semantic(sync.get("desired_status", {}).get("local")) == _semantic(snapshot):
                    continue
                elif row["status"] != sync["remote"]["status"]:
                    remote_changes.append(row["status"] == "completed")
            if remote_changes:
                # An explicit reopening wins over conflicting completed echoes.
                completed = all(remote_changes)
                delete = delete or (completed and settings.get("coupled_completion") == "delete")
                status_action = True

        if local_changed and item is not None and missing:
            # A local edit also wins when the competing source UID is gone.
            # Detach that confirmed absence before persisting a new baseline,
            # otherwise the same old deletion would win on the following pass.
            group = await self._detach_missing(source_id, group, missing, check)
            if not group:
                return

        if item is not None and (delete or (status_action and item["completed"] != completed)):
            intent = {"before": snapshot, "delete": delete, "completed": completed}
            for link in group:
                link["sync"]["local_action"] = intent
                await self._save(source_id, link, check)
            check()
            applied = await self._database.async_apply_alexa_sync_local(
                item["id"], item["updated_at"], completed=completed, delete=delete,
            )
            check()
            item = _record(applied["item"])
            snapshot = _local(item)
            if not applied["applied"]:
                # CAS refused because a local edit won the race.
                if delete and item is not None and missing:
                    group = await self._detach_missing(source_id, group, missing, check)
                    if not group:
                        return
                delete = item is None
                completed = bool(item and item["completed"])
            else:
                self._hass.bus.async_fire(EVENT_ITEMS_CHANGED, {"list_id": applied["list_id"]})
            status_action = True

        # Persist the post-local-write baseline before any cloud operation.
        # It is also sufficient to recognize that a replayed deletion succeeded.
        for link in group:
            sync = link["sync"]
            sync.pop("local_action", None)
            sync["local"] = snapshot
            if status_action and item is not None:
                sync["desired_status"] = {"status": "completed" if completed else "needs_action",
                                          "local": snapshot}
            if "remote" not in sync and link["uid"] in observed:
                sync["remote"] = _remote(observed[link["uid"]])
            await self._save(source_id, link, check)

        if delete:
            for link in group:
                row = observed.get(link["uid"])
                if row is not None:
                    await self._cloud(source_id, entity_id, link, row, check,
                                      delete=True, local=snapshot, reason="position")
                elif link["uid"] in missing:
                    await self._database.async_remove_alexa_links(source_id, [link["uid"]])
            return

        canonical = group[0]
        normalize = settings.get("sync_quantities") is True
        desired_name = _summary(item) if normalize else None
        if desired_name is not None and len(desired_name) > 2000:
            raise ValueError("Alexa summary exceeds source limit")
        canonical_confirmed = False
        for link in group:
            row = observed.get(link["uid"])
            sync = link["sync"]
            pending = sync.get("pending")
            if link.get("_awaiting_echo"):
                continue
            if row is None:
                if pending and pending.get("reason") == "consolidate" and link["uid"] in missing:
                    # The requested secondary removal is already reflected.
                    await self._database.async_remove_alexa_links(source_id, [link["uid"]])
                elif link["uid"] in missing and "remote" not in sync:
                    # Baseline activation never retroactively deletes a local
                    # article because an old source UID is already absent.
                    await self._database.async_remove_alexa_links(source_id, [link["uid"]])
                continue
            if normalize and link is not canonical:
                continue
            desired_status = ("completed" if completed else "needs_action") if status_action else None
            planned = sync.get("desired_status")
            if planned and _semantic(planned.get("local")) == _semantic(snapshot):
                desired_status = desired_status or planned["status"]
            if pending and pending.get("action") == "update":
                # A newer local revision replaces an obsolete pending write.
                if _semantic(pending.get("local")) == _semantic(snapshot):
                    desired_status = desired_status or pending.get("status")
            summary = desired_name if normalize and link is canonical else None
            if ((summary is not None and summary != row["summary"])
                    or (desired_status is not None and desired_status != row["status"])):
                row = await self._cloud(source_id, entity_id, link, row, check,
                                        summary=summary, status=desired_status, local=snapshot)
                observed[link["uid"]] = row
            else:
                sync.pop("pending", None)
                sync.pop("desired_status", None)
                sync["remote"] = _remote(row)
                await self._save(source_id, link, check, original_name=row["summary"])
            if link is canonical and normalize:
                if reader is not None and len(group) > 1:
                    check()
                    verified = {value["uid"]: value for value in await self._read(reader, entity_id)}
                    check()
                    value = verified.get(link["uid"])
                    canonical_confirmed = bool(value and value["summary"] == desired_name
                                               and value["status"] == row["status"])
                else:
                    canonical_confirmed = row["summary"] == desired_name

        if normalize and canonical_confirmed:
            for link in group[1:]:
                row = observed.get(link["uid"])
                if row is not None:
                    await self._cloud(source_id, entity_id, link, row, check,
                                      delete=True, local=snapshot, reason="consolidate")

    async def _cloud(self, source_id, entity_id, link, row, check, *,
                     summary=None, status=None, delete=False, local=None, reason=None):
        sync = link["sync"]
        pending = {"action": "delete" if delete else "update", "local": local}
        if summary is not None:
            pending["summary"] = summary
        if status is not None:
            pending["status"] = status
        if reason is not None:
            pending["reason"] = reason
        sync["pending"] = pending
        await self._save(source_id, link, check, force=True)
        data = {"entity_id": entity_id, "item": link["uid"]}
        if summary is not None:
            data["rename"] = summary
        if status is not None:
            data["status"] = status
        check()
        remaining = self._remaining()
        if self._writes >= _MAX_WRITES or remaining <= 0:
            raise _Deferred
        self._writes += 1
        async with asyncio.timeout(min(10, remaining)):
            await self._hass.services.async_call(
                "todo", "remove_item" if delete else "update_item", data, blocking=True,
            )
        check()
        if delete:
            await self._database.async_remove_alexa_links(source_id, [link["uid"]])
            return None
        updated = {**row, "summary": summary if summary is not None else row["summary"],
                   "status": status if status is not None else row["status"]}
        sync.pop("pending", None)
        sync.pop("desired_status", None)
        sync["echo"] = {"before": _remote(row), "after": _remote(updated)}
        sync["remote"] = _remote(updated)
        await self._save(source_id, link, check, original_name=updated["summary"])
        return updated
