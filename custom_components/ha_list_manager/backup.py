"""Home Assistant backup hooks for the integration's WAL database."""
from .const import DOMAIN
from .data_backup import atomic_executor, checkpoint

_LOCKED_DATABASE = f'{DOMAIN}_backup_locked_database'


async def async_pre_backup(hass):
    runtime = hass.data.get(DOMAIN)
    if runtime is None:
        return
    database = runtime.database
    await database._lock.acquire()
    try:
        database._check_available()
        await atomic_executor(hass, checkpoint, database)
        hass.data[_LOCKED_DATABASE] = database
    except BaseException:
        database._lock.release()
        raise


async def async_post_backup(hass):
    database = hass.data.pop(_LOCKED_DATABASE, None)
    if database is not None:
        database._lock.release()
