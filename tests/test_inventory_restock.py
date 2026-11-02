"""Regression tests for backend-owned inventory restocking."""
from __future__ import annotations
import importlib.util
from datetime import UTC, datetime
from pathlib import Path
import sqlite3
import sys
import tempfile
import types

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"

def _database_module():
    package_name = "ha_list_manager_restock_test"
    package = types.ModuleType(package_name)
    package.__path__ = [str(INTEGRATION)]
    sys.modules[package_name] = package
    for module_name in ("const", "models", "database"):
        name = f"{package_name}.{module_name}"
        spec = importlib.util.spec_from_file_location(name, INTEGRATION / f"{module_name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        assert spec.loader
        spec.loader.exec_module(module)
    return sys.modules[f"{package_name}.database"]

def _fixture():
    module = _database_module()
    directory = tempfile.TemporaryDirectory()
    database = module.HaListManagerDatabase(types.SimpleNamespace(), Path(directory.name) / "test.db")
    database._initialize()
    shopping = database._create_list("Einkauf", "shopping", None, "local", None, "specific", True, True, True)
    inventory = database._create_list("Vorrat", "inventory", None, "local", None, "specific", True, True, True)
    milk = database._create_product(None, "Milch", None, None, None, None, None, "manual", [], [])
    entry = database._create_inventory_entry(inventory.id, milk.id, 2, 2, None, "Getränke", False)
    return directory, database, shopping, inventory, entry

def test_continuous_restock_ignores_existing_open_quantity():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._create_item(shopping.id, "Milch", None, 1, None, None, None, [], None, None)
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "continuous", 5)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["transfer"]["quantity"] == 1
        assert result["transfer"]["already_open"] == 1
        assert db._list_items(shopping.id)[0].quantity == 2
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["transfer"]["quantity"] == 1
        assert db._list_items(shopping.id)[0].quantity == 3

def test_fixed_restock_latches_until_stock_changes_or_manual_reset():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._update_inventory_entry(entry.id, 2, 2, None, "Getränke", False, 5, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 1)
        first = db._adjust_inventory_with_restock(entry.id, -1)
        assert first["transfer"]["quantity"] == 5
        second = db._adjust_inventory_with_restock(entry.id, -1)
        assert second["transfer"] is None
        preview = db._preview_inventory_restock(inventory.id)
        assert preview["items"][0]["latched"] is True
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        db._update_inventory_entry(entry.id, 1, 2, None, "Getränke", False)
        third = db._adjust_inventory_with_restock(entry.id, -1)
        assert third["transfer"]["quantity"] == 5


def test_explicit_fixed_restock_requires_a_minimum_stock():
    directory, db, _shopping, _inventory, entry = _fixture()
    with directory:
        try:
            db._update_inventory_entry(
                entry.id, 2, None, None, "Getränke", False, 6, "fixed"
            )
        except ValueError as error:
            assert "Mindestbestand" in str(error)
        else:
            raise AssertionError("fixed restock without a threshold must be rejected")

def test_manual_shortage_and_group_name_transfer():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        second_product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 0, None, None, "Getränke", False)
        group = db._create_inventory_group(inventory.id, "Milch", 4, None, "Getränke", [first.id, second.id])
        db._set_inventory_restock_settings(inventory.id, shopping.id, False, "continuous", 1)
        preview = db._preview_inventory_restock(inventory.id)
        assert preview["target_list_name"] == shopping.name
        assert preview["items"][0]["name"] == "Milch"
        assert preview["items"][0]["quantity"] == 2
        applied = db._apply_inventory_restock(inventory.id)
        assert applied["items"][0]["source_type"] == "group"
        item = db._list_items(shopping.id)[0]
        assert item.name == "Milch"
        assert item.quantity == 2
        assert item.inventory_source_id == group.id
        assert "Hafermilch" in (item.description or "")


def test_fixed_group_uses_its_own_restock_quantity():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        second_product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 0, None, None, "Getränke", False)
        db._create_inventory_group(inventory.id, "Milch", 4, None, "Getränke", [first.id, second.id], 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 1)
        result = db._adjust_inventory_with_restock(first.id, -1)
        assert result["transfer"]["quantity"] == 6
        assert db._list_items(shopping.id)[0].quantity == 6

