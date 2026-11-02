"""Legacy-list import contracts exercised with the real parser and SQLite.

Only HA's executor and event bus are replaced. The fixtures contain invented
credentials so accidental disclosure can be detected without copying live data.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import importlib
import json
import sqlite3
import sys
from types import SimpleNamespace

import pytest

from test_inventory_restock import _database_module


FAKE_SECRET = "FAKE_IMPORT_SECRET_MUST_NEVER_BE_RETURNED"
BASE_CARD = """type: custom:ha-shopping-list-improved
entity: todo.groceries
title: Groceries
mode: shopping
categories:
  - name: Drinks
    icon: mdi:bottle-soda
    bgcolor: darkblue
    items: [Milk, Cola]
  - name: Fruit
    bgcolor: '#247645'
    items: [Apples]
chips: >-
  Bread, Butter; Milk
"""


@pytest.fixture
def environment(tmp_path):
    database_module = _database_module()
    package = database_module.__name__.rsplit(".", 1)[0]
    sys.modules.pop(package + ".legacy_import", None)
    legacy = importlib.import_module(package + ".legacy_import")
    events = []

    async def executor(function, *args):
        return function(*args)

    hass = SimpleNamespace(
        config=SimpleNamespace(language="en"),
        async_add_executor_job=executor,
        bus=SimpleNamespace(async_fire=lambda *args: events.append(args)),
    )
    db = database_module.HaListManagerDatabase(hass, tmp_path / "legacy.db")
    db._initialize()
    return SimpleNamespace(module=legacy, db=db, database_module=database_module,
                           events=events, hass=hass)


def source_item(uid, summary, *, status="needs_action", description=None, due=None):
    return {"uid": uid, "summary": summary, "status": status,
            "description": description, "due": due}


def build(environment, yaml=BASE_CARD, items=None, *, files=None, selections=None):
    parsed = environment.module.parse_legacy_configs(yaml, files)
    source = {"todo.groceries": [] if items is None else items}
    return environment.module.build_import_plan(parsed, source, selections)


def apply(environment, plan, import_id="import-test-1", database=None):
    return asyncio.run((database or environment.db).async_import_legacy(plan, import_id))


def table_counts(db):
    tables = ("lists", "list_items", "categories", "category_rules", "chips",
              "products", "inventory_entries", "inventory_groups",
              "list_script_settings", "notification_pending_batches")
    with db._connect() as connection:
        return {name: connection.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
                for name in tables}


def test_folded_yaml_chips_and_named_categories_are_parsed(environment):
    parsed = environment.module.parse_legacy_configs(BASE_CARD)
    assert len(parsed["cards"]) == 1
    card = parsed["cards"][0]
    assert (card["source_entity"], card["mode"], card["target_name"]) == (
        "todo.groceries", "shopping", "Groceries")
    plan = environment.module.build_import_plan(parsed, {"todo.groceries": []})
    assert [chip["name"] for chip in plan["lists"][0]["chips"]] == ["Bread", "Butter", "Milk"]
    assert {chip["chip_kind"] for chip in plan["lists"][0]["chips"]} == {"entry"}
    assert card["categories"][0]["color"] == "#00008B"
    assert card["categories"][0]["icon"] == "mdi:bottle-soda"
    assert card["categories"][0]["rules"] == ["Milk", "Cola"]


def test_missing_mode_means_shopping_even_for_a_freezer_name(environment):
    parsed = environment.module.parse_legacy_configs("""type: custom:ha-shopping-list-improved
entity: todo.freezer
title: Freezer contents
categories:
  - name: Vegetables
    bgcolor: green
""")
    assert parsed["cards"][0]["mode"] == "shopping"
    assert parsed["cards"][0]["categories"][0]["color"] == "#008000"


@pytest.mark.parametrize("value, expected", [
    ("red", "#FF0000"), ("green", "#008000"), ("darkblue", "#00008B"),
    ("#abc", "#AABBCC"), ("#4169E1", "#4169E1"), ("#247645", "#247645"),
])
def test_supported_css_colors_keep_their_meaning(environment, value, expected):
    parsed = environment.module.parse_legacy_configs(f"""type: custom:ha-shopping-list-improved
entity: todo.groceries
categories:
  - name: Example
    bgcolor: '{value}'
""")
    assert parsed["cards"][0]["categories"][0]["color"] == expected


@pytest.mark.parametrize("value", ["#aaaa", "#12345680", "not-a-color"])
def test_unrepresentable_colors_are_reported_not_silently_flattened(environment, value):
    parsed = environment.module.parse_legacy_configs(f"""type: custom:ha-shopping-list-improved
entity: todo.groceries
categories:
  - name: Transparent example
    bgcolor: '{value}'
