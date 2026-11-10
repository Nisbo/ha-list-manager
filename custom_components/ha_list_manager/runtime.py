"""Runtime state for HA List Manager."""

from dataclasses import dataclass, field
import secrets
from typing import TYPE_CHECKING

from homeassistant.config_entries import ConfigEntry

from .database import HaListManagerDatabase

if TYPE_CHECKING:
    from .alexa import AlexaInboxManager
    from .entity_history import EntityHistoryManager
    from .external_lists import ExternalListManager
    from .legacy_import_manager import LegacyImportManager
    from .notifications import NotificationManager
    from .scanner import ScannerManager
    from .scripts import ListScriptManager
    from .tandoor import TandoorClient


@dataclass(slots=True)
class HaListManagerRuntime:
    """Objects owned by the configured integration instance."""

    database: HaListManagerDatabase
    config_entry: ConfigEntry
    alexa: "AlexaInboxManager | None" = None
    scanner: "ScannerManager | None" = None
    notifications: "NotificationManager | None" = None
    scripts: "ListScriptManager | None" = None
    external_lists: "ExternalListManager | None" = None
    legacy_import: "LegacyImportManager | None" = None
    entity_history: "EntityHistoryManager | None" = None
    tandoor: "TandoorClient | None" = None
    tandoor_config: tuple[str, str] | None = None
    tandoor_image_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