def test_zero_stock_requires_explicit_confirmation():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "one_to_one", 1)
        db._update_inventory_entry(entry.id, 0, 2, None, "Getränke", False)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["needs_confirmation"] is True
        assert db._list_items(shopping.id) == []
        transfer = db._confirm_zero_stock_restock(entry.id, 1)
        assert transfer["quantity"] == 1
        assert db._list_items(shopping.id)[0].quantity == 1

def test_group_changes_remove_obsolete_fixed_restock_latches():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        second_product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 0, None, None, "Getränke", False)
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 5)
        db._adjust_inventory_with_restock(first.id, -1)
        assert db._preview_inventory_restock(inventory.id)["items"][0]["latched"] is True
        group = db._create_inventory_group(inventory.id, "Milch", 4, None, "Getränke", [first.id, second.id])
        preview = db._preview_inventory_restock(inventory.id)
        assert preview["items"][0]["source_id"] == group.id
        assert preview["items"][0]["latched"] is False
        db._adjust_inventory_with_restock(first.id, -1)
        assert db._preview_inventory_restock(inventory.id)["items"][0]["latched"] is True
        db._delete_inventory_group(group.id)
        with db._connect() as connection:
            stale = connection.execute(
                "SELECT 1 FROM inventory_restock_state WHERE source_id = ?", (group.id,)
            ).fetchone()
        assert stale is None

def test_initial_restock_schema_persists_optional_defaults_without_obsolete_columns():
    directory, db, shopping, inventory, _entry = _fixture()
    with directory:
        with db._connect() as connection:
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(inventory_restock_settings)")}
        assert "mode" not in columns and "fixed_quantity" not in columns
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", None)
        db._initialize()
        settings = db._get_inventory_restock_settings(inventory.id)
        assert settings.enabled and settings.mode == "fixed" and settings.fixed_quantity is None
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 6)
        db._initialize()
        assert db._get_inventory_restock_settings(inventory.id).fixed_quantity == 6


def test_source_rule_overrides_list_default():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._update_inventory_entry(entry.id, 5, 5, None, "Getränke", False, 20, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "one_to_one", None)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["transfer"]["quantity"] == 20
        assert result["transfer"]["mode"] == "fixed"


def test_optional_fixed_default_requires_a_source_amount():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", None)
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["transfer"] is None
        db._update_inventory_entry(entry.id, 2, 2, None, "Getränke", False, 4, "fixed")
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["transfer"]["quantity"] == 4


def test_fixed_list_default_amount_is_used_by_inheriting_source():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 8)
        settings = db._get_inventory_restock_settings(inventory.id)
        assert settings.mode == "fixed"
        assert settings.fixed_quantity == 8
        result = db._adjust_inventory_with_restock(entry.id, -1)
        assert result["transfer"]["quantity"] == 8


def test_no_list_default_and_explicit_disabled_are_distinct():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, None, None)
        assert db._adjust_inventory_with_restock(entry.id, -1)["transfer"] is None
        db._update_inventory_entry(entry.id, 2, 2, None, "Getränke", False, 1, "one_to_one")
        assert db._adjust_inventory_with_restock(entry.id, -1)["transfer"]["quantity"] == 1
        db._update_inventory_entry(entry.id, 2, 2, None, "Getränke", False, 1, "disabled")
        assert db._adjust_inventory_with_restock(entry.id, -1)["transfer"] is None


def test_manual_fixed_shortage_respects_latch_and_relatches_after_reset():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._update_inventory_entry(entry.id, 2, 2, None, "Getränke", False, 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "continuous", None)
        assert db._adjust_inventory_with_restock(entry.id, -1)["transfer"]["quantity"] == 6
        preview = db._preview_inventory_restock(inventory.id)["items"][0]
        assert preview["quantity"] == 1
        assert preview["effective_mode"] == "fixed"
        assert preview["effective_fixed_quantity"] == 6
        assert preview["already_open"] == 6
        assert preview["latched"] is True and preview["skipped"] is True
        assert db._apply_inventory_restock(inventory.id)["items"] == []
        before_reset = db._list_items(shopping.id)
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        assert db._list_items(shopping.id) == before_reset
        preview = db._preview_inventory_restock(inventory.id)["items"][0]
        assert preview["quantity"] == 1 and preview["already_open"] == 6
        assert preview["latched"] is False and preview["skipped"] is False
        applied = db._apply_inventory_restock(inventory.id)
        assert len(applied["items"]) == 1
        assert applied["items"][0]["quantity"] == 1
        assert applied["items"][0]["already_open"] == 6
        assert db._list_items(shopping.id)[0].quantity == 7
        assert db._preview_inventory_restock(inventory.id)["items"][0]["latched"] is True
        assert db._apply_inventory_restock(inventory.id)["items"] == []
        assert db._list_items(shopping.id)[0].quantity == 7


