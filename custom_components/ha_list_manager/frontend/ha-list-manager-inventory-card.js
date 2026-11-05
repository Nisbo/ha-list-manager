// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerInventoryCardTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerInventoryCardTextLanguage(hass = null) {
  return haListManagerInventoryCardTextLocale(hass).toLowerCase().split("-")[0] === "de" ? "de" : "en";
}
function haListManagerInventoryCardText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerInventoryCardTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerInventoryCardTextLocale(hass));
  let request = languages.get(language);
  if (!request) {
    // Let HA finish clearing its category cache when a user switches language.
    request = Promise.resolve().then(() => hass.loadBackendTranslation("config_panel", "ha_list_manager")).catch(() => {
      // A failed scoped load remains marked as loaded in HA's native cache.
      // Loading the category restores it and enables HA's reconnect refresh.
      return hass.loadBackendTranslation("config_panel");
    });
    languages.set(language, request);
    const clear = () => { if (languages.get(language) === request) languages.delete(language); };
    request.then(clear, clear);
  }
  return request;
}
function haListManagerInventoryCardTextUpdateTranslations(element, hass) {
  if (!hass) return false;
  const previous = element._nativeTranslationState;
  const language = String(hass.language || haListManagerInventoryCardTextLocale(hass));
  const connection = hass.connection || hass;
  const changed = !previous || previous.language !== language || previous.connection !== connection;
  const wasReady = previous?.ready;
  let state = previous;
  if (changed) {
    state = { language, connection, previousLocalize: previous?.localize, switched: Boolean(previous && previous.language !== language), localize: hass.localize, renderedLocalize: hass.localize, ready: false };
    // Preloaded resources are immediately usable, including in an editor.
    state.ready = Boolean(haListManagerInventoryCardText("ui.cancel", {}, hass)) && (!state.switched || hass.localize !== state.previousLocalize);
    element._nativeTranslationState = state;
    haListManagerInventoryCardTextLoadTranslations(hass).then((localize) => {
      if (element._nativeTranslationState !== state) return;
      state.needsRefresh = Boolean(localize && localize !== state.renderedLocalize);
      const current = element._hass;
      if (!current || String(current.language || haListManagerInventoryCardTextLocale(current)) !== language || (current.connection || current) !== connection) return;
      if (haListManagerInventoryCardText("ui.cancel", {}, current) && (!state.switched || current.localize !== state.previousLocalize) && (!state.ready || (state.needsRefresh && current.localize !== state.renderedLocalize))) {
        state.ready = true;
        state.needsRefresh = false;
        state.renderedLocalize = current.localize;
        haListManagerInventoryCardTextUpdateMetadata(current);
        element._render();
      }
    }).catch((error) => {
      if (element._nativeTranslationState === state) console.warn(error);
    });
  } else if (!state.ready && haListManagerInventoryCardText("ui.cancel", {}, hass) && (!state.switched || hass.localize !== state.previousLocalize)) {
    state.ready = true;
  }
  const refresh = state.ready && state.needsRefresh && hass.localize !== state.renderedLocalize;
  if (state.ready && (changed || !wasReady || refresh)) { state.renderedLocalize = hass.localize; state.needsRefresh = false; }
  state.localize = hass.localize;
  if (state.ready && (changed || !wasReady || refresh)) haListManagerInventoryCardTextUpdateMetadata(hass);
  return state.ready && (changed || !wasReady || refresh);
}
function haListManagerInventoryCardTextUpdateMetadata(hass) {
  const metadata = window.customCards?.find((card) => card.type === "ha-list-manager-inventory-card");
  if (metadata) {
    metadata.name = haListManagerInventoryCardText("ui.inventory_page_title", {}, hass) || metadata.name;
    metadata.description = haListManagerInventoryCardText("inventory.card_description", {}, hass);
  }
}
function haListManagerInventoryCardTextRequest(hass, message) {
  return hass.callWS(message.type?.startsWith("ha_list_manager/") ? { ...message, language: haListManagerInventoryCardTextLanguage(hass) } : message);
}

// Keep this Lovelace resource self-contained. Home Assistant may instantiate a
// dashboard card before a statically imported helper module has finished
// loading, which leaves the dashboard at "Custom element doesn't exist" until
// another reload. The administration panel can still share the separate core
// module when its frontend is split further.
const HA_LM_API = "ha_list_manager";
const HA_LM_INVENTORY_EVENT = "ha_list_manager_inventory_changed";
const HA_LM_SCANNER_TARGET_EVENT = "ha_list_manager_scanner_target_changed";
const HA_LM_SCAN_PROCESSED_EVENT = "ha_list_manager_scan_processed";

