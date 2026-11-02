const { nativeHass } = require("./native_translation_hass");
/* Browser-independent smoke test for inventory chip rendering and activation. */
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
const values = new Map();
global.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };

const source = fs.readFileSync(process.argv[2], "utf8");
const structure = require("./localization_source")(source);
if (structure.includes('<label><span>Kategorie</span>${this._categoryPickerMarkup()}</label>') || structure.includes('<label><span>Kategorie der Gruppe</span>${this._categoryPickerMarkup()}</label>')) {
  throw new Error("Inventory category help is still wrapped by a label and reopens the picker when clicked");
}
if ((structure.match(/<div class="dialog-field"><span>Kategorie/g) || []).length < 3) {
  throw new Error("Inventory category pickers do not use neutral dialog field wrappers");
}
if (!structure.includes('class="category-option-icon" style="${category.color ? `--category-color:') || !structure.includes('class="category-option-icon" style="${productDefault.color ? `--category-color:')) {
  throw new Error("Inventory category picker icons do not use category and product-default colors");
}
vm.runInThisContext(source, { filename: process.argv[2] });
const Card = registry.get("ha-list-manager-inventory-card");
const card = new Card(); card._hass = nativeHass();
card._config = { ...Card.getStubConfig(), list_id: "pantry", category_chip_layout: "stacked" };
const controlCodes = card._inventoryControlCodes();
const expectedControlCodes = ["ADD", "REMOVE", "REGISTER", "CORRECT"].map((action) => `HA-LM:INVENTORY:pantry:${action}`);
if (JSON.stringify(controlCodes.map((entry) => entry.value)) !== JSON.stringify(expectedControlCodes)) {
  throw new Error("Inventory control QR codes do not identify this inventory and all four booking modes");
}
card._controlCodesOpen = true;
const controlCodeMarkup = card._renderControlCodes();
if (!expectedControlCodes.every((value) => controlCodeMarkup.includes(`data-control-code="${value}"`)) || !controlCodeMarkup.includes("QR-Codes für Buchungsmodi")) {
  throw new Error("Inventory control QR dialog is incomplete");
}
card._controlCodesOpen = false;
card._categories = [{ id: "drinks", name: "Getränke", scope: "list_type", list_type: "inventory", color: "#123456" }];
card._products = [{ id: "beer", name: "Bier", category_assignments: [{ category_id: "drinks", scope: "list_type", list_type: "inventory" }] }];
card._chips = [{ id: "water-chip", name: "Wasser", scope: "global", product_id: null }, { id: "beer-chip", name: "Bier", scope: "list_type", product_id: "beer", product_name: "Bier" }];
card._importantChipKeys = new Set(["chip:water-chip"]);
card._chipCategories = new Map([["water-chip", null], ["beer-chip", card._categories[0]]]);