def test_manual_apply_rechecks_a_latch_set_after_the_preview():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._update_inventory_entry(entry.id, 1, 2, None, "Getränke", False, 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 8)
        stale_preview = db._preview_inventory_restock(inventory.id)
        assert stale_preview["items"][0]["quantity"] == 1
        assert stale_preview["items"][0]["skipped"] is False
        assert db._adjust_inventory_with_restock(entry.id, -1)["transfer"]["quantity"] == 6
        before_apply = db._list_items(shopping.id)
        assert db._apply_inventory_restock(inventory.id)["items"] == []
        assert db._list_items(shopping.id) == before_apply


def test_manual_apply_transfers_only_unlatched_shortages_in_a_mixed_inventory():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        db._update_inventory_entry(first.id, 2, 2, None, "Getränke", False, 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 8)
        db._adjust_inventory_with_restock(first.id, -1)
        second_product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 1, 2, None, "Getränke", False, 9, "fixed")
        preview = {row["source_id"]: row for row in db._preview_inventory_restock(inventory.id)["items"]}
        assert preview[first.id]["skipped"] is True
        assert preview[second.id]["skipped"] is False
        applied = db._apply_inventory_restock(inventory.id)
        assert [(row["source_id"], row["quantity"]) for row in applied["items"]] == [(second.id, 1)]
        assert {item.name: item.quantity for item in db._list_items(shopping.id)} == {"Milch": 6, "Hafermilch": 1}
        assert all(row["latched"] for row in db._preview_inventory_restock(inventory.id)["items"])
        assert db._apply_inventory_restock(inventory.id)["items"] == []


def test_manual_group_shortage_respects_one_group_latch_and_uses_group_deficit():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        second_product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 0, None, None, "Getränke", False)
        group = db._create_inventory_group(inventory.id, "Milchgruppe", 3, None, "Getränke", [first.id, second.id], 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "one_to_one", None)
        assert db._adjust_inventory_with_restock(first.id, -1)["transfer"]["quantity"] == 6
        preview = db._preview_inventory_restock(inventory.id)["items"]
        assert len(preview) == 1
        assert preview[0]["source_type"] == "group" and preview[0]["source_id"] == group.id
        assert preview[0]["quantity"] == 2 and preview[0]["skipped"] is True
        assert db._apply_inventory_restock(inventory.id)["items"] == []
        before_reset = db._list_items(shopping.id)
        db._reset_inventory_restock_latch(inventory.id, "group", group.id)
        assert db._list_items(shopping.id) == before_reset
        applied = db._apply_inventory_restock(inventory.id)
        assert len(applied["items"]) == 1
        assert applied["items"][0]["quantity"] == 2
        assert applied["items"][0]["source_id"] == group.id
        item = db._list_items(shopping.id)[0]
        assert item.name == "Milchgruppe" and item.quantity == 8
        assert "Milch" in item.description and "Hafermilch" in item.description
        assert db._preview_inventory_restock(inventory.id)["items"][0]["latched"] is True
        assert db._apply_inventory_restock(inventory.id)["items"] == []


def test_manual_inherited_fixed_rule_relatches_using_deficit_instead_of_default_amount():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 8)
        assert db._adjust_inventory_with_restock(entry.id, -1)["transfer"]["quantity"] == 8
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["restock_mode"] is None
        assert row["effective_mode"] == "fixed" and row["effective_fixed_quantity"] == 8
        assert row["skipped"] is True
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        db._set_inventory_restock_settings(inventory.id, shopping.id, False, "fixed", 8)
        applied = db._apply_inventory_restock(inventory.id)
        assert applied["items"][0]["quantity"] == 1
        assert db._list_items(shopping.id)[0].quantity == 9
        assert db._preview_inventory_restock(inventory.id)["items"][0]["latched"] is True
        assert db._apply_inventory_restock(inventory.id)["items"] == []


def test_manual_transfer_respects_existing_latch_after_default_rule_changes():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 8)
        db._adjust_inventory_with_restock(entry.id, -1)
        db._set_inventory_restock_settings(inventory.id, shopping.id, False, "continuous", None)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["effective_mode"] == "continuous"
        assert row["latched"] is True and row["skipped"] is True
        assert db._apply_inventory_restock(inventory.id)["items"] == []
        assert db._list_items(shopping.id)[0].quantity == 8


