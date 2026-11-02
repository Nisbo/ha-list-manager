const { nativeHass } = require("./native_translation_hass");
/* Browser-independent interaction smoke test for exact product selection. */
const fs = require("fs");
const vm = require("vm");

const registry = new Map();
global.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = {
      querySelector: () => null,
      querySelectorAll: () => [],
      append: () => {},
      innerHTML: "",
    };
    return this.shadowRoot;
  }
  dispatchEvent() {}
};
global.CustomEvent = class {};
global.customElements = {
  get: (name) => registry.get(name),
  define: (name, constructor) => registry.set(name, constructor),
};
global.document = {
  createElement: () => ({ addEventListener: () => {} }),
  body: { style: {} },
  documentElement: { lang: "de-DE", style: {} },
};
global.window = { customCards: [] };
global.ResizeObserver = class { observe() {} disconnect() {} };
const localValues = new Map();
global.localStorage = {
  getItem: (key) => localValues.has(key) ? localValues.get(key) : null,
  setItem: (key, value) => localValues.set(key, String(value)),
  removeItem: (key) => localValues.delete(key),
};

const source = fs.readFileSync(process.argv[2], "utf8");
const structure = require("./localization_source")(source);
if (structure.includes('<label><span>Kategorie</span>${this._renderCategorySelector()}</label>')) {
  throw new Error("Shopping category help is still wrapped by a label and reopens the picker when clicked");
}
if ((structure.match(/<div class="dialog-field"><span>Kategorie/g) || []).length !== 3) {
  throw new Error("Shopping category pickers do not use neutral dialog field wrappers");
}
vm.runInThisContext(source, { filename: process.argv[2] });
const Card = registry.get("ha-list-manager-shopping-card");

const card = new Card(); card._hass = nativeHass();
card._config = { ...Card.getStubConfig(), list_id: "weekly", show_brand: true, show_quantity: true };
card._suggestions = [{ id: "suggested", name: "Vorschlag", image_url: null }];
card._suggestionsVisible = false;
if (!card._renderInputRow().includes("data-suggestions hidden")) throw new Error("Shopping suggestions remain open after the input loses focus");
card._suggestionsVisible = true;
if (card._renderInputRow().includes("data-suggestions hidden")) throw new Error("Shopping suggestions do not reopen when the input regains focus");
card._suggestions = [];
const shoppingSource = fs.readFileSync(process.argv[2], "utf8");
if (!shoppingSource.includes('productInput?.addEventListener("blur"') || !shoppingSource.includes("this._suggestionsVisible = false")) throw new Error("Shopping suggestions have no outside-click blur handling");
const editorSchema = Card.getConfigForm(nativeHass()).schema.flatMap((entry) => entry.schema || [entry]);
if (!editorSchema.some((entry) => entry.name === "option_row_position") || !editorSchema.some((entry) => entry.name === "show_category_toggle_button") || card._config.option_row_position !== "bottom" || card._config.show_category_toggle_button !== true) {
  throw new Error("Shopping card button bar position option is missing or has the wrong default");
}
card._list = { id: "weekly", use_global_categories: true, use_type_categories: true };
card._items = [];
card._categories = [
  { id: "global-drinks", name: "Getränke", scope: "global", color: "#00aaff" },
  { id: "type-bakery", name: "Backwaren", scope: "list_type", list_type: "shopping", color: "#cc9900" },
  { id: "weekly-drinks", name: "Getränke", scope: "list", list_id: "weekly", color: "#0000ff" },
];
if (card._categoryScope(card._categories[0]) !== "Global" || card._categoryScope(card._categories[1]) !== "Einkaufslisten" || card._categoryScope(card._categories[2]) !== "Diese Liste") {
  throw new Error("Shopping category scopes are not distinguished in the picker");
}
const beer = {
  id: "beer",
  name: "Bier",
  brand: "Marke 1",
  category_assignments: [{
    category_id: "global-drinks",
    scope: "global",
    category: { id: "global-drinks", name: "Getränke", scope: "global" },
  }],
};

