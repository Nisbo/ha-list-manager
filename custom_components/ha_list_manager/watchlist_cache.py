"""Persistent, bounded cache for streaming availability and episode credits."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from .const import DOMAIN


class WatchlistCache:
    def __init__(self, store):
        self._store = store
        self._records = None
        self._lock = asyncio.Lock()

    async def read(self, key, ttl):
        async with self._lock:
            if self._records is None:
                self._records = await self._store.async_load() or {}
            record = self._records.get(key)
        if record is None:
            return None
        age = datetime.now(UTC) - datetime.fromisoformat(record["checked_at"])
        return {**record, "stale": age >= timedelta(hours=ttl)}

    async def availability(self, region, titles):
        async with self._lock:
            if self._records is None:
                self._records = await self._store.async_load() or {}
            return {
                f"{title['kind']}:{title['id']}": {
                    group: [provider["id"] for provider in providers]
                    for group, providers in self._records[key]["data"]["groups"].items()
                    if group in {"flatrate", "free", "ads"}
                }
                for title in titles
                if (key := availability_key(region, title["kind"], title["id"])) in self._records
            }

    async def write(self, key, data, *, persistent=False):
        record = {"data": data, "checked_at": datetime.now(UTC).isoformat()}
        if persistent:
            record["persistent"] = True
        async with self._lock:
            if self._records is None:
                self._records = await self._store.async_load() or {}
            records = {**self._records, key: record}
            transient = [item for item in records if not records[item].get("persistent")]
            for item in sorted(transient, key=lambda name: records[name]["checked_at"])[:max(0, len(transient) - 600)]:
                del records[item]
            await self._store.async_save(records)
            self._records = records
        return {**record, "stale": False}


def watchlist_cache(hass):
    from homeassistant.helpers.storage import Store

    key = f"{DOMAIN}.watchlist_cache"
    if key not in hass.data:
        hass.data[key] = WatchlistCache(Store(hass, 1, key))
    return hass.data[key]


def streaming_region(hass, options):
    region = options.get("watchlist_region") or getattr(getattr(hass, "config", None), "country", None)
    return region if valid_region(region) else None


def valid_region(region):
    return isinstance(region, str) and len(region) == 2 and region.isascii() and region.isalpha() and region.isupper()


def availability_key(region, kind, media_id):
    return f"availability:v2:{region}:{kind}:{media_id}"
