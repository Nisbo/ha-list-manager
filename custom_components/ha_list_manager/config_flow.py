"""Config flow for HA List Manager."""

from __future__ import annotations

from typing import Any

import probatio

from homeassistant import config_entries
from homeassistant.config_entries import ConfigFlowResult

from .const import DOMAIN, INTEGRATION_NAME


class HaListManagerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single HA List Manager backend instance."""

    VERSION = 1
    MINOR_VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle setup started by the user."""
        if user_input is not None:
            return self.async_create_entry(title=INTEGRATION_NAME, data={})

        return self.async_show_form(step_id="user", data_schema=probatio.Schema({}))
