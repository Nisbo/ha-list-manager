const { nativeHass } = require("./native_translation_hass");
/* Verify that overlapping Todo refreshes cannot apply an older response. */
const fs = require("fs");
const vm = require("vm");

const registry = new Map();
class HTMLElement {
  attachShadow() {
    this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [], innerHTML: "" };
    return this.shadowRoot;
  }
  dispatchEvent() {}
}
const context = vm.createContext({
  console, setTimeout, clearTimeout, HTMLElement, CustomEvent: class {},
  ResizeObserver: class { observe() {} disconnect() {} },
  customElements: { get: (name) => registry.get(name), define: (name, constructor) => registry.set(name, constructor) },
  document: { createElement: () => ({}), head: { appendChild: () => {} }, body: { style: {} }, documentElement: { style: {} } },
  window: { customCards: [] }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { language: "de-DE" },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function main() {
  const cardPath = process.argv[2];
  vm.runInContext(fs.readFileSync(cardPath, "utf8"), context, { filename: cardPath });
  const TodoCard = registry.get("ha-list-manager-todo-card");
  const card = new TodoCard(); card._hass = nativeHass();
  card._config = { ...TodoCard.getStubConfig(), list_id: "todo" };

  const requests = [Array.from({ length: 7 }, deferred), Array.from({ length: 7 }, deferred)];
  let callIndex = 0;
  card._hass = nativeHass({ callWS: () => {
    const request = requests[Math.floor(callIndex / 7)][callIndex % 7];
    callIndex += 1;
    return request.promise;
  } });
  let renderCount = 0;
  card._render = () => { renderCount += 1; };

  const olderLoad = card._load(true);
  const newerLoad = card._load(true);
  const resolveLoad = (request, itemName) => {
    const values = [
      { lists: [{ id: "todo", list_type: "todo" }] },
      { items: [{ id: itemName, name: itemName }] },
      { categories: [] }, { labels: [] }, { chips: [] },
      { assignments: [] }, { assignments: [] },
    ];
    request.forEach((entry, index) => entry.resolve(values[index]));
  };

  resolveLoad(requests[1], "newer");
  await newerLoad;
  resolveLoad(requests[0], "older");
  await olderLoad;

  if (card._items[0]?.id !== "newer") throw new Error("An older Todo response replaced the latest item state");
  if (renderCount !== 1) throw new Error(`Overlapping Todo loads rendered ${renderCount} times instead of once`);
  if (card._loading) throw new Error("Todo loading state remained active after the latest response");
  console.log("todo load race smoke test passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
