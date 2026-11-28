"""Read-only TMDB API client using Home Assistant's HTTP session."""
from __future__ import annotations

import asyncio
import re
from urllib.parse import urlsplit

from aiohttp import ClientError, ClientTimeout
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .watchlist import CAST_LIMIT, TV_FULL_CAST_REVISION, WatchlistError, watchlist_error

TMDB_API = "https://api.themoviedb.org/3"
IMAGE_PATH = re.compile(r"/[A-Za-z0-9]+\.(?:jpg|jpeg|png|webp)")


def _image(path):
    return path if isinstance(path, str) and IMAGE_PATH.fullmatch(path) else None


def _title(data, kind):
    return {
        "kind": kind, "id": data["id"],
        "title": data.get("title") or data.get("name") or data.get("original_title") or data.get("original_name") or "",
        "original_title": data.get("original_title") or data.get("original_name") or "",
        "date": data.get("release_date") or data.get("first_air_date") or "",
        "overview": data.get("overview") or "",
        "poster": _image(data.get("poster_path")),
        "backdrop": _image(data.get("backdrop_path")),
        "genres": [{"id": genre["id"], "name": genre["name"]} for genre in data.get("genres", [])],
    }


def _episode(data):
    return {"number": data["episode_number"], "tmdb_id": data.get("id"), "title": data.get("name") or "",
            "date": data.get("air_date") or "", "overview": data.get("overview") or "",
            "minutes": data.get("runtime"), "still": _image(data.get("still_path"))}


def _airing(data, key):
    if (episode := data.get(key)) and episode.get("air_date"):
        return {**_episode(episode), "season": episode["season_number"]}
    return None


def _series_fields(data):
    return {
        "seasons": [
            {"number": row["season_number"], "tmdb_id": row.get("id"), "name": row.get("name") or "",
             "count": row["episode_count"], "date": row.get("air_date") or "",
             "poster": _image(row.get("poster_path"))}
            for row in data["seasons"]
        ],
        "status": data.get("status") or "",
        "next_airing": _airing(data, "next_episode_to_air"),
        "last_airing": _airing(data, "last_episode_to_air"),
    }


def _cast(credits, limit=None):
    cast = credits.get("cast") if isinstance(credits, dict) else None
    result = []
    for person in cast or []:
        if not person.get("name"):
            continue
        role = person.get("character") or next(
            (entry["character"] for entry in person.get("roles") or [] if entry.get("character")), "",
        )
        result.append({"id": person.get("id"), "name": person["name"], "role": role,
                       "photo": _image(person.get("profile_path"))})
        if len(result) == limit:
            break
    return result


def _credits_key(kind):
    return "aggregate_credits" if kind == "tv" else "credits"