""")
    assert parsed["cards"][0]["categories"][0]["color"] is None
    assert parsed["warnings"] or parsed["cards"][0]["warnings"]


def test_credentials_and_unsupported_source_values_never_enter_the_draft(environment):
    yaml = BASE_CARD + f"""
longlived_token: {FAKE_SECRET}
notify_entity: notify.private_example
ean_database_entity: todo.product_records
ean_transfer_entity: todo.old_transfer_queue
ean_transfer_mode: receive
list_script_entity: script.private_example
local_chips: true
own_css: 'body {{ color: red; }}'
"""
    parsed = environment.module.parse_legacy_configs(yaml)
    serialized = json.dumps(parsed)
    assert FAKE_SECRET not in serialized
    assert "notify.private_example" not in serialized
    assert "script.private_example" not in serialized
    # Internal excluded-source IDs may be retained to prevent their selection;
    # they must not become card options or imported data.
    assert "todo.product_records" not in json.dumps(parsed["cards"])
    assert "todo.old_transfer_queue" not in json.dumps(parsed["cards"])
    assert "body { color: red; }" not in serialized
    assert parsed["warnings"] or parsed["cards"][0]["warnings"]
    plan = environment.module.build_import_plan(parsed, {"todo.groceries": []})
    assert FAKE_SECRET not in json.dumps(plan)
    assert "todo.product_records" not in json.dumps(plan)
    assert "todo.old_transfer_queue" not in json.dumps(plan)
    apply(environment, plan)
    with environment.db._connect() as connection:
        stored = "\n".join(connection.iterdump())
    assert FAKE_SECRET not in stored
    assert "notify.private_example" not in stored
    assert "script.private_example" not in stored


def test_malformed_yaml_does_not_echo_secret_lines_in_errors(environment):
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.parse_legacy_configs(
            f"longlived_token: {FAKE_SECRET}\ncategories: [\n")
    assert FAKE_SECRET not in str(caught.value)
    assert FAKE_SECRET not in json.dumps(caught.value.values)


def test_unsafe_yaml_tags_cannot_execute_python(environment, tmp_path):
    marker = tmp_path / "must-not-exist"
    yaml = f'!!python/object/apply:pathlib.Path.touch ["{marker}"]'
    with pytest.raises(environment.module.LegacyImportError):
        environment.module.parse_legacy_configs(yaml)
    assert not marker.exists()


@pytest.mark.parametrize("yaml", ["", "[]", "null", "42", "{type: unrelated, entity: todo.groceries}"])
def test_invalid_card_documents_are_rejected(environment, yaml):
    with pytest.raises(environment.module.LegacyImportError):
        environment.module.parse_legacy_configs(yaml)


@pytest.mark.parametrize("field", ["mode: []", "mode: {unexpected: value}",
                                   "entity: [todo.groceries]", "chips: [{name: Milk}]"])
def test_malformed_field_types_raise_a_controlled_import_error(environment, field):
    yaml = "type: custom:ha-shopping-list-improved\nentity: todo.groceries\n" + field
    if field.startswith("entity:"):
        yaml = "type: custom:ha-shopping-list-improved\n" + field
    with pytest.raises(environment.module.LegacyImportError):
        environment.module.parse_legacy_configs(yaml)


def test_inventory_card_is_recognized_as_a_simplified_inventory_import(environment):
    parsed = environment.module.parse_legacy_configs("""type: custom:ha-shopping-list-improved
entity: todo.inventory
mode: inventory
""")
    assert parsed["cards"][0]["mode"] == "inventory"
    assert "todo.inventory" not in parsed["excluded_sources"]


def test_mixed_import_recognizes_inventory_but_keeps_freezer_shopping_by_default(environment):
    parsed = environment.module.parse_legacy_configs("""- type: custom:ha-shopping-list-improved
  entity: todo.inventory
  mode: inventory
- type: custom:ha-shopping-list-improved
  entity: todo.freezer
  title: Freezer contents
""")
    assert [(card["source_entity"], card["mode"]) for card in parsed["cards"]] == [
        ("todo.inventory", "inventory"), ("todo.freezer", "shopping")]
    assert "todo.inventory" not in parsed["excluded_sources"]
    assert "todo.freezer" not in parsed["excluded_sources"]
    plan = environment.module.build_import_plan(parsed, {
        "todo.inventory": [source_item("zero", "Milk (0)")],
        "todo.freezer": [source_item("one", "Peas")],
    })
    assert plan["lists"][0]["items"][0]["stock"] == 0
    assert plan["lists"][1]["items"][0]["name"] == "Peas"


def test_legacy_summary_metadata_and_dynamic_category_are_preserved(environment):
    items = [
        source_item("a", "[[003]] @Fruit@ 2× Apples [[ISL:OFFER_ONLY]]",
                    description="Choose ripe fruit."),
        source_item("b", "@Weekend@ Bread (4)", status="completed"),
        source_item("c", "Milk"),
    ]
    before = deepcopy(items)
    plan = build(environment, items=items)
    actual = {item["source_uid"]: item for item in plan["lists"][0]["items"]}
    assert actual["a"]["name"] == "Apples"
    assert actual["a"]["quantity"] == 2
    assert actual["a"]["category"] == "Fruit" and actual["a"]["category_saved"]
    assert actual["a"]["offer_only"] is True
    assert actual["a"]["description"] == "Choose ripe fruit."
    assert actual["b"]["name"] == "Bread" and actual["b"]["quantity"] == 4
    assert actual["b"]["category"] == "Weekend"
    assert actual["b"]["category_saved"] is False
    assert actual["b"]["completed"] is True
    assert actual["c"]["category"] == "Drinks"
    assert items == before, "Previewing must not rewrite HA response data"


def test_category_rules_are_exact_case_insensitive_and_first_match_wins(environment):
    yaml = """type: custom:ha-shopping-list-improved
