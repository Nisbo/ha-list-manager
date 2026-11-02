"""Import previews use real SQLite and safety backups, with only HA I/O doubled."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import importlib
import sqlite3
import sys
from types import ModuleType, SimpleNamespace

import pytest
import yaml

from test_legacy_import import BASE_CARD, FAKE_SECRET, environment, source_item, table_counts


@pytest.fixture
def coordinator(environment, monkeypatch):
    package = environment.database_module.__name__.rsplit(".", 1)[0]
    for name in ("homeassistant", "homeassistant.helpers"):
        if name not in sys.modules:
            module = ModuleType(name)
            module.__path__ = []
            monkeypatch.setitem(sys.modules, name, module)
    exceptions = ModuleType("homeassistant.exceptions")
    exceptions.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
    monkeypatch.setitem(sys.modules, "homeassistant.exceptions", exceptions)
    registry_entries = {}
    registry = SimpleNamespace(async_get=registry_entries.get)
    er = ModuleType("homeassistant.helpers.entity_registry")
    er.async_get = lambda hass: registry
    monkeypatch.setitem(sys.modules, "homeassistant.helpers.entity_registry", er)
    for suffix in ("data_backup", "legacy_import_manager"):
        sys.modules.pop(package + "." + suffix, None)
    module = importlib.import_module(package + ".legacy_import_manager")
    backup = importlib.import_module(package + ".data_backup")
    responses = {"todo.groceries": {"items": [
        source_item("open", "Milk"), source_item("done", "Bread", status="completed"),
    ]}}
    calls = []

    async def async_call(domain, service, data, **kwargs):
        calls.append((domain, service, data, kwargs))
        entity = kwargs["target"]["entity_id"]
        return {entity: deepcopy(responses[entity])}

    hass = environment.hass
    runtime = SimpleNamespace(database=environment.db)
    hass.data = {module.DOMAIN: runtime}
    hass.config.path = lambda name: str(environment.db.path.parent / name)
    states = {"todo.groceries": SimpleNamespace(state="2", attributes={"friendly_name": "Groceries"})}
    hass.states = SimpleNamespace(get=states.get)
    hass.services = SimpleNamespace(async_call=async_call)
    manager = module.LegacyImportManager(hass, runtime)
    yield SimpleNamespace(**vars(environment), manager=manager, manager_module=module,
                          backup_module=backup, runtime=runtime, sources=responses,
                          states=states, registry=registry_entries, calls=calls)
    backups = hass.data.get(module.MANAGER_KEY)
    if backups:
        backups._directory.cleanup()


async def prepare(coordinator, *, owner="admin-a", document=BASE_CARD, include_items=True):
    draft = await coordinator.manager.analyze(owner, document)
    choices = [{"card_id": card["id"], "entity_id": card["source_entity"],
                "target_name": card["target_name"]} for card in draft["cards"]]
    preview = await coordinator.manager.preview(owner, draft["draft_id"], choices, include_items=include_items)
    return draft, preview


def test_preview_reads_both_statuses_without_mutating_source_or_database(coordinator):
    async def scenario():
        original = deepcopy(coordinator.sources)
        before = table_counts(coordinator.db)
        _, preview = await prepare(coordinator)
        assert preview["can_import"] is True
        assert {row["completed"] for row in preview["lists"][0]["items"]} == {False, True}
        assert coordinator.sources == original and table_counts(coordinator.db) == before
        assert coordinator.events == []
        assert coordinator.calls == [("todo", "get_items", {}, {
            "target": {"entity_id": "todo.groceries"},
            "blocking": True, "return_response": True,
        })]
        assert not list(coordinator.db.path.parent.glob("ha_list_manager_backups/*.db"))
    asyncio.run(scenario())


def test_apply_creates_one_preimport_snapshot_and_replays_without_extra_side_effects(coordinator):
    async def scenario():
        _, preview = await prepare(coordinator)
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        backups = coordinator.hass.data[coordinator.manager_module.MANAGER_KEY]
        files = await backups.listing()
        assert len(files) == 1 and files[0]["origin"] == "before_import"
        assert result["backup"]["id"] == files[0]["id"]
        with sqlite3.connect(backups._path(files[0]["id"])) as connection:
            assert connection.execute("SELECT count(*) FROM lists").fetchone()[0] == 0
        imported_id = result["lists"][0]["list_id"]
        config, = [yaml.safe_load(value) for value in result["cards_yaml"]]
        assert config["type"] == "custom:ha-list-manager-shopping-card"
        assert config["list_id"] == imported_id
        events_before = list(coordinator.events)
        reads_before = len(coordinator.calls)
        again = await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert again["lists"] == result["lists"] and again["replayed"] is True
        assert len(await backups.listing()) == 1
        # Replaying may recover HA entity registration after a cancelled response;
        # only the safe list-refresh event is repeated, no item automation.
        assert coordinator.events == events_before * 2
        assert len(coordinator.calls) == reads_before
        assert len(coordinator.db._list_lists()) == 1
    asyncio.run(scenario())


@pytest.mark.parametrize("field,value", [("summary", "Butter"), ("status", "completed"),
                                         ("description", "Changed"), ("due", "2026-11-07")])
def test_source_changes_require_a_fresh_preview_before_any_backup_or_write(coordinator, field, value):
    async def scenario():
        _, preview = await prepare(coordinator)
        coordinator.sources["todo.groceries"]["items"][0][field] = value
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert caught.value.code == "source_changed"
        assert not coordinator.db._list_lists() and coordinator.events == []
        assert not list(coordinator.db.path.parent.glob("ha_list_manager_backups/*.db"))
    asyncio.run(scenario())


def test_draft_and_preview_belong_to_one_admin_session(coordinator):
    async def scenario():
        draft, preview = await prepare(coordinator)
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await coordinator.manager.preview("admin-b", draft["draft_id"], [])
        assert caught.value.code == "preview_expired"
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await coordinator.manager.apply("admin-b", preview["plan_id"])
        assert caught.value.code == "preview_expired"
        assert not coordinator.db._list_lists()
    asyncio.run(scenario())


def test_old_preview_id_is_not_usable_after_manager_recreation(coordinator):
    async def scenario():
        _, preview = await prepare(coordinator)
        recreated = coordinator.manager_module.LegacyImportManager(coordinator.hass, coordinator.runtime)
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await recreated.apply("admin-a", preview["plan_id"])
        assert caught.value.code == "preview_expired"
        assert not coordinator.db._list_lists() and coordinator.events == []
    asyncio.run(scenario())


def test_target_name_created_after_preview_is_not_merged_or_overwritten(coordinator):
    async def scenario():
        _, preview = await prepare(coordinator)
        existing = coordinator.db._create_list("Groceries", "shopping", None, "local", None,
                                               "specific", True, True, True)
        before = table_counts(coordinator.db)
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert caught.value.code == "target_exists"
        assert table_counts(coordinator.db) == before
        assert coordinator.db._get_list(existing.id).name == "Groceries"
        assert not list(coordinator.db.path.parent.glob("ha_list_manager_backups/*.db"))
    asyncio.run(scenario())


@pytest.mark.parametrize("invalidate", ["time", "restart", "restore", "retired"])
def test_previews_expire_after_timeout_or_runtime_replacement(coordinator, monkeypatch, invalidate):
    async def scenario():
        _, preview = await prepare(coordinator)
        if invalidate == "time":
            now = coordinator.manager_module.monotonic()
            monkeypatch.setattr(coordinator.manager_module, "monotonic", lambda: now + 1201)
        elif invalidate == "restart":
            coordinator.hass.data[coordinator.manager_module.DOMAIN] = SimpleNamespace(database=coordinator.db)
        elif invalidate == "restore":
            coordinator.hass.data[f"{coordinator.manager_module.DOMAIN}_restore_in_progress"] = True
        else:
            coordinator.db._retired = True
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert caught.value.code == "preview_expired"
        assert coordinator.events == []
        with coordinator.db._connect() as connection:
            assert connection.execute("SELECT count(*) FROM lists").fetchone()[0] == 0
    asyncio.run(scenario())


def test_concurrent_double_submit_keeps_one_backup_and_one_import(coordinator):
    async def scenario():
        _, preview = await prepare(coordinator)
        results = await asyncio.gather(*(coordinator.manager.apply("admin-a", preview["plan_id"])
                                         for _ in range(2)))
        assert results[0]["lists"] == results[1]["lists"]
        assert sorted(row["replayed"] for row in results) == [False, True]
        backups = coordinator.hass.data[coordinator.manager_module.MANAGER_KEY]
        assert len(await backups.listing()) == len(coordinator.db._list_lists()) == 1
        assert coordinator.events == [
            (coordinator.manager_module.EVENT_LISTS_CHANGED, {"list_id": None})
        ] * 2
    asyncio.run(scenario())


def test_failed_backup_prevents_commit_and_retry_can_succeed(coordinator, monkeypatch):
    async def scenario():
        _, preview = await prepare(coordinator)
        backup = coordinator.backup_module.DataBackupManager(coordinator.hass)
        coordinator.hass.data[coordinator.manager_module.MANAGER_KEY] = backup
        create = backup.create_locked

        async def unavailable(**kwargs):
            raise OSError("simulated backup failure")

        monkeypatch.setattr(backup, "create_locked", unavailable)
        with pytest.raises(OSError):
            await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert not coordinator.db._list_lists() and coordinator.events == []
        monkeypatch.setattr(backup, "create_locked", create)
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert result["replayed"] is False and len(await backup.listing()) == 1
    asyncio.run(scenario())


def test_failed_import_retry_creates_a_fresh_snapshot_of_current_data(coordinator, monkeypatch):
    async def scenario():
        _, preview = await prepare(coordinator)
        commit = coordinator.db.async_import_legacy

        async def fail_commit(*args):
            raise sqlite3.DatabaseError("simulated import failure")

        monkeypatch.setattr(coordinator.db, "async_import_legacy", fail_commit)
        with pytest.raises(sqlite3.DatabaseError):
            await coordinator.manager.apply("admin-a", preview["plan_id"])
        backups = coordinator.hass.data[coordinator.manager_module.MANAGER_KEY]
        assert not coordinator.db._list_lists() and coordinator.events == []
        assert len(await backups.listing()) == 1
        # Other legitimate changes between attempts need a current safety copy.
        coordinator.db._create_list("Other list", "shopping", None, "local", None,
                                    "specific", True, True, True)
        monkeypatch.setattr(coordinator.db, "async_import_legacy", commit)
        await coordinator.manager.apply("admin-a", preview["plan_id"])
        records = await backups.listing()
        assert len(records) == 2
        snapshot_counts = []
        for record in records:
            with sqlite3.connect(backups._path(record["id"])) as connection:
                snapshot_counts.append(connection.execute("SELECT count(*) FROM lists").fetchone()[0])
        assert sorted(snapshot_counts) == [0, 1]
    asyncio.run(scenario())


@pytest.mark.parametrize("source", ["local", "unavailable", "malformed"])
def test_integration_owned_unavailable_or_invalid_sources_are_not_imported(coordinator, source):
    async def scenario():
        draft = await coordinator.manager.analyze("admin-a", BASE_CARD)
        if source == "local":
            coordinator.registry["todo.groceries"] = SimpleNamespace(platform="ha_list_manager")
        elif source == "unavailable":
            coordinator.states["todo.groceries"].state = "unavailable"
        else:
            coordinator.sources["todo.groceries"] = {"items": None}
        with pytest.raises(coordinator.module.LegacyImportError):
            await coordinator.manager.preview("admin-a", draft["draft_id"], [{
                "card_id": draft["cards"][0]["id"], "entity_id": "todo.groceries",
                "target_name": "Groceries",
            }])
        assert not coordinator.db._list_lists() and coordinator.events == []
    asyncio.run(scenario())


@pytest.mark.parametrize("source", [None, "todo.no_longer_installed", "todo.groceries"])
def test_configuration_only_import_never_fetches_source_items_and_keeps_backup_retry(coordinator, monkeypatch, source):
    async def forbidden_read(*args):
        raise AssertionError("Configuration-only import must not fetch a source list")

    async def scenario():
        document = BASE_CARD.replace("entity: todo.groceries\n", "" if source is None else f"entity: {source}\n")
        coordinator.states.clear()
        monkeypatch.setattr(coordinator.manager, "_read_sources", forbidden_read)
        _, preview = await prepare(coordinator, document=document, include_items=False)
        assert preview["include_items"] is False
        assert preview["lists"][0]["include_items"] is False
        assert preview["counts"]["items"] == 0
        assert coordinator.calls == [] and table_counts(coordinator.db)["lists"] == 0
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        list_id = result["lists"][0]["list_id"]
        assert coordinator.db._list_items(list_id) == []
        assert len(coordinator.db._list_categories(list_id)) == 2
        assert len(coordinator.db._list_chips(list_id)) == 3
        backups = coordinator.hass.data[coordinator.manager_module.MANAGER_KEY]
        records = await backups.listing()
        assert len(records) == 1 and records[0]["origin"] == "before_import"
        with sqlite3.connect(backups._path(records[0]["id"])) as connection:
            assert connection.execute("SELECT count(*) FROM lists").fetchone()[0] == 0
        again = await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert again["replayed"] is True and again["lists"] == result["lists"]
        assert len(await backups.listing()) == 1
        assert coordinator.calls == []
    asyncio.run(scenario())


def test_configuration_only_missing_sources_produce_correct_distinct_card_bindings(coordinator):
    async def scenario():
        document = """- type: custom:ha-shopping-list-improved
  title: Shopping template
  chips: Milk, Bread
