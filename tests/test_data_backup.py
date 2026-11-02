"""Real SQLite/WAL regression tests; no live Home Assistant required."""
import asyncio
from contextlib import closing
import importlib
from pathlib import Path
import runpy
import sqlite3
import sys
import types

_fixture = runpy.run_path(str(Path(__file__).with_name('test_inventory_restock.py')))['_fixture']


def _modules(db):
    package = type(db).__module__.rsplit('.', 1)[0]
    sys.modules.pop(package+'.data_backup',None)
    sys.modules.pop(package+'.backup',None)
    return importlib.import_module(package+'.data_backup'), importlib.import_module(package+'.backup')


def test_snapshot_includes_committed_wal_and_is_standalone():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        module, _ = _modules(db)
        with closing(db._connect()) as writer:
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute('UPDATE inventory_entries SET stock=17 WHERE id=?',(entry.id,));writer.commit()
            assert Path(str(db.path)+'-wal').stat().st_size > 0
            target=db.path.parent/'snapshot.db';module.snapshot(db.path,target)
        assert not Path(str(target)+'-wal').exists()
        assert module.validate(target)['inventory']==1
        with closing(sqlite3.connect(target)) as con:
            assert con.execute('SELECT stock FROM inventory_entries WHERE id=?',(entry.id,)).fetchone()[0]==17


def test_validation_rejects_wrong_corrupt_future_and_partial_databases():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        module, _ = _modules(db)
        def rejected(path):
            try:module.validate(path)
            except module.BackupError:pass
            else:raise AssertionError(path)
        invalid=db.path.parent/'bad.db';invalid.write_bytes(b'not sqlite');rejected(invalid)
        invalid.unlink()
        with closing(sqlite3.connect(invalid)) as con:con.execute('CREATE TABLE test(value)')
        rejected(invalid)
        for sql in ["UPDATE schema_metadata SET value='999' WHERE key='schema_version'", 'DROP TABLE product_labels', 'CREATE TRIGGER malicious AFTER INSERT ON lists BEGIN SELECT 1; END', 'PRAGMA foreign_keys=OFF; INSERT INTO list_item_labels(item_id,label_id) VALUES(\'bad\',\'bad\')']:
            path=db.path.parent/'candidate.db';module.snapshot(db.path,path)
            with closing(sqlite3.connect(path)) as con:con.executescript(sql);con.commit()
            rejected(path)
        assert db._list_inventory(inventory.id)[0].stock==2


def test_validation_keeps_schema_one_snapshot_unchanged():
    directory, db, *_ = _fixture()
    with directory:
        module, _ = _modules(db);path=db.path.parent/'upload.db';module.snapshot(db.path,path)
        before=path.read_bytes()
        path.chmod(0o400)
        summary=module.validate(path)
        assert summary['schema_version']==1
        assert 'original_schema_version' not in summary
        assert path.read_bytes()==before
        assert not Path(str(path)+'-wal').exists()
        assert not Path(str(path)+'-shm').exists()
        assert db._schema_version()==1


def test_unsupported_upload_versions_are_not_changed_or_archived():
    directory,db,shopping,inventory,entry=_fixture()
    with directory:
        module,_=_modules(db)
        async def scenario():
            hass=_Hass(db,module);manager=module.DataBackupManager(hass)
            for version in (0,25,999):
                path=manager.directory/f'unsupported-{version}.db';module.snapshot(db.path,path)
                with closing(sqlite3.connect(path)) as connection:
                    connection.execute("UPDATE schema_metadata SET value=? WHERE key='schema_version'",(str(version),));connection.commit()
                before=path.read_bytes()
                try:await manager.prepare(path,path.name)
                except module.BackupError:pass
                else:raise AssertionError(f'Unsupported schema {version} accepted')
                assert path.read_bytes()==before
                assert not await manager.listing()
            assert db._schema_version()==1
            assert db._list_inventory(inventory.id)[0].stock==2
        asyncio.run(scenario())