def test_manual_nonfixed_shortages_remain_repeatable_and_ignore_open_quantity():
    for mode in ("continuous", "one_to_one", "disabled", None):
        directory, db, shopping, inventory, entry = _fixture()
        with directory:
            db._update_inventory_entry(entry.id, 1, 2, None, "Getränke", False, 1, mode)
            db._set_inventory_restock_settings(inventory.id, shopping.id, False, None, None)
            db._create_item(shopping.id, "Milch", None, 20, None, None, None, [], None, None)
            for already_open in (20, 21):
                preview = db._preview_inventory_restock(inventory.id)["items"][0]
                assert preview["effective_mode"] == mode
                assert preview["latched"] is False and preview["skipped"] is False
                assert preview["quantity"] == 1 and preview["already_open"] == already_open
                applied = db._apply_inventory_restock(inventory.id)
                assert len(applied["items"]) == 1 and applied["items"][0]["quantity"] == 1
            assert db._list_items(shopping.id)[0].quantity == 22


def test_preview_reports_skip_state_even_without_a_target():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._update_inventory_entry(entry.id, 2, 2, None, "Getränke", False, 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 8)
        db._adjust_inventory_with_restock(entry.id, -1)
        db._set_inventory_restock_settings(inventory.id, None, False, "fixed", 8)
        preview = db._preview_inventory_restock(inventory.id)
        assert preview["target_list_id"] is None
        row = preview["items"][0]
        assert row["latched"] is True and row["skipped"] is True
        assert row["effective_mode"] == "fixed" and row["effective_fixed_quantity"] == 6
        before_reset = db._list_items(shopping.id)
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        assert db._list_items(shopping.id) == before_reset
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["latched"] is False and row["skipped"] is False


def test_old_shopping_items_do_not_invent_transfer_metadata():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._update_inventory_entry(entry.id, 1, 2, None, "Getränke", False)
        db._create_item(shopping.id, "Milch", None, 3, None, None, None, [], None, None)
        db._set_inventory_restock_settings(inventory.id, shopping.id, False, None, None)
        preview = db._preview_inventory_restock(inventory.id)["items"][0]
        assert preview["already_open"] == 3
        assert preview["last_manual_transfer"] is None
        assert preview["last_automatic_transfer"] is None


def test_all_automatic_rules_record_the_actual_transferred_quantity_and_mode():
    for mode, expected_quantity in (("continuous", 1), ("fixed", 6), ("one_to_one", 1)):
        directory, db, shopping, inventory, entry = _fixture()
        with directory:
            db._set_inventory_restock_settings(inventory.id, shopping.id, True, mode, 6)
            db._now = lambda: "2026-10-19T10:00:00+00:00"
            db._adjust_inventory_with_restock(entry.id, -1)
            row = db._preview_inventory_restock(inventory.id)["items"][0]
            assert row["last_manual_transfer"] is None
            assert row["last_automatic_transfer"] == {
                "transferred_at": "2026-10-19T10:00:00+00:00",
                "quantity": expected_quantity,
                "target_list_id": shopping.id,
                "target_list_name": "Einkauf",
                "mode": mode,
            }
            assert datetime.fromisoformat(row["last_automatic_transfer"]["transferred_at"]).tzinfo == UTC


def test_manual_and_automatic_latest_transfers_are_kept_independently():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 6)
        db._now = lambda: "2026-10-19T10:00:00+00:00"
        db._adjust_inventory_with_restock(entry.id, -1)
        automatic = db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"]
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        db._now = lambda: "2026-10-19T11:00:00+00:00"
        db._apply_inventory_restock(inventory.id)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_automatic_transfer"] == automatic
        assert row["last_manual_transfer"] == {
            "transferred_at": "2026-10-19T11:00:00+00:00", "quantity": 1,
            "target_list_id": shopping.id, "target_list_name": "Einkauf", "mode": None,
        }
        first_manual = row["last_manual_transfer"]
        db._now = lambda: "2026-10-19T12:00:00+00:00"
        assert db._apply_inventory_restock(inventory.id)["items"] == []
        assert db._preview_inventory_restock(inventory.id)["items"][0]["last_manual_transfer"] == first_manual
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        db._apply_inventory_restock(inventory.id)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_manual_transfer"]["transferred_at"] == "2026-10-19T12:00:00+00:00"
        assert row["last_automatic_transfer"] == automatic
        with db._connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM inventory_restock_transfers").fetchone()[0] == 2
        # A later automatic order replaces only that origin's latest record.
        db._adjust_inventory_with_restock(entry.id, 1)
        db._now = lambda: "2026-10-19T13:00:00+00:00"
        db._adjust_inventory_with_restock(entry.id, -1)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_automatic_transfer"]["transferred_at"] == "2026-10-19T13:00:00+00:00"
        assert row["last_manual_transfer"]["transferred_at"] == "2026-10-19T12:00:00+00:00"


