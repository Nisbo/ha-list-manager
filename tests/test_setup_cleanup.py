"""A failed integration setup must not leave privately owned listeners behind."""
import ast
import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _setup_environment(fail_at=None, *, restore=False, fail_stop=None):
    active = {name: set() for name in ("external_lists", "scripts", "notifications", "entity_history", "scanner")}
    calls = []
    failure = RuntimeError("expected setup failure")
    state = {"fail_at": fail_at, "panel": False, "views": 0, "unloads": 0}

    class Manager:
        def __init__(self, name):
            self.name = name

        async def async_start(self):
            calls.append(self.name)
            active[self.name].add(self)
            if state["fail_at"] == self.name:
                raise failure

        async def async_stop(self):
            calls.append("stop:" + self.name)
            active[self.name].discard(self)
            if self.name == fail_stop:
                raise RuntimeError("expected cleanup failure")

    class Entry:
        def __init__(self):
            self.callbacks = []

        def async_on_unload(self, callback):
            self.callbacks.append(callback)

        async def process_callbacks(self):
            # HA runs these on failure, but private manager starts do not
            # register their bus listeners here automatically.
            for callback in self.callbacks:
                result = callback()
                if result is not None:
                    await result
            self.callbacks.clear()

    class Database:
        def __init__(self, *_args):
            pass

        async def async_initialize(self):
            pass

    async def configure(_hass):
        pass

    async def register_panel(_hass):
        calls.append("panel")
        state["panel"] = True
        if state["fail_at"] == "panel":
            raise failure

    def unregister_panel(_hass):
        state["panel"] = False

    async def forward(_entry, _platforms):
        calls.append("forward")
        if state["fail_at"] == "forward":
            raise failure

    async def unload(_entry, _platforms):
        state["unloads"] += 1
        return True

    def register_view(_view):
        state["views"] += 1

    def runtime(**kwargs):
        return SimpleNamespace(**kwargs, **{name: None for name in active})

    def manager_factory(name):
        return lambda *_args: Manager(name)

    namespace = {
        "Path": Path, "DOMAIN": "ha_list_manager", "DATABASE_FILENAME": "ha_list_manager.db",
        "PLATFORMS": ["sensor"], "_LOGGER": logging.getLogger("setup_cleanup_test"),
        "configure_localization": configure, "HaListManagerDatabase": Database,
        "HaListManagerRuntime": runtime,
        "ExternalListManager": manager_factory("external_lists"),
        "ListScriptManager": manager_factory("scripts"),
        "NotificationManager": manager_factory("notifications"),
        "EntityHistoryManager": manager_factory("entity_history"),
        "ScannerManager": manager_factory("scanner"),
        "TandoorRecipeImageView": type("ImageView", (), {}),
        "DataBackupView": type("BackupView", (), {}),
        "async_register_websocket_commands": lambda _hass: None,
        "async_register_panel": register_panel,
        "async_unregister_panel": unregister_panel,
    }
    tree = ast.parse((INTEGRATION / "__init__.py").read_text())
    nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
             *[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]]
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(INTEGRATION / "__init__.py"), "exec"), namespace)
    hass = SimpleNamespace(data={}, config=SimpleNamespace(path=lambda name: "/config/" + name),
        http=SimpleNamespace(register_view=register_view),
        config_entries=SimpleNamespace(async_forward_entry_setups=forward, async_unload_platforms=unload))
    if restore:
        hass.data["ha_list_manager_restore_in_progress"] = True
    return namespace, hass, Entry(), active, calls, state, failure