class HaListManagerClient {
  constructor(hass) { this.hass = hass; }
  listInventoryLists() { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/lists` }); }
  listInventory(listId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/list`, list_id: listId }); }
  listInventoryGroups(listId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/groups/list`, list_id: listId }); }
  createInventoryGroup(listId, group) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/groups/create`, list_id: listId, ...group }); }
  updateInventoryGroup(groupId, group) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/groups/update`, group_id: groupId, ...group }); }
  deleteInventoryGroup(groupId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/groups/delete`, group_id: groupId }); }
  inventoryOptions(listId, search = "") { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/options`, list_id: listId, search }); }
  lookupInventoryProduct(ean) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/lookup`, ean }); }
  lookupProduct(ean, productId = null) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/products/lookup`, ean, product_id: productId }); }
  addInventoryProduct(listId, value, quantity = 1, categoryId = null, category = null, details = {}) {
    return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/add`, list_id: listId, value, quantity, category_id: categoryId, category, ...details });
  }
  adjustInventory(entryId, delta) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/adjust`, entry_id: entryId, delta }); }
  previewRestock(listId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/restock/preview`, list_id: listId }); }
  applyRestock(listId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/restock/apply`, list_id: listId }); }
  resetRestockLatch(listId, sourceType, sourceId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/restock/latch/reset`, list_id: listId, source_type: sourceType, source_id: sourceId }); }
  confirmZeroRestock(entryId, quantity) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/restock/confirm_zero`, entry_id: entryId, quantity }); }
  updateInventory(entryId, stock, minimumStock, categoryId, category = null, hidden = false) {
    return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/update`, entry_id: entryId, stock, minimum_stock: minimumStock, category_id: categoryId, category, hidden });
  }
  setInventoryHidden(entryId, hidden) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/visibility`, entry_id: entryId, hidden }); }
  deleteInventory(entryId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/inventory/delete`, entry_id: entryId }); }
  updateProduct(product) {
    return haListManagerInventoryCardTextRequest(this.hass, {
      type: `${HA_LM_API}/products/update`,
      product_id: product.id,
      ean: product.ean || null,
      name: product.name,
      original_name: product.original_name || null,
      brand: product.brand || null,
      package_quantity: product.package_quantity || null,
      category: null,
      image_url: product.image_url || null,
      label_ids: (product.labels || []).map((label) => label.id),
    });
  }
  getScannerTarget() { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/scanner/target/get` }); }
  setScannerTarget(listId, action) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/scanner/target/set`, list_id: listId, action }); }
  clearScannerTarget() { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/scanner/target/clear` }); }
  listPendingScans(listId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/scanner/queue/list_for_list`, list_id: listId }); }
  holdPendingScan(scanId) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/scanner/queue/hold`, scan_id: scanId }); }
  resolvePendingScan(scanId, details = {}) { return haListManagerInventoryCardTextRequest(this.hass, { type: `${HA_LM_API}/scanner/queue/resolve`, scan_id: scanId, ...details }); }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function inventoryState(entry) {
  if (entry.stock === 0) return "stock-empty";
  if (entry.minimum_stock !== null && entry.stock < entry.minimum_stock) return "stock-low";
  return "stock-normal";
}

const CARD_VERSION = "1.0.0b4";
const PICKER_RESULT_LIMIT = 100;
const MODES = (hass = null) => ({
  add: { label: haListManagerInventoryCardText("ui.stock_in", {}, hass), icon: "mdi:package-variant-plus", color: "var(--success-color,#2e7d32)", help: haListManagerInventoryCardText("inventory.stock_in_activated", {}, hass) },
  remove: { label: haListManagerInventoryCardText("inventory.withdraw", {}, hass), icon: "mdi:package-variant-minus", color: "var(--warning-color,#e0a526)", help: haListManagerInventoryCardText("inventory.withdraw_mode_active", {}, hass) },
  register: { label: haListManagerInventoryCardText("ui.register", {}, hass), icon: "mdi:package-variant", color: "var(--primary-color,#03a9f4)", help: haListManagerInventoryCardText("ui.capture_mode_enabled", {}, hass) },
  correct: { label: haListManagerInventoryCardText("inventory.correct", {}, hass), icon: "mdi:square-edit-outline", color: "#7e57c2", help: haListManagerInventoryCardText("inventory.correct_mode_active", {}, hass) },
});

class HaListManagerInventoryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._entries = [];
    this._products = [];
    this._categories = [];
    this._labels = [];
    this._chips = [];
    this._browserChips = [];
    this._importantChipKeys = new Set();
    this._importantBrowserChipIds = new Set();
    this._chipCategories = new Map();
    this._wrappedChipCategoryOpen = {};
    this._inventoryLists = [];
    this._restockPreview = [];
    this._restockDialog = null;
    this._scannerTarget = null;
    this._pendingScans = [];
    this._pendingScanPicker = false;
    this._inventoryGroups = [];
    this._groupSelectionMode = false;
    this._selectedEntryIds = new Set();
    this._mode = "add";
    this._filter = "all";
    this._selectedCategoryIds = null;
    this._selectedLabelIds = null;
    this._groupCategories = true;
    this._categoryMenuOpen = false;
    this._labelMenuOpen = false;
    this._showDetails = true;
    this._showHidden = false;
    this._inputValue = "";
    this._selectedProduct = null;
    this._chipsExpanded = false;
    this._chipDialog = false;
    this._browserChipMenu = null;
    this._chipLongPressTimer = null;
    this._suppressChipClickUntil = 0;
    this._dialog = null;
    this._confirmation = null;
    this._memberPicker = null;
    this._groupPicker = null;
    this._dialogStatus = "";
    this._dialogStatusTone = "info";
    this._dialogStatusTarget = "general";
    this._loadedListId = null;
    this._loading = false;
    this._loadRequestId = 0;
    this._loadingListId = null;
    this._busy = false;
    this._error = "";
    this._actionStatus = "";
    this._lastInventoryBooking = null;
    this._undoTimer = null;
    this._undoCountdownTimer = null;
    this._undoChoice = false;
    this._pdfExporting = false;
    this._headerMenuOpen = false;
    this._controlCodesOpen = false;
    this._unsubscribes = [];
    this._subscribing = false;
    this._scannerStarting = false;
    this._cameraScanner = null;
    this._cameraOverlay = null;
    this._modeTimer = null;
    this._modeDeadline = 0;
    this._modeRemaining = 0;
    this._expandedView = false;
    this._expandedViewWasCollapsed = false;
    this._expandedPageOverflow = null;
    this._expandedViewport = null;
    this._expandedResizeObserver = null;
    this._expandedResizeFrame = null;
    this._expandedScrollTop = 0;
    this._expandedScrollFrame = null;
    this._onExpandedViewResize = () => this._scheduleExpandedViewBounds();
    this._onExpandedViewKeydown = (event) => {
      if (event.key === "Escape" && this._expandedView) this._setExpandedView(false);
    };
  }

  static getConfigElement() {
    return document.createElement("ha-list-manager-inventory-card-editor");
  }

  static getConfigForm(hass = null) {
    const entities = Object.entries(hass?.states || {})
      .filter(([entityId, state]) => entityId.startsWith("sensor.") && state.attributes?.list_type === "inventory")
      .map(([entityId]) => entityId)
      .sort((left, right) => left.localeCompare(right));
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { include_entities: entities } } },
        { type: "expandable", label: haListManagerInventoryCardText("ui.general", {}, hass), icon: "mdi:cog-outline", schema: [
          { name: "title", selector: { text: {} } },
          { name: "title_icon", selector: { icon: {} }, default: "mdi:package-variant-closed" },
          { name: "title_icon_color_rgb", selector: { color_rgb: {} } },
          { name: "view_mode", selector: { select: { mode: "dropdown", options: [{ value: "auto", label: haListManagerInventoryCardText("ui.automatic", {}, hass) }, { value: "panel", label: haListManagerInventoryCardText("ui.panel_view", {}, hass) }, { value: "mobile", label: haListManagerInventoryCardText("ui.mobile_view", {}, hass) }] } } },
          { name: "content_display", selector: { select: { mode: "dropdown", options: [
            { value: "card_and_large", label: haListManagerInventoryCardText("ui.card_and_large_view", {}, hass) },
            { value: "card_only", label: haListManagerInventoryCardText("ui.card_only", {}, hass) },
            { value: "large_only", label: haListManagerInventoryCardText("ui.large_view_only", {}, hass) },
          ] } }, default: "card_and_large" },
          { name: "collapsible", selector: { boolean: {} }, default: true },
        ] },
        { type: "expandable", label: haListManagerInventoryCardText("inventory.input_and_transactions", {}, hass), icon: "mdi:package-variant-plus", schema: [
          { name: "input_row_position", selector: { select: { mode: "dropdown", options: [{ value: "top", label: haListManagerInventoryCardText("ui.top", {}, hass) }, { value: "bottom", label: haListManagerInventoryCardText("ui.bottom", {}, hass) }] } }, default: "top" },
          { name: "show_quantity_box", selector: { boolean: {} }, default: true },
          { name: "show_submit_button", selector: { boolean: {} }, default: true },
          { name: "allow_filter", selector: { boolean: {} }, default: true },
          { name: "allow_suggestions", selector: { boolean: {} }, default: true },
          { name: "show_camera_scan_button", selector: { boolean: {} }, default: true },
          { name: "show_mode_toggle", selector: { boolean: {} }, default: true },
          { name: "mode_panel_expanded", selector: { boolean: {} }, default: true },
          { name: "show_scanner_target_button", selector: { boolean: {} }, default: true },
          { name: "default_action", selector: { select: { mode: "dropdown", options: Object.entries(MODES(hass)).map(([value, mode]) => ({ value, label: mode.label })) } } },
          { name: "mode_timeout", selector: { number: { min: 0, max: 3600, step: 5, mode: "box" } } },
        ] },
        { type: "expandable", label: haListManagerInventoryCardText("ui.list_appearance", {}, hass), icon: "mdi:format-line-spacing", schema: [
          { name: "show_item_dividers", selector: { boolean: {} }, default: true },
          { name: "item_divider_before_spacing", selector: { number: { min: 0, max: 32, step: 1, mode: "slider", unit_of_measurement: "px" } }, default: 10 },
          { name: "item_divider_after_spacing", selector: { number: { min: 0, max: 32, step: 1, mode: "slider", unit_of_measurement: "px" } }, default: 10 },
          { name: "item_font_size", selector: { number: { min: 12, max: 24, step: 1, mode: "box", unit_of_measurement: "px" } }, default: 16 },
          { name: "category_font_scale", selector: { number: { min: 80, max: 160, step: 5, mode: "box", unit_of_measurement: "%" } }, default: 110 },
        ] },
        { type: "expandable", label: haListManagerInventoryCardText("ui.items_and_categories", {}, hass), icon: "mdi:shape-outline", schema: [
          { name: "quantity_position", selector: { select: { mode: "dropdown", options: [{ value: "beginning", label: haListManagerInventoryCardText("ui.before_item_name", {}, hass) }, { value: "end", label: haListManagerInventoryCardText("ui.after_item_name", {}, hass) }, { value: "controls", label: haListManagerInventoryCardText("ui.between_plus_minus", {}, hass) }] } } },
          { name: "show_plus_minus", selector: { boolean: {} }, default: true },
          { name: "show_images", selector: { boolean: {} }, default: true },
          { name: "show_details_default", selector: { boolean: {} }, default: true },
          { name: "show_hidden_default", selector: { boolean: {} }, default: false },
          { name: "group_categories", selector: { boolean: {} }, default: true },
          { name: "show_category_count", selector: { boolean: {} }, default: true },
          { name: "category_sort", selector: { select: { mode: "dropdown", options: [{ value: "alphabetical", label: haListManagerInventoryCardText("categories.combined_alphabetical", {}, hass) }, { value: "global_list_dynamic", label: haListManagerInventoryCardText("categories.order_global_local_dynamic", {}, hass) }, { value: "list_global_dynamic", label: haListManagerInventoryCardText("categories.order_local_global_dynamic", {}, hass) }, { value: "position", label: haListManagerInventoryCardText("ui.manual_position", {}, hass) }] } } },
        ] },
        { type: "expandable", label: haListManagerInventoryCardText("ui.toolbar_and_actions", {}, hass), icon: "mdi:dots-horizontal-circle-outline", schema: [
          { name: "option_row_position", selector: { select: { mode: "dropdown", options: [{ value: "top", label: haListManagerInventoryCardText("ui.top", {}, hass) }, { value: "bottom", label: haListManagerInventoryCardText("ui.bottom", {}, hass) }] } }, default: "top" },
          { name: "show_stock_filter_button", selector: { boolean: {} }, default: true },
          { name: "show_hidden_button", selector: { boolean: {} }, default: true },
          { name: "show_details_button", selector: { boolean: {} }, default: true },
          { name: "show_category_toggle_button", selector: { boolean: {} }, default: true },
          { name: "label_grouping", selector: { select: { mode: "dropdown", options: [
            { value: "disabled", label: haListManagerInventoryCardText("ui.label_grouping_disabled", {}, hass) },
            { value: "categories", label: haListManagerInventoryCardText("ui.label_grouping_categories", {}, hass) },
            { value: "labels", label: haListManagerInventoryCardText("ui.label_grouping_labels", {}, hass) },
          ] } }, default: "disabled" },
          { name: "show_label_filter_button", selector: { boolean: {} }, default: true },
          { name: "show_category_filter_button", selector: { boolean: {} }, default: true },
          { name: "show_group_button", selector: { boolean: {} }, default: true },
          { name: "show_product_database_button", selector: { boolean: {} }, default: true },
          { name: "show_pdf_export_button", selector: { boolean: {} }, default: false },
          { name: "show_restock_flag", selector: { boolean: {} }, default: true },
        ] },
        { type: "expandable", label: haListManagerInventoryCardText("ui.chips", {}, hass), icon: "mdi:gesture-tap-button", schema: [
          { name: "show_chips", selector: { boolean: {} }, default: true },
          { name: "show_chip_popup_button", selector: { boolean: {} }, default: true },
          { name: "show_browser_chips", selector: { boolean: {} }, default: true },
          { name: "browser_chips_for_products", selector: { boolean: {} }, default: false },
          { name: "allow_save_browser_chips", selector: { boolean: {} }, default: true },
          { name: "filter_chips", selector: { boolean: {} }, default: true },
          { name: "category_chip_layout", selector: { select: { mode: "dropdown", options: [
            { value: "none", label: haListManagerInventoryCardText("ui.no_category_chips", {}, hass) },
            { value: "stacked", label: haListManagerInventoryCardText("ui.stacked", {}, hass) },
            { value: "wrap", label: haListManagerInventoryCardText("ui.side_by_side", {}, hass) },
            { value: "compact", label: haListManagerInventoryCardText("ui.side_by_side_compact", {}, hass) },
          ] } }, default: "none" },
          { name: "category_chip_colors", selector: { boolean: {} }, default: true },
          { name: "show_important_chips", selector: { boolean: {} }, default: true },
          { name: "chips_limit", selector: { number: { min: 0, max: 50, step: 1, mode: "box" } }, default: 8 },
          { name: "chips_position", selector: { select: { mode: "dropdown", options: [
            { value: "auto", label: haListManagerInventoryCardText("ui.automatic", {}, hass) }, { value: "bottom", label: haListManagerInventoryCardText("ui.below_inventory", {}, hass) }, { value: "right", label: haListManagerInventoryCardText("ui.right_of_inventory", {}, hass) },
          ] } }, default: "auto" },
          { name: "chip_color_mode", selector: { select: { mode: "dropdown", options: [
            { value: "scope_fallback", label: haListManagerInventoryCardText("chips.color_then_scope", {}, hass) },
            { value: "scope_override", label: haListManagerInventoryCardText("chips.inventory_color_priority", {}, hass) },
            { value: "chip_only", label: haListManagerInventoryCardText("chips.saved_colors_only", {}, hass) },
            { value: "none", label: haListManagerInventoryCardText("ui.no_colors", {}, hass) },
          ] } }, default: "scope_fallback" },
          { name: "chip_color_global_rgb", selector: { color_rgb: {} } },
          { name: "chip_color_list_type_rgb", selector: { color_rgb: {} } },
          { name: "chip_color_list_rgb", selector: { color_rgb: {} } },
          { name: "chip_color_browser_rgb", selector: { color_rgb: {} } },
          { name: "important_chip_color_rgb", selector: { color_rgb: {} } },
        ] },
      ],
      computeLabel: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerInventoryCard.getConfigForm({ ...(hass || {}), localize }).computeLabel(schema);
        return ({ label_grouping: haListManagerInventoryCardText("ui.label_grouping", {}, hass), entity: haListManagerInventoryCardText("ui.inventory_list", {}, hass), title: haListManagerInventoryCardText("ui.title", {}, hass), title_icon: haListManagerInventoryCardText("ui.title_icon", {}, hass), title_icon_color_rgb: haListManagerInventoryCardText("ui.title_icon_color", {}, hass), content_display: haListManagerInventoryCardText("ui.show_content", {}, hass), collapsible: haListManagerInventoryCardText("ui.list_collapsible", {}, hass), view_mode: haListManagerInventoryCardText("ui.appearance", {}, hass), input_row_position: haListManagerInventoryCardText("ui.input_row_position", {}, hass), show_quantity_box: haListManagerInventoryCardText("ui.show_amount_field", {}, hass), show_submit_button: haListManagerInventoryCardText("ui.show_transaction_button", {}, hass), allow_filter: haListManagerInventoryCardText("ui.filter_items_typing", {}, hass), allow_suggestions: haListManagerInventoryCardText("products.show_suggestions", {}, hass), show_camera_scan_button: haListManagerInventoryCardText("scanner.show_camera", {}, hass), show_mode_toggle: haListManagerInventoryCardText("ui.show_mode_selector", {}, hass), mode_panel_expanded: haListManagerInventoryCardText("inventory.mode_picker_initially_open", {}, hass), show_scanner_target_button: haListManagerInventoryCardText("ui.show_scanner_target_button", {}, hass), default_action: haListManagerInventoryCardText("inventory.initial_mode", {}, hass), mode_timeout: haListManagerInventoryCardText("ui.mode_reset_seconds", {}, hass), quantity_position: haListManagerInventoryCardText("ui.stock_display_position", {}, hass), show_plus_minus: haListManagerInventoryCardText("shopping.show_quantity_buttons", {}, hass), show_images: haListManagerInventoryCardText("ui.show_product_images", {}, hass), show_details_default: haListManagerInventoryCardText("products.details_initially_visible", {}, hass), show_hidden_default: haListManagerInventoryCardText("ui.show_hidden_items_default", {}, hass), group_categories: haListManagerInventoryCardText("categories.group_by_category", {}, hass), show_category_count: haListManagerInventoryCardText("ui.show_category_item_counts", {}, hass), category_sort: haListManagerInventoryCardText("ui.category_sort_order", {}, hass), show_item_dividers: haListManagerInventoryCardText("ui.show_dividers", {}, hass), item_divider_before_spacing: haListManagerInventoryCardText("ui.divider_top_spacing", {}, hass), item_divider_after_spacing: haListManagerInventoryCardText("ui.divider_bottom_spacing", {}, hass), item_font_size: haListManagerInventoryCardText("ui.entry_text_size", {}, hass), category_font_scale: haListManagerInventoryCardText("categories.name_size", {}, hass), option_row_position: haListManagerInventoryCardText("ui.toolbar_position", {}, hass), show_stock_filter_button: haListManagerInventoryCardText("ui.show_stock_filter", {}, hass), show_hidden_button: haListManagerInventoryCardText("ui.show_hidden_items_toggle", {}, hass), show_details_button: haListManagerInventoryCardText("ui.show_product_details_toggle", {}, hass), show_category_toggle_button: haListManagerInventoryCardText("categories.show_collapse_control", {}, hass), show_label_filter_button: haListManagerInventoryCardText("ui.show_label_filter", {}, hass), show_category_filter_button: haListManagerInventoryCardText("ui.show_category_filter", {}, hass), show_group_button: haListManagerInventoryCardText("ui.show_group_action", {}, hass), show_product_database_button: haListManagerInventoryCardText("products.show_database", {}, hass), show_pdf_export_button: haListManagerInventoryCardText("ui.show_pdf_export", {}, hass), show_restock_flag: haListManagerInventoryCardText("ui.show_restock_flag", {}, hass), show_chips: haListManagerInventoryCardText("chips.show", {}, hass), show_chip_popup_button: haListManagerInventoryCardText("ui.show_chip_input_button", {}, hass), show_browser_chips: haListManagerInventoryCardText("ui.use_browser_chips", {}, hass), browser_chips_for_products: haListManagerInventoryCardText("chips.create_browser_product_chips", {}, hass), allow_save_browser_chips: haListManagerInventoryCardText("ui.allow_permanent_save", {}, hass), filter_chips: haListManagerInventoryCardText("ui.filter_chips_typing", {}, hass), category_chip_layout: haListManagerInventoryCardText("chips.category_appearance", {}, hass), category_chip_colors: haListManagerInventoryCardText("ui.grouped_chips_category_color", {}, hass), show_important_chips: haListManagerInventoryCardText("chips.show_important", {}, hass), chips_limit: haListManagerInventoryCardText("ui.initial_visible_chips", {}, hass), chips_position: haListManagerInventoryCardText("ui.position", {}, hass), chip_color_mode: haListManagerInventoryCardText("ui.color_display", {}, hass), chip_color_global_rgb: haListManagerInventoryCardText("ui.global_chip_color", {}, hass), chip_color_list_type_rgb: haListManagerInventoryCardText("chips.inventory_color", {}, hass), chip_color_list_rgb: haListManagerInventoryCardText("chips.list_color", {}, hass), chip_color_browser_rgb: haListManagerInventoryCardText("ui.browser_chip_color", {}, hass), important_chip_color_rgb: haListManagerInventoryCardText("ui.important_chip_color", {}, hass) })[schema.name] || schema.label || schema.name;
      },
      computeHelper: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerInventoryCard.getConfigForm({ ...(hass || {}), localize }).computeHelper(schema);
        if (schema.name === "entity") return haListManagerInventoryCardText("help.inventory_backend_list", {}, hass);
        if (schema.name === "title") return haListManagerInventoryCardText("help.inventory_card_title", {}, hass);
        if (schema.name === "title_icon") return haListManagerInventoryCardText("help.title_icon", {}, hass);
        if (schema.name === "title_icon_color_rgb") return haListManagerInventoryCardText("help.title_icon_color", {}, hass);
        if (schema.name === "view_mode") return haListManagerInventoryCardText("help.card_layout_auto", {}, hass);
        if (schema.name === "content_display") return haListManagerInventoryCardText("help.list_content_view", {}, hass);
        if (schema.name === "collapsible") return haListManagerInventoryCardText("help.title_collapse_card", {}, hass);
        if (schema.name === "input_row_position") return haListManagerInventoryCardText("help.inventory_input_position", {}, hass);
        if (schema.name === "show_quantity_box") return haListManagerInventoryCardText("help.inventory_quantity_input", {}, hass);
        if (schema.name === "show_submit_button") return haListManagerInventoryCardText("help.inventory_action_button", {}, hass);
        if (schema.name === "allow_filter") return haListManagerInventoryCardText("help.inventory_typing_filter", {}, hass);
        if (schema.name === "allow_suggestions") return haListManagerInventoryCardText("help.inventory_product_suggestions", {}, hass);
        if (schema.name === "show_camera_scan_button") return haListManagerInventoryCardText("help.camera_scan_input_button", {}, hass);
        if (schema.name === "show_mode_toggle") return haListManagerInventoryCardText("help.inventory_mode_controls", {}, hass);
        if (schema.name === "mode_panel_expanded") return haListManagerInventoryCardText("help.initial_mode_state", {}, hass);
        if (schema.name === "show_scanner_target_button") return haListManagerInventoryCardText("help.backend_scanner_target_button", {}, hass);
        if (schema.name === "default_action") return haListManagerInventoryCardText("help.initial_stock_action_mode", {}, hass);
        if (schema.name === "mode_timeout") return haListManagerInventoryCardText("help.mode_auto_reset", {}, hass);
        if (schema.name === "show_item_dividers") return haListManagerInventoryCardText("help.item_dividers", {}, hass);
        if (schema.name === "item_divider_before_spacing") return haListManagerInventoryCardText("help.item_divider_spacing", {}, hass);
        if (schema.name === "item_divider_after_spacing") return haListManagerInventoryCardText("help.item_top_spacing", {}, hass);
        if (schema.name === "item_font_size") return haListManagerInventoryCardText("help.item_category_base_size", {}, hass);
        if (schema.name === "category_font_scale") return haListManagerInventoryCardText("help.category_name_scale", {}, hass);
        if (schema.name === "quantity_position") return haListManagerInventoryCardText("help.stock_display_position", {}, hass);
        if (schema.name === "show_plus_minus") return haListManagerInventoryCardText("help.direct_stock_buttons", {}, hass);
        if (schema.name === "show_images") return haListManagerInventoryCardText("help.product_image_visibility", {}, hass);
        if (schema.name === "show_details_default") return haListManagerInventoryCardText("help.initial_product_details", {}, hass);
        if (schema.name === "show_hidden_default") return haListManagerInventoryCardText("help.initial_hidden_inventory_items", {}, hass);
        if (schema.name === "group_categories") return haListManagerInventoryCardText("help.inventory_category_grouping", {}, hass);
        if (schema.name === "show_category_count") return haListManagerInventoryCardText("help.inventory_category_count", {}, hass);
        if (schema.name === "category_sort") return haListManagerInventoryCardText("help.category_sort_order", {}, hass);
        if (schema.name === "option_row_position") return haListManagerInventoryCardText("help.inventory_toolbar_position", {}, hass);
        if (schema.name === "show_stock_filter_button") return haListManagerInventoryCardText("help.inventory_stock_filter", {}, hass);
        if (schema.name === "show_hidden_button") return haListManagerInventoryCardText("help.hidden_items_toggle", {}, hass);
        if (schema.name === "show_details_button") return haListManagerInventoryCardText("help.product_details_toggle", {}, hass);
        if (schema.name === "show_category_toggle_button") return haListManagerInventoryCardText("help.inventory_category_toggle", {}, hass);
        if (schema.name === "label_grouping") return haListManagerInventoryCardText("help.label_grouping", {}, hass);
        if (schema.name === "show_label_filter_button") return haListManagerInventoryCardText("help.label_multiselect_filter", {}, hass);
        if (schema.name === "show_category_filter_button") return haListManagerInventoryCardText("help.inventory_category_multiselect", {}, hass);
        if (schema.name === "show_group_button") return haListManagerInventoryCardText("help.inventory_group_action", {}, hass);
        if (schema.name === "show_product_database_button") return haListManagerInventoryCardText("help.inventory_product_database_access", {}, hass);
        if (schema.name === "show_restock_flag") return haListManagerInventoryCardText("help.restock_once_flag", {}, hass);
        if (schema.name === "show_pdf_export_button") return haListManagerInventoryCardText("help.inventory_pdf_action", {}, hass);
        if (schema.name === "show_chips") return haListManagerInventoryCardText("help.inventory_quick_entries", {}, hass);
        if (schema.name === "show_chip_popup_button") return haListManagerInventoryCardText("help.chip_picker_icon", {}, hass);
        if (schema.name === "show_browser_chips") return haListManagerInventoryCardText("help.auto_save_inventory_browser_chip", {}, hass);
        if (schema.name === "browser_chips_for_products") return haListManagerInventoryCardText("help.inventory_database_browser_chips", {}, hass);
        if (schema.name === "allow_save_browser_chips") return haListManagerInventoryCardText("help.browser_chip_save_action", {}, hass);
        if (schema.name === "filter_chips") return haListManagerInventoryCardText("help.chips_filter_as_typing", {}, hass);
        if (schema.name === "category_chip_layout") return haListManagerInventoryCardText("help.category_chip_layouts", {}, hass);
        if (schema.name === "category_chip_colors") return haListManagerInventoryCardText("help.quick_entry_category_color", {}, hass);
        if (schema.name === "show_important_chips") return haListManagerInventoryCardText("help.prioritize_important_inventory_chips", {}, hass);
        if (schema.name === "chips_limit") return haListManagerInventoryCardText("help.initial_plain_chips_limit", {}, hass);
        if (schema.name === "chips_position") return haListManagerInventoryCardText("help.inventory_chip_placement", {}, hass);
        if (schema.name === "chip_color_mode") return haListManagerInventoryCardText("help.inventory_chip_color_source", {}, hass);
        if (schema.name === "chip_color_global_rgb") return haListManagerInventoryCardText("help.global_chip_color", {}, hass);
        if (schema.name === "chip_color_list_type_rgb") return haListManagerInventoryCardText("help.inventory_chip_color", {}, hass);
        if (schema.name === "chip_color_list_rgb") return haListManagerInventoryCardText("help.inventory_local_chip_color", {}, hass);
        if (schema.name === "chip_color_browser_rgb") return haListManagerInventoryCardText("help.browser_only_chip_color", {}, hass);
        if (schema.name === "important_chip_color_rgb") return haListManagerInventoryCardText("help.important_browser_chip_color", {}, hass);
        return "";
      },
    };
  }
  static getStubConfig(hass = null) { return { title: haListManagerInventoryCardText("ui.inventory", {}, hass), title_icon: "mdi:package-variant-closed", content_display: "card_and_large", collapsible: true, view_mode: "auto", input_row_position: "top", show_quantity_box: true, show_submit_button: true, allow_filter: true, allow_suggestions: true, show_camera_scan_button: true, show_mode_toggle: true, mode_panel_expanded: true, show_scanner_target_button: true, default_action: "add", mode_timeout: 0, quantity_position: "end", show_plus_minus: true, show_images: true, show_details_default: true, show_hidden_default: false, group_categories: true, label_grouping: "disabled", show_category_count: true, category_sort: "alphabetical", show_item_dividers: true, item_divider_before_spacing: 10, item_divider_after_spacing: 10, item_font_size: 16, category_font_scale: 110, option_row_position: "top", show_stock_filter_button: true, show_hidden_button: true, show_details_button: true, show_category_toggle_button: true, show_label_filter_button: true, show_category_filter_button: true, show_group_button: true, show_product_database_button: true, show_pdf_export_button: false, show_restock_flag: true, show_chips: true, show_chip_popup_button: true, show_browser_chips: true, browser_chips_for_products: false, allow_save_browser_chips: true, filter_chips: true, category_chip_layout: "none", category_chip_colors: true, show_important_chips: true, chips_limit: 8, chips_position: "auto", chip_color_mode: "scope_fallback", chip_color_global_rgb: [96, 125, 139], chip_color_list_type_rgb: [3, 169, 244], chip_color_list_rgb: [67, 160, 71], chip_color_browser_rgb: [121, 85, 72], important_chip_color_rgb: [244, 67, 54] }; }

  setConfig(config) {
    this._config = { ...HaListManagerInventoryCard.getStubConfig(this._hass), ...config };
    const normalizeAppearanceNumber = (value, fallback, min, max) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    };
    this._config.item_divider_before_spacing = normalizeAppearanceNumber(this._config.item_divider_before_spacing, 10, 0, 32);
    this._config.item_divider_after_spacing = normalizeAppearanceNumber(this._config.item_divider_after_spacing, 10, 0, 32);
    this._config.item_font_size = normalizeAppearanceNumber(this._config.item_font_size, 16, 12, 24);
    this._config.category_font_scale = normalizeAppearanceNumber(this._config.category_font_scale, 110, 80, 160);
    if (!MODES(this._hass)[this._config.default_action]) this._config.default_action = "add";
    if (!["beginning", "end", "controls"].includes(this._config.quantity_position)) this._config.quantity_position = "end";
    if (!["alphabetical", "global_list_dynamic", "list_global_dynamic", "position"].includes(this._config.category_sort)) this._config.category_sort = "alphabetical";
    if (!["disabled", "categories", "labels"].includes(this._config.label_grouping)) this._config.label_grouping = "disabled";
    if (!["card_and_large", "card_only", "large_only"].includes(this._config.content_display)) this._config.content_display = "card_and_large";
    if (!["top", "bottom"].includes(this._config.input_row_position)) this._config.input_row_position = "top";
    if (!["top", "bottom"].includes(this._config.option_row_position)) this._config.option_row_position = "top";
    if (!["auto", "bottom", "right"].includes(this._config.chips_position)) this._config.chips_position = "auto";
    if (!["none", "stacked", "wrap", "compact"].includes(this._config.category_chip_layout)) this._config.category_chip_layout = "none";
    if (!["scope_fallback", "scope_override", "chip_only", "none"].includes(this._config.chip_color_mode)) this._config.chip_color_mode = "scope_fallback";
    const configuredChipLimit = Number.parseInt(this._config.chips_limit, 10);
    this._config.chips_limit = Number.isFinite(configuredChipLimit) ? Math.max(0, Math.min(50, configuredChipLimit)) : 8;
    if (this._expandedView && this._config.content_display === "card_only") this._setExpandedView(false);
    this._config.mode_timeout = Math.min(3600, Math.max(0, Math.floor(Number(this._config.mode_timeout) || 0)));
    this._showDetails = this._config.show_details_default !== false;
    this._showHidden = this._config.show_hidden_default === true;
    this._groupCategories = this._config.group_categories !== false;
    if (this._config.show_stock_filter_button === false) this._filter = "all";
    if (this._config.show_category_filter_button === false) { this._selectedCategoryIds = null; this._categoryMenuOpen = false; }
    if (this._config.show_label_filter_button === false) { this._selectedLabelIds = null; this._labelMenuOpen = false; }
    if (this._config.show_group_button === false) { this._groupSelectionMode = false; this._selectedEntryIds.clear(); }
    if (!this._loadedListId) this._mode = this._config.default_action;
    if (this._loadedListId !== this._listId()) {
      this._entries = []; this._products = []; this._categories = []; this._inventoryGroups = []; this._loadedListId = null;
    }
    this._restoreInventoryUndo();
    this._render();
    this._load();
  }

  set hass(value) {
    const first = !this._hass;
    this._hass = value;
    if (this.isConnected) this._watchConnection();
    const translationsChanged = haListManagerInventoryCardTextUpdateTranslations(this, this._hass);
    this._restoreInventoryUndo();
    if (first) { this._subscribe(); this._load(); } else if (this._loadedListId !== this._listId()) this._load(true);
    if (translationsChanged) this._render();
  }
  connectedCallback() {
    this._watchConnection();
    this._mode = this._config.default_action || "add";
    this._clearModeTimer();
    this._restoreInventoryUndo();
    this._render();
    this._subscribe();
    // Lovelace disconnects inactive views. Their cached data can therefore be
    // stale when the user returns, because they did not receive backend events
    // while detached. Always refresh the active scanner target on reconnect.
    this._load(true);
  }
  disconnectedCallback() { this._watchConnection(null); this._loadRequestId += 1; this._loading = false; this._loadingListId = null; clearTimeout(this._undoTimer); clearTimeout(this._undoCountdownTimer); this._lastInventoryBooking = null; this._setExpandedView(false); this._unsubscribes.forEach((unsubscribe) => unsubscribe()); this._unsubscribes = []; this._clearModeTimer(); this._stopCameraScan(); }
  getCardSize() { return this._config.content_display === "large_only" ? 1 : Math.max(3, Math.ceil(this._entries.length * 0.75) + 2); }

  _listId() {
    return this._hass?.states?.[this._config.entity]?.attributes?.list_id || this._config.list_id || null;
  }

  _cardIdentity() {
    return this._config.card_id || this._config.entity || this._listId() || "inventory";
  }

  _groupingKey() { return `ha-list-manager:inventory-grouping:${encodeURIComponent(this._cardIdentity())}`; }
  _groupingEnabled() { return ["categories", "labels"].includes(this._config.label_grouping); }
  _groupingMode() {
    if (!this._groupingEnabled()) return "categories";
    const key = this._groupingKey();
    if (this._groupingPreference?.key === key) return this._groupingPreference.mode;
    try {
      const saved = localStorage.getItem(key);
      if (["categories", "labels"].includes(saved)) return saved;
    } catch (_error) { /* The configured default also works without storage. */ }
    return this._config.label_grouping;
  }
  _toggleGrouping() {
    if (!this._groupingEnabled()) return;
    const key = this._groupingKey();
    const mode = this._groupingMode() === "labels" ? "categories" : "labels";
    this._groupingPreference = { key, mode };
    try { localStorage.setItem(key, mode); } catch (_error) {}
    this._categoryMenuOpen = false;
    this._labelMenuOpen = false;
    this._render();
  }

  _browserChipStorageKey(listId = this._listId()) { return `ha-list-manager:inventory-browser-chips:${encodeURIComponent(listId || this._cardIdentity())}`; }
  _importantBrowserChipStorageKey(listId = this._listId()) { return `ha-list-manager:inventory-important-browser-chips:${encodeURIComponent(listId || this._cardIdentity())}`; }
  _normalizedChipName(value) { return String(value || "").trim().normalize("NFKC").toLocaleLowerCase(); }
  _loadBrowserChips(listId = this._listId()) {
    try {
      const parsed = JSON.parse(localStorage.getItem(this._browserChipStorageKey(listId)) || "[]");
      this._browserChips = Array.isArray(parsed) ? parsed.filter((chip) => chip && typeof chip.name === "string" && chip.name.trim()).map((chip, index) => ({
        id: String(chip.id || `browser-${index}-${this._normalizedChipName(chip.name)}`), name: chip.name.trim(),
        product_id: chip.product_id || null, product_name: chip.product_name || null, scope: "browser", browser: true,
      })).slice(0, 2000) : [];
    } catch (_error) { this._browserChips = []; }
    try {
      const ids = JSON.parse(localStorage.getItem(this._importantBrowserChipStorageKey(listId)) || "[]");
      const available = new Set(this._browserChips.map((chip) => chip.id));
      this._importantBrowserChipIds = new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => available.has(id)));
    } catch (_error) { this._importantBrowserChipIds = new Set(); }
  }
  _saveBrowserChips() {
    try { localStorage.setItem(this._browserChipStorageKey(), JSON.stringify(this._browserChips.slice(0, 2000).map(({ id, name, product_id, product_name }) => ({ id, name, product_id, product_name })))); }
    catch (_error) {}
  }
  _saveImportantBrowserChips() {
    try { localStorage.setItem(this._importantBrowserChipStorageKey(), JSON.stringify([...this._importantBrowserChipIds])); }
    catch (_error) {}
  }
  _importantChipTarget(chip) {
    if (!chip || chip.browser) return null;
    if (chip.categoryProduct && chip.product_id) return { target_type: "product", target_id: chip.product_id };
    return chip.id ? { target_type: "chip", target_id: chip.id } : null;
  }
  _isChipImportant(chip) {
    if (!chip) return false;
    if (chip.browser) return this._importantBrowserChipIds.has(chip.id);
    const target = this._importantChipTarget(chip);
    return Boolean(target && this._importantChipKeys.has(`${target.target_type}:${target.target_id}`));
  }
  _effectiveChips() {
    if (this._config.show_browser_chips === false) return this._chips;
    const names = new Set(this._chips.map((chip) => this._normalizedChipName(chip.name)));
    const products = new Set(this._chips.map((chip) => chip.product_id).filter(Boolean));
    const browser = this._browserChips.filter((chip) => !names.has(this._normalizedChipName(chip.name)) && !(chip.product_id && products.has(chip.product_id)));
    return [...this._chips, ...browser].sort((left, right) => left.name.localeCompare(right.name, haListManagerInventoryCardTextLocale(this._hass), { sensitivity: "base", numeric: true }));
  }
  _matchingProductCategory(product) { return this._productDefaultCategory(product); }
  _categoryProductChips() {
    const linkedProducts = new Set(this._effectiveChips().map((chip) => chip.product_id).filter(Boolean));
    return this._products.flatMap((product) => {
      if (!product?.id || linkedProducts.has(product.id)) return [];
      const category = this._matchingProductCategory(product);
      if (!category) return [];
      return [{ id: `category-product:${product.id}`, name: product.name, product_id: product.id, product_name: product.name, scope: category.scope || "list", category, categoryProduct: true }];
    });
  }
  _categoryChipLayout() { return this._config.category_chip_layout || "none"; }
  _categoryChipsEnabled() { return this._categoryChipLayout() !== "none"; }
  _displayChips() {
    const chips = this._categoryChipsEnabled() ? [...this._effectiveChips(), ...this._categoryProductChips()] : this._effectiveChips();
    return chips.map((chip) => ({ ...chip, important: this._isChipImportant(chip) })).sort((left, right) => {
      if (this._config.show_important_chips !== false && left.important !== right.important) return left.important ? -1 : 1;
      return left.name.localeCompare(right.name, haListManagerInventoryCardTextLocale(this._hass), { sensitivity: "base", numeric: true });
    });
  }
  async _loadChipCategories(requestId = this._loadRequestId, listId = this._listId()) {
    if (!this._categoryChipsEnabled() || !this._hass || !this._listId()) { this._chipCategories = new Map(); return; }
    const chips = this._effectiveChips();
    if (!chips.length) { this._chipCategories = new Map(); return; }
    const result = await haListManagerInventoryCardTextRequest(this._hass, {
      type: `${HA_LM_API}/categories/chips/resolve`, list_id: listId,
      candidates: chips.map((chip) => ({ key: chip.id, name: chip.name, product_id: chip.product_id || null })),
    });
    if (requestId !== this._loadRequestId || listId !== this._listId()) return;
    this._chipCategories = new Map((result.resolutions || []).map((entry) => [entry.key, entry.category || null]));
  }
  _chipCategoryCollapseKey(categoryId) { return `ha-list-manager:inventory-chip-category:${encodeURIComponent(this._cardIdentity())}:${encodeURIComponent(categoryId || "__general__")}`; }
  _wrappedChipCategoryKey(context) { return `ha-list-manager:inventory-chip-category-open:${encodeURIComponent(this._cardIdentity())}:${context}`; }
  _wrappedChipCategorySelection(context) {
    if (Object.prototype.hasOwnProperty.call(this._wrappedChipCategoryOpen, context)) return this._wrappedChipCategoryOpen[context];
    try { const stored = localStorage.getItem(this._wrappedChipCategoryKey(context)); return stored === null ? undefined : stored === "__none__" ? null : stored; }
    catch (_error) { return undefined; }
  }
  _storeWrappedChipCategorySelection(context, categoryId) {
    this._wrappedChipCategoryOpen[context] = categoryId;
    try { localStorage.setItem(this._wrappedChipCategoryKey(context), categoryId || "__none__"); } catch (_error) {}
  }
  _chipCategoryCollapsed(categoryId) {
    try { const stored = localStorage.getItem(this._chipCategoryCollapseKey(categoryId)); return stored === null ? categoryId !== "__important__" : stored !== "0"; }
    catch (_error) { return true; }
  }
  _toggleChipCategory(categoryId, dialog = false) {
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      const context = dialog ? "dialog" : "card";
      const stored = this._wrappedChipCategorySelection(context);
      const current = stored !== undefined ? stored : categoryId === "__important__" ? "__important__" : null;
      this._storeWrappedChipCategorySelection(context, current === categoryId ? null : categoryId);
    } else {
      try { localStorage.setItem(this._chipCategoryCollapseKey(categoryId), this._chipCategoryCollapsed(categoryId) ? "0" : "1"); } catch (_error) {}
    }
    this._render();
  }
  _allChipCategoriesExpanded(chips = this._filteredChips()) {
    const categoryIds = this._chipCategoryGroups(chips).map(({ category }) => category.id || "__general__");
    if (!categoryIds.length) return false;
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      const selected = this._wrappedChipCategorySelection("card");
      return selected === "__all__" || (categoryIds.length === 1 && selected === categoryIds[0]);
    }
    return categoryIds.every((categoryId) => !this._chipCategoryCollapsed(categoryId));
  }
  _toggleAllChipCategories() {
    const categoryIds = this._chipCategoryGroups(this._filteredChips()).map(({ category }) => category.id || "__general__");
    if (!categoryIds.length) return;
    const expand = !this._allChipCategoriesExpanded();
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      this._storeWrappedChipCategorySelection("card", expand ? "__all__" : null);
    } else {
      try { categoryIds.forEach((categoryId) => localStorage.setItem(this._chipCategoryCollapseKey(categoryId), expand ? "0" : "1")); }
      catch (_error) {}
    }
    this._render();
  }
  _chipCategoryGroups(chips = this._filteredChips()) {
    const groups = new Map();
    for (const chip of chips) {
      const resolved = chip.category || this._chipCategories.get(chip.id);
      const category = resolved || { id: "", name: haListManagerInventoryCardText("ui.general", {}, this._hass), icon: "mdi:shape-outline", color: null, scope: "list", dynamic: false, uncategorized: true };
      const key = category.id || "__general__";
      if (!groups.has(key)) groups.set(key, { category, chips: [] });
      groups.get(key).chips.push(chip);
    }
    const normal = [...groups.values()].sort((left, right) => this._compareCategories(left.category, right.category));
    const important = this._config.show_important_chips !== false ? chips.filter((chip) => chip.important) : [];
    return important.length ? [{ category: { id: "__important__", name: haListManagerInventoryCardText("ui.important", {}, this._hass), icon: "mdi:alert-circle-outline", color: this._configuredChipColor(this._config.important_chip_color_rgb, "rgb(244, 67, 54)"), important: true }, chips: important }, ...normal] : normal;
  }
  _rememberBrowserChip(name, product = null) {
    if (this._config.show_browser_chips === false) return;
    const normalized = this._normalizedChipName(name);
    const productId = product?.product_id || product?.id || null;
    if (productId && this._config.browser_chips_for_products !== true) return;
    if (!normalized || this._chips.some((chip) => this._normalizedChipName(chip.name) === normalized || (productId && chip.product_id === productId))) return;
    if (this._browserChips.some((chip) => this._normalizedChipName(chip.name) === normalized || (productId && chip.product_id === productId))) return;
    this._browserChips.push({ id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, name: String(name).trim(), product_id: productId, product_name: product?.name || null, scope: "browser", browser: true });
    this._browserChips = this._browserChips.slice(0, 2000);
    this._saveBrowserChips();
  }
  _removeBrowserChip(chip) { this._browserChips = this._browserChips.filter((entry) => entry.id !== chip?.id); this._importantBrowserChipIds.delete(chip?.id); this._saveBrowserChips(); this._saveImportantBrowserChips(); }
  _clearBrowserChips() { this._browserChips = []; this._importantBrowserChipIds.clear(); this._saveBrowserChips(); this._saveImportantBrowserChips(); }

  _listCollapseKey() { return `ha-list-manager:inventory-list:${encodeURIComponent(this._cardIdentity())}`; }
  _listCollapsed() { try { return localStorage.getItem(this._listCollapseKey()) === "1"; } catch (_error) { return false; } }
  _toggleList() { try { const key = this._listCollapseKey(); if (this._listCollapsed()) localStorage.removeItem(key); else localStorage.setItem(key, "1"); } catch (_error) {} this._render(); }
  _findDashboardViewport() {
    const selector = "hui-view, hui-masonry-view, hui-sections-view, hui-panel-view";
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      if (node.parentElement) { node = node.parentElement; continue; }
      const root = node.getRootNode?.();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  }

  _isPanelDashboardView() {
    let node = this;
    while (node) {
      if (node.matches?.("hui-panel-view")) return true;
      node = node.parentNode || node.getRootNode?.().host || null;
    }
    return false;
  }
  _updateExpandedViewBounds() {
    if (!this._expandedView) return;
    const viewport = this._expandedViewport || this._findDashboardViewport();
    const rect = viewport?.getBoundingClientRect?.();
    const validRect = rect && rect.width > 0 && rect.height > 0;
    const top = validRect ? Math.max(0, Math.min(window.innerHeight, rect.top)) : 56;
    const left = validRect ? Math.max(0, Math.min(window.innerWidth, rect.left)) : 0;
    const right = validRect ? Math.max(0, window.innerWidth - Math.min(window.innerWidth, rect.right)) : 0;
    const bottom = validRect ? Math.max(0, window.innerHeight - Math.min(window.innerHeight, rect.bottom)) : 0;
    this.style.setProperty("--expanded-top", `${top}px`);
    this.style.setProperty("--expanded-left", `${left}px`);
    this.style.setProperty("--expanded-right", `${right}px`);
    this.style.setProperty("--expanded-bottom", `${bottom}px`);
  }
  _scheduleExpandedViewBounds() {
    if (!this._expandedView || this._expandedResizeFrame) return;
    this._expandedResizeFrame = requestAnimationFrame(() => { this._expandedResizeFrame = null; this._updateExpandedViewBounds(); });
  }
  _watchExpandedViewBounds() {
    this._expandedViewport = this._findDashboardViewport();
    if (this._expandedViewport && typeof ResizeObserver !== "undefined") {
      this._expandedResizeObserver = new ResizeObserver(this._onExpandedViewResize);
      this._expandedResizeObserver.observe(this._expandedViewport);
    }
    window.addEventListener("resize", this._onExpandedViewResize);
    document.addEventListener("transitionrun", this._onExpandedViewResize, true);
    document.addEventListener("transitionend", this._onExpandedViewResize, true);
    this._updateExpandedViewBounds();
  }
  _stopWatchingExpandedViewBounds() {
    this._expandedResizeObserver?.disconnect();
    this._expandedResizeObserver = null;
    this._expandedViewport = null;
    if (this._expandedResizeFrame) cancelAnimationFrame(this._expandedResizeFrame);
    this._expandedResizeFrame = null;
    if (this._expandedScrollFrame) cancelAnimationFrame(this._expandedScrollFrame);
    this._expandedScrollFrame = null;
    window.removeEventListener("resize", this._onExpandedViewResize);
    document.removeEventListener("transitionrun", this._onExpandedViewResize, true);
    document.removeEventListener("transitionend", this._onExpandedViewResize, true);
  }
  _setExpandedView(expanded) {
    const next = Boolean(expanded);
    if (next === this._expandedView) return;
    this._expandedView = next;
    if (next) {
      this._expandedViewWasCollapsed = this._listCollapsed();
      this.setAttribute("data-expanded-view", "");
      this._watchExpandedViewBounds();
      this._expandedPageOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._onExpandedViewKeydown, true);
      if (this._expandedViewWasCollapsed || this._config.content_display === "large_only") this._render();
    } else {
      this._stopWatchingExpandedViewBounds();
      this._expandedScrollTop = 0;
      this.removeAttribute("data-expanded-view");
      ["--expanded-top", "--expanded-left", "--expanded-right", "--expanded-bottom"].forEach((property) => this.style.removeProperty(property));
      document.removeEventListener("keydown", this._onExpandedViewKeydown, true);
      document.body.style.overflow = this._expandedPageOverflow || "";
      this._expandedPageOverflow = null;
      const shouldRenderCollapsed = this._expandedViewWasCollapsed || this._config.content_display === "large_only";
      this._expandedViewWasCollapsed = false;
      if (shouldRenderCollapsed && this.isConnected) this._render();
    }
    this.shadowRoot?.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => {
      element.setAttribute("aria-pressed", String(next));
      element.setAttribute("aria-expanded", String(next));
      element.setAttribute("title", next ? haListManagerInventoryCardText("ui.close_large_view", {}, this._hass) : haListManagerInventoryCardText("ui.open_large_view", {}, this._hass));
      element.setAttribute("aria-label", next ? haListManagerInventoryCardText("ui.close_large_view", {}, this._hass) : haListManagerInventoryCardText("ui.open_large_view", {}, this._hass));
    });
  }
  _toggleExpandedView(event) { event?.preventDefault(); event?.stopPropagation(); this._setExpandedView(!this._expandedView); }
  _restoreExpandedScroll() {
    if (!this._expandedView || this._expandedScrollTop <= 0) return;
    if (this._expandedScrollFrame) cancelAnimationFrame(this._expandedScrollFrame);
    const scrollTop = this._expandedScrollTop;
    this._expandedScrollFrame = requestAnimationFrame(() => {
      this._expandedScrollFrame = null;
      const card = this.shadowRoot?.querySelector("ha-card");
      if (card) card.scrollTop = scrollTop;
    });
  }
  _modePanelKey() { return `ha-list-manager:inventory-mode-panel:${encodeURIComponent(this._cardIdentity())}`; }
  _modePanelExpanded() { try { const value = localStorage.getItem(this._modePanelKey()); return value === null ? this._config.mode_panel_expanded !== false : value === "1"; } catch (_error) { return this._config.mode_panel_expanded !== false; } }
  _toggleModePanel() { try { localStorage.setItem(this._modePanelKey(), this._modePanelExpanded() ? "0" : "1"); } catch (_error) {} this._render(); }

  _collapseKey(categoryId) {
    return `ha-list-manager:inventory-category:${encodeURIComponent(this._cardIdentity())}:${encodeURIComponent(categoryId || "__uncategorized__")}`;
  }

  _isCategoryCollapsed(categoryId) {
    try { return localStorage.getItem(this._collapseKey(categoryId)) === "1"; } catch (_error) { return false; }
  }

  _toggleCategory(categoryId, button = null) {
    const key = this._collapseKey(categoryId);
    const collapsed = !this._isCategoryCollapsed(categoryId);
    try { if (collapsed) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch (_error) { /* Storage may be disabled. */ }
    const header = button || [...this.shadowRoot.querySelectorAll("[data-toggle-category]")].find((element) => element.dataset.toggleCategory === categoryId);
    const section = header?.closest(".category");
    const group = this._groups().find(({ key: groupKey, category }) => String(category?.id || groupKey || "__uncategorized__") === String(categoryId));
    if (!header || !section || !group) { this._render(); return; }
    header.setAttribute("aria-expanded", String(!collapsed));
    header.querySelector(".category-chevron")?.setAttribute("icon", `mdi:${collapsed ? "chevron-down" : "chevron-up"}`);
    [...section.children].slice(1).forEach((element) => element.remove());
    if (!collapsed) {
      section.insertAdjacentHTML("beforeend", group.units.map((unit) => this._renderUnit(unit)).join(""));
      this._bindInventoryRowEvents(section, false);
    }
  }

  _allCategoriesExpanded(groups = this._groups()) {
    const categoryGroups = groups.filter(({ flat, units }) => !flat && units.length);
    return categoryGroups.length > 0 && categoryGroups.every(({ key, category }) => !this._isCategoryCollapsed(category?.id || key || "__uncategorized__"));
  }

  _toggleAllCategories() {
    const groups = this._groups().filter(({ flat, units }) => !flat && units.length);
    if (!groups.length) return;
    const collapse = this._allCategoriesExpanded(groups);
    try {
      groups.forEach(({ key, category }) => {
        const storageKey = this._collapseKey(category?.id || key || "__uncategorized__");
        if (collapse) localStorage.setItem(storageKey, "1");
        else localStorage.removeItem(storageKey);
      });
    } catch (_error) { /* Storage may be disabled. */ }
    this._render();
  }

  _watchConnection(connection = this._hass?.connection) {
    if (this._watchedConnection === connection) return;
    this._watchedConnection?.removeEventListener?.("ready", this._onConnectionReady);
    this._watchedConnection = connection;
    this._onConnectionReady ||= () => {
      if (this.isConnected) this._load(true);
    };
    connection?.addEventListener?.("ready", this._onConnectionReady);
  }

  async _subscribe() {
    if (!this._hass || this._unsubscribes.length || this._subscribing) return;
    this._subscribing = true;
    const subscriptions = [];
    try {
      subscriptions.push(await this._hass.connection.subscribeMessage((event) => {
        if (this.isConnected && event.data?.list_id === this._listId()) this._load(true);
      }, { type: `${HA_LM_API}/subscribe`, event_type: HA_LM_INVENTORY_EVENT }));
      subscriptions.push(await this._hass.connection.subscribeMessage((event) => {
        if (!this.isConnected) return;
        this._scannerTarget = event.data?.target === null ? null : event.data;
        this._render();
      }, { type: `${HA_LM_API}/subscribe`, event_type: HA_LM_SCANNER_TARGET_EVENT }));
      subscriptions.push(await this._hass.connection.subscribeMessage((event) => {
        if (this.isConnected) this._handleProcessedScan(event.data || {});
      }, { type: `${HA_LM_API}/subscribe`, event_type: HA_LM_SCAN_PROCESSED_EVENT }));
      if (this.isConnected) this._unsubscribes = subscriptions;
      else subscriptions.forEach((unsubscribe) => unsubscribe());
    } catch (error) {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      throw error;
    } finally {
      this._subscribing = false;
    }
  }

  async _load(force = false) {
    const listId = this._listId();
    if (!this._hass || !listId || this._hass.connection?.connected === false || (this._loading && !force && this._loadingListId === listId) || (!force && this._loadedListId === listId)) return;
    this._loadBrowserChips(listId);
    const requestId = ++this._loadRequestId;
    this._loadingListId = listId;
    const alreadyLoading = this._loading;
    this._loading = true; this._error = "";
    if (!alreadyLoading) this._render();
    try {
      const client = new HaListManagerClient(this._hass);
      const [inventory, options, groups, scannerTarget, inventoryLists, pendingScans, chips, importantChips, restockPreview] = await Promise.all([
        client.listInventory(listId), client.inventoryOptions(listId),
        client.listInventoryGroups(listId), client.getScannerTarget(),
        client.listInventoryLists(), client.listPendingScans(listId),
        haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/list`, list_id: listId }),
        haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/important/list`, list_id: listId }),
        client.previewRestock(listId),
      ]);
      if (requestId !== this._loadRequestId || listId !== this._listId()) return;
      this._entries = inventory.entries || [];
      this._products = options.products || [];
      this._categories = options.categories || [];
      this._labels = options.labels || [];
      this._inventoryGroups = groups.groups || [];
      this._scannerTarget = scannerTarget.target || null;
      this._inventoryLists = inventoryLists.lists || [];
      this._restockPreview = restockPreview.items || [];
      this._pendingScans = pendingScans.scans || [];
      this._chips = chips.chips || [];
      this._importantChipKeys = new Set((importantChips.assignments || []).map((entry) => `${entry.target_type}:${entry.target_id}`));
      try { await this._loadChipCategories(requestId, listId); }
      catch (_error) { if (requestId === this._loadRequestId && listId === this._listId()) this._chipCategories = new Map(); }
      if (requestId === this._loadRequestId && listId === this._listId()) this._loadedListId = listId;
    } catch (error) {
      // Interrupted reads are refreshed by HA's next ready event.
      if (requestId === this._loadRequestId && listId === this._listId() && error !== 3 && error?.error?.code !== 3) {
        this._error = error?.message || error?.error?.message || (typeof error === "string" ? error : haListManagerInventoryCardText("errors.inventory_load_failed", {}, this._hass));
      }
    } finally {
      if (requestId === this._loadRequestId) {
        this._loading = false;
        this._loadingListId = null;
        this._render();
      }
    }
  }

  async _run(action, fallback) {
    if (this._busy) return null;
    this._busy = true;
    try { const result = await action(); this._error = ""; return result; }
    catch (error) { this._error = error?.message || fallback; return null; }
    finally { this._busy = false; }
  }

  _clearModeTimer() {
    if (this._modeTimer) clearInterval(this._modeTimer);
    this._modeTimer = null;
    this._modeDeadline = 0;
    this._modeRemaining = 0;
  }

  _startModeTimer() {
    this._clearModeTimer();
    const timeout = this._config.mode_timeout;
    if (!timeout || this._mode === this._config.default_action) return;
    this._modeDeadline = Date.now() + timeout * 1000;
    this._modeRemaining = timeout;
    this._modeTimer = setInterval(() => {
      this._modeRemaining = Math.max(0, Math.ceil((this._modeDeadline - Date.now()) / 1000));
      if (this._modeRemaining <= 0) {
        this._clearModeTimer();
        this._mode = this._config.default_action;
        this._syncActiveScannerMode();
        this._render();
        return;
      }
      this._updateModeCountdown();
    }, 1000);
  }

  _updateModeCountdown() {
    const label = this.shadowRoot.querySelector(`[data-mode-label="${this._mode}"]`);
    if (label) label.textContent = `${MODES(this._hass)[this._mode].label}${this._modeRemaining ? ` (${this._modeRemaining})` : ""}`;
  }

  _selectMode(mode) {
    this._mode = mode;
    this._startModeTimer();
    this._syncActiveScannerMode();
    this._render();
  }

  _scannerTargetIsCurrentList() {
    return this._scannerTarget?.list_id === this._listId();
  }

  _scannerTargetName() {
    const list = this._inventoryLists.find((item) => item.id === this._scannerTarget?.list_id);
    return list?.name || haListManagerInventoryCardText("ui.another_inventory_list", {}, this._hass);
  }

  async _syncActiveScannerMode() {
    if (!this._scannerTargetIsCurrentList()) return;
    const result = await this._run(
      () => new HaListManagerClient(this._hass).setScannerTarget(this._listId(), this._mode),
      haListManagerInventoryCardText("errors.scanner_mode_update_failed", {}, this._hass),
    );
    if (result) this._scannerTarget = result.target;
  }

  async _activateScannerTarget() {
    const result = await this._run(
      () => new HaListManagerClient(this._hass).setScannerTarget(this._listId(), this._mode),
      haListManagerInventoryCardText("errors.inventory_target_enable_failed", {}, this._hass),
    );
    if (result) this._scannerTarget = result.target;
    this._render();
  }

  async _toggleScannerTarget() {
    if (this._scannerTargetIsCurrentList()) {
      const result = await this._run(
        () => new HaListManagerClient(this._hass).clearScannerTarget(),
        haListManagerInventoryCardText("errors.scanner_target_disable_failed", {}, this._hass),
      );
      if (result) this._scannerTarget = null;
      this._render();
      return;
    }
    if (this._scannerTarget?.list_id) {
      this._requestConfirmation(
        haListManagerInventoryCardText("scanner.confirm_switch_target", {}, this._hass),
        haListManagerInventoryCardText("scanner.confirm_switch_target_mode", {p0:(this._scannerTargetName()), p1:(this._config.title || haListManagerInventoryCardText("ui.inventory", {}, this._hass)), p2:(MODES(this._hass)[this._mode].label)}, this._hass),
        haListManagerInventoryCardText("ui.change_scanner_target", {}, this._hass),
        () => this._activateScannerTarget(),
        false,
      );
      return;
    }
    await this._activateScannerTarget();
  }

  async _handleProcessedScan(scan) {
    if (scan.list_id !== this._listId() || !scan.queued || !["queued", "offered", "needs_input"].includes(scan.status)) return;
    if (document.visibilityState !== "visible" || !this.isConnected || this.getClientRects().length === 0) return;
    if (scan.status === "offered") {
      try {
        const held = await new HaListManagerClient(this._hass).holdPendingScan(scan.id);
        scan = { ...scan, ...(held.scan || {}), queued: true };
      } catch (_error) {
        // Another visible card won the atomic claim.
        return;
      }
    }
    const pendingIndex = this._pendingScans.findIndex((item) => item.id === scan.id);
    if (pendingIndex === -1) this._pendingScans.unshift(scan);
    else this._pendingScans[pendingIndex] = scan;
    if (this._dialog || this._memberPicker || this._groupPicker || this._confirmation) {
      this._error = haListManagerInventoryCardText("scanner.another_open_ean", {p0:(scan.ean)}, this._hass);
      this._render();
      return;
    }
    await this._load(true);
    this._openPendingScan(scan);
  }

  _openPendingScan(scan) {
    if (!scan) return;
    this._pendingScanPicker = false;
    const entry = this._entries.find((item) => item.id === scan.inventory_entry_id || item.product_id === scan.product_id);
    if (entry) {
      this._openEditDialog(entry);
      this._dialog.pendingScan = scan;
      if (scan.action === "add") this._dialog.draft.stock = entry.stock + scan.quantity;
      else if (scan.action === "remove") this._dialog.draft.stock = Math.max(0, entry.stock - scan.quantity);
      this._rememberDialogState();
      this._setDialogStatus(haListManagerInventoryCardText("help.scan_pending_save", {}, this._hass), "warning");
      this._render();
      return;
    }
    const product = this._products.find((item) => item.id === scan.product_id);
    const stock = scan.action === "add" ? scan.quantity : 0;
    this._openAddDialog(product || null, product?.ean || scan.ean, stock);
    this._dialog.pendingScan = scan;
    this._setDialogStatus(
      scan.status === "needs_input"
        ? haListManagerInventoryCardText("scanner.correction_pending_help", {}, this._hass)
        : haListManagerInventoryCardText("ui.scan_pending_product_details", {}, this._hass),
      "warning",
    );
    this._render();
  }

  _touchModeTimer() {
    if (this._modeTimer) this._startModeTimer();
  }

  _replaceEntry(entry) {
    if (entry.undo_token) this._rememberInventoryUndo(entry.undo_token);
    const index = this._entries.findIndex((item) => item.id === entry.id);
    if (index === -1) this._entries.push(entry); else this._entries[index] = entry;
  }

  _inventoryUndoStorageKey() {
    return `ha-list-manager-inventory-undo:${this._hass?.user?.id || "local"}:${this._listId()}`;
  }

  _saveInventoryUndo() {
    const booking = this._lastInventoryBooking;
    if (!booking || booking.listId !== this._listId() || booking.userId !== (this._hass?.user?.id || "local")) return;
    try { sessionStorage.setItem(this._inventoryUndoStorageKey(), JSON.stringify({ ...booking, status: this._actionStatus })); }
    catch (_error) { /* Undo remains usable when browser storage is disabled. */ }
  }

  _restoreInventoryUndo() {
    if (!this._hass || !this._listId()) return;
    if (this._lastInventoryBooking?.listId === this._listId() && this._lastInventoryBooking.userId === (this._hass?.user?.id || "local")) return;
    clearTimeout(this._undoTimer);
    clearTimeout(this._undoCountdownTimer);
    this._lastInventoryBooking = null;
    this._undoChoice = false;
    try {
      const stored = JSON.parse(sessionStorage.getItem(this._inventoryUndoStorageKey()) || "null");
      if (!stored) return;
      if (stored.listId !== this._listId() || stored.userId !== (this._hass?.user?.id || "local") || typeof stored.token !== "string" ||
          !Number.isFinite(stored.expires) || stored.expires <= Date.now() || stored.expires > Date.now() + 60000) {
        sessionStorage.removeItem(this._inventoryUndoStorageKey());
        return;
      }
      this._actionStatus = typeof stored.status === "string" ? stored.status : haListManagerInventoryCardText("ui.last_transaction_undo_available", {}, this._hass);
      this._rememberInventoryUndo(stored.token, stored.transfer, stored.expires);
    } catch (_error) { /* Missing, malformed, or blocked storage must not prevent loading the card. */ }
  }

  _rememberInventoryUndo(token, transfer = null, expires = Date.now() + 60000) {
    if (!token) return;
    clearTimeout(this._undoTimer);
    clearTimeout(this._undoCountdownTimer);
    this._lastInventoryBooking = { token, transfer, expires, listId: this._listId(), userId: this._hass?.user?.id || "local" };
    this._saveInventoryUndo();
    const storageKey = this._inventoryUndoStorageKey();
    this._undoTimer = setTimeout(() => {
      clearTimeout(this._undoCountdownTimer);
      // Another card for this list may already have saved a newer booking.
      try {
        if (JSON.parse(sessionStorage.getItem(storageKey) || "null")?.token === token) sessionStorage.removeItem(storageKey);
      } catch (_error) {}
      this._lastInventoryBooking = null;
      this._undoChoice = false;
      this.shadowRoot.querySelector("[data-inventory-undo-choice]")?.remove();
      this.shadowRoot.querySelector("[data-undo-booking]")?.remove();
    }, Math.max(0, expires - Date.now()));
    this._updateInventoryUndoCountdown();
  }

  _updateInventoryUndoCountdown() {
    const booking = this._lastInventoryBooking;
    if (!booking) return;
    const remaining = Math.max(0, Math.ceil((booking.expires - Date.now()) / 1000));
    const counter = this.shadowRoot.querySelector("[data-undo-countdown]");
    if (counter) counter.textContent = `${remaining} s`;
    if (remaining > 0) this._undoCountdownTimer = setTimeout(() => this._updateInventoryUndoCountdown(), 1000);
  }

  async _undoInventoryBooking(includeTransfer = null) {
    const booking = this._lastInventoryBooking;
    if (this._busy || !booking || booking.listId !== this._listId()) return;
    if (booking.transfer && includeTransfer === null) { this._undoChoice = true; this._render(); return; }
    const result = await this._run(() => haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/inventory/undo`, token: booking.token, include_transfer: includeTransfer === true }), haListManagerInventoryCardText("ui.transaction_undo_failed", {}, this._hass));
    this._undoChoice = false;
    if (result) {
      clearTimeout(this._undoTimer);
      clearTimeout(this._undoCountdownTimer);
      try {
        const key = this._inventoryUndoStorageKey();
        if (JSON.parse(sessionStorage.getItem(key) || "null")?.token === booking.token) sessionStorage.removeItem(key);
      } catch (_error) {}
      this._lastInventoryBooking = null;
      this._actionStatus = result.transfer_kept ? haListManagerInventoryCardText("inventory.reset_restock_kept", {}, this._hass) : haListManagerInventoryCardText("inventory.last_transaction_undone", {}, this._hass);
      await this._load(true);
    }
    this._render();
  }

  _renderInventoryUndoChoice() {
    if (!this._undoChoice) return "";
    return `<div class="backdrop confirmation-backdrop" data-inventory-undo-choice><section class="dialog" role="alertdialog" aria-modal="true"><div class="dialog-header"><h3>${haListManagerInventoryCardText("inventory.undo_transaction", {}, this._hass)}</h3></div><p>${haListManagerInventoryCardText("ui.undo_restock_confirm", {p0:(this._lastInventoryBooking?.transfer?.quantity || 0)}, this._hass)}</p><div class="dialog-actions"><button type="button" data-undo-stock>${haListManagerInventoryCardText("ui.stock_only", {}, this._hass)}</button><button type="button" class="primary" data-undo-both>${haListManagerInventoryCardText("ui.stock_and_restock", {}, this._hass)}</button><button type="button" data-cancel-undo>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  async _adjust(id, delta) {
    const previous = Number(this._entries.find((entry) => entry.id === id)?.stock || 0);
    const result = await this._run(() => new HaListManagerClient(this._hass).adjustInventory(id, delta), haListManagerInventoryCardText("errors.stock_update_failed", {}, this._hass));
    if (result?.entry) {
      this._rememberInventoryUndo(result.undo_token, result.transfer);
      this._replaceEntry(result.entry);
      this._setInventoryActionStatus(result.entry, previous, Number(result.entry.stock || 0));
      this._touchModeTimer();
    }
    if (result?.needs_confirmation) {
      const quantity = Math.abs(delta);
      this._requestConfirmation(
        haListManagerInventoryCardText("inventory.stock_already_zero", {}, this._hass),
        `${result.confirmation?.message || haListManagerInventoryCardText("inventory.add_shopping_anyway_confirm", {}, this._hass)} (${quantity} × ${result.confirmation?.name || haListManagerInventoryCardText("ui.item", {}, this._hass)})`,
        haListManagerInventoryCardText("shopping.add_to_list", {}, this._hass),
        async () => {
          const confirmed = await this._run(
            () => new HaListManagerClient(this._hass).confirmZeroRestock(id, quantity),
            haListManagerInventoryCardText("ui.shopping_add_failed", {}, this._hass),
          );
          if (confirmed?.transfer) this._actionStatus = haListManagerInventoryCardText("shopping.quantity_added", {p0:(quantity), p1:(confirmed.transfer.name)}, this._hass);
          await this._load(true);
        },
        false,
      );
      return result;
    }
    if (result?.transfer) {
      const info = result.transfer.already_open ? (" " + haListManagerInventoryCardText("shopping.already_open_suffix", {p0:(result.transfer.already_open)}, this._hass)) : "";
      this._actionStatus = result.transfer.mode === "fixed"
        ? haListManagerInventoryCardText("ui.fixed_restock_completed", {p0:(result.transfer.quantity), p1:(result.transfer.name), p2:(info)}, this._hass)
        : haListManagerInventoryCardText("inventory.restock_completed", {quantity: result.transfer.quantity, name: result.transfer.name, info}, this._hass);
      await this._load(true);
    }
    this._render();
    return result;
  }

  async _adjustFromInput(entry, delta) {
    const result = await this._adjust(entry.id, delta);
    if (result?.entry) {
      this._rememberBrowserChip(entry.product?.name || result.entry.product?.name, entry.product || result.entry.product);
      this._inputValue = "";
      this._selectedProduct = null;
      this._render();
    }
    return result;
  }

  _setInventoryActionStatus(entry, previous, next) {
    const name = entry?.product?.name || haListManagerInventoryCardText("ui.item", {}, this._hass);
    if (next > previous) this._actionStatus = haListManagerInventoryCardText("ui.stock_increased_result", {p0:(name), p1:(previous), p2:(next)}, this._hass);
    else if (next < previous) this._actionStatus = haListManagerInventoryCardText("inventory.stock_reduced_details", {p0:(name), p1:(previous), p2:(next)}, this._hass);
    else this._actionStatus = haListManagerInventoryCardText("inventory.stock_unchanged", {p0:(name), p1:(next)}, this._hass);
  }

  async _setHidden(id, hidden) {
    const result = await this._run(() => new HaListManagerClient(this._hass).setInventoryHidden(id, hidden), haListManagerInventoryCardText("ui.visibility_change_failed", {}, this._hass));
    if (result?.entry) this._replaceEntry(result.entry);
    this._render();
  }

  _quantity() {
    const value = Number(this.shadowRoot.querySelector("[data-quantity]")?.value || 1);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  _matchProduct(value) {
    if (this._selectedProduct) return this._selectedProduct;
    const normalized = value.trim().toLocaleLowerCase();
    return this._products.find((product) => product.name.toLocaleLowerCase() === normalized || product.ean === value.trim()) || null;
  }

  async _performInputAction() {
    const input = this.shadowRoot.querySelector("[data-product-input]");
    const value = input?.value.trim() || "";
    if (!value) { this._error = haListManagerInventoryCardText("errors.enter_item_or_ean", {}, this._hass); this._render(); return; }
    this._error = "";
    this._actionStatus = "";
    let product = this._matchProduct(value);
    const isEan = /^\d{4,32}$/.test(value);
    if (!product && isEan) {
      const lookup = await this._run(
        () => new HaListManagerClient(this._hass).lookupInventoryProduct(value),
        haListManagerInventoryCardText("errors.ean_lookup_failed", {}, this._hass),
      );
      if (!lookup?.product) {
        if (["add", "register"].includes(this._mode)) {
          this._error = "";
          this._openAddDialog(null, value, this._mode === "add" ? this._quantity() : 0);
          this._setDialogStatus(haListManagerInventoryCardText("ui.ean_no_product_data", {}, this._hass), "warning", "ean");
          this._render();
        } else this._render();
        return;
      }
      product = lookup.product;
      if (lookup.local && !this._products.some((item) => item.id === product.id)) this._products.push(product);
      const lookedUpEntry = lookup.local ? this._entries.find((item) => item.product_id === product.id) : null;
      if (this._mode === "add" && lookedUpEntry) { await this._adjustFromInput(lookedUpEntry, this._quantity()); return; }
      if (this._mode === "remove" || this._mode === "correct") {
        if (!lookedUpEntry) { this._error = haListManagerInventoryCardText("inventory.item_missing", {}, this._hass); this._render(); return; }
        if (this._mode === "remove") await this._adjustFromInput(lookedUpEntry, -this._quantity());
        else this._openEditDialog(lookedUpEntry);
        return;
      }
    }
    const entry = product ? this._entries.find((item) => item.product_id === product.id) : null;
    const quantity = this._quantity();
    if (this._mode === "add" && entry) { await this._adjustFromInput(entry, quantity); return; }
    if (this._mode === "remove") {
      if (!entry) { this._error = haListManagerInventoryCardText("inventory.item_missing", {}, this._hass); this._render(); return; }
      await this._adjustFromInput(entry, -quantity); return;
    }
    if (this._mode === "correct") {
      if (!entry) { this._error = haListManagerInventoryCardText("inventory.item_not_registered", {}, this._hass); this._render(); return; }
      this._openEditDialog(entry); return;
    }
    if (this._mode === "register" && entry) { this._openEditDialog(entry); return; }
    this._openAddDialog(product, value, quantity);
  }

  async _useChip(chip) {
    if (!chip || this._busy) return;
    let product = chip.product_id ? this._products.find((entry) => entry.id === chip.product_id) || null : null;
    if (!product && chip.product_id) {
      try {
        const result = await haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/products/list`, search: chip.product_name || chip.name, limit: 100, offset: 0 });
        product = (result.products || []).find((entry) => entry.id === chip.product_id) || null;
      } catch (error) { this._error = error?.message || String(error); this._render(); return; }
    }
    this._inputValue = product?.name || chip.name;
    this._selectedProduct = product;
    const input = this.shadowRoot.querySelector("[data-product-input]");
    if (input) input.value = this._inputValue;
    await this._performInputAction();
    this._inputValue = "";
    this._selectedProduct = null;
    this._render();
  }

  async _loadCameraScannerLibrary() {
    if (window.Html5QrcodeScanner) return;
    if (!window.__sliHtml5QrcodePromise) {
      window.__sliHtml5QrcodePromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error(haListManagerInventoryCardText("errors.scanner_library_load_failed", {}, this._hass)));
        document.head.appendChild(script);
      }).finally(() => { window.__sliHtml5QrcodePromise = null; });
    }
    await window.__sliHtml5QrcodePromise;
  }

  async _startCameraScan() {
    if (this._scannerStarting || this._cameraScanner) return;
    const hostname = String(window.location?.hostname || "").toLowerCase();
    const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (!window.isSecureContext && !local) {
      this._error = haListManagerInventoryCardText("ui.camera_https_required", {}, this._hass);
      this._render();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this._error = haListManagerInventoryCardText("scanner.camera_unavailable", {}, this._hass);
      this._render();
      return;
    }
    this._scannerStarting = true;
    const overlay = document.createElement("div");
    const readerId = `ha-list-manager-inventory-camera-${Math.random().toString(36).slice(2)}`;
    overlay.className = "ha-list-manager-inventory-camera-overlay";
    overlay.innerHTML = `<div class="ha-list-manager-inventory-camera-dialog"><div id="${readerId}"></div><button type="button">${haListManagerInventoryCardText("ui.close", {}, this._hass)}</button></div>`;
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "10000", display: "grid", placeItems: "center", padding: "16px", background: "rgba(0,0,0,.7)" });
    const panel = overlay.firstElementChild;
    Object.assign(panel.style, { width: "min(460px,100%)", maxHeight: "calc(100vh - 32px)", overflow: "auto", padding: "16px", borderRadius: "12px", background: "var(--card-background-color,#fff)", color: "var(--primary-text-color,#212121)" });
    const close = overlay.querySelector("button");
    Object.assign(close.style, { minHeight: "42px", marginTop: "12px", padding: "0 18px", border: "0", borderRadius: "21px", color: "#fff", background: "var(--primary-color,#03a9f4)", cursor: "pointer" });
    close.addEventListener("click", () => this._stopCameraScan());
    overlay.addEventListener("click", (event) => { if (event.target === overlay) this._stopCameraScan(); });
    document.body.appendChild(overlay);
    this._cameraOverlay = overlay;
    try {
      await this._loadCameraScannerLibrary();
      if (!this._scannerStarting || !overlay.isConnected || !window.Html5QrcodeScanner) return;
      const permission = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      permission.getTracks().forEach((track) => track.stop());
      if (!this._scannerStarting || !overlay.isConnected) return;
      this._cameraScanner = new window.Html5QrcodeScanner(readerId, { fps: 10, qrbox: 250, showTorchButton: true }, false);
      this._cameraScanner.render((decodedText) => this._handleCameraScan(decodedText));
    } catch (error) {
      await this._stopCameraScan();
      this._error = error?.message || haListManagerInventoryCardText("ui.camera_start_failed", {}, this._hass);
      this._render();
    } finally {
      this._scannerStarting = false;
    }
  }

  async _handleCameraScan(decodedText) {
    if (this._busy) return;
    const value = String(decodedText || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
    await this._stopCameraScan();
    if (!value) return;
    this._inputValue = value;
    this._selectedProduct = null;
    this._render();
    const input = this.shadowRoot.querySelector("[data-product-input]");
    if (input) input.value = value;
    await this._performInputAction();
  }

  async _stopCameraScan() {
    const scanner = this._cameraScanner;
    this._cameraScanner = null;
    try { if (scanner) await scanner.clear(); } catch (_error) { /* Scanner may already be stopped. */ }
    this._cameraOverlay?.remove();
    this._cameraOverlay = null;
    this._scannerStarting = false;
  }

  _openAddDialog(product, value, quantity) {
    const isEan = /^\d{4,32}$/.test(value.trim());
    this._clearDialogStatus();
    const preferredCategory = this._preferredCategory(product);
    this._dialog = {
      kind: "add",
      product,
      draft: this._productDialogDraft(product, {
        name: product?.name || (isEan ? "" : value.trim()),
        ean: product?.ean || (isEan ? value.trim() : ""),
        stock: quantity,
        minimum_stock: "",
        category_id: preferredCategory.id,
        category_name: preferredCategory.name,
      }),
    };
    this._rememberDialogState();
    this._render();
  }

  _preferredCategory(product) {
    const selected = this._selectedCategoryIds?.size === 1 && !this._selectedCategoryIds.has("__uncategorized__") ? [...this._selectedCategoryIds][0] : "";
    if (selected) {
      const category = this._categories.find((item) => item.id === selected);
      if (category) return { id: category.id, name: category.name };
    }
    const productCategory = this._productDefaultCategory(product);
    if (productCategory) return { id: productCategory.id.startsWith("product:") ? "" : productCategory.id, name: productCategory.name };
    return { id: "", name: "" };
  }

  _productDefaultCategory(product) {
    const byId = new Map(this._categories.map((category) => [category.id, category]));
    const assignments = Array.isArray(product?.category_assignments) ? product.category_assignments : [];
    const preferred = [
      assignments.find((item) => item.scope === "list" && item.list_id === this._listId()),
      assignments.find((item) => item.scope === "list_type" && item.list_type === "inventory"),
      assignments.find((item) => item.scope === "global"),
    ].find((item) => item && byId.has(item.category_id));
    if (preferred) return byId.get(preferred.category_id);
    return null;
  }

  _effectiveEntryCategory(entry) {
    const dynamicName = String(entry.category_name || "").trim();
    if (entry.category_id && entry.category) return entry.category;
    if (dynamicName) return { id: `dynamic:${dynamicName.toLocaleLowerCase()}`, name: dynamicName, icon: "mdi:shape-outline", color: null, position: 999999, dynamic: true };
    return this._productDefaultCategory(entry.product);
  }

  _categoryContextProduct() {
    if (this._dialog?.kind === "add") return this._dialog.product || this._products.find((product) => product.id === this._dialog.draft.product_id) || null;
    if (this._dialog?.kind === "edit") return this._dialog.entry?.product || null;
    return null;
  }

  _openEditDialog(entry) { this._clearDialogStatus(); this._dialog = { kind: "edit", entry, draft: { stock: entry.stock, minimum_stock: entry.minimum_stock ?? "", category_id: entry.category_id || "", category_name: entry.category_name || entry.category?.name || "" } }; this._rememberDialogState(); this._render(); }
  _openProductEditDialog(entry) {
    const product = entry.product;
    this._clearDialogStatus();
    this._dialog = { kind: "product-edit", entry, draft: this._productDialogDraft(product) };
    this._rememberDialogState();
    this._render();
  }

  _productDialogDraft(product = null, overrides = {}) {
    const name = overrides.name ?? product?.name ?? "";
    const brand = overrides.brand ?? product?.brand ?? "";
    const packageQuantity = overrides.package_quantity ?? product?.package_quantity ?? "";
    const parsedName = this._parseProductName(name, brand, packageQuantity);
    return {
      product_id: product?.id || "",
      name: parsedName.name,
      base_name: parsedName.base_name,
      append_brand: parsedName.append_brand,
      append_quantity: parsedName.append_quantity,
      original_name: product?.original_name || "",
      ean: product?.ean || "",
      brand,
      package_quantity: packageQuantity,
      image_url: product?.image_url || "",
      label_ids: (product?.labels || []).map((label) => label.id),
      ...overrides,
    };
  }

  _openGroupDialog(group = null, memberIds = []) {
    const record = group ? this._inventoryGroups.find((item) => item.id === group.id) || group : null;
    this._clearDialogStatus();
    this._dialog = {
      kind: "group-edit",
      group: record,
      draft: {
        name: record?.name || "",
        minimum_stock: record?.minimum_stock ?? "",
        category_id: record?.category_id || "",
        category_name: record?.category_name || record?.category?.name || "",
        member_ids: [...(record?.member_ids || memberIds)],
      },
    };
    this._rememberDialogState();
    this._render();
  }

  _groupForEntry(entryId) {
    return this._inventoryGroups.find((group) => (group.member_ids || []).includes(entryId)) || null;
  }

  _replaceDialog(action) {
    if (this._isDialogDirty(true)) {
      this._requestConfirmation(
        haListManagerInventoryCardText("ui.discard_changes_confirm", {}, this._hass),
        haListManagerInventoryCardText("ui.dialog_changes_unsaved", {}, this._hass),
        haListManagerInventoryCardText("ui.discard_changes", {}, this._hass),
        action,
      );
      return;
    }
    action();
  }

  _openMemberPicker() {
    if (this._dialog?.kind !== "group-edit") return;
    this._syncDialogDraft();
    this._memberPicker = { query: "", selected_ids: new Set(), show_grouped: false };
    this._render();
  }

  _memberPickerMatches() {
    if (!this._memberPicker || this._dialog?.kind !== "group-edit") return [];
    const current = new Set(this._dialog.draft.member_ids || []);
    const grouped = this._entryGroupMap();
    const query = this._memberPicker.query.trim().toLocaleLowerCase();
    return [...this._entries]
      .filter((entry) => !current.has(entry.id))
      .filter((entry) => this._memberPicker.show_grouped || this._memberPicker.selected_ids.has(entry.id) || !grouped.has(entry.id))
      .filter((entry) => !query || this._entrySearchValues(entry).some((value) => value.includes(query)))
      .sort((a, b) => a.product.name.localeCompare(b.product.name));
  }

  _renderMemberPickerChoices() {
    const groupByEntry = this._entryGroupMap();
    const matches = this._memberPickerMatches();
    if (!matches.length) return `<p class="picker-empty">${haListManagerInventoryCardText("ui.no_other_matching_items", {}, this._hass)}</p>`;
    const choices = matches.slice(0, PICKER_RESULT_LIMIT).map((entry) => {
      const selected = this._memberPicker.selected_ids.has(entry.id);
      const otherGroup = this._inventoryGroups.find((group) => group.id === groupByEntry.get(entry.id));
      return `<label class="picker-choice${otherGroup ? " belongs-to-group" : ""}"><input type="checkbox" data-member-picker-entry="${escapeHtml(entry.id)}" ${selected ? "checked" : ""}><span><strong>${escapeHtml(entry.product.name)}</strong><small>${haListManagerInventoryCardText("inventory.stock_value", {p0:(entry.stock)}, this._hass)}</small>${otherGroup ? `<small class="move-note"><ha-icon icon="mdi:alert-outline"></ha-icon>${haListManagerInventoryCardText("ui.current_group_move_hint", {p0:(escapeHtml(otherGroup.name))}, this._hass)}</small>` : ""}</span></label>`;
    }).join("");
    const limit = matches.length > PICKER_RESULT_LIMIT
      ? `<p class="picker-limit">${haListManagerInventoryCardText("ui.items_shown_search_more", {p0:(PICKER_RESULT_LIMIT), p1:(matches.length)}, this._hass)}</p>`
      : "";
    return `${choices}${limit}`;
  }

  _renderMemberPicker() {
    if (!this._memberPicker) return "";
    return `<div class="backdrop nested-backdrop" data-member-picker-backdrop><section class="dialog picker-dialog" role="dialog" aria-modal="true"><div class="dialog-header"><div><h3>${haListManagerInventoryCardText("ui.add_members", {}, this._hass)}</h3><p class="field-help">${haListManagerInventoryCardText("inventory.group_members_search_help", {}, this._hass)}</p></div><button class="icon-button" data-close-member-picker title="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="group-move-warning"><ha-icon icon="mdi:alert-outline"></ha-icon><span>${haListManagerInventoryCardText("help.inventory_group_membership", {}, this._hass)}</span><label class="show-grouped-toggle"><input type="checkbox" data-show-grouped-members ${this._memberPicker.show_grouped ? "checked" : ""}>${haListManagerInventoryCardText("ui.show_grouped_items", {}, this._hass)}</label></div><div class="picker-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" value="${escapeHtml(this._memberPicker.query)}" placeholder="${haListManagerInventoryCardText("ui.search_item_brand_ean", {}, this._hass)}" autocomplete="off" data-member-picker-search></div><div class="picker-list" data-member-picker-list>${this._renderMemberPickerChoices()}</div><div class="dialog-actions"><button class="primary" data-apply-member-picker ${this._memberPicker.selected_ids.size ? "" : "disabled"}>${this._memberPicker.selected_ids.size ? haListManagerInventoryCardText("ui.add_named", {p0:(this._memberPicker.selected_ids.size)}, this._hass) : haListManagerInventoryCardText("ui.select_item", {}, this._hass)}</button><button data-close-member-picker>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _applyMemberPicker() {
    if (!this._memberPicker || this._dialog?.kind !== "group-edit") return;
    this._dialog.draft.member_ids = [...new Set([...(this._dialog.draft.member_ids || []), ...this._memberPicker.selected_ids])];
    this._memberPicker = null;
    this._render();
  }

  _openGroupPicker(entry) {
    this._groupPicker = { entry, query: "" };
    this._render();
  }

  _groupPickerMatches() {
    if (!this._groupPicker) return [];
    const current = this._groupForEntry(this._groupPicker.entry.id);
    const query = this._groupPicker.query.trim().toLocaleLowerCase();
    return this._inventoryGroups
      .filter((group) => group.id !== current?.id)
      .filter((group) => !query || group.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _renderGroupPickerChoices() {
    const matches = this._groupPickerMatches();
    if (!matches.length) return `<p class="picker-empty">${haListManagerInventoryCardText("ui.no_other_group_matches", {}, this._hass)}</p>`;
    return matches.map((group) => `<button type="button" class="group-picker-choice" data-join-group="${escapeHtml(group.id)}"><ha-icon icon="mdi:group"></ha-icon><span><strong>${escapeHtml(group.name)}</strong><small>${haListManagerInventoryCardText("ui.members_count", {p0:(group.member_ids.length)}, this._hass)}</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button>`).join("");
  }

  _renderGroupPicker() {
    if (!this._groupPicker) return "";
    return `<div class="backdrop nested-backdrop" data-group-picker-backdrop><section class="dialog picker-dialog" role="dialog" aria-modal="true"><div class="dialog-header"><div><h3>${haListManagerInventoryCardText("ui.select_group", {}, this._hass)}</h3><p class="field-help">${haListManagerInventoryCardText("inventory.member_add_selected", {p0:(escapeHtml(this._groupPicker.entry.product.name))}, this._hass)}</p></div><button class="icon-button" data-close-group-picker title="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="picker-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" value="${escapeHtml(this._groupPicker.query)}" placeholder="${haListManagerInventoryCardText("ui.search_group", {}, this._hass)}" autocomplete="off" data-group-picker-search></div><div class="picker-list" data-group-picker-list>${this._renderGroupPickerChoices()}</div><div class="dialog-actions"><button data-new-group-for-entry="${escapeHtml(this._groupPicker.entry.id)}"><ha-icon icon="mdi:group-plus"></ha-icon>${haListManagerInventoryCardText("ui.create_new_group", {}, this._hass)}</button><button data-close-group-picker>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _requestGroupMove(entry, targetDescription, action) {
    const source = this._groupForEntry(entry.id);
    if (!source) { action(); return; }
    const dissolves = (source.member_ids || []).length <= 2;
    this._requestConfirmation(
      dissolves ? haListManagerInventoryCardText("ui.move_dissolve_group_confirm", {}, this._hass) : haListManagerInventoryCardText("ui.move_item_group_confirm", {}, this._hass),
      dissolves
        ? haListManagerInventoryCardText("ui.move_item_dissolve_warning", {p0:(entry.product.name), p1:(source.name), p2:(targetDescription)}, this._hass)
        : haListManagerInventoryCardText("inventory.member_move_assignment", {p0:(entry.product.name), p1:(source.name), p2:(targetDescription)}, this._hass),
      haListManagerInventoryCardText("ui.move_item", {}, this._hass),
      action,
      false,
    );
  }

  _selectEntryForGroup(entry) {
    if (this._selectedEntryIds.has(entry.id)) {
      this._selectedEntryIds.delete(entry.id);
      this._render();
      return;
    }
    this._requestGroupMove(entry, haListManagerInventoryCardText("ui.new_group_fragment", {}, this._hass), () => {
      this._selectedEntryIds.add(entry.id);
      this._render();
    });
  }

  _openNewGroupForEntry(entry) {
    this._requestGroupMove(entry, haListManagerInventoryCardText("ui.new_group_fragment", {}, this._hass), () => {
      this._groupPicker = null;
      this._replaceDialog(() => this._openGroupDialog(null, [entry.id]));
    });
  }

  _groupPayload(group, memberIds) {
    return { name: group.name, minimum_stock: group.minimum_stock, category_id: group.category_id || null, category: group.category_id ? null : (group.category_name || null), member_ids: memberIds };
  }

  async _joinGroup(entry, group) {
    const memberIds = [...new Set([...(group.member_ids || []), entry.id])];
    const result = await this._run(() => new HaListManagerClient(this._hass).updateInventoryGroup(group.id, this._groupPayload(group, memberIds)), haListManagerInventoryCardText("errors.group_item_add_failed", {}, this._hass));
    if (!result?.group) { this._render(); return; }
    this._groupPicker = null;
    await this._load(true);
    if (this._dialog?.kind === "edit" && this._dialog.entry.id === entry.id) {
      this._dialog.entry = this._entries.find((item) => item.id === entry.id) || this._dialog.entry;
      this._setDialogStatus(haListManagerInventoryCardText("inventory.item_group_assigned", {p0:(group.name)}, this._hass), "success");
      this._render();
    }
  }

  _requestRemoveEntryFromGroup(entry, group) {
    const remaining = (group.member_ids || []).filter((id) => id !== entry.id);
    const dissolves = remaining.length < 2;
    this._requestConfirmation(
      dissolves ? haListManagerInventoryCardText("inventory.confirm_dissolve_group", {}, this._hass) : haListManagerInventoryCardText("ui.remove_group_item_confirm", {}, this._hass),
      dissolves
        ? haListManagerInventoryCardText("inventory.remove_member_dissolves_group", {p0:(entry.product.name), p1:(group.name)}, this._hass)
        : haListManagerInventoryCardText("inventory.remove_member_named", {p0:(entry.product.name), p1:(group.name)}, this._hass),
      dissolves ? haListManagerInventoryCardText("ui.dissolve_group", {}, this._hass) : haListManagerInventoryCardText("ui.remove_item", {}, this._hass),
      () => this._removeEntryFromGroup(entry, group, remaining),
    );
  }

  async _removeEntryFromGroup(entry, group, remaining) {
    const client = new HaListManagerClient(this._hass);
    const result = remaining.length < 2
      ? await this._run(() => client.deleteInventoryGroup(group.id), haListManagerInventoryCardText("errors.group_dissolve_failed", {}, this._hass))
      : await this._run(() => client.updateInventoryGroup(group.id, this._groupPayload(group, remaining)), haListManagerInventoryCardText("errors.group_item_remove_failed", {}, this._hass));
    if (result === null) { this._render(); return; }
    await this._load(true);
    if (this._dialog?.kind === "edit" && this._dialog.entry.id === entry.id) {
      this._dialog.entry = this._entries.find((item) => item.id === entry.id) || this._dialog.entry;
      this._setDialogStatus(remaining.length < 2 ? haListManagerInventoryCardText("inventory.group_dissolved", {}, this._hass) : haListManagerInventoryCardText("inventory.item_group_removed", {}, this._hass), "success");
      this._render();
    }
  }

  _dialogState(dialog = this._dialog) {
    if (!dialog?.draft) return "";
    const normalize = (value, key = "") => {
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) {
        const normalized = value.map((item) => normalize(item));
        return ["label_ids", "member_ids"].includes(key) ? normalized.sort() : normalized;
      }
      if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((childKey) => [childKey, normalize(value[childKey], childKey)]));
      if (typeof value === "number") return String(value);
      return value;
    };
    return JSON.stringify(normalize(dialog.draft));
  }

  _rememberDialogState() {
    if (this._dialog?.draft) this._dialog.initialState = this._dialogState();
  }

  _isDialogDirty(sync = false) {
    const dialog = this._dialog?.kind === "image" ? this._dialog.parent : this._dialog;
    if (!dialog?.draft || dialog.initialState === undefined) return false;
    if (sync && dialog === this._dialog) this._syncDialogDraft();
    return dialog.initialState !== this._dialogState(dialog);
  }

  _updateDialogDirtyIndicator() {
    const indicator = this.shadowRoot.querySelector("[data-unsaved-indicator]");
    if (indicator) indicator.hidden = !this._isDialogDirty(true);
  }

  _dialogHeader(title) {
    return `<div class="dialog-header"><div class="dialog-heading"><h3>${escapeHtml(title)}</h3><span class="unsaved-indicator" data-unsaved-indicator ${this._isDialogDirty() ? "" : "hidden"}><ha-icon icon="mdi:content-save-alert-outline"></ha-icon>${haListManagerInventoryCardText("ui.not_saved_yet", {}, this._hass)}</span></div><button class="icon-button" data-close-dialog title="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>`;
  }

  _closeDialog() {
    if (this._busy || !this._dialog) return;
    if (this._dialog.kind === "image") {
      this._dialog = this._dialog.parent || null;
      this._render();
      return;
    }
    if (this._isDialogDirty(true)) {
      this._requestConfirmation(
        haListManagerInventoryCardText("ui.discard_changes_confirm", {}, this._hass),
        haListManagerInventoryCardText("ui.dialog_changes_unsaved", {}, this._hass),
        haListManagerInventoryCardText("ui.discard_changes", {}, this._hass),
        () => this._discardDialog(),
      );
      return;
    }
    this._discardDialog();
  }

  _discardDialog() {
    this._dialog = null;
    this._memberPicker = null;
    this._groupPicker = null;
    this._clearDialogStatus();
    this._render();
  }

  _requestConfirmation(title, message, confirmLabel, action, danger = true) {
    this._confirmation = { title, message, confirmLabel, action, danger };
    this._render();
  }

  async _resolveConfirmation(accepted) {
    const confirmation = this._confirmation;
    this._confirmation = null;
    if (!accepted || !confirmation?.action) { this._render(); return; }
    await confirmation.action();
  }

  _renderConfirmation() {
    if (!this._confirmation) return "";
    const confirmation = this._confirmation;
    return `<div class="backdrop confirmation-backdrop" data-confirmation-backdrop><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true"><div class="confirmation-icon ${confirmation.danger ? "danger" : "warning"}"><ha-icon icon="mdi:${confirmation.danger ? "alert-outline" : "help-circle-outline"}"></ha-icon></div><h3>${escapeHtml(confirmation.title)}</h3><p>${escapeHtml(confirmation.message)}</p><div class="dialog-actions"><button class="${confirmation.danger ? "danger filled" : "primary"}" data-confirm-accept>${escapeHtml(confirmation.confirmLabel)}</button><button data-confirm-cancel>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _inventoryControlCodes() {
    const listId = this._listId();
    return [
      ["add", haListManagerInventoryCardText("ui.stock_in", {}, this._hass), "mdi:package-variant-plus"],
      ["remove", haListManagerInventoryCardText("inventory.withdraw", {}, this._hass), "mdi:package-variant-minus"],
      ["register", haListManagerInventoryCardText("ui.register", {}, this._hass), "mdi:package-variant"],
      ["correct", haListManagerInventoryCardText("inventory.correct", {}, this._hass), "mdi:square-edit-outline"],
    ].map(([action, label, icon]) => ({
      action, label, icon,
      value: `HA-LM:INVENTORY:${listId}:${action.toUpperCase()}`,
    }));
  }

  _renderControlCodes() {
    if (!this._controlCodesOpen) return "";
    const codes = this._inventoryControlCodes();
    return `<div class="backdrop control-codes-backdrop" data-control-codes-backdrop><section class="dialog control-codes-dialog" role="dialog" aria-modal="true" aria-label="${haListManagerInventoryCardText("ui.stock_mode_qr_codes", {}, this._hass)}"><div class="dialog-header"><div><h3>${haListManagerInventoryCardText("ui.stock_mode_qr_codes", {}, this._hass)}</h3><p class="field-help">${haListManagerInventoryCardText("help.scan_mode_qr_code", {}, this._hass)}</p></div><button class="icon-button" type="button" data-close-control-codes title="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="control-code-grid">${codes.map((code) => `<article class="control-code"><div class="control-code-qr" data-control-code="${escapeHtml(code.value)}" aria-label="${haListManagerInventoryCardText("scanner.qr_code_named", {p0:(escapeHtml(code.label))}, this._hass)}"></div><div><strong><ha-icon icon="${escapeHtml(code.icon)}"></ha-icon>${escapeHtml(code.label)}</strong><code>${escapeHtml(code.value)}</code></div></article>`).join("")}</div><div class="dialog-actions"><button type="button" data-close-control-codes>${haListManagerInventoryCardText("ui.close", {}, this._hass)}</button></div></section></div>`;
  }

  async _drawControlCodes() {
    const holders = [...this.shadowRoot.querySelectorAll("[data-control-code]")];
    if (!holders.length) return;
    try {
      if (!window.QRCode) {
        if (!window._sliQrCodeLoadPromise) {
          window._sliQrCodeLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          }).catch((error) => { window._sliQrCodeLoadPromise = null; throw error; });
        }
        await window._sliQrCodeLoadPromise;
      }
      if (!this._controlCodesOpen) return;
      holders.forEach((holder) => {
        holder.replaceChildren();
        new window.QRCode(holder, {
          text: holder.dataset.controlCode, width: 156, height: 156,
          colorDark: "#000000", colorLight: "#ffffff",
          correctLevel: window.QRCode.CorrectLevel.M,
        });
      });
    } catch (error) {
      console.warn("[ha-list-manager] QR generation", error);
      holders.forEach((holder) => {
        holder.classList.add("control-code-fallback");
        holder.textContent = holder.dataset.controlCode;
      });
    }
  }

  _openControlCodes() {
    this._headerMenuOpen = false;
    this._controlCodesOpen = true;
    this._render();
  }

  _closeControlCodes() {
    this._controlCodesOpen = false;
    this._render();
  }

  _clearDialogStatus() {
    this._dialogStatus = "";
    this._dialogStatusTone = "info";
    this._dialogStatusTarget = "general";
  }

  _setDialogStatus(message, tone = "info", target = "general") {
    this._dialogStatus = message;
    this._dialogStatusTone = tone;
    this._dialogStatusTarget = target;
  }

  _renderDialogStatus(target = "general") {
    if (!this._dialogStatus || this._dialogStatusTarget !== target) return "";
    return `<p class="dialog-status ${escapeHtml(this._dialogStatusTone)}"><ha-icon icon="mdi:${this._dialogStatusTone === "success" ? "check-circle-outline" : this._dialogStatusTone === "warning" ? "alert-outline" : this._dialogStatusTone === "error" ? "alert-circle-outline" : "information-outline"}"></ha-icon><span>${escapeHtml(this._dialogStatus)}</span></p>`;
  }

  _parseProductName(name, brand, quantity) {
    let base = String(name || "").trim();
    let appendQuantity = false;
    let appendBrand = false;
    if (quantity && base.endsWith(` – ${quantity}`)) { base = base.slice(0, -(` – ${quantity}`).length); appendQuantity = true; }
    if (brand && base.endsWith(` – ${brand}`)) { base = base.slice(0, -(` – ${brand}`).length); appendBrand = true; }
    return { name: String(name || "").trim(), base_name: base, append_brand: appendBrand, append_quantity: appendQuantity };
  }

  _composeProductName(draft) {
    const base = String(draft.base_name || draft.name || draft.original_name || "").trim();
    const parts = [base];
    if (draft.append_brand && draft.brand && !base.toLocaleLowerCase().includes(String(draft.brand).toLocaleLowerCase())) parts.push(draft.brand);
    if (draft.append_quantity && draft.package_quantity) parts.push(draft.package_quantity);
    return parts.filter(Boolean).join(" – ");
  }

  _toggleNameComponent(component) {
    this._syncDialogDraft();
    const draft = this._dialog?.draft;
    if (!draft) return;
    if (component === "brand") {
      const alreadyIncluded = draft.brand && String(draft.base_name || draft.name).toLocaleLowerCase().includes(String(draft.brand).toLocaleLowerCase());
      if (alreadyIncluded && !draft.append_brand) this._setDialogStatus(haListManagerInventoryCardText("products.brand_already_in_name", {}, this._hass), "warning");
      else draft.append_brand = !draft.append_brand;
    } else draft.append_quantity = !draft.append_quantity;
    draft.name = this._composeProductName(draft);
    this._render();
  }

  _syncDialogDraft() {
    if (!this._dialog) return;
    const productFields = ["name", "original_name", "ean", "brand", "package_quantity", "image_url"];
    const fields = this._dialog.kind === "group-edit"
      ? ["name", "minimum_stock"]
      : this._dialog.kind === "add"
      ? [...productFields, "stock", "minimum_stock"]
      : this._dialog.kind === "product-edit"
        ? [...productFields, "category"]
        : ["stock", "minimum_stock"];
    for (const field of fields) {
      const element = this.shadowRoot.querySelector(`[data-field="${field}"]`);
      if (element) this._dialog.draft[field] = element.value;
    }
  }

  async _lookupDialogEan() {
    this._syncDialogDraft();
    const ean = this._dialog?.draft.ean?.trim();
    if (!/^\d{4,32}$/.test(ean || "")) { this._setDialogStatus(haListManagerInventoryCardText("errors.ean_digits_required", {}, this._hass), "error", "ean"); this._render(); return; }
    const keepCustomName = this._dialog.kind === "product-edit";
    const client = new HaListManagerClient(this._hass);
    if (this._busy) return;
    this._busy = true;
    let result;
    try {
      result = await (keepCustomName ? client.lookupProduct(ean, this._dialog.entry.product.id) : client.lookupInventoryProduct(ean));
      this._error = "";
    } catch (error) {
      if (error?.code === "product_not_found") this._setDialogStatus(haListManagerInventoryCardText("products.ean_data_not_found", {}, this._hass), "warning", "ean");
      else this._setDialogStatus(error?.message || haListManagerInventoryCardText("errors.openfoodfacts_load_failed", {}, this._hass), "error", "ean");
      this._busy = false;
      this._render();
      return;
    }
    this._busy = false;
    if (!result?.product) { this._setDialogStatus(haListManagerInventoryCardText("products.ean_data_not_found", {}, this._hass), "warning", "ean"); this._render(); return; }
    const product = result.product;
    const currentName = this._dialog.draft.name;
    const currentBaseName = this._dialog.draft.base_name;
    this._dialog.product = result.local ? product : null;
    const parsedName = this._parseProductName(product.name || this._dialog.draft.name, product.brand, product.package_quantity);
    Object.assign(this._dialog.draft, {
      product_id: result.local ? product.id : "",
      name: keepCustomName ? currentName : parsedName.name,
      base_name: keepCustomName ? currentBaseName : parsedName.base_name,
      append_brand: keepCustomName ? this._dialog.draft.append_brand : parsedName.append_brand,
      append_quantity: keepCustomName ? this._dialog.draft.append_quantity : parsedName.append_quantity,
      original_name: product.original_name || product.name || this._dialog.draft.original_name,
      ean: product.ean || ean,
      brand: product.brand || "",
      package_quantity: product.package_quantity || "",
      image_url: product.image_url || "",
    });
    this._setDialogStatus(keepCustomName ? haListManagerInventoryCardText("ui.product_data_loaded_unsaved", {}, this._hass) : (result.local ? haListManagerInventoryCardText("products.local_match_found", {}, this._hass) : haListManagerInventoryCardText("ui.product_data_loaded_unsaved", {}, this._hass)), "success", "ean");
    this._render();
  }

  _renderLabelSelector(selectedIds = []) {
    if (!this._labels.length) return `<div class="label-selector"><span>${haListManagerInventoryCardText("ui.labels_optional", {}, this._hass)}</span><p class="field-help">${haListManagerInventoryCardText("labels.none_created", {}, this._hass)}</p></div>`;
    const knownLabels = [...this._labels, ...((this._dialog?.entry?.product?.labels) || [])].filter((label, index, all) => all.findIndex((item) => item.id === label.id) === index);
    const selected = knownLabels.filter((label) => selectedIds.includes(label.id) && this._labels.some((available) => available.id === label.id));
    const chips = selected.map((label) => `<button type="button" class="selected-label" data-remove-label="${escapeHtml(label.id)}" style="${label.color ? `--label-color:${escapeHtml(label.color)}` : ""}" title="${haListManagerInventoryCardText("ui.remove_named", {p0:(escapeHtml(label.name))}, this._hass)}"><ha-icon icon="${escapeHtml(label.icon || "mdi:label-outline")}"></ha-icon><span>${escapeHtml(label.name)}</span><ha-icon class="remove-label" icon="mdi:close"></ha-icon></button>`).join("");
    return `<div class="label-selector"><span>${haListManagerInventoryCardText("ui.labels_optional", {}, this._hass)}</span>${chips ? `<div class="selected-labels">${chips}</div>` : ""}<div class="label-combo"><div class="label-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" placeholder="${haListManagerInventoryCardText("ui.browse_labels", {}, this._hass)}" autocomplete="off" data-label-input></div><div class="label-picker-options" data-label-options hidden></div></div></div>`;
  }

  _installPickerListTriggers(root = this.shadowRoot) {
    const inputSelector = "[data-category-input],[data-label-input],[data-d-category],[data-dish-category-search],[data-tandoor-category-search],[data-chip-category-combo],[data-chip-label-combo],[data-inventory-category-name],[data-item-category-search],[data-product-global-category],[data-product-shopping-category],[data-product-inventory-category],[data-product-exception-category]";
    root.querySelectorAll(inputSelector).forEach((input) => {
      const menuSelector = ".category-picker-options,.category-options,.label-picker-options,.label-options,.chip-template-options";
      const searchRow = input.parentElement?.classList?.contains("label-search") ? input.parentElement : null;
      const menuHost = input.closest(".category-combo,.category-picker,.label-combo,.chip-template-combo,.dish-category-combo");
      const triggerHost = searchRow || menuHost;
      const menu = menuHost?.querySelector(menuSelector);
      if (!triggerHost || !menu || triggerHost.querySelector(":scope > [data-picker-list-trigger]")) return;
      triggerHost.classList.add("picker-trigger-host");
      input.style.setProperty("padding-right", "44px", "important");
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "picker-list-trigger";
      trigger.dataset.pickerListTrigger = "";
      trigger.title = haListManagerInventoryCardText("ui.open_picker_close_keyboard", {}, this._hass);
      trigger.setAttribute("aria-label", trigger.title);
      trigger.innerHTML = '<ha-icon icon="mdi:gesture-tap-button"></ha-icon>';
      trigger.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const focused = root.activeElement === input || this.shadowRoot.activeElement === input;
        this.shadowRoot.activeElement?.blur?.();
        if (!menu.hidden) {
          menu.hidden = true;
          input.setAttribute("aria-expanded", "false");
          trigger.classList.remove("active");
          trigger.setAttribute("aria-expanded", "false");
          return;
        }
        root.querySelectorAll(menuSelector).forEach((otherMenu) => { if (otherMenu !== menu) otherMenu.hidden = true; });
        root.querySelectorAll("[data-picker-list-trigger]").forEach((otherTrigger) => {
          otherTrigger.classList.remove("active");
          otherTrigger.setAttribute("aria-expanded", "false");
        });
        const currentValue = input.value.trim();
        input.blur();
        setTimeout(() => {
          input.value = "";
          input.dispatchEvent(new Event("focus"));
          input.value = currentValue;
          menu.querySelectorAll("button").forEach((button) => {
            button.hidden = false;
            button.style.display = "";
            const optionName = button.querySelector("strong")?.textContent?.trim() || "";
            button.classList.toggle("picker-current", Boolean(currentValue) && optionName.localeCompare(currentValue, undefined, { sensitivity: "accent" }) === 0);
          });
          menu.hidden = false;
          input.setAttribute("aria-expanded", "true");
          trigger.classList.add("active");
          trigger.setAttribute("aria-expanded", "true");
          menu.querySelector(".picker-current")?.scrollIntoView({ block: "nearest" });
        }, focused ? 140 : 0);
      });
      triggerHost.append(trigger);
    });
  }

  _configureLabelSelector() {
    const input = this.shadowRoot.querySelector("[data-label-input]");
    const menu = this.shadowRoot.querySelector("[data-label-options]");
    const draft = this._dialog?.draft;
    if (!input || !menu || !draft) return;
    draft.label_ids = [...new Set(draft.label_ids || [])];
    const choose = (label) => {
      if (!label || draft.label_ids.includes(label.id)) return;
      draft.label_ids = [...draft.label_ids, label.id];
      this._render();
    };
    const matches = () => {
      const query = input.value.trim().toLocaleLowerCase();
      return this._labels.filter((label) => !draft.label_ids.includes(label.id) && label.name.toLocaleLowerCase().includes(query));
    };
    const renderOptions = () => {
      const available = matches();
      menu.innerHTML = available.length
        ? available.map((label) => `<button type="button" data-label-option="${escapeHtml(label.id)}" style="${label.color ? `--label-color:${escapeHtml(label.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${escapeHtml(label.icon || "mdi:label-outline")}"></ha-icon></span><span><strong>${escapeHtml(label.name)}</strong><small>${escapeHtml(label.scope === "global" ? haListManagerInventoryCardText("ui.global", {}, this._hass) : label.scope === "list" ? haListManagerInventoryCardText("inventory.this_inventory", {}, this._hass) : haListManagerInventoryCardText("ui.inventory", {}, this._hass))}</small></span></button>`).join("")
        : `<p class="label-empty">${haListManagerInventoryCardText("labels.no_matches", {}, this._hass)}</p>`;
      menu.hidden = false;
      menu.querySelectorAll("[data-label-option]").forEach((button) => button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(this._labels.find((label) => label.id === button.dataset.labelOption));
      }));
    };
    input.addEventListener("focus", renderOptions);
    input.addEventListener("input", renderOptions);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const first = matches()[0];
      if (first) choose(first);
    });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    this.shadowRoot.querySelectorAll("[data-remove-label]").forEach((button) => button.addEventListener("click", () => {
      draft.label_ids = draft.label_ids.filter((id) => id !== button.dataset.removeLabel);
      this._render();
    }));
  }

  _openImageDialog(url, name) {
    if (!url) return;
    this._dialog = { kind: "image", url, name, parent: this._dialog };
    this._render();
  }

  async _saveDialog() {
    this._syncDialogDraft();
    const draft = this._dialog?.draft;
    if (!draft) return;
    const client = new HaListManagerClient(this._hass);
    if (this._dialog.kind === "group-edit") {
      const name = String(draft.name || "").trim();
      const minimum = String(draft.minimum_stock).trim() === "" ? null : Number(draft.minimum_stock);
      const memberIds = [...new Set(draft.member_ids || [])];
      if (!name) { this._setDialogStatus(haListManagerInventoryCardText("errors.enter_group_name", {}, this._hass), "error"); this._render(); return; }
      if (minimum !== null && (!Number.isInteger(minimum) || minimum < 0)) { this._setDialogStatus(haListManagerInventoryCardText("errors.minimum_stock_invalid", {}, this._hass), "error"); this._render(); return; }
      if (memberIds.length < 2) { this._setDialogStatus(haListManagerInventoryCardText("ui.group_needs_two_items", {}, this._hass), "error"); this._render(); return; }
      const payload = { name, minimum_stock: minimum, category_id: draft.category_id || null, category: draft.category_id ? null : (draft.category_name?.trim() || null), member_ids: memberIds };
      const result = await this._run(() => this._dialog.group ? client.updateInventoryGroup(this._dialog.group.id, payload) : client.createInventoryGroup(this._listId(), payload), haListManagerInventoryCardText("errors.group_save_failed", {}, this._hass));
      if (result?.group) {
        await this._load(true);
        this._dialog = null;
        this._groupSelectionMode = false;
        this._selectedEntryIds.clear();
      }
      this._render();
      return;
    }
    if (this._dialog.kind === "product-edit") {
      if (!String(draft.name).trim()) { this._setDialogStatus(haListManagerInventoryCardText("errors.enter_product_name", {}, this._hass), "error"); this._render(); return; }
      const knownLabels = [...this._labels, ...(this._dialog.entry.product.labels || [])].filter((label, index, all) => all.findIndex((item) => item.id === label.id) === index);
      const result = await this._run(() => client.updateProduct({ ...this._dialog.entry.product, ...draft, labels: knownLabels.filter((label) => (draft.label_ids || []).includes(label.id)), name: draft.name.trim() }), haListManagerInventoryCardText("errors.product_save_failed", {}, this._hass));
      if (result?.product) {
        this._products = this._products.map((product) => product.id === result.product.id ? result.product : product);
        this._entries = this._entries.map((entry) => entry.product_id === result.product.id ? { ...entry, product: result.product } : entry);
        this._dialog = null;
      }
      this._render();
      return;
    }
    const stock = Number(draft.stock);
    const minimum = String(draft.minimum_stock).trim() === "" ? null : Number(draft.minimum_stock);
    if (!Number.isInteger(stock) || stock < 0 || minimum !== null && (!Number.isInteger(minimum) || minimum < 0)) { this._setDialogStatus(haListManagerInventoryCardText("errors.stock_integer_required", {}, this._hass), "error"); this._render(); return; }
    if (this._dialog.kind === "edit") {
      const entry = this._dialog.entry;
      const previousStock = Number(entry.stock || 0);
      const pendingScan = this._dialog.pendingScan;
      const result = await this._run(() => pendingScan
        ? client.resolvePendingScan(pendingScan.id, { corrected_stock: stock, restock_zero: Boolean(this.shadowRoot.querySelector("[data-restock-zero]")?.checked), category_id: draft.category_id || null, category: draft.category_id ? null : (draft.category_name?.trim() || null) })
        : client.updateInventory(entry.id, stock, minimum, draft.category_id || null, draft.category_id ? null : (draft.category_name?.trim() || null), entry.hidden), haListManagerInventoryCardText("errors.inventory_item_save_failed", {}, this._hass));
      if (result?.entry) {
        this._replaceEntry(result.entry);
        this._setInventoryActionStatus(result.entry, previousStock, Number(result.entry.stock || 0));
        if (pendingScan) this._pendingScans = this._pendingScans.filter((scan) => scan.id !== pendingScan.id);
        this._dialog = null;
        this._touchModeTimer();
      } else if (pendingScan && result?.transfer) {
        this._pendingScans = this._pendingScans.filter((scan) => scan.id !== pendingScan.id);
        this._dialog = null;
        this._actionStatus = haListManagerInventoryCardText("inventory.zero_stock_added_to_shopping", {p0:(result.transfer.quantity), p1:(result.transfer.name)}, this._hass);
        await this._load(true);
      }
    } else {
      if (!String(draft.name).trim()) { this._setDialogStatus(haListManagerInventoryCardText("errors.enter_product_name", {}, this._hass), "error"); this._render(); return; }
      const value = draft.ean?.trim() || draft.name.trim();
      const pendingScan = this._dialog.pendingScan;
      const details = { corrected_stock: pendingScan?.action === "correct" ? stock : null, minimum_stock: minimum, category_id: draft.category_id || null, category: draft.category_id ? null : (draft.category_name?.trim() || null), name: draft.name.trim(), original_name: draft.original_name?.trim() || null, brand: draft.brand?.trim() || null, package_quantity: draft.package_quantity?.trim() || null, product_category: null, image_url: draft.image_url?.trim() || null, label_ids: draft.label_ids || [] };
      const result = await this._run(() => pendingScan
        ? client.resolvePendingScan(pendingScan.id, details)
        : client.addInventoryProduct(this._listId(), value, stock, draft.category_id || null, draft.category_id ? null : (draft.category_name?.trim() || null), {
          minimum_stock: minimum, product_id: draft.product_id || null, ean: draft.ean?.trim() || null, name: draft.name.trim(), original_name: draft.original_name?.trim() || null, brand: draft.brand?.trim() || null, package_quantity: draft.package_quantity?.trim() || null, image_url: draft.image_url?.trim() || null, label_ids: draft.label_ids || [],
        }), haListManagerInventoryCardText("errors.item_add_failed", {}, this._hass));
      if (result?.entry) {
        this._replaceEntry(result.entry);
        this._setInventoryActionStatus(result.entry, 0, Number(result.entry.stock || 0));
        this._rememberBrowserChip(result.entry.product?.name || draft.name.trim(), result.entry.product || this._products.find((product) => product.id === result.entry.product_id));
        if (pendingScan) this._pendingScans = this._pendingScans.filter((scan) => scan.id !== pendingScan.id);
        this._dialog = null;
        this._inputValue = "";
        this._selectedProduct = null;
        this._touchModeTimer();
      }
    }
    this._render();
  }

  _deleteEntry(entry) {
    this._requestConfirmation(
      haListManagerInventoryCardText("inventory.confirm_delete_item", {}, this._hass),
      haListManagerInventoryCardText("ui.remove_inventory_product_warning", {p0:(entry.product.name)}, this._hass),
      haListManagerInventoryCardText("inventory.delete_item", {}, this._hass),
      () => this._deleteEntryConfirmed(entry),
    );
  }

  async _deleteEntryConfirmed(entry) {
    const result = await this._run(() => new HaListManagerClient(this._hass).deleteInventory(entry.id), haListManagerInventoryCardText("ui.inventory_remove_failed", {}, this._hass));
    if (result !== null) { this._entries = this._entries.filter((item) => item.id !== entry.id); this._dialog = null; }
    this._render();
  }

  _deleteGroup(group) {
    this._requestConfirmation(
      haListManagerInventoryCardText("inventory.confirm_dissolve_group", {}, this._hass),
      haListManagerInventoryCardText("ui.dissolve_group_warning", {p0:(group.name)}, this._hass),
      haListManagerInventoryCardText("ui.dissolve_group", {}, this._hass),
      () => this._deleteGroupConfirmed(group),
    );
  }

  async _deleteGroupConfirmed(group) {
    const result = await this._run(() => new HaListManagerClient(this._hass).deleteInventoryGroup(group.id), haListManagerInventoryCardText("errors.group_dissolve_failed", {}, this._hass));
    if (result !== null) { this._inventoryGroups = this._inventoryGroups.filter((item) => item.id !== group.id); this._dialog = null; }
    this._render();
  }

  _inventoryCategoryChoices() {
    const choices = [...this._categories];
    const knownNames = new Set(choices.map((category) => category.name.trim().toLocaleLowerCase()).filter(Boolean));
    const addDynamic = (value) => {
      const name = String(value || "").trim();
      const key = name.toLocaleLowerCase();
      if (!name || knownNames.has(key)) return;
      knownNames.add(key);
      choices.push({ id: `dynamic:${key}`, name, icon: "mdi:shape-plus-outline", scope: "dynamic", dynamic: true, position: 999999 });
    };
    this._entries.forEach((entry) => addDynamic(entry.category_name));
    this._inventoryGroups.forEach((group) => addDynamic(group.category_name));
    return choices.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.scope === "list" ? -1 : 1));
  }

  _configureCategoryPicker() {
    const picker = this.shadowRoot.querySelector("[data-category-input]");
    const menu = this.shadowRoot.querySelector("[data-category-options]");
    const draft = this._dialog?.draft;
    if (!picker || !menu || !draft) return;
    const categories = this._inventoryCategoryChoices();
    const productDefault = this._productDefaultCategory(this._categoryContextProduct());
    const apply = (value, permanent = null) => {
      const raw = String(value || "");
      const cleaned = raw.trim();
      const match = permanent || categories.find((category) => category.name.localeCompare(cleaned, undefined, { sensitivity: "base" }) === 0);
      draft.category_id = match && !match.dynamic ? match.id : "";
      draft.category_name = match?.name || raw;
      picker.value = match?.name || raw;
      this._updateDialogDirtyIndicator();
    };
    const renderOptions = () => {
      const query = picker.value.trim().toLocaleLowerCase();
      const matches = categories.filter((category) => category.name.toLocaleLowerCase().includes(query));
      const inherited = productDefault
        ? `<button type="button" data-category-option=""><span class="category-option-icon" style="${productDefault.color ? `--category-color:${escapeHtml(productDefault.color)}` : ""}"><ha-icon icon="${escapeHtml(productDefault.icon || "mdi:database-outline")}"></ha-icon></span><span><strong>${haListManagerInventoryCardText("ui.use_product_default", {}, this._hass)}</strong><small>${escapeHtml(productDefault.name)}</small></span></button>`
        : `<button type="button" data-category-option=""><span class="category-option-icon"><ha-icon icon="mdi:shape-outline"></ha-icon></span><span><strong>${haListManagerInventoryCardText("ui.general", {}, this._hass)}</strong><small>${haListManagerInventoryCardText("ui.no_category", {}, this._hass)}</small></span></button>`;
      menu.innerHTML = `${inherited}${matches.map((category) => `<button type="button" data-category-option="${escapeHtml(category.id)}"><span class="category-option-icon" style="${category.color ? `--category-color:${escapeHtml(category.color)}` : ""}"><ha-icon icon="${escapeHtml(category.icon || (category.scope === "global" ? "mdi:earth" : "mdi:format-list-bulleted"))}"></ha-icon></span><span><strong>${escapeHtml(category.name)}</strong><small>${category.dynamic ? haListManagerInventoryCardText("ui.dynamic_in_inventory", {}, this._hass) : category.scope === "global" ? haListManagerInventoryCardText("ui.global", {}, this._hass) : haListManagerInventoryCardText("ui.this_list", {}, this._hass)}</small></span></button>`).join("")}`;
      menu.hidden = false;
      menu.querySelectorAll("[data-category-option]").forEach((button) => button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const category = categories.find((item) => item.id === button.dataset.categoryOption) || null;
        apply(category?.name || "", category);
        menu.hidden = true;
      }));
    };
    picker.addEventListener("focus", renderOptions);
    picker.addEventListener("input", () => { apply(picker.value); renderOptions(); });
    picker.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 120));
  }

  _groupCategory(group, members) {
    const dynamicName = String(group.category_name || "").trim();
    if (group.category_id && group.category) return group.category;
    if (dynamicName) return { id: `dynamic:${dynamicName.toLocaleLowerCase()}`, name: dynamicName, icon: "mdi:shape-outline", color: null, position: 999999, dynamic: true };
    const categories = members.map((entry) => this._effectiveEntryCategory(entry));
    const first = categories[0] || null;
    return first && categories.every((category) => (category?.id || category?.name) === (first.id || first.name)) ? first : null;
  }

  _groupView(group) {
    const members = group.member_ids.map((id) => this._entries.find((entry) => entry.id === id)).filter(Boolean);
    return {
      ...group,
      members,
      stock: members.reduce((sum, entry) => sum + entry.stock, 0),
      hidden: members.length > 0 && members.every((entry) => entry.hidden),
      effective_category: this._groupCategory(group, members),
    };
  }

  _entryGroupMap() {
    const map = new Map();
    for (const group of this._inventoryGroups) for (const id of group.member_ids || []) map.set(id, group.id);
    return map;
  }

  _displayUnits() {
    const groupedIds = this._entryGroupMap();
    if (this._groupSelectionMode) return this._entries.map((entry) => ({ kind: "entry", entry }));
    return [
      ...this._inventoryGroups.map((group) => ({ kind: "group", group: this._groupView(group) })),
      ...this._entries.filter((entry) => !groupedIds.has(entry.id)).map((entry) => ({ kind: "entry", entry })),
    ];
  }

  _unitState(unit) {
    if (unit.kind === "group") return unit.group;
    return unit.entry;
  }

  _unitCategory(unit) {
    return unit.kind === "group" ? unit.group.effective_category : this._effectiveEntryCategory(unit.entry);
  }

  _entrySearchValues(entry) {
    const product = entry?.product || {};
    return [product.name, product.original_name, product.brand, product.package_quantity, product.ean, ...(product.labels || []).map((label) => label.name)]
      .map((value) => String(value || "").toLocaleLowerCase())
      .filter(Boolean);
  }

  _unitMatchesQuery(unit, query) {
    if (!query) return true;
    if (unit.kind === "entry") return this._entrySearchValues(unit.entry).some((value) => value.includes(query));
    return [String(unit.group.name || "").toLocaleLowerCase(), ...unit.group.members.flatMap((entry) => this._entrySearchValues(entry))].some((value) => value.includes(query));
  }

  _unitLabelKeys(unit) {
    const entries = unit.kind === "group" ? unit.group.members : [unit.entry];
    const keys = new Set();
    for (const entry of entries) {
      const labels = entry?.product?.labels || [];
      if (!labels.length) keys.add("__unlabeled__");
      labels.forEach((label) => keys.add(label.id));
    }
    return keys;
  }

  _passesFilter(unit) {
    const entry = this._unitState(unit);
    const query = this._config.allow_filter ? this._inputValue.trim().toLocaleLowerCase() : "";
    if (!this._unitMatchesQuery(unit, query)) return false;
    if (!this._showHidden && entry.hidden) return false;
    if (this._selectedCategoryIds !== null) {
      const category = this._unitCategory(unit);
      const key = category?.id || "__uncategorized__";
      if (!this._selectedCategoryIds.has(key)) return false;
    }
    if (this._selectedLabelIds !== null) {
      const labelKeys = this._unitLabelKeys(unit);
      if (![...labelKeys].some((key) => this._selectedLabelIds.has(key))) return false;
    }
    if (this._filter === "zero" && entry.stock !== 0) return false;
    if (this._filter === "zero_one" && (entry.stock < 0 || entry.stock > 1)) return false;
    if (this._filter === "minimum" && (entry.minimum_stock === null || entry.stock > entry.minimum_stock)) return false;
    if (this._filter === "below" && (entry.minimum_stock === null || entry.stock >= entry.minimum_stock)) return false;
    return true;
  }

  _groups() {
    const units = this._displayUnits().filter((unit) => this._passesFilter(unit));
    if (this._groupingMode() === "labels") {
      const groups = new Map();
      for (const unit of units) {
        const entries = unit.kind === "group" ? unit.group.members : [unit.entry];
        const labels = new Map(entries.flatMap((entry) => entry.product?.labels || [])
          .filter((label) => label.id).map((label) => [label.id, label]));
        const definitions = labels.size ? [...labels.values()].map((label) => ({
          ...label, id: `__label__:${label.id}`, icon: label.icon || "mdi:label-outline",
        })) : [{ id: "__unlabeled__", name: haListManagerInventoryCardText("ui.without_label", {}, this._hass), icon: "mdi:label-off-outline" }];
        for (const category of definitions) {
          const key = category.id;
          if (!groups.has(key)) groups.set(key, { key, category, units: [] });
          groups.get(key).units.push(unit);
        }
      }
      return [...groups.values()].sort((a, b) => {
        if (a.key === "__unlabeled__" || b.key === "__unlabeled__") return a.key === b.key ? 0 : a.key === "__unlabeled__" ? -1 : 1;
        return a.category.name.localeCompare(b.category.name, haListManagerInventoryCardTextLocale(this._hass), { sensitivity: "base", numeric: true });
      });
    }
    if (!this._groupCategories && !this._groupingEnabled()) return [{ category: null, units, flat: true }];
    const groups = new Map();
    for (const unit of units) {
      const category = this._unitCategory(unit);
      const key = category?.id || "__uncategorized__";
      if (!groups.has(key)) groups.set(key, { key, category, units: [] });
      groups.get(key).units.push(unit);
    }
    return [...groups.values()].sort((a, b) => this._compareCategories(a.category, b.category));
  }

  _categoryScopeRank(category, order = "global_list_dynamic") {
    if (!category) return -1;
    const scope = category.dynamic || category.scope === "dynamic" || String(category.id || "").startsWith("dynamic:") ? "dynamic" : category.scope === "list" ? "list" : "global";
    const scopes = order === "list_global_dynamic" ? ["list", "global", "dynamic"] : ["global", "list", "dynamic"];
    return scopes.indexOf(scope);
  }

  _compareCategories(a, b) {
    if (!a || !b) return !a ? (!b ? 0 : -1) : 1;
    const nameResult = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const tieScope = this._categoryScopeRank(a, "list_global_dynamic") - this._categoryScopeRank(b, "list_global_dynamic");
    if (this._config.category_sort === "alphabetical") return nameResult || tieScope;
    if (["global_list_dynamic", "list_global_dynamic"].includes(this._config.category_sort)) {
      return this._categoryScopeRank(a, this._config.category_sort) - this._categoryScopeRank(b, this._config.category_sort) || nameResult;
    }
    const aDynamic = this._categoryScopeRank(a) === 2;
    const bDynamic = this._categoryScopeRank(b) === 2;
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
    return (Number(a.manual_position ?? a.position) || 0) - (Number(b.manual_position ?? b.position) || 0) || tieScope || nameResult;
  }

  _renderEntry(entry) {
    const product = entry.product;
    const image = this._config.show_images
      ? product.image_url
        ? `<button type="button" class="product-image" data-view-image="${escapeHtml(entry.id)}" title="${haListManagerInventoryCardText("ui.enlarge_product_image", {}, this._hass)}"><img src="${escapeHtml(product.image_url)}" alt=""></button>`
        : `<span class="product-image product-image-placeholder" title="${haListManagerInventoryCardText("products.no_image", {}, this._hass)}"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`
      : "";
    const currentGroup = this._groupSelectionMode ? this._groupForEntry(entry.id) : null;
    const details = [product.original_name && product.original_name !== product.name ? product.original_name : null, product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : null, currentGroup ? haListManagerInventoryCardText("ui.group_named", {p0:(currentGroup.name)}, this._hass) : null].filter(Boolean);
    const labels = (product.labels || []).map((label) => `<span class="label-chip" style="${label.color ? `--label-color:${escapeHtml(label.color)}` : ""}"><ha-icon icon="${escapeHtml(label.icon || "mdi:label-outline")}"></ha-icon>${escapeHtml(label.name)}</span>`).join("");
    const position = this._config.quantity_position === "controls" && this._config.show_plus_minus === false ? "end" : this._config.quantity_position;
    const title = position === "beginning" ? `${entry.stock}× ${product.name}` : position === "end" ? `${product.name} (${entry.stock})` : product.name;
    const controlsStock = position === "controls" ? `<strong class="controls-stock">${entry.stock}</strong>` : "";
    const restockFlag = this._config.show_restock_flag !== false && this._restockPreview.some((item) => item.source_type === "entry" && item.source_id === entry.id && item.latched) ? `<button class="restock-flag" type="button" data-open-restock-preview title="${haListManagerInventoryCardText("inventory.restock_sent_locked", {}, this._hass)}"><ha-icon icon="mdi:flag"></ha-icon></button>` : "";
    const selectable = this._groupSelectionMode ? `<button type="button" class="group-select ${this._selectedEntryIds.has(entry.id) ? "selected" : ""}" data-select-entry="${entry.id}" title="${haListManagerInventoryCardText("ui.select_for_group", {}, this._hass)}"><ha-icon icon="mdi:${this._selectedEntryIds.has(entry.id) ? "checkbox-marked" : "checkbox-blank-outline"}"></ha-icon></button>` : `<button class="icon-button visibility" type="button" data-hidden="${entry.id}:${entry.hidden ? "0" : "1"}" title="${entry.hidden ? haListManagerInventoryCardText("ui.show_item", {}, this._hass) : haListManagerInventoryCardText("ui.hide_item", {}, this._hass)}"><ha-icon icon="mdi:${entry.hidden ? "eye-outline" : "eye-off-outline"}"></ha-icon></button>`;
    const stockActions = this._groupSelectionMode || this._config.show_plus_minus === false ? "" : `<div class="stock-actions">${restockFlag}<button class="icon-button" type="button" data-adjust="${entry.id}:1" title="${haListManagerInventoryCardText("ui.increase_stock", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button>${controlsStock}<button class="icon-button" type="button" data-adjust="${entry.id}:-1" title="${haListManagerInventoryCardText("ui.decrease_stock", {}, this._hass)}"><ha-icon icon="mdi:minus"></ha-icon></button></div>`;
    return `<article class="entry ${this._config.show_images ? "with-image" : "without-image"} ${inventoryState(entry)} ${entry.hidden ? "is-hidden" : ""}">${selectable}${image}<button class="entry-main" type="button" ${this._groupSelectionMode ? `data-select-entry="${entry.id}"` : `data-edit="${entry.id}"`}><span class="entry-title">${escapeHtml(title)}${product.ean ? ` <ha-icon icon="mdi:barcode"></ha-icon>` : ""}</span>${this._showDetails && details.length ? `<span class="entry-details">${escapeHtml(details.join(" · "))}</span>` : ""}${this._showDetails && labels ? `<span class="labels">${labels}</span>` : ""}</button>${stockActions}</article>`;
  }

  _renderInventoryGroup(group) {
    const state = inventoryState(group);
    const memberNames = group.members.map((entry) => `${entry.product.name} (${entry.stock})`).join(" · ");
    const position = this._config.quantity_position === "controls" && this._config.show_plus_minus === false ? "end" : this._config.quantity_position;
    const title = position === "beginning" ? `${group.stock}× ${group.name}` : position === "end" ? `${group.name} (${group.stock})` : group.name;
    const controlsStock = position === "controls" ? `<strong class="controls-stock">${group.stock}</strong>` : "";
    const restockFlag = this._config.show_restock_flag !== false && this._restockPreview.some((item) => item.source_type === "group" && item.source_id === group.id && item.latched) ? `<button class="restock-flag" type="button" data-open-restock-preview title="${haListManagerInventoryCardText("inventory.restock_sent_locked", {}, this._hass)}"><ha-icon icon="mdi:flag"></ha-icon></button>` : "";
    const groupLead = this._config.show_images
      ? `<span class="group-visibility-spacer"></span><span class="group-icon"><ha-icon icon="mdi:group"></ha-icon></span>`
      : `<span class="group-icon"><ha-icon icon="mdi:group"></ha-icon></span>`;
    const stockActions = this._config.show_plus_minus === false ? "" : `<div class="stock-actions">${restockFlag}<button class="icon-button" type="button" data-edit-group="${escapeHtml(group.id)}" title="${haListManagerInventoryCardText("ui.select_variant", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button>${controlsStock}<button class="icon-button" type="button" data-edit-group="${escapeHtml(group.id)}" title="${haListManagerInventoryCardText("ui.select_variant", {}, this._hass)}"><ha-icon icon="mdi:minus"></ha-icon></button></div>`;
    return `<article class="entry inventory-group ${this._config.show_images ? "with-image" : "without-image"} ${state}">${groupLead}<button class="entry-main" type="button" data-edit-group="${escapeHtml(group.id)}"><span class="entry-title">${escapeHtml(title)} <ha-icon icon="mdi:layers-triple-outline"></ha-icon></span>${this._showDetails ? `<span class="entry-details">${escapeHtml(memberNames)}</span>` : ""}</button>${stockActions}</article>`;
  }

  _renderUnit(unit) {
    return unit.kind === "group" ? this._renderInventoryGroup(unit.group) : this._renderEntry(unit.entry);
  }

  _loadPdfExporter() {
    if (window.HaListManagerPdfExporter) return Promise.resolve(window.HaListManagerPdfExporter);
    if (window.__shoppingListImprovedPdfExporterPromise) return window.__shoppingListImprovedPdfExporterPromise;
    window.__shoppingListImprovedPdfExporterPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/ha_list_manager_static/ha-list-manager-pdf-export.js?v=${CARD_VERSION}`;
      script.async = true;
      script.onload = () => window.HaListManagerPdfExporter
        ? resolve(window.HaListManagerPdfExporter)
        : reject(new Error(haListManagerInventoryCardText("ui.pdf_export_not_loaded", {}, this._hass)));
      script.onerror = () => reject(new Error(haListManagerInventoryCardText("errors.pdf_export_load_failed", {}, this._hass)));
      document.head.appendChild(script);
    }).catch((error) => {
      window.__shoppingListImprovedPdfExporterPromise = null;
      throw error;
    });
    return window.__shoppingListImprovedPdfExporterPromise;
  }

  _pdfSections() {
    const groups = new Map();
    for (const entry of this._entries) {
      const category = this._effectiveEntryCategory(entry);
      const key = category?.id || "__uncategorized__";
      if (!groups.has(key)) groups.set(key, { category, items: [] });
      const product = entry.product || {};
      const details = [product.brand, product.package_quantity].filter(Boolean).join(" · ");
      const productName = details ? `${product.name} – ${details}` : product.name;
      const name = productName || haListManagerInventoryCardText("ui.unnamed_item", {}, this._hass);
      groups.get(key).items.push({ name, text: name, stockLabel: haListManagerInventoryCardText("inventory.stock_value", {p0:(entry.stock)}, this._hass), checked: false });
    }
    return [...groups.values()]
      .sort((left, right) => this._compareCategories(left.category, right.category))
      .map(({ category, items }) => ({
        name: category?.name || haListManagerInventoryCardText("ui.general", {}, this._hass),
        color: category?.color || null,
        items: items.sort((left, right) => left.name.localeCompare(right.name, haListManagerInventoryCardTextLocale(this._hass), { sensitivity: "base", numeric: true })),
      }));
  }

  async _exportPdf() {
    if (this._pdfExporting) return;
    this._pdfExporting = true;
    this._error = "";
    this._actionStatus = "";
    this._render();
    try {
      const exporter = await this._loadPdfExporter();
      const title = this._config.title || this._list?.name || haListManagerInventoryCardText("ui.inventory", {}, this._hass);
      await exporter.exportPdf({ hass: this._hass,
        title,
        subtitle: haListManagerInventoryCardText("ui.inventory_item_count", {p0:(this._entries.length)}, this._hass),
        fileName: haListManagerInventoryCardText("pdf.inventory_filename", { list: this._list?.name || this._listId() || haListManagerInventoryCardText("ui.list", {}, this._hass).toLocaleLowerCase() }, this._hass),
        sections: this._pdfSections(),
      });
      this._actionStatus = haListManagerInventoryCardText("ui.pdf_created", {}, this._hass);
    } catch (error) {
      this._error = error?.message || haListManagerInventoryCardText("errors.pdf_creation_failed", {}, this._hass);
    } finally {
      this._pdfExporting = false;
      this._render();
    }
  }

  _renderGroups() {
    const groups = this._groups();
    if (!groups.some((group) => group.units.length)) return `<div class="empty"><ha-icon icon="mdi:package-variant"></ha-icon><strong>${haListManagerInventoryCardText("ui.no_matching_items", {}, this._hass)}</strong><span>${haListManagerInventoryCardText("ui.change_filter_category", {}, this._hass)}</span></div>`;
    return groups.map(({ key, category, units, flat }) => {
      if (!units.length) return "";
      const below = units.filter((unit) => { const entry = this._unitState(unit); return entry.minimum_stock !== null && entry.stock < entry.minimum_stock; }).length;
      const categoryKey = category?.id || key || "__uncategorized__";
      const collapsed = !flat && this._isCategoryCollapsed(categoryKey);
      const categoryInfo = [this._config.show_category_count !== false ? `(${units.length})` : "", below ? `<b>${haListManagerInventoryCardText("ui.below_minimum_count", {p0:(below)}, this._hass)}</b>` : ""].filter(Boolean).join(" · ");
      const header = flat ? "" : `<button type="button" class="category-header" data-toggle-category="${escapeHtml(categoryKey)}" aria-expanded="${collapsed ? "false" : "true"}" style="${category?.color ? `--category-color:${escapeHtml(category.color)}` : ""}"><ha-icon icon="${escapeHtml(category?.icon || "mdi:shape-outline")}"></ha-icon><strong>${escapeHtml(category?.name || haListManagerInventoryCardText("ui.general", {}, this._hass))}</strong>${categoryInfo ? `<span>${categoryInfo}</span>` : ""}<ha-icon class="category-chevron" icon="mdi:${collapsed ? "chevron-down" : "chevron-up"}"></ha-icon></button>`;
      return `<section class="category">${header}${collapsed ? "" : units.map((unit) => this._renderUnit(unit)).join("")}</section>`;
    }).join("");
  }

  _categoryPickerMarkup() {
    const draft = this._dialog?.draft || {};
    const category = this._categories.find((item) => item.id === draft.category_id);
    const value = category?.name || draft.category_name || "";
    const productDefault = this._productDefaultCategory(this._categoryContextProduct());
    const help = productDefault
      ? haListManagerInventoryCardText("help.inventory_category_override", {p0:(escapeHtml(productDefault.name))}, this._hass)
      : haListManagerInventoryCardText("help.inventory_dynamic_category", {}, this._hass);
    return `<div class="category-combo"><input value="${escapeHtml(value)}" placeholder="${productDefault ? haListManagerInventoryCardText("ui.use_product_category_default", {p0:(escapeHtml(productDefault.name))}, this._hass) : haListManagerInventoryCardText("ui.category_search_or_create", {}, this._hass)}" autocomplete="off" data-category-input><div class="category-picker-options" data-category-options hidden></div></div><p class="field-help">${help}</p>`;
  }

  _renderDialog() {
    if (!this._dialog) return "";
    if (this._dialog.kind === "image") {
      return `<div class="backdrop image-backdrop" data-backdrop><section class="dialog image-dialog">${this._dialogHeader(this._dialog.name || haListManagerInventoryCardText("ui.product_image", {}, this._hass))}<img src="${escapeHtml(this._dialog.url)}" alt="${escapeHtml(this._dialog.name || haListManagerInventoryCardText("ui.product_image", {}, this._hass))}"></section></div>`;
    }
    const draft = this._dialog.draft;
    const eanStatus = this._renderDialogStatus("ean");
    const generalStatus = this._renderDialogStatus("general");
    if (this._dialog.kind === "group-edit") {
      const group = this._dialog.group;
      const members = (draft.member_ids || []).map((id) => this._entries.find((entry) => entry.id === id)).filter(Boolean).map((entry) => `<div class="group-member-choice"><button type="button" class="group-member-open" data-edit-group-member="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.product.name)}</strong><small>${haListManagerInventoryCardText("inventory.stock_value", {p0:(entry.stock)}, this._hass)}</small></button><span class="group-member-stock"><button type="button" class="icon-button" data-group-adjust="${entry.id}:1" title="${haListManagerInventoryCardText("ui.increase_stock", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button><button type="button" class="icon-button" data-group-adjust="${entry.id}:-1" title="${haListManagerInventoryCardText("ui.decrease_stock", {}, this._hass)}"><ha-icon icon="mdi:minus"></ha-icon></button><button type="button" class="icon-button danger" data-remove-group-member="${escapeHtml(entry.id)}" title="${haListManagerInventoryCardText("inventory.remove_from_group", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></span></div>`).join("");
      return `<div class="backdrop" data-backdrop><section class="dialog group-dialog" data-dialog-panel>${this._dialogHeader(group ? haListManagerInventoryCardText("ui.edit_group", {}, this._hass) : haListManagerInventoryCardText("inventory.create_group", {}, this._hass))}<label><span>${haListManagerInventoryCardText("ui.group_name", {}, this._hass)}</span><input value="${escapeHtml(draft.name)}" data-field="name" placeholder="${haListManagerInventoryCardText("ui.milk_example", {}, this._hass)}"></label><div class="field-grid"><label><span>${haListManagerInventoryCardText("inventory.optional_group_minimum", {}, this._hass)}</span><input type="number" min="0" step="1" value="${escapeHtml(draft.minimum_stock)}" data-field="minimum_stock"></label><div class="dialog-field"><span>${haListManagerInventoryCardText("ui.group_category", {}, this._hass)}</span>${this._categoryPickerMarkup()}</div></div><fieldset class="group-members"><legend>${haListManagerInventoryCardText("ui.member_count", {p0:((draft.member_ids || []).length)}, this._hass)}</legend>${members || `<p class="field-help">${haListManagerInventoryCardText("ui.no_members_selected", {}, this._hass)}</p>`}<button type="button" class="add-members-button" data-open-member-picker><ha-icon icon="mdi:account-multiple-plus-outline"></ha-icon>${haListManagerInventoryCardText("ui.add_members", {}, this._hass)}</button><p class="field-help">${haListManagerInventoryCardText("help.inventory_single_group", {}, this._hass)}</p></fieldset>${generalStatus}<div class="dialog-actions"><button class="primary" data-save-dialog>${haListManagerInventoryCardText("ui.save", {}, this._hass)}</button><button data-close-dialog>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button>${group ? `<button class="danger" data-delete-group="${escapeHtml(group.id)}"><ha-icon icon="mdi:ungroup"></ha-icon>${haListManagerInventoryCardText("ui.dissolve_group", {}, this._hass)}</button>` : ""}</div></section></div>`;
    }
    if (this._dialog.kind === "edit") {
      const entry = this._dialog.entry;
      const group = this._groupForEntry(entry.id);
      const groupSection = group
        ? `<section class="entry-group-section"><div class="entry-group-summary"><span>${haListManagerInventoryCardText("inventory.group", {}, this._hass)}</span><strong><ha-icon icon="mdi:group"></ha-icon>${escapeHtml(group.name)}</strong></div><div class="entry-group-actions"><button type="button" data-edit-entry-group="${escapeHtml(group.id)}">${haListManagerInventoryCardText("ui.edit", {}, this._hass)}</button><button type="button" data-pick-group="${escapeHtml(entry.id)}">${haListManagerInventoryCardText("ui.switch", {}, this._hass)}</button><button type="button" class="danger" data-remove-entry-group="${escapeHtml(entry.id)}">${haListManagerInventoryCardText("ui.remove", {}, this._hass)}</button></div></section>`
        : `<section class="entry-group-section"><div class="entry-group-summary"><span>${haListManagerInventoryCardText("inventory.group", {}, this._hass)}</span><small>${haListManagerInventoryCardText("inventory.no_group", {}, this._hass)}</small></div><div class="entry-group-actions"><button type="button" data-pick-group="${escapeHtml(entry.id)}"><ha-icon icon="mdi:group-plus"></ha-icon>${haListManagerInventoryCardText("inventory.select_group", {}, this._hass)}</button><button type="button" data-new-group-for-entry="${escapeHtml(entry.id)}"><ha-icon icon="mdi:plus"></ha-icon>${haListManagerInventoryCardText("inventory.new_group", {}, this._hass)}</button></div></section>`;
      const zeroRestock = this._dialog.pendingScan?.action === "remove" && Number(entry.stock) === 0 ? `<label class="switch-field"><span><strong>${haListManagerInventoryCardText("inventory.restock_despite_zero", {}, this._hass)}</strong><small>${haListManagerInventoryCardText("help.zero_stock_restock_scan", {}, this._hass)}</small></span><input type="checkbox" data-restock-zero></label>` : "";
      return `<div class="backdrop" data-backdrop><section class="dialog" data-dialog-panel>${this._dialogHeader(haListManagerInventoryCardText("inventory.correct_stock", {}, this._hass))}<strong class="dialog-product">${escapeHtml(entry.product.name)}</strong><div class="field-grid"><label><span>${haListManagerInventoryCardText("ui.stock", {}, this._hass)}</span><input type="number" min="0" step="1" value="${escapeHtml(draft.stock)}" data-field="stock"></label><label><span>${haListManagerInventoryCardText("ui.minimum_stock_optional", {}, this._hass)}</span><input type="number" min="0" step="1" value="${escapeHtml(draft.minimum_stock)}" data-field="minimum_stock"></label></div><div class="dialog-field"><span>${haListManagerInventoryCardText("ui.category", {}, this._hass)}</span>${this._categoryPickerMarkup()}</div>${groupSection}${zeroRestock}${generalStatus}<div class="dialog-actions dialog-actions-wrap"><button class="primary" data-save-dialog>${haListManagerInventoryCardText("ui.save", {}, this._hass)}</button><button data-close-dialog>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button><button data-edit-product="${entry.id}"><ha-icon icon="mdi:pencil"></ha-icon>${haListManagerInventoryCardText("ui.edit_item", {}, this._hass)}</button><button class="danger" data-delete-entry="${entry.id}"><ha-icon icon="mdi:delete-outline"></ha-icon>${haListManagerInventoryCardText("inventory.delete_item", {}, this._hass)}</button></div></section></div>`;
    }
    if (["product-edit", "add"].includes(this._dialog.kind)) return this._renderProductDialog(eanStatus, generalStatus);
    return "";
  }

  _renderProductDialog(eanStatus, generalStatus) {
    const draft = this._dialog.draft;
    const editing = this._dialog.kind === "product-edit";
    const locked = !editing && Boolean(draft.product_id);
    const readonly = locked ? "readonly" : "";
    const title = editing ? haListManagerInventoryCardText("products.edit", {}, this._hass) : haListManagerInventoryCardText("inventory.add_product", {}, this._hass);
    const lookupIcon = editing ? "mdi:cloud-download-outline" : "mdi:database-search-outline";
    const lookupLabel = editing ? haListManagerInventoryCardText("ui.refresh", {}, this._hass) : haListManagerInventoryCardText("ui.lookup_ean", {}, this._hass);
    const image = draft.image_url
      ? `<button type="button" class="dialog-image-button" data-dialog-image><img class="dialog-image" src="${escapeHtml(draft.image_url)}" alt=""></button>`
      : `<span class="dialog-image dialog-image-placeholder"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`;
    const inventoryFields = editing ? "" : `<div class="field-grid"><label><span>${haListManagerInventoryCardText("ui.initial_stock", {}, this._hass)}</span><input type="number" min="0" step="1" value="${escapeHtml(draft.stock)}" data-field="stock"></label><label><span>${haListManagerInventoryCardText("ui.minimum_stock_optional", {}, this._hass)}</span><input type="number" min="0" step="1" value="${escapeHtml(draft.minimum_stock)}" data-field="minimum_stock"></label></div>`;
    const categoryField = editing
      ? `<p class="field-help">${haListManagerInventoryCardText("help.manage_product_categories", {}, this._hass)}</p>`
      : `<div class="dialog-field"><span>${haListManagerInventoryCardText("ui.category", {}, this._hass)}</span>${this._categoryPickerMarkup()}</div>`;
    const imageField = editing
      ? `<label><span>${haListManagerInventoryCardText("ui.optional_image_url", {}, this._hass)}</span><input value="${escapeHtml(draft.image_url)}" data-field="image_url"></label>`
      : `<input type="hidden" value="${escapeHtml(draft.image_url)}" data-field="image_url">`;
    const lockedHelp = locked ? `<p class="field-help">${haListManagerInventoryCardText("help.central_product_editing", {}, this._hass)}</p>` : "";
    return `<div class="backdrop" data-backdrop><section class="dialog product-dialog" data-dialog-panel>${this._dialogHeader(title)}${image}<label><span>${haListManagerInventoryCardText("products.custom_name", {}, this._hass)}</span><input value="${escapeHtml(draft.name)}" data-field="name" ${readonly}></label><div class="name-options"><button type="button" class="${draft.append_brand ? "active" : ""}" data-name-component="brand" ${locked || !draft.brand ? "disabled" : ""}><ha-icon icon="mdi:tag-outline"></ha-icon>${haListManagerInventoryCardText("ui.brand", {}, this._hass)}</button><button type="button" class="${draft.append_quantity ? "active" : ""}" data-name-component="quantity" ${locked || !draft.package_quantity ? "disabled" : ""}><ha-icon icon="mdi:scale-balance"></ha-icon>${haListManagerInventoryCardText("ui.amount", {}, this._hass)}</button></div><div class="ean-row"><label><span>${haListManagerInventoryCardText("ui.ean_optional", {}, this._hass)}</span><input value="${escapeHtml(draft.ean)}" data-field="ean" ${readonly}></label><button type="button" data-lookup-ean ${locked ? "disabled" : ""}><ha-icon icon="${lookupIcon}"></ha-icon>${lookupLabel}</button>${eanStatus}</div><label><span>${haListManagerInventoryCardText("products.original_name", {}, this._hass)}</span><input value="${escapeHtml(draft.original_name)}" data-field="original_name" ${readonly}></label><div class="field-grid"><label><span>${haListManagerInventoryCardText("ui.brand_optional", {}, this._hass)}</span><input value="${escapeHtml(draft.brand)}" data-field="brand" ${readonly}></label><label><span>${haListManagerInventoryCardText("ui.package_quantity_optional", {}, this._hass)}</span><input value="${escapeHtml(draft.package_quantity)}" data-field="package_quantity" ${readonly}></label></div>${inventoryFields}${categoryField}${this._renderLabelSelector(draft.label_ids || [])}${lockedHelp}${imageField}${generalStatus}<div class="dialog-actions"><button class="primary" data-save-dialog>${haListManagerInventoryCardText("ui.save", {}, this._hass)}</button><button data-close-dialog>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _suggestionMarkup(product) {
    const secondary = [product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : null].filter(Boolean).join(" · ");
    const inInventory = this._entries.some((entry) => entry.product_id === product.id);
    const image = this._config.show_images
      ? (product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="">` : `<span class="suggestion-placeholder"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`)
      : "";
    return `<button type="button" data-suggestion="${escapeHtml(product.id)}">${image}<span><strong>${escapeHtml(product.name)}</strong>${secondary ? `<small>${escapeHtml(secondary)}</small>` : ""}<small class="suggestion-source"><ha-icon icon="mdi:database"></ha-icon>${haListManagerInventoryCardText("ui.product_database_suffix", {p0:(inInventory ? (" " + haListManagerInventoryCardText("inventory.already_registered_suffix", {}, this._hass)) : "")}, this._hass)}</small></span></button>`;
  }

  _updateSuggestions(value) {
    const container = this.shadowRoot.querySelector("[data-suggestions]");
    const clear = this.shadowRoot.querySelector("[data-clear-input]");
    if (clear) clear.hidden = !value;
    if (!container) return;
    if (this._config.allow_suggestions === false) { container.hidden = true; container.innerHTML = ""; return; }
    const query = value.trim().toLocaleLowerCase();
    if (!query) { container.hidden = true; container.innerHTML = ""; return; }
    const matches = this._products.filter((product) => [product.name, product.original_name, product.brand, product.package_quantity, product.ean].some((part) => String(part || "").toLocaleLowerCase().includes(query))).slice(0, 8);
    container.innerHTML = matches.map((product) => this._suggestionMarkup(product)).join("");
    container.hidden = !matches.length;
    container.querySelectorAll("[data-suggestion]").forEach((button) => button.addEventListener("mousedown", async (event) => {
      event.preventDefault();
      const product = this._products.find((item) => item.id === button.dataset.suggestion);
      if (!product) return;
      this._selectedProduct = product; this._inputValue = product.name;
      const input = this.shadowRoot.querySelector("[data-product-input]"); if (input) input.value = product.name;
      container.hidden = true;
      await this._performInputAction();
      if (this._dialog || !this._error) {
        this._inputValue = "";
        this._selectedProduct = null;
        this._render();
      }
    }));
  }

  _clearInput() {
    this._inputValue = "";
    this._selectedProduct = null;
    this._error = "";
    const input = this.shadowRoot.querySelector("[data-product-input]");
    if (input) input.value = "";
    this._updateSuggestions("");
    if (this._config.allow_filter) this._refreshInventoryContent();
    if (this._config.filter_chips !== false) this._refreshChipContent();
    input?.focus();
  }

  _renderToolbar() {
    const effective = this._displayUnits().map((unit) => this._unitCategory(unit)).filter(Boolean);
    const knownIds = new Set(this._categories.map((category) => category.id));
    const dynamic = [...new Map(effective.filter((category) => !knownIds.has(category.id)).map((category) => [category.id, category])).values()];
    const availableCategories = [...this._categories, ...dynamic];
    const categoryKeys = ["__uncategorized__", ...availableCategories.map((category) => category.id)];
    const selectedCount = this._selectedCategoryIds === null ? categoryKeys.length : this._selectedCategoryIds.size;
    const categoryLabel = this._selectedCategoryIds === null ? haListManagerInventoryCardText("ui.all_categories", {}, this._hass) : haListManagerInventoryCardText("ui.category_selection_count", {p0:(selectedCount), p1:(categoryKeys.length)}, this._hass);
    const choice = (key, name, icon = "mdi:shape-outline") => `<label class="category-choice"><input type="checkbox" data-category-choice="${escapeHtml(key)}" ${this._selectedCategoryIds === null || this._selectedCategoryIds.has(key) ? "checked" : ""}><ha-icon icon="${escapeHtml(icon)}"></ha-icon><span>${escapeHtml(name)}</span></label>`;
    const choices = choice("__uncategorized__", haListManagerInventoryCardText("ui.general", {}, this._hass), "mdi:shape-outline") + availableCategories.sort((a, b) => this._compareCategories(a, b)).map((category) => choice(category.id, category.name, category.icon || "mdi:shape-outline")).join("");
    const labelKeys = ["__unlabeled__", ...this._labels.map((label) => label.id)];
    const selectedLabelCount = this._selectedLabelIds === null ? labelKeys.length : this._selectedLabelIds.size;
    const labelFilterLabel = this._selectedLabelIds === null ? haListManagerInventoryCardText("ui.all_labels", {}, this._hass) : haListManagerInventoryCardText("ui.selected_label_count", {p0:(selectedLabelCount), p1:(labelKeys.length)}, this._hass);
    const labelChoice = (key, name, icon = "mdi:label-outline", color = "") => `<label class="category-choice label-filter-choice" style="${color ? `--label-color:${escapeHtml(color)}` : ""}"><input type="checkbox" data-label-choice="${escapeHtml(key)}" ${this._selectedLabelIds === null || this._selectedLabelIds.has(key) ? "checked" : ""}><ha-icon icon="${escapeHtml(icon)}"></ha-icon><span>${escapeHtml(name)}</span></label>`;
    const labelChoices = labelChoice("__unlabeled__", haListManagerInventoryCardText("ui.without_label", {}, this._hass), "mdi:label-off-outline") + [...this._labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((label) => labelChoice(label.id, label.name, label.icon || "mdi:label-outline", label.color || "")).join("");
    const filterLabel = ({ all: haListManagerInventoryCardText("ui.all", {}, this._hass), zero: haListManagerInventoryCardText("ui.zero_stock", {}, this._hass), zero_one: haListManagerInventoryCardText("inventory.stock_zero_to_one", {}, this._hass), minimum: haListManagerInventoryCardText("ui.at_or_below_minimum_stock", {}, this._hass), below: "< Mindestbestand" })[this._filter] || haListManagerInventoryCardText("ui.all", {}, this._hass);
    const categoryGroups = this._groups().filter(({ flat, units }) => !flat && units.length);
    const allCategoriesExpanded = this._allCategoriesExpanded(categoryGroups);
    const categoryToggleLabel = haListManagerInventoryCardText(this._groupingMode() === "labels" ? "ui.all_labels_count" : "ui.all_categories_count", {p0:(allCategoriesExpanded ? haListManagerInventoryCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerInventoryCardText("ui.expand_lowercase", {}, this._hass))}, this._hass);
    const categoryToggle = this._config.show_category_toggle_button === false ? "" : `<button type="button" class="tool-button" data-toggle-categories aria-expanded="${allCategoriesExpanded}" aria-label="${categoryToggleLabel}" title="${categoryToggleLabel}" ${categoryGroups.length ? "" : "disabled"}><ha-icon icon="mdi:unfold-${allCategoriesExpanded ? "less" : "more"}-horizontal"></ha-icon></button>`;
    const labelsGrouped = this._groupingMode() === "labels";
    const groupingLabel = haListManagerInventoryCardText(labelsGrouped ? "ui.group_by_categories" : "ui.group_by_labels", {}, this._hass);
    const groupingToggle = this._groupingEnabled() ? `<button type="button" class="tool-button ${labelsGrouped ? "active" : ""}" data-toggle-grouping aria-pressed="${labelsGrouped}" aria-label="${escapeHtml(groupingLabel)}" title="${escapeHtml(groupingLabel)}"><ha-icon icon="mdi:${labelsGrouped ? "label-multiple-outline" : "shape-outline"}"></ha-icon></button>` : "";
    const pendingButton = this._pendingScans.length ? `<button class="tool-button text-button pending-scans-button" data-open-pending-scans><ha-icon icon="mdi:barcode-scan"></ha-icon><span>${haListManagerInventoryCardText("scanner.open_scan_count", {p0:(this._pendingScans.length)}, this._hass)}</span></button>` : "";
    const stockFilter = this._config.show_stock_filter_button === false ? "" : `<label class="filter ${this._filter !== "all" ? "active" : ""}" title="${haListManagerInventoryCardText("inventory.stock_filter_value", {p0:(escapeHtml(filterLabel))}, this._hass)}"><ha-icon icon="mdi:filter-variant"></ha-icon><select data-filter aria-label="${haListManagerInventoryCardText("inventory.stock_filter_value", {p0:(escapeHtml(filterLabel))}, this._hass)}"><option value="all">${haListManagerInventoryCardText("ui.all", {}, this._hass)}</option><option value="zero">${haListManagerInventoryCardText("ui.zero_stock", {}, this._hass)}</option><option value="zero_one">${haListManagerInventoryCardText("inventory.stock_zero_to_one", {}, this._hass)}</option><option value="minimum">${haListManagerInventoryCardText("ui.at_or_below_minimum_stock", {}, this._hass)}</option><option value="below">${haListManagerInventoryCardText("ui.below_minimum_stock", {}, this._hass)}</option></select></label>`;
    const hiddenToggle = this._config.show_hidden_button === false ? "" : `<button class="tool-button ${this._showHidden ? "active" : ""}" data-toggle-hidden title="${haListManagerInventoryCardText("ui.hidden_items", {}, this._hass)}"><ha-icon icon="mdi:eye-off-outline"></ha-icon></button>`;
    const detailsToggle = this._config.show_details_button === false ? "" : `<button class="tool-button ${this._showDetails ? "active" : ""}" data-toggle-details title="${haListManagerInventoryCardText("ui.show_product_details", {}, this._hass)}"><ha-icon icon="mdi:text-box-outline"></ha-icon></button>`;
    const labelFilter = this._config.show_label_filter_button === false ? "" : `<div class="label-filter"><button type="button" class="tool-button text-button toolbar-filter-button ${this._selectedLabelIds !== null ? "active" : ""}" data-toggle-label-menu aria-label="${escapeHtml(labelFilterLabel)}" title="${escapeHtml(labelFilterLabel)}"><ha-icon icon="mdi:label-multiple-outline"></ha-icon><span>${escapeHtml(labelFilterLabel)}</span><ha-icon class="filter-menu-chevron" icon="mdi:menu-down"></ha-icon></button>${this._labelMenuOpen ? `<div class="label-menu"><div class="category-menu-actions"><button type="button" data-label-all>${haListManagerInventoryCardText("ui.select_all", {}, this._hass)}</button><button type="button" data-label-none>${haListManagerInventoryCardText("ui.select_none", {}, this._hass)}</button></div><div class="category-choice-list">${labelChoices}</div></div>` : ""}</div>`;
    const categoryFilter = this._config.show_category_filter_button === false ? "" : `<div class="category-filter"><button type="button" class="tool-button text-button toolbar-filter-button ${this._selectedCategoryIds !== null ? "active" : ""}" data-toggle-category-menu aria-label="${escapeHtml(categoryLabel)}" title="${escapeHtml(categoryLabel)}"><ha-icon icon="mdi:shape-outline"></ha-icon><span>${escapeHtml(categoryLabel)}</span><ha-icon class="filter-menu-chevron" icon="mdi:menu-down"></ha-icon></button>${this._categoryMenuOpen ? `<div class="category-menu"><div class="category-menu-actions"><button type="button" data-category-all>${haListManagerInventoryCardText("ui.select_all", {}, this._hass)}</button><button type="button" data-category-none>${haListManagerInventoryCardText("ui.select_none", {}, this._hass)}</button></div><div class="category-choice-list">${choices}</div>${this._groupingEnabled() ? "" : `<label class="category-choice category-group-choice"><input type="checkbox" data-flat-categories ${!this._groupCategories ? "checked" : ""}><ha-icon icon="mdi:format-list-bulleted"></ha-icon><span>${haListManagerInventoryCardText("ui.no_category_grouping", {}, this._hass)}</span></label>`}</div>` : ""}</div>`;
    const tools = `${stockFilter}${hiddenToggle}${detailsToggle}${categoryToggle}${groupingToggle}${pendingButton}`;
    const filters = `${labelFilter}${categoryFilter}`;
    return tools || filters ? `<div class="toolbar">${tools ? `<div class="tools">${tools}</div>` : ""}${filters ? `<div class="toolbar-filters">${filters}</div>` : ""}</div>` : "";
  }

  _configuredChipColor(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length === 3) {
      const channels = value.map(Number);
      if (channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) return `rgb(${channels.map((channel) => Math.round(channel)).join(", ")})`;
    }
    return fallback;
  }
  _chipScopeColor(chip) {
    if (chip.scope === "browser") return this._configuredChipColor(this._config.chip_color_browser_rgb, "rgb(121, 85, 72)");
    if (chip.scope === "list") return this._configuredChipColor(this._config.chip_color_list_rgb, "rgb(67, 160, 71)");
    if (chip.scope === "list_type") return this._configuredChipColor(this._config.chip_color_list_type_rgb, "rgb(3, 169, 244)");
    return this._configuredChipColor(this._config.chip_color_global_rgb, "rgb(96, 125, 139)");
  }
  _chipDisplayColor(chip) {
    if (this._config.chip_color_mode === "none") return "";
    if (chip.scope === "browser") return this._chipScopeColor(chip);
    if (this._config.chip_color_mode === "chip_only") return chip.color || "";
    if (this._config.chip_color_mode === "scope_override") return this._chipScopeColor(chip);
    return chip.color || this._chipScopeColor(chip);
  }
  _filteredChips() {
    const chips = this._displayChips();
    const query = this._config.filter_chips === false ? "" : this._inputValue.trim().toLocaleLowerCase();
    return query ? chips.filter((chip) => chip.name.toLocaleLowerCase().includes(query)) : chips;
  }
  _renderChipButton(chip, dialog = false, categoryColor = null, importantView = false) {
    const importantColor = this._configuredChipColor(this._config.important_chip_color_rgb, "rgb(244, 67, 54)");
    const useImportantColor = this._config.show_important_chips !== false && this._config.chip_color_mode !== "none" && (importantView || (!this._categoryChipsEnabled() && chip.important));
    const color = useImportantColor ? importantColor : this._config.category_chip_colors !== false && this._config.chip_color_mode !== "none" && categoryColor ? categoryColor : this._chipDisplayColor(chip);
    const borderColor = useImportantColor && chip.browser ? this._configuredChipColor(this._config.chip_color_browser_rgb, "rgb(121, 85, 72)") : null;
    const style = `${color ? `--chip-color:${escapeHtml(color)};` : ""}${borderColor ? `--chip-border-color:${escapeHtml(borderColor)};` : ""}`;
    const title = chip.browser ? haListManagerInventoryCardText("ui.use_named_hold_actions", {p0:(chip.name)}, this._hass) : chip.product_id ? haListManagerInventoryCardText("ui.use_product_named", {p0:(chip.product_name || chip.name)}, this._hass) : haListManagerInventoryCardText("ui.use_named", {p0:(chip.name)}, this._hass);
    return `<button type="button" class="quick-chip ${dialog ? "dialog-chip " : ""}${chip.browser ? "browser-chip " : ""}${color ? "colored" : ""}" data-${dialog ? "dialog-" : "quick-"}chip="${escapeHtml(chip.id)}" style="${style}" title="${escapeHtml(title)}">${escapeHtml(chip.name)}</button>`;
  }
  _renderChipCategoryGroups(chips, dialog = false) {
    const queryOpensGroups = !dialog && this._config.filter_chips !== false && Boolean(this._inputValue.trim());
    const groups = this._chipCategoryGroups(chips);
    const layout = this._categoryChipLayout();
    if (["wrap", "compact"].includes(layout)) {
      const context = dialog ? "dialog" : "card";
      const fallbackId = groups.some(({ category }) => category.id === "__important__") ? "__important__" : null;
      const stored = this._wrappedChipCategorySelection(context);
      const selectedId = stored !== undefined ? stored : fallbackId;
      const allExpanded = selectedId === "__all__";
      const activeId = groups.some(({ category }) => (category.id || "__general__") === selectedId) ? selectedId : null;
      const compact = layout === "compact";
      const flow = groups.map(({ category, chips: groupChips }) => {
        const categoryId = category.id || "__general__";
        const active = allExpanded || activeId === categoryId;
        const expanded = queryOpensGroups || active;
        const style = category.color ? `--category-chip-color:${escapeHtml(category.color)}` : "";
        const selector = `<button type="button" class="chip-category-selector ${active ? "active" : ""}" data-chip-category="${escapeHtml(categoryId)}" data-chip-category-dialog="${dialog ? "1" : "0"}" aria-expanded="${expanded}" style="${style}"><ha-icon icon="${escapeHtml(category.icon || "mdi:shape-outline")}"></ha-icon><strong>${escapeHtml(category.name)}</strong>${compact ? "" : `<span>${groupChips.length}</span><ha-icon class="chip-category-chevron" icon="mdi:chevron-${expanded ? "up" : "down"}"></ha-icon>`}</button>`;
        const panel = expanded ? `<section class="chip-category-expanded" style="${style}"><div class="chip-category-items">${groupChips.map((chip) => this._renderChipButton(chip, dialog, category.color || null, category.important === true)).join("")}</div></section>` : "";
        return `${selector}${panel}`;
      }).join("");
      return `<div class="chip-category-groups layout-${layout} ${dialog ? "dialog-chip-categories" : ""}"><div class="chip-category-flow">${flow}</div></div>`;
    }
    return `<div class="chip-category-groups layout-stacked ${dialog ? "dialog-chip-categories" : ""}">${groups.map(({ category, chips: groupChips }) => {
      const categoryId = category.id || "__general__";
      const collapsed = queryOpensGroups ? false : this._chipCategoryCollapsed(categoryId);
      const style = category.color ? `--category-chip-color:${escapeHtml(category.color)}` : "";
      return `<section class="chip-category-group" style="${style}"><button type="button" class="chip-category-header" data-chip-category="${escapeHtml(categoryId)}" data-chip-category-dialog="${dialog ? "1" : "0"}" aria-expanded="${!collapsed}"><ha-icon icon="${escapeHtml(category.icon || "mdi:shape-outline")}"></ha-icon><strong>${escapeHtml(category.name)}</strong><span>${groupChips.length}</span><ha-icon class="chip-category-chevron" icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>${collapsed ? "" : `<div class="chip-category-items">${groupChips.map((chip) => this._renderChipButton(chip, dialog, category.color || null, category.important === true)).join("")}</div>`}</section>`;
    }).join("")}</div>`;
  }
  _renderChips() {
    if (this._config.show_chips === false || !this._displayChips().length) return "";
    const filtered = this._filteredChips();
    if (this._categoryChipsEnabled()) {
      const content = filtered.length ? this._renderChipCategoryGroups(filtered) : `<span class="chips-empty">${haListManagerInventoryCardText("ui.no_quick_entry_matches", {}, this._hass)}</span>`;
      const allExpanded = this._allChipCategoriesExpanded(filtered);
      return `<aside class="quick-chips-panel category-chip-view" aria-label="${haListManagerInventoryCardText("ui.quick_entries", {}, this._hass)}"><h3>${haListManagerInventoryCardText("ui.quick_entries", {}, this._hass)} <button type="button" class="chip-category-toggle-all" data-toggle-chip-categories aria-expanded="${allExpanded}" aria-label="${haListManagerInventoryCardText("ui.all_categories_count", {p0:(allExpanded ? haListManagerInventoryCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerInventoryCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}" title="${haListManagerInventoryCardText("ui.all_categories_count", {p0:(allExpanded ? haListManagerInventoryCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerInventoryCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}">${filtered.length}</button></h3>${content}</aside>`;
    }
    const limit = this._config.chips_limit;
    const visible = this._chipsExpanded ? filtered : filtered.slice(0, limit);
    const remaining = Math.max(0, filtered.length - limit);
    const toggle = filtered.length > limit ? `<button type="button" class="chips-toggle" data-toggle-chips><ha-icon icon="mdi:chevron-${this._chipsExpanded ? "up" : "down"}"></ha-icon>${this._chipsExpanded ? haListManagerInventoryCardText("ui.show_less", {}, this._hass) : limit === 0 ? haListManagerInventoryCardText("ui.show_chip_count", {p0:(remaining)}, this._hass) : haListManagerInventoryCardText("ui.show_more_count", {p0:(remaining)}, this._hass)}</button>` : "";
    return `<aside class="quick-chips-panel" aria-label="${haListManagerInventoryCardText("ui.quick_entries", {}, this._hass)}"><h3>${haListManagerInventoryCardText("ui.quick_entries", {}, this._hass)} <span>${filtered.length}</span></h3><div class="chip-list">${visible.map((chip) => this._renderChipButton(chip)).join("") || `<span class="chips-empty">${haListManagerInventoryCardText("ui.no_quick_entry_matches", {}, this._hass)}</span>`}</div>${toggle}</aside>`;
  }
  _renderChipDialog() {
    if (!this._chipDialog) return "";
    const chips = this._displayChips();
    const content = this._categoryChipsEnabled() ? this._renderChipCategoryGroups(chips, true) : `<div class="dialog-chip-grid">${chips.map((chip) => this._renderChipButton(chip, true)).join("")}</div>`;
    return `<div class="backdrop chip-dialog-backdrop" data-close-chip-dialog><section class="dialog chip-dialog" role="dialog" aria-modal="true"><div class="dialog-header"><div><h3>${haListManagerInventoryCardText("ui.quick_entries", {}, this._hass)}</h3><p class="field-help">${haListManagerInventoryCardText("ui.inventory_content_summary", {p0:(chips.length), p1:(chips.length === 1 ? haListManagerInventoryCardText("ui.chip", {}, this._hass) : haListManagerInventoryCardText("ui.chips", {}, this._hass))}, this._hass)}</p></div><button class="icon-button" data-close-chip-dialog title="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>${content}</section></div>`;
  }
  _renderBrowserChipMenu() {
    const menu = this._browserChipMenu;
    if (!menu?.chip) return "";
    if (menu.confirmAll) return `<div class="backdrop confirmation-backdrop"><section class="dialog confirmation-dialog" role="alertdialog"><span class="confirmation-icon danger"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon></span><h3>${haListManagerInventoryCardText("chips.delete_browser_confirm", {}, this._hass)}</h3><p>${haListManagerInventoryCardText("ui.clear_inventory_browser_chips_warning", {p0:(this._browserChips.length)}, this._hass)}</p><div class="dialog-actions"><button class="danger filled" data-confirm-delete-browser-chips>${haListManagerInventoryCardText("ui.delete_all", {}, this._hass)}</button><button data-cancel-browser-chip-confirmation>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
    const important = this._isChipImportant(menu.chip);
    const importantAction = this._config.show_important_chips !== false ? `<button type="button" data-toggle-important-chip><ha-icon icon="mdi:${important ? "alert-circle-minus-outline" : "alert-circle-plus-outline"}"></ha-icon><span><strong>${important ? haListManagerInventoryCardText("ui.remove_important_mark", {}, this._hass) : haListManagerInventoryCardText("ui.mark_important", {}, this._hass)}</strong><small>${haListManagerInventoryCardText("ui.only_this_inventory", {}, this._hass)}</small></span></button>` : "";
    const browserActions = menu.chip.browser ? `<button type="button" data-delete-browser-chip><ha-icon icon="mdi:delete-outline"></ha-icon><span><strong>${haListManagerInventoryCardText("chips.delete", {}, this._hass)}</strong><small>${haListManagerInventoryCardText("ui.remove_browser_chip_only", {}, this._hass)}</small></span></button><button type="button" data-delete-all-browser-chips><ha-icon icon="mdi:delete-sweep-outline"></ha-icon><span><strong>${haListManagerInventoryCardText("chips.delete_all_browser", {}, this._hass)}</strong><small>${haListManagerInventoryCardText("chips.clear_inventory_browser", {}, this._hass)}</small></span></button>${this._config.allow_save_browser_chips !== false ? `<button type="button" data-save-browser-chip><ha-icon icon="mdi:content-save-outline"></ha-icon><span><strong>${haListManagerInventoryCardText("ui.save_inventory_permanently", {}, this._hass)}</strong><small>${haListManagerInventoryCardText("ui.chip_available_other_browsers", {}, this._hass)}</small></span></button>` : ""}` : "";
    return `<div class="backdrop browser-chip-backdrop" data-close-browser-chip-menu><section class="dialog browser-chip-menu" role="dialog"><div class="dialog-header"><div><h3>${escapeHtml(menu.chip.name)}</h3><p class="field-help">${menu.chip.browser ? haListManagerInventoryCardText("ui.chip_browser_only", {}, this._hass) : menu.chip.categoryProduct ? haListManagerInventoryCardText("ui.quick_entry_product_linked", {}, this._hass) : haListManagerInventoryCardText("help.inventory_chip_important", {}, this._hass)}</p></div><button class="icon-button" data-close-browser-chip-menu><ha-icon icon="mdi:close"></ha-icon></button></div>${menu.status ? `<div class="dialog-status error">${escapeHtml(menu.status)}</div>` : ""}<div class="browser-chip-actions">${importantAction}${browserActions}</div></section></div>`;
  }
  _closeChipDialog() { this._chipDialog = false; this._render(); }
  _closeBrowserChipMenu() { this._browserChipMenu = null; this._render(); }
  async _saveBrowserChipPermanently() {
    const chip = this._browserChipMenu?.chip;
    if (!chip || this._config.allow_save_browser_chips === false || this._busy) return;
    this._busy = true;
    this._browserChipMenu.status = "";
    this._render();
    try {
      const wasImportant = this._isChipImportant(chip);
      const result = await haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/create`, name: chip.name, color: null, scope: "list", list_type: null, list_id: this._listId(), product_id: chip.product_id || null });
      if (wasImportant && result?.chip?.id) await haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/important/set`, list_id: this._listId(), target_type: "chip", target_id: result.chip.id, important: true });
      this._removeBrowserChip(chip);
      this._browserChipMenu = null;
      await this._load(true);
    } catch (error) { if (this._browserChipMenu) this._browserChipMenu.status = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }
  async _toggleImportantChip(chip) {
    if (!chip || this._config.show_important_chips === false || this._busy) return;
    const important = !this._isChipImportant(chip);
    if (chip.browser) {
      if (important) this._importantBrowserChipIds.add(chip.id); else this._importantBrowserChipIds.delete(chip.id);
      this._saveImportantBrowserChips();
      this._closeBrowserChipMenu();
      return;
    }
    const target = this._importantChipTarget(chip);
    if (!target) return;
    this._busy = true;
    try {
      await haListManagerInventoryCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/important/set`, list_id: this._listId(), ...target, important });
      const key = `${target.target_type}:${target.target_id}`;
      if (important) this._importantChipKeys.add(key); else this._importantChipKeys.delete(key);
      this._browserChipMenu = null;
    } catch (error) { if (this._browserChipMenu) this._browserChipMenu.status = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }
  _bindChipButton(button, chip, activate) {
    if (!button || !chip) return;
    button.addEventListener("click", (event) => {
      if (Date.now() < this._suppressChipClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
      activate();
    });
    if (!chip.browser && this._config.show_important_chips === false) return;
    const cancel = () => { clearTimeout(this._chipLongPressTimer); this._chipLongPressTimer = null; };
    const start = (event) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      cancel();
      this._chipLongPressTimer = setTimeout(() => {
        this._suppressChipClickUntil = Date.now() + 900;
        this._chipDialog = false;
        this._browserChipMenu = { chip, confirmAll: false, status: "" };
        this._render();
      }, 650);
    };
    button.addEventListener("pointerdown", start);
    button.addEventListener("mousedown", start);
    button.addEventListener("touchstart", start, { passive: true });
    ["pointerup", "pointercancel", "pointerleave", "mouseup", "mouseleave", "touchend", "touchcancel"].forEach((type) => button.addEventListener(type, cancel));
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }
  _bindChipActions(root = this.shadowRoot) {
    const chips = this._displayChips();
    root.querySelector("[data-toggle-chip-categories]")?.addEventListener("click", () => this._toggleAllChipCategories());
    root.querySelectorAll("[data-chip-category]").forEach((button) => button.addEventListener("click", () => this._toggleChipCategory(button.dataset.chipCategory, button.dataset.chipCategoryDialog === "1")));
    root.querySelectorAll("[data-quick-chip]").forEach((button) => this._bindChipButton(button, chips.find((chip) => chip.id === button.dataset.quickChip), () => this._useChip(chips.find((chip) => chip.id === button.dataset.quickChip))));
    root.querySelectorAll("[data-dialog-chip]").forEach((button) => {
      const chip = chips.find((entry) => entry.id === button.dataset.dialogChip);
      this._bindChipButton(button, chip, async () => { this._chipDialog = false; await this._useChip(chip); });
    });
    root.querySelector("[data-toggle-chips]")?.addEventListener("click", () => { this._chipsExpanded = !this._chipsExpanded; this._render(); });
  }

  _renderPendingScanPicker() {
    if (!this._pendingScanPicker) return "";
    const rows = this._pendingScans.map((scan) => `<button type="button" class="pending-scan-row" data-open-pending-scan="${escapeHtml(scan.id)}"><ha-icon icon="mdi:barcode-scan"></ha-icon><span><strong>${escapeHtml(scan.product_name || `EAN ${scan.ean}`)}</strong><small>${haListManagerInventoryCardText("ui.name_quantity", {p0:(escapeHtml(MODES(this._hass)[scan.action]?.label || scan.action || haListManagerInventoryCardText("ui.scan", {}, this._hass))), p1:(escapeHtml(scan.quantity || 1))}, this._hass)}</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button>`).join("");
    return `<div class="backdrop" data-pending-scan-backdrop><section class="dialog pending-scan-dialog" data-dialog-panel><div class="dialog-header"><h3>${haListManagerInventoryCardText("ui.pending_scans", {}, this._hass)}</h3><button class="icon-button" data-close-pending-scans title="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div><p class="field-help">${haListManagerInventoryCardText("inventory.select_scan_help", {}, this._hass)}</p><div class="pending-scan-list">${rows}</div><div class="dialog-actions"><button data-close-pending-scans>${haListManagerInventoryCardText("ui.close", {}, this._hass)}</button></div></section></div>`;
  }

  async _openRestockDialog() {
    if (this._busy) return;
    this._headerMenuOpen = false;
    const client = new HaListManagerClient(this._hass);
    const result = await this._run(() => client.previewRestock(this._listId()), haListManagerInventoryCardText("errors.restock_load_failed", {}, this._hass));
    this._restockPreview = result?.items || [];
    this._restockDialog = { view: "preview", target_list_id: result?.target_list_id, target_list_name: result?.target_list_name };
    this._render();
  }

  async _applyRestockPreview() {
    if (this._busy || !this._restockDialog?.target_list_id || !this._restockPreview.some((item) => !item.skipped)) return;
    const request = this._run(
      () => new HaListManagerClient(this._hass).applyRestock(this._listId()),
      haListManagerInventoryCardText("errors.shortfall_transfer_failed", {}, this._hass),
    );
    this._render();
    const result = await request;
    if (!result) { this._render(); return; }
    const count = (result.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    if (!count) {
      await this._openRestockDialog();
      this._restockDialog.status = haListManagerInventoryCardText("inventory.preview_refreshed_no_transfer", {}, this._hass);
      this._render();
      return;
    }
    this._restockDialog = null;
    this._actionStatus = haListManagerInventoryCardText("inventory.transfer_success", {p0:(count)}, this._hass);
    await this._load(true);
  }

  async _resetRestockLatch(sourceType, sourceId) {
    if (this._busy) return;
    const request = this._run(
      () => new HaListManagerClient(this._hass).resetRestockLatch(this._listId(), sourceType, sourceId),
      haListManagerInventoryCardText("ui.restock_lock_reset_failed", {}, this._hass),
    );
    this._render();
    const result = await request;
    if (!result) { this._render(); return; }
    await this._openRestockDialog();
    this._restockDialog.status = haListManagerInventoryCardText("inventory.lock_reset_no_transfer", {}, this._hass);
    this._render();
  }

  _renderRestockTransferHistory(item, compact = false) {
    if (compact && !item.last_manual_transfer && !item.last_automatic_transfer) return "";
    if (!item.last_manual_transfer && !item.last_automatic_transfer) return `<small class="restock-transfer-history">${haListManagerInventoryCardText("inventory.no_restock_recorded", {}, this._hass)}</small>`;
    const renderTransfer = (transfer, automatic) => {
      const label = compact ? (automatic ? haListManagerInventoryCardText("ui.automatic", {}, this._hass) : haListManagerInventoryCardText("ui.manual", {}, this._hass)) : (automatic ? haListManagerInventoryCardText("inventory.last_auto_restock", {}, this._hass) : haListManagerInventoryCardText("inventory.last_manual_transfer", {}, this._hass));
      if (compact && !transfer) return "";
      if (!transfer) return `<small class="restock-transfer-history">${haListManagerInventoryCardText("ui.named_not_logged", {p0:(label)}, this._hass)}</small>`;
      const date = new Date(transfer.transferred_at);
      let timestamp = haListManagerInventoryCardText("ui.time_unavailable", {}, this._hass);
      if (transfer.transferred_at && !Number.isNaN(date.getTime())) {
        try {
          timestamp = new Intl.DateTimeFormat(haListManagerInventoryCardTextLocale(this._hass), {
            dateStyle: compact ? "short" : "medium", timeStyle: "short", ...(this._hass?.config?.time_zone ? { timeZone: this._hass.config.time_zone } : {}),
          }).format(date);
        } catch (_error) { timestamp = date.toISOString(); }
      }
      const reason = automatic ? (" " + haListManagerInventoryCardText("ui.reason_suffix", {p0:({ continuous: haListManagerInventoryCardText("ui.minimum_stock", {}, this._hass), fixed: haListManagerInventoryCardText("inventory.fixed_quantity", {}, this._hass), one_to_one: "1:1" }[transfer.mode] || haListManagerInventoryCardText("ui.not_logged", {}, this._hass))}, this._hass)) : "";
      const details = `${label}: ${timestamp} · ${transfer.quantity ?? "?"}×${compact ? "" : ` · ${transfer.target_list_name || haListManagerInventoryCardText("ui.destination_not_logged", {}, this._hass)}${reason}`}`;
      return `<small class="restock-transfer-history">${escapeHtml(details)}</small>`;
    };
    return renderTransfer(item.last_manual_transfer, false) + renderTransfer(item.last_automatic_transfer, true);
  }

  _renderRestockDialog() {
    if (!this._restockDialog) return "";
    const hasEligibleItems = this._restockPreview.some((item) => !item.skipped);
    const transferCount = this._restockPreview.filter((item) => !item.skipped).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const rows = this._restockPreview.map((item) => `<div class="restock-preview-row"><span><span class="restock-row-heading"><strong>${escapeHtml(item.name)}</strong><strong class="${item.skipped ? "restock-locked" : "restock-amount"}">${item.skipped ? `<ha-icon icon="mdi:flag"></ha-icon>${haListManagerInventoryCardText("ui.locked", {}, this._hass)}` : haListManagerInventoryCardText("ui.transferred_quantity", {p0:(item.quantity)}, this._hass)}</strong></span><small>${haListManagerInventoryCardText("inventory.stock_summary", {p0:(item.stock), p1:(item.minimum_stock), p2:(item.quantity)}, this._hass)}</small><small>${haListManagerInventoryCardText("ui.shopping_list_quantity", {p0:(item.already_open || 0)}, this._hass)}</small>${this._renderRestockTransferHistory(item, true)}<details class="restock-details"><summary>${haListManagerInventoryCardText("ui.show_details", {}, this._hass)}</summary>${item.effective_mode === "fixed" ? `<small>${haListManagerInventoryCardText("inventory.fixed_auto_restock_quantity", {p0:(item.effective_fixed_quantity ?? haListManagerInventoryCardText("ui.not_set", {}, this._hass))}, this._hass)}</small>` : ""}<small>${item.skipped ? haListManagerInventoryCardText("inventory.restock_locked_skip", {}, this._hass) : haListManagerInventoryCardText("ui.manual_transfer_quantity", {p0:(item.quantity)}, this._hass)}</small><small>${haListManagerInventoryCardText("help.pending_shopping_quantity", {}, this._hass)}</small>${this._renderRestockTransferHistory(item)}</details></span>${item.latched ? `<button type="button" data-reset-restock-latch="${escapeHtml(item.source_type)}:${escapeHtml(item.source_id)}" title="${haListManagerInventoryCardText("help.reset_restock_lock", {}, this._hass)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:flag-remove-outline"></ha-icon> ${haListManagerInventoryCardText("ui.reset_lock", {}, this._hass)}</button>` : ""}</div>`).join("");
    return `<div class="backdrop" data-restock-backdrop><section class="dialog restock-dialog" role="dialog" aria-modal="true" aria-labelledby="restock-title"><div class="dialog-header"><h3 id="restock-title">${haListManagerInventoryCardText("inventory.transfer_shortage", {}, this._hass)}</h3><button type="button" class="icon-button" data-close-restock aria-label="${haListManagerInventoryCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>${this._restockDialog.target_list_name ? `<p class="field-help restock-target">${haListManagerInventoryCardText("ui.destination_label", {}, this._hass)} <strong>${escapeHtml(this._restockDialog.target_list_name)}</strong></p>` : ""}<details class="restock-explanation"><summary>${haListManagerInventoryCardText("ui.transfer_explanation", {}, this._hass)}</summary><p class="field-help"><strong>${haListManagerInventoryCardText("ui.manual_shortage", {}, this._hass)}</strong> ${haListManagerInventoryCardText("help.restock_to_minimum", {}, this._hass)}</p><p class="field-help"><strong>${haListManagerInventoryCardText("ui.automatic_fixed_restock_quantity", {}, this._hass)}</strong> ${haListManagerInventoryCardText("help.automatic_restock_quantity_only", {}, this._hass)}</p><p class="field-help">${haListManagerInventoryCardText("help.manual_restock_locks", {}, this._hass)}</p><p class="field-help">${haListManagerInventoryCardText("ui.restock_history_unavailable", {}, this._hass)}</p><p class="field-help">${haListManagerInventoryCardText("help.reset_lock_without_transfer", {}, this._hass)}</p></details><div class="restock-preview-list">${rows || `<p class="field-help">${haListManagerInventoryCardText("inventory.no_shortage", {}, this._hass)}</p>`}</div>${this._restockPreview.length && !hasEligibleItems ? `<p class="field-help">${haListManagerInventoryCardText("inventory.all_items_locked", {}, this._hass)}</p>` : ""}${!this._restockDialog.target_list_id ? `<p class="field-help">${haListManagerInventoryCardText("errors.configure_inventory_target", {}, this._hass)}</p>` : ""}${this._restockDialog.status ? `<p class="field-help" role="status">${escapeHtml(this._restockDialog.status)}</p>` : ""}${this._error ? `<p class="error" role="alert">${escapeHtml(this._error)}</p>` : ""}<div class="dialog-actions"><button type="button" class="primary" data-apply-restock ${!this._busy && this._restockDialog.target_list_id && hasEligibleItems ? "" : "disabled"}>${this._busy ? haListManagerInventoryCardText("ui.processing", {}, this._hass) : haListManagerInventoryCardText("inventory.transfer_items", {p0:(transferCount)}, this._hass)}</button><button type="button" data-close-restock>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    if (this._expandedView) this._expandedScrollTop = this.shadowRoot.querySelector("ha-card")?.scrollTop ?? this._expandedScrollTop;
    if (!this._listId()) { this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="empty"><strong>${haListManagerInventoryCardText("ui.select_inventory_list", {}, this._hass)}</strong><span>${haListManagerInventoryCardText("inventory.select_backend_list_help", {}, this._hass)}</span></div></ha-card>`; return; }
    const mode = MODES(this._hass)[this._mode];
    const view = ["panel", "mobile"].includes(this._config.view_mode)
      ? this._config.view_mode
      : (this._isPanelDashboardView() ? "panel" : "auto");
    const content = this._loading && !this._loadedListId ? `<div class="empty"><ha-circular-progress active></ha-circular-progress></div>` : this._renderGroups();
    const count = this._selectedEntryIds.size;
    const selectionText = count === 0
      ? haListManagerInventoryCardText("help.create_group_minimum", {}, this._hass)
      : count === 1
        ? haListManagerInventoryCardText("ui.select_second_group_item", {}, this._hass)
        : haListManagerInventoryCardText("inventory.group_selection_count", {p0:(count)}, this._hass);
    const selectionBar = this._groupSelectionMode ? `<div class="group-selection-bar"><span data-selection-message>${selectionText}</span><button type="button" class="tool-button" data-create-group ${count < 2 ? "disabled" : ""}><ha-icon icon="mdi:group-plus"></ha-icon>${haListManagerInventoryCardText("inventory.create_group", {}, this._hass)}</button><button type="button" class="tool-button" data-cancel-group-selection>${haListManagerInventoryCardText("ui.cancel", {}, this._hass)}</button></div>` : "";
    const scannerActive = this._scannerTargetIsCurrentList();
    const scannerHint = scannerActive
      ? haListManagerInventoryCardText("ui.scanner_target_active", {p0:(MODES(this._hass)[this._mode].label)}, this._hass)
      : mode.help;
    const contentDisplay = this._config.content_display || "card_and_large";
    const largeViewEnabled = contentDisplay !== "card_only";
    const largeOnly = contentDisplay === "large_only";
    const collapsible = this._config.collapsible !== false && !largeOnly;
    const collapsed = !this._expandedView && (largeOnly || (collapsible && this._listCollapsed()));
    const modePanelExpanded = this._modePanelExpanded();
    const belowMinimum = this._entries.filter((entry) => entry.minimum_stock !== null && entry.stock < entry.minimum_stock).length;
    const inventoryStatus = haListManagerInventoryCardText("ui.item_count_suffix", {p0:(this._entries.length), p1:(belowMinimum ? (" " + haListManagerInventoryCardText("inventory.below_minimum_suffix", {p0:(belowMinimum)}, this._hass)) : (" " + haListManagerInventoryCardText("inventory.minimum_met_suffix", {}, this._hass)))}, this._hass);
    const expandedLabel = this._expandedView ? haListManagerInventoryCardText("ui.close_large_view", {}, this._hass) : haListManagerInventoryCardText("ui.open_large_view", {}, this._hass);
    const titleIconStyle = `color:${escapeHtml(this._configuredChipColor(this._config.title_icon_color_rgb, "var(--primary-color)"))}`;
    const titleIcon = largeViewEnabled
      ? `<button type="button" class="inventory-title-icon inventory-expand-toggle" style="${titleIconStyle}" data-toggle-expanded-view aria-pressed="${this._expandedView}" aria-label="${expandedLabel}" title="${expandedLabel}"><ha-icon icon="${escapeHtml(this._config.title_icon || "mdi:package-variant-closed")}"></ha-icon></button>`
      : `<span class="inventory-title-icon inventory-static-icon" style="${titleIconStyle}"><ha-icon icon="${escapeHtml(this._config.title_icon || "mdi:package-variant-closed")}"></ha-icon></span>`;
    const titleContent = `<h2>${escapeHtml(this._config.title || haListManagerInventoryCardText("ui.inventory", {}, this._hass))}</h2><span>${escapeHtml(inventoryStatus)}</span>`;
    const titleCopy = largeOnly
      ? `<button type="button" class="inventory-title-copy" data-toggle-expanded-view aria-expanded="${this._expandedView}">${titleContent}</button>`
      : collapsible
        ? `<button type="button" class="inventory-title-copy" data-toggle-list aria-expanded="${collapsed ? "false" : "true"}">${titleContent}</button>`
        : `<div class="inventory-title-copy">${titleContent}</div>`;
    const titleHeader = `<div class="inventory-title">${titleIcon}${titleCopy}</div>`;
    const modeToggle = this._config.show_mode_toggle !== false ? `<button type="button" class="inventory-mode-toggle" data-toggle-mode-panel aria-expanded="${modePanelExpanded ? "true" : "false"}"><ha-icon icon="mdi:tune-variant"></ha-icon><span>${haListManagerInventoryCardText("ui.mode", {}, this._hass)}</span><ha-icon icon="mdi:chevron-${modePanelExpanded ? "up" : "down"}"></ha-icon></button>` : "";
    const pdfButton = this._config.show_pdf_export_button === true ? `<button type="button" class="inventory-header-action" data-export-pdf title="${haListManagerInventoryCardText("ui.export_inventory_pdf", {}, this._hass)}" ${this._pdfExporting ? "disabled" : ""}><ha-icon icon="mdi:file-pdf-box"></ha-icon><span>${this._pdfExporting ? "PDF …" : "PDF"}</span></button>` : "";
    const itemFontSize = this._config.item_font_size;
    const categoryFontSize = itemFontSize * this._config.category_font_scale / 100;
    const categorySecondaryFontSize = Math.max(9, itemFontSize - 3);
    const categoryIconSize = Math.max(18, itemFontSize * 1.25);
    const dividerBeforeSpacing = this._config.item_divider_before_spacing;
    const dividerAfterSpacing = this._config.item_divider_after_spacing;
    const appearanceStyle = `--ha-list-manager-item-font-size:${itemFontSize}px;--ha-list-manager-secondary-font-size:${Math.max(10, itemFontSize - 2)}px;--ha-list-manager-tertiary-font-size:${Math.max(9, itemFontSize - 3)}px;--ha-list-manager-category-font-size:${categoryFontSize.toFixed(2)}px;--ha-list-manager-category-secondary-font-size:${categorySecondaryFontSize.toFixed(2)}px;--ha-list-manager-category-icon-size:${categoryIconSize.toFixed(2)}px;--ha-list-manager-item-divider-before-spacing:${dividerBeforeSpacing}px;--ha-list-manager-item-divider-after-spacing:${dividerAfterSpacing}px`;
    const dividerClass = this._config.show_item_dividers ? "item-dividers" : "";
    const productsButton = this._hass.user?.is_admin !== true || this._config.show_product_database_button === false ? "" : `<button type="button" class="inventory-header-action" data-open-products title="${haListManagerInventoryCardText("ui.open_product_database", {}, this._hass)}"><ha-icon icon="mdi:database"></ha-icon><span>${haListManagerInventoryCardText("ui.product_database_short", {}, this._hass)}</span></button>`;
    const groupButton = this._config.show_group_button === false ? "" : `<button type="button" class="inventory-header-action ${this._groupSelectionMode ? "active" : ""}" data-toggle-group-selection aria-pressed="${this._groupSelectionMode}" title="${this._groupSelectionMode ? haListManagerInventoryCardText("ui.finish_grouping", {}, this._hass) : haListManagerInventoryCardText("inventory.group_items", {}, this._hass)}"><ha-icon icon="mdi:group"></ha-icon><span>${this._groupSelectionMode ? haListManagerInventoryCardText("ui.finish_grouping", {}, this._hass) : haListManagerInventoryCardText("ui.group_action", {}, this._hass)}</span></button>`;
    const controlCodesButton = `<button type="button" class="inventory-header-action" data-open-control-codes title="${haListManagerInventoryCardText("scanner.show_transaction_qr_codes", {}, this._hass)}"><ha-icon icon="mdi:qrcode"></ha-icon><span>${haListManagerInventoryCardText("ui.qr_codes", {}, this._hass)}</span></button>`;
    const restockButton = `<button type="button" class="inventory-header-action" data-open-restock-preview title="${haListManagerInventoryCardText("ui.review_transfer_shortage", {}, this._hass)}"><ha-icon icon="mdi:cart-arrow-down"></ha-icon><span>${haListManagerInventoryCardText("ui.stock_shortage", {}, this._hass)}</span></button>`;
    const compactRestockButtons = `<button type="button" data-open-restock-preview><ha-icon icon="mdi:cart-arrow-down"></ha-icon><span>${haListManagerInventoryCardText("inventory.transfer_shortage", {}, this._hass)}</span></button>`;
    const compactControlCodesButton = `<button type="button" data-open-control-codes><ha-icon icon="mdi:qrcode"></ha-icon><span>${haListManagerInventoryCardText("ui.stock_mode_qr_codes", {}, this._hass)}</span></button>`;
    const compactMenuItems = `${modeToggle ? `<button type="button" data-toggle-mode-panel><ha-icon icon="mdi:tune-variant"></ha-icon><span>${haListManagerInventoryCardText("ui.select_mode", {}, this._hass)}</span><ha-icon class="compact-menu-chevron" icon="mdi:chevron-${modePanelExpanded ? "up" : "down"}"></ha-icon></button>` : ""}${compactControlCodesButton}${compactRestockButtons}${productsButton ? `<button type="button" data-open-products><ha-icon icon="mdi:database"></ha-icon><span>${haListManagerInventoryCardText("ui.open_product_database_short", {}, this._hass)}</span></button>` : ""}${groupButton ? `<button type="button" class="${this._groupSelectionMode ? "active" : ""}" data-toggle-group-selection aria-pressed="${this._groupSelectionMode}"><ha-icon icon="mdi:group"></ha-icon><span>${this._groupSelectionMode ? haListManagerInventoryCardText("ui.finish_grouping", {}, this._hass) : haListManagerInventoryCardText("inventory.group_items", {}, this._hass)}</span></button>` : ""}${pdfButton ? `<button type="button" data-export-pdf ${this._pdfExporting ? "disabled" : ""}><ha-icon icon="mdi:file-pdf-box"></ha-icon><span>${this._pdfExporting ? haListManagerInventoryCardText("ui.pdf_creating", {}, this._hass) : haListManagerInventoryCardText("ui.export_pdf", {}, this._hass)}</span></button>` : ""}`;
    const wideHeaderActions = `${modeToggle}${controlCodesButton}${restockButton}${productsButton}${groupButton}${pdfButton}`;
    const headerActions = wideHeaderActions ? `<div class="inventory-header-actions"><div class="inventory-header-actions-wide">${wideHeaderActions}</div><div class="compact-header-actions"><button type="button" class="inventory-header-action compact-actions-toggle" data-toggle-header-menu aria-expanded="${this._headerMenuOpen}" title="${haListManagerInventoryCardText("ui.actions", {}, this._hass)}"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>${this._headerMenuOpen ? `<div class="compact-actions-menu">${compactMenuItems}</div>` : ""}</div></div>` : "";
    const inventoryHeader = `<div class="inventory-header">${titleHeader}${headerActions}</div>`;
    const scannerTargetButton = this._config.show_scanner_target_button === false ? "" : `<button class="mode-button scanner ${scannerActive ? "active" : ""}" type="button" title="${scannerActive ? haListManagerInventoryCardText("scanner.deactivate_target", {}, this._hass) : haListManagerInventoryCardText("scanner.activate_this_inventory", {}, this._hass)}" data-toggle-scanner-target><ha-icon icon="mdi:qrcode-scan"></ha-icon></button>`;
    const modePanel = this._config.show_mode_toggle !== false && modePanelExpanded ? `<div class="mode-panel"><div class="modes">${Object.entries(MODES(this._hass)).map(([key, value]) => `<button type="button" class="mode-button mode-${key} ${key === this._mode ? "active" : ""}" style="--mode-color:${value.color}" data-mode="${key}"><ha-icon icon="${value.icon}"></ha-icon><span data-mode-label="${key}">${value.label}${key === this._mode && this._modeRemaining ? ` (${this._modeRemaining})` : ""}</span></button>`).join("")}${scannerTargetButton}</div><p>${escapeHtml(scannerHint)}</p></div>` : "";
    const showChipButton = this._config.show_chip_popup_button !== false && this._displayChips().length;
    const inputActions = `<button type="button" class="clear-input ${showChipButton ? "with-chip-trigger" : ""}" data-clear-input aria-label="${haListManagerInventoryCardText("ui.clear_input", {}, this._hass)}" title="${haListManagerInventoryCardText("ui.clear_input", {}, this._hass)}" ${this._inputValue ? "" : "hidden"}><ha-icon icon="mdi:close-circle"></ha-icon></button>${showChipButton ? `<button type="button" class="chip-popup-trigger" data-open-chip-dialog aria-label="${haListManagerInventoryCardText("chips.open", {}, this._hass)}" title="${haListManagerInventoryCardText("chips.open", {}, this._hass)}"><ha-icon icon="mdi:gesture-tap-button"></ha-icon></button>` : ""}`;
    this._saveInventoryUndo();
    const actionStatus = this._actionStatus ? `<div class="inventory-action-status" role="status"><ha-icon icon="mdi:check-circle-outline"></ha-icon><span>${escapeHtml(this._actionStatus)}</span>${this._lastInventoryBooking && this._lastInventoryBooking.listId === this._listId() && this._lastInventoryBooking.expires > Date.now() ? `<button type="button" class="tool-button" data-undo-booking><ha-icon icon="mdi:undo-variant"></ha-icon><span>${haListManagerInventoryCardText("ui.undo_countdown_prefix", {}, this._hass)}<span data-undo-countdown>${Math.max(0, Math.ceil((this._lastInventoryBooking.expires - Date.now()) / 1000))} s</span>)</span></button>` : ""}</div>` : "";
    const quantityInput = this._config.show_quantity_box === false ? "" : `<input class="quantity" type="number" min="1" step="1" value="1" placeholder="${haListManagerInventoryCardText("ui.count", {}, this._hass)}" data-quantity>`;
    const submitButton = this._config.show_submit_button === false ? "" : `<button class="action-button" type="button" data-action>${escapeHtml(mode.label)}</button>`;
    const cameraButton = this._config.show_camera_scan_button === false ? "" : `<button class="scan-button" type="button" title="${haListManagerInventoryCardText("ui.scan_ean_camera", {}, this._hass)}" data-camera-scan><ha-icon icon="mdi:qrcode-scan"></ha-icon></button>`;
    const inputBlock = `<div class="input-row">${quantityInput}<div class="product-input"><input class="${showChipButton ? "has-chip-trigger" : ""}" type="text" value="${escapeHtml(this._inputValue)}" placeholder="${haListManagerInventoryCardText("ui.item_or_ean", {}, this._hass)}" autocomplete="off" data-product-input>${inputActions}<div class="suggestions" data-suggestions hidden></div></div>${submitButton}${cameraButton}</div>${actionStatus}`;
    const toolbar = this._renderToolbar();
    const beforeEntries = `${this._config.input_row_position === "bottom" ? "" : inputBlock}${this._config.option_row_position === "bottom" ? "" : toolbar}${selectionBar}${this._error ? `<div class="error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${escapeHtml(this._error)}</div>` : ""}`;
    const afterEntries = `${this._config.option_row_position === "bottom" ? toolbar : ""}${this._config.input_row_position === "bottom" ? inputBlock : ""}`;
    const listContent = `${modePanel}${beforeEntries}<div class="entries">${content}</div>${afterEntries}`;
    const cardBody = collapsed ? "" : `<div class="inventory-card-layout"><div class="inventory-list-column">${listContent}</div>${this._renderChips()}</div>`;
    this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card class="view-${view} chips-position-${escapeHtml(this._config.chips_position)} ${dividerClass} ${collapsed ? "list-collapsed" : ""}" style="--active-mode-color:${mode.color};${appearanceStyle}">${inventoryHeader}${cardBody}${this._renderDialog()}${this._renderMemberPicker()}${this._renderGroupPicker()}${this._renderPendingScanPicker()}${this._renderRestockDialog()}${this._renderInventoryUndoChoice()}${this._renderConfirmation()}${this._renderControlCodes()}${this._renderChipDialog()}${this._renderBrowserChipMenu()}</ha-card>`;
    this._bindEvents();
    if (this._controlCodesOpen) this._drawControlCodes();
    this._restoreExpandedScroll();
    const filter = this.shadowRoot.querySelector("[data-filter]"); if (filter) filter.value = this._filter;
  }

  _bindDialogScrollGuard() {
    this.shadowRoot.querySelectorAll(".backdrop").forEach((backdrop) => this._guardBackdropScroll(backdrop));
  }

  _guardBackdropScroll(backdrop) {
    const dialog = backdrop?.querySelector(".dialog");
    if (!backdrop || !dialog) return;
    const canScrollInsideDialog = (target, deltaY) => {
      let node = target?.nodeType === 1 ? target : dialog;
      while (node && dialog.contains(node)) {
        const overflowY = getComputedStyle(node).overflowY;
        const canOverflow = node === dialog || overflowY === "auto" || overflowY === "scroll";
        const maxScrollTop = node.scrollHeight - node.clientHeight;
        if (canOverflow && maxScrollTop > 1) {
          if (deltaY < 0 && node.scrollTop > 0) return true;
          if (deltaY > 0 && node.scrollTop < maxScrollTop - 1) return true;
        }
        if (node === dialog) break;
        node = node.parentElement;
      }
      return false;
    };
    let previousTouchY = null;
    backdrop.addEventListener("touchstart", (event) => { previousTouchY = event.touches[0]?.clientY ?? null; }, { passive: true });
    backdrop.addEventListener("touchmove", (event) => {
      const currentTouchY = event.touches[0]?.clientY;
      if (currentTouchY === undefined || previousTouchY === null) return;
      const deltaY = previousTouchY - currentTouchY;
      previousTouchY = currentTouchY;
      event.stopPropagation();
      if (!canScrollInsideDialog(event.target, deltaY)) event.preventDefault();
    }, { passive: false });
    const resetTouch = () => { previousTouchY = null; };
    backdrop.addEventListener("touchend", resetTouch, { passive: true });
    backdrop.addEventListener("touchcancel", resetTouch, { passive: true });
    backdrop.addEventListener("wheel", (event) => {
      event.stopPropagation();
      if (!canScrollInsideDialog(event.target, event.deltaY)) event.preventDefault();
    }, { passive: false });
  }

  _refreshInventoryContent() {
    const entries = this.shadowRoot.querySelector(".entries");
    if (entries) entries.innerHTML = this._renderGroups();
    this._bindInventoryRowEvents();
  }

  _refreshChipContent() {
    const panel = this.shadowRoot.querySelector(".quick-chips-panel");
    if (!panel) return;
    panel.outerHTML = this._renderChips();
    const nextPanel = this.shadowRoot.querySelector(".quick-chips-panel");
    if (nextPanel) this._bindChipActions(nextPanel);
  }

  _bindInventoryRowEvents(root = this.shadowRoot, bindCategories = true) {
    root.querySelectorAll("[data-adjust]").forEach((button) => button.addEventListener("click", () => { const [id, delta] = button.dataset.adjust.split(":"); this._adjust(id, Number(delta)); }));
    if (bindCategories) root.querySelectorAll("[data-toggle-category]").forEach((button) => button.addEventListener("click", () => this._toggleCategory(button.dataset.toggleCategory, button)));
    root.querySelectorAll("[data-hidden]").forEach((button) => button.addEventListener("click", () => { const [id, hidden] = button.dataset.hidden.split(":"); this._setHidden(id, hidden === "1"); }));
    root.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => { const entry = this._entries.find((item) => item.id === button.dataset.edit); if (entry) this._openEditDialog(entry); }));
    root.querySelectorAll("[data-edit-group]").forEach((button) => button.addEventListener("click", () => { const group = this._inventoryGroups.find((item) => item.id === button.dataset.editGroup); if (group) this._openGroupDialog(group); }));
    root.querySelectorAll("[data-select-entry]").forEach((button) => button.addEventListener("click", () => {
      const entry = this._entries.find((item) => item.id === button.dataset.selectEntry);
      if (entry) this._selectEntryForGroup(entry);
    }));
    root.querySelectorAll("[data-view-image]").forEach((button) => button.addEventListener("click", () => { const entry = this._entries.find((item) => item.id === button.dataset.viewImage); if (entry?.product?.image_url) this._openImageDialog(entry.product.image_url, entry.product.name); }));
  }

  _bindMemberPickerChoices() {
    this.shadowRoot.querySelectorAll("[data-member-picker-entry]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      if (!this._memberPicker) return;
      const entry = this._entries.find((item) => item.id === checkbox.dataset.memberPickerEntry);
      if (!checkbox.checked) {
        this._memberPicker.selected_ids.delete(checkbox.dataset.memberPickerEntry);
        this._render();
        return;
      }
      const select = () => {
        this._memberPicker?.selected_ids.add(checkbox.dataset.memberPickerEntry);
        this._render();
      };
      if (entry) {
        const targetName = this._dialog?.draft?.name?.trim();
        this._requestGroupMove(entry, targetName ? haListManagerInventoryCardText("inventory.named_group_fragment", {p0:(targetName)}, this._hass) : haListManagerInventoryCardText("ui.new_group_fragment", {}, this._hass), select);
      }
      else select();
    }));
  }

  _bindGroupPickerChoices() {
    this.shadowRoot.querySelectorAll("[data-join-group]").forEach((button) => button.addEventListener("click", () => {
      const group = this._inventoryGroups.find((item) => item.id === button.dataset.joinGroup);
      if (group && this._groupPicker?.entry) {
        const entry = this._groupPicker.entry;
        this._requestGroupMove(entry, haListManagerInventoryCardText("inventory.named_group_fragment", {p0:(group.name)}, this._hass), () => this._joinGroup(entry, group));
      }
    }));
  }

  _bindEvents() {
    this.shadowRoot.querySelector("ha-card")?.addEventListener("scroll", (event) => { if (this._expandedView) this._expandedScrollTop = event.currentTarget.scrollTop; }, { passive: true });
    this.shadowRoot.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => element.addEventListener("click", (event) => this._toggleExpandedView(event)));
    this.shadowRoot.querySelector("[data-toggle-list]")?.addEventListener("click", () => { if (!this._expandedView) this._toggleList(); });
    this.shadowRoot.querySelector("[data-toggle-header-menu]")?.addEventListener("click", () => { this._headerMenuOpen = !this._headerMenuOpen; this._render(); });
    this.shadowRoot.querySelectorAll("[data-toggle-mode-panel]").forEach((button) => button.addEventListener("click", () => { this._headerMenuOpen = false; this._toggleModePanel(); }));
    this.shadowRoot.querySelectorAll("[data-export-pdf]").forEach((button) => button.addEventListener("click", () => { this._headerMenuOpen = false; this._exportPdf(); }));
    this.shadowRoot.querySelectorAll("[data-open-control-codes]").forEach((button) => button.addEventListener("click", () => this._openControlCodes()));
    this.shadowRoot.querySelector("[data-undo-booking]")?.addEventListener("click", () => this._undoInventoryBooking());
    this.shadowRoot.querySelector("[data-undo-stock]")?.addEventListener("click", () => this._undoInventoryBooking(false));
    this.shadowRoot.querySelector("[data-undo-both]")?.addEventListener("click", () => this._undoInventoryBooking(true));
    this.shadowRoot.querySelector("[data-cancel-undo]")?.addEventListener("click", () => { this._undoChoice = false; this._render(); });
    this.shadowRoot.querySelectorAll("[data-open-restock-preview]").forEach((button) => button.addEventListener("click", () => this._openRestockDialog()));
    this.shadowRoot.querySelectorAll("[data-close-restock]").forEach((button) => button.addEventListener("click", () => { this._restockDialog = null; this._render(); }));
    this.shadowRoot.querySelector("[data-restock-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { this._restockDialog = null; this._render(); } });
    this.shadowRoot.querySelector("[data-apply-restock]")?.addEventListener("click", () => this._applyRestockPreview());
    this.shadowRoot.querySelectorAll("[data-reset-restock-latch]").forEach((button) => button.addEventListener("click", () => { const [type, id] = button.dataset.resetRestockLatch.split(":"); this._resetRestockLatch(type, id); }));
    this.shadowRoot.querySelectorAll("[data-close-control-codes]").forEach((button) => button.addEventListener("click", () => this._closeControlCodes()));
    this.shadowRoot.querySelector("[data-control-codes-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) this._closeControlCodes(); });
    this.shadowRoot.querySelector("ha-card")?.addEventListener("click", (event) => {
      let changed = false;
      if (this._headerMenuOpen && !event.target.closest(".compact-header-actions")) { this._headerMenuOpen = false; changed = true; }
      if (this._categoryMenuOpen && !event.target.closest(".category-filter")) { this._categoryMenuOpen = false; changed = true; }
      if (this._labelMenuOpen && !event.target.closest(".label-filter")) { this._labelMenuOpen = false; changed = true; }
      if (changed) this._render();
    });
    this.shadowRoot.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => this._selectMode(button.dataset.mode)));
    this.shadowRoot.querySelector("[data-toggle-scanner-target]")?.addEventListener("click", () => this._toggleScannerTarget());
    this.shadowRoot.querySelector("[data-action]")?.addEventListener("click", () => this._performInputAction());
    this.shadowRoot.querySelector("[data-camera-scan]")?.addEventListener("click", () => this._startCameraScan());
    const input = this.shadowRoot.querySelector("[data-product-input]");
    input?.addEventListener("input", (event) => { this._inputValue = event.target.value; this._selectedProduct = null; this._updateSuggestions(event.target.value); if (this._config.allow_filter) this._refreshInventoryContent(); if (this._config.filter_chips !== false) this._refreshChipContent(); });
    input?.addEventListener("focus", () => this._updateSuggestions(input.value));
    input?.addEventListener("blur", () => setTimeout(() => { const suggestions = this.shadowRoot.querySelector("[data-suggestions]"); if (suggestions) suggestions.hidden = true; }, 120));
    input?.addEventListener("keydown", (event) => { if (event.key === "Enter") this._performInputAction(); });
    this.shadowRoot.querySelector("[data-clear-input]")?.addEventListener("click", () => this._clearInput());
    this.shadowRoot.querySelector("[data-open-chip-dialog]")?.addEventListener("click", () => { this._chipDialog = true; this._render(); });
    this._bindChipActions();
    this.shadowRoot.querySelectorAll("[data-close-chip-dialog]").forEach((element) => element.addEventListener("click", (event) => { if (!event.currentTarget.classList.contains("backdrop") || event.target === event.currentTarget) this._closeChipDialog(); }));
    this.shadowRoot.querySelectorAll("[data-close-browser-chip-menu]").forEach((element) => element.addEventListener("click", (event) => { if (!event.currentTarget.classList.contains("backdrop") || event.target === event.currentTarget) this._closeBrowserChipMenu(); }));
    this.shadowRoot.querySelector("[data-delete-browser-chip]")?.addEventListener("click", () => { this._removeBrowserChip(this._browserChipMenu?.chip); this._closeBrowserChipMenu(); });
    this.shadowRoot.querySelector("[data-delete-all-browser-chips]")?.addEventListener("click", () => { this._browserChipMenu.confirmAll = true; this._render(); });
    this.shadowRoot.querySelector("[data-save-browser-chip]")?.addEventListener("click", () => this._saveBrowserChipPermanently());
    this.shadowRoot.querySelector("[data-toggle-important-chip]")?.addEventListener("click", () => this._toggleImportantChip(this._browserChipMenu?.chip));
    this.shadowRoot.querySelector("[data-cancel-browser-chip-confirmation]")?.addEventListener("click", () => { this._browserChipMenu.confirmAll = false; this._render(); });
    this.shadowRoot.querySelector("[data-confirm-delete-browser-chips]")?.addEventListener("click", () => { this._clearBrowserChips(); this._closeBrowserChipMenu(); });
    this.shadowRoot.querySelector("[data-filter]")?.addEventListener("change", (event) => { this._filter = event.target.value; this._render(); });
    this.shadowRoot.querySelector("[data-toggle-hidden]")?.addEventListener("click", () => { this._showHidden = !this._showHidden; this._render(); });
    this.shadowRoot.querySelector("[data-toggle-details]")?.addEventListener("click", () => { this._showDetails = !this._showDetails; this._render(); });
    this.shadowRoot.querySelectorAll("[data-toggle-group-selection]").forEach((button) => button.addEventListener("click", () => { this._headerMenuOpen = false; this._groupSelectionMode = !this._groupSelectionMode; this._selectedEntryIds.clear(); this._render(); }));
    this.shadowRoot.querySelector("[data-toggle-categories]")?.addEventListener("click", () => this._toggleAllCategories());
    this.shadowRoot.querySelector("[data-toggle-grouping]")?.addEventListener("click", () => this._toggleGrouping());
    this.shadowRoot.querySelector("[data-cancel-group-selection]")?.addEventListener("click", () => { this._groupSelectionMode = false; this._selectedEntryIds.clear(); this._render(); });
    this.shadowRoot.querySelector("[data-create-group]")?.addEventListener("click", () => this._openGroupDialog(null, [...this._selectedEntryIds]));
    this.shadowRoot.querySelectorAll("[data-open-products]").forEach((button) => button.addEventListener("click", () => { this._headerMenuOpen = false; history.pushState(null, "", "/ha_list_manager/products"); window.dispatchEvent(new Event("popstate")); }));
    this.shadowRoot.querySelector("[data-open-pending-scans]")?.addEventListener("click", () => {
      if (this._pendingScans.length === 1) this._openPendingScan(this._pendingScans[0]);
      else { this._pendingScanPicker = true; this._render(); }
    });
    this.shadowRoot.querySelectorAll("[data-open-pending-scan]").forEach((button) => button.addEventListener("click", () => {
      this._openPendingScan(this._pendingScans.find((scan) => scan.id === button.dataset.openPendingScan));
    }));
    this.shadowRoot.querySelectorAll("[data-close-pending-scans]").forEach((button) => button.addEventListener("click", () => { this._pendingScanPicker = false; this._render(); }));
    this.shadowRoot.querySelector("[data-pending-scan-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { this._pendingScanPicker = false; this._render(); } });
    this.shadowRoot.querySelector("[data-toggle-category-menu]")?.addEventListener("click", () => { this._categoryMenuOpen = !this._categoryMenuOpen; this._labelMenuOpen = false; this._render(); });
    this.shadowRoot.querySelector("[data-category-all]")?.addEventListener("click", () => { this._selectedCategoryIds = null; this._render(); });
    this.shadowRoot.querySelector("[data-category-none]")?.addEventListener("click", () => { this._selectedCategoryIds = new Set(); this._render(); });
    this.shadowRoot.querySelectorAll("[data-category-choice]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      const allKeys = new Set(["__uncategorized__", ...this._categories.map((category) => category.id), ...this._displayUnits().map((unit) => this._unitCategory(unit)?.id).filter(Boolean)]);
      if (this._selectedCategoryIds === null) this._selectedCategoryIds = new Set(allKeys);
      if (checkbox.checked) this._selectedCategoryIds.add(checkbox.dataset.categoryChoice); else this._selectedCategoryIds.delete(checkbox.dataset.categoryChoice);
      const allCount = allKeys.size;
      if (this._selectedCategoryIds.size === allCount) this._selectedCategoryIds = null;
      this._render();
    }));
    this.shadowRoot.querySelector("[data-flat-categories]")?.addEventListener("change", (event) => { this._groupCategories = !event.target.checked; this._render(); });
    this.shadowRoot.querySelector("[data-toggle-label-menu]")?.addEventListener("click", () => { this._labelMenuOpen = !this._labelMenuOpen; this._categoryMenuOpen = false; this._render(); });
    this.shadowRoot.querySelector("[data-label-all]")?.addEventListener("click", () => { this._selectedLabelIds = null; this._render(); });
    this.shadowRoot.querySelector("[data-label-none]")?.addEventListener("click", () => { this._selectedLabelIds = new Set(); this._render(); });
    this.shadowRoot.querySelectorAll("[data-label-choice]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      const allKeys = new Set(["__unlabeled__", ...this._labels.map((label) => label.id)]);
      if (this._selectedLabelIds === null) this._selectedLabelIds = new Set(allKeys);
      if (checkbox.checked) this._selectedLabelIds.add(checkbox.dataset.labelChoice); else this._selectedLabelIds.delete(checkbox.dataset.labelChoice);
      if (this._selectedLabelIds.size === allKeys.size) this._selectedLabelIds = null;
      this._render();
    }));
    this._bindInventoryRowEvents();
    this.shadowRoot.querySelector("[data-lookup-ean]")?.addEventListener("click", () => this._lookupDialogEan());
    this.shadowRoot.querySelectorAll("[data-name-component]").forEach((button) => button.addEventListener("click", () => this._toggleNameComponent(button.dataset.nameComponent)));
    this.shadowRoot.querySelectorAll(".dialog input,.dialog textarea,.dialog select").forEach((field) => {
      field.addEventListener("keydown", (event) => event.stopPropagation());
      field.addEventListener("keyup", (event) => event.stopPropagation());
    });
    this.shadowRoot.querySelector("[data-save-dialog]")?.addEventListener("click", () => this._saveDialog());
    this.shadowRoot.querySelector("[data-edit-product]")?.addEventListener("click", (event) => { const entry = this._entries.find((item) => item.id === event.currentTarget.dataset.editProduct); if (entry) this._replaceDialog(() => this._openProductEditDialog(entry)); });
    this.shadowRoot.querySelector("[data-delete-entry]")?.addEventListener("click", (event) => { const entry = this._entries.find((item) => item.id === event.currentTarget.dataset.deleteEntry); if (entry) this._deleteEntry(entry); });
    this.shadowRoot.querySelector("[data-delete-group]")?.addEventListener("click", (event) => { const group = this._inventoryGroups.find((item) => item.id === event.currentTarget.dataset.deleteGroup); if (group) this._deleteGroup(group); });
    this.shadowRoot.querySelector("[data-open-member-picker]")?.addEventListener("click", () => this._openMemberPicker());
    this.shadowRoot.querySelectorAll("[data-remove-group-member]").forEach((button) => button.addEventListener("click", () => {
      if (this._dialog?.kind !== "group-edit") return;
      this._syncDialogDraft();
      this._dialog.draft.member_ids = (this._dialog.draft.member_ids || []).filter((id) => id !== button.dataset.removeGroupMember);
      this._render();
    }));
    this.shadowRoot.querySelectorAll("[data-edit-group-member]").forEach((button) => button.addEventListener("click", () => {
      const entry = this._entries.find((item) => item.id === button.dataset.editGroupMember);
      if (entry) this._replaceDialog(() => this._openEditDialog(entry));
    }));
    this.shadowRoot.querySelectorAll("[data-group-adjust]").forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); const [id, delta] = button.dataset.groupAdjust.split(":"); this._adjust(id, Number(delta)); }));
    this.shadowRoot.querySelectorAll("[data-pick-group]").forEach((button) => button.addEventListener("click", () => { const entry = this._entries.find((item) => item.id === button.dataset.pickGroup); if (entry) this._openGroupPicker(entry); }));
    this.shadowRoot.querySelectorAll("[data-new-group-for-entry]").forEach((button) => button.addEventListener("click", () => {
      const entry = this._entries.find((item) => item.id === button.dataset.newGroupForEntry);
      if (entry) this._openNewGroupForEntry(entry);
    }));
    this.shadowRoot.querySelectorAll("[data-edit-entry-group]").forEach((button) => button.addEventListener("click", () => { const group = this._inventoryGroups.find((item) => item.id === button.dataset.editEntryGroup); if (group) this._replaceDialog(() => this._openGroupDialog(group)); }));
    this.shadowRoot.querySelectorAll("[data-remove-entry-group]").forEach((button) => button.addEventListener("click", () => {
      const entry = this._entries.find((item) => item.id === button.dataset.removeEntryGroup);
      const group = entry ? this._groupForEntry(entry.id) : null;
      if (entry && group) this._requestRemoveEntryFromGroup(entry, group);
    }));
    this.shadowRoot.querySelectorAll("[data-close-member-picker]").forEach((button) => button.addEventListener("click", () => { this._memberPicker = null; this._render(); }));
    this.shadowRoot.querySelector("[data-member-picker-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { this._memberPicker = null; this._render(); } });
    this.shadowRoot.querySelector("[data-show-grouped-members]")?.addEventListener("change", (event) => { if (this._memberPicker) { this._memberPicker.show_grouped = event.target.checked; this._render(); } });
    const memberSearch = this.shadowRoot.querySelector("[data-member-picker-search]");
    memberSearch?.addEventListener("input", (event) => {
      this._memberPicker.query = event.target.value;
      const list = this.shadowRoot.querySelector("[data-member-picker-list]");
      if (list) list.innerHTML = this._renderMemberPickerChoices();
      this._bindMemberPickerChoices();
    });
    this.shadowRoot.querySelector("[data-apply-member-picker]")?.addEventListener("click", () => this._applyMemberPicker());
    this._bindMemberPickerChoices();
    this.shadowRoot.querySelectorAll("[data-close-group-picker]").forEach((button) => button.addEventListener("click", () => { this._groupPicker = null; this._render(); }));
    this.shadowRoot.querySelector("[data-group-picker-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { this._groupPicker = null; this._render(); } });
    const groupSearch = this.shadowRoot.querySelector("[data-group-picker-search]");
    groupSearch?.addEventListener("input", (event) => {
      this._groupPicker.query = event.target.value;
      const list = this.shadowRoot.querySelector("[data-group-picker-list]");
      if (list) list.innerHTML = this._renderGroupPickerChoices();
      this._bindGroupPickerChoices();
    });
    this._bindGroupPickerChoices();
    this.shadowRoot.querySelector("[data-confirm-accept]")?.addEventListener("click", () => this._resolveConfirmation(true));
    this.shadowRoot.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => this._resolveConfirmation(false));
    this.shadowRoot.querySelector("[data-confirmation-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) this._resolveConfirmation(false); });
    this.shadowRoot.querySelector("[data-dialog-image]")?.addEventListener("click", () => { const draft = this._dialog?.draft; if (draft?.image_url) this._openImageDialog(draft.image_url, draft.name); });
    this.shadowRoot.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => this._closeDialog()));
    this.shadowRoot.querySelector("[data-backdrop]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) this._closeDialog(); });
    this.shadowRoot.querySelectorAll("[data-dialog-panel] [data-field]").forEach((field) => {
      field.addEventListener("input", () => this._updateDialogDirtyIndicator());
      field.addEventListener("change", () => this._updateDialogDirtyIndicator());
    });
    this._configureCategoryPicker();
    this._configureLabelSelector();
    this._installPickerListTriggers();
    this._bindDialogScrollGuard();
  }

  _styles() { return `
    *{box-sizing:border-box}[hidden]{display:none!important}:host{display:block;container-type:inline-size}:host([data-expanded-view]){position:fixed!important;top:var(--expanded-top,56px)!important;right:var(--expanded-right,0)!important;bottom:var(--expanded-bottom,0)!important;left:var(--expanded-left,0)!important;z-index:9998;min-width:0!important;max-width:none!important;padding:16px;overflow:hidden;background:var(--primary-background-color,#111)}:host([data-expanded-view]) ha-card{height:100%;min-height:0!important;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,.45)}ha-card{position:relative;overflow:visible;padding:12px 14px 18px;color:var(--primary-text-color)}button,input,select{font:inherit}button:disabled{opacity:.42;cursor:not-allowed}.inventory-header{display:flex;align-items:center;gap:8px;height:50px;min-height:50px;margin:0 0 8px}.inventory-title{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:8px;flex:1;min-width:0}.inventory-title-icon{display:grid;place-items:center;width:35px;height:35px;padding:5px;border-radius:50%;color:var(--primary-color)}.inventory-title-icon ha-icon{--mdc-icon-size:25px}.inventory-expand-toggle{border:0;background:transparent;cursor:pointer}.inventory-static-icon{pointer-events:none}.inventory-expand-toggle:hover,.inventory-expand-toggle:focus-visible{outline:0;background:color-mix(in srgb,var(--primary-text-color) 12%,transparent)}.inventory-title-copy{display:grid;grid-template-rows:auto auto;row-gap:1px;min-width:0;width:100%;padding:0;border:0;color:var(--primary-text-color);background:transparent;text-align:left}.inventory-title-copy[data-toggle-list],.inventory-title-copy[data-toggle-expanded-view]{cursor:pointer}.inventory-title-copy[data-toggle-list]:hover,.inventory-title-copy[data-toggle-expanded-view]:hover{background:color-mix(in srgb,var(--primary-text-color) 5%,transparent)}.inventory-title h2{min-width:0;overflow:hidden;margin:0;font-size:24px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}.inventory-title-copy>span{min-width:0;overflow:hidden;color:var(--secondary-text-color);font-size:13px;text-overflow:ellipsis;white-space:nowrap}.list-collapsed{height:76px;padding:12px 14px}.list-collapsed .inventory-header{margin:0}.inventory-header-actions{display:flex;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;gap:6px}.inventory-mode-toggle,.inventory-header-action{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 11px;border:1px solid var(--divider-color);border-radius:19px;color:var(--primary-color);background:transparent;cursor:pointer}.inventory-mode-toggle ha-icon,.inventory-header-action ha-icon{--mdc-icon-size:19px}.inventory-mode-toggle span,.inventory-header-action span{font-size:13px}.view-panel{border:0!important;background:var(--ha-card-background,var(--card-background-color))!important;box-shadow:none!important}.mode-panel{padding:10px 12px;border-left:4px solid var(--active-mode-color);border-radius:8px;background:var(--secondary-background-color)}.modes{display:flex;flex-wrap:wrap;gap:7px}.mode-button,.tool-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 12px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.mode-button.active{color:#fff;border-color:var(--mode-color);background:var(--mode-color)}.tool-button.active{color:var(--primary-color);border-color:var(--primary-color)}.pending-scans-button{color:var(--warning-color,#f0a000);border-color:var(--warning-color,#f0a000)}.mode-panel p{margin:10px 0 0;color:var(--secondary-text-color);font-size:14px}.inventory-action-status{display:flex;align-items:center;gap:7px;margin:8px 0 14px;padding:8px 10px;border-left:3px solid var(--active-mode-color);border-radius:5px;background:color-mix(in srgb,var(--active-mode-color) 10%,transparent);font-size:13px}.inventory-action-status ha-icon{--mdc-icon-size:19px;color:var(--active-mode-color)}.input-row{display:flex;align-items:stretch;gap:8px;margin:8px 0 14px}.input-row>.quantity{flex:0 0 92px}.input-row input{width:100%;height:44px;padding:0 11px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color)}.product-input{position:relative;flex:1 1 160px;min-width:0}.product-input>input{padding-right:42px}.clear-input{position:absolute;z-index:3;right:5px;top:5px;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;color:var(--secondary-text-color);background:transparent;cursor:pointer}.clear-input:hover{color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 10%,transparent)}.clear-input ha-icon{--mdc-icon-size:20px}.suggestions{position:absolute;z-index:8;top:calc(100% + 4px);left:0;right:0;max-height:310px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35)}.suggestions button{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:9px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.suggestions button:hover{background:var(--secondary-background-color)}.suggestions img,.suggestion-placeholder{display:grid;place-items:center;width:38px;height:38px;border-radius:5px;object-fit:contain;background:var(--secondary-background-color)}.suggestions button>span:last-child{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:3px}.suggestions small{color:var(--secondary-text-color)}.suggestion-source{display:flex;align-items:center;gap:4px}.suggestion-source ha-icon{--mdc-icon-size:14px}.action-button{flex:0 0 auto;padding:0 18px;border:0;border-radius:8px;color:#fff;background:var(--active-mode-color);cursor:pointer}.scan-button{flex:0 0 42px}.scan-button,.icon-button{display:grid;place-items:center;width:42px;height:42px;padding:0;border:0;border-radius:50%;color:var(--primary-text-color);background:transparent;cursor:pointer}.scan-button:hover,.icon-button:hover{background:var(--secondary-background-color)}h2{margin:4px 0 14px;font-size:27px;font-weight:400}.toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start;margin:7px 0 10px;padding:6px;border-radius:8px;background:var(--secondary-background-color)}.tools{display:flex;flex-wrap:wrap;gap:6px}.filter{display:flex;align-items:center;gap:6px;min-height:38px;padding:0 10px;border:1px solid var(--divider-color);border-radius:9px;color:var(--secondary-text-color);background:var(--card-background-color)}.toolbar .tool-button{min-height:38px;padding:0 10px;border-radius:9px;color:var(--secondary-text-color);background:var(--card-background-color)}.toolbar .tool-button:not(:disabled):hover,.toolbar .tool-button:not(:disabled):focus-visible,.filter:focus-within{color:var(--primary-color);border-color:var(--primary-color);outline:0;background:color-mix(in srgb,var(--primary-color) 10%,var(--card-background-color))}.toolbar .tool-button ha-icon,.filter ha-icon{--mdc-icon-size:19px}.filter select{border:0;color:var(--primary-text-color);background:transparent}.text-button{padding:0 13px}.toolbar-filters{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px}.category-filter,.label-filter{position:relative}.category-menu,.label-menu{position:absolute;z-index:20;right:0;top:calc(100% + 6px);width:min(350px,calc(100vw - 36px));max-height:420px;overflow:auto;padding:10px;border:1px solid var(--divider-color);border-radius:9px;background:var(--card-background-color);box-shadow:0 9px 28px rgba(0,0,0,.4)}.category-menu-actions{display:flex;gap:7px;padding-bottom:8px;border-bottom:1px solid var(--divider-color)}.category-menu-actions button{padding:6px 10px;border:1px solid var(--divider-color);border-radius:6px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.category-choice-list{padding:5px 0}.category-choice{display:grid!important;grid-template-columns:auto 24px 1fr;align-items:center;gap:8px;margin:0!important;padding:7px 4px;color:var(--primary-text-color)!important;cursor:pointer}.category-choice input{width:18px;height:18px}.category-choice ha-icon{--mdc-icon-size:20px}.label-filter-choice ha-icon{color:var(--label-color,var(--primary-color))}.category-group-choice{padding-top:10px;border-top:1px solid var(--divider-color)}.category{margin-top:9px}.category-header{display:flex;align-items:center;gap:8px;width:100%;min-height:37px;padding:5px 12px;border:0;border-radius:5px;color:#fff;background:var(--category-color,var(--primary-color));text-align:left;cursor:pointer}.category-header strong{font-size:var(--ha-list-manager-category-font-size)}.category-header>ha-icon{--mdc-icon-size:var(--ha-list-manager-category-icon-size)}.category-header span{margin-left:2px;font-size:var(--ha-list-manager-category-secondary-font-size)}.category-header span b{color:#ffe082}.category-chevron{margin-left:auto}.entry{display:grid;align-items:center;padding:0 8px 0 4px;border-left:4px solid transparent}.category-header+.entry,.entry+.entry{padding-top:var(--ha-list-manager-item-divider-after-spacing)}.entry:not(:last-child){padding-bottom:var(--ha-list-manager-item-divider-before-spacing)}.item-dividers .entry{position:relative}.item-dividers .entry:not(:last-child){padding-bottom:calc(var(--ha-list-manager-item-divider-before-spacing) + 1px)}.item-dividers .entry:not(:last-child)::after{content:"";position:absolute;z-index:1;left:8px;right:8px;bottom:0;height:1px;background:var(--divider-color);pointer-events:none}.entry.with-image{grid-template-columns:46px 56px minmax(0,1fr) auto}.entry.without-image{grid-template-columns:46px minmax(0,1fr) auto}.entry.stock-low{border-left-color:var(--warning-color,#f0a000)}.entry.stock-empty{border-left-color:var(--error-color)}.entry.stock-empty .entry-title{color:var(--error-color)}.entry.is-hidden{opacity:.58}.product-image{display:grid;place-items:center;align-self:center;position:relative;width:48px;height:48px;margin-right:4px;padding:0;overflow:hidden;border:0;border-radius:6px;background:var(--secondary-background-color);cursor:pointer}.product-image img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.product-image-placeholder{color:var(--disabled-text-color,var(--secondary-text-color))}.entry-main{display:flex;flex-direction:column;align-items:flex-start;align-self:center;gap:4px;min-width:0;padding:0 8px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.entry-title{font-size:var(--ha-list-manager-item-font-size);line-height:1}.entry-title ha-icon{--mdc-icon-size:18px;color:var(--secondary-text-color)}.entry-details{color:var(--secondary-text-color);font-size:var(--ha-list-manager-secondary-font-size);line-height:1}.stock-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px;min-width:92px}.controls-stock{min-width:36px;text-align:center;font-size:var(--ha-list-manager-item-font-size)}.labels{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}.label-chip{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;line-height:1;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 55%,var(--divider-color));border-radius:14px;color:var(--primary-text-color);background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent);font-size:var(--ha-list-manager-tertiary-font-size)}.inventory-action-status [data-undo-booking]{white-space:nowrap;flex-shrink:0}.label-chip ha-icon{--mdc-icon-size:13px;color:var(--label-color,var(--primary-color))}.error{display:flex;align-items:center;gap:8px;margin:8px 0;padding:10px 12px;border-left:4px solid var(--error-color);background:color-mix(in srgb,var(--error-color) 10%,transparent)}.empty{min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--secondary-text-color)}.backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.58);overscroll-behavior:contain;touch-action:none}.dialog{position:relative;width:min(680px,100%);max-height:calc(100vh - 36px);overflow:auto;padding:22px;border-radius:12px;background:var(--card-background-color);box-shadow:0 12px 40px rgba(0,0,0,.4);overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y}.dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dialog-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.unsaved-indicator{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:14px;color:var(--warning-color,#f0a000);background:color-mix(in srgb,var(--warning-color,#f0a000) 14%,transparent);font-size:12px;font-weight:500}.unsaved-indicator ha-icon{--mdc-icon-size:17px}.dialog h3{margin:0;font-size:23px}.dialog-product{display:block;margin:10px 0;font-size:18px}.dialog label,.dialog-field{display:flex;flex-direction:column;gap:6px;margin-top:13px;color:var(--secondary-text-color)}.dialog input,.dialog select{min-height:45px;padding:9px 11px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color)}.dialog ha-combo-box{display:block;width:100%}.field-help{margin:7px 0;color:var(--secondary-text-color);font-size:13px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ean-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px}.ean-row .dialog-status{grid-column:1/-1}.ean-row button,.dialog-actions button,.name-options button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 16px;border:1px solid var(--divider-color);border-radius:21px;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.name-options{display:flex;gap:8px;margin-top:10px}.name-options button.active{color:#fff;border-color:var(--primary-color);background:var(--primary-color)}.dialog-image-button{position:absolute;right:22px;top:68px;width:105px;height:105px;padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer}.dialog-image{position:absolute;right:22px;top:68px;width:105px;height:105px;object-fit:contain;border-radius:8px;background:var(--secondary-background-color)}.dialog-image-button .dialog-image{inset:0}.dialog-image-placeholder{display:grid;place-items:center;color:var(--secondary-text-color)}.dialog-image-placeholder ha-icon{--mdc-icon-size:42px}.product-dialog>label:first-of-type{padding-right:120px}.dialog-status{display:flex;align-items:center;gap:7px;margin:3px 0 0;color:var(--primary-color);font-size:14px}.dialog-status ha-icon{--mdc-icon-size:19px}.dialog-status.success{color:var(--success-color,#2e7d32)}.dialog-status.warning{color:var(--warning-color,#f0a000)}.dialog-status.error{color:var(--error-color,#db4437)}.pending-scan-list{display:grid;gap:7px;margin-top:14px}.pending-scan-row{display:grid;grid-template-columns:32px minmax(0,1fr) 28px;align-items:center;gap:8px;width:100%;padding:11px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);background:var(--secondary-background-color);text-align:left;cursor:pointer}.pending-scan-row span{display:flex;flex-direction:column;gap:3px}.pending-scan-row small{color:var(--secondary-text-color)}.dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:9px;margin-top:22px}.dialog-actions .primary{color:#fff;border-color:var(--primary-color);background:var(--primary-color)}.dialog-actions .danger{color:var(--error-color);border-color:var(--error-color)}.label-selector{display:grid;gap:8px;margin-top:14px;padding:10px;border:1px solid var(--divider-color);border-radius:8px;color:var(--secondary-text-color)}.selected-labels{display:flex;flex-wrap:wrap;gap:7px}.selected-label{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:3px 8px;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 58%,var(--divider-color));border-radius:18px;color:var(--primary-text-color);background:color-mix(in srgb,var(--label-color,var(--primary-color)) 24%,var(--card-background-color));cursor:pointer}.selected-label ha-icon{--mdc-icon-size:18px;color:var(--label-color,var(--primary-color))}.selected-label .remove-label{--mdc-icon-size:17px;color:var(--secondary-text-color)}.label-combo{position:relative}.label-search{display:grid;grid-template-columns:26px 1fr;align-items:center;min-height:45px;padding:0 10px;border:1px solid var(--divider-color);border-radius:7px;background:var(--secondary-background-color)}.label-search ha-icon{--mdc-icon-size:21px}.label-search input{min-height:42px!important;padding:0!important;border:0!important;outline:0;background:transparent!important}.label-picker-options{position:absolute;z-index:18;top:calc(100% + 4px);left:0;right:0;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35)}.label-picker-options button{display:grid;grid-template-columns:32px 1fr;align-items:center;gap:8px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.label-picker-options button>span:last-child{display:flex;min-width:0;flex-direction:column;gap:2px}.label-picker-options button small{display:block;color:var(--secondary-text-color)}.label-picker-options button:hover{background:var(--secondary-background-color)}.label-option-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;color:var(--label-color,var(--primary-color));background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent)}.label-option-icon ha-icon{--mdc-icon-size:19px}.label-empty{margin:0;padding:13px;color:var(--secondary-text-color)}.image-dialog{width:min(900px,100%)}.image-dialog>img{display:block;max-width:100%;max-height:calc(100vh - 130px);margin:14px auto 0;object-fit:contain}
    .picker-trigger-host{position:relative}.picker-trigger-host input{padding-right:44px!important}.picker-list-trigger{position:absolute!important;z-index:4;right:5px;top:50%;display:grid!important;place-items:center;width:34px!important;height:34px!important;min-width:34px!important;min-height:34px!important;padding:0!important;transform:translateY(-50%);border:0!important;border-radius:50%!important;color:var(--primary-color)!important;background:transparent!important;cursor:pointer}.picker-list-trigger:hover,.picker-list-trigger:focus-visible,.picker-list-trigger.active{outline:0;background:color-mix(in srgb,var(--primary-color) 16%,transparent)!important}.picker-list-trigger ha-icon{--mdc-icon-size:21px}.picker-current{box-shadow:inset 3px 0 0 var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))!important}.category-combo{position:relative}.category-combo>input{width:100%}.category-picker-options{position:absolute;z-index:15;top:calc(100% + 4px);left:0;right:0;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35)}.category-picker-options button{display:grid;grid-template-columns:28px 1fr;align-items:center;gap:8px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.category-picker-options button:hover{background:var(--secondary-background-color)}.category-picker-options span{display:flex;flex-direction:column}.category-picker-options small{color:var(--secondary-text-color)}.category-picker-options .picker-empty{padding:12px}.category-picker-options .category-option-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;color:var(--category-color,var(--primary-color));background:color-mix(in srgb,var(--category-color,var(--primary-color)) 20%,transparent)}.category-picker-options .category-option-icon ha-icon{--mdc-icon-size:19px}.group-selection-bar{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin:-4px 0 12px;padding:9px 12px;border-left:4px solid var(--primary-color);border-radius:7px;background:var(--secondary-background-color)}.group-selection-bar span{margin-right:auto}.group-select{display:grid;place-items:center;width:42px;height:42px;padding:0;border:0;color:var(--secondary-text-color);background:transparent;cursor:pointer}.group-select.selected{color:var(--primary-color)}.group-visibility-spacer,.group-icon{display:grid;place-items:center;width:42px}.group-icon{color:var(--primary-color)}.inventory-group{border-left-color:var(--primary-color)}.group-members{margin-top:16px;padding:10px;border:1px solid var(--divider-color);border-radius:8px}.group-members legend{padding:0 6px}.group-member-choice{display:grid!important;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;margin:0!important;padding:8px;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color)!important}.group-member-choice small{color:var(--secondary-text-color)}.group-member-open{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0;padding:5px;border:0;border-radius:6px;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.group-member-open:hover{background:var(--secondary-background-color)}.group-member-stock{display:flex;flex-direction:row!important}.group-dialog{width:min(760px,100%)}.add-members-button,.entry-group-actions button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 11px;border:1px solid var(--divider-color);border-radius:18px;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.add-members-button{margin-top:10px}.entry-group-section{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding:9px 11px;border:1px solid var(--divider-color);border-radius:9px}.entry-group-summary{display:flex;flex-direction:column;gap:3px;min-width:0}.entry-group-summary>span,.entry-group-summary>small{color:var(--secondary-text-color);font-size:13px}.entry-group-summary>strong{display:flex;align-items:center;gap:6px}.entry-group-summary>strong ha-icon{--mdc-icon-size:19px;color:var(--primary-color)}.entry-group-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.entry-group-actions .danger{color:var(--error-color);border-color:var(--error-color)}.nested-backdrop{z-index:1100}.confirmation-backdrop{z-index:1200}.picker-dialog{width:min(620px,100%)}.group-move-warning{display:flex;flex-wrap:wrap;align-items:flex-start;gap:9px;margin-top:12px;padding:10px 12px;border-left:4px solid var(--warning-color,#f0a000);border-radius:6px;color:var(--primary-text-color);background:color-mix(in srgb,var(--warning-color,#f0a000) 14%,var(--card-background-color));font-size:13px;line-height:1.45}.group-move-warning ha-icon{flex:0 0 auto;color:var(--warning-color,#f0a000)}.group-move-warning>span{flex:1;min-width:0}.show-grouped-toggle{display:flex!important;flex:0 0 100%;flex-direction:row!important;align-items:center;gap:8px!important;margin:4px 0 0 33px!important;color:var(--primary-text-color)!important}.show-grouped-toggle input{width:18px;height:18px;min-height:0!important;padding:0!important}.picker-search{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;margin-top:12px;padding:0 10px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color)}.picker-search input{width:100%;border:0!important;outline:0;background:transparent!important}.picker-list{max-height:min(48vh,430px);margin-top:10px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;overscroll-behavior:contain}.picker-choice{display:grid!important;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;margin:0!important;padding:10px 12px;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color)!important}.picker-choice.belongs-to-group{background:color-mix(in srgb,var(--warning-color,#f0a000) 7%,transparent)}.picker-choice>span,.group-picker-choice>span{display:flex;flex-direction:column;gap:3px}.picker-choice small,.group-picker-choice small{color:var(--secondary-text-color)}.picker-choice .move-note{display:flex;align-items:center;gap:4px;color:var(--warning-color,#f0a000)}.picker-choice .move-note ha-icon{--mdc-icon-size:16px}.picker-limit{margin:0;padding:9px 12px;color:var(--secondary-text-color);background:var(--secondary-background-color);font-size:12px}.group-picker-choice{display:grid;grid-template-columns:28px minmax(0,1fr) 28px;align-items:center;gap:9px;width:100%;padding:11px 12px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.group-picker-choice:hover{background:var(--secondary-background-color)}.picker-empty{margin:0;padding:18px;color:var(--secondary-text-color)}.confirmation-dialog{width:min(460px,100%);text-align:center}.confirmation-dialog>p{margin-top:10px;color:var(--secondary-text-color);line-height:1.5}.confirmation-dialog .dialog-actions{justify-content:center}.confirmation-icon{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 12px;border-radius:50%}.confirmation-icon ha-icon{--mdc-icon-size:31px}.confirmation-icon.danger{color:var(--error-color);background:color-mix(in srgb,var(--error-color) 14%,transparent)}.confirmation-icon.warning{color:var(--warning-color);background:color-mix(in srgb,var(--warning-color) 14%,transparent)}.dialog-actions .danger.filled{color:#fff;border-color:var(--error-color);background:var(--error-color)}
    .control-codes-dialog{width:min(720px,100%)}.control-codes-dialog .dialog-header{align-items:flex-start}.control-codes-dialog .dialog-header>div{flex:1;min-width:0}.control-codes-dialog .dialog-header h3{margin:0}.control-code-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}.control-code{display:flex;align-items:center;gap:12px;min-width:0;padding:12px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}.control-code-qr{display:grid;place-items:center;flex:0 0 160px;width:160px;height:160px;padding:2px;color:#111;background:#fff}.control-code-qr img,.control-code-qr canvas{display:block;width:156px!important;height:156px!important}.control-code>div:last-child{display:flex;min-width:0;flex-direction:column;gap:6px}.control-code strong{display:flex;align-items:center;gap:6px}.control-code strong ha-icon{--mdc-icon-size:20px}.control-code code{font-size:11px;overflow-wrap:anywhere}.control-code-fallback{padding:10px;font-size:11px;overflow-wrap:anywhere}
    .inventory-card-layout{display:block}.inventory-list-column{min-width:0}.view-panel.chips-position-auto .inventory-card-layout,.chips-position-right .inventory-card-layout,:host([data-expanded-view]) .chips-position-auto .inventory-card-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);align-items:start;gap:16px}.quick-chips-panel{min-width:0;margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--divider-color)}.view-panel.chips-position-auto .quick-chips-panel,.chips-position-right .quick-chips-panel,:host([data-expanded-view]) .chips-position-auto .quick-chips-panel{margin:0;padding:0 0 0 16px;border-top:0;border-left:1px solid var(--divider-color)}.quick-chips-panel h3{display:flex;align-items:center;gap:6px;margin:0 0 8px;color:var(--secondary-text-color);font-size:13px;font-weight:500}.quick-chips-panel h3 span,.quick-chips-panel h3 .chip-category-toggle-all{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border:0;border-radius:11px;color:inherit;background:var(--secondary-background-color);font-size:12px}.quick-chips-panel h3 .chip-category-toggle-all:hover,.quick-chips-panel h3 .chip-category-toggle-all:focus-visible{color:var(--primary-color);outline:1px solid var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--secondary-background-color))}.chip-list,.chip-category-items,.dialog-chip-grid{display:flex;flex-wrap:wrap;gap:7px}.quick-chip{min-height:32px;padding:4px 11px;border:1px solid var(--divider-color);border-radius:17px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.quick-chip.colored{border-color:color-mix(in srgb,var(--chip-border-color,var(--chip-color)) 70%,var(--divider-color));background:color-mix(in srgb,var(--chip-color) 20%,var(--card-background-color))}.quick-chip:hover{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.quick-chip.colored:hover{border-color:var(--chip-border-color,var(--chip-color));background:color-mix(in srgb,var(--chip-color) 30%,var(--card-background-color))}.chips-toggle{display:flex;align-items:center;gap:4px;margin-top:9px;padding:3px 9px;border:0;color:var(--primary-color);background:transparent;cursor:pointer}.chips-toggle ha-icon{--mdc-icon-size:18px}.chips-empty{color:var(--secondary-text-color);font-size:13px}.chip-popup-trigger{position:absolute;z-index:3;right:5px;top:5px;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;color:var(--primary-color);background:transparent;cursor:pointer}.clear-input.with-chip-trigger{right:39px}.product-input>input.has-chip-trigger{padding-right:78px}.chip-category-groups,.quick-chips-panel>.chip-category-groups{display:grid;gap:7px;width:100%}.chip-category-group,.chip-category-expanded{min-width:0;overflow:hidden;border:1px solid var(--divider-color);border-radius:9px}.quick-chips-panel .chip-category-header,.chip-category-header{display:grid;grid-template-columns:24px minmax(0,1fr) auto 22px;align-items:center;gap:7px;width:100%;min-height:40px;padding:6px 8px;border:0;border-radius:0;color:var(--primary-text-color);background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 15%,var(--card-background-color));text-align:left;cursor:pointer}.quick-chips-panel .chip-category-header:hover,.chip-category-header:hover{border:0;background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 23%,var(--card-background-color))}.chip-category-header>ha-icon:first-child{--mdc-icon-size:20px;color:var(--category-chip-color,var(--primary-color))}.chip-category-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.chip-category-header>span{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;color:var(--secondary-text-color);background:color-mix(in srgb,var(--primary-text-color) 8%,transparent);font-size:12px}.chip-category-chevron{--mdc-icon-size:19px;color:var(--secondary-text-color)}.chip-category-items{display:flex;flex-wrap:wrap;gap:7px;padding:8px;border-top:1px solid var(--divider-color);background:color-mix(in srgb,var(--secondary-background-color) 40%,transparent)}.chip-category-expanded .chip-category-items{border-top:0}.chip-category-flow{display:flex;flex-wrap:wrap;gap:7px;width:100%}.chip-category-flow>.chip-category-expanded{flex:0 0 100%;width:100%}.quick-chips-panel .chip-category-selector,.chip-category-selector{display:grid;grid-template-columns:22px minmax(0,auto) auto 19px;align-items:center;gap:6px;max-width:100%;min-height:40px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 52%,var(--divider-color));border-radius:9px;color:var(--primary-text-color);background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 15%,var(--card-background-color));text-align:left}.quick-chips-panel .chip-category-selector:hover,.chip-category-selector:hover,.quick-chips-panel .chip-category-selector.active,.chip-category-selector.active{border-color:var(--category-chip-color,var(--primary-color));background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 27%,var(--card-background-color))}.chip-category-selector>ha-icon:first-child{--mdc-icon-size:19px;color:var(--category-chip-color,var(--primary-color))}.chip-category-selector strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.chip-category-selector>span{display:grid;place-items:center;min-width:21px;height:21px;padding:0 6px;border-radius:11px;color:var(--secondary-text-color);background:color-mix(in srgb,var(--primary-text-color) 8%,transparent);font-size:12px}.layout-compact .chip-category-selector{grid-template-columns:20px minmax(0,auto);min-height:34px;padding:4px 9px;border-radius:18px}.dialog-chip-categories{display:grid;gap:9px;margin-top:18px}.dialog-chip-categories .chip-category-header{min-height:46px;padding:7px 11px}.dialog-chip-categories .chip-category-items{padding:10px}.chip-dialog{width:min(760px,100%)}.chip-dialog-backdrop{z-index:1250}.dialog-chip-grid{margin-top:14px}.browser-chip-menu{width:min(520px,100%)}.browser-chip-backdrop{z-index:1300}.browser-chip-actions{display:grid;gap:9px;margin-top:16px}.browser-chip-actions>button{display:grid;grid-template-columns:30px minmax(0,1fr);align-items:center;gap:10px;width:100%;padding:11px 13px;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-text-color);background:var(--secondary-background-color);text-align:left;cursor:pointer}.browser-chip-actions span{display:flex;flex-direction:column;gap:2px}.browser-chip-actions small{color:var(--secondary-text-color)}
    .restock-dialog{width:min(720px,100%)}.restock-row-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}.restock-row-heading>strong:last-child{font-size:13px}.restock-amount{color:var(--primary-color)}.restock-details summary,.restock-explanation summary{cursor:pointer;color:var(--primary-color);padding:7px 0;min-height:32px}.restock-details[open]{display:grid;gap:5px}.restock-details small{display:block;margin:4px 0}.restock-target{margin:0 0 6px}.restock-explanation{font-size:13px}.switch-field{display:flex!important;flex-direction:row!important;align-items:center;justify-content:space-between;gap:16px;padding:10px 0}.switch-field>span{display:flex;flex-direction:column;gap:3px}.switch-field small{color:var(--secondary-text-color)}.switch-field input{width:22px;height:22px;min-height:0}.restock-preview-list{display:grid;gap:8px;margin-top:14px}.restock-preview-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--divider-color);border-radius:8px}.restock-preview-row>span{display:flex;flex:1 1 260px;min-width:0;flex-direction:column;gap:4px}.restock-preview-row small{color:var(--secondary-text-color)}.restock-preview-row .restock-locked{display:flex;align-items:center;gap:5px;color:var(--warning-color,#f0a000)}.restock-locked ha-icon{flex-shrink:0;--mdc-icon-size:18px}.restock-preview-row button{display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:0 10px;border:1px solid var(--warning-color,#f0a000);border-radius:18px;color:var(--warning-color,#f0a000);background:transparent}.restock-flag{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;color:var(--warning-color,#f0a000);background:transparent;cursor:pointer}.restock-flag ha-icon{--mdc-icon-size:18px}
    .inventory-header-actions-wide{display:flex;gap:6px}.inventory-header-action.active{color:var(--primary-color);border-color:var(--primary-color)}.compact-header-actions{display:none;position:relative}.compact-actions-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;display:grid;width:max-content;min-width:210px;overflow:hidden;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);box-shadow:0 8px 26px rgba(0,0,0,.38)}.compact-actions-menu button{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 14px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.compact-actions-menu button:last-child{border-bottom:0}.compact-actions-menu button:hover,.compact-actions-menu button.active{background:var(--secondary-background-color)}.compact-actions-menu button.active{color:var(--primary-color)}.compact-actions-menu ha-icon{--mdc-icon-size:20px;color:var(--primary-color)}.compact-actions-menu .compact-menu-chevron{margin-left:auto;color:var(--secondary-text-color)}
    @container(max-width:580px){.control-code-grid{grid-template-columns:1fr}.control-code{justify-content:flex-start}.control-code-qr{flex-basis:144px;width:144px;height:144px}.control-code-qr img,.control-code-qr canvas{width:140px!important;height:140px!important}}
    @media(max-width:580px){.control-code-grid{grid-template-columns:1fr}.control-code{justify-content:flex-start}.control-code-qr{flex-basis:144px;width:144px;height:144px}.control-code-qr img,.control-code-qr canvas{width:140px!important;height:140px!important}}
    @container(max-width:700px){.toolbar-filter-button{display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}.toolbar-filter-button>span,.toolbar-filter-button>.filter-menu-chevron{display:none}}
    @media(max-width:700px){.toolbar-filter-button{display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}.toolbar-filter-button>span,.toolbar-filter-button>.filter-menu-chevron{display:none}}
    .view-mobile .toolbar-filter-button{display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}.view-mobile .toolbar-filter-button>span,.view-mobile .toolbar-filter-button>.filter-menu-chevron{display:none}
    @container(max-width:700px){ha-card,.list-collapsed{padding:10px}.inventory-header{height:54px;min-height:54px;margin:0 0 4px}.list-collapsed .inventory-header{margin:0}.inventory-header-actions-wide{display:none}.compact-header-actions{display:block}.compact-actions-toggle{width:38px;padding:0}.inventory-title h2{font-size:21px}.mode-panel{padding:8px}.mode-button{padding:0 8px;font-size:13px}.input-row{flex-wrap:wrap}.input-row>.quantity{flex-basis:76px}.action-button{order:2;flex:1 0 100%;height:42px;min-height:42px}.scan-button{flex:0 0 42px}.toolbar{grid-template-columns:minmax(0,1fr);grid-auto-flow:row}.tools,.toolbar-filters{width:100%;justify-content:flex-start}.category-filter,.label-filter{position:static;justify-self:start}.category-menu,.label-menu{left:6px;right:6px;top:calc(100% + 6px);width:auto;max-width:none}.entry.with-image{grid-template-columns:40px 46px minmax(0,1fr) auto}.entry.without-image{grid-template-columns:40px minmax(0,1fr) auto}.product-image{width:40px;height:40px}.stock-actions{grid-column:auto;justify-content:flex-end;margin-left:0}.entry-title{font-size:var(--ha-list-manager-item-font-size)}.entry-details{font-size:var(--ha-list-manager-secondary-font-size)}.field-grid,.ean-row{grid-template-columns:1fr}.dialog-image{position:static;display:grid;width:90px;height:90px;margin:10px auto}.product-dialog>label:first-of-type{padding-right:0}.entry-group-section{align-items:flex-start;flex-direction:column}.entry-group-actions{justify-content:flex-start}.view-panel.chips-position-auto .inventory-card-layout,.chips-position-right .inventory-card-layout,:host([data-expanded-view]) .chips-position-auto .inventory-card-layout{display:block}.view-panel.chips-position-auto .quick-chips-panel,.chips-position-right .quick-chips-panel,:host([data-expanded-view]) .chips-position-auto .quick-chips-panel{margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--divider-color);border-left:0}}
    @media(max-width:700px){ha-card{padding:10px}.inventory-header{height:54px;min-height:54px;margin:0 0 4px}.list-collapsed .inventory-header{margin:0}.inventory-title h2{font-size:21px}.mode-panel{padding:8px}.mode-button{padding:0 8px;font-size:13px}.input-row{flex-wrap:wrap}.input-row>.quantity{flex-basis:76px}.action-button{order:2;flex:1 0 100%;height:42px;min-height:42px}.scan-button{flex:0 0 42px}.toolbar{grid-template-columns:minmax(0,1fr);grid-auto-flow:row}.tools,.toolbar-filters{width:100%;justify-content:flex-start}.category-filter,.label-filter{position:static;justify-self:start}.category-menu,.label-menu{left:6px;right:6px;top:calc(100% + 6px);width:auto;max-width:none}.entry.with-image{grid-template-columns:40px 46px minmax(0,1fr) auto}.entry.without-image{grid-template-columns:40px minmax(0,1fr) auto}.product-image{width:40px;height:40px}.stock-actions{grid-column:auto;justify-content:flex-end;margin-left:0}.entry-title{font-size:var(--ha-list-manager-item-font-size)}.entry-details{font-size:var(--ha-list-manager-secondary-font-size)}.field-grid,.ean-row{grid-template-columns:1fr}.dialog-image{position:static;display:grid;width:90px;height:90px;margin:10px auto}.product-dialog>label:first-of-type{padding-right:0}.entry-group-section{align-items:flex-start;flex-direction:column}.entry-group-actions{justify-content:flex-start}}
    .view-mobile .toolbar{grid-template-columns:minmax(0,1fr);grid-auto-flow:row}.view-mobile .tools,.view-mobile .toolbar-filters{width:100%;justify-content:flex-start}.view-mobile .category-filter,.view-mobile .label-filter{position:static;justify-self:start}.view-mobile .category-menu,.view-mobile .label-menu{left:6px;right:6px;top:calc(100% + 6px);width:auto;max-width:none}.view-mobile .entry.with-image{grid-template-columns:40px 46px minmax(0,1fr) auto}.view-mobile .entry.without-image{grid-template-columns:40px minmax(0,1fr) auto}.view-mobile .stock-actions{grid-column:auto;justify-content:flex-end;margin-left:0}.view-mobile .input-row{flex-wrap:wrap}.view-mobile .input-row>.quantity{flex-basis:76px}.view-mobile .action-button{order:2;flex:1 0 100%;height:42px;min-height:42px}.view-mobile .scan-button{flex:0 0 42px}.view-mobile .inventory-card-layout{display:block!important}.view-mobile .quick-chips-panel{margin:14px 0 0!important;padding:12px 0 0!important;border-top:1px solid var(--divider-color)!important;border-left:0!important}
    .filter.active,.toolbar .tool-button.active{color:var(--primary-color);border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,var(--card-background-color))}
    @container(max-width:700px){.toolbar{position:relative;display:flex;flex-wrap:wrap;gap:7px}.toolbar .tools,.toolbar .toolbar-filters{width:auto}.filter{position:relative;display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}.filter select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}}
    @media(max-width:700px){.toolbar{position:relative;display:flex;flex-wrap:wrap;gap:7px}.toolbar .tools,.toolbar .toolbar-filters{width:auto}.filter{position:relative;display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}.filter select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}}
    .view-mobile .toolbar{position:relative;display:flex;flex-wrap:wrap;gap:7px}.view-mobile .toolbar .tools,.view-mobile .toolbar .toolbar-filters{width:auto}.view-mobile .filter{position:relative;display:grid;place-items:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:9px}.view-mobile .filter select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
  `; }
}

class HaListManagerInventoryCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._form = null;
  }

  set hass(value) {
    this._hass = value;
    haListManagerInventoryCardTextUpdateTranslations(this, value);
    this._render();
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    if (!this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (event) => {
        this._config = { ...this._config, ...event.detail.value };
        this.dispatchEvent(new CustomEvent("config-changed", {
          bubbles: true,
          composed: true,
          detail: { config: this._config },
        }));
      });
      this.shadowRoot.append(this._form);
    }
    const definition = HaListManagerInventoryCard.getConfigForm(this._hass);
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = definition.schema;
    this._form.computeLabel = definition.computeLabel;
    this._form.computeHelper = definition.computeHelper;
  }
}

if (!customElements.get("ha-list-manager-inventory-card-editor")) customElements.define("ha-list-manager-inventory-card-editor", HaListManagerInventoryCardEditor);
if (!customElements.get("ha-list-manager-inventory-card")) customElements.define("ha-list-manager-inventory-card", HaListManagerInventoryCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "ha-list-manager-inventory-card")) window.customCards.push({ type: "ha-list-manager-inventory-card", name: "HA List Manager · Inventory", preview: false, documentationURL: "https://github.com/Nisbo/ha-list-manager/wiki" });
console.info(`%c HA-LIST-MANAGER-INVENTORY-CARD %c v${CARD_VERSION} `, "color:white;background:#03a9f4;font-weight:bold", "color:#03a9f4;background:white;font-weight:bold");
