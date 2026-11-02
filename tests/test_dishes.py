"""Regression tests for central dishes and transactional list insertion."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _database_module():
    package_name = "ha_list_manager_dish_test"
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


def _shopping_list(database, name="Einkauf", use_dishes=True):
    return database._create_list(
        name, "shopping", None, "local", None, "specific",
        True, True, True, True, True, True, True, use_dishes,
    )


def test_dish_crud_and_normalized_name_uniqueness() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "dishes.db"
        )
        database._initialize()
        dish = database._create_dish(
            "  Pasta   Napoli ", "#aa3300",
            [{"name": "Nudeln", "quantity": 2}],
        )
        assert dish.name == "Pasta Napoli"
        assert dish.normalized_name == "pasta napoli"
        assert dish.items[0].name == "Nudeln"
        try:
            database._create_dish(
                "PASTA NAPOLI", None, [{"name": "Tomaten", "quantity": 1}]
            )
        except module.DuplicateDishError:
            pass
        else:
            raise AssertionError("normalized dish names must be unique")

        updated = database._update_dish(
            dish.id, "Pasta Arrabbiata", None,
            [{"name": "Tomaten", "quantity": 3}],
        )
        assert updated.name == "Pasta Arrabbiata"
        assert updated.items[0].quantity == 3
        database._delete_dish(dish.id)
        assert database._list_dishes() == []


def test_dish_product_snapshot_survives_product_deletion() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "snapshot.db"
        )
        database._initialize()
        product = database._create_product(
            "1234567890123", "Passierte Tomaten", None, "Testmarke", "400 g", None, None, "manual", []
        )
        dish = database._create_dish(
            "Tomatensuppe", None,
            [{"name": "Passierte Tomaten", "product_id": product.id, "quantity": 2}],
        )
        linked_item = database._list_dishes()[0].items[0]
        assert linked_item.product_name == "Passierte Tomaten"
        assert linked_item.product_brand == "Testmarke"
        assert linked_item.product_package_quantity == "400 g"
        assert linked_item.product_ean == "1234567890123"
        database._delete_product(product.id)
        item = database._list_dishes()[0].items[0]
        assert item.product_id is None
        assert item.name == "Passierte Tomaten"


def test_dish_add_creates_and_increments_items_atomically() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "add.db"
        )
        database._initialize()
        target = _shopping_list(database)
        disabled = _shopping_list(database, "Ohne Gerichte", False)
        product = database._create_product(
            None, "Nudeln", None, None, None, None, None, "manual", []
        )
        dish = database._create_dish(
            "Pasta", None,
            [
                {"name": "Nudeln", "product_id": product.id, "quantity": 2},
                {"name": "Tomaten", "quantity": 3},
            ],
        )
        assert database._list_dishes(disabled.id) == []
        assert [entry.id for entry in database._list_dishes(target.id)] == [dish.id]

        result = database._add_dish_to_list(dish.id, target.id, None)
        assert result == {"dish": database._list_dishes()[0].as_dict(), "created": 2, "updated": 0}
        result = database._add_dish_to_list(
            dish.id, target.id,
            [{"item_id": dish.items[0].id, "quantity": 4}],
        )
        assert result["created"] == 0
        assert result["updated"] == 1
        items = database._list_items(target.id)
        assert {item.name: item.quantity for item in items} == {"Nudeln": 6, "Tomaten": 3}

        try:
            database._add_dish_to_list(dish.id, disabled.id, None)
        except module.DishesDisabledError:
            pass
        else:
            raise AssertionError("disabled lists must reject dish insertion")


def test_dish_add_accepts_one_time_category_overrides() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "category-overrides.db"
        )
        database._initialize()
        target = _shopping_list(database)
        vegetables = database._create_category(
            "Gemüse", "list", None, target.id, "mdi:food-apple", "#00aa22", None
        )
        database._replace_category_rules(vegetables.id, ["Tomaten*"])
        dish = database._create_dish(
            "Salat", None,
            [
                {"name": "Tomaten", "quantity": 1},
                {"name": "Gurke", "quantity": 1},
            ],
        )
        database._add_dish_to_list(
            dish.id,
            target.id,
            [
                {"item_id": dish.items[0].id, "quantity": 1, "category_id": None},
                {"item_id": dish.items[1].id, "quantity": 1, "category_id": vegetables.id},
            ],
        )
        items = {item.name: item for item in database._list_items(target.id)}
        assert items["Tomaten"].category_id is None
        assert items["Tomaten"].category is None
        assert items["Gurke"].category_id == vegetables.id
        assert items["Gurke"].category == "Gemüse"

        dynamic_dish = database._create_dish(
            "Nachtisch", None, [{"name": "Pudding", "quantity": 1}]
        )
        database._add_dish_to_list(
            dynamic_dish.id,
            target.id,
            [{
                "item_id": dynamic_dish.items[0].id,
                "quantity": 1,
                "category_id": None,
                "category": "Kühlregal",
            }],
        )
        pudding = {item.name: item for item in database._list_items(target.id)}["Pudding"]
        assert pudding.category_id is None
        assert pudding.category == "Kühlregal"


def test_inventory_list_projection_includes_dish_setting() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "inventory.db"
        )
        database._initialize()
        database._create_list(
            "Vorrat", "inventory", None, "local", None, "specific",
            True, True, True, True, True, True, True, False,
        )
        records = database._list_inventory_lists()
        assert len(records) == 1
        assert records[0].name == "Vorrat"
        assert records[0].use_dishes is False