class _Hass:
    def __init__(self,db,module):
        self.data={module.DOMAIN:types.SimpleNamespace(database=db,config_entry=types.SimpleNamespace(entry_id='test'))}
        self.config=types.SimpleNamespace(path=lambda name:str(db.path.parent/name))
        self.config_entries=types.SimpleNamespace(async_unload=self.unload,async_setup=self.setup)
        self.db,self.module,self.fail_setup,self.fail_unload=db,module,False,False
    def async_add_executor_job(self,fn,*args):return asyncio.get_running_loop().run_in_executor(None,fn,*args)
    async def unload(self,entry_id):
        assert self.data.get(f'{self.module.DOMAIN}_restore_in_progress'), 'Panel must stay registered during restore'
        if self.fail_unload:return False
        self.data.pop(self.module.DOMAIN,None);return True
    async def setup(self,entry_id):
        if self.fail_setup:self.fail_setup=False;return False
        db=type(self.db)(self,self.db.path);await db.async_initialize()
        self.data[self.module.DOMAIN]=types.SimpleNamespace(database=db,config_entry=types.SimpleNamespace(entry_id='test'));return True


def test_archive_survives_restart_restores_repeatedly_and_all_origins_are_deletable():
    directory,db,shopping,inventory,entry=_fixture()
    with directory:
        module,_=_modules(db)
        async def scenario():
            hass=_Hass(db,module);db._hass=hass;manager=module.DataBackupManager(hass)
            upload=manager.directory/'upload.db';module.snapshot(db.path,upload)
            uploaded=await manager.prepare(upload,'Milch.db')
            created=await manager.create()
            assert len(await manager.listing())==2
            # A new manager models an actual HA process restart: no RAM state survives.
            manager=module.DataBackupManager(hass)
            assert {r['id'] for r in await manager.listing()}=={uploaded['id'],created['id']}
            db._adjust_inventory_entry(entry.id,3)
            assert (await manager.restore(uploaded['id']))['restored']
            current=hass.data[module.DOMAIN].database
            assert (await current.async_list_inventory(inventory.id))[0].stock==2
            safety=next(r for r in await manager.listing() if r['origin']=='safety')
            with closing(sqlite3.connect(manager._path(safety['id']))) as con:
                assert con.execute('SELECT stock FROM inventory_entries').fetchone()[0]==5
            try:await db.async_list_inventory(inventory.id)
            except module.HaListManagerDatabaseError:pass
            else:raise AssertionError('Old database accepted late writes')
            await manager.restore(safety['id'])
            assert (await hass.data[module.DOMAIN].database.async_list_inventory(inventory.id))[0].stock==5
            await manager.restore(created['id'])
            await manager.restore(uploaded['id'])
            for record in await manager.listing():
                path=await manager.download(record['id'])
                assert module.validate(path)['inventory']==1
                path.unlink()
                await manager.delete(record['id'])
            assert not await manager.listing()
            assert not list(manager.archive.iterdir())
            assert (await hass.data[module.DOMAIN].database.async_list_inventory(inventory.id))[0].stock==2
        asyncio.run(scenario())


def test_failed_setup_rolls_back_and_failed_unload_does_not_touch_data():
    directory,db,shopping,inventory,entry=_fixture()
    with directory:
        module,_=_modules(db)
        async def scenario():
            hass=_Hass(db,module);db._hass=hass;manager=module.DataBackupManager(hass)
            record=await manager.create()
            db._adjust_inventory_entry(entry.id,5);hass.fail_setup=True
            try:await manager.restore(record['id'])
            except module.BackupError as err:assert 'vorherige' in str(err)
            else:raise AssertionError('Setup failure hidden')
            current=hass.data[module.DOMAIN].database
            assert (await current.async_list_inventory(inventory.id))[0].stock==7
            hass.fail_unload=True
            try:await manager.restore(record['id'])
            except module.BackupError:pass
            else:raise AssertionError('Unload failure hidden')
            assert not current._retired
            assert (await current.async_list_inventory(inventory.id))[0].stock==7
            assert manager._path(record['id']).exists()
        asyncio.run(scenario())


def test_ha_backup_pauses_operations_and_always_unlocks():
    directory, db, shopping, inventory, entry = _fixture()
    with directory:
        module,hooks=_modules(db)
        async def scenario():
            hass=_Hass(db,module);db._hass=hass
            await hooks.async_pre_backup(hass)
            pending=asyncio.create_task(db.async_list_inventory(inventory.id));await asyncio.sleep(0)
            assert not pending.done()
            await hooks.async_post_backup(hass)
            assert (await pending)[0].stock==2
            await hooks.async_post_backup(hass)
            original=hooks.checkpoint
            def fail(database):raise RuntimeError('disk full')
            hooks.checkpoint=fail
            try:
                try:await hooks.async_pre_backup(hass)
                except RuntimeError:pass
                assert not db._lock.locked()
            finally:hooks.checkpoint=original
        asyncio.run(scenario())


