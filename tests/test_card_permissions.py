"""Exercise the card/admin boundary with production commands and real SQLite.

Only Home Assistant's transport is replaced. Production command bodies,
localization, validators, and permission decorators remain in place.
"""
from __future__ import annotations

import ast
import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from functools import wraps
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_inventory_restock import _fixture


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"

# These operations manage the integration rather than an existing list's
# entries. Keeping this explicit catches a removed guard, including operations
# that the dashboard never happens to call during a smoke test.
ADMIN_COMMANDS = """
list_tracked_entities set_entity_tracking delete_entity_history
save_entity_sample delete_entity_sample import_entity_history info
list_favorites set_favorite list_notification_profiles
create_notification_profile update_notification_profile
delete_notification_profile set_notification_assignments test_notification_profile
create_list update_list list_scope_impact delete_list sync_external_list
list_category_products set_product_list_category get_settings update_settings
test_tandoor delete_product list_category_rules set_category_rules list_categories
create_category update_category delete_category set_category_order reset_category_order
create_label update_label delete_label update_chip delete_chip
create_dish update_dish delete_dish create_inventory_entry
set_inventory_restock_settings list_scanners create_scanner update_scanner
delete_scanner simulate_scan pending_scans dismiss_pending_scan scan_history
get_list_script_settings set_list_script_settings
""".split()


class Connection:
    def __init__(self, *, admin=False):
        self.user = SimpleNamespace(
            id="test-admin" if admin else "test-user",
            is_admin=admin,
            permissions=SimpleNamespace(check_entity=lambda *_: True),
        )
        self.errors = []
        self.results = []
        self.messages = []
        self.subscriptions = {}

    def send_error(self, *args, **_metadata):
        self.errors.append(args)

    def send_result(self, *args):
        self.results.append(args)

    def send_message(self, message):
        self.messages.append(message)


def _commands(db):
    """Load all production functions, including their actual decorator lists."""
    probatio = pytest.importorskip("probatio")
    package = type(db).__module__.rsplit(".", 1)[0]
    constants = import_module(package + ".const")
    localization = import_module(package + ".localization")

    def websocket_command(schema):
        def register(handler):
            handler.schema = schema
            return handler
        return register

    def async_response(handler):
        @wraps(handler)
        def schedule(hass, connection, message):
            return asyncio.create_task(handler(hass, connection, message))
        return schedule

    def require_admin(handler):
        @wraps(handler)
        def guarded(hass, connection, message):
            if not connection.user.is_admin:
                connection.send_error(message["id"], "unauthorized", "Administrator required")
                return None
            return handler(hass, connection, message)
        return guarded

    namespace = {
        **vars(constants),
        **vars(import_module(package + ".database")),
        "asyncio": asyncio,
        "UTC": UTC,
        "datetime": datetime,
        "wraps": wraps,
        "callback": lambda handler: handler,
        "probatio": probatio,
        "websocket_api": SimpleNamespace(
            websocket_command=websocket_command,
            async_response=async_response,
            require_admin=require_admin,
            ERR_NOT_FOUND="not_found",
            ERR_INVALID_FORMAT="invalid_format",
            ERR_UNKNOWN_ERROR="unknown_error",
            ERR_UNAUTHORIZED="unauthorized",
            event_message=lambda identifier, event: {"id": identifier, "type": "event", "event": event},
        ),
        "async_use_language": localization.async_use_language,
        "system_language": localization.system_language,
        "localized_text": localization.text,
        "error_translation_metadata": localization.error_translation_metadata,
        "HomeAssistantError": type("HomeAssistantError", (Exception,), {}),
        "ExternalListError": type("ExternalListError", (Exception,), {}),
        "OpenFactsLookupError": type("OpenFactsLookupError", (Exception,), {}),
        "TandoorError": type("TandoorError", (Exception,), {}),
        "POLICY_READ": "read",
        "NOTIFICATION_PROVIDERS": {"notify_entity", "notify_service", "ntfy", "persistent"},
        "NOTIFICATION_FORMATS": {"plain", "markdown", "html"},
    }
    tree = ast.parse((INTEGRATION / "websocket.py").read_text())
    functions = deepcopy([
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Assign, ast.AnnAssign))
    ])
    module = ast.Module(body=[
        ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
        *functions,
    ], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(INTEGRATION / "websocket.py"), "exec"), namespace)
    return namespace