card._labels = [];
card._dialog = {
  mode: "edit",
  item: { id: "beer-item", product_id: "beer" },
  product: { ...beer, ean: "4105250022003", package_quantity: "500 ml" },
  name: "Bier",
  description: "750 g",
  quantity: 2,
  completed: false,
  category_id: "weekly-drinks",
  category_name: "Getränke",
  label_ids: [],
  status: "",
  statusTone: "error",
};
const productDialog = card._renderDialog();
if (!productDialog.includes('<div class="dialog-field"><span>Kategorie</span>')) {
  throw new Error("Shopping product dialog did not render the neutral category field wrapper");
}
if (!productDialog.includes("Fest aus der Produktdatenbank übernommen") || !productDialog.includes('class="fixed-product-amount"') || productDialog.includes("<input value=\"500 ml\"") || productDialog.includes("data-d-description")) {
  throw new Error("Linked product still exposes an editable amount override");
}
if (!productDialog.includes("data-product-amount-warning")) {
  throw new Error("Product amount warning has no render target");
}
if (!productDialog.includes("Packungsmenge: 500 ml · Anzahl: 2 · Gesamtmenge: 1 l")) {
  throw new Error("Linked product total does not use the neutral quantity wording");
}
if (!productDialog.includes("data-open-product-transfer") || !productDialog.includes("Produkt bearbeiten")) {
  throw new Error("Linked shopping items do not expose product editing");
}
card._dialog = {
  ...card._dialog,
  item: { id: "free-item" },
  product: null,
  name: "Schafskäse",
  description: "250 g",
  quantity: 2,
};
if (!card._renderDialog().includes("Menge: 250 g · Anzahl: 2 · Gesamtmenge: 500 g")) {
  throw new Error("Free article does not show its calculated total amount");
}
if (!card._renderDialog().includes("In Produkt-DB übernehmen")) {
  throw new Error("Free shopping items cannot be transferred to the product database");
}
const transferDraft = card._productTransferDraft(card._dialog);
if (transferDraft.package_quantity !== "250 g" || transferDraft.category_id !== "weekly-drinks") {
  throw new Error("Product transfer did not prefill the safe package quantity and selected category");
}
card._labels = [{ id: "fresh", name: "Frisch", scope: "global" }];
card._dialog = transferDraft;
const transferMarkup = card._renderDialog();
if (!transferMarkup.includes('data-product-category="1"') || !transferMarkup.includes("data-label-input") || transferMarkup.includes("autofocus")) {
  throw new Error("Product transfer does not preserve the mobile-safe category/label picker behavior");
}
if (!transferMarkup.includes("Global → Einkaufslisten → Diese Liste") || !transferMarkup.includes("Je weiter rechts, desto höher die Priorität")) {
  throw new Error("Product transfer does not explain the category scope priority");
}
if (!transferMarkup.includes("Gleichnamige Labels werden zusammengefasst")) {
  throw new Error("Product transfer does not explain the label scope priority");
}
if (!card._styles().includes(".product-category-input-status{color:var(--error-color)!important}")) {
  throw new Error("Dynamic product category warning is not highlighted as an error");
}
card._categories.push({ id: "dynamic-party", name: "Party", scope: "list", dynamic: true });
if (!card._productCategoryInputStatus("Party", "dynamic-party").includes("Dynamische Kategorie")) {
  throw new Error("A selected dynamic category does not keep its product warning");
}
card._categories = card._categories.filter((category) => category.id !== "dynamic-party");
card._dialog = card._productTransferDraft({ ...transferDraft.parent, description: "Bio, mild" });
if (card._dialog.package_quantity !== "") {
  throw new Error("A free-form item description was incorrectly treated as a package quantity");
}
card._dialog = null;

if (card._matchingProductCategory(beer)?.id !== "weekly-drinks") {
  throw new Error("Same-name list category did not override the global product assignment");
}

card._items = [{ id: "done", name: "Bier", completed: true, category_id: "weekly-drinks", quantity: 1 }];
let optionMarkup = card._optionRowHtml();
if (!optionMarkup.includes("data-toggle-categories") || !optionMarkup.includes("Alle Kategorien einklappen") || !optionMarkup.includes("Erledigte löschen (1)")) {
  throw new Error("Shopping button bar is incomplete");
}
card._config.show_category_toggle_button = false;
if (card._optionRowHtml().includes("data-toggle-categories")) throw new Error("Disabled Shopping category toggle remained visible");
card._config.show_category_toggle_button = true;
const shoppingRender = card._render;
card._render = () => {};
card._toggleAllCategories();
if (card._allCategoriesExpanded()) throw new Error("Shopping button bar did not collapse every item category");
card._toggleAllCategories();
if (!card._allCategoriesExpanded()) throw new Error("Shopping button bar did not expand every item category");
card._render = shoppingRender;
if (!card._styles().includes(".option-row button{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;min-height:38px;padding:0;gap:0;border-radius:9px}") || !card._styles().includes(".option-row button>span{display:none}")) throw new Error("Shopping compact button bar does not center its icons and hide its labels");

