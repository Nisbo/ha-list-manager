"""Consistent SQLite snapshots and validated, administrator-owned restore staging."""
from __future__ import annotations

import asyncio
from contextlib import closing
from contextvars import copy_context
import os
from pathlib import Path
import secrets
import sqlite3
from tempfile import TemporaryDirectory
import json
import re
from datetime import UTC, datetime

from .const import DATABASE_SCHEMA_VERSION, DOMAIN
from .database import HaListManagerDatabase, HaListManagerDatabaseError
from .localization import async_use_language, text

MANAGER_KEY = f"{DOMAIN}_data_backup"
MAX_UPLOAD_SIZE = 512 * 1024 * 1024


class BackupError(HaListManagerDatabaseError):
    """A backup could not be validated or restored safely."""


async def atomic_executor(hass, function, *args):
    """Do not release a database lock while a cancelled executor job still runs."""
    async with async_use_language(hass):
        context = copy_context()
        future = asyncio.ensure_future(hass.async_add_executor_job(context.run, function, *args))
        cancelled = None
        while True:
            try:
                result = await asyncio.shield(future)
                break
            except asyncio.CancelledError as error:
                if future.cancelled():
                    raise
                cancelled = error
        if cancelled is not None:
            raise cancelled
        return result


def snapshot(source: Path, destination: Path) -> None:
    """SQLite's backup API includes committed WAL pages in a standalone file."""
    temporary = destination.with_name(destination.name + '.partial')
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(temporary)) as dst:
            src.backup(dst)
            dst.execute('PRAGMA journal_mode=DELETE')
        os.chmod(temporary, 0o600)
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def apply_snapshot(source: Path, destination: Path) -> None:
    """Restore through SQLite, never replace a file underneath its WAL."""
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(destination, timeout=30)) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise BackupError(text('backup.invalid'))
        if dst.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
            raise BackupError(text('backup.busy'))


def checkpoint(database) -> None:
    with closing(database._connect()) as connection:
        if connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
            raise BackupError(text('backup.busy'))


