"""Local Watchlist persistence and TMDB metadata."""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, date, datetime
from uuid import uuid4

from .localization import text

CAST_LIMIT = 12
TV_FULL_CAST_REVISION = 2
LABEL_TABLES = ("watchlist_custom_assignments", "watchlist_custom_labels", "watchlist_settings")
PREFERENCE_TABLES = (
    "watchlist_collection_custom_labels", "watchlist_collection_global_labels",
    "watchlist_collection_favorites", "watchlist_collections",
    "watchlist_personal_progress", "watchlist_progress_modes", "watchlist_preferences",
)
TABLES = ("watchlist_labels", "watchlist_progress", "watchlist_seasons", "watchlist_titles")


END_STATES = {"Ended", "Canceled"}
DEFAULT_SYNC = {"enabled": True, "time": "03:00", "active_days": 1, "catalog_days": 7}


def sync_settings(options):
    return {**DEFAULT_SYNC, **options.get("watchlist_sync", {})}


def active_series(title):
    return title["kind"] == "tv" and title.get("status") not in END_STATES


def sync_interval(settings, title):
    return settings["active_days" if active_series(title) else "catalog_days"]


def playback_settings(options):
    return {"script": "", "players": [], "local_sources": [], **(options.get("watchlist_playback") or {})}



