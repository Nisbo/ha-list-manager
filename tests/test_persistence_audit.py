"""Persistence regressions found by the post-localization code audit."""
import asyncio
import threading
from types import SimpleNamespace

import pytest

from test_inventory_restock import _fixture
from test_data_backup import _modules


def test_group_restock_uses_total_stock_of_all_variants():
    directory, db, shopping, inventory, first = _fixture()
    with directory:
        second_product = db._create_product(None, "Hafermilch", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 5, None, None, None, False)
        db._create_inventory_group(inventory.id, "Milch", 4, None, None, [first.id, second.id], 6, "fixed")
        db._set_inventory_restock_settings(inventory.id, shopping.id, True, "one_to_one", None)
        assert db._preview_inventory_restock(inventory.id)["items"] == []
        assert db._adjust_inventory_with_restock(first.id, -1)["transfer"] is None
        assert db._list_items(shopping.id) == []
        assert db._adjust_inventory_with_restock(second.id, -1)["transfer"] is None
        assert db._adjust_inventory_with_restock(first.id, -1)["transfer"] is None
        sent = db._adjust_inventory_with_restock(second.id, -1)["transfer"]
        assert sent["quantity"] == 6
        assert db._list_items(shopping.id)[0].quantity == 6
        preview = db._preview_inventory_restock(inventory.id)["items"]
        assert len(preview) == 1 and preview[0]["stock"] == 3
        assert preview[0]["latched"] is True


@pytest.mark.parametrize("worker_fails", [False, True])
def test_cancelled_executor_keeps_lock_and_publishes_committed_booking(worker_fails):
    directory, db, _shopping, inventory, entry = _fixture()
    with directory:
        async def scenario():
            started, release = threading.Event(), threading.Event()
            events = []
            db._hass = SimpleNamespace(
                async_add_executor_job=lambda function, *args: asyncio.get_running_loop().run_in_executor(None, function, *args),
                bus=SimpleNamespace(async_fire=lambda event, data: events.append((event, data))),
            )
            adjust = db._adjust_inventory_with_restock

            def blocked_adjust(*args):
                started.set()
                if not release.wait(5):
                    raise RuntimeError("test worker was not released")
                if worker_fails:
                    raise ValueError("test mutation failed before committing")
                return adjust(*args)

            blocked_adjust.__name__ = adjust.__name__
            db._adjust_inventory_with_restock = blocked_adjust
            booking = asyncio.create_task(db.async_adjust_inventory_with_restock(entry.id, 1))
            later_read = None
            try:
                assert await asyncio.to_thread(started.wait, 2)
                booking.cancel()
                await asyncio.sleep(0)
                assert db._lock.locked(), "a cancelled caller must not release a running SQLite worker's lock"
                booking.cancel()
                await asyncio.sleep(0)
                assert db._lock.locked(), "repeated cancellation must still wait for the worker"
                later_read = asyncio.create_task(db.async_list_inventory(inventory.id))
                await asyncio.sleep(0)
                assert not later_read.done()
            finally:
                release.set()
                await asyncio.gather(booking, return_exceptions=True)
                if later_read:
                    await later_read
            with pytest.raises(ValueError if worker_fails else asyncio.CancelledError):
                await booking
            assert not db._lock.locked()
            assert (await db.async_list_inventory(inventory.id))[0].stock == (2 if worker_fails else 3)
            committed = [data for _event, data in events if data.get("event") == "inventory_in"]
            assert len(committed) == (0 if worker_fails else 1)
            if committed:
                assert committed[0]["stock_before"] == 2 and committed[0]["stock_after"] == 3
        asyncio.run(scenario())


@pytest.mark.parametrize("scope,flag", [("global", "use_global_categories"), ("list_type", "use_type_categories")])
def test_dynamic_categories_remain_visible_when_matching_scope_is_disabled(scope, flag):
    directory, db, shopping, _inventory, _entry = _fixture()
    with directory:
        db._create_category("Saucen", scope, "shopping" if scope == "list_type" else None, None, None, None, None)
        db._create_item(shopping.id, "Senf", None, 1, None, "Saucen", None, [], None, None)

        def matching():
            return [row for row in db._list_dynamic_categories() if row["list_id"] == shopping.id and row["name"] == "Saucen"]

        assert not matching(), "an enabled permanent category already provides this name"
        with db._connect() as connection:
            connection.execute(f"UPDATE lists SET {flag}=0 WHERE id=?", (shopping.id,))
        assert db._list_categories(shopping.id) == []
        assert len(matching()) == 1
        assert db._overview_statistics()["categories_dynamic"] == len(db._list_dynamic_categories())
        db._create_category("Saucen", "list", None, shopping.id, None, None, None)
        assert not matching(), "a list-specific permanent category still takes precedence"


@pytest.mark.parametrize("language,prefix", [("de", "Produktoptionen: "), ("en", "Product options: ")])
def test_group_product_options_use_native_text_and_keep_product_names(language, prefix):
    directory, db, _shopping, inventory, first = _fixture()
    with directory:
        second_product = db._create_product(None, "Hafermilch {name}", None, None, None, None, None, "manual", [], [])
        second = db._create_inventory_entry(inventory.id, second_product.id, 1, None, None, None, False)
        db._create_inventory_group(inventory.id, "Milch", 4, None, None, [first.id, second.id])
        from importlib import import_module
        localization = import_module(type(db).__module__.rsplit(".", 1)[0] + ".localization")
        with localization.use_language(language), db._connect() as connection:
            assert db._restock_source(connection, first.id)["options"] == prefix + "Milch, Hafermilch {name}"


def test_repeated_cancellation_keeps_backup_lock_until_executor_finishes():
    directory, db, *_ = _fixture()
    with directory:
        backup, _ = _modules(db)

        async def scenario():
            started, release = threading.Event(), threading.Event()
            lock = asyncio.Lock()
            hass = SimpleNamespace(async_add_executor_job=lambda function, *args: asyncio.get_running_loop().run_in_executor(None, function, *args))

            def worker():
                started.set()
                if not release.wait(5):
                    raise RuntimeError("test worker was not released")

            async def operation():
                async with lock:
                    await backup.atomic_executor(hass, worker)

            task = asyncio.create_task(operation())
            try:
                assert await asyncio.to_thread(started.wait, 2)
                for _ in range(2):
                    task.cancel()
                    await asyncio.sleep(0)
                    assert lock.locked(), "backup operations must retain their lock until the worker finishes"
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not lock.locked()

        asyncio.run(scenario())
