"""Authenticated relay for recipe images hosted on a private Tandoor instance."""

from __future__ import annotations

import secrets

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.helpers.http import KEY_HASS

from .const import DOMAIN
from .tandoor import TandoorError


class TandoorRecipeImageView(HomeAssistantView):
    """Expose only known recipe images without leaking the Tandoor token."""

    url = f"/api/{DOMAIN}/tandoor/image/{{recipe_id}}"
    name = f"api:{DOMAIN}:tandoor:image"
    requires_auth = False

    async def get(self, request: web.Request, recipe_id: str) -> web.Response:
        runtime = request.app[KEY_HASS].data.get(DOMAIN)
        supplied_token = str(request.query.get("token") or "")
        if runtime is None or not secrets.compare_digest(supplied_token, runtime.tandoor_image_token):
            raise web.HTTPUnauthorized()
        try:
            numeric_id = int(recipe_id)
            if numeric_id < 1 or runtime.tandoor is None:
                raise ValueError
            data, content_type = await runtime.tandoor.async_recipe_image(numeric_id)
        except ValueError as error:
            raise web.HTTPBadRequest() from error
        except TandoorError as error:
            raise web.HTTPBadGateway(text=str(error)) from error
        return web.Response(
            body=data,
            content_type=content_type,
            headers={"Cache-Control": "private, max-age=300"},
        )
