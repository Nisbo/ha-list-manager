const { nativeHass } = require("./native_translation_hass");
/* Exercise listener lifetimes through production card binding and partial updates. */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Markup rendering is outside this test. Replacement factories model precisely
// which regions survive an update; event binding and dispatch use real methods.
class Node {
  constructor(tag = "div", attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.listeners = new Map();
    this.children = [];
    this.hidden = false;
    this.style = {};
    this.append(...children);
  }
  get dataset() {
    return Object.fromEntries(Object.entries(this.attributes)
      .filter(([key]) => key.startsWith("data-"))
      .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  }
  append(...children) {
    children.forEach((child) => { child.parentElement = this; this.children.push(child); });
  }
  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    this.append(...children);
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      const match = part.trim().match(/^(?:([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
      if (!match) return false;
      const [, tag, className, attribute, value] = match;
      return (!tag || this.tagName === tag.toUpperCase())
        && (!className || (this.attributes.class || "").split(/\s+/).includes(className))
        && (!attribute || (Object.hasOwn(this.attributes, attribute) && (value === undefined || this.attributes[attribute] === value)));
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(_markup) { this.replaceChildren(...(this.replaceMarkup?.() || [])); }
  set outerHTML(_markup) {
    const parent = this.parentElement;
    const replacement = this.replaceMarkup();
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, replacement);
    replacement.parentElement = parent;
    this.parentElement = null;
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    if (!callbacks.includes(callback)) callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== callback));
  }
  click() {
    const event = { target: this, preventDefault() {}, stopPropagation() { this.stopped = true; } };
    for (let current = this; current; current = current.parentElement) {
      event.currentTarget = current;
      for (const callback of [...(current.listeners.get("click") || [])]) callback(event);
      if (event.stopped) break;
    }
  }
}

function loadCard(file, name) {
  const registry = new Map();
  const values = new Map();
  class HTMLElement {
    attachShadow() { this.shadowRoot = new Node("shadow-root"); return this.shadowRoot; }
  }
  const context = vm.createContext({
    console, setTimeout, clearTimeout, HTMLElement,
    customElements: { get: (key) => registry.get(key), define: (key, value) => registry.set(key, value) },
    document: { body: { style: {} }, createElement: (tag) => new Node(tag) },
    window: { customCards: [] },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const Card = registry.get(name);
  const card = new Card(); card._hass = nativeHass();
  card._config = { ...Card.getStubConfig(), list_id: "test-list" };
  return card;
}

const frontend = path.join(__dirname, "../custom_components/ha_list_manager/frontend");
const shopping = loadCard(process.argv[2] || path.join(frontend, "ha-list-manager-shopping-card.js"), "ha-list-manager-shopping-card");
const inventory = loadCard(process.argv[3] || path.join(frontend, "ha-list-manager-inventory-card.js"), "ha-list-manager-inventory-card");
const chip = { id: "test-chip", name: "Milch" };
shopping._displayChips = inventory._displayChips = () => [chip];

let menuRenders = 0;
shopping._render = () => { menuRenders += 1; };
for (let index = 0; index < 6; index += 1) {
  shopping.shadowRoot.replaceChildren(new Node("ha-card", {}, [new Node("button")]));
  shopping._bind();
}
assert.ok((shopping.shadowRoot.listeners.get("click") || []).length <= 1,
  "Rebuilt shopping cards accumulated click callbacks on their persistent shadow root");
shopping._headerMenuOpen = true;
shopping.shadowRoot.querySelector("button").click();
assert.equal(menuRenders, 1, "An outside click must close the header menu once");
assert.equal(shopping._headerMenuOpen, false);

const quickPanel = (className) => {
  const panel = new Node("section", { class: className }, [new Node("button", { "data-quick-chip": chip.id })]);
  panel.replaceMarkup = () => quickPanel(className);
  return panel;
};
const suggestions = new Node("div", { "data-suggestions": "" });
suggestions.replaceMarkup = () => [new Node("button", { "data-product-id": "product" })];
const main = new Node("main");
main.replaceMarkup = () => [new Node("div", { "data-item-id": "item" }, [new Node("button", { "data-complete": "" })])];
const choice = new Node("button", { "data-product-choice": "product" });
const shoppingDialogChip = new Node("button", { "data-dialog-chip": chip.id });
shopping.shadowRoot.replaceChildren(new Node("ha-card", {}, [suggestions, main, quickPanel("quick-chips"), choice, shoppingDialogChip]));
shopping._suggestions = [{ id: "product" }];
shopping._items = [{ id: "item", completed: false }];
shopping._renderChips = shopping._suggestionsHtml = shopping._contentHtml = () => "";
const shoppingEffects = { choice: 0, chip: 0, suggestion: 0, complete: 0 };
shopping._chooseProduct = () => { shoppingEffects.choice += 1; };
shopping._useChip = () => { shoppingEffects.chip += 1; };
shopping._handleProduct = () => { shoppingEffects.suggestion += 1; };
shopping._complete = () => { shoppingEffects.complete += 1; };
shopping._bind();
for (let index = 0; index < 4; index += 1) shopping._refreshSearchView();
choice.click();
shoppingDialogChip.click();
shopping.shadowRoot.querySelector("[data-product-id]").click();
shopping.shadowRoot.querySelector("[data-complete]").click();
shopping.shadowRoot.querySelector("[data-quick-chip]").click();
assert.deepEqual(shoppingEffects, { choice: 1, chip: 2, suggestion: 1, complete: 1 },
  "Shopping partial updates must bind new regions without duplicating live chooser or dialog-chip actions");

const inventoryDialogChip = new Node("button", { "data-dialog-chip": chip.id });
inventory.shadowRoot.replaceChildren(new Node("ha-card", {}, [quickPanel("quick-chips-panel"), inventoryDialogChip]));
inventory._renderChips = () => "";
let inventoryEffects = 0;
inventory._useChip = () => { inventoryEffects += 1; };
inventory._bindChipActions();
for (let index = 0; index < 4; index += 1) inventory._refreshChipContent();
inventoryDialogChip.click();
assert.equal(inventoryEffects, 1, "Inventory chip refreshes duplicated a live dialog-chip action");
inventory.shadowRoot.querySelector("[data-quick-chip]").click();
assert.equal(inventoryEffects, 2, "The newly replaced inventory chip panel was not bound exactly once");
console.log("list card binding smoke test passed");
