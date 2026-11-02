const { nativeHass } = require("./native_translation_hass");
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
const file=path.join(__dirname,'../custom_components/ha_list_manager/frontend/ha-list-manager-panel.js');
let Panel;
const context=vm.createContext({console,Date,Intl,setTimeout,clearTimeout,
 HTMLElement:class{attachShadow(){return this.shadowRoot={querySelector:()=>null,querySelectorAll:()=>[]};}},
 customElements:{get:()=>null,define:(name,ctor)=>{Panel=ctor;}},window:{},document:{body:{style:{}},documentElement:{style:{}}},
});
vm.runInContext(fs.readFileSync(file,'utf8'),context);
async function main(){
 const panel=new Panel(); panel._hass = nativeHass();panel._render=()=>{};
 panel._lists=[{id:'pantry',name:'Vorrat',list_type:'inventory'}];
 const calls=[];
 panel._hass=nativeHass({callWS:async msg=>{calls.push(msg);return{settings:{enabled:true,script_entity:'script.probe',events:['inventory_out']},options:[{event:'inventory_in',group:'inventory',label:'Eingelagert'},{event:'inventory_out',group:'inventory',label:'Entnommen'},{event:'scan_error',group:'scanner',label:'Fehler'}]};}});
 await panel._openListScript('pantry');
 assert.equal(panel._dialog.draft.script_entity,'script.probe');
 const html=panel._renderListScriptDialog();
 for(const text of ['Skript-Anbindung','Vorrat','Inventarbuchungen','EAN und Scanner','Entnommen','data-script-entity','data-script-event="inventory_out" checked'])assert.ok(html.includes(text),text);
 assert.ok(!/scripts\.(inventory|scanner|help)/.test(html),'Missing native catalog entry');
 assert.ok(html.includes('Das Skript erhält Informationen zum ausgewählten Ereignis.'));
 for(const text of ['Anleitung und wichtigste Variablen','Weitere Variablen und technische Details','HA-LM – Ereignisse testen','script-variables','stock_before','{{ message }}','<details'])assert.ok(!html.includes(text),text+' belongs in the wiki, not the settings dialog');
 panel._dialog.draft.enabled=false;
 await panel._saveListScript();
 assert.equal(calls[1].enabled,false);assert.equal(calls[1].script_entity,'script.probe');
 assert.deepEqual(Array.from(calls[1].events),['inventory_out']);assert.equal(panel._dialog,null);
 panel._lists=[{id:'pantry',name:'Vorrat',list_type:'inventory'},{id:'tasks',name:'Aufgaben',list_type:'todo'},{id:'shopping',name:'Einkauf',list_type:'shopping'}];
 panel._inventoryGroups=[];panel._inventoryEntries=[];panel._categories=[];
 panel._renderDashboardUsage=()=>'';panel._renderListOverview=()=>'';
 for(const list of panel._lists){
   panel._selectedListId=list.id;
   const detail=panel._renderListDetail();
   assert.ok(detail.includes('data-list-script="'+list.id+'"'),'Script connection missing in '+list.list_type+' detail');
 }
 const rows=panel._renderLists();
 for(const list of panel._lists)assert.ok(rows.includes('data-list-script="'+list.id+'"'),'Script connection missing from list overview');
 const get=calls.length;
 await panel._openListScript('missing');assert.equal(calls.length,get);
 console.log('List script panel settings smoke test passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
