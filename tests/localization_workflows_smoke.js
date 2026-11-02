/* Exercise bilingual workflows through production methods and editor forms. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { nativeHass } = require("./native_translation_hass");

const frontend = path.join(__dirname, "../custom_components/ha_list_manager/frontend");

class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.nodes = new Map();
    this.listeners = new Map(); this.attributes = new Map();
    this.dataset = {}; this.style = {}; this.events = []; this.value = "";
    this.classList = { remove() {}, add() {}, toggle() {} };
  }
  set innerHTML(value) {
    this.html = value;
    this.children = this.children.filter(child => !child.parsedLabel);
    // Only the history editor's persistent labels need a parsed DOM here.
    for (const match of value.matchAll(/<([a-z][\w-]*)\b[^>]*\s(data-reference-heading|data-reference-help|data-add-reference-label|data-remove-reference-label)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const label = new Element(match[1]); label.parsedLabel = true;
      label.setAttribute(match[2], ""); label.textContent = match[3];
      this.nodes.set(`[${match[2]}]`, label); this.children.push(label);
    }
  }
  get innerHTML() { return this.html || ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  matches(selector) {
    return selector === this.tag || (selector.startsWith("[") && !selector.includes("=") && this.attributes.has(selector.slice(1, -1)));
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.nodes.get(selector) || this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, values = {}) {
    return this.listeners.get(name)?.({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...values });
  }
  dispatchEvent(event) { this.events.push(event); }
  closest() { return this; }
  select() { this.selected = true; }
  focus() {}
}

function loadCard(kind) {
  const registry = new Map();
  const context = vm.createContext({
    console: { info() {}, log() {}, error: console.error }, Date, Intl,
    HTMLElement: class extends Element { attachShadow() { return this.shadowRoot = new Element("shadow"); } },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    customElements: { get: name => registry.get(name), define: (name, ctor) => registry.set(name, ctor) },
    document: {
      documentElement: { lang: "de-DE", style: {} }, body: { style: {} },
      createElement(tag) {
        const element = new Element(tag);
        if (tag === "ha-expansion-panel") {
          for (const attr of ["data-reference-rows", "data-add-reference"]) {
            const node = new Element(attr === "data-add-reference" ? "ha-button" : "div");
            node.setAttribute(attr, ""); element.append(node);
          }
        }
        return element;
      },
    },
    navigator: { language: "de-DE" }, window: { customCards: [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const file = `ha-list-manager-${kind}-card.js`;
  const helper = `haListManager${kind[0].toUpperCase() + kind.slice(1)}CardText`;
  vm.runInContext(fs.readFileSync(path.join(frontend, file), "utf8") +
    `\nglobalThis.probes = { locale: ${helper}Locale, language: ${helper}Language };`, context, { filename: file });
  return { Card: registry.get(`ha-list-manager-${kind}-card`), Editor: registry.get(`ha-list-manager-${kind}-card-editor`), probes: context.probes };
}

const resources = Object.fromEntries(["shopping", "inventory", "todo", "history"].map(kind => [kind, loadCard(kind)]));
const hassFor = (language, callWS = async () => ({})) => nativeHass({ locale: { language }, language, states: {}, callWS });
const flatten = schema => schema.flatMap(field => [field, ...flatten(field.schema || [])]);

function editorTests() {
  for (const [kind, { Card, Editor, probes }] of Object.entries(resources)) {
    assert.equal(probes.locale(hassFor("en-GB")), "en-GB", `${kind}: regional display locale is preserved`);
    assert.equal(probes.language(hassFor("en-GB")), "en", `${kind}: request language retains its compatible English value`);
    assert.equal(probes.locale(hassFor("de-AT")), "de-AT");
    assert.equal(probes.language(hassFor("de-AT")), "de");
    const editor = new Editor();
    editor.setConfig({ title: "My own title", reference_lines: [{ value: 2, label: "User reference" }] });
    let form;
    const optionValues = [];
    for (const language of ["de-DE", "en-GB"]) {
      editor.hass = hassFor(language);
      if (form) assert.equal(editor._form, form, `${kind}: language change preserves the form instance`);
      form = editor._form;
      assert.match(form.computeLabel({ name: "title" }), language.startsWith("de") ? /^Titel/ : /^Title/);
      assert.equal(editor._config.title, "My own title", "User-provided titles are not translated");
      const definition = Card.getConfigForm(hassFor(language));
      const fields = flatten(definition.schema);
      // Direct ha-form callbacks receive current FORM DATA as argument two.
      // Lovelace's wrapper instead supplies a LocalizeFunc (tested below).
      const formData = Object.freeze({ ...editor._config, entity: "sensor.user", localize: { userData: true } });
      const beforeData = JSON.stringify(formData);
      for (const field of fields) {
        assert.equal(form.computeLabel(field, formData), definition.computeLabel(field),
          `${kind}: ha-form data must not replace the captured HA localizer for ${field.name}`);
        assert.equal(form.computeHelper(field, formData), definition.computeHelper(field),
          `${kind}: helper retains the selected language when ha-form passes data for ${field.name}`);
      }
      assert.equal(JSON.stringify(formData), beforeData, "Editor callbacks leave form data untouched");

      const selectorName = kind === "history" ? "view" : "view_mode";
      const options = fields.find(field => field.name === selectorName).selector.select.options;
      const option = options.find(entry => entry.value === (kind === "history" ? "chart" : "auto"));
      assert.equal(option.label, language.startsWith("de") ? (kind === "history" ? "Diagramm" : "Automatisch") : (kind === "history" ? "Chart" : "Automatic"));
      optionValues.push(JSON.stringify(options.map(entry => entry.value)));
      if (kind === "inventory") {
        const actions = fields.find(field => field.name === "default_action").selector.select.options;
        assert.equal(actions.find(entry => entry.value === "add").label, language.startsWith("de") ? "Einlagern" : "Add stock");
      }
      if (kind === "history") {
        assert.equal(editor._references.querySelector("[data-add-reference-label]").textContent, language.startsWith("de") ? "Referenzlinie hinzufügen" : "Add reference line");
        assert.equal(editor._references.querySelector("[data-remove-reference-label]").textContent, language.startsWith("de") ? "Referenzlinie entfernen" : "Remove reference line");
      } else {
        assert.equal(form.computeLabel({ name: "show_pdf_export_button" }), language.startsWith("de") ? "PDF-Export anzeigen" : "Show PDF export");
      }
    }
    const germanDefinition = Card.getConfigForm(hassFor("de-DE"));
    const nativeEnglishLocalize = hassFor("en-GB").localize;
    assert.match(germanDefinition.computeLabel({ name: "title" }, nativeEnglishLocalize), /^Title/,
      `${kind}: HA config form callbacks use the supplied native localizer`);
    const englishDefinition = Card.getConfigForm(hassFor("en-GB"));
    assert.equal(germanDefinition.computeHelper({ name: "entity" }, nativeEnglishLocalize),
      englishDefinition.computeHelper({ name: "entity" }),
      `${kind}: Lovelace's native LocalizeFunc also overrides helper text`);
    assert.notEqual(germanDefinition.computeHelper({ name: "entity" }, nativeEnglishLocalize),
      germanDefinition.computeHelper({ name: "entity" }),
      `${kind}: helper override is observably English rather than the captured German`);

    assert.equal(optionValues[0], optionValues[1], `${kind}: translated options keep protocol values`);
    assert.equal(editor.events.length, 0, `${kind}: language changes do not emit config mutations`);
  }
}

function shoppingCard(language, reply = {}) {
  const card = new resources.shopping.Card();
  const requests = [];
  card._hass = hassFor(language, async message => { requests.push(message); return reply; });
  card._config = { list_id: "weekly" };
  card._render = () => {};
  card._load = async () => {};
  card._unlockScroll = () => {};
  card._setNotificationStatus = message => { card.lastStatus = message; };
  card._bindChipActions = () => {};
  card._bindDynamicContent = () => {};
  card._bindScrollGuard = () => {};
  card._installPickerListTriggers = () => {};
  return { card, requests };
}

function categoryInput(card, workflow, choice, categories) {
  const input = new Element("input"), menu = new Element(), add = new Element("button");
  const kind = workflow === "dish" ? "dish" : "tandoor";
  input.setAttribute(`data-${kind}-category-search`, "1");
  menu.setAttribute(`data-${kind}-category-options`, "1");
  add.setAttribute("data-add-dish-to-list", "");
  card.shadowRoot.append(input, menu, add);
  card._availableCategories = () => categories;
  if (workflow === "dish") {
    card._dishDialog = {
      dish: { id: "dish", name: "Dinner", items: [{ id: "1", name: "Pasta" }] },
      selected: new Set(["1"]), quantities: { "1": 1 }, categories: { "1": choice },
    };
    card._bind();
  } else {
    card._tandoorDialog = {
      recipe: { name: "Dinner", ingredients: [{ id: 1, name: "Pasta" }] },
      selected: new Set(["1"]), products: {}, useProducts: new Set(), includeAmounts: new Set(),
      ingredientCategories: { "1": choice },
    };
    card._configureTandoorCategorySelectors();
  }
  return { input, add };
}

async function categoryTests() {
  for (const language of ["de-DE", "en-GB"]) for (const workflow of ["dish", "recipe"]) {
    for (const scenario of ["unassigned", "saved-General", "saved-Allgemein", "dynamic-General", "dynamic-Allgemein"]) {
      const { card, requests } = shoppingCard(language, { created: 1 });
      const choice = { category_id: null, category_name: "", dynamic: false, general: true, source: "none", locked: false };
      const dynamic = scenario.startsWith("dynamic-");
      const name = scenario.split("-")[1] || "";
      const categories = name
        ? [{ id: dynamic ? `dynamic:${name}` : `saved:${name}`, name, dynamic, scope: "list" }]
        : [{ id: "saved:General", name: "General" }, { id: "saved:Allgemein", name: "Allgemein" }];
      const { input, add } = categoryInput(card, workflow, choice, categories);
      input.emit("focus");
      if (name) { input.value = name; input.emit("input"); }
      input.emit("keydown", { key: "Enter" });
      if (workflow === "dish") { add.emit("click"); await new Promise(setImmediate); }
      else await card._addTandoorSelection();
      const request = requests.find(message => message.type.endsWith(workflow === "dish" ? "/dishes/add_to_list" : "/items/create"));
      assert.ok(request, `${language} ${workflow} ${scenario}: production add request exists`);
      const item = workflow === "dish" ? request.items[0] : request;
      assert.equal(item.category_id, name && !dynamic ? `saved:${name}` : null, `${scenario}: saved category identity`);
      assert.equal(item.category, dynamic ? name : null, `${scenario}: unassigned stays null and real names survive`);
      assert.equal(request.language, language.startsWith("de") ? "de" : "en", "API preserves its normalized language field");
    }
  }
}

async function grammarAndParserTests() {
  for (const language of ["de-DE", "en-GB"]) {
    const de = language.startsWith("de");
    const { card } = shoppingCard(language);
    card._list = { tandoor_excluded_units: "spoonful" };
    for (const unit of ["Esslöffel", "Teelöffel", "EL", "TL", "tbsp", "tsp", "pinch", "dash", "spoonful"]) {
      assert.equal(card._isTandoorSmallUnit({ unit }), true, `${language}: ${unit} is recognized independently of UI text`);
    }
    for (const quantity of ["6 pieces", "6 pcs", "6 Stück"]) {
      assert.equal(card._parsePackageMeasurement(quantity).dimension, "count");
      assert.equal(card._parsePackageMeasurement(quantity).value, 6);
    }
    card._tandoorServingScale = () => 1;
    assert.equal(card._tandoorAmountText({ amount: 1.25, unit: "l" }), de ? "1,25 l" : "1.25 l");
    assert.equal(card._list.tandoor_excluded_units, "spoonful");
    for (const count of [1, 2]) {
      const deletion = shoppingCard(language);
      deletion.card._items = Array.from({ length: count }, (_, i) => ({ id: String(i), completed: true }));
      deletion.card._confirmation = { type: "clear_completed", count };
      const confirmation = deletion.card._renderConfirmation();
      assert.ok(confirmation.includes(de
        ? `${count} erledigte${count === 1 ? "r Artikel wird" : " Artikel werden"} dauerhaft`
        : `${count} completed item${count === 1 ? "" : "s"} will be permanently removed`));
      await deletion.card._clearCompleted();
      assert.equal(deletion.card._notificationStatus, de
        ? `${count} erledigte${count === 1 ? "r" : ""} Artikel gelöscht.`
        : `${count} completed item${count === 1 ? "" : "s"} deleted.`);
      assert.equal(deletion.requests.filter(message => message.type.endsWith("/items/delete")).length, count);
      const dish = shoppingCard(language, { created: count });
      await dish.card._addDishToList({ id: "dish", name: "Dinner" });
      assert.equal(dish.card.lastStatus, de
        ? `Dinner: ${count} Zutat${count === 1 ? " wurde" : "en wurden"} hinzugefügt.`
        : `Dinner: ${count} ingredient${count === 1 ? " was" : "s were"} added.`);
      const recipe = shoppingCard(language);
      recipe.card._availableCategories = () => [];
      recipe.card._tandoorDialog = {
        recipe: { name: "Dinner", ingredients: Array.from({ length: count }, (_, id) => ({ id, name: `Ingredient ${id}` })) },
        selected: new Set(Array.from({ length: count }, (_, id) => String(id))), products: {},
        useProducts: new Set(), includeAmounts: new Set(), ingredientCategories: {},
      };
      await recipe.card._addTandoorSelection();
      assert.equal(recipe.card.lastStatus, de
        ? `Dinner: ${count} Artikel ${count === 1 ? "wurde" : "wurden"} hinzugefügt.`
        : `Dinner: ${count} item${count === 1 ? " was" : "s were"} added.`);
    }
  }
  const todo = new resources.todo.Card(); todo._hass = hassFor("en-GB");
  const due = new Date("2026-11-05T12:30:00Z");
  assert.equal(todo._formatDue({ due_at: due.toISOString() }), new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(due), "A production date formatter retains the regional English locale");
}

async function staleProductTests() {
  for (const language of ["de-DE", "en-GB"]) for (const code of ["not_found", "product_not_found", "invalid_format"]) {
    const { card } = shoppingCard(language);
    const attempts = [];
    const message = code === "invalid_format" ? "Product not found" : "Unrelated localized error wording";
    card._hass.callWS = async request => {
      attempts.push(request);
      if (attempts.length === 1) throw { code, message };
      return { chip: { id: "saved-chip" } };
    };
    card._browserChipMenu = { chip: { id: "browser-chip", name: "Milk", product_id: "deleted-product" } };
    card._isChipImportant = () => false;
    card._removeBrowserChip = () => { card.browserChipRemoved = true; };
    await card._saveBrowserChipPermanently();
    const missingProduct = code !== "invalid_format";
    assert.equal(attempts.length, missingProduct ? 2 : 1, "Retry depends on the stable code rather than translated error wording");
    if (missingProduct) {
      assert.equal(attempts[1].product_id, null);
      assert.equal(card.browserChipRemoved, true);
    } else {
      assert.equal(card._browserChipMenu.status, message);
      assert.equal(card.browserChipRemoved, undefined);
    }
  }
}

(async () => {
  editorTests();
  await categoryTests();
  await grammarAndParserTests();
  await staleProductTests();
  console.log("Localization workflows passed: DE/EN categories, parsing, plural statuses, four config editors, and regional locales");
})().catch(error => { console.error(error); process.exitCode = 1; });
