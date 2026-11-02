"""Real SQLite writes and backend dispatch, without a dashboard or external calls."""
from __future__ import annotations
import asyncio
import importlib
from pathlib import Path
import runpy
import sys
import types

_fixture = runpy.run_path(str(Path(__file__).with_name('test_inventory_restock.py')))['_fixture']


class Bus:
    def __init__(self): self.handlers = {}; self.events=[]
    def async_listen(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)
        return lambda: self.handlers[event].remove(handler)
    def async_fire(self, event, data):
        self.events.append((event,data))
        for handler in tuple(self.handlers.get(event,())): handler(types.SimpleNamespace(data=data,context=None))


class States:
    def __init__(self):self.values={'script.probe':types.SimpleNamespace(entity_id='script.probe',attributes={})}
    def get(self, key):return self.values.get(key)
    def async_all(self):return list(self.values.values())


class Services:
    def __init__(self):self.calls=[];self.fail=False;self.on_call=None
    async def async_call(self, domain, service, data, **kwargs):
        self.calls.append((domain,service,data,kwargs))
        if self.fail:raise RuntimeError('Expected script failure')
        if self.on_call:await self.on_call()


class Hass:
    def __init__(self):self.bus=Bus();self.states=States();self.services=Services()
    async def async_add_executor_job(self, fn, *args):return await asyncio.to_thread(fn,*args)
    def async_create_task(self, coro, *args):return asyncio.create_task(coro)


def _manager(db):
    core=types.ModuleType('homeassistant.core');core.callback=lambda fn:fn;core.HomeAssistant=object;core.Event=object
    config=types.ModuleType('homeassistant.config_entries');config.ConfigEntry=object
    sys.modules.update({'homeassistant':types.ModuleType('homeassistant'),'homeassistant.core':core,'homeassistant.config_entries':config})
    package=db.__class__.__module__.rsplit('.',1)[0]
    module=importlib.import_module(package+'.scripts')
    hass=Hass();db._hass=hass
    return hass,module.ListScriptManager(hass,db),package


async def _flush(manager):
    while manager._tasks:await asyncio.gather(*tuple(manager._tasks))


def test_settings_are_persistent_type_filtered_and_disabled_selection_is_preserved():
    directory,db,shopping,inventory,entry=_fixture()
    with directory:
        assert db._get_list_script_settings(inventory.id)['settings']['enabled'] is False
        saved=db._set_list_script_settings(inventory.id,True,'script.probe',['inventory_out','inventory_out'])
        assert saved['settings']['events']==['inventory_out']
        db._set_list_script_settings(inventory.id,False,'script.probe',['inventory_out'])
        db._initialize()
        assert db._get_list_script_settings(inventory.id)['settings']['script_entity']=='script.probe'
        assert all(o['group']=='list' for o in db._get_list_script_settings(shopping.id)['options'])
        for enabled,script,events in [(True,None,['inventory_out']),(True,'script.probe',[]),(True,'light.test',['inventory_out']),(True,'script.probe',['item_added'])]:
            try:db._set_list_script_settings(inventory.id,enabled,script,events)
            except ValueError:pass
            else:raise AssertionError((enabled,script,events))
        db._delete_list(inventory.id)
        with db._connect() as con:assert con.execute('SELECT COUNT(*) FROM list_script_settings').fetchone()[0]==0


def test_schema_one_reopen_keeps_script_settings_stock_products_and_items():
    directory,db,shopping,inventory,entry=_fixture()
    with directory:
        item=db._create_item(shopping.id,'Bananen',None,3,None,None,None,[],None,None)
        db._set_list_script_settings(inventory.id,True,'script.probe',['inventory_out'])
        settings=db._get_list_script_settings(inventory.id)
        db._initialize()
        assert db._schema_version()==1
        assert db._list_inventory(inventory.id)[0].stock==entry.stock
        assert db._list_items(shopping.id)[0].id==item.id
        assert db._get_list_script_settings(inventory.id)==settings


