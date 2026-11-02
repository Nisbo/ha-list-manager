"""Authenticated, admin-only backup download and two-step restore."""
import asyncio
from datetime import UTC, datetime
from functools import wraps
import secrets

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.helpers.http import KEY_HASS

from .const import DOMAIN
from .data_backup import MANAGER_KEY, MAX_UPLOAD_SIZE, BackupError, DataBackupManager, remove_temporary
from .localization import async_use_language, system_language, text


def localized_request(handler):
    """Keep backup errors in the requesting UI's language across awaits."""
    @wraps(handler)
    async def wrapped(self, request, operation):
        async with async_use_language(
            request.app[KEY_HASS], request.query.get('language') or system_language(),
        ):
            return await handler(self, request, operation)
    return wrapped


class DataBackupView(HomeAssistantView):
    url = f'/api/{DOMAIN}/backup/{{operation}}'
    name = f'api:{DOMAIN}:backup'
    requires_auth = True

    def manager(self, request):
        user = request.get('hass_user')
        if user is None or not user.is_admin:
            raise web.HTTPForbidden()
        hass = request.app[KEY_HASS]
        if MANAGER_KEY not in hass.data:
            hass.data[MANAGER_KEY] = DataBackupManager(hass)
        return hass.data[MANAGER_KEY], user

    @localized_request
    async def get(self, request, operation):
        manager, _ = self.manager(request)
        if operation == 'info':
            return web.json_response({
                'backups': await manager.listing(),
                'database_path': str(manager.runtime().database.path),
                'archive_path': str(manager.archive), 'max_upload_size': MAX_UPLOAD_SIZE,
            })
        if operation != 'download':
            raise web.HTTPNotFound()
        try:
            path = await manager.download(request.query.get('backup_id'))
        except BackupError as err:
            raise web.HTTPBadRequest(text=str(err)) from err
        try:
            response = web.StreamResponse(headers={
                'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
                'Content-Disposition': f'attachment; filename="ha-list-manager-{operation}-{datetime.now(UTC):%Y%m%d-%H%M%S}.db"',
            })
            response.content_length = (await manager.hass.async_add_executor_job(path.stat)).st_size
            await response.prepare(request)
            stream = await manager.hass.async_add_executor_job(path.open, 'rb')
            try:
                while chunk := await manager.hass.async_add_executor_job(stream.read, 256 * 1024):
                    await response.write(chunk)
            finally:
                await manager.hass.async_add_executor_job(stream.close)
            await response.write_eof()
            return response
        finally:
            remove_temporary(path)

    @localized_request
    async def post(self, request, operation):
        manager, user = self.manager(request)
        try:
            if operation == 'validate':
                path = manager.directory / f'{secrets.token_hex(16)}.db'
                try:
                    size = 0
                    stream = await manager.hass.async_add_executor_job(path.open, 'wb')
                    try:
                        async for chunk in request.content.iter_chunked(256 * 1024):
                            size += len(chunk)
                            if size > MAX_UPLOAD_SIZE:
                                raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD_SIZE, actual_size=size)
                            await manager.hass.async_add_executor_job(stream.write, chunk)
                    finally:
                        await manager.hass.async_add_executor_job(stream.close)
                    result = await manager.prepare(path, request.query.get('filename'))
                    return web.json_response({'backup': result})
                finally:
                    remove_temporary(path)
            if operation == 'create':
                return web.json_response({'backup': await manager.create()})
            if operation in {'restore', 'delete'}:
                try:
                    body = await request.json()
                except (ValueError, TypeError) as err:
                    raise web.HTTPBadRequest(text=text('backup.confirm_required')) from err
                if not isinstance(body, dict) or not isinstance(body.get('backup_id'), str) or body.get('confirm') is not True:
                    raise web.HTTPBadRequest(text=text('backup.confirm_required'))
                if operation == 'delete':
                    await manager.delete(body['backup_id'])
                    return web.json_response({'deleted': True})
                # A disconnected browser must not interrupt a restore halfway.
                task = manager.hass.async_create_task(manager.restore(body['backup_id']), 'HA-LM database restore')
                return web.json_response(await asyncio.shield(task))
            raise web.HTTPNotFound()
        except BackupError as err:
            raise web.HTTPBadRequest(text=str(err)) from err
