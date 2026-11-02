"""Real SQLite checks for hidden originals and deletion of manual measurements."""
import importlib
import importlib.util
from pathlib import Path
import runpy
import tempfile
import types

Database = runpy.run_path(str(Path(__file__).with_name('test_entity_history.py')))['_database_class']


def _rows(db, *, include_hidden=False, limit=100, minimum=None, before_id=None):
    return db._query_entity_history('sensor.weight', None, None, limit, True, None, minimum, None, before_id, include_hidden)


def test_originals_stay_hidden_across_imports_corrections_and_restart():
    for source in ['live', 'recorder', 'long_term_statistics']:
        with tempfile.TemporaryDirectory() as directory:
            cls = Database(); db = cls(types.SimpleNamespace(), Path(directory)/'history.db')
            db._initialize(); db._set_entity_tracking('sensor.weight', True)
            time = '2026-11-01T08:00:00+00:00'
            snapshot = {'state':'85','attributes':{'unit_of_measurement':'kg'},'last_updated':time,'last_changed':time}
            if source == 'live':
                db._record_entity_state('sensor.weight','85',snapshot['attributes'],time,time,time)
            else:
                db._import_entity_states('sensor.weight',[snapshot],source)
            original = _rows(db)[0][0]
            db._save_entity_sample('sensor.weight','85',original.attributes,time,original.id,True)
            assert not _rows(db)[0]
            visible = db._list_tracked_entities()[0]
            assert visible.sample_count == 0 and visible.hidden_count == 1
            assert visible.first_recorded_at is None and visible.last_recorded_at is None
            archived = _rows(db,include_hidden=True)[0][0]
            assert archived.hidden and archived.source == source, 'Hiding must not create a correction'
            assert archived.as_dict()['hidden'] is True
            # Reimport the same point; exact Recorder data may replace an aggregate,
            # but its row ID and hidden flag must remain stable.
            db._import_entity_states('sensor.weight',[snapshot],'recorder')
            db = cls(types.SimpleNamespace(),db.path);db._initialize()
            assert not _rows(db)[0]
            archived = _rows(db,include_hidden=True)[0][0]
            assert archived.id == original.id and archived.hidden
            db._save_entity_sample('sensor.weight','84',archived.attributes,'2026-11-01T09:00:00+00:00',archived.id,True)
            corrected = _rows(db,include_hidden=True)[0][0]
            assert corrected.hidden and corrected.source == 'corrected'
            assert corrected.original['state']=='85'
            db._import_entity_states('sensor.weight',[snapshot],'recorder')
            assert not _rows(db)[0]
            db._save_entity_sample('sensor.weight',corrected.state,corrected.attributes,corrected.last_updated,corrected.id,False)
            restored = _rows(db)[0][0]
            assert restored.state=='84' and not restored.hidden
            assert db._list_tracked_entities()[0].hidden_count==0
            # The original is still retained even after correction and visibility changes.
            with db._connect() as con:
                assert con.execute('SELECT state FROM entity_states WHERE id=?',(original.id,)).fetchone()[0]=='85'


def test_hidden_points_are_excluded_before_filters_limits_and_pagination():
    with tempfile.TemporaryDirectory() as directory:
        db=Database()(types.SimpleNamespace(),Path(directory)/'history.db');db._initialize();db._set_entity_tracking('sensor.weight',True)
        for minute in range(6):
            t=f'2026-11-01T08:0{minute}:00+00:00'
            db._record_entity_state('sensor.weight',str(80+minute),{},t,t,t)
        all_rows=_rows(db)[0]
        for row in all_rows[-2:]:
            db._save_entity_sample('sensor.weight',row.state,row.attributes,row.last_updated,row.id,True)
        first,truncated,limited=_rows(db,limit=2,minimum=81)
        assert [r.state for r in first]==['82','83'] and truncated and not limited
        second,truncated,_=_rows(db,limit=2,minimum=81,before_id=first[0].id)
        assert [r.state for r in second]==['81'] and not truncated
        assert len(_rows(db,include_hidden=True)[0])==6
        assert db._get_entity_history('sensor.weight',None,None,100,True,None,None,None)[0]==_rows(db)[0]


