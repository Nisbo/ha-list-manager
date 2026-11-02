"""Import retained Home Assistant history into Entity-Inventar."""

from __future__ import annotations

from datetime import UTC, datetime
from functools import partial
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder import history, statistics
from homeassistant.core import HomeAssistant, State

from .database import HaListManagerDatabase

_MAX_IMPORT_ROWS = 200_000


def _state_snapshot(state: State) -> dict[str, Any]:
    """Copy a Recorder state while its database session is available."""
    last_reported = getattr(state, "last_reported", None)
    return {
        "state": state.state,
        "attributes": dict(state.attributes),
        "last_changed": state.last_changed.isoformat(),
        "last_updated": state.last_updated.isoformat(),
        "last_reported": last_reported.isoformat() if last_reported else None,
    }


def _read_recorder_states(
    hass: HomeAssistant,
    entity_id: str,
    start_time: datetime,
    end_time: datetime | None,
) -> tuple[list[dict[str, Any]], bool]:
    """Read exact state-machine rows in the Recorder executor."""
    result = history.get_significant_states(
        hass,
        start_time,
        end_time,
        entity_ids=[entity_id],
        include_start_time_state=False,
        significant_changes_only=False,
        minimal_response=False,
        no_attributes=False,
    )
    rows = result.get(entity_id, [])
    truncated = len(rows) > _MAX_IMPORT_ROWS
    return ([_state_snapshot(state) for state in rows[:_MAX_IMPORT_ROWS]], truncated)


def _read_long_term_statistics(
    hass: HomeAssistant,
    entity_id: str,
    start_time: datetime,
    end_time: datetime | None,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Read hourly aggregate statistics and identify the selected value column."""
    result = statistics.statistics_during_period(
        hass,
        start_time,
        end_time,
        {entity_id},
        "hour",
        None,
        {"mean", "state", "sum", "min", "max"},
    )
    rows = result.get(entity_id, [])
    truncated = len(rows) > _MAX_IMPORT_ROWS
    current = hass.states.get(entity_id)
    unit = current.attributes.get("unit_of_measurement") if current else None
    snapshots: list[dict[str, Any]] = []
    selected_type: str | None = None
    for row in rows[:_MAX_IMPORT_ROWS]:
        value_type = next(
            (name for name in ("mean", "state", "sum") if row.get(name) is not None),
            None,
        )
        if value_type is None:
            continue
        selected_type = selected_type or value_type
        timestamp = datetime.fromtimestamp(float(row["start"]), UTC).isoformat()
        attributes: dict[str, Any] = {
            "ha_list_manager_statistic_type": value_type,
        }
        if unit:
            attributes["unit_of_measurement"] = unit
        for name in ("min", "max"):
            if row.get(name) is not None:
                attributes[f"ha_list_manager_{name}"] = row[name]
        snapshots.append(
            {
                "state": str(row[value_type]),
                "attributes": attributes,
                "last_changed": timestamp,
                "last_updated": timestamp,
                "last_reported": None,
            }
        )
    return snapshots, truncated, selected_type


async def async_import_entity_history(
    hass: HomeAssistant,
    database: HaListManagerDatabase,
    *,
    entity_id: str,
    start_time: datetime,
    end_time: datetime | None,
    include_recorder: bool,
    include_long_term_statistics: bool,
) -> dict[str, Any]:
    """Backfill one archive from Recorder and optional aggregate statistics."""
    recorder = get_instance(hass)
    result: dict[str, Any] = {
        "entity_id": entity_id,
        "recorder": None,
        "long_term_statistics": None,
        "truncated": False,
    }
    if include_recorder:
        states, truncated = await recorder.async_add_executor_job(
            partial(_read_recorder_states, hass, entity_id, start_time, end_time)
        )
        counts = await database.async_import_entity_states(
            entity_id, states, "recorder"
        )
        result["recorder"] = {**counts, "read": len(states)}
        result["truncated"] = result["truncated"] or truncated

    if include_long_term_statistics:
        states, truncated, value_type = await recorder.async_add_executor_job(
            partial(
                _read_long_term_statistics,
                hass,
                entity_id,
                start_time,
                end_time,
            )
        )
        counts = await database.async_import_entity_states(
            entity_id, states, "long_term_statistics"
        )
        result["long_term_statistics"] = {
            **counts,
            "read": len(states),
            "value_type": value_type,
        }
        result["truncated"] = result["truncated"] or truncated
    return result