def _hass(db):
    events = []

    async def executor(function, *args):
        return function(*args)

    runtime = SimpleNamespace(database=db, config_entry=SimpleNamespace(options={}))
    hass = SimpleNamespace(
        data={"ha_list_manager": runtime},
        config=SimpleNamespace(language="en"),
        bus=SimpleNamespace(async_fire=lambda event, data: events.append((event, data))),
        async_add_executor_job=executor,
    )
    db._hass = hass
    return hass, events


async def _call(namespace, hass, connection, command, **values):
    """Apply the registered schema, including HA transport defaults."""
    handler = namespace["websocket_" + command]
    identifier = len(connection.results) + len(connection.errors) + 1
    schema = namespace["probatio"].Schema({
        namespace["probatio"].Required("id"): int,
        **handler.schema,
    })
    request = schema({"id": identifier, "type": handler.schema["type"], "language": "en", **values})
    task = handler(hass, connection, request)
    if task is not None:
        await task
    assert not connection.errors, connection.errors
    assert connection.results[-1][0] == identifier
    return connection.results[-1][1] if len(connection.results[-1]) > 1 else None


@pytest.mark.parametrize("command", ADMIN_COMMANDS)
def test_normal_users_cannot_call_management_commands(command):
    directory, db, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        # Any access to runtime would indicate that the guard was bypassed.
        namespace["_runtime"] = lambda _hass: pytest.fail("management body reached by normal user")
        connection = Connection()
        result = namespace["websocket_" + command](None, connection, {"id": 1, "language": "en"})
        assert result is None
        assert connection.errors and connection.errors[0][:2] == (1, "unauthorized")


@pytest.mark.parametrize("admin", [False, True])
@pytest.mark.parametrize("list_type", ["shopping", "todo"])
def test_both_roles_can_operate_shopping_and_todo_entries(admin, list_type):
    directory, db, shopping, *_ = _fixture()
    with directory:
        record = shopping if list_type == "shopping" else db._create_list(
            "Aufgaben", "todo", None, "local", None, "specific", True, True, True,
        )
        namespace = _commands(db)
        hass, events = _hass(db)
        connection = Connection(admin=admin)
        products_before = len(db._list_products(None, None))

        async def scenario():
            lists = await _call(namespace, hass, connection, "list_lists")
            assert record.id in {row["id"] for row in lists["lists"]}
            values = {"list_id": record.id, "name": "Milch" if list_type == "shopping" else "Müll rausbringen", "quantity": 1}
            if list_type == "todo":
                values.update(due_at="2026-11-02T08:00:00+00:00", recurrence_interval=2, recurrence_unit="D")
            first = (await _call(namespace, hass, connection, "create_item", **values))["item"]
            second = (await _call(namespace, hass, connection, "create_item", list_id=record.id, name="Zweiter Eintrag", quantity=1))["item"]
            updated = (await _call(namespace, hass, connection, "update_item", item_id=first["id"], name="Geändert", quantity=3, completed=False))["item"]
            assert updated["name"] == "Geändert" and updated["quantity"] == 3
            if list_type == "todo":
                assert updated["recurrence_interval"] == 2
            done = (await _call(namespace, hass, connection, "set_item_completed", item_id=second["id"], completed=True))["item"]
            assert done["completed"] is True
            await _call(namespace, hass, connection, "set_item_completed", item_id=second["id"], completed=False)
            await _call(namespace, hass, connection, "reorder_items", list_id=record.id, item_ids=[second["id"], first["id"]])
            rows = (await _call(namespace, hass, connection, "list_items", list_id=record.id))["items"]
            assert [row["id"] for row in rows] == [second["id"], first["id"]]
            await _call(namespace, hass, connection, "delete_item", item_id=first["id"])
            await _call(namespace, hass, connection, "delete_item", item_id=second["id"])
            assert db._list_items(record.id) == []
            assert len(db._list_products(None, None)) == products_before, "general To-do entries must never create products"
            assert events

        asyncio.run(scenario())