def test_only_manual_origin_can_be_deleted_even_after_correction():
    with tempfile.TemporaryDirectory() as directory:
        db=Database()(types.SimpleNamespace(),Path(directory)/'history.db');db._initialize();db._set_entity_tracking('sensor.weight',True)
        t='2026-11-01T08:00:00+00:00'
        db._record_entity_state('sensor.weight','85',{},t,t,t)
        original=_rows(db)[0][0]
        try: db._delete_entity_sample('sensor.weight',original.id)
        except ValueError: pass
        else: raise AssertionError('Original measurements must never be deleted')
        manual_id=db._save_entity_sample('sensor.weight','90',{},'2026-11-01T09:00:00+00:00',None)
        try: db._save_entity_sample('sensor.weight','90',{},'2026-11-01T09:00:00+00:00',manual_id,True)
        except ValueError: pass
        else: raise AssertionError('Manual measurements are deleted instead of hidden')
        db._save_entity_sample('sensor.weight','89',{},'2026-11-01T09:00:00+00:00',manual_id)
        assert _rows(db)[0][-1].original_source=='manual'
        try: db._delete_entity_sample('sensor.other',manual_id)
        except ValueError: pass
        else: raise AssertionError('Entity and record ID must match')
        db._delete_entity_sample('sensor.weight',manual_id)
        assert [r.id for r in _rows(db)[0]]==[original.id]
        with db._connect() as con:
            assert not con.execute('SELECT 1 FROM entity_state_corrections WHERE id=?',(manual_id,)).fetchone()
            assert not con.execute('PRAGMA foreign_key_check').fetchall()


