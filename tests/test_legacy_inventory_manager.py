"""The inventory import retains the preview/backup boundary and human explanations."""
import asyncio
from copy import deepcopy
import json

import pytest
import yaml

from test_legacy_import import environment, source_item
from test_legacy_import_manager import coordinator


INVENTORY = """type: custom:ha-shopping-list-improved
entity: todo.groceries
mode: inventory
title: Pantry import
chips: Milk, Water
categories:
  - name: Drinks
    icon: mdi:bottle-soda
    bgcolor: darkblue
    items: [Milk, Water]
ean_database_entity: todo.old_ean_database
ean_transfer_mode: send
ean_transfer_default_minimum_stock: 6
notify_on_change: true
"""


def test_inventory_preview_apply_preserves_source_and_creates_only_generic_stock(coordinator):
    async def scenario():
        coordinator.sources["todo.groceries"]["items"] = [
            source_item("one", "@Drinks@ Milk (3)", description=json.dumps({
                "schema": 1, "type": "isl_inventory_variant", "ean": "4062139025398", "groupMinimumStock": 6,
            })),
            source_item("two", "@Drinks@ Milk (2)", status="completed", description=json.dumps({
                "schema": 1, "type": "isl_inventory_variant", "ean": "8715700117140",
            })),
            source_item("zero", "@Drinks@ Water (0)", status="completed"),
        ]
        original = deepcopy(coordinator.sources)
        draft = await coordinator.manager.analyze("admin-a", INVENTORY)
        choices = [{"card_id": draft["cards"][0]["id"], "entity_id": "todo.groceries", "target_name": "Pantry import"}]
        preview = await coordinator.manager.preview("admin-a", draft["draft_id"], choices)
        assert preview["lists"][0]["list_type"] == "inventory"
        assert preview["counts"]["products"] == 2
        assert preview["counts"]["source_items"] == 3
        assert preview["counts"]["hidden"] == 1
        assert not coordinator.db._list_lists()
        for warning in preview["warnings"]:
            assert warning["group"] and warning["reason"] and warning["message_key"]
            assert "card-1" not in warning["message"]
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        record = result["lists"][0]
        assert len(record["product_ids"]) == 2
        entries = coordinator.db._list_inventory(record["list_id"])
        assert sorted((entry.product.name, entry.stock, entry.hidden) for entry in entries) == [
            ("Milk", 5, False), ("Water", 0, True),
        ]
        assert all(entry.minimum_stock is None for entry in entries)
        assert not coordinator.db._list_inventory_groups(record["list_id"])
        assert not coordinator.db._list_items(record["list_id"])
        assert {entry.product_id for entry in entries} == set(record["product_ids"])
        assert all(entry.product.ean is None for entry in entries)
        config, = [yaml.safe_load(value) for value in result["cards_yaml"]]
        assert config["type"] == "custom:ha-list-manager-inventory-card"
        assert config["list_id"] == record["list_id"]
        assert coordinator.sources == original
        assert len(coordinator.events) == 1
        backups = coordinator.hass.data[coordinator.manager_module.MANAGER_KEY]
        assert len(await backups.listing()) == 1
        replay = await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert replay["lists"] == result["lists"] and replay["replayed"] is True
        assert len(coordinator.db._list_products(None, None)) == 2
    asyncio.run(scenario())


def test_old_shopping_freezer_can_explicitly_become_inventory(coordinator):
    async def scenario():
        draft = await coordinator.manager.analyze("admin-a", INVENTORY.replace("mode: inventory\n", ""))
        assert draft["cards"][0]["mode"] == "shopping"
        preview = await coordinator.manager.preview("admin-a", draft["draft_id"], [{
            "card_id": draft["cards"][0]["id"], "entity_id": "todo.groceries",
            "target_name": "Freezer", "list_type": "inventory",
        }])
        assert preview["lists"][0]["list_type"] == "inventory"
        assert preview["counts"]["products"] == 2
        # The explanation must describe the final selected type, not a stale shopping default.
        camera = INVENTORY.replace("mode: inventory\n", "") + "show_qrscan_button: true\n"
        second = await coordinator.manager.analyze("admin-a", camera)
        other = await coordinator.manager.preview("admin-a", second["draft_id"], [{
            "card_id": second["cards"][0]["id"], "entity_id": "todo.groceries",
            "target_name": "Second freezer", "list_type": "inventory",
        }])
        warning = next(row for row in other["warnings"] if row.get("field") == "show_qrscan_button")
        assert warning["source_name"] == "Pantry import"
        assert warning["group"] == "appearance"
    asyncio.run(scenario())


def test_empty_inventory_import_needs_no_source_and_creates_no_products(coordinator):
    async def scenario():
        document = INVENTORY.replace("entity: todo.groceries\n", "")
        draft = await coordinator.manager.analyze("admin-a", document)
        preview = await coordinator.manager.preview("admin-a", draft["draft_id"], [{
            "card_id": draft["cards"][0]["id"], "target_name": "Empty inventory",
        }], include_items=False)
        result = await coordinator.manager.apply("admin-a", preview["plan_id"])
        assert preview["counts"]["products"] == 0
        assert result["lists"][0]["product_ids"] == []
        assert not coordinator.calls
        assert not coordinator.db._list_inventory(result["lists"][0]["list_id"])
        assert not coordinator.db._list_products(None, None)
    asyncio.run(scenario())


@pytest.mark.parametrize("requested", ["inventory", "shopping", None, [], {}])
def test_todo_cards_cannot_accidentally_create_product_inventory(coordinator, requested):
    async def scenario():
        draft = await coordinator.manager.analyze("admin-a", INVENTORY.replace("mode: inventory", "mode: todo"))
        with pytest.raises(coordinator.module.LegacyImportError) as caught:
            await coordinator.manager.preview("admin-a", draft["draft_id"], [{
                "card_id": draft["cards"][0]["id"], "entity_id": "todo.groceries",
                "target_name": "Not inventory", "list_type": requested,
            }])
        assert caught.value.code == "invalid_import_type"
        assert not coordinator.calls and not coordinator.db._list_products(None, None)
    asyncio.run(scenario())


def test_warning_messages_use_card_title_and_explain_backend_settings(coordinator):
    async def scenario():
        document = INVENTORY + "list_script_entity: script.example\nnotify_entity: notify.example\nlonglived_token: FAKE_NOT_A_VALID_TOKEN\n"
        draft = await coordinator.manager.analyze("admin-a", document)
        assert draft["warnings"]
        assert "FAKE_NOT_A_VALID_TOKEN" not in json.dumps(draft)
        assert all(row["source_name"] == "Pantry import" for row in draft["warnings"])
        for field in ("list_script_entity", "notify_entity"):
            warning = next(row for row in draft["warnings"] if row.get("field") == field)
            assert warning["group"] == "backend"
        assert next(row for row in draft["warnings"] if row.get("field") == "longlived_token")["group"] == "security"
    asyncio.run(scenario())