card._items = [
  { id: "item-brand-1", product_id: "beer", name: "Bier", quantity: 1 },
  { id: "free-beer", product_id: null, name: "Bier", quantity: 1 },
];
const secondBeer = { ...beer, id: "beer-2", brand: "Marke 2", category_assignments: [] };
if (card._existingItem(beer)?.id !== "item-brand-1") {
  throw new Error("Product identity did not match its own linked list item");
}
if (card._existingItem(secondBeer) !== null) {
  throw new Error("Equal product names with different IDs were incorrectly merged");
}
if (card._existingItem(null, "Bier")?.id !== "free-beer") {
  throw new Error("Free text did not stay limited to unlinked list items");
}
card._items = [];

let handled = null;
card._render = () => {};
card._requestedQuantity = () => 1;
card._handleProduct = async (product) => { handled = product; };
card._hass = nativeHass({
  states: {},
  callWS: async (message) => {
    if (!message.type.endsWith("/products/list")) throw new Error("Unexpected command");
    return { products: [beer] };
  },
});
card._inputValue = "Bier";
card._suggestions = [];

(async () => {
  const transferCard = new Card(); transferCard._hass = nativeHass();
  transferCard._config = { ...Card.getStubConfig(), list_id: "weekly" };
  transferCard._list = { id: "weekly", use_global_categories: true, use_type_categories: true };
  transferCard._categories = card._categories;
  transferCard._labels = [];
  transferCard._items = [];
  transferCard._products = [];
  transferCard._render = () => {};
  transferCard._lockScroll();
  const transferParent = {
    mode: "edit", item: { id: "banana-item", name: "Bananen", completed: false }, product: null,
    name: "Bananen", description: "", quantity: 1, completed: false,
    category_id: "weekly-drinks", category_name: "Getränke", label_ids: [], status: "", statusTone: "error",
  };
  transferCard._dialog = transferParent;
  transferCard._hass = nativeHass({ callWS: async () => ({ products: [{ id: "banana-product", name: "Bananen", labels: [] }] }) });
  await transferCard._openProductTransferDialog();
  if (transferCard._dialog.mode !== "product-duplicates" || !transferCard._renderDialog().includes('data-link-existing-product="banana-product"')) {
    throw new Error("Exact product duplicates are not offered before creating a product");
  }

  const transferCalls = [];
  transferCard._dialog = transferCard._productTransferDraft(transferParent);
  transferCard._hass = nativeHass({ callWS: async (message) => {
    transferCalls.push(message);
    if (message.type.endsWith("/products/create")) return { product: { id: "created-banana", name: message.name, labels: [] } };
    return {};
  } });
  transferCard._load = async () => {};
  await transferCard._saveProductTransfer();
  const createCall = transferCalls.find((message) => message.type.endsWith("/products/create"));
  const linkCall = transferCalls.find((message) => message.type.endsWith("/items/update"));
  if (!createCall || createCall.category_ids?.[0] !== "weekly-drinks" || !linkCall || linkCall.product_id !== "created-banana") {
    throw new Error("A transferred shopping item was not created with its category and linked back to the item");
  }

  transferCalls.length = 0;
  const generalParent = { ...transferParent, category_id: null, category_name: "" };
  transferCard._dialog = { ...transferCard._productTransferDraft(generalParent), category_id: "weekly-drinks", category_name: "Getränke" };
  const optionalMoveMarkup = transferCard._renderDialog();
  if (!optionalMoveMarkup.includes("Kategorie des Listenartikels ändern?") || optionalMoveMarkup.includes('data-move-product-category checked')) {
    throw new Error("A changed product category does not offer an initially optional item move");
  }
  await transferCard._saveProductTransfer();
  const unchangedItemCall = transferCalls.find((message) => message.type.endsWith("/items/update"));
  if (unchangedItemCall?.category_id !== null || unchangedItemCall.category !== null) {
    throw new Error("An unconfirmed product category move changed the current shopping item");
  }

  transferCalls.length = 0;
  transferCard._dialog = { ...transferCard._productTransferDraft(generalParent), category_id: "weekly-drinks", category_name: "Getränke", move_item_category: true };
  const moveMarkup = transferCard._renderDialog();
  if (!moveMarkup.includes("Kategorie des Listenartikels ändern?") || !moveMarkup.includes('data-move-product-category checked')) {
    throw new Error("A changed product category does not offer moving the current shopping item");
  }
  await transferCard._saveProductTransfer();
  const movedItemCall = transferCalls.find((message) => message.type.endsWith("/items/update"));
  if (movedItemCall?.category_id !== "weekly-drinks" || movedItemCall.category !== null) {
    throw new Error("Confirmed product category move did not update the current shopping item");
  }

  transferCalls.length = 0;
  transferCard._dialog = transferCard._productTransferDraft({ ...transferParent, category_id: null, category_name: "Party" });
  await transferCard._saveProductTransfer();
  if (transferCalls.length || !transferCard._dialog.status.includes("keine gespeicherte Kategorie")) {
    throw new Error("An unknown product category was silently ignored instead of requesting a saved category");
  }

  transferCard._dialog.ean = "12";
  await transferCard._lookupProductTransferEan();
  const eanMarkup = transferCard._renderDialog();
  const eanRow = eanMarkup.indexOf('class="ean-lookup-row"');
  const eanMessage = eanMarkup.indexOf("Bitte eine gültige EAN");
  const brandFields = eanMarkup.indexOf('class="bring-detail-fields"');
  if (!(eanRow >= 0 && eanMessage > eanRow && eanMessage < brandFields)) {
    throw new Error("EAN status is not rendered directly below the EAN field");
  }

  await card._useInput();
  if (handled?.id !== "beer") throw new Error("Add did not resolve the exact product from the backend");

  handled = null;
  card._hass.callWS = async () => ({ products: [beer, { ...beer, id: "beer-2", brand: "Marke 2" }] });
  card._inputValue = "Bier";
  card._suggestions = [];
  await card._useInput();
  if (handled !== null || card._productPicker?.products.length !== 2 || card._productPicker.rawName !== "Bier") {
    throw new Error("Ambiguous product names were not opened in the product picker");
  }
  const pickerMarkup = card._renderProductPicker();
  if (!pickerMarkup.includes("Marke 1") || !pickerMarkup.includes("Marke 2")) {
    throw new Error("Product picker does not distinguish equal names by brand");
  }
  card._clearInput();
  if (card._inputValue !== "" || card._suggestions.length !== 0) {
    throw new Error("Clear input did not reset the shopping search");
  }

  handled = null;
  card._products = [beer];
  await card._useChip({ id: "chip-linked", name: "Feierabendbier", product_id: beer.id, product_name: beer.name });
  if (handled?.id !== beer.id) throw new Error("Linked chip did not select its exact product ID");

  handled = null;
  card._productPicker = null;
  card._hass.callWS = async () => ({ products: [beer, { ...beer, id: "beer-2", brand: "Marke 2" }] });
  await card._useChip({ id: "chip-name", name: "Bier", product_id: null });
  if (handled !== null || card._productPicker?.products.length !== 2) {
    throw new Error("Unlinked chip did not reuse the ambiguous-name product picker");
  }
  if (card._inputValue !== "") throw new Error("Chip use left its temporary search name in the shopping input");

  card._chips = [
    { id: "global", name: "Bier", color: null, scope: "global", product_id: null },
    { id: "type", name: "Brötchen", color: "#123456", scope: "list_type", product_id: null },
    { id: "list", name: "Butter", color: null, scope: "list", product_id: null },
  ];
  card._inputValue = "bi";
  const filteredChips = card._renderChips();
  if (!filteredChips.includes(">Bier<") || filteredChips.includes(">Brötchen<") || filteredChips.includes(">Butter<")) {
    throw new Error("Chip names were not filtered with the shopping input");
  }
  card._config.filter_chips = false;
  if (!card._renderChips().includes(">Brötchen<")) throw new Error("Disabled chip filtering still hid chips");
  card._config.chips_limit = 2;
  card._inputValue = "";
  if (!card._renderChips().includes("1 weitere anzeigen")) throw new Error("Chip limit did not offer expansion");
  card._config.chips_limit = 0;
  card._chipsExpanded = false;
  const collapsedChips = card._renderChips();
  if (!collapsedChips.includes("3 Chips anzeigen") || collapsedChips.includes("data-quick-chip")) {
    throw new Error("Zero visible chips did not start fully collapsed");
  }
  card._chipDialog = true;
  const chipDialog = card._renderChipDialog();
  if ((chipDialog.match(/data-dialog-chip=/g) || []).length !== 3) {
    throw new Error("Chip dialog did not show every effective chip");
  }
  if (!card._renderInputRow().includes("data-open-chip-dialog")) throw new Error("Chip popup button is missing from the input field");
  card._config.show_chip_popup_button = false;
  if (card._renderInputRow().includes("data-open-chip-dialog")) throw new Error("Disabled chip popup button remained visible");
  card._config.show_chip_popup_button = true;
  card._config.chips_limit = 3;
  card._config.chip_color_mode = "scope_override";
  if (!card._renderChips().includes("rgb(96, 125, 139)")) throw new Error("Global scope color was not applied");
  card._config.chip_color_mode = "none";
  if (card._renderChips().includes("colored")) throw new Error("Color-free mode still styled chips with a color");

  card._config.category_chip_layout = "stacked";
  card._config.category_chip_colors = true;
  card._config.chip_color_mode = "scope_override";
  card._config.filter_chips = true;
  card._inputValue = "";
  const sauce = {
    id: "sauce-product",
    name: "Barbecue Sauce",
    brand: "Heinz",
    package_quantity: "1 pcs",
    category_assignments: [{
      category_id: "weekly-sauces",
      scope: "list",
      list_id: "weekly",
      category: { id: "weekly-sauces", name: "Saucen", scope: "list", list_id: "weekly" },
    }],
  };
  card._categories.push({ id: "weekly-sauces", name: "Saucen", scope: "list", list_id: "weekly", icon: "mdi:bottle-tonic", color: "#aa5500" });
  card._products = [sauce];
  card._chipCategories = new Map([
    ["global", { id: "global-drinks", name: "Getränke", icon: "mdi:bottle-soda", color: "#0088ff", scope: "global" }],
    ["type", { id: "type-bakery", name: "Backwaren", icon: "mdi:bread-slice", color: "#aa7700", scope: "list_type" }],
  ]);
  let groupedChips = card._renderChips();
  if (!groupedChips.includes("data-chip-category=\"global-drinks\"") || !groupedChips.includes(">Getränke<") || !groupedChips.includes(">Allgemein<") || !groupedChips.includes(">Saucen<")) {
    throw new Error("Category chips did not group resolved and uncategorized chips");
  }
  if (groupedChips.includes("data-quick-chip")) throw new Error("Collapsed category chips exposed their child chips");
  if (!groupedChips.includes("data-toggle-chip-categories") || !groupedChips.includes('aria-label="Alle Kategorien aufklappen"')) {
    throw new Error("Categorized shopping chips have no all-category counter toggle");
  }
  card._toggleAllChipCategories();
  groupedChips = card._renderChips();
  if (!groupedChips.includes('aria-label="Alle Kategorien einklappen"') || !groupedChips.includes('data-quick-chip="global"') || !groupedChips.includes('data-quick-chip="type"')) {
    throw new Error("Shopping chip counter did not open every category");
  }
  card._toggleAllChipCategories();
  if (card._renderChips().includes("data-quick-chip")) throw new Error("Shopping chip counter did not close every category");
  card._toggleChipCategory("global-drinks");
  groupedChips = card._renderChips();
  if (!groupedChips.includes("data-quick-chip=\"global\"") || !groupedChips.includes("mdi:chevron-up")) {
    throw new Error("Opening a category chip did not reveal its chips");
  }
  card._toggleChipCategory("weekly-sauces");
  groupedChips = card._renderChips();
  if (!groupedChips.includes("data-quick-chip=\"category-product:sauce-product\"") || !groupedChips.includes("Barbecue Sauce – Heinz – 1 pcs")) {
    throw new Error("A category product assignment was not offered as an exact product shortcut");
  }
  if (!groupedChips.includes("--chip-color:#aa5500")) {
    throw new Error("Grouped product shortcuts did not use their category color by default");
  }
  card._config.category_chip_colors = false;
  groupedChips = card._renderChips();
  if (!groupedChips.includes("--chip-color:rgb(67, 160, 71)")) {
    throw new Error("Disabling category colors did not restore the configured scope color");
  }
  card._config.category_chip_colors = true;
  card._importantChipKeys = new Set(["chip:global"]);
  groupedChips = card._renderChips();
  if (!groupedChips.includes(">Wichtig<") || groupedChips.indexOf(">Wichtig<") > groupedChips.indexOf(">Getränke<")) {
    throw new Error("Important chips were not duplicated into the first category");
  }
  if ((groupedChips.match(/data-quick-chip="global"/g) || []).length !== 2) {
    throw new Error("An important chip disappeared from its normal category");
  }
  card._inputValue = "bi";
  groupedChips = card._renderChips();
  if (!groupedChips.includes("data-quick-chip=\"global\"") || groupedChips.includes("type-bakery") || groupedChips.includes(">Allgemein<")) {
    throw new Error("Filtering did not open and limit category-chip groups");
  }
  card._inputValue = "";
  card._chipDialog = true;
  if (!card._renderChipDialog().includes("dialog-chip-categories")) throw new Error("Chip dialog did not reuse category grouping");
  card._config.category_chip_layout = "wrap";
  card._wrappedChipCategoryOpen = {};
  let wrappedCategories = card._renderChips();
  if (!wrappedCategories.includes("layout-wrap") || !wrappedCategories.includes("chip-category-flow")) {
    throw new Error("Wrapped category chips did not render their shared wrapping flow");
  }
  card._toggleChipCategory("global-drinks");
  wrappedCategories = card._renderChips();
  if (!wrappedCategories.includes('data-chip-category="global-drinks"') || !wrappedCategories.includes('data-quick-chip="global"')) {
    throw new Error("Wrapped category selection did not reveal the selected category");
  }
  const selectedCategoryPosition = wrappedCategories.indexOf('data-chip-category="global-drinks"');
  const expandedPanelPosition = wrappedCategories.indexOf('class="chip-category-expanded"', selectedCategoryPosition);
  const laterCategoryPosition = wrappedCategories.indexOf('data-chip-category="weekly-sauces"', selectedCategoryPosition);
  if (expandedPanelPosition < selectedCategoryPosition || laterCategoryPosition < expandedPanelPosition) {
    throw new Error("Wrapped category content was not inserted before the following categories");
  }
  card._toggleAllChipCategories();
  wrappedCategories = card._renderChips();
  if ((wrappedCategories.match(/class="chip-category-expanded"/g) || []).length !== card._chipCategoryGroups(card._filteredChips()).length) {
    throw new Error("Shopping chip counter did not open every wrapped category");
  }
  card._toggleAllChipCategories();
  if (card._renderChips().includes('class="chip-category-expanded"')) throw new Error("Shopping chip counter did not close every wrapped category");
  card._config.category_chip_layout = "compact";
  const compactCategories = card._renderChips();
  const compactSelectors = [...compactCategories.matchAll(/<button[^>]*class="chip-category-selector[^"]*"[\s\S]*?<\/button>/g)].map((match) => match[0]);
  if (!compactCategories.includes("layout-compact") || !compactSelectors.length || compactSelectors.some((selector) => selector.includes("chip-category-chevron") || selector.includes("<span>"))) {
    throw new Error("Compact category chips still showed counters or chevrons");
  }
  card._config.category_chip_layout = "none";
  card._products = [beer];
  let flatImportant = card._renderChips();
  if (flatImportant.indexOf('data-quick-chip="global"') > flatImportant.indexOf('data-quick-chip="type"') || !flatImportant.includes("--chip-color:rgb(244, 67, 54)")) {
    throw new Error("Important chips were not sorted first and colored in the flat view");
  }
  card._importantChipKeys.clear();

  card._config.chip_color_mode = "scope_fallback";
  card._browserChips = [];
  card._chips = [{ id: "saved-beer", name: "Bier", product_id: beer.id, scope: "list" }];
  card._rememberBrowserChip("Bier", beer);
  if (card._browserChips.length) throw new Error("A browser chip was created despite an existing permanent product chip");
  const browserProduct = { id: "browser-product", name: "Browser Banane" };
  card._rememberBrowserChip("Browser Banane", browserProduct);
  if (card._browserChips.length) throw new Error("A database product created a browser chip while the opt-in setting was disabled");
  card._config.browser_chips_for_products = true;
  card._rememberBrowserChip("Browser Banane", browserProduct);
  if (card._browserChips.length !== 1 || card._browserChips[0].product_id !== browserProduct.id) {
    throw new Error("Browser chip did not retain its exact product link");
  }
  if (!card._effectiveChips().some((chip) => chip.browser && chip.name === "Browser Banane")) {
    throw new Error("Browser chip was not merged into the effective chips");
  }
  card._importantBrowserChipIds.add(card._browserChips[0].id);
  const importantBrowserMarkup = card._renderChips();
  if (!importantBrowserMarkup.includes("--chip-color:rgb(244, 67, 54)") || !importantBrowserMarkup.includes("--chip-border-color:rgb(121, 85, 72)")) {
    throw new Error("Important browser chip did not retain its browser-colored border");
  }
  card._browserChipMenu = { chip: card._browserChips[0], confirmAll: false, status: "" };
  if (!card._renderBrowserChipMenu().includes("Wichtig-Markierung entfernen")) {
    throw new Error("The chip long-press menu did not offer importance removal");
  }
  card._browserChipMenu = null;
  if (card._chipDisplayColor(card._browserChips[0]) !== "rgb(121, 85, 72)") {
    throw new Error("Configured browser chip color fallback was not applied");
  }
  card._config.browser_chips_for_products = false;
  card._rememberBrowserChip("Freier Eintrag", { id: "list-item-id", product_id: null, name: "Freier Eintrag" });
  const freeBrowserChip = card._browserChips.find((chip) => chip.name === "Freier Eintrag");
  if (!freeBrowserChip || freeBrowserChip.product_id !== null) {
    throw new Error("A free list item was incorrectly stored as a linked product browser chip");
  }
  card._removeBrowserChip(freeBrowserChip);
  card._config.browser_chips_for_products = true;
  card._chips = [];
  card._rememberBrowserChip("2222");
  card._rememberBrowserChip("1111");
  const orderedBrowserNames = card._effectiveChips().map((chip) => chip.name);
  if (orderedBrowserNames.join(",") !== "1111,2222,Browser Banane") {
    throw new Error(`Browser chips were not sorted predictably: ${orderedBrowserNames.join(",")}`);
  }
  card._rememberBrowserChip("2222");
  if (card._effectiveChips().map((chip) => chip.name).join(",") !== orderedBrowserNames.join(",")) {
    throw new Error("Reusing a browser chip changed its position");
  }
  card._browserChips = card._browserChips.filter((chip) => chip.product_id === browserProduct.id);
  card._saveBrowserChips();
  card._browserChipMenu = { chip: card._browserChips[0], confirmAll: false, status: "" };
  if (!card._renderBrowserChipMenu().includes("Dauerhaft in diese Liste speichern")) {
    throw new Error("Browser chip menu is missing permanent save");
  }
  card._browserChipMenu.confirmAll = true;
  if (!card._renderBrowserChipMenu().includes("Alle Browserchips löschen?") || !card._renderBrowserChipMenu().includes("data-confirm-delete-browser-chips")) {
    throw new Error("Delete-all browser chips is missing its confirmation dialog");
  }
  card._browserChipMenu.confirmAll = false;
  card._config.allow_save_browser_chips = false;
  if (card._renderBrowserChipMenu().includes("Dauerhaft in diese Liste speichern")) {
    throw new Error("Disabled permanent browser chip save remained available");
  }
  card._config.allow_save_browser_chips = true;
  let savedChipPayload = null;
  card._hass.callWS = async (payload) => { savedChipPayload = payload; return { chip: {} }; };
  card._load = async () => {};
  await card._saveBrowserChipPermanently();
  if (savedChipPayload?.type !== "ha_list_manager/chips/create" || savedChipPayload.scope !== "list" || savedChipPayload.product_id !== browserProduct.id) {
    throw new Error("Browser chip was not saved permanently for this list with its product link");
  }
  if (card._browserChips.length) throw new Error("Saved browser chip remained in browser storage");

  const legacyChip = { id: "legacy", name: "Alter freier Chip", product_id: "list-item-id", product_name: null, scope: "browser", browser: true };
  card._browserChips = [legacyChip];
  card._browserChipMenu = { chip: legacyChip, confirmAll: false, status: "" };
  const legacyPayloads = [];
  card._hass.callWS = async (payload) => {
    legacyPayloads.push(payload);
    if (payload.product_id) throw Object.assign(new Error("Product not found"), { code: "not_found" });
    return { chip: {} };
  };
  await card._saveBrowserChipPermanently();
  if (legacyPayloads.length !== 2 || legacyPayloads[0].product_id !== "list-item-id" || legacyPayloads[1].product_id !== null) {
    throw new Error("Legacy free browser chip did not retry permanent save without its invalid product ID");
  }

  const dishCard = new Card(); dishCard._hass = nativeHass();
  dishCard._config = { ...Card.getStubConfig(), list_id: "weekly", category_chip_layout: "stacked" };
  dishCard._list = { id: "weekly", use_global_categories: true, use_type_categories: true };
  dishCard._chips = [{
    id: "beer-chip", name: "Bier", scope: "global", product_id: null,
    category: { id: "drinks", name: "Getränke", icon: "mdi:bottle-soda", color: "#1565c0" },
  }];
  dishCard._dishes = [{ id: "pasta", name: "Pasta", color: "#795548", items: [{ id: "noodles", name: "Nudeln", quantity: 1 }] }];
  let dishMarkup = dishCard._renderChips();
  if (!dishMarkup.includes('data-chip-category="__dishes__"') || dishMarkup.indexOf("Getränke") > dishMarkup.indexOf("Gerichte")) {
    throw new Error("The collapsed dishes group was not rendered after chip categories");
  }
  if (dishMarkup.includes('data-dish="pasta"')) {
    throw new Error("The stacked dishes group was not collapsed initially");
  }
  localStorage.setItem(dishCard._chipCategoryCollapseKey("__dishes__"), "0");
  dishMarkup = dishCard._renderChips();
  if (!dishMarkup.includes('data-dish="pasta"')) {
    throw new Error("The stacked dishes group did not reveal its dishes");
  }
  for (const layout of ["wrap", "compact"]) {
    dishCard._config.category_chip_layout = layout;
    dishCard._wrappedChipCategoryOpen.card = "__dishes__";
    dishMarkup = dishCard._renderChips();
    if (!dishMarkup.includes('data-dish="pasta"') || dishMarkup.indexOf("Getränke") > dishMarkup.indexOf("Gerichte")) {
      throw new Error(`The ${layout} dishes group did not open after chip categories`);
    }
  }
  const restoredDishCard = (layout) => {
    const restored = new Card(); restored._hass = nativeHass();
    restored._config = { ...Card.getStubConfig(), list_id: "persist-list", category_chip_layout: layout };
    restored._list = { id: "persist-list", use_global_categories: true, use_type_categories: true };
    restored._chips = dishCard._chips;
    restored._dishes = dishCard._dishes;
    return restored;
  };
  const wrappedPersistenceCard = restoredDishCard("compact");
  wrappedPersistenceCard._render = () => {};
  localStorage.removeItem(wrappedPersistenceCard._wrappedChipCategoryKey("card"));
  wrappedPersistenceCard._toggleChipCategory("__dishes__");
  if (!restoredDishCard("compact")._renderChips().includes('data-dish="pasta"')) {
    throw new Error("The opened compact chip group was not restored after refresh");
  }
  wrappedPersistenceCard._toggleChipCategory("__dishes__");
  if (restoredDishCard("compact")._renderChips().includes('data-dish="pasta"')) {
    throw new Error("The closed compact chip group was not restored after refresh");
  }
  const stackedPersistenceCard = restoredDishCard("stacked");
  stackedPersistenceCard._render = () => {};
  localStorage.removeItem(stackedPersistenceCard._chipCategoryCollapseKey("__dishes__"));
  stackedPersistenceCard._toggleChipCategory("__dishes__");
  if (!restoredDishCard("stacked")._renderChips().includes('data-dish="pasta"')) {
    throw new Error("The opened stacked chip group was not restored after refresh");
  }
  dishCard._config.category_chip_layout = "none";
  dishMarkup = dishCard._renderChips();
  if (dishMarkup.indexOf("Schnelleingaben") > dishMarkup.indexOf("Gerichte")) {
    throw new Error("Ungrouped dishes were not rendered below regular chips");
  }
  dishCard._config.category_chip_layout = "stacked";
  dishCard._chipDialog = true;
  const dishDialogMarkup = dishCard._renderChipDialog();
  if (!dishDialogMarkup.includes('data-chip-category="__dishes__"') || dishDialogMarkup.indexOf("Getränke") > dishDialogMarkup.indexOf("Gerichte")) {
    throw new Error("The popup did not render dishes as the final expandable category");
  }
  const editorForm = Card.getConfigForm(nativeHass());
  const dishesSection = editorForm.schema.find((section) => section.label === "Gerichte");
  const confirmSchema = dishesSection.schema.find((entry) => entry.name === "dishes_confirm_add");
  if (!editorForm.computeHelper(confirmSchema).includes("Backend-Listeneinstellungen")) {
    throw new Error("The card editor is missing the list-settings activation hint");
  }
  console.log("shopping card exact-product/category smoke test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