def test_schema_one_reopen_preserves_every_table_and_backup_includes_visibility():
    with tempfile.TemporaryDirectory() as directory:
        cls=Database();db=cls(types.SimpleNamespace(),Path(directory)/'history.db');db._initialize();db._set_entity_tracking('sensor.weight',True)
        t='2026-11-01T08:00:00+00:00';db._record_entity_state('sensor.weight','85',{},t,t,t)
        with db._connect() as con:
            tables=[r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_metadata'")]
            before={table:[tuple(r) for r in con.execute(f'SELECT * FROM "{table}"')] for table in tables}
        db._initialize()
        assert db._schema_version()==1
        with db._connect() as con:
            after={table:[tuple(r) for r in con.execute(f'SELECT * FROM "{table}"')] for table in tables}
        assert before==after
        row=_rows(db)[0][0];db._save_entity_sample('sensor.weight',row.state,row.attributes,row.last_updated,row.id,True)
        backup=importlib.import_module(cls.__module__.rsplit('.',1)[0]+'.data_backup')
        target=Path(directory)/'snapshot.db';backup.snapshot(db.path,target)
        assert backup.validate(target)['schema_version']==1
        restored=cls(types.SimpleNamespace(),target)
        assert not _rows(restored)[0] and _rows(restored,include_hidden=True)[0][0].hidden


def test_history_api_guards_hidden_reads_and_preserves_visibility_arguments():
    """Exercise production WS handlers with transport doubles; decorators stay required."""
    import ast
    import asyncio
    from copy import deepcopy
    path=Path(__file__).parents[1]/'custom_components/ha_list_manager/websocket.py'
    specification=importlib.util.spec_from_file_location('entity_sample_visibility_localization',path.with_name('localization.py'))
    localization=importlib.util.module_from_spec(specification)
    specification.loader.exec_module(localization)
    tree=ast.parse(path.read_text())
    names=['websocket_get_entity_history','websocket_save_entity_sample','websocket_delete_entity_sample']
    nodes=[node for node in tree.body if isinstance(node,ast.AsyncFunctionDef) and node.name in names]
    for node in nodes:
        if node.name!='websocket_get_entity_history':
            assert any(ast.unparse(d)=='websocket_api.require_admin' for d in node.decorator_list)
    copied=deepcopy(nodes)
    for node in copied:node.decorator_list=[]
    module=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*copied],type_ignores=[])
    calls=[]
    class DB:
        async def async_query_entity_history(self,*args):calls.append(('get',args));return [],False,False
        async def async_save_entity_sample(self,*args):calls.append(('save',args));return 7
        async def async_delete_entity_sample(self,*args):calls.append(('delete',args))
    class Connection:
        def __init__(self,admin):
            self.user=types.SimpleNamespace(is_admin=admin,permissions=types.SimpleNamespace(check_entity=lambda *args:True))
            self.errors=[];self.results=[]
        def send_error(self,*args):self.errors.append(args)
        def send_result(self,*args):self.results.append(args)
    namespace={'_runtime':lambda hass:types.SimpleNamespace(database=DB()),'POLICY_READ':'read','websocket_api':types.SimpleNamespace(ERR_INVALID_FORMAT='invalid_format'),'_send_input_error':lambda *args:None,'localized_text':localization.text,'_send_error':lambda connection,*args:connection.send_error(*args)}
    exec(compile(ast.fix_missing_locations(module),str(path),'exec'),namespace)
    async def scenario():
        user=Connection(False)
        request={'id':1,'entity_id':'sensor.weight','limit':10,'latest':True,'include_hidden':True}
        await namespace[names[0]](None,user,request)
        assert user.errors and not calls
        assert user.errors[-1]==(1,'unauthorized',localization.text('errors.unauthorized',language='de'))
        request['include_hidden']=False
        await namespace[names[0]](None,user,request)
        assert calls[-1][1][-1] is False
        admin=Connection(True);request['include_hidden']=True
        await namespace[names[0]](None,admin,request)
        assert calls[-1][1][-1] is True
        await namespace[names[1]](None,admin,{'id':2,'entity_id':'sensor.weight','state':'85','attributes':{},'timestamp':'2026-11-01T08:00:00+00:00','record_id':7,'hidden':True})
        assert calls[-1]==('save',('sensor.weight','85',{},'2026-11-01T08:00:00+00:00',7,True))
        await namespace[names[2]](None,admin,{'id':3,'entity_id':'sensor.weight','record_id':7})
        assert calls[-1]==('delete',('sensor.weight',7))
    asyncio.run(scenario())


def test_hiding_json_round_trip_numbers_does_not_create_a_false_correction():
    with tempfile.TemporaryDirectory() as directory:
        db=Database()(types.SimpleNamespace(),Path(directory)/'history.db');db._initialize();db._set_entity_tracking('sensor.weight',True)
        t='2026-11-01T08:00:00+00:00'
        original={'min':0.0,'nested':{'max':150.0},'values':[0.0,True]}
        db._record_entity_state('sensor.weight','85',original,t,t,t)
        row=_rows(db)[0][0]
        round_trip={'min':0,'nested':{'max':150},'values':[0,True]}
        db._save_entity_sample('sensor.weight','85',round_trip,t,row.id,True)
        assert _rows(db,include_hidden=True)[0][0].source=='live'
        # A real type change must still be treated as a correction.
        changed={**round_trip,'values':[0,1]}
        db._save_entity_sample('sensor.weight','85',changed,t,row.id,True)
        assert _rows(db,include_hidden=True)[0][0].source=='corrected'
        db._save_entity_sample('sensor.weight','85',round_trip,t,row.id,False)
        result=_rows(db)[0][0]
        assert result.source=='live' and result.original is None and not result.hidden
        with db._connect() as con:
            assert con.execute('SELECT attributes_json FROM entity_states WHERE id=?',(row.id,)).fetchone()[0].find('0.0')>=0
