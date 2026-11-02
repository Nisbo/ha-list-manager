const { nativeHass } = require("./native_translation_hass");
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
let Panel;
const context=vm.createContext({console,Date,Intl,setTimeout,clearTimeout,requestAnimationFrame:callback=>callback(),URL:{createObjectURL:()=>"blob:test",revokeObjectURL:()=>{}},
 HTMLElement:class{attachShadow(){return this.shadowRoot={querySelector:()=>null,querySelectorAll:()=>[]};}},
 customElements:{get:()=>null,define:(_,ctor)=>{Panel=ctor;}},window:{},document:{body:{style:{}},documentElement:{lang:'de-DE',style:{}}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../custom_components/ha_list_manager/frontend/ha-list-manager-panel.js'),'utf8'),context);
async function main(){
 const panel=new Panel(); panel._hass = nativeHass();panel._render=()=>{};const calls=[];
 const record={id:'a'.repeat(32),name:'<script>.db',origin:'uploaded',created_at:'2026-10-20T10:00:00Z',size:1024,summary:{lists:2,products:3,inventory:1,items:4,schema_version:1}};
 let files=[];
 const backupUrl=url=>new URL(url,'https://ha.example');
 const isOperation=(url,operation)=>backupUrl(url).pathname===`/api/ha_list_manager/backup/${operation}`;
 panel._hass=nativeHass({locale:{language:'de-DE'},fetchWithAuth:async(url,options={})=>{calls.push([url,options]);
  assert.equal(backupUrl(url).searchParams.get('language'),'de','Backup HTTP requests must carry the HA language');
  if(isOperation(url,'validate')||isOperation(url,'create'))files=[record];
  if(isOperation(url,'delete'))files=[];
  if(isOperation(url,'download'))return {ok:true,blob:async()=>({}),headers:{get:()=>'attachment; filename="backup.db"'}};
  return {ok:true,json:async()=>isOperation(url,'info')?{backups:files,database_path:'/config/<db>.db',archive_path:'/config/backups'}:{backup:record,restored:true}};
 }});
 assert.ok(!panel._renderSettings.toString().includes('_renderDataBackup'));
 panel._activeSection='backup';assert.ok(panel._renderContent().includes('Sicherung erstellen'));
 await panel._createDataBackup();assert.ok(isOperation(calls[0][0],'create'));
 await panel._prepareDataRestore({name:'<script>.db',size:100});
 assert.ok(calls.some(([url])=>isOperation(url,'validate')&&backupUrl(url).searchParams.get('filename')==='<script>.db'));
 assert.equal(panel._dialog,null,'Uploading must not immediately start a restore');
 let html=panel._renderDataBackup();assert.ok(html.includes('&lt;script&gt;.db'));assert.ok(html.includes('/config/&lt;db&gt;.db'));
 for(const action of ['download','restore','delete'])assert.ok(html.includes(`data-backup-${action}="${record.id}"`));
 for(const origin of ['created','uploaded','safety']){record.origin=origin;assert.ok(panel._renderDataBackup().includes(`data-backup-delete="${record.id}"`));}
 record.origin='uploaded';
 assert.match(html,/class="ha-button destructive" data-backup-delete/);
 record.origin='safety';const safetyHtml=panel._renderDataBackup();assert.ok(safetyHtml.includes('unmittelbar vor einer Wiederherstellung'));assert.ok(safetyHtml.includes('backup-safety'));record.origin='uploaded';
 assert.ok(html.indexOf('backup-notice')<html.indexOf('data-backup-storage'),'Credential notice belongs beside backup actions');
 assert.ok(!html.includes('10 Minuten'));assert.ok(!html.includes('HA-Skripte, Automationen'));
 // Download result and fallback link belong exclusively to the clicked file.
 context.document.createElement=()=>({click(){}});
 await panel._downloadDataBackup(record.id);
 assert.equal(panel._renderDataBackupFeedback('controls'),'');
 assert.ok(panel._renderDataBackupFeedback(record.id).includes('Der Download wurde gestartet'));
 assert.ok(panel._renderDataBackupFeedback(record.id).includes('download="backup.db"'));
 assert.equal(panel._renderDataBackupFeedback('b'.repeat(32)),'');
 panel._beginBackupAction();assert.equal(panel._backupDownload,null);assert.equal(panel._renderDataBackupFeedback(record.id),'');
 panel._backupStatus='Sicherung erstellt';assert.ok(panel._renderDataBackupFeedback('controls').includes('Sicherung erstellt'));
 panel._error='<failure>';assert.ok(panel._renderDataBackupFeedback('controls').includes('&lt;failure&gt;'));
 panel._error='';
 panel._openDataRestore(record.id);html=panel._renderDataRestore();assert.ok(html.includes('data-restore-data disabled'));
 assert.ok(html.includes('2 Listen · 3 Produkte · 1 Inventarartikel · 4 Listeneinträge'));
 let count=calls.length;await panel._restoreDataBackup();assert.equal(calls.length,count);
 panel._dialog.confirmed=true;await panel._restoreDataBackup();
 const restore=calls.find(([url])=>isOperation(url,'restore'));assert.equal(JSON.parse(restore[1].body).backup_id,record.id);
 assert.equal(panel._dialog,null);assert.equal(panel._backupRestored,true);
 // A newly loaded panel reads the same archive without any old browser state.
 const reloaded=new Panel(); reloaded._hass = nativeHass();reloaded._render=()=>{};reloaded._hass=panel._hass;await reloaded._loadDataBackupInfo();assert.equal(reloaded._backupInfo.backups.length,1);
 reloaded._openDataRestore(record.id,true);assert.ok(reloaded._renderDataBackupDelete().includes('&lt;script&gt;.db'));
 assert.match(reloaded._renderDataBackupDelete(),/class="ha-button destructive" data-backup-delete-confirm/);
 await reloaded._deleteDataBackup();assert.equal(reloaded._backupInfo.backups.length,0);
 assert.ok(reloaded._renderDataBackupFeedback(record.id).includes('Sicherungsdatei wurde gelöscht'));
 assert.ok(reloaded._renderDataBackup().includes('&lt;script&gt;.db'));
 assert.ok(!reloaded._renderDataBackup().includes('data-backup-download='));
 reloaded._beginBackupAction();assert.ok(!reloaded._renderDataBackup().includes('&lt;script&gt;.db'));
 const deletion=calls.find(([url])=>isOperation(url,'delete'));assert.equal(JSON.parse(deletion[1].body).confirm,true);
 count=calls.length;await panel._prepareDataRestore({name:'huge.db',size:513*1024*1024});assert.equal(calls.length,count);
 panel._hass.fetchWithAuth=async()=>({ok:false,text:async()=>'Ungültige Datei'});
 await panel._prepareDataRestore({name:'bad.db',size:1});assert.equal(panel._error,'Ungültige Datei');
 const english=new Panel(); english._hass = nativeHass();english._hass=nativeHass({locale:{language:'en-GB'},fetchWithAuth:async(url)=>{
  assert.ok(isOperation(url,'info'));assert.equal(backupUrl(url).searchParams.get('language'),'en');
  return {ok:true,json:async()=>({backups:[]})};
 }});
 await english._backupRequest('info');
 // Busy/status updates retain the archive and its focused buttons. Only a
 // changed archive replaces rows; repeated event binding uses handler properties.
 const stable=new Panel(); stable._hass = nativeHass();
 // The existing archive DOM below was rendered in this same HA language.
 stable._renderedLanguage=stable._hass.language;stable._activeSection='backup';stable._renderDataBackup=()=>'<backup>';stable._renderDialog=()=>'';
 let rowWrites=0,bindings=0,locks=0;
 const rows={dataset:{records:'same'},get innerHTML(){return 'existing rows';},set innerHTML(value){rowWrites++;}};
 const feedback={innerHTML:'',dataset:{backupFeedback:'controls'}},error={innerHTML:''},dialog={innerHTML:''},button={disabled:false};
 const current={'[data-backup-view]':{},'[data-backup-records]':rows,'[data-backup-feedback]':feedback,'[data-backup-error]':error,'[data-backup-dialog]':dialog};
 for(const key of ['[data-backup-database-path]','[data-backup-archive-path]'])current[key]={innerHTML:''};
 const nextRows={dataset:{records:'same'},innerHTML:'new rows'};
 const next={'[data-backup-records]':nextRows,'[data-backup-feedback="controls"]':{innerHTML:'download started'}};
 for(const key of ['[data-backup-database-path]','[data-backup-archive-path]'])next[key]={innerHTML:'/config/test'};
 context.document.createElement=()=>({content:{querySelector:selector=>next[selector]},innerHTML:''});
 stable.shadowRoot.querySelector=selector=>current[selector]||null;stable.shadowRoot.querySelectorAll=selector=>selector==='[data-backup-feedback]'?[feedback]:[button];
 Object.defineProperty(stable.shadowRoot,'innerHTML',{set(){throw Error('The backup shadow tree must remain mounted');}});
 stable._bindBackupEvents=()=>{bindings++;};stable._setPageScrollLocked=()=>{locks++;};
 stable._busy=true;stable._render();assert.equal(rowWrites,0);assert.equal(button.disabled,true);assert.equal(feedback.innerHTML,'download started');assert.equal(current['[data-backup-archive-path]'].innerHTML,'/config/test');
 stable._busy=false;stable._render();assert.equal(rowWrites,0);assert.equal(button.disabled,false);
 nextRows.dataset.records='changed';stable._render();assert.equal(rowWrites,1);assert.equal(bindings,3);assert.equal(locks,3);
 // Retained controls get one handler, and selecting the same file again works.
 const bound=new Panel(),fileInput={value:'chosen',files:[{name:'again.db'}]},downloadButton={dataset:{backupDownload:record.id}}; bound._hass = nativeHass();
 bound.shadowRoot.querySelector=selector=>selector==='[data-backup-file]'?fileInput:null;
 bound.shadowRoot.querySelectorAll=selector=>selector==='[data-backup-download]'?[downloadButton]:[];
 let downloads=0,uploads=0;bound._downloadDataBackup=()=>{downloads++;};bound._prepareDataRestore=()=>{uploads++;};
 bound._bindBackupEvents();bound._bindBackupEvents();downloadButton.onclick();fileInput.onchange({target:fileInput});
 assert.equal(downloads,1);assert.equal(uploads,1);assert.equal(fileInput.value,'');
 // Overflowing HA wrappers are not necessarily scroll containers. Locking
 // those wrappers clips the document on mobile; lock its actual scroller only.
 context.ShadowRoot=class{};context.getComputedStyle=element=>({overflowY:element.overflowY||'visible'});
 const locked=new Panel(); locked._hass = nativeHass();locked._activeSection='backup';locked.style={};locked.getRootNode=()=>null;
 const root={style:{overflow:'',overscrollBehavior:''}},body={style:{overflow:'',overscrollBehavior:''}};
 context.document.documentElement=root;context.document.body=body;context.document.scrollingElement=root;
 locked._setPageScrollLocked(true);assert.equal(root.style.overflow,'hidden');assert.equal(body.style.overflow,'');
 locked._setPageScrollLocked(false);assert.equal(root.style.overflow,'');assert.equal(locked._pageScrollLocks.length,0);
 console.log('Persistent backup archive UI actions, escaping, reload and confirmations passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
