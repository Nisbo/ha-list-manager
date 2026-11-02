const { nativeHass } = require("./native_translation_hass");
/* Product defaults and one optional entry move must remain separate operations. */
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");
const registry = new Map();
global.HTMLElement = class {
  attachShadow() { return this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [] }; }
};
global.customElements = { get: (name) => registry.get(name), define: (name, ctor) => registry.set(name, ctor) };
global.CustomEvent = class {};
global.document = { body: { style: {} }, documentElement: { style: {} } };
global.window = { customCards: [] };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.localStorage = { getItem: () => null, setItem: () => {} };
vm.runInThisContext(fs.readFileSync(process.argv[2], "utf8"), { filename: process.argv[2] });
const Card = registry.get("ha-list-manager-shopping-card");
const categories = [
  { id: "global-old", name: "Global old", scope: "global" },
  { id: "global-new", name: "Global new", scope: "global" },
  { id: "type-old", name: "Type old", scope: "list_type", list_type: "shopping" },
  { id: "type-new", name: "Type new", scope: "list_type", list_type: "shopping" },
  { id: "local-old", name: "Local old", scope: "list", list_id: "weekly" },
  { id: "local-new", name: "Local new", scope: "list", list_id: "weekly" },
  { id: "other-local", name: "Other list", scope: "list", list_id: "other" },
  { id: "inventory-type", name: "Pantry", scope: "list_type", list_type: "inventory" },
];
const byId = (id) => categories.find((category) => category.id === id);
const assignment = (id) => ({ ...byId(id), category_id: id, category: byId(id) });
const originalIds = ["global-old", "type-old", "local-old", "other-local", "inventory-type"];

async function scenario({ targetId, move, linked, initial = "local-old" }) {
  const card = new Card(); card._hass = nativeHass();
  card._config = { ...Card.getStubConfig(), list_id: "weekly" };
  card._list = { id: "weekly", use_global_categories: true, use_type_categories: true };
  card._categories = categories.filter((category) => category.list_id !== "other");
  card._labels = [];
  card._render = () => {};
  card._load = async () => {};
  const product = { id: "milk", name: "Milk", labels: [], category_assignments: originalIds.map(assignment) };
  card._products = [product];
  const initialCategory = byId(initial);
  const rows = [
    { id: "current", list_id: "weekly", category_id: initialCategory?.id || null, category: initial === "dynamic" ? "Picnic" : null },
    { id: "same-product-same-list", list_id: "weekly", category_id: "local-old", category: null },
    { id: "same-product-other-list", list_id: "other", category_id: "other-local", category: null },
  ];
  const unchangedSiblings = structuredClone(rows.slice(1));
  const parent = { mode: "edit", item: { ...rows[0], product_id: linked ? product.id : null }, product: linked ? product : null,
    name: "Milk", description: "", quantity: 1, completed: false, category_id: rows[0].category_id,
    category_name: initialCategory?.name || rows[0].category || "", label_ids: [] };
  const target = byId(targetId);
  card._dialog = { ...card._productTransferDraft(parent, linked ? product : null),
    category_id: target?.id || null, category_name: target?.name || "", move_item_category: move };
  const calls = [];
  card._hass = nativeHass({ callWS: async (message) => {
    calls.push(message);
    assert.ok(!message.type.endsWith("/products/category/set"), "Card used the bulk-move API");
    if (message.type.endsWith("/products/update") || message.type.endsWith("/products/create")) {
      return { product: { ...product, id: linked ? "milk" : "new-milk", category_assignments: message.category_ids.map(assignment) } };
    }
    assert.equal(message.type, "ha_list_manager/items/update");
    assert.equal(message.item_id, "current", "An item other than the current one was updated");
    Object.assign(rows[0], { category_id: message.category_id, category: message.category });
    return {};
  } });
  await card._saveProductTransfer();
  assert.equal(card._dialog, null, "Product save failed");
  assert.equal(calls.length, 2, "Expected one product save and one current-item update");
  assert.deepEqual(rows.slice(1), unchangedSiblings, "Sibling entries were moved");
  assert.equal(rows[0].category_id, move ? target?.id || null : parent.category_id);
  const expectedText = move || parent.category_id ? null : parent.category_name || null;
  assert.equal(rows[0].category, expectedText);
  const expectedIds = linked ? originalIds.filter((id) => {
    const old = byId(id);
    return !target ? old.scope !== "list" || old.list_id !== "weekly"
      : old.scope !== target.scope || (old.scope === "list_type" ? old.list_type !== target.list_type
        : old.scope === "list" ? old.list_id !== target.list_id : false);
  }) : [];
  if (target) expectedIds.push(target.id);
  assert.deepEqual([...calls[0].category_ids].sort(), expectedIds.sort(), "Unrelated product defaults were replaced");
}

(async () => {
  for (const linked of [false, true]) {
    for (const move of [false, true]) {
      for (const targetId of ["global-new", "type-new", "local-new", null]) {
        for (const initial of ["local-old", null, "dynamic"]) await scenario({ targetId, move, linked, initial });
      }
    }
  }
  console.log("48 product-category cases passed: scope, checkbox, General/dynamic, creation/editing and sibling preservation");
})().catch((error) => { console.error(error); process.exitCode = 1; });