def validate(path: Path) -> dict:
    """Validate a supported snapshot without modifying the supplied database."""
    try:
        with path.open('rb') as stream:
            if stream.read(16) != b'SQLite format 3\x00':
                raise BackupError(text('backup.invalid'))
        with TemporaryDirectory(prefix='ha-list-manager-schema-') as directory:
            baseline = Path(directory) / 'schema.db'
            HaListManagerDatabase(None, baseline)._initialize()
            with closing(sqlite3.connect(baseline)) as expected:
                allowed_triggers = dict(expected.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'"))
                with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as connection:
                    connection.execute('PRAGMA trusted_schema=OFF')
                    triggers = dict(connection.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'"))
                    if connection.execute("SELECT 1 FROM sqlite_master WHERE type='view'").fetchone() or any(allowed_triggers.get(name) != sql for name, sql in triggers.items()):
                        raise BackupError(text('backup.invalid'))
                    if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise BackupError(text('backup.invalid'))
                    version = int(connection.execute("SELECT value FROM schema_metadata WHERE key='schema_version'").fetchone()[0])
                    if version != DATABASE_SCHEMA_VERSION:
                        raise BackupError(text('backup.version'))
                    expected_tables = {row[0] for row in expected.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    actual_tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    if expected_tables != actual_tables:
                        raise BackupError(text('backup.invalid'))
                    for table in expected_tables:
                        # Names come exclusively from our freshly created schema.
                        cols = lambda con: {(row[1], row[2].upper()) for row in con.execute(f'PRAGMA table_info("{table}")')}
                        if cols(expected) != cols(connection):
                            raise BackupError(text('backup.invalid'))
                    if dict(connection.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'")) != allowed_triggers or connection.execute('PRAGMA foreign_key_check').fetchone():
                        raise BackupError(text('backup.invalid'))
                    summary = {key: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for key, table in (
                        ('lists', 'lists'), ('products', 'products'), ('inventory', 'inventory_entries'), ('items', 'list_items'))}
                    summary.update(schema_version=DATABASE_SCHEMA_VERSION)
        return summary
    except BackupError:
        raise
    except (sqlite3.Error, ValueError, TypeError, IndexError, OSError) as err:
        raise BackupError(text('backup.invalid')) from err


def remove_temporary(path):
    """Remove a work file and any SQLite sidecars left by its operations."""
    for suffix in ('', '-wal', '-shm', '-journal'):
        Path(str(path) + suffix).unlink(missing_ok=True)


class DataBackupManager:
    """A persistent file archive, independent from the database being restored."""

    def __init__(self, hass):
        self.hass = hass
        self.archive = Path(hass.config.path('ha_list_manager_backups'))
        self._directory = TemporaryDirectory(prefix='ha-list-manager-backup-')
        self.directory = Path(self._directory.name)
        self.operation_lock = asyncio.Lock()

    def runtime(self):
        runtime = self.hass.data.get(DOMAIN)
        if runtime is None:
            raise BackupError(text('backup.unavailable'))
        return runtime

    def _path(self, backup_id):
        if not isinstance(backup_id, str) or not re.fullmatch(r'[a-f0-9]{32}', backup_id):
            raise BackupError(text('backup.not_found'))
        path = self.archive / f'{backup_id}.db'
        if not path.is_file() or path.is_symlink():
            raise BackupError(text('backup.not_found'))
        return path

    def _record(self, path):
        metadata = path.with_suffix('.json')
        record = {}
        try:
            if not metadata.is_symlink():
                record = json.loads(metadata.read_text())
                if not isinstance(record, dict):
                    record = {}
        except (OSError, ValueError):
            pass
        return {
            'id': path.stem, 'name': str(record.get('name') or path.name),
            'origin': record.get('origin', 'uploaded'),
            'created_at': record.get('created_at') or datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
            'size': path.stat().st_size, 'summary': record.get('summary') or {},
        }

    def _store(self, source, origin, name, summary):
        self.archive.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup_id = secrets.token_hex(16)
        path = self.archive / f'{backup_id}.db'
        work = self.directory / f'{secrets.token_hex(16)}.db'
        try:
            snapshot(source, work)
            summary = summary or validate(work)
            snapshot(work, path)
        finally:
            remove_temporary(work)
        record = {'name': name, 'origin': origin, 'created_at': datetime.now(UTC).isoformat(), 'summary': summary}
        metadata = path.with_suffix('.json')
        temporary = metadata.with_suffix('.json.partial')
        try:
            with temporary.open('w', encoding='utf-8') as stream:
                os.chmod(temporary, 0o600)
                json.dump(record, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, metadata)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        finally:
            temporary.unlink(missing_ok=True)
        return self._record(path)

    def _list(self):
        if not self.archive.exists():
            return []
        paths = [p for p in self.archive.glob('*.db') if re.fullmatch(r'[a-f0-9]{32}', p.stem) and not p.is_symlink()]
        return sorted((self._record(p) for p in paths), key=lambda record: record['created_at'], reverse=True)

    async def listing(self):
        async with self.operation_lock:
            return await atomic_executor(self.hass, self._list)

    async def prepare(self, path, filename):
        """Keep every valid upload; invalid files never enter the archive."""
        async with self.operation_lock:
            summary = await atomic_executor(self.hass, validate, path)
            name = str(filename or text('backend.backup_default_filename')).replace('\\', '/').rsplit('/', 1)[-1][:200]
            return await atomic_executor(self.hass, self._store, path, 'uploaded', name, summary)

    async def create(self):
        async with self.operation_lock:
            return await self.create_locked()

    async def create_locked(self, *, origin='created', name=None):
        """Snapshot while the caller holds operation_lock through a following write."""
        database = self.runtime().database
        path = self.directory / f'{secrets.token_hex(16)}.db'
        try:
            async with database._lock:
                database._check_available()
                await atomic_executor(self.hass, snapshot, database.path, path)
            summary = await atomic_executor(self.hass, validate, path)
            return await atomic_executor(self.hass, self._store, path, origin, name or text('backup.created_name'), summary)
        finally:
            remove_temporary(path)

    async def download(self, backup_id):
        async with self.operation_lock:
            source = self._path(backup_id)
            path = self.directory / f'{secrets.token_hex(16)}.db'
            await atomic_executor(self.hass, snapshot, source, path)
            return path

    async def delete(self, backup_id):
        async with self.operation_lock:
            path = self._path(backup_id)
            path.unlink()
            path.with_suffix('.json').unlink(missing_ok=True)

    async def restore(self, backup_id):
        async with self.operation_lock:
            source = self._path(backup_id)
            path = self.directory / f'{secrets.token_hex(16)}.db'
            try:
                await atomic_executor(self.hass, snapshot, source, path)
                await atomic_executor(self.hass, validate, path)
                runtime = self.runtime()
                database, config_entry = runtime.database, runtime.config_entry
                self.hass.data[f'{DOMAIN}_restore_in_progress'] = True
                try:
                    async with database._lock:
                        database._check_available()
                        database._retired = True
                    try:
                        if not await self.hass.config_entries.async_unload(config_entry.entry_id):
                            raise BackupError(text('backup.unload_failed'))
                    except Exception:
                        database._retired = False
                        raise
                    recovery = None
                    try:
                        record = await atomic_executor(self.hass, self._store, database.path, 'safety', text('backup.safety_name'), {})
                        recovery = self._path(record['id'])
                        await atomic_executor(self.hass, apply_snapshot, path, database.path)
                        if not await self.hass.config_entries.async_setup(config_entry.entry_id):
                            raise BackupError(text('backup.reload_failed'))
                    except Exception as err:
                        if self.hass.data.get(DOMAIN):
                            await self.hass.config_entries.async_unload(config_entry.entry_id)
                        if recovery is not None:
                            await atomic_executor(self.hass, apply_snapshot, recovery, database.path)
                        if not await self.hass.config_entries.async_setup(config_entry.entry_id):
                            raise BackupError(text('backup.recovery_failed')) from err
                        raise BackupError(text('backup.restore_rolled_back')) from err
                    return {'restored': True, 'safety_backup_id': record['id']}
                finally:
                    self.hass.data.pop(f'{DOMAIN}_restore_in_progress', None)
            finally:
                remove_temporary(path)
