const { nativeHass } = require("./native_translation_hass");
/* Search debounces must stop with their view while live searches still run once. */
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

let nextTimer = 1;
const timers = new Map();
const schedule = (callback) => { const id = nextTimer++; timers.set(id, callback); return id; };
const flush = async () => {
  while (timers.size) {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) await callback();
  }
};
class Element {
  constructor() { this.value = "Milch"; this.hidden = true; this.listeners = new Map(); this.style = { setProperty() {} }; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type) { for (const callback of this.listeners.get(type) || []) callback({ target: this }); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  insertAdjacentHTML() {}
}
class HTMLElement {
  attachShadow() {
    const nodes = new Map();
    this.shadowRoot = { nodes, querySelector: (selector) => nodes.get(selector) || null, querySelectorAll: () => [] };
    return this.shadowRoot;
  }
}
const registry = new Map();
const context = vm.createContext({
  console, HTMLElement, setTimeout: schedule, clearTimeout: (id) => timers.delete(id),
  setInterval: schedule, clearInterval: (id) => timers.delete(id),
  customElements: { get: (name) => registry.get(name), define: (name, ctor) => registry.set(name, ctor) },
});
const sourcePath = process.argv[2];
vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
const Panel = registry.get("ha-list-manager-panel");
const fixture = (kind) => {
  const panel = new Panel(); panel._hass = nativeHass();
  const calls = [];
  panel._render = () => {};
  panel._hass = nativeHass({ callWS: async (request) => { calls.push(request); return { products: [], total: 0 }; } });
  panel._dialog = { kind, draft: { name: "Milch", product_id: "" }, product_options: [] };
  return { panel, calls };
};
const picker = (kind) => {
  const result = fixture(kind);
  const { panel } = result;
  const inventory = kind === "inventory-editor";
  const input = new Element(), menu = new Element();
  panel.shadowRoot.nodes.set(inventory ? "[data-inventory-product-search]" : "[data-chip-product-search]", input);
  panel.shadowRoot.nodes.set(inventory ? "[data-inventory-product-options]" : "[data-chip-product-options]", menu);
  if (inventory) panel._configureInventoryProductPicker();
  else panel._configureChipProductPicker();
  return { ...result, input };
};

async function main() {
  for (const kind of ["chip-editor", "inventory-editor"]) {
    const closed = picker(kind);
    closed.input.emit("input");
    assert.equal(timers.size, 1, `${kind} did not schedule its real search handler`);
    closed.panel._closeDialog();
    await flush();
    assert.equal(closed.calls.length, 0, `${kind} sent a product query after closing`);
    assert.equal(closed.panel._dialog, null);

    const active = picker(kind);
    active.input.emit("input");
    active.input.value = "Milch neu";
    active.input.emit("input");
    await flush();
    assert.equal(active.calls.length, 1, `${kind} search was canceled or sent duplicate requests`);
    assert.equal(active.calls[0].type, "ha_list_manager/products/list");
    assert.equal(active.calls[0].search, "Milch neu");
    assert.equal(active.calls[0].limit, 100);
  }

  const busy = picker("chip-editor");
  const busyDialog = busy.panel._dialog;
  busy.input.emit("input");
  busy.panel._busy = true;
  busy.panel._closeDialog();
  assert.equal(busy.panel._dialog, busyDialog, "Closing while saving discarded the dialog");
  await flush();
  assert.equal(busy.calls.length, 1, "A refused close canceled the still-live dialog search");

  const nested = fixture("inventory-editor");
  const parent = { kind: "chip-editor", product_search_timer: schedule(() => nested.calls.push("parent")) };
  nested.panel._dialog.return_dialog = parent;
  nested.panel._dialog.product_search_timer = schedule(() => nested.calls.push("child"));
  nested.panel._productSearchTimer = schedule(() => nested.calls.push("products-page"));
  nested.panel._closeDialog();
  assert.equal(nested.panel._dialog, parent, "Closing the child lost the return dialog");
  await flush();
  assert.deepEqual(nested.calls, ["parent", "products-page"], "Closing a child canceled unrelated searches or left its own search alive");

  for (const [kind, ownTimer, otherTimer] of [
    ["category-products", "_categoryProductSearchTimer", "_dishProductSearchTimer"],
    ["dish-editor", "_dishProductSearchTimer", "_categoryProductSearchTimer"],
  ]) {
    const { panel, calls } = fixture(kind);
    panel[ownTimer] = schedule(() => calls.push("closed-dialog"));
    panel[otherTimer] = schedule(() => calls.push("other-dialog"));
    panel._productSearchTimer = schedule(() => calls.push("products-page"));
    panel._closeDialog();
    await flush();
    assert.deepEqual(calls, ["other-dialog", "products-page"], `${kind} did not limit cancellation to its own search`);
  }

  const detached = picker("inventory-editor");
  detached.input.emit("input");
  const ancestor = { kind: "chip-editor", product_search_timer: schedule(() => detached.calls.push("ancestor")) };
  const parentDialog = { kind: "product-editor", return_dialog: ancestor, product_search_timer: schedule(() => detached.calls.push("parent")) };
  detached.panel._dialog.return_dialog = parentDialog;
  for (const property of ["_productSearchTimer", "_categoryProductSearchTimer", "_dishProductSearchTimer"]) {
    detached.panel[property] = schedule(() => detached.calls.push(property));
  }
  detached.panel.disconnectedCallback();
  assert.equal(timers.size, 0, "Disconnect left searches queued in the panel or return-dialog chain");
  await flush();
  assert.equal(detached.calls.length, 0, "A detached panel sent a search request");
  console.log("panel search lifecycle smoke test passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