entity: todo.groceries
title: Groceries
categories:
  - name: Fish
    items: [Salmon, 'Milk*']
  - name: Chilled
    items: [salmon]
"""
    plan = build(environment, yaml, [source_item("one", "SALMON"),
                                    source_item("two", "Milk chocolate")])
    items = {item["source_uid"]: item for item in plan["lists"][0]["items"]}
    assert items["one"]["category"] == "Fish"
    assert not items["two"]["category"], "Legacy exact rules must not become wildcard rules"
    assert plan["warnings"] or environment.module.parse_legacy_configs(yaml)["warnings"]


def test_todo_dates_description_recurrence_and_completion_are_separate(environment):
    yaml = """type: custom:ha-shopping-list-improved
entity: todo.tasks
title: Maintenance
mode: todo
chips: [Check batteries]
categories:
  - name: Devices
    items: [Check radio]
"""
    sources = {"todo.tasks": [
        source_item("dated", "@Devices@ Check radio {{7D}}", due="2026-11-07",
                    description="Use the test switch."),
        source_item("timed", "Check alarm {{1M}}", status="completed",
                    due="2026-11-07T10:00:00+01:00"),
    ]}
    parsed = environment.module.parse_legacy_configs(yaml)
    plan = environment.module.build_import_plan(parsed, sources)
    listing = plan["lists"][0]
    assert listing["list_type"] == "todo"
    assert listing["chips"][0]["chip_kind"] == "todo_template"
    dated, timed = listing["items"]
    assert (dated["name"], dated["due_at"], dated["description"]) == (
        "Check radio", "2026-11-07", "Use the test switch.")
    assert (dated["recurrence_interval"], dated["recurrence_unit"]) == (7, "D")
    assert timed["completed"] is True
    assert timed["due_at"] == "2026-11-07T10:00:00+01:00"
    assert (timed["recurrence_interval"], timed["recurrence_unit"]) == (1, "M")
    assert all(item["quantity"] == 1 and item["offer_only"] is False for item in listing["items"])


def test_two_views_of_one_source_import_one_list_and_one_set_of_entries(environment):
    yaml = """- type: custom:ha-shopping-list-improved
  entity: todo.groceries
  title: Kitchen
- type: custom:ha-shopping-list-improved
  entity: todo.groceries
  title: Mobile shopping
"""
    parsed = environment.module.parse_legacy_configs(yaml)
    selections = [{"card_id": card["id"], "entity_id": "todo.groceries",
                   "target_name": "Groceries"} for card in parsed["cards"]]
    plan = environment.module.build_import_plan(parsed, {
        "todo.groceries": [source_item("one", "Milk")],
    }, selections)
    assert len(plan["lists"]) == 1
    assert len(plan["lists"][0]["items"]) == 1
    assert len(plan["lists"][0]["cards"]) == 2


@pytest.mark.parametrize("second_name", ["Pantry", "groceries"])
def test_shared_source_cannot_silently_choose_between_different_target_names(environment, second_name):
    parsed = environment.module.parse_legacy_configs("""- type: custom:ha-shopping-list-improved
  entity: todo.groceries
- type: custom:ha-shopping-list-improved
  entity: todo.groceries
""")
    selections = [{"card_id": card["id"], "entity_id": "todo.groceries", "target_name": name}
                  for card, name in zip(parsed["cards"], ["Groceries", second_name])]
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.build_import_plan(parsed, {"todo.groceries": []}, selections)
    assert caught.value.code == "source_target_conflict"
    assert not environment.db._list_lists()


def test_shared_source_accepts_the_same_target_name_after_trimming_whitespace(environment):
    parsed = environment.module.parse_legacy_configs("""- type: custom:ha-shopping-list-improved
  entity: todo.groceries
- type: custom:ha-shopping-list-improved
  entity: todo.groceries
