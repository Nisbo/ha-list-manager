/* Render the affected workflows with HA's native German and English catalogs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { nativeHass } = require("./native_translation_hass");

const frontend = path.join(__dirname, "../custom_components/ha_list_manager/frontend");
function load(name) {
  const registry = new Map();
  const element = () => ({ querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  const context = vm.createContext({
    console: { info() {}, log() {}, error: console.error }, Date, Intl,
    HTMLElement: class { attachShadow() { return this.shadowRoot = element(); } },
    customElements: { get: key => registry.get(key), define: (key, value) => registry.set(key, value) },
    document: { createElement: element, body: { style: {} }, documentElement: { lang: "de-DE", style: {} } },
    navigator: { language: "de-DE" }, window: { customCards: [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(frontend, `ha-list-manager-${name}.js`), "utf8"), context);
  return new (registry.get(`ha-list-manager-${name}`))();
}

// Inspect the real action/input markup rather than scanning whole pages, which
// legitimately contain user-entered German text even in an English interface.
function buttonText(html, attribute) {
  const match = html.match(new RegExp(`<button\\b(?=[^>]*\\b${attribute}(?:[\\s=>]))[^>]*>([\\s\\S]*?)<\\/button>`));
  assert.ok(match, `Missing production action ${attribute}`);
  return match[1].replace(/<[^>]*>/g, "").trim();
}
function placeholder(html, attribute) {
  const input = html.match(new RegExp(`<input\\b(?=[^>]*\\b${attribute}(?:[\\s=>]))[^>]*>`));
  assert.ok(input, `Missing production input ${attribute}`);
  return input[0].match(/\bplaceholder="([^"]*)"/)?.[1];
}

const shopping = load("shopping-card");
const inventory = load("inventory-card");
const panel = load("panel");
const userName = "Milch und Frühstück";
const shoppingDraft = {
  mode: "product-transfer", name: userName, original_name: "", ean: "",
  brand: "", package_quantity: "", image_url: "", category_name: "", category_id: null, label_ids: [],
};
const inventoryDraft = {
  name: userName, original_name: "", ean: "", brand: "", package_quantity: "",
  image_url: "", stock: 0, minimum_stock: "", category_name: "", category_id: null, label_ids: [],
};

// Reuse the mounted objects when switching back, so cached wording cannot pass.
for (const language of ["de-DE", "en-GB", "de-DE"]) {
  const de = language.startsWith("de");
  for (const component of [shopping, inventory, panel]) component._hass = nativeHass({ language, states: {} });
  const lookup = de ? "EAN abfragen" : "Look up EAN";

  shopping._dialog = structuredClone(shoppingDraft);
  const beforeShopping = JSON.stringify(shopping._dialog);
  const transfer = shopping._renderDialog();
  assert.equal(buttonText(transfer, "data-lookup-product-ean"), lookup, `${language}: shopping EAN lookup`);
  assert.equal(placeholder(transfer, 'data-product-field="package_quantity"'), de ? "z. B. 500 g" : "e.g. 500 g");
  assert.ok(transfer.includes(`value="${userName}"`), "User product names remain unchanged");
  assert.equal(JSON.stringify(shopping._dialog), beforeShopping, "Rendering leaves the product transfer draft unchanged");

  inventory._dialog = { kind: "add", draft: structuredClone(inventoryDraft) };
  const beforeInventory = JSON.stringify(inventory._dialog);
  const addProduct = inventory._renderDialog();
  assert.equal(buttonText(addProduct, "data-lookup-ean"), lookup, `${language}: inventory EAN lookup`);
  assert.equal(JSON.stringify(inventory._dialog), beforeInventory, "Rendering leaves the inventory draft unchanged");
  inventory._dialog.kind = "product-edit";
  const editProduct = inventory._renderDialog();
  assert.equal(buttonText(editProduct, "data-lookup-ean"), de ? "Aktualisieren" : "Refresh", "Existing-product refresh remains distinct from lookup");

  panel._lists = [
    { id: "groceries", name: "Einkauf", list_type: "shopping" },
    { id: "tasks", name: "Aufgaben", list_type: "todo" },
  ];
  for (const [tab, listId, isTemplate] of [
    ["global", "groceries", false], ["shopping", "groceries", false],
    ["todo", "groceries", true], ["specific", "groceries", false], ["specific", "tasks", true],
  ]) {
    panel._chipTab = tab;
    panel._chipSpecificListId = listId;
    const chips = panel._renderChips();
    const expected = isTemplate
      ? de ? "To-do-Vorlage anlegen" : "Create to-do template"
      : de ? "Chip anlegen" : "Create chip";
    assert.equal(buttonText(chips, "data-add-chip"), expected, `${language}: complete create label in ${tab}/${listId}`);
  }

  panel._lists = [];
  panel._notificationProfiles = [{ id: "feedback", name: userName, provider: "persistent", enabled: true }];
  for (const count of [0, 1, 2]) {
    panel._notificationAssignments = Array.from({ length: count }, (_, index) => ({ profile_id: "feedback", list_id: `list-${index}` }));
    const notifications = panel._renderNotifications();
    const assigned = de ? `${count} ${count === 1 ? "Liste" : "Listen"} zugeordnet` : `Assigned to ${count} ${count === 1 ? "list" : "lists"}`;
    assert.ok(notifications.includes(`${assigned} · ${de ? "Aktiv" : "Active"}`), `${language}: ${count} assigned lists`);
    assert.ok(notifications.includes(`<strong>${userName}</strong>`), "User notification names remain unchanged");
  }

  const simulationBefore = JSON.stringify(panel._simulation);
  assert.equal(placeholder(panel._renderScannerSimulation(), "data-simulation-ean"), de ? "z. B. 4062139025398" : "e.g. 4062139025398");
  assert.equal(JSON.stringify(panel._simulation), simulationBefore, "Rendering a scanner example does not execute or change a scan");

  panel._dialog = { record: null, draft: { name: userName, provider: "notify_entity", target: "", click_url: "", title: "", message_format: "plain" } };
  assert.equal(placeholder(panel._renderNotificationDialog(), "data-notification-click-url"), de
    ? "z. B. /dashboard-einkauf/einkaufsliste" : "e.g. /dashboard-groceries/groceries");
  panel._dialog = { record: null, draft: { ...inventoryDraft, category_assignments: [] } };
  assert.equal(placeholder(panel._renderProductDialog(), "data-product-quantity"), de ? "z. B. 1,25 l" : "e.g. 1.25 l");
}

async function pdfTests() {
  for (const [kind, dePrefix, enPrefix] of [
    ["shopping", "einkaufsliste", "shopping-list"],
    ["inventory", "inventar", "inventory"],
    ["todo", "todo", "todo"],
  ]) {
    const card = load(`${kind}-card`);
    card._render = () => {};
    const exported = [];
    card._loadPdfExporter = async () => ({ exportPdf: async options => exported.push(options) });
    for (const language of ["de-DE", "en-GB", "de-DE"]) {
      const de = language.startsWith("de");
      card._hass = nativeHass({ language, states: {} });
      for (const scenario of [
        { name: userName, id: "weekly", suffix: userName },
        { name: "", id: "weekly", suffix: "weekly" },
        { name: "", id: "", suffix: de ? "liste" : "list" },
      ]) {
        card._list = { name: scenario.name };
        card._listId = () => scenario.id;
        const previous = exported.length;
        await card._exportPdf();
        assert.equal(card._error, "", `${language} ${kind}: export succeeds`);
        assert.equal(exported.length, previous + 1, "One export per action");
        const result = exported.at(-1);
        assert.equal(result.fileName, `${de ? dePrefix : enPrefix}-${scenario.suffix}`, `${language} ${kind}: translated filename and fallback`);
        if (scenario.name) assert.equal(result.title, userName, "The list name and PDF title remain user-provided data");
        assert.equal(result.hass, card._hass, "The exporter retains the selected HA locale");
        assert.equal(card._pdfExporting, false, "The busy flag clears after a successful export");
      }
    }
  }
}

pdfTests().then(() => console.log("Translation residues verified through DE/EN/DE product dialogs, create buttons, plural assignment counts, examples and PDF export names"))
  .catch(error => { console.error(error); process.exitCode = 1; });