def test_inventory_filter_undo_restock_and_legacy_variables_without_dashboard():
    async def scenario(db,inventory,shopping,entry):
        hass,manager,_=_manager(db);await manager.async_start()
        await db.async_set_list_script_settings(inventory.id,True,'script.probe',['inventory_out','inventory_undo_completed','restock_automatic','restock_lock_reset'])
        db._set_inventory_restock_settings(inventory.id,shopping.id,True,'fixed',6)
        result=await db.async_adjust_inventory_with_restock(entry.id,-1);await _flush(manager)
        assert len(hass.services.calls)==2
        booking=hass.services.calls[0][2]['variables'];restock=hass.services.calls[1][2]['variables']
        assert booking['event']=='inventory_out' and booking['stock_before']==2 and booking['stock_after']==1
        assert booking['name']=='Milch' and booking['quantity']==1 and booking['mode']=='inventory'
        assert booking['list_id']==inventory.id and booking['list_name']=='Vorrat'
        assert booking['message']=='1× Milch aus Vorrat entnommen.'
        for key in ['status','ean','brand','product_quantity','scan_quantity','category','image_url','list_entity','scanner_address','scanner_source','scan_mode','card_id','original_action','transfer_result','action','error']:assert key in booking,key
        assert restock['quantity']==6 and restock['status']=='transfer_sent' and restock['target_list_name']=='Einkauf'
        await db.async_undo_inventory_booking(result['undo_token'],False);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='inventory_undo_completed'
        assert hass.services.calls[-1][2]['variables']['transfer_result']=='kept'
        await db.async_reset_inventory_restock_latch(inventory.id,'entry',entry.id);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='restock_lock_reset'
        before=len(hass.services.calls)
        await db.async_adjust_inventory_with_restock(entry.id,1);await _flush(manager)
        assert len(hass.services.calls)==before,'Unselected event executed'
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,inventory,shopping,entry))


def test_list_edits_emit_once_with_complete_changes_and_no_todo_product():
    async def scenario(db,shopping):
        hass,manager,_=_manager(db);await manager.async_start()
        await db.async_set_list_script_settings(shopping.id,True,'script.probe',['item_added','item_quantity_changed','item_removed'])
        item=await db.async_create_item(shopping.id,'Bananen',None,1,None,None,None,[])
        await _flush(manager)
        await db.async_update_item(item.id,name='Bio-Bananen',description=None,quantity=4,category_id=None,category=None,due_at=None,completed=False,label_ids=[])
        await _flush(manager)
        assert len(hass.services.calls)==2
        variables=hass.services.calls[-1][2]['variables']
        assert variables['event']=='item_quantity_changed' and variables['previous_quantity']==1
        assert variables['previous_name']=='Bananen' and set(variables['changed_fields'])>={'name','quantity'}
        await db.async_delete_item(item.id);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['status']=='item_removed'
        assert hass.services.calls[-1][2]['variables']['quantity']==0
        todo=db._create_list('Aufgaben','todo',None,'local',None,'specific',True,True,True)
        await db.async_set_list_script_settings(todo.id,True,'script.probe',['item_added'])
        with db._connect() as con:before=con.execute('SELECT COUNT(*) FROM products').fetchone()[0]
        await db.async_create_item(todo.id,'Müll rausbringen',None,1,None,None,None,[]);await _flush(manager)
        with db._connect() as con:assert con.execute('SELECT COUNT(*) FROM products').fetchone()[0]==before
        assert hass.services.calls[-1][2]['variables']['mode']=='todo'
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,shopping))


def test_script_failure_missing_script_and_recursion_do_not_corrupt_bookings():
    async def scenario(db,inventory,entry):
        hass,manager,_=_manager(db);await manager.async_start()
        await db.async_set_list_script_settings(inventory.id,True,'script.probe',['inventory_in'])
        hass.services.fail=True
        await db.async_adjust_inventory_with_restock(entry.id,1);await _flush(manager)
        assert db._list_inventory(inventory.id)[0].stock==3 and len(hass.services.calls)==1
        hass.services.fail=False
        async def reenter():await db.async_adjust_inventory_with_restock(entry.id,1)
        hass.services.on_call=reenter
        await db.async_adjust_inventory_with_restock(entry.id,1);await _flush(manager)
        assert len(hass.services.calls)==2,'A list script recursively invoked itself'
        assert db._list_inventory(inventory.id)[0].stock==5
        hass.states.values.clear()
        await db.async_adjust_inventory_with_restock(entry.id,1);await _flush(manager)
        assert len(hass.services.calls)==2 and db._list_inventory(inventory.id)[0].stock==6
        await manager.async_stop()
        assert all(not handlers for handlers in hass.bus.handlers.values())
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,inventory,entry))


