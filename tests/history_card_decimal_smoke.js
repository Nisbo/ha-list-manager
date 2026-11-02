const { nativeHass } = require("./native_translation_hass");
/* Browser-independent smoke test for independent value and axis decimals. */
const fs = require("fs");
const vm = require("vm");

const registry = new Map();
global.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [], append: () => {}, innerHTML: "" };
    return this.shadowRoot;
  }
  dispatchEvent() {}
};
global.CustomEvent = class {};
global.customElements = { get: (name) => registry.get(name), define: (name, constructor) => registry.set(name, constructor) };
global.document = { createElement: () => ({ addEventListener: () => {} }), body: { style: {} }, documentElement: { style: {} } };
global.window = { customCards: [] };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const source = fs.readFileSync(process.argv[2], "utf8");
vm.runInThisContext(source, { filename: process.argv[2] });
const Card = registry.get("ha-list-manager-history-card");
const card = new Card(); card._hass = nativeHass();
card._hass = nativeHass({ locale: { language: "de" } });
card._config = { scale_decimals: 2, value_fixed_decimals: true, axis_decimals: 1, axis_fixed_decimals: true };

if (card._formatValue(1.5) !== "1,50") throw new Error("Value decimals are not padded independently");
if (card._formatAxisValue(1.5) !== "1,5") throw new Error("Axis decimals are not formatted independently");
if (card._formatAxisValue(2) !== "2,0") throw new Error("Axis decimals are not padded");
card._config.value_fixed_decimals = false;
card._config.axis_fixed_decimals = false;
if (card._formatValue(1.5) !== "1,5" || card._formatAxisValue(2) !== "2") throw new Error("Optional padding cannot be disabled");

console.log("history card decimal smoke test passed");