@pytest.mark.parametrize("admin", [False, True])
def test_both_roles_can_book_undo_and_remove_inventory_entries(admin):
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        namespace = _commands(db)
        hass, events = _hass(db)
        connection = Connection(admin=admin)

        async def scenario():
            added = (await _call(namespace, hass, connection, "add_inventory_product", list_id=inventory.id, value="Testbrot", quantity=3))["entry"]
            assert added["stock"] == 3
            options = await _call(namespace, hass, connection, "inventory_options", list_id=inventory.id)
            assert any(row["name"] == "Testbrot" for row in options["products"])
            changed = await _call(namespace, hass, connection, "adjust_inventory_entry", entry_id=added["id"], delta=-1)
            assert changed["entry"]["stock"] == 2
            undone = await _call(namespace, hass, connection, "undo_inventory_booking", token=changed["undo_token"])
            assert undone["entry"]["stock"] == 3
            hidden = (await _call(namespace, hass, connection, "set_inventory_hidden", entry_id=added["id"], hidden=True))["entry"]
            assert hidden["hidden"] is True
            db._set_inventory_restock_settings(inventory.id, shopping.id, False, "continuous", None)
            db._update_inventory_entry(first.id, 1, 2, None, "Getränke", False)
            preview = await _call(namespace, hass, connection, "preview_inventory_restock", list_id=inventory.id)
            assert preview["items"][0]["quantity"] == 1
            await _call(namespace, hass, connection, "apply_inventory_restock", list_id=inventory.id)
            assert db._list_items(shopping.id)[0].quantity == 1
            await _call(namespace, hass, connection, "delete_inventory_entry", entry_id=added["id"])
            assert all(entry.id != added["id"] for entry in db._list_inventory(inventory.id))
            assert any(product.name == "Testbrot" for product in db._list_products(None, None)), "removing stock must preserve the product"
            assert events

        asyncio.run(scenario())


@pytest.mark.parametrize("command", ["list_labels", "list_chips", "list_dishes", "list_notification_assignments", "get_category_order"])
@pytest.mark.parametrize("list_id", [None, "", "   "])
def test_normal_users_need_a_real_list_context_for_definition_reads(command, list_id):
    directory, db, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        namespace["_runtime"] = lambda _hass: pytest.fail("unscoped definition read reached database")
        connection = Connection()

        async def scenario():
            values = {"id": 1, "language": "en"}
            if list_id is not None:
                values["list_id"] = list_id
            result = namespace["websocket_" + command](None, connection, values)
            if result is not None:
                await result
            assert connection.errors and connection.errors[0][:2] == (1, "unauthorized")
        asyncio.run(scenario())


@pytest.mark.parametrize("scope", ["global", "list_type", "list"])
def test_normal_users_cannot_read_category_base_order(scope):
    directory, db, shopping, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        connection = Connection()

        async def scenario():
            await namespace["websocket_get_category_order"](None, connection, {
                "id": 1, "list_id": shopping.id, "scope": scope, "language": "en",
            })
            assert connection.errors and connection.errors[0][:2] == (1, "unauthorized")
        asyncio.run(scenario())


@pytest.mark.parametrize("scope,list_id", [("global", None), ("list_type", None), ("list", None), ("list", ""), ("list", "   ")])
def test_normal_users_cannot_create_global_or_unscoped_chips(scope, list_id):
    directory, db, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        namespace["_runtime"] = lambda _hass: pytest.fail("privileged chip creation reached database")
        connection = Connection()

        async def scenario():
            await namespace["websocket_create_chip"](None, connection, {
                "id": 1, "name": "Test", "scope": scope, "list_id": list_id, "language": "en",
            })
            assert connection.errors and connection.errors[0][:2] == (1, "unauthorized")
        asyncio.run(scenario())