def test_zero_stock_confirmation_is_recorded_as_manual_only_after_confirmation():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "one_to_one", None)
        db._update_inventory_entry(entry.id, 0, 2, None, "Getränke", False)
        assert db._adjust_inventory_with_restock(entry.id, -3)["needs_confirmation"] is True
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_manual_transfer"] is None and row["last_automatic_transfer"] is None
        db._now = lambda: "2026-10-19T10:00:00+00:00"
        db._confirm_zero_stock_restock(entry.id, 3)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_manual_transfer"]["quantity"] == 3
        assert row["last_manual_transfer"]["transferred_at"] == "2026-10-19T10:00:00+00:00"
        assert row["last_manual_transfer"]["mode"] is None
        assert row["last_automatic_transfer"] is None


def test_transfer_metadata_survives_reset_stock_changes_rule_changes_and_reopening():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 6)
        db._adjust_inventory_with_restock(entry.id, -1)
        original = db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"]
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        assert db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"] == original
        db._update_inventory_entry(entry.id, 0, 2, None, "Getränke", False, 4, "disabled")
        assert db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"] == original
        db._adjust_inventory_with_restock(entry.id, 1)
        assert db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"] == original
        db._set_inventory_restock_settings(inventory.id, None, False, None, None)
        reopened = type(db)(types.SimpleNamespace(), db.path)
        reopened._initialize()
        row = reopened._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_automatic_transfer"] == original
        assert row["last_manual_transfer"] is None
        assert reopened._list_items(shopping.id)[0].quantity == 6


def test_failed_automatic_transfer_rolls_back_stock_latch_and_metadata():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 6)
        with db._connect() as connection:
            connection.executescript("""
            CREATE TRIGGER reject_restock_metadata BEFORE INSERT ON inventory_restock_transfers
            BEGIN SELECT RAISE(ABORT, 'simulated transfer failure'); END;
            """)
        try:
            db._adjust_inventory_with_restock(entry.id, -1)
        except sqlite3.IntegrityError as error:
            assert "simulated transfer failure" in str(error)
        else:
            raise AssertionError("transfer should fail")
        assert db._list_inventory(inventory.id)[0].stock == 2
        assert db._list_items(shopping.id) == []
        with db._connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM inventory_restock_transfers").fetchone()[0] == 0
            assert connection.execute("SELECT COUNT(*) FROM inventory_restock_state").fetchone()[0] == 0


def test_failed_manual_transfer_preserves_previous_order_and_existing_shopping_quantity():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, False, None, None)
        db._update_inventory_entry(entry.id, 1, 2, None, "Getränke", False)
        db._apply_inventory_restock(inventory.id)
        previous = db._preview_inventory_restock(inventory.id)["items"][0]["last_manual_transfer"]
        with db._connect() as connection:
            connection.executescript("""
            CREATE TRIGGER reject_restock_metadata BEFORE INSERT ON inventory_restock_transfers
            BEGIN SELECT RAISE(ABORT, 'simulated transfer failure'); END;
            """)
        try:
            db._apply_inventory_restock(inventory.id)
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("transfer should fail")
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_manual_transfer"] == previous
        assert row["last_automatic_transfer"] is None
        assert db._list_items(shopping.id)[0].quantity == 1