const markup = card._renderChips();
if (!markup.includes("Wichtig") || !markup.includes("Getränke") || !markup.includes("Wasser") || !markup.includes('data-chip-category="drinks"')) throw new Error("Inventory chip groups were not rendered");
if (!markup.includes("data-toggle-chip-categories")) throw new Error("Categorized inventory chips have no all-category counter toggle");
const inventoryRender = card._render;
card._render = () => {};
card._toggleAllChipCategories();
if (!card._renderChips().includes('aria-label="Alle Kategorien einklappen"') || !card._renderChips().includes('data-quick-chip="beer-chip"')) throw new Error("Inventory chip counter did not open every category");
card._toggleAllChipCategories();
if (card._renderChips().includes("data-quick-chip")) throw new Error("Inventory chip counter did not close every category");
card._render = inventoryRender;
if (markup.includes("Gerichte")) throw new Error("Inventory card rendered dishes");
const configForm = Card.getConfigForm(nativeHass());
const sectionLabels = configForm.schema.filter((entry) => entry.type === "expandable").map((entry) => entry.label);
for (const label of ["Allgemein", "Eingabe und Buchung", "Artikel und Kategorien", "Buttonleiste und Aktionen", "Chips"]) {
  if (!sectionLabels.includes(label)) throw new Error(`Inventory editor has no ${label} section`);
}
if (sectionLabels.includes("Gerichte")) throw new Error("Inventory editor exposes dishes");
const configFields = configForm.schema.flatMap((entry) => entry.schema || [entry]);
const newConfigNames = ["input_row_position", "show_quantity_box", "show_submit_button", "allow_suggestions", "show_camera_scan_button", "show_scanner_target_button", "show_plus_minus", "show_details_default", "show_hidden_default", "group_categories", "show_category_count", "option_row_position", "show_stock_filter_button", "show_hidden_button", "show_details_button", "show_category_toggle_button", "show_label_filter_button", "show_category_filter_button", "show_group_button", "show_product_database_button"];
for (const name of newConfigNames) {
  const field = configFields.find((entry) => entry.name === name);
  if (!field || !configForm.computeLabel(field) || !configForm.computeHelper(field)) throw new Error(`Inventory editor option ${name} is missing or undocumented`);
}
const defaults = Card.getStubConfig();
for (const name of ["show_quantity_box", "show_submit_button", "allow_suggestions", "show_camera_scan_button", "show_mode_toggle", "show_scanner_target_button", "show_plus_minus", "show_images", "show_details_default", "group_categories", "show_category_count", "show_stock_filter_button", "show_hidden_button", "show_details_button", "show_category_toggle_button", "show_label_filter_button", "show_category_filter_button", "show_group_button", "show_product_database_button"]) {
  if (defaults[name] !== true) throw new Error(`Inventory compatibility default ${name} is not enabled`);
}
if (defaults.show_hidden_default !== false || defaults.show_pdf_export_button !== false || defaults.input_row_position !== "top" || defaults.option_row_position !== "top") throw new Error("Inventory compatibility defaults changed");
const styles = card._styles();
if (!styles.includes(".view-panel.chips-position-auto .inventory-card-layout")) throw new Error("Automatic panel chip position is not a right column");
if (!styles.includes(".quick-chip{min-height:32px;padding:4px 11px")) throw new Error("Inventory chip dimensions differ from shopping chips");
if (!styles.includes("@container(max-width:700px)") || styles.split(".view-panel.chips-position-auto .inventory-card-layout,.chips-position-right .inventory-card-layout").length < 3) throw new Error("Mobile panel chips are not reset below the inventory");
if (!styles.includes(".chip-category-selector>ha-icon:first-child{--mdc-icon-size:19px") || !styles.includes(".chip-category-selector strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px")) throw new Error("Inventory category chip contents differ from shopping chips");
if (!styles.includes(".category-picker-options .category-option-icon{display:grid;place-items:center") || !styles.includes("color:var(--category-color,var(--primary-color))")) throw new Error("Inventory category picker icon colors are not styled");
const picturedSuggestion = card._suggestionMarkup({ id: "pictured", name: "Produkt", image_url: "https://example.test/product.png" });
const placeholderSuggestion = card._suggestionMarkup({ id: "placeholder", name: "Ohne Bild", image_url: null });
if (!picturedSuggestion.includes('<img src="https://example.test/product.png"') || !placeholderSuggestion.includes("suggestion-placeholder") || !styles.includes(".suggestions img,.suggestion-placeholder")) {
  throw new Error("Inventory product suggestions do not render shopping-style images and placeholders");
}
card._labels = [{ id: "party", name: "Party", icon: "mdi:party-popper", color: "#ff00aa" }];
const toolbarMarkup = card._renderToolbar();
if (toolbarMarkup.includes("data-open-products") || !toolbarMarkup.includes("toolbar-filter-button") || !toolbarMarkup.includes('title="Alle Labels"') || !toolbarMarkup.includes('title="Alle Kategorien"')) {
  throw new Error("Inventory toolbar still contains the product database or lacks compact filter controls");
}
if (!toolbarMarkup.includes("data-toggle-categories") || toolbarMarkup.includes("data-toggle-group-selection")) {
  throw new Error("Inventory toolbar does not replace grouping with the category toggle");
}
if (!structure.includes('const productsButton = this._hass.user?.is_admin !== true || this._config.show_product_database_button === false ? ""') || !structure.includes("data-open-products><ha-icon icon=\"mdi:database\"") || !structure.includes('querySelectorAll("[data-open-products]")')) {
  throw new Error("Inventory product database action is not available in both header layouts");
}
if (!structure.includes('const groupButton = this._config.show_group_button === false ? ""') || (structure.match(/data-toggle-group-selection/g) || []).length < 3) {
  throw new Error("Inventory grouping is not available in the wide header and compact action menu");
}
if (!structure.includes("compactControlCodesButton") || !structure.includes("QR-Codes für Buchungsmodi") || !structure.includes('querySelectorAll("[data-open-control-codes]")')) {
  throw new Error("Inventory control QR codes are not available from the action menu");
}
if (!styles.includes(".control-code-grid{display:grid") || !styles.includes("@container(max-width:580px){.control-code-grid{grid-template-columns:1fr}")) {
  throw new Error("Inventory control QR dialog is not responsive");
}
if (!structure.includes('!event.target.closest(".category-filter")') || !structure.includes('!event.target.closest(".label-filter")')) {
  throw new Error("Inventory category or label filters do not close after an outside click");
}
if (!styles.includes(".toolbar-filter-button>span,.toolbar-filter-button>.filter-menu-chevron{display:none}")) {
  throw new Error("Compact inventory category and label filters still show their text");
}
if (
  !styles.includes(".toolbar{position:relative;display:flex;flex-wrap:wrap;gap:7px}") ||
  !styles.includes(".category-filter,.label-filter{position:static;justify-self:start}.category-menu,.label-menu{left:6px;right:6px;top:calc(100% + 6px);width:auto;max-width:none}") ||
  !styles.includes(".view-mobile .category-filter,.view-mobile .label-filter{position:static;justify-self:start}.view-mobile .category-menu,.view-mobile .label-menu{left:6px;right:6px;top:calc(100% + 6px);width:auto;max-width:none}")
) {
  throw new Error("Inventory category and label menus are not anchored to the full mobile toolbar width");
}
card._filter = "zero";
const activeFilterMarkup = card._renderToolbar();
if (!activeFilterMarkup.includes('class="filter active"') || !activeFilterMarkup.includes('Bestandsfilter: Bestand 0')) {
  throw new Error("A non-default inventory stock filter is not marked active");
}
if (!styles.includes(".filter.active,.toolbar .tool-button.active{color:var(--primary-color);border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,var(--card-background-color))}") || !styles.includes(".filter select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}") || !styles.includes(".toolbar .tools,.toolbar .toolbar-filters{width:auto}") || !styles.includes(".toolbar-filter-button{display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}")) {
  throw new Error("Compact inventory stock filter or single-row toolbar styling is missing");
}
card._filter = "all";

