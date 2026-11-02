"""Administrator-owned previews for a read-only legacy source and atomic import."""

from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
import re
import secrets
from functools import partial
from time import monotonic

import yaml

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN, EVENT_LISTS_CHANGED
from .data_backup import MANAGER_KEY, DataBackupManager, atomic_executor
from .legacy_import import LegacyImportError, build_import_plan, parse_legacy_configs
from .legacy_import_warnings import classify_import_warning
from .localization import text

PREVIEW_LIFETIME = 20 * 60
MAX_PREVIEWS = 4


class LegacyImportManager:
    """Keep sanitized previews in RAM, tied to one user and integration runtime."""

    def __init__(self, hass, runtime):
        self.hass = hass
        self.runtime = runtime
        self.drafts = {}
        self.plans = {}
        self._apply_lock = asyncio.Lock()

    def _check_runtime(self):
        if (self.hass.data.get(DOMAIN) is not self.runtime
                or self.hass.data.get(f"{DOMAIN}_restore_in_progress")
                or self.runtime.database._retired):
            raise LegacyImportError("preview_expired")

    def _prune(self, cache):
        now = monotonic()
        for key, value in list(cache.items()):
            if value["expires"] <= now and not value.get("running"):
                del cache[key]

    def _remember(self, cache, user_id, payload):
        self._prune(cache)
        # Bound memory even when several administrator sessions prepare imports.
        while len(cache) >= MAX_PREVIEWS:
            key = next((key for key, value in cache.items() if not value.get("running")), None)
            if key is None:
                raise LegacyImportError("import_busy")
            del cache[key]
        key = secrets.token_hex(16)
        cache[key] = {"owner": user_id, "expires": monotonic() + PREVIEW_LIFETIME, **payload}
        return key

    def _get(self, cache, key, user_id):
        self._check_runtime()
        self._prune(cache)
        value = cache.get(key) if isinstance(key, str) else None
        if value is None or value["owner"] != user_id:
            raise LegacyImportError("preview_expired")
        return value

    @staticmethod
    def _warnings(warnings, cards=(), lists=(), selections=()):
        choices = {row["card_id"]: row.get("list_type") for row in selections}
        contexts = {}
        for index, card in enumerate(cards, 1):
            context = {
                "source_name": card.get("title") or card.get("target_name") or text("import.card_name", number=index),
                "list_type": choices.get(card["id"]) or card["mode"],
            }
            contexts[card["id"]] = context
            if card.get("source_entity"):
                contexts.setdefault(card["source_entity"], context)
        for row in lists:
            if row.get("source_entity"):
                contexts[row["source_entity"]] = {"source_name": row["name"], "list_type": row["list_type"]}
        result = []
        for warning in warnings:
            source = warning.get("source") or ""
            context = contexts.get(source)
            if context is None:
                match = re.fullmatch(r"card-(\d+)", source)
                context = {"source_name": text("import.card_name", number=int(match[1])) if match else text("import.import_name"), "list_type": None}
            reason = classify_import_warning({**warning, "list_type": context["list_type"]})
            result.append({**warning, **reason, "source_name": context["source_name"], "message": text(
                reason["message_key"], source=context["source_name"], field=warning.get("field", ""),
                count=warning.get("count", 0),
            )})
        return result

    async def analyze(self, user_id, yaml_text, files=None):
        self._check_runtime()
        parsed = await atomic_executor(self.hass, parse_legacy_configs, yaml_text, files)
        existing = {record.name.casefold() for record in await self.runtime.database.async_list_lists()}
        names = {}
        for card in parsed["cards"]:
            entity = card["source_entity"]
            state = self.hass.states.get(entity) if entity else None
            name = card["title"] or (state.attributes.get("friendly_name") if state else None) or card["target_name"] or text("import.list_name")
            if entity in names:
                card["target_name"] = names[entity]
                continue
            candidate = str(name)[:200]
            if candidate.casefold() in existing:
                base = text("import.target_name", name=candidate[:175])
                candidate, index = base, 2
                while candidate.casefold() in existing:
                    candidate, index = f"{base} {index}", index + 1
            card["target_name"] = candidate
            existing.add(candidate.casefold())
            if entity:
                names[entity] = candidate
        draft_id = self._remember(self.drafts, user_id, {"parsed": parsed})
        cards = [{key: card[key] for key in (
            "id", "source_entity", "mode", "title", "target_name", "icon",
        )} for card in parsed["cards"]]
        return {"draft_id": draft_id, "cards": cards, "warnings": self._warnings(parsed["warnings"], parsed["cards"])}

    @staticmethod
    def _selections(parsed, sources, include_items=True):
        if not isinstance(sources, list) or len(sources) != len(parsed["cards"]):
            raise LegacyImportError("source_required")
        selected = {}
        for row in sources:
            if (not isinstance(row, dict) or not isinstance(row.get("card_id"), str)
                    or row["card_id"] in selected):
                raise LegacyImportError("invalid_config")
            selected[row["card_id"]] = row
        if set(selected) != {card["id"] for card in parsed["cards"]}:
            raise LegacyImportError("invalid_config")
        result = []
        for card in parsed["cards"]:
            row = selected[card["id"]]
            entity = row.get("entity_id") if include_items else card["source_entity"]
            name = row.get("target_name")
            list_type = row.get("list_type", card["mode"])
            if not isinstance(list_type, str) or not (
                list_type == card["mode"] or (card["mode"] == "shopping" and list_type == "inventory")
            ):
                raise LegacyImportError("invalid_import_type")
            if include_items:
                if not isinstance(entity, str) or not re.fullmatch(r"todo\.[a-z0-9_]+", entity):
                    raise LegacyImportError("source_invalid")
                if entity in parsed.get("excluded_sources", []):
                    raise LegacyImportError("unsupported_source")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
                raise LegacyImportError("invalid_target")
            result.append({"card_id": card["id"], "entity_id": entity, "target_name": name.strip(), "list_type": list_type})
        return result

    async def _read_sources(self, sources):
        items = {}
        registry = er.async_get(self.hass)
        for entity_id in dict.fromkeys(row["entity_id"] for row in sources):
            state = self.hass.states.get(entity_id)
            registered = registry.async_get(entity_id)
            if registered and registered.platform == DOMAIN:
                raise LegacyImportError("unsupported_source")
            if state is None or state.state in {"unavailable", "unknown"}:
                raise LegacyImportError("source_unavailable")
            try:
                # No status filter returns completed and open entries together.
                response = await self.hass.services.async_call(
                    "todo", "get_items", {}, target={"entity_id": entity_id},
                    blocking=True, return_response=True,
                )
            except HomeAssistantError:
                raise LegacyImportError("source_unavailable") from None
            payload = response.get(entity_id) if isinstance(response, dict) else None
            if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
                raise LegacyImportError("source_unavailable")
            items[entity_id] = payload["items"]
        return items

    @staticmethod
    def _source_fingerprint(items):
        # Keep response ordering: it carries manual order when no legacy index exists.
        values = {entity: [{field: row.get(field) for field in (
            "uid", "summary", "status", "description", "due",
        )} for row in rows] for entity, rows in items.items()}
        return hashlib.sha256(json.dumps(values, sort_keys=True, default=str).encode()).hexdigest()

    async def _check_names(self, plan):
        existing = {record.name.casefold() for record in await self.runtime.database.async_list_lists()}
        if any(row["name"].casefold() in existing for row in plan["lists"]):
            raise LegacyImportError("target_exists")

    async def preview(self, user_id, draft_id, sources, include_items=True):
        if not isinstance(include_items, bool):
            raise LegacyImportError("invalid_config")
        draft = self._get(self.drafts, draft_id, user_id)
        choices = self._selections(draft["parsed"], sources, include_items)
        items = await self._read_sources(choices) if include_items else {}
        plan = await atomic_executor(self.hass, partial(build_import_plan, include_items=include_items), draft["parsed"], items, choices)
        await self._check_names(plan)
        self._get(self.drafts, draft_id, user_id)
        plan_id = self._remember(self.plans, user_id, {
            "plan": plan, "sources": choices, "include_items": include_items,
            "source_fingerprint": self._source_fingerprint(items), "backup": None,
        })
        lists = [{**{key: row[key] for key in (
            "source_entity", "name", "list_type", "icon", "counts", "include_items",
        )}, "categories": deepcopy(row["categories"]), "chips": deepcopy(row["chips"][:20]),
            "items": deepcopy(row["items"][:20])} for row in plan["lists"]]
        return {"plan_id": plan_id, "lists": lists, "counts": plan["counts"],
                "warnings": self._warnings(plan["warnings"], draft["parsed"]["cards"], plan["lists"], choices), "can_import": bool(lists), "include_items": include_items}

    def _cards_yaml(self, plan, result):
        registry = er.async_get(self.hass)
        configs = []
        for row, record in zip(plan["lists"], result["lists"], strict=True):
            unique_id = f"{'inventory' if row['list_type'] == 'inventory' else 'list'}_{record['list_id']}"
            entity_id = registry.async_get_entity_id("sensor", DOMAIN, unique_id)
            if entity_id is None:
                # Reserve the actual HA ID before the asynchronous sensor setup.
                # HA handles name collisions, and the sensor reuses this unique ID.
                entity_id = registry.async_get_or_create(
                    "sensor", DOMAIN, unique_id,
                    config_entry=self.runtime.config_entry,
                    suggested_object_id=record["name"], original_name=record["name"],
                    has_entity_name=False,
                ).entity_id
            for view in row["cards"]:
                config = {
                    "type": f"custom:ha-list-manager-{row['list_type']}-card",
                    "entity": entity_id,
                    **view["options"],
                }
                if view["title"]:
                    config["title"] = view["title"]
                if view["title_icon"]:
                    config["title_icon"] = view["title_icon"]
                configs.append(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
        return configs

    async def apply(self, user_id, plan_id):
        self._get(self.plans, plan_id, user_id)
        async with self._apply_lock:
            job = self._get(self.plans, plan_id, user_id)
            job["running"] = True
            try:
                backups = self.hass.data.get(MANAGER_KEY)
                if backups is None:
                    backups = self.hass.data[MANAGER_KEY] = DataBackupManager(self.hass)
                # Restore must not replace the runtime between snapshot and commit.
                async with backups.operation_lock:
                    self._check_runtime()
                    database = self.runtime.database
                    result = await database.async_get_legacy_import_result(plan_id)
                    if result is None:
                        items = await self._read_sources(job["sources"]) if job["include_items"] else {}
                        if self._source_fingerprint(items) != job["source_fingerprint"]:
                            raise LegacyImportError("source_changed")
                        await self._check_names(job["plan"])
                        job["backup"] = await backups.create_locked(
                            origin="before_import", name=text("import.backup_name"),
                        )
                        result = await database.async_import_legacy(job["plan"], plan_id)
                    else:
                        result = {**result, "replayed": True}
                    cards_yaml = self._cards_yaml(job["plan"], result)
                    # A retried committed operation may still need entity registration.
                    self.hass.bus.async_fire(EVENT_LISTS_CHANGED, {"list_id": None})
                return {**result, "cards_yaml": cards_yaml, "backup": job["backup"], "include_items": job["include_items"]}
            finally:
                job["running"] = False