def test_real_scanner_success_is_one_booking_and_waiting_and_modes_are_deduplicated():
    async def scenario(db,inventory,entry):
        hass,manager,package=_manager(db)
        facts=types.ModuleType(package+'.open_facts');facts.OpenFactsLookupError=RuntimeError
        async def unknown(*args,**kwargs):return None
        facts.async_lookup_open_facts=unknown;sys.modules[package+'.open_facts']=facts
        scanner_module=importlib.import_module(package+'.scanner')
        scanner=scanner_module.ScannerManager(hass,db,types.SimpleNamespace())
        with db._connect() as con:con.execute("UPDATE products SET ean='4062139025398',brand='Milchmarke' WHERE id=?",(entry.product_id,))
        await db.async_set_list_script_settings(inventory.id,True,'script.probe',['inventory_out','inventory_registered','scan_needs_input','scanner_mode_changed','scanner_disabled'])
        await manager.async_start()
        result=await scanner.async_process_scan(ean='4062139025398',list_id=inventory.id,action='remove',source='simulation',address='AA:BB:CC:DD:EE:FF',offer_to_card=False)
        assert result['history']['status']=='success';await _flush(manager)
        assert len(hass.services.calls)==1
        variables=hass.services.calls[0][2]['variables']
        assert variables['status']=='product_quantity_decreased' and variables['scan_mode']=='remove'
        assert variables['source']=='scanner' and variables['ean']=='4062139025398' and variables['brand']=='Milchmarke'
        await scanner.async_process_scan(ean='8715700117140',list_id=inventory.id,action='add',source='simulation',offer_to_card=False,product_data={'name':'Ketchup','brand':'Heinz','package_quantity':'425 g'})
        await _flush(manager)
        assert len(hass.services.calls)==2,'A newly assigned product was announced twice'
        added=hass.services.calls[-1][2]['variables']
        assert added['event']=='inventory_registered' and added['status']=='product_added'
        assert added['stock_before']==0 and added['stock_after']==1 and added['ean']=='8715700117140'
        await scanner.async_process_scan(ean='HA-LM:INVENTORY:'+inventory.id+':add',source='simulation')
        await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['message']=='Einlagern für Vorrat aktiviert.'
        const=importlib.import_module(package+'.const')
        waiting={'id':'pending-scan','list_id':inventory.id,'status':'offered','ean':'1234','action':'add'}
        hass.bus.async_fire(const.EVENT_SCAN_PROCESSED,waiting)
        hass.bus.async_fire(const.EVENT_SCAN_PROCESSED,{**waiting,'status':'queued'})
        await _flush(manager)
        assert sum(call[2]['variables']['event']=='scan_needs_input' for call in hass.services.calls)==1
        hass.bus.async_fire(const.EVENT_SCANNER_TARGET_CHANGED,{'target':None});await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='scanner_disabled'
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,inventory,entry))


def test_manual_restock_has_one_source_and_one_destination_call_with_product_data():
    async def scenario(db,inventory,shopping,entry):
        hass,manager,_=_manager(db);await manager.async_start()
        with db._connect() as con:con.execute("UPDATE products SET ean='4062139025398',brand='Marke' WHERE id=?",(entry.product_id,))
        db._create_item(shopping.id,'Milch',None,3,None,None,None,[],entry.product_id,None)
        db._set_inventory_restock_settings(inventory.id,shopping.id,False,'continuous',None)
        db._adjust_inventory_with_restock(entry.id,-1)
        await db.async_set_list_script_settings(inventory.id,True,'script.probe',['restock_manual'])
        await db.async_set_list_script_settings(shopping.id,True,'script.probe',['item_added','item_quantity_changed'])
        await db.async_apply_inventory_restock(inventory.id);await _flush(manager)
        assert len(hass.services.calls)==2
        source,target=[call[2]['variables'] for call in hass.services.calls]
        assert source['event']=='restock_manual' and source['quantity']==1
        assert target['event']=='item_quantity_changed' and target['previous_quantity']==3 and target['quantity']==4
        assert target['source']=='restock' and target['ean']=='4062139025398' and target['brand']=='Marke'
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,inventory,shopping,entry))


