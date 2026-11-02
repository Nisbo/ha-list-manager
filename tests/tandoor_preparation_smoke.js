const { nativeHass } = require("./native_translation_hass");
/* Browser-independent smoke test for Tandoor ingredient/preparation tabs. */
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
global.document = { createElement: () => ({ addEventListener: () => {} }), body: { style: {} }, documentElement: { lang: "de-DE", style: {} } };
global.window = { customCards: [] };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const source = fs.readFileSync(process.argv[2], "utf8");
vm.runInThisContext(source, { filename: process.argv[2] });
const Card = registry.get("ha-list-manager-shopping-card");
const card = new Card(); card._hass = nativeHass();
card._busy = false;
card._list = { tandoor_excluded_units: "" };
if (!card._isTandoorSmallUnit({ unit: "Prise(n)" })) {
  throw new Error("Tandoor plural marker in Prise(n) is not recognized as a small unit");
}
if (card._tandoorAmountText({ amount: 0, unit: null, no_amount: false }) !== "") {
  throw new Error("Zero Tandoor amount is still treated as a shopping quantity");
}
card._tandoorDialog = {
  mode: "recipe",
  recipeTab: "ingredients",
  servings: 2,
  skipSmallUnits: false,
  status: "",
  recipe: {
    id: 1,
    name: "Testgericht",
    servings: 2,
    image: null,
    ingredients: [{ id: 11, name: "Möhren", amount: 2, unit: "Stück", note: null }],
    steps: [{ id: 21, name: "Vorbereiten", instruction: "Möhren schneiden.\nKurz garen." }],
  },
  products: {},
  selected: new Set(["11"]),
  useProducts: new Set(),
  includeAmounts: new Set(["11"]),
  ingredientCategories: {
    "11": { category_id: "vegetables", category_name: "Gemüse", dynamic: false, general: false, source: "automatic", locked: false },
  },
};

let markup = card._renderTandoorDialog();
if (!markup.includes('data-tandoor-recipe-tab="ingredients"') || !markup.includes('data-tandoor-recipe-tab="preparation"')) {
  throw new Error("Recipe tabs are missing when preparation steps exist");
}
if (!markup.includes("Zutaten <span>1</span>") || !markup.includes("Zubereitung <span>1</span>")) {
  throw new Error("Recipe tab counters are missing");
}
if (!markup.includes("data-tandoor-servings") || !markup.includes("Rezeptmenge: <strong>2 Stück</strong>")) {
  throw new Error("Portion control or original ingredient amount is missing");
}
if (!markup.includes('data-tandoor-category-search="11"') || !markup.includes('value="Gemüse"')) {
  throw new Error("Resolved ingredient category is not shown in the recipe selection");
}
card._tandoorDialog.selected.clear();
markup = card._renderTandoorDialog();
if (markup.includes('data-tandoor-category-search="11"')) {
  throw new Error("Unselected ingredients still waste space with a category selector");
}
card._tandoorDialog.selected.add("11");
card._tandoorDialog.servings = 4;
markup = card._renderTandoorDialog();
if (!markup.includes("Rezeptmenge: <strong>4 Stück</strong>") || card._tandoorProductCount({ amount: 400, unit: "g" }, { package_quantity: "500 g" }) !== 2) {
  throw new Error("Ingredient amounts and package counts do not scale with portions");
}
if (!markup.includes("data-tandoor-ingredient=\"11\"") || markup.includes("tandoor-step-number")) {
  throw new Error("Ingredients are not the default recipe tab");
}

card._tandoorDialog.recipeTab = "preparation";
markup = card._renderTandoorDialog();
if (!markup.includes("tandoor-step-number\">1</span>") || !markup.includes("Vorbereiten") || !markup.includes("Möhren schneiden.\nKurz garen.")) {
  throw new Error("Preparation steps are not rendered in order with preserved line breaks");
}
if (!markup.includes("data-add-tandoor") || markup.includes("data-tandoor-ingredient=\"11\"")) {
  throw new Error("Preparation tab lost the add action or still renders ingredient controls");
}
if (!card._tandoorDialog.selected.has("11") || !card._tandoorDialog.includeAmounts.has("11")) {
  throw new Error("Switching the recipe tab discarded ingredient selection state");
}

card._tandoorDialog.recipeTab = "ingredients";
card._tandoorDialog.recipe.ingredients.push({ id: 12, name: "etwas Milch", amount: 0, unit: null, note: null });
card._tandoorDialog.selected.add("12");
card._tandoorDialog.includeAmounts.delete("12");
markup = card._renderTandoorDialog();
if (markup.includes("Rezeptmenge: <strong>0</strong>")) {
  throw new Error("Zero recipe amount is still rendered as selectable amount");
}

card._tandoorDialog.recipe.steps = [];
markup = card._renderTandoorDialog();
if (markup.includes("data-tandoor-recipe-tab") || !markup.includes("data-tandoor-ingredient=\"11\"")) {
  throw new Error("Recipes without preparation steps should show ingredients without empty tabs");
}

card._config = { ...Card.getStubConfig(), list_id: "weekly" };
card._list = { id: "weekly" };
card._categories = [{ id: "vegetables", name: "Gemüse", scope: "list", dynamic: false }];
card._items = [];
card._render = () => {};
card._unlockScroll = () => {};
card._setNotificationStatus = () => {};
card._load = async () => {};
const messages = [];
card._hass = nativeHass({ callWS: async (message) => { messages.push(message); return {}; } });

(async () => {
  await card._addTandoorSelection();
  const create = messages.find((message) => message.type.endsWith("/items/create"));
  if (!create || create.category_id !== "vegetables" || create.category !== null) {
    throw new Error("Selected saved category was not used when adding a Tandoor ingredient");
  }
  if (create.description !== "4 Stück") {
    throw new Error("Scaled free-ingredient amount was not kept while assigning its category");
  }
  console.log("Tandoor preparation smoke test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
