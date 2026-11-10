"""HA List Manager backend integration."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DATABASE_FILENAME, DOMAIN
from .alexa import AlexaInboxManager
from .localization import configure as configure_localization
from .backup_http import DataBackupView
from .database import HaListManagerDatabase
from .entity_history import EntityHistoryManager
from .external_lists import ExternalListManager
from .notifications import NotificationManager
from .panel import async_register_panel, async_unregister_panel
from .runtime import HaListManagerRuntime
from .scanner import ScannerManager
from .scripts import ListScriptManager
from .tandoor_image import TandoorRecipeImageView
from .websocket import async_register_websocket_commands

type HaListManagerConfigEntry = ConfigEntry[HaListManagerRuntime]

PLATFORMS: list[Platform] = [Platform.SENSOR]

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: HaListManagerConfigEntry
) -> bool:
    """Set up HA List Manager from a config entry."""
    await configure_localization(hass)
    database = HaListManagerDatabase(
        hass, Path(hass.config.path(DATABASE_FILENAME))
    )
    await database.async_initialize()

    runtime = HaListManagerRuntime(database=database, config_entry=entry)
    forward_attempted = False
    try:
        runtime.external_lists = ExternalListManager(hass, database)
        await runtime.external_lists.async_start()
        runtime.notifications = NotificationManager(hass, database)
        entry.runtime_data = runtime
        hass.data[DOMAIN] = runtime
        runtime.scripts = ListScriptManager(hass, database)
        await runtime.scripts.async_start()
        if not hass.data.get(f"{DOMAIN}_tandoor_image_view_registered"):
            hass.http.register_view(TandoorRecipeImageView)
            hass.data[f"{DOMAIN}_tandoor_image_view_registered"] = True
        await runtime.notifications.async_start()

        runtime.entity_history = EntityHistoryManager(hass, database)
        await runtime.entity_history.async_start()

        runtime.alexa = AlexaInboxManager(hass, database)
        await runtime.alexa.async_start()

        if not hass.data.get(f"{DOMAIN}_backup_view_registered"):
            hass.http.register_view(DataBackupView())
            hass.data[f"{DOMAIN}_backup_view_registered"] = True
        async_register_websocket_commands(hass)
        runtime.scanner = ScannerManager(hass, database, entry)
        await runtime.scanner.async_start()
        await async_register_panel(hass)
        forward_attempted = True
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except BaseException:
        await _async_cleanup_failed_setup(hass, entry, runtime, forward_attempted)
        raise
    return True


async def _async_cleanup_failed_setup(
    hass: HomeAssistant, entry: HaListManagerConfigEntry,
    runtime: HaListManagerRuntime, forward_attempted: bool,
) -> None:
    """Release privately owned listeners before HA retries a failed setup.

    HA only runs callbacks registered with the entry on setup failure; these
    managers also own event-bus listeners and background work outside that list.
    Global HTTP/WebSocket bindings stay registered once for the next attempt.
    """
    if forward_attempted:
        try:
            await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
        except BaseException:
            _LOGGER.exception("Could not unload platforms after setup failure")
    for name in ("alexa", "scripts", "scanner", "notifications", "external_lists", "entity_history"):
        manager = getattr(runtime, name)
        if manager is not None:
            try:
                await manager.async_stop()
            except BaseException:
                _LOGGER.exception("Could not stop %s after setup failure", name)
    if hass.data.get(DOMAIN) is runtime:
        hass.data.pop(DOMAIN)
    if getattr(entry, "runtime_data", None) is runtime:
        object.__delattr__(entry, "runtime_data")
    if not hass.data.get(f"{DOMAIN}_restore_in_progress"):
        try:
            async_unregister_panel(hass)
        except BaseException:
            _LOGGER.exception("Could not unregister the panel after setup failure")


async def async_unload_entry(
    hass: HomeAssistant, entry: HaListManagerConfigEntry
) -> bool:
    """Unload HA List Manager."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if not unloaded:
        return False
    runtime = hass.data.get(DOMAIN)
    if runtime and runtime.alexa:
        await runtime.alexa.async_stop()
    if runtime and runtime.scripts:
        await runtime.scripts.async_stop()
    if runtime and runtime.scanner:
        await runtime.scanner.async_stop()
    if runtime and runtime.notifications:
        await runtime.notifications.async_stop()
    if runtime and runtime.external_lists:
        await runtime.external_lists.async_stop()
    if runtime and runtime.entity_history:
        await runtime.entity_history.async_stop()
    hass.data.pop(DOMAIN, None)
    if not hass.data.get(f"{DOMAIN}_restore_in_progress"):
        async_unregister_panel(hass)

    return True
