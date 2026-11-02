"""Focused tests for readable automatic change notifications."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys


INTEGRATION = Path(__file__).parents[1] / "custom_components" / "ha_list_manager"


def _load_notifications():
    """Load the formatter without requiring a Home Assistant installation."""
    package = ModuleType("notification_test_package")
    package.__path__ = [str(INTEGRATION)]
    sys.modules[package.__name__] = package

    homeassistant = ModuleType("homeassistant")
    core = ModuleType("homeassistant.core")
    core.Event = object
    core.HomeAssistant = object
    core.callback = lambda function: function
    exceptions = ModuleType("homeassistant.exceptions")
    exceptions.HomeAssistantError = RuntimeError
    helpers = ModuleType("homeassistant.helpers")
    event = ModuleType("homeassistant.helpers.event")
    event.async_call_later = lambda *_args, **_kwargs: None
    sys.modules.update(
        {
            "homeassistant": homeassistant,
            "homeassistant.core": core,
            "homeassistant.exceptions": exceptions,
            "homeassistant.helpers": helpers,
            "homeassistant.helpers.event": event,
        }
    )

    for sibling in ("database", "models"):
        module = ModuleType(f"{package.__name__}.{sibling}")
        if sibling == "database":
            module.HaListManagerDatabase = object
        else:
            for name in (
                "ListItemRecord",
                "ListNotificationAssignmentRecord",
                "ListRecord",
                "NotificationPendingBatchRecord",
                "NotificationProfileRecord",
            ):
                setattr(module, name, object)
        sys.modules[module.__name__] = module
    const = ModuleType(f"{package.__name__}.const")
    const.EVENT_ITEM_MUTATED = "test_event"
    sys.modules[const.__name__] = const

    name = f"{package.__name__}.notifications"
    spec = spec_from_file_location(name, INTEGRATION / "notifications.py")
    assert spec and spec.loader
    module = module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


NOTIFICATIONS = _load_notifications()


def _assignment():
    return SimpleNamespace(
        notify_on_add=True,
        notify_on_increase=True,
        notify_on_decrease=True,
        notify_on_edit=True,
        notify_on_complete=True,
        notify_on_reopen=True,
        notify_on_delete=True,
    )


def test_quantity_change_states_old_and_new_value() -> None:
    message = NOTIFICATIONS.NotificationManager._format_changes(
        {
            "beer": {
                "before": {"name": "Bier", "quantity": 3},
                "after": {"name": "Bier", "quantity": 4},
            }
        },
        _assignment(),
        "text",
    )

    assert "Anzahl erhöht:" in message
    assert "Bier: von 3 auf 4" in message
    assert "Bearbeitet" not in message


def test_todo_edit_describes_each_visible_change() -> None:
    message = NOTIFICATIONS.NotificationManager._format_changes(
        {
            "task": {
                "before": {
                    "name": "Müll rausbringen",
                    "description": "",
                    "quantity": 1,
                    "category": None,
                    "category_id": None,
                    "due_at": None,
                    "recurrence_interval": None,
                    "recurrence_unit": None,
                    "labels": [{"id": "home", "name": "Zuhause"}],
                },
                "after": {
                    "name": "Mülltonne rausstellen",
                    "description": "Gelbe Tonne",
                    "quantity": 1,
                    "category": "Haushalt",
                    "category_id": "household",
                    "due_at": "2026-10-16T12:42:00",
                    "recurrence_interval": 7,
                    "recurrence_unit": "D",
                    "labels": [{"id": "outside", "name": "Draußen"}],
                },
            }
        },
        _assignment(),
        "markdown",
    )

    assert "**Name geändert**" in message
    assert "Müll rausbringen → Mülltonne rausstellen" in message
    assert "**Beschreibung ergänzt**" in message
    assert "**Fälligkeit gesetzt**" in message
    assert "Mülltonne rausstellen: 16.10.2026, 12:42" in message
    assert "**Kategorie geändert**" in message
    assert "Allgemein → Haushalt" in message
    assert "**Labels geändert**" in message
    assert "hinzugefügt: Draußen; entfernt: Zuhause" in message
    assert "**Wiederholung festgelegt**" in message
    assert "alle 7 Tage" in message
    assert "Bearbeitet" not in message


def test_removed_due_date_and_html_are_readable_and_escaped() -> None:
    message = NOTIFICATIONS.NotificationManager._format_changes(
        {
            "task": {
                "before": {
                    "name": "A&B",
                    "quantity": 1,
                    "due_at": "2026-10-16",
                },
                "after": {"name": "A&B", "quantity": 1, "due_at": None},
            }
        },
        _assignment(),
        "html",
    )

    assert "<h3>Fälligkeit entfernt</h3>" in message
    assert "A&amp;B: bisher 16.10.2026" in message


def _list_item(**overrides):
    values = {
        "name": "Aufgabe",
        "description": None,
        "quantity": 1,
        "category": None,
        "due_at": None,
        "recurrence_interval": None,
        "recurrence_unit": None,
        "completed": False,
        "offer_only": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_todo_full_list_includes_due_status_description_and_recurrence() -> None:
    message = NOTIFICATIONS.NotificationManager._format_list(
        SimpleNamespace(name="Aufgaben", list_type="todo"),
        [
            _list_item(
                name="Müll rausbringen",
                description="Gelbe Tonne",
                category="Haushalt",
                due_at="2000-01-01",
                recurrence_interval=7,
                recurrence_unit="D",
            ),
            _list_item(name="Erledigt", completed=True),
        ],
        "markdown",
    )

    assert "**Haushalt**" in message
    assert "Müll rausbringen — Gelbe Tonne · Überfällig: 01.01.2000 · alle 7 Tage" in message
    assert "Erledigt" not in message


def test_todo_full_list_html_escapes_details_and_shopping_keeps_quantity() -> None:
    todo_message = NOTIFICATIONS.NotificationManager._format_list(
        SimpleNamespace(name="A&B", list_type="todo"),
        [_list_item(name="Putzen", description="Bad < Küche")],
        "html",
    )
    shopping_message = NOTIFICATIONS.NotificationManager._format_list(
        SimpleNamespace(name="Einkauf", list_type="shopping"),
        [_list_item(name="Milch", quantity=3)],
        "text",
    )

    assert "<h2>A&amp;B</h2>" in todo_message
    assert "<small>Bad &lt; Küche</small>" in todo_message
    assert "Milch × 3" in shopping_message



def test_shopping_offer_marker_is_in_every_notification_format():
    for fmt in ("html", "text", "markdown"):
        message = NOTIFICATIONS.NotificationManager._format_list(
            SimpleNamespace(name="Einkauf", list_type="shopping"),
            [_list_item(name="Milch", quantity=3, offer_only=True)], fmt,
        )
        assert "Nur im Angebot" in message and "Milch" in message
