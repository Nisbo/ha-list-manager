/* Role-specific affordances must match the backend permissions. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { nativeHass } = require("./native_translation_hass");

function subscriptionTransport(registrations) {
  const sourcePath = process.argv[2];
  if (!sourcePath) return {
    subscribeEvents() { throw new Error("Native custom-event subscriptions require an admin"); },
    // home-assistant-js-websocket Connection._handleMessage passes message.event.
    subscribeMessage: async (handler, request) => { registrations.push({ request, deliver: handler }); return () => {}; },
  };

  // Optional compatibility check against the unmodified, pinned upstream source:
  // https://github.com/home-assistant/home-assistant-js-websocket/blob/9.7.1/lib/connection.ts
  const { stripTypeScriptTypes } = require("node:module");
  const source = stripTypeScriptTypes(fs.readFileSync(sourcePath, "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export class Connection", "class Connection");
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    messages: { unsubscribeEvents: subscription => ({ type: "unsubscribe_events", subscription }) },
    ERR_INVALID_AUTH: "invalid_auth", ERR_CONNECTION_LOST: "connection_lost",
  });
  vm.runInContext(`${source}\nglobalThis.Connection = Connection;`, context);
  const listeners = new Map();
  const socket = {
    OPEN: 1, readyState: 1, haVersion: "2026.10.4",
    addEventListener: (name, handler) => listeners.set(name, handler),
    send(raw) {
      const request = JSON.parse(raw);
      if (request.type !== "unsubscribe_events") registrations.push({ request,
        deliver: event => listeners.get("message")({ data: JSON.stringify({ id: request.id, type: "event", event }) }),
      });
      listeners.get("message")({ data: JSON.stringify({ id: request.id, type: "result", success: true, result: null }) });
    },
  };
  return new context.Connection(socket, {});
}

function load(name) {
  const registry = new Map();
  class Element {
    constructor() { this.isConnected = true; }
    attachShadow() {
      return this.shadowRoot = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    }
    setAttribute() {}
    removeAttribute() {}
    toggleAttribute() {}
  }
  const context = vm.createContext({
    HTMLElement: Element, console: { info() {}, warn() {}, error: console.error },
    customElements: { get: key => registry.get(key), define: (key, value) => registry.set(key, value) },
    window: { customCards: [] }, document: { body: { style: {} }, documentElement: { style: {} } },
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  });
  const file = path.join(__dirname, `../custom_components/ha_list_manager/frontend/ha-list-manager-${name}-card.js`);
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const Card = registry.get(`ha-list-manager-${name}-card`);
  const card = new Card();
  card._config = { ...Card.getStubConfig(), list_id: "list" };
  return card;
}

async function main() {
  for (const name of ["inventory", "shopping", "todo"]) {
    const card = load(name), registrations = [];
    let refreshed = 0, scanned = 0;
    card._load = async () => { refreshed += 1; };
    card._render = () => {};
    card._handleProcessedScan = () => { scanned += 1; };
    card._hass = nativeHass({ user: { is_admin: false }, connection: subscriptionTransport(registrations) });
    await card._subscribe();
    assert.equal(registrations.length, name === "inventory" ? 3 : 1);
    for (const { deliver, request } of registrations) {
      assert.equal(request.type, "ha_list_manager/subscribe");
      assert.match(request.event_type, /^ha_list_manager_(items_changed|inventory_changed|scanner_target_changed|scan_processed)$/);
      if (request.event_type.endsWith("items_changed") || request.event_type.endsWith("inventory_changed")) {
        deliver({ data: { list_id: "another-list" } });
        assert.equal(refreshed, 0, "Other lists cannot trigger refreshes");
        deliver({ data: { list_id: "list" } });
        assert.equal(refreshed, 1, "subscribeMessage already unwraps the event envelope before invoking the callback");
      } else if (request.event_type.endsWith("scanner_target_changed")) {
        deliver({ data: { list_id: "list", action: "add" } });
        assert.equal(card._scannerTarget.list_id, "list");
        deliver({ data: { target: null } });
        assert.equal(card._scannerTarget, null);
      } else {
        deliver({ data: { scan_id: "scan" } });
        assert.equal(scanned, 1);
      }
    }
  }

  const inventory = load("inventory");
  inventory._headerMenuOpen = true;
  for (const admin of [false, true]) {
    inventory._hass = nativeHass({ user: { id: "user", is_admin: admin } });
    inventory._render();
    const markup = inventory.shadowRoot.innerHTML;
    assert.equal(markup.includes("data-open-products"), admin, "Only admins may navigate to product management");
    assert.match(markup, /data-action/, "Stock booking stays available to both roles");
    assert.match(markup, /data-open-restock-preview/, "Manual shortage transfer stays available to both roles");
    assert.match(markup, /data-toggle-group-selection/, "Inventory grouping stays available to both roles");
  }
  inventory._config.show_product_database_button = false;
  inventory._render();
  assert.doesNotMatch(inventory.shadowRoot.innerHTML, /data-open-products/, "An admin's disabled menu option stays hidden");

  const todo = load("todo");
  todo._render = () => {};
  todo._unlock = () => {};
  todo._load = async () => {};
  const calls = [];
  for (const admin of [false, true]) {
    todo._hass = nativeHass({ user: { id: "user", is_admin: admin }, callWS: async msg => { calls.push(msg); return {}; } });
    todo._templateDialog = { item: { name: "Take out trash" }, name: "Template", item_name: "Take out trash", scope: "list_type", add_mode: "edit", due_mode: "none" };
    const markup = todo._templateDialogHtml();
    assert.match(markup, /value="list"/, "Both roles can save a template for this list");
    assert.equal(markup.includes('value="list_type"'), admin, "Only admins can offer templates to every To-do list");
    await todo._saveTemplateFromItem();
    const message = calls.at(-1);
    assert.equal(message.type, "ha_list_manager/chips/create");
    assert.equal(message.scope, admin ? "list_type" : "list", "A normal user's stale draft must remain scoped to the current list");
    assert.equal(message.list_id, admin ? null : "list");
    assert.equal(message.list_type, admin ? "todo" : null);
  }
  console.log("card permissions smoke passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