def test_group_transfer_metadata_is_separate_from_member_orders_and_survives_group_edits():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "continuous", None)
        db._adjust_inventory_with_restock(first.id, -1)
        member_order = db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"]
        product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, product.id, 0, None, None, "Getränke", False)
        group = db._create_inventory_group(inventory.id, "Milchgruppe", 4, None, "Getränke", [first.id, second.id], 6, "fixed")
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["source_type"] == "group"
        assert row["last_automatic_transfer"] is None
        db._adjust_inventory_with_restock(first.id, -1)
        original = db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"]
        assert original["quantity"] == 6 and original["mode"] == "fixed"
        db._reset_inventory_restock_latch(inventory.id, "group", group.id)
        db._apply_inventory_restock(inventory.id)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_manual_transfer"]["quantity"] == 4
        assert row["last_automatic_transfer"] == original
        db._update_inventory_group(group.id, "Milchgruppe neu", 4, None, "Getränke", [first.id, second.id], 7, "fixed")
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_automatic_transfer"] == original
        db._delete_inventory_group(group.id)
        row = next(row for row in db._preview_inventory_restock(inventory.id)["items"] if row["source_id"] == first.id)
        assert row["last_automatic_transfer"] == member_order
        with db._connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM inventory_restock_transfers WHERE source_id = ?", (group.id,)).fetchone()[0] == 0


def test_transfer_target_name_is_a_snapshot_and_target_changes_do_not_rewrite_old_orders():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "continuous", None)
        db._adjust_inventory_with_restock(entry.id, -1)
        original = db._preview_inventory_restock(inventory.id)["items"][0]["last_automatic_transfer"]
        second_target = db._create_list("Andere Einkäufe", "shopping", None, "local", None, "specific", True, True, True)
        with db._connect() as connection:
            connection.execute("UPDATE lists SET name = 'Umbenannt' WHERE id = ?", (shopping.id,))
        db._set_inventory_restock_settings(inventory.id, second_target.id, False, None, None)
        db._apply_inventory_restock(inventory.id)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_automatic_transfer"] == original
        assert row["last_manual_transfer"]["target_list_name"] == "Andere Einkäufe"
        assert row["last_manual_transfer"]["target_list_id"] == second_target.id
        db._delete_list(shopping.id)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_automatic_transfer"] == {**original, "target_list_id": None}


def test_deleting_inventory_products_cleans_up_last_transfer_metadata():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "continuous", None)
        db._adjust_inventory_with_restock(entry.id, -1)
        db._delete_product(entry.product_id)
        with db._connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM inventory_restock_transfers").fetchone()[0] == 0
        assert db._list_items(shopping.id)[0].quantity == 1


def test_schema_one_reopen_preserves_stock_orders_locks_and_transfer_history():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "fixed", 6)
        db._adjust_inventory_with_restock(entry.id, -1)
        existing_items = db._list_items(shopping.id)
        existing_inventory = db._list_inventory(inventory.id)
        original = db._preview_inventory_restock(inventory.id)["items"][0]
        assert original["latched"] and original["last_automatic_transfer"]["quantity"] == 6
        db._initialize()
        db._initialize()
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row == original
        assert db._list_items(shopping.id) == existing_items
        assert db._list_inventory(inventory.id) == existing_inventory
        assert db._schema_version() == 1
        db._reset_inventory_restock_latch(inventory.id, "entry", entry.id)
        db._apply_inventory_restock(inventory.id)
        row = db._preview_inventory_restock(inventory.id)["items"][0]
        assert row["last_manual_transfer"]["quantity"] == 1
        assert row["last_automatic_transfer"] == original["last_automatic_transfer"]
        db._delete_inventory_entry(entry.id)
        with db._connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM inventory_restock_transfers").fetchone()[0] == 0


def test_unknown_schemas_are_rejected_without_rewriting_data():
    module = _database_module()
    for version in (0, 17, 25, 999):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unsupported.db"
            with sqlite3.connect(path) as connection:
                connection.executescript("""
                CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE lists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                INSERT INTO lists VALUES ('preserve-id', 'Preserve this entry');
                """)
                connection.execute("INSERT INTO schema_metadata VALUES ('schema_version', ?)", (str(version),))
            before = path.read_bytes()
            db = module.HaListManagerDatabase(types.SimpleNamespace(), path)
            try:
                db._initialize()
            except module.UnsupportedSchemaVersionError:
                pass
            else:
                raise AssertionError(f"Unsupported schema {version} was accepted")
            assert path.read_bytes() == before
            assert not Path(str(path) + "-wal").exists()


def test_existing_unversioned_database_is_not_treated_as_a_fresh_install():
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "unrelated.db"
        with sqlite3.connect(path) as connection:
            connection.executescript("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('Keep me');")
        before = path.read_bytes()
        db = module.HaListManagerDatabase(types.SimpleNamespace(), path)
        try:
            db._initialize()
        except module.UnsupportedSchemaVersionError:
            pass
        else:
            raise AssertionError("An existing unversioned database was accepted")
        assert path.read_bytes() == before
