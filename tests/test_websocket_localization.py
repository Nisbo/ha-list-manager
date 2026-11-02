"""Exercise production WS localization with task-scheduling transport doubles."""
import ast
import asyncio
from copy import deepcopy
from functools import wraps
import importlib.util
from pathlib import Path
from types import SimpleNamespace


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


class _SchemaKey:
    def __init__(self, name, *, required=False, default=None):
        self.name, self.required, self.default = name, required, default


class _Connection:
    def __init__(self, *, admin=False, readable=True):
        self.user = SimpleNamespace(is_admin=admin, permissions=SimpleNamespace(check_entity=lambda *_: readable))
        self.errors, self.results, self.metadata = [], [], []

    def send_error(self, *error, **metadata):
        self.errors.append(error)
        self.metadata.append(metadata)

    def send_result(self, *result):
        self.results.append(result)


def _load_commands():
    """Keep production decorators and localization; replace only HA transport."""
    spec = importlib.util.spec_from_file_location("websocket_language_test", INTEGRATION / "localization.py")
    localization = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(localization)
    schemas = []

    def websocket_command(schema):
        schemas.append(schema)

        def register(handler):
            handler.schema = schema
            return handler
        return register

    def async_response(handler):
        # Home Assistant schedules the coroutine while its caller's ContextVars
        # are active. Returning the task lets this isolated test await it.
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

    api = SimpleNamespace(websocket_command=websocket_command, async_response=async_response,
                          require_admin=require_admin, ERR_INVALID_FORMAT="invalid_format")
    schema = SimpleNamespace(Optional=lambda name, **kw: _SchemaKey(name, **kw),
                             Required=lambda name, **kw: _SchemaKey(name, required=True, **kw),
                             Any=lambda *types: types)
    tree = ast.parse((INTEGRATION / "websocket.py").read_text())
    names = {"localized_command", "_send_error", "websocket_get_entity_history", "websocket_save_entity_sample"}
    nodes = deepcopy([node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names])
    assert {node.name for node in nodes} == names
    save = next(node for node in nodes if node.name == "websocket_save_entity_sample")
    assert any(ast.unparse(item) == "websocket_api.require_admin" for item in save.decorator_list)
    namespace = {"callback": lambda function: function, "wraps": wraps, "probatio": schema,
                 "websocket_api": api, "DOMAIN": "ha_list_manager", "POLICY_READ": "read",
                 "localized_text": localization.text, "async_use_language": localization.async_use_language,
                 "system_language": localization.system_language,
                 "error_translation_metadata": localization.error_translation_metadata,
                 "HomeAssistantError": type("HomeAssistantError", (Exception,), {})}
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(INTEGRATION / "websocket.py"), "exec"), namespace)
    return localization, namespace, schemas


def test_optional_request_language_is_isolated_across_scheduled_tasks():
    localization, namespace, schemas = _load_commands()
    hass = SimpleNamespace(config=SimpleNamespace(language="de-DE"))
    asyncio.run(localization.configure(hass))
    api = namespace["websocket_api"]
    key = "backend.list_not_found"
    observations = {}

    @namespace["localized_command"]({namespace["probatio"].Required("type"): "ha_list_manager/test"})
    async def handler(_hass, _connection, message):
        assert "language" not in message, "transport language must not reach CRUD arguments"
        def mutation(*, id):
            return id
        assert mutation(**message) == message["id"]
        before = localization.text(key)
        await asyncio.sleep(0)
        observations[message["id"]] = (before, localization.text(key))

    language_keys = [item for item in handler.schema if item.name == "language"]
    assert len(language_keys) == 1 and not language_keys[0].required
    assert handler.schema[language_keys[0]] is str
    assert language_keys[0].default is None
    assert all(any(item.name == "language" and not item.required for item in schema) for schema in schemas)
    messages = [{"id": 1, "language": "de-DE"}, {"id": 2, "language": "en-GB"},
                {"id": 3, "language": "fr-FR"}, {"id": 4}]
    snapshots = deepcopy(messages)

    async def scenario():
        with localization.use_language("en"):
            tasks = [handler(hass, _Connection(), message) for message in messages]
            assert localization.text(key) == localization.text(key, language="en")
            await asyncio.gather(*tasks)
            assert localization.text(key) == localization.text(key, language="en")
    asyncio.run(scenario())
    for identifier, language in [(1, "de"), (2, "en"), (3, "en"), (4, "de")]:
        expected = localization.text(key, language=language)
        assert observations[identifier] == (expected, expected)
    assert messages == snapshots
    assert localization.text(key) == localization.text(key, language="de")


def test_language_support_preserves_entity_and_admin_permissions():
    localization, namespace, _ = _load_commands()
    calls = []

    class Database:
        async def async_query_entity_history(self, *args):
            calls.append(("read", args))
            return [], False, False

        async def async_save_entity_sample(self, *args):
            calls.append(("save", args))
            return 7

    namespace["_runtime"] = lambda _hass: SimpleNamespace(database=Database())
    namespace["_send_input_error"] = lambda *_: None

    async def scenario():
        request = {"id": 1, "entity_id": "sensor.weight", "limit": 10, "latest": True, "language": "en-GB"}
        unreadable = _Connection(readable=False)
        await namespace["websocket_get_entity_history"](None, unreadable, request)
        assert unreadable.errors == [(1, "unauthorized", localization.text("errors.unauthorized", language="en"))]
        assert not calls
        hidden = _Connection()
        await namespace["websocket_get_entity_history"](None, hidden, {**request, "include_hidden": True, "language": "de-DE"})
        assert hidden.errors == [(1, "unauthorized", localization.text("errors.unauthorized", language="de"))]
        assert not calls
        user = _Connection()
        sample = {"id": 2, "entity_id": "sensor.weight", "state": "85", "attributes": {},
                  "timestamp": "2026-11-01T08:00:00+00:00", "language": "en-GB"}
        assert namespace["websocket_save_entity_sample"](None, user, sample) is None
        assert user.errors[0][1] == "unauthorized" and not calls
        admin = _Connection(admin=True)
        await namespace["websocket_save_entity_sample"](None, admin, sample)
        assert calls == [("save", ("sensor.weight", "85", {}, sample["timestamp"], None, None))]
        assert admin.results == [(2, {"record_id": 7})]
    asyncio.run(scenario())


def test_native_metadata_keeps_existing_error_codes_and_localized_fallback_message():
    localization, namespace, _ = _load_commands()
    connection = _Connection()
    message = localization.text("errors.text_too_long", language="de", maximum=120)
    namespace["_send_error"](connection, 7, "invalid_format", ValueError(message))
    assert connection.errors == [(7, "invalid_format", str(message))]
    assert connection.metadata == [{
        "translation_domain": "ha_list_manager",
        "translation_key": "errors_text_too_long",
        "translation_placeholders": {"maximum": "120"},
    }]
    namespace["_send_error"](connection, 8, "lookup_unavailable", "Remote service unavailable")
    assert connection.errors[-1] == (8, "lookup_unavailable", "Remote service unavailable")
    assert connection.metadata[-1] == {}