def test_scoped_card_choices_work_and_notification_destinations_are_redacted():
    directory, db, shopping, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        hass, _ = _hass(db)
        user, admin = Connection(), Connection(admin=True)
        category = db._create_category("Getränke", "global", None, None, "mdi:cup", "#123456", None)
        profile = db._create_notification_profile("Handy", "ntfy", "https://example.invalid/private-topic", "Privater Titel", "https://example.invalid/private-link", "plain", True)
        db._set_notification_assignments(shopping.id, [{"profile_id": profile.id, "manual_enabled": True, "automatic_mode": "changes", "delay_seconds": 17}])

        async def scenario():
            for name, key in [("list_labels", "labels"), ("list_dishes", "dishes")]:
                assert key in await _call(namespace, hass, user, name, list_id=shopping.id)
            order = await _call(namespace, hass, user, "get_category_order", list_id=shopping.id)
            assert category.id in {row["id"] for row in order["categories"]}
            chip = (await _call(namespace, hass, user, "create_chip", name="Milch", scope="list", list_id=shopping.id))["chip"]
            assert chip["list_id"] == shopping.id
            choices = await _call(namespace, hass, user, "list_chips", list_id=shopping.id)
            assert chip["id"] in {row["id"] for row in choices["chips"]}
            await _call(namespace, hass, user, "set_important_chip", list_id=shopping.id, target_type="chip", target_id=chip["id"], important=True)
            assert (await _call(namespace, hass, user, "list_important_chips", list_id=shopping.id))["assignments"]
            assignment = (await _call(namespace, hass, user, "list_notification_assignments", list_id=shopping.id))["assignments"][0]
            assert set(assignment) == {"list_id", "profile_id", "manual_enabled", "profile"}
            assert assignment["profile"] == {"id": profile.id, "name": "Handy", "enabled": True}
            assert "private" not in str(assignment)
            full = (await _call(namespace, hass, admin, "list_notification_assignments"))["assignments"][0]
            assert full["profile"]["target"] == profile.target
            assert full["delay_seconds"] == 17
            # Administrative unscoped reads and definition creation remain possible.
            assert "chips" in await _call(namespace, hass, admin, "list_chips")
            assert "categories" in await _call(namespace, hass, admin, "list_categories")
            assert (await _call(namespace, hass, admin, "create_chip", name="Global", scope="global"))["chip"]["scope"] == "global"
            created = await _call(namespace, hass, admin, "create_list", name="Neue Liste", list_type="todo")
            assert created["list"]["name"] == "Neue Liste"

        asyncio.run(scenario())


@pytest.mark.parametrize("admin", [False, True])
def test_both_roles_can_save_products_and_use_configured_dishes_and_recipes(admin):
    directory, db, shopping, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        hass, _ = _hass(db)
        connection = Connection(admin=admin)
        with db._connect() as sql:
            sql.execute("UPDATE lists SET use_dishes=1, use_tandoor=1 WHERE id=?", (shopping.id,))
        dish = db._create_dish("Frühstück", "#123456", [{"name": "Brot", "quantity": 2}])
        remote_calls = []

        class RecipeClient:
            async def async_categories(self, *, limit):
                remote_calls.append(("categories", limit))
                return [{"id": 4, "name": "Frühstück"}]

            async def async_search(self, query, **options):
                remote_calls.append(("search", query, options))
                return [{"id": 7, "name": "Pfannkuchen"}]

            async def async_recipe(self, recipe_id):
                remote_calls.append(("recipe", recipe_id))
                return {"id": recipe_id, "name": "Pfannkuchen", "ingredients": []}

        runtime = hass.data["ha_list_manager"]
        runtime.tandoor = RecipeClient()
        runtime.tandoor_config = ("", "")

        async def scenario():
            product = (await _call(namespace, hass, connection, "create_product", name="Pepsi Lemon Zero", ean="4062139025398", brand="Pepsi", package_quantity="1,25 l"))["product"]
            edited = (await _call(namespace, hass, connection, "update_product", product_id=product["id"], name="Pepsi Lemon Zero", ean=product["ean"], brand="Pepsi", package_quantity="1,25 l"))["product"]
            assert edited["ean"] == product["ean"]
            lookup = await _call(namespace, hass, connection, "lookup_product", ean=product["ean"])
            assert lookup["duplicate"]["id"] == product["id"]
            assert any(row["id"] == product["id"] for row in (await _call(namespace, hass, connection, "list_products", search="Pepsi"))["products"])
            saved = (await _call(namespace, hass, connection, "create_item", list_id=shopping.id, name=product["name"], product_id=product["id"], quantity=1))["item"]
            assert saved["product_id"] == product["id"]
            assert dish.id in {row["id"] for row in (await _call(namespace, hass, connection, "list_dishes", list_id=shopping.id))["dishes"]}
            await _call(namespace, hass, connection, "add_dish_to_list", dish_id=dish.id, list_id=shopping.id)
            assert any(row.name == "Brot" and row.quantity == 2 for row in db._list_items(shopping.id))
            assert (await _call(namespace, hass, connection, "list_tandoor_categories", list_id=shopping.id))["categories"][0]["id"] == 4
            assert (await _call(namespace, hass, connection, "search_tandoor_recipes", list_id=shopping.id, query="Pfann"))["recipes"][0]["id"] == 7
            assert (await _call(namespace, hass, connection, "get_tandoor_recipe", list_id=shopping.id, recipe_id=7))["recipe"]["id"] == 7
            assert [call[0] for call in remote_calls] == ["categories", "search", "recipe"]

        asyncio.run(scenario())


