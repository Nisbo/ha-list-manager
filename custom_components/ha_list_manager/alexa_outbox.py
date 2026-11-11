"""Durable outgoing creates, with conservative acknowledgement and no blind retry."""
from __future__ import annotations

import asyncio
from typing import Any
import unicodedata

from .alexa_sync import _local, _summary
from .database import ListItemNotFoundError
from .localization import text


class AlexaOutboxManager:
    """Keep an uncertain create distinct from a new spoken Alexa order."""

    def __init__(self, hass, database) -> None:
        self._hass, self._database = hass, database

    @staticmethod
    def _eligible(job, source_id, target_id, settings):
        return (settings.get("enabled") and settings.get("mode") == "coupled"
                and settings.get("send_local_items") is True
                and job["source_id"] == source_id and job["target_list_id"] == target_id)

    @staticmethod
    def _new_rows(job, rows):
        before = set(job["payload"].get("before_uids", []))
        return [row for row in rows if row["uid"] not in before]

    @staticmethod
    def _same_summary(job, summary):
        def normalized(value):
            return " ".join(unicodedata.normalize("NFKC", value or "").casefold().split())
        return normalized(job["payload"].get("summary")) == normalized(summary)

    async def async_quarantined(self, source_id, rows) -> set[str]:
        jobs = await self._database.async_list_alexa_outbox(source_id=source_id)
        return {row["uid"] for job in jobs if job["state"] != "queued"
                for row in self._new_rows(job, rows) if self._same_summary(job, row["summary"])}

    async def async_status(self) -> dict[str, Any]:
        jobs = await self._database.async_list_alexa_outbox()
        displayed = []
        for job in jobs[:50]:
            payload = job["payload"]
            local = payload.get("local") or {}
            key = ("alexa.outbox_cancelled" if job["state"] == "cancelled"
                   else payload.get("error_key") or
                   ("alexa.outbox_uncertain" if job["state"] != "queued" else None))
            candidates = payload.get("candidates", [])[:50]
            if candidates:
                uids = [row["uid"] for row in candidates]
                claimed = await self._database.async_get_alexa_receipts(job["source_id"], uids)
                consumed = await self._database.async_has_alexa_history(job["source_id"], uids)
                candidates = [row for row in candidates
                              if row["uid"] not in claimed and row["uid"] not in consumed]
            displayed.append({field: job[field] for field in
                ("id", "source_entity_id", "target_list_id", "item_id", "state")})
            displayed[-1].update(item_name=local.get("name", ""), quantity=local.get("quantity", 1),
                                 message=str(text(key)) if key else "",
                                 candidates=candidates)
        return {"outbound_jobs": displayed, "pending_outbound": len(jobs),
                "uncertain_outbound": sum(job["state"] != "queued" for job in jobs)}

    async def _remember_candidates(self, job, rows, *, state=None, error_key=None):
        candidates = self._new_rows(job, rows)
        uids = [row["uid"] for row in candidates]
        claimed = await self._database.async_get_alexa_receipts(job["source_id"], uids)
        consumed = await self._database.async_has_alexa_history(job["source_id"], uids)
        payload = {**job["payload"], "candidates": [row for row in candidates
                    if row["uid"] not in claimed and row["uid"] not in consumed][:50]}
        if error_key:
            payload["error_key"] = error_key
        state = state or job["state"]
        if state == job["state"] and payload == job["payload"]:
            return job
        return await self._database.async_update_alexa_outbox(job["id"], state, payload,
                                                               expected_state=job["state"])

    async def async_cancel(self, job):
        if job["state"] == "queued":
            await self._database.async_remove_alexa_outbox(job["id"])
        else:
            # Forgetting the guard would turn a late create echo into an order.
            await self._database.async_update_alexa_outbox(job["id"], "cancelled")

    async def async_bind(self, job, uid, rows) -> bool:
        if job["state"] == "queued":
            return False
        row = next((row for row in self._new_rows(job, rows) if row["uid"] == uid), None)
        if row is None:
            return False
        return await self._database.async_bind_alexa_outbox(
            job["id"], uid, row["summary"], row["status"])

    async def async_reconcile(self, source_id, entity_id, target_id, rows, settings,
                              check, read_source):
        """Run before intake while its manager lock also serializes source echoes."""
        jobs = await self._database.async_list_alexa_outbox()
        check()
        errors = []
        unresolved = []
        for job in jobs:
            if job["state"] == "queued":
                continue
            if job["source_id"] != source_id:
                continue
            # A previous process may have stopped between the service call and
            # its reply. A single matching later row is not proof of origin.
            job = await self._remember_candidates(job, rows,
                state="uncertain" if job["state"] == "attempted" else None,
                error_key="alexa.outbox_uncertain" if job["state"] == "attempted" else None)
            check()
            if job:
                unresolved.append(job)
        if unresolved:
            errors.append(str(text("alexa.outbox_uncertain")))
        if not any(job["state"] == "queued" and self._eligible(job, source_id, target_id, settings)
                   for job in jobs):
            return rows, await self.async_quarantined(source_id, rows), errors

        linked = {row["item_id"] for row in await self._database.async_list_alexa_links(source_id)
                  if row["cleanup_status"] != "ignored" and row["target_list_id"] == target_id}
        deadline = asyncio.get_running_loop().time() + 20
        sent = 0
        for job in jobs:
            check()
            if job["state"] != "queued":
                continue
            if not self._eligible(job, source_id, target_id, settings):
                # Settings changes remove unsent jobs in the same DB commit.
                continue
            try:
                local = (await self._database.async_get_item(job["item_id"])).as_dict()
            except ListItemNotFoundError:
                local = None
            check()
            if local is None or local["completed"] or local["id"] in linked:
                await self._database.async_remove_alexa_outbox(job["id"])
                continue
            if sent >= 3 or asyncio.get_running_loop().time() >= deadline:
                break
            summary = _summary(local)
            if any(self._same_summary(pending, summary) for pending in unresolved):
                # An unrelated order can continue while this exact text is
                # awaiting acknowledgement; never freeze the entire list.
                payload = {**job["payload"], "local": _local(local),
                           "error_key": "alexa.outbox_uncertain"}
                if payload != job["payload"]:
                    await self._database.async_update_alexa_outbox(job["id"], "queued", payload,
                                                                     expected_state="queued")
                continue
            if len(summary) > 2000:
                await self._database.async_update_alexa_outbox(job["id"], "queued",
                    {**job["payload"], "local": _local(local), "error_key": "alexa.outbox_name_too_long"})
                errors.append(str(text("alexa.outbox_name_too_long")))
                continue
            payload = {"local": _local(local), "summary": summary,
                       "before_uids": [row["uid"] for row in rows], "candidates": []}
            # The queued row may have disappeared when the article was deleted.
            job = await self._database.async_update_alexa_outbox(job["id"], "attempted", payload,
                                                                  expected_state="queued")
            if job is None:
                continue
            check()
            sent += 1
            try:
                remaining = max(0.01, deadline - asyncio.get_running_loop().time())
                async with asyncio.timeout(min(10, remaining)):
                    await self._hass.services.async_call("todo", "add_item",
                        {"entity_id": entity_id, "item": summary}, blocking=True)
                    check()
                    fresh = await read_source(entity_id)
                check()
                rows = fresh
                matches = [row for row in self._new_rows(job, rows) if row["summary"] == summary]
                if len(matches) == 1 and await self.async_bind(job, matches[0]["uid"], rows):
                    linked.add(job["item_id"])
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                # The add may have succeeded before its response was lost.
                # Only explicit user resolution can release this guard safely.
                check()
            await self._remember_candidates(job, rows, state="uncertain",
                                             error_key="alexa.outbox_uncertain")
            check()
            errors.append(str(text("alexa.outbox_uncertain")))
            break
        return rows, await self.async_quarantined(source_id, rows), errors
