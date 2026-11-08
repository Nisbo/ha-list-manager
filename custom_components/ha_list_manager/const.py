"""Constants for HA List Manager."""

from typing import Final

DOMAIN: Final = "ha_list_manager"
INTEGRATION_NAME: Final = "HA List Manager"
VERSION: Final = "1.0.0b9"
DATABASE_FILENAME: Final = "ha_list_manager.db"
DATABASE_SCHEMA_VERSION: Final = 1
LIST_TYPES: Final = ("shopping", "todo", "inventory")
LIST_PROVIDERS: Final = ("local", "bring")
SCANNER_ACTIONS: Final = ("add", "remove", "register", "correct")
SCANNER_ROUTING: Final = ("active_target", "fixed")
EVENT_INVENTORY_CHANGED: Final = f"{DOMAIN}_inventory_changed"
EVENT_SCANNER_TARGET_CHANGED: Final = f"{DOMAIN}_scanner_target_changed"
EVENT_SCAN_PROCESSED: Final = f"{DOMAIN}_scan_processed"
EVENT_LISTS_CHANGED: Final = f"{DOMAIN}_lists_changed"
EVENT_ITEMS_CHANGED: Final = f"{DOMAIN}_items_changed"
EVENT_ITEM_MUTATED: Final = f"{DOMAIN}_item_mutated"

PANEL_ELEMENT_NAME: Final = "ha-list-manager-panel"
PANEL_ICON: Final = "mdi:cart-variant"
PANEL_STATIC_URL: Final = f"/{DOMAIN}_static"
PANEL_TITLE: Final = "HA List Manager"
PANEL_URL_PATH: Final = DOMAIN

DATA_STATIC_PATH_REGISTERED: Final = f"{DOMAIN}_static_path_registered"
DATA_WEBSOCKET_REGISTERED: Final = f"{DOMAIN}_websocket_registered"

EVENT_SCRIPT_ACTION: Final = f"{DOMAIN}_script_action"
