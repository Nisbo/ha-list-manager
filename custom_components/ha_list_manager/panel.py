"""Frontend panel registration for HA List Manager."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.frontend import async_panel_exists
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.core import HomeAssistant

from .const import (
    DATA_STATIC_PATH_REGISTERED,
    PANEL_ELEMENT_NAME,
    PANEL_ICON,
    PANEL_STATIC_URL,
    PANEL_TITLE,
    PANEL_URL_PATH,
    VERSION,
)

_LOGGER = logging.getLogger(__name__)
FRONTEND_DIRECTORY = Path(__file__).parent / "frontend"
PANEL_MODULE_URL = f"{PANEL_STATIC_URL}/ha-list-manager-panel.js?v={VERSION}"
INVENTORY_CARD_MODULE_URL = (
    f"{PANEL_STATIC_URL}/ha-list-manager-inventory-card.js?v={VERSION}"
)
INVENTORY_CARD_RESOURCE_PATH = (
    f"{PANEL_STATIC_URL}/ha-list-manager-inventory-card.js"
)
SHOPPING_CARD_MODULE_URL = (
    f"{PANEL_STATIC_URL}/ha-list-manager-shopping-card.js?v={VERSION}"
)
SHOPPING_CARD_RESOURCE_PATH = (
    f"{PANEL_STATIC_URL}/ha-list-manager-shopping-card.js"
)
TODO_CARD_MODULE_URL = (
    f"{PANEL_STATIC_URL}/ha-list-manager-todo-card.js?v={VERSION}"
)
TODO_CARD_RESOURCE_PATH = (
    f"{PANEL_STATIC_URL}/ha-list-manager-todo-card.js"
)
HISTORY_CARD_MODULE_URL = (
    f"{PANEL_STATIC_URL}/ha-list-manager-history-card.js?v={VERSION}"
)
HISTORY_CARD_RESOURCE_PATH = (
    f"{PANEL_STATIC_URL}/ha-list-manager-history-card.js"
)


async def _async_register_frontend_cards(hass: HomeAssistant) -> None:
    """Register backend-backed Lovelace cards after the registry is ready."""
    lovelace = hass.data["lovelace"]
    resources = (
        lovelace.resources if hasattr(lovelace, "resources") else lovelace["resources"]
    )
    await resources.async_get_info()

    registered = {item.get("url", "").split("?", 1)[0]: item for item in resources.async_items()}
    card_resources = (
        (INVENTORY_CARD_RESOURCE_PATH, INVENTORY_CARD_MODULE_URL),
        (SHOPPING_CARD_RESOURCE_PATH, SHOPPING_CARD_MODULE_URL),
        (TODO_CARD_RESOURCE_PATH, TODO_CARD_MODULE_URL),
        (HISTORY_CARD_RESOURCE_PATH, HISTORY_CARD_MODULE_URL),
    )
    if isinstance(resources, ResourceStorageCollection):
        for path, module_url in card_resources:
            item = registered.get(path)
            if item and item.get("url") == module_url and item.get("type") == "module":
                continue
            if item:
                await resources.async_update_item(item["id"], {"res_type": "module", "url": module_url})
            else:
                await resources.async_create_item({"res_type": "module", "url": module_url})
        return

    # YAML resource collections cannot be changed by an integration. Retain the
    # previous fallback for those installations.
    _LOGGER.warning(
        "Lovelace resources use YAML mode; loading backend cards through "
        "the frontend fallback"
    )
    frontend.add_extra_js_url(hass, INVENTORY_CARD_MODULE_URL)
    frontend.add_extra_js_url(hass, SHOPPING_CARD_MODULE_URL)
    frontend.add_extra_js_url(hass, TODO_CARD_MODULE_URL)
    frontend.add_extra_js_url(hass, HISTORY_CARD_MODULE_URL)


async def async_register_panel(hass: HomeAssistant) -> None:
    """Register the administrator-only sidebar panel."""
    if not hass.data.get(DATA_STATIC_PATH_REGISTERED):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    PANEL_STATIC_URL,
                    str(FRONTEND_DIRECTORY),
                    cache_headers=False,
                )
            ]
        )
        hass.data[DATA_STATIC_PATH_REGISTERED] = True

    await _async_register_frontend_cards(hass)

    if async_panel_exists(hass, PANEL_URL_PATH):
        return

    await panel_custom.async_register_panel(
        hass=hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT_NAME,
        module_url=PANEL_MODULE_URL,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        embed_iframe=False,
        require_admin=True,
        handle_safe_area=True,
    )


def async_unregister_panel(hass: HomeAssistant) -> None:
    """Remove the sidebar panel when the config entry is unloaded."""
    if async_panel_exists(hass, PANEL_URL_PATH):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
