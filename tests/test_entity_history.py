"""Focused regression tests for the independent entity history."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types


INTEGRATION = (
    Path(__file__).parents[1]
    / "custom_components"
    / "ha_list_manager"
)


def _database_class():
    """Load the database module without requiring a Home Assistant install."""
    package_name = "ha_list_manager_history_test"
    package = types.ModuleType(package_name)
    package.__path__ = [str(INTEGRATION)]
    sys.modules[package_name] = package
    for module_name in ("const", "models", "database"):
        qualified_name = f"{package_name}.{module_name}"
        specification = importlib.util.spec_from_file_location(
            qualified_name, INTEGRATION / f"{module_name}.py"
        )
        module = importlib.util.module_from_spec(specification)
        sys.modules[qualified_name] = module
        assert specification.loader is not None
        specification.loader.exec_module(module)
    return sys.modules[f"{package_name}.database"].HaListManagerDatabase


def test_numeric_bounds_are_applied_before_latest_limit() -> None:
    database_class = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        database = database_class(
            types.SimpleNamespace(), Path(directory) / "history.db"
        )
        database._initialize()
        database._set_entity_tracking("sensor.weight", True)
        values = [0, 49.9, 50, 75, 100, 150, 150.1, 125]
        with database._connect() as connection:
            for index, value in enumerate(values):
                timestamp = f"2026-10-11T12:{index:02d}:00+00:00"
                connection.execute(
                    """
                    INSERT INTO entity_states(
                        entity_id, state, attributes_json, last_changed,
                        last_updated, last_reported, recorded_at, source
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "sensor.weight", str(value), "{}", timestamp,
                        timestamp, timestamp, timestamp, "test",
                    ),
                )

        records, truncated = database._get_entity_history(
            "sensor.weight", None, None, 3, True, None, 50, 150
        )

        assert [float(record.state) for record in records] == [100, 150, 125]
        assert truncated is True


def test_numeric_bounds_are_optional_and_inclusive() -> None:
    database_class = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        database = database_class(
            types.SimpleNamespace(), Path(directory) / "history.db"
        )
        database._initialize()
        database._set_entity_tracking("sensor.weight", True)
        values = [49.9, 50, 150, 150.1]
        with database._connect() as connection:
            for index, value in enumerate(values):
                timestamp = f"2026-10-11T12:{index:02d}:00+00:00"
                connection.execute(
                    """
                    INSERT INTO entity_states(
                        entity_id, state, attributes_json, last_changed,
                        last_updated, last_reported, recorded_at, source
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "sensor.weight", str(value), "{}", timestamp,
                        timestamp, timestamp, timestamp, "test",
                    ),
                )

        records, truncated = database._get_entity_history(
            "sensor.weight", None, None, 20, True, None, 50, None
        )

        assert [float(record.state) for record in records] == [50, 150, 150.1]
        assert truncated is False


def test_entity_rename_preserves_tracking_and_every_sample() -> None:
    database_class = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        database = database_class(
            types.SimpleNamespace(), Path(directory) / "history.db"
        )
        database._initialize()
        database._set_entity_tracking(
            "sensor.old_weight", True, "registry-entry-123"
        )
        with database._connect() as connection:
            for index, source in enumerate(("live", "manual", "recorder")):
                timestamp = f"2026-10-11T12:0{index}:00+00:00"
                connection.execute(
                    """
                    INSERT INTO entity_states(
                        entity_id, state, attributes_json, last_changed,
                        last_updated, last_reported, recorded_at, source
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "sensor.old_weight", str(90 + index), "{}", timestamp,
                        timestamp, timestamp, timestamp, source,
                    ),
                )

        renamed = database._rename_tracked_entity(
            "sensor.old_weight", "sensor.new_weight", "registry-entry-123"
        )

        assert renamed is True
        tracked = database._list_tracked_entities()
        assert len(tracked) == 1
        assert tracked[0].entity_id == "sensor.new_weight"
        assert tracked[0].registry_entry_id == "registry-entry-123"
        assert tracked[0].sample_count == 3
        with database._connect() as connection:
            rows = connection.execute(
                "SELECT entity_id, source FROM entity_states ORDER BY id"
            ).fetchall()
        assert [(row["entity_id"], row["source"]) for row in rows] == [
            ("sensor.new_weight", "live"),
            ("sensor.new_weight", "manual"),
            ("sensor.new_weight", "recorder"),
        ]


