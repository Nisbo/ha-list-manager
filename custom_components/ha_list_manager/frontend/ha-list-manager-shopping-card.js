import "./ha-list-manager-shopping-scanner.js";
import "./ha-list-manager-filters.js";
import "./ha-list-manager-product-editor.js";
import "./ha-list-manager-dialog-sections.js";

// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerShoppingCardTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerShoppingCardTextLanguage(hass = null) {
  return haListManagerShoppingCardTextLocale(hass).toLowerCase().split("-")[0] === "de" ? "de" : "en";
}
function haListManagerShoppingCardText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerShoppingCardTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerShoppingCardTextLocale(hass));
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
function haListManagerShoppingCardTextUpdateTranslations(element, hass) {
  if (!hass) return false;
  const previous = element._nativeTranslationState;
  const language = String(hass.language || haListManagerShoppingCardTextLocale(hass));
  const connection = hass.connection || hass;
  const changed = !previous || previous.language !== language || previous.connection !== connection;
  const wasReady = previous?.ready;
  let state = previous;
  if (changed) {
    state = { language, connection, previousLocalize: previous?.localize, switched: Boolean(previous && previous.language !== language), localize: hass.localize, renderedLocalize: hass.localize, ready: false };
    // Preloaded resources are immediately usable, including in an editor.
    state.ready = Boolean(haListManagerShoppingCardText("ui.cancel", {}, hass)) && (!state.switched || hass.localize !== state.previousLocalize);
    element._nativeTranslationState = state;
    haListManagerShoppingCardTextLoadTranslations(hass).then((localize) => {
      if (element._nativeTranslationState !== state) return;
      state.needsRefresh = Boolean(localize && localize !== state.renderedLocalize);
      const current = element._hass;
      if (!current || String(current.language || haListManagerShoppingCardTextLocale(current)) !== language || (current.connection || current) !== connection) return;
      if (haListManagerShoppingCardText("ui.cancel", {}, current) && (!state.switched || current.localize !== state.previousLocalize) && (!state.ready || (state.needsRefresh && current.localize !== state.renderedLocalize))) {
        state.ready = true;
        state.needsRefresh = false;
        state.renderedLocalize = current.localize;
        haListManagerShoppingCardTextUpdateMetadata(current);
        element._render();
      }
    }).catch((error) => {
      if (element._nativeTranslationState === state) console.warn(error);
    });
  } else if (!state.ready && haListManagerShoppingCardText("ui.cancel", {}, hass) && (!state.switched || hass.localize !== state.previousLocalize)) {
    state.ready = true;
  }
  const refresh = state.ready && state.needsRefresh && hass.localize !== state.renderedLocalize;
  if (state.ready && (changed || !wasReady || refresh)) { state.renderedLocalize = hass.localize; state.needsRefresh = false; }
  state.localize = hass.localize;
  if (state.ready && (changed || !wasReady || refresh)) haListManagerShoppingCardTextUpdateMetadata(hass);
  return state.ready && (changed || !wasReady || refresh);
}
function haListManagerShoppingCardTextUpdateMetadata(hass) {
  const metadata = window.customCards?.find((card) => card.type === "ha-list-manager-shopping-card");
  if (metadata) {
    metadata.name = haListManagerShoppingCardText("ui.shopping_card_name", {}, hass) || metadata.name;
    metadata.description = haListManagerShoppingCardText("shopping.card_description", {}, hass);
  }
}
function haListManagerShoppingCardTextRequest(hass, message) {
  return hass.callWS(message.type?.startsWith("ha_list_manager/") ? { ...message, language: haListManagerShoppingCardTextLanguage(hass) } : message);
}

// Backend-backed shopping card. Its layout and interaction model intentionally
// follow the established ha-list-manager card while product, label
// and category data comes from the integration.
const HA_LM_API = "ha_list_manager";
const HA_LM_ITEMS_EVENT = "ha_list_manager_items_changed";
const HA_LM_LISTS_EVENT = "ha_list_manager_lists_changed";
const CARD_VERSION = "1.1.0b2";

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const largeImageUrl = (value) => {
  const url = String(value || "");
  if (!url.includes("images.openfoodfacts.org/")) return url;
  return url.replace(/\.(?:100|200|400)\.(jpe?g|png|webp)(?=\?|$)/i, ".full.$1");
};

// Backend category and label colors are normalized to opaque #RRGGBB.
const categoryTextColor = (color) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color || ""));
  if (!hex) return "#fff";
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex[1].slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000" : "#fff";
};

class HaListManagerShoppingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._items = [];
    this._products = [];
    this._categories = [];
    this._labels = [];
    this._chips = [];
    this._dishes = [];
    this._browserChips = [];
    this._importantChipKeys = new Set();
    this._importantBrowserChipIds = new Set();
    this._chipCategories = new Map();
    this._wrappedChipCategoryOpen = {};
    this._notificationAssignments = [];
    this._bringRefreshTimer = null;
    this._notificationStatus = "";
    this._pdfExporting = false;
    this._headerMenuOpen = false;
    globalThis.HaListManagerFilters.init(this);
    this._list = null;
    this._inputValue = "";
    this._suggestions = [];
    this._suggestionsVisible = false;
    this._productPicker = null;
    this._dialog = null;
    this._confirmation = null;
    this._imageDialog = null;
    this._loading = false;
    this._loadRequestId = 0;
    this._busy = false;
    this._error = "";
    this._unsubscribe = null;
    this._subscribePromise = null;
    this._renderListeners = [];
    this._searchTimer = null;
    this._chipsExpanded = false;
    this._chipDialog = false;
    this._dishDialog = null;
    this._tandoorDialog = null;
    this._tandoorSearchTimer = null;
    this._tandoorSearchRequestId = 0;
    this._browserChipMenu = null;
    this._itemAction = null;
    this._selectionPopup = null;
    this._chipLongPressTimer = null;
    this._suppressChipClickUntil = 0;
    this._expandedView = false;
    this._expandedViewWasCollapsed = false;
    this._expandedPageOverflow = null;
    this._expandedViewport = null;
    this._expandedResizeObserver = null;
    this._expandedResizeFrame = null;
    this._expandedScrollTop = 0;
    this._expandedScrollFrame = null;
    this._expandedScrollTimer = null;
    this._expandedScrollAnchor = null;
    this._onExpandedViewResize = () => this._scheduleExpandedViewBounds();
    this._onExpandedViewKeydown = (event) => {
      if (event.key === "Escape" && this._labelFilterDialog) {
        event.preventDefault(); event.stopPropagation(); this._cancelFilterView(); return;
      }
      if (event.key === "Escape" && this._imageDialog) {
        event.preventDefault(); event.stopPropagation(); this._closeDialog(); return;
      }
      if (event.key === "Escape" && this._selectionPopup) {
        event.preventDefault(); event.stopPropagation();
        this._closeSelectionPopup();
        return;
      }
      if (event.key === "Escape" && (this._itemAction || this._dialog?.item_actions_open)) {
        event.preventDefault(); event.stopPropagation();
        if (this._itemAction) this._closeItemAction(); else this._toggleItemActions();
        return;
      }
      if (event.key === "Escape" && this._confirmation?.type === "discard_dialog") {
        event.preventDefault(); event.stopPropagation(); this._cancelConfirmation(); return;
      }
      if (event.key === "Escape" && this._dialog) {
        event.preventDefault(); event.stopPropagation(); this._closeDialog(); return;
      }
      if (event.key === "Escape" && this._filterMenuOpen) {
        event.preventDefault(); event.stopPropagation(); this._closeFilterMenu(true); return;
      }
      if (event.key === "Escape" && this._expandedView) this._setExpandedView(false);
    };
  }

  static getConfigElement() {
    return document.createElement("ha-list-manager-shopping-card-editor");
  }

  static getConfigForm(hass = null) {
    const entities = Object.entries(hass?.states || {})
      .filter(([entityId, state]) => entityId.startsWith("sensor.") && ["shopping", "bring"].includes(state.attributes?.list_type))
      .map(([entityId]) => entityId)
      .sort((left, right) => left.localeCompare(right));
    const labels = {
      entity: haListManagerShoppingCardText("ui.shopping_list", {}, hass), title: haListManagerShoppingCardText("ui.title", {}, hass), title_icon: haListManagerShoppingCardText("ui.title_icon", {}, hass), title_icon_color_rgb: haListManagerShoppingCardText("ui.title_icon_color", {}, hass), view_mode: haListManagerShoppingCardText("ui.appearance", {}, hass), content_display: haListManagerShoppingCardText("ui.show_content", {}, hass), collapsible: haListManagerShoppingCardText("ui.list_collapsible", {}, hass),
      input_row_position: haListManagerShoppingCardText("ui.input_row", {}, hass), option_row_position: haListManagerShoppingCardText("ui.button_bar", {}, hass), show_category_toggle_button: haListManagerShoppingCardText("ui.show_category_toggle", {}, hass), quantity_position: haListManagerShoppingCardText("shopping.quantity_position", {}, hass),
      label_grouping: haListManagerShoppingCardText("ui.label_grouping", {}, hass),
      add_dialog_behavior: haListManagerShoppingCardText("shopping.add_dialog", {}, hass), category_sort: haListManagerShoppingCardText("ui.category_sort_order", {}, hass),
      show_camera_scan_button: haListManagerShoppingCardText("scan.camera_option", {}, hass),
      show_scanner_target_button: haListManagerShoppingCardText("ui.show_scanner_target_button", {}, hass),
      show_quantity_box: haListManagerShoppingCardText("ui.show_quantity_field", {}, hass), show_submit_button: haListManagerShoppingCardText("ui.show_add_button", {}, hass),
      show_plus_minus: haListManagerShoppingCardText("ui.show_plus_minus_buttons", {}, hass), show_item_dividers: haListManagerShoppingCardText("ui.show_dividers", {}, hass), item_divider_before_spacing: haListManagerShoppingCardText("ui.divider_top_spacing", {}, hass), item_divider_after_spacing: haListManagerShoppingCardText("ui.divider_bottom_spacing", {}, hass), item_font_size: haListManagerShoppingCardText("ui.entry_text_size", {}, hass), category_font_scale: haListManagerShoppingCardText("categories.name_size", {}, hass), acknowledged: haListManagerShoppingCardText("shopping.completed_items", {}, hass),
      show_quantity_one: haListManagerShoppingCardText("shopping.show_quantity_one", {}, hass), allow_filter: haListManagerShoppingCardText("ui.filter_items_typing", {}, hass), auto_expand_search: haListManagerShoppingCardText("ui.auto_expand_search", {}, hass),
      allow_suggestions: haListManagerShoppingCardText("products.show_suggestions", {}, hass), show_done_hidden_items_in_search: haListManagerShoppingCardText("ui.show_completed_search_results", {}, hass),
      show_images: haListManagerShoppingCardText("ui.show_product_images", {}, hass), show_brand: haListManagerShoppingCardText("ui.append_brand_to_name", {}, hass),
      show_quantity: haListManagerShoppingCardText("products.append_package_quantity", {}, hass), show_category_count: haListManagerShoppingCardText("ui.show_category_item_counts", {}, hass),
      show_labels: haListManagerShoppingCardText("ui.show_labels", {}, hass), show_share_button: haListManagerShoppingCardText("ui.show_share_button", {}, hass), show_pdf_export_button: haListManagerShoppingCardText("ui.show_pdf_export", {}, hass),
      show_clear_completed_button: haListManagerShoppingCardText("ui.bulk_delete_completed_items", {}, hass),
      show_label_filter_button: haListManagerShoppingCardText("filters.show", {}, hass),
      show_edit_shortcuts: haListManagerShoppingCardText("shopping.show_edit_shortcuts", {}, hass),
      show_chips: haListManagerShoppingCardText("chips.show", {}, hass), listed_chip_display: haListManagerShoppingCardText("chips.listed_display", {}, hass), chip_font_size: haListManagerShoppingCardText("chips.font_size", {}, hass), filter_chips: haListManagerShoppingCardText("ui.filter_chips_typing", {}, hass),
      category_chip_layout: haListManagerShoppingCardText("chips.category_appearance", {}, hass),
      category_chip_colors: haListManagerShoppingCardText("ui.grouped_chips_category_color", {}, hass),
      show_important_chips: haListManagerShoppingCardText("chips.show_important", {}, hass),
      show_chip_popup_button: haListManagerShoppingCardText("ui.show_chip_input_button", {}, hass),
      show_browser_chips: haListManagerShoppingCardText("ui.use_browser_chips", {}, hass), browser_chips_for_products: haListManagerShoppingCardText("chips.create_browser_product_chips", {}, hass),
      allow_save_browser_chips: haListManagerShoppingCardText("ui.allow_permanent_save", {}, hass),
      chips_position: haListManagerShoppingCardText("ui.position", {}, hass), chips_limit: haListManagerShoppingCardText("ui.initial_visible_chips", {}, hass),
      chip_color_mode: haListManagerShoppingCardText("ui.color_display", {}, hass), chip_color_global_rgb: haListManagerShoppingCardText("ui.global_chip_color", {}, hass),
      chip_color_list_type_rgb: haListManagerShoppingCardText("ui.shopping_chip_color", {}, hass), chip_color_list_rgb: haListManagerShoppingCardText("chips.list_color", {}, hass),
      chip_color_browser_rgb: haListManagerShoppingCardText("ui.browser_chip_color", {}, hass),
      important_chip_color_rgb: haListManagerShoppingCardText("ui.important_chip_color", {}, hass),
      dishes_confirm_add: haListManagerShoppingCardText("ui.review_dish_before_adding", {}, hass),
      dish_color_rgb: haListManagerShoppingCardText("ui.default_dish_color", {}, hass),
    };
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { include_entities: entities } } },
        { type: "expandable", label: haListManagerShoppingCardText("ui.general", {}, hass), icon: "mdi:cog-outline", schema: [
          { name: "title", selector: { text: {} }, default: haListManagerShoppingCardText("ui.shopping_list", {}, hass) },
          { name: "title_icon", selector: { icon: {} }, default: "mdi:cart-variant" },
          { name: "title_icon_color_rgb", selector: { color_rgb: {} } },
          { name: "view_mode", selector: { select: { mode: "dropdown", options: [
            { value: "auto", label: haListManagerShoppingCardText("ui.automatic", {}, hass) }, { value: "panel", label: haListManagerShoppingCardText("ui.panel_view", {}, hass) }, { value: "mobile", label: haListManagerShoppingCardText("ui.mobile_view", {}, hass) },
          ] } }, default: "auto" },
          { name: "content_display", selector: { select: { mode: "dropdown", options: [
            { value: "card_and_large", label: haListManagerShoppingCardText("ui.card_and_large_view", {}, hass) },
            { value: "card_only", label: haListManagerShoppingCardText("ui.card_only", {}, hass) },
            { value: "large_only", label: haListManagerShoppingCardText("ui.large_view_only", {}, hass) },
          ] } }, default: "card_and_large" },
          { name: "collapsible", selector: { boolean: {} }, default: true },
          { name: "input_row_position", selector: { select: { mode: "dropdown", options: [
            { value: "top", label: haListManagerShoppingCardText("ui.top", {}, hass) }, { value: "bottom", label: haListManagerShoppingCardText("ui.bottom", {}, hass) },
          ] } }, default: "top" },
          { name: "option_row_position", selector: { select: { mode: "dropdown", options: [
            { value: "top", label: haListManagerShoppingCardText("ui.top", {}, hass) }, { value: "bottom", label: haListManagerShoppingCardText("ui.bottom", {}, hass) },
          ] } }, default: "bottom" },
          { name: "label_grouping", selector: { select: { mode: "dropdown", options: [
            { value: "disabled", label: haListManagerShoppingCardText("ui.label_grouping_disabled", {}, hass) },
            { value: "categories", label: haListManagerShoppingCardText("ui.label_grouping_categories", {}, hass) },
            { value: "labels", label: haListManagerShoppingCardText("ui.label_grouping_labels", {}, hass) },
          ] } }, default: "disabled" },
          { name: "show_category_toggle_button", selector: { boolean: {} }, default: true },
          { name: "show_submit_button", selector: { boolean: {} }, default: true },
          { name: "allow_filter", selector: { boolean: {} }, default: true },
          { name: "auto_expand_search", selector: { boolean: {} }, default: true },
          { name: "allow_suggestions", selector: { boolean: {} }, default: true },
          { name: "show_share_button", selector: { boolean: {} }, default: true },
          { name: "show_pdf_export_button", selector: { boolean: {} }, default: false },
          { name: "add_dialog_behavior", selector: { select: { mode: "dropdown", options: [
            { value: "always", label: haListManagerShoppingCardText("ui.always_open", {}, hass) },
            { value: "new", label: haListManagerShoppingCardText("ui.new_list_entries_only", {}, hass) },
            { value: "missing_category", label: haListManagerShoppingCardText("categories.prompt_missing_product_category", {}, hass) },
            { value: "never", label: haListManagerShoppingCardText("categories.never_prompt_general", {}, hass) },
          ] } }, default: "missing_category" },
        ] },
        { type: "expandable", label: haListManagerShoppingCardText("ui.list_appearance", {}, hass), icon: "mdi:format-line-spacing", schema: [
          { name: "show_item_dividers", selector: { boolean: {} }, default: true },
          { name: "item_divider_before_spacing", selector: { number: { min: 0, max: 32, step: 1, mode: "slider", unit_of_measurement: "px" } }, default: 10 },
          { name: "item_divider_after_spacing", selector: { number: { min: 0, max: 32, step: 1, mode: "slider", unit_of_measurement: "px" } }, default: 10 },
          { name: "item_font_size", selector: { number: { min: 12, max: 24, step: 1, mode: "box", unit_of_measurement: "px" } }, default: 16 },
          { name: "category_font_scale", selector: { number: { min: 80, max: 160, step: 5, mode: "box", unit_of_measurement: "%" } }, default: 110 },
        ] },
        { type: "expandable", label: haListManagerShoppingCardText("ui.item", {}, hass), icon: "mdi:format-list-bulleted", schema: [
          { name: "show_edit_shortcuts", selector: { boolean: {} }, default: true },
          { name: "quantity_position", selector: { select: { mode: "dropdown", options: [
            { value: "beginning", label: haListManagerShoppingCardText("ui.before_item_name", {}, hass) }, { value: "end", label: haListManagerShoppingCardText("ui.after_item_name", {}, hass) },
            { value: "controls", label: haListManagerShoppingCardText("ui.between_plus_minus", {}, hass) },
          ] } }, default: "beginning" },
          { name: "show_camera_scan_button", selector: { boolean: {} }, default: true },
          { name: "show_scanner_target_button", selector: { boolean: {} }, default: true },
          { name: "show_quantity_box", selector: { boolean: {} }, default: true },
          { name: "show_quantity_one", selector: { boolean: {} }, default: false },
          { name: "show_plus_minus", selector: { boolean: {} }, default: true },
          { name: "acknowledged", selector: { select: { mode: "dropdown", options: [
            { value: "show", label: haListManagerShoppingCardText("ui.show_in_place", {}, hass) }, { value: "end", label: haListManagerShoppingCardText("ui.show_at_end", {}, hass) }, { value: "hide", label: haListManagerShoppingCardText("ui.hide", {}, hass) },
          ] } }, default: "show" },
          { name: "show_done_hidden_items_in_search", selector: { boolean: {} }, default: true },
          { name: "show_label_filter_button", selector: { boolean: {} }, default: true },
          { name: "show_clear_completed_button", selector: { boolean: {} }, default: true },
          { name: "show_category_count", selector: { boolean: {} }, default: true },
          { name: "show_labels", selector: { boolean: {} }, default: true },
          { name: "category_sort", selector: { select: { mode: "dropdown", options: [
            { value: "alphabetical", label: haListManagerShoppingCardText("categories.combined_alphabetical", {}, hass) },
            { value: "global_list_dynamic", label: haListManagerShoppingCardText("categories.order_global_local_dynamic", {}, hass) },
            { value: "global_dynamic_list", label: haListManagerShoppingCardText("ui.category_priority_path", {}, hass) },
            { value: "list_global_dynamic", label: haListManagerShoppingCardText("categories.order_local_global_dynamic", {}, hass) },
            { value: "list_dynamic_global", label: haListManagerShoppingCardText("categories.list_dynamic_global", {}, hass) },
            { value: "dynamic_global_list", label: haListManagerShoppingCardText("categories.order_dynamic_global_local", {}, hass) },
            { value: "dynamic_list_global", label: haListManagerShoppingCardText("categories.dynamic_list_global", {}, hass) },
            { value: "position", label: haListManagerShoppingCardText("ui.manual_position", {}, hass) },
          ] } }, default: "alphabetical" },
        ] },
        { type: "expandable", label: haListManagerShoppingCardText("ui.product_data", {}, hass), icon: "mdi:database-outline", schema: [
          { name: "show_images", selector: { boolean: {} }, default: false },
          { name: "show_brand", selector: { boolean: {} }, default: false },
          { name: "show_quantity", selector: { boolean: {} }, default: false },
        ] },
        { type: "expandable", label: haListManagerShoppingCardText("ui.chips", {}, hass), icon: "mdi:gesture-tap-button", schema: [
          { name: "show_chips", selector: { boolean: {} }, default: true },
          { name: "show_chip_popup_button", selector: { boolean: {} }, default: true },
          { name: "show_browser_chips", selector: { boolean: {} }, default: true },
          { name: "browser_chips_for_products", selector: { boolean: {} }, default: false },
          { name: "allow_save_browser_chips", selector: { boolean: {} }, default: true },
          { name: "filter_chips", selector: { boolean: {} }, default: true },
          { name: "listed_chip_display", selector: { select: { mode: "dropdown", options: [
            { value: "normal", label: haListManagerShoppingCardText("chips.listed_normal", {}, hass) },
            { value: "dim", label: haListManagerShoppingCardText("chips.listed_dim", {}, hass) },
            { value: "hide", label: haListManagerShoppingCardText("chips.listed_hide", {}, hass) },
          ] } }, default: "normal" },
          { name: "chip_font_size", selector: { number: { min: 12, max: 24, step: 1, mode: "box", unit_of_measurement: "px" } } },
          { name: "category_chip_layout", selector: { select: { mode: "dropdown", options: [
            { value: "none", label: haListManagerShoppingCardText("ui.no_category_chips", {}, hass) },
            { value: "stacked", label: haListManagerShoppingCardText("ui.stacked", {}, hass) },
            { value: "wrap", label: haListManagerShoppingCardText("ui.side_by_side", {}, hass) },
            { value: "compact", label: haListManagerShoppingCardText("ui.side_by_side_compact", {}, hass) },
          ] } }, default: "none" },
          { name: "category_chip_colors", selector: { boolean: {} }, default: true },
          { name: "show_important_chips", selector: { boolean: {} }, default: true },
          { name: "chips_limit", selector: { number: { min: 0, max: 50, step: 1, mode: "box" } }, default: 8 },
          { name: "chips_position", selector: { select: { mode: "dropdown", options: [
            { value: "auto", label: haListManagerShoppingCardText("ui.automatic", {}, hass) },
            { value: "bottom", label: haListManagerShoppingCardText("ui.below_list", {}, hass) },
            { value: "right", label: haListManagerShoppingCardText("chips.right_of_list", {}, hass) },
          ] } }, default: "auto" },
          { name: "chip_color_mode", selector: { select: { mode: "dropdown", options: [
            { value: "scope_fallback", label: haListManagerShoppingCardText("chips.color_priority", {}, hass) },
            { value: "scope_override", label: haListManagerShoppingCardText("chips.always_scope_colors", {}, hass) },
            { value: "chip_only", label: haListManagerShoppingCardText("chips.saved_colors_only", {}, hass) },
            { value: "none", label: haListManagerShoppingCardText("ui.no_colors", {}, hass) },
          ] } }, default: "scope_fallback" },
          { name: "chip_color_global_rgb", selector: { color_rgb: {} } },
          { name: "chip_color_list_type_rgb", selector: { color_rgb: {} } },
          { name: "chip_color_list_rgb", selector: { color_rgb: {} } },
          { name: "chip_color_browser_rgb", selector: { color_rgb: {} } },
          { name: "important_chip_color_rgb", selector: { color_rgb: {} } },
        ] },
        { type: "expandable", label: haListManagerShoppingCardText("recipes.dishes", {}, hass), icon: "mdi:food-variant", schema: [
          { name: "dishes_confirm_add", selector: { boolean: {} }, default: true },
          { name: "dish_color_rgb", selector: { color_rgb: {} } },
        ] },
      ],
      computeLabel: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerShoppingCard.getConfigForm({ ...(hass || {}), localize }).computeLabel(schema);
        return labels[schema.name] || schema.label || schema.name;
      },
      computeHelper: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerShoppingCard.getConfigForm({ ...(hass || {}), localize }).computeHelper(schema);
        if (schema.name === "entity") return haListManagerShoppingCardText("help.list_sensor_selection", {}, hass);
        if (schema.name === "title") return haListManagerShoppingCardText("help.card_heading", {}, hass);
        if (schema.name === "title_icon") return haListManagerShoppingCardText("help.title_icon", {}, hass);
        if (schema.name === "title_icon_color_rgb") return haListManagerShoppingCardText("help.title_icon_color", {}, hass);
        if (schema.name === "view_mode") return haListManagerShoppingCardText("help.responsive_card_layout", {}, hass);
        if (schema.name === "content_display") return haListManagerShoppingCardText("help.list_content_view", {}, hass);
        if (schema.name === "collapsible") return haListManagerShoppingCardText("help.title_collapse", {}, hass);
        if (schema.name === "input_row_position") return haListManagerShoppingCardText("help.input_row_position", {}, hass);
        if (schema.name === "option_row_position") return haListManagerShoppingCardText("help.shopping_button_bar_position", {}, hass);
        if (schema.name === "label_grouping") return haListManagerShoppingCardText("help.label_grouping", {}, hass);
        if (schema.name === "show_category_toggle_button") return haListManagerShoppingCardText("help.expand_all_categories_button", {}, hass);
        if (schema.name === "show_submit_button") return haListManagerShoppingCardText("help.shopping_add_button", {}, hass);
        if (schema.name === "show_label_filter_button") return haListManagerShoppingCardText("filters.option_help", {}, hass);
        if (schema.name === "allow_filter") return haListManagerShoppingCardText("help.filter_while_typing_item", {}, hass);
        if (schema.name === "auto_expand_search") return haListManagerShoppingCardText("help.auto_expand_search", {}, hass);
        if (schema.name === "allow_suggestions") return haListManagerShoppingCardText("help.shopping_product_search", {}, hass);
        if (schema.name === "show_share_button") return haListManagerShoppingCardText("help.share_button_visibility", {}, hass);
        if (schema.name === "show_pdf_export_button") return haListManagerShoppingCardText("help.shopping_pdf_button", {}, hass);
        if (schema.name === "add_dialog_behavior") return haListManagerShoppingCardText("help.shopping_add_dialog_behavior", {}, hass);
        if (schema.name === "show_item_dividers") return haListManagerShoppingCardText("help.item_dividers", {}, hass);
        if (schema.name === "item_divider_before_spacing") return haListManagerShoppingCardText("help.item_bottom_spacing", {}, hass);
        if (schema.name === "item_divider_after_spacing") return haListManagerShoppingCardText("help.divider_item_spacing", {}, hass);
        if (schema.name === "item_font_size") return haListManagerShoppingCardText("help.item_base_text_size", {}, hass);
        if (schema.name === "category_font_scale") return haListManagerShoppingCardText("help.category_name_scale", {}, hass);
        if (schema.name === "quantity_position") return haListManagerShoppingCardText("help.shopping_quantity_position", {}, hass);
        if (schema.name === "show_scanner_target_button") return haListManagerShoppingCardText("scan.scanner_help", {}, hass);
        if (schema.name === "show_camera_scan_button") return haListManagerShoppingCardText("scan.camera_help", {}, hass);
        if (schema.name === "show_quantity_box") return haListManagerShoppingCardText("help.shopping_quantity_input", {}, hass);
        if (schema.name === "show_quantity_one") return haListManagerShoppingCardText("help.show_single_item_count", {}, hass);
        if (schema.name === "show_plus_minus") return haListManagerShoppingCardText("help.shopping_quantity_buttons", {}, hass);
        if (schema.name === "acknowledged") return haListManagerShoppingCardText("help.completed_item_placement", {}, hass);
        if (schema.name === "show_done_hidden_items_in_search") return haListManagerShoppingCardText("help.search_completed_items", {}, hass);
        if (schema.name === "show_clear_completed_button") return haListManagerShoppingCardText("help.delete_completed_button", {}, hass);
        if (schema.name === "show_edit_shortcuts") return haListManagerShoppingCardText("help.shopping_edit_shortcuts", {}, hass);
        if (schema.name === "show_category_count") return haListManagerShoppingCardText("help.shopping_category_counts", {}, hass);
        if (schema.name === "show_labels") return haListManagerShoppingCardText("help.item_label_visibility", {}, hass);
        if (schema.name === "category_sort") return haListManagerShoppingCardText("help.shopping_category_order", {}, hass);
        if (schema.name === "show_images") return haListManagerShoppingCardText("help.shopping_product_images", {}, hass);
        if (schema.name === "show_brand") return haListManagerShoppingCardText("help.append_product_brand", {}, hass);
        if (schema.name === "show_quantity") return haListManagerShoppingCardText("help.append_linked_package_quantity", {}, hass);
        if (schema.name === "show_chips") return haListManagerShoppingCardText("help.show_effective_chips", {}, hass);
        if (schema.name === "show_chip_popup_button") return haListManagerShoppingCardText("help.chip_picker_icon", {}, hass);
        if (schema.name === "show_browser_chips") return haListManagerShoppingCardText("help.auto_browser_chips", {}, hass);
        if (schema.name === "browser_chips_for_products") return haListManagerShoppingCardText("help.browser_chips_database_products", {}, hass);
        if (schema.name === "allow_save_browser_chips") return haListManagerShoppingCardText("help.browser_chip_save_action", {}, hass);
        if (schema.name === "filter_chips") return haListManagerShoppingCardText("help.chips_filter_as_typing", {}, hass);
        if (schema.name === "category_chip_layout") return haListManagerShoppingCardText("help.category_chip_layout", {}, hass);
        if (schema.name === "category_chip_colors") return haListManagerShoppingCardText("help.shopping_category_chip_color", {}, hass);
        if (schema.name === "show_important_chips") return haListManagerShoppingCardText("help.shopping_important_chips", {}, hass);
        if (schema.name === "listed_chip_display") return haListManagerShoppingCardText("chips.listed_help", {}, hass);
        if (schema.name === "chip_font_size") return haListManagerShoppingCardText("chips.font_size_help", {}, hass);
        if (schema.name === "chips_limit") return haListManagerShoppingCardText("help.initial_plain_chips_limit", {}, hass);
        if (schema.name === "chips_position") return haListManagerShoppingCardText("help.chips_auto_position", {}, hass);
        if (schema.name === "chip_color_mode") return haListManagerShoppingCardText("help.chip_color_modes", {}, hass);
        if (schema.name === "chip_color_global_rgb") return haListManagerShoppingCardText("help.global_chip_color", {}, hass);
        if (schema.name === "chip_color_list_type_rgb") return haListManagerShoppingCardText("help.shopping_type_chip_color", {}, hass);
        if (schema.name === "chip_color_list_rgb") return haListManagerShoppingCardText("help.list_chip_color", {}, hass);
        if (schema.name === "chip_color_browser_rgb") return haListManagerShoppingCardText("help.browser_chip_color", {}, hass);
        if (schema.name === "important_chip_color_rgb") return haListManagerShoppingCardText("help.important_chip_color", {}, hass);
        if (schema.name === "dishes_confirm_add") return haListManagerShoppingCardText("help.dish_ingredient_selection", {}, hass);
        if (schema.name === "dish_color_rgb") return haListManagerShoppingCardText("help.dish_default_color", {}, hass);
        return "";
      },
    };
  }

  static getStubConfig(hass = null) {
    return {
      title: haListManagerShoppingCardText("ui.shopping_list", {}, hass), title_icon: "mdi:cart-variant", view_mode: "auto", content_display: "card_and_large", collapsible: true, input_row_position: "top", option_row_position: "bottom", show_category_toggle_button: true, label_grouping: "disabled", add_dialog_behavior: "missing_category",
      quantity_position: "beginning", show_quantity_box: true, show_submit_button: true,
      show_plus_minus: true, show_item_dividers: true, item_divider_before_spacing: 10, item_divider_after_spacing: 10, item_font_size: 16, category_font_scale: 110, acknowledged: "show", show_quantity_one: false,
      allow_filter: true, auto_expand_search: true, allow_suggestions: true, show_done_hidden_items_in_search: true,
      show_share_button: true, show_pdf_export_button: false, show_clear_completed_button: true, show_edit_shortcuts: true,
      show_images: false, show_brand: false, show_quantity: false, show_category_count: true, show_labels: true, category_sort: "alphabetical",
      show_chips: true, show_chip_popup_button: true, show_browser_chips: true, browser_chips_for_products: false, allow_save_browser_chips: true,
      filter_chips: true, category_chip_layout: "none", category_chip_colors: true, show_important_chips: true, chips_limit: 8, chips_position: "auto", chip_color_mode: "scope_fallback",
      chip_color_global_rgb: [96, 125, 139], chip_color_list_type_rgb: [3, 169, 244], chip_color_list_rgb: [67, 160, 71], chip_color_browser_rgb: [121, 85, 72],
      important_chip_color_rgb: [244, 67, 54],
      dishes_confirm_add: true, dish_color_rgb: [121, 85, 72],
    };
  }

  setConfig(config) {
    const previousFilterScope = this._filterOwnerKey();
    this._config = { ...HaListManagerShoppingCard.getStubConfig(this._hass), ...config };
    if (previousFilterScope !== this._filterOwnerKey()) this._resetLabelFilterScope();
    const normalizeAppearanceNumber = (value, fallback, min, max) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    };
    this._config.item_divider_before_spacing = normalizeAppearanceNumber(this._config.item_divider_before_spacing, 10, 0, 32);
    this._config.item_divider_after_spacing = normalizeAppearanceNumber(this._config.item_divider_after_spacing, 10, 0, 32);
    this._config.item_font_size = normalizeAppearanceNumber(this._config.item_font_size, 16, 12, 24);
    if (!["normal", "dim", "hide"].includes(this._config.listed_chip_display)) this._config.listed_chip_display = "normal";
    const chipFontSize = this._config.chip_font_size;
    this._config.chip_font_size = chipFontSize == null || chipFontSize === "" || !Number.isFinite(Number(chipFontSize))
      ? null : Math.max(12, Math.min(24, Math.round(Number(chipFontSize))));
    this._config.category_font_scale = normalizeAppearanceNumber(this._config.category_font_scale, 110, 80, 160);
    if (!["disabled", "categories", "labels"].includes(this._config.label_grouping)) this._config.label_grouping = "disabled";
    if (!["beginning", "end", "controls"].includes(this._config.quantity_position)) this._config.quantity_position = "beginning";
    if (!["always", "new", "missing_category", "never"].includes(this._config.add_dialog_behavior)) this._config.add_dialog_behavior = "missing_category";
    if (!["alphabetical", "global_list_dynamic", "global_dynamic_list", "list_global_dynamic", "list_dynamic_global", "dynamic_global_list", "dynamic_list_global", "position"].includes(this._config.category_sort)) this._config.category_sort = "alphabetical";
    if (!["show", "end", "hide"].includes(this._config.acknowledged)) this._config.acknowledged = "show";
    if (!["top", "bottom"].includes(this._config.input_row_position)) this._config.input_row_position = "top";
    if (!["top", "bottom"].includes(this._config.option_row_position)) this._config.option_row_position = "bottom";
    if (!["card_and_large", "card_only", "large_only"].includes(this._config.content_display)) this._config.content_display = "card_and_large";
    if (!["auto", "bottom", "right"].includes(this._config.chips_position)) this._config.chips_position = "auto";
    if (!["none", "stacked", "wrap", "compact"].includes(this._config.category_chip_layout)) this._config.category_chip_layout = "none";
    if (!["scope_fallback", "scope_override", "chip_only", "none"].includes(this._config.chip_color_mode)) this._config.chip_color_mode = "scope_fallback";
    const configuredChipLimit = Number.parseInt(this._config.chips_limit, 10);
    this._config.chips_limit = Number.isFinite(configuredChipLimit) ? Math.max(0, Math.min(50, configuredChipLimit)) : 8;
    if (this._expandedView && this._config.content_display === "card_only") this._setExpandedView(false);
    this._render();
    this._load();
  }

  set hass(value) {
    const previousId = this._listId();
    const previousUser = this._hass?.user?.id;
    this._hass = value;
    if (previousUser && previousUser !== value?.user?.id) {
      this._resetLabelFilterScope(); this._load(true);
    }
    if (this.isConnected) this._watchConnection();
    const translationsChanged = haListManagerShoppingCardTextUpdateTranslations(this, this._hass);
    if (previousId !== this._listId()) { this._resetLabelFilterScope(); globalThis.HaListManagerShoppingScanner?.stop(this); }
    if (!this._list || previousId !== this._listId()) this._load(true);
    this._subscribe();
    if (this.isConnected) globalThis.HaListManagerShoppingScanner?.for(this).start().catch(() => {});

    if (translationsChanged) this._render();
  }

  connectedCallback() {
    this._watchConnection();
    this._render();
    this._subscribe();
    this._load(true);
    globalThis.HaListManagerShoppingScanner?.for(this).start().catch(() => {});
    if (!this._bringRefreshTimer) {
      this._bringRefreshTimer = setInterval(() => {
        const editing = Boolean(this._labelFilterDialog || this._dialog || this._productPicker || this._confirmation || this.shadowRoot?.activeElement?.matches?.("input, textarea"));
        if (document.visibilityState === "visible" && this._list?.list_type === "bring" && !this._loading && !editing) this._load();
      }, 15000);
    }
  }
  disconnectedCallback() {
    globalThis.HaListManagerShoppingScanner?.stop(this);
    globalThis.HaListManagerProductEditor.cancelRename(this);
    this._clearRenderListeners();
    this._pageActionAnchor = null;
    this._watchConnection(null);
    this._setExpandedView(false);
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    this._invalidateSavedLabelFilters();
    this._labelFilterDialog = null;
    this._loadRequestId += 1;
    this._loading = false;
    clearTimeout(this._searchTimer);
    // A detached view must not open a menu from a pending long press.
    clearTimeout(this._filterPressTimer); this._filterPressTimer = null;
    clearTimeout(this._chipLongPressTimer);
    this._chipLongPressTimer = null;
    if (this._bringRefreshTimer) clearInterval(this._bringRefreshTimer);
    this._bringRefreshTimer = null;
    this._unlockScroll();
  }
  getCardSize() { return this._config.content_display === "large_only" ? 1 : Math.max(3, Math.ceil(this._items.length * 0.55) + 2); }

  _listId() { return this._hass?.states?.[this._config.entity]?.attributes?.list_id || this._config.list_id || null; }
  _identity() { return this._config.card_id || this._config.entity || this._listId() || "shopping"; }
  _listCollapseKey() { return `ha-list-manager:shopping-list:${encodeURIComponent(this._identity())}`; }
  _browserChipStorageKey(listId = this._listId()) { return `ha-list-manager:browser-chips:${encodeURIComponent(listId || this._identity())}`; }
  _importantBrowserChipStorageKey(listId = this._listId()) { return `ha-list-manager:important-browser-chips:${encodeURIComponent(listId || this._identity())}`; }
  _normalizedChipName(value) { return String(value || "").trim().normalize("NFKC").toLocaleLowerCase(); }
  _loadBrowserChips(listId = this._listId()) {
    try {
      const parsed = JSON.parse(localStorage.getItem(this._browserChipStorageKey(listId)) || "[]");
      this._browserChips = Array.isArray(parsed) ? parsed
        .filter((chip) => chip && typeof chip.name === "string" && chip.name.trim())
        .map((chip, index) => ({
          id: String(chip.id || `browser-${index}-${this._normalizedChipName(chip.name)}`),
          name: chip.name.trim(), product_id: chip.product_id || null,
          product_name: chip.product_name || null, scope: "browser", browser: true,
        })).slice(0, 2000) : [];
    } catch (_error) { this._browserChips = []; }
    try {
      const importantIds = JSON.parse(localStorage.getItem(this._importantBrowserChipStorageKey(listId)) || "[]");
      const availableIds = new Set(this._browserChips.map((chip) => chip.id));
      this._importantBrowserChipIds = new Set(
        (Array.isArray(importantIds) ? importantIds : []).map(String).filter((id) => availableIds.has(id))
      );
    } catch (_error) { this._importantBrowserChipIds = new Set(); }
  }
  _saveBrowserChips() {
    try {
      const records = this._browserChips.slice(0, 2000).map(({ id, name, product_id, product_name }) => ({ id, name, product_id, product_name }));
      localStorage.setItem(this._browserChipStorageKey(), JSON.stringify(records));
    } catch (_error) {}
  }
  _saveImportantBrowserChips() {
    try {
      localStorage.setItem(this._importantBrowserChipStorageKey(), JSON.stringify([...this._importantBrowserChipIds]));
    } catch (_error) {}
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
    return [...this._chips, ...browser].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  }
  _categoryProductChips() {
    const linkedProducts = new Set(this._effectiveChips().map((chip) => chip.product_id).filter(Boolean));
    return this._products.flatMap((product) => {
      if (!product?.id || linkedProducts.has(product.id)) return [];
      const category = this._matchingProductCategory(product);
      if (!category) return [];
      return [{
        id: `category-product:${product.id}`,
        name: this._productName(product),
        product_id: product.id,
        product_name: product.name,
        scope: category.scope || "list",
        category,
        categoryProduct: true,
      }];
    });
  }
  _categoryChipLayout() { return this._config.category_chip_layout || "none"; }
  _categoryChipsEnabled() { return this._categoryChipLayout() !== "none"; }
  _listedChips(chips) {
    const mode = this._config.listed_chip_display;
    if (!mode || mode === "normal") return chips;
    const normalize = (value) => String(value || "").trim().normalize("NFKC").toLocaleLowerCase();
    const products = new Set();
    const names = new Set();
    const productNames = new Map(this._products.map((product) => [product.id, product.name]));
    for (const item of this._items) {
      if (item.completed) continue;
      if (item.product_id) products.add(item.product_id);
      for (const name of [item.name, item.product?.name, productNames.get(item.product_id)]) {
        const key = normalize(name);
        if (key) names.add(key);
      }
    }
    return chips.map((chip) => ({ ...chip, listed: chip.product_id ? products.has(chip.product_id) : names.has(normalize(chip.name)) }))
      .filter((chip) => mode !== "hide" || !chip.listed);
  }
  _displayChips() {
    const chips = this._categoryChipsEnabled()
      ? [...this._effectiveChips(), ...this._categoryProductChips()]
      : this._effectiveChips();
    return this._listedChips(chips).map((chip) => ({ ...chip, important: this._isChipImportant(chip) }))
      .sort((left, right) => {
        if (this._config.show_important_chips !== false && left.important !== right.important) return left.important ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
      });
  }
  async _loadChipCategories(requestId = this._loadRequestId) {
    if (!this._categoryChipsEnabled() || !this._hass || !this._listId()) {
      this._chipCategories = new Map();
      return;
    }
    const chips = this._effectiveChips();
    if (!chips.length) {
      this._chipCategories = new Map();
      return;
    }
    const result = await haListManagerShoppingCardTextRequest(this._hass, {
      type: `${HA_LM_API}/categories/chips/resolve`,
      list_id: this._listId(),
      candidates: chips.map((chip) => ({
        key: chip.id,
        name: chip.name,
        product_id: chip.product_id || null,
      })),
    });
    if (requestId !== this._loadRequestId) return;
    this._chipCategories = new Map(
      (result.resolutions || []).map((entry) => [entry.key, entry.category || null])
    );
  }
  _chipCategoryCollapseKey(categoryId) {
    return `ha-list-manager:chip-category:${encodeURIComponent(this._identity())}:${encodeURIComponent(categoryId || "__general__")}`;
  }
  _wrappedChipCategoryKey(context) {
    return `ha-list-manager:chip-category-open:${encodeURIComponent(this._identity())}:${context}`;
  }
  _wrappedChipCategorySelection(context) {
    if (Object.prototype.hasOwnProperty.call(this._wrappedChipCategoryOpen, context)) return this._wrappedChipCategoryOpen[context];
    try {
      const stored = localStorage.getItem(this._wrappedChipCategoryKey(context));
      if (stored === null) return undefined;
      return stored === "__none__" ? null : stored;
    } catch (_error) { return undefined; }
  }
  _storeWrappedChipCategorySelection(context, categoryId) {
    this._wrappedChipCategoryOpen[context] = categoryId;
    try { localStorage.setItem(this._wrappedChipCategoryKey(context), categoryId || "__none__"); }
    catch (_error) {}
  }
  _chipCategoryCollapsed(categoryId) {
    try {
      const stored = localStorage.getItem(this._chipCategoryCollapseKey(categoryId));
      return stored === null ? categoryId !== "__important__" : stored !== "0";
    }
    catch (_error) { return true; }
  }
  _toggleChipCategory(categoryId, dialog = false) {
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      const context = dialog ? "dialog" : "card";
      const stored = this._wrappedChipCategorySelection(context);
      const current = stored !== undefined ? stored : categoryId === "__important__" ? "__important__" : null;
      this._storeWrappedChipCategorySelection(context, current === categoryId ? null : categoryId);
      this._render();
      return;
    }
    try {
      const key = this._chipCategoryCollapseKey(categoryId);
      localStorage.setItem(key, this._chipCategoryCollapsed(categoryId) ? "0" : "1");
    } catch (_error) {}
    this._render();
  }
  _allChipCategoriesExpanded(chips = this._filteredChips(), dishes = this._filteredDishes()) {
    const categoryIds = this._chipCategoryGroups(chips).map(({ category }) => category.id || "__general__");
    if (dishes.length) categoryIds.push("__dishes__");
    if (!categoryIds.length) return false;
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      const selected = this._wrappedChipCategorySelection("card");
      return selected === "__all__" || (categoryIds.length === 1 && selected === categoryIds[0]);
    }
    return categoryIds.every((categoryId) => !this._chipCategoryCollapsed(categoryId));
  }
  _toggleAllChipCategories() {
    const chips = this._filteredChips();
    const dishes = this._filteredDishes();
    const categoryIds = this._chipCategoryGroups(chips).map(({ category }) => category.id || "__general__");
    if (dishes.length) categoryIds.push("__dishes__");
    if (!categoryIds.length) return;
    const expand = !this._allChipCategoriesExpanded(chips, dishes);
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
      const category = this._categories.find((entry) => entry.id === resolved?.id) || resolved || {
        id: "", name: haListManagerShoppingCardText("ui.general", {}, this._hass), icon: "mdi:shape-outline", color: null,
        scope: "list", dynamic: false, uncategorized: true,
      };
      const key = category.id || "__general__";
      if (!groups.has(key)) groups.set(key, { category, chips: [] });
      groups.get(key).chips.push(chip);
    }
    const normalGroups = [...groups.values()].sort((left, right) => this._compareCategories(left.category, right.category));
    const important = this._config.show_important_chips !== false ? chips.filter((chip) => chip.important) : [];
    if (!important.length) return normalGroups;
    return [{
      category: {
        id: "__important__", name: haListManagerShoppingCardText("ui.important", {}, this._hass), icon: "mdi:alert-circle-outline",
        color: this._configuredChipColor(this._config.important_chip_color_rgb, "rgb(244, 67, 54)"),
        important: true,
      },
      chips: important,
    }, ...normalGroups];
  }
  _rememberBrowserChip(name, product = null) {
    if (this._config.show_browser_chips === false) return;
    const normalized = this._normalizedChipName(name);
    const productId = product && Object.prototype.hasOwnProperty.call(product, "product_id")
      ? product.product_id || null
      : product?.id || null;
    if (productId && this._config.browser_chips_for_products !== true) return;
    if (!normalized || this._chips.some((chip) => this._normalizedChipName(chip.name) === normalized || (productId && chip.product_id === productId))) return;
    const index = this._browserChips.findIndex((chip) => this._normalizedChipName(chip.name) === normalized || (productId && chip.product_id === productId));
    if (index >= 0) return;
    const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this._browserChips.push({ id, name: String(name).trim(), product_id: productId, product_name: product?.name || null, scope: "browser", browser: true });
    this._browserChips = this._browserChips.slice(0, 2000);
    this._saveBrowserChips();
  }
  _removeBrowserChip(chip) {
    this._browserChips = this._browserChips.filter((entry) => entry.id !== chip?.id);
    this._importantBrowserChipIds.delete(chip?.id);
    this._saveBrowserChips();
    this._saveImportantBrowserChips();
  }
  _clearBrowserChips() { this._browserChips = []; this._importantBrowserChipIds.clear(); this._saveBrowserChips(); this._saveImportantBrowserChips(); }
  _groupingKey() { return `ha-list-manager:shopping-grouping:${encodeURIComponent(this._identity())}`; }
  _labelGroupingEnabled() { return ["categories", "labels"].includes(this._config.label_grouping); }
  _groupingMode() {
    if (!this._labelGroupingEnabled()) return "categories";
    const key = this._groupingKey();
    if (this._groupingChoice?.key === key) return this._groupingChoice.mode;
    try {
      const stored = localStorage.getItem(key);
      if (["categories", "labels"].includes(stored)) return stored;
    } catch (_error) { /* Switching remains available when browser storage is blocked. */ }
    return this._config.label_grouping;
  }
  _toggleGrouping() {
    if (!this._labelGroupingEnabled()) return;
    const key = this._groupingKey();
    const mode = this._groupingMode() === "labels" ? "categories" : "labels";
    this._groupingChoice = { key, mode };
    try { localStorage.setItem(key, mode); } catch (_error) {}
    this._expandedScrollAnchor = null;
    this._render();
  }

  _offerFilterStorageKey() {
    return `ha-list-manager:shopping-offer-filter:${encodeURIComponent(this._hass?.user?.id || "")}:${encodeURIComponent(this._listId() || this._identity())}`;
  }

  _offerFilter() {
    if (this._list?.list_type === "bring" || this._list?.provider === "bring") return "all";
    const key = this._offerFilterStorageKey();
    if (this._offerFilterChoice?.key === key) return this._offerFilterChoice.mode;
    try {
      const stored = localStorage.getItem(key);
      if (["all", "hide", "only"].includes(stored)) return stored;
    } catch (_error) { /* Filtering remains available when browser storage is blocked. */ }
    return "all";
  }

  _setOfferFilter(mode, refresh = true) {
    if (!["all", "hide", "only"].includes(mode)) return;
    const key = this._offerFilterStorageKey();
    this._offerFilterChoice = { key, mode };
    try { localStorage.setItem(key, mode); } catch (_error) {}
    if (refresh) {
      if (this._labelFilterDialog) this._refreshFilterView();
      else this._render();
    }
  }

  _filterModesEnabled() { return this._list?.list_type !== "bring" && this._list?.provider !== "bring"; }
  _filterMode() { return this._offerFilter(); }
  _setFilterMode(mode) { this._setOfferFilter(mode, false); }
  _filterModeHeading() { return this._filterText("offers_heading"); }
  _filterModes() { return ["all","only","hide"].map(value => ({value,label:haListManagerShoppingCardText(`shopping.offer_filter_${value}`,{},this._hass)})); }

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
    this._expandedResizeFrame = requestAnimationFrame(() => {
      this._expandedResizeFrame = null;
      this._updateExpandedViewBounds();
    });
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
    if (this._expandedScrollTimer) clearTimeout(this._expandedScrollTimer);
    this._expandedScrollTimer = null;
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
      this._expandedScrollAnchor = null;
      this.removeAttribute("data-expanded-view");
      this.style.removeProperty("--expanded-top");
      this.style.removeProperty("--expanded-left");
      this.style.removeProperty("--expanded-right");
      this.style.removeProperty("--expanded-bottom");
      document.removeEventListener("keydown", this._onExpandedViewKeydown, true);
      if (this._scrollLocked) this._oldOverflow = this._expandedPageOverflow ?? this._oldOverflow;
      else document.body.style.overflow = this._expandedPageOverflow || "";
      this._expandedPageOverflow = null;
      const shouldRenderCollapsed = this._expandedViewWasCollapsed || this._config.content_display === "large_only";
      this._expandedViewWasCollapsed = false;
      if (shouldRenderCollapsed && this.isConnected) this._render();
    }
    this.shadowRoot?.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => {
      element.setAttribute("aria-pressed", String(next));
      element.setAttribute("aria-expanded", String(next));
      element.setAttribute("title", next ? haListManagerShoppingCardText("ui.close_large_view", {}, this._hass) : haListManagerShoppingCardText("ui.open_large_view", {}, this._hass));
      element.setAttribute("aria-label", next ? haListManagerShoppingCardText("ui.close_large_view", {}, this._hass) : haListManagerShoppingCardText("ui.open_large_view", {}, this._hass));
    });
  }
  _toggleExpandedView(event) {
    event?.preventDefault();
    event?.stopPropagation();
    this._setExpandedView(!this._expandedView);
  }
  _rememberExpandedScroll(itemId = null, sourceRow = null) {
    if (!this._expandedView) return;
    const card = this.shadowRoot?.querySelector("ha-card");
    if (!card || !Number.isFinite(card.scrollTop)) return;
    this._expandedScrollTop = card.scrollTop;
    const row = sourceRow || (itemId
      ? [...this.shadowRoot.querySelectorAll("[data-item-id]")].find((element) => element.dataset.itemId === itemId)
      : null);
    if (row) {
      this._expandedScrollAnchor = {
        itemId,
        categoryId: row.closest?.(".category")?.querySelector("[data-category]")?.dataset.category,
        offset: row.getBoundingClientRect().top - card.getBoundingClientRect().top,
      };
    }
  }
  _restoreExpandedScroll() {
    if (!this._expandedView || (!this._expandedScrollAnchor && this._expandedScrollTop <= 0)) return;
    if (this._expandedScrollFrame) cancelAnimationFrame(this._expandedScrollFrame);
    if (this._expandedScrollTimer) clearTimeout(this._expandedScrollTimer);
    const scrollTop = this._expandedScrollTop;
    const anchor = this._expandedScrollAnchor ? { ...this._expandedScrollAnchor } : null;
    const align = (restoreScrollTop = false) => {
      if (!this._expandedView) return;
      const card = this.shadowRoot?.querySelector("ha-card");
      if (!card) return;
      if (restoreScrollTop) card.scrollTop = scrollTop;
      const row = anchor
        ? [...this.shadowRoot.querySelectorAll("[data-item-id]")].find((element) => element.dataset.itemId === anchor.itemId && (!anchor.categoryId || element.closest?.(".category")?.querySelector("[data-category]")?.dataset.category === anchor.categoryId))
        : null;
      if (row) {
        const offset = row.getBoundingClientRect().top - card.getBoundingClientRect().top;
        card.scrollTop += offset - anchor.offset;
      }
      this._expandedScrollTop = card.scrollTop;
    };
    align(true);
    this._expandedScrollFrame = requestAnimationFrame(() => {
      this._expandedScrollFrame = null;
      align();
      this._expandedScrollTimer = setTimeout(() => {
        align();
        this._expandedScrollTimer = setTimeout(() => {
          align();
          this._expandedScrollTimer = null;
          if (this._expandedScrollAnchor?.itemId === anchor?.itemId) this._expandedScrollAnchor = null;
        }, 180);
      }, 80);
    });
  }
  _collapseKey(id) { return `ha-list-manager:shopping-category:${encodeURIComponent(this._identity())}:${encodeURIComponent(id || "__none__")}`; }
  _searchExpandsGroups() { return Boolean(this._config.allow_filter && this._config.auto_expand_search !== false && this._inputValue.trim()); }
  _collapsed(id) { if (this._searchExpandsGroups()) return false; try { return localStorage.getItem(this._collapseKey(id)) === "1"; } catch (_error) { return false; } }
  _toggleCategory(id, button = null) {
    if (this._searchExpandsGroups()) return;
    const collapsed = !this._collapsed(id);
    try { const key = this._collapseKey(id); if (collapsed) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch (_error) {}
    const header = button || [...this.shadowRoot.querySelectorAll("[data-category]")].find((element) => element.dataset.category === id);
    const section = header?.closest(".category");
    const group = this._groups().find(({ category }) => String(category.id) === String(id));
    if (!header || !section || !group) { this._render(); return; }
    header.setAttribute("aria-expanded", String(!collapsed));
    header.querySelector(".chevron")?.setAttribute("icon", `mdi:chevron-${collapsed ? "down" : "up"}`);
    [...section.children].slice(1).forEach((element) => { this._clearRenderListeners(element); element.remove(); });
    if (!collapsed) {
      section.insertAdjacentHTML("beforeend", group.items.map((item) => this._renderItem(item)).join(""));
      this._bindDynamicContent(section, false);
    }
  }
  _allCategoriesExpanded(groups = this._groups()) {
    return groups.length > 0 && groups.every(({ category }) => !this._collapsed(category.id));
  }
  _toggleAllCategories() {
    if (this._searchExpandsGroups()) return;
    const groups = this._groups();
    if (!groups.length) return;
    const collapse = this._allCategoriesExpanded(groups);
    try {
      groups.forEach(({ category }) => {
        const key = this._collapseKey(category.id);
        if (collapse) localStorage.setItem(key, "1");
        else localStorage.removeItem(key);
      });
    } catch (_error) {}
    this._render();
  }

  _watchConnection(connection = this._hass?.connection) {
    if (this._watchedConnection === connection) return;
    this._watchedConnection?.removeEventListener?.("ready", this._onConnectionReady);
    this._watchedConnection = connection;
    this._onConnectionReady ||= () => {
      if (this.isConnected) { this._invalidateSavedLabelFilters(); this._load(true); }
    };
    connection?.addEventListener?.("ready", this._onConnectionReady);
  }

  async _subscribe() {
    if (!this._hass || this._unsubscribe || this._subscribePromise) return;
    const subscriptions = [];
    this._subscribePromise = (async () => {
      try {
        subscriptions.push(await this._hass.connection.subscribeMessage((event) => {
          if (this.isConnected && event.data?.list_id === this._listId()) this._load(true);
        }, { type: `${HA_LM_API}/subscribe`, event_type: HA_LM_ITEMS_EVENT }));
        subscriptions.push(await this._hass.connection.subscribeMessage((event) => {
          if (!this.isConnected || (event.data?.list_id && event.data.list_id !== this._listId())) return;
          if (event.data?.label_filters) {
            if (event.data.user_id === this._hass?.user?.id) this._loadSavedLabelFilters().catch((error) => {
              if (this._labelFilterDialog) { this._labelFilterDialog.status = error?.message || String(error); this._refreshMetadataUi(); }
            });
          } else this._load(true, true);
        }, { type: `${HA_LM_API}/subscribe`, event_type: HA_LM_LISTS_EVENT }));
        return () => subscriptions.forEach((unsubscribe) => unsubscribe());
      } catch (error) {
        subscriptions.forEach((unsubscribe) => unsubscribe());
        throw error;
      }
    })();
    try {
      const unsubscribe = await this._subscribePromise;
      if (this.isConnected) this._unsubscribe = unsubscribe;
      else unsubscribe();
    } finally {
      this._subscribePromise = null;
    }
  }

  async _load(force = false, metadata = false) {
    const listId = this._listId();
    if (!this._hass || !listId || this._hass.connection?.connected === false || (this._loading && !force)) return;
    this._loadBrowserChips(listId);
    const requestId = ++this._loadRequestId;
    this._loading = true;
    this._error = "";
    let quantityOnly = false;
    try {
      const [lists, items, categories, labels, chips, dishes, products, notifications, importantChips] = await Promise.all([
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/lists/list` }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/list`, list_id: listId }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/categories/order/get`, list_id: listId }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/labels/list`, list_id: listId }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/list`, list_id: listId }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/dishes/list`, list_id: listId }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/list` }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/notifications/assignments/list`, list_id: listId }),
        haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/important/list`, list_id: listId }),
      ]);
      if (requestId !== this._loadRequestId) return;
      const nextList = lists.lists.find((entry) => entry.id === listId) || null;
      if (nextList && !["shopping", "bring"].includes(nextList.list_type)) throw new Error(haListManagerShoppingCardText("errors.shopping_card_list_type", {}, this._hass));
      const nextItems = items.items || [];
      // This endpoint already applies the list override; base positions belong to separate scopes.
      const nextCategories = (categories.categories || []).map((category, manual_position) => ({ ...category, manual_position }));
      const nextLabels = labels.labels || [];
      const nextChips = chips.chips || [];
      const nextDishes = dishes.dishes || [];
      const nextProducts = products.products || [];
      const nextNotifications = notifications.assignments || [];
      const nextImportantChipKeys = new Set(
        (importantChips.assignments || []).map((entry) => `${entry.target_type}:${entry.target_id}`)
      );
      const importantChipsChanged = [...nextImportantChipKeys].sort().join("|") !== [...this._importantChipKeys].sort().join("|");
      quantityOnly = this._canPatchQuantityRefresh(nextList, nextItems, nextCategories, nextLabels, nextChips, nextDishes, nextProducts, nextNotifications);
      this._list = nextList;
      if (this.isConnected) globalThis.HaListManagerShoppingScanner?.for(this).sync().catch(() => {});
      this._categories = nextCategories;
      this._labels = nextLabels;
      if (this._savedFiltersStale || this._savedFilterScope !== this._filterOwnerKey()) await this._loadSavedLabelFilters(false);
      if (requestId !== this._loadRequestId) return;
      this._chips = nextChips;
      this._dishes = nextDishes;
      this._products = nextProducts;
      this._importantChipKeys = nextImportantChipKeys;
      this._notificationAssignments = nextNotifications;
      try { await this._loadChipCategories(requestId); }
      catch (_error) { if (requestId === this._loadRequestId) this._chipCategories = new Map(); }
      if (this._categoryChipsEnabled()) quantityOnly = false;
      if (importantChipsChanged) quantityOnly = false;
      if (quantityOnly) this._patchQuantityItems(nextItems);
      else this._items = nextItems;
    } catch (error) {
      // Interrupted reads are refreshed by HA's next ready event.
      if (requestId === this._loadRequestId && error !== 3 && error?.error?.code !== 3) {
        this._error = error?.message || error?.error?.message || (typeof error === "string" ? error : haListManagerShoppingCardText("errors.list_load_failed", {}, this._hass));
      }
    } finally {
      if (requestId === this._loadRequestId) {
        this._loading = false;
        if (!quantityOnly) {
          if (metadata) this._refreshMetadataUi();
          else this._render();
        }
      }
    }
  }

  _refreshMetadataUi() {
    // Definition updates must refresh open pickers without losing an in-progress edit.
    // Product/item drafts are kept current by their input handlers.
    const transientSelectors = ["[data-quantity]", "[data-label-input]", "[data-d-category]", "[data-category-input]", "[data-selection-search]"];
    const transientInputs = transientSelectors.map((selector) => [selector, [...this.shadowRoot.querySelectorAll(selector)].map((input) => {
      const menu = input.closest?.(".label-combo,.category-combo,.category-picker")?.querySelector(".label-picker-options,.category-picker-options");
      return { value: input.value, menuHidden: menu?.hidden };
    })]);
    const active = this.shadowRoot.activeElement;
    const attribute = active?.getAttributeNames?.().find((name) => name.startsWith("data-"));
    const value = attribute ? active.getAttribute(attribute) : null;
    const inputValue = active?.value;
    const selection = active?.tagName === "INPUT" && ["text", "search", "url", "tel"].includes(active.type)
      ? [active.selectionStart, active.selectionEnd] : null;
    const scrollSelector = "ha-card,.dialog,.category-picker-options,.label-picker-options,.selection-grid";
    const innerScroll = [...this.shadowRoot.querySelectorAll(scrollSelector)].map((node) => [node.scrollTop, node.scrollLeft]);
    const outerScroll = [];
    for (let node = this; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.scrollTop || node.scrollLeft) outerScroll.push([node, node.scrollTop, node.scrollLeft]);
    }
    this._render();
    for (const [selector, values] of transientInputs) {
      [...this.shadowRoot.querySelectorAll(selector)].forEach((input, index) => {
        const previous = values[index];
        if (!previous) return;
        input.value = previous.value;
        const menu = input.closest?.(".label-combo,.category-combo,.category-picker")?.querySelector(".label-picker-options,.category-picker-options");
        if (menu && previous.menuHidden !== undefined) {
          if (!previous.menuHidden) input.dispatchEvent?.(new Event("input"));
          menu.hidden = previous.menuHidden;
        }
      });
    }
    if (attribute) {
      const next = [...this.shadowRoot.querySelectorAll(`[${attribute}]`)].find((node) => node.getAttribute(attribute) === value);
      if (next) {
        if (inputValue !== undefined) next.value = inputValue;
        next.focus?.({ preventScroll: true });
        if (selection) next.setSelectionRange?.(...selection);
      }
    }
    [...this.shadowRoot.querySelectorAll(scrollSelector)].forEach((node, index) => {
      if (innerScroll[index]) [node.scrollTop, node.scrollLeft] = innerScroll[index];
    });
    outerScroll.forEach(([node, top, left]) => { node.scrollTop = top; node.scrollLeft = left; });
  }

  _itemPresentationSignature(item) {
    return JSON.stringify({
      id: item.id, name: item.name, description: item.description || null, completed: Boolean(item.completed),
      category_id: item.category_id || null, category: item.category || null, due_at: item.due_at || null,
      product_id: item.product_id || null,
      labels: (item.labels || []).map((label) => ({ id: label.id, name: label.name, icon: label.icon, color: label.color })),
    });
  }

  _canPatchQuantityRefresh(list, items, categories, labels, chips, dishes, products, notifications) {
    if (!this._list || !this.shadowRoot?.querySelector("main")) return false;
    const listSignature = (value) => JSON.stringify(value ? { id: value.id, name: value.name, list_type: value.list_type, bring_list_id: value.bring_list_id || null } : null);
    if (listSignature(this._list) !== listSignature(list)) return false;
    if (JSON.stringify(this._categories) !== JSON.stringify(categories)
      || JSON.stringify(this._labels) !== JSON.stringify(labels)
      || JSON.stringify(this._chips) !== JSON.stringify(chips)
      || JSON.stringify(this._dishes) !== JSON.stringify(dishes)
      || JSON.stringify(this._products) !== JSON.stringify(products)
      || JSON.stringify(this._notificationAssignments) !== JSON.stringify(notifications)
      || this._items.length !== items.length) return false;
    const previous = new Map(this._items.map((item) => [item.id, this._itemPresentationSignature(item)]));
    return items.every((item) => previous.get(item.id) === this._itemPresentationSignature(item));
  }

  _patchQuantityItems(items) {
    const previous = new Map(this._items.map((item) => [item.id, Number(item.quantity || 0)]));
    this._items = items;
    for (const item of items) {
      if (previous.get(item.id) === Number(item.quantity || 0)) continue;
      const rows = [...this.shadowRoot.querySelectorAll("[data-item-id]")].filter((element) => element.dataset.itemId === item.id);
      for (const row of rows) {
        const name = row.querySelector(".item-name");
        const controlsQuantity = row.querySelector(".controls-quantity");
        // Every label representation shares the same entry; keep offer badges mounted.
        if (name?.firstChild) name.firstChild.textContent = this._displayName(item) + (item.offer_only ? " " : "");
        if (controlsQuantity) controlsQuantity.textContent = String(Math.max(0, Number(item.quantity || 0)));
      }
    }
  }

  _capturePageScrollAnchor(preferred = null) {
    if (this._expandedView) return null;
    const scrollers = [];
    for (let node = this; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) scrollers.push(node);
    }
    if (!scrollers.length) return null;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const selector = "[data-item-id],[data-chip-category],[data-quick-chip],[data-dish],[data-category],[data-label-filter-preset],[data-open-label-filter]";
    const action = preferred || this._pageActionAnchor || this.shadowRoot.activeElement?.closest?.(selector);
    const candidates = [action, ...this.shadowRoot.querySelectorAll(selector)].filter(Boolean);
    for (const node of candidates) {
      // Fixed dialogs have their own scroll area and must never anchor the page behind them.
      if (node.closest?.(".backdrop,.filter-menu")) continue;
      const bounds = node.getBoundingClientRect();
      if (bounds.height > 0 && bounds.bottom > 0 && bounds.top < viewportHeight) return { node, top: bounds.top, scrollers };
    }
    return null;
  }

  _restorePageScrollAnchor(anchor) {
    if (!anchor?.node.isConnected) return;
    // Safari cannot rely on native scroll anchoring. Correct only the measured
    // layout shift, synchronously; browsers that already anchored need no change.
    let remaining = anchor.node.getBoundingClientRect().top - anchor.top;
    for (const scroller of anchor.scrollers) {
      if (Math.abs(remaining) < 0.5) break;
      const before = scroller.scrollTop;
      scroller.scrollTop += remaining;
      remaining -= scroller.scrollTop - before;
    }
  }

  _setNotificationStatus(message, anchorItemId = null) {
    this._notificationStatus = message;
    const region = this.shadowRoot?.querySelector("[data-status-region]");
    if (!region) return;
    const card = this.shadowRoot.querySelector("ha-card");
    const anchor = anchorItemId
      ? [...this.shadowRoot.querySelectorAll("[data-item-id]")].find((element) => element.dataset.itemId === anchorItemId)
      : null;
    const pageAnchor = this._capturePageScrollAnchor(anchor);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const before = region.getBoundingClientRect().height;
    this._clearRenderListeners(region);
    // Native HA icons render asynchronously; retain the mounted icon when the text changes.
    const template = document.createElement("template");
    template.innerHTML = this._notice(message, "notification", "send-status", "check-circle-outline");
    this._patchDom(region, template.content);
    this._bindNotices(region);
    const heightChange = Number.isFinite(anchorTop)
      ? anchor.getBoundingClientRect().top - anchorTop
      : region.getBoundingClientRect().height - before;
    if (this._expandedView && card?.scrollTop > 0 && heightChange) {
      card.scrollTop += heightChange;
      this._expandedScrollTop = card.scrollTop;
    }
    this._restorePageScrollAnchor(pageAnchor);
  }

  _searchProducts(value) {
    // Keep the live input node mounted while typing. Replacing the complete
    // shadow DOM here makes Home Assistant lose focus after every keypress.
    this._inputValue = value;
    this._suggestionsVisible = true;
    this._error = "";
    clearTimeout(this._searchTimer);
    if (!this._config.allow_suggestions || !value.trim()) {
      this._suggestions = [];
      this._refreshSearchView();
      return;
    }
    this._searchTimer = setTimeout(async () => {
      try {
        const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/list`, search: value.trim(), limit: 25, offset: 0 });
        if (this._inputValue === value) {
          this._suggestions = result.products || [];
          this._refreshSearchView();
        }
      } catch (error) { this._error = error?.message || String(error); this._render(); }
    }, 180);
    this._refreshSearchView();
  }

  async _sendList(profileIds = null) {
    if (this._busy || !this._listId()) return;
    this._busy = true;
    this._error = "";
    this._notificationStatus = "";
    this._render();
    try {
      const payload = { type: `${HA_LM_API}/notifications/send_list`, list_id: this._listId() };
      if (profileIds) payload.profile_ids = profileIds;
      const result = await haListManagerShoppingCardTextRequest(this._hass, payload);
      const count = (result.sent_profile_ids || []).length;
      this._notificationStatus = haListManagerShoppingCardText("ui.list_sent_to", {p0:(count), p1:(count === 1 ? haListManagerShoppingCardText("ui.target", {}, this._hass) : haListManagerShoppingCardText("ui.targets", {}, this._hass))}, this._hass);
    } catch (error) { this._error = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }

  _requestShare() {
    const profiles = this._notificationAssignments
      .filter((assignment) => assignment.manual_enabled && assignment.profile?.enabled)
      .map((assignment) => ({ id: assignment.profile.id, name: assignment.profile.name }));
    if (!profiles.length) return;
    this._confirmation = { type: "share", profiles, selectedIds: profiles.map((profile) => profile.id) };
    this._lockScroll();
    this._render();
  }

  async _confirmShare() {
    const selectedIds = [...(this._confirmation?.selectedIds || [])];
    if (!selectedIds.length) return;
    this._confirmation = null;
    this._unlockScroll();
    await this._sendList(selectedIds);
  }

  _formattedProductName(product, showBrand, showQuantity) {
    const parts = [product.name];
    const name = String(product.name || "").toLocaleLowerCase();
    if (showBrand && product.brand && !name.includes(String(product.brand).toLocaleLowerCase())) parts.push(product.brand);
    if (showQuantity && product.package_quantity && !name.includes(String(product.package_quantity).toLocaleLowerCase())) parts.push(product.package_quantity);
    return parts.filter(Boolean).join(" – ");
  }

  _productName(product) { return this._formattedProductName(product, this._config.show_brand, this._config.show_quantity); }

  _requestedQuantity() {
    return Math.max(1, Number.parseInt(this.shadowRoot.querySelector("[data-quantity]")?.value, 10) || 1);
  }

  _matchingProductCategory(product) {
    const available = this._availableCategories();
    const byId = new Map(available.map((category) => [category.id, category]));
    const assignments = Array.isArray(product?.category_assignments) ? product.category_assignments : [];
    const preferred = [
      assignments.find((item) => item.scope === "list" && item.list_id === this._listId()),
      this._list?.use_type_categories === false ? null : assignments.find((item) => item.scope === "list_type" && item.list_type === "shopping"),
      this._list?.use_global_categories === false ? null : assignments.find((item) => item.scope === "global"),
    ].find(Boolean);
    if (!preferred) return null;
    const assigned = byId.get(preferred.category_id) || preferred.category;
    const assignedName = String(assigned?.name || "").trim();
    if (!assignedName) return byId.get(preferred.category_id) || null;
    const scopeRank = (category) => category.scope === "list" ? 3 : category.scope === "list_type" ? 2 : category.scope === "global" ? 1 : 0;
    const sameName = available
      .filter((category) => !category.dynamic && category.name.localeCompare(assignedName, undefined, { sensitivity: "base" }) === 0)
      .sort((left, right) => scopeRank(right) - scopeRank(left));
    if (sameName.length) return sameName[0];
    if (byId.has(preferred.category_id)) return byId.get(preferred.category_id);
    return null;
  }

  async _matchingAutomaticCategory(name) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName || !this._hass || !this._listId()) return null;
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, {
        type: `${HA_LM_API}/categories/rules/resolve`,
        list_id: this._listId(),
        name: normalizedName,
      });
      const resolved = result.category;
      if (!resolved) return null;
      return this._availableCategories().find((category) => category.id === resolved.id)
        || this._availableCategories().find((category) => !category.dynamic && category.name.localeCompare(resolved.name, undefined, { sensitivity: "base" }) === 0)
        || null;
    } catch (_error) {
      // The backend still applies the rule while saving. A failed preview must
      // not prevent the user from opening the normal item dialog.
      return null;
    }
  }

  _existingItem(product, rawName = "") {
    if (product?.id) {
      return this._items.find((item) => item.product_id === product.id) || null;
    }
    // A product selected from the database is identified only by its ID.
    // Equal display names may intentionally represent different brands,
    // package sizes or category assignments. Name matching is reserved for
    // genuinely free, unlinked list entries.
    if (product) return null;
    const candidates = [rawName]
      .map((name) => String(name || "").trim().toLocaleLowerCase())
      .filter(Boolean);
    return this._items.find((item) => !item.product_id && candidates.includes(String(item.name || "").trim().toLocaleLowerCase())) || null;
  }

  async _updateExistingQuantity(item, increment) {
    this._busy = true;
    try {
      const previous = Math.max(0, Number(item.quantity || 0));
      const next = previous + increment;
      await haListManagerShoppingCardTextRequest(this._hass, this._itemPayload({ ...item, completed: false }, next));
      this._rememberBrowserChip(item.name, this._products.find((product) => product.id === item.product_id) || item);
      this._inputValue = "";
      this._suggestions = [];
      this._notificationStatus = haListManagerShoppingCardText("shopping.quantity_increased", {p0:(item.name), p1:(previous), p2:(next)}, this._hass);
      await this._load(true);
    } catch (error) { this._error = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }

  async _createProductItem(product, rawName, quantity, forceGeneral = false) {
    const category = forceGeneral ? null : this._matchingProductCategory(product);
    this._busy = true;
    try {
      let resolvedProduct = product;
      if (product?._new) {
        const created = await haListManagerShoppingCardTextRequest(this._hass, {
          type: `${HA_LM_API}/products/create`, ean: product.ean || null, name: product.name || rawName,
          original_name: product.original_name || product.name || null, brand: product.brand || null,
          package_quantity: product.package_quantity || null, category: null,
          image_url: product.image_url || null, label_ids: (product.labels || []).map((label) => label.id),
        });
        resolvedProduct = created.product;
      }
      await haListManagerShoppingCardTextRequest(this._hass, {
        type: `${HA_LM_API}/items/create`, list_id: this._listId(),
        name: String(resolvedProduct?.name || rawName).trim(), description: null, quantity,
        category_id: category && !category.dynamic ? category.id : null,
        category: forceGeneral ? null : category?.dynamic ? category.name : null,
        due_at: null, label_ids: (resolvedProduct?.labels || product?.labels || []).map((label) => label.id), product_id: resolvedProduct?.id || null,
      });
      this._rememberBrowserChip(String(resolvedProduct?.name || rawName).trim(), resolvedProduct);
      this._inputValue = "";
      this._suggestions = [];
      this._notificationStatus = haListManagerShoppingCardText("shopping.quantity_added", {p0:quantity, p1:String(resolvedProduct?.name || rawName).trim()}, this._hass);
      await this._load(true);
    } catch (error) { this._error = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }

  async _handleProduct(product, rawName = "", quantity = this._requestedQuantity()) {
    const existing = this._existingItem(product, rawName);
    if (existing) {
      if (this._config.add_dialog_behavior === "always") {
        this._openIncrementDialog(existing, product || this._products.find((entry) => entry.id === existing.product_id), quantity);
      } else {
        await this._updateExistingQuantity(existing, quantity);
      }
      return;
    }
    if (this._config.add_dialog_behavior === "never") {
      await this._createProductItem(product, rawName, quantity, true);
      return;
    }
    const productCategory = this._matchingProductCategory(product);
    const automaticCategory = productCategory
      ? null
      : await this._matchingAutomaticCategory(product?.name || rawName);
    if (this._config.add_dialog_behavior === "missing_category" && productCategory) {
      await this._createProductItem(product, rawName, quantity);
      return;
    }
    this._openDialog(null, product, rawName, quantity, false, automaticCategory);
  }

  async _useInput() {
    const raw = this._inputValue.trim();
    if (!raw || this._busy) return;
    clearTimeout(this._searchTimer);
    const requestedQuantity = this._requestedQuantity();
    const normalized = raw.toLocaleLowerCase();
    let exactMatches = this._suggestions.filter((product) => product.ean === raw || product.name.toLocaleLowerCase() === normalized);
    if (exactMatches.length === 1) { await this._handleProduct(exactMatches[0], "", requestedQuantity); return; }
    if (exactMatches.length > 1) {
      this._openProductPicker(exactMatches, raw, requestedQuantity);
      return;
    }
    if (/^\d{8,14}$/.test(raw)) {
      this._busy = true; this._render();
      try {
        const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/lookup`, ean: raw, product_id: null });
        this._busy = false;
        await this._handleProduct(result.duplicate || { ...result.product, _new: true, labels: [] }, raw, requestedQuantity);
      } catch (_error) {
        this._openDialog(null, null, raw, requestedQuantity, false);
        this._dialog.status = haListManagerShoppingCardText("products.ean_unknown_manual", {}, this._hass);
        this._dialog.statusTone = "warning";
      } finally { this._busy = false; this._render(); }
      return;
    }
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/list`, search: raw, limit: 100, offset: 0 });
      exactMatches = (result.products || []).filter((product) => product.name.toLocaleLowerCase() === normalized);
      if (exactMatches.length === 1) { await this._handleProduct(exactMatches[0], "", requestedQuantity); return; }
      if (exactMatches.length > 1) {
        this._openProductPicker(exactMatches, raw, requestedQuantity);
        return;
      }
    } catch (error) {
      this._error = error?.message || String(error);
      this._render();
      return;
    }
    await this._handleProduct(null, raw, requestedQuantity);
  }

  async _useChip(chip) {
    if (!chip || this._busy) return;
    const quantity = this._requestedQuantity();
    try {
      if (chip.product_id) {
        let product = this._products.find((entry) => entry.id === chip.product_id) || null;
        if (!product) {
          const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/list`, search: chip.product_name || chip.name, limit: 100, offset: 0 });
          product = (result.products || []).find((entry) => entry.id === chip.product_id) || null;
        }
        if (product) {
          await this._handleProduct(product, "", quantity);
          return;
        }
      }
      this._inputValue = chip.name;
      this._suggestions = [];
      await this._useInput();
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._inputValue = "";
      this._suggestions = [];
      this._render();
    }
  }

  async _useDish(dish) {
    if (!dish || this._busy) return;
    this._chipDialog = false;
    if (this._config.dishes_confirm_add === false) {
      await this._addDishToList(dish, null);
      return;
    }
    let resolutions = new Map();
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, {
        type: `${HA_LM_API}/categories/chips/resolve`,
        list_id: this._listId(),
        candidates: dish.items.map((item) => ({
          key: item.id,
          name: item.product_name || item.name,
          product_id: item.product_id || null,
        })),
      });
      resolutions = new Map((result.resolutions || []).map((entry) => [entry.key, entry.category || null]));
    } catch (_error) {}
    const categories = Object.fromEntries(dish.items.map((item) => {
      const existing = this._items.find((entry) => item.product_id
        ? entry.product_id === item.product_id
        : !entry.product_id && entry.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase());
      if (existing) {
        const category = this._categoryFor(existing);
        return [item.id, { category_id: existing.category_id || category.id || null, category_name: category.uncategorized ? "" : category.name, dynamic: Boolean(category.dynamic), general: Boolean(category.uncategorized), source: "existing", locked: true }];
      }
      const category = resolutions.get(item.id);
      return [item.id, {
        category_id: category?.id || null,
        category_name: category?.name || "",
        dynamic: Boolean(category?.dynamic || String(category?.id || "").startsWith("dynamic:")),
        general: !category,
        source: category ? "automatic" : "none",
        locked: false,
      }];
    }));
    this._dishDialog = {
      dish,
      selected: new Set(dish.items.map((item) => item.id)),
      quantities: Object.fromEntries(dish.items.map((item) => [item.id, item.quantity || 1])),
      categories,
      status: "",
    };
    this._lockScroll();
    this._render();
  }

  async _addDishToList(dish, items) {
    if (!dish || this._busy) return;
    this._busy = true;
    this._error = "";
    if (this._dishDialog) this._dishDialog.status = "";
    this._render();
    try {
      const payload = { type: `${HA_LM_API}/dishes/add_to_list`, dish_id: dish.id, list_id: this._listId() };
      if (items) payload.items = items;
      const result = await haListManagerShoppingCardTextRequest(this._hass, payload);
      this._dishDialog = null;
      this._unlockScroll();
      const count = Number(result.created || 0) + Number(result.updated || 0);
      this._setNotificationStatus((count === 1 ? haListManagerShoppingCardText("shopping.dish_added_one", {dish: dish.name, count}, this._hass) : haListManagerShoppingCardText("shopping.dish_added_many", {dish: dish.name, count}, this._hass)));
      await this._load(true);
    } catch (error) {
      const message = error?.message || String(error);
      if (this._dishDialog) this._dishDialog.status = message;
      else this._error = message;
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _closeDishDialog() {
    this._dishDialog = null;
    if (!this._dialog && !this._confirmation && !this._imageDialog && !this._chipDialog) this._unlockScroll();
    this._render();
  }

  _openProductPicker(products, rawName, quantity) {
    this._error = "";
    this._suggestions = [];
    this._productPicker = { products, rawName, quantity };
    this._lockScroll();
    this._render();
  }

  _closeProductPicker() {
    this._productPicker = null;
    if (!this._dialog && !this._confirmation && !this._imageDialog && !this._chipDialog && !this._dishDialog) this._unlockScroll();
    this._render();
  }

  async _chooseProduct(productId) {
    const picker = this._productPicker;
    const product = picker?.products.find((entry) => entry.id === productId);
    if (!picker || !product) return;
    this._productPicker = null;
    this._unlockScroll();
    await this._handleProduct(product, "", picker.quantity);
  }

  _clearInput() {
    clearTimeout(this._searchTimer);
    this._inputValue = "";
    this._suggestions = [];
    this._error = "";
    this._render();
    this.shadowRoot.querySelector("[data-product-input]")?.focus();
  }

  _openDialog(item = null, product = null, rawName = "", quantity = null, completed = null, automaticCategory = null) {
    const currentCategory = item ? this._categoryFor(item) : null;
    const categoryName = currentCategory?.uncategorized ? "" : currentCategory?.name || "";
    const category = item ? currentCategory?.uncategorized ? null : currentCategory
      : this._matchingProductCategory(product) || automaticCategory;
    this._itemAction = null;
    this._dialog = {
      mode: item ? "edit" : "create", item, product, name: item?.name || product?.name || rawName,
      description: item?.description || "", offer_only: item?.offer_only === true,
      quantity: quantity ?? item?.quantity ?? 1, completed: completed ?? item?.completed ?? false,
      category_id: category && !category.dynamic ? category.id : null,
      category_name: category ? category.name : categoryName,
      remember_product_category: false,
      remember_product_labels: false,
      label_ids: [...new Set((item?.labels || product?.labels || []).map((label) => label.id))],
      status: "", statusTone: "error",
    };
    this._dialog.initialState = this._dialogSnapshot();
    this._suggestions = [];
    this._lockScroll();
    this._render();
  }

  _openIncrementDialog(item, product, increment = 1) {
    this._dialog = {
      mode: "increment", item, product,
      name: item.name, increment: Math.max(1, Number.parseInt(increment, 10) || 1),
      status: "", statusTone: "error",
    };
    this._suggestions = [];
    this._lockScroll();
    this._render();
  }

  _productTransferDraft(parent, product = null) {
    const description = String(parent?.description || "").trim();
    const packageQuantity = /^\d+(?:[.,]\d+)?\s*(?:mg|kg|g|ml|cl|l|stück|stueck|stk|st|pieces?|pcs?)$/i.test(description)
      ? description
      : "";
    const category = parent?.category_id
      ? this._availableCategories().find((entry) => entry.id === parent.category_id && !entry.dynamic)
      : null;
    const draft = {
      mode: "product-transfer",
      parent,
      item: parent?.item || null,
      product,
      editing: Boolean(product?.id),
      name: product?.name || parent?.name || "",
      original_name: product?.original_name || "",
      ean: product?.ean || "",
      brand: product?.brand || "",
      package_quantity: product?.package_quantity || packageQuantity,
      image_url: product?.image_url || "",
      category_id: category?.id || this._matchingProductCategory(product)?.id || null,
      category_name: category?.name || this._matchingProductCategory(product)?.name || parent?.category_name || "",
      label_ids: [...new Set((product?.labels || []).map((label) => label.id).concat(parent?.label_ids || []))],
      move_item_category: false,
      status: "",
      statusTone: "error",
      eanStatus: "",
      eanStatusTone: "error",
    };
    draft.initialState = this._dialogSnapshot(draft);
    return draft;
  }

  async _openProductTransferDialog() {
    const parent = this._dialog;
    if (!parent?.item || this._busy) return;
    parent.dialogScroll = this.shadowRoot.querySelector("[data-dialog]")?.scrollTop || 0;
    this.shadowRoot.activeElement?.blur?.();
    const linked = parent.product || this._products.find((product) => product.id === parent.item.product_id) || null;
    if (linked) {
      this._dialog = this._productTransferDraft(parent, linked);
      this._render();
      return;
    }
    this._busy = true;
    parent.status = "";
    this._render();
    try {
      const name = parent.name.trim();
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/list`, search: name, limit: 100, offset: 0 });
      const normalized = name.replace(/\s+/g, " ").toLocaleLowerCase();
      const matches = (result.products || []).filter((product) => String(product.name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalized);
      this._dialog = matches.length
        ? { mode: "product-duplicates", parent, item: parent.item, matches, status: "", statusTone: "error" }
        : this._productTransferDraft(parent);
    } catch (error) {
      parent.status = error?.message || haListManagerShoppingCardText("errors.product_database_check_failed", {}, this._hass);
      parent.statusTone = "error";
      this._dialog = parent;
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _backToItemDialog(discard = false) {
    const parent = this._dialog?.parent;
    if (!parent || this._busy) return;
    if (!discard && this._isDialogDirty()) { this._requestDialogDiscard(); return; }
    this.shadowRoot.activeElement?.blur?.();
    this._dialog = parent;
    this._render();
    this.shadowRoot.querySelector("[data-open-product-transfer]")?.focus({ preventScroll: true });
    const panel = this.shadowRoot.querySelector("[data-dialog]");
    if (panel) panel.scrollTop = parent.dialogScroll || 0;
  }

  async _linkProductToItem(product, parent = this._dialog?.parent) {
    if (!product?.id || !parent?.item || this._busy) return;
    this._busy = true;
    this._dialog.status = "";
    this._render();
    try {
      const payload = this._itemDraftPayload(parent, product);
      await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/update`, item_id: parent.item.id, completed: parent.completed, ...payload });
      this._setNotificationStatus(haListManagerShoppingCardText("products.linked_to_database", {p0:(product.name)}, this._hass), parent.item.id);
      this._dialog = null;
      this._unlockScroll();
      await this._load(true);
    } catch (error) {
      this._dialog.status = error?.message || haListManagerShoppingCardText("ui.product_link_failed", {}, this._hass);
      this._dialog.statusTone = "error";
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _productTransferCategoryIds(product, category) {
    // Updating a product default must not use the backend's bulk-move action.
    // Keep defaults from other contexts, including other individual lists.
    const scope = category?.scope || "list";
    const sameContext = (assignment) => assignment.scope === scope && (
      scope === "global" || (scope === "list_type"
        ? assignment.list_type === category.list_type
        : assignment.list_id === (category?.list_id || this._listId()))
    );
    const ids = (product.category_assignments || [])
      .filter((assignment) => !sameContext(assignment))
      .map((assignment) => assignment.category_id);
    return [...new Set(category ? [...ids, category.id] : ids)];
  }

  async _saveProductTransfer() {
    const draft = this._dialog;
    if (draft?.mode !== "product-transfer" || !draft.name.trim() || this._busy) return;
    const categoryText = draft.category_name.trim();
    const categories = this._availableCategories();
    const category = draft.category_id
      ? categories.find((entry) => entry.id === draft.category_id && !entry.dynamic)
      : categories.find((entry) => !entry.dynamic && entry.name.localeCompare(categoryText, undefined, { sensitivity: "base" }) === 0);
    if (categoryText && !category) {
      const dynamic = categories.some((entry) => entry.dynamic && entry.name.localeCompare(categoryText, undefined, { sensitivity: "base" }) === 0);
      draft.status = dynamic
        ? haListManagerShoppingCardText("ui.dynamic_category_save_required", {p0:(categoryText)}, this._hass)
        : haListManagerShoppingCardText("errors.saved_category_required", {p0:(categoryText)}, this._hass);
      draft.statusTone = "warning";
      this._render();
      return;
    }
    this._busy = true;
    draft.status = "";
    this._render();
    try {
      const productPayload = {
        ean: draft.ean.trim() || null,
        name: draft.name.trim(),
        original_name: draft.original_name.trim() || null,
        brand: draft.brand.trim() || null,
        package_quantity: draft.package_quantity.trim() || null,
        category: null,
        image_url: draft.image_url.trim() || null,
        label_ids: draft.label_ids,
      };
      let product;
      if (draft.editing) {
        const result = await globalThis.HaListManagerProductEditor.saveProduct(this, options => haListManagerShoppingCardTextRequest(this._hass, {
          type: `${HA_LM_API}/products/update`, product_id: draft.product.id, ...productPayload,
          ...options, category_ids: this._productTransferCategoryIds(draft.product, category),
        }));
        if (!result) { this._busy = false; this._render(); return; }
        product = result.product;
      } else {
        const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/create`, ...productPayload, category_ids: category ? [category.id] : [] });
        product = result.product;
      }
      this._products = [...this._products.filter((entry) => entry.id !== product.id), product];
      const parent = draft.move_item_category
        ? { ...draft.parent, category_id: category?.id || null, category_name: category?.name || "" }
        : draft.parent;
      this._busy = false;
      await this._linkProductToItem(product, parent);
    } catch (error) {
      if (error?.code === "ean_already_exists") {
        draft.eanStatus = haListManagerShoppingCardText("ui.ean_already_assigned", {}, this._hass);
        draft.eanStatusTone = "error";
      } else {
        draft.status = error?.message || haListManagerShoppingCardText("errors.product_save_failed", {}, this._hass);
        draft.statusTone = "error";
      }
      this._busy = false;
      this._render();
    }
  }

  _stageProductRefresh(draft, product) {
    globalThis.HaListManagerProductEditor.stageRefresh(draft, product);
  }

  _applyProductRefresh(field, selected, draft) {
    const change = globalThis.HaListManagerProductEditor.applyRefresh(draft, field, selected);
    if (!change) return;
    // Keep the dialog nodes mounted so choosing replacements retains focus and scroll.
    const input = this.shadowRoot.querySelector(`[data-product-field="${field}"]`);
    if (input) input.value = draft[field];
    const checkbox = this.shadowRoot.querySelector(`[data-off-change="${field}"]`);
    if (checkbox) {
      checkbox.checked = selected;
      const values = checkbox.closest("label")?.querySelector("small");
      if (values) values.textContent = `${change.before} → ${change.after}`;
    }
    if (field === "image_url") {
      const image = this.shadowRoot.querySelector(".product-editor-image img");
      if (image) image.src = draft.image_url;
    }
    this._updateDialogDirtyState();
  }

  async _lookupProductTransferEan() {
    const draft = this._dialog;
    if (draft?.mode !== "product-transfer" || this._busy) return;
    const ean = draft.ean.trim();
    if (!/^\d{4,32}$/.test(ean)) {
      draft.eanStatus = haListManagerShoppingCardText("errors.ean_digits_required", {}, this._hass);
      draft.eanStatusTone = "error";
      this._render();
      return;
    }
    this.shadowRoot.activeElement?.blur?.();
    this._busy = true;
    draft.eanStatus = "";
    this._render();
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/products/lookup`, ean, product_id: draft.product?.id || null });
      if (this._dialog !== draft || draft.ean.trim() !== ean) return;
      if (result.duplicate) {
        draft.eanStatus = haListManagerShoppingCardText("errors.ean_already_assigned", {p0:(result.duplicate.name)}, this._hass);
        draft.eanStatusTone = "warning";
      } else if (result.product) {
        const product = result.product;
        this._stageProductRefresh(draft, product);
        draft.eanStatus = haListManagerShoppingCardText("products.off_refreshed_custom_kept", {}, this._hass);
        draft.eanStatusTone = "success";
      }
    } catch (error) {
      if (this._dialog !== draft) return;
      draft.eanStatus = error?.code === "product_not_found"
        ? haListManagerShoppingCardText("products.ean_data_not_found", {}, this._hass)
        : error?.message || haListManagerShoppingCardText("errors.product_data_load_failed", {}, this._hass);
      draft.eanStatusTone = error?.code === "product_not_found" ? "warning" : "error";
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _dialogSnapshot(draft = this._dialog) {
    if (!draft) return null;
    if (draft.mode === "product-transfer") {
      const categoryName = String(draft.category_name || "").trim();
      const category = this._availableCategories().find((entry) => !entry.dynamic && (draft.category_id
        ? entry.id === draft.category_id : entry.name.toLocaleLowerCase() === categoryName.toLocaleLowerCase()));
      return globalThis.HaListManagerProductEditor.snapshot(draft, {
        category_id: category?.id || null, category_name: category ? "" : categoryName,
        move_item_category: draft.move_item_category === true });
    }
    // Compare the values we would save, so reselecting the same category stays clean.
    const payload = this._itemDraftPayload(draft, draft.product);
    return JSON.stringify({
      name: payload.name, description: payload.description || "", quantity: payload.quantity,
      offer_only: payload.offer_only, completed: draft.completed === true,
      category_id: payload.category_id, category_name: payload.category || "",
      remember_product_category: payload.remember_product_category === true,
      remember_product_labels: payload.remember_product_labels === true,
      label_ids: [...new Set(payload.label_ids || [])].sort(),
    });
  }

  _isDialogDirty() {
    return ["edit", "product-transfer"].includes(this._dialog?.mode) && this._dialog.initialState != null
      && this._dialog.initialState !== this._dialogSnapshot();
  }

  _updateDialogDirtyState() {
    const indicator = this.shadowRoot.querySelector("[data-unsaved-indicator]");
    if (indicator) indicator.hidden = !this._isDialogDirty();
    globalThis.HaListManagerDialogSections.refresh(this);
    this._refreshEditorNotices();
  }

  _closeDialog() {
    if (this._imageDialog) {
      this._imageDialog = null;
      if (!this._dialog && !this._chipDialog) this._unlockScroll();
      this._refreshMetadataUi();
      return;
    }
    if (this._selectionPopup) { this._closeSelectionPopup(); return; }
    if (this._itemAction) { this._closeItemAction(); return; }
    if (this._busy || this._confirmation) return;
    if (this._dialog?.parent) { this._backToItemDialog(); return; }
    if (this._isDialogDirty()) { this._requestDialogDiscard(); return; }
    this._discardDialog();
  }

  _requestDialogDiscard() {
    if (this._confirmation) return;
    const active = this.shadowRoot.activeElement;
    const attribute = active?.getAttributeNames?.().find((name) => name.startsWith("data-"));
    const selection = active?.tagName === "INPUT" && ["text", "search", "url", "tel"].includes(active.type)
      ? [active.selectionStart, active.selectionEnd] : null;
    this._confirmation = { type: "discard_dialog", returnToParent: Boolean(this._dialog?.parent), returnFocus: attribute
      ? { attribute, value: active.getAttribute(attribute), tagName: active.tagName, element: active, selection } : null };
    // Keep the original form mounted so opening/cancelling the prompt cannot scroll it.
    this.shadowRoot.querySelector("ha-card")?.insertAdjacentHTML("beforeend", this._renderConfirmation());
    this._bindDiscardConfirmation();
    this.shadowRoot.querySelector("[data-cancel-confirmation]")?.focus({ preventScroll: true });
  }

  _cancelConfirmation() {
    const confirmation = this._confirmation;
    this._confirmation = null;
    if (!this._dialog) this._unlockScroll();
    if (confirmation?.type !== "discard_dialog") { this._render(); return; }
    const backdrop = this.shadowRoot.querySelector("[data-discard-backdrop]");
    if (backdrop) { this._clearRenderListeners(backdrop); backdrop.remove(); }
    const focus = confirmation.returnFocus;
    const target = focus?.element?.isConnected ? focus.element
      : focus && [...this.shadowRoot.querySelectorAll(`[${focus.attribute}]`)]
        .find((element) => element.getAttribute(focus.attribute) === focus.value && element.tagName === focus.tagName);
    target?.focus({ preventScroll: true });
    if (focus?.selection && target?.setSelectionRange) target.setSelectionRange(...focus.selection);
  }

  _bindDiscardConfirmation() {
    if (this._confirmation?.type !== "discard_dialog") return;
    this._listen(this.shadowRoot.querySelector("[data-confirm-discard]"), "click", () => {
      const returnToParent = this._confirmation?.returnToParent;
      this._confirmation = null;
      if (returnToParent) this._backToItemDialog(true);
      else this._discardDialog();
    });
    this._listen(this.shadowRoot.querySelector("[data-cancel-confirmation]"), "click", () => this._cancelConfirmation());
    this._listen(this.shadowRoot.querySelector("[data-discard-confirmation]"), "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this._cancelConfirmation(); }
    });
  }

  _discardDialog() {
    this._dialog = null;
    this._confirmation = null;
    this._imageDialog = null;
    this._unlockScroll();
    this._render();
  }
  _closeChipDialog() {
    this._chipDialog = false;
    if (!this._dialog && !this._productPicker && !this._confirmation && !this._imageDialog) this._unlockScroll();
    this._render();
  }

  _lockScroll() { if (!this._scrollLocked) { this._scrollLocked = true; this._oldOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; } }
  _unlockScroll() { if (this._scrollLocked) { document.body.style.overflow = this._expandedView ? "hidden" : this._oldOverflow || ""; this._scrollLocked = false; } }

  async _saveDialog() {
    const draft = this._dialog;
    if (draft?.mode === "increment") { await this._saveIncrementDialog(); return; }
    if (draft?.mode === "product-transfer") { await this._saveProductTransfer(); return; }
    if (!draft || !draft.name.trim() || this._busy) return;
    this._busy = true; draft.status = ""; this._render();
    try {
      let product = draft.product;
      if (draft.camera_capture) {
        await globalThis.HaListManagerShoppingScanner.for(this).confirmDraft(draft);
        this._inputValue = "";
        this._discardDialog();
        await this._load(true);
        return;
      }
      if (product?._new) {
        const created = await haListManagerShoppingCardTextRequest(this._hass, {
          type: `${HA_LM_API}/products/create`, ean: product.ean || null, name: draft.name.trim(), original_name: product.name || null,
          brand: product.brand || null, package_quantity: product.package_quantity || null, category: null,
          image_url: product.image_url || null, label_ids: draft.label_ids,
        });
        product = created.product;
      }
      const payload = this._itemDraftPayload(draft, product);
      if (draft.item) await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/update`, item_id: draft.item.id, completed: draft.completed, ...payload });
      else await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/create`, list_id: this._listId(), ...payload });
      if (!draft.item) {
        this._rememberBrowserChip(payload.name, product);
        this._notificationStatus = haListManagerShoppingCardText("shopping.quantity_added", {p0:payload.quantity, p1:payload.name}, this._hass);
      }
      this._inputValue = "";
      // The persisted draft no longer needs a discard confirmation.
      this._discardDialog();
      await this._load(true);
    } catch (error) { draft.status = error?.message || String(error); draft.statusTone = "error"; }
    finally { this._busy = false; this._render(); }
  }

  _itemDraftPayload(draft, product = null) {
    const categoryText = draft.category_name.trim();
    // Preserve the exact selected category ID. Names are not unique across
    // global and list-specific categories.
    const matched = draft.category_id
      ? this._availableCategories().find((entry) => entry.id === draft.category_id)
      : this._availableCategories().find((entry) => entry.name.toLocaleLowerCase() === categoryText.toLocaleLowerCase());
    return {
      offer_only: draft.offer_only === true,
      name: draft.name.trim(), description: product ? null : draft.description.trim() || null,
      quantity: Math.max(1, Number.parseInt(draft.quantity, 10) || 1),
      category_id: matched && !matched.dynamic ? matched.id : null,
      category: matched?.dynamic ? matched.name : matched ? null : categoryText || null,
      due_at: draft.item?.due_at || null, label_ids: draft.label_ids,
      product_id: product?.id || draft.item?.product_id || null,
      ...(draft.remember_product_category === true && this._categoryPreferenceState(draft).enabled
        ? { remember_product_category: true } : {}),
      ...(draft.remember_product_labels === true && this._productLabelPreferenceState(draft).enabled
        ? { remember_product_labels: true } : {}),
    };
  }

  async _saveIncrementDialog() {
    const draft = this._dialog;
    if (!draft?.item || this._busy) return;
    const increment = Math.max(1, Number.parseInt(draft.increment, 10) || 1);
    this._busy = true; draft.status = ""; this._render();
    try {
      const quantity = Math.max(0, Number(draft.item.quantity || 0)) + increment;
      await haListManagerShoppingCardTextRequest(this._hass, this._itemPayload({ ...draft.item, completed: false }, quantity));
      this._rememberBrowserChip(draft.item.name, this._products.find((product) => product.id === draft.item.product_id) || draft.item);
      this._inputValue = "";
      this._suggestions = [];
      this._notificationStatus = haListManagerShoppingCardText("shopping.quantity_increased", {p0:draft.item.name, p1:Math.max(0, Number(draft.item.quantity || 0)), p2:quantity}, this._hass);
      this._dialog = null;
      this._unlockScroll();
      await this._load(true);
    } catch (error) { draft.status = error?.message || String(error); draft.statusTone = "error"; }
    finally { this._busy = false; this._render(); }
  }

  _itemPayload(item, quantity) {
    return {
      type: `${HA_LM_API}/items/update`, item_id: item.id, completed: item.completed,
      name: item.name, description: item.description || null, quantity,
      category_id: item.category_id || null, category: item.category || null,
      due_at: item.due_at || null, label_ids: (item.labels || []).map((label) => label.id),
      product_id: item.product_id || null,
    };
  }

  async _changeQuantity(item, delta) {
    if (this._busy) return;
    const next = Math.max(0, Number(item.quantity || 1) + delta);
    if (next === 0) { this._confirmation = { item, source: "minus" }; this._lockScroll(); this._render(); return; }
    this._busy = true;
    try {
      const previous = Math.max(0, Number(item.quantity || 1));
      await haListManagerShoppingCardTextRequest(this._hass, this._itemPayload(item, next));
      this._patchQuantityItems(this._items.map((entry) => entry.id === item.id ? { ...entry, quantity: next } : entry));
      this._setNotificationStatus((delta > 0 ? haListManagerShoppingCardText("shopping.quantity_increased_full", {item: item.name, previous, next}, this._hass) : haListManagerShoppingCardText("shopping.quantity_decreased_full", {item: item.name, previous, next}, this._hass)), item.id);
    }
    catch (error) { this._error = error?.message || String(error); this._render(); }
    finally { this._busy = false; }
  }

  async _complete(item, completed, sourceRow = null, confirmed = false) {
    if (completed && !item.completed && !confirmed && this._list?.provider !== "bring" && this._list?.auto_delete_completed && this._list.auto_delete_confirm) {
      this._rememberExpandedScroll(item.id, sourceRow);
      this._confirmation = {type:"complete_cleanup",item};this._lockScroll();this._render();return;
    }
    this._rememberExpandedScroll(item.id, sourceRow);
    try { await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/set_completed`, item_id: item.id, completed }); await this._load(true); }
    catch (error) { this._error = error?.message || String(error); this._render(); }
  }

  _delete(item) { this._confirmation = { item, source: "dialog" }; this._lockScroll(); this._render(); }

  async _confirmDelete() {
    if (this._confirmation?.type === "complete_cleanup") {
      const item=this._confirmation.item;this._confirmation=null;this._unlockScroll();await this._complete(item,true,null,true);return;
    }
    if (this._confirmation?.type === "clear_completed") {
      await this._clearCompleted();
      return;
    }
    const item = this._confirmation?.item;
    if (!item) return;
    this._confirmation = null;
    try {
      await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/delete`, item_id: item.id });
      this._notificationStatus = haListManagerShoppingCardText("ui.item_removed_from_list", {p0:(item.name)}, this._hass);
      this._dialog = null; this._unlockScroll(); await this._load(true);
    } catch (error) {
      if (this._dialog) { this._dialog.status = error?.message || String(error); this._dialog.statusTone = "error"; }
      else this._error = error?.message || String(error);
      this._render();
    }
  }

  _requestClearCompleted() {
    const items = this._items.filter((item) => item.completed);
    if (!items.length) return;
    this._confirmation = { type: "clear_completed", count: items.length };
    this._lockScroll();
    this._render();
  }

  async _clearCompleted() {
    const items = this._items.filter((item) => item.completed);
    if (!items.length || this._busy) return;
    this._busy = true;
    this._confirmation = null;
    try {
      for (const item of items) {
        await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/items/delete`, item_id: item.id });
      }
      this._notificationStatus = (items.length === 1 ? haListManagerShoppingCardText("shopping.completed_deleted_one", {count: items.length}, this._hass) : haListManagerShoppingCardText("shopping.completed_deleted_many", {count: items.length}, this._hass));
      this._unlockScroll();
      await this._load(true);
    } catch (error) {
      this._error = error?.message || String(error);
      this._unlockScroll();
      this._render();
    } finally {
      this._busy = false;
    }
  }

  _categoryFor(item) {
    const categoryName = String(item.category_name || item.category || "").trim();
    const saved = this._categories.find((entry) => entry.id === item.category_id)
      || (categoryName ? this._categories.find((entry) => !entry.dynamic && entry.name.localeCompare(categoryName, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base" }) === 0) : null);
    return saved
      ? { id: saved.id, name: saved.name, icon: saved.icon, color: saved.color, scope: saved.scope, dynamic: Boolean(saved.dynamic), position: saved.position, manual_position: saved.manual_position }
      : item.category_id && item.category_name
      ? { id: item.category_id, name: item.category_name, icon: null, color: null, scope: "list", dynamic: false }
      : { id: item.category ? `dynamic:${item.category}` : "", name: item.category || haListManagerShoppingCardText("ui.general", {}, this._hass), icon: null, color: null, scope: "list", dynamic: Boolean(item.category), uncategorized: !item.category };
  }

  _availableCategories() {
    const categories = [...this._categories];
    const knownIds = new Set(categories.map((category) => category.id));
    for (const item of this._items) {
      const category = this._categoryFor(item);
      if (!category.dynamic || knownIds.has(category.id)) continue;
      knownIds.add(category.id);
      categories.push(category);
    }
    return categories;
  }

  _visibleItems() {
    const query = this._config.allow_filter ? this._inputValue.trim().toLocaleLowerCase() : "";
    const offerFilter = this._offerFilter();
    const labelFilter = this._activeLabelFilter();
    const compareNames = (a, b) => a.name.localeCompare(b.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true });
    let items = this._items
      .filter((item) => this._matchesLabelFilter(item, labelFilter))
      .filter((item) => offerFilter === "all" || (offerFilter === "only" ? item.offer_only === true : item.offer_only !== true))
      .filter((item) => !query || `${item.name} ${item.description || ""} ${(item.labels || []).map((label) => label.name).join(" ")}`.toLocaleLowerCase().includes(query))
      .sort(compareNames);
    const revealCompleted = query && this._config.show_done_hidden_items_in_search;
    if (!revealCompleted && this._config.acknowledged === "hide") items = items.filter((item) => !item.completed);
    if (!revealCompleted && this._config.acknowledged === "end") items.sort((a, b) => Number(a.completed) - Number(b.completed) || compareNames(a, b));
    return items;
  }

  _groups() {
    const groups = new Map();
    const byLabel = this._groupingMode() === "labels";
    for (const item of this._visibleItems()) {
      const labels = byLabel ? [...new Map((item.labels || []).filter((label) => label?.id).map((label) => [label.id, label])).values()] : [];
      const categories = byLabel
        ? labels.length ? labels.map((label) => ({ ...label, id: `__label__:${label.id}`, label: true }))
          : [{ id: "__unlabeled__", name: haListManagerShoppingCardText("ui.without_label", {}, this._hass), icon: "mdi:label-off-outline", unlabeled: true }]
        : [this._categoryFor(item)];
      for (const category of categories) {
        if (!groups.has(category.id)) groups.set(category.id, { category, items: [] });
        groups.get(category.id).items.push(item);
      }
    }
    if (byLabel) return [...groups.values()].sort((a, b) => Number(Boolean(b.category.unlabeled)) - Number(Boolean(a.category.unlabeled)) || a.category.name.localeCompare(b.category.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true }) || a.category.id.localeCompare(b.category.id));
    return [...groups.values()].sort((a, b) => this._compareCategories(a.category, b.category));
  }

  _categoryScopeRank(category, order = "global_list_dynamic") {
    if (category?.uncategorized) return -1;
    const scope = category?.dynamic || category?.scope === "dynamic" || String(category?.id || "").startsWith("dynamic:") ? "dynamic" : category?.scope === "list" ? "list" : "global";
    const scopes = {
      global_list_dynamic: ["global", "list", "dynamic"],
      global_dynamic_list: ["global", "dynamic", "list"],
      list_global_dynamic: ["list", "global", "dynamic"],
      list_dynamic_global: ["list", "dynamic", "global"],
      dynamic_global_list: ["dynamic", "global", "list"],
      dynamic_list_global: ["dynamic", "list", "global"],
    }[order] || ["global", "list", "dynamic"];
    return scopes.indexOf(scope);
  }

  _compareCategories(a, b) {
    if (a?.uncategorized || b?.uncategorized) return a?.uncategorized ? (b?.uncategorized ? 0 : -1) : 1;
    const nameResult = a.name.localeCompare(b.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true });
    const tieScope = this._categoryScopeRank(a, "list_global_dynamic") - this._categoryScopeRank(b, "list_global_dynamic");
    if (this._config.category_sort === "alphabetical") return nameResult || tieScope;
    if (["global_list_dynamic", "global_dynamic_list", "list_global_dynamic", "list_dynamic_global", "dynamic_global_list", "dynamic_list_global"].includes(this._config.category_sort)) {
      return this._categoryScopeRank(a, this._config.category_sort) - this._categoryScopeRank(b, this._config.category_sort) || nameResult;
    }
    const aDynamic = this._categoryScopeRank(a) === 2;
    const bDynamic = this._categoryScopeRank(b) === 2;
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
    return (Number(a.manual_position ?? a.position) || 0) - (Number(b.manual_position ?? b.position) || 0) || tieScope || nameResult;
  }

  _displayName(item) {
    const product = this._products.find((entry) => entry.id === item.product_id);
    const generatedNames = product ? [
      this._formattedProductName(product, false, false), this._formattedProductName(product, true, false),
      this._formattedProductName(product, false, true), this._formattedProductName(product, true, true),
    ].map((name) => name.toLocaleLowerCase()) : [];
    const storedName = String(item.name || "");
    const baseName = product && generatedNames.includes(storedName.toLocaleLowerCase()) ? product.name : storedName;
    const parts = [baseName];
    const normalizedName = baseName.toLocaleLowerCase();
    if (this._config.show_brand && product?.brand && !normalizedName.includes(String(product.brand).toLocaleLowerCase())) parts.push(product.brand);
    if (this._config.show_quantity && product?.package_quantity && !normalizedName.includes(String(product.package_quantity).toLocaleLowerCase())) parts.push(product.package_quantity);
    const name = parts.filter(Boolean).join(" – ");
    const quantity = Math.max(1, Number(item.quantity || 1));
    if (this._config.quantity_position === "controls" || (quantity === 1 && !this._config.show_quantity_one)) return name;
    return this._config.quantity_position === "beginning" ? `${quantity}× ${name}` : `${name} (${quantity})`;
  }

  _displayNameWithoutQuantity(item) {
    const product = this._products.find((entry) => entry.id === item.product_id);
    const generatedNames = product ? [
      this._formattedProductName(product, false, false), this._formattedProductName(product, true, false),
      this._formattedProductName(product, false, true), this._formattedProductName(product, true, true),
    ].map((name) => name.toLocaleLowerCase()) : [];
    const storedName = String(item.name || "");
    const baseName = product && generatedNames.includes(storedName.toLocaleLowerCase()) ? product.name : storedName;
    const parts = [baseName];
    const normalizedName = baseName.toLocaleLowerCase();
    if (this._config.show_brand && product?.brand && !normalizedName.includes(String(product.brand).toLocaleLowerCase())) parts.push(product.brand);
    if (this._config.show_quantity && product?.package_quantity && !normalizedName.includes(String(product.package_quantity).toLocaleLowerCase())) parts.push(product.package_quantity);
    return parts.filter(Boolean).join(" – ");
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
        : reject(new Error(haListManagerShoppingCardText("ui.pdf_export_not_loaded", {}, this._hass)));
      script.onerror = () => reject(new Error(haListManagerShoppingCardText("errors.pdf_export_load_failed", {}, this._hass)));
      document.head.appendChild(script);
    }).catch((error) => {
      window.__shoppingListImprovedPdfExporterPromise = null;
      throw error;
    });
    return window.__shoppingListImprovedPdfExporterPromise;
  }

  _pdfSections() {
    const groups = new Map();
    for (const item of this._items) {
      const category = this._categoryFor(item);
      if (!groups.has(category.id)) groups.set(category.id, { category, items: [] });
      const quantity = Math.max(1, Number(item.quantity || 1));
      const name = this._displayNameWithoutQuantity(item) + (item.offer_only ? (" " + haListManagerShoppingCardText("ui.offer_only_suffix", {}, this._hass)) : "");
      const quantityLabel = quantity === 1 && !this._config.show_quantity_one ? "" : `${quantity}×`;
      groups.get(category.id).items.push({ name, text: name, quantityLabel, checked: Boolean(item.completed) });
    }
    return [...groups.values()]
      .sort((left, right) => this._compareCategories(left.category, right.category))
      .map(({ category, items }) => ({
        name: category.name || haListManagerShoppingCardText("ui.general", {}, this._hass),
        color: category.color || null,
        items: items.sort((left, right) => left.name.localeCompare(right.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true })),
      }));
  }

  async _exportPdf() {
    if (this._pdfExporting) return;
    this._pdfExporting = true;
    this._error = "";
    this._notificationStatus = "";
    this._render();
    try {
      const exporter = await this._loadPdfExporter();
      const title = this._config.title || this._list?.name || haListManagerShoppingCardText("ui.shopping_list", {}, this._hass);
      await exporter.exportPdf({ hass: this._hass,
        title,
        subtitle: haListManagerShoppingCardText("ui.open_total_items", {p0:(this._items.filter((item) => !item.completed).length), p1:(this._items.length)}, this._hass),
        fileName: haListManagerShoppingCardText("pdf.shopping_filename", { list: this._list?.name || this._listId() || haListManagerShoppingCardText("ui.list", {}, this._hass).toLocaleLowerCase() }, this._hass),
        sections: this._pdfSections(),
      });
      this._notificationStatus = haListManagerShoppingCardText("ui.pdf_created", {}, this._hass);
    } catch (error) {
      this._error = error?.message || haListManagerShoppingCardText("errors.pdf_creation_failed", {}, this._hass);
    } finally {
      this._pdfExporting = false;
      this._render();
    }
  }

  _labelScope(label) { return label.scope === "global" ? haListManagerShoppingCardText("ui.global", {}, this._hass) : label.scope === "list" ? haListManagerShoppingCardText("ui.this_list", {}, this._hass) : haListManagerShoppingCardText("ui.shopping_lists", {}, this._hass); }
  _categoryScope(category) {
    if (category.dynamic) return haListManagerShoppingCardText("categories.dynamic_in_list", {}, this._hass);
    if (category.scope === "global") return haListManagerShoppingCardText("ui.global", {}, this._hass);
    return category.scope === "list_type" ? haListManagerShoppingCardText("ui.shopping_lists", {}, this._hass) : haListManagerShoppingCardText("ui.this_list", {}, this._hass);
  }

  _notice(message, key, className, icon = "alert-circle-outline") {
    if (!message) return "";
    const close = haListManagerShoppingCardText("ui.dismiss_message", {}, this._hass);
    return `<div class="${className} dismissible-notice" data-notice="${key}" role="${key === "error" || className.includes("error") ? "alert" : "status"}"><ha-icon icon="mdi:${icon}"></ha-icon><span class="notice-text">${esc(message)}</span><button type="button" class="notice-dismiss" data-dismiss-message="${key}" aria-label="${esc(close)}" title="${esc(close)}"><ha-icon icon="mdi:close"></ha-icon></button></div>`;
  }

  _dismissNotice(key, button, keyboard = false) {
    const returnFocus = button?._noticeReturnFocus || (keyboard && this.shadowRoot.activeElement === button
      ? button.closest?.(".dialog")?.querySelector?.("input:not(:disabled),select:not(:disabled),textarea:not(:disabled)") || this.shadowRoot.querySelector("[data-product-input]")
      : null);
    if (key === "notification") this._notificationStatus = "";
    else if (key === "error") this._error = "";
    else if (key === "item-action") { if (this._itemAction) this._itemAction.error = ""; }
    else if (key === "dish") { if (this._dishDialog) this._dishDialog.status = ""; }
    else if (key === "tandoor") { if (this._tandoorDialog) this._tandoorDialog.status = ""; }
    else if (key === "browser-chip") { if (this._browserChipMenu) this._browserChipMenu.status = ""; }
    else if (this._dialog) {
      const field = { dialog: "status", ean: "eanStatus", quick: "quick_action_status" }[key];
      if (field) this._dialog[field] = "";
    }
    // Remove only this banner: keep input nodes, picker queries and scroll anchors mounted.
    const notice = button?.closest?.("[data-notice]");
    if (notice) { this._clearRenderListeners(notice); notice.remove(); }
    returnFocus?.focus?.({ preventScroll: true });
  }

  _bindNotices(root = this.shadowRoot) {
    root.querySelectorAll("[data-dismiss-message]").forEach((button) => {
      this._listen(button, "pointerdown", () => {
        const active = this.shadowRoot.activeElement;
        button._noticeReturnFocus = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) ? active : null;
      });
      this._listen(button, "click", (event) => {
        event.preventDefault(); event.stopPropagation();
        this._dismissNotice(button.dataset.dismissMessage, button, event.detail === 0);
      });
    });
  }

  _selectionHeading(text) { return `<span class="selection-field-heading">${text}</span>`; }

  _selectionButton(kind, disabled = false, context = "", itemId = "") {
    const label = haListManagerShoppingCardText(`selection.choose_${kind}`, {}, this._hass);
    return `<button type="button" class="selection-open" data-open-selection="${kind}"${context ? ` data-selection-context="${context}" data-selection-item="${esc(itemId)}"` : ""} aria-label="${esc(label)}" title="${esc(label)}" ${disabled || this._busy ? "disabled" : ""}><ha-icon icon="mdi:view-grid-outline"></ha-icon></button>`;
  }

  _selectionIsCurrent(popup = this._selectionPopup) {
    if (!popup) return false;
    if (!popup.context) return this._dialog === popup.parent;
    const owner = popup.context === "dish" ? this._dishDialog : this._tandoorDialog;
    const choices = popup.context === "dish" ? owner?.categories : owner?.ingredientCategories;
    return owner === popup.owner && choices?.[popup.itemId] === popup.parent && !popup.parent.locked
      && [...(owner.selected || [])].some((id) => String(id) === popup.itemId);
  }

  _selectionOptions(popup = this._selectionPopup) {
    if (!this._selectionIsCurrent(popup)) return [];
    if (popup.kind === "labels") this._labels.forEach((entry) => {
      popup.labelNames[entry.id] = entry.name.toLocaleLowerCase();
      popup.labelDefinitions[entry.id] = entry;
    });
    const values = popup.kind === "labels" ? this._labels : [
      { id: "", name: haListManagerShoppingCardText("ui.general", {}, this._hass), icon: "mdi:shape-outline", general: true },
      ...this._availableCategories().filter((entry) => popup.parent.mode !== "product-transfer" || !entry.dynamic),
    ];
    const query = popup.query.trim().toLocaleLowerCase(haListManagerShoppingCardTextLocale(this._hass));
    return values.filter((entry) => !query || entry.name.toLocaleLowerCase(haListManagerShoppingCardTextLocale(this._hass)).includes(query));
  }

  _selectionLabelPermitted(id, popup = this._selectionPopup) {
    const label = popup?.labelDefinitions[id];
    if (!label) return false;
    if (label.scope === "global") return this._list?.use_global_labels !== false;
    if (label.scope === "list_type") return this._list?.use_type_labels !== false;
    return label.scope === "list" && (!label.list_id || label.list_id === this._listId());
  }

  _renderSelectionOptions() {
    const popup = this._selectionPopup;
    if (!popup) return "";
    const options = this._selectionOptions(popup);
    return options.length ? options.map((entry) => {
      const selected = popup.kind === "labels" ? popup.selected.some((id) => this._selectionLabelPermitted(id, popup) && popup.labelNames[id] === entry.name.toLocaleLowerCase())
        : entry.general ? !popup.parent.category_id && !popup.parent.category_name : entry.id === popup.parent.category_id || entry.name === popup.parent.category_name;
      const scope = entry.general ? haListManagerShoppingCardText("ui.no_category", {}, this._hass)
        : popup.kind === "labels" ? this._labelScope(entry) : this._categoryScope(entry);
      return `<button type="button" class="selection-chip ${selected ? "selected" : ""}" data-selection-option="${esc(entry.id)}" aria-pressed="${selected}" style="${entry.color ? `--selection-color:${esc(entry.color)};--selection-ink:${categoryTextColor(entry.color)}` : ""}"><ha-icon icon="${esc(entry.icon || "mdi:tag-outline")}"></ha-icon><span><strong>${esc(entry.name)}</strong><small>${esc(scope)}</small></span>${selected ? '<ha-icon class="selection-check" icon="mdi:check"></ha-icon>' : ""}</button>`;
    }).join("") : `<p class="field-help">${haListManagerShoppingCardText("selection.empty", {}, this._hass)}</p>`;
  }

  _renderSelectionPopup() {
    const popup = this._selectionPopup;
    if (!this._selectionIsCurrent(popup)) { this._selectionPopup = null; return ""; }
    const title = haListManagerShoppingCardText(`selection.${popup.kind}`, {}, this._hass);
    return `<div class="backdrop selection-backdrop" data-selection-backdrop data-selection-popup-host><section class="dialog selection-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-selection-dialog><header><h2>${title}</h2><button type="button" class="icon-button" data-selection-close aria-label="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header><label class="selection-search"><span>${haListManagerShoppingCardText("selection.search", {}, this._hass)}</span><input type="search" data-selection-search value="${esc(popup.query)}" autocomplete="off"></label><div class="selection-grid" data-selection-grid>${this._renderSelectionOptions()}</div><footer>${popup.kind === "labels" ? `<button type="button" class="primary" data-selection-apply>${haListManagerShoppingCardText("selection.apply", {}, this._hass)}</button><button type="button" data-clear-selection>${haListManagerShoppingCardText("selection.clear", {}, this._hass)}</button>` : ""}<button type="button" data-selection-close>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }

  _openSelectionPopup(kind, trigger = null) {
    const context = trigger?.dataset.selectionContext || "";
    const itemId = trigger?.dataset.selectionItem || "";
    const owner = context === "dish" ? this._dishDialog : context === "tandoor" ? this._tandoorDialog : null;
    const parent = context === "dish" ? owner?.categories?.[itemId] : context === "tandoor" ? owner?.ingredientCategories?.[itemId] : this._dialog;
    const panelSelector = context === "dish" ? "[data-dish-dialog]" : context === "tandoor" ? ".tandoor-recipe-dialog" : "[data-dialog]";
    if (!parent || this._busy || this._itemAction || this._selectionPopup || trigger?.disabled || !["categories", "labels"].includes(kind) || (context && kind !== "categories") || (kind === "labels" && !this._labels.length)) return;
    const popup = { kind, parent, context, owner, itemId, trigger, panelSelector, selected: [...(parent.label_ids || [])], labelNames: Object.fromEntries(this._labels.map((entry) => [entry.id, entry.name.toLocaleLowerCase()])), labelDefinitions: Object.fromEntries(this._labels.map((entry) => [entry.id, entry])), query: "", scroll: this.shadowRoot.querySelector(panelSelector)?.scrollTop || 0 };
    if (!this._selectionIsCurrent(popup)) return;
    this.shadowRoot.activeElement?.blur?.();
    this.shadowRoot.querySelectorAll(".category-picker-options,.category-options,.label-picker-options,.label-options,.chip-template-options").forEach((menu) => { menu.hidden = true; });
    this.shadowRoot.querySelectorAll("[data-picker-list-trigger]").forEach((button) => { button.classList.remove("active"); button.setAttribute("aria-expanded", "false"); });
    this.shadowRoot.querySelectorAll("[data-d-category],[data-label-input],[data-dish-category-search],[data-tandoor-category-search]").forEach((input) => input.setAttribute("aria-expanded", "false"));
    this._selectionPopup = popup;
    this.shadowRoot.querySelector("ha-card")?.insertAdjacentHTML("beforeend", this._renderSelectionPopup());
    this._bindSelectionPopup();
    // Keep the on-screen keyboard closed until the user chooses to search.
    this.shadowRoot.querySelector("[data-selection-dialog] [data-selection-close]")?.focus({ preventScroll: true });
  }

  _closeSelectionPopup(apply = false) {
    const popup = this._selectionPopup;
    if (!popup) return;
    const current = this._selectionIsCurrent(popup);
    if (apply && current && popup.kind === "labels") {
      const selectedNames = new Set(popup.selected.filter((id) => this._selectionLabelPermitted(id, popup)).map((id) => popup.labelNames[id]));
      const availableNames = new Set(this._labels.map((entry) => entry.name.toLocaleLowerCase()));
      // Scope updates can replace an effective definition while this popup is open.
      // Keep unavailable assignments and resolve visible selections by name.
      const hiddenIds = (popup.parent.label_ids || []).filter((id) => !this._selectionLabelPermitted(id, popup) || !availableNames.has(popup.labelNames[id]));
      popup.parent.label_ids = [...new Set([...hiddenIds, ...this._labels.filter((entry) => selectedNames.has(entry.name.toLocaleLowerCase())).map((entry) => entry.id)])];
    }
    this._selectionPopup = null;
    const backdrop = this.shadowRoot.querySelector("[data-selection-backdrop]");
    if (backdrop) { this._clearRenderListeners(backdrop); backdrop.remove(); }
    if (apply && current && !popup.context) this._refreshMetadataUi();
    if (current) {
      const panel = this.shadowRoot.querySelector(popup.panelSelector || "[data-dialog]");
      if (panel) panel.scrollTop = popup.scroll;
      const trigger = popup.trigger?.isConnected ? popup.trigger : popup.context
        ? [...this.shadowRoot.querySelectorAll("[data-open-selection]")].find((button) => button.dataset.selectionContext === popup.context && button.dataset.selectionItem === popup.itemId)
        : this.shadowRoot.querySelector(`[data-open-selection="${popup.kind}"]${popup.trigger?.dataset?.editShortcut ? "[data-edit-shortcut]" : ":not([data-edit-shortcut])"}`);
      trigger?.focus({ preventScroll: true });
    }
  }

  _chooseSelectionOption(id, button = null) {
    const popup = this._selectionPopup;
    if (!this._selectionIsCurrent(popup) || this._busy) return;
    if (popup.kind === "labels") {
      const entry = this._labels.find((entry) => entry.id === id);
      if (!entry) return;
      const name = entry.name.toLocaleLowerCase();
      popup.labelNames[id] = name;
      popup.labelDefinitions[id] = entry;
      const selected = !popup.selected.some((selectedId) => this._selectionLabelPermitted(selectedId, popup) && popup.labelNames[selectedId] === name);
      popup.selected = popup.selected.filter((selectedId) => !this._selectionLabelPermitted(selectedId, popup) || popup.labelNames[selectedId] !== name);
      if (selected) popup.selected.push(id);
      button?.setAttribute?.("aria-pressed", String(selected));
      button?.classList?.toggle("selected", selected);
      this._refreshSelectionGrid(id);
      return;
    }
    const category = this._selectionOptions({ ...popup, query: "" }).find((entry) => entry.id === id);
    if (!category) return;
    popup.parent.category_id = category.id || null;
    popup.parent.category_name = category.general ? "" : category.name;
    const input = popup.context
      ? [...this.shadowRoot.querySelectorAll(popup.context === "dish" ? "[data-dish-category-search]" : "[data-tandoor-category-search]")].find((field) => (popup.context === "dish" ? field.dataset.dishCategorySearch : field.dataset.tandoorCategorySearch) === popup.itemId)
      : this.shadowRoot.querySelector("[data-d-category]");
    if (popup.context) {
      popup.parent.dynamic = Boolean(category.dynamic || String(category.id || "").startsWith("dynamic:"));
      popup.parent.general = Boolean(category.general);
      popup.parent.source = "manual";
      input?.closest(".dish-category-combo")?.classList.remove("unresolved");
    }
    if (input) input.value = popup.parent.category_name;
    this._closeSelectionPopup(true);
  }

  _refreshSelectionGrid(focusId = null) {
    const grid = this.shadowRoot.querySelector("[data-selection-grid]");
    if (!grid) return;
    const scrollTop = grid.scrollTop;
    this._clearRenderListeners(grid);
    grid.innerHTML = this._renderSelectionOptions();
    this._bindSelectionOptions();
    grid.scrollTop = scrollTop;
    if (focusId !== null) [...grid.querySelectorAll("[data-selection-option]")].find((button) => button.dataset.selectionOption === focusId)?.focus({ preventScroll: true });
  }

  _bindSelectionOptions() {
    this.shadowRoot.querySelectorAll("[data-selection-option]").forEach((button) => this._listen(button, "click", () => this._chooseSelectionOption(button.dataset.selectionOption, button)));
  }

  _bindSelectionTriggers(root = this.shadowRoot) {
    root.querySelectorAll("[data-open-selection]").forEach((button) => {
      if (button.dataset.selectionBound) return;
      button.dataset.selectionBound = "1";
      this._listen(button, "pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
      this._listen(button, "click", (event) => { event.preventDefault(); event.stopPropagation(); if (!button.disabled) this._openSelectionPopup(button.dataset.openSelection, button); });
    });
  }

  _bindSelectionPopup() {
    const root = this.shadowRoot;
    this._listen(root.querySelector("[data-selection-backdrop]"), "click", (event) => { if (event.target === event.currentTarget) this._closeSelectionPopup(); });
    this._listen(root.querySelector("[data-selection-dialog]"), "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this._closeSelectionPopup(); }
      if (event.key === "Tab") {
        const focusable = [...root.querySelectorAll("[data-selection-dialog] button,[data-selection-dialog] input")].filter((element) => !element.disabled);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
        else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
      }
    });
    root.querySelectorAll("[data-selection-close]").forEach((button) => this._listen(button, "click", () => this._closeSelectionPopup()));
    this._listen(root.querySelector("[data-selection-search]"), "input", (event) => { if (this._selectionPopup) { this._selectionPopup.query = event.target.value; this._refreshSelectionGrid(); } });
    this._listen(root.querySelector("[data-clear-selection]"), "click", () => { if (this._selectionPopup) { this._selectionPopup.selected = []; this._refreshSelectionGrid(); } });
    this._listen(root.querySelector("[data-selection-apply]"), "click", () => this._closeSelectionPopup(true));
    this._bindSelectionOptions();
  }

  _renderLabels(labels) {
    return (labels || []).map((label) => `<span class="label" style="${label.color ? `--label-color:${esc(label.color)}` : ""}"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon>${esc(label.name)}</span>`).join("");
  }

  _renderSelectedLabels(selectedIds = []) {
    const selected = this._labels.filter((label) => selectedIds.includes(label.id));
    return selected.map((label) => `<button type="button" class="selected-label" data-remove-label="${esc(label.id)}" style="${label.color ? `--label-color:${esc(label.color)}` : ""}" title="${haListManagerShoppingCardText("ui.remove_named", {p0:(esc(label.name))}, this._hass)}"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon><span>${esc(label.name)}</span><ha-icon class="remove-label" icon="mdi:close"></ha-icon></button>`).join("");
  }

  _renderLabelSelector(selectedIds = []) {
    const chips = this._renderSelectedLabels(selectedIds);
    const content = `<div class="label-selector">${this._selectionHeading(haListManagerShoppingCardText("ui.labels_optional", {}, this._hass))}<div class="selected-labels" data-selected-labels ${chips ? "" : "hidden"}>${chips}</div><div class="label-combo"><div class="label-search picker-popup-host"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" placeholder="${haListManagerShoppingCardText("ui.browse_labels", {}, this._hass)}" autocomplete="off" data-label-input ${this._labels.length ? "" : "disabled"}>${this._selectionButton("labels", !this._labels.length)}</div><div class="label-picker-options" data-label-options hidden></div></div><p class="field-help">${haListManagerShoppingCardText(this._labels.length ? "help.label_scope_priority" : "labels.none_created", {}, this._hass)}</p></div>${this._renderProductLabelPreference(false)}`;
    return globalThis.HaListManagerDialogSections.render(this, { kind: "labels", context: this._editorSectionContext(),
      title: haListManagerShoppingCardText("ui.labels", {}, this._hass), summary: this._editorSectionSummary("labels"), content,
      notice: `<div data-editor-notice="labels">${this._renderProductLabelNotice()}</div>` });
  }

  _editorSectionContext() { return this._dialog?.mode === "product-transfer" ? "product" : "item"; }

  _editorSectionSummary(kind) {
    const draft = this._dialog;
    if (kind === "category") return String(draft?.category_name || "").trim() || haListManagerShoppingCardText("ui.general", {}, this._hass);
    const selected = new Set(draft?.label_ids || []);
    return String(this._labels.filter((label) => selected.has(label.id)).length);
  }

  _renderCategoryEditorSection(productMode = false) {
    return globalThis.HaListManagerDialogSections.render(this, { kind: "category", context: this._editorSectionContext(),
      title: haListManagerShoppingCardText("ui.category", {}, this._hass), summary: this._editorSectionSummary("category"),
      content: `<div class="dialog-field">${this._selectionHeading(haListManagerShoppingCardText("ui.category", {}, this._hass))}${this._renderCategorySelector(productMode, true)}</div>`,
      notice: `<div data-editor-notice="category">${this._renderCategoryEditorNotice()}</div>` });
  }

  _renderCategoryEditorNotice() {
    const draft = this._dialog;
    if (draft?.mode === "product-transfer") {
      const status = this._productCategoryInputStatus(draft.category_name, draft.category_id);
      return `<p class="field-help product-category-input-status" data-product-category-input-status ${status ? "" : "hidden"}>${esc(status)}</p>`;
    }
    const state = this._categoryPreferenceState();
    return draft?.remember_product_category && state.enabled
      ? `<p class="field-help">${haListManagerShoppingCardText("shopping.product_category_to_save", {category:esc(state.category.name)}, this._hass)}</p>` : "";
  }

  _refreshEditorNotices() {
    this.shadowRoot.querySelectorAll("[data-editor-notice]").forEach((host) => {
      const content = host.dataset.editorNotice === "labels" ? this._renderProductLabelNotice() : this._renderCategoryEditorNotice();
      if (host._haLmNoticeMarkup !== content) {
        this._clearRenderListeners(host);
        host.innerHTML = content;
        host._haLmNoticeMarkup = content;
      }
    });
  }

  _productLabelPreferenceState(draft = this._dialog) {
    const productId = draft?.product?.id || draft?.item?.product_id;
    const product = this._products.find((entry) => entry.id === productId) || draft?.product;
    const visible = ["create", "edit"].includes(draft?.mode)
      && this._list?.list_type === "shopping" && this._list?.provider !== "bring";
    const enabled = visible && Boolean(productId && product);
    if (!enabled) return { visible, enabled: false, added: [], removed: [] };
    // Only definitions offered by this list can be changed here. Hidden
    // scopes and priority-shadowed product assignments remain untouched.
    const original = new Set((product.labels || []).map((label) => label.id));
    const selected = new Set(draft.label_ids || []);
    return {
      visible: true, enabled: true,
      added: this._labels.filter((label) => selected.has(label.id) && !original.has(label.id)),
      removed: this._labels.filter((label) => original.has(label.id) && !selected.has(label.id)),
    };
  }

  _renderProductLabelChanges() {
    const state = this._productLabelPreferenceState();
    if (!state.enabled) return "";
    const checked = this._dialog.remember_product_labels === true;
    const names = (labels) => labels.map((label) => `${label.name} (${this._labelScope(label)})`).join(", ");
    const preview = checked ? `${state.added.length ? `<p class="product-label-added">${haListManagerShoppingCardText("shopping.product_labels_added", {labels:esc(names(state.added))}, this._hass)}</p>` : ""}${state.removed.length ? `<p class="product-label-removed">${haListManagerShoppingCardText("shopping.product_labels_removed", {labels:esc(names(state.removed))}, this._hass)}</p>` : ""}${!state.added.length && !state.removed.length ? `<p class="field-help">${haListManagerShoppingCardText("shopping.product_labels_unchanged", {}, this._hass)}</p>` : ""}` : "";
    return `<div class="product-label-preview" data-product-label-preview role="status" aria-live="polite">${preview}</div>`;
  }

  _renderProductLabelNotice() {
    const state = this._productLabelPreferenceState();
    if (!state.enabled) return "";
    return `<p class="field-help product-label-scope-warning">${haListManagerShoppingCardText("shopping.product_labels_help", {}, this._hass)}</p>${this._dialog.remember_product_labels ? this._renderProductLabelChanges() : ""}`;
  }

  _cameraCreatesProduct(draft = this._dialog) {
    return Boolean(draft?.camera_capture && draft.product?._new && !draft.product.id);
  }

  _renderProductLabelPreferenceContent(includeNotice = true) {
    const state = this._productLabelPreferenceState();
    if (!state.visible) return "";
    if (this._cameraCreatesProduct()) return `<p class="field-help">${haListManagerShoppingCardText("scan.new_product_labels", {}, this._hass)}</p>`;
    const checked = state.enabled && this._dialog.remember_product_labels === true;
    const help = !state.enabled
      ? `<p class="field-help">${haListManagerShoppingCardText("shopping.product_labels_need_product", {}, this._hass)}</p>`
      : includeNotice ? this._renderProductLabelNotice() : "";
    return `<label class="offer-only-choice"><input type="checkbox" data-remember-product-labels ${checked ? "checked" : ""} ${state.enabled ? "" : "disabled"}><span>${haListManagerShoppingCardText("shopping.remember_product_labels", {}, this._hass)}</span></label>${help}`;
  }

  _renderProductLabelPreference(includeNotice = true) {
    return this._productLabelPreferenceState().visible
      ? `<div data-product-label-preference data-label-notice-external="${!includeNotice}">${this._renderProductLabelPreferenceContent(includeNotice)}</div>` : "";
  }

  _updateProductLabelPreference() {
    const host = this.shadowRoot.querySelector("[data-product-label-preference]");
    if (!host) return;
    if (!this._productLabelPreferenceState().enabled) this._dialog.remember_product_labels = false;
    const returnFocus = this.shadowRoot.activeElement === host.querySelector("[data-remember-product-labels]");
    this._clearRenderListeners(host);
    host.innerHTML = this._renderProductLabelPreferenceContent(host.dataset.labelNoticeExternal !== "true");
    const checkbox = host.querySelector("[data-remember-product-labels]");
    this._listen(checkbox, "change", (event) => {
      this._dialog.remember_product_labels = event.target.checked && this._productLabelPreferenceState().enabled;
      this._updateProductLabelPreference();
      this._updateDialogDirtyState();
    });
    if (returnFocus) checkbox?.focus({ preventScroll: true });
    this._refreshEditorNotices();
  }

  _renderCategorySelector(productMode = false, externalNotice = false) {
    const draft = this._dialog;
    const placeholder = productMode ? haListManagerShoppingCardText("ui.search_saved_category", {}, this._hass) : haListManagerShoppingCardText("ui.category_search_or_create", {}, this._hass);
    const help = productMode
      ? haListManagerShoppingCardText("help.product_category_scope", {}, this._hass)
      : haListManagerShoppingCardText("help.choose_saved_dynamic_category", {}, this._hass);
    const categoryStatus = productMode ? this._productCategoryInputStatus(draft.category_name, draft.category_id) : "";
    return `<div class="category-combo picker-popup-host"><input value="${esc(draft.category_name)}" placeholder="${placeholder}" autocomplete="off" data-d-category data-product-category="${productMode ? "1" : "0"}">${this._selectionButton("categories")}<div class="category-picker-options" data-category-options hidden></div></div>${productMode && !externalNotice ? `<p class="field-help product-category-input-status" data-product-category-input-status ${categoryStatus ? "" : "hidden"}>${esc(categoryStatus)}</p>` : ""}<p class="field-help">${help}</p>${productMode ? "" : this._renderCategoryPreference()}`;
  }

  _categoryPreferenceState(draft = this._dialog) {
    const visible = ["create", "edit"].includes(draft?.mode)
      && this._list?.list_type === "shopping" && this._list?.provider !== "bring";
    const hasProduct = Boolean(draft?.product?.id || draft?.product?._new || draft?.item?.product_id);
    const name = String(draft?.category_name || "").trim();
    const category = visible ? this._availableCategories().find((entry) => draft.category_id
      ? entry.id === draft.category_id : entry.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0) : null;
    return { visible, hasProduct, category, enabled: Boolean(visible && hasProduct && category?.id && !category.dynamic && !category.uncategorized
      && !String(category.id).startsWith("dynamic:")) };
  }

  _categoryPreferenceHelpKey(state) {
    if (!state.hasProduct) return "shopping.product_category_needs_product";
    if (state.enabled && this._cameraCreatesProduct()) return "scan.new_product_category";
    return state.enabled ? "shopping.remember_product_category_help" : "shopping.remember_product_category_needs_saved";
  }

  _renderCategoryPreference() {
    const state = this._categoryPreferenceState();
    if (!state.visible) return "";
    return `<div data-category-preference><label class="offer-only-choice"><input type="checkbox" data-remember-product-category ${state.enabled && this._dialog.remember_product_category ? "checked" : ""} ${state.enabled ? "" : "disabled"}><span>${haListManagerShoppingCardText("shopping.remember_product_category", {}, this._hass)}</span></label><p class="field-help" data-category-preference-help>${haListManagerShoppingCardText(this._categoryPreferenceHelpKey(state), {}, this._hass)}</p></div>`;
  }

  _updateCategoryPreference() {
    const state = this._categoryPreferenceState();
    const checkbox = this.shadowRoot.querySelector("[data-remember-product-category]");
    if (!checkbox) return;
    if (!state.enabled && !this._dialog.camera_capture) this._dialog.remember_product_category = false;
    checkbox.disabled = !state.enabled;
    checkbox.checked = state.enabled && this._dialog.remember_product_category === true;
    const help = this.shadowRoot.querySelector("[data-category-preference-help]");
    if (help) help.textContent = haListManagerShoppingCardText(this._categoryPreferenceHelpKey(state), {}, this._hass);
  }

  _productCategoryInputStatus(value, selectedId = null) {
    const name = String(value || "").trim();
    const categories = this._availableCategories();
    const selected = selectedId ? categories.find((category) => category.id === selectedId) : null;
    if (selected?.dynamic) return haListManagerShoppingCardText("help.dynamic_category_not_default", {}, this._hass);
    if (!name || selected) return "";
    if (categories.some((category) => !category.dynamic && category.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) return "";
    return categories.some((category) => category.dynamic && category.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)
      ? haListManagerShoppingCardText("help.dynamic_category_not_default", {}, this._hass)
      : haListManagerShoppingCardText("ui.no_saved_category_selected", {}, this._hass);
  }

  _productCategoryMoveState(draft = this._dialog) {
    if (draft?.mode !== "product-transfer") return null;
    const categories = this._availableCategories();
    const categoryName = String(draft.category_name || "").trim();
    const target = draft.category_id
      ? categories.find((category) => category.id === draft.category_id && !category.dynamic)
      : categories.find((category) => !category.dynamic && category.name.localeCompare(categoryName, undefined, { sensitivity: "base" }) === 0);
    if (categoryName && !target) return null;
    const current = draft.parent?.category_id
      ? categories.find((category) => category.id === draft.parent.category_id)
      : null;
    const currentName = String(current?.name || draft.parent?.category_name || "").trim() || haListManagerShoppingCardText("ui.general", {}, this._hass);
    const targetName = target?.name || haListManagerShoppingCardText("ui.general", {}, this._hass);
    if (currentName.localeCompare(targetName, undefined, { sensitivity: "base" }) === 0) return null;
    return { currentName, targetName };
  }

  _renderProductCategoryMove() {
    const state = this._productCategoryMoveState();
    if (!state) return "";
    return `<section class="product-category-move"><div><ha-icon icon="mdi:folder-move-outline"></ha-icon><span><strong>${haListManagerShoppingCardText("categories.confirm_change_item", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("shopping.product_default_comparison", {p0:(esc(state.currentName)), p1:(esc(state.targetName))}, this._hass)}</small></span></div><label><input type="checkbox" data-move-product-category ${this._dialog.move_item_category ? "checked" : ""}><span>${haListManagerShoppingCardText("shopping.move_this_item_category", {p0:(esc(state.targetName)), p1:(esc(state.currentName))}, this._hass)}</span></label></section>`;
  }

  _bringPreviewValue(quantity, description) {
    const count = Math.max(1, Number.parseInt(quantity, 10) || 1);
    const details = String(description || "").trim();
    if (details) return count === 1 ? details : `${count} x ${details}`;
    return count === 1 ? "" : String(count);
  }

  _updateBringPreview() {
    const name = this.shadowRoot?.querySelector("[data-bring-preview-name]");
    const value = this.shadowRoot?.querySelector("[data-bring-preview-value]");
    if (!name || !value || !this._dialog) return;
    name.textContent = this._dialog.name.trim() || haListManagerShoppingCardText("ui.item_name", {}, this._hass);
    const preview = this._bringPreviewValue(
      this._dialog.quantity,
      this._dialog.product?.package_quantity || this._dialog.description,
    );
    value.textContent = preview;
    value.hidden = !preview;
  }

  _formatMeasurement(measurement) {
    if (!measurement) return "";
    let value = Number(measurement.value);
    let unit = measurement.dimension === "weight" ? "g" : measurement.dimension === "volume" ? "ml" : haListManagerShoppingCardText("ui.pieces", {}, this._hass);
    if (measurement.dimension === "weight" && value >= 1000) { value /= 1000; unit = "kg"; }
    if (measurement.dimension === "volume" && value >= 1000) { value /= 1000; unit = "l"; }
    const formatted = value.toLocaleString(haListManagerShoppingCardTextLocale(this._hass), { maximumFractionDigits: 3 });
    return `${formatted} ${unit}`;
  }

  _amountDetails(value, quantity, label = haListManagerShoppingCardText("ui.amount", {}, this._hass)) {
    const amount = this._parsePackageMeasurement(value);
    if (!amount) return { summary: "", warning: "" };
    const count = Math.max(1, Number.parseInt(quantity, 10) || 1);
    const total = { ...amount, value: amount.value * count };
    return {
      summary: haListManagerShoppingCardText("recipes.ingredient_total_details", {p0:(label), p1:(value), p2:(count), p3:(this._formatMeasurement(total))}, this._hass),
      warning: "",
    };
  }

  _updateProductAmountDetails() {
    if (!this._dialog) return;
    const value = this._dialog.product?.package_quantity || this._dialog.description;
    const details = this._amountDetails(value, this._dialog.quantity, this._dialog.product ? haListManagerShoppingCardText("ui.package_quantity", {}, this._hass) : haListManagerShoppingCardText("ui.amount", {}, this._hass));
    const summary = this.shadowRoot?.querySelector("[data-product-amount-summary]");
    const warning = this.shadowRoot?.querySelector("[data-product-amount-warning]");
    const help = this.shadowRoot?.querySelector("[data-free-amount-help]");
    if (summary) { summary.textContent = details.summary; summary.hidden = !details.summary; }
    if (help) help.hidden = Boolean(details.summary);
    if (warning) { warning.textContent = details.warning; warning.hidden = !details.warning; }
  }

  _itemActionCategory(draft = this._dialog) {
    if (!draft) return null;
    return this._availableCategories().find((category) => category.id === draft.category_id && !category.dynamic) || null;
  }

  _renderItemActionsMenu() {
    const draft = this._dialog;
    if (!draft?.item || draft.mode !== "edit" || this._list?.list_type === "bring") return "";
    const nameValid = Boolean(draft.name?.trim());
    const category = this._itemActionCategory(draft);
    const ruleEnabled = nameValid && Boolean(category);
    return `<div class="item-actions"><button type="button" class="icon-button" data-toggle-item-actions aria-haspopup="menu" aria-expanded="${Boolean(draft.item_actions_open)}" aria-label="${haListManagerShoppingCardText("quick_actions.menu", {}, this._hass)}" title="${haListManagerShoppingCardText("quick_actions.menu", {}, this._hass)}"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>${draft.item_actions_open ? `<div class="item-actions-menu" role="menu" aria-label="${haListManagerShoppingCardText("quick_actions.menu", {}, this._hass)}"><button type="button" role="menuitem" data-item-action="send"><ha-icon icon="mdi:receipt-text-send-outline"></ha-icon><span>${haListManagerShoppingCardText("quick_actions.send", {}, this._hass)}</span></button><button type="button" role="menuitem" data-item-action="chip" ${nameValid ? "" : "disabled"}><ha-icon icon="mdi:tag-plus-outline"></ha-icon><span>${haListManagerShoppingCardText("quick_actions.chip", {}, this._hass)}</span></button>${this._hass?.user?.is_admin ? `<button type="button" role="menuitem" data-item-action="rule" ${ruleEnabled ? "" : "disabled"}><ha-icon icon="mdi:format-list-checks"></ha-icon><span>${haListManagerShoppingCardText("quick_actions.rule", {}, this._hass)}</span></button>${!category ? `<small>${haListManagerShoppingCardText("quick_actions.rule_unavailable", {}, this._hass)}</small>` : ""}` : ""}</div>` : ""}</div>`;
  }

  _renderEditShortcuts() {
    const draft = this._dialog;
    const localActions = this._list?.list_type !== "bring";
    if (!draft?.item || draft.mode !== "edit" || this._config.show_edit_shortcuts === false) return "";
    const nameValid = Boolean(draft.name?.trim());
    const button = (kind, icon, label, disabled = false, selection = false) => `<button type="button" class="edit-shortcut" data-edit-shortcut="${kind}" ${selection ? `data-open-selection="${kind}"` : `data-item-shortcut="${kind}"`} title="${esc(label)}" aria-label="${esc(label)}" ${this._busy || disabled ? "disabled" : ""}><ha-icon icon="${icon}" aria-hidden="true"></ha-icon></button>`;
    return `<div class="edit-shortcuts" role="group" aria-label="${haListManagerShoppingCardText("quick_actions.shortcuts", {}, this._hass)}">${button("categories", "mdi:shape-outline", haListManagerShoppingCardText("quick_actions.change_category", {}, this._hass), false, true)}${button("labels", "mdi:label-multiple-outline", haListManagerShoppingCardText("quick_actions.change_labels", {}, this._hass), !this._labels.length, true)}${localActions ? `${button("send", "mdi:receipt-text-send-outline", haListManagerShoppingCardText("quick_actions.send", {}, this._hass))}${button("chip", "mdi:tag-plus-outline", haListManagerShoppingCardText("quick_actions.chip", {}, this._hass), !nameValid)}${this._hass?.user?.is_admin ? button("rule", "mdi:format-list-checks", haListManagerShoppingCardText("quick_actions.rule", {}, this._hass), !nameValid || !this._itemActionCategory(draft)) : ""}` : ""}</div>`;
  }

  _toggleItemActions() {
    if (this._dialog?.mode !== "edit" || !this._dialog.item || this._busy || this._list?.list_type === "bring") return;
    this._dialog.item_actions_open = !this._dialog.item_actions_open;
    this._refreshMetadataUi();
    const target = this._dialog.item_actions_open ? "[data-item-action]:not(:disabled)" : "[data-toggle-item-actions]";
    this.shadowRoot.querySelector(target)?.focus({ preventScroll: true });
  }

  _itemActionTargetStorageKey(listId = this._listId()) {
    const userId = this._hass?.user?.id;
    return userId && listId ? `ha-list-manager:item-action-target:${encodeURIComponent(userId)}:${encodeURIComponent(listId)}` : null;
  }

  _rememberItemActionTarget(targetId, storageKey) {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, targetId); }
    catch (_error) { /* Sending remains available when browser storage is disabled. */ }
  }

  async _openItemAction(kind, trigger = null) {
    const parent = this._dialog;
    if (!parent?.item || parent.mode !== "edit" || this._busy || this._list?.list_type === "bring" || !["send", "chip", "rule"].includes(kind)) return;
    const name = String(parent.name || "").trim();
    const category = this._itemActionCategory(parent);
    if ((kind !== "send" && !name) || (kind === "rule" && (!category || !this._hass?.user?.is_admin))) return;
    const action = { kind, parent, list_id: this._listId(), name, category,
      list_name: this._list?.name || "", quantity: "1", target_list_id: "", lists: [], target_storage_key: this._itemActionTargetStorageKey(),
      loading: kind === "send", busy: false, error: "",
      parent_scroll: this.shadowRoot.querySelector("[data-dialog]")?.scrollTop || 0,
      return_selector: trigger?.dataset?.itemShortcut ? `[data-item-shortcut="${kind}"]` : "[data-toggle-item-actions]",
    };
    parent.item_actions_open = false;
    this._itemAction = action;
    this._refreshMetadataUi();
    this.shadowRoot.querySelector("[data-cancel-item-action]")?.focus({ preventScroll: true });
    if (kind !== "send") return;
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/lists/list` });
      if (this._itemAction !== action || this._dialog !== parent) return;
      action.lists = (result.lists || []).filter((list) => list.id !== action.list_id && list.enabled !== false && list.list_type === "shopping" && list.provider !== "bring");
      action.target_list_id = action.lists.length === 1 ? action.lists[0].id : "";
      try {
        const remembered = action.target_storage_key ? localStorage.getItem(action.target_storage_key) : null;
        // A removed or disabled remembered destination needs a fresh choice,
        // even when a single different destination remains.
        if (remembered !== null) action.target_list_id = action.lists.some((list) => list.id === remembered) ? remembered : "";
      } catch (_error) { /* Keep the normal target picker when browser storage is disabled. */ }
    } catch (error) {
      if (this._itemAction === action) action.error = error?.message || haListManagerShoppingCardText("quick_actions.error", {}, this._hass);
    } finally {
      if (this._itemAction === action) { action.loading = false; this._refreshMetadataUi(); }
    }
  }

  _closeItemAction() {
    const action = this._itemAction;
    if (!action || action.busy) return;
    this._itemAction = null;
    if (this._dialog !== action.parent) return;
    this._refreshMetadataUi();
    const panel = this.shadowRoot.querySelector("[data-dialog]");
    if (panel) panel.scrollTop = action.parent_scroll;
    this.shadowRoot.querySelector(action.return_selector || "[data-toggle-item-actions]")?.focus({ preventScroll: true });
  }

  _renderItemActionDialog() {
    const action = this._itemAction;
    if (!action) return "";
    const text = (key, values = {}) => haListManagerShoppingCardText(`quick_actions.${key}`, values, this._hass);
    const isSend = action.kind === "send";
    const title = text(`title_${action.kind}`);
    const note = isSend ? `<p class="field-help">${text("saved_source_note")}</p><p class="field-help">${text("source_unchanged")}</p>`
      : `<p>${action.kind === "chip" ? text("confirm_chip", {p0:esc(action.name), p1:esc(action.list_name)}) : text("confirm_rule", {p0:esc(action.name), p1:esc(action.category.name), p2:esc(action.list_name)})}</p>${action.kind === "rule" && action.category.scope !== "list" ? `<p class="field-help">${text("local_category_help")}</p>` : ""}`;
    const fields = !isSend ? "" : action.loading ? `<p role="status">${haListManagerShoppingCardText("ui.please_wait", {}, this._hass)}</p>`
      : action.lists.length ? `<label><span>${text("target")}</span><select data-item-action-target ${action.busy ? "disabled" : ""}><option value="">${text("choose_target")}</option>${action.lists.map((list) => `<option value="${esc(list.id)}" ${list.id === action.target_list_id ? "selected" : ""}>${esc(list.name)}</option>`).join("")}</select></label><label><span>${haListManagerShoppingCardText("ui.count", {}, this._hass)}</span><input type="number" min="1" max="1000000" step="1" value="${esc(action.quantity)}" data-item-action-quantity ${action.busy ? "disabled" : ""}></label>` : `<p class="field-help">${text("no_targets")}</p>`;
    const disabled = action.busy || action.loading || isSend && !action.lists.length;
    return `<div class="backdrop" data-close-dialog><section class="dialog item-action-dialog" role="dialog" aria-modal="true" aria-label="${title}" data-dialog><header><h2>${title}</h2><button type="button" class="icon-button" data-close-dialog ${action.busy ? "disabled" : ""} aria-label="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>${note}${fields}${this._notice(action.error, "item-action", "dialog-status error")}<footer><button type="button" class="primary" data-confirm-item-action ${disabled ? "disabled" : ""}>${action.busy ? haListManagerShoppingCardText("ui.please_wait", {}, this._hass) : isSend ? haListManagerShoppingCardText("ui.add", {}, this._hass) : text("create")}</button><button type="button" data-cancel-item-action data-close-dialog ${action.busy ? "disabled" : ""}>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }

  async _confirmItemAction() {
    const action = this._itemAction;
    if (!action || action.busy || action.loading || this._dialog !== action.parent || this._listId() !== action.list_id) return;
    if (action.kind === "rule" && !this._hass?.user?.is_admin) return;
    const quantity = Number(action.quantity);
    if (action.kind === "send") {
      if (!action.lists.some((list) => list.id === action.target_list_id)) {
        action.error = haListManagerShoppingCardText("quick_actions.choose_target", {}, this._hass);
        this._refreshMetadataUi(); return;
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) {
        action.error = haListManagerShoppingCardText("quick_actions.quantity_range", {}, this._hass);
        this._refreshMetadataUi(); return;
      }
    }
    action.busy = true; action.error = "";
    this._refreshMetadataUi();
    try {
      const payload = action.kind === "send"
        ? { source_list_id: action.list_id, source_item_id: action.parent.item.id, target_list_id: action.target_list_id, quantity }
        : { list_id: action.list_id, name: action.name, ...(action.kind === "chip" ? {product_id: action.parent.item.product_id || null} : {category_id: action.category.id}) };
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/item_actions/${action.kind}`, ...payload });
      if (action.kind === "send") this._rememberItemActionTarget(payload.target_list_id, action.target_storage_key);
      if (this._itemAction !== action || this._dialog !== action.parent) return;
      if (action.kind === "rule" && result.category?.id) {
        // Keep the draft bound to the newly effective list category; do not save the item.
        action.parent.category_id = result.category.id;
        action.parent.category_name = result.category.name;
      }
      const key = action.kind === "send" ? result.merged ? "merged" : "sent"
        : action.kind === "chip" ? result.created ? "created_chip" : "existing_chip"
        : result.created ? "created_rule" : "existing_rule";
      const values = action.kind === "send" ? {p0:quantity, p1:result.list?.name || action.lists.find((list) => list.id === action.target_list_id)?.name || ""} : {};
      action.parent.quick_action_status = haListManagerShoppingCardText(`quick_actions.${key}`, values, this._hass);
      action.busy = false;
      this._closeItemAction();
    } catch (error) {
      if (this._itemAction === action) action.error = error?.message || haListManagerShoppingCardText("quick_actions.error", {}, this._hass);
    } finally {
      action.busy = false;
      if (this._itemAction === action) this._refreshMetadataUi();
    }
  }

  _renderDialogHeading(title) {
    const tracked = ["edit", "product-transfer"].includes(this._dialog?.mode);
    return `<div class="dialog-heading"><h2>${title}</h2>${tracked ? `<span class="unsaved-indicator" data-unsaved-indicator ${this._isDialogDirty() ? "" : "hidden"}><ha-icon icon="mdi:content-save-alert-outline"></ha-icon>${haListManagerShoppingCardText("ui.not_saved_yet", {}, this._hass)}</span>` : ""}</div>`;
  }

  _renderDialog() {
    const draft = this._dialog;
    if (!draft) return "";
    if (this._itemAction?.parent === draft) return this._renderItemActionDialog();
    if (draft.mode === "product-duplicates") {
      return `<div class="backdrop" data-close-dialog><section class="dialog product-choice-dialog" role="dialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("ui.select_existing_product", {}, this._hass)}" data-dialog>
        <header><div><h2>${haListManagerShoppingCardText("ui.product_exists", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("ui.choose_existing_or_duplicate_product", {}, this._hass)}</p></div><button class="icon-button" data-product-transfer-back title="${haListManagerShoppingCardText("ui.back_to_item", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>
        <div class="product-choices">${draft.matches.map((product) => `<button type="button" class="product-choice" data-link-existing-product="${esc(product.id)}">${product.image_url ? `<img src="${esc(product.image_url)}" alt="">` : `<span class="product-choice-placeholder"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`}<span><strong>${esc(product.name)}</strong><small>${esc([product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : null].filter(Boolean).join(" · ") || haListManagerShoppingCardText("ui.product_database", {}, this._hass))}</small></span><ha-icon icon="mdi:link-variant"></ha-icon></button>`).join("")}</div>
        ${this._notice(draft.status, "dialog", `dialog-status ${esc(draft.statusTone)}`)}
        <footer><button data-create-product-anyway><ha-icon icon="mdi:database-plus-outline"></ha-icon>${haListManagerShoppingCardText("ui.create_product_anyway", {}, this._hass)}</button><button data-product-transfer-back>${haListManagerShoppingCardText("ui.back_to_item", {}, this._hass)}</button></footer>
      </section></div>`;
    }
    if (draft.mode === "product-transfer") {
      const title = draft.editing ? haListManagerShoppingCardText("products.edit", {}, this._hass) : haListManagerShoppingCardText("products.save_to_database", {}, this._hass);
      const action = draft.editing ? haListManagerShoppingCardText("ui.save_link_product", {}, this._hass) : haListManagerShoppingCardText("ui.create_link_product", {}, this._hass);
      const eanStatus = draft.eanStatus
        ? this._notice(draft.eanStatus, "ean", `dialog-status ean-dialog-status ${esc(draft.eanStatusTone)}`, draft.eanStatusTone === "success" ? "check-circle-outline" : draft.eanStatusTone === "warning" ? "alert-outline" : "alert-circle-outline")
        : "";
      const fields = globalThis.HaListManagerProductEditor.renderFields({
        draft, text: (key, values = {}) => haListManagerShoppingCardText(key, values, this._hass),
        fieldAttribute: (field) => `data-product-field="${field}"`, lookupAttribute: "data-lookup-product-ean",
        lookupLabel: haListManagerShoppingCardText("ui.lookup_ean", {}, this._hass),
        busy: this._busy, imageAttribute: "data-view-transfer-image", eanStatusHtml: eanStatus,
        packagePlaceholder: haListManagerShoppingCardText("ui.package_weight_example", {}, this._hass),
      });
      return `<div class="backdrop" data-close-dialog><section class="dialog product-dialog transfer-product-dialog" role="dialog" aria-modal="true" aria-label="${title}" data-dialog>
        <header>${this._renderDialogHeading(title)}<button class="icon-button" data-product-transfer-back title="${haListManagerShoppingCardText("ui.back_to_item", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>
        ${fields}
        ${this._renderCategoryEditorSection(true)}
        ${this._renderProductCategoryMove()}
        ${this._renderLabelSelector(draft.label_ids)}
        ${this._notice(draft.status, "dialog", `dialog-status ${esc(draft.statusTone)}`, draft.statusTone === "success" ? "check-circle-outline" : draft.statusTone === "warning" ? "alert-outline" : "alert-circle-outline")}
        <footer><button class="primary" data-save-product-transfer>${this._busy ? haListManagerShoppingCardText("ui.saving", {}, this._hass) : action}</button><button data-product-transfer-back>${haListManagerShoppingCardText("ui.back_to_item", {}, this._hass)}</button></footer>
      </section></div>`;
    }
    const product = draft.product;
    const createsProduct = this._cameraCreatesProduct(draft);
    const dialogTitle = haListManagerShoppingCardText(draft.item ? "ui.edit_item" : createsProduct ? "scan.new_product_title" : "ui.add_item", {}, this._hass);
    const isBring = this._list?.list_type === "bring";
    const amountValue = product?.package_quantity || draft.description;
    const amountDetails = this._amountDetails(amountValue, draft.quantity, product ? haListManagerShoppingCardText("ui.package_quantity", {}, this._hass) : haListManagerShoppingCardText("ui.amount", {}, this._hass));
    const amountHelp = `<div class="product-amount-summary" data-product-amount-summary ${amountDetails.summary ? "" : "hidden"}>${esc(amountDetails.summary)}</div><p class="product-amount-warning" data-product-amount-warning ${amountDetails.warning ? "" : "hidden"}>${esc(amountDetails.warning)}</p>${product ? "" : `<p class="field-help" data-free-amount-help ${amountDetails.summary ? "hidden" : ""}>${haListManagerShoppingCardText("help.recipe_quantity_input", {}, this._hass)}</p>`}`;
    const amountField = product?.package_quantity
      ? `<div class="fixed-product-amount"><span>${haListManagerShoppingCardText("ui.package_quantity", {}, this._hass)}</span><strong>${esc(product.package_quantity)}</strong><small>${haListManagerShoppingCardText(createsProduct ? "scan.new_product_package" : "ui.fixed_database_value", {}, this._hass)}</small></div>`
      : `<label><span>${haListManagerShoppingCardText("ui.quantity_description_optional", {}, this._hass)}</span><input data-d-description value="${esc(draft.description)}" maxlength="2000" placeholder="${haListManagerShoppingCardText("ui.package_description_example", {}, this._hass)}"></label>`;
    const quantityFields = `<div class="item-quantity-fields"><div class="item-quantity-controls"><label class="quantity-edit-field"><span>${haListManagerShoppingCardText("ui.count", {}, this._hass)}</span><input data-d-quantity type="number" min="1" max="1000000" value="${esc(draft.quantity)}"></label><div class="dialog-quantity-actions"><button type="button" data-dialog-quantity="1" title="${haListManagerShoppingCardText("ui.increase_quantity", {}, this._hass)}">+</button><button type="button" data-dialog-quantity="-1" title="${haListManagerShoppingCardText("ui.decrease_count", {}, this._hass)}">−</button></div></div>${amountField}</div>`;
    const previewDescription = product?.package_quantity || draft.description;
    const image = product?.image_url && this._config.show_images
      ? `<button class="dialog-image-button" type="button" data-view-image="${esc(product.image_url)}" title="${haListManagerShoppingCardText("ui.enlarge_product_image", {}, this._hass)}"><img class="dialog-image" src="${esc(product.image_url)}" alt="${esc(draft.name)}"></button>`
      : "";
    if (draft.mode === "increment") {
      const current = Math.max(0, Number(draft.item?.quantity || 0));
      const increment = Math.max(1, Number.parseInt(draft.increment, 10) || 1);
      return `<div class="backdrop" data-close-dialog><section class="dialog increment-dialog" role="dialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("ui.increase_quantity", {}, this._hass)}" data-dialog>
        <header><h2>${haListManagerShoppingCardText("ui.increase_quantity", {}, this._hass)}</h2><button class="icon-button" data-close-dialog title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>
        ${image}<div class="increment-product"><strong>${esc(this._displayNameWithoutQuantity(draft.item))}</strong>${product?.ean ? `<span class="meta">EAN ${esc(product.ean)}${product.brand ? ` · ${esc(product.brand)}` : ""}${product.package_quantity ? ` · ${esc(product.package_quantity)}` : ""}</span>` : ""}</div>
        <div class="increment-summary"><div class="increment-term"><span>${haListManagerShoppingCardText("ui.current_count", {}, this._hass)}</span><strong>${current}</strong></div><button type="button" class="increment-operator increment-plus" data-increment-plus title="${haListManagerShoppingCardText("ui.increase_add_quantity", {}, this._hass)}">+</button><label class="increment-term"><span>${haListManagerShoppingCardText("ui.add", {}, this._hass)}</span><input data-d-increment type="number" min="1" max="1000000" value="${esc(draft.increment)}"></label><span class="increment-operator increment-equals">=</span><div class="increment-term increment-new"><span>${haListManagerShoppingCardText("ui.new_count", {}, this._hass)}</span><strong data-increment-total>${current + increment}</strong></div></div>
        ${this._notice(draft.status, "dialog", `dialog-status ${esc(draft.statusTone)}`)}
        <footer><button class="primary" data-save-dialog>${this._busy ? haListManagerShoppingCardText("ui.saving", {}, this._hass) : haListManagerShoppingCardText("ui.increase_quantity", {}, this._hass)}</button><button data-close-dialog>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button><button data-edit-existing><ha-icon icon="mdi:pencil-outline"></ha-icon>${haListManagerShoppingCardText("ui.edit_item", {}, this._hass)}</button></footer>
      </section></div>`;
    }
    return `<div class="backdrop" data-close-dialog><section class="dialog product-dialog" role="dialog" aria-modal="true" aria-label="${dialogTitle}" data-dialog>
      <header>${this._renderDialogHeading(dialogTitle)}<div class="item-dialog-header-actions">${draft.item ? this._renderItemActionsMenu() : ""}<button class="icon-button" data-close-dialog title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div></header>
      ${this._renderEditShortcuts()}${this._notice(draft.quick_action_status, "quick", "dialog-status success item-action-result", "check-circle-outline")}${image}<label class="offer-only-choice"><input type="checkbox" data-d-offer-only ${draft.offer_only ? "checked" : ""}>${haListManagerShoppingCardText("ui.buy_on_offer_only", {}, this._hass)}</label><label class="name-field"><span>${haListManagerShoppingCardText(createsProduct ? "scan.new_product_name" : "ui.item_name", {}, this._hass)}</span><input data-d-name value="${esc(draft.name)}" maxlength="200"></label>
      ${draft.item?.completed_delete_at ? `<p class="field-help">${haListManagerShoppingCardText("cleanup.scheduled",{time:esc(new Date(draft.item.completed_delete_at).toLocaleString(haListManagerShoppingCardTextLocale(this._hass)))},this._hass)}</p>` : ""}
      ${draft.camera_capture ? `<p class="field-help">${haListManagerShoppingCardText(createsProduct ? "scan.confirm_hint" : "scan.known_product_hint", {}, this._hass)}</p>` : ""}${product?.ean ? `<div class="meta product-meta">EAN ${esc(product.ean)}${product.brand ? ` · ${esc(product.brand)}` : ""}${product.package_quantity ? ` · ${esc(product.package_quantity)}` : ""}</div>` : ""}
      ${isBring ? `${quantityFields}${amountHelp}${product?.package_quantity ? "" : `<p class="field-help bring-format-help">${haListManagerShoppingCardText("help.bring_quantity_examples", {}, this._hass)}</p>`}<div class="bring-live-preview"><span>${haListManagerShoppingCardText("bring.preview", {}, this._hass)}</span><strong data-bring-preview-name>${esc(draft.name.trim() || haListManagerShoppingCardText("ui.item_name", {}, this._hass))}</strong><small data-bring-preview-value ${this._bringPreviewValue(draft.quantity, previewDescription) ? "" : "hidden"}>${esc(this._bringPreviewValue(draft.quantity, previewDescription))}</small></div>${this._renderCategoryEditorSection()}` : `${quantityFields}${amountHelp}${this._renderCategoryEditorSection()}`}
      ${this._renderLabelSelector(draft.label_ids)}
      ${this._notice(draft.status, "dialog", `dialog-status ${esc(draft.statusTone)}`, draft.statusTone === "warning" ? "alert-outline" : "alert-circle-outline")}
      <footer><button class="primary" data-save-dialog>${this._busy ? haListManagerShoppingCardText("ui.saving", {}, this._hass) : haListManagerShoppingCardText(createsProduct ? "scan.new_product_save" : draft.camera_capture ? "ui.add" : "ui.save", {}, this._hass)}</button><button data-close-dialog>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button>${draft.item ? `<button data-open-product-transfer><ha-icon icon="mdi:${draft.item.product_id ? "database-edit-outline" : "database-plus-outline"}"></ha-icon>${draft.item.product_id ? haListManagerShoppingCardText("products.edit", {}, this._hass) : haListManagerShoppingCardText("products.save_to_database", {}, this._hass)}</button><button class="danger" data-delete-item><ha-icon icon="mdi:delete-outline"></ha-icon>${haListManagerShoppingCardText("ui.delete_from_list", {}, this._hass)}</button>` : ""}</footer>
    </section></div>`;
  }

  _renderConfirmation() {
    if (this._confirmation?.type === "complete_cleanup") {
      const minutes=Number(this._list.auto_delete_delay_minutes || 0);
      const text=haListManagerShoppingCardText(minutes ? "cleanup.confirm_delayed" : "cleanup.confirm_now",{name:esc(this._confirmation.item.name),minutes},this._hass);
      return `<div class="backdrop confirmation-backdrop"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true"><span class="confirmation-icon"><ha-icon icon="mdi:delete-clock-outline"></ha-icon></span><h2>${haListManagerShoppingCardText("cleanup.confirm_title",{},this._hass)}</h2><p>${text}</p><footer><button class="danger filled" data-confirm-delete>${haListManagerShoppingCardText("cleanup.confirm_action",{},this._hass)}</button><button data-cancel-delete>${haListManagerShoppingCardText("ui.cancel",{},this._hass)}</button></footer></section></div>`;
    }
    if (this._confirmation?.type === "discard_dialog") {
      return `<div class="backdrop confirmation-backdrop" data-discard-backdrop><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("ui.discard_changes_confirm", {}, this._hass)}" data-discard-confirmation><span class="confirmation-icon"><ha-icon icon="mdi:alert-outline"></ha-icon></span><h2>${haListManagerShoppingCardText("ui.discard_changes_confirm", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("ui.dialog_changes_unsaved", {}, this._hass)}</p><footer><button class="danger filled" data-confirm-discard>${haListManagerShoppingCardText("ui.discard_changes", {}, this._hass)}</button><button data-cancel-confirmation>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
    }
    if (this._confirmation?.type === "share") {
      const profiles = this._confirmation.profiles || [];
      const selected = new Set(this._confirmation.selectedIds || []);
      return `<div class="backdrop confirmation-backdrop"><section class="dialog confirmation-dialog share-confirmation" role="alertdialog" aria-modal="true"><span class="confirmation-icon"><ha-icon icon="mdi:share-variant-outline"></ha-icon></span><h2>${haListManagerShoppingCardText("ui.send_list_confirm", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("notifications.send_to_label", {}, this._hass)}</p><div class="share-targets">${profiles.map((profile) => `<label><input type="checkbox" data-share-profile="${esc(profile.id)}" ${selected.has(profile.id) ? "checked" : ""}><span>${esc(profile.name)}</span></label>`).join("")}</div><footer><button class="primary" data-confirm-share ${selected.size ? "" : "disabled"}>${haListManagerShoppingCardText("ui.send", {}, this._hass)}</button><button data-cancel-confirmation>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
    }
    if (this._confirmation?.type === "clear_completed") {
      const count = Number(this._confirmation.count || 0);
      return `<div class="backdrop confirmation-backdrop"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true"><span class="confirmation-icon"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon></span><h2>${haListManagerShoppingCardText("ui.delete_completed_items_confirm", {}, this._hass)}</h2><p>${(count === 1 ? haListManagerShoppingCardText("shopping.clear_completed_one", {count}, this._hass) : haListManagerShoppingCardText("shopping.clear_completed_many", {count}, this._hass))}</p><footer><button class="danger filled" data-confirm-delete>${haListManagerShoppingCardText("ui.delete_all", {}, this._hass)}</button><button data-cancel-delete>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
    }
    const item = this._confirmation?.item;
    if (!item) return "";
    const databaseNote = item.product_id ? (" " + haListManagerShoppingCardText("ui.linked_product_retained", {}, this._hass)) : "";
    return `<div class="backdrop confirmation-backdrop"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true"><span class="confirmation-icon"><ha-icon icon="mdi:delete-outline"></ha-icon></span><h2>${haListManagerShoppingCardText("ui.remove_item_confirm", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("shopping.confirm_remove_named", {p0:(esc(item.name)), p1:(databaseNote)}, this._hass)}</p><footer><button class="danger filled" data-confirm-delete>${haListManagerShoppingCardText("ui.remove", {}, this._hass)}</button><button data-cancel-delete>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }

  _renderImageDialog() {
    if (!this._imageDialog) return "";
    return `<div class="backdrop image-backdrop" data-close-image><section class="dialog image-dialog"><header><h2>${esc(this._imageDialog.name)}</h2><button class="icon-button" data-close-image title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header><img src="${esc(this._imageDialog.url)}" alt="${esc(this._imageDialog.name)}"></section></div>`;
  }

  _renderChipDialog() {
    if (!this._chipDialog) return "";
    const chips = this._displayChips();
    const dishes = this._dishes;
    const heading = (label, count) => `<h3>${esc(label)} <span>${count}</span></h3>`;
    const content = this._categoryChipsEnabled()
      ? this._renderChipCategoryGroups(chips, true, dishes)
      : `${chips.length ? `<section class="dialog-chip-section">${heading(haListManagerShoppingCardText("ui.chips", {}, this._hass), chips.length)}<div class="dialog-chip-grid">${chips.map((chip) => this._renderChipButton(chip, true)).join("")}</div></section>` : ""}${dishes.length ? `<section class="dialog-dishes dialog-chip-section">${heading(haListManagerShoppingCardText("recipes.dishes", {}, this._hass), dishes.length)}<div class="dialog-chip-grid">${dishes.map((dish) => this._renderDishButton(dish, true)).join("")}</div></section>` : ""}`;
    return `<div class="backdrop chip-dialog-backdrop" data-close-chip-dialog><section class="dialog chip-dialog" role="dialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("ui.quick_entries", {}, this._hass)}" data-dialog><header><div><h2>${haListManagerShoppingCardText("ui.quick_entries", {}, this._hass)}</h2></div>${this._config.show_label_filter_button !== false ? `<button type="button" class="filter-header-button" data-open-label-filter><ha-icon icon="mdi:filter-variant"></ha-icon><span>${esc(this._filterText("open_button"))}</span></button>` : ""}<button class="icon-button" data-close-chip-dialog title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>${this._renderLabelFilterControls()}${content}</section></div>`;
  }

  _renderDishDialog() {
    const dialog = this._dishDialog;
    if (!dialog?.dish) return "";
    const selected = dialog.selected || new Set();
    const rows = dialog.dish.items.map((item) => {
      const isSelected = selected.has(item.id);
      const existing = this._items.find((entry) => item.product_id
        ? entry.product_id === item.product_id
        : !entry.product_id && entry.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase());
      const choice = dialog.categories?.[item.id] || { category_id: null, category_name: "", dynamic: false, general: true, source: "none", locked: false };
      const sourceText = haListManagerShoppingCardText("shopping.already_listed_quantity", {p0:(Math.max(0, Number(existing?.quantity) || 0))}, this._hass);
      const categoryControl = choice.locked
        ? `<span class="dish-category-locked"><strong>${esc(choice.category_name || haListManagerShoppingCardText("ui.general", {}, this._hass))}</strong><small>${esc(sourceText)}</small></span>`
        : `<div class="dish-category-combo picker-popup-host ${choice.source === "none" ? "unresolved" : ""}"><input value="${esc(choice.category_name || "")}" placeholder="${choice.general ? haListManagerShoppingCardText("ui.general", {}, this._hass) : haListManagerShoppingCardText("categories.search_or_enter", {}, this._hass)}" autocomplete="off" data-dish-category-search="${esc(item.id)}" aria-label="${haListManagerShoppingCardText("ui.category_for", {p0:(esc(item.name))}, this._hass)}" ${isSelected ? "" : "disabled"}>${this._selectionButton("categories", !isSelected, "dish", item.id)}<div class="category-picker-options" data-dish-category-options="${esc(item.id)}" hidden></div></div>`;
      return `<div class="dish-choice ${isSelected ? "selected" : ""}"><input type="checkbox" data-dish-choice="${esc(item.id)}" aria-label="${haListManagerShoppingCardText("ui.select_named_item", {p0:(esc(item.name))}, this._hass)}" ${isSelected ? "checked" : ""}><span><strong>${esc(item.product_name || item.name)}</strong>${item.product_name ? `<small>${haListManagerShoppingCardText("ui.product", {}, this._hass)}</small>` : `<small>${haListManagerShoppingCardText("ui.freeform_item", {}, this._hass)}</small>`}</span><input type="number" min="1" max="1000000" step="1" data-dish-quantity="${esc(item.id)}" value="${esc(dialog.quantities[item.id] || item.quantity || 1)}" aria-label="${haListManagerShoppingCardText("shopping.quantity_for", {p0:(esc(item.name))}, this._hass)}" ${isSelected ? "" : "disabled"}>${categoryControl}</div>`;
    }).join("");
    return `<div class="backdrop dish-dialog-backdrop" data-close-dish-dialog><section class="dialog dish-add-dialog" role="dialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("ui.add_dish", {}, this._hass)}" data-dish-dialog><header><div><h2>${esc(dialog.dish.name)}</h2><p>${haListManagerShoppingCardText("recipes.review_ingredients_help", {}, this._hass)}</p></div><button class="icon-button" data-close-dish-dialog title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header><div class="dish-choices">${rows}</div>${this._notice(dialog.status, "dish", "dialog-status error")}<footer><button class="primary" data-add-dish-to-list ${selected.size && !this._busy ? "" : "disabled"}>${this._busy ? haListManagerShoppingCardText("ui.adding", {}, this._hass) : haListManagerShoppingCardText("ui.add_selection", {}, this._hass)}</button><button data-close-dish-dialog>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }

  _normalizeTandoorName(value) {
    return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  }

  _tandoorServingScale(dialog = this._tandoorDialog) {
    const original = Number(dialog?.recipe?.servings);
    const selected = Number(dialog?.servings);
    return Number.isFinite(original) && original > 0 && Number.isFinite(selected) && selected > 0
      ? selected / original : 1;
  }

  _tandoorAmountText(ingredient, dialog = this._tandoorDialog) {
    if (!ingredient || ingredient.no_amount || ingredient.amount === null || ingredient.amount === undefined) return "";
    const numeric = Number(ingredient.amount);
    // Tandoor uses zero for ingredients without a concrete recipe amount.
    // It is not a meaningful shopping quantity and must not reach the list.
    if (Number.isFinite(numeric) && numeric <= 0) return "";
    const amount = Number.isFinite(numeric)
      ? new Intl.NumberFormat(haListManagerShoppingCardTextLocale(this._hass), { maximumFractionDigits: 3, useGrouping: false }).format(numeric * this._tandoorServingScale(dialog))
      : String(ingredient.amount);
    return `${amount}${ingredient.unit ? ` ${ingredient.unit}` : ""}`.trim();
  }

  _isTandoorSmallUnit(ingredient) {
    const normalizeUnit = (value) => String(value || "")
      .trim().toLocaleLowerCase("de-DE")
      .replace(/\([^)]*\)/g, "")
      .replace(/[.]/g, "")
      .trim();
    const unit = normalizeUnit(ingredient?.unit);
    const excludedUnits = new Set([
      "el", "esslöffel", "essloeffel",
      "tl", "teelöffel", "teeloeffel",
      "prise", "prisen",
      "msp", "messerspitze", "messerspitzen",
      "schuss",
      "tbsp", "tablespoon", "tablespoons",
      "tsp", "teaspoon", "teaspoons",
      "pinch", "pinches", "dash", "dashes",
    ]);
    String(this._list?.tandoor_excluded_units || "").split(/[,;\n]/)
      .map(normalizeUnit)
      .filter(Boolean)
      .forEach((value) => excludedUnits.add(value));
    return excludedUnits.has(unit);
  }

  _suggestTandoorProduct(name) {
    const normalized = this._normalizeTandoorName(name);
    const linkedChip = this._chips.find((chip) => chip.product_id && this._normalizeTandoorName(chip.name) === normalized);
    if (linkedChip) return this._products.find((product) => product.id === linkedChip.product_id) || null;
    const matches = this._products.filter((product) => [product.name, product.original_name]
      .some((value) => this._normalizeTandoorName(value) === normalized));
    return matches.length === 1 ? matches[0] : null;
  }

  _measurementBase(amount, unit) {
    const value = Number(amount);
    const normalized = String(unit || "").trim().toLocaleLowerCase();
    if (!Number.isFinite(value) || value <= 0) return null;
    const conversions = {
      mg: ["weight", 0.001], g: ["weight", 1], kg: ["weight", 1000],
      ml: ["volume", 1], cl: ["volume", 10], l: ["volume", 1000],
      stück: ["count", 1], stueck: ["count", 1], stk: ["count", 1], st: ["count", 1],
      piece: ["count", 1], pieces: ["count", 1], pc: ["count", 1], pcs: ["count", 1],
    };
    const conversion = conversions[normalized];
    return conversion ? { dimension: conversion[0], value: value * conversion[1] } : null;
  }

  _parsePackageMeasurement(value) {
    const match = String(value || "").trim().match(/(\d+(?:[.,]\d+)?)\s*(mg|kg|g|ml|cl|l|stück|stueck|stk|st|pieces?|pcs?)\b/i);
    return match ? this._measurementBase(Number(match[1].replace(",", ".")), match[2]) : null;
  }

  _tandoorProductCount(ingredient, product, dialog = this._tandoorDialog) {
    const amount = Number(ingredient?.amount);
    const scaledAmount = Number.isFinite(amount) ? amount * this._tandoorServingScale(dialog) : ingredient?.amount;
    const needed = this._measurementBase(scaledAmount, ingredient?.unit);
    const packaged = this._parsePackageMeasurement(product?.package_quantity);
    if (!needed || !packaged || needed.dimension !== packaged.dimension) return null;
    return Math.max(1, Math.ceil(needed.value / packaged.value));
  }

  async _openTandoorDialog() {
    if (!this._list?.use_tandoor || this._busy) return;
    this._headerMenuOpen = false;
    this._tandoorDialog = {
      mode: "search", query: "", categoryId: null, categoryName: "", browseAll: false,
      includeIngredients: this._list?.tandoor_include_ingredients !== false,
      skipSmallUnits: this._list?.tandoor_skip_small_units === true,
      resultLimit: Number(this._list?.tandoor_result_limit || 100),
      categories: [], categoriesLoading: true, loading: false, searchPending: false, recipes: [], status: "",
    };
    this._lockScroll();
    this._render();
    await this._loadTandoorCategories();
  }

  async _loadTandoorCategories() {
    const dialog = this._tandoorDialog;
    if (!dialog) return;
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/tandoor/categories/list`, list_id: this._listId() });
      if (this._tandoorDialog === dialog) dialog.categories = result.categories || [];
    } catch (error) {
      if (this._tandoorDialog === dialog) dialog.status = error?.message || String(error);
    } finally {
      if (this._tandoorDialog === dialog) {
        dialog.categoriesLoading = false;
        this._render();
      }
    }
  }

  _focusTandoorSearch(position) {
    const input = this.shadowRoot.querySelector("[data-tandoor-search]");
    if (!input) return;
    input.focus({ preventScroll: true });
    const caret = Math.min(Number(position) || 0, input.value.length);
    input.setSelectionRange(caret, caret);
  }

  _setTandoorSearchPending(active) {
    const dialog = this._tandoorDialog;
    if (!dialog) return;
    dialog.searchPending = active;
    const indicator = this.shadowRoot.querySelector("[data-tandoor-search-loading]");
    if (indicator) indicator.hidden = !active;
    const field = this.shadowRoot.querySelector(".tandoor-search");
    if (field) field.setAttribute("aria-busy", active ? "true" : "false");
  }

  async _searchTandoorRecipes(query, preserveFocus = false) {
    const dialog = this._tandoorDialog;
    if (!dialog) return;
    const requestId = ++this._tandoorSearchRequestId;
    const caret = query.length;
    dialog.query = query;
    dialog.status = "";
    if (!query.trim() && !dialog.categoryId && !dialog.browseAll) {
      dialog.searchPending = false;
      dialog.loading = false;
      dialog.recipes = [];
      this._render();
      if (preserveFocus) {
        this._focusTandoorSearch(caret);
        requestAnimationFrame(() => {
          if (this._tandoorDialog === dialog && requestId === this._tandoorSearchRequestId) {
            this._focusTandoorSearch(caret);
          }
        });
      }
      return;
    }
    dialog.searchPending = false;
    dialog.loading = true;
    // Do not replace the active input while the user is typing. The completed
    // request renders the new result list and restores the caret below.
    if (!preserveFocus) this._render();
    try {
      const message = {
        type: `${HA_LM_API}/tandoor/recipes/search`, list_id: this._listId(), query,
        include_ingredients: dialog.includeIngredients !== false,
      };
      if (dialog.categoryId) message.category_id = Number(dialog.categoryId);
      const result = await haListManagerShoppingCardTextRequest(this._hass, message);
      if (this._tandoorDialog !== dialog || requestId !== this._tandoorSearchRequestId) return;
      dialog.recipes = result.recipes || [];
    } catch (error) {
      if (this._tandoorDialog === dialog && requestId === this._tandoorSearchRequestId) dialog.status = error?.message || String(error);
    } finally {
      if (this._tandoorDialog === dialog && requestId === this._tandoorSearchRequestId) {
        dialog.loading = false;
        this._render();
        if (preserveFocus) {
          this._focusTandoorSearch(caret);
          requestAnimationFrame(() => {
            if (this._tandoorDialog === dialog && requestId === this._tandoorSearchRequestId) {
              this._focusTandoorSearch(caret);
            }
          });
        }
      }
    }
  }

  async _selectTandoorRecipe(recipeId) {
    const dialog = this._tandoorDialog;
    if (!dialog) return;
    dialog.loading = true;
    dialog.status = "";
    this._render();
    try {
      const result = await haListManagerShoppingCardTextRequest(this._hass, { type: `${HA_LM_API}/tandoor/recipes/get`, list_id: this._listId(), recipe_id: Number(recipeId) });
      if (this._tandoorDialog !== dialog) return;
      const recipe = result.recipe;
      const products = Object.fromEntries((recipe.ingredients || []).map((ingredient) => [ingredient.id, this._suggestTandoorProduct(ingredient.name)]));
      let resolutions = new Map();
      try {
        const resolved = await haListManagerShoppingCardTextRequest(this._hass, {
          type: `${HA_LM_API}/categories/chips/resolve`,
          list_id: this._listId(),
          candidates: (recipe.ingredients || []).map((ingredient) => ({
            key: String(ingredient.id),
            name: products[ingredient.id]?.name || ingredient.name,
            product_id: products[ingredient.id]?.id || null,
          })),
        });
        resolutions = new Map((resolved.resolutions || []).map((entry) => [String(entry.key), entry.category || null]));
      } catch (_error) {}
      if (this._tandoorDialog !== dialog) return;
      const ingredientCategories = Object.fromEntries((recipe.ingredients || []).map((ingredient) => {
        const id = String(ingredient.id);
        const product = products[ingredient.id] || null;
        const matchedItem = this._existingItem(product, ingredient.name);
        const existing = matchedItem && !matchedItem.completed ? matchedItem : null;
        if (existing) {
          const category = this._categoryFor(existing);
          return [id, { category_id: existing.category_id || category.id || null, category_name: category.uncategorized ? "" : category.name, dynamic: Boolean(category.dynamic), general: Boolean(category.uncategorized), source: "existing", locked: true }];
        }
        const category = this._matchingProductCategory(product) || resolutions.get(id);
        return [id, {
          category_id: category?.id || null,
          category_name: category?.name || "",
          dynamic: Boolean(category?.dynamic || String(category?.id || "").startsWith("dynamic:")),
          general: !category,
          source: category ? "automatic" : "none",
          locked: false,
        }];
      }));
      dialog.mode = "recipe";
      dialog.recipe = recipe;
      dialog.recipeTab = "ingredients";
      dialog.servings = Number(recipe.servings) > 0 ? Number(recipe.servings) : null;
      dialog.products = products;
      dialog.ingredientCategories = ingredientCategories;
      dialog.selected = new Set((recipe.ingredients || [])
        .filter((ingredient) => !dialog.skipSmallUnits || !this._isTandoorSmallUnit(ingredient))
        .map((ingredient) => String(ingredient.id)));
      dialog.useProducts = new Set(Object.entries(products).filter(([, product]) => product).map(([id]) => String(id)));
      dialog.includeAmounts = new Set((recipe.ingredients || []).filter((ingredient) => {
        if (!this._tandoorAmountText(ingredient, dialog)) return false;
        const product = products[ingredient.id];
        return !product || this._tandoorProductCount(ingredient, product) !== null;
      }).map((ingredient) => String(ingredient.id)));
    } catch (error) {
      if (this._tandoorDialog === dialog) dialog.status = error?.message || String(error);
    } finally {
      if (this._tandoorDialog === dialog) {
        dialog.loading = false;
        this._render();
      }
    }
  }

  _closeTandoorDialog() {
    clearTimeout(this._tandoorSearchTimer);
    this._tandoorDialog = null;
    if (!this._dialog && !this._confirmation && !this._imageDialog && !this._chipDialog && !this._dishDialog) this._unlockScroll();
    this._render();
  }

  _renderTandoorRecipePreservingScroll() {
    const scrollTop = this.shadowRoot.querySelector(".tandoor-recipe-dialog")?.scrollTop || 0;
    this._render();
    const restore = () => {
      const dialog = this.shadowRoot.querySelector(".tandoor-recipe-dialog");
      if (dialog) dialog.scrollTop = scrollTop;
    };
    restore();
    requestAnimationFrame(restore);
  }

  _setTandoorServings(value) {
    const dialog = this._tandoorDialog;
    if (!dialog?.recipe || !(Number(dialog.recipe.servings) > 0)) return;
    const next = Math.max(1, Math.min(100, Math.round(Number(value) || 1)));
    dialog.servings = next;
    this._renderTandoorRecipePreservingScroll();
  }

  async _addTandoorSelection() {
    const dialog = this._tandoorDialog;
    if (!dialog?.recipe || this._busy) return;
    this._busy = true;
    dialog.status = "";
    this._render();
    let changed = 0;
    const availableCategories = this._availableCategories();
    try {
      for (const ingredient of dialog.recipe.ingredients || []) {
        const id = String(ingredient.id);
        if (!dialog.selected.has(id)) continue;
        const suggested = dialog.products?.[ingredient.id] || null;
        const product = suggested && dialog.useProducts.has(id) ? suggested : null;
        const includeAmount = dialog.includeAmounts.has(id);
        const calculated = product && includeAmount ? this._tandoorProductCount(ingredient, product) : null;
        const quantity = calculated || 1;
        const description = !product && includeAmount ? this._tandoorAmountText(ingredient) || null : null;
        const name = product?.name || ingredient.name;
        const choice = dialog.ingredientCategories?.[id] || {};
        const categoryName = String(choice.category_name || "").trim();
        const matchedCategory = choice.general ? null : choice.category_id
          ? availableCategories.find((category) => category.id === choice.category_id)
          : availableCategories.find((category) => category.name.localeCompare(categoryName, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
        const dynamicCategory = matchedCategory?.dynamic ? matchedCategory.name
          : !choice.general && !matchedCategory && categoryName ? categoryName : null;
        const existing = this._items.find((item) => !item.completed && (product
          ? item.product_id === product.id
          : !item.product_id && this._normalizeTandoorName(item.name) === this._normalizeTandoorName(name) && String(item.description || "") === String(description || "")));
        if (existing) {
          await haListManagerShoppingCardTextRequest(this._hass, {
            type: `${HA_LM_API}/items/update`, item_id: existing.id, name: existing.name,
            description: existing.description || description, quantity: Number(existing.quantity || 0) + quantity,
            category_id: existing.category_id || null, category: existing.category || null,
            due_at: existing.due_at || null, completed: false,
            label_ids: (existing.labels || []).map((label) => label.id), product_id: existing.product_id || product?.id || null,
          });
        } else {
          await haListManagerShoppingCardTextRequest(this._hass, {
            type: `${HA_LM_API}/items/create`, list_id: this._listId(), name,
            description, quantity,
            category_id: matchedCategory && !matchedCategory.dynamic ? matchedCategory.id : null,
            category: dynamicCategory,
            label_ids: [], product_id: product?.id || null,
          });
        }
        changed += 1;
      }
      const recipeName = dialog.recipe.name;
      this._tandoorDialog = null;
      this._unlockScroll();
      this._setNotificationStatus((changed === 1 ? haListManagerShoppingCardText("shopping.recipe_added_one", {recipe: recipeName, count: changed}, this._hass) : haListManagerShoppingCardText("shopping.recipe_added_many", {recipe: recipeName, count: changed}, this._hass)));
      await this._load(true);
    } catch (error) {
      if (this._tandoorDialog === dialog) dialog.status = error?.message || String(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _renderTandoorDialog() {
    const dialog = this._tandoorDialog;
    if (!dialog) return "";
    if (dialog.mode === "search") {
      const rows = (dialog.recipes || []).map((recipe) => `<button type="button" class="tandoor-recipe" data-tandoor-recipe="${esc(recipe.id)}">${recipe.image ? `<img src="${esc(recipe.image)}" alt="">` : `<span class="tandoor-image-placeholder"><ha-icon icon="mdi:food-variant"></ha-icon></span>`}<span><strong>${esc(recipe.name)}</strong><small>${recipe.servings ? haListManagerShoppingCardText("recipes.serving_count", {p0:(esc(recipe.servings))}, this._hass) : ""}${recipe.working_time ? haListManagerShoppingCardText("recipes.preparation_minutes", {p0:(recipe.servings ? " · " : ""), p1:(esc(recipe.working_time))}, this._hass) : ""}</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button>`).join("");
      const cookbooks = (dialog.categories || []).map((category) => `<button type="button" class="tandoor-cookbook" data-tandoor-cookbook="${esc(category.id)}" data-tandoor-cookbook-name="${esc(category.name)}"><span class="tandoor-cookbook-icon"><ha-icon icon="mdi:book-open-page-variant-outline"></ha-icon></span><strong>${esc(category.name)}</strong><ha-icon icon="mdi:chevron-right"></ha-icon></button>`).join("");
      const searching = Boolean(dialog.query.trim() || dialog.categoryId || dialog.browseAll);
      const scope = dialog.categoryId || dialog.browseAll ? `<div class="tandoor-scope"><button type="button" data-tandoor-all-cookbooks title="${haListManagerShoppingCardText("ui.back_all_cookbooks", {}, this._hass)}"><ha-icon icon="mdi:arrow-left"></ha-icon></button><span><small>${dialog.categoryId ? haListManagerShoppingCardText("recipes.cookbook", {}, this._hass) : haListManagerShoppingCardText("ui.selection", {}, this._hass)}</small><strong>${esc(dialog.categoryName || haListManagerShoppingCardText("ui.all_recipes", {}, this._hass))}</strong></span></div>` : "";
      const allRecipes = `<button type="button" class="tandoor-cookbook tandoor-all-recipes" data-tandoor-all-recipes><span class="tandoor-cookbook-icon"><ha-icon icon="mdi:silverware-fork-knife"></ha-icon></span><strong>${haListManagerShoppingCardText("ui.all_recipes", {}, this._hass)}</strong><ha-icon icon="mdi:chevron-right"></ha-icon></button>`;
      const content = dialog.loading ? `<div class="tandoor-state"><ha-circular-progress active></ha-circular-progress><span>${haListManagerShoppingCardText("ui.loading_recipes", {}, this._hass)}</span></div>` : dialog.status ? this._notice(dialog.status, "tandoor", "dialog-status error") : searching ? `<div class="tandoor-results">${rows || `<p class="tandoor-state">${haListManagerShoppingCardText("recipes.no_matches", {}, this._hass)}</p>`}</div>` : dialog.categoriesLoading ? `<div class="tandoor-state"><ha-circular-progress active></ha-circular-progress><span>${haListManagerShoppingCardText("ui.loading_cookbooks", {}, this._hass)}</span></div>` : `<section class="tandoor-cookbooks"><h3>${haListManagerShoppingCardText("recipes.recipes", {}, this._hass)}</h3>${allRecipes}<h3 class="tandoor-cookbooks-heading">${haListManagerShoppingCardText("ui.cookbooks", {}, this._hass)}</h3>${cookbooks || `<p class="tandoor-state">${haListManagerShoppingCardText("ui.no_cookbooks", {}, this._hass)}</p>`}</section>`;
      return `<div class="backdrop tandoor-backdrop" data-close-tandoor><section class="dialog tandoor-dialog" role="dialog" aria-modal="true"><header><div><h2>${haListManagerShoppingCardText("recipes.search_tandoor", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("recipes.choose_cookbook_help", {}, this._hass)}</p></div><button class="icon-button" data-close-tandoor title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>${scope}<div class="tandoor-filters"><label class="tandoor-search" aria-busy="${dialog.searchPending ? "true" : "false"}"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" value="${esc(dialog.query)}" placeholder="${dialog.categoryId ? haListManagerShoppingCardText("recipes.search_this_cookbook", {}, this._hass) : haListManagerShoppingCardText("recipes.search_all", {}, this._hass)}" autocomplete="off" data-tandoor-search><span class="tandoor-search-actions"><ha-circular-progress size="small" active data-tandoor-search-loading ${dialog.searchPending ? "" : "hidden"}></ha-circular-progress><button type="button" data-tandoor-clear title="${haListManagerShoppingCardText("ui.clear_input", {}, this._hass)}" ${dialog.query ? "" : "hidden"}><ha-icon icon="mdi:close"></ha-icon></button></span></label><div class="tandoor-search-options"><label class="tandoor-search-option"><input type="checkbox" data-tandoor-include-ingredients ${dialog.includeIngredients !== false ? "checked" : ""}><span>${haListManagerShoppingCardText("ui.search_ingredients", {}, this._hass)}</span></label><label class="tandoor-search-option"><input type="checkbox" data-tandoor-skip-small-units ${dialog.skipSmallUnits ? "checked" : ""}><span>${haListManagerShoppingCardText("recipes.skip_small_quantities", {}, this._hass)}</span></label></div><small>${haListManagerShoppingCardText("recipes.result_limit", {p0:(esc(dialog.resultLimit))}, this._hass)}</small></div>${content}</section></div>`;
    }
    const recipe = dialog.recipe;
    const steps = recipe?.steps || [];
    const recipeTab = dialog.recipeTab === "preparation" && steps.length ? "preparation" : "ingredients";
    const servings = Number(dialog.servings) > 0 ? Number(dialog.servings) : null;
    const rows = (recipe?.ingredients || []).map((ingredient) => {
      const id = String(ingredient.id);
      const selected = dialog.selected.has(id);
      const product = dialog.products?.[ingredient.id] || null;
      const useProduct = product && dialog.useProducts.has(id);
      const amount = this._tandoorAmountText(ingredient);
      const packageCount = useProduct ? this._tandoorProductCount(ingredient, product) : null;
      const amountEnabled = !useProduct || packageCount !== null;
      const productLabel = product ? [product.name, product.brand, product.package_quantity].filter(Boolean).join(" · ") : "";
      const choice = dialog.ingredientCategories?.[id] || { category_name: "", general: true, source: "none", locked: false };
      const categoryControl = choice.locked
        ? `<span class="tandoor-category-locked"><strong>${esc(choice.category_name || haListManagerShoppingCardText("ui.general", {}, this._hass))}</strong><small>${haListManagerShoppingCardText("ui.already_on_list", {}, this._hass)}</small></span>`
        : `<div class="dish-category-combo tandoor-category-combo picker-popup-host ${choice.source === "none" ? "unresolved" : ""}"><input value="${esc(choice.category_name || "")}" placeholder="${choice.general ? haListManagerShoppingCardText("ui.general", {}, this._hass) : haListManagerShoppingCardText("categories.search_or_enter", {}, this._hass)}" autocomplete="off" data-tandoor-category-search="${esc(id)}" aria-label="${haListManagerShoppingCardText("ui.category_for", {p0:(esc(ingredient.name))}, this._hass)}">${this._selectionButton("categories", false, "tandoor", id)}<div class="category-picker-options" data-tandoor-category-options="${esc(id)}" hidden></div></div>`;
      return `<article class="tandoor-ingredient ${selected ? "selected" : ""}"><div class="tandoor-ingredient-head"><label class="tandoor-ingredient-main"><input type="checkbox" data-tandoor-ingredient="${esc(id)}" ${selected ? "checked" : ""}><span><strong>${esc(ingredient.name)}</strong>${ingredient.note ? `<small>${esc(ingredient.note)}</small>` : ""}</span></label>${selected ? categoryControl : ""}</div>${product ? `<label class="tandoor-option"><input type="checkbox" data-tandoor-product="${esc(id)}" ${useProduct ? "checked" : ""} ${selected ? "" : "disabled"}><span>${haListManagerShoppingCardText("ui.use_product_label", {}, this._hass)} <strong>${esc(productLabel)}</strong></span></label>` : ""}${amount ? `<label class="tandoor-option"><input type="checkbox" data-tandoor-amount="${esc(id)}" ${dialog.includeAmounts.has(id) ? "checked" : ""} ${selected && amountEnabled ? "" : "disabled"}><span>${haListManagerShoppingCardText("recipes.recipe_quantity", {}, this._hass)} <strong>${esc(amount)}</strong>${packageCount !== null ? (" " + haListManagerShoppingCardText("ui.quantity_suffix", {p0:(packageCount)}, this._hass)) : ""}</span></label>` : ""}</article>`;
    }).join("");
    const tabs = steps.length ? `<div class="tandoor-recipe-tabs" role="tablist" aria-label="${haListManagerShoppingCardText("ui.recipe_view", {}, this._hass)}"><button type="button" role="tab" data-tandoor-recipe-tab="ingredients" aria-selected="${recipeTab === "ingredients"}" class="${recipeTab === "ingredients" ? "active" : ""}"><ha-icon icon="mdi:format-list-checks"></ha-icon>${haListManagerShoppingCardText("ui.ingredients", {}, this._hass)} <span>${esc(recipe?.ingredients?.length || 0)}</span></button><button type="button" role="tab" data-tandoor-recipe-tab="preparation" aria-selected="${recipeTab === "preparation"}" class="${recipeTab === "preparation" ? "active" : ""}"><ha-icon icon="mdi:chef-hat"></ha-icon>${haListManagerShoppingCardText("ui.preparation", {}, this._hass)} <span>${esc(steps.length)}</span></button></div>` : "";
    const ingredientContent = `<label class="tandoor-search-option tandoor-recipe-small-units"><input type="checkbox" data-tandoor-skip-small-units ${dialog.skipSmallUnits ? "checked" : ""}><span>${haListManagerShoppingCardText("recipes.skip_small_quantities", {}, this._hass)}</span></label><div class="tandoor-selection-actions"><button type="button" data-tandoor-select-all><ha-icon icon="mdi:checkbox-multiple-marked-outline"></ha-icon>${haListManagerShoppingCardText("ui.select_all", {}, this._hass)}</button><button type="button" data-tandoor-select-none><ha-icon icon="mdi:checkbox-multiple-blank-outline"></ha-icon>${haListManagerShoppingCardText("ui.deselect_all", {}, this._hass)}</button></div><div class="tandoor-ingredients">${rows}</div>`;
    const preparationContent = `<div class="tandoor-steps">${steps.map((step, index) => `<article class="tandoor-step"><span class="tandoor-step-number">${index + 1}</span><div>${step.name ? `<h3>${esc(step.name)}</h3>` : ""}${step.instruction ? `<p>${esc(step.instruction)}</p>` : ""}</div></article>`).join("")}</div>`;
    const servingsControl = servings ? `<div class="tandoor-servings"><span><strong>${haListManagerShoppingCardText("ui.servings", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("recipes.quantity_auto_adjusted", {}, this._hass)}</small></span><div><button type="button" data-tandoor-servings-change="-1" aria-label="${haListManagerShoppingCardText("recipes.one_serving_less", {}, this._hass)}"><ha-icon icon="mdi:minus"></ha-icon></button><input type="number" min="1" max="100" step="1" value="${esc(servings)}" data-tandoor-servings aria-label="${haListManagerShoppingCardText("recipes.servings", {}, this._hass)}"><button type="button" data-tandoor-servings-change="1" aria-label="${haListManagerShoppingCardText("recipes.increase_serving", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button></div></div>` : "";
    return `<div class="backdrop tandoor-backdrop" data-close-tandoor><section class="dialog tandoor-dialog tandoor-recipe-dialog" role="dialog" aria-modal="true"><header class="tandoor-recipe-header"><button class="icon-button tandoor-recipe-back" data-tandoor-back title="${haListManagerShoppingCardText("recipes.back_to_selection", {}, this._hass)}"><ha-icon icon="mdi:arrow-left"></ha-icon></button><div><h2>${esc(recipe?.name || haListManagerShoppingCardText("ui.recipe", {}, this._hass))}</h2><p>${servings ? haListManagerShoppingCardText("recipes.serving_count", {p0:(esc(servings))}, this._hass) : haListManagerShoppingCardText("recipes.select_ingredients", {}, this._hass)}</p></div><button class="icon-button" data-close-tandoor title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>${recipe?.image ? `<img class="tandoor-hero" src="${esc(recipe.image)}" alt="${esc(recipe.name)}">` : ""}${this._notice(dialog.status, "tandoor", "dialog-status error")}${servingsControl}${tabs}${recipeTab === "preparation" ? preparationContent : ingredientContent}<footer><button class="primary" data-add-tandoor ${this._busy || !dialog.selected.size ? "disabled" : ""}>${this._busy ? haListManagerShoppingCardText("ui.adding", {}, this._hass) : haListManagerShoppingCardText("ui.add_selection", {}, this._hass)}</button><button data-tandoor-back>${haListManagerShoppingCardText("ui.back", {}, this._hass)}</button><button data-close-tandoor>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }

  _renderBrowserChipMenu() {
    const menu = this._browserChipMenu;
    if (!menu?.chip) return "";
    if (menu.confirmAll) {
      return `<div class="backdrop confirmation-backdrop"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true"><span class="confirmation-icon"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon></span><h2>${haListManagerShoppingCardText("chips.delete_browser_confirm", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("chips.delete_browser_count", {p0:(this._browserChips.length)}, this._hass)}</p><footer><button class="danger filled" data-confirm-delete-browser-chips>${haListManagerShoppingCardText("ui.delete_all", {}, this._hass)}</button><button data-cancel-browser-chip-confirmation>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
    }
    const important = this._isChipImportant(menu.chip);
    const importantAction = this._config.show_important_chips !== false
      ? `<button type="button" data-toggle-important-chip><ha-icon icon="mdi:${important ? "alert-circle-minus-outline" : "alert-circle-plus-outline"}"></ha-icon><span><strong>${important ? haListManagerShoppingCardText("ui.remove_important_mark", {}, this._hass) : haListManagerShoppingCardText("ui.mark_important", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.this_list_only", {}, this._hass)}</small></span></button>`
      : "";
    const browserActions = menu.chip.browser
      ? `<button type="button" data-delete-browser-chip><ha-icon icon="mdi:delete-outline"></ha-icon><span><strong>${haListManagerShoppingCardText("chips.delete", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.remove_browser_chip_only", {}, this._hass)}</small></span></button><button type="button" data-delete-all-browser-chips><ha-icon icon="mdi:delete-sweep-outline"></ha-icon><span><strong>${haListManagerShoppingCardText("chips.delete_all_browser", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.clear_list_browser_chips", {}, this._hass)}</small></span></button>${this._config.allow_save_browser_chips !== false ? `<button type="button" data-save-browser-chip><ha-icon icon="mdi:content-save-outline"></ha-icon><span><strong>${haListManagerShoppingCardText("chips.save_to_this_list", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.chip_available_other_browsers", {}, this._hass)}</small></span></button>` : ""}`
      : "";
    const description = menu.chip.browser
      ? haListManagerShoppingCardText("ui.chip_browser_only", {}, this._hass)
      : menu.chip.categoryProduct
        ? haListManagerShoppingCardText("ui.quick_entry_product_linked", {}, this._hass)
        : haListManagerShoppingCardText("help.chip_mark_important", {}, this._hass);
    return `<div class="backdrop browser-chip-backdrop" data-close-browser-chip-menu><section class="dialog browser-chip-menu" role="dialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("chips.manage", {}, this._hass)}"><header><div><h2>${esc(menu.chip.name)}</h2><p>${esc(description)}</p></div><button class="icon-button" data-close-browser-chip-menu title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header>${this._notice(menu.status, "browser-chip", "dialog-status error")}<div class="browser-chip-actions">${importantAction}${browserActions}</div></section></div>`;
  }

  _closeBrowserChipMenu() {
    this._browserChipMenu = null;
    if (!this._dialog && !this._productPicker && !this._confirmation && !this._imageDialog && !this._chipDialog) this._unlockScroll();
    this._render();
  }

  async _saveBrowserChipPermanently() {
    const chip = this._browserChipMenu?.chip;
    if (!chip || this._config.allow_save_browser_chips === false || this._busy) return;
    this._busy = true;
    this._browserChipMenu.status = "";
    this._render();
    try {
      const wasImportant = this._isChipImportant(chip);
      const create = (productId) => haListManagerShoppingCardTextRequest(this._hass, {
        type: `${HA_LM_API}/chips/create`, name: chip.name, color: null,
        scope: "list", list_type: null, list_id: this._listId(), product_id: productId,
      });
      let result;
      try {
        result = await create(chip.product_id || null);
      } catch (error) {
        if (!chip.product_id || !["not_found", "product_not_found"].includes(error?.code)) throw error;
        result = await create(null);
      }
      if (wasImportant && result?.chip?.id) {
        try {
          await haListManagerShoppingCardTextRequest(this._hass, {
            type: `${HA_LM_API}/chips/important/set`, list_id: this._listId(),
            target_type: "chip", target_id: result.chip.id, important: true,
          });
        } catch (error) {
          // The chip already exists permanently at this point. Do not leave the
          // browser copy behind, because retrying would create a duplicate.
          this._error = haListManagerShoppingCardText("ui.chip_saved_important_failed", {p0:(error?.message || String(error))}, this._hass);
        }
      }
      this._removeBrowserChip(chip);
      this._browserChipMenu = null;
      this._unlockScroll();
      await this._load(true);
    } catch (error) {
      if (this._browserChipMenu) this._browserChipMenu.status = error?.message || String(error);
    } finally { this._busy = false; this._render(); }
  }

  async _toggleImportantChip(chip) {
    if (!chip || this._config.show_important_chips === false || this._busy) return;
    const important = !this._isChipImportant(chip);
    if (chip.browser) {
      if (important) this._importantBrowserChipIds.add(chip.id);
      else this._importantBrowserChipIds.delete(chip.id);
      this._saveImportantBrowserChips();
      this._closeBrowserChipMenu();
      return;
    }
    const target = this._importantChipTarget(chip);
    if (!target) return;
    this._busy = true;
    if (this._browserChipMenu) this._browserChipMenu.status = "";
    this._render();
    try {
      await haListManagerShoppingCardTextRequest(this._hass, {
        type: `${HA_LM_API}/chips/important/set`, list_id: this._listId(),
        ...target, important,
      });
      const key = `${target.target_type}:${target.target_id}`;
      if (important) this._importantChipKeys.add(key);
      else this._importantChipKeys.delete(key);
      this._browserChipMenu = null;
      this._unlockScroll();
    } catch (error) {
      if (this._browserChipMenu) this._browserChipMenu.status = error?.message || String(error);
    } finally { this._busy = false; this._render(); }
  }

  _renderProductPicker() {
    const picker = this._productPicker;
    if (!picker) return "";
    const choices = picker.products.map((product) => {
      const image = this._config.show_images
        ? product.image_url
          ? `<img src="${esc(product.image_url)}" alt="">`
          : `<span class="suggestion-placeholder"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`
        : "";
      const details = [product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : null].filter(Boolean).join(" · ");
      return `<button type="button" class="product-choice" data-product-choice="${esc(product.id)}">${image}<span><strong>${esc(product.name)}</strong><small>${esc(details || haListManagerShoppingCardText("products.no_further_details", {}, this._hass))}</small></span><ha-icon icon="mdi:chevron-right"></ha-icon></button>`;
    }).join("");
    return `<div class="backdrop" data-close-product-picker><section class="dialog product-choice-dialog" role="dialog" aria-modal="true" aria-label="${haListManagerShoppingCardText("ui.select_product", {}, this._hass)}" data-product-picker><header><div><h2>${haListManagerShoppingCardText("ui.select_product", {}, this._hass)}</h2><p>${haListManagerShoppingCardText("products.name_multiple_matches", {p0:(esc(picker.rawName))}, this._hass)}</p></div><button class="icon-button" data-close-product-picker title="${haListManagerShoppingCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header><div class="product-choices">${choices}</div><footer><button data-close-product-picker>${haListManagerShoppingCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }

  _renderInputRow() {
    const showChipButton = this._config.show_chip_popup_button !== false && (this._config.show_label_filter_button !== false || this._displayChips().length || this._dishes.length);
    const showCamera = this._config.show_camera_scan_button !== false && this._list?.provider === "local" && this._list?.list_type === "shopping";
    const cameraButton = showCamera ? `<button type="button" class="camera-scan-trigger" data-shopping-camera aria-label="${haListManagerShoppingCardText("scan.camera", {}, this._hass)}" title="${haListManagerShoppingCardText("scan.camera", {}, this._hass)}"><ha-icon icon="mdi:camera"></ha-icon></button>` : "";
    const inputActions = `<button type="button" class="clear-input ${showChipButton ? "with-chip-trigger" : ""}" data-clear-input aria-label="${haListManagerShoppingCardText("ui.clear_input", {}, this._hass)}" title="${haListManagerShoppingCardText("ui.clear_input", {}, this._hass)}" ${this._inputValue ? "" : "hidden"}><ha-icon icon="mdi:close-circle"></ha-icon></button>${showChipButton ? `<button type="button" class="chip-popup-trigger" data-open-chip-dialog aria-label="${haListManagerShoppingCardText("chips.open", {}, this._hass)}" title="${haListManagerShoppingCardText("chips.open", {}, this._hass)}"><ha-icon icon="mdi:gesture-tap-button"></ha-icon></button>` : ""}`;
    const inputClass = showChipButton ? "has-chip-trigger has-clear-input" : "has-clear-input";
    return `<div class="input-row">${this._config.show_quantity_box ? `<input class="quantity-input" data-quantity type="number" min="1" value="1" aria-label="${haListManagerShoppingCardText("ui.count", {}, this._hass)}">` : ""}<div class="product-input ${showCamera ? "with-camera" : ""}"><input class="${inputClass}" data-product-input value="${esc(this._inputValue)}" placeholder="${haListManagerShoppingCardText("ui.item_or_ean", {}, this._hass)}" autocomplete="off">${inputActions}${cameraButton}<div class="suggestions" data-suggestions ${this._suggestions.length && this._suggestionsVisible ? "" : "hidden"}>${this._suggestionsHtml()}</div></div>${this._config.show_submit_button ? `<button class="submit-button" data-add>${this._busy ? "…" : haListManagerShoppingCardText("ui.add", {}, this._hass)}</button>` : ""}</div>`;
  }

  _renderChips() {
    const filters = this._renderLabelFilterControls();
    const dishes = this._filteredDishes();
    const showNormalChips = !(this._config.show_chips === false) && this._displayChips().length;
    if (!dishes.length && !showNormalChips) return filters ? `<aside class="quick-chips label-filter-only" aria-label="${esc(this._filterText("title"))}">${filters}</aside>` : "";
    const dishSection = dishes.length ? `<section class="dish-chips"><h3>${haListManagerShoppingCardText("recipes.dishes", {}, this._hass)} <span>${dishes.length}</span></h3><div>${dishes.map((dish) => this._renderDishButton(dish)).join("")}</div></section>` : "";
    if (!showNormalChips) {
      const content = this._categoryChipsEnabled() ? this._renderChipCategoryGroups([], false, dishes) : dishSection;
      return `<aside class="quick-chips ${this._categoryChipsEnabled() ? "category-chip-view" : ""}" aria-label="${haListManagerShoppingCardText("recipes.dishes", {}, this._hass)}">${filters}${content}</aside>`;
    }
    const filtered = this._filteredChips();
    if (this._categoryChipsEnabled()) {
      const content = filtered.length || dishes.length ? this._renderChipCategoryGroups(filtered, false, dishes) : `<span class="chips-empty">${haListManagerShoppingCardText("ui.no_quick_entry_matches", {}, this._hass)}</span>`;
      const allExpanded = this._allChipCategoriesExpanded(filtered, dishes);
      return `<aside class="quick-chips category-chip-view" aria-label="${haListManagerShoppingCardText("ui.quick_entries", {}, this._hass)}">${filters}<section class="normal-chips"><h3>${haListManagerShoppingCardText("ui.quick_entries", {}, this._hass)} <button type="button" class="chip-category-toggle-all" data-toggle-chip-categories aria-expanded="${allExpanded}" aria-label="${haListManagerShoppingCardText("ui.all_categories_count", {p0:(allExpanded ? haListManagerShoppingCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerShoppingCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}" title="${haListManagerShoppingCardText("ui.all_categories_count", {p0:(allExpanded ? haListManagerShoppingCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerShoppingCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}">${filtered.length + dishes.length}</button></h3>${content}</section></aside>`;
    }
    const limit = this._config.chips_limit;
    const visible = this._chipsExpanded ? filtered : filtered.slice(0, limit);
    const remaining = Math.max(0, filtered.length - limit);
    const buttons = visible.map((chip) => this._renderChipButton(chip)).join("");
    const toggle = filtered.length > limit
      ? `<button type="button" class="chips-toggle" data-toggle-chips aria-expanded="${this._chipsExpanded}"><ha-icon icon="mdi:chevron-${this._chipsExpanded ? "up" : "down"}"></ha-icon>${this._chipsExpanded ? haListManagerShoppingCardText("ui.show_less", {}, this._hass) : limit === 0 ? haListManagerShoppingCardText("ui.show_chip_count", {p0:(remaining)}, this._hass) : haListManagerShoppingCardText("ui.show_more_count", {p0:(remaining)}, this._hass)}</button>`
      : "";
    const content = filtered.length ? buttons : `<span class="chips-empty">${haListManagerShoppingCardText("ui.no_quick_entry_matches", {}, this._hass)}</span>`;
    return `<aside class="quick-chips" aria-label="${haListManagerShoppingCardText("ui.quick_entries", {}, this._hass)}">${filters}<section class="normal-chips"><h3>${haListManagerShoppingCardText("ui.quick_entries", {}, this._hass)} <span>${filtered.length}</span></h3><div>${content}</div>${toggle}</section>${dishSection}</aside>`;
  }

  _filteredDishes() {
    const query = this._config.filter_chips === false ? "" : this._inputValue.trim().toLocaleLowerCase();
    return query ? this._dishes.filter((dish) => dish.name.toLocaleLowerCase().includes(query)) : this._dishes;
  }

  _renderDishButton(dish, dialog = false) {
    const color = dish.color || this._configuredChipColor(this._config.dish_color_rgb, "rgb(121, 85, 72)");
    return `<button type="button" class="${dialog ? "dialog-chip" : ""} dish-chip colored" data-${dialog ? "dialog-" : ""}dish="${esc(dish.id)}" style="--chip-color:${esc(color)}" title="${esc(dish.items.length)} ${dish.items.length === 1 ? haListManagerShoppingCardText("ui.ingredient", {}, this._hass) : haListManagerShoppingCardText("ui.ingredients", {}, this._hass)}"><ha-icon icon="mdi:food-variant"></ha-icon><span>${esc(dish.name)}</span></button>`;
  }

  _renderChipButton(chip, dialog = false, categoryColor = null, importantView = false) {
    const importantColor = this._configuredChipColor(this._config.important_chip_color_rgb, "rgb(244, 67, 54)");
    const useImportantColor = this._config.show_important_chips !== false
      && this._config.chip_color_mode !== "none"
      && (importantView || (!this._categoryChipsEnabled() && chip.important));
    const color = useImportantColor
      ? importantColor
      : this._config.category_chip_colors !== false && this._config.chip_color_mode !== "none" && categoryColor
        ? categoryColor
        : this._chipDisplayColor(chip);
    const borderColor = useImportantColor && chip.browser
      ? this._configuredChipColor(this._config.chip_color_browser_rgb, "rgb(121, 85, 72)")
      : null;
    const title = chip.browser ? haListManagerShoppingCardText("chips.add_hold_actions", {p0:(chip.name)}, this._hass) : chip.product_id ? haListManagerShoppingCardText("products.add_named", {p0:(chip.product_name || chip.name)}, this._hass) : haListManagerShoppingCardText("ui.add_named_item", {p0:(chip.name)}, this._hass);
    const listedHint = chip.listed ? " · " + haListManagerShoppingCardText("chips.already_listed", {}, this._hass) : "";
    const attribute = dialog ? "data-dialog-chip" : "data-quick-chip";
    const style = `${color ? `--chip-color:${esc(color)};` : ""}${borderColor ? `--chip-border-color:${esc(borderColor)};` : ""}`;
    return `<button type="button" class="${chip.listed ? "chip-listed " : ""}${dialog ? "dialog-chip " : ""}${chip.browser ? "browser-chip" : ""} ${color ? "colored" : ""}" ${attribute}="${esc(chip.id)}" style="${style}" title="${esc(title + listedHint)}">${esc(chip.name)}</button>`;
  }

  _renderChipCategoryGroups(chips, dialog = false, dishes = []) {
    const queryOpensGroups = !dialog && this._config.filter_chips !== false && Boolean(this._inputValue.trim());
    const groups = this._chipCategoryGroups(chips);
    if (dishes.length) groups.push({
      category: {
        id: "__dishes__", name: haListManagerShoppingCardText("recipes.dishes", {}, this._hass), icon: "mdi:food-variant",
        color: this._configuredChipColor(this._config.dish_color_rgb, "rgb(121, 85, 72)"),
      },
      dishes,
    });
    const layout = this._categoryChipLayout();
    if (["wrap", "compact"].includes(layout)) {
      const context = dialog ? "dialog" : "card";
      const fallbackId = groups.some(({ category }) => category.id === "__important__") ? "__important__" : null;
      const storedSelection = this._wrappedChipCategorySelection(context);
      const selectedId = storedSelection !== undefined ? storedSelection : fallbackId;
      const selectedExists = groups.some(({ category }) => (category.id || "__general__") === selectedId);
      const allExpanded = selectedId === "__all__";
      const activeId = selectedExists ? selectedId : null;
      const compact = layout === "compact";
      const flow = groups.map(({ category, chips: groupChips = [], dishes: groupDishes = [] }) => {
        const groupItems = groupDishes.length ? groupDishes : groupChips;
        const categoryId = category.id || "__general__";
        const active = allExpanded || activeId === categoryId;
        const style = category.color ? `--category-chip-color:${esc(category.color)}` : "";
        const expanded = queryOpensGroups || active;
        const selector = `<button type="button" class="chip-category-selector ${active ? "active" : ""}" data-chip-category="${esc(categoryId)}" data-chip-category-dialog="${dialog ? "1" : "0"}" aria-expanded="${expanded ? "true" : "false"}" style="${style}"><ha-icon icon="${esc(category.icon || "mdi:shape-outline")}"></ha-icon><strong>${esc(category.name)}</strong>${compact ? "" : `<span>${groupItems.length}</span><ha-icon class="chip-category-chevron" icon="mdi:chevron-${expanded ? "up" : "down"}"></ha-icon>`}</button>`;
        const itemButtons = groupDishes.length
          ? groupDishes.map((dish) => this._renderDishButton(dish, dialog)).join("")
          : groupChips.map((chip) => this._renderChipButton(chip, dialog, category.color || null, category.important === true)).join("");
        const panel = expanded ? `<section class="chip-category-expanded" style="${style}"><div class="chip-category-items">${itemButtons}</div></section>` : "";
        return `${selector}${panel}`;
      }).join("");
      return `<div class="chip-category-groups layout-${layout} ${dialog ? "dialog-chip-categories" : ""}"><div class="chip-category-flow">${flow}</div></div>`;
    }
    return `<div class="chip-category-groups layout-stacked ${dialog ? "dialog-chip-categories" : ""}">${groups.map(({ category, chips: groupChips = [], dishes: groupDishes = [] }) => {
      const groupItems = groupDishes.length ? groupDishes : groupChips;
      const categoryId = category.id || "__general__";
      const collapsed = queryOpensGroups ? false : this._chipCategoryCollapsed(categoryId);
      const style = category.color ? `--category-chip-color:${esc(category.color)}` : "";
      const itemButtons = groupDishes.length
        ? groupDishes.map((dish) => this._renderDishButton(dish, dialog)).join("")
        : groupChips.map((chip) => this._renderChipButton(chip, dialog, category.color || null, category.important === true)).join("");
      return `<section class="chip-category-group" style="${style}"><button type="button" class="chip-category-header" data-chip-category="${esc(categoryId)}" data-chip-category-dialog="${dialog ? "1" : "0"}" aria-expanded="${collapsed ? "false" : "true"}"><ha-icon icon="${esc(category.icon || "mdi:shape-outline")}"></ha-icon><strong>${esc(category.name)}</strong><span>${groupItems.length}</span><ha-icon class="chip-category-chevron" icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>${collapsed ? "" : `<div class="chip-category-items">${itemButtons}</div>`}</section>`;
    }).join("")}</div>`;
  }

  _configuredChipColor(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length === 3) {
      const channels = value.map(Number);
      if (channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
        return `rgb(${channels.map((channel) => Math.round(channel)).join(", ")})`;
      }
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
    const query = this._config.filter_chips !== false ? this._inputValue.trim().toLocaleLowerCase() : "";
    return query ? chips.filter((chip) => chip.name.toLocaleLowerCase().includes(query)) : chips;
  }

  _suggestionsHtml() {
    return this._suggestions.map((product) => {
      const details = [product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : null, haListManagerShoppingCardText("ui.product_database", {}, this._hass)].filter(Boolean).join(" · ");
      return `<button type="button" data-product-id="${esc(product.id)}">${this._config.show_images ? (product.image_url ? `<img src="${esc(product.image_url)}" alt="">` : `<span class="suggestion-placeholder"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`) : ""}<span><strong>${esc(product.name)}</strong><small>${esc(details)}</small></span></button>`;
    }).join("");
  }

  _renderItem(item) {
    const product = this._products.find((entry) => entry.id === item.product_id);
    const image = this._config.show_images
      ? (product?.image_url ? `<button type="button" class="item-image" data-view-item-image="${esc(item.id)}"><img src="${esc(product.image_url)}" alt="${esc(item.name)}"></button>` : `<span class="item-image placeholder"><ha-icon icon="mdi:image-off-outline"></ha-icon></span>`)
      : "";
    const controlsQuantity = this._config.quantity_position === "controls" ? `<strong class="controls-quantity">${Math.max(0, Number(item.quantity || 0))}</strong>` : "";
    return `<article class="item ${item.completed ? "completed" : ""} ${this._config.show_images ? "with-image" : "without-image"}" data-item-id="${esc(item.id)}"><button type="button" class="complete-button" data-complete title="${item.completed ? haListManagerShoppingCardText("ui.show_again", {}, this._hass) : haListManagerShoppingCardText("ui.mark_completed", {}, this._hass)}">${item.completed ? "✓" : "☐"}</button>${image}<button type="button" class="item-main" data-edit-item="${esc(item.id)}"><span class="item-name">${esc(this._displayName(item))}${item.offer_only ? ` <span class="offer-only-badge" title="${haListManagerShoppingCardText("ui.buy_on_offer_only", {}, this._hass)}"><ha-icon icon="mdi:tag-outline"></ha-icon>${haListManagerShoppingCardText("ui.special_offer", {}, this._hass)}</span>` : ""}</span>${item.description ? `<span class="meta">${esc(item.description)}</span>` : ""}${this._config.show_labels && item.labels?.length ? `<span class="labels">${this._renderLabels(item.labels)}</span>` : ""}</button>${this._config.show_plus_minus ? `<div class="quantity-actions"><button type="button" data-quantity-change="${esc(item.id)}:1" title="${haListManagerShoppingCardText("ui.increase_quantity", {}, this._hass)}">+</button>${controlsQuantity}<button type="button" data-quantity-change="${esc(item.id)}:-1" title="${haListManagerShoppingCardText("ui.decrease_count", {}, this._hass)}">−</button></div>` : ""}</article>`;
  }

  _contentHtml() {
    const groups = this._groups();
    if (!groups.length) return `<div class="empty">${this._loading ? haListManagerShoppingCardText("shopping.loading", {}, this._hass) : haListManagerShoppingCardText("ui.no_item_matches", {}, this._hass)}</div>`;
    const duplicateNames = groups.reduce((counts, { category }) => {
      const key = category.name.toLocaleLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map());
    return groups.map(({ category, items }) => {
      const collapsed = this._collapsed(category.id);
      const completed = items.filter((item) => item.completed).length;
      const count = this._config.show_category_count ? `<span class="count">(${completed}/${items.length})</span>` : "";
      const source = category.dynamic ? haListManagerShoppingCardText("ui.dynamic", {}, this._hass) : this._categoryScope(category);
      const sourceSuffix = duplicateNames.get(category.name.toLocaleLowerCase()) > 1 ? `<span class="category-source">· ${source}</span>` : "";
      return `<section class="category"><button type="button" class="category-header ${category.color ? "colored" : ""}" style="${category.color ? `--category-color:${esc(category.color)};--category-text-color:${categoryTextColor(category.color)}` : ""}" data-category="${esc(category.id)}" aria-expanded="${collapsed ? "false" : "true"}"><ha-icon icon="${esc(category.icon || (category.label ? "mdi:label-outline" : "mdi:shape-outline"))}"></ha-icon><strong>${esc(category.name)}</strong>${sourceSuffix}${count}<ha-icon class="chevron" icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>${collapsed ? "" : items.map((item) => this._renderItem(item)).join("")}</section>`;
    }).join("");
  }

  _resetLabelFilterScope() {
    clearTimeout(this._filterPressTimer); this._filterPressTimer = null;
    this._labelFiltersRequest++; this._savedLabelFilters = []; this._savedFilterScope = null;
    if (this._labelFilterDialog) { this._labelFilterDialog = null; this._unlockScroll(); }
  }
  _optionRowHtml() {
    const completed = this._items.filter((item) => item.completed).length;
    const groups = this._groups();
    const allExpanded = this._allCategoriesExpanded(groups);
    const byLabel = this._groupingMode() === "labels";
    const groupingTitle = haListManagerShoppingCardText(byLabel ? "ui.group_by_categories" : "ui.group_by_labels", {}, this._hass);
    const groupingToggle = this._labelGroupingEnabled()
      ? `<button type="button" class="${byLabel ? "active" : ""}" data-toggle-grouping aria-pressed="${byLabel}" aria-label="${groupingTitle}" title="${groupingTitle}"><ha-icon icon="${byLabel ? "mdi:label-multiple-outline" : "mdi:shape-outline"}"></ha-icon><span>${groupingTitle}</span></button>`
      : "";
    const categoryToggle = this._config.show_category_toggle_button !== false && groups.length
      ? `<button type="button" data-toggle-categories ${this._searchExpandsGroups() ? "disabled" : ""} aria-expanded="${allExpanded}" aria-label="${haListManagerShoppingCardText(byLabel ? "ui.all_labels_count" : "ui.all_categories_count", {p0:(allExpanded ? haListManagerShoppingCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerShoppingCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}" title="${haListManagerShoppingCardText(byLabel ? "ui.all_labels_count" : "ui.all_categories_count", {p0:(allExpanded ? haListManagerShoppingCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerShoppingCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}"><ha-icon icon="mdi:unfold-${allExpanded ? "less" : "more"}-horizontal"></ha-icon><span>${haListManagerShoppingCardText(byLabel ? "ui.all_labels_count" : "ui.all_categories_count", {p0:(allExpanded ? haListManagerShoppingCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerShoppingCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}</span></button>`
      : "";
    const clearCompleted = this._config.show_clear_completed_button !== false
      ? `<button type="button" data-clear-completed ${completed ? "" : "disabled"} title="${haListManagerShoppingCardText("shopping.delete_completed_items", {}, this._hass)}"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon><span>${haListManagerShoppingCardText("ui.delete_completed_count", {p0:(completed ? ` (${completed})` : "")}, this._hass)}</span></button>`
      : "";
    const offerFilter = this._renderFilterButton();
    const scannerTools = globalThis.HaListManagerShoppingScanner?.for(this).markup() || "";
    return offerFilter || groupingToggle || categoryToggle || clearCompleted || scannerTools ? `<div class="option-row">${offerFilter}${categoryToggle}${groupingToggle}${scannerTools}${clearCompleted}</div>` : "";
  }

  _refreshSearchView() {
    const suggestions = this.shadowRoot?.querySelector("[data-suggestions]");
    if (suggestions) {
      this._clearRenderListeners(suggestions);
      suggestions.innerHTML = this._suggestionsHtml();
      suggestions.hidden = !this._suggestions.length || !this._suggestionsVisible;
      this._bindDynamicContent(suggestions);
    }
    const clear = this.shadowRoot?.querySelector("[data-clear-input]");
    if (clear) clear.hidden = !this._inputValue;
    const content = this.shadowRoot?.querySelector("main");
    if (content) { this._clearRenderListeners(content); content.innerHTML = this._contentHtml(); this._bindDynamicContent(content); }
    const categoryToggle = this.shadowRoot?.querySelector("[data-toggle-categories]");
    if (categoryToggle) categoryToggle.disabled = this._searchExpandsGroups() || !this._groups().length;
    const chips = this.shadowRoot?.querySelector(".quick-chips");
    if (chips) {
      this._clearRenderListeners(chips);
      chips.outerHTML = this._renderChips();
      const nextChips = this.shadowRoot.querySelector(".quick-chips");
      if (nextChips) { this._bindChipActions(nextChips); this._bindLabelFilterControls(nextChips); }
    }
  }

  _chipStyles() {
    const size = this._config.chip_font_size;
    const listedStyle = "ha-card button.chip-listed{opacity:.45}ha-card button.chip-listed:hover{opacity:.7}ha-card button.chip-listed:focus-visible{opacity:1}";
    if (size == null) return listedStyle;
    const growth = Math.max(0, size - 16);
    const gap = 7 + growth / 2;
    const inline = "ha-card button[data-quick-chip],ha-card button[data-todo-chip],ha-card button[data-dish]";
    const popup = "ha-card button[data-dialog-chip],ha-card button[data-dialog-todo-chip],ha-card button[data-dialog-dish]";
    return `${listedStyle}${inline},${popup}{box-sizing:border-box;max-width:100%;font-size:${size}px;line-height:1.35;overflow-wrap:anywhere;touch-action:manipulation}
      ${inline}{min-height:${32 + growth * 2}px;padding:${4 + growth / 4}px ${11 + growth / 2}px;border-radius:${17 + growth}px}
      ${popup}{min-height:${38 + growth * 2}px;padding:${6 + growth / 4}px ${13 + growth / 2}px;border-radius:${20 + growth}px}
      ${inline.split(",").map(selector => `${selector} ha-icon`).join(",")},${popup.split(",").map(selector => `${selector} ha-icon`).join(",")}{--mdc-icon-size:${Math.max(18, size + 2)}px;flex-shrink:0}
      ha-card .chip-category-items,ha-card .chip-category-flow,ha-card .dialog-chip-grid,ha-card .todo-chip-category-items,ha-card .todo-chip-category-expanded>div,ha-card .todo-chip-flow,ha-card .todo-chip-dialog-grid,ha-card .normal-chips>div,ha-card .dish-chips>div,ha-card .quick-chips>div,ha-card .quick-chips-panel>div,ha-card .todo-chips>div{gap:${gap}px}
      ha-card .chip-category-header strong,ha-card .chip-category-selector strong,ha-card .todo-chip-category-head strong,ha-card .todo-chip-category-selector strong{font-size:${size}px;line-height:1.35}
      ha-card button.chip-category-header,ha-card button.chip-category-selector,ha-card button.todo-chip-category-head,ha-card button.todo-chip-category-selector{min-height:${40 + growth * 2}px}`;
  }

  _styles() {
    return `${globalThis.HaListManagerDialogSections.styles()}.product-label-preview p{margin:7px 0;overflow-wrap:anywhere;font-size:13px;line-height:1.45}.product-label-added{color:var(--success-color,#43a047)}.product-label-removed{padding-left:9px;border-left:3px solid var(--warning-color,#e0a526);color:var(--warning-color,#e0a526)}.product-label-scope-warning{line-height:1.45}

.dismissible-notice{align-items:center}.dismissible-notice .notice-text{flex:1;min-width:0;overflow-wrap:anywhere}.notice-dismiss{display:inline-grid!important;place-items:center;flex:0 0 32px;width:32px!important;height:32px!important;min-height:32px!important;padding:0!important;margin-left:auto;border:0!important;border-radius:50%!important;background:transparent!important;color:inherit!important;cursor:pointer}.notice-dismiss:hover,.notice-dismiss:focus-visible{background:color-mix(in srgb,currentColor 12%,transparent)!important}.notice-dismiss ha-icon{--mdc-icon-size:20px}.selection-field-heading{display:block;min-height:30px}.picker-popup-host{position:relative}.picker-trigger-host.picker-popup-host input{padding-right:86px!important}.picker-popup-host>.picker-list-trigger{right:44px}.picker-popup-host>.selection-open{position:absolute;z-index:4;right:4px;top:50%;display:grid;place-items:center;width:34px;height:34px;min-width:34px;min-height:34px;padding:0;transform:translateY(-50%);border:0;border-radius:50%;color:var(--primary-color);background:transparent;cursor:pointer}.selection-open:hover,.selection-open:focus-visible{background:color-mix(in srgb,var(--primary-color) 16%,transparent)}.selection-open:disabled,.picker-list-trigger:disabled{opacity:.4;cursor:default}.selection-open ha-icon{--mdc-icon-size:21px}.selection-backdrop{z-index:1250}.dialog.selection-dialog{width:min(640px,100%);display:flex;flex-direction:column;max-height:calc(100dvh - 36px)}.selection-dialog header{flex:0 0 auto}.selection-dialog header h2{min-width:0;overflow-wrap:anywhere}.selection-search{flex:0 0 auto;margin-top:14px}.selection-grid{display:flex;flex-wrap:wrap;align-content:flex-start;gap:9px;overflow:auto;overscroll-behavior:contain;min-height:0;margin-top:16px;padding:3px;max-height:55dvh}.selection-chip{display:flex;align-items:center;gap:8px;min-height:46px;max-width:100%;padding:7px 11px;border:1px solid color-mix(in srgb,var(--selection-color,var(--primary-color)) 60%,var(--divider-color));border-radius:22px;color:var(--primary-text-color);background:color-mix(in srgb,var(--selection-color,var(--primary-color)) 16%,var(--card-background-color));text-align:left;cursor:pointer}.selection-chip.selected{outline:2px solid var(--primary-color);outline-offset:1px}.selection-chip>span{display:flex;flex-direction:column;min-width:0;gap:2px}.selection-chip strong{font-size:14px;overflow-wrap:anywhere}.selection-chip small{font-size:11px;color:var(--secondary-text-color)}.selection-chip>ha-icon:not(.selection-check){--mdc-icon-size:20px;box-sizing:content-box;padding:4px;border-radius:50%;color:var(--selection-ink,#fff);background:var(--selection-color,var(--primary-color));flex:0 0 auto}.selection-chip .selection-check{--mdc-icon-size:18px;color:var(--primary-text-color)}.selection-dialog footer{flex:0 0 auto;margin-top:18px}.selection-dialog input[type=search]{width:100%}@media(max-width:600px){.selection-grid{gap:8px}.selection-chip{padding:7px 9px}.dialog.selection-dialog{max-height:calc(100dvh - 24px)}}
      .edit-shortcuts{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px;position:static}.edit-shortcut{display:grid;place-items:center;flex:0 0 44px;width:44px;height:44px;padding:0;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-color);background:var(--secondary-background-color);cursor:pointer;touch-action:manipulation}.edit-shortcut ha-icon{--mdc-icon-size:24px}.edit-shortcut:hover{background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.edit-shortcut:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}.edit-shortcut:disabled{opacity:.4;cursor:default}.product-dialog:has(.edit-shortcuts) .dialog-image-button{top:132px}
      .item-dialog-header-actions{display:flex;align-items:center;gap:4px;margin-left:auto}.item-actions{position:relative;flex:0 0 auto}.item-actions-menu{position:absolute;z-index:20;top:calc(100% + 5px);right:0;display:grid;width:min(290px,calc(100vw - 60px));overflow:hidden;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);box-shadow:0 8px 26px rgba(0,0,0,.38)}.item-actions-menu>button{display:flex;align-items:center;gap:9px;min-height:46px;width:100%;padding:10px 12px;border:0;border-radius:0;text-align:left;white-space:normal;background:transparent}.item-actions-menu>button:not(:disabled):hover{background:var(--secondary-background-color)}.item-actions-menu>button>ha-icon{flex:0 0 auto;--mdc-icon-size:21px;color:var(--primary-color)}.item-actions-menu>small{padding:0 12px 12px;color:var(--secondary-text-color);font-size:12px;line-height:1.4}.item-action-dialog{width:min(480px,100%)}.item-action-dialog>p{line-height:1.5}.item-action-dialog select{width:100%;min-height:45px;padding:10px 12px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color);font:inherit}.item-action-result{margin:10px 0}.dialog-status.success{color:var(--success-color,#43a047)}



      .dish-chips{margin-top:12px;padding-top:12px;border-top:1px solid var(--divider-color)}.dish-chips>div,.normal-chips>div{display:flex;flex-wrap:wrap;gap:7px}.dish-chip{display:inline-flex;align-items:center;gap:6px}.dish-chip ha-icon{--mdc-icon-size:18px}.dialog-dishes{margin-top:18px;padding-top:18px;border-top:1px solid var(--divider-color)}.dialog-dishes h3{margin:0;color:var(--secondary-text-color);font-size:14px}.dish-dialog-backdrop{z-index:1180}.dish-add-dialog{width:min(760px,100%)}.dish-add-dialog header{align-items:flex-start}.dish-add-dialog header>div{min-width:0;flex:1}.dish-add-dialog header p{margin:4px 0 0;color:var(--secondary-text-color);line-height:1.4}.dish-choices{display:grid;gap:8px;margin-top:18px}.dialog .dish-choice{display:grid;grid-template-columns:24px minmax(130px,1fr) minmax(155px,190px) 86px;align-items:center;gap:8px 10px;margin:0;padding:10px 11px;border:1px solid var(--divider-color);border-radius:9px;color:var(--primary-text-color);background:var(--secondary-background-color)}.dialog .dish-choice.selected{border-color:color-mix(in srgb,var(--primary-color) 65%,var(--divider-color))}.dish-choice>input[type=checkbox]{width:20px;min-height:20px;padding:0;accent-color:var(--primary-color)}.dish-choice>span:not(.dish-category-locked){display:flex;min-width:0;flex-direction:column;gap:3px}.dish-choice small{color:var(--secondary-text-color);font-size:12px;line-height:1.25}.dish-choice>input[type=number]{grid-column:4;grid-row:1;min-height:40px}.dish-category-combo,.dish-category-locked{grid-column:3;grid-row:1;min-width:0;color:var(--primary-text-color);text-align:left}.dish-category-combo{position:relative;z-index:1}.dish-category-combo:focus-within{z-index:30}.dialog .dish-category-combo>input{width:100%;min-width:0;min-height:40px;height:40px;padding:7px 10px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit}.dialog .dish-category-combo.unresolved>input{border-color:var(--error-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--error-color) 35%,transparent)}.dish-category-combo>.category-picker-options{min-width:240px}.dish-category-locked{display:flex;flex-direction:column;align-items:stretch;gap:3px}.dish-category-locked>small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dish-category-locked strong{overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.dish-add-dialog footer{justify-content:flex-start}@media(max-width:600px){.dish-add-dialog{width:100%}.dialog .dish-choice{grid-template-columns:24px minmax(0,1fr) 78px}.dish-choice>input[type=number]{grid-column:3}.dish-category-combo,.dish-category-locked{grid-column:2/4;grid-row:2}.dish-category-combo>.category-picker-options{min-width:100%}.dish-category-locked{display:flex;flex-direction:row;align-items:center;gap:8px}.dish-category-locked>small{margin-left:auto;text-align:right}}
      .tandoor-backdrop{z-index:1190}.tandoor-dialog{width:min(820px,100%)}.tandoor-dialog header{align-items:flex-start}.tandoor-dialog header>div{min-width:0;flex:1}.tandoor-dialog header p{margin:4px 0 0;color:var(--secondary-text-color)}.tandoor-filters{display:grid;gap:10px;margin-top:18px}.tandoor-filters>label:not(.tandoor-search){display:grid;gap:5px}.tandoor-filters>label>span,.tandoor-filters>small{color:var(--secondary-text-color);font-size:13px}.tandoor-filters select{min-height:46px;padding:0 12px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);background:var(--secondary-background-color)}.tandoor-search{display:grid!important;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:5px;margin:0!important;padding:0 6px 0 10px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color)}.tandoor-search input{min-height:46px!important;padding:0!important;border:0!important;outline:0;background:transparent!important}.tandoor-search ha-icon{color:var(--secondary-text-color)}.tandoor-results,.tandoor-ingredients{display:grid;gap:8px;margin-top:14px}.tandoor-recipe{display:grid;grid-template-columns:62px minmax(0,1fr) 28px;align-items:center;gap:11px;width:100%;min-height:72px;padding:8px;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-text-color);background:var(--secondary-background-color);text-align:left;cursor:pointer}.tandoor-recipe:hover{border-color:var(--primary-color)}.tandoor-recipe img,.tandoor-image-placeholder{display:grid;place-items:center;width:62px;height:56px;border-radius:7px;object-fit:cover;background:var(--card-background-color)}.tandoor-recipe>span:nth-child(2){display:flex;min-width:0;flex-direction:column;gap:4px}.tandoor-recipe strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tandoor-recipe small{color:var(--secondary-text-color)}.tandoor-state{display:flex;align-items:center;justify-content:center;gap:10px;min-height:90px;color:var(--secondary-text-color)}.tandoor-hero{display:block;width:100%;max-height:230px;margin-top:16px;border-radius:10px;object-fit:cover}.tandoor-ingredient{display:grid;gap:7px;padding:11px 12px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}.tandoor-ingredient.selected{border-color:color-mix(in srgb,var(--primary-color) 65%,var(--divider-color))}.tandoor-ingredient-main,.tandoor-option{display:flex!important;flex-direction:row!important;align-items:center;gap:10px;margin:0!important;color:var(--primary-text-color)!important}.tandoor-ingredient-main input,.tandoor-option input{flex:0 0 auto;width:20px!important;min-height:20px!important;padding:0!important;accent-color:var(--primary-color)}.tandoor-ingredient-main>span{display:flex;min-width:0;flex-direction:column;gap:2px}.tandoor-ingredient-main small,.tandoor-option{color:var(--secondary-text-color)!important;font-size:13px}.tandoor-option{justify-self:start;width:fit-content;max-width:100%;padding-left:30px;touch-action:pan-y}.tandoor-option strong{color:var(--primary-text-color);font-weight:500}.tandoor-recipe-dialog footer{justify-content:flex-start}@media(max-width:600px){.tandoor-dialog{width:100%}.tandoor-hero{max-height:170px}.tandoor-option{padding-left:0}}
      .tandoor-search-options{display:flex;flex-wrap:wrap;gap:8px 18px}.tandoor-search-option{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;width:max-content;margin:0!important;color:var(--secondary-text-color)!important;font-size:13px}.tandoor-recipe-small-units{margin-top:14px!important}.tandoor-search-option input{width:18px!important;min-height:18px!important;margin:0!important;padding:0!important;accent-color:var(--primary-color)}.tandoor-search-actions{display:flex;align-items:center;gap:2px}.tandoor-search-actions button{display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;color:var(--secondary-text-color);background:transparent;cursor:pointer}.tandoor-search-actions button:hover{color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 8%,transparent)}.tandoor-search-actions ha-circular-progress{width:24px;height:24px}.tandoor-cookbooks{display:grid;gap:8px;margin-top:18px}.tandoor-cookbooks h3{margin:0 0 2px;font-size:16px}.tandoor-cookbooks .tandoor-cookbooks-heading{margin-top:10px}.tandoor-all-recipes{border-color:color-mix(in srgb,var(--primary-color) 55%,var(--divider-color));background:color-mix(in srgb,var(--primary-color) 7%,var(--secondary-background-color))}.tandoor-cookbook{display:grid;grid-template-columns:42px minmax(0,1fr) 28px;align-items:center;gap:10px;width:100%;min-height:60px;padding:8px 10px;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-text-color);background:var(--secondary-background-color);text-align:left;cursor:pointer}.tandoor-cookbook:hover{border-color:var(--primary-color)}.tandoor-cookbook-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:9px;color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.tandoor-scope{display:flex;align-items:center;gap:10px;margin-top:16px;padding:9px 11px;border-radius:10px;background:color-mix(in srgb,var(--primary-color) 10%,var(--secondary-background-color))}.tandoor-scope button{display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid var(--divider-color);border-radius:50%;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.tandoor-scope span{display:flex;min-width:0;flex-direction:column}.tandoor-scope small{color:var(--secondary-text-color)}.tandoor-scope strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tandoor-recipe-header{display:grid!important;grid-template-columns:42px minmax(0,1fr) 42px;gap:10px}.tandoor-recipe-header>div{align-self:center}.tandoor-recipe-back{align-self:start}.tandoor-selection-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.tandoor-selection-actions button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 11px;border:1px solid var(--divider-color);border-radius:18px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.tandoor-selection-actions button:hover{border-color:var(--primary-color)}.tandoor-selection-actions ha-icon{--mdc-icon-size:18px;color:var(--primary-color)}.tandoor-recipe-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-top:14px;padding:4px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}.tandoor-recipe-tabs button{display:flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 12px;border:0;border-radius:7px;color:var(--secondary-text-color);background:transparent;font:inherit;cursor:pointer}.tandoor-recipe-tabs button.active{color:var(--primary-text-color);background:var(--card-background-color);box-shadow:0 1px 3px rgba(0,0,0,.18)}.tandoor-recipe-tabs button span{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:color-mix(in srgb,var(--primary-text-color) 9%,transparent);font-size:12px}.tandoor-recipe-tabs ha-icon{--mdc-icon-size:19px;color:var(--primary-color)}.tandoor-steps{display:grid;gap:10px;margin-top:14px}.tandoor-step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:11px;padding:13px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}.tandoor-step-number{display:grid;place-items:center;align-self:start;width:32px;height:32px;border-radius:50%;color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-color) 18%,var(--card-background-color));font-weight:700}.tandoor-step h3{margin:2px 0 7px;font-size:15px}.tandoor-step p{margin:2px 0;white-space:pre-wrap;line-height:1.5}.tandoor-servings{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px;padding:10px 12px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}.tandoor-servings>span{display:flex;min-width:0;flex-direction:column;gap:2px}.tandoor-servings small{color:var(--secondary-text-color);font-size:12px}.tandoor-servings>div{display:grid;grid-template-columns:38px 58px 38px;align-items:center}.tandoor-servings button{display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid var(--divider-color);color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.tandoor-servings button:first-child{border-radius:8px 0 0 8px}.tandoor-servings button:last-child{border-radius:0 8px 8px 0}.tandoor-servings input{width:58px!important;min-height:38px!important;padding:0 4px!important;border-width:1px 0!important;border-radius:0!important;text-align:center;background:var(--card-background-color)!important}@media(max-width:480px){.tandoor-servings{align-items:flex-start;flex-direction:column}.tandoor-servings>div{align-self:flex-end}}
      .tandoor-ingredient-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,280px);align-items:center;gap:10px}.tandoor-ingredient-main{justify-self:start;width:fit-content;max-width:100%;touch-action:pan-y}.tandoor-ingredient-head .dish-category-combo{grid-column:auto;grid-row:auto}.tandoor-category-locked{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:2px;padding:4px 8px}.tandoor-category-locked strong{overflow:hidden;max-width:100%;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.tandoor-category-locked small{color:var(--secondary-text-color);font-size:11px}@media(max-width:600px){.tandoor-ingredient-head{grid-template-columns:1fr}.tandoor-category-combo,.tandoor-category-locked{margin-left:30px}.tandoor-category-locked{padding-left:0}}
      .quick-chips{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--divider-color)}.quick-chips h3{display:flex;align-items:center;gap:6px;margin:0 0 8px;color:var(--secondary-text-color);font-size:13px;font-weight:500}.quick-chips h3 span,.quick-chips h3 .chip-category-toggle-all{display:inline-grid;place-items:center;min-width:22px;height:22px;min-height:22px;padding:0 6px;border:0;border-radius:11px;color:inherit;background:var(--secondary-background-color);font-size:12px}.quick-chips h3 .chip-category-toggle-all:hover,.quick-chips h3 .chip-category-toggle-all:focus-visible{color:var(--primary-color);outline:1px solid var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--secondary-background-color))}.quick-chips>div{display:flex;flex-wrap:wrap;gap:7px}.quick-chips button{min-height:32px;padding:4px 11px;border:1px solid var(--divider-color);border-radius:17px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.quick-chips button.colored{border-color:color-mix(in srgb,var(--chip-border-color,var(--chip-color)) 70%,var(--divider-color));background:color-mix(in srgb,var(--chip-color) 20%,var(--card-background-color))}.quick-chips button:hover{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.quick-chips button.colored:hover{border-color:var(--chip-border-color,var(--chip-color));background:color-mix(in srgb,var(--chip-color) 30%,var(--card-background-color))}.quick-chips .chips-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:9px;padding:3px 9px;color:var(--primary-color);background:transparent}.chips-toggle ha-icon{--mdc-icon-size:18px}.chips-empty{color:var(--secondary-text-color);font-size:13px}.chip-category-groups,.quick-chips>.chip-category-groups{display:grid;gap:7px;width:100%}.chip-category-group,.chip-category-expanded{min-width:0;overflow:hidden;border:1px solid var(--divider-color);border-radius:9px}.quick-chips .chip-category-header,.chip-category-header{display:grid;grid-template-columns:24px minmax(0,1fr) auto 22px;align-items:center;gap:7px;width:100%;min-height:40px;padding:6px 8px;border:0;border-radius:0;color:var(--primary-text-color);background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 15%,var(--card-background-color));text-align:left;cursor:pointer}.quick-chips .chip-category-header:hover,.chip-category-header:hover{border:0;background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 23%,var(--card-background-color))}.chip-category-header>ha-icon:first-child{--mdc-icon-size:20px;color:var(--category-chip-color,var(--primary-color))}.chip-category-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.chip-category-header>span{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;color:var(--secondary-text-color);background:color-mix(in srgb,var(--primary-text-color) 8%,transparent);font-size:12px}.chip-category-chevron{--mdc-icon-size:19px;color:var(--secondary-text-color)}.chip-category-items{display:flex;flex-wrap:wrap;gap:7px;padding:8px;border-top:1px solid var(--divider-color);background:color-mix(in srgb,var(--secondary-background-color) 40%,transparent)}.chip-category-expanded .chip-category-items{border-top:0}.chip-category-flow{display:flex;flex-wrap:wrap;gap:7px;width:100%}.chip-category-flow>.chip-category-expanded{flex:0 0 100%;width:100%}.quick-chips .chip-category-selector,.chip-category-selector{display:grid;grid-template-columns:22px minmax(0,auto) auto 19px;align-items:center;gap:6px;max-width:100%;min-height:40px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 52%,var(--divider-color));border-radius:9px;color:var(--primary-text-color);background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 15%,var(--card-background-color));text-align:left}.quick-chips .chip-category-selector:hover,.chip-category-selector:hover,.quick-chips .chip-category-selector.active,.chip-category-selector.active{border-color:var(--category-chip-color,var(--primary-color));background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 27%,var(--card-background-color))}.chip-category-selector>ha-icon:first-child{--mdc-icon-size:19px;color:var(--category-chip-color,var(--primary-color))}.chip-category-selector strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.chip-category-selector>span{display:grid;place-items:center;min-width:21px;height:21px;padding:0 6px;border-radius:11px;color:var(--secondary-text-color);background:color-mix(in srgb,var(--primary-text-color) 8%,transparent);font-size:12px}.layout-compact .chip-category-selector{grid-template-columns:20px minmax(0,auto);min-height:34px;padding:4px 9px;border-radius:18px}.dialog-chip-categories{display:grid;gap:9px;margin-top:18px}.dialog-chip-categories .chip-category-header{min-height:46px;padding:7px 11px}.dialog-chip-categories .chip-category-items{padding:10px}.view-panel.chips-position-auto .card-layout,.chips-position-right .card-layout,:host([data-expanded-view]) .chips-position-auto .card-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);align-items:start;gap:16px}.view-panel.chips-position-auto .card-layout>.quick-chips,.chips-position-right .card-layout>.quick-chips,:host([data-expanded-view]) .chips-position-auto .card-layout>.quick-chips{grid-column:2;grid-row:1;margin:0;padding:0 0 0 16px;border-top:0;border-left:1px solid var(--divider-color)}.view-panel.chips-position-auto .card-layout>.list-column,.chips-position-right .card-layout>.list-column,:host([data-expanded-view]) .chips-position-auto .card-layout>.list-column{grid-column:1;grid-row:1;min-width:0}
      *{box-sizing:border-box}[hidden]{display:none!important}.offer-only-choice{display:flex!important;flex-direction:row!important;align-items:center;gap:9px}.offer-only-choice input{width:20px!important;min-height:20px!important;height:20px}.offer-only-badge{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:10px;background:var(--warning-color,#e0a526);color:#111;font-size:10px;font-weight:600;line-height:1.5;white-space:nowrap;vertical-align:middle}.offer-only-badge ha-icon{--mdc-icon-size:13px}:host{display:block;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,inherit);container-type:inline-size}:host([data-expanded-view]){position:fixed!important;top:var(--expanded-top,56px)!important;right:var(--expanded-right,0)!important;bottom:var(--expanded-bottom,0)!important;left:var(--expanded-left,0)!important;z-index:9998;min-width:0!important;max-width:none!important;padding:16px;overflow:hidden;background:var(--primary-background-color,#111)}:host([data-expanded-view]) ha-card{height:100%;min-height:0!important;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,.45)}button,input{font:inherit}button:disabled{opacity:.45;cursor:not-allowed}ha-card{padding:12px 14px 18px;overflow:visible}.view-panel{min-height:100vh;border:0!important;border-radius:0!important;background:var(--ha-card-background,var(--card-background-color))!important;box-shadow:none!important}.view-panel.list-collapsed{min-height:0}.card-title{display:flex;align-items:center;gap:8px;height:50px;min-height:50px;margin:0 0 8px}.list-collapsed{height:76px;padding:12px 14px}.list-collapsed .card-title{margin:0}.card-title-toggle{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;flex:1;min-width:0;align-items:center}.title-icon{display:grid;grid-column:1;place-items:center;width:35px;height:35px;padding:5px;border-radius:50%;color:var(--primary-color)}.title-icon ha-icon{--mdc-icon-size:25px}.title-expand-toggle{border:0;background:transparent;cursor:pointer}.title-static-icon{pointer-events:none}.title-expand-toggle:hover,.title-expand-toggle:focus-visible{outline:0;background:color-mix(in srgb,var(--primary-text-color) 12%,transparent)}.card-title-copy{display:grid;grid-column:2;grid-template-rows:auto auto;row-gap:1px;min-width:0;padding:0;border:0;color:var(--primary-text-color);background:transparent;text-align:left}.card-title-copy[data-toggle-list],.card-title-copy[data-toggle-expanded-view]{cursor:pointer}.card-title-copy[data-toggle-list]:hover,.card-title-copy[data-toggle-expanded-view]:hover{background:color-mix(in srgb,var(--primary-text-color) 5%,transparent)}.card-title-copy>span{overflow:hidden;font-size:24px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}.card-title-copy small{color:var(--secondary-text-color);font-size:13px;font-weight:400;white-space:nowrap}.title-actions{display:flex;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;gap:6px}.title-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 11px;border:1px solid var(--divider-color);border-radius:19px;color:var(--primary-color);background:transparent;cursor:pointer}.title-action ha-icon{--mdc-icon-size:20px}.title-action span{font-size:13px}.send-status{display:flex;align-items:center;gap:7px;margin:8px 0;padding:8px 10px;border-left:3px solid var(--success-color,#43a047);border-radius:5px;background:color-mix(in srgb,var(--success-color,#43a047) 10%,transparent);font-size:13px}.send-status ha-icon{--mdc-icon-size:19px;color:var(--success-color,#43a047)}.send-status>ha-icon{flex:0 0 19px;width:19px;height:19px}.option-row{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 10px;padding:6px;border-radius:8px;background:var(--secondary-background-color)}.option-row button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 10px;border:1px solid var(--divider-color);border-radius:9px;color:var(--secondary-text-color);background:var(--card-background-color);cursor:pointer}.option-row button:not(:disabled):hover,.option-row button:not(:disabled):focus-visible{color:var(--primary-color);border-color:var(--primary-color);outline:0;background:color-mix(in srgb,var(--primary-color) 10%,var(--card-background-color))}.option-row button:disabled{opacity:.45;cursor:default}.option-row button.active{color:var(--primary-color);border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,var(--card-background-color))}.option-row ha-icon{--mdc-icon-size:19px}.input-row{display:grid;grid-template-columns:92px minmax(160px,1fr) auto;gap:8px;margin:8px 0 14px}.input-row:not(:has(.quantity-input)){grid-template-columns:minmax(160px,1fr) auto}.input-row:not(:has(.submit-button)){grid-template-columns:92px minmax(160px,1fr)}.input-row:not(:has(.quantity-input)):not(:has(.submit-button)){grid-template-columns:1fr}.input-row input{width:100%;height:44px;padding:0 11px;border:1px solid var(--divider-color);border-radius:6px;color:var(--primary-text-color);background:var(--secondary-background-color)}.product-input{position:relative}.product-input>input.has-clear-input{padding-right:42px}.product-input>input.has-chip-trigger{padding-right:78px}.clear-input,.chip-popup-trigger{position:absolute;z-index:3;top:5px;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer}.clear-input{right:5px;color:var(--secondary-text-color)}.clear-input.with-chip-trigger{right:39px}.chip-popup-trigger{right:5px;color:var(--primary-color)}.clear-input:hover,.chip-popup-trigger:hover{color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 10%,transparent)}.clear-input ha-icon{--mdc-icon-size:20px}.chip-popup-trigger ha-icon{--mdc-icon-size:21px}.submit-button{padding:0 16px;border:0;border-radius:6px;color:#fff;background:var(--primary-color);cursor:pointer}.product-input.with-camera>input{padding-right:78px}.product-input.with-camera>input.has-chip-trigger{padding-right:114px}.camera-scan-trigger{position:absolute;z-index:3;top:5px;right:5px;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;color:var(--primary-color);background:transparent;cursor:pointer}.camera-scan-trigger ha-icon{--mdc-icon-size:21px}.product-input.with-camera .chip-popup-trigger{right:39px}.product-input.with-camera .clear-input{right:39px}.product-input.with-camera .clear-input.with-chip-trigger{right:73px}.option-row button.list-scanner.scan-active,.option-row button.list-scanner.scan-active:not(:disabled):hover,.option-row button.list-scanner.scan-active:not(:disabled):focus-visible{color:var(--success-color,#43a047);border-color:currentColor;background:color-mix(in srgb,var(--success-color,#43a047) 14%,var(--card-background-color))}.option-row .scan-queue-count{display:none}.suggestions{position:absolute;z-index:20;top:calc(100% + 4px);left:0;right:0;max-height:310px;overflow:auto;border:1px solid var(--divider-color);border-radius:7px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35);overscroll-behavior:contain}.suggestions button{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:9px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.suggestions button:hover{background:var(--secondary-background-color)}.suggestions img,.suggestion-placeholder{display:grid;place-items:center;width:38px;height:38px;border-radius:5px;object-fit:contain;background:var(--secondary-background-color)}.suggestions button>span:last-child{display:flex;flex-direction:column;gap:2px}.suggestions small,.field-help{color:var(--secondary-text-color);font-size:13px}.meta{color:var(--secondary-text-color);font-size:var(--ha-list-manager-secondary-font-size);line-height:1}.error{display:flex;align-items:center;gap:7px;margin:8px 0;color:var(--error-color)}.category{margin-top:8px}.category-header{display:flex;align-items:center;gap:6px;width:100%;min-height:37px;padding:5px 8px;border:0;border-radius:4px;color:var(--primary-text-color);background:var(--category-color,var(--secondary-background-color));text-align:left;cursor:pointer}.category-header.colored{color:var(--category-text-color,#fff)}.category-header strong{font-size:var(--ha-list-manager-category-font-size)}.category-header>ha-icon{--mdc-icon-size:var(--ha-list-manager-category-icon-size)}.category-header .count{margin-left:2px;font-size:var(--ha-list-manager-category-secondary-font-size);font-weight:400}.category-source{font-size:var(--ha-list-manager-category-secondary-font-size);font-weight:400;opacity:.85}.category-header .chevron{margin-left:auto}.item{display:grid;align-items:center;padding:0 4px;border-bottom:0}.category-header+.item,.item+.item{padding-top:var(--ha-list-manager-item-divider-after-spacing)}.item:not(:last-child){padding-bottom:var(--ha-list-manager-item-divider-before-spacing)}.item-dividers .item{position:relative}.item-dividers .item:not(:last-child){padding-bottom:calc(var(--ha-list-manager-item-divider-before-spacing) + 1px)}.item-dividers .item:not(:last-child)::after{content:"";position:absolute;z-index:1;left:4px;right:4px;bottom:0;height:1px;background:color-mix(in srgb,var(--divider-color) 55%,transparent);pointer-events:none}.item.with-image{grid-template-columns:38px 46px minmax(0,1fr) auto}.item.without-image{grid-template-columns:38px minmax(0,1fr) auto}.item.completed{color:var(--success-color,#43a047);opacity:.7}.item.completed .item-name{text-decoration:line-through}.complete-button,.quantity-actions button,.item-image{display:grid;place-items:center;padding:0;border:0;color:inherit;background:transparent;cursor:pointer}.complete-button{align-self:center;width:34px;height:34px;font-size:18px}.item-image{align-self:center;width:42px;height:42px;border-radius:6px;overflow:hidden}.item-image img{width:100%;height:100%;object-fit:contain;background:var(--secondary-background-color)}.item-image.placeholder{color:var(--secondary-text-color);background:var(--secondary-background-color)}.item-main{display:flex;flex-direction:column;align-items:flex-start;align-self:center;gap:2px;min-width:0;padding:0 6px;border:0;color:inherit;background:transparent;text-align:left;cursor:pointer}.item-name{font-size:var(--ha-list-manager-item-font-size);line-height:1}.labels{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}.label{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;line-height:1;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 55%,var(--divider-color));border-radius:14px;color:var(--primary-text-color);background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent);font-size:var(--ha-list-manager-tertiary-font-size)}.label ha-icon{--mdc-icon-size:13px;color:var(--label-color,var(--primary-color))}.quantity-actions{align-self:center;display:flex;align-items:center;gap:2px}.quantity-actions button{width:38px;height:38px;font-size:19px}.controls-quantity{min-width:34px;text-align:center;font-size:var(--ha-list-manager-item-font-size)}.empty{padding:22px;text-align:center;color:var(--secondary-text-color)}
      .backdrop{--dialog-inset-top:max(18px,env(safe-area-inset-top,0px),var(--safe-area-inset-top,0px));--dialog-inset-bottom:max(18px,env(safe-area-inset-bottom,0px),var(--safe-area-inset-bottom,0px));position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:var(--dialog-inset-top) max(18px,env(safe-area-inset-right,0px),var(--safe-area-inset-right,0px)) var(--dialog-inset-bottom) max(18px,env(safe-area-inset-left,0px),var(--safe-area-inset-left,0px));overflow:auto;background:rgba(0,0,0,.58);overscroll-behavior:contain}.dialog{position:relative;width:min(660px,100%);max-height:calc(100vh - var(--dialog-inset-top,18px) - var(--dialog-inset-bottom,18px));overflow:auto;padding:24px;border-radius:18px;color:var(--primary-text-color);background:var(--card-background-color);box-shadow:0 16px 50px rgba(0,0,0,.45);overscroll-behavior:contain}.dialog header{display:flex;align-items:center;gap:12px}.product-choice-dialog header{align-items:flex-start}.product-choice-dialog header>div{min-width:0;flex:1}.product-choice-dialog header p{margin:4px 0 14px;color:var(--secondary-text-color);line-height:1.4}.product-choices{display:grid;gap:7px}.product-choice{display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:11px;width:100%;padding:10px;border:1px solid var(--divider-color);border-radius:9px;color:var(--primary-text-color);background:var(--secondary-background-color);text-align:left;cursor:pointer}.product-choice:hover{border-color:var(--primary-color)}.product-choice>img,.product-choice-placeholder{display:grid;place-items:center;width:48px;height:48px;object-fit:contain;border-radius:7px;color:var(--secondary-text-color);background:var(--card-background-color)}.product-choice>span{display:flex;min-width:0;flex-direction:column;gap:3px}.product-choice strong{font-size:16px}.product-choice small{color:var(--secondary-text-color);font-size:13px}.product-choice>ha-icon{color:var(--secondary-text-color)}.dialog h2{flex:1;margin:0;font-size:25px}.dialog-heading{display:flex;flex:1;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}.dialog-heading h2{flex:0 1 auto}.unsaved-indicator{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:18px;color:var(--warning-color,#ffa000);background:color-mix(in srgb,var(--warning-color,#ffa000) 13%,transparent);font-size:12px;font-weight:500}.unsaved-indicator[hidden]{display:none}.unsaved-indicator ha-icon{--mdc-icon-size:16px}.icon-button{display:grid;place-items:center;width:40px;height:40px;padding:0;border:0;border-radius:50%;color:var(--primary-text-color);background:transparent;cursor:pointer}.dialog label,.dialog-field{display:flex;flex-direction:column;gap:6px;margin-top:14px;color:var(--secondary-text-color)}.dialog input{width:100%;min-height:45px;padding:9px 11px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color)}.item-quantity-fields{display:grid;grid-template-columns:minmax(0,256px) minmax(0,1fr);gap:12px;align-items:start}.item-quantity-controls{display:grid;grid-template-columns:minmax(0,150px) auto;gap:12px;align-items:end}.quantity-edit-field{align-self:start}.bring-format-help{margin:8px 0 0;line-height:1.45}.bring-live-preview{display:flex;flex-direction:column;gap:3px;margin-top:12px;padding:11px 13px;border-left:3px solid var(--primary-color);border-radius:7px;background:color-mix(in srgb,var(--primary-color) 9%,var(--secondary-background-color))}.bring-live-preview>span{color:var(--secondary-text-color);font-size:12px}.bring-live-preview>strong{font-size:15px}.bring-live-preview>small{color:var(--primary-text-color);font-size:14px}.dialog-quantity-actions{display:flex;gap:10px;margin-bottom:1.5px}.dialog-quantity-actions button{display:grid;place-items:center;width:42px;height:42px;padding:0;border:1px solid var(--divider-color);border-radius:50%;color:var(--primary-text-color);background:var(--card-background-color);font-size:24px;line-height:1;cursor:pointer}.dialog-quantity-actions button:hover{background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.product-dialog .name-field{padding-right:120px}.product-meta{margin-top:6px}.product-amount-summary{margin:10px 0 4px;padding:9px 11px;border-left:3px solid var(--primary-color);border-radius:5px;background:color-mix(in srgb,var(--primary-color) 10%,transparent);font-size:13px}.product-amount-warning{margin:8px 0;color:var(--error-color);font-size:13px}.increment-dialog{width:min(560px,100%)}.increment-product{display:flex;flex-direction:column;gap:4px;min-height:72px;margin-top:18px;padding-right:120px;font-size:18px}.increment-summary{display:grid;grid-template-columns:1fr 48px 110px 48px 1fr;align-items:stretch;gap:10px;margin-top:12px;padding:14px;border-radius:10px;background:var(--secondary-background-color)}.increment-term{display:grid!important;grid-template-rows:26px 48px;gap:0!important;min-width:0;margin:0!important;color:var(--secondary-text-color);font-size:13px}.increment-term>span{display:flex;align-items:start;white-space:nowrap}.increment-term>strong{display:flex;align-items:center;color:var(--primary-text-color);font-size:21px}.increment-term>input{height:48px;min-height:48px}.increment-operator{align-self:end;display:grid;place-items:center;width:48px;height:48px;padding:0;border:0;border-radius:50%;color:var(--primary-text-color);background:transparent;font-size:28px;line-height:1}.increment-plus{border:1px solid var(--divider-color);background:var(--card-background-color);cursor:pointer}.increment-plus:hover{background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.dialog-image-button{position:absolute;right:24px;top:70px;width:100px;height:100px;padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer}.dialog-image{width:100%;height:100%;object-fit:contain;border-radius:8px;background:var(--secondary-background-color)}.picker-trigger-host{position:relative}.picker-trigger-host input{padding-right:44px!important}.picker-list-trigger{position:absolute!important;z-index:4;right:5px;top:50%;display:grid!important;place-items:center;width:34px!important;height:34px!important;min-width:34px!important;min-height:34px!important;padding:0!important;transform:translateY(-50%);border:0!important;border-radius:50%!important;color:var(--primary-color)!important;background:transparent!important;cursor:pointer}.picker-list-trigger:hover,.picker-list-trigger:focus-visible,.picker-list-trigger.active{outline:0;background:color-mix(in srgb,var(--primary-color) 16%,transparent)!important}.picker-list-trigger ha-icon{--mdc-icon-size:21px}.picker-current{box-shadow:inset 3px 0 0 var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))!important}.category-combo,.label-combo{position:relative}.category-picker-options,.label-picker-options{position:absolute;z-index:22;top:calc(100% + 4px);left:0;right:0;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35);overscroll-behavior:contain}.category-picker-options button,.label-picker-options button{display:grid;grid-template-columns:30px minmax(0,1fr);align-items:center;gap:8px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.category-picker-options button:hover,.label-picker-options button:hover{background:var(--secondary-background-color)}.label-picker-options button>span:last-child{display:flex;min-width:0;flex-direction:column;gap:2px}.label-picker-options button small{display:block;color:var(--secondary-text-color)}.category-picker-options button>span:not(.category-option-icon){display:flex;flex-direction:column}.category-picker-options small{color:var(--secondary-text-color)}.category-option-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;color:var(--category-color,var(--primary-color));background:color-mix(in srgb,var(--category-color,var(--primary-color)) 20%,transparent)}.picker-empty{margin:0;padding:12px;color:var(--secondary-text-color)}.label-selector{display:grid;gap:8px;margin-top:16px;padding:0;border:0;border-radius:0;color:var(--secondary-text-color)}.selected-labels{display:flex;flex-wrap:wrap;gap:7px}.selected-label{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:3px 8px;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 58%,var(--divider-color));border-radius:18px;color:var(--primary-text-color);background:color-mix(in srgb,var(--label-color,var(--primary-color)) 24%,var(--card-background-color));cursor:pointer}.selected-label ha-icon{--mdc-icon-size:17px;color:var(--label-color,var(--primary-color))}.selected-label .remove-label{color:var(--secondary-text-color)}.label-search{display:grid;grid-template-columns:25px minmax(0,1fr);align-items:center;min-height:43px;padding:0 9px;border:1px solid var(--divider-color);border-radius:7px;background:var(--secondary-background-color)}.label-search input{min-height:40px!important;padding:0!important;border:0!important;outline:0;background:transparent!important}.label-option-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;color:var(--label-color,var(--primary-color));background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent)}.product-category-input-status{color:var(--error-color)!important}.ean-dialog-status{margin-top:7px}.product-category-move{display:grid;gap:10px;margin-top:14px;padding:12px;border:1px solid color-mix(in srgb,var(--warning-color,#f0a000) 65%,var(--divider-color));border-radius:9px;background:color-mix(in srgb,var(--warning-color,#f0a000) 10%,transparent)}.product-category-move>div{display:flex;align-items:flex-start;gap:9px}.product-category-move>div>ha-icon{flex:0 0 auto;color:var(--warning-color,#f0a000)}.product-category-move>div>span{display:flex;min-width:0;flex-direction:column;gap:3px}.product-category-move small{color:var(--secondary-text-color)}.product-category-move label{display:flex;flex-direction:row;align-items:flex-start;gap:9px;margin:0;color:var(--primary-text-color);cursor:pointer}.product-category-move input{flex:0 0 auto;width:19px;height:19px;min-height:0;margin:1px 0 0;accent-color:var(--primary-color)}.dialog-status{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:14px}.dialog-status.success{color:var(--success-color,#43a047)}.dialog-status.warning{color:var(--warning-color,#f0a000)}.dialog-status.error{color:var(--error-color)}.dialog footer{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}.dialog footer button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 16px;border:1px solid var(--divider-color);border-radius:21px;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.dialog footer .primary{color:#fff;border-color:var(--primary-color);background:var(--primary-color)}.dialog footer .danger{color:var(--error-color);border-color:var(--error-color)}.dialog footer .danger.filled{color:#fff;background:var(--error-color)}.confirmation-backdrop{z-index:1200}.confirmation-dialog{width:min(460px,100%);text-align:center}.confirmation-dialog h2{display:block}.confirmation-dialog p{color:var(--secondary-text-color);line-height:1.5}.confirmation-dialog footer{justify-content:center}.confirmation-icon{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 12px;border-radius:50%;color:var(--error-color);background:color-mix(in srgb,var(--error-color) 14%,transparent)}.confirmation-icon ha-icon{--mdc-icon-size:31px}.share-confirmation .confirmation-icon{color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,transparent)}.share-targets{display:flex;flex-direction:column;gap:7px;margin:10px 0}.share-targets label{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:10px;margin:0;padding:9px 12px;border-radius:8px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.share-targets input{width:20px;height:20px;accent-color:var(--primary-color)}.chip-dialog-backdrop{z-index:1150}.chip-dialog{width:min(620px,100%)}.chip-dialog header{align-items:flex-start}.chip-dialog header>div{flex:1;min-width:0}.chip-dialog header p{margin:4px 0 0;color:var(--secondary-text-color)}.dialog-chip-grid{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.dialog-chip{min-height:38px;padding:6px 13px;border:1px solid var(--divider-color);border-radius:20px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.dialog-chip.colored{border-color:color-mix(in srgb,var(--chip-border-color,var(--chip-color)) 70%,var(--divider-color));background:color-mix(in srgb,var(--chip-color) 20%,var(--card-background-color))}.dialog-chip:hover{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.dialog-chip.colored:hover{border-color:var(--chip-border-color,var(--chip-color));background:color-mix(in srgb,var(--chip-color) 30%,var(--card-background-color))}.browser-chip{touch-action:manipulation}.browser-chip-backdrop{z-index:1175}.browser-chip-menu{width:min(560px,100%)}.browser-chip-menu header{align-items:flex-start}.browser-chip-menu header>div{flex:1;min-width:0}.browser-chip-menu header p{margin:4px 0 0;color:var(--secondary-text-color)}.browser-chip-actions{display:grid;gap:8px;margin-top:18px}.browser-chip-actions>button{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;width:100%;padding:11px 13px;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-text-color);background:var(--secondary-background-color);text-align:left;cursor:pointer}.browser-chip-actions>button:hover{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 10%,var(--card-background-color))}.browser-chip-actions ha-icon{color:var(--primary-color)}.browser-chip-actions span{display:flex;min-width:0;flex-direction:column;gap:2px}.browser-chip-actions small{color:var(--secondary-text-color)}.image-backdrop{z-index:1300}.image-dialog{width:min(900px,100%)}.image-dialog>img{display:block;width:100%;height:auto;max-height:calc(100vh - 130px);margin:14px auto 0;object-fit:contain}
      .title-actions-wide{display:flex;gap:6px}.compact-header-actions{display:none;position:relative}.compact-actions-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;display:grid;width:max-content;min-width:190px;overflow:hidden;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);box-shadow:0 8px 26px rgba(0,0,0,.38)}.compact-actions-menu button{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 14px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.compact-actions-menu button:last-child{border-bottom:0}.compact-actions-menu button:hover{background:var(--secondary-background-color)}.compact-actions-menu ha-icon{--mdc-icon-size:20px;color:var(--primary-color)}
      @container(max-width:600px){ha-card,.list-collapsed{padding:10px}.card-title{height:54px;min-height:54px;margin:0 0 4px}.list-collapsed .card-title{margin:0}.option-row button{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;min-height:38px;padding:0;gap:0;border-radius:9px}.option-row button>span{display:none}.option-row [data-shopping-scan-queue]{position:relative}.option-row .scan-queue-count{display:block;position:absolute;top:0;right:1px;font-size:10px;line-height:12px;color:var(--primary-color)}.card-title-copy>span{font-size:21px}.title-actions-wide{display:none}.compact-header-actions{display:block}.compact-actions-toggle{width:38px;padding:0}.input-row{grid-template-columns:76px minmax(0,1fr)}.input-row .submit-button{grid-column:1/-1;min-height:42px}.input-row:not(:has(.quantity-input)){grid-template-columns:1fr}.item.with-image{grid-template-columns:34px 42px minmax(0,1fr) auto}.item.without-image{grid-template-columns:34px minmax(0,1fr) auto}.quantity-actions button{width:32px}.view-panel.chips-position-auto .card-layout,.chips-position-right .card-layout,:host([data-expanded-view]) .chips-position-auto .card-layout{display:block}.view-panel.chips-position-auto .card-layout>.quick-chips,.chips-position-right .card-layout>.quick-chips,:host([data-expanded-view]) .chips-position-auto .card-layout>.quick-chips{margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--divider-color);border-left:0}}
      @media(max-width:600px){.product-dialog .name-field,.increment-product{padding-right:0}.increment-summary{grid-template-columns:1fr 48px minmax(90px,1fr)}.increment-equals,.increment-new{display:none!important}.dialog-image-button{position:static;float:right;margin:12px 0 8px 12px}.dialog{padding:18px}.chip-dialog-backdrop{place-items:end center;padding:0}.chip-dialog{width:100%;max-height:75vh;border-radius:18px 18px 0 0}}
      .fixed-product-amount{align-self:start;display:grid;gap:6px;margin-top:14px}.fixed-product-amount>span,.fixed-product-amount>small{color:var(--secondary-text-color);font-size:13px}.fixed-product-amount>strong{display:flex;align-items:center;min-height:45px;padding:9px 11px;border-left:3px solid var(--primary-color);border-radius:7px;color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-color) 9%,var(--secondary-background-color));font-size:16px;font-weight:500}.view-mobile .input-row{grid-template-columns:76px minmax(0,1fr)}.view-mobile .input-row .submit-button{grid-column:1/-1;min-height:42px}

      @media(max-width:600px){.item-quantity-fields{grid-template-columns:minmax(0,1fr)}.item-quantity-controls{grid-template-columns:minmax(0,1fr) auto}}@supports(height:100dvh){.backdrop{height:100dvh;bottom:auto}.dialog{max-height:calc(100dvh - var(--dialog-inset-top,18px) - var(--dialog-inset-bottom,18px))}}
.label-filter-dialog .filter-save-actions>button,.label-filter-dialog>[data-reset-label-filter],.saved-filter>button{border:0;background:transparent;color:var(--primary-text-color);font:inherit;cursor:pointer;min-height:44px}.saved-filter>button.danger,.filter-status.error{color:var(--error-color)}
      ${globalThis.HaListManagerProductEditor.styles()}
    ${this._chipStyles()}${this._labelFilterStyles()}`;
  }

  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    if (!this.shadowRoot) return;
    const pageAnchor = this._capturePageScrollAnchor();
    const previousCard = this.shadowRoot.querySelector("ha-card");
    if (this._expandedView && previousCard?.scrollTop > 0) this._expandedScrollTop = previousCard.scrollTop;
    const active = this.shadowRoot.activeElement;
    const focusAttribute = active?.getAttributeNames?.().find((name) => name.startsWith("data-"));
    const focusValue = focusAttribute ? active.getAttribute(focusAttribute) : null;
    const focusItemId = active?.closest?.("[data-item-id]")?.dataset.itemId;
    const focusCategoryId = active?.closest?.(".category")?.querySelector("[data-category]")?.dataset.category;
    const supportsSelection = active?.tagName === "TEXTAREA"
      || (active?.tagName === "INPUT" && ["text", "search", "url", "tel", "password", "email"].includes(active.type));
    const selection = supportsSelection ? [active.selectionStart, active.selectionEnd] : null;
    const title = this._config.title || this._list?.name || haListManagerShoppingCardText("ui.shopping_list", {}, this._hass);
    const input = this._renderInputRow();
    const content = this._contentHtml();
    const view = ["panel", "mobile"].includes(this._config.view_mode)
      ? this._config.view_mode
      : (this._isPanelDashboardView() ? "panel" : "auto");
    const hasNotificationTarget = this._notificationAssignments.some((assignment) => assignment.manual_enabled && assignment.profile?.enabled);
    const notifyButton = this._config.show_share_button !== false && hasNotificationTarget ? `<button class="title-action" type="button" data-send-list title="${haListManagerShoppingCardText("ui.share_list", {}, this._hass)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:share-variant-outline"></ha-icon><span>${haListManagerShoppingCardText("ui.share", {}, this._hass)}</span></button>` : "";
    const pdfButton = this._config.show_pdf_export_button === true ? `<button class="title-action" type="button" data-export-pdf title="${haListManagerShoppingCardText("ui.export_list_pdf", {}, this._hass)}" ${this._pdfExporting ? "disabled" : ""}><ha-icon icon="mdi:file-pdf-box"></ha-icon><span>${this._pdfExporting ? "PDF …" : "PDF"}</span></button>` : "";
    const tandoorButton = this._list?.use_tandoor ? `<button class="title-action" type="button" data-open-tandoor title="${haListManagerShoppingCardText("recipes.search_tandoor", {}, this._hass)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:chef-hat"></ha-icon><span>${haListManagerShoppingCardText("recipes.recipes", {}, this._hass)}</span></button>` : "";
    const compactMenuItems = `${tandoorButton ? `<button type="button" data-open-tandoor><ha-icon icon="mdi:chef-hat"></ha-icon><span>${haListManagerShoppingCardText("recipes.search_tandoor", {}, this._hass)}</span></button>` : ""}${notifyButton ? `<button type="button" data-send-list><ha-icon icon="mdi:share-variant-outline"></ha-icon><span>${haListManagerShoppingCardText("ui.share_list", {}, this._hass)}</span></button>` : ""}${pdfButton ? `<button type="button" data-export-pdf ${this._pdfExporting ? "disabled" : ""}><ha-icon icon="mdi:file-pdf-box"></ha-icon><span>${this._pdfExporting ? haListManagerShoppingCardText("ui.pdf_creating", {}, this._hass) : haListManagerShoppingCardText("ui.export_pdf", {}, this._hass)}</span></button>` : ""}`;
    const titleActions = notifyButton || pdfButton || tandoorButton ? `<div class="title-actions"><div class="title-actions-wide">${tandoorButton}${notifyButton}${pdfButton}</div><div class="compact-header-actions"><button type="button" class="title-action compact-actions-toggle" data-toggle-header-menu aria-expanded="${this._headerMenuOpen}" title="${haListManagerShoppingCardText("ui.actions", {}, this._hass)}"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>${this._headerMenuOpen ? `<div class="compact-actions-menu">${compactMenuItems}</div>` : ""}</div></div>` : "";
    const contentDisplay = this._config.content_display || "card_and_large";
    const largeViewEnabled = contentDisplay !== "card_only";
    const largeOnly = contentDisplay === "large_only";
    const itemFontSize = this._config.item_font_size;
    const categoryFontSize = itemFontSize * this._config.category_font_scale / 100;
    const categorySecondaryFontSize = Math.max(9, itemFontSize - 3);
    const categoryIconSize = Math.max(18, itemFontSize * 1.25);
    const dividerBeforeSpacing = this._config.item_divider_before_spacing;
    const dividerAfterSpacing = this._config.item_divider_after_spacing;
    const appearanceStyle = `--ha-list-manager-item-font-size:${itemFontSize}px;--ha-list-manager-secondary-font-size:${Math.max(10, itemFontSize - 2)}px;--ha-list-manager-tertiary-font-size:${Math.max(9, itemFontSize - 3)}px;--ha-list-manager-category-font-size:${categoryFontSize.toFixed(2)}px;--ha-list-manager-category-secondary-font-size:${categorySecondaryFontSize.toFixed(2)}px;--ha-list-manager-category-icon-size:${categoryIconSize.toFixed(2)}px;--ha-list-manager-item-divider-before-spacing:${dividerBeforeSpacing}px;--ha-list-manager-item-divider-after-spacing:${dividerAfterSpacing}px`;
    const dividerClass = this._config.show_item_dividers ? "item-dividers" : "";
    const collapsible = !largeOnly && this._config.collapsible !== false;
    const collapsed = !this._expandedView && (largeOnly || (collapsible && this._listCollapsed()));
    const openItems = this._items.filter((item) => !item.completed).length;
    const expandedLabel = this._expandedView ? haListManagerShoppingCardText("ui.close_large_view", {}, this._hass) : haListManagerShoppingCardText("ui.open_large_view", {}, this._hass);
    const titleIcon = esc(this._config.title_icon || "mdi:cart-variant");
    const titleIconStyle = `color:${esc(this._configuredChipColor(this._config.title_icon_color_rgb, "var(--primary-color)"))}`;
    const expandedToggle = largeViewEnabled
      ? `<button type="button" class="title-icon title-expand-toggle" style="${titleIconStyle}" data-toggle-expanded-view aria-pressed="${this._expandedView}" aria-label="${expandedLabel}" title="${expandedLabel}"><ha-icon icon="${titleIcon}"></ha-icon></button>`
      : `<span class="title-icon title-static-icon" style="${titleIconStyle}" aria-hidden="true"><ha-icon icon="${titleIcon}"></ha-icon></span>`;
    const titleContent = `<span>${esc(title)}</span><small>${haListManagerShoppingCardText("ui.open_total_items", {p0:(openItems), p1:(this._items.length)}, this._hass)}</small>`;
    const titleCopy = largeOnly
      ? `<button type="button" class="card-title-copy" data-toggle-expanded-view aria-expanded="${this._expandedView}">${titleContent}</button>`
      : collapsible ? `<button type="button" class="card-title-copy" data-toggle-list aria-expanded="${collapsed ? "false" : "true"}">${titleContent}</button>` : `<div class="card-title-copy">${titleContent}</div>`;
    const titleToggle = `<div class="card-title-toggle">${expandedToggle}${titleCopy}</div>`;
    const options = this._optionRowHtml();
    const listBody = `${this._config.input_row_position === "top" ? input : ""}${this._config.option_row_position === "top" ? options : ""}<div class="status-region" data-status-region>${this._notice(this._notificationStatus, "notification", "send-status", "check-circle-outline")}</div>${this._notice(this._error, "error", "error")}<main>${content}</main>${this._config.option_row_position === "bottom" ? options : ""}${this._config.input_row_position === "bottom" ? input : ""}`;
    const cardBody = collapsed ? "" : `<div class="card-layout"><div class="list-column">${listBody}</div>${this._renderChips()}</div>`;
    const markup = `<style>${this._styles()}</style><ha-card class="view-${view} chips-position-${esc(this._config.chips_position)} ${dividerClass} ${collapsed ? "list-collapsed" : ""}" style="${appearanceStyle}"><div class="card-title">${titleToggle}${titleActions}</div>${cardBody}${this._renderDialog()}${this._renderProductPicker()}${this._renderConfirmation()}${this._renderChipDialog()}${this._renderDishDialog()}${this._renderTandoorDialog()}${this._renderBrowserChipMenu()}${this._renderImageDialog()}${this._renderSelectionPopup()}${this._renderLabelFilterDialog()}</ha-card>`;
    this._clearRenderListeners();
    const template = document.createElement("template");
    template.innerHTML = markup;
    this._patchDom(this.shadowRoot, template.content);
    this._bind();
    if (focusAttribute) {
      const next = [...this.shadowRoot.querySelectorAll(`[${focusAttribute}]`)]
        .find((element) => element.getAttribute(focusAttribute) === focusValue
          && (!focusItemId || element.closest?.("[data-item-id]")?.dataset.itemId === focusItemId)
          && (!focusCategoryId || element.closest?.(".category")?.querySelector("[data-category]")?.dataset.category === focusCategoryId));
      next?.focus({ preventScroll: true });
      if (selection && next?.setSelectionRange) next.setSelectionRange(selection[0], selection[1]);
    }
    this._restoreExpandedScroll();
    this._restorePageScrollAnchor(pageAnchor);
    if (!this._pageActionAnchor?.isConnected) this._pageActionAnchor = null;
  }

  // Keep the live card, rows and chip controls mounted so HA and the browser
  // retain their scroll anchors when a backend event refreshes the list.
  _patchDom(parent, content) {
    const key = (node) => {
      if (node.nodeType !== 1) return String(node.nodeType);
      const attribute = node.getAttributeNames().find((name) => name.startsWith("data-"));
      return `${node.nodeName}:${attribute ? `${attribute}=${node.getAttribute(attribute)}` : node.getAttribute("class")?.split(/\s+/)[0] || ""}`;
    };
    const previous = [...parent.childNodes];
    const used = new Set();
    let position = parent.firstChild;
    for (const desired of [...content.childNodes]) {
      const current = previous.find((node) => !used.has(node) && key(node) === key(desired));
      const node = current || desired.cloneNode(true);
      if (node !== position) parent.insertBefore(node, position);
      used.add(node);
      if (current && node.nodeType === 1) {
        for (const attribute of [...node.attributes]) {
          if (!desired.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
        }
        for (const attribute of [...desired.attributes]) {
          if (node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
        }
        this._patchDom(node, desired);
        if (["INPUT", "TEXTAREA", "SELECT"].includes(node.nodeName)) {
          if (node.value !== desired.value) node.value = desired.value;
          if (node.nodeName === "INPUT") node.checked = desired.checked;
        }
      } else if (current && node.nodeValue !== desired.nodeValue) node.nodeValue = desired.nodeValue;
      position = node.nextSibling;
    }
    for (const node of previous) if (!used.has(node)) node.remove();
  }

  _listen(target, type, listener, options) {
    if (!target) return;
    target.addEventListener(type, listener, options);
    this._renderListeners.push({ target, type, listener, options });
  }

  _clearRenderListeners(subtree = null) {
    if (!subtree || subtree.querySelector?.("[data-label-filter-preset]")) { clearTimeout(this._filterPressTimer); this._filterPressTimer = null; }
    const retained = [];
    for (const entry of this._renderListeners) {
      if (subtree && !subtree.contains(entry.target)) retained.push(entry);
      else entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    }
    this._renderListeners = retained;
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
      input.style.setProperty("padding-right", triggerHost.classList.contains("picker-popup-host") ? "86px" : "44px", "important");
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "picker-list-trigger";
      trigger.dataset.pickerListTrigger = "";
      trigger.disabled = this._busy || input.disabled;
      trigger.title = haListManagerShoppingCardText("ui.open_picker_close_keyboard", {}, this._hass);
      trigger.setAttribute("aria-label", trigger.title);
      trigger.innerHTML = '<ha-icon icon="mdi:gesture-tap-button"></ha-icon>';
      this._listen(trigger, "pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
      this._listen(trigger, "click", (event) => {
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
          if (input.isConnected === false || input.disabled || this._busy || this._selectionPopup) return;
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
    const draft = this._dialog;
    if (!input || !menu || !draft) return;
    this._updateProductLabelPreference();
    const choose = (label) => {
      if (!label || draft.label_ids.includes(label.id)) return;
      draft.label_ids = [...draft.label_ids, label.id];
      input.value = "";
      menu.hidden = true;
      refreshSelection();
    };
    const matches = () => {
      const query = input.value.trim().toLocaleLowerCase();
      return this._labels.filter((label) => !draft.label_ids.includes(label.id) && label.name.toLocaleLowerCase().includes(query));
    };
    const renderOptions = () => {
      const available = matches();
      this._clearRenderListeners(menu);
      menu.innerHTML = available.length ? available.map((label) => `<button type="button" data-label-option="${esc(label.id)}" style="${label.color ? `--label-color:${esc(label.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon></span><span><strong>${esc(label.name)}</strong><small>${esc(this._labelScope(label))}</small></span></button>`).join("") : `<p class="picker-empty">${haListManagerShoppingCardText("labels.no_matches", {}, this._hass)}</p>`;
      menu.hidden = false;
      menu.querySelectorAll("[data-label-option]").forEach((button) => this._listen(button, "mousedown", (event) => { event.preventDefault(); choose(this._labels.find((label) => label.id === button.dataset.labelOption)); }));
    };
    const bindRemoveButtons = () => {
      this.shadowRoot.querySelectorAll("[data-remove-label]").forEach((button) => this._listen(button, "click", () => {
        const focused = this.shadowRoot.activeElement === button;
        const menuHidden = menu.hidden;
        draft.label_ids = draft.label_ids.filter((id) => id !== button.dataset.removeLabel);
        refreshSelection();
        if (focused) {
          input.focus({ preventScroll: true });
          menu.hidden = menuHidden;
        }
      }));
    };
    const refreshSelection = () => {
      // Keep the dialog and input mounted: remounting loses mobile scroll/focus.
      const host = this.shadowRoot.querySelector("[data-selected-labels]");
      if (host) {
        this._clearRenderListeners(host);
        host.innerHTML = this._renderSelectedLabels(draft.label_ids);
        host.hidden = !host.innerHTML;
        bindRemoveButtons();
      }
      if (!menu.hidden) renderOptions();
      this._updateProductLabelPreference();
      this._updateDialogDirtyState();
    };
    this._listen(input, "focus", renderOptions);
    this._listen(input, "input", renderOptions);
    this._listen(input, "keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); choose(matches()[0]); } });
    this._listen(input, "blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    bindRemoveButtons();
  }

  _configureCategorySelector() {
    const input = this.shadowRoot.querySelector("[data-d-category]");
    const menu = this.shadowRoot.querySelector("[data-category-options]");
    const draft = this._dialog;
    if (!input || !menu || !draft) return;
    const productMode = input.dataset.productCategory === "1";
    const categories = this._availableCategories().filter((category) => !productMode || !category.dynamic);
    const updateProductStatus = () => {
      if (!productMode) return;
      const status = this.shadowRoot.querySelector("[data-product-category-input-status]");
      if (!status) return;
      status.textContent = this._productCategoryInputStatus(input.value, draft.category_id);
      status.hidden = !status.textContent;
    };
    const sourceRank = (category) => category.dynamic ? 2 : category.scope === "global" ? 0 : 1;
    const matches = () => {
      const query = input.value.trim().toLocaleLowerCase();
      return categories
        .filter((category) => category.name.toLocaleLowerCase().includes(query))
        .sort((left, right) => left.name.localeCompare(right.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true }) || sourceRank(left) - sourceRank(right));
    };
    const renderOptions = () => {
      const available = matches();
      this._clearRenderListeners(menu);
      menu.innerHTML = `<button type="button" data-category-option=""><span class="category-option-icon"><ha-icon icon="mdi:shape-outline"></ha-icon></span><span><strong>${haListManagerShoppingCardText("ui.general", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.no_category", {}, this._hass)}</small></span></button>${available.map((category) => `<button type="button" data-category-option="${esc(category.id)}"><span class="category-option-icon" style="${category.color ? `--category-color:${esc(category.color)}` : ""}"><ha-icon icon="${esc(category.icon || (category.scope === "global" ? "mdi:earth" : "mdi:format-list-bulleted"))}"></ha-icon></span><span><strong>${esc(category.name)}</strong><small>${esc(this._categoryScope(category))}</small></span></button>`).join("")}`;
      menu.hidden = false;
      menu.querySelectorAll("[data-category-option]").forEach((button) => this._listen(button, "mousedown", (event) => {
        event.preventDefault();
        const category = categories.find((entry) => entry.id === button.dataset.categoryOption);
        draft.category_id = category?.id || null;
        draft.category_name = category?.name || "";
        this._render();
      }));
    };
    this._listen(input, "focus", () => { renderOptions(); updateProductStatus(); });
    this._listen(input, "input", (event) => { draft.category_id = null; draft.category_name = event.target.value; renderOptions(); updateProductStatus(); this._updateCategoryPreference(); this._updateDialogDirtyState(); });
    this._listen(input, "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const exact = categories.find((category) => category.name.localeCompare(input.value.trim(), haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
      if (!exact) return;
      draft.category_id = exact.id;
      draft.category_name = exact.name;
      this._render();
    });
    this._listen(input, "blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    this._updateCategoryPreference();
    this._listen(this.shadowRoot.querySelector("[data-remember-product-category]"), "change", (event) => {
      draft.remember_product_category = event.target.checked && this._categoryPreferenceState(draft).enabled;
      this._updateDialogDirtyState();
    });
  }

  _configureDishCategorySelectors(root = this.shadowRoot) {
    const dialog = this._dishDialog;
    if (!dialog) return;
    const categories = this._availableCategories();
    const sourceRank = (category) => category.dynamic ? 2 : category.scope === "global" ? 0 : 1;
    root.querySelectorAll("[data-dish-category-search]").forEach((input) => {
      const itemId = input.dataset.dishCategorySearch;
      const choice = dialog.categories?.[itemId];
      const menu = [...root.querySelectorAll("[data-dish-category-options]")]
        .find((element) => element.dataset.dishCategoryOptions === itemId);
      if (!choice || choice.locked || !menu) return;
      const matches = () => {
        const rawQuery = input.value.trim();
        const query = choice.general ? "" : rawQuery.toLocaleLowerCase();
        return categories
          .filter((category) => category.name.toLocaleLowerCase().includes(query))
          .sort((left, right) => left.name.localeCompare(right.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true }) || sourceRank(left) - sourceRank(right));
      };
      const choose = (category) => {
        choice.category_id = category?.id || null;
        choice.category_name = category?.name || "";
        choice.dynamic = Boolean(category?.dynamic || String(category?.id || "").startsWith("dynamic:"));
        choice.general = !category;
        choice.source = "manual";
        this._render();
      };
      const renderOptions = () => {
        const available = matches();
        this._clearRenderListeners(menu);
        menu.innerHTML = `<button type="button" data-dish-category-option=""><span class="category-option-icon"><ha-icon icon="mdi:shape-outline"></ha-icon></span><span><strong>${haListManagerShoppingCardText("ui.general", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.no_category", {}, this._hass)}</small></span></button>${available.map((category) => `<button type="button" data-dish-category-option="${esc(category.id)}"><span class="category-option-icon" style="${category.color ? `--category-color:${esc(category.color)}` : ""}"><ha-icon icon="${esc(category.icon || (category.dynamic ? "mdi:shape-outline" : category.scope === "global" ? "mdi:earth" : "mdi:format-list-bulleted"))}"></ha-icon></span><span><strong>${esc(category.name)}</strong><small>${esc(this._categoryScope(category))}</small></span></button>`).join("")}`;
        menu.hidden = false;
        menu.querySelectorAll("[data-dish-category-option]").forEach((button) => this._listen(button, "mousedown", (event) => {
          event.preventDefault();
          choose(categories.find((category) => category.id === button.dataset.dishCategoryOption));
        }));
      };
      this._listen(input, "focus", () => {
        if (choice.general) input.select();
        renderOptions();
      });
      this._listen(input, "input", (event) => {
        choice.category_id = null;
        choice.category_name = event.target.value;
        choice.dynamic = Boolean(event.target.value.trim());
        choice.general = !event.target.value.trim();
        choice.source = "manual";
        input.closest(".dish-category-combo")?.classList.remove("unresolved");
        renderOptions();
      });
      this._listen(input, "keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const exact = categories.find((category) => category.name.localeCompare(input.value.trim(), haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
        if (exact) choose(exact);
        else {
          choice.category_id = null;
          choice.category_name = input.value.trim();
          choice.dynamic = Boolean(input.value.trim());
          choice.general = !input.value.trim();
          choice.source = "manual";
          this._render();
        }
      });
      this._listen(input, "blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    });
  }

  _configureTandoorCategorySelectors(root = this.shadowRoot) {
    const dialog = this._tandoorDialog;
    if (!dialog?.recipe) return;
    const categories = this._availableCategories();
    const sourceRank = (category) => category.dynamic ? 2 : category.scope === "global" ? 0 : 1;
    root.querySelectorAll("[data-tandoor-category-search]").forEach((input) => {
      const ingredientId = input.dataset.tandoorCategorySearch;
      const choice = dialog.ingredientCategories?.[ingredientId];
      const menu = [...root.querySelectorAll("[data-tandoor-category-options]")]
        .find((element) => element.dataset.tandoorCategoryOptions === ingredientId);
      if (!choice || choice.locked || !menu) return;
      const matches = () => {
        const rawQuery = input.value.trim();
        const query = choice.general ? "" : rawQuery.toLocaleLowerCase();
        return categories
          .filter((category) => category.name.toLocaleLowerCase().includes(query))
          .sort((left, right) => left.name.localeCompare(right.name, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base", numeric: true }) || sourceRank(left) - sourceRank(right));
      };
      const choose = (category) => {
        choice.category_id = category?.id || null;
        choice.category_name = category?.name || "";
        choice.dynamic = Boolean(category?.dynamic || String(category?.id || "").startsWith("dynamic:"));
        choice.general = !category;
        choice.source = "manual";
        this._renderTandoorRecipePreservingScroll();
      };
      const renderOptions = () => {
        const available = matches();
        this._clearRenderListeners(menu);
        menu.innerHTML = `<button type="button" data-tandoor-category-option=""><span class="category-option-icon"><ha-icon icon="mdi:shape-outline"></ha-icon></span><span><strong>${haListManagerShoppingCardText("ui.general", {}, this._hass)}</strong><small>${haListManagerShoppingCardText("ui.no_category", {}, this._hass)}</small></span></button>${available.map((category) => `<button type="button" data-tandoor-category-option="${esc(category.id)}"><span class="category-option-icon" style="${category.color ? `--category-color:${esc(category.color)}` : ""}"><ha-icon icon="${esc(category.icon || (category.dynamic ? "mdi:shape-outline" : category.scope === "global" ? "mdi:earth" : "mdi:format-list-bulleted"))}"></ha-icon></span><span><strong>${esc(category.name)}</strong><small>${esc(this._categoryScope(category))}</small></span></button>`).join("")}`;
        menu.hidden = false;
        menu.querySelectorAll("[data-tandoor-category-option]").forEach((button) => this._listen(button, "mousedown", (event) => {
          event.preventDefault();
          choose(categories.find((category) => category.id === button.dataset.tandoorCategoryOption));
        }));
      };
      this._listen(input, "focus", () => {
        if (choice.general) input.select();
        renderOptions();
      });
      this._listen(input, "input", (event) => {
        const value = event.target.value.trim();
        const general = !value;
        choice.category_id = null;
        choice.category_name = value;
        choice.dynamic = !general;
        choice.general = general;
        choice.source = "manual";
        input.closest(".dish-category-combo")?.classList.remove("unresolved");
        renderOptions();
      });
      this._listen(input, "keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const exact = categories.find((category) => category.name.localeCompare(input.value.trim(), haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
        if (exact) choose(exact);
        else {
          const value = input.value.trim();
          const general = !value;
          choice.category_id = null;
          choice.category_name = value;
          choice.dynamic = !general;
          choice.general = general;
          choice.source = "manual";
          this._renderTandoorRecipePreservingScroll();
        }
      });
      this._listen(input, "blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    });
  }

  _bindScrollGuard() {
    this.shadowRoot.querySelectorAll(".backdrop").forEach((backdrop) => {
      this._listen(backdrop, "wheel", (event) => event.stopPropagation(), { passive: false });
      this._listen(backdrop, "touchmove", (event) => event.stopPropagation(), { passive: false });
    });
  }

  _bindDynamicContent(root = this.shadowRoot, bindCategories = true) {
    root.querySelectorAll("[data-product-id]").forEach((button) => this._listen(button, "click", () => {
      const product = this._suggestions.find((entry) => entry.id === button.dataset.productId);
      if (product) this._handleProduct(product, "", this._requestedQuantity());
    }));
    root.querySelectorAll("[data-product-choice]").forEach((button) => this._listen(button, "click", () => this._chooseProduct(button.dataset.productChoice)));
    if (bindCategories) root.querySelectorAll("[data-category]").forEach((button) => this._listen(button, "click", () => this._toggleCategory(button.dataset.category, button)));
    root.querySelectorAll("[data-edit-item]").forEach((button) => this._listen(button, "click", () => { const item = this._items.find((entry) => entry.id === button.dataset.editItem); if (item) this._openDialog(item, this._products.find((product) => product.id === item.product_id)); }));
    root.querySelectorAll("[data-complete]").forEach((button) => this._listen(button, "click", () => { const row = button.closest("[data-item-id]"); const item = this._items.find((entry) => entry.id === row?.dataset.itemId); if (item) this._complete(item, !item.completed, row); }));
    root.querySelectorAll("[data-quantity-change]").forEach((button) => this._listen(button, "click", () => { const [id, delta] = button.dataset.quantityChange.split(":"); const item = this._items.find((entry) => entry.id === id); if (item) this._changeQuantity(item, Number(delta)); }));
    root.querySelectorAll("[data-view-item-image]").forEach((button) => this._listen(button, "click", () => {
      const item = this._items.find((entry) => entry.id === button.dataset.viewItemImage);
      const product = this._products.find((entry) => entry.id === item?.product_id);
      if (product?.image_url) {
        this._imageDialog = { url: largeImageUrl(product.image_url), name: item.name };
        this._lockScroll();
        this._render();
      }
    }));
  }

  _bindChipButton(button, chip, activate) {
    if (!button || !chip) return;
    this._listen(button, "click", (event) => {
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
        this._lockScroll();
        this._render();
      }, 650);
    };
    this._listen(button, "pointerdown", start);
    this._listen(button, "mousedown", start);
    this._listen(button, "touchstart", start, { passive: true });
    ["pointerup", "pointercancel", "pointerleave", "mouseup", "mouseleave", "touchend", "touchcancel"].forEach((type) => this._listen(button, type, cancel));
    this._listen(button, "contextmenu", (event) => event.preventDefault());
  }

  _bindChipActions(root = this.shadowRoot) {
    const chips = this._displayChips();
    this._listen(root.querySelector("[data-toggle-chip-categories]"), "click", () => this._toggleAllChipCategories());
    root.querySelectorAll("[data-chip-category]").forEach((button) => this._listen(button, "click", () => this._toggleChipCategory(button.dataset.chipCategory, button.dataset.chipCategoryDialog === "1")));
    root.querySelectorAll("[data-quick-chip]").forEach((button) => {
      const chip = chips.find((entry) => entry.id === button.dataset.quickChip);
      this._bindChipButton(button, chip, () => this._useChip(chip));
    });
    root.querySelectorAll("[data-dialog-chip]").forEach((button) => {
      const chip = chips.find((entry) => entry.id === button.dataset.dialogChip);
      this._bindChipButton(button, chip, async () => {
        this._chipDialog = false;
        this._unlockScroll();
        await this._useChip(chip);
      });
    });
    this._listen(root.querySelector("[data-toggle-chips]"), "click", () => {
      this._chipsExpanded = !this._chipsExpanded;
      this._render();
    });
    root.querySelectorAll("[data-dish]").forEach((button) => this._listen(button, "click", () => this._useDish(this._dishes.find((dish) => dish.id === button.dataset.dish))));
    root.querySelectorAll("[data-dialog-dish]").forEach((button) => this._listen(button, "click", () => this._useDish(this._dishes.find((dish) => dish.id === button.dataset.dialogDish))));
  }

  _bind() {
    const root = this.shadowRoot;
    globalThis.HaListManagerShoppingScanner?.for(this).bind(root);
    this._bindLabelFilter(root);
    this._listen(root, "pointerdown", (event) => {
      this._pageActionAnchor = event.target.closest?.("[data-item-id],[data-chip-category],[data-quick-chip],[data-dish],[data-category],[data-label-filter-preset],[data-open-label-filter]") || null;
    });
    this._bindNotices();
    this._bindSelectionPopup();
    this._bindSelectionTriggers(root);
    this._listen(root.querySelector("[data-toggle-item-actions]"), "click", () => this._toggleItemActions());
    root.querySelectorAll("[data-item-action]").forEach((button) => this._listen(button, "click", () => this._openItemAction(button.dataset.itemAction)));
    root.querySelectorAll("[data-item-shortcut]").forEach((button) => this._listen(button, "click", () => this._openItemAction(button.dataset.itemShortcut, button)));
    this._listen(root.querySelector("[data-confirm-item-action]"), "click", () => this._confirmItemAction());
    this._listen(root.querySelector("[data-item-action-target]"), "change", (event) => { if (this._itemAction) this._itemAction.target_list_id = event.target.value; });
    this._listen(root.querySelector("[data-item-action-quantity]"), "input", (event) => { if (this._itemAction) this._itemAction.quantity = event.target.value; });
    this._listen(root.querySelector("[data-dialog]"), "keydown", (event) => {
      if (event.key === "Escape" && (this._itemAction || this._dialog?.item_actions_open)) {
        event.preventDefault(); event.stopPropagation();
        if (this._itemAction) this._closeItemAction(); else this._toggleItemActions();
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); this._closeDialog();
      }
    });
    this._listen(root.querySelector(".item-actions-menu"), "keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...root.querySelectorAll("[data-item-action]:not(:disabled)")];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(root.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index]?.focus({ preventScroll: true });
    });
    this._listen(root.querySelector("ha-card"), "scroll", (event) => {
      if (this._expandedView) this._expandedScrollTop = event.currentTarget.scrollTop;
    }, { passive: true });
    root.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => this._listen(element, "click", (event) => this._toggleExpandedView(event)));
    this._listen(root.querySelector("[data-toggle-list]"), "click", () => { if (!this._expandedView) this._toggleList(); });
    const productInput = root.querySelector("[data-product-input]");
    this._listen(productInput, "input", (event) => this._searchProducts(event.target.value));
    this._listen(productInput, "focus", () => {
      this._suggestionsVisible = true;
      const suggestions = this.shadowRoot.querySelector("[data-suggestions]");
      if (suggestions) suggestions.hidden = !this._suggestions.length;
    });
    this._listen(productInput, "blur", () => setTimeout(() => {
      this._suggestionsVisible = false;
      const suggestions = this.shadowRoot.querySelector("[data-suggestions]");
      if (suggestions) suggestions.hidden = true;
    }, 120));
    this._listen(productInput, "keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); this._useInput(); } });
    this._listen(root.querySelector("[data-clear-input]"), "click", () => this._clearInput());
    this._listen(root.querySelector("[data-open-chip-dialog]"), "click", () => {
      this._chipDialog = true;
      this._lockScroll();
      this._render();
    });
    this._listen(root.querySelector("[data-add]"), "click", () => this._useInput());
    this._bindChipActions(root);
    this._listen(root.querySelector("[data-toggle-header-menu]"), "click", () => { this._headerMenuOpen = !this._headerMenuOpen; this._render(); });
    root.querySelectorAll("[data-send-list]").forEach((button) => this._listen(button, "click", () => { this._headerMenuOpen = false; this._requestShare(); }));
    root.querySelectorAll("[data-export-pdf]").forEach((button) => this._listen(button, "click", () => { this._headerMenuOpen = false; this._exportPdf(); }));
    root.querySelectorAll("[data-open-tandoor]").forEach((button) => this._listen(button, "click", () => this._openTandoorDialog()));
    this._bindFilterMenu(root);
    this._listen(root.querySelector("ha-card"), "click", (event) => {
      if (this._filterMenuOpen && !event.target.closest(".filter-menu-host")) this._closeFilterMenu();
      if (this._headerMenuOpen && !event.target.closest(".compact-header-actions")) { this._headerMenuOpen = false; this._render(); }
    });
    this._listen(root.querySelector("[data-dialog]"), "click", (event) => {
      event.stopPropagation();
      if (this._dialog?.item_actions_open && !event.target.closest(".item-actions")) {
        this._dialog.item_actions_open = false;
        const menu = root.querySelector(".item-actions-menu");
        if (menu) { this._clearRenderListeners(menu); menu.remove(); }
        root.querySelector("[data-toggle-item-actions]")?.setAttribute("aria-expanded", "false");
      }
    });
    this._listen(root.querySelector(".backdrop[data-close-product-picker]"), "click", (event) => { if (event.target === event.currentTarget) this._closeProductPicker(); });
    root.querySelectorAll("button[data-close-product-picker]").forEach((element) => this._listen(element, "click", () => this._closeProductPicker()));
    this._listen(root.querySelector(".backdrop[data-close-chip-dialog]"), "click", (event) => { if (event.target === event.currentTarget) this._closeChipDialog(); });
    root.querySelectorAll("button[data-close-chip-dialog]").forEach((element) => this._listen(element, "click", () => this._closeChipDialog()));
    this._listen(root.querySelector(".backdrop[data-close-dish-dialog]"), "click", (event) => { if (event.target === event.currentTarget) this._closeDishDialog(); });
    root.querySelectorAll("button[data-close-dish-dialog]").forEach((element) => this._listen(element, "click", () => this._closeDishDialog()));
    this._listen(root.querySelector(".backdrop[data-close-tandoor]"), "click", (event) => { if (event.target === event.currentTarget) this._closeTandoorDialog(); });
    root.querySelectorAll("button[data-close-tandoor]").forEach((element) => this._listen(element, "click", () => this._closeTandoorDialog()));
    this._listen(root.querySelector("[data-tandoor-search]"), "input", (event) => {
      if (!this._tandoorDialog) return;
      const query = event.currentTarget.value;
      this._tandoorDialog.query = query;
      clearTimeout(this._tandoorSearchTimer);
      this._setTandoorSearchPending(Boolean(query.trim()));
      const clearButton = root.querySelector("[data-tandoor-clear]");
      if (clearButton) clearButton.hidden = !query;
      this._tandoorSearchTimer = setTimeout(() => this._searchTandoorRecipes(query, true), 300);
    });
    this._listen(root.querySelector("[data-tandoor-clear]"), "click", () => {
      if (!this._tandoorDialog) return;
      clearTimeout(this._tandoorSearchTimer);
      this._tandoorDialog.query = "";
      this._setTandoorSearchPending(false);
      this._searchTandoorRecipes("", true);
    });
    this._listen(root.querySelector("[data-tandoor-include-ingredients]"), "change", (event) => {
      if (!this._tandoorDialog) return;
      clearTimeout(this._tandoorSearchTimer);
      this._tandoorDialog.includeIngredients = event.currentTarget.checked;
      if (this._tandoorDialog.query.trim() || this._tandoorDialog.categoryId || this._tandoorDialog.browseAll) this._searchTandoorRecipes(this._tandoorDialog.query);
    });
    this._listen(root.querySelector("[data-tandoor-skip-small-units]"), "change", (event) => {
      const dialog = this._tandoorDialog;
      if (!dialog) return;
      dialog.skipSmallUnits = event.currentTarget.checked;
      if (dialog.mode !== "recipe" || !dialog.recipe) return;
      for (const ingredient of dialog.recipe.ingredients) {
        if (!this._isTandoorSmallUnit(ingredient)) continue;
        const id = String(ingredient.id);
        if (dialog.skipSmallUnits) dialog.selected.delete(id);
        else dialog.selected.add(id);
      }
      this._renderTandoorRecipePreservingScroll();
    });
    this._listen(root.querySelector("[data-tandoor-all-recipes]"), "click", () => {
      if (!this._tandoorDialog) return;
      this._tandoorDialog.categoryId = null;
      this._tandoorDialog.categoryName = haListManagerShoppingCardText("ui.all_recipes", {}, this._hass);
      this._tandoorDialog.browseAll = true;
      this._tandoorDialog.query = "";
      this._searchTandoorRecipes("");
    });
    root.querySelectorAll("[data-tandoor-cookbook]").forEach((button) => this._listen(button, "click", () => {
      if (!this._tandoorDialog) return;
      this._tandoorDialog.categoryId = Number(button.dataset.tandoorCookbook);
      this._tandoorDialog.categoryName = button.dataset.tandoorCookbookName || "";
      this._tandoorDialog.browseAll = false;
      this._tandoorDialog.query = "";
      this._searchTandoorRecipes("");
    }));
    this._listen(root.querySelector("[data-tandoor-all-cookbooks]"), "click", () => {
      if (!this._tandoorDialog) return;
      this._tandoorDialog.categoryId = null;
      this._tandoorDialog.categoryName = "";
      this._tandoorDialog.browseAll = false;
      this._tandoorDialog.query = "";
      this._tandoorDialog.recipes = [];
      this._tandoorDialog.loading = false;
      this._render();
    });
    root.querySelectorAll("[data-tandoor-recipe]").forEach((button) => this._listen(button, "click", () => this._selectTandoorRecipe(button.dataset.tandoorRecipe)));
    root.querySelectorAll("[data-tandoor-recipe-tab]").forEach((button) => this._listen(button, "click", () => {
      const dialog = this._tandoorDialog;
      if (!dialog?.recipe) return;
      dialog.recipeTab = button.dataset.tandoorRecipeTab === "preparation" ? "preparation" : "ingredients";
      this._render();
      const recipeDialog = this.shadowRoot.querySelector(".tandoor-recipe-dialog");
      if (recipeDialog) recipeDialog.scrollTop = 0;
    }));
    this._listen(root.querySelector("[data-tandoor-servings]"), "change", (event) => {
      this._setTandoorServings(event.currentTarget.value);
    });
    this._listen(root.querySelector("[data-tandoor-servings]"), "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this._setTandoorServings(event.currentTarget.value);
    });
    root.querySelectorAll("[data-tandoor-servings-change]").forEach((button) => this._listen(button, "click", () => {
      const current = Number(this._tandoorDialog?.servings) || 1;
      this._setTandoorServings(current + Number(button.dataset.tandoorServingsChange || 0));
    }));
    this._listen(root.querySelector("[data-tandoor-select-all]"), "click", () => {
      if (!this._tandoorDialog?.recipe) return;
      this._tandoorDialog.selected = new Set(this._tandoorDialog.recipe.ingredients.map((ingredient) => String(ingredient.id)));
      this._renderTandoorRecipePreservingScroll();
    });
    this._listen(root.querySelector("[data-tandoor-select-none]"), "click", () => {
      if (!this._tandoorDialog) return;
      this._tandoorDialog.selected.clear();
      this._renderTandoorRecipePreservingScroll();
    });
    root.querySelectorAll("[data-tandoor-ingredient]").forEach((checkbox) => this._listen(checkbox, "change", () => {
      if (!this._tandoorDialog) return;
      if (checkbox.checked) this._tandoorDialog.selected.add(checkbox.dataset.tandoorIngredient);
      else this._tandoorDialog.selected.delete(checkbox.dataset.tandoorIngredient);
      this._renderTandoorRecipePreservingScroll();
    }));
    root.querySelectorAll("[data-tandoor-product]").forEach((checkbox) => this._listen(checkbox, "change", () => {
      const dialog = this._tandoorDialog;
      if (!dialog) return;
      const id = checkbox.dataset.tandoorProduct;
      if (checkbox.checked) {
        dialog.useProducts.add(id);
        const ingredient = dialog.recipe.ingredients.find((item) => String(item.id) === id);
        if (this._tandoorProductCount(ingredient, dialog.products?.[ingredient?.id]) !== null) dialog.includeAmounts.add(id);
        else dialog.includeAmounts.delete(id);
      } else {
        dialog.useProducts.delete(id);
        if (this._tandoorAmountText(dialog.recipe.ingredients.find((item) => String(item.id) === id))) dialog.includeAmounts.add(id);
      }
      this._renderTandoorRecipePreservingScroll();
    }));
    root.querySelectorAll("[data-tandoor-amount]").forEach((checkbox) => this._listen(checkbox, "change", () => {
      if (!this._tandoorDialog) return;
      if (checkbox.checked) this._tandoorDialog.includeAmounts.add(checkbox.dataset.tandoorAmount);
      else this._tandoorDialog.includeAmounts.delete(checkbox.dataset.tandoorAmount);
      this._renderTandoorRecipePreservingScroll();
    }));
    root.querySelectorAll("[data-tandoor-back]").forEach((button) => this._listen(button, "click", () => {
      if (!this._tandoorDialog) return;
      this._tandoorDialog.mode = "search";
      this._tandoorDialog.recipe = null;
      this._render();
    }));
    this._listen(root.querySelector("[data-add-tandoor]"), "click", () => this._addTandoorSelection());
    root.querySelectorAll("[data-dish-choice]").forEach((checkbox) => this._listen(checkbox, "change", () => {
      if (!this._dishDialog) return;
      if (checkbox.checked) this._dishDialog.selected.add(checkbox.dataset.dishChoice);
      else this._dishDialog.selected.delete(checkbox.dataset.dishChoice);
      this._render();
    }));
    root.querySelectorAll("[data-dish-quantity]").forEach((input) => this._listen(input, "input", () => { if (this._dishDialog) this._dishDialog.quantities[input.dataset.dishQuantity] = input.value; }));
    this._configureTandoorCategorySelectors(root);
    this._configureDishCategorySelectors(root);
    this._listen(root.querySelector("[data-add-dish-to-list]"), "click", () => {
      const dialog = this._dishDialog;
      if (!dialog) return;
      const availableCategories = this._availableCategories();
      const items = [...dialog.selected].map((itemId) => {
        const choice = dialog.categories?.[itemId] || {};
        const categoryName = String(choice.category_name || "").trim();
        const matched = choice.general ? null : choice.category_id
          ? availableCategories.find((category) => category.id === choice.category_id)
          : availableCategories.find((category) => category.name.localeCompare(categoryName, haListManagerShoppingCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
        const dynamicName = matched?.dynamic ? matched.name
          : !choice.general && !matched && categoryName ? categoryName : null;
        return {
          item_id: itemId,
          quantity: Math.max(1, Number.parseInt(dialog.quantities[itemId], 10) || 1),
          category_id: matched && !matched.dynamic ? matched.id : null,
          category: dynamicName,
        };
      });
      this._addDishToList(dialog.dish, items);
    });
    this._listen(root.querySelector(".backdrop[data-close-browser-chip-menu]"), "click", (event) => { if (event.target === event.currentTarget) this._closeBrowserChipMenu(); });
    root.querySelectorAll("button[data-close-browser-chip-menu]").forEach((element) => this._listen(element, "click", () => this._closeBrowserChipMenu()));
    this._listen(root.querySelector("[data-delete-browser-chip]"), "click", () => {
      this._removeBrowserChip(this._browserChipMenu?.chip);
      this._closeBrowserChipMenu();
    });
    this._listen(root.querySelector("[data-delete-all-browser-chips]"), "click", () => { this._browserChipMenu.confirmAll = true; this._render(); });
    this._listen(root.querySelector("[data-save-browser-chip]"), "click", () => this._saveBrowserChipPermanently());
    this._listen(root.querySelector("[data-toggle-important-chip]"), "click", () => this._toggleImportantChip(this._browserChipMenu?.chip));
    this._listen(root.querySelector("[data-cancel-browser-chip-confirmation]"), "click", () => { this._browserChipMenu.confirmAll = false; this._render(); });
    this._listen(root.querySelector("[data-confirm-delete-browser-chips]"), "click", () => { this._clearBrowserChips(); this._closeBrowserChipMenu(); });
    root.querySelectorAll("[data-close-dialog]").forEach((element) => this._listen(element, "click", () => this._closeDialog()));
    root.querySelectorAll("[data-close-image]").forEach((element) => this._listen(element, "click", () => { this._imageDialog = null; if (!this._dialog && !this._chipDialog) this._unlockScroll(); this._render(); }));
    this._listen(root.querySelector("[data-view-image]"), "click", () => { const product = this._dialog?.product; if (product?.image_url) { this._imageDialog = { url: largeImageUrl(product.image_url), name: this._dialog.name }; this._render(); } });
    this._listen(root.querySelector("[data-view-transfer-image]"), "click", () => {
      const draft = this._dialog;
      if (draft?.mode === "product-transfer" && draft.image_url) {
        this._imageDialog = { url: largeImageUrl(draft.image_url), name: draft.name };
        this._render();
      }
    });
    this._listen(root.querySelector("[data-d-offer-only]"), "change", (event) => { this._dialog.offer_only = event.target.checked; this._updateDialogDirtyState(); });
    this._listen(root.querySelector("[data-d-name]"), "input", (event) => { this._dialog.name = event.target.value; this._updateBringPreview(); this._updateDialogDirtyState(); });
    this._listen(root.querySelector("[data-d-description]"), "input", (event) => { this._dialog.description = event.target.value; this._updateBringPreview(); this._updateProductAmountDetails(); this._updateDialogDirtyState(); });
    this._listen(root.querySelector("[data-d-quantity]"), "input", (event) => { this._dialog.quantity = event.target.value; this._updateBringPreview(); this._updateProductAmountDetails(); this._updateDialogDirtyState(); });
    root.querySelectorAll("[data-dialog-quantity]").forEach((button) => this._listen(button, "click", () => {
      const input = root.querySelector("[data-d-quantity]");
      if (!input) return;
      const delta = Number(button.dataset.dialogQuantity || 0);
      input.value = String(Math.max(1, (Number.parseInt(input.value, 10) || 1) + delta));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }));
    this._listen(root.querySelector("[data-d-increment]"), "input", (event) => {
      this._dialog.increment = event.target.value;
      const current = Math.max(0, Number(this._dialog.item?.quantity || 0));
      const increment = Math.max(1, Number.parseInt(event.target.value, 10) || 1);
      const total = root.querySelector("[data-increment-total]");
      if (total) total.textContent = String(current + increment);
    });
    this._listen(root.querySelector("[data-increment-plus]"), "click", () => {
      const input = root.querySelector("[data-d-increment]");
      if (!input) return;
      input.value = String(Math.max(1, Number.parseInt(input.value, 10) || 1) + 1);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    this._listen(root.querySelector("[data-save-dialog]"), "click", () => this._saveDialog());
    this._listen(root.querySelector("[data-open-product-transfer]"), "click", () => this._openProductTransferDialog());
    root.querySelectorAll("[data-product-transfer-back]").forEach((button) => this._listen(button, "click", () => this._backToItemDialog()));
    this._listen(root.querySelector("[data-create-product-anyway]"), "click", () => {
      const parent = this._dialog?.parent;
      if (!parent) return;
      this._dialog = this._productTransferDraft(parent);
      this._render();
    });
    root.querySelectorAll("[data-link-existing-product]").forEach((button) => this._listen(button, "click", () => {
      const product = this._dialog?.matches?.find((entry) => entry.id === button.dataset.linkExistingProduct);
      if (product) this._linkProductToItem(product);
    }));
    root.querySelectorAll("[data-product-field]").forEach((input) => this._listen(input, "input", () => {
      if (this._dialog?.mode !== "product-transfer") return;
      this._dialog[input.dataset.productField] = input.value;
      if (input.dataset.productField === "ean") this._dialog.eanStatus = "";
      this._updateDialogDirtyState();
    }));
    this._listen(root.querySelector("[data-move-product-category]"), "change", (event) => { this._dialog.move_item_category = event.target.checked; this._updateDialogDirtyState(); });
    this._listen(root.querySelector("[data-lookup-product-ean]"), "click", () => this._lookupProductTransferEan());
    root.querySelectorAll("[data-off-change]").forEach((input) => this._listen(input, "change", () => this._applyProductRefresh(input.dataset.offChange, input.checked, this._dialog)));
    this._listen(root.querySelector("[data-save-product-transfer]"), "click", () => this._saveProductTransfer());
    this._listen(root.querySelector("[data-edit-existing]"), "click", () => {
      const { item, product } = this._dialog;
      this._openDialog(item, product);
    });
    this._listen(root.querySelector("[data-delete-item]"), "click", () => this._delete(this._dialog.item));
    this._listen(root.querySelector("[data-confirm-delete]"), "click", () => this._confirmDelete());
    this._listen(root.querySelector("[data-clear-completed]"), "click", () => this._requestClearCompleted());
    this._listen(root.querySelector("[data-toggle-grouping]"), "click", () => this._toggleGrouping());
    this._listen(root.querySelector("[data-toggle-categories]"), "click", () => this._toggleAllCategories());
    this._listen(root.querySelector("[data-confirm-share]"), "click", () => this._confirmShare());
    root.querySelectorAll("[data-share-profile]").forEach((checkbox) => this._listen(checkbox, "change", () => {
      const selected = new Set(this._confirmation?.selectedIds || []);
      if (checkbox.checked) selected.add(checkbox.dataset.shareProfile);
      else selected.delete(checkbox.dataset.shareProfile);
      this._confirmation.selectedIds = [...selected];
      const sendButton = root.querySelector("[data-confirm-share]");
      if (sendButton) sendButton.disabled = selected.size === 0;
    }));
    this._bindDiscardConfirmation();
    if (this._confirmation?.type !== "discard_dialog") {
      root.querySelectorAll("[data-cancel-delete],[data-cancel-confirmation]").forEach((button) => this._listen(button, "click", () => this._cancelConfirmation()));
    }
    this._configureCategorySelector();
    this._configureLabelSelector();
    this._installPickerListTriggers();
    this._bindDynamicContent();
    globalThis.HaListManagerDialogSections.bind(this);
    this._bindScrollGuard();
  }
}

class HaListManagerShoppingCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._form = null;
  }

  set hass(value) {
    this._hass = value;
    haListManagerShoppingCardTextUpdateTranslations(this, value);
    this._render();
  }

  setConfig(config) {
    this._config = { ...HaListManagerShoppingCard.getStubConfig(this._hass), ...config };
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
    const definition = HaListManagerShoppingCard.getConfigForm(this._hass);
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = definition.schema;
    this._form.computeLabel = definition.computeLabel;
    this._form.computeHelper = definition.computeHelper;
  }
}

globalThis.HaListManagerFilters.install(HaListManagerShoppingCard.prototype);

if (!customElements.get("ha-list-manager-shopping-card-editor")) customElements.define("ha-list-manager-shopping-card-editor", HaListManagerShoppingCardEditor);
if (!customElements.get("ha-list-manager-shopping-card")) customElements.define("ha-list-manager-shopping-card", HaListManagerShoppingCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "ha-list-manager-shopping-card")) window.customCards.push({ type: "ha-list-manager-shopping-card", name: "HA List Manager · Shopping", preview: false });
console.info(`%c HA-LIST-MANAGER-SHOPPING-CARD %c ${CARD_VERSION} `, "color:white;background:#03a9f4;font-weight:bold", "color:#03a9f4;background:white;font-weight:bold");
