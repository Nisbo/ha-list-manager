"""New HA reports, including identical helper writes, versus initial snapshots."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, UTC
import importlib.util
from pathlib import Path
import runpy
import sys
import tempfile
import types
from unittest.mock import patch

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"
_database_class = runpy.run_path(str(Path(__file__).with_name("test_entity_history.py")))["_database_class"]


def _time(minute):
    return datetime(2026, 11, 1, 10, minute, tzinfo=UTC)


@contextmanager
def _manager_environment():
    """Use production manager/SQLite with a small, filtered HA event-bus double."""
    database_class = _database_class()

    class State:
        def __init__(self, value, minute, attributes=None, entity_id="input_number.weight"):
            self.entity_id = entity_id
            self.state = value
            self.attributes = attributes if attributes is not None else {"unit_of_measurement": "kg"}
            self.last_changed = self.last_updated = self.last_reported = _time(minute)

    class Hass:
        def __init__(self):
            self.values = {}
            self.states = types.SimpleNamespace(get=self.values.get)
            self.listeners = {}
            self.reports = []
            self.report_subscriptions = 0
            self.bus = types.SimpleNamespace(async_listen=self.listen)

        def listen(self, event_type, action):
            self.listeners[event_type] = action
            return lambda: self.listeners.pop(event_type)

        def track_report(self, entity_ids, action):
            self.report_subscriptions += 1
            entry = (frozenset(entity_ids), action)
            self.reports.append(entry)
            return lambda: self.reports.remove(entry)

        def report(self, state, minute):
            state.last_reported = _time(minute)
            event = types.SimpleNamespace(data={"entity_id": state.entity_id, "new_state": state, "last_reported": _time(minute)})
            for entity_ids, action in self.reports:
                if state.entity_id in entity_ids:
                    action(event)

        def change(self, state, old_state):
            self.values[state.entity_id] = state
            self.listeners["state_changed"](types.SimpleNamespace(data={"entity_id": state.entity_id, "new_state": state, "old_state": old_state}))

        def async_create_task(self, coroutine, name):
            return asyncio.create_task(coroutine, name=name)

        async def async_add_executor_job(self, target, *args):
            return target(*args)

    modules = {name: types.ModuleType(name) for name in (
        "homeassistant", "homeassistant.const", "homeassistant.core",
        "homeassistant.helpers", "homeassistant.helpers.entity_registry",
        "homeassistant.helpers.event",
    )}
    modules["homeassistant.const"].EVENT_STATE_CHANGED = "state_changed"
    core = modules["homeassistant.core"]
    core.Event, core.HomeAssistant, core.State = types.SimpleNamespace, Hass, State
    core.callback = lambda function: function
    registry = modules["homeassistant.helpers.entity_registry"]
    registry.EVENT_ENTITY_REGISTRY_UPDATED = "entity_registry_updated"
    registry.async_get = lambda hass: types.SimpleNamespace(entities={}, async_get=lambda entity_id: None)
    modules["homeassistant.helpers.event"].async_track_state_report_event = lambda hass, entity_ids, action: hass.track_report(entity_ids, action)
    with patch.dict(sys.modules, modules):
        name = "ha_list_manager_history_test.entity_history"
        spec = importlib.util.spec_from_file_location(name, INTEGRATION / "entity_history.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        yield database_class, module.EntityHistoryManager, Hass, State


async def _drain(manager):
    if manager._tasks:
        await asyncio.gather(*tuple(manager._tasks))


def test_identical_reports_keep_the_event_time_and_survive_restarts():
    async def scenario():
        with _manager_environment() as (Database, Manager, Hass, State), tempfile.TemporaryDirectory() as directory:
            hass = Hass()
            db = Database(hass, Path(directory) / "history.db")
            db._initialize()
            db._set_entity_tracking("input_number.weight", True)
            state = State("85.0", 0)
            hass.values[state.entity_id] = state
            manager = Manager(hass, db)
            await manager.async_start()
            assert len(hass.reports) == 1
            assert hass.reports[0][0] == frozenset({state.entity_id})
            # HA reuses the SAME State object for unchanged writes. Queue both
            # before executing either database coroutine to expose timestamp races.
            hass.report(state, 1)
            hass.report(state, 2)
            state.last_reported = _time(9)
            await _drain(manager)
            rows = db._get_entity_history(state.entity_id, None, None, 100, False, None, None, None)[0]
            assert [row.state for row in rows] == ["85.0"] * 3
            assert [row.last_updated for row in rows] == [_time(i).isoformat() for i in (0, 1, 2)]
            assert rows[1].last_changed == _time(0).isoformat()
            assert rows[1].last_reported == _time(1).isoformat()
            hass.report(state, 1)  # Replayed older event, even after a newer one.
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 3
            changed = State("86.0", 3)
            hass.change(changed, state)
            forced = State("86.0", 4)
            hass.change(forced, changed)  # force_update uses state_changed instead.
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 5
            await manager.async_stop()
            assert not hass.reports and not hass.listeners

            # Recreate both database and manager as on integration/HA restart.
            db = Database(hass, db.path)
            restored = State("86.0", 5)
            hass.values[state.entity_id] = restored
            manager = Manager(hass, db)
            await manager.async_start()
            hass.change(restored, None)
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 5
            hass.report(restored, 6)  # Next real write of the restored value counts.
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 6
            await manager.async_stop()
    asyncio.run(scenario())


def test_tracking_refresh_filters_reports_and_ignores_restore_placeholders():
    async def scenario():
        with _manager_environment() as (Database, Manager, Hass, State), tempfile.TemporaryDirectory() as directory:
            hass = Hass()
            db = Database(hass, Path(directory) / "history.db")
            db._initialize()
            db._set_entity_tracking("input_number.weight", True)
            placeholder = State("unavailable", 0, {"restored": True})
            hass.values[placeholder.entity_id] = placeholder
            manager = Manager(hass, db)
            await manager.async_start()
            hass.report(placeholder, 1)
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 0
            first = State("85.0", 2)
            hass.change(first, placeholder)
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 1
            await manager.async_refresh()
            assert hass.report_subscriptions == 1, "Unchanged tracking must not duplicate subscriptions"
            await manager.async_set_tracking(first.entity_id, False)
            assert not hass.reports
            hass.report(first, 3)
            hass.change(State("86.0", 4), first)
            await _drain(manager)
            assert db._list_tracked_entities()[0].sample_count == 1
            await manager.async_set_tracking("light.example", True)
            assert hass.reports[0][0] == frozenset({"light.example"})
            light = State("on", 5, {"brightness": 100}, "light.example")
            hass.change(light, None)
            hass.report(light, 6)
            await _drain(manager)
            assert len(db._get_entity_history(light.entity_id, None, None, 100, False, None, None, None)[0]) == 2
            await manager.async_stop()
            assert not hass.reports
    asyncio.run(scenario())


def test_recorder_keeps_distinct_identical_samples_and_import_is_idempotent():
    Database = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = Database(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        samples = [{"state": "85", "attributes": {}, "last_updated": _time(i).isoformat(), "last_changed": _time(0).isoformat()} for i in (0, 1, 2)]
        assert db._import_entity_states("sensor.weight", samples, "recorder")["imported"] == 3
        assert db._import_entity_states("sensor.weight", samples, "recorder")["already_stored"] == 3
        assert not db._record_entity_state("sensor.weight", "85", {}, _time(0).isoformat(), _time(3).isoformat(), None, initial=True)
        assert db._record_entity_state("sensor.weight", "85", {}, _time(0).isoformat(), _time(4).isoformat(), _time(4).isoformat())
        assert db._list_tracked_entities()[0].sample_count == 4


def test_todo_tracking_records_entity_counts_without_creating_list_items():
    async def scenario():
        with _manager_environment() as (Database, Manager, Hass, State), tempfile.TemporaryDirectory() as directory:
            hass = Hass(); db = Database(hass, Path(directory) / 'history.db')
            db._initialize(); db._set_entity_tracking('todo.example', True)
            first = State('5', 0, {'friendly_name':'Testaufgaben'}, 'todo.example')
            hass.values[first.entity_id] = first
            manager = Manager(hass, db); await manager.async_start()
            hass.change(State('4', 1, first.attributes, first.entity_id), first)
            await _drain(manager)
            rows = db._get_entity_history('todo.example', None, None, 100, False, None, None, None)[0]
            assert [row.state for row in rows] == ['5', '4']
            with db._connect() as connection:
                assert connection.execute('SELECT COUNT(*) FROM products').fetchone()[0] == 0
                assert connection.execute('SELECT COUNT(*) FROM list_items').fetchone()[0] == 0
            await manager.async_stop()
    asyncio.run(scenario())