""")
    selections = [{"card_id": card["id"], "entity_id": "todo.groceries", "target_name": name}
                  for card, name in zip(parsed["cards"], [" Groceries ", "Groceries"])]
    plan = environment.module.build_import_plan(parsed, {"todo.groceries": []}, selections)
    assert len(plan["lists"]) == 1
    assert plan["lists"][0]["name"] == "Groceries"


def test_source_and_target_can_be_selected_without_mutating_the_draft(environment):
    parsed = environment.module.parse_legacy_configs(BASE_CARD)
    before = deepcopy(parsed)
    selections = [{"card_id": parsed["cards"][0]["id"],
                   "entity_id": "todo.other", "target_name": "Imported groceries"}]
    plan = environment.module.build_import_plan(parsed, {
        "todo.other": [source_item("one", "Milk")],
    }, selections)
    assert (plan["lists"][0]["source_entity"], plan["lists"][0]["name"]) == (
        "todo.other", "Imported groceries")
    assert parsed == before


def test_missing_source_response_is_not_treated_as_an_empty_list(environment):
    parsed = environment.module.parse_legacy_configs(BASE_CARD)
    with pytest.raises(environment.module.LegacyImportError):
        environment.module.build_import_plan(parsed, {})


@pytest.mark.parametrize("mode", ["shopping", "todo"])
@pytest.mark.parametrize("source", [None, "todo.missing_live_list"])
def test_configuration_only_plan_preserves_definitions_without_reading_entries(environment, mode, source):
    document = BASE_CARD.replace("mode: shopping", f"mode: {mode}")
    document = document.replace("entity: todo.groceries\n", "" if source is None else f"entity: {source}\n")
    parsed = environment.module.parse_legacy_configs(document)
    # Even if source data was supplied, the explicit option must leave it out.
    plan = environment.module.build_import_plan(parsed, {
        source: [source_item("ignored", "Do not copy me", status="completed")],
    }, include_items=False)
    listing, = plan["lists"]
    assert listing["source_entity"] == source
    assert listing["include_items"] is False
    assert listing["items"] == []
    assert listing["counts"]["items"] == listing["counts"]["completed"] == 0
    assert listing["categories"][0]["rules"] == ["Milk", "Cola"]
    assert [chip["name"] for chip in listing["chips"]] == ["Bread", "Butter", "Milk"]
    assert listing["chips"][0]["chip_kind"] == ("todo_template" if mode == "todo" else "entry")
    result = apply(environment, plan)
    list_id = result["lists"][0]["list_id"]
    assert environment.db._list_items(list_id) == []
    assert len(environment.db._list_categories(list_id)) == 2
    assert len(environment.db._list_chips(list_id)) == 3
    assert environment.db._resolve_category_rule(list_id, "Milk").name == "Drinks"
    counts = table_counts(environment.db)
    assert counts["products"] == counts["inventory_entries"] == counts["inventory_groups"] == 0
    assert counts["list_script_settings"] == counts["notification_pending_batches"] == 0
    assert environment.events == []


def test_configuration_only_cards_without_source_entities_are_separate_targets(environment):
    parsed = environment.module.parse_legacy_configs("""- type: custom:ha-shopping-list-improved
  title: Shopping template
  chips: Milk, Bread
- type: custom:ha-shopping-list-improved
  title: Task template
  mode: todo
  chips: Check batteries
""")
    plan = environment.module.build_import_plan(parsed, {}, include_items=False)
    assert [listing["name"] for listing in plan["lists"]] == ["Shopping template", "Task template"]
    assert [listing["source_entity"] for listing in plan["lists"]] == [None, None]
    assert plan["counts"]["lists"] == 2 and plan["counts"]["items"] == 0
    result = apply(environment, plan)
    assert len({listing["list_id"] for listing in result["lists"]}) == 2


def test_configuration_only_shared_source_is_still_imported_once(environment):
    parsed = environment.module.parse_legacy_configs("""- type: custom:ha-shopping-list-improved
  title: Shopping desktop
  entity: todo.not_installed_here
  chips: Milk
- type: custom:ha-shopping-list-improved
  title: Shopping mobile
  entity: todo.not_installed_here
  chips: Bread