card._config = { ...card._config, ...Object.fromEntries(["show_stock_filter_button", "show_hidden_button", "show_details_button", "show_category_toggle_button", "show_label_filter_button", "show_category_filter_button"].map((name) => [name, false])) };
if (card._renderToolbar() !== "") throw new Error("Disabled inventory toolbar controls are still rendered");
card._pendingScans = [{ id: "scan-1" }];
if (!card._renderToolbar().includes("Offene Scans (1)")) throw new Error("Pending scans disappeared with all optional toolbar controls disabled");
card._pendingScans = [];
card._config = { ...Card.getStubConfig(), list_id: "pantry", show_plus_minus: false, show_category_count: false };
const entryWithoutControls = card._renderEntry({ id: "entry-1", stock: 2, hidden: false, product: { name: "Milch", labels: [] } });
if (entryWithoutControls.includes("data-adjust=") || !entryWithoutControls.includes("Milch (2)")) throw new Error("Hidden stock controls also hid the stock value");
card._groups = () => [{ key: "drinks", category: { id: "drinks", name: "Getränke" }, units: [{ kind: "entry", entry: { id: "entry-1", stock: 2, minimum_stock: null, hidden: false, product: { name: "Milch", labels: [] } } }] }];
const groupMarkupWithoutCount = card._renderGroups();
if (groupMarkupWithoutCount.includes("(1)")) throw new Error("Disabled inventory category count is still rendered");
if (!structure.includes('this._config.show_mode_toggle !== false && modePanelExpanded') || !structure.includes('this._config.allow_suggestions === false')) throw new Error("Mode selection or product suggestion switches are not connected to rendering");
if (!styles.includes(".input-row{display:flex") || styles.includes(".input-row{display:grid;grid-template-columns:92px")) throw new Error("Conditional inventory input controls do not use the flexible layout");
card._config = { ...Card.getStubConfig(), list_id: "pantry", view_mode: "mobile", input_row_position: "bottom", option_row_position: "bottom", show_quantity_box: false, show_submit_button: false, show_camera_scan_button: false, show_mode_toggle: false, show_group_button: false, show_product_database_button: false, show_stock_filter_button: false, show_hidden_button: false, show_details_button: false, show_category_toggle_button: false, show_label_filter_button: false, show_category_filter_button: false };
card._render();
const minimalMarkup = card.shadowRoot.innerHTML;
if (minimalMarkup.includes("data-toggle-mode-panel") || minimalMarkup.includes('<div class="mode-panel">') || minimalMarkup.includes("data-open-products") || minimalMarkup.includes("data-toggle-group-selection")) throw new Error("Disabled inventory header actions are still rendered");
if (minimalMarkup.includes("data-quantity") || minimalMarkup.includes("data-action") || minimalMarkup.includes("data-camera-scan") || minimalMarkup.includes('class="toolbar"')) throw new Error("Disabled inventory input or toolbar controls are still rendered");
if (minimalMarkup.indexOf('class="input-row"') < minimalMarkup.indexOf('class="entries"')) throw new Error("Bottom inventory input row is still above the entries");
card._config = { ...Card.getStubConfig(), list_id: "pantry", view_mode: "mobile", input_row_position: "bottom", option_row_position: "bottom" };
card._render();
const bottomMarkup = card.shadowRoot.innerHTML;
if (bottomMarkup.indexOf('class="toolbar"') < bottomMarkup.indexOf('class="entries"') || bottomMarkup.indexOf('class="input-row"') < bottomMarkup.indexOf('class="entries"')) throw new Error("Bottom inventory controls are still above the entries");