@pytest.mark.parametrize("fail_at", ["external_lists", "panel", "forward"])
def test_failed_setup_stops_partial_managers_and_retry_has_single_listeners(fail_at):
    async def scenario():
        namespace, hass, entry, active, calls, state, failure = _setup_environment(fail_at)
        with pytest.raises(RuntimeError) as raised:
            await namespace["async_setup_entry"](hass, entry)
        assert raised.value is failure
        await entry.process_callbacks()
        assert all(not listeners for listeners in active.values())
        assert "ha_list_manager" not in hass.data
        assert not hasattr(entry, "runtime_data")
        assert not state["panel"]
        assert state["unloads"] == (1 if fail_at == "forward" else 0)
        state["fail_at"] = None
        assert await namespace["async_setup_entry"](hass, entry)
        assert all(len(listeners) == 1 for listeners in active.values())
        assert hass.data["ha_list_manager"] is entry.runtime_data
        assert state["panel"]
        assert state["views"] == 2, "Globally registered HTTP views must stay single on retry"
    asyncio.run(scenario())


def test_failure_cleanup_preserves_original_exception_and_stops_other_managers():
    async def scenario():
        namespace, hass, entry, active, _, _, failure = _setup_environment("forward", fail_stop="scanner")
        with pytest.raises(RuntimeError) as raised:
            await namespace["async_setup_entry"](hass, entry)
        assert raised.value is failure
        assert all(not listeners for listeners in active.values())
        assert "ha_list_manager" not in hass.data and not hasattr(entry, "runtime_data")
    asyncio.run(scenario())


def test_failed_setup_during_restore_keeps_the_existing_panel():
    async def scenario():
        namespace, hass, entry, active, _, state, _ = _setup_environment("forward", restore=True)
        with pytest.raises(RuntimeError):
            await namespace["async_setup_entry"](hass, entry)
        assert all(not listeners for listeners in active.values())
        assert state["panel"]
        assert "ha_list_manager" not in hass.data
    asyncio.run(scenario())


def test_successful_start_and_unload_keep_the_existing_order():
    async def scenario():
        namespace, hass, entry, active, calls, state, _ = _setup_environment()
        assert await namespace["async_setup_entry"](hass, entry)
        assert calls == ["external_lists", "scripts", "notifications", "entity_history", "scanner", "panel", "forward"]
        assert await namespace["async_unload_entry"](hass, entry)
        assert calls[7:] == ["stop:scripts", "stop:scanner", "stop:notifications", "stop:external_lists", "stop:entity_history"]
        assert all(not listeners for listeners in active.values())
        assert state["unloads"] == 1 and not state["panel"]
    asyncio.run(scenario())


def test_cancelled_late_setup_still_releases_managers_before_propagating():
    async def scenario():
        namespace, hass, entry, active, _, state, _ = _setup_environment()
        entered = asyncio.Event()
        async def blocked_forward(*_args):
            entered.set()
            await asyncio.Future()
        hass.config_entries.async_forward_entry_setups = blocked_forward
        setup = asyncio.create_task(namespace["async_setup_entry"](hass, entry))
        await entered.wait()
        setup.cancel()
        with pytest.raises(asyncio.CancelledError):
            await setup
        assert all(not listeners for listeners in active.values())
        assert "ha_list_manager" not in hass.data and not hasattr(entry, "runtime_data")
        assert state["unloads"] == 1 and not state["panel"]
    asyncio.run(scenario())


def test_cleanup_platform_and_panel_errors_do_not_hide_the_setup_failure():
    async def scenario():
        namespace, hass, entry, active, _, _, failure = _setup_environment("forward")
        async def failed_platform_cleanup(*_args):
            raise RuntimeError("expected platform cleanup failure")
        def failed_panel_cleanup(*_args):
            raise RuntimeError("expected panel cleanup failure")
        hass.config_entries.async_unload_platforms = failed_platform_cleanup
        namespace["async_unregister_panel"] = failed_panel_cleanup
        with pytest.raises(RuntimeError) as raised:
            await namespace["async_setup_entry"](hass, entry)
        assert raised.value is failure
        assert all(not listeners for listeners in active.values())
        assert "ha_list_manager" not in hass.data and not hasattr(entry, "runtime_data")
    asyncio.run(scenario())