def test_registration_correction_hidden_settings_and_clamped_stock_quantities():
    async def scenario(db,inventory):
        hass,manager,_=_manager(db);await manager.async_start()
        await db.async_set_list_script_settings(inventory.id,True,'script.probe',['inventory_registered','inventory_corrected','inventory_out'])
        product=db._create_product(None,'Erdbeeren',None,None,None,None,None,'manual',[],[])
        entry=await db.async_create_inventory_entry(list_id=inventory.id,product_id=product.id,stock=0,minimum_stock=None);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='inventory_registered'
        await db.async_update_inventory_entry(entry.id,stock=3,minimum_stock=None,hidden=True);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['message']=='Erdbeeren: Bestand von 0 auf 3 korrigiert.'
        count=len(hass.services.calls)
        await db.async_update_inventory_entry(entry.id,stock=3,minimum_stock=2,hidden=False);await _flush(manager)
        assert len(hass.services.calls)==count,'Changing only visibility/minimum is not a stock booking'
        await db.async_adjust_inventory_with_restock(entry.id,-100);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['quantity']==3
        assert hass.services.calls[-1][2]['variables']['stock_after']==0
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,inventory))


def test_script_settings_websocket_commands_require_administrator():
    source=(Path(__file__).parents[1]/'custom_components/ha_list_manager/websocket.py').read_text()
    for name in ['websocket_get_list_script_settings','websocket_set_list_script_settings']:
        end=source.index('async def '+name)
        start=source.rfind('@websocket_api.require_admin',0,end)
        assert start>=0 and '\n\nasync def' not in source[start:end]


def test_dish_batch_reports_each_changed_ingredient_once():
    async def scenario(db):
        hass,manager,_=_manager(db);await manager.async_start()
        shopping=db._create_list('Rezepte','shopping',None,'local',None,'specific',True,True,True,True,True,True,True,True)
        dish=db._create_dish('Frühstück',None,[{'name':'Bananen','quantity':2},{'name':'Äpfel','quantity':1}])
        await db.async_set_list_script_settings(shopping.id,True,'script.probe',['item_added','item_quantity_changed'])
        await db.async_add_dish_to_list(dish.id,shopping.id);await _flush(manager)
        assert len(hass.services.calls)==2
        assert {call[2]['variables']['source'] for call in hass.services.calls}=={'dish'}
        await db.async_add_dish_to_list(dish.id,shopping.id);await _flush(manager)
        assert len(hass.services.calls)==4
        assert all(call[2]['variables']['event']=='item_quantity_changed' for call in hass.services.calls[2:])
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db))


def test_undo_order_reports_destination_removal_once():
    async def scenario(db,inventory,shopping,entry):
        hass,manager,_=_manager(db);await manager.async_start()
        db._set_inventory_restock_settings(inventory.id,shopping.id,True,'fixed',6)
        await db.async_set_list_script_settings(shopping.id,True,'script.probe',['item_added','item_removed'])
        result=await db.async_adjust_inventory_with_restock(entry.id,-1);await _flush(manager)
        assert len(hass.services.calls)==1 and hass.services.calls[0][2]['variables']['quantity']==6
        await db.async_undo_inventory_booking(result['undo_token'],True);await _flush(manager)
        assert len(hass.services.calls)==2
        assert hass.services.calls[-1][2]['variables']['event']=='item_removed'
        assert hass.services.calls[-1][2]['variables']['source']=='inventory_undo'
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db,inventory,shopping,entry))


def test_todo_completion_and_interval_date_change_keep_distinct_events():
    async def scenario(db):
        hass,manager,_=_manager(db);await manager.async_start()
        todo=db._create_list('Wiederholungen','todo',None,'local',None,'specific',True,True,True)
        await db.async_set_list_script_settings(todo.id,True,'script.probe',['item_completed','item_updated','item_reopened'])
        item=await db.async_create_item(todo.id,'Backup',None,1,None,None,'2026-10-19T10:00:00+00:00',[],recurrence_interval=7,recurrence_unit='D')
        await db.async_set_item_completed(item.id,True);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='item_completed'
        await db.async_set_item_completed(item.id,False);await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='item_reopened'
        await db.async_update_item(item.id,name=item.name,description=None,quantity=1,category_id=None,category=None,due_at='2026-10-26T10:00:00+00:00',completed=False,label_ids=[],recurrence_interval=7,recurrence_unit='D')
        await _flush(manager)
        assert hass.services.calls[-1][2]['variables']['event']=='item_updated'
        assert 'due_at' in hass.services.calls[-1][2]['variables']['changed_fields']
        assert len(hass.services.calls)==3
        await manager.async_stop()
    directory,db,shopping,inventory,entry=_fixture()
    with directory:asyncio.run(scenario(db))
