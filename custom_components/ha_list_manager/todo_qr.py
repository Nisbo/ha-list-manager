"""Versioned task action codes; no product lookup or scanner target changes."""
from datetime import datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from .localization import text

PREFIX = "HA-LM:TODO:1:"
ACTIONS = {"now", "next", "done", "checked"}


def parse_code(value):
    code = str(value or "").strip()
    if not code.startswith(PREFIX):
        raise ValueError(text("todoqr.invalid"))
    parts = code[len(PREFIX):].split(":")
    if len(parts) != 2 or parts[1] not in ACTIONS:
        raise ValueError(text("todoqr.invalid"))
    try:
        item_id = str(UUID(parts[0]))
    except (ValueError, TypeError) as error:
        raise ValueError(text("todoqr.invalid")) from error
    if item_id != parts[0]:
        raise ValueError(text("todoqr.invalid"))
    return item_id, parts[1]


def validate_task(item, target, action):
    if target.list_type != "todo" or target.provider != "local" or not target.enabled:
        raise ValueError(text("todoqr.unavailable"))
    if action in {"now", "next"} and not (item.due_at and item.recurrence_interval and item.recurrence_unit in {"H", "D", "M"}):
        raise ValueError(text("todoqr.interval_required"))


def next_due(item, action, now, timezone):
    """Match the card's local calendar arithmetic, including month overflow."""
    zone = ZoneInfo(timezone)
    current = datetime.fromisoformat(now).astimezone(zone)
    base = current if action == "now" else datetime.fromisoformat(item.due_at)
    if base.tzinfo is None:
        base = base.replace(tzinfo=zone)
    else:
        base = base.astimezone(zone)
    interval, unit = item.recurrence_interval, item.recurrence_unit
    if unit in {"H", "D"}:
        step = timedelta(hours=interval) if unit == "H" else timedelta(days=interval)
        count = 1 if action == "now" else max(1, (current - base) // step + 1)
        result = base + count * step
    else:
        result = base
        while True:
            month = result.year * 12 + result.month - 1 + interval
            result = result.replace(year=month // 12, month=month % 12 + 1, day=1) + timedelta(days=result.day - 1)
            if action == "now" or result > current:
                break
    return result.date().isoformat() if len(item.due_at) == 10 and unit != "H" else result.isoformat(timespec="seconds")