def test_archive_rejects_paths_and_symlinks_without_touching_active_data():
    directory,db,*_=_fixture()
    with directory:
        module,_=_modules(db)
        async def scenario():
            hass=_Hass(db,module);manager=module.DataBackupManager(hass)
            created=await manager.create()
            records=await manager.listing()
            assert len(records)==1 and records[0]['id']==created['id']
            assert len(await module.DataBackupManager(hass).listing())==1
            for value in ['../ha_list_manager',None,'a'*32]:
                try:await manager.delete(value)
                except module.BackupError:pass
                else:raise AssertionError('Unsafe path accepted')
            link=manager.archive/('b'*32+'.db');link.symlink_to(db.path)
            try:await manager.restore('b'*32)
            except module.BackupError:pass
            else:raise AssertionError('Symlink accepted')
            await manager.delete(records[0]['id'])
            assert not await manager.listing()
            assert db.path.exists()
        asyncio.run(scenario())


def test_http_backup_requires_admin_and_explicit_confirmation():
    directory,db,*_=_fixture()
    with directory:
        module,_=_modules(db)
        from unittest.mock import patch
        class HTTPError(Exception):pass
        class TooLarge(HTTPError):
            def __init__(self,**kwargs):pass
        class BadRequest(HTTPError):
            def __init__(self,**kwargs):pass
        web=types.SimpleNamespace(Request=object,StreamResponse=object,HTTPForbidden=HTTPError,HTTPNotFound=HTTPError,HTTPBadRequest=BadRequest,HTTPRequestEntityTooLarge=TooLarge,json_response=lambda value:value)
        stubs={'aiohttp':types.SimpleNamespace(web=web),'homeassistant.components.http':types.SimpleNamespace(HomeAssistantView=object),'homeassistant.helpers.http':types.SimpleNamespace(KEY_HASS='hass')}
        package=type(db).__module__.rsplit('.',1)[0]
        with patch.dict(sys.modules,stubs):
            sys.modules.pop(package+'.backup_http',None)
            http=importlib.import_module(package+'.backup_http')
        assert http.DataBackupView.requires_auth
        hass=_Hass(db,module);manager=module.DataBackupManager(hass);hass.data[module.MANAGER_KEY]=manager
        class Request(dict):
            app={'hass':hass}
            query={}
            async def json(self):return {'backup_id':'not-checked','confirm':False}
        view=http.DataBackupView()
        for user in (None,types.SimpleNamespace(is_admin=False,id='user')):
            try:view.manager(Request(hass_user=user))
            except HTTPError:pass
            else:raise AssertionError('Non-admin accepted')
        async def scenario():
            request=Request(hass_user=types.SimpleNamespace(is_admin=True,id='admin'))
            try:await view.post(request,'restore')
            except BadRequest:pass
            else:raise AssertionError('Unconfirmed restore accepted')
            class Content:
                async def iter_chunked(self,size):yield b'too large'
            request.content=Content();limit=http.MAX_UPLOAD_SIZE;http.MAX_UPLOAD_SIZE=1
            try:
                try:await view.post(request,'validate')
                except TooLarge:pass
                else:raise AssertionError('Oversized upload accepted')
            finally:http.MAX_UPLOAD_SIZE=limit
            assert not list(manager.directory.iterdir())
        asyncio.run(scenario())


def test_archive_preserves_current_stock_on_safety_snapshot_failure():
    directory,db,shopping,inventory,entry=_fixture()
    with directory:
        module,_=_modules(db)
        async def scenario():
            hass=_Hass(db,module);db._hass=hass;manager=module.DataBackupManager(hass)
            record=await manager.create();db._adjust_inventory_entry(entry.id,7)
            original=manager._store
            def fail(*args):raise OSError('disk full')
            manager._store=fail
            try:
                try:await manager.restore(record['id'])
                except module.BackupError:pass
                else:raise AssertionError('Snapshot failure hidden')
            finally:manager._store=original
            current=hass.data[module.DOMAIN].database
            assert (await current.async_list_inventory(inventory.id))[0].stock==9
            assert len(await manager.listing())==1
        asyncio.run(scenario())