""")
    choices = [{"card_id": card["id"], "target_name": "Imported shopping"} for card in parsed["cards"]]
    plan = environment.module.build_import_plan(parsed, {}, choices, include_items=False)
    listing, = plan["lists"]
    assert listing["source_entity"] == "todo.not_installed_here"
    assert listing["items"] == [] and len(listing["cards"]) == 2
    assert {chip["name"] for chip in listing["chips"]} == {"Milk", "Bread"}


@pytest.mark.parametrize("value", [None, 0, 1, "false", []])
def test_entry_import_option_requires_an_explicit_boolean(environment, value):
    parsed = environment.module.parse_legacy_configs(BASE_CARD)
    with pytest.raises(environment.module.LegacyImportError):
        environment.module.build_import_plan(parsed, {"todo.groceries": []}, include_items=value)


@pytest.mark.parametrize("name", ["Pineapple (can)", "Protein powder (500 g)", "Vitamin B12", "Yogurt 250 ml"])
def test_package_description_and_parenthesized_words_are_not_item_counts(environment, name):
    plan = build(environment, items=[source_item("one", name)])
    item = plan["lists"][0]["items"][0]
    assert item["name"] == name
    assert item["quantity"] == 1


@pytest.mark.parametrize("quantity", ["0× Milk", "Milk (0)"])
def test_zero_shopping_quantity_does_not_silently_become_one(environment, quantity):
    with pytest.raises(environment.module.LegacyImportError):
        build(environment, items=[source_item("one", quantity)])


@pytest.mark.parametrize("description", [
    '{"schema":1,"type":"isl_inventory_variant","ean":null}',
    '{"schema":1,"transferId":"old-operation","sourceEntity":"todo.source",'
    '"destinationEntity":"todo.target","operation":"shopping_add",'
    '"product":{"name":"Milk"},"ean":null,"quantity":1}',
])
def test_inventory_or_transfer_records_cannot_become_regular_shopping_entries(environment, description):
    try:
        plan = build(environment, items=[source_item("one", "Internal operation", description=description)])
    except environment.module.LegacyImportError:
        return  # Rejecting a wrong source altogether is also safe.
    assert not plan["lists"][0]["items"]
    assert plan["warnings"], "Skipped technical records must be visible in the preview"


def test_one_source_entity_cannot_be_interpreted_as_both_shopping_and_todo(environment):
    parsed = environment.module.parse_legacy_configs("""- type: custom:ha-shopping-list-improved
  entity: todo.shared
  mode: shopping
- type: custom:ha-shopping-list-improved
  entity: todo.shared
  mode: todo
""")
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.build_import_plan(parsed, {"todo.shared": []})
    assert caught.value.code == "source_mode_conflict"


def test_yaml_aliases_are_rejected_before_expansion(environment):
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.parse_legacy_configs("""type: custom:ha-shopping-list-improved
entity: todo.groceries
chips: &items [Bread, Milk]
categories: *items
""")
    assert caught.value.code == "yaml_reference"


def test_oversized_yaml_is_rejected_before_parsing(environment):
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.parse_legacy_configs("#" * (environment.module.MAX_YAML_BYTES + 1))
    assert caught.value.code == "yaml_too_large"


def test_card_and_entry_limits_are_enforced_before_database_writes(environment):
    document = "\n".join("- type: custom:ha-shopping-list-improved\n  entity: todo.groceries"
                          for _ in range(environment.module.MAX_CARDS + 1))
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.parse_legacy_configs(document)
    assert caught.value.code == "too_many_cards"
    parsed = environment.module.parse_legacy_configs(BASE_CARD)
    with pytest.raises(environment.module.LegacyImportError) as caught:
        environment.module.build_import_plan(parsed, {"todo.groceries": [
            source_item(str(index), "Milk") for index in range(environment.module.MAX_ITEMS + 1)
        ]})
    assert caught.value.code == "too_many_items"
    assert table_counts(environment.db)["lists"] == 0


def test_shopping_chip_metadata_is_cleaned_and_unrepresentable_parts_warn(environment):
    document = """type: custom:ha-shopping-list-improved
entity: todo.groceries
chips: ['@Drinks@ Water', '@Drinks@ 2× Cola [[ISL:OFFER_ONLY]]', '@Weekend@ Bread']
categories:
  - name: Drinks
"""
    plan = build(environment, document)
    listing = plan["lists"][0]
    assert [chip["name"] for chip in listing["chips"]] == ["Water", "Cola", "Bread"]
    assert listing["categories"][0]["rules"] == ["Water", "Cola"]
    assert any(warning["code"] == "chip_metadata" for warning in plan["warnings"])
    result = apply(environment, plan)
    list_id = result["lists"][0]["list_id"]
    assert environment.db._resolve_category_rule(list_id, "Water").name == "Drinks"
    assert environment.db._resolve_category_rule(list_id, "Sparkling Water") is None


def test_explicit_category_file_and_chip_file_are_parsed_without_network(environment):
    yaml = """type: custom:ha-shopping-list-improved