def test_entity_rename_never_merges_two_existing_archives() -> None:
    database_class = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        database = database_class(
            types.SimpleNamespace(), Path(directory) / "history.db"
        )
        database._initialize()
        database._set_entity_tracking("sensor.old", True, "registry-old")
        database._set_entity_tracking("sensor.target", True, "registry-target")

        try:
            database._rename_tracked_entity(
                "sensor.old", "sensor.target", "registry-old"
            )
        except Exception as error:
            assert error.__class__.__name__ == "EntityHistoryRenameConflictError"
        else:
            raise AssertionError("Conflicting entity histories must not be merged")

        assert {item.entity_id for item in database._list_tracked_entities()} == {
            "sensor.old",
            "sensor.target",
        }


def test_old_import_does_not_duplicate_the_unchanged_live_state() -> None:
    database_class = _database_class()
    for source in ("recorder", "long_term_statistics"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.db"
            database = database_class(types.SimpleNamespace(), path)
            database._initialize()
            database._set_entity_tracking("sensor.weight", True)
            current = "2026-11-01T10:00:00+00:00"
            old = "2026-10-01T10:00:00+00:00"
            attributes = {"unit_of_measurement": "kg"}
            assert database._record_entity_state(
                "sensor.weight", "20", attributes, current, current, current
            )
            snapshot = {"state": "10", "attributes": attributes,
                        "last_changed": old, "last_updated": old}
            result = database._import_entity_states("sensor.weight", [snapshot], source)
            assert result["imported"] == 1

            # Reopening the database also covers the first report after a restart.
            database = database_class(types.SimpleNamespace(), path)
            assert not database._record_entity_state(
                "sensor.weight", "20", attributes, current, current, current
            )
            report = "2026-11-01T10:01:00+00:00"
            assert not database._record_entity_state(
                "sensor.weight", "20", attributes, current, report, report, initial=True
            )
            assert database._record_entity_state(
                "sensor.weight", "21", attributes, report, report, report
            )
            changed_attributes = {**attributes, "friendly_name": "Weight"}
            assert database._record_entity_state(
                "sensor.weight", "21", changed_attributes, report, report, report
            )
            with database._connect() as connection:
                rows = connection.execute(
                    "SELECT state FROM entity_states ORDER BY last_updated, id"
                ).fetchall()
            assert [row["state"] for row in rows] == ["10", "20", "21", "21"]


def test_corrections_preserve_originals_and_do_not_change_live_deduplication() -> None:
    cls = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = cls(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        timestamp = "2026-11-01T10:00:00+00:00"
        attrs = {"unit_of_measurement": "kg", "weight": 91.5}
        assert db._record_entity_state("sensor.weight", "91.5", attrs, timestamp, timestamp, None)
        rows, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        record_id = rows[0].id
        db._save_entity_sample("sensor.weight", "90", {**attrs, "weight": 90}, timestamp, record_id)
        assert not db._record_entity_state("sensor.weight", "91.5", attrs, timestamp, timestamp, None)
        db = cls(types.SimpleNamespace(), db.path)
        rows, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        corrected = rows[0]
        assert corrected.state == "90" and corrected.source == "corrected"
        assert corrected.original_source == "live" and corrected.modified_at
        assert corrected.original["state"] == "91.5"
        assert corrected.original["attributes"] == attrs
        snapshot = {"state": "91.5", "attributes": attrs, "last_updated": timestamp, "last_changed": timestamp}
        assert db._import_entity_states("sensor.weight", [snapshot], "recorder")["already_stored"] == 1
        assert db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)[0][0].state == "90"
        # A second correction still exposes the first original, not the previous edit.
        db._save_entity_sample("sensor.weight", "89", attrs, timestamp, record_id)
        rows, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        assert rows[0].original["state"] == "91.5"


def test_manual_samples_filtering_pagination_and_timestamp_validation() -> None:
    cls = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = cls(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        db._set_entity_tracking("sensor.other", True)
        ids = []
        for hour, value in [(10, "10"), (11, "20"), (12, "30")]:
            ids.append(db._save_entity_sample("sensor.weight", value, {"weight": float(value)}, f"2026-11-01T{hour}:00:00+00:00", None))
        # Corrections participate in numeric filters and sort by corrected time.
        db._save_entity_sample("sensor.weight", "15", {"weight": 15}, "2026-11-01T13:00:00+00:00", ids[0])
        rows, truncated = db._get_entity_history("sensor.weight", None, None, 2, True, None, 10, 25)
        assert [row.id for row in rows] == [ids[1], ids[0]] and not truncated
        rows, truncated = db._get_entity_history("sensor.weight", None, None, 2, True, None, None, None)
        assert [row.id for row in rows] == [ids[2], ids[0]] and truncated
        older, _ = db._get_entity_history("sensor.weight", None, None, 2, True, None, None, None, rows[0].id)
        assert [row.id for row in older] == [ids[1]]
        assert not db._get_entity_history("sensor.other", None, None, 2, True, None, None, None, ids[0])[0]
        for state, attrs, time, id_value in [
            ("15", {}, "2026-11-01T13:00:00+00:00", None),
            ("15", {}, "2026-11-01T13:00:00", None),
            ("", {}, "2026-11-01T14:00:00+00:00", None),
            ("15", [], "2026-11-01T14:00:00+00:00", None),
            ("15", {"bad": float("nan")}, "2026-11-01T14:00:00+00:00", None),
            ("15", {}, "2026-11-01T14:00:00+00:00", -10),
        ]:
            try: db._save_entity_sample("sensor.weight", state, attrs, time, id_value)
            except ValueError: pass
            else: raise AssertionError("Invalid or duplicate measurement accepted")
        try: db._save_entity_sample("sensor.other", "1", {}, "2026-11-01T14:00:00+00:00", ids[0])
        except ValueError: pass
        else: raise AssertionError("Cross-entity correction accepted")


def test_hourly_correction_keeps_aggregate_origin_and_manual_values_do_not_suppress_live() -> None:
    cls = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = cls(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        time = "2026-11-01T10:00:00+00:00"
        db._import_entity_states("sensor.weight", [{"state": "20", "attributes": {}, "last_updated": time, "last_changed": time}], "long_term_statistics")
        rows, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        db._save_entity_sample("sensor.weight", "19", {}, time, rows[0].id)
        # Exact imports normally replace aggregates, but a manually corrected
        # aggregate must retain its original snapshot and aggregate origin.
        imported = db._import_entity_states("sensor.weight", [{"state": "20.5", "attributes": {}, "last_updated": time, "last_changed": time}], "recorder")
        assert imported["already_stored"] == 1 and imported["updated"] == 0
        db._save_entity_sample("sensor.weight", "30", {}, "2026-11-01T12:00:00+00:00", None)
        assert db._record_entity_state("sensor.weight", "30", {}, time, "2026-11-01T11:00:00+00:00", None)
        rows, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        assert rows[0].source == "corrected" and rows[0].original_source == "long_term_statistics"
        db._delete_entity_history("sensor.weight")
        with db._connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM entity_state_corrections").fetchone()[0] == 0


def test_schema_one_reopen_preserves_existing_history_and_corrections() -> None:
    cls = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = cls(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        time = "2026-11-01T10:00:00+00:00"
        db._record_entity_state("sensor.weight", "20", {}, time, time, None)
        existing, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        db._save_entity_sample("sensor.weight", "19", {}, time, existing[0].id)
        db._initialize()
        db._initialize()  # Repeated startup must be safe.
        assert db._schema_version() == 1
        rows, _ = db._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        assert len(rows) == 1 and rows[0].state == "19" and rows[0].source == "corrected"


def test_existing_simultaneous_samples_can_be_corrected_and_paginated() -> None:
    cls = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = cls(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        time = "2026-11-01T10:00:00+00:00"
        db._record_entity_state("sensor.weight", "20", {}, time, time, None)
        db._record_entity_state("sensor.weight", "21", {}, time, time, None)
        rows, truncated = db._get_entity_history("sensor.weight", None, None, 1, True, None, None, None)
        assert truncated
        db._save_entity_sample("sensor.weight", "22", {}, time, rows[0].id)
        older, _ = db._get_entity_history("sensor.weight", None, None, 1, True, None, None, None, rows[0].id)
        assert older[0].state == "20" and older[0].id != rows[0].id


def test_measurement_websocket_handler_and_backup_include_corrections() -> None:
    import ast
    import asyncio
    import sqlite3

    cls = _database_class()
    tree = ast.parse((INTEGRATION / "websocket.py").read_text())
    handler = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "websocket_save_entity_sample")
    assert any(ast.unparse(decorator) == "websocket_api.require_admin" for decorator in handler.decorator_list)
    handler.decorator_list = []
    with tempfile.TemporaryDirectory() as directory:
        class Hass:
            async def async_add_executor_job(self, fn, *args):
                return fn(*args)
        db = cls(Hass(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        results, errors = [], []
        connection = types.SimpleNamespace(send_result=lambda *args: results.append(args), send_error=lambda *args: errors.append(args))
        namespace = {"__annotations__": {}, "_runtime": lambda _: types.SimpleNamespace(database=db),
                     "_send_input_error": lambda conn, msg, error: conn.send_error(msg["id"], "invalid_format", str(error))}
        # Execute the actual handler body with the real async database methods.
        code = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), handler], type_ignores=[])
        exec(compile(ast.fix_missing_locations(code), "measurement_handler", "exec"), namespace)
        message = {"id": 1, "entity_id": "SENSOR.WEIGHT", "state": "90", "attributes": {"unit_of_measurement": "kg"}, "timestamp": "2026-11-01T11:00:00+01:00"}
        asyncio.run(namespace[handler.name](None, connection, message))
        record_id = results[-1][1]["record_id"]
        asyncio.run(namespace[handler.name](None, connection, {**message, "record_id": record_id, "state": "89"}))
        assert len(results) == 2 and not errors
        asyncio.run(namespace[handler.name](None, connection, message))
        assert errors and len(results) == 2  # Duplicate timestamp is an input error.
        snapshot = Path(directory) / "backup.db"
        with sqlite3.connect(db.path) as source, sqlite3.connect(snapshot) as target:
            source.backup(target)
        restored = cls(Hass(), snapshot)
        restored._initialize()
        rows, _ = restored._get_entity_history("sensor.weight", None, None, 10, True, None, None, None)
        assert rows[0].state == "89" and rows[0].original["state"] == "90"


def test_query_status_separates_requested_limits_from_safety_scan_exhaustion() -> None:
    cls = _database_class()
    with tempfile.TemporaryDirectory() as directory:
        db = cls(types.SimpleNamespace(), Path(directory) / "history.db")
        db._initialize()
        db._set_entity_tracking("sensor.weight", True)
        with db._connect() as connection:
            connection.execute("""
                WITH RECURSIVE samples(n) AS (
                    SELECT 1 UNION ALL SELECT n + 1 FROM samples WHERE n < 200001
                ) INSERT INTO entity_states(entity_id, state, attributes_json,
                    last_changed, last_updated, recorded_at, source)
                SELECT 'sensor.weight', '0', '{}', '2026-11-01T10:00:00+00:00',
                    '2026-11-01T10:00:00+00:00', '2026-11-01T10:00:00+00:00', 'live'
                FROM samples
            """)
        records, more, limited = db._query_entity_history(
            "sensor.weight", None, None, 30, True, None, 50, None
        )
        assert not records and more and limited
        records, more, limited = db._query_entity_history(
            "sensor.weight", None, None, 30, True, None, 0, None
        )
        assert len(records) == 30 and more and not limited
        records, more, limited = db._query_entity_history(
            "sensor.weight", None, None, 30, True, None, None, None
        )
        assert len(records) == 30 and more and not limited
        with db._connect() as connection:
            connection.execute("UPDATE entity_states SET state='1000' WHERE id > 199971")
        records, more, limited = db._query_entity_history(
            "sensor.weight", None, None, 30, True, None, 1000, None
        )
        assert len(records) == 30 and not limited