def test_backend_panel_registration_remains_admin_only():
    tree = ast.parse((INTEGRATION / "panel.py").read_text())
    register = deepcopy(next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_register_panel"))
    calls = []

    async def register_cards(_hass):
        pass

    async def register_panel(**values):
        calls.append(values)

    namespace = {
        "DATA_STATIC_PATH_REGISTERED": "registered",
        "_async_register_frontend_cards": register_cards,
        "async_panel_exists": lambda *_: False,
        "panel_custom": SimpleNamespace(async_register_panel=register_panel),
        **{name: name for name in ("PANEL_URL_PATH", "PANEL_ELEMENT_NAME", "PANEL_MODULE_URL", "PANEL_TITLE", "PANEL_ICON")},
    }
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), register], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(INTEGRATION / "panel.py"), "exec"), namespace)
    asyncio.run(namespace["async_register_panel"](SimpleNamespace(data={"registered": True})))
    assert len(calls) == 1 and calls[0]["require_admin"] is True


@pytest.mark.parametrize("admin", [False, True])
@pytest.mark.parametrize("event_name", ["EVENT_ITEMS_CHANGED", "EVENT_INVENTORY_CHANGED", "EVENT_SCANNER_TARGET_CHANGED", "EVENT_SCAN_PROCESSED"])
def test_card_updates_reach_both_roles_and_unsubscribe_removes_the_listener(admin, event_name):
    directory, db, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        connection = Connection(admin=admin)
        listeners = {}

        def listen(event_type, callback):
            callbacks = listeners.setdefault(event_type, [])
            callbacks.append(callback)
            return lambda: callbacks.remove(callback)

        hass = SimpleNamespace(bus=SimpleNamespace(async_listen=listen))
        event_type = namespace[event_name]
        payload = {"event_type": event_type, "data": {"list_id": "test-list", "entry_id": "test-entry"}}

        async def scenario():
            await _call(namespace, hass, connection, "subscribe", event_type=event_type)
            assert len(listeners[event_type]) == 1
            assert set(connection.subscriptions) == {1}
            for callback in listeners[event_type]:
                callback(SimpleNamespace(as_dict=lambda: payload))
            assert connection.messages == [{"id": 1, "type": "event", "event": payload}]
            # This is the callback HA invokes on unsubscribe or disconnect.
            connection.subscriptions.pop(1)()
            assert listeners[event_type] == []
            assert connection.subscriptions == {}
            for callback in listeners[event_type]:
                callback(SimpleNamespace(as_dict=lambda: payload))
            assert len(connection.messages) == 1, "detached cards must not retain event listeners"
        asyncio.run(scenario())


@pytest.mark.parametrize("event_type", ["state_changed", "call_service", "*", "ha_list_manager_script_action"])
def test_card_subscription_rejects_events_outside_its_allowlist(event_type):
    directory, db, *_ = _fixture()
    with directory:
        namespace = _commands(db)
        connection = Connection()
        hass = SimpleNamespace(bus=SimpleNamespace(async_listen=lambda *_: pytest.fail("unsupported event subscribed")))

        async def scenario():
            with pytest.raises(namespace["probatio"].Invalid):
                await _call(namespace, hass, connection, "subscribe", event_type=event_type)
            assert connection.results == [] and connection.messages == []
            assert connection.subscriptions == {}
        asyncio.run(scenario())
