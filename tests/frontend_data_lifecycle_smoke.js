/* Late responses and subscriptions must stay owned by their list/view. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { nativeHass } = require("./native_translation_hass");

const frontend = path.join(__dirname, "../custom_components/ha_list_manager/frontend");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const load = (name) => {
  const registry = new Map();
  class Element {
    constructor() { this.isConnected = true; this.style = {}; }
    attachShadow() { return this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [] }; }
    setAttribute() {}
    removeAttribute() {}
    toggleAttribute() {}
  }
  const context = vm.createContext({
    HTMLElement: Element, console: { info() {}, warn() {}, error: console.error },
    customElements: { get: key => registry.get(key), define: (key, value) => registry.set(key, value) },
    window: { customCards: [] }, document: { documentElement: { style: {} }, body: { style: {} } },
    localStorage: { getItem: () => null }, clearTimeout() {}, clearInterval() {},
    setTimeout: () => 0, setInterval: () => 0, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  });
  vm.runInContext(fs.readFileSync(path.join(frontend, `ha-list-manager-${name}.js`), "utf8"), context);
  const instance = new (registry.get(`ha-list-manager-${name}`))();
  instance._render = () => {};
  return instance;
};

async function main() {
  const panel = load("panel");
  const reads = [];
  panel._hass = nativeHass({ callWS: request => {
    const response = deferred(); reads.push({ request, ...response }); return response.promise;
  } });
  panel._selectedListId = "a";
  const first = panel._loadItems();
  panel._selectedListId = "b";
  const second = panel._loadItems();
  assert.deepEqual(reads.map(row => row.request.list_id), ["a", "b"], "Selecting another list must start its own request");
  reads[0].resolve({ items: [{ id: "a-row" }] });
  await first;
  assert.equal(panel._items.length, 0, "List A must never be displayed under selected list B");
  assert.equal(panel._itemsLoading, true, "A stale completion must not clear B's loading state");
  reads[1].resolve({ items: [{ id: "b-row" }] });
  await second;
  assert.equal(panel._items[0].id, "b-row");
  assert.equal(panel._itemsLoading, false);

  panel._selectedListId = "a";
  const oldFailure = panel._loadItems();
  panel._selectedListId = "b";
  const newer = panel._loadItems();
  reads[3].resolve({ items: [{ id: "current" }] });
  await newer;
  reads[2].reject(new Error("obsolete A failure"));
  await oldFailure;
  assert.equal(panel._error, "", "An abandoned list cannot show its error in the current list");
  assert.equal(panel._items[0].id, "current");

  const inventory = load("panel");
  inventory._lists = [{ id: "a", list_type: "inventory" }, { id: "b", list_type: "inventory" }];
  const inventoryReads = [];
  inventory._hass = nativeHass({ callWS: request => {
    const response = deferred(); inventoryReads.push({ request, ...response }); return response.promise;
  } });
  inventory._products = [{ id: "filtered-product", name: "Filtered page" }, { id: "shared-product", name: "Old product name", category: "Old product category" }];
  inventory._productsLoaded = true;
  inventory._productTotal = 251;
  inventory._productPage = 3;
  inventory._selectedInventoryListId = "a";
  const oldInventory = inventory._loadInventory();
  inventory._selectedInventoryListId = "b";
  const newInventory = inventory._loadInventory();
  assert.equal(inventoryReads.length, 10);
  const answer = (rows, id) => {
    for (const row of rows) {
      const type = row.request.type;
      row.resolve(type.endsWith("inventory/list") ? { entries: [{ id: `${id}-entry` }] }
        : type.endsWith("products/list") ? { products: [{ id: `${id}-option`, name: "Option" }, { id: "shared-product", name: `${id} fresh product`, category: `${id} fresh category` }], total: 1001 }
        : type.endsWith("groups/list") ? { groups: [{ id: `${id}-group` }] }
        : type.endsWith("settings/get") ? { settings: { target_list_id: `${id}-shopping` } }
        : { items: [{ source_id: `${id}-restock` }] });
    }
  };
  answer(inventoryReads.slice(0, 5), "a"); await oldInventory;
  assert.equal(inventory._inventoryEntries.length, 0, "Stale inventory rows are discarded");
  assert.equal(inventory._inventoryLoading, true);
  answer(inventoryReads.slice(5), "b"); await newInventory;
  assert.equal(inventory._inventoryEntries[0].id, "b-entry");
  assert.equal(inventory._inventoryRestockSettings.target_list_id, "b-shopping");
  assert.equal(inventory._inventoryProducts[0].id, "b-option");
  assert.equal(inventory._findInventoryProduct("b-option").id, "b-option", "Inventory product choices remain usable");
  assert.equal(inventory._products[0].id, "filtered-product", "Inventory options cannot replace a filtered Products page");
  assert.equal(inventory._productsLoaded, true);
  assert.equal(inventory._productTotal, 251);
  assert.equal(inventory._productPage, 3);
  inventory._openInventoryDialog(null);
  assert.equal(inventory._dialog.product_options[0].id, "b-option");
  assert.equal(inventory._dialog.product_total, 1001);
  inventory._dialog.draft.product_id = "shared-product";
  for (const section of ["inventory", "lists", "history"]) {
    inventory._activeSection = section;
    assert.match(inventory._inventoryProductPickerMarkup(), /value="b fresh product"/, "Fresh inventory results must take precedence over the cached Products page");
    assert.match(inventory._renderInventoryDialog(), /b fresh category/, "The selected product's current category must match the fresh inventory choice");
  }
  inventory._dialog.product_options = [{ id: "shared-product", name: "Newest search result", category: "Newest search category" }];
  assert.match(inventory._inventoryProductPickerMarkup(), /value="Newest search result"/, "A newer picker query takes precedence over the initial inventory choices");
  assert.match(inventory._renderInventoryDialog(), /Newest search category/);
  assert.equal(inventory._findProduct("shared-product").name, "Old product name", "Inventory lookup does not mutate the independent Products page cache");

  for (const method of ["_ensureItemsSubscription", "_ensureLovelaceSubscription"]) {
    const view = load("panel"); const subscriptions = [];
    view._hass = nativeHass({ connection: { subscribeEvents: () => {
      const response = deferred(); subscriptions.push(response); return response.promise;
    } } });
    const old = view[method]();
    view.isConnected = false; view.disconnectedCallback();
    view.isConnected = true;
    const current = view[method]();
    let removedOld = 0, removedCurrent = 0;
    subscriptions[1].resolve(() => { removedCurrent += 1; }); await current;
    subscriptions[0].resolve(() => { removedOld += 1; }); await old;
    assert.equal(removedOld, 1, "An obsolete subscription must be cleaned after reconnect");
    assert.equal(removedCurrent, 0);
    view.isConnected = false; view.disconnectedCallback();
    assert.equal(removedCurrent, 1, "Current subscription remains owned by normal teardown");
  }

  const card = load("inventory-card");
  card._config = { list_id: "a", category_chip_layout: "none" };
  card._loadBrowserChips = () => {};
  const cardReads = [];
  card._hass = nativeHass({ callWS: request => {
    const response = deferred(); cardReads.push({ request, ...response }); return response.promise;
  } });
  const before = card._load();
  card._config.list_id = "b";
  const after = card._load();
  assert.equal(cardReads.length, 18, "A card switched to list B cannot stay blocked by list A");
  const answerCard = (rows, id) => rows.forEach(row => row.resolve({ entries: [{ id: `${id}-row` }] }));
  answerCard(cardReads.slice(9), "b"); await after;
  answerCard(cardReads.slice(0, 9), "a"); await before;
  assert.equal(card._entries[0].id, "b-row");
  assert.equal(card._loadedListId, "b");

  let refreshRenders = 0;
  card._render = () => { refreshRenders += 1; };
  const forced = card._load(true);
  const latest = card._load(true);
  assert.equal(cardReads.length, 36, "A forced post-booking refresh cannot be dropped during an older request");
  assert.equal(refreshRenders, 1, "Overlapping refreshes must not add another loading redraw");
  answerCard(cardReads.slice(27), "fresh"); await latest;
  answerCard(cardReads.slice(18, 27), "stale"); await forced;
  assert.equal(card._entries[0].id, "fresh-row");
  assert.equal(refreshRenders, 2, "Only the latest refresh may redraw its result");

  for (const failAfterFirst of [false, true]) {
    const view = load("inventory-card"); const registrations = [];
    view._hass = nativeHass({ connection: { subscribeMessage: () => {
      const response = deferred(); registrations.push(response); return response.promise;
    } } });
    let cleaned = 0;
    const subscribed = view._subscribe();
    registrations[0].resolve(() => { cleaned += 1; }); await tick();
    assert.equal(registrations.length, 2);
    if (failAfterFirst) {
      registrations[1].reject(new Error("subscription rejected"));
      await assert.rejects(subscribed, /subscription rejected/);
      assert.equal(cleaned, 1, "A partial registration failure must clean earlier handles");
    } else {
      view.isConnected = false; view.disconnectedCallback();
      registrations[1].resolve(() => { cleaned += 1; }); await tick();
      registrations[2].resolve(() => { cleaned += 1; }); await subscribed;
      assert.equal(cleaned, 3, "A detached card must release all late subscriptions");
      assert.equal(view._unsubscribes.length, 0);
    }
  }

  const todo = load("todo-card"), registration = deferred();
  let subscribeCalls = 0, removed = 0;
  todo._hass = nativeHass({ connection: { subscribeMessage: () => {
    subscribeCalls += 1; return registration.promise;
  } } });
  const pendingSubscription = todo._subscribe();
  todo.isConnected = false; todo.disconnectedCallback();
  todo.isConnected = true;
  await todo._subscribe();
  assert.equal(subscribeCalls, 1, "Reattaching a to-do card must not duplicate its pending subscription");
  registration.resolve(() => { removed += 1; }); await pendingSubscription;
  todo.isConnected = false; todo.disconnectedCallback();
  assert.equal(removed, 1);

  for (const language of ["de", "en"]) {
    for (const mode of ["fixed", "one_to_one"]) {
      const view = load("inventory-card");
      view._hass = nativeHass({ language });
      view._entries = [{ id: "milk", stock: 5 }];
      view._run = async () => ({ entry: { id: "milk", stock: 4 }, transfer: { quantity: 2, name: "Milch {name}", mode, already_open: 7 } });
      view._rememberInventoryUndo = view._replaceEntry = view._setInventoryActionStatus = view._touchModeTimer = () => {};
      view._load = async () => {};
      await view._adjust("milk", -1);
      assert.ok(view._actionStatus.includes("2 × Milch {name}"), "User names remain literal in restock status");
      assert.match(view._actionStatus, language === "de" ? /wurden (?:einmalig )?nachbestellt/ : /restock/);
      assert.match(view._actionStatus, language === "de" ? /Bereits offen: 7/ : /Already open: 7/);
      if (language === "en") assert.doesNotMatch(view._actionStatus, /wurden|nachbestellt/);
      if (mode === "fixed") assert.match(view._actionStatus, language === "de" ? /einmalig/ : /once/);
    }
  }
  console.log("frontend list ownership, product-cache separation and subscription lifecycle passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
