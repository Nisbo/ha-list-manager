"""Frontend panel registration for HA List Manager."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.frontend import async_panel_exists
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.core import HomeAssistant

from .frontend_assets import (
    ASSETS_KEY, ASSETS_URL, EVENT_FRONTEND_CHANGED, FrontendAssets, FrontendAssetView,
    assets_for, read_snapshot,
)

from .const import (
    DATA_STATIC_PATH_REGISTERED,
    PANEL_ELEMENT_NAME,
    PANEL_ICON,
    PANEL_STATIC_URL,
    PANEL_TITLE,
    PANEL_URL_PATH,
)

_LOGGER = logging.getLogger(__name__)
FRONTEND_DIRECTORY = Path(__file__).parent / "frontend"
CARD_FILES = (
    "ha-list-manager-inventory-card.js", "ha-list-manager-shopping-card.js",
    "ha-list-manager-todo-card.js", "ha-list-manager-history-card.js",
)


def _resource_filename(url: str) -> str | None:
    path = url.split("?", 1)[0]
    if path.startswith((PANEL_STATIC_URL + "/", ASSETS_URL + "/")):
        filename = path.rsplit("/", 1)[-1]
        if filename in CARD_FILES:
            return filename
    return None


async def _async_register_frontend_cards(hass: HomeAssistant) -> None:
    """Register backend-backed Lovelace cards after the registry is ready."""
    lovelace = hass.data["lovelace"]
    resources = (
        lovelace.resources if hasattr(lovelace, "resources") else lovelace["resources"]
    )
    await resources.async_get_info()

    registered = {name: item for item in resources.async_items()
                  if (name := _resource_filename(item.get("url", ""))) is not None}
    card_resources = [(name, assets_for(hass).url(name)) for name in CARD_FILES]
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
    previous = hass.data.get(f"{ASSETS_KEY}_yaml_urls", ())
    for url in previous:
        frontend.remove_extra_js_url(hass, url)
    for _, url in card_resources:
        frontend.add_extra_js_url(hass, url)
    hass.data[f"{ASSETS_KEY}_yaml_urls"] = [url for _, url in card_resources]


async def async_register_panel(hass: HomeAssistant, *, renew: bool = False) -> None:
    """Publish one asset revision for every frontend entry point."""
    if ASSETS_KEY not in hass.data:
        hass.data[ASSETS_KEY] = FrontendAssets()
        hass.http.register_view(FrontendAssetView())
    assets = assets_for(hass)
    async with assets.lock:
        revision, files = await hass.async_add_executor_job(read_snapshot)
        assets.install(revision, files, renew=renew)
        if not hass.data.get(DATA_STATIC_PATH_REGISTERED):
            await hass.http.async_register_static_paths([
                StaticPathConfig(PANEL_STATIC_URL, str(FRONTEND_DIRECTORY), cache_headers=False)
            ])
            hass.data[DATA_STATIC_PATH_REGISTERED] = True
        await _async_register_frontend_cards(hass)
        module_url = assets.url("ha-list-manager-panel.js")
        if async_panel_exists(hass, PANEL_URL_PATH):
            frontend.async_register_built_in_panel(
                hass, component_name="custom", frontend_url_path=PANEL_URL_PATH,
                sidebar_title=PANEL_TITLE, sidebar_icon=PANEL_ICON, require_admin=True,
                config={"_panel_custom": {"name": PANEL_ELEMENT_NAME, "embed_iframe": False,
                        "trust_external": False, "handle_safe_area": True, "module_url": module_url}},
                update=True,
            )
        else:
            await panel_custom.async_register_panel(
                hass=hass, frontend_url_path=PANEL_URL_PATH, webcomponent_name=PANEL_ELEMENT_NAME,
                module_url=module_url, sidebar_title=PANEL_TITLE, sidebar_icon=PANEL_ICON,
                embed_iframe=False, require_admin=True, handle_safe_area=True,
            )
        hass.bus.async_fire(EVENT_FRONTEND_CHANGED, assets.info())


def async_unregister_panel(hass: HomeAssistant) -> None:
    """Remove the sidebar panel when the config entry is unloaded."""
    if async_panel_exists(hass, PANEL_URL_PATH):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