class Tmdb:
    def __init__(self, hass, token, language):
        self.session = async_get_clientsession(hass)
        self.token = token
        self.language = "de-DE" if language == "de" else "en-US"

    async def get(self, path, *, missing_ok=False, **params):
        if not self.token:
            raise watchlist_error("setup_required")
        try:
            async with self.session.get(
                f"{TMDB_API}/{path}", params={"language": self.language, **params},
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=ClientTimeout(total=15), allow_redirects=False,
            ) as response:
                if response.status in (401, 403):
                    raise watchlist_error("credentials")
                if response.status == 429:
                    raise watchlist_error("rate_limit")
                if response.status == 404 and missing_ok:
                    return {}
                if response.status != 200:
                    raise watchlist_error("remote")
                result = await response.json()
        except (ClientError, TimeoutError, ValueError) as error:
            raise watchlist_error("remote") from error
        if not isinstance(result, dict):
            raise watchlist_error("remote")
        return result

    async def search(self, kind, query, page):
        data = await self.get(f"search/{kind}", query=query, page=page, include_adult="false")
        return {"results": [_title(row, kind) for row in data["results"]],
                "more": page < min(data["total_pages"], 500)}

    async def title(self, kind, media_id, collection=None, *, full_cast=False, preview=False):
        path = f"{kind}/{media_id}"
        credits_key = _credits_key(kind)
        parts = [credits_key, "external_ids"]
        if kind == "tv":
            parts.append("episode_groups")
        data = await self.get(path, append_to_response=",".join(parts))
        if not data.get("overview") and self.language != "en-US":
            try:
                data["overview"] = (await self.get(path, language="en-US")).get("overview")
            except WatchlistError:
                pass  # A local title with an empty synopsis is still usable.
        title = _title(data, kind)
        title["imdb_id"] = (data.get("external_ids") or {}).get("imdb_id") or data.get("imdb_id")
        credits = data.get(credits_key) or {}
        cast = _cast(credits, None if full_cast else CAST_LIMIT)
        if full_cast and isinstance(credits.get("cast"), list):
            if kind == "tv":
                await self.add_season_cast(media_id, data.get("seasons") or [], cast)
                title["full_cast_revision"] = TV_FULL_CAST_REVISION
            title["full_cast"] = cast
        title["cast"] = cast[:CAST_LIMIT]
        title["metadata_language"] = self.language
        if preview:
            return title
        if kind == "tv":
            title.update(_series_fields(data))
            if isinstance(groups := (data.get("episode_groups") or {}).get("results"), list):
                title["order_groups_available"] = bool(groups)
        elif details := data.get("belongs_to_collection"):
            title["collection"] = collection or await self.collection(details["id"])
        return title

    async def add_season_cast(self, media_id, seasons, cast):
        """Keep the series order and append people only credited on a season."""
        people = {person["id"] or person["name"] for person in cast}
        paths = [f"season/{row['season_number']}/aggregate_credits" for row in seasons if row["season_number"] > 0]
        # TMDB accepts up to twenty appended endpoints per call.
        for start in range(0, len(paths), 20):
            batch = paths[start:start + 20]
            data = await self.get(f"tv/{media_id}", append_to_response=",".join(batch))
            for path in batch:
                credits = data.get(path)
                if not isinstance(credits, dict) or not isinstance(credits.get("cast"), list):
                    raise watchlist_error("remote")
                for person in _cast(credits):
                    key = person["id"] or person["name"]
                    if key not in people:
                        people.add(key)
                        cast.append(person)

    async def cast(self, kind, media_id, full):
        if kind == "tv" and full:
            title = await self.title(kind, media_id, full_cast=True, preview=True)
            if "full_cast" not in title:
                raise watchlist_error("remote")
            return title["full_cast"]
        credits = await self.get(f"{kind}/{media_id}/{_credits_key(kind)}")
        if not isinstance(credits.get("cast"), list):
            raise watchlist_error("remote")
        return _cast(credits, None if full else CAST_LIMIT)

    async def filmography(self, person_id):
        data = await self.get(f"person/{person_id}", append_to_response="combined_credits")
        credits = (data.get("combined_credits") or {}).get("cast")
        if not isinstance(credits, list) or not data.get("name"):
            raise watchlist_error("remote")
        titles = {}
        for row in credits:
            kind, media_id = row.get("media_type"), row.get("id")
            if kind not in {"tv", "movie"} or not media_id or row.get("adult"):
                continue
            key = (kind, media_id)
            if key not in titles:
                title = _title(row, kind)
                titles[key] = {field: title[field] for field in ("kind", "id", "title", "date", "poster")}
                titles[key]["roles"] = []
                if kind == "tv":
                    titles[key]["credit_ids"] = []
            role = row.get("character")
            if role and role not in titles[key]["roles"]:
                titles[key]["roles"].append(role)
            if kind == "tv" and (credit := row.get("credit_id")) and credit not in titles[key]["credit_ids"]:
                titles[key]["credit_ids"].append(credit)
        return {"id": person_id, "name": data["name"], "photo": _image(data.get("profile_path")),
                "birthday": data.get("birthday"), "deathday": data.get("deathday"),
                "titles": sorted(titles.values(), key=lambda title: title["date"], reverse=True)}

    async def streaming_regions(self):
        data = await self.get("watch/providers/regions")
        return [row["iso_3166_1"] for row in data["results"]]

    async def streaming_providers(self, region):
        lists = await asyncio.gather(self.get("watch/providers/movie", watch_region=region),
                                     self.get("watch/providers/tv", watch_region=region))
        providers = {row["provider_id"]: {"id": row["provider_id"], "name": row["provider_name"],
                                          "logo": _image(row.get("logo_path"))}
                     for catalog in lists for row in catalog["results"]}
        return sorted(providers.values(), key=lambda provider: provider["name"].casefold())

    async def availability(self, kind, media_id, region):
        data = await self.get(f"{kind}/{media_id}/watch/providers")
        return self.provider_entry(data, region)

    @staticmethod
    def provider_entry(data, region):
        entry = data["results"].get(region, {})
        link = urlsplit(entry.get("link") or "")
        groups = {key: [{"id": row.get("provider_id"), "name": row["provider_name"], "logo": _image(row.get("logo_path"))}
                        for row in entry.get(key, [])]
                  for key in ("flatrate", "free", "ads", "rent", "buy")}
        return {"groups": groups, "link": link.geturl() if link.scheme == "https"
                and link.netloc == "www.themoviedb.org" else None}

    async def appearances(self, media_id, person_id, credits):
        episodes = {}
        seasons = set()

        def add(row, role):
            key = row.get("season_number"), row.get("episode_number")
            if any(not isinstance(number, int) for number in key):
                return
            item = episodes.setdefault(key, {"season": key[0], "episode": key[1],
                                             "title": row.get("name") or "", "roles": []})
            if role and role not in item["roles"]:
                item["roles"].append(role)

        for credit in dict.fromkeys(credits):
            if not re.fullmatch(r"[a-f0-9]{24}", credit):
                continue
            detail = await self.get(f"credit/{credit}", missing_ok=True)
            media = detail.get("media") or {}
            if media.get("id") != media_id or (detail.get("person") or {}).get("id") != person_id:
                continue
            seasons.update(row["season_number"] for row in media.get("seasons") or []
                           if isinstance(row.get("season_number"), int) and row["season_number"] > 0)
            for episode in media.get("episodes") or []:
                add(episode, media.get("character"))

        series = await self.get(f"tv/{media_id}", append_to_response="aggregate_credits")
        cast = (series.get("aggregate_credits") or {}).get("cast") or []
        actor = next((person for person in cast if person.get("id") == person_id), {})
        count = actor.get("total_episode_count")
        total = series.get("number_of_episodes")
        regular_seasons = {row["season_number"] for row in series.get("seasons", [])
                           if row["season_number"] > 0 and row.get("episode_count")}
        all_regular = (isinstance(count, int) and count > 0 and count == total
                       and bool(regular_seasons) and regular_seasons.issubset(seasons))
        count_needs_episodes = isinstance(count, int) and len(episodes) < count
        if not all_regular and (count_needs_episodes or (not episodes and not seasons)):
            for row in series.get("seasons", []):
                try:
                    season = await self.get(f"tv/{media_id}/season/{row['season_number']}")
                except WatchlistError:
                    if not episodes and not seasons:
                        raise
                    break
                for episode in season.get("episodes", []):
                    for guest in episode.get("guest_stars") or []:
                        if guest.get("id") == person_id:
                            add(episode, guest.get("character"))
        credited_seasons = seasons | {number for number, _ in episodes if number > 0}
        return {"episodes": [episodes[key] for key in sorted(episodes)], "seasons": sorted(credited_seasons),
                "roles": [row["character"] for row in actor.get("roles") or [] if row.get("character")],
                "episode_count": count, "series_episode_count": total, "all_regular": all_regular}

    async def collection(self, collection_id):
        data = await self.get(f"collection/{collection_id}")
        return {"id": data["id"], "name": data["name"], "poster": _image(data.get("poster_path")),
                "overview": data.get("overview") or "", "backdrop": _image(data.get("backdrop_path")),
                "parts": sorted([_title(row, "movie") for row in data["parts"]],
                                key=lambda row: (row["date"] or "9999", row["id"]))}

    async def season(self, media_id, number):
        data = await self.get(f"tv/{media_id}/season/{number}")
        return [_episode(row) for row in data["episodes"]]

    async def sync_title(self, kind, media_id, region, start, end):
        """Bundle metadata, provider availability and recent TV change hints."""
        params = {"start_date": start, "end_date": end} if kind == "tv" else {}
        parts = ["external_ids"]
        if region:
            parts.append("watch/providers")
        if kind == "tv":
            parts.extend(("changes", "episode_groups"))
        path = f"{kind}/{media_id}"
        data = await self.get(path, append_to_response=",".join(parts), **params)
        title = _title(data, kind)
        title["imdb_id"] = (data.get("external_ids") or {}).get("imdb_id") or data.get("imdb_id")
        changes = []
        if kind == "tv":
            title.update(_series_fields(data))
            if isinstance(groups := (data.get("episode_groups") or {}).get("results"), list):
                title["order_groups_available"] = bool(groups)
            changes = (data.get("changes") or {}).get("changes")
            if not isinstance(changes, list):
                changes = (await self.get(f"{path}/changes", **params))["changes"]
        availability = self.provider_entry(data["watch/providers"], region) if region else None
        return title, availability, changes

    async def episode_orders(self, media_id):
        data = await self.get(f"tv/{media_id}/episode_groups")
        return [{"id": row["id"], "name": row["name"], "type": row.get("type")}
                for row in data["results"] if re.fullmatch(r"[a-fA-F0-9]{24}", row.get("id") or "")]

    async def episode_order(self, group_id):
        data = await self.get(f"tv/episode_group/{group_id}")
        return [
            {"name": group.get("name") or "", "episodes": [
                {**_episode(episode), "season": episode["season_number"]}
                for episode in sorted(group["episodes"], key=lambda row: row["order"])
            ]}
            for group in sorted(data["groups"], key=lambda row: row["order"]) if group["episodes"]
        ]

    async def imdb_id(self, kind, media_id, season=None, episode=None):
        path = f"{kind}/{media_id}"
        if episode is not None:
            path += f"/season/{season}/episode/{episode}"
        return (await self.get(f"{path}/external_ids", missing_ok=True)).get("imdb_id")