def create_schema(connection):
    # Individual statements keep the version upgrade inside its transaction.
    connection.execute("""CREATE TABLE watchlist_titles (
        kind TEXT NOT NULL CHECK(kind IN ('movie', 'tv')),
        tmdb_id INTEGER NOT NULL CHECK(tmdb_id > 0),
        metadata TEXT NOT NULL,
        PRIMARY KEY(kind, tmdb_id)
    )""")
    connection.execute("""CREATE TABLE watchlist_seasons (
        kind TEXT NOT NULL DEFAULT 'tv' CHECK(kind = 'tv'),
        tmdb_id INTEGER NOT NULL,
        season INTEGER NOT NULL CHECK(season >= 0),
        episodes TEXT NOT NULL,
        PRIMARY KEY(kind, tmdb_id, season),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")
    connection.execute("""CREATE TABLE watchlist_progress (
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        PRIMARY KEY(kind, tmdb_id, season, episode),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")
    connection.execute("""CREATE TABLE watchlist_labels (
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY(kind, tmdb_id, label_id),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")


def create_label_schema(connection):
    connection.execute("""CREATE TABLE watchlist_custom_labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folded_name TEXT NOT NULL UNIQUE,
        icon TEXT,
        color TEXT
    )""")
    connection.execute("""CREATE TABLE watchlist_custom_assignments (
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        label_id TEXT NOT NULL REFERENCES watchlist_custom_labels(id) ON DELETE CASCADE,
        PRIMARY KEY(kind, tmdb_id, label_id),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")
    create_global_label_setting(connection)


def create_global_label_setting(connection):
    connection.execute("""CREATE TABLE watchlist_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        use_global_labels INTEGER NOT NULL CHECK(use_global_labels IN (0, 1))
    )""")


def _use_global_labels(connection):
    row = connection.execute("SELECT use_global_labels FROM watchlist_settings WHERE id = 1").fetchone()
    return bool(row and row["use_global_labels"])


def _available_labels(connection):
    labels = [dict(row) for row in connection.execute(
        "SELECT id, name, icon, color FROM watchlist_custom_labels"
    )]
    if _use_global_labels(connection):
        labels.extend(dict(row) for row in connection.execute(
            "SELECT id, name, icon, color FROM labels WHERE scope = 'global'"
        ))
    return sorted(labels, key=lambda label: label["name"].casefold())


class WatchlistError(Exception):
    """Translated error safe for dashboard users."""


def watchlist_error(key):
    error = WatchlistError(text(f"watchlist.{key}"))
    error.key = key
    return error


def create_favorites_schema(connection):
    connection.execute("""CREATE TABLE watchlist_favorites (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        PRIMARY KEY(user_id, kind, tmdb_id),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")


def create_preferences_schema(connection):
    connection.execute("""CREATE TABLE watchlist_preferences (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        default_mode TEXT NOT NULL CHECK(default_mode IN ('shared', 'personal')),
        allow_override INTEGER NOT NULL CHECK(allow_override IN (0, 1)),
        show_all_favorites INTEGER NOT NULL CHECK(show_all_favorites IN (0, 1))
    )""")
    connection.execute("""CREATE TABLE watchlist_progress_modes (
        kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('shared', 'personal')),
        PRIMARY KEY(kind, tmdb_id),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")
    connection.execute("""CREATE TABLE watchlist_personal_progress (
        user_id TEXT NOT NULL, kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL,
        season INTEGER NOT NULL, episode INTEGER NOT NULL,
        PRIMARY KEY(user_id, kind, tmdb_id, season, episode),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")
    connection.execute("""CREATE TABLE watchlist_collections (
        tmdb_id INTEGER PRIMARY KEY, metadata TEXT NOT NULL
    )""")
    connection.execute("""CREATE TABLE watchlist_collection_favorites (
        user_id TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL REFERENCES watchlist_collections(tmdb_id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, tmdb_id)
    )""")
    for table, reference in (("custom", "watchlist_custom_labels"), ("global", "labels")):
        connection.execute(f"""CREATE TABLE watchlist_collection_{table}_labels (
            tmdb_id INTEGER NOT NULL REFERENCES watchlist_collections(tmdb_id) ON DELETE CASCADE,
            label_id TEXT NOT NULL REFERENCES {reference}(id) ON DELETE CASCADE,
            PRIMARY KEY(tmdb_id, label_id)
        )""")


def add_watch_timestamps(connection):
    # Earlier imports preserve their progress without inventing a watch date.
    connection.execute("ALTER TABLE watchlist_progress ADD COLUMN watched_at TEXT")
    connection.execute("ALTER TABLE watchlist_personal_progress ADD COLUMN watched_at TEXT")


def create_continue_schema(connection):
    connection.execute("""CREATE TABLE watchlist_continue_positions (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'tv' CHECK(kind = 'tv'),
        tmdb_id INTEGER NOT NULL,
        season INTEGER,
        episode INTEGER,
        exact INTEGER NOT NULL CHECK(exact IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, tmdb_id),
        CHECK((season IS NULL AND episode IS NULL AND exact = 0)
            OR (season IS NOT NULL AND season >= 0 AND episode IS NOT NULL AND episode > 0)),
        FOREIGN KEY(kind, tmdb_id) REFERENCES watchlist_titles(kind, tmdb_id) ON DELETE CASCADE
    )""")


def _preferences(connection):
    row = connection.execute("SELECT * FROM watchlist_preferences WHERE id=1").fetchone()
    return {
        "default_mode": row["default_mode"] if row else "shared",
        "allow_override": not row or bool(row["allow_override"]),
        "show_all_favorites": not row or bool(row["show_all_favorites"]),
    }


def preferences(database):
    with database._connect() as connection:
        return _preferences(connection)


def set_preferences(database, default_mode, allow_override, show_all_favorites):
    with database._connect() as connection:
        connection.execute("""
            INSERT INTO watchlist_preferences VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET default_mode=excluded.default_mode,
              allow_override=excluded.allow_override, show_all_favorites=excluded.show_all_favorites
        """, (default_mode, allow_override, show_all_favorites))
        return _preferences(connection)


def set_progress_mode(database, kind, media_id, mode):
    with database._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        prefs = _preferences(connection)
        if not prefs["allow_override"]:
            raise watchlist_error("mode_locked")
        if mode == prefs["default_mode"]:
            connection.execute("DELETE FROM watchlist_progress_modes WHERE kind=? AND tmdb_id=?", (kind, media_id))
        else:
            connection.execute("""
                INSERT INTO watchlist_progress_modes(kind, tmdb_id, mode)
                SELECT kind, tmdb_id, ? FROM watchlist_titles WHERE kind=? AND tmdb_id=?
                ON CONFLICT(kind, tmdb_id) DO UPDATE SET mode=excluded.mode
            """, (mode, kind, media_id))


def _collection_row(connection, media_id, materialize=False):
    row = connection.execute("SELECT metadata FROM watchlist_collections WHERE tmdb_id=?", (media_id,)).fetchone()
    if row:
        return row["metadata"]
    row = connection.execute("""
        SELECT json_extract(metadata, '$.collection') AS metadata FROM watchlist_titles
        WHERE kind='movie' AND json_extract(metadata, '$.collection.id')=? LIMIT 1
    """, (media_id,)).fetchone()
    if not row:
        raise watchlist_error("missing_collection")
    if materialize:
        connection.execute("INSERT INTO watchlist_collections VALUES (?, ?)", (media_id, row["metadata"]))
    return row["metadata"]


def stored_collection(database, media_id):
    with database._connect() as connection:
        return json.loads(_collection_row(connection, media_id))


def set_favorite(database, user_id, kind, media_id, favorite):
    with database._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if kind == "collection":
            if favorite:
                _collection_row(connection, media_id, materialize=True)
                connection.execute(
                    "INSERT OR IGNORE INTO watchlist_collection_favorites VALUES (?, ?)", (user_id, media_id),
                )
            else:
                connection.execute("DELETE FROM watchlist_collection_favorites WHERE user_id=? AND tmdb_id=?",
                                   (user_id, media_id))
            query, args = "SELECT user_id FROM watchlist_collection_favorites WHERE tmdb_id=?", (media_id,)
        else:
            if favorite:
                cursor = connection.execute("""
                    INSERT OR IGNORE INTO watchlist_favorites(user_id, kind, tmdb_id)
                    SELECT ?, kind, tmdb_id FROM watchlist_titles WHERE kind=? AND tmdb_id=?
                """, (user_id, kind, media_id))
                if not cursor.rowcount and not connection.execute(
                    "SELECT 1 FROM watchlist_titles WHERE kind=? AND tmdb_id=?", (kind, media_id),
                ).fetchone():
                    raise watchlist_error("missing_title")
            else:
                connection.execute("DELETE FROM watchlist_favorites WHERE user_id=? AND kind=? AND tmdb_id=?",
                                   (user_id, kind, media_id))
            query, args = "SELECT user_id FROM watchlist_favorites WHERE kind=? AND tmdb_id=?", (kind, media_id)
        owners = {row["user_id"] for row in connection.execute(query, args)}
        share = _preferences(connection)["show_all_favorites"]
        update = {"kind": kind, "id": media_id, "favorite": user_id in owners, "any_favorite": share and bool(owners)}
        return update, share


def _collection_title(collection):
    return {
        "kind": "collection", "id": collection["id"], "title": collection["name"],
        "poster": collection.get("poster"), "backdrop": collection.get("backdrop"),
        "overview": collection.get("overview"), "collection": collection,
        "seen": [], "label_ids": [],
    }


def state(database, user_id=None):
    with database._connect() as connection:
        connection.execute("BEGIN")
        prefs = _preferences(connection)
        titles = {(row["kind"], row["tmdb_id"]): {
            **json.loads(row["metadata"]), "seen": [], "label_ids": [],
            **({"metadata_updated_at": row["updated_at"]} if row["updated_at"] else {}),
        } for row in connection.execute("""
            SELECT kind, tmdb_id, json_remove(metadata, '$.full_cast', '$.full_cast_revision',
                                             '$.season_cache_generation', '$.season_cache_fresh',
                                             '$.sync_stamp', '$.sync_region') AS metadata,
                   COALESCE(json_extract(metadata, '$.metadata_updated_at'),
                            json_extract(metadata, '$.sync_stamp')) AS updated_at
            FROM watchlist_titles
        """)}
        collections = {
            title["collection"]["id"]: {**_collection_title(title["collection"]), "in_library": True}
            for title in titles.values() if title.get("collection")
        }
        for row in connection.execute("""
            SELECT tmdb_id, metadata FROM watchlist_collections AS collection
            WHERE EXISTS (SELECT 1 FROM watchlist_collection_favorites WHERE tmdb_id=collection.tmdb_id)
               OR EXISTS (SELECT 1 FROM watchlist_collection_global_labels WHERE tmdb_id=collection.tmdb_id)
               OR EXISTS (SELECT 1 FROM watchlist_collection_custom_labels WHERE tmdb_id=collection.tmdb_id)
        """):
            collections.setdefault(row["tmdb_id"], {**_collection_title(json.loads(row["metadata"])), "in_library": False})
        overrides = {(row["kind"], row["tmdb_id"]): row["mode"] for row in connection.execute(
            "SELECT * FROM watchlist_progress_modes"
        )} if prefs["allow_override"] else {}
        modes = {key: overrides.get(key, prefs["default_mode"]) for key in titles}
        for key, title in titles.items():
            title["progress_mode"] = modes[key]
        latest = {}
        for row in connection.execute("""
            SELECT kind, tmdb_id, season, episode, watched_at, 'shared' AS mode FROM watchlist_progress
            UNION ALL SELECT kind, tmdb_id, season, episode, watched_at, 'personal' FROM watchlist_personal_progress
            WHERE user_id=? ORDER BY season, episode
        """, (user_id,)):
            key = (row["kind"], row["tmdb_id"])
            if modes[key] == row["mode"]:
                titles[key]["seen"].append([row["season"], row["episode"]])
                if row["kind"] == "tv":
                    latest[key] = _latest_viewing(latest.get(key), row)
        today = date.today().isoformat()
        positions = {(row["tmdb_id"], row["user_id"]): row for row in connection.execute(
            "SELECT * FROM watchlist_continue_positions WHERE user_id IN ('', ?)", (user_id,),
        )}
        for key, title in titles.items():
            if key[0] != "tv":
                continue
            position = positions.get((key[1], user_id if modes[key] == "personal" else ""))
            last_watched, last_points = latest.get(key) or ("", ())
            if episode := _resume_episode(connection, title, position, today, last_points):
                timestamp = max(last_watched, position["updated_at"] if position else "")
                title["continue_watching"] = {**episode, "watched_at": timestamp or None}
        all_items = {**titles, **{("collection", key): item for key, item in collections.items()}}
        for row in connection.execute("""
            SELECT kind, tmdb_id, label_id FROM watchlist_labels UNION ALL
            SELECT kind, tmdb_id, label_id FROM watchlist_custom_assignments UNION ALL
            SELECT 'collection', tmdb_id, label_id FROM watchlist_collection_global_labels UNION ALL
            SELECT 'collection', tmdb_id, label_id FROM watchlist_collection_custom_labels
        """):
            all_items[row["kind"], row["tmdb_id"]]["label_ids"].append(row["label_id"])
        labels = _available_labels(connection)
        if user_id is not None:
            for row in connection.execute("""
                SELECT kind, tmdb_id, user_id FROM watchlist_favorites WHERE user_id=? OR ?
                UNION ALL SELECT 'collection', tmdb_id, user_id FROM watchlist_collection_favorites WHERE user_id=? OR ?
            """, (user_id, prefs["show_all_favorites"], user_id, prefs["show_all_favorites"])):
                item = all_items[row["kind"], row["tmdb_id"]]
                if row["user_id"] == user_id:
                    item["favorite"] = True
                if prefs["show_all_favorites"]:
                    item["any_favorite"] = True
    visible_ids = {label["id"] for label in labels}
    for title in all_items.values():
        title["label_ids"] = [label for label in title["label_ids"] if label in visible_ids]
    visible_collections = [item for item in collections.values()
                           if item["in_library"] or item.get("favorite") or item.get("any_favorite")]
    return {"titles": list(titles.values()), "collections": visible_collections,
            "labels": labels, "preferences": prefs}


def _latest_viewing(latest, row):
    stamp = row["watched_at"]
    if not stamp:
        return latest
    point = (row["season"], row["episode"])
    if latest is None or stamp > latest[0]:
        return stamp, [point]
    if stamp == latest[0]:
        latest[1].append(point)
    return latest


def _resume_episode(connection, title, position, today, last_points=()):
    if position is None:
        return _next_episode(connection, title, today, last_points=last_points) if title["seen"] else None
    number, episode = position["season"], position["episode"]
    if number is None:
        return None  # Explicitly hidden until the next newly watched episode.
    season = next((row for row in title.get("seasons", []) if row["number"] == number), None)
    if position["exact"] and season and (season.get("date") or "") <= today:
        episodes = _read_season(connection, title["id"], number)
        if episodes is None and episode <= season["count"]:
            return {"season": number, "episode": episode}
        for row in episodes or []:
            if row["number"] == episode and (row.get("date") or "") <= today:
                return {"season": number, "episode": episode, "title": row.get("title") or "", "still": row.get("still")}
    return _next_episode(connection, title, today, (number, episode))


def _next_episode(connection, title, today, minimum=None, last_points=()):
    watched = {tuple(point) for point in title["seen"]}
    ordered = [episode for group in (title.get("episode_order") or {}).get("groups", [])
               for episode in group["episodes"]]
    order_points = [(item["season"], item["number"]) for item in ordered]
    if last_points:
        points = set(last_points)
        # A bulk mark gives all affected episodes one timestamp. Use the last
        # of those episodes in the selected order when they are all represented.
        minimum = max(last_points)
        if points.issubset(order_points):
            minimum = next(point for point in reversed(order_points) if point in points)
    if ordered and (minimum is None or minimum in order_points):
        start = order_points.index(minimum) if minimum else 0
        for point, item in zip(order_points[start:], ordered[start:]):
            if point not in watched and (item.get("date") or "") <= today:
                return {"season": point[0], "episode": point[1], "title": item["title"], "still": item["still"]}
        watched.update(order_points)
        if not last_points:
            minimum = None
    seasons = title.get("seasons", [])
    regular = seasons if minimum and minimum[0] == 0 else [season for season in seasons if season["number"] > 0] or seasons
    first_season, first_episode = minimum or (0, 1)
    for season in sorted(regular, key=lambda row: row["number"]):
        number = season["number"]
        if number < first_season or not season["count"] or (season.get("date") or "") > today:
            continue
        first = first_episode if number == first_season else 1
        episodes = _read_season(connection, title["id"], number) or []
        for episode in sorted(episodes, key=lambda item: item["number"]):
            if episode["number"] >= first and (number, episode["number"]) not in watched and (episode.get("date") or "") <= today:
                return {"season": number, "episode": episode["number"],
                        "title": episode.get("title") or "", "still": episode.get("still")}
        # A published season can be absent from the local cache (or can have
        # grown since it was cached). Resolve the exact episode when it opens.
        if len(episodes) < season["count"] and not any((item.get("date") or "") > today for item in episodes):
            known = {item["number"] for item in episodes}
            candidate = next((ep for ep in range(first, season["count"] + 1)
                              if ep not in known and (number, ep) not in watched), None)
            if candidate is not None:
                return {"season": number, "episode": candidate}
    return None


def stored_title(database, kind, media_id, missing_ok=False):
    with database._connect() as connection:
        row = connection.execute(
            "SELECT metadata FROM watchlist_titles WHERE kind = ? AND tmdb_id = ?", (kind, media_id),
        ).fetchone()
    if row is None:
        if missing_ok:
            return None
        raise watchlist_error("missing_title")
    return json.loads(row["metadata"])


def save_titles(database, titles, replace=False):
    with database._connect() as connection:
        sql = ("""UPDATE watchlist_titles SET metadata = json_set(CASE
                       WHEN json_type(?1, '$.full_cast') IS NULL AND json_type(metadata, '$.full_cast') = 'array'
                       THEN json_set(?1, '$.full_cast', json_extract(metadata, '$.full_cast'),
                                     '$.full_cast_revision', json_extract(metadata, '$.full_cast_revision')) ELSE ?1 END
                       , '$.added_at', json_extract(metadata, '$.added_at'),
                         '$.episode_order', json_extract(metadata, '$.episode_order'))
                   WHERE kind = ?2 AND tmdb_id = ?3""" if replace
               else "INSERT INTO watchlist_titles(metadata, kind, tmdb_id) VALUES (?, ?, ?) "
                    "ON CONFLICT(kind, tmdb_id) DO NOTHING")
        fetched_at = datetime.now(UTC).isoformat()
        records = []
        for title in titles:
            metadata = {**title, "metadata_updated_at": fetched_at}
            if not replace:
                metadata["added_at"] = fetched_at
            elif title["kind"] == "tv":
                metadata["season_cache_generation"] = str(uuid4())
            records.append((json.dumps(metadata), title["kind"], title["id"]))
        connection.executemany(sql, records)
        if replace and (collection := titles[0].get("collection")):
            connection.execute(
                """UPDATE watchlist_titles
                   SET metadata = json_set(metadata, '$.collection', json(?))
                   WHERE kind = 'movie' AND json_extract(metadata, '$.collection.id') = ?""",
                (json.dumps(collection), collection["id"]),
            )
            connection.execute("UPDATE watchlist_collections SET metadata=? WHERE tmdb_id=?",
                               (json.dumps(collection), collection["id"]))


def save_cast(database, kind, media_id, cast, summary, full):
    with database._connect() as connection:
        if full:
            connection.execute("""UPDATE watchlist_titles
                SET metadata = json_set(metadata, '$.cast', json(?), '$.full_cast', json(?), '$.full_cast_revision', ?)
                WHERE kind = ? AND tmdb_id = ?""",
                (json.dumps(summary), json.dumps(cast), TV_FULL_CAST_REVISION if kind == "tv" else None, kind, media_id))
        else:
            connection.execute("""UPDATE watchlist_titles SET metadata = json_set(metadata, '$.cast', json(?))
                WHERE kind = ? AND tmdb_id = ? AND json_type(metadata, '$.full_cast') IS NULL""",
                (json.dumps(summary), kind, media_id))


def remove_title(database, kind, media_id):
    with database._connect() as connection:
        connection.execute("DELETE FROM watchlist_titles WHERE kind = ? AND tmdb_id = ?", (kind, media_id))


def _read_season(connection, media_id, number):
    row = connection.execute(
        "SELECT episodes FROM watchlist_seasons WHERE tmdb_id = ? AND season = ?", (media_id, number),
    ).fetchone()
    return json.loads(row["episodes"]) if row else None


def stored_season(database, media_id, number):
    with database._connect() as connection:
        return _read_season(connection, media_id, number)


def save_season(database, media_id, number, episodes, generation=None):
    with database._connect() as connection:
        # Discard in-flight results that were requested before a title refresh.
        saved = connection.execute(
            """INSERT INTO watchlist_seasons(tmdb_id, season, episodes)
               SELECT tmdb_id, ?, ? FROM watchlist_titles WHERE kind = 'tv' AND tmdb_id = ?
                 AND json_extract(metadata, '$.season_cache_generation') IS ?
               ON CONFLICT(kind, tmdb_id, season) DO UPDATE SET episodes = excluded.episodes""",
            (number, json.dumps(episodes), media_id, generation),
        )
        if generation is not None and saved.rowcount:
            connection.execute("""
                UPDATE watchlist_titles
                SET metadata = json_set(metadata, '$.season_cache_fresh',
                    json_insert(COALESCE(json_extract(metadata, '$.season_cache_fresh'), '[]'), '$[#]', ?))
                WHERE kind = 'tv' AND tmdb_id = ?
                  AND NOT EXISTS (SELECT 1 FROM json_each(metadata, '$.season_cache_fresh') WHERE value = ?)
            """, (number, media_id, number))


def _active_mode(connection, kind, media_id, expected_mode):
    prefs = _preferences(connection)
    override = connection.execute("SELECT mode FROM watchlist_progress_modes WHERE kind=? AND tmdb_id=?",
                                  (kind, media_id)).fetchone()
    mode = override["mode"] if override and prefs["allow_override"] else prefs["default_mode"]
    if expected_mode and expected_mode != mode:
        raise watchlist_error("mode_changed")
    return mode


def set_continue(database, media_id, target, previous, user_id, expected_mode):
    with database._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        mode = _active_mode(connection, "tv", media_id, expected_mode)
        owner = user_id if mode == "personal" else ""
        row = connection.execute("SELECT metadata FROM watchlist_titles WHERE kind='tv' AND tmdb_id=?", (media_id,)).fetchone()
        if row is None:
            raise watchlist_error("missing_title")
        title = json.loads(row["metadata"])
        if owner:
            query = "SELECT season, episode, watched_at FROM watchlist_personal_progress WHERE kind='tv' AND tmdb_id=? AND user_id=?"
            args = (media_id, owner)
        else:
            query = "SELECT season, episode, watched_at FROM watchlist_progress WHERE kind='tv' AND tmdb_id=?"
            args = (media_id,)
        title["seen"] = []
        latest = None
        for watched in connection.execute(query, args):
            title["seen"].append((watched["season"], watched["episode"]))
            latest = _latest_viewing(latest, watched)
        position = connection.execute(
            "SELECT * FROM watchlist_continue_positions WHERE user_id=? AND tmdb_id=?", (owner, media_id),
        ).fetchone()
        current = _resume_episode(connection, title, position, date.today().isoformat(), latest[1] if latest else ())
        actual = [current["season"], current["episode"]] if current else None
        if previous != actual and (target is None or list(target) != actual):
            raise watchlist_error("continue_changed")
        number, episode = target or (None, None)
        connection.execute("""
            INSERT INTO watchlist_continue_positions(user_id, tmdb_id, season, episode, exact, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, tmdb_id) DO UPDATE SET season=excluded.season, episode=excluded.episode,
                exact=excluded.exact, updated_at=excluded.updated_at
        """, (owner, media_id, number, episode, target is not None, datetime.now(UTC).isoformat()))
    return mode


def set_seen(database, kind, media_id, seen, points, season=None, episode=None, user_id=None, expected_mode=None):
    with database._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        mode = _active_mode(connection, kind, media_id, expected_mode)
        personal = mode == "personal"
        table = "watchlist_personal_progress" if personal else "watchlist_progress"
        user = (user_id,) if personal else ()
        if seen:
            columns = "user_id, " if personal else ""
            value = "?, " if personal else ""
            watched_at = datetime.now(UTC).isoformat()
            saved = connection.executemany(
                f"""INSERT OR IGNORE INTO {table}({columns}kind, tmdb_id, season, episode, watched_at)
                    SELECT {value}kind, tmdb_id, ?, ?, ? FROM watchlist_titles WHERE kind=? AND tmdb_id=?""",
                [(*user, number, ep, watched_at, kind, media_id) for number, ep in points],
            )
            if kind == "tv" and saved.rowcount:
                owner = user_id if personal else ""
                number, last = max(points)
                position = connection.execute("""
                    SELECT season, episode, exact FROM watchlist_continue_positions
                    WHERE user_id=? AND tmdb_id=?
                """, (owner, media_id)).fetchone()
                if position and (position["season"] is None or position["exact"]):
                    anchor = (position["season"], position["episode"])
                    if anchor[0] is None or _at_or_after_position(connection, media_id, anchor, points):
                        connection.execute("""
                            UPDATE watchlist_continue_positions
                            SET season=COALESCE(season, ?), episode=COALESCE(episode, ?), exact=0, updated_at=?
                            WHERE user_id=? AND tmdb_id=?
                        """, (number, last, watched_at, owner, media_id))
        else:
            where = ["kind=?", "tmdb_id=?"]
            params = [kind, media_id]
            if personal:
                where.append("user_id=?")
                params.append(user_id)
            if season is not None:
                where.append("season=?")
                params.append(season)
            if episode is not None:
                where.append("episode=?")
                params.append(episode)
            connection.execute(f"DELETE FROM {table} WHERE {' AND '.join(where)}", params)
    return mode



def _at_or_after_position(connection, media_id, anchor, points):
    row = connection.execute("""
        SELECT json_extract(metadata, '$.episode_order')
        FROM watchlist_titles WHERE kind='tv' AND tmdb_id=?
    """, (media_id,)).fetchone()
    if row and row[0]:
        order = json.loads(row[0])
        ordered = [(episode["season"], episode["number"])
                   for group in order["groups"] for episode in group["episodes"]]
        if anchor in ordered:
            remaining = set(ordered[ordered.index(anchor):])
            return any(point in remaining for point in points)
    return max(points) >= anchor

def label_settings(database):
    with database._connect() as connection:
        connection.execute("BEGIN")
        custom = [dict(row, scope="watchlist") for row in connection.execute("""
            SELECT id, name, icon, color,
                ((SELECT COUNT(*) FROM watchlist_custom_assignments WHERE label_id = id) +
                 (SELECT COUNT(*) FROM watchlist_collection_custom_labels WHERE label_id = id)) AS title_count
            FROM watchlist_custom_labels ORDER BY name COLLATE NOCASE
        """)]
        use_global_labels = _use_global_labels(connection)
    return {"custom": custom, "use_global_labels": use_global_labels}


def save_custom_label(database, label_id, name, icon, color):
    try:
        with database._connect() as connection:
            values = (name, name.casefold(), icon, color)
            if label_id is None:
                connection.execute("""
                    INSERT INTO watchlist_custom_labels(id, name, folded_name, icon, color)
                    VALUES (?, ?, ?, ?, ?)
                """, (str(uuid4()), *values))
            elif not connection.execute("""
                UPDATE watchlist_custom_labels SET name=?, folded_name=?, icon=?, color=? WHERE id=?
            """, (*values, label_id)).rowcount:
                raise watchlist_error("label_missing")
    except sqlite3.IntegrityError as error:
        raise watchlist_error("label_duplicate") from error


def delete_custom_label(database, label_id):
    with database._connect() as connection:
        if not connection.execute("DELETE FROM watchlist_custom_labels WHERE id = ?", (label_id,)).rowcount:
            raise watchlist_error("label_missing")


def set_use_global_labels(database, enabled):
    with database._connect() as connection:
        connection.execute("""
            INSERT INTO watchlist_settings(id, use_global_labels) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET use_global_labels = excluded.use_global_labels
        """, (int(enabled),))


def update_labels(database, kind, media_id, added, removed):
    with database._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        available = {label["id"] for label in _available_labels(connection)}
        if set(added) - available:
            raise watchlist_error("label_missing")
        custom = {row["id"] for row in connection.execute("SELECT id FROM watchlist_custom_labels")}
        if kind == "collection":
            _collection_row(connection, media_id, materialize=True)
            tables = (("watchlist_collection_custom_labels", True), ("watchlist_collection_global_labels", False))
            columns = "tmdb_id, label_id"
            condition = "tmdb_id=?"
            identity = (media_id,)
        else:
            if not connection.execute(
                "SELECT 1 FROM watchlist_titles WHERE kind=? AND tmdb_id=?", (kind, media_id),
            ).fetchone():
                raise watchlist_error("missing_title")
            tables = (("watchlist_custom_assignments", True), ("watchlist_labels", False))
            columns = "kind, tmdb_id, label_id"
            condition = "kind=? AND tmdb_id=?"
            identity = (kind, media_id)
        placeholders = ", ".join("?" for _ in range(len(identity) + 1))
        for table, own in tables:
            connection.executemany(
                f"DELETE FROM {table} WHERE {condition} AND label_id=?",
                [(*identity, label_id) for label_id in set(removed) & available if (label_id in custom) == own],
            )
            connection.executemany(
                f"INSERT OR IGNORE INTO {table}({columns}) VALUES ({placeholders})",
                [(*identity, label_id) for label_id in set(added) if (label_id in custom) == own],
            )


def season_summary(title, number):
    for season in title.get("seasons", []):
        if season["number"] == number:
            return season
    raise watchlist_error("missing_season")


def released_points(episodes, number, requested=None):
    today = date.today().isoformat()
    return [(number, row["number"]) for row in episodes
            if (requested is None or row["number"] == requested)
            and (not row["date"] or row["date"] <= today)]


def sync_titles(database):
    """Read only the metadata used to plan background work."""
    with database._connect() as connection:
        return [json.loads(row[0]) for row in connection.execute("""
            SELECT json_remove(metadata, '$.full_cast', '$.cast', '$.collection', '$.episode_order')
            FROM watchlist_titles
        """)]


def apply_sync(database, previous, updates, seasons, stamp, region):
    """Update a title and affected seasons together, preserving edits made by users."""
    kind, media_id = previous["kind"], previous["id"]
    with database._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT metadata FROM watchlist_titles WHERE kind=? AND tmdb_id=?",
                                 (kind, media_id)).fetchone()
        if not row:
            return None
        title = json.loads(row["metadata"])
        if any(title.get(field) != previous.get(field)
               for field in ("added_at", "season_cache_generation", "sync_stamp", "metadata_updated_at")):
            return None
        changes = []
        if not updates.get("overview") and title.get("overview"):
            updates = {**updates, "overview": title["overview"]}
        for field in ("title", "overview", "poster", "backdrop", "genres", "date"):
            if title.get(field) != updates.get(field):
                changes.append({"key": "title_changed"})
                break
        old_seasons = {season["number"]: season for season in title.get("seasons", [])}
        for season in updates.get("seasons", []):
            number = season["number"]
            before = old_seasons.get(number, {}).get("count", 0)
            if season["count"] > before:
                changes.append({"key": "episodes_added", "season": number, "count": season["count"] - before})
        for number, episodes in seasons.items():
            before = {episode["number"]: episode for episode in _read_season(connection, media_id, number) or []}
            for episode in episodes:
                old = before.get(episode["number"])
                if old and old.get("overview") != episode["overview"]:
                    changes.append({"key": "overview_changed", "season": number, "episode": episode["number"]})
                elif old and any(old.get(key) != episode.get(key) for key in ("title", "date", "minutes", "still")):
                    changes.append({"key": "episode_changed", "season": number, "episode": episode["number"]})
            connection.execute("""INSERT INTO watchlist_seasons(tmdb_id, season, episodes) VALUES (?, ?, ?)
                                  ON CONFLICT(kind, tmdb_id, season) DO UPDATE SET episodes=excluded.episodes""",
                               (media_id, number, json.dumps(episodes)))
        if order := title.get("episode_order"):
            by_point = {(number, row["number"]): row for number, rows in seasons.items() for row in rows}
            for group in order["groups"]:
                group["episodes"] = [{**episode, **by_point.get((episode["season"], episode["number"]), {})}
                                     for episode in group["episodes"]]
        if seasons:
            # Invalidate older in-flight reads without invalidating unaffected, fresh seasons.
            prior = title.get("season_cache_generation")
            if prior is None:
                fresh = {row[0] for row in connection.execute(
                    "SELECT season FROM watchlist_seasons WHERE tmdb_id=?", (media_id,))}
            else:
                fresh = set(title.get("season_cache_fresh", [])) | seasons.keys()
            title.update(season_cache_generation=str(uuid4()), season_cache_fresh=sorted(fresh))
        title.update(updates, sync_stamp=stamp, sync_region=region, metadata_updated_at=datetime.now(UTC).isoformat())
        connection.execute("UPDATE watchlist_titles SET metadata=? WHERE kind=? AND tmdb_id=?",
                           (json.dumps(title), kind, media_id))
        return changes


def set_episode_order(database, media_id, order):
    with database._connect() as connection:
        if not connection.execute(
            """UPDATE watchlist_titles SET metadata=json_set(metadata, '$.episode_order', json(?))
               WHERE kind='tv' AND tmdb_id=?""", (json.dumps(order), media_id),
        ).rowcount:
            raise watchlist_error("missing_title")


def cached_seasons(database, media_id):
    with database._connect() as connection:
        return {row["season"]: json.loads(row["episodes"]) for row in connection.execute(
            "SELECT season, episodes FROM watchlist_seasons WHERE tmdb_id=?", (media_id,),
        )}
