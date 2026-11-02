"""Regression tests for uniform category, label, and chip scopes."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _database_module():
    package_name = "ha_list_manager_scope_test"
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


def _list(database, name="Einkauf"):
    return database._create_list(
        name, "shopping", None, "local", None, "specific", True, True, True
    )


def test_navigation_favorites_are_isolated_per_home_assistant_user() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "favorites.db"
        )
        database._initialize()

        first = database._set_user_favorite(
            "user-a", "categories", "specific", None, True
        )
        assert len(first) == 1
        category_favorite = database._set_user_favorite(
            "user-a", "categories", "products", "category-id", True
        )
        assert [entry["position"] for entry in category_favorite] == [0, 1]
        assert database._set_user_favorite(
            "user-a", "categories", "specific", None, True
        ) == category_favorite
        assert database._list_user_favorites("user-b") == []

        database._set_user_favorite("user-b", "labels", "global", None, True)
        assert len(database._list_user_favorites("user-a")) == 2
        assert database._list_user_favorites("user-b")[0]["section"] == "labels"
        remaining = database._set_user_favorite(
            "user-a", "categories", "specific", None, False
        )
        assert len(remaining) == 1
        assert remaining[0]["target_id"] == "category-id"


def test_all_content_types_resolve_list_before_type_before_global() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "scopes.db"
        )
        database._initialize()
        target = _list(database)
        global_category = database._create_category(
            "Getränke", "global", None, None, None, "#111111", None
        )
        type_category = database._create_category(
            "Getränke", "list_type", "shopping", None, None, "#222222", None
        )
        list_category = database._create_category(
            "Getränke", "list", None, target.id, None, "#333333", None
        )
        global_label = database._create_label(
            "Kühl", None, "#111111", "global", None, None
        )
        database._create_label("Kühl", None, "#222222", "list_type", "shopping", None)
        list_label = database._create_label(
            "Kühl", None, "#333333", "list", None, target.id
        )
        global_chip = database._create_chip(
            "Milch", "#111111", "global", None, None, None
        )
        database._create_chip("Milch", "#222222", "list_type", "shopping", None, None)
        list_chip = database._create_chip(
            "Milch", "#333333", "list", None, target.id, None
        )

        assert [entry.id for entry in database._list_categories(target.id)] == [list_category.id]
        assert [entry.id for entry in database._list_labels(target.id)] == [list_label.id]
        assert [entry.id for entry in database._list_chips(target.id)] == [list_chip.id]

        database._update_list(
            target.id, None, None, None, module._UNSET, None,
            False, False, False, False, None, False, False, False,
        )
        assert database._list_categories(target.id)[0].id == list_category.id
        assert database._list_labels(target.id)[0].id == list_label.id
        assert database._list_chips(target.id)[0].id == list_chip.id
        assert global_category.id != type_category.id
        assert global_label.id != list_label.id
        assert global_chip.id != list_chip.id


def test_disabling_scopes_reassigns_or_removes_concrete_item_assignments() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "impact.db"
        )
        database._initialize()
        target = _list(database)
        global_category = database._create_category(
            "Getränke", "global", None, None, None, None, None
        )
        replacement_category = database._create_category(
            "Getränke", "list", None, target.id, None, None, None
        )
        removed_category = database._create_category(
            "Obst", "global", None, None, None, None, None
        )
        global_label = database._create_label(
            "Kühl", None, None, "global", None, None
        )
        replacement_label = database._create_label(
            "Kühl", None, None, "list", None, target.id
        )
        removed_label = database._create_label(
            "Bio", None, None, "global", None, None
        )
        first = database._create_item(
            target.id, "Milch", None, 1, global_category.id, None, None,
            [global_label.id], None, None,
        )
        second = database._create_item(
            target.id, "Äpfel", None, 1, removed_category.id, None, None,
            [removed_label.id], None, None,
        )

        impact = database._preview_list_scope_changes(
            target.id, False, True, False, True, True, True
        )
        assert impact["category_reassigned"] == 1
        assert impact["category_cleared"] == 1
        assert impact["label_reassigned"] == 1
        assert impact["label_removed"] == 1

        try:
            database._update_list(
                target.id, None, None, None, module._UNSET, None,
                False, True, False, True, None, True, True, False,
            )
        except module.ScopeChangeConfirmationRequired:
            pass
        else:
            raise AssertionError("destructive scope update must require confirmation")

        database._update_list(
            target.id, None, None, None, module._UNSET, None,
            False, True, False, True, None, True, True, True,
        )
        first_after = database._get_item(first.id)
        second_after = database._get_item(second.id)
        assert first_after.category_id == replacement_category.id
        assert [label.id for label in first_after.labels] == [replacement_label.id]
        assert second_after.category_id is None
        assert second_after.labels == ()



def test_product_categories_resolve_by_list_then_type_then_global_and_keep_dynamic_items() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "product-categories.db"
        )
        database._initialize()
        shopping = _list(database, "Wocheneinkauf")
        inventory = database._create_list(
            "Keller", "inventory", None, "local", None, "specific",
            True, True, True,
        )
        global_category = database._create_category(
            "Alkoholische Getränke", "global", None, None, None, None, None
        )
        shopping_type = database._create_category(
            "Getränke", "list_type", "shopping", None, None, None, None
        )
        inventory_type = database._create_category(
            "Getränke im Keller", "list_type", "inventory", None, None, None, None
        )
        shopping_list = database._create_category(
            "Hinten links", "list", None, shopping.id, None, None, None
        )
        product = database._create_product(
            None, "Augustiner", None, None, None, None, None, "manual", [],
            [global_category.id, shopping_type.id, inventory_type.id, shopping_list.id],
        )

        shopping_item = database._create_item(
            shopping.id, product.name, None, 1, None, None, None, [], product.id, None
        )
        inventory_entry = database._create_inventory_entry(
            inventory.id, product.id, 1, None, None, None, False
        )
        dynamic = database._create_item(
            shopping.id, "Freier Artikel", None, 1, None, "Dynamisch", None, [], None, None
        )

        assert shopping_item.category_id == shopping_list.id
        assert inventory_entry.category_id == inventory_type.id
        assert dynamic.category_id is None
        assert dynamic.category == "Dynamisch"
        assert len(product.category_assignments) == 4

        database._delete_category(shopping_list.id)
        assert database._get_item(shopping_item.id).category_id == shopping_type.id
        with database._connect() as connection:
            impact = database._scope_change_impact(
                connection, shopping.id,
                True, False, True, True, True, True,
                apply=True,
            )
        assert impact["category_reassigned"] == 1
        assert database._get_item(shopping_item.id).category_id == global_category.id


def test_global_product_category_uses_same_named_list_category() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "same-name-product-category.db"
        )
        database._initialize()
        shopping = _list(database, "Einkaufslisten Test")
        global_category = database._create_category(
            "Getränke", "global", None, None, "mdi:liquor", "#0096ff", None
        )
        list_category = database._create_category(
            "Getränke", "list", None, shopping.id,
            "mdi:bottle-soda-outline", "#0432ff", None,
        )
        product = database._create_product(
            None, "Bier", None, None, None, None, None, "manual", [],
            [global_category.id],
        )

        item = database._create_item(
            shopping.id, product.name, None, 1, None, None, None, [],
            product.id, None,
        )

        assert item.category_id == list_category.id
        assert item.category == "Getränke"


def test_product_rejects_two_category_assignments_for_the_same_context() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "product-category-conflict.db"
        )
        database._initialize()
        first = database._create_category(
            "Getränke", "global", None, None, None, None, None
        )
        second = database._create_category(
            "Lebensmittel", "global", None, None, None, None, None
        )
        try:
            database._create_product(
                None, "Produkt", None, None, None, None, None, "manual", [],
                [first.id, second.id],
            )
        except ValueError as error:
            assert "Pro Bereich" in str(error)
        else:
            raise AssertionError("two global assignments must be rejected")


def test_list_category_manager_warns_before_move_and_synchronizes_existing_items() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "category-manager.db"
        )
        database._initialize()
        shopping = _list(database, "Einkaufslisten Test")
        global_category = database._create_category(
            "Lebensmittel", "global", None, None, None, None, None
        )
        first = database._create_category(
            "Getränke", "list", None, shopping.id, None, None, None
        )
        second = database._create_category(
            "Angebote", "list", None, shopping.id, None, None, None
        )
        product = database._create_product(
            None, "Bier", None, "Marke 1", None, None, None, "manual", [],
            [global_category.id, first.id],
        )
        item = database._create_item(
            shopping.id, product.name, None, 1, None, None, None, [],
            product.id, None,
        )

        original_products = database._list_products(None, None)
        original_item = database._get_item(item.id)
        for replace_existing in (False, True):
            unchanged, current, changed, list_type = database._set_product_list_category(
                product.id, shopping.id, first.id, replace_existing
            )
            assert changed is False
            assert current == first
            assert list_type == "shopping"
            assert unchanged == original_products[0]
            assert database._list_products(None, None) == original_products
            assert database._get_item(item.id) == original_item

        unchanged, conflict, changed, list_type = database._set_product_list_category(
            product.id, shopping.id, second.id, False
        )
        assert changed is False
        assert conflict.id == first.id
        assert list_type == "shopping"
        assert first.id in [assignment.category_id for assignment in unchanged.category_assignments]
        assert database._get_item(item.id).category_id == first.id

        moved, previous, changed, _ = database._set_product_list_category(
            product.id, shopping.id, second.id, True
        )
        assert changed is True
        assert previous.id == first.id
        assert second.id in [assignment.category_id for assignment in moved.category_assignments]
        assert first.id not in [assignment.category_id for assignment in moved.category_assignments]
        assert database._get_item(item.id).category_id == second.id

        removed, previous, changed, _ = database._set_product_list_category(
            product.id, shopping.id, None, False
        )
        assert changed is True
        assert previous.id == second.id
        assert second.id not in [assignment.category_id for assignment in removed.category_assignments]
        assert database._get_item(item.id).category_id == global_category.id


def test_recent_products_are_limited_and_sorted_by_last_update() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "recent-products.db"
        )
        database._initialize()
        first = database._create_product(
            None, "Alt", None, None, None, None, None, "manual", [], []
        )
        second = database._create_product(
            None, "Mittel", None, None, None, None, None, "manual", [], []
        )
        third = database._create_product(
            None, "Neu", None, None, None, None, None, "manual", [], []
        )
        with database._connect() as connection:
            connection.execute(
                "UPDATE products SET updated_at = ? WHERE id = ?",
                ("2026-01-01T00:00:00+00:00", first.id),
            )
            connection.execute(
                "UPDATE products SET updated_at = ? WHERE id = ?",
                ("2026-01-02T00:00:00+00:00", second.id),
            )
            connection.execute(
                "UPDATE products SET updated_at = ? WHERE id = ?",
                ("2026-01-03T00:00:00+00:00", third.id),
            )

        assert [product.name for product in database._list_recent_products(2)] == [
            "Neu", "Mittel"
        ]


def test_category_rules_classify_new_items_below_product_and_manual_assignments() -> None:
    module = _database_module()
    with tempfile.TemporaryDirectory() as directory:
        database = module.HaListManagerDatabase(
            types.SimpleNamespace(), Path(directory) / "category-rules.db"
        )
        database._initialize()
        shopping = _list(database, "Einkaufslisten Test")
        global_vegetables = database._create_category(
            "Gemüse", "global", None, None, None, None, None
        )
        list_vegetables = database._create_category(
            "Gemüse", "list", None, shopping.id, None, None, None
        )
        exact_category = database._create_category(
            "Angebot", "list_type", "shopping", None, None, None, None
        )
        global_exact_category = database._create_category(
            "Global exakt", "global", None, None, None, None, None
        )
        product_category = database._create_category(
            "Getränke", "global", None, None, None, None, None
        )
        manual_category = database._create_category(
            "Manuell", "list", None, shopping.id, None, None, None
        )

        rules = database._replace_category_rules(
            global_vegetables.id, ["Tomaten*", "tomaten*", " Gurke* "]
        )
        assert [rule["pattern"] for rule in rules] == ["Tomaten*", "Gurke*"]
        database._replace_category_rules(
            exact_category.id, ["Tomaten Spezial", "Bananen*"]
        )
        database._replace_category_rules(global_exact_category.id, ["Bananen Bio"])

        # The same text may intentionally be overridden in a more specific
        # scope, but it must not point to two categories in the same list.
        database._replace_category_rules(list_vegetables.id, ["Bananen*"])
        try:
            database._replace_category_rules(manual_category.id, ["bananen*"])
        except ValueError as error:
            assert "überschneidet" in str(error)
            assert "Gemüse" in str(error)
        else:
            raise AssertionError("duplicate rules in one list must be rejected")
        try:
            database._replace_category_rules(
                manual_category.id, ["Senf*", "Bananen", "Ketchup*"]
            )
        except ValueError as error:
            assert "Bananen" in str(error)
            assert "Bananen*" in str(error)
            assert "Gemüse" in str(error)
        else:
            raise AssertionError("overlapping rules in one list must be rejected")
        assert database._list_category_rules(manual_category.id) == []
        assert database._category_rules_overlap("Bananen", "Bananen*")
        assert database._category_rules_overlap("Bananen*", "*Bananen*")
        assert database._category_rules_overlap("*Tomaten", "T*en")
        assert not database._category_rules_overlap("Bananen*", "Apfel*")
        assert database._resolve_category_rule(
            shopping.id, "Bananen Bio"
        ).id == list_vegetables.id

        wildcard_item = database._create_item(
            shopping.id, "Tomaten Cherry", None, 1, None, None, None, [], None, None
        )
        exact_item = database._create_item(
            shopping.id, "Tomaten Spezial", None, 1, None, None, None, [], None, None
        )
        assert wildcard_item.category_id == list_vegetables.id
        assert exact_item.category_id == exact_category.id

        product = database._create_product(
            None, "Tomaten Saft", None, None, None, None, None, "manual", [],
            [product_category.id],
        )
        product_item = database._create_item(
            shopping.id, product.name, None, 1, None, None, None, [], product.id, None
        )
        manual_item = database._create_item(
            shopping.id, "Tomaten Dose", None, 1, manual_category.id, None, None,
            [], None, None,
        )
        dynamic_item = database._create_item(
            shopping.id, "Tomaten Passiert", None, 1, None, "Eigene Kategorie",
            None, [], None, None,
        )
        assert product_item.category_id == product_category.id
        assert manual_item.category_id == manual_category.id
        assert dynamic_item.category_id is None
        assert dynamic_item.category == "Eigene Kategorie"

        database._delete_category(global_vegetables.id)
        with database._connect() as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM category_rules WHERE category_id = ?",
                (global_vegetables.id,),
            ).fetchone()[0] == 0
