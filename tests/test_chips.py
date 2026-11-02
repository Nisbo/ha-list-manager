"""Focused regression tests for backend-managed quick-add chips."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import types


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _database_module():
    package_name = "ha_list_manager_chip_test"
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
    return sys.modules[f"{package_name}.database"]


def _list(database, name: str, list_type: str):
    return database._create_list(
        name, list_type, None, "local", None, "specific", True, True, True
    )


def test_unsupported_database_schema_is_rejected() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "unsupported.db"
        database = module.HaListManagerDatabase(types.SimpleNamespace(), path)
        database._initialize()
        with sqlite3.connect(path) as connection:
            connection.execute(
                "UPDATE schema_metadata SET value = '16' WHERE key = 'schema_version'"
            )

        try:
            database._initialize()
        except module.UnsupportedSchemaVersionError as error:
            assert "not supported; expected 1" in str(error)
            assert database._schema_version() == 16
        else:
            raise AssertionError("An unsupported database schema must be rejected")


def test_chip_scopes_resolve_to_the_most_specific_name() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "chips.db"
        )
        database._initialize()
        shopping = _list(database, "Einkauf", "shopping")
        todo = _list(database, "Aufgaben", "todo")
        global_chip = database._create_chip("Milch", "#111111", "global", None, None, None)
        type_chip = database._create_chip("Milch", "#222222", "list_type", "shopping", None, None)
        list_chip = database._create_chip("Milch", "#333333", "list", None, shopping.id, None)

        assert [chip.id for chip in database._list_chips(shopping.id)] == [list_chip.id]
        assert database._list_chips(todo.id) == []
        assert {chip.id for chip in database._list_chips()} == {
            global_chip.id, type_chip.id, list_chip.id
        }


def test_todo_templates_are_isolated_from_article_chips() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "chips.db"
        )
        database._initialize()
        shopping = _list(database, "Einkauf", "shopping")
        todo = _list(database, "Aufgaben", "todo")
        article = database._create_chip(
            "Milch", None, "global", None, None, None
        )
        template = database._create_chip(
            "Gelbe Tonne", "#ffaa00", "list", None, todo.id, None,
            "todo_template", "mdi:trash-can-outline",
            {
                "item_name": "Gelbe Tonne rausstellen",
                "due_mode": "tomorrow",
                "due_time": "18:00",
                "recurrence_interval": 14,
                "recurrence_unit": "D",
                "add_mode": "direct",
            },
        )

        assert [chip.id for chip in database._list_chips(shopping.id)] == [article.id]
        assert [chip.id for chip in database._list_chips(todo.id)] == [template.id]
        assert template.template_data["item_name"] == "Gelbe Tonne rausstellen"
        assert template.template_data["due_mode"] == "tomorrow"


def test_chip_kinds_cannot_move_between_todo_and_article_lists() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "chips.db"
        )
        database._initialize()
        shopping = _list(database, "Einkauf", "shopping")
        todo = _list(database, "Aufgaben", "todo")

        invalid_calls = [
            lambda: database._create_chip(
                "Aufgabe", None, "list", None, shopping.id, None,
                "todo_template", None, {"item_name": "Aufgabe"},
            ),
            lambda: database._create_chip(
                "Milch", None, "list", None, todo.id, None
            ),
            lambda: database._create_chip(
                "Global", None, "global", None, None, None,
                "todo_template", None, {"item_name": "Aufgabe"},
            ),
        ]
        for call in invalid_calls:
            try:
                call()
            except ValueError:
                continue
            raise AssertionError("Incompatible chip target was accepted")


def test_chip_can_reference_a_product_and_survives_product_deletion() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "chips.db"
        )
        database._initialize()
        product = database._create_product(
            None, "Gurken", None, None, None, None, None, "manual", []
        )
        chip = database._create_chip(
            "Gurken", "#00aa77", "global", None, None, product.id
        )
        assert chip.product_id == product.id
        assert chip.product_name == "Gurken"

        database._delete_product(product.id)
        remaining = database._list_chips()[0]
        assert remaining.product_id is None
        assert remaining.product_name is None


def test_chip_categories_use_product_assignments_and_name_rules() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "chips.db"
        )
        database._initialize()
        shopping = _list(database, "Einkauf", "shopping")
        drinks = database._create_category(
            "Getränke", "global", None, None, "mdi:bottle-soda", "#0088ff", None
        )
        vegetables = database._create_category(
            "Gemüse", "list", None, shopping.id, "mdi:food-apple", "#00aa22", None
        )
        database._replace_category_rules(vegetables.id, ["Tomaten*"])
        product = database._create_product(
            None, "Apfelsaft", None, None, None, None, None, "manual", [],
            [drinks.id],
        )
        rule_product = database._create_product(
            None, "Tomaten Dose", None, None, None, None, None, "manual", [], []
        )

        resolved = database._resolve_chip_categories(
            shopping.id,
            [
                {"key": "product", "name": "Saft", "product_id": product.id},
                {"key": "rule", "name": "Tomaten Cherry", "product_id": None},
                {"key": "product-rule", "name": "Eigener Chipname", "product_id": rule_product.id},
                {"key": "general", "name": "Unbekannt", "product_id": None},
            ],
        )

        assert resolved["product"].id == drinks.id
        assert resolved["rule"].id == vegetables.id
        assert resolved["product-rule"].id == vegetables.id
        assert resolved["general"] is None


def test_chip_priority_name_normalizes_whitespace_and_scope_move_can_replace() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "chips.db"
        )
        database._initialize()
        target = _list(database, "Einkauf", "shopping")
        global_chip = database._create_chip(
            "Bier", None, "global", None, None, None
        )
        type_chip = database._create_chip(
            "  BIER  ", None, "list_type", "shopping", None, None
        )
        assert type_chip.priority_name == "bier"
        assert [chip.id for chip in database._list_chips(target.id)] == [type_chip.id]

        try:
            database._update_chip(
                global_chip.id, "Bier", None, "list_type", "shopping", None,
                None,
            )
        except module.DuplicateChipError:
            pass
        else:
            raise AssertionError("a destination conflict must require replacement")

        moved = database._update_chip(
            global_chip.id, "Bier", None, "list_type", "shopping", None,
            None, True,
        )
        assert moved.id == global_chip.id
        assert [chip.id for chip in database._list_chips()] == [global_chip.id]


def test_important_chip_assignments_are_list_specific_and_cleaned_up() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "important-chips.db"
        )
        database._initialize()
        first = _list(database, "Einkauf", "shopping")
        second = _list(database, "Arbeit", "shopping")
        product = database._create_product(
            None, "Ketchup", None, None, None, None, None, "manual", []
        )
        chip = database._create_chip(
            "Milch", None, "global", None, None, None
        )

        database._set_important_chip_assignment(first.id, "chip", chip.id, True)
        database._set_important_chip_assignment(first.id, "product", product.id, True)
        assert database._list_important_chip_assignments(first.id) == [
            {"target_type": "chip", "target_id": chip.id},
            {"target_type": "product", "target_id": product.id},
        ]
        assert database._list_important_chip_assignments(second.id) == []

        database._set_important_chip_assignment(first.id, "chip", chip.id, False)
        assert database._list_important_chip_assignments(first.id) == [
            {"target_type": "product", "target_id": product.id}
        ]
        database._delete_product(product.id)
        assert database._list_important_chip_assignments(first.id) == []