const originalGroups = card._groups;
const originalRenderAfterToolbar = card._render;
card._groups = () => [{ key: "drinks", category: { id: "drinks", name: "Getränke" }, units: [{}] }];
card._render = () => {};
if (!card._allCategoriesExpanded()) throw new Error("Inventory categories should initially be expanded");
card._toggleAllCategories();
if (card._allCategoriesExpanded()) throw new Error("Inventory category toggle did not collapse all categories");
card._toggleAllCategories();
if (!card._allCategoriesExpanded()) throw new Error("Inventory category toggle did not expand all categories");
card._groups = originalGroups;
card._render = originalRenderAfterToolbar;

card._config.category_chip_layout = "none";
card._browserChips = [{ id: "browser-1", name: "Milch", product_id: null, scope: "browser", browser: true }];
if (!card._renderChips().includes("Milch")) throw new Error("Browser chip was not rendered");
card._importantBrowserChipIds.add("browser-1");
if (!card._renderChips().includes("--chip-border-color")) throw new Error("Important browser chip did not retain its browser border");

card._render = () => {};
card._rememberBrowserChip = () => {};
const bookingRequests = [];
card._entries = [{ id: "inventory-beer", stock: 2, product: card._products[0] }];
card._run = async (action) => action();
card._hass = nativeHass({ callWS: async (request) => {
  bookingRequests.push(request);
  return { entry: { id: request.entry_id, stock: 4, product: { id: "beer", name: "Bier" } } };
} });
let statusUpdates = 0;
const setInventoryActionStatus = card._setInventoryActionStatus.bind(card);
card._setInventoryActionStatus = (...args) => { statusUpdates += 1; setInventoryActionStatus(...args); };
card._inputValue = "Bier";
card._selectedProduct = card._products[0];
card._adjustFromInput({ id: "inventory-beer", stock: 2, product: card._products[0] }, 2).then(() => {
  if (bookingRequests.length !== 1 || bookingRequests[0].type !== "ha_list_manager/inventory/adjust" || bookingRequests[0].entry_id !== "inventory-beer" || bookingRequests[0].delta !== 2) throw new Error("Inventory input action did not send exactly one stock adjustment");
  if (card._entries[0].stock !== 4 || statusUpdates !== 1) throw new Error("Inventory booking did not update the stock and status exactly once");
  if (card._actionStatus !== "Bier: Bestand von 2 auf 4 erhöht.") throw new Error("Inventory input action has no stock transition status");
  if (card._inputValue !== "" || card._selectedProduct !== null) throw new Error("Inventory input action did not clear the input state");
  console.log("inventory chip smoke test passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
