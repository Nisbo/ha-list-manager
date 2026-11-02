"""Concurrent notification changes must survive coalescing and delivery."""
import asyncio
import json
from types import SimpleNamespace

from test_notifications import _assignment, _load_notifications


def _scenario_parts():
    module = _load_notifications()
    profile = SimpleNamespace(enabled=True, message_format="text", title=None)
    assignment = _assignment()
    assignment.profile_id = "profile"
    assignment.profile = profile
    assignment.automatic_mode = "changes"
    assignment.delay_seconds = 5

    class Database:
        batch = None

        async def async_list_notification_assignments(self, _list_id):
            return [assignment]

        async def async_get_notification_pending_batch(self, _list_id, _profile_id):
            # Expose the real DB await boundary after reading the current row.
            snapshot = self.batch
            await asyncio.sleep(0)
            return snapshot

        async def async_upsert_notification_pending_batch(self, list_id, profile_id, due_at, changes_json):
            await asyncio.sleep(0)
            self.batch = SimpleNamespace(list_id=list_id, profile_id=profile_id,
                                         due_at=due_at, changes_json=changes_json)
            return self.batch

        async def async_delete_notification_pending_batch(self, *_args):
            self.batch = None

        async def async_list_lists(self):
            return [SimpleNamespace(id="list", name="Shopping")]

    database = Database()
    hass = SimpleNamespace(config=SimpleNamespace(language="de"),
                           async_create_task=lambda coroutine, *_args: asyncio.create_task(coroutine))
    manager = module.NotificationManager(hass, database)
    scheduled = []
    manager._schedule_batch = scheduled.append
    return manager, database, scheduled


def _change(item):
    return {"list_id": "list", "item_id": item, "before": None,
            "after": {"name": item, "quantity": 1}}


def test_simultaneous_changes_for_different_items_are_both_retained():
    async def scenario():
        manager, database, _ = _scenario_parts()
        await asyncio.gather(manager._async_record_change(_change("milk")),
                             manager._async_record_change(_change("bread")))
        assert set(json.loads(database.batch.changes_json)) == {"milk", "bread"}
    asyncio.run(scenario())


def test_change_while_sending_is_retained_for_a_following_notification():
    async def scenario():
        manager, database, _ = _scenario_parts()
        await manager._async_record_change(_change("milk"))
        sending = asyncio.Event()
        release = asyncio.Event()
        messages = []

        async def send(_profile, _title, message):
            messages.append(message)
            sending.set()
            await release.wait()

        manager._async_send = send
        delivery = asyncio.create_task(manager._async_deliver_batch("list", "profile"))
        await sending.wait()
        update = asyncio.create_task(manager._async_record_change(_change("bread")))
        # An unlocked reader would overwrite the row while delivery is pending.
        for _ in range(5):
            await asyncio.sleep(0)
        release.set()
        await asyncio.gather(delivery, update)
        assert len(messages) == 1 and "milk" in messages[0] and "bread" not in messages[0]
        assert database.batch is not None
        assert set(json.loads(database.batch.changes_json)) == {"bread"}
    asyncio.run(scenario())


def test_stop_drains_started_batch_writes_without_creating_new_timers():
    async def scenario():
        manager, database, _ = _scenario_parts()
        del manager._schedule_batch  # Exercise the actual timer lifecycle.
        cancelled = []
        manager._timers[("old-list", "profile")] = lambda: cancelled.append(True)
        manager._handle_item_mutated(SimpleNamespace(data=_change("milk")))
        await manager.async_stop()
        assert set(json.loads(database.batch.changes_json)) == {"milk"}
        assert not manager._timers and not manager._tasks
        assert cancelled == [True]
        manager._handle_item_mutated(SimpleNamespace(data=_change("ignored-after-stop")))
        assert not manager._tasks
    asyncio.run(scenario())