entity: todo.groceries
title: Groceries
category_file: /local/categories.txt
chip_file: /local/chips.txt
"""
    parsed = environment.module.parse_legacy_configs(yaml, {
        "/local/categories.txt": "[Drinks]\nicon=mdi:bottle-soda\nbgcolor=red\nitems=Milk, Cola\n",
        "/local/chips.txt": "Bread\nButter\n",
    })
    card = parsed["cards"][0]
    assert card["categories"][0]["name"] == "Drinks"
    assert card["categories"][0]["color"] == "#FF0000"
    plan = environment.module.build_import_plan(parsed, {"todo.groceries": []})
    assert [chip["name"] for chip in plan["lists"][0]["chips"]] == ["Bread", "Butter"]


def test_database_import_is_new_local_list_only_and_emits_no_automations(environment):
    plan = build(environment, items=[source_item("one", "Milk"),
                                   source_item("two", "@Weekend@ 2× Bread", status="completed")])
    result = apply(environment, plan)
    assert result["replayed"] is False
    listing = environment.db._get_list(result["lists"][0]["list_id"])
    assert listing.list_type == "shopping" and listing.provider == "local"
    assert listing.use_global_categories is False and listing.use_type_categories is False
    entries = environment.db._list_items(listing.id)
    assert {item.name: (item.quantity, item.completed) for item in entries} == {
        "Milk": (1, False), "Bread": (2, True)}
    categories = environment.db._list_categories(listing.id)
    assert {category.scope for category in categories} == {"list"}
    chips = environment.db._list_chips(listing.id)
    assert {chip.scope for chip in chips} == {"list"}
    counts = table_counts(environment.db)
    assert counts["products"] == counts["inventory_entries"] == counts["inventory_groups"] == 0
    assert counts["list_script_settings"] == counts["notification_pending_batches"] == 0
    assert environment.events == []


def test_double_apply_and_restart_do_not_create_a_second_list_or_entries(environment):
    plan = build(environment, items=[source_item("one", "Milk")])
    first = apply(environment, plan)
    before = table_counts(environment.db)
    second = apply(environment, plan)
    reopened = environment.database_module.HaListManagerDatabase(environment.hass, environment.db.path)
    reopened._initialize()
    third = apply(environment, plan, database=reopened)
    assert first["lists"] == second["lists"] == third["lists"]
    assert second["replayed"] is third["replayed"] is True
    assert table_counts(reopened) == before
    assert environment.events == []


def test_import_receipt_can_be_read_without_reapplying_or_reusing_for_another_plan(environment):
    assert asyncio.run(environment.db.async_get_legacy_import_result("import-test-1")) is None
    original = build(environment, items=[source_item("one", "Milk")])
    first = apply(environment, original)
    receipt = asyncio.run(environment.db.async_get_legacy_import_result("import-test-1"))
    assert receipt["lists"] == first["lists"] and receipt["replayed"] is True
    before = table_counts(environment.db)
    changed = build(environment, items=[source_item("one", "Butter")])
    with pytest.raises(environment.module.LegacyImportError) as caught:
        apply(environment, changed)
    assert caught.value.code == "import_changed"
    assert table_counts(environment.db) == before


def test_todo_import_persists_dates_intervals_and_templates_without_products(environment):
    yaml = """type: custom:ha-shopping-list-improved
entity: todo.groceries
title: Maintenance
mode: todo
chips: ['@Devices@ Check batteries {{7D}}']
categories:
  - name: Devices
    items: [Check radio]
"""
    plan = build(environment, yaml, [source_item(
        "one", "@Devices@ Check radio {{7D}}", due="2026-11-07",
        description="Use the test switch.", status="completed")])
    result = apply(environment, plan)
    list_id = result["lists"][0]["list_id"]
    entry, = environment.db._list_items(list_id)
    assert (entry.name, entry.due_at, entry.recurrence_interval,
            entry.recurrence_unit, entry.completed, entry.quantity) == (
        "Check radio", "2026-11-07", 7, "D", True, 1)
    assert entry.description == "Use the test switch." and entry.category_id
    chip, = environment.db._list_chips(list_id)
    assert chip.chip_kind == "todo_template"
    assert chip.name == "Check batteries"
    assert (chip.template_data["category_name"], chip.template_data["recurrence_interval"],
            chip.template_data["recurrence_unit"]) == ("Devices", 7, "D")
    assert chip.template_data["category_id"] == entry.category_id
    assert table_counts(environment.db)["products"] == 0


def test_database_failure_rolls_back_lists_definitions_and_import_receipt(environment):
    plan = build(environment, items=[source_item("one", "Milk"),
                                   source_item("two", "Fail item")])
    before = table_counts(environment.db)
    with environment.db._connect() as connection:
        connection.execute("""CREATE TRIGGER fail_import BEFORE INSERT ON list_items
                              WHEN NEW.name = 'Fail item'
                              BEGIN SELECT RAISE(ABORT, 'injected import failure'); END""")
    with pytest.raises(Exception):
        apply(environment, plan)
    assert table_counts(environment.db) == before
    assert environment.events == []
    with environment.db._connect() as connection:
        connection.execute("DROP TRIGGER fail_import")
    assert apply(environment, plan)["replayed"] is False


def test_import_does_not_merge_into_an_existing_target_name(environment):
    existing = environment.db._create_list("Groceries", "shopping", None, "local", None,
                                           "specific", True, True, True)
    environment.db._create_item(existing.id, "Original item", None, 7, None, None,
                                None, [], None, None)
    before = table_counts(environment.db)
    plan = build(environment, items=[source_item("one", "Imported item")])
    with pytest.raises((ValueError, sqlite3.IntegrityError,
                        environment.database_module.DuplicateListNameError)):
        apply(environment, plan)
    assert table_counts(environment.db) == before
    assert [(item.name, item.quantity) for item in environment.db._list_items(existing.id)] == [
        ("Original item", 7)]


INVENTORY_CARD = """type: custom:ha-shopping-list-improved
entity: todo.groceries
title: Imported pantry
mode: inventory
chips: Milk, Bread
categories:
  - name: Drinks
    bgcolor: green
    items: [Milk]