- type: custom:ha-shopping-list-improved
  title: Task template
  mode: todo
  chips: Check batteries
"""
        _, preview = await prepare(coordinator, document=document, include_items=False)
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        configs = [yaml.safe_load(value) for value in result["cards_yaml"]]
        assert len(result["lists"]) == len(configs) == 2
        assert {config["list_id"] for config in configs} == {row["list_id"] for row in result["lists"]}
        assert len({config["list_id"] for config in configs}) == 2
        assert [(config["title"], config["type"]) for config in configs] == [
            ("Shopping template", "custom:ha-list-manager-shopping-card"),
            ("Task template", "custom:ha-list-manager-todo-card"),
        ]
        assert coordinator.calls == []
    asyncio.run(scenario())


@pytest.mark.parametrize("value", [None, 0, 1, "false", []])
def test_invalid_entry_import_option_fails_before_source_read(coordinator, value):
    async def scenario():
        draft = await coordinator.manager.analyze("admin-a", BASE_CARD)
        choices = [{"card_id": draft["cards"][0]["id"], "entity_id": "todo.groceries", "target_name": "Groceries"}]
        with pytest.raises(coordinator.module.LegacyImportError):
            await coordinator.manager.preview("admin-a", draft["draft_id"], choices, include_items=value)
        assert coordinator.calls == [] and not coordinator.db._list_lists()
    asyncio.run(scenario())


def test_credentials_never_reappear_in_preview_generated_card_or_receipt(coordinator):
    async def scenario():
        document = BASE_CARD + f"\nlonglived_token: {FAKE_SECRET}\n"
        draft, preview = await prepare(coordinator, document=document)
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert FAKE_SECRET not in repr((draft, preview, result))
        assert FAKE_SECRET not in repr(coordinator.manager.drafts)
        with coordinator.db._connect() as connection:
            assert FAKE_SECRET not in "\n".join(connection.iterdump())
    asyncio.run(scenario())
