const { nativeHass } = require("./native_translation_hass");
/* Exercise the actual card methods without writing to a Home Assistant instance. */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const frontend = path.join(__dirname, '../custom_components/ha_list_manager/frontend');
function load(file, tag, sessionValues = new Map(), clock = {now:Date.now()}) {
  const registry = new Map();
  const timers = [];
  const values = new Map();
  const TestDate = class extends Date { static now() { return clock.now; } };
  const context = vm.createContext({ console, Date:TestDate, Intl,
    setTimeout: (fn, delay) => { timers.push({fn, delay}); return timers.length; }, clearTimeout: () => {},
    HTMLElement: class { attachShadow() { return this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [], innerHTML: '' }; } },
    customElements: { get: n => registry.get(n), define: (n, c) => registry.set(n, c) },
    window: { customCards: [] }, document: { body: { style: {} }, documentElement: { style: {} } },
    sessionStorage: { getItem: k => sessionValues.get(k) ?? null, setItem: (k,v) => sessionValues.set(k,String(v)), removeItem:k => sessionValues.delete(k) },
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) },
  });
  vm.runInContext(fs.readFileSync(path.join(frontend,file),'utf8'), context);
  const card = new (registry.get(tag))(); card._hass = nativeHass();
  card._testTimers = timers;
  card._testClock = clock;
  card._testSession = sessionValues;
  return card;
}
async function main() {
  const inv = load('ha-list-manager-inventory-card.js','ha-list-manager-inventory-card');
  inv._config = {list_id:'pantry'};
  inv._render = () => {};
  inv._load = async () => {};
  inv._entries = [{id:'milk',stock:2,product:{name:'Milch'}}];
  const calls = [];
  inv._hass = nativeHass({callWS: async msg => {
    calls.push(msg);
    return msg.type.endsWith('/adjust') ? {entry:{id:'milk',stock:1,product:{name:'Milch'}},undo_token:'server-token',transfer:{quantity:6,name:'Milch',mode:'fixed'}} : {entry:{stock:2},transfer_kept:!msg.include_transfer};
  }});
  await inv._adjust('milk',-1);
  assert.equal(inv._lastInventoryBooking.token,'server-token');
  await inv._undoInventoryBooking();
  assert.equal(inv._undoChoice,true);
  assert.match(inv._renderInventoryUndoChoice(),/Nur Bestand/);
  assert.match(inv._renderInventoryUndoChoice(),/Bestand und Nachbestellung/);
  assert.equal(calls.length,1,'Opening the choice must not undo anything');
  await inv._undoInventoryBooking(false);
  assert.equal(calls[1].include_transfer,false);
  assert.equal(calls[1].token,'server-token');
  assert.match(inv._actionStatus,/bleibt erhalten/);
  assert.equal(inv._lastInventoryBooking,null);
  const counter = {textContent:''};
  inv.shadowRoot.querySelector = selector => selector === '[data-undo-countdown]' ? counter : null;
  inv._lastInventoryBooking = {expires:inv._testClock.now+60000};
  inv._updateInventoryUndoCountdown();
  assert.equal(counter.textContent,'60 s');
  inv._lastInventoryBooking.expires = inv._testClock.now+59000;
  inv._testTimers.at(-1).fn();
  assert.equal(counter.textContent,'59 s','The counter must tick without rebuilding the card');
  inv._lastInventoryBooking = null;
  inv.shadowRoot.querySelector = () => null;
  inv._rememberInventoryUndo('next-token');
  await inv._undoInventoryBooking();
  assert.equal(calls[2].include_transfer,false,'A booking without transfer must not alter shopping');
  inv._rememberInventoryUndo('expired-token');
  inv._hass.callWS = async () => {throw Error('60 Sekunden abgelaufen');};
  await inv._undoInventoryBooking();
  assert.match(inv._error,/60 Sekunden/);
  inv._undoChoice = true;
  inv._testTimers.findLast(timer => timer.delay === 60000).fn();
  assert.equal(inv._lastInventoryBooking,null);
  assert.equal(inv._undoChoice,false);

  // A full card replacement models a page reload: only session storage survives.
  const shared = new Map();
  const clock = {now:1700000000000};
  const make = (list='pantry',user='user-a') => {
    const card=load('ha-list-manager-inventory-card.js','ha-list-manager-inventory-card',shared,clock);
    card._config={list_id:list}; card._hass=nativeHass({user:{id:user},callWS:async()=>({transfer_kept:false})});
    card._render=()=>{};card._load=async()=>{};
    return card;
  };
  const original=make();
  original._rememberInventoryUndo('reload-token',{quantity:6});
  original._actionStatus='Milch: Bestand von 2 auf 1 verringert.';
  original._saveInventoryUndo();
  const expires=original._lastInventoryBooking.expires;
  clock.now+=21000;
  const reloaded=make();reloaded._restoreInventoryUndo();
  assert.equal(reloaded._lastInventoryBooking.token,'reload-token');
  assert.equal(reloaded._lastInventoryBooking.expires,expires,'Reload must never extend the deadline');
  assert.equal(reloaded._testTimers[0].delay,39000);
  assert.equal(reloaded._actionStatus,original._actionStatus);
  assert.equal(reloaded._lastInventoryBooking.transfer.quantity,6);
  const otherList=make('cellar');otherList._restoreInventoryUndo();
  assert.equal(otherList._lastInventoryBooking,null);
  const otherUser=make('pantry','user-b');otherUser._restoreInventoryUndo();
  assert.equal(otherUser._lastInventoryBooking,null);
  await reloaded._undoInventoryBooking(false);
  assert.equal(shared.has(reloaded._inventoryUndoStorageKey()),false,'Successful undo must remove its saved token');
  const afterUndo=make();afterUndo._restoreInventoryUndo();assert.equal(afterUndo._lastInventoryBooking,null);
  const expiring=make();expiring._rememberInventoryUndo('expired-after-reload');clock.now+=60001;
  const expired=make();expired._restoreInventoryUndo();
  assert.equal(expired._lastInventoryBooking,null);assert.equal(shared.size,0);
  shared.set(expired._inventoryUndoStorageKey(),'{broken json');
  assert.doesNotThrow(()=>expired._restoreInventoryUndo());
  const old=make();old._rememberInventoryUndo('old');
  const newer=make();newer._rememberInventoryUndo('new');
  old._testTimers.find(timer=>timer.delay===60000).fn();
  assert.equal(JSON.parse(shared.get(newer._inventoryUndoStorageKey())).token,'new','An old timer must not erase a newer booking');

  const blocked=load('ha-list-manager-inventory-card.js','ha-list-manager-inventory-card',{
    get(){throw Error('Storage blocked');},set(){throw Error('Storage blocked');},delete(){throw Error('Storage blocked');}
  },clock);
  blocked._config={list_id:'pantry'};blocked._hass=nativeHass({user:{id:'user-a'}});
  assert.doesNotThrow(()=>blocked._restoreInventoryUndo());
  assert.doesNotThrow(()=>blocked._rememberInventoryUndo('without-storage'));
  assert.equal(blocked._lastInventoryBooking.token,'without-storage');

  const shopping = load('ha-list-manager-shopping-card.js','ha-list-manager-shopping-card');
  shopping._config = {show_images:false,show_plus_minus:false,show_labels:false,quantity_position:'beginning'};
  shopping._availableCategories = () => [];
  const draft={name:'Milch',description:'',quantity:1,category_name:'',label_ids:[],offer_only:true};
  assert.equal(shopping._itemDraftPayload(draft).offer_only,true);
  const item={id:'milk',name:'Milch',quantity:1,labels:[],offer_only:true};
  assert.match(shopping._renderItem(item),/class="item-name">Milch <span class="offer-only-badge"[^>]*><ha-icon[^>]*><\/ha-icon>Angebot<\/span><\/span>/);
  assert.doesNotMatch(shopping._renderItem({...item,offer_only:false}),/offer-only-badge/);
  const nameText = {textContent:'Milch '};
  const offerBadge = {className:'offer-only-badge'};
  const nameNode = {firstChild:nameText,children:[offerBadge]};
  Object.defineProperty(nameNode,'textContent',{set(){throw Error('Quantity patch must preserve the offer badge');}});
  const quantityNode = {textContent:'1'};
  const row = {dataset:{itemId:'milk'},querySelector:selector=>selector === '.item-name' ? nameNode : quantityNode};
  shopping.shadowRoot.querySelectorAll=()=>[row];
  shopping._items=[item];
  for (const quantity of [2,1]) {
    shopping._patchQuantityItems([{...item,quantity}]);
    assert.equal(nameText.textContent,quantity === 1 ? 'Milch ' : '2× Milch ');
    assert.equal(quantityNode.textContent,String(quantity));
    assert.equal(nameNode.children[0],offerBadge,'Plus and minus must keep the same badge node');
  }
  shopping._items=[item];
  shopping._categoryFor=()=>({id:'general',name:'Allgemein'});
  assert.match(shopping._pdfSections()[0].items[0].name,/Nur im Angebot/);
  const todoSource = fs.readFileSync(path.join(frontend,'ha-list-manager-todo-card.js'),'utf8');
  const todoLabelStyle = todoSource.match(/\.item-label\{([^}]+)\}/)[1];
  for (const [name, cls] of [['shopping','label'],['inventory','label-chip']]) {
    const source = fs.readFileSync(path.join(frontend,`ha-list-manager-${name}-card.js`),'utf8');
    assert.equal(source.match(new RegExp('\\.'+cls+'\\{([^}]+)\\}'))[1],todoLabelStyle);
    assert.match(source,/label.icon \|\| "mdi:label-outline"/);
  }
  console.log('Inventory undo and shopping offer smoke tests passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