"""


def test_simplified_inventory_merges_exact_name_and_category_and_preserves_zero(environment):
    items = [
        source_item("one", "@Drinks@ 3× Milk", description=json.dumps({
            "schema": 1, "type": "isl_inventory_variant", "ean": "1111111111111",
            "groupMinimumStock": 8,
        })),
        source_item("two", "@Drinks@ milk (2)", description=json.dumps({
            "schema": 1, "type": "isl_inventory_variant", "ean": "2222222222222",
        })),
        source_item("zero", "Bread (0)"),
        source_item("other-category", "@Freezer@ Milk (4)"),
    ]
    before = deepcopy(items)
    plan = build(environment, INVENTORY_CARD, items)
    listing, = plan["lists"]
    milk, bread, other = listing["items"]
    assert (milk["name"], milk["stock"], milk["quantity"], milk["merged_count"]) == ("Milk", 5, 5, 2)
    assert milk["category"] == "Drinks" and milk["category_saved"]
    assert bread["stock"] == 0
    assert other["stock"] == 4 and other["category"] == "Freezer" and not other["category_saved"]
    assert listing["counts"]["products"] == 3
    assert listing["counts"]["source_items"] == 4 and listing["counts"]["merged"] == 1
    assert any(warning["code"] == "inventory_simple" for warning in plan["warnings"])
    assert any(warning["code"] == "inventory_merged" for warning in plan["warnings"])
    serialized = json.dumps(plan)
    assert "1111111111111" not in serialized and "2222222222222" not in serialized
    assert "groupMinimumStock" not in serialized
    assert items == before


def test_inventory_merging_uses_whitespace_and_case_normalization_without_fuzzy_names(environment):
    plan = build(environment, INVENTORY_CARD, [
        source_item("one", "@Drinks@ Long  life milk (2)"),
        source_item("two", "@drinks@ long life MILK (3)"),
        source_item("three", "@Drinks@ Milk (1)"),
    ])
    assert [item["stock"] for item in plan["lists"][0]["items"]] == [5, 1]


@pytest.mark.parametrize("statuses, hidden, conflict", [
    (["completed", "completed"], True, False),
    (["needs_action", "needs_action"], False, False),
    (["completed", "needs_action"], False, True),
])
def test_inventory_visibility_is_preserved_or_explicitly_reported(environment, statuses, hidden, conflict):
    plan = build(environment, INVENTORY_CARD, [
        source_item(str(index), "Milk (2)", status=status) for index, status in enumerate(statuses)
    ])
    item, = plan["lists"][0]["items"]
    assert item["stock"] == 4 and item["hidden"] is hidden and item["completed"] is False
    assert plan["counts"]["completed"] == 0 and plan["counts"]["hidden"] == int(hidden)
    assert any(warning["code"] == "inventory_visibility_merged" for warning in plan["warnings"]) is conflict


def test_inventory_without_quantity_defaults_to_one_and_omits_descriptions_and_dates(environment):
    plan = build(environment, INVENTORY_CARD, [
        source_item("one", "Milk", description="Unneeded free text", due="not-a-date"),
    ])
    item, = plan["lists"][0]["items"]
    assert item["stock"] == 1 and item["description"] is None and item["due_at"] is None
    assert any(warning["code"] == "inventory_description_omitted" for warning in plan["warnings"])


@pytest.mark.parametrize("description", [
    '{"schema":1,"transferId":"operation","quantity":2}',
    '{"schema":1,"ean":"1111111111111","name":"Milk"}',
])
def test_inventory_import_still_rejects_ean_database_and_transfer_queue_entries(environment, description):
    with pytest.raises(environment.module.LegacyImportError) as caught:
        build(environment, INVENTORY_CARD, [source_item("one", "Milk", description=description)])
    assert caught.value.code == "unsupported_source"


def test_inventory_merge_rejects_stock_overflow_instead_of_losing_units(environment):
    with pytest.raises(environment.module.LegacyImportError) as caught:
        build(environment, INVENTORY_CARD, [source_item("one", "Milk (1000000)"), source_item("two", "Milk")])
    assert caught.value.code == "invalid_item"
    assert table_counts(environment.db)["products"] == 0


def test_shopping_card_can_be_explicitly_imported_as_inventory_with_valid_card_options(environment):
    parsed = environment.module.parse_legacy_configs(BASE_CARD + "acknowledged: end\nshow_quantity_one: true\nquantity: end\n")
    choices = [{"card_id": parsed["cards"][0]["id"], "entity_id": "todo.groceries",
                "target_name": "Pantry", "list_type": "inventory"}]
    plan = environment.module.build_import_plan(parsed, {"todo.groceries": [source_item("one", "Milk (0)")]}, choices)
    listing, = plan["lists"]
    assert listing["list_type"] == "inventory" and listing["items"][0]["stock"] == 0
    assert listing["cards"][0]["options"]["quantity_position"] == "end"
    assert "acknowledged" not in listing["cards"][0]["options"]
    assert "show_quantity_one" not in listing["cards"][0]["options"]


@pytest.mark.parametrize("original, requested", [("todo", "inventory"), ("todo", "shopping"), ("inventory", "shopping")])
def test_only_shopping_cards_can_be_explicitly_converted_to_inventory(environment, original, requested):
    parsed = environment.module.parse_legacy_configs(BASE_CARD.replace("mode: shopping", f"mode: {original}"))
    with pytest.raises(environment.module.LegacyImportError):
        environment.module.build_import_plan(parsed, {"todo.groceries": []}, [{
            "card_id": parsed["cards"][0]["id"], "entity_id": "todo.groceries",
            "target_name": "Imported", "list_type": requested,
        }])


def test_inventory_only_configuration_creates_definitions_but_no_products(environment):
    parsed = environment.module.parse_legacy_configs(INVENTORY_CARD.replace("entity: todo.groceries\n", ""))
    plan = environment.module.build_import_plan(parsed, {}, include_items=False)
    result = apply(environment, plan)
    listing, = result["lists"]
    assert listing["list_type"] == "inventory" and listing["product_ids"] == []
    counts = table_counts(environment.db)
    assert counts["categories"] == 1 and counts["chips"] == 2
    assert counts["products"] == counts["inventory_entries"] == counts["list_items"] == 0


def test_inventory_database_import_creates_only_generic_products_and_stock_and_keeps_existing_products(environment):
    existing = environment.db._create_product(
        "1111111111111", "Milk", "Original Milk", "Existing brand", "1 l", None,
        "https://example.invalid/image.png", "manual", [], [],
    )
    existing_before = existing.as_dict()
    plan = build(environment, INVENTORY_CARD, [
        source_item("one", "Milk (2)", description='{"schema":1,"type":"isl_inventory_variant","ean":"1111111111111"}'),
        source_item("two", "Milk (3)"), source_item("zero", "Bread (0)", status="completed"),
    ])
    result = apply(environment, plan)
    listing, = result["lists"]
    assert len(listing["product_ids"]) == 2 and existing.id not in listing["product_ids"]
    assert environment.db._get_product_by_ean(existing.ean).as_dict() == existing_before
    inventory = environment.db._list_inventory(listing["list_id"])
    assert {entry.product.name: (entry.stock, entry.hidden) for entry in inventory} == {
        "Milk": (5, False), "Bread": (0, True),
    }
    for entry in inventory:
        assert entry.product.ean is None and entry.product.brand is None
        assert entry.product.package_quantity is None and entry.product.image_url is None
        assert entry.minimum_stock is None and entry.restock_mode is None
    assert inventory[0].category_name == "Drinks"
    counts = table_counts(environment.db)
    assert counts["products"] == 3 and counts["inventory_entries"] == 2
    assert counts["list_items"] == counts["inventory_groups"] == 0
    assert counts["list_script_settings"] == counts["notification_pending_batches"] == 0
    assert environment.events == []
    assert environment.db._get_inventory_restock_settings(listing["list_id"]).enabled is False
    replay = apply(environment, plan)
    assert replay["lists"] == result["lists"] and replay["replayed"] is True
    assert table_counts(environment.db) == counts


def test_inventory_import_rolls_back_new_products_and_stock_together(environment):
    plan = build(environment, INVENTORY_CARD, [source_item("one", "Milk (3)"), source_item("two", "Bread (2)")])
    before = table_counts(environment.db)
    with environment.db._connect() as connection:
        connection.execute("""CREATE TRIGGER fail_inventory_import BEFORE INSERT ON inventory_entries
                              WHEN NEW.stock = 2
                              BEGIN SELECT RAISE(ABORT, 'injected inventory failure'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        apply(environment, plan)
    assert table_counts(environment.db) == before
    assert asyncio.run(environment.db.async_get_legacy_import_result("import-test-1")) is None
    assert environment.events == []
