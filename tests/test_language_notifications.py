"""Bilingual notification behavior and executor language isolation."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from html import escape
import importlib
import sys
from types import SimpleNamespace

import pytest

from test_inventory_restock import _database_module
from test_notifications import _assignment, _list_item, _load_notifications


@pytest.fixture(params=("de", "en"))
def notification_language(request, monkeypatch):
    module = _load_notifications()
    localization = sys.modules[module.localized_text.__module__]
    language = request.param
    monkeypatch.setattr(
        localization, "_hass", SimpleNamespace(config=SimpleNamespace(language=language))
    )
    # Automatic notifications must follow HA even when scheduled by another UI.
    with localization.use_language("en" if language == "de" else "de"):
        yield module.NotificationManager, localization, language


@pytest.mark.parametrize("unit, german_one, german_many, english_one, english_many", [
    ("H", "jede Stunde", "alle 2 Stunden", "every hour", "every 2 hours"),
    ("D", "jeden Tag", "alle 2 Tage", "every day", "every 2 days"),
    ("M", "jeden Monat", "alle 2 Monate", "every month", "every 2 months"),
])
def test_recurrence_uses_system_language_and_singular_plural(
    notification_language, unit, german_one, german_many, english_one, english_many
):
    manager, localization, language = notification_language
    assert localization.text("backend.general") == ("General" if language == "de" else "Allgemein")
    expected = (german_one, german_many) if language == "de" else (english_one, english_many)
    for count, text in zip((1, 2), expected):
        assert manager._format_recurrence({
            "recurrence_interval": count, "recurrence_unit": unit,
        }) == text


@pytest.mark.parametrize("before_count, after_count", [(1, 2), (2, 1)])
def test_quantity_changes_keep_names_and_render_both_values(
    notification_language, before_count, after_count
):
    manager, _, language = notification_language
    name = "Milch & Hafer {count}"
    changes = {"milk": {
        "before": {"name": name, "quantity": before_count},
        "after": {"name": name, "quantity": after_count},
    }}
    original = deepcopy(changes)
    message = manager._format_changes(changes, _assignment(), "text")
    if language == "de":
        heading = "Anzahl erhöht:" if after_count > before_count else "Anzahl verringert:"
        detail = f"{name}: von {before_count} auf {after_count}"
    else:
        heading = "Count increased:" if after_count > before_count else "Count decreased:"
        detail = f"{name}: from {before_count} to {after_count}"
    assert heading in message
    assert detail in message
    assert changes == original


@pytest.mark.parametrize("offer_only", [False, True])
def test_offer_and_removed_labels_are_localized_and_html_escaped(
    notification_language, offer_only
):
    manager, _, language = notification_language
    name = "Müll & <Tonne> {name}"
    old_label = "Draußen & <Haus> {labels}"
    new_label = "Zuhause"
    changes = {"task": {
        "before": {
            "name": name, "quantity": 1, "offer_only": not offer_only,
            "labels": [{"id": "old", "name": old_label}],
        },
        "after": {
            "name": name, "quantity": 1, "offer_only": offer_only,
            "labels": [{"id": "new", "name": new_label}],
        },
    }}
    original = deepcopy(changes)
    message = manager._format_changes(changes, _assignment(), "html")
    if language == "de":
        offer = "Nur im Angebot aktiviert" if offer_only else "Nur im Angebot deaktiviert"
        labels = f"hinzugefügt: {new_label}; entfernt: {old_label}"
    else:
        offer = "Only on offer enabled" if offer_only else "Only on offer disabled"
        labels = f"added: {new_label}; removed: {old_label}"
    assert f"{escape(name)}: {offer}" in message
    assert escape(labels) in message
    assert "&amp;amp;" not in message
    assert "<Tonne>" not in message
    assert changes == original


@pytest.mark.parametrize("message_format", ["text", "markdown"])
def test_empty_lists_use_system_language(notification_language, message_format):
    manager, _, language = notification_language
    title = "Leere Liste {name}"
    message = manager._format_list(
        SimpleNamespace(name=title, list_type="shopping"),
        [_list_item(name="Already completed", completed=True)], message_format,
    )
    expected = "Die Liste ist leer." if language == "de" else "The list is empty."
    assert message == f"{title}\n\n{expected}"


def test_unassigned_group_preserves_real_general_category_names(notification_language):
    manager, _, language = notification_language
    items = [
        _list_item(name="No category", category=None, category_id=None),
        _list_item(name="Real General", category="General", category_id="general"),
        _list_item(name="Real Allgemein", category="Allgemein", category_id="allgemein"),
    ]
    message = manager._format_list(
        SimpleNamespace(name="List", list_type="shopping"), items, "html"
    )
    unassigned = "Allgemein" if language == "de" else "General"
    assert message.count("<h3>") == 3
    assert f"<h3>{unassigned}</h3><ul><li>No category</li></ul>" in message
    assert "<h3>General</h3><ul><li>Real General</li></ul>" in message
    assert "<h3>Allgemein</h3><ul><li>Real Allgemein</li></ul>" in message
    assert [item.category for item in items] == [None, "General", "Allgemein"]


def test_full_todo_list_preserves_user_data_and_localizes_date(notification_language):
    manager, _, language = notification_language
    item = _list_item(
        name="Äpfel & <Birnen> {p0}", description="Frühstück <b> {count}",
        category="Haushalt", due_at="2000-01-01",
        recurrence_interval=2, recurrence_unit="D",
    )
    original = vars(item).copy()
    message = manager._format_list(
        SimpleNamespace(name="A&B", list_type="todo"), [item], "html"
    )
    assert "<h2>A&amp;B</h2>" in message
    assert "<h3>Haushalt</h3>" in message
    assert "Äpfel &amp; &lt;Birnen&gt; {p0}" in message
    assert "Frühstück &lt;b&gt; {count}" in message
    if language == "de":
        assert "Überfällig: 01.01.2000 · alle 2 Tage" in message
    else:
        assert "Overdue: 2000-01-01 · every 2 days" in message
    assert vars(item) == original


def test_backup_executor_propagates_language_and_cleans_worker_context(monkeypatch):
    database_module = _database_module()
    package = database_module.__package__
    backup = importlib.import_module(f"{package}.data_backup")
    localization = importlib.import_module(f"{package}.localization")
    monkeypatch.setattr(
        localization, "_hass", SimpleNamespace(config=SimpleNamespace(language="de"))
    )

    import threading
    native_cached = localization.async_get_cached_translations
    event_loop_thread = threading.get_ident()

    def cached(*args):
        assert threading.get_ident() == event_loop_thread, "HA cache callbacks cannot run in SQLite workers"
        return native_cached(*args)

    monkeypatch.setattr(localization, "async_get_cached_translations", cached)

    async def scenario():
        # Reuse one thread so a leaked request context cannot hide in the pool.
        with ThreadPoolExecutor(max_workers=1) as executor:
            loop = asyncio.get_running_loop()
            hass = SimpleNamespace(async_add_executor_job=lambda function, *args:
                loop.run_in_executor(executor, function, *args))

            async def translate(language):
                with localization.use_language(language):
                    return await backup.atomic_executor(hass, localization.text, "backend.general")

            assert await asyncio.gather(translate("en"), translate("de")) == ["General", "Allgemein"]
            assert localization.text("backend.general") == "Allgemein"
            assert await hass.async_add_executor_job(lambda: (localization._LANGUAGE.get(), localization._RESOURCES.get())) == (None, None)

            def fail():
                raise ValueError(localization.text("backend.assignment_word_required"))

            with localization.use_language("en"):
                with pytest.raises(ValueError, match="An assignment rule must contain at least one word"):
                    await backup.atomic_executor(hass, fail)
                assert localization.text("backend.general") == "General"
            assert localization.text("backend.general") == "Allgemein"
            assert await hass.async_add_executor_job(lambda: (localization._LANGUAGE.get(), localization._RESOURCES.get())) == (None, None)

    asyncio.run(scenario())
