"""Personal streaming subscriptions and remembered playback sources."""
from __future__ import annotations

import asyncio

from .const import DOMAIN

_PLAYBACK = "playback_sources"


class WatchlistSubscriptions:
    def __init__(self, store):
        self._store = store
        self._records = None
        self._lock = asyncio.Lock()

    async def _load(self):
        if self._records is None:
            self._records = await self._store.async_load() or {}

    async def view(self, region, user_id, household_ids=()):
        async with self._lock:
            await self._load()
            users = self._records.get(region, {})
            own = set(users.get(user_id, []))
            household = {provider_id for other_id in household_ids if other_id != user_id
                         for provider_id in users.get(other_id, [])}
        return {"own": sorted(own), "household": sorted(household - own)}

    async def save(self, region, user_id, ids):
        async with self._lock:
            await self._load()
            users = dict(self._records.get(region, {}))
            if ids:
                users[user_id] = sorted(set(ids))
            else:
                users.pop(user_id, None)
            records = {**self._records, region: users}
            await self._store.async_save(records)
            self._records = records

    async def playback_source(self, user_id, kind, media_id):
        key = f"{kind}:{media_id}"
        async with self._lock:
            await self._load()
            return self._records.get(_PLAYBACK, {}).get(user_id, {}).get(key)

    async def remember_playback_source(self, user_id, kind, media_id, source):
        key = f"{kind}:{media_id}"
        async with self._lock:
            await self._load()
            users = dict(self._records.get(_PLAYBACK, {}))
            titles = dict(users.get(user_id, {}))
            if titles.get(key) == source:
                return
            if source:
                titles[key] = source
            else:
                titles.pop(key, None)
            if titles:
                users[user_id] = titles
            else:
                users.pop(user_id, None)
            records = {**self._records, _PLAYBACK: users}
            await self._store.async_save(records)
            self._records = records


def watchlist_subscriptions(hass):
    from homeassistant.helpers.storage import Store

    key = f"{DOMAIN}.watchlist_subscriptions"
    if key not in hass.data:
        hass.data[key] = WatchlistSubscriptions(Store(hass, 1, key))
    return hass.data[key]
