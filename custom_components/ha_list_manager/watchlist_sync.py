"""Scheduled incremental updates of the local Watchlist."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, time, timedelta
import logging

from homeassistant.core import callback
from homeassistant.util import dt as dt_util

from . import watchlist
from .const import DOMAIN, EVENT_WATCHLIST_CHANGED
from .tmdb import Tmdb
from .watchlist_cache import availability_key, streaming_region, watchlist_cache

_LOGGER = logging.getLogger(__name__)

def _updated_seasons(previous, title, changes, cached, recover):
    old = {row["number"]: row["count"] for row in previous.get("seasons", [])}
    rows = title.get("seasons", [])
    changed = {row["number"] for row in rows if row["count"] and row["count"] != old.get(row["number"], 0)}
    by_id = {row["tmdb_id"]: row["number"] for row in rows if row.get("tmdb_id")}
    valid = {row["number"] for row in rows}
    for change in changes:
        if change.get("key") not in {"season", "episode"}:
            continue
        for item in change.get("items") or []:
            value = item.get("value")
            if isinstance(value, dict):
                number = value.get("season_number")
                if number not in valid:
                    number = by_id.get(value.get("season_id") or value.get("id"))
                if number not in valid:
                    episode_id = value.get("episode_id")
                    number = next((n for n, episodes in cached.items()
                                   if episode_id and any(ep.get("tmdb_id") == episode_id for ep in episodes)), None)
                if number in valid:
                    changed.add(number)
                    continue
            # Older cached episodes may predate stable IDs. Revalidate the
            # seasons we have locally if TMDB cannot locate the change for us.
            recover = True
    return sorted((changed | (cached.keys() if recover else set())) & valid)


class WatchlistSync:
    def __init__(self, hass, runtime):
        from homeassistant.helpers.storage import Store

        self.hass, self.runtime = hass, runtime
        self._store = Store(hass, 1, f"{DOMAIN}.watchlist_sync")
        self._logs = []
        self._wake = asyncio.Event()
        self._task = None
        self._unsub = None
        self._force = False
        self._active_run = None
        self._retry_after = None
        self._scheduled = None

    @property
    def options(self):
        return self.runtime.config_entry.options

    async def async_start(self):
        self._logs = await self._store.async_load() or []
        self._scheduled = self._next(watchlist.sync_settings(self.options), datetime.now(UTC))
        if self.hass.is_running:
            self._start()
        else:
            self._unsub = self.hass.bus.async_listen_once("homeassistant_started", self._start)

    @callback
    def _start(self, _event=None):
        self._task = self.runtime.config_entry.async_create_background_task(
            self.hass, self._worker(), "HA List Manager Watchlist sync",
        )

    async def async_stop(self):
        if self._unsub:
            self._unsub()
            self._unsub = None
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    def reschedule(self):
        self._wake.set()

    def force(self):
        if self._active_run is None and not self._force and self.options.get("tmdb_token"):
            self._force = True
            self._wake.set()

    def status(self):
        run = self._active_run
        progress = None if run is None else {
            "total": run.get("total"), "processed": run["checked"] + run["errors"],
            "errors": run["errors"], "title": run.get("current_title"),
        }
        retry_at = self._retry_after if self._force and self._retry_after and self._retry_after > datetime.now(UTC) else None
        return {"running": run is not None or self._force, "progress": progress, "runs": self._logs,
                "retry_at": retry_at.isoformat() if retry_at else None,
                "next": self._scheduled.isoformat() if self._scheduled else None}

    def _next(self, settings, now):
        if not self.options.get("tmdb_token") or not settings["enabled"]:
            return None
        local = now.astimezone(dt_util.DEFAULT_TIME_ZONE)
        today = datetime.combine(local.date(), time.fromisoformat(settings["time"]), local.tzinfo)
        last = next((run["slot"] for run in self._logs if run.get("slot")), "")
        point = today if today.isoformat() > last else today + timedelta(days=1)
        return max(point.astimezone(UTC), self._retry_after) if self._retry_after else point.astimezone(UTC)

    async def _worker(self):
        while True:
            self._wake.clear()
            now = datetime.now(UTC)
            settings = watchlist.sync_settings(self.options)
            next_run = self._next(settings, now)
            self._scheduled = next_run
            timeout = min(60, max(0, (next_run - now).total_seconds())) if next_run else 60
            if self._retry_after and self._retry_after > now:
                timeout = min(60, (self._retry_after - now).total_seconds())
            elif self._force or next_run is not None and next_run <= now:
                force, self._force = self._force, False
                slot = None if force else now.astimezone(dt_util.DEFAULT_TIME_ZONE).replace(
                    hour=int(settings["time"][:2]), minute=int(settings["time"][3:]), second=0, microsecond=0,
                ).isoformat()
                try:
                    await self._run(settings, now, force, slot)
                except Exception:
                    _LOGGER.exception("Could not complete Watchlist sync")
                    self._retry_after = datetime.now(UTC) + timedelta(minutes=15)
                continue
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
            except TimeoutError:
                pass

    async def _run(self, settings, now, force, slot):
        options = self.options
        token = options.get("tmdb_token")
        if not token:
            return
        region = streaming_region(self.hass, options)
        language = (self.hass.config.language or "en").split("-")[0]
        clients = {}
        database = self.runtime.database
        run = {"time": now.isoformat(), "slot": slot, "force": force, "checked": 0,
               "changed": 0, "errors": 0, "details": []}
        self._active_run = run
        try:
            titles = await database._async_run(watchlist.sync_titles, database)
            local = dt_util.DEFAULT_TIME_ZONE
            day = now.astimezone(local).date()
            due = []
            for title in sorted(titles, key=lambda item: item.get("sync_stamp") or ""):
                stamp = datetime.fromisoformat(title["sync_stamp"]) if title.get("sync_stamp") else None
                if (force or stamp is None or title.get("sync_region") != region
                        or (day - stamp.astimezone(local).date()).days >= watchlist.sync_interval(settings, title)):
                    due.append((title, stamp))
            run["total"] = len(due)
            for index, (title, previous) in enumerate(due):
                if index:
                    run.pop("current_title", None)
                    await asyncio.sleep(1)
                if (self.options.get("tmdb_token") != token
                        or streaming_region(self.hass, self.options) != region
                        or not force and not watchlist.sync_settings(self.options)["enabled"]):
                    break
                run["current_title"] = title["title"]
                try:
                    locale = (title.get("metadata_language") or language).split("-")[0]
                    if locale not in clients:
                        clients[locale] = Tmdb(self.hass, token, locale)
                    details = await self._sync_one(clients[locale], title, region, now, previous)
                except (watchlist.WatchlistError, KeyError, TypeError, ValueError) as error:
                    key = getattr(error, "key", "remote")
                    run["errors"] += 1
                    details = [{"key": key, "error": True}]
                    if key in {"credentials", "rate_limit"}:
                        if key == "rate_limit":
                            self._retry_after = datetime.now(UTC) + timedelta(minutes=15)
                            run["slot"] = None
                        run["details"].extend({**detail, "title": title["title"]} for detail in details)
                        break
                else:
                    run["checked"] += 1
                    run["changed"] += bool(details)
                run["details"].extend({**detail, "title": title["title"]} for detail in details)
            run.pop("current_title", None)
            run["truncated"] = max(0, len(run["details"]) - 300)
            run["details"] = run["details"][:300]
            logs = [run, *self._logs][:20]
            await self._store.async_save(logs)
            self._logs = logs
            if run["checked"]:
                self.hass.bus.async_fire(EVENT_WATCHLIST_CHANGED, {"sync": True})
        finally:
            self._active_run = None

    async def _sync_one(self, client, previous, region, now, stamp):
        kind, media_id = previous["kind"], previous["id"]
        floor = now.date() - timedelta(days=13)
        start = max(floor, stamp.date()) if stamp else floor
        updates, providers, changes = await client.sync_title(kind, media_id, region, str(start), str(now.date()))
        database = self.runtime.database
        seasons = {}
        if kind == "tv":
            cached = await database._async_run(watchlist.cached_seasons, database, media_id)
            for number in _updated_seasons(previous, updates, changes, cached, not stamp or stamp.date() < floor):
                seasons[number] = await client.season(media_id, number)
        details = await database._async_run(
            watchlist.apply_sync, database, previous, updates, seasons, now.isoformat(), region,
        )
        if details is None:
            return []
        if providers is not None:
            cache = watchlist_cache(self.hass)
            key = availability_key(region, kind, media_id)
            old = await cache.read(key, 24)
            await cache.write(key, providers, persistent=True)
            if old:
                for group, entries in providers["groups"].items():
                    prior = {item["id"]: item["name"] for item in old["data"]["groups"].get(group, [])}
                    current = {item["id"]: item["name"] for item in entries}
                    for label, first, second in (("provider_added", current, prior), ("provider_removed", prior, current)):
                        details.extend({"key": label, "provider": first[item], "offer": group}
                                       for item in first.keys() - second.keys())
        return details
