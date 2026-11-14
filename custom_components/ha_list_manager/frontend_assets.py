"""Immutable frontend snapshots shared by cards, panel and lazy dependencies."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from hashlib import sha256
from pathlib import Path
import secrets

from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView

from .const import DOMAIN, VERSION

ASSETS_KEY = f"{DOMAIN}_frontend_assets"
ASSETS_URL = f"/{DOMAIN}_assets"
EVENT_FRONTEND_CHANGED = f"{DOMAIN}_frontend_changed"
INTEGRATION_DIRECTORY = Path(__file__).parent


def read_snapshot(directory: Path = INTEGRATION_DIRECTORY) -> tuple[str, dict[str, bytes]]:
    """Read once in an executor; each URL must keep serving the same bytes."""
    digest = sha256(VERSION.encode())
    files = {}
    for folder in ("frontend", "translations"):
        for path in sorted((directory / folder).iterdir()):
            if not path.is_file() or path.is_symlink() or path.name.startswith("."):
                continue
            content = path.read_bytes()
            digest.update(f"{folder}/{path.name}\0".encode())
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
            if folder == "frontend":
                files[path.name] = content
    return digest.hexdigest()[:24], files


class FrontendAssets:
    """Keep a bounded set of coherent snapshots, without open files or timers."""

    def __init__(self):
        self.lock = asyncio.Lock()
        self.revision = ""
        self.snapshots: OrderedDict[str, dict[str, bytes]] = OrderedDict()

    def install(self, revision: str, files: dict[str, bytes], *, renew: bool = False) -> None:
        if renew:
            revision = sha256(revision.encode() + secrets.token_bytes(16)).hexdigest()[:24]
        self.revision = revision
        self.snapshots[revision] = files
        self.snapshots.move_to_end(revision)
        while len(self.snapshots) > 3:
            self.snapshots.popitem(last=False)

    def url(self, filename: str) -> str:
        return f"{ASSETS_URL}/{self.revision}/{filename}"

    def info(self) -> dict[str, str]:
        return {"revision": self.revision, "version": VERSION}


def assets_for(hass) -> FrontendAssets:
    return hass.data[ASSETS_KEY]


class FrontendAssetView(HomeAssistantView):
    # Like HA's static frontend resources, these contain only public UI files.
    url = f"{ASSETS_URL}/{{revision}}/{{filename}}"
    name = f"api:{DOMAIN}:frontend_asset"
    requires_auth = False

    async def get(self, request, revision: str, filename: str):
        assets = request.app[KEY_HASS].data.get(ASSETS_KEY)
        content = assets.snapshots.get(revision, {}).get(filename) if assets else None
        if content is None:
            raise web.HTTPNotFound(headers={"Cache-Control": "no-store"})
        return web.Response(
            body=content,
            content_type="text/javascript" if filename.endswith(".js") else "text/plain",
            headers={"Cache-Control": "public, max-age=31536000, immutable",
                     "X-Content-Type-Options": "nosniff",
                     # Let reverse proxies forward large modules without disk buffering.
                     "X-Accel-Buffering": "no"},
        )
