import "./ha-list-manager-frontend-refresh.js";
import "./ha-list-manager-filters.js";
import "./ha-list-manager-dialog-sections.js?v=1.1.0b3-labels";

// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerTodoCardTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerTodoCardTextLanguage(hass = null) {
  return haListManagerTodoCardTextLocale(hass).toLowerCase().split("-")[0] === "de" ? "de" : "en";
}
function haListManagerTodoCardText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerTodoCardTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerTodoCardTextLocale(hass));
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
function haListManagerTodoCardTextUpdateTranslations(element, hass) {
  if (!hass) return false;
  const previous = element._nativeTranslationState;
  const language = String(hass.language || haListManagerTodoCardTextLocale(hass));
  const connection = hass.connection || hass;
  const changed = !previous || previous.language !== language || previous.connection !== connection;
  const wasReady = previous?.ready;
  let state = previous;
  if (changed) {
    state = { language, connection, previousLocalize: previous?.localize, switched: Boolean(previous && previous.language !== language), localize: hass.localize, renderedLocalize: hass.localize, ready: false };
    // Preloaded resources are immediately usable, including in an editor.
    state.ready = Boolean(haListManagerTodoCardText("ui.cancel", {}, hass)) && (!state.switched || hass.localize !== state.previousLocalize);
    element._nativeTranslationState = state;
    haListManagerTodoCardTextLoadTranslations(hass).then((localize) => {
      if (element._nativeTranslationState !== state) return;
      state.needsRefresh = Boolean(localize && localize !== state.renderedLocalize);
      const current = element._hass;
      if (!current || String(current.language || haListManagerTodoCardTextLocale(current)) !== language || (current.connection || current) !== connection) return;
      if (haListManagerTodoCardText("ui.cancel", {}, current) && (!state.switched || current.localize !== state.previousLocalize) && (!state.ready || (state.needsRefresh && current.localize !== state.renderedLocalize))) {
        state.ready = true;
        state.needsRefresh = false;
        state.renderedLocalize = current.localize;
        haListManagerTodoCardTextUpdateMetadata(current);
        element._render();
      }
    }).catch((error) => {
      if (element._nativeTranslationState === state) console.warn(error);
    });
  } else if (!state.ready && haListManagerTodoCardText("ui.cancel", {}, hass) && (!state.switched || hass.localize !== state.previousLocalize)) {
    state.ready = true;
  }
  const refresh = state.ready && state.needsRefresh && hass.localize !== state.renderedLocalize;
  if (state.ready && (changed || !wasReady || refresh)) { state.renderedLocalize = hass.localize; state.needsRefresh = false; }
  state.localize = hass.localize;
  if (state.ready && (changed || !wasReady || refresh)) haListManagerTodoCardTextUpdateMetadata(hass);
  return state.ready && (changed || !wasReady || refresh);
}
function haListManagerTodoCardTextUpdateMetadata(hass) {
  const metadata = window.customCards?.find((card) => card.type === "ha-list-manager-todo-card");
  if (metadata) {
    metadata.name = haListManagerTodoCardText("ui.todo_card_name", {}, hass) || metadata.name;
    metadata.description = haListManagerTodoCardText("help.backend_todo_features", {}, hass);
  }
}
function haListManagerTodoCardTextRequest(hass, message) {
  return hass.callWS(message.type?.startsWith("ha_list_manager/") ? { ...message, language: haListManagerTodoCardTextLanguage(hass) } : message);
}

const HA_LM_API = "ha_list_manager";
const HA_LM_ITEMS_EVENT = "ha_list_manager_items_changed";
const HA_LM_LISTS_EVENT = "ha_list_manager_lists_changed";
const CARD_VERSION = "1.1.0b3";

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);
const FILTERS = (hass = null) => ({
  all: haListManagerTodoCardText("ui.all", {}, hass), today: haListManagerTodoCardText("ui.today", {}, hass), overdue: haListManagerTodoCardText("todo.overdue", {}, hass),
  overdue_include_today: haListManagerTodoCardText("ui.overdue_including_today", {}, hass), upcoming: haListManagerTodoCardText("ui.future", {}, hass),
  dated: haListManagerTodoCardText("todo.with_due_date", {}, hass), undated: haListManagerTodoCardText("ui.without_due_date", {}, hass),
});

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

class HaListManagerTodoCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    globalThis.HaListManagerFilters.init(this);
    this._taskFilterMemory = new Map();
    this._list = null;
    this._items = [];
    this._categories = [];
    this._labels = [];
    this._chips = [];
    this._importantChipKeys = new Set();
    this._chipCategoryOpen = {};
    this._chipDialog = false;
    this._chipMenu = null;
    this._chipPressTimer = null;
    this._suppressChipClickUntil = 0;
    this._input = "";
    this._dialog = null;
    this._selectionPopup = null;
    this._actionDialog = null;
    this._templateDialog = null;
    this._filterDialog = false;
    this._filterPortal = null;
    this._confirmation = null;
    this._error = "";
    this._loading = false;
    this._loadRequestId = 0;
    this._busy = false;
    this._notificationAssignments = [];
    this._notificationStatus = "";
    this._pdfExporting = false;
    this._headerMenuOpen = false;
    this._unsubscribe = null;
    this._subscribePromise = null;
    this._refreshTimer = null;
    this._pressTimer = null;
    this._suppressActionClickUntil = 0;
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
    this._scrollLocked = false;
    this._oldOverflow = "";
    this._renderListeners = [];
    this._onExpandedViewResize = () => this._scheduleExpandedViewBounds();
    this._onExpandedViewKeydown = (event) => {
      if (event.key === "Escape" && this._confirmation?.type === "discard_dialog") { event.preventDefault(); event.stopPropagation(); this._cancelDialogDiscard(); return; }
      if (event.key === "Escape" && this._dialog) { event.preventDefault(); event.stopPropagation(); this._closeDialogs(); return; }
      if (event.key === "Escape" && this._selectionPopup) { event.preventDefault(); event.stopPropagation(); this._closeSelectionPopup(); return; }
      if (event.key === "Escape" && this._expandedView) this._setExpandedView(false);
    };
  }

  static getConfigElement() { return document.createElement("ha-list-manager-todo-card-editor"); }

  static getStubConfig(hass = null) {
    return {
      title: haListManagerTodoCardText("ui.tasks", {}, hass), title_icon: "mdi:checkbox-marked-outline", view_mode: "auto", content_display: "card_and_large", collapsible: true,
      input_row_position: "top", option_row_position: "bottom", show_category_toggle_button: true, show_input_mask: true,
      show_submit_button: true, show_clear_button: true, allow_filter: false, auto_expand_search: true,
      show_share_button: true, show_pdf_export_button: false, show_edit_shortcuts: true,
      show_chips: true, show_chip_popup_button: true, filter_chips: true, show_important_chips: true,
      category_chip_layout: "none", category_chip_colors: true, important_chip_color_rgb: [244, 67, 54], chips_position: "auto",
      show_descriptions: true, show_labels: true, show_item_dividers: true, item_divider_before_spacing: 10, item_divider_after_spacing: 10, item_font_size: 16, category_font_scale: 110,
      acknowledged: "show", sort_mode: "due", category_sort: "alphabetical", label_grouping: "disabled",
      show_category_count: true, show_title_info: true, show_title_info_icon: true,
      show_title_exclamation_mark: true, show_cat_next_due: true,
      show_last_checked: true, dates_inline: false,
      show_cat_exclamation_mark: true, cat_double_sized_icon: true,
      todo_filter: "all", show_todo_filter_menu: true, show_label_filter_button: true,
      todo_default_action: "done", todo_action_behavior: "menu",
      todo_yellow_m: 1440, todo_yellow_d: 120, todo_yellow_h: 10, todo_yellow_s: 120, todo_date_only_end_of_day: false,
      list_reload_time: 10,
    };
  }

  static getConfigForm(hass = null) {
    const entities = Object.entries(hass?.states || {})
      .filter(([id, state]) => id.startsWith("sensor.") && state.attributes?.list_type === "todo")
      .map(([id]) => id).sort();
    const labels = {
      entity: haListManagerTodoCardText("ui.todo_list", {}, hass), title: haListManagerTodoCardText("ui.title", {}, hass), title_icon: haListManagerTodoCardText("ui.title_icon", {}, hass), title_icon_color_rgb: haListManagerTodoCardText("ui.title_icon_color", {}, hass), view_mode: haListManagerTodoCardText("ui.appearance", {}, hass), content_display: haListManagerTodoCardText("ui.show_content", {}, hass), collapsible: haListManagerTodoCardText("ui.list_collapsible", {}, hass),
      input_row_position: haListManagerTodoCardText("ui.input_row", {}, hass), option_row_position: haListManagerTodoCardText("ui.button_bar", {}, hass), show_category_toggle_button: haListManagerTodoCardText("ui.show_category_toggle", {}, hass),
      show_edit_shortcuts: haListManagerTodoCardText("shopping.show_edit_shortcuts", {}, hass),
      show_input_mask: haListManagerTodoCardText("ui.show_input_row", {}, hass), show_submit_button: haListManagerTodoCardText("ui.show_add_button", {}, hass),
      allow_filter: haListManagerTodoCardText("ui.filter_tasks_while_typing", {}, hass),
      auto_expand_search: haListManagerTodoCardText("ui.auto_expand_search", {}, hass),
      show_chips: haListManagerTodoCardText("ui.show_todo_templates", {}, hass), show_chip_popup_button: haListManagerTodoCardText("ui.show_template_input_button", {}, hass), listed_chip_display: haListManagerTodoCardText("chips.listed_display", {}, hass), chip_font_size: haListManagerTodoCardText("chips.font_size", {}, hass), filter_chips: haListManagerTodoCardText("ui.filter_templates_typing", {}, hass),
      show_important_chips: haListManagerTodoCardText("ui.show_important_templates", {}, hass), category_chip_layout: haListManagerTodoCardText("ui.category_display", {}, hass),
      category_chip_colors: haListManagerTodoCardText("chips.use_category_color", {}, hass), important_chip_color_rgb: haListManagerTodoCardText("ui.important_template_color", {}, hass), chips_position: haListManagerTodoCardText("ui.template_position", {}, hass),
      show_clear_button: haListManagerTodoCardText("ui.delete_completed_tasks", {}, hass), show_share_button: haListManagerTodoCardText("ui.show_share_button", {}, hass), show_pdf_export_button: haListManagerTodoCardText("ui.show_pdf_export", {}, hass), show_descriptions: haListManagerTodoCardText("todo.show_descriptions", {}, hass), show_item_dividers: haListManagerTodoCardText("ui.show_dividers", {}, hass), item_divider_before_spacing: haListManagerTodoCardText("ui.divider_top_spacing", {}, hass), item_divider_after_spacing: haListManagerTodoCardText("ui.divider_bottom_spacing", {}, hass), item_font_size: haListManagerTodoCardText("ui.entry_text_size", {}, hass), category_font_scale: haListManagerTodoCardText("categories.name_size", {}, hass), show_labels: haListManagerTodoCardText("ui.show_labels", {}, hass),
      acknowledged: haListManagerTodoCardText("ui.completed_tasks", {}, hass), sort_mode: haListManagerTodoCardText("ui.sort_tasks", {}, hass),
      label_grouping: haListManagerTodoCardText("ui.label_grouping", {}, hass), category_sort: haListManagerTodoCardText("ui.category_sort_order", {}, hass), show_category_count: haListManagerTodoCardText("ui.show_category_task_count", {}, hass),
      show_title_info: haListManagerTodoCardText("ui.show_next_due_below_title", {}, hass),
      show_title_info_icon: haListManagerTodoCardText("ui.show_due_calendar_icon", {}, hass),
      show_title_exclamation_mark: haListManagerTodoCardText("todo.show_title_warning", {}, hass),
      show_last_checked: haListManagerTodoCardText("todo.show_last_checked", {}, hass),
      dates_inline: haListManagerTodoCardText("todo.dates_inline", {}, hass),
      show_cat_next_due: haListManagerTodoCardText("ui.show_category_next_due", {}, hass),
      show_cat_exclamation_mark: haListManagerTodoCardText("ui.show_category_warning", {}, hass),
      cat_double_sized_icon: haListManagerTodoCardText("todo.large_due_category_icon", {}, hass),
      show_label_filter_button: haListManagerTodoCardText("filters.show", {}, hass),
      todo_filter: haListManagerTodoCardText("ui.default_filter", {}, hass), show_todo_filter_menu: haListManagerTodoCardText("ui.show_filter_button", {}, hass),
      todo_default_action: haListManagerTodoCardText("ui.default_action", {}, hass), todo_action_behavior: haListManagerTodoCardText("todo.action_box_behavior", {}, hass),
      todo_date_only_end_of_day: haListManagerTodoCardText("todo.date_only_end_of_day", {}, hass),
      todo_yellow_m: haListManagerTodoCardText("ui.monthly_interval_warning", {}, hass), todo_yellow_d: haListManagerTodoCardText("ui.warning_daily_intervals", {}, hass),
      todo_yellow_h: haListManagerTodoCardText("todo.hourly_warning_lead_time", {}, hass), todo_yellow_s: haListManagerTodoCardText("ui.warning_nonrecurring_tasks", {}, hass),
      list_reload_time: haListManagerTodoCardText("ui.refresh_due_display", {}, hass),
    };
    const dropdown = (options) => ({ select: { mode: "dropdown", options } });
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { include_entities: entities } } },
        { type: "expandable", label: haListManagerTodoCardText("ui.general", {}, hass), icon: "mdi:cog-outline", schema: [
          { name: "title", selector: { text: {} }, default: haListManagerTodoCardText("ui.tasks", {}, hass) },
          { name: "title_icon", selector: { icon: {} }, default: "mdi:checkbox-marked-outline" },
          { name: "title_icon_color_rgb", selector: { color_rgb: {} } },
          { name: "view_mode", selector: dropdown([{ value: "auto", label: haListManagerTodoCardText("ui.automatic", {}, hass) }, { value: "panel", label: haListManagerTodoCardText("ui.panel_view", {}, hass) }, { value: "mobile", label: haListManagerTodoCardText("ui.mobile_view", {}, hass) }]), default: "auto" },
          { name: "content_display", selector: dropdown([
            { value: "card_and_large", label: haListManagerTodoCardText("ui.card_and_large_view", {}, hass) },
            { value: "card_only", label: haListManagerTodoCardText("ui.card_only", {}, hass) },
            { value: "large_only", label: haListManagerTodoCardText("ui.large_view_only", {}, hass) },
          ]), default: "card_and_large" },
          { name: "collapsible", selector: { boolean: {} }, default: true },
          { name: "input_row_position", selector: dropdown([{ value: "top", label: haListManagerTodoCardText("ui.top", {}, hass) }, { value: "bottom", label: haListManagerTodoCardText("ui.bottom", {}, hass) }]), default: "top" },
          { name: "option_row_position", selector: dropdown([{ value: "top", label: haListManagerTodoCardText("ui.top", {}, hass) }, { value: "bottom", label: haListManagerTodoCardText("ui.bottom", {}, hass) }]), default: "bottom" },
          { name: "show_category_toggle_button", selector: { boolean: {} }, default: true },
          { name: "label_grouping", selector: dropdown([
            { value: "disabled", label: haListManagerTodoCardText("ui.label_grouping_disabled", {}, hass) },
            { value: "categories", label: haListManagerTodoCardText("ui.label_grouping_categories", {}, hass) },
            { value: "labels", label: haListManagerTodoCardText("ui.label_grouping_labels", {}, hass) },
          ]), default: "disabled" },
          { name: "show_edit_shortcuts", selector: { boolean: {} }, default: true },
          { name: "show_input_mask", selector: { boolean: {} }, default: true },
          { name: "show_submit_button", selector: { boolean: {} }, default: true },
          { name: "show_clear_button", selector: { boolean: {} }, default: true },
          { name: "show_share_button", selector: { boolean: {} }, default: true },
          { name: "show_pdf_export_button", selector: { boolean: {} }, default: false },
          { name: "allow_filter", selector: { boolean: {} }, default: false },
          { name: "auto_expand_search", selector: { boolean: {} }, default: true },
        ] },
        { type: "expandable", label: haListManagerTodoCardText("ui.list_appearance", {}, hass), icon: "mdi:format-line-spacing", schema: [
          { name: "show_item_dividers", selector: { boolean: {} }, default: true },
          { name: "item_divider_before_spacing", selector: { number: { min: 0, max: 32, step: 1, mode: "slider", unit_of_measurement: "px" } }, default: 10 },
          { name: "item_divider_after_spacing", selector: { number: { min: 0, max: 32, step: 1, mode: "slider", unit_of_measurement: "px" } }, default: 10 },
          { name: "item_font_size", selector: { number: { min: 12, max: 24, step: 1, mode: "box", unit_of_measurement: "px" } }, default: 16 },
          { name: "category_font_scale", selector: { number: { min: 80, max: 160, step: 5, mode: "box", unit_of_measurement: "%" } }, default: 110 },
        ] },
        { type: "expandable", label: haListManagerTodoCardText("ui.tasks", {}, hass), icon: "mdi:format-list-checks", schema: [
          { name: "sort_mode", selector: dropdown([{ value: "alpha", label: haListManagerTodoCardText("ui.alphabetical", {}, hass) }, { value: "due", label: haListManagerTodoCardText("ui.sort_by_due_date", {}, hass) }, { value: "manual", label: haListManagerTodoCardText("ui.manual_drag_drop", {}, hass) }, { value: "none", label: haListManagerTodoCardText("ui.saved_order", {}, hass) }]), default: "due" },
          { name: "acknowledged", selector: dropdown([{ value: "show", label: haListManagerTodoCardText("ui.show_in_place", {}, hass) }, { value: "end", label: haListManagerTodoCardText("ui.show_at_end", {}, hass) }, { value: "hide", label: haListManagerTodoCardText("ui.hide", {}, hass) }]), default: "show" },
          { name: "show_descriptions", selector: { boolean: {} }, default: true },
          { name: "show_labels", selector: { boolean: {} }, default: true },
          { name: "show_hidden_labels", selector: { boolean: {} }, default: false },
          { name: "show_category_count", selector: { boolean: {} }, default: true },
          { name: "category_sort", selector: dropdown([{ value: "alphabetical", label: haListManagerTodoCardText("categories.combined_alphabetical", {}, hass) }, { value: "global_list_dynamic", label: haListManagerTodoCardText("categories.order_global_local_dynamic", {}, hass) }, { value: "list_global_dynamic", label: haListManagerTodoCardText("categories.order_local_global_dynamic", {}, hass) }, { value: "position", label: haListManagerTodoCardText("ui.manual_position", {}, hass) }]), default: "alphabetical" },
        ] },
        { type: "expandable", label: haListManagerTodoCardText("ui.due_date_and_filters", {}, hass), icon: "mdi:calendar-clock", schema: [
          { name: "todo_filter", selector: dropdown(Object.entries(FILTERS(hass)).map(([value, label]) => ({ value, label }))), default: "all" },
          { name: "show_todo_filter_menu", selector: { boolean: {} }, default: true },
          { name: "show_label_filter_button", selector: { boolean: {} }, default: true },
          { name: "show_title_info", selector: { boolean: {} }, default: true },
          { name: "show_title_info_icon", selector: { boolean: {} }, default: true },
          { name: "show_title_exclamation_mark", selector: { boolean: {} }, default: true },
          { name: "show_cat_next_due", selector: { boolean: {} }, default: true },
          { name: "show_last_checked", selector: { boolean: {} }, default: true },
          { name: "dates_inline", selector: { boolean: {} }, default: false },
          { name: "show_cat_exclamation_mark", selector: { boolean: {} }, default: true },
          { name: "cat_double_sized_icon", selector: { boolean: {} }, default: true },
        ] },
        { type: "expandable", label: haListManagerTodoCardText("ui.actions", {}, hass), icon: "mdi:gesture-tap-button", schema: [
          { name: "todo_default_action", selector: dropdown([{ value: "done", label: haListManagerTodoCardText("ui.toggle_completed", {}, hass) }, { value: "edit", label: haListManagerTodoCardText("todo.edit_task", {}, hass) }, { value: "remove", label: haListManagerTodoCardText("ui.remove_due_date", {}, hass) }, { value: "next", label: haListManagerTodoCardText("todo.set_next_due", {}, hass) }, { value: "now", label: haListManagerTodoCardText("ui.next_due_from_now", {}, hass) }, { value: "delete", label: haListManagerTodoCardText("ui.delete_task", {}, hass) }]), default: "done" },
          { name: "todo_action_behavior", selector: dropdown([{ value: "menu", label: haListManagerTodoCardText("ui.open_menu", {}, hass) }, { value: "click_menu_long_default", label: haListManagerTodoCardText("todo.click_menu_hold_default", {}, hass) }, { value: "click_default_long_menu", label: haListManagerTodoCardText("ui.tap_action_hold_menu", {}, hass) }]), default: "menu" },
        ] },
        { type: "expandable", label: haListManagerTodoCardText("todo.templates", {}, hass), icon: "mdi:gesture-tap-button", schema: [
          { name: "show_chips", selector: { boolean: {} }, default: true },
          { name: "show_chip_popup_button", selector: { boolean: {} }, default: true },
          { name: "filter_chips", selector: { boolean: {} }, default: true },
          { name: "listed_chip_display", selector: { select: { mode: "dropdown", options: [
            { value: "normal", label: haListManagerTodoCardText("chips.listed_normal", {}, hass) },
            { value: "dim", label: haListManagerTodoCardText("chips.listed_dim", {}, hass) },
            { value: "hide", label: haListManagerTodoCardText("chips.listed_hide", {}, hass) },
          ] } }, default: "normal" },
          { name: "chip_font_size", selector: { number: { min: 12, max: 24, step: 1, mode: "box", unit_of_measurement: "px" } } },
          { name: "category_chip_layout", selector: dropdown([
            { value: "none", label: haListManagerTodoCardText("ui.no_grouping", {}, hass) },
            { value: "stacked", label: haListManagerTodoCardText("ui.stacked_categories", {}, hass) },
            { value: "wrap", label: haListManagerTodoCardText("categories.side_by_side", {}, hass) },
            { value: "compact", label: haListManagerTodoCardText("ui.categories_side_by_side_compact", {}, hass) },
          ]), default: "none" },
          { name: "category_chip_colors", selector: { boolean: {} }, default: true },
          { name: "show_important_chips", selector: { boolean: {} }, default: true },
          { name: "important_chip_color_rgb", selector: { color_rgb: {} } },
          { name: "chips_position", selector: dropdown([{ value: "auto", label: haListManagerTodoCardText("ui.automatic", {}, hass) }, { value: "bottom", label: haListManagerTodoCardText("ui.bottom", {}, hass) }, { value: "right", label: haListManagerTodoCardText("ui.right", {}, hass) }]), default: "auto" },
        ] },
        { type: "expandable", label: haListManagerTodoCardText("ui.advance_warning_times", {}, hass), icon: "mdi:alert-outline", schema: [
          { name: "todo_date_only_end_of_day", selector: { boolean: {} }, default: false },
          { name: "todo_yellow_m", selector: { number: { min: 0, max: 300000, mode: "box", unit_of_measurement: "min" } }, default: 1440 },
          { name: "todo_yellow_d", selector: { number: { min: 0, max: 300000, mode: "box", unit_of_measurement: "min" } }, default: 120 },
          { name: "todo_yellow_h", selector: { number: { min: 0, max: 300000, mode: "box", unit_of_measurement: "min" } }, default: 10 },
          { name: "todo_yellow_s", selector: { number: { min: 0, max: 300000, mode: "box", unit_of_measurement: "min" } }, default: 120 },
          { name: "list_reload_time", selector: { number: { min: 1, max: 3600, mode: "box", unit_of_measurement: "s" } }, default: 10 },
        ] },
      ],
      computeLabel: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerTodoCard.getConfigForm({ ...(hass || {}), localize }).computeLabel(schema);
        if (schema.name === "show_hidden_labels") return haListManagerTodoCardText("labels.show_hidden", {}, hass);
        return labels[schema.name] || schema.label || schema.name;
      },
      computeHelper: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerTodoCard.getConfigForm({ ...(hass || {}), localize }).computeHelper(schema);
        return ({
        entity: haListManagerTodoCardText("help.available_todo_lists", {}, hass),
        title: haListManagerTodoCardText("help.card_heading", {}, hass), title_icon: haListManagerTodoCardText("help.title_icon", {}, hass), title_icon_color_rgb: haListManagerTodoCardText("help.title_icon_color", {}, hass),
        view_mode: haListManagerTodoCardText("help.responsive_view_mode", {}, hass),
        content_display: haListManagerTodoCardText("help.list_content_view", {}, hass),
        collapsible: haListManagerTodoCardText("help.title_collapse_card", {}, hass),
        input_row_position: haListManagerTodoCardText("help.todo_input_row_position", {}, hass),
        option_row_position: haListManagerTodoCardText("help.todo_toolbar_position", {}, hass),
        show_category_toggle_button: haListManagerTodoCardText("help.expand_all_categories_button", {}, hass),
        label_grouping: haListManagerTodoCardText("help.label_grouping", {}, hass),
        show_edit_shortcuts: haListManagerTodoCardText("help.todo_edit_shortcuts", {}, hass),
        show_input_mask: haListManagerTodoCardText("help.task_input_visibility", {}, hass),
        show_submit_button: haListManagerTodoCardText("help.todo_add_button", {}, hass),
        show_clear_button: haListManagerTodoCardText("help.delete_completed_tasks_button", {}, hass),
        show_share_button: haListManagerTodoCardText("help.share_button_visibility", {}, hass),
        show_pdf_export_button: haListManagerTodoCardText("help.todo_pdf_export", {}, hass),
        allow_filter: haListManagerTodoCardText("help.todo_search_filter", {}, hass),
        auto_expand_search: haListManagerTodoCardText("help.auto_expand_search", {}, hass),
        show_chips: haListManagerTodoCardText("help.todo_template_visibility", {}, hass),
        show_chip_popup_button: haListManagerTodoCardText("help.todo_template_input_button", {}, hass),
        filter_chips: haListManagerTodoCardText("help.template_typing_filter", {}, hass),
        category_chip_layout: haListManagerTodoCardText("help.template_category_layout", {}, hass),
        category_chip_colors: haListManagerTodoCardText("help.template_category_color", {}, hass),
        show_important_chips: haListManagerTodoCardText("help.important_templates", {}, hass),
        important_chip_color_rgb: haListManagerTodoCardText("help.important_template_color", {}, hass),
        chips_position: haListManagerTodoCardText("help.template_layout_auto", {}, hass),
        show_item_dividers: haListManagerTodoCardText("help.todo_item_dividers", {}, hass),
        item_divider_before_spacing: haListManagerTodoCardText("help.task_bottom_spacing", {}, hass),
        item_divider_after_spacing: haListManagerTodoCardText("help.task_top_spacing", {}, hass),
        listed_chip_display: haListManagerTodoCardText("chips.listed_help", {}, hass),
        chip_font_size: haListManagerTodoCardText("chips.font_size_help", {}, hass),
        item_font_size: haListManagerTodoCardText("help.todo_base_text_size", {}, hass),
        category_font_scale: haListManagerTodoCardText("help.category_relative_text_size", {}, hass),
        sort_mode: haListManagerTodoCardText("help.todo_sorting", {}, hass),
        acknowledged: haListManagerTodoCardText("help.completed_task_placement", {}, hass),
        show_descriptions: haListManagerTodoCardText("help.todo_description_visibility", {}, hass),
        show_labels: haListManagerTodoCardText("help.todo_label_visibility", {}, hass),
        show_category_count: haListManagerTodoCardText("help.category_task_counts", {}, hass),
        category_sort: haListManagerTodoCardText("help.todo_category_order", {}, hass),
        show_label_filter_button: haListManagerTodoCardText("filters.option_help", {}, hass),
        todo_filter: haListManagerTodoCardText("help.initial_task_filter", {}, hass),
        show_todo_filter_menu: haListManagerTodoCardText("help.list_filter_persistence", {}, hass),
        show_last_checked: haListManagerTodoCardText("help.last_checked", {}, hass),
        dates_inline: haListManagerTodoCardText("help.dates_inline", {}, hass),
        show_title_info: haListManagerTodoCardText("help.next_due_below_title", {}, hass),
        show_title_info_icon: haListManagerTodoCardText("help.due_calendar_icon", {}, hass),
        show_title_exclamation_mark: haListManagerTodoCardText("help.title_due_warning", {}, hass),
        show_cat_next_due: haListManagerTodoCardText("help.category_next_due", {}, hass),
        show_cat_exclamation_mark: haListManagerTodoCardText("help.category_due_warning", {}, hass),
        cat_double_sized_icon: haListManagerTodoCardText("help.large_due_category_icon", {}, hass),
        todo_default_action: haListManagerTodoCardText("help.default_chip_action", {}, hass),
        todo_action_behavior: haListManagerTodoCardText("help.chip_click_actions", {}, hass),
        todo_date_only_end_of_day: haListManagerTodoCardText("help.date_only_end_of_day", {}, hass),
        todo_yellow_m: haListManagerTodoCardText("help.monthly_due_warning", {}, hass),
        todo_yellow_d: haListManagerTodoCardText("help.daily_interval_warning", {}, hass),
        todo_yellow_h: haListManagerTodoCardText("help.hourly_due_warning", {}, hass),
        todo_yellow_s: haListManagerTodoCardText("help.nonrepeating_due_warning", {}, hass),
        list_reload_time: haListManagerTodoCardText("help.remaining_time_refresh", {}, hass),
      }[schema.name] || "");
      },

    };
  }

  setConfig(config) {
    this._config = { ...HaListManagerTodoCard.getStubConfig(this._hass), ...config };
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
    for (const [key, fallback] of Object.entries({ todo_yellow_m: 1440, todo_yellow_d: 120, todo_yellow_h: 10, todo_yellow_s: 120 })) {
      const value = this._config[key];
      const minutes = Number(value);
      this._config[key] = ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(minutes) && minutes >= 0 ? minutes : fallback;
    }
    this._config.todo_date_only_end_of_day = this._config.todo_date_only_end_of_day === true;
    if (!["disabled", "categories", "labels"].includes(this._config.label_grouping)) this._config.label_grouping = "disabled";
    if (!["card_and_large", "card_only", "large_only"].includes(this._config.content_display)) this._config.content_display = "card_and_large";
    if (this._expandedView && this._config.content_display === "card_only") this._setExpandedView(false);
    this._render(); this._load(); this._restartTimer();
  }
  set hass(value) {
    this._hass = value;
    globalThis.HaListManagerFrontendRefresh.attach(this);
    if (this.isConnected) this._watchConnection();
    const translationsChanged = haListManagerTodoCardTextUpdateTranslations(this, this._hass);
    this._subscribe();
    if (!this._list) this._load(true);
    if (translationsChanged) this._render();
  }
  connectedCallback() { globalThis.HaListManagerFrontendRefresh.attach(this); this._watchConnection(); this._render(); this._subscribe(); this._load(true); this._restartTimer(); }
  disconnectedCallback() {
    globalThis.HaListManagerFrontendRefresh.detach(this);
    this._watchConnection(null);
    this._setExpandedView(false);
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._loadRequestId += 1;
    this._loading = false;
    clearInterval(this._refreshTimer);
    // Detached long presses must not change tasks or lock the page again.
    clearTimeout(this._pressTimer);
    clearTimeout(this._chipPressTimer);
    this._pressTimer = null;
    this._chipPressTimer = null;
    this._removeFilterPortal();
    this._invalidateSavedLabelFilters();
    this._labelFilterDialog = null;
    this._filterMenuOpen = false;
    clearTimeout(this._filterPressTimer);
    this._clearRenderListeners();
    this._unlock();
  }
  getCardSize() { return this._config.content_display === "large_only" ? 1 : Math.max(3, Math.ceil(this._visibleItems().length * .55) + 2); }
  _listId() { return this._hass?.states?.[this._config.entity]?.attributes?.list_id || this._config.list_id || null; }
  _identity() { return this._config.card_id || this._config.entity || this._listId() || "todo"; }
  _groupingKey() { return `ha-list-manager:todo-grouping:${encodeURIComponent(this._identity())}`; }
  _groupingMode() {
    if (!["categories", "labels"].includes(this._config.label_grouping)) return "categories";
    const key = this._groupingKey();
    if (this._groupingOverride?.key === key) return this._groupingOverride.mode;
    try {
      const stored = localStorage.getItem(key);
      if (["categories", "labels"].includes(stored)) return stored;
    } catch (_error) {}
    return this._config.label_grouping;
  }
  _toggleGrouping() {
    if (!["categories", "labels"].includes(this._config.label_grouping)) return;
    const mode = this._groupingMode() === "labels" ? "categories" : "labels";
    const key = this._groupingKey();
    this._groupingOverride = { key, mode };
    try { localStorage.setItem(key, mode); } catch (_error) {}
    this._expandedScrollAnchor = null;
    this._render();
  }
  _groupToggleLabel(action) {
    return haListManagerTodoCardText(this._groupingMode() === "labels" ? "ui.all_labels_count" : "ui.all_categories_count", { p0: action }, this._hass);
  }
  _filterKey() { return `ha-list-manager:todo-filter:${encodeURIComponent(this._identity())}`; }
  _capturePageScrollAnchor(preferred = null) {
    if (this._expandedView) return null;
    const scrollers = [];
    for (let node = this; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) scrollers.push(node);
    }
    if (!scrollers.length) return null;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const selector = "[data-entry-id],[data-group-id],[data-item-id],[data-chip-category],[data-quick-chip],[data-dish],[data-category],[data-label-filter-preset],[data-open-label-filter]";
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
    if (!anchor) return;
    if (!anchor.node.isConnected) {
      const attribute=anchor.node.getAttributeNames?.().find(name=>name.startsWith("data-"));
      const value=attribute ? anchor.node.getAttribute(attribute) : null;
      anchor.node=attribute ? [...this.shadowRoot.querySelectorAll(`[${attribute}]`)].find(node=>node.getAttribute(attribute)===value && !node.closest(".backdrop,.filter-menu")) : null;
    }
    if (!anchor.node?.isConnected) return;
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

  _savedTaskFilter() {
    let value;
    try { value = localStorage.getItem(this._filterKey()); } catch (_error) {}
    return Object.hasOwn(FILTERS(this._hass), value) ? value : this._config.todo_filter || "all";
  }
  _taskSelectionKey() { return `${this._filterKey()}:active:${encodeURIComponent(this._filterOwnerKey())}`; }
  _activeFilter() {
    let value = this._taskFilterMemory.get(this._taskSelectionKey());
    try { value = localStorage.getItem(this._taskSelectionKey()) || value; } catch (_error) {}
    return Object.hasOwn(FILTERS(this._hass), value) ? value : this._savedTaskFilter();
  }
  _filterModesEnabled() { return this._config.show_todo_filter_menu !== false; }
  _filterModeHeading() { return this._filterText("task_settings"); }
  _filterModes() { return Object.entries(FILTERS(this._hass)).map(([value,label])=>({value,label})); }
  _filterMode() { return this._activeFilter(); }
  _setFilterMode(value) {
    if (!Object.hasOwn(FILTERS(this._hass),value)) return;
    this._taskFilterMemory.set(this._taskSelectionKey(),value);
    try { localStorage.setItem(this._taskSelectionKey(),value); } catch (_error) {}
  }
  _filterModeSettings() { this._openFilterPortal(); }
  _positionFilterMenu(menu, button) {
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || window.innerHeight);
    const below = Math.max(0,bottom-rect.bottom-12), above = Math.max(0,rect.top-top-12);
    const openBelow = below >= menu.scrollHeight || below >= above;
    Object.assign(menu.style,{top:openBelow ? "calc(100% + 6px)" : "auto",bottom:openBelow ? "auto" : "calc(100% + 6px)",maxHeight:`${openBelow ? below : above}px`});
  }
  _lockScroll() { this._lock(); }
  _unlockScroll() { this._unlock(); }
  _refreshMetadataUi() { this._render(); }

  _listCollapseKey() { return `ha-list-manager:todo-list:${encodeURIComponent(this._identity())}`; }
  _listCollapsed() { try { return localStorage.getItem(this._listCollapseKey()) === "1"; } catch (_e) { return false; } }
  _toggleList() { try { const key = this._listCollapseKey(); this._listCollapsed() ? localStorage.removeItem(key) : localStorage.setItem(key, "1"); } catch (_e) {} this._render(); }
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
      ["--expanded-top", "--expanded-left", "--expanded-right", "--expanded-bottom"].forEach((property) => this.style.removeProperty(property));
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
      element.setAttribute("title", next ? haListManagerTodoCardText("ui.close_large_view", {}, this._hass) : haListManagerTodoCardText("ui.open_large_view", {}, this._hass));
      element.setAttribute("aria-label", next ? haListManagerTodoCardText("ui.close_large_view", {}, this._hass) : haListManagerTodoCardText("ui.open_large_view", {}, this._hass));
    });
  }
  _toggleExpandedView(event) { event?.preventDefault(); event?.stopPropagation(); this._setExpandedView(!this._expandedView); }
  _rememberExpandedScroll(itemId = null, sourceRow = null) {
    if (!this._expandedView) return;
    const card = this.shadowRoot?.querySelector("ha-card");
    if (!card || !Number.isFinite(card.scrollTop)) return;
    this._expandedScrollTop = card.scrollTop;
    const rows = itemId ? [...this.shadowRoot.querySelectorAll("[data-item-id]")].filter((element) => element.dataset.itemId === itemId) : [];
    const activeRow = this.shadowRoot.activeElement?.closest?.("[data-item-id]");
    const previousGroup = this._expandedScrollAnchor?.itemId === itemId ? this._expandedScrollAnchor.categoryId : null;
    const previousRow = rows.find((element) => previousGroup != null && element.closest?.(".category")?.dataset.categoryId === previousGroup);
    const focusedRow = rows.includes(activeRow) ? activeRow : null;
    const row = rows.includes(sourceRow) ? sourceRow : ((this._dialog || this._actionDialog) ? previousRow || focusedRow : focusedRow || previousRow) || rows[0];
    if (row) {
      this._expandedScrollAnchor = {
        itemId,
        categoryId: row.closest?.(".category")?.dataset.categoryId ?? null,
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
        ? [...this.shadowRoot.querySelectorAll("[data-item-id]")].find((element) => element.dataset.itemId === anchor.itemId && (anchor.categoryId == null || element.closest?.(".category")?.dataset.categoryId === anchor.categoryId))
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
  _collapseKey(id) { return `ha-list-manager:todo-category:${encodeURIComponent(this._identity())}:${encodeURIComponent(id || "__none__")}`; }
  _searchExpandsGroups() { return this._config.auto_expand_search !== false && Boolean(this._config.allow_filter && this._input.trim()); }
  _collapsed(id) { if (this._searchExpandsGroups()) return false; try { return localStorage.getItem(this._collapseKey(id)) === "1"; } catch (_e) { return false; } }
  _applyCategoryState(id, collapsed, button = null) {
    const header = button || [...this.shadowRoot.querySelectorAll("[data-category]")].find((element) => element.dataset.category === id);
    const section = header?.closest(".category");
    const group = this._groups().find(({ category }) => String(category.id) === String(id));
    if (!header || !section || !group) return false;
    header.setAttribute("aria-expanded", String(!collapsed));
    header.lastElementChild?.setAttribute("icon", `mdi:chevron-${collapsed ? "down" : "up"}`);
    const previousItems = section.querySelector(".items");
    if (previousItems) { this._clearRenderListeners(previousItems); previousItems.remove(); }
    if (!collapsed) {
      section.insertAdjacentHTML("beforeend", `<div class="items">${group.items.map((item) => this._itemHtml(item)).join("")}</div>`);
      this._bindContent(section, false);
    }
    return true;
  }
  _toggleCategory(id, button = null) {
    if (this._searchExpandsGroups()) return;
    const collapsed = !this._collapsed(id);
    try { const key = this._collapseKey(id); collapsed ? localStorage.setItem(key, "1") : localStorage.removeItem(key); } catch (_e) {}
    if (!this._applyCategoryState(id, collapsed, button)) this._render();
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
    groups.forEach(({ category }) => this._applyCategoryState(category.id, collapse));
    const toggle = this.shadowRoot.querySelector("[data-toggle-categories]");
    if (toggle) {
      const action = collapse ? haListManagerTodoCardText("ui.expand_lowercase", {}, this._hass) : haListManagerTodoCardText("ui.collapse_lowercase", {}, this._hass);
      toggle.setAttribute("aria-expanded", String(!collapse));
      toggle.setAttribute("aria-label", this._groupToggleLabel(action));
      toggle.setAttribute("title", this._groupToggleLabel(action));
      toggle.querySelector("ha-icon")?.setAttribute("icon", `mdi:unfold-${collapse ? "more" : "less"}-horizontal`);
      const label = toggle.querySelector("span");
      if (label) label.textContent = this._groupToggleLabel(action);
    }
  }
  _restartTimer() { clearInterval(this._refreshTimer); this._refreshTimer = setInterval(() => { if (document.visibilityState === "visible" && !this._dialog && !this._actionDialog) this._refreshDueText(); }, Math.max(1, Number(this._config.list_reload_time) || 10) * 1000); }
  _refreshDueText() { this.shadowRoot?.querySelectorAll("[data-due-id]").forEach((node) => { const item = this._items.find((entry) => entry.id === node.dataset.dueId); if (item) node.innerHTML = this._dueHtml(item); }); }

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
          if (event.data?.label_filters) this._loadSavedLabelFilters().catch(()=>{});
          else this._load(true);
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

  async _load(force = false) {
    const id = this._listId();
    if (!this._hass || !id || this._hass.connection?.connected === false || (this._loading && !force)) return;
    const requestId = ++this._loadRequestId;
    this._loading = true;
    this._error = "";
    try {
      const [lists, items, categories, labels, chips, notifications, importantChips] = await Promise.all([
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/lists/list` }),
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/list`, list_id: id }),
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/categories/order/get`, list_id: id }),
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/labels/list`, list_id: id }),
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/list`, list_id: id }),
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/notifications/assignments/list`, list_id: id }),
        haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/important/list`, list_id: id }),
        (this._savedFiltersStale || this._savedFilterScope !== this._filterOwnerKey()) ? this._loadSavedLabelFilters(false) : Promise.resolve(),
      ]);
      if (requestId !== this._loadRequestId) return;
      const nextList = lists.lists.find((entry) => entry.id === id) || null;
      if (nextList && nextList.list_type !== "todo") throw new Error(haListManagerTodoCardText("ui.todo_lists_only", {}, this._hass));
      this._list = nextList;
      this._items = items.items || [];
      // The returned order includes the list override, unlike each category's base position.
      this._categories = (categories.categories || []).map((category, manual_position) => ({ ...category, manual_position }));
      this._labels = labels.labels || [];
      this._chips = (chips.chips || []).filter((chip) => chip.chip_kind === "todo_template");
      this._notificationAssignments = notifications.assignments || [];
      this._importantChipKeys = new Set((importantChips.assignments || []).map((entry) => `${entry.target_type}:${entry.target_id}`));
    } catch (error) {
      // HA rejects interrupted reads with its connection-lost envelope (code 3).
      // Keep the cached list; the native ready event requests fresh data.
      if (requestId === this._loadRequestId && error !== 3 && error?.error?.code !== 3) {
        this._error = error?.message || error?.error?.message || (typeof error === "string" ? error : haListManagerTodoCardText("errors.list_load_failed", {}, this._hass));
      }
    } finally {
      if (requestId === this._loadRequestId) {
        this._loading = false;
        this._render();
      }
    }
  }

  _name(item) { return String(item?.name || "").trim(); }
  _interval(item) {
    if (Number(item?.recurrence_interval) >= 1 && ["H", "D", "M"].includes(item?.recurrence_unit)) {
      return { value: Number(item.recurrence_interval), unit: item.recurrence_unit };
    }
    return null;
  }
  _due(item) { if (!item?.due_at) return null; const date = new Date(item.due_at); return Number.isNaN(date.getTime()) ? null : date; }
  _calendarDue(item) {
    const value = String(item?.due_at || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return this._due(item);
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  _warningDue(item) {
    const due = this._calendarDue(item);
    if (due && this._config.todo_date_only_end_of_day && /^\d{4}-\d{2}-\d{2}$/.test(String(item?.due_at))) {
      // Shift a calendar day, not 24 hours: local midnight can cross DST.
      due.setDate(due.getDate() + 1);
    }
    return due;
  }
  _dateOnly(item) { return Boolean(item?.due_at && !String(item.due_at).includes("T")); }
  _startToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  _isDue(item) { const due = this._due(item); if (!due || item.completed || item.monitoring_paused) return false; return this._dateOnly(item) ? due < new Date(this._startToday().getTime() + 86400000) : due <= new Date(); }
  _isOverdue(item) { const due = this._due(item); return Boolean(due && !item.completed && !item.monitoring_paused && due < this._startToday()); }
  _warningMinutes(item) { const interval = this._interval(item); return Number(interval ? this._config[`todo_yellow_${interval.unit.toLowerCase()}`] : this._config.todo_yellow_s) || 0; }
  _status(item) {
    const due = this._warningDue(item);
    if (!due || item.completed || item.monitoring_paused) return "";
    const minutes = (due.getTime() - Date.now()) / 60000;
    if (minutes <= 0) return "overdue";
    const warning = this._warningMinutes(item);
    return warning > 0 && minutes <= warning ? "soon" : "future";
  }
  _formatDue(item) {
    const due = this._calendarDue(item); if (!due) return "";
    const options = this._dateOnly(item) ? { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" } : { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" };
    return new Intl.DateTimeFormat(haListManagerTodoCardTextLocale(this._hass), options).format(due);
  }
  _intervalText(item) {
    const interval = this._interval(item);
    return interval ? `${interval.value}${interval.unit}` : "";
  }
  _remainingDue(item) {
    const due = this._due(item);
    if (!due) return "";
    if (this._isDue(item)) return haListManagerTodoCardText("todo.due", {}, this._hass);
    if (this._dateOnly(item)) {
      const days = Math.round((due - this._startToday()) / 86400000);
      if (days === 1) return haListManagerTodoCardText("ui.one_day", {}, this._hass);
      return haListManagerTodoCardText("ui.days_count", {p0:(days)}, this._hass);
    }
    let remaining = Math.max(0, due.getTime() - Date.now());
    const units = [
      [365 * 86400000, haListManagerTodoCardText("ui.year", {}, this._hass), haListManagerTodoCardText("ui.years", {}, this._hass)],
      [30 * 86400000, haListManagerTodoCardText("ui.month", {}, this._hass), haListManagerTodoCardText("ui.months", {}, this._hass)],
      [86400000, haListManagerTodoCardText("ui.day", {}, this._hass), haListManagerTodoCardText("ui.days", {}, this._hass)],
      [3600000, haListManagerTodoCardText("ui.hour", {}, this._hass), haListManagerTodoCardText("ui.hours", {}, this._hass)],
      [60000, haListManagerTodoCardText("ui.minute", {}, this._hass), haListManagerTodoCardText("ui.minutes", {}, this._hass)],
    ];
    const parts = [];
    for (const [size, singular, plural] of units) {
      const value = Math.floor(remaining / size);
      if (value > 0) {
        parts.push(`${value} ${value === 1 ? singular : plural}`);
        remaining %= size;
      }
      if (parts.length === 2) break;
    }
    return parts.join(" ") || haListManagerTodoCardText("todo.less_than_minute", {}, this._hass);
  }
  _formatChecked(item) {
    return this._formatDue({ due_at: item?.last_checked_at });
  }
  _dueHtml(item) {
    const checked = this._config.show_last_checked !== false && this._formatChecked(item);
    const showIcon = this._config.show_title_info_icon || checked;
    const due = item.due_at ? `<span class="due ${this._status(item)}${item.monitoring_paused ? " paused" : ""}"><span class="due-date" title="${haListManagerTodoCardText("ui.due_date", {}, this._hass)}">${showIcon ? '<ha-icon class="task-date-icon" icon="mdi:calendar-clock"></ha-icon>' : ""}<span class="due-value">${esc(this._formatDue(item))}</span></span>${!item.monitoring_paused ? `<span class="due-remaining">${esc(this._remainingDue(item))}</span>` : ""}</span>` : "";
    const last = checked ? `<span class="last-checked" title="${haListManagerTodoCardText("todo.last_checked", {}, this._hass)}">${due && this._config.dates_inline ? '<span class="date-separator">·</span>' : ""}<ha-icon class="task-date-icon" icon="mdi:check"></ha-icon><span>${esc(checked)}</span></span>` : "";
    return due || last ? `<span class="task-dates ${this._config.dates_inline ? "inline" : ""}">${due}${last}</span>` : "";
  }

  _matchesFilter(item) {
    const filter = this._activeFilter(), due = this._due(item), today = this._startToday(), tomorrow = new Date(today.getTime() + 86400000);
    if (filter === "all") return true; if (filter === "dated") return Boolean(due); if (filter === "undated") return !due; if (!due || item.monitoring_paused) return false;
    if (filter === "today") return due >= today && due < tomorrow;
    if (filter === "overdue") return due < today;
    if (filter === "overdue_include_today") return due < tomorrow;
    if (filter === "upcoming") return due >= tomorrow;
    return true;
  }
  _compareItems(a, b) {
    let result = 0;
    if (this._config.sort_mode === "alpha") result = this._name(a).localeCompare(this._name(b), haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base", numeric: true });
    else if (this._config.sort_mode === "due") { const ad = this._due(a), bd = this._due(b); result = ad && bd ? ad - bd : ad ? -1 : bd ? 1 : this._name(a).localeCompare(this._name(b), haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base" }); }
    else result = Number(a.position) - Number(b.position);
    if (this._config.acknowledged === "end" && a.completed !== b.completed) return a.completed ? 1 : -1;
    return result || Number(a.position) - Number(b.position);
  }
  _matchesSearch(item) {
    const query = this._input.trim().toLocaleLowerCase();
    if (!this._config.allow_filter || !query) return true;
    const category = this._categoryFor(item);
    return [this._name(item), item.description, item.category, category?.name, ...(item.labels || []).map((label) => label.name)]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  }
  _visibleItems() { const labels = this._activeLabelFilter(); return this._items.filter((item) => this._matchesFilter(item) && this._matchesLabelFilter(item,labels) && this._matchesSearch(item) && (this._config.acknowledged !== "hide" || !item.completed)).sort((a, b) => this._compareItems(a, b)); }
  _categoryFor(item) {
    if (item.category_id) return this._categories.find((entry) => entry.id === item.category_id) || { id: item.category_id, name: item.category || haListManagerTodoCardText("ui.category", {}, this._hass), dynamic: true };
    if (item.category) return this._categories.find((entry) => entry.name.toLocaleLowerCase() === item.category.toLocaleLowerCase()) || { id: `dynamic:${item.category}`, name: item.category, dynamic: true };
    return { id: "", name: haListManagerTodoCardText("ui.general", {}, this._hass), uncategorized: true, icon: "mdi:shape-outline" };
  }
  _categoryRank(category) { if (category.uncategorized) return -1; if (this._config.category_sort === "position") return Number(category.manual_position ?? category.position ?? 999999); if (this._config.category_sort === "global_list_dynamic") return category.dynamic ? 2 : category.scope === "global" ? 0 : 1; if (this._config.category_sort === "list_global_dynamic") return category.dynamic ? 2 : category.scope === "list" ? 0 : 1; return 0; }
  _groups() {
    const groups = new Map();
    const byLabels = this._groupingMode() === "labels";
    // Each label view keeps the original record and its backend identity.
    for (const item of this._visibleItems()) {
      const labels = byLabels ? [...new Map((item.labels || []).filter((label) => label?.id && label.name).map((label) => [label.id, label])).values()] : [];
      const categories = !byLabels ? [this._categoryFor(item)] : labels.length
        ? labels.map((label) => ({ ...label, id: `__label__:${label.id}`, icon: label.icon || "mdi:label-outline", label: true }))
        : [{ id: "__unlabeled__", name: haListManagerTodoCardText("ui.without_label", {}, this._hass), icon: "mdi:label-off-outline", uncategorized: true, label: true }];
      for (const category of categories) {
        if (!groups.has(category.id)) groups.set(category.id, { category, items: [] });
        groups.get(category.id).items.push(item);
      }
    }
    return [...groups.values()].sort((a, b) => (byLabels
      ? Number(Boolean(b.category.uncategorized)) - Number(Boolean(a.category.uncategorized))
      : this._categoryRank(a.category) - this._categoryRank(b.category)) || a.category.name.localeCompare(b.category.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base", numeric: true }));
  }
  _nextDue(items, includeDue = false) { return items.filter((item) => !item.completed && !item.monitoring_paused && this._due(item) && (includeDue || !this._isDue(item))).sort((a, b) => this._due(a) - this._due(b))[0] || null; }

  _openEditor(item = null, name = "", sourceRow = null) {
    this._rememberExpandedScroll(item?.id, sourceRow);
    const interval = this._interval(item); const due = item?.due_at || "";
    const savedCategory = item?.category_id ? this._categories.find((entry) => entry.id === item.category_id) : null;
    this._dialog = { item, name: item ? this._name(item) : name, description: item?.description || "", category_id: item?.category_id || null, category_name: savedCategory?.name || item?.category || "", due_date: due ? due.slice(0, 10) : "", due_time: due.includes("T") ? due.slice(11, 16) : "", interval_value: interval?.value || "", interval_unit: interval?.unit || "D", label_ids: item?.labels?.map((label) => label.id) || [], monitoring_paused: Boolean(item?.monitoring_paused) };
    this._dialog.initialDraft = { ...this._dialog, label_ids: [...this._dialog.label_ids] };
    this._actionDialog = null; this._lock(); this._render();
  }
  _dialogSnapshot(draft = this._dialog) {
    if (!draft) return null;
    const categoryName = String(draft.category_name || "").trim();
    const category = this._categories.find((entry) => draft.category_id
      ? entry.id === draft.category_id : entry.name.toLocaleLowerCase() === categoryName.toLocaleLowerCase());
    const intervalText = String(draft.interval_value ?? "").trim();
    const interval = intervalText ? Number(intervalText) : null;
    return JSON.stringify({
      name: String(draft.name || "").trim(), description: String(draft.description || "").trim(),
      category_id: draft.category_id || category?.id || null, category_name: draft.category_id || category ? "" : categoryName,
      due_date: draft.due_date || "", due_time: draft.due_date ? draft.due_time || "" : "",
      interval: Number.isFinite(interval) ? interval : intervalText, interval_unit: intervalText ? draft.interval_unit : null,
      label_ids: [...new Set(draft.label_ids || [])].sort(),
      monitoring_paused: Boolean(draft.monitoring_paused),
    });
  }
  _isDialogDirty() {
    // Resolve both drafts against the same live definitions: promoting a dynamic
    // category must not create an edit, or clear a genuine pending change.
    return Boolean(this._dialog?.item && this._dialog.initialDraft
      && this._dialogSnapshot(this._dialog.initialDraft) !== this._dialogSnapshot());
  }
  _updateDialogDirtyState() {
    globalThis.HaListManagerDialogSections.refresh(this);
    const indicator = this.shadowRoot.querySelector("[data-unsaved-indicator]");
    if (indicator) indicator.hidden = !this._isDialogDirty();
  }
  _requestDialogDiscard() {
    if (this._confirmation) return;
    const active = this.shadowRoot.activeElement;
    const attribute = active?.getAttributeNames?.().find((name) => name.startsWith("data-"));
    const selection = active?.tagName === "INPUT" && ["text", "search", "url", "tel"].includes(active.type)
      ? [active.selectionStart, active.selectionEnd] : null;
    this._confirmation = { type: "discard_dialog", returnFocus: attribute
      ? { attribute, value: active.getAttribute(attribute), tagName: active.tagName, element: active, selection } : null };
    // Keep the task form mounted: opening/cancelling the prompt must not move it.
    this.shadowRoot.querySelector("ha-card")?.insertAdjacentHTML("beforeend", this._confirmationHtml());
    this._bindDiscardConfirmation();
    this.shadowRoot.querySelector("[data-cancel-discard]")?.focus({ preventScroll: true });
  }
  _cancelDialogDiscard() {
    const confirmation = this._confirmation;
    if (confirmation?.type !== "discard_dialog") return;
    this._confirmation = null;
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
    this._listen(this.shadowRoot.querySelector("[data-confirm-discard]"), "click", () => this._closeDialogs(true));
    this._listen(this.shadowRoot.querySelector("[data-cancel-discard]"), "click", () => this._cancelDialogDiscard());
    this._listen(this.shadowRoot.querySelector("[data-discard-confirmation]"), "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this._cancelDialogDiscard(); }
    });
  }
  _closeDialogs(force = false) {
    if (!force) {
      if (this._selectionPopup) { this._closeSelectionPopup(); return; }
      if (this._templateDialog?.parentDialog) { if (!this._busy) this._returnFromTemplate(); return; }
      if (this._busy) return;
      if (this._confirmation?.type === "discard_dialog") { this._cancelDialogDiscard(); return; }
      if (this._confirmation && this._dialog) { this._confirmation = null; this._render(); return; }
      if (this._isDialogDirty()) { this._requestDialogDiscard(); return; }
    }
    this._dialog = null; this._actionDialog = null; this._templateDialog = null; this._filterDialog = false;
    this._confirmation = null; this._chipDialog = false; this._chipMenu = null;
    this._removeFilterPortal(); this._unlock(); this._render();
  }
  _removeFilterPortal() {
    this._filterPortal?.remove();
    this._filterPortal = null;
  }
  _closeFilterPortal(render = false) {
    this._filterDialog = false;
    this._removeFilterPortal();
    this._unlock();
    if (render) this._render();
    this._restorePageScrollAnchor(this._taskFilterAnchor);
    this._taskFilterAnchor = null;
    this.shadowRoot.querySelector("[data-toggle-filter-menu]")?.focus({preventScroll:true});
  }
  _openFilterPortal() {
    this._taskFilterAnchor = this._capturePageScrollAnchor(this.shadowRoot.querySelector("[data-toggle-filter-menu]"));
    this._filterDialog = true;
    this._lock();
    this._removeFilterPortal();
    const portal = document.createElement("div");
    portal.setAttribute("data-ha-list-manager-todo-filter-portal", "");
    Object.assign(portal.style, { position: "fixed", inset: "0", zIndex: "10000", display: "block" });
    const root = portal.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${this._styles()}</style>${this._filterHtml()}`;
    root.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => this._closeFilterPortal(false)));
    root.querySelector("[data-apply-filter]")?.addEventListener("click", () => {
      const value = root.querySelector('input[name="todo-filter"]:checked')?.value || "all";
      if (root.querySelector("[data-remember-filter]")?.checked) {
        try { localStorage.setItem(this._filterKey(), value); } catch (_error) {}
      }
      this._setFilterMode(value);
      this._closeFilterPortal(true);
    });
    document.body.appendChild(portal);
    this._filterPortal = portal;
    requestAnimationFrame(() => root.querySelector('input[name="todo-filter"]:checked')?.focus({preventScroll:true}));
    root.querySelector('[data-dialog]')?.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this._closeFilterPortal(false);}});
  }
  async _saveEditor() {
    const d = this._dialog; if (!d?.name.trim() || this._busy) return;
    this._rememberExpandedScroll(d.item?.id);
    this._busy = true; this._render();
    try {
      const due = d.due_date ? `${d.due_date}${d.due_time ? `T${d.due_time}:00` : ""}` : null;
      const recurrenceInterval = String(d.interval_value).trim() ? Number(d.interval_value) : null;
      if (recurrenceInterval !== null && (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 1000000)) {
        throw new Error(haListManagerTodoCardText("errors.repeat_interval_range", {}, this._hass));
      }
      const values = { name: String(d.name || "").trim(), description: d.description.trim() || null, quantity: 1, category_id: d.category_id || null, category: d.category_id ? null : d.category_name.trim() || null, due_at: due, recurrence_interval: recurrenceInterval, recurrence_unit: recurrenceInterval ? d.interval_unit : null, label_ids: d.label_ids || [], monitoring_paused: Boolean(d.monitoring_paused) };
      if (d.item) await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/update`, item_id: d.item.id, completed: d.item.completed, product_id: null, ...values });
      else await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/create`, list_id: this._listId(), ...values });
      this._input = ""; this._closeDialogs(true); await this._load(true);
    } catch (error) { this._error = error?.message || String(error); } finally { this._busy = false; this._render(); }
  }
  async _setCompleted(item, completed, sourceRow = null) { if (this._busy) return false; this._rememberExpandedScroll(item.id, sourceRow); try { await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/set_completed`, item_id: item.id, completed }); await this._load(true); return true; } catch (error) { this._error = error?.message || String(error); this._render(); return false; } }
  _advanceDue(item, fromNow) {
    const interval = this._interval(item); if (!interval) return null; const base = fromNow ? new Date() : this._due(item); if (!base) return null; const next = new Date(base);
    const add = () => { if (interval.unit === "H") next.setHours(next.getHours() + interval.value); else if (interval.unit === "D") next.setDate(next.getDate() + interval.value); else next.setMonth(next.getMonth() + interval.value); };
    add(); if (!fromNow) while (next <= new Date()) add(); return this._dateOnly(item) && interval.unit !== "H" ? next.toISOString().slice(0, 10) : `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}T${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}:00`;
  }
  async _updateDue(item, dueAt, completed = item.completed, sourceRow = null, markChecked = false, monitoringPaused = undefined) { this._rememberExpandedScroll(item.id, sourceRow); await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/update`, item_id: item.id, name: this._name(item), description: item.description, quantity: 1, category_id: item.category_id, category: item.category_id ? null : item.category, due_at: dueAt, ...(markChecked ? { mark_checked: true } : {}), ...(monitoringPaused === undefined ? {} : { monitoring_paused: monitoringPaused }), recurrence_interval: item.recurrence_interval ?? this._interval(item)?.value ?? null, recurrence_unit: item.recurrence_unit ?? this._interval(item)?.unit ?? null, completed, label_ids: item.labels?.map((label) => label.id) || [] }); await this._load(true); }
  _available(item, action) { if (action === "remove") return Boolean(item.due_at); if (["next", "now"].includes(action)) return Boolean(item.due_at && this._interval(item)); return true; }
  async _execute(item, action, sourceRow = null) {
    if (sourceRow) this._rememberExpandedScroll(item.id, sourceRow);
    if (!this._available(item, action)) { this._actionDialog = { item, action: this._fallbackAction(item) }; this._lock(); this._render(); return; }
    try {
      if (action === "done") { const changed = await this._setCompleted(item, !item.completed, sourceRow); if (changed && this._actionDialog) this._closeDialogs(); }
      else if (action === "edit") this._openEditor(item, "", sourceRow);
      else if (action === "delete") { this._confirmation = { type: "delete", item }; this._actionDialog = null; this._render(); }
      else if (action === "template") { this._openTemplateDialog(item); }
      else if (action === "checked") {
        this._rememberExpandedScroll(item.id, sourceRow);
        await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/check`, item_id: item.id });
        await this._load(true); this._closeDialogs();
      }
      else if (action === "pause") { await this._updateDue(item, item.due_at, item.completed, sourceRow, false, !item.monitoring_paused); this._closeDialogs(); }
      else if (action === "remove") { await this._updateDue(item, null, item.completed, sourceRow); this._closeDialogs(); }
      else if (action === "next" || action === "now") { await this._updateDue(item, this._advanceDue(item, action === "now"), false, sourceRow, true); this._closeDialogs(); }
    } catch (error) { this._error = error?.message || String(error); this._render(); }
  }
  _openEditorTemplate(trigger = null) {
    const parent = this._dialog;
    if (!parent?.item || this._busy) return;
    const view = this.shadowRoot.querySelector("[data-dialog]");
    const parentScroll = view?.scrollTop || 0;
    const parentTrigger = (trigger || this.shadowRoot.activeElement)?.dataset?.editShortcut ? "[data-edit-shortcut=template]" : "footer [data-save-item-template]";
    const item = { ...parent.item, name: parent.name, description: parent.description,
      category_id: parent.category_id, category: parent.category_name,
      labels: (parent.label_ids || []).map((id) => this._labels.find((label) => label.id === id) || parent.item.labels?.find((label) => label.id === id)).filter(Boolean),
      recurrence_interval: Number(parent.interval_value) || null, recurrence_unit: parent.interval_unit,
    };
    this._openTemplateDialog(item);
    Object.assign(this._templateDialog, { parentDialog: parent, parentScroll, parentTrigger });
  }
  _returnFromTemplate() {
    const child = this._templateDialog;
    if (!child?.parentDialog) return false;
    this._templateDialog = null;
    this._dialog = child.parentDialog;
    this._render();
    const view = this.shadowRoot.querySelector("[data-dialog]");
    if (view) view.scrollTop = child.parentScroll;
    this.shadowRoot.querySelector(child.parentTrigger)?.focus({ preventScroll: true });
    return true;
  }
  _openTemplateDialog(item) {
    this._actionDialog = null;
    this._dialog = null;
    this._templateDialog = { item, name: this._name(item), item_name: this._name(item), icon: "mdi:checkbox-marked-outline", color: "", scope: "list", add_mode: "edit", due_mode: "none", due_time: null };
    this._lock(); this._render(); setTimeout(() => this.shadowRoot.querySelector("[data-template-name]")?.focus(), 0);
  }
  async _saveTemplateFromItem() {
    const draft = this._templateDialog; if (!draft?.name.trim() || !draft?.item_name?.trim() || this._busy) return;
    const scope = this._hass.user?.is_admin === true ? draft.scope : "list";
    const item = draft.item; let saved = false; this._busy = true; this._render();
    try {
      await haListManagerTodoCardTextRequest(this._hass, {
        type: `${HA_LM_API}/chips/create`, name: draft.name.trim(), color: draft.color || null,
        chip_kind: "todo_template", icon: draft.icon || null,
        scope, list_type: scope === "list_type" ? "todo" : null,
        list_id: scope === "list" ? this._listId() : null, product_id: null,
        template_data: {
          item_name: draft.item_name.trim(), description: item.description || null,
          category_id: item.category_id || null, category_name: item.category || null,
          label_ids: item.labels?.map((label) => label.id) || [],
          due_mode: draft.due_mode, due_time: draft.due_time || null,
          due_offset_value: draft.due_offset_value || null, due_offset_unit: draft.due_offset_unit || "D",
          recurrence_interval: item.recurrence_interval || null, recurrence_unit: item.recurrence_unit || null,
          add_mode: draft.add_mode,
        },
      });
      saved = true; this._notificationStatus = haListManagerTodoCardText("todo.template_saved", {p0:(draft.name.trim())}, this._hass); await this._load(true);
    } catch (error) { this._error = error?.message || String(error); }
    finally {
      this._busy = false;
      if (!saved || !this._returnFromTemplate()) {
        if (saved) { this._templateDialog = null; this._unlock(); }
        this._render();
      }
    }
  }
  _fallbackAction(item) { return this._available(item, this._config.todo_default_action) ? this._config.todo_default_action : "done"; }
  _openAction(item, sourceRow = null) { this._rememberExpandedScroll(item.id, sourceRow); this._actionDialog = { item, action: this._fallbackAction(item) }; this._lock(); this._render(); }
  async _deleteItem(item) { try { await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/delete`, item_id: item.id }); this._closeDialogs(true); await this._load(true); } catch (error) { this._error = error?.message || String(error); this._render(); } }
  async _clearCompleted() { const completed = this._items.filter((item) => item.completed); try { for (const item of completed) await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/delete`, item_id: item.id }); this._closeDialogs(); await this._load(true); } catch (error) { this._error = error?.message || String(error); this._render(); } }
  async _sendList(profileIds = null) {
    if (this._busy || !this._listId()) return;
    this._busy = true; this._error = ""; this._notificationStatus = ""; this._render();
    try {
      const payload = { type: `${HA_LM_API}/notifications/send_list`, list_id: this._listId() };
      if (profileIds) payload.profile_ids = profileIds;
      const result = await haListManagerTodoCardTextRequest(this._hass, payload);
      const count = (result.sent_profile_ids || []).length;
      this._notificationStatus = haListManagerTodoCardText("ui.list_sent_to", {p0:(count), p1:(count === 1 ? haListManagerTodoCardText("ui.target", {}, this._hass) : haListManagerTodoCardText("ui.targets", {}, this._hass))}, this._hass);
    } catch (error) { this._error = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }
  _requestShare() {
    const profiles = this._notificationAssignments.filter((assignment) => assignment.manual_enabled && assignment.profile?.enabled).map((assignment) => ({ id: assignment.profile.id, name: assignment.profile.name }));
    if (!profiles.length) return;
    this._confirmation = { type: "share", profiles, selectedIds: profiles.map((profile) => profile.id) };
    this._lock(); this._render();
  }
  async _confirmShare() {
    const selectedIds = [...(this._confirmation?.selectedIds || [])];
    if (!selectedIds.length) return;
    this._confirmation = null; this._unlock(); await this._sendList(selectedIds);
  }
  _loadPdfExporter() {
    if (window.HaListManagerPdfExporter) return Promise.resolve(window.HaListManagerPdfExporter);
    if (window.__shoppingListImprovedPdfExporterPromise) return window.__shoppingListImprovedPdfExporterPromise;
    window.__shoppingListImprovedPdfExporterPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = globalThis.HaListManagerFrontendRefresh.assetUrl("ha-list-manager-pdf-export.js");
      script.async = true;
      script.onload = () => window.HaListManagerPdfExporter ? resolve(window.HaListManagerPdfExporter) : reject(new Error(haListManagerTodoCardText("ui.pdf_export_not_loaded", {}, this._hass)));
      script.onerror = () => reject(new Error(haListManagerTodoCardText("errors.pdf_export_load_failed", {}, this._hass)));
      document.head.appendChild(script);
    }).catch((error) => { window.__shoppingListImprovedPdfExporterPromise = null; throw error; });
    return window.__shoppingListImprovedPdfExporterPromise;
  }
  _recurrenceLabel(item) {
    const interval = this._interval(item); if (!interval) return "";
    const units = { H: [haListManagerTodoCardText("ui.hour", {}, this._hass), haListManagerTodoCardText("ui.hours", {}, this._hass)], D: [haListManagerTodoCardText("ui.day", {}, this._hass), haListManagerTodoCardText("ui.days", {}, this._hass)], M: [haListManagerTodoCardText("ui.month", {}, this._hass), haListManagerTodoCardText("ui.months", {}, this._hass)] };
    return haListManagerTodoCardText("ui.every_interval", {p0:(interval.value), p1:(units[interval.unit][interval.value === 1 ? 0 : 1])}, this._hass);
  }
  _pdfDueColumn(item, status) {
    const due = this._due(item); if (!due) return [];
    const locale = haListManagerTodoCardTextLocale(this._hass);
    const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(due);
    const tone = status === haListManagerTodoCardText("todo.overdue", {}, this._hass) ? "error" : "";
    if (this._dateOnly(item)) return [{ text: date, tone }];
    const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(due);
    return [{ text: date, tone }, { text: time, tone }];
  }
  _pdfSections() {
    const groups = new Map();
    for (const item of this._items.slice().sort((a, b) => this._compareItems(a, b))) {
      const category = this._categoryFor(item);
      if (!groups.has(category.id)) groups.set(category.id, { category, items: [] });
      const due = this._due(item);
      const status = item.completed ? haListManagerTodoCardText("ui.completed", {}, this._hass) : this._isOverdue(item) ? haListManagerTodoCardText("todo.overdue", {}, this._hass) : this._isDue(item) ? haListManagerTodoCardText("todo.due", {}, this._hass) : "";
      const remaining = due && !item.completed ? this._remainingDue(item) : "";
      const recurrence = this._recurrenceLabel(item);
      const detailRows = [
        ...(item.description ? [{ text: item.description, tone: "" }] : []),
        ...(remaining || recurrence ? [{ text: [remaining, recurrence].filter(Boolean).join(" · "), tone: "" }] : []),
      ];
      groups.get(category.id).items.push({ name: this._name(item), text: this._name(item), badge: due ? "" : item.completed ? haListManagerTodoCardText("ui.completed", {}, this._hass) : "", leadingRows: due ? this._pdfDueColumn(item, status) : [], detailRows, checked: Boolean(item.completed) });
    }
    return [...groups.values()].sort((a, b) => this._categoryRank(a.category) - this._categoryRank(b.category) || a.category.name.localeCompare(b.category.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base", numeric: true })).map(({ category, items }) => ({ name: category.name || haListManagerTodoCardText("ui.general", {}, this._hass), color: category.color || null, items }));
  }
  async _exportPdf() {
    if (this._pdfExporting) return;
    this._pdfExporting = true; this._error = ""; this._notificationStatus = ""; this._render();
    try {
      const exporter = await this._loadPdfExporter();
      const title = this._config.title || this._list?.name || haListManagerTodoCardText("ui.todo_list", {}, this._hass);
      await exporter.exportPdf({ hass: this._hass, title, subtitle: haListManagerTodoCardText("todo.open_total_count", {p0:(this._items.filter((item) => !item.completed).length), p1:(this._items.length)}, this._hass), fileName: haListManagerTodoCardText("pdf.todo_filename", { list: this._list?.name || this._listId() || haListManagerTodoCardText("ui.list", {}, this._hass).toLocaleLowerCase() }, this._hass), sections: this._pdfSections() });
      this._notificationStatus = haListManagerTodoCardText("ui.pdf_created", {}, this._hass);
    } catch (error) { this._error = error?.message || haListManagerTodoCardText("errors.pdf_creation_failed", {}, this._hass); }
    finally { this._pdfExporting = false; this._render(); }
  }
  async _moveItem(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const ordered = this._items.slice().sort((a, b) => Number(a.position) - Number(b.position));
    const from = ordered.findIndex((item) => item.id === sourceId), to = ordered.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1); ordered.splice(to, 0, moved);
    try {
      const result = await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/reorder`, list_id: this._listId(), item_ids: ordered.map((item) => item.id) });
      this._items = result.items || ordered; this._render();
    } catch (error) { this._error = error?.message || String(error); this._render(); }
  }

  _templateDue(template) {
    const mode = template.due_mode || "none";
    if (mode === "none") return null;
    const now = new Date(); const due = new Date(now);
    if (mode === "today") due.setHours(0, 0, 0, 0);
    else if (mode === "tomorrow") { due.setHours(0, 0, 0, 0); due.setDate(due.getDate() + 1); }
    else if (mode === "offset") {
      const value = Math.max(1, Number(template.due_offset_value) || 1);
      if (template.due_offset_unit === "H") due.setHours(due.getHours() + value);
      else if (template.due_offset_unit === "M") due.setMonth(due.getMonth() + value);
      else due.setDate(due.getDate() + value);
    } else if (mode === "next_weekday") {
      due.setHours(0, 0, 0, 0);
      const weekday = Math.max(0, Math.min(6, Number(template.due_weekday) || 0));
      const delta = (weekday - due.getDay() + 7) % 7 || 7;
      due.setDate(due.getDate() + delta);
    }
    if (template.due_time) {
      const [hours, minutes] = String(template.due_time).split(":").map(Number);
      due.setHours(hours || 0, minutes || 0, 0, 0);
    }
    const date = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
    if (template.due_time || (mode === "offset" && template.due_offset_unit === "H")) return `${date}T${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}:00`;
    return date;
  }
  _templateValues(chip) {
    const template = chip.template_data || {};
    const category = this._categories.find((entry) => entry.id === template.category_id)
      || this._categories.find((entry) => template.category_name && entry.name.localeCompare(template.category_name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
    const availableLabels = new Set(this._labels.map((label) => label.id));
    return {
      name: String(template.item_name || chip.name || "").trim(),
      description: String(template.description || "").trim() || null,
      quantity: 1,
      category_id: category?.id || null,
      category: category ? null : String(template.category_name || "").trim() || null,
      due_at: this._templateDue(template),
      recurrence_interval: template.recurrence_interval || null,
      recurrence_unit: template.recurrence_interval ? template.recurrence_unit : null,
      label_ids: (template.label_ids || []).filter((id) => availableLabels.has(id)),
    };
  }
  _openTemplateEditor(chip) {
    const values = this._templateValues(chip); const due = values.due_at || "";
    const category = values.category_id ? this._categories.find((entry) => entry.id === values.category_id) : null;
    this._dialog = { item: null, name: values.name, description: values.description || "", category_id: values.category_id, category_name: category?.name || values.category || "", due_date: due ? due.slice(0, 10) : "", due_time: due.includes("T") ? due.slice(11, 16) : "", interval_value: values.recurrence_interval || "", interval_unit: values.recurrence_unit || "D", label_ids: values.label_ids };
    this._lock(); this._render(); setTimeout(() => this.shadowRoot.querySelector("[data-d-name]")?.focus(), 0);
  }
  async _useTemplateChip(chip) {
    if (!chip || this._busy) return;
    if ((chip.template_data?.add_mode || "edit") === "edit") { this._openTemplateEditor(chip); return; }
    this._busy = true; this._error = ""; this._render();
    try {
      await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/items/create`, list_id: this._listId(), ...this._templateValues(chip) });
      this._notificationStatus = haListManagerTodoCardText("ui.named_item_added", {p0:(chip.name)}, this._hass);
      await this._load(true);
    } catch (error) { this._error = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }

  _configuredChipColor(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length === 3) {
      const channels = value.map(Number);
      if (channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) return `rgb(${channels.map((channel) => Math.round(channel)).join(", ")})`;
    }
    return fallback;
  }
  _categoryChipLayout() { return this._config.category_chip_layout || "none"; }
  _categoryChipsEnabled() { return this._categoryChipLayout() !== "none"; }
  _isChipImportant(chip) { return Boolean(chip?.id && this._importantChipKeys.has(`chip:${chip.id}`)); }
  _listedChips(chips) {
    const mode = this._config.listed_chip_display;
    if (!mode || mode === "normal") return chips;
    const normalize = (value) => String(value || "").trim().normalize("NFKC").toLocaleLowerCase();
    const names = new Set(this._items.filter((item) => !item.completed).map((item) => normalize(item.name)).filter(Boolean));
    return chips.map((chip) => ({ ...chip, listed: names.has(normalize(chip.template_data?.item_name || chip.name)) }))
      .filter((chip) => mode !== "hide" || !chip.listed);
  }
  _displayChips() {
    return this._listedChips(this._chips).map((chip) => ({ ...chip, important: this._isChipImportant(chip) })).sort((left, right) => {
      if (this._config.show_important_chips !== false && left.important !== right.important) return left.important ? -1 : 1;
      return left.name.localeCompare(right.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base", numeric: true });
    });
  }
  _filteredChips() {
    const chips = this._displayChips();
    const query = this._config.filter_chips !== false ? this._input.trim().toLocaleLowerCase() : "";
    return query ? chips.filter((chip) => chip.name.toLocaleLowerCase().includes(query)) : chips;
  }
  _templateCategory(chip) {
    const template = chip?.template_data || {};
    if (template.category_id) return this._categories.find((entry) => entry.id === template.category_id)
      || { id: template.category_id, name: template.category_name || haListManagerTodoCardText("ui.category", {}, this._hass), dynamic: true, icon: "mdi:shape-outline" };
    if (template.category_name) return this._categories.find((entry) => entry.name.localeCompare(template.category_name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base" }) === 0)
      || { id: `dynamic:${template.category_name}`, name: template.category_name, dynamic: true, icon: "mdi:shape-outline" };
    return { id: "", name: haListManagerTodoCardText("ui.general", {}, this._hass), uncategorized: true, icon: "mdi:shape-outline" };
  }
  _chipCategoryKey(id) { return `ha-list-manager:todo-chip-category:${encodeURIComponent(this._identity())}:${encodeURIComponent(id || "__general__")}`; }
  _wrappedChipCategoryKey(context) { return `ha-list-manager:todo-chip-category-open:${encodeURIComponent(this._identity())}:${context}`; }
  _wrappedChipCategorySelection(context) {
    if (Object.prototype.hasOwnProperty.call(this._chipCategoryOpen, context)) return this._chipCategoryOpen[context];
    try { const stored = localStorage.getItem(this._wrappedChipCategoryKey(context)); return stored === null ? undefined : stored === "__none__" ? null : stored; }
    catch (_error) { return undefined; }
  }
  _storeWrappedChipCategorySelection(context, id) {
    this._chipCategoryOpen[context] = id;
    try { localStorage.setItem(this._wrappedChipCategoryKey(context), id || "__none__"); } catch (_error) {}
  }
  _chipCategoryCollapsed(id) {
    try {
      const stored = localStorage.getItem(this._chipCategoryKey(id));
      return stored === null ? id !== "__important__" : stored !== "0";
    } catch (_error) { return id !== "__important__"; }
  }
  _toggleChipCategory(id, dialog = false) {
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      const context = dialog ? "dialog" : "card";
      const current = this._wrappedChipCategorySelection(context);
      this._storeWrappedChipCategorySelection(context, current === id ? null : id);
    } else {
      try { const key = this._chipCategoryKey(id); localStorage.setItem(key, this._chipCategoryCollapsed(id) ? "0" : "1"); } catch (_error) {}
    }
    this._render();
  }
  _allChipCategoriesExpanded(chips = this._filteredChips()) {
    const ids = this._chipGroups(chips).map(({ category }) => category.id || "__general__");
    if (!ids.length) return false;
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      const selected = this._wrappedChipCategorySelection("card");
      return selected === "__all__" || (ids.length === 1 && selected === ids[0]);
    }
    return ids.every((id) => !this._chipCategoryCollapsed(id));
  }
  _toggleAllChipCategories() {
    const ids = this._chipGroups(this._filteredChips()).map(({ category }) => category.id || "__general__");
    if (!ids.length) return;
    const expand = !this._allChipCategoriesExpanded();
    if (["wrap", "compact"].includes(this._categoryChipLayout())) {
      this._storeWrappedChipCategorySelection("card", expand ? "__all__" : null);
    } else {
      try { ids.forEach((id) => localStorage.setItem(this._chipCategoryKey(id), expand ? "0" : "1")); }
      catch (_error) {}
    }
    this._render();
  }
  _chipGroups(chips = this._displayChips()) {
    const groups = new Map();
    for (const chip of chips) {
      const category = this._templateCategory(chip); const key = category.id || "__general__";
      if (!groups.has(key)) groups.set(key, { category, chips: [] });
      groups.get(key).chips.push(chip);
    }
    const normal = [...groups.values()].sort((left, right) => this._categoryRank(left.category) - this._categoryRank(right.category) || left.category.name.localeCompare(right.category.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base", numeric: true }));
    const important = this._config.show_important_chips !== false ? chips.filter((chip) => chip.important) : [];
    if (!important.length) return normal;
    return [{ category: { id: "__important__", name: haListManagerTodoCardText("ui.important", {}, this._hass), icon: "mdi:alert-circle-outline", color: this._configuredChipColor(this._config.important_chip_color_rgb, "rgb(244, 67, 54)"), important: true }, chips: important }, ...normal];
  }
  _chipButton(chip, dialog = false, category = null) {
    const importantColor = this._configuredChipColor(this._config.important_chip_color_rgb, "rgb(244, 67, 54)");
    const color = category?.important || (!this._categoryChipsEnabled() && chip.important && this._config.show_important_chips !== false)
      ? importantColor : this._config.category_chip_colors !== false && category?.color ? category.color : chip.color;
    return `<button type="button" class="todo-chip ${chip.listed ? "chip-listed " : ""}${color ? "colored" : ""}" data-${dialog ? "dialog-" : ""}todo-chip="${esc(chip.id)}" style="${color ? `--chip-color:${esc(color)}` : ""}" title="${haListManagerTodoCardText("ui.chip_use_hold_hint", {p0:(esc(chip.name))}, this._hass)}${chip.listed ? " · " + haListManagerTodoCardText("chips.already_listed", {}, this._hass) : ""}">${chip.icon ? `<ha-icon icon="${esc(chip.icon)}"></ha-icon>` : ""}<span>${esc(chip.name)}</span></button>`;
  }
  _chipGroupsHtml(chips, dialog = false) {
    const groups = this._chipGroups(chips); const layout = this._categoryChipLayout();
    const queryOpensGroups = !dialog && this._config.filter_chips !== false && Boolean(this._input.trim());
    if (["wrap", "compact"].includes(layout)) {
      const fallback = groups[0]?.category?.id || "__general__"; const context = dialog ? "dialog" : "card";
      const stored = this._wrappedChipCategorySelection(context); const activeId = stored !== undefined ? stored : fallback; const allExpanded = activeId === "__all__";
      return `<div class="todo-chip-groups layout-${layout}"><div class="todo-chip-flow">${groups.map(({ category, chips: entries }) => { const id = category.id || "__general__"; const active = allExpanded || activeId === id; const expanded = queryOpensGroups || active; const color = category.color || null; return `<button type="button" class="todo-chip-category-selector ${active ? "active" : ""}" data-todo-chip-category="${esc(id)}" data-dialog-category="${dialog ? "1" : "0"}" aria-expanded="${expanded}" style="${color ? `--category-chip-color:${esc(color)}` : ""}"><ha-icon icon="${esc(category.icon || "mdi:shape-outline")}"></ha-icon><strong>${esc(category.name)}</strong>${layout === "compact" ? "" : `<span>${entries.length}</span><ha-icon icon="mdi:chevron-${expanded ? "up" : "down"}"></ha-icon>`}</button>${expanded ? `<section class="todo-chip-category-expanded"><div>${entries.map((chip) => this._chipButton(chip, dialog, category)).join("")}</div></section>` : ""}`; }).join("")}</div></div>`;
    }
    return `<div class="todo-chip-groups layout-stacked">${groups.map(({ category, chips: entries }) => { const id = category.id || "__general__"; const collapsed = queryOpensGroups ? false : this._chipCategoryCollapsed(id); const color = category.color || null; return `<section class="todo-chip-group" style="${color ? `--category-chip-color:${esc(color)}` : ""}"><button type="button" class="todo-chip-category-head" data-todo-chip-category="${esc(id)}" data-dialog-category="${dialog ? "1" : "0"}" aria-expanded="${!collapsed}"><ha-icon icon="${esc(category.icon || "mdi:shape-outline")}"></ha-icon><strong>${esc(category.name)}</strong><span>${entries.length}</span><ha-icon icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>${collapsed ? "" : `<div class="todo-chip-category-items">${entries.map((chip) => this._chipButton(chip, dialog, category)).join("")}</div>`}</section>`; }).join("")}</div>`;
  }
  async _toggleImportantChip(chip) {
    if (!chip?.id || this._config.show_important_chips === false || this._busy) return;
    const important = !this._isChipImportant(chip); this._busy = true; this._render();
    try {
      await haListManagerTodoCardTextRequest(this._hass, { type: `${HA_LM_API}/chips/important/set`, list_id: this._listId(), target_type: "chip", target_id: chip.id, important });
      important ? this._importantChipKeys.add(`chip:${chip.id}`) : this._importantChipKeys.delete(`chip:${chip.id}`);
      this._chipMenu = null; this._unlock();
    } catch (error) { if (this._chipMenu) this._chipMenu.status = error?.message || String(error); }
    finally { this._busy = false; this._render(); }
  }
  _chipMenuHtml() {
    const chip = this._chipMenu?.chip; if (!chip) return ""; const important = this._isChipImportant(chip);
    return `<div class="backdrop top" data-close-chip-menu><div class="dialog chip-action-dialog"><header><div><h2>${esc(chip.name)}</h2><p>${haListManagerTodoCardText("ui.manage_template", {}, this._hass)}</p></div><button data-close-chip-menu><ha-icon icon="mdi:close"></ha-icon></button></header>${this._noticeHtml("chip", this._chipMenu.status)}<div class="chip-menu-actions"><button type="button" data-toggle-important-template><ha-icon icon="mdi:${important ? "alert-circle-minus-outline" : "alert-circle-plus-outline"}"></ha-icon><span><strong>${important ? haListManagerTodoCardText("ui.remove_important_mark", {}, this._hass) : haListManagerTodoCardText("ui.mark_important", {}, this._hass)}</strong><small>${haListManagerTodoCardText("ui.todo_list_only", {}, this._hass)}</small></span></button></div></div></div>`;
  }
  _chipDialogHtml() {
    if (!this._chipDialog) return ""; const chips = this._displayChips(); const content = this._categoryChipsEnabled() ? this._chipGroupsHtml(chips, true) : `<div class="todo-chip-dialog-grid">${chips.map((chip) => this._chipButton(chip, true)).join("")}</div>`;
    return `<div class="backdrop top" data-close-chip-dialog><div class="dialog chip-dialog"><header><div><h2>${haListManagerTodoCardText("todo.templates_title", {}, this._hass)}</h2><p>${(chips.length === 1 ? haListManagerTodoCardText("todo.templates_for_list_one", {count: chips.length}, this._hass) : haListManagerTodoCardText("todo.templates_for_list_many", {count: chips.length}, this._hass))}</p></div>${this._config.show_label_filter_button !== false ? `<button type="button" class="filter-header-button" data-open-label-filter><ha-icon icon="mdi:filter-variant"></ha-icon>${this._filterText("open_button")}</button>` : ""}<button data-close-chip-dialog><ha-icon icon="mdi:close"></ha-icon></button></header>${this._renderLabelFilterControls()}<section class="dialog-chip-section"><h3>${haListManagerTodoCardText("todo.templates_title", {}, this._hass)} <span>${chips.length}</span></h3>${content}</section></div></div>`;
  }
  _filterHostStyles() { return `.option-row{overflow:visible}.option-row>.filter-menu-host>button{display:flex;align-items:center;gap:8px}.filter-menu-host .filter-menu{top:calc(100% + 6px);bottom:auto;width:300px;max-height:calc(100dvh - 140px);overflow-y:auto}.label-filter-dialog{box-sizing:border-box}.label-filter-dialog footer{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.label-filter-dialog header{display:flex;align-items:center;justify-content:space-between;gap:8px}.label-filter-dialog input{box-sizing:border-box;width:100%;min-width:0}.label-filter-dialog{max-height:calc(100dvh - 48px - env(safe-area-inset-top));overflow-y:auto}.label-filter-dialog .saved-filter button{padding:5px}.label-filter-dialog .saved-filter{grid-template-columns:minmax(0,1fr) repeat(4,36px)}.filter-menu[hidden]{display:none}`; }
  _chipsHtml() {
    if (this._config.show_chips === false || (!this._chips.length && this._config.show_label_filter_button === false)) return "";
    const chips = this._filteredChips(); const content = chips.length ? (this._categoryChipsEnabled() ? this._chipGroupsHtml(chips) : `<div>${chips.map((chip) => this._chipButton(chip)).join("")}</div>`) : `<span class="chips-empty">${haListManagerTodoCardText("ui.no_matching_templates", {}, this._hass)}</span>`;
    const categoryToggle = this._categoryChipsEnabled(); const allExpanded = categoryToggle && this._allChipCategoriesExpanded(chips);
    return `<aside class="todo-chips ${categoryToggle ? "category-chip-view" : ""}" aria-label="${haListManagerTodoCardText("todo.templates_title", {}, this._hass)}">${this._renderLabelFilterControls()}<h3>${haListManagerTodoCardText("ui.templates_count", {p0:(categoryToggle ? `<button type="button" class="chip-category-toggle-all" data-toggle-chip-categories aria-expanded="${allExpanded}" aria-label="${haListManagerTodoCardText("ui.all_categories_count", {p0:(allExpanded ? haListManagerTodoCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerTodoCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}" title="${haListManagerTodoCardText("ui.all_categories_count", {p0:(allExpanded ? haListManagerTodoCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerTodoCardText("ui.expand_lowercase", {}, this._hass))}, this._hass)}">${chips.length}</button>` : `<span>${chips.length}</span>`)}, this._hass)}</h3>${content}</aside>`;
  }

  _inputHtml() { if (!this._config.show_input_mask) return ""; const popup = this._config.show_chip_popup_button !== false && (this._chips.length || this._config.show_label_filter_button !== false); return `<div class="input-row"><div class="task-input"><input class="${popup ? "has-chip-trigger" : ""}" data-new-task value="${esc(this._input)}" placeholder="${this._config.allow_filter ? haListManagerTodoCardText("ui.new_task_or_search", {}, this._hass) : haListManagerTodoCardText("todo.new_task_placeholder", {}, this._hass)}"><button type="button" class="clear-input ${popup ? "with-chip-trigger" : ""}" data-clear-input aria-label="${haListManagerTodoCardText("ui.clear_input", {}, this._hass)}" title="${haListManagerTodoCardText("ui.clear_input", {}, this._hass)}" ${this._input ? "" : "hidden"}><ha-icon icon="mdi:close-circle"></ha-icon></button>${popup ? `<button type="button" class="chip-popup-trigger" data-open-chip-dialog aria-label="${haListManagerTodoCardText("todo.open_templates", {}, this._hass)}" title="${haListManagerTodoCardText("todo.open_templates", {}, this._hass)}"><ha-icon icon="mdi:gesture-tap-button"></ha-icon></button>` : ""}</div>${this._config.show_submit_button ? `<button class="primary" data-add-task><span>${haListManagerTodoCardText("ui.add", {}, this._hass)}</span></button>` : ""}</div>`; }
  _optionsHtml() {
    const completed = this._items.filter((item) => item.completed).length;
    const groups = this._groups();
    const allExpanded = this._allCategoriesExpanded(groups);
    const filter = this._renderFilterButton();
    const categoryToggle = this._config.show_category_toggle_button !== false && groups.length
      ? `<button type="button" data-toggle-categories ${this._searchExpandsGroups() ? "disabled" : ""} aria-expanded="${allExpanded}" aria-label="${this._groupToggleLabel(allExpanded ? haListManagerTodoCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerTodoCardText("ui.expand_lowercase", {}, this._hass))}" title="${this._groupToggleLabel(allExpanded ? haListManagerTodoCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerTodoCardText("ui.expand_lowercase", {}, this._hass))}"><ha-icon icon="mdi:unfold-${allExpanded ? "less" : "more"}-horizontal"></ha-icon><span>${this._groupToggleLabel(allExpanded ? haListManagerTodoCardText("ui.collapse_lowercase", {}, this._hass) : haListManagerTodoCardText("ui.expand_lowercase", {}, this._hass))}</span></button>`
      : "";
    const clear = this._config.show_clear_button
      ? `<button type="button" data-clear-completed ${completed ? "" : "disabled"} title="${haListManagerTodoCardText("ui.delete_completed_tasks", {}, this._hass)}"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon><span>${haListManagerTodoCardText("ui.delete_completed_count", {p0:(completed ? ` (${completed})` : "")}, this._hass)}</span></button>`
      : "";
    const labelsActive = this._groupingMode() === "labels";
    const groupingLabel = haListManagerTodoCardText(labelsActive ? "ui.group_by_categories" : "ui.group_by_labels", {}, this._hass);
    const grouping = ["categories", "labels"].includes(this._config.label_grouping)
      ? `<button type="button" class="${labelsActive ? "active" : ""}" data-toggle-grouping aria-pressed="${labelsActive}" aria-label="${groupingLabel}" title="${groupingLabel}"><ha-icon icon="${labelsActive ? "mdi:label-multiple-outline" : "mdi:shape-outline"}"></ha-icon><span>${groupingLabel}</span></button>`
      : "";
    return filter || categoryToggle || grouping || clear ? `<div class="option-row">${filter}${categoryToggle}${grouping}${clear}</div>` : "";
  }
  _labelsHtml(item) { if (!this._config.show_labels || !item.labels?.length) return ""; return `<span class="item-labels">${item.labels.filter(label => !label.hide_in_items || this._config.show_hidden_labels).map((label) => `<span class="item-label" style="${label.color ? `--label-color:${esc(label.color)}` : ""}"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon>${esc(label.name)}${globalThis.HaListManagerDialogSections.labelMarker(label, haListManagerTodoCardText("labels.filter_only", {}, this._hass))}</span>`).join("")}</span>`; }
  _categoryIcon(category) {
    const requested = category.icon || (category.uncategorized ? "mdi:folder-question" : "mdi:format-list-checks");
    const prefix = requested.includes(":") ? requested.split(":", 1)[0] : "mdi";
    const missing = prefix !== "mdi" && !window.customIcons?.[prefix];
    const fallbacks = {
      "phu:unifi": "mdi:access-point-network",
      "phu:unifi-protect": "mdi:cctv",
      "phu:proxmox": "mdi:server",
      "phu:portainer": "mdi:docker",
    };
    return { icon: missing ? (fallbacks[requested] || "mdi:image-off-outline") : requested, missing, requested };
  }
  _itemHtml(item) { const draggable = this._config.sort_mode === "manual"; const interval = this._intervalText(item); return `<div class="item ${item.completed ? "completed" : ""} ${this._status(item)}" data-item-id="${esc(item.id)}" ${draggable ? "draggable=true" : ""}>${draggable ? `<ha-icon class="drag" icon="mdi:drag-vertical"></ha-icon>` : ""}<button class="check" data-item-action="${esc(item.id)}" aria-label="${haListManagerTodoCardText("ui.actions", {}, this._hass)}"><ha-icon icon="${item.completed ? "mdi:checkbox-marked" : "mdi:checkbox-blank-outline"}"></ha-icon></button><button class="item-main" data-edit="${esc(item.id)}"><span class="item-name-row"><span class="task-name"><strong>${esc(this._name(item))}</strong>${item.monitoring_paused ? `<ha-icon class="pause-marker" icon="mdi:pause-circle-outline" title="${haListManagerTodoCardText("todo.monitoring_paused", {}, this._hass)}" aria-label="${haListManagerTodoCardText("todo.monitoring_paused", {}, this._hass)}"></ha-icon>` : ""}</span>${interval ? `<span class="interval">${esc(interval)}</span>` : ""}</span>${this._config.show_descriptions && item.description ? `<small>${esc(item.description)}</small>` : ""}<span class="due-holder" data-due-id="${esc(item.id)}">${this._dueHtml(item)}</span>${this._labelsHtml(item)}</button></div>`; }
  _contentHtml() {
    const groups = this._groups(); if (!this._list) return `<div class="empty">${haListManagerTodoCardText("errors.select_todo_list", {}, this._hass)}</div>`; if (!groups.length) return `<div class="empty"><ha-icon icon="mdi:checkbox-marked-circle-outline"></ha-icon><span>${this._items.length ? haListManagerTodoCardText("todo.no_filter_matches", {}, this._hass) : haListManagerTodoCardText("ui.no_tasks_yet", {}, this._hass)}</span></div>`;
    return groups.map(({ category, items }) => { const collapsed = this._collapsed(category.id); const next = this._nextDue(items); const due = items.some((item) => this._isDue(item)); const notDue = items.filter((item) => item.completed || item.monitoring_paused || (this._due(item) && !this._isDue(item))).length; const style = category.color ? `--category-color:${esc(category.color)};--category-text-color:${categoryTextColor(category.color)}` : ""; const icon = this._categoryIcon(category); const iconHint = icon.missing ? ` title="${esc(haListManagerTodoCardText("ui.unavailable_icon", {icon: icon.requested}, this._hass))}" aria-label="${esc(haListManagerTodoCardText("ui.missing_icon_replacement", {icon: icon.requested}, this._hass))}"` : ""; return `<section class="category" data-category-id="${esc(category.id)}" style="${style}"><button class="category-head ${category.color ? "colored" : ""}" data-category="${esc(category.id)}" aria-expanded="${collapsed ? "false" : "true"}"><span class="category-icon ${this._config.cat_double_sized_icon && this._config.show_cat_next_due && next ? "large" : ""}"${iconHint}><ha-icon icon="${esc(icon.icon)}"></ha-icon></span><span class="category-title"><strong>${esc(category.name)}</strong>${this._config.show_cat_next_due && next ? `<small>${this._config.show_title_info_icon ? `<ha-icon icon="mdi:calendar-clock"></ha-icon>` : ""}${esc(this._formatDue(next))}</small>` : ""}</span>${this._config.show_cat_exclamation_mark && due ? `<span class="warning" aria-label="${haListManagerTodoCardText("todo.due_tasks", {}, this._hass)}">⚠</span>` : ""}${this._config.show_category_count ? `<span class="count">${notDue}/${items.length}</span>` : ""}<ha-icon icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>${collapsed ? "" : `<div class="items">${items.map((item) => this._itemHtml(item)).join("")}</div>`}</section>`; }).join("");
  }
  _categoryOptions() { return this._selectionOptions("categories").filter((category) => !category.uncategorized).sort((a, b) => a.name.localeCompare(b.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base" })).map((category) => { const icon = this._categoryIcon(category); const hint = icon.missing ? ` title="${esc(haListManagerTodoCardText("ui.unavailable_icon", {icon: icon.requested}, this._hass))}"` : ""; return `<button type="button" data-category-option="${esc(category.id)}"><span class="category-option-icon" style="${category.color ? `--category-color:${esc(category.color)}` : ""}"${hint}><ha-icon icon="${esc(icon.icon)}"></ha-icon></span><span><strong>${esc(category.name)}</strong><small>${category.scope === "global" ? haListManagerTodoCardText("ui.global", {}, this._hass) : category.dynamic ? haListManagerTodoCardText("ui.dynamic", {}, this._hass) : haListManagerTodoCardText("ui.this_list", {}, this._hass)}</small></span></button>`; }).join(""); }
  _noticeHtml(key, message, tone = "error") {
    if (!message) return "";
    const icon = tone === "success" ? "check-circle-outline" : tone === "warning" ? "alert-outline" : "alert-circle-outline";
    return `<div class="${tone === "success" ? "send-status" : "error"} dismissible-message" data-message="${key}" role="${tone === "error" ? "alert" : "status"}"><ha-icon icon="mdi:${icon}"></ha-icon><span class="message-copy">${esc(message)}</span><button type="button" class="message-close" data-dismiss-message="${key}" aria-label="${haListManagerTodoCardText("ui.dismiss_message", {}, this._hass)}" title="${haListManagerTodoCardText("ui.dismiss_message", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>`;
  }
  _dismissMessage(key, button) {
    if (key === "error") this._error = "";
    else if (key === "notification") this._notificationStatus = "";
    else if (key === "chip" && this._chipMenu) this._chipMenu.status = "";
    const focused = this.shadowRoot.activeElement === button;
    button?.closest?.("[data-message]")?.remove();
    if (focused) (this.shadowRoot.querySelector("[data-d-name]") || this.shadowRoot.querySelector("[data-new-task]"))?.focus({ preventScroll: true });
  }
  _selectionButton(kind) {
    const label = haListManagerTodoCardText(`selection.choose_${kind}`, {}, this._hass);
    return `<button type="button" class="selection-open" data-open-selection="${kind}" title="${label}" aria-label="${label}" aria-haspopup="dialog" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:view-grid-outline"></ha-icon></button>`;
  }
  _selectionOptions(kind) {
    const values = kind === "labels" ? this._labels : [...this._categories];
    if (kind === "categories") {
      for (const item of [...this._items, this._dialog]) {
        const name = String(item?.category_name || item?.category || "").trim();
        if (name && !values.some((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) values.push({ id: `dynamic:${name}`, name, dynamic: true });
      }
    }
    const rank = (entry) => entry.dynamic ? 0 : entry.scope === "list" ? 3 : entry.scope === "list_type" ? 2 : 1;
    const byName = new Map();
    for (const entry of values) {
      if (!entry?.id || !entry.name) continue;
      const key = entry.name.trim().toLocaleLowerCase();
      if (!byName.has(key) || rank(entry) > rank(byName.get(key))) byName.set(key, entry);
    }
    const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base", numeric: true }));
    if (kind === "categories") entries.unshift({ id: "", name: haListManagerTodoCardText("ui.general", {}, this._hass), icon: "mdi:shape-outline", uncategorized: true });
    return entries;
  }
  _openSelectionPopup(kind, trigger = null) {
    if (this._busy || !this._dialog || !["categories", "labels"].includes(kind)) return;
    this.shadowRoot.activeElement?.blur?.();
    this.shadowRoot.querySelectorAll(".category-picker-options,.category-options,.label-picker-options,.label-options,.chip-template-options").forEach((menu) => { menu.hidden = true; });
    this.shadowRoot.querySelectorAll("[data-picker-list-trigger]").forEach((button) => { button.classList.remove("active"); button.setAttribute("aria-expanded", "false"); });
    this.shadowRoot.querySelectorAll("[data-d-category],[data-label-input]").forEach((input) => input.setAttribute("aria-expanded", "false"));
    this._selectionPopup = {
      kind, trigger, parent: this._dialog, listId: this._listId(), query: "", ids: [...(this._dialog.label_ids || [])], labelsById: new Map(this._labels.map((entry) => [entry.id, entry])),
      parentFields: ["[data-d-category]", "[data-label-input]"].map((selector) => { const node = this.shadowRoot.querySelector(selector); return node ? { selector, value: node.value } : null; }).filter(Boolean),
      parentScroll: [...this.shadowRoot.querySelectorAll("[data-dialog],ha-card")].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft })),
    };
    this._mountSelectionPopup();
    this.shadowRoot.querySelector("[data-selection-popup] [data-selection-close]")?.focus({ preventScroll: true });
  }
  _selectionPopupHtml() {
    const popup = this._selectionPopup;
    if (!popup || popup.parent !== this._dialog || popup.listId !== this._listId()) return "";
    const title = haListManagerTodoCardText(`selection.${popup.kind}`, {}, this._hass);
    return `<div class="backdrop selection-backdrop" data-selection-backdrop><section class="dialog selection-popup" role="dialog" aria-modal="true" aria-label="${title}" data-selection-popup><header><h2>${title}</h2><button type="button" data-selection-close aria-label="${haListManagerTodoCardText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></header><input type="search" data-selection-search value="${esc(popup.query)}" placeholder="${haListManagerTodoCardText("selection.search", {}, this._hass)}" aria-label="${haListManagerTodoCardText("selection.search", {}, this._hass)}"><div class="selection-chip-grid" data-selection-options>${this._selectionOptionsHtml()}</div><footer>${popup.kind === "labels" ? `<button type="button" class="primary" data-selection-apply>${haListManagerTodoCardText("selection.apply", {}, this._hass)}</button><button type="button" data-selection-clear>${haListManagerTodoCardText("selection.clear", {}, this._hass)}</button>` : ""}<button type="button" data-selection-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`;
  }
  _selectionLabelAllowed(label) {
    if (label?.scope === "global") return this._list?.use_global_labels !== false;
    if (label?.scope === "list_type") return this._list?.use_type_labels !== false && (!label.list_type || label.list_type === "todo");
    return label?.scope !== "list" || !label.list_id || label.list_id === this._listId();
  }
  _selectedSelectionNames() {
    const popup = this._selectionPopup; if (!popup) return new Set();
    this._labels.forEach((entry) => popup.labelsById.set(entry.id, entry));
    return new Set(popup.ids.map((id) => popup.labelsById.get(id)).filter((label) => label && this._selectionLabelAllowed(label)).map((label) => label.name.toLocaleLowerCase()));
  }
  _selectionOptionsHtml() {
    const popup = this._selectionPopup; if (!popup) return "";
    const query = popup.query.trim().toLocaleLowerCase(), selectedNames = this._selectedSelectionNames();
    const options = this._selectionOptions(popup.kind).filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query));
    const renderOption = (entry) => {
      const selected = popup.kind === "labels" ? selectedNames.has(entry.name.toLocaleLowerCase()) : entry.uncategorized ? !popup.parent.category_id && !String(popup.parent.category_name || "").trim() : popup.parent.category_id === entry.id || popup.parent.category_name === entry.name;
      return `<button type="button" class="selection-chip ${selected ? "selected" : ""}" data-selection-option="${esc(entry.id)}" aria-pressed="${selected}" style="${entry.color ? `--selection-color:${esc(entry.color)};--selection-ink:${categoryTextColor(entry.color)}` : ""}"><ha-icon icon="${esc(entry.icon || (popup.kind === "labels" ? "mdi:tag-outline" : "mdi:shape-outline"))}"></ha-icon><span>${esc(entry.name)}${popup.kind === "labels" ? globalThis.HaListManagerDialogSections.labelMarker(entry, haListManagerTodoCardText("labels.filter_only", {}, this._hass)) : ""}</span>${selected ? '<ha-icon class="selection-check" icon="mdi:check"></ha-icon>' : ""}</button>`;
    };
    return options.length ? (popup.kind === "labels" ? globalThis.HaListManagerDialogSections.renderLabelGroups(options, renderOption, haListManagerTodoCardText("labels.filter_only", {}, this._hass), haListManagerTodoCardText("labels.other", {}, this._hass)) : options.map(renderOption).join("")) : `<p class="label-empty">${haListManagerTodoCardText("selection.empty", {}, this._hass)}</p>`;
  }
  _mountSelectionPopup() {
    const host = this.shadowRoot.querySelector("[data-selection-popup-host]"); if (!host) return;
    this._clearRenderListeners(host); host.innerHTML = this._selectionPopupHtml(); this._bindSelectionPopup(host);
  }
  _restoreSelectionParent() {
    const popup = this._selectionPopup; if (!popup || popup.parent !== this._dialog || popup.listId !== this._listId()) return;
    popup.parentFields.forEach(({ selector, value }) => { const node = this.shadowRoot.querySelector(selector); if (node && node.value !== value) node.value = value; });
    popup.parentScroll.forEach(({ node, top, left }) => { if (node.isConnected !== false) { node.scrollTop = top; node.scrollLeft = left; } });
  }
  _closeSelectionPopup() {
    const popup = this._selectionPopup; if (!popup) return;
    this._restoreSelectionParent(); this._selectionPopup = null; this._mountSelectionPopup(); this._updateDialogDirtyState();
    const selector = `[data-open-selection="${popup.kind}"]${popup.trigger?.dataset?.editShortcut ? "[data-edit-shortcut]" : ":not([data-edit-shortcut])"}`;
    this.shadowRoot.querySelector(selector)?.focus({ preventScroll: true });
  }
  _chooseSelectionOption(id) {
    const popup = this._selectionPopup;
    if (!popup || popup.parent !== this._dialog || popup.listId !== this._listId()) { this._closeSelectionPopup(); return; }
    const entry = this._selectionOptions(popup.kind).find((item) => item.id === id); if (!entry) return;
    if (popup.kind === "labels") {
      const name = entry.name.toLocaleLowerCase(), selected = this._selectedSelectionNames().has(name);
      popup.ids = popup.ids.filter((value) => { const label = popup.labelsById.get(value); return !label || !this._selectionLabelAllowed(label) || label.name.toLocaleLowerCase() !== name; });
      if (!selected) popup.ids.push(id);
      this._refreshSelectionOptions(); return;
    }
    this._dialog.category_id = entry.uncategorized || entry.dynamic ? null : entry.id;
    this._dialog.category_name = entry.uncategorized ? "" : entry.name;
    const snapshot = popup.parentFields.find((field) => field.selector === "[data-d-category]"); if (snapshot) snapshot.value = this._dialog.category_name;
    this._closeSelectionPopup();
  }
  _applySelectionLabels() {
    const popup = this._selectionPopup;
    if (!popup || popup.parent !== this._dialog || popup.listId !== this._listId()) { this._closeSelectionPopup(); return; }
    const available = this._selectionOptions("labels"), byName = new Map(available.map((label) => [label.name.toLocaleLowerCase(), label]));
    const selectedNames = this._selectedSelectionNames();
    const hiddenIds = (this._dialog.label_ids || []).filter((id) => {
      const label = popup.labelsById.get(id);
      return !label || !this._selectionLabelAllowed(label) || !byName.has(label.name.toLocaleLowerCase());
    });
    this._dialog.label_ids = [...new Set([...hiddenIds, ...available.filter((label) => selectedNames.has(label.name.toLocaleLowerCase())).map((label) => label.id)])];
    const host = this.shadowRoot.querySelector("[data-selected-labels]");
    if (host) { this._clearRenderListeners(host); host.innerHTML = this._selectedLabelsHtml(this._dialog); this._bindSelectedLabelRemovals(host); }
    this._closeSelectionPopup();
  }
  _refreshSelectionOptions() {
    const host = this.shadowRoot.querySelector("[data-selection-options]"); if (!host) return;
    const scroll = host.scrollTop, focusedId = this.shadowRoot.activeElement?.dataset?.selectionOption;
    this._clearRenderListeners(host); host.innerHTML = this._selectionOptionsHtml(); this._bindSelectionOptions(host); host.scrollTop = scroll;
    if (focusedId !== undefined) [...host.querySelectorAll("[data-selection-option]")].find((button) => button.dataset.selectionOption === focusedId)?.focus({ preventScroll: true });
  }
  _bindSelectionOptions(root) {
    root.querySelectorAll("[data-selection-option]").forEach((button) => this._listen(button, "click", () => this._chooseSelectionOption(button.dataset.selectionOption)));
  }
  _bindSelectionPopup(root) {
    this._listen(root.querySelector("[data-selection-search]"), "input", (event) => { if (this._selectionPopup) { this._selectionPopup.query = event.target.value; this._refreshSelectionOptions(); } });
    root.querySelectorAll("[data-selection-close]").forEach((button) => this._listen(button, "click", () => this._closeSelectionPopup()));
    this._listen(root.querySelector("[data-selection-apply]"), "click", () => this._applySelectionLabels());
    this._listen(root.querySelector("[data-selection-clear]"), "click", () => { if (this._selectionPopup) { this._selectionPopup.ids = []; this._refreshSelectionOptions(); } });
    this._listen(root.querySelector("[data-selection-backdrop]"), "click", (event) => { if (event.target === event.currentTarget) this._closeSelectionPopup(); });
    this._listen(root.querySelector("[data-selection-popup]"), "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this._closeSelectionPopup(); }
      else if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll("button:not(:disabled),input")]; const first = controls[0], last = controls.at(-1), active = this.shadowRoot.activeElement;
        if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
      }
    });
    this._bindSelectionOptions(root);
  }
  _bindSelectedLabelRemovals(root) {
    root.querySelectorAll("[data-remove-label]").forEach((button) => this._listen(button, "click", () => { if (this._dialog) { this._dialog.label_ids = this._dialog.label_ids.filter((id) => id !== button.dataset.removeLabel); this._render(); } }));
  }
  _selectedLabelsHtml(d) { const selected = this._labels.filter((label) => d.label_ids?.includes(label.id)); return selected.length ? `<div class="selected-labels">${selected.map((label) => `<button type="button" class="selected-label" data-remove-label="${esc(label.id)}" style="${label.color ? `--label-color:${esc(label.color)}` : ""}"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon><span>${esc(label.name)}${globalThis.HaListManagerDialogSections.labelMarker(label, haListManagerTodoCardText("labels.filter_only", {}, this._hass))}</span><ha-icon class="remove-label" icon="mdi:close"></ha-icon></button>`).join("")}</div>` : ""; }
  _editShortcutsHtml() {
    if (!this._dialog?.item || this._config.show_edit_shortcuts === false) return "";
    const button = (kind, icon, key) => {
      const label = esc(haListManagerTodoCardText(key, {}, this._hass));
      const action = kind === "template" ? "data-save-item-template" : `data-open-selection="${kind}"`;
      return `<button type="button" class="edit-shortcut" data-edit-shortcut="${kind}" ${action} title="${label}" aria-label="${label}" ${this._busy ? "disabled" : ""}><ha-icon icon="${icon}" aria-hidden="true"></ha-icon></button>`;
    };
    return `<div class="edit-shortcuts" role="group" aria-label="${haListManagerTodoCardText("quick_actions.shortcuts", {}, this._hass)}">${button("categories", "mdi:shape-outline", "quick_actions.change_category")}${button("labels", "mdi:label-multiple-outline", "quick_actions.change_labels")}${button("template", "mdi:gesture-tap-button", "ui.save_as_template")}</div>`;
  }
  _editorSectionSummary(kind, context = "item") {
    const d = this._dialog;
    if (!d || context !== "item") return "";
    if (kind === "category") return String(this._categories.find((entry) => entry.id === d.category_id)?.name || d.category_name || "").trim() || haListManagerTodoCardText("ui.general", {}, this._hass);
    if (kind === "labels") return String(new Set(d.label_ids || []).size);
    return "";
  }
  // The section summary is the caption. A wrapping label would focus the input
  // and open its dropdown when the caption or surrounding picker is clicked.
  _editorCategoryHtml(d) { return `<div class="category-picker"><div class="picker-input-row"><input data-d-category aria-label="${haListManagerTodoCardText("ui.category", {}, this._hass)}" value="${esc(d.category_name)}" placeholder="${haListManagerTodoCardText("ui.category_search_or_create", {}, this._hass)}">${this._selectionButton("categories")}</div><div class="category-options" data-category-options hidden><button type="button" data-category-option=""><span class="category-option-icon"><ha-icon icon="mdi:shape-outline"></ha-icon></span><span><strong>${haListManagerTodoCardText("ui.general", {}, this._hass)}</strong><small>${haListManagerTodoCardText("ui.no_category", {}, this._hass)}</small></span></button>${this._categoryOptions()}</div></div>`; }
  _editorLabelsHtml(d) { return `<fieldset class="label-selector"><legend class="selection-field-heading">${haListManagerTodoCardText("ui.labels_optional", {}, this._hass)}</legend><div data-selected-labels>${this._selectedLabelsHtml(d)}</div><div class="label-combo"><div class="label-search picker-input-row"><ha-icon icon="mdi:magnify"></ha-icon><input data-label-input placeholder="${haListManagerTodoCardText("ui.browse_labels", {}, this._hass)}">${this._selectionButton("labels")}</div><div class="label-options" data-label-options hidden></div></div></fieldset>`; }
  _editorHtml() { const d = this._dialog; if (!d) return ""; return `<div class="backdrop"><div class="dialog" data-dialog><header><div class="dialog-heading"><h2>${d.item ? haListManagerTodoCardText("todo.edit_task", {}, this._hass) : haListManagerTodoCardText("ui.create_task", {}, this._hass)}</h2>${d.item ? `<span class="unsaved-indicator" data-unsaved-indicator ${this._isDialogDirty() ? "" : "hidden"}><ha-icon icon="mdi:content-save-alert-outline"></ha-icon>${haListManagerTodoCardText("ui.not_saved_yet", {}, this._hass)}</span>` : ""}</div><button data-close><ha-icon icon="mdi:close"></ha-icon></button></header>${this._editShortcutsHtml()}<label>${haListManagerTodoCardText("ui.task", {}, this._hass)}<input data-d-name value="${esc(d.name)}" placeholder="${haListManagerTodoCardText("ui.task_name_example", {}, this._hass)}"></label><label>${haListManagerTodoCardText("ui.description_optional", {}, this._hass)}<textarea data-d-description rows="3" placeholder="${haListManagerTodoCardText("ui.notes_or_details", {}, this._hass)}">${esc(d.description)}</textarea></label><label>${haListManagerTodoCardText("todo.optional_due_date", {}, this._hass)}<div class="due-editor-row"><div class="due-editor-field"><input data-d-date type="date" aria-label="${haListManagerTodoCardText("todo.optional_due_date", {}, this._hass)}" value="${esc(d.due_date)}"></div><div class="due-editor-field"><input data-d-time type="time" aria-label="${haListManagerTodoCardText("ui.time_optional", {}, this._hass)}" value="${esc(d.due_time)}" ${d.due_date ? "" : "disabled"}></div><div class="due-editor-actions"><button type="button" class="icon-button" data-copy-due title="${haListManagerTodoCardText("ui.copy_due_interval", {}, this._hass)}" aria-label="${haListManagerTodoCardText("ui.copy_due_interval", {}, this._hass)}"><ha-icon icon="mdi:content-copy"></ha-icon></button><button type="button" class="icon-button" data-paste-due title="${haListManagerTodoCardText("ui.insert_due_interval", {}, this._hass)}" aria-label="${haListManagerTodoCardText("ui.insert_due_interval", {}, this._hass)}"><ha-icon icon="mdi:content-paste"></ha-icon></button></div></div></label><div class="fields recurrence"><label>${haListManagerTodoCardText("ui.repeat_every_optional", {}, this._hass)}<input data-d-interval type="number" min="1" max="1000000" step="1" value="${esc(d.interval_value)}" placeholder="${haListManagerTodoCardText("todo.no_interval", {}, this._hass)}"></label><label>${haListManagerTodoCardText("ui.unit", {}, this._hass)}<select data-d-unit><option value="H" ${d.interval_unit === "H" ? "selected" : ""}>${haListManagerTodoCardText("ui.hours", {}, this._hass)}</option><option value="D" ${d.interval_unit === "D" ? "selected" : ""}>${haListManagerTodoCardText("ui.days", {}, this._hass)}</option><option value="M" ${d.interval_unit === "M" ? "selected" : ""}>${haListManagerTodoCardText("ui.months", {}, this._hass)}</option></select></label></div><div class="monitoring-settings"><label class="monitoring-option"><input type="checkbox" data-d-paused ${d.monitoring_paused ? "checked" : ""}><span>${haListManagerTodoCardText("todo.pause_monitoring", {}, this._hass)}</span></label><p class="field-help">${haListManagerTodoCardText("todo.pause_help", {}, this._hass)}</p><p class="field-help last-check-info"><span>${haListManagerTodoCardText("todo.last_checked", {}, this._hass)}:</span> ${this._formatChecked(d.item || {}) ? esc(this._formatChecked(d.item)) : haListManagerTodoCardText("todo.no_check", {}, this._hass)}</p></div>${globalThis.HaListManagerDialogSections.render(this, { kind: "category", title: haListManagerTodoCardText("ui.category", {}, this._hass), summary: this._editorSectionSummary("category"), content: this._editorCategoryHtml(d) })}${globalThis.HaListManagerDialogSections.render(this, { kind: "labels", title: haListManagerTodoCardText("ui.labels", {}, this._hass), summary: this._editorSectionSummary("labels"), content: this._editorLabelsHtml(d) })}<footer><button class="primary" data-save>${d.item ? haListManagerTodoCardText("ui.save", {}, this._hass) : haListManagerTodoCardText("ui.create_task", {}, this._hass)}</button><button data-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button>${d.item ? `<button data-save-item-template><ha-icon icon="mdi:gesture-tap-button"></ha-icon>${haListManagerTodoCardText("ui.save_as_template", {}, this._hass)}</button><button class="danger" data-request-delete><ha-icon icon="mdi:delete"></ha-icon>${haListManagerTodoCardText("ui.delete_task", {}, this._hass)}</button>` : ""}</footer></div></div>`; }
  _copyDueSettings(button) {
    const d = this._dialog; if (!d) return;
    const copyObj = {
      date: d.due_date || "",
      time: d.due_time || "",
      intervalInput: String(d.interval_value || ""),
      intervalUnitSelect: d.interval_unit || "",
      selectedCategory: d.category_name || "none",
    };
    try {
      localStorage.setItem("dueDateTimeData", JSON.stringify(copyObj));
      button?.classList.add("pressed");
      setTimeout(() => button?.classList.remove("pressed"), 400);
    } catch (_error) { window.alert(haListManagerTodoCardText("errors.copy_due_interval_failed", {}, this._hass)); }
  }
  _pasteDueSettings() {
    const d = this._dialog; if (!d) return;
    try {
      const stored = localStorage.getItem("dueDateTimeData");
      if (!stored) { window.alert(haListManagerTodoCardText("ui.no_copied_values", {}, this._hass)); return; }
      const value = JSON.parse(stored);
      if (typeof value !== "object" || value === null || typeof value.date !== "string" || typeof value.time !== "string") throw new Error("invalid clipboard");
      const time = /^\d{2}:\d{2}/.test(value.time) ? value.time.slice(0, 5) : "";
      d.due_date = value.date || "";
      d.due_time = value.date ? time : "";
      d.interval_value = String(value.intervalInput || "");
      if (["H", "D", "M"].includes(value.intervalUnitSelect)) d.interval_unit = value.intervalUnitSelect;
      if (value.selectedCategory === "none") { d.category_id = null; d.category_name = ""; }
      else if (typeof value.selectedCategory === "string" && value.selectedCategory) {
        const category = this._categories.find((entry) => entry.name.localeCompare(value.selectedCategory, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base" }) === 0);
        d.category_id = category?.id || null; d.category_name = category?.name || value.selectedCategory;
      }
      this._render();
    } catch (_error) { window.alert(haListManagerTodoCardText("errors.paste_values_invalid", {}, this._hass)); }
  }
  _actionHtml() { const d = this._actionDialog; if (!d) return ""; const item = d.item; const options = [{ value: "done", label: item.completed ? haListManagerTodoCardText("ui.reopen", {}, this._hass) : haListManagerTodoCardText("ui.mark_completed", {}, this._hass), icon: item.completed ? "mdi:checkbox-blank-outline" : "mdi:checkbox-marked-outline" }, { value: "edit", label: haListManagerTodoCardText("todo.edit_task", {}, this._hass), icon: "mdi:pencil" }, { value: "template", label: haListManagerTodoCardText("ui.save_as_template", {}, this._hass), icon: "mdi:gesture-tap-button" }, { value: "remove", label: haListManagerTodoCardText("ui.remove_due_date", {}, this._hass), icon: "mdi:calendar-remove" }, { value: "next", label: haListManagerTodoCardText("todo.set_next_due", {}, this._hass), icon: "mdi:calendar-refresh" }, { value: "now", label: haListManagerTodoCardText("ui.next_due_from_now", {}, this._hass), icon: "mdi:calendar-start" }, { value: "delete", label: haListManagerTodoCardText("ui.delete_task", {}, this._hass), icon: "mdi:delete" }, { value: "pause", label: haListManagerTodoCardText(item.monitoring_paused ? "todo.resume_monitoring" : "todo.pause_monitoring", {}, this._hass), icon: item.monitoring_paused ? "mdi:play-circle-outline" : "mdi:pause-circle-outline" }, { value: "checked", label: haListManagerTodoCardText("todo.set_last_checked", {}, this._hass), icon: "mdi:check" }]; return `<div class="backdrop"><div class="dialog action-dialog" data-dialog><header><div><h2>${haListManagerTodoCardText("ui.choose_action", {}, this._hass)}</h2><p>${esc(this._name(item))}</p></div><button data-close><ha-icon icon="mdi:close"></ha-icon></button></header><div class="actions">${options.map((option) => `<label class="action ${this._available(item, option.value) ? "" : "disabled"}"><input type="radio" name="todo-action" value="${option.value}" ${d.action === option.value ? "checked" : ""} ${this._available(item, option.value) ? "" : "disabled"}><ha-icon icon="${option.icon}"></ha-icon><span>${option.label}</span></label>`).join("")}</div><footer><button class="primary" data-run-action>${haListManagerTodoCardText("ui.execute", {}, this._hass)}</button><button data-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></div></div>`; }
  _templateDialogHtml() {
    const d = this._templateDialog;
    if (!d) return "";
    const item = d.item || {};
    const category = this._categories.find((entry) => entry.id === item.category_id)?.name || item.category || haListManagerTodoCardText("ui.general", {}, this._hass);
    const labels = (item.labels || []).map((label) => label.name).filter(Boolean);
    const interval = this._interval(item);
    const intervalUnits = { H: [haListManagerTodoCardText("ui.hour", {}, this._hass), haListManagerTodoCardText("ui.hours", {}, this._hass)], D: [haListManagerTodoCardText("ui.day", {}, this._hass), haListManagerTodoCardText("ui.days", {}, this._hass)], M: [haListManagerTodoCardText("ui.month", {}, this._hass), haListManagerTodoCardText("ui.months", {}, this._hass)] };
    const intervalNames = interval ? (intervalUnits[interval.unit] || [interval.unit, interval.unit]) : null;
    const intervalText = interval ? haListManagerTodoCardText("ui.every_interval", {p0:(interval.value), p1:(interval.value === 1 ? intervalNames[0] : intervalNames[1])}, this._hass) : haListManagerTodoCardText("ui.no_recurrence", {}, this._hass);
    const description = String(item.description || "").trim();
    const summary = `<div class="template-source-summary"><strong>${haListManagerTodoCardText("ui.details_to_apply", {}, this._hass)}</strong><dl><div><dt>${haListManagerTodoCardText("ui.description", {}, this._hass)}</dt><dd>${description ? esc(description) : haListManagerTodoCardText("ui.none", {}, this._hass)}</dd></div><div><dt>${haListManagerTodoCardText("ui.category", {}, this._hass)}</dt><dd>${esc(category)}</dd></div><div><dt>${haListManagerTodoCardText("ui.labels", {}, this._hass)}</dt><dd>${labels.length ? labels.map(esc).join(", ") : haListManagerTodoCardText("ui.none", {}, this._hass)}</dd></div><div><dt>${haListManagerTodoCardText("todo.repeat", {}, this._hass)}</dt><dd>${esc(intervalText)}</dd></div><div><dt>${haListManagerTodoCardText("ui.due_date", {}, this._hass)}</dt><dd>${haListManagerTodoCardText("ui.no_time_from_date", {}, this._hass)}</dd></div></dl><p>${haListManagerTodoCardText("help.todo_template_due_rules", {}, this._hass)}</p></div>`;
    return `<div class="backdrop"><div class="dialog" data-dialog><header><div><h2>${haListManagerTodoCardText("ui.save_template", {}, this._hass)}</h2><p>${esc(this._name(d.item))}</p></div><button data-close><ha-icon icon="mdi:close"></ha-icon></button></header><label>${haListManagerTodoCardText("todo.template_name", {}, this._hass)}<input data-template-name value="${esc(d.name)}" maxlength="100" autocomplete="off"></label><label>${haListManagerTodoCardText("ui.task_name", {}, this._hass)}<input data-template-item-name value="${esc(d.item_name)}" maxlength="200" autocomplete="off"></label><label>${haListManagerTodoCardText("ui.symbol_optional", {}, this._hass)}<ha-selector data-template-icon></ha-selector></label><label>${haListManagerTodoCardText("ui.optional_color", {}, this._hass)}<input data-template-color type="color" value="${esc(d.color || "#03a9f4")}"></label><div class="fields"><label>${haListManagerTodoCardText("ui.validity", {}, this._hass)}<select data-template-scope><option value="list" ${d.scope === "list" ? "selected" : ""}>${haListManagerTodoCardText("todo.this_list_only", {}, this._hass)}</option>${this._hass.user?.is_admin === true ? `<option value="list_type" ${d.scope === "list_type" ? "selected" : ""}>${haListManagerTodoCardText("ui.all_todo_lists", {}, this._hass)}</option>` : ""}</select></label><label>${haListManagerTodoCardText("ui.on_click", {}, this._hass)}<select data-template-mode><option value="direct" ${d.add_mode === "direct" ? "selected" : ""}>${haListManagerTodoCardText("ui.add_directly", {}, this._hass)}</option><option value="edit" ${d.add_mode === "edit" ? "selected" : ""}>${haListManagerTodoCardText("ui.edit_before_adding", {}, this._hass)}</option></select></label></div>${summary}<footer><button class="primary" data-save-template ${this._busy || !d.item_name.trim() ? "disabled" : ""}>${haListManagerTodoCardText("ui.save_template", {}, this._hass)}</button><button data-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></div></div>`;
  }
  _filterHtml() { if (!this._filterDialog) return ""; const current = this._activeFilter(); return `<div class="backdrop top filter-backdrop"><div class="dialog filter-dialog" data-dialog><header><h2>${haListManagerTodoCardText("todo.filter_tasks", {}, this._hass)}</h2><button data-close><ha-icon icon="mdi:close"></ha-icon></button></header><div class="actions">${Object.entries(FILTERS(this._hass)).map(([value, label]) => `<label class="action"><input type="radio" name="todo-filter" value="${value}" ${current === value ? "checked" : ""}><ha-icon icon="mdi:filter-outline"></ha-icon><span>${label}</span></label>`).join("")}</div><label class="remember"><input type="checkbox" data-remember-filter checked>${haListManagerTodoCardText("ui.remember_browser_list", {}, this._hass)}</label><footer><button class="primary" data-apply-filter>${haListManagerTodoCardText("ui.apply", {}, this._hass)}</button><button data-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></div></div>`; }
  _confirmationHtml() { const c = this._confirmation; if (!c) return ""; if (c.type === "discard_dialog") return `<div class="backdrop top" data-discard-backdrop><section class="dialog confirmation" role="alertdialog" aria-modal="true" aria-label="${haListManagerTodoCardText("ui.discard_changes_confirm", {}, this._hass)}" data-dialog data-discard-confirmation><ha-icon class="confirm-icon" icon="mdi:alert-outline"></ha-icon><h2>${haListManagerTodoCardText("ui.discard_changes_confirm", {}, this._hass)}</h2><p>${haListManagerTodoCardText("ui.dialog_changes_unsaved", {}, this._hass)}</p><footer><button class="danger filled" data-confirm-discard>${haListManagerTodoCardText("ui.discard_changes", {}, this._hass)}</button><button data-cancel-discard>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></section></div>`; if (c.type === "share") { const selected = new Set(c.selectedIds || []); return `<div class="backdrop top"><div class="dialog confirmation share-confirmation" data-dialog><ha-icon class="confirm-icon share-icon" icon="mdi:share-variant-outline"></ha-icon><h2>${haListManagerTodoCardText("ui.send_list_confirm", {}, this._hass)}</h2><p>${haListManagerTodoCardText("notifications.send_to_label", {}, this._hass)}</p><div class="share-targets">${c.profiles.map((profile) => `<label><input type="checkbox" data-share-profile="${esc(profile.id)}" ${selected.has(profile.id) ? "checked" : ""}><span>${esc(profile.name)}</span></label>`).join("")}</div><footer><button class="primary" data-confirm-share ${selected.size ? "" : "disabled"}>${haListManagerTodoCardText("ui.send", {}, this._hass)}</button><button data-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></div></div>`; } const all = c.type === "clear"; return `<div class="backdrop top"><div class="dialog confirmation" data-dialog><ha-icon class="confirm-icon" icon="mdi:delete-alert-outline"></ha-icon><h2>${all ? haListManagerTodoCardText("todo.confirm_delete_completed", {}, this._hass) : haListManagerTodoCardText("ui.delete_task_confirm", {}, this._hass)}</h2><p>${all ? haListManagerTodoCardText("todo.delete_completed_count", {p0:(this._items.filter((item) => item.completed).length)}, this._hass) : haListManagerTodoCardText("ui.delete_named_item_warning", {p0:(esc(this._name(c.item)))}, this._hass)}</p><footer><button class="danger filled" data-confirm-delete>${all ? haListManagerTodoCardText("ui.delete_all", {}, this._hass) : haListManagerTodoCardText("ui.delete", {}, this._hass)}</button><button data-close>${haListManagerTodoCardText("ui.cancel", {}, this._hass)}</button></footer></div></div>`; }
  _titleInfo() { const next = this._nextDue(this._items); if (!this._config.show_title_info || !next) return ""; return `<small class="title-info">${this._config.show_title_info_icon ? `<ha-icon icon="mdi:calendar-clock"></ha-icon>` : ""}${esc(this._formatDue(next))}</small>`; }

  // iOS native date/time styling can override border-box widths; the fields below opt out of that renderer.
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

  _styles() { return `.task-name{display:flex;align-items:center;gap:5px;min-width:0}.task-name strong{min-width:0}.pause-marker{flex:0 0 18px;width:18px;--mdc-icon-size:18px;color:var(--secondary-text-color)}.task-dates{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}.task-dates.inline{flex-direction:row;flex-wrap:wrap;align-items:center;column-gap:8px}.task-dates.inline .due{width:auto;display:flex;flex-wrap:wrap}.last-checked{display:inline-flex;align-items:center;gap:4px;font-size:var(--ha-list-manager-tertiary-font-size);line-height:1;color:var(--secondary-text-color)}.task-dates .task-date-icon{flex:0 0 18px;width:18px;height:18px;--mdc-icon-size:18px}.due.paused{color:var(--primary-text-color);font-weight:normal}.due.paused .due-value{text-decoration:line-through}.date-separator{margin-right:4px}.monitoring-option{display:flex;align-items:center;gap:8px}.monitoring-option input{flex:0 0 20px;width:20px;height:20px}.monitoring-settings .field-help{color:var(--secondary-text-color);font-size:13px;line-height:1.45}[hidden]{display:none!important}:host{display:block;container-type:inline-size}:host([data-expanded-view]){position:fixed!important;top:var(--expanded-top,56px)!important;right:var(--expanded-right,0)!important;bottom:var(--expanded-bottom,0)!important;left:var(--expanded-left,0)!important;z-index:9998;min-width:0!important;max-width:none!important;padding:16px;overflow:hidden;background:var(--primary-background-color,#111)}:host([data-expanded-view]) ha-card{height:100%;min-height:0!important;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,.45)}*{box-sizing:border-box}ha-card{padding:12px 14px 18px;background:var(--ha-card-background,var(--card-background-color));color:var(--primary-text-color)}button,input,textarea,select{font:inherit}.title{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-content:center;align-items:center;gap:6px;width:100%;height:50px;min-height:50px;margin:0 0 8px;color:var(--primary-text-color);text-align:left}.title-icon{display:grid;place-items:center;width:35px;height:35px;padding:5px;border-radius:50%;color:var(--primary-color)}.title-icon ha-icon{--mdc-icon-size:24px}.title-expand-toggle{border:0;background:transparent;cursor:pointer}.title-static-icon{pointer-events:none}.title-expand-toggle:hover,.title-expand-toggle:focus-visible{outline:0;background:color-mix(in srgb,var(--primary-text-color) 12%,transparent)}.title-copy{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:1px;min-width:0;width:100%;padding:0;color:var(--primary-text-color);background:transparent;text-align:left}.title-copy[data-toggle-list]:hover,.title-copy[data-toggle-expanded-view]:hover{background:color-mix(in srgb,var(--primary-text-color) 5%,transparent)}.list-collapsed{height:76px;padding:12px 14px}.list-collapsed .title{margin:0}.title-heading{grid-column:1;grid-row:1;display:flex;align-items:center;gap:8px;min-width:0}.title h2{min-width:0;overflow:hidden;margin:0;font-size:24px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}.title-meta{grid-column:1;grid-row:2;display:flex;align-items:center;flex-wrap:wrap;gap:5px 8px;min-width:0;color:var(--secondary-text-color)}.title .open{white-space:nowrap}.title .warning{display:inline-flex;align-items:center;justify-content:center;font-size:18px;line-height:1;color:var(--primary-text-color)}.title-info{display:flex;align-items:center;gap:5px;color:var(--secondary-text-color)}.title-info ha-icon{--mdc-icon-size:17px}.title-actions{display:flex;flex:0 0 auto;justify-content:flex-end}.title-actions-wide{display:flex;gap:6px}.title-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 11px;border:1px solid var(--divider-color);border-radius:19px;color:var(--primary-color);background:transparent}.title-action ha-icon{--mdc-icon-size:20px}.title-action span{font-size:13px}.compact-header-actions{display:none;position:relative}.compact-actions-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;display:grid;width:max-content;min-width:190px;overflow:hidden;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);box-shadow:0 8px 26px rgba(0,0,0,.38)}.compact-actions-menu button{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 14px;border-bottom:1px solid var(--divider-color);text-align:left}.compact-actions-menu button:last-child{border-bottom:0}.compact-actions-menu button:hover{background:var(--secondary-background-color)}.compact-actions-menu ha-icon{--mdc-icon-size:20px;color:var(--primary-color)}.send-status{display:flex;align-items:center;gap:7px;margin:8px 0;padding:8px 10px;border-left:3px solid var(--success-color,#43a047);border-radius:5px;background:color-mix(in srgb,var(--success-color,#43a047) 10%,transparent);font-size:13px}.send-status ha-icon{--mdc-icon-size:19px;color:var(--success-color,#43a047)}.input-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin:8px 0 14px}.task-input{position:relative;min-width:0}.task-input>input{padding-right:42px!important}.clear-input{position:absolute;right:5px;top:5px;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;color:var(--secondary-text-color);background:transparent}.clear-input:hover{color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 10%,transparent)}.clear-input ha-icon{--mdc-icon-size:20px}.input-row input,.dialog input,.dialog textarea,.dialog select{width:100%;min-height:38px;padding:6px 10px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color);outline:none}.input-row input{height:44px;min-height:44px}.input-row .primary{height:44px;min-height:44px}.dialog textarea{resize:vertical}.input-row input:focus,.dialog input:focus,.dialog textarea:focus,.dialog select:focus{border-color:var(--primary-color)}button{border:0;color:var(--primary-text-color);background:transparent;cursor:pointer}.primary{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 12px;border-radius:7px;color:#fff;background:var(--primary-color)}.option-row{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 10px;padding:6px;border-radius:8px;background:var(--secondary-background-color)}.option-row button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 10px;border:1px solid var(--divider-color);border-radius:9px;color:var(--secondary-text-color);background:var(--card-background-color);cursor:pointer}.option-row button:not(:disabled):hover,.option-row button:not(:disabled):focus-visible{color:var(--primary-color);border-color:var(--primary-color);outline:0;background:color-mix(in srgb,var(--primary-color) 10%,var(--card-background-color))}.option-row button:disabled{opacity:.45;cursor:default}.option-row ha-icon{--mdc-icon-size:19px}.option-row button.active{color:var(--primary-color);border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,var(--card-background-color))}.todo-card-layout{display:block}.todo-list-column{min-width:0}.todo-chips{min-width:0;margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--divider-color)}.todo-chips h3{display:flex;align-items:center;gap:6px;margin:0 0 8px;color:var(--secondary-text-color);font-size:13px;font-weight:500}.todo-chips h3 span,.todo-chips h3 .chip-category-toggle-all{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border:0;border-radius:11px;color:inherit;background:var(--secondary-background-color);font-size:12px}.todo-chips h3 .chip-category-toggle-all:hover,.todo-chips h3 .chip-category-toggle-all:focus-visible{color:var(--primary-color);outline:1px solid var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--secondary-background-color))}.todo-chips>div{display:flex;flex-wrap:wrap;gap:7px}.todo-chip{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:4px 11px;border:1px solid var(--divider-color);border-radius:17px;color:var(--primary-text-color);background:var(--secondary-background-color);cursor:pointer}.todo-chip ha-icon{--mdc-icon-size:18px;color:var(--chip-color,var(--primary-color))}.todo-chip.colored{border-color:color-mix(in srgb,var(--chip-color) 70%,var(--divider-color));background:color-mix(in srgb,var(--chip-color) 20%,var(--card-background-color))}.todo-chip:hover{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}.todo-chip.colored:hover{border-color:var(--chip-color,var(--primary-color));background:color-mix(in srgb,var(--chip-color) 30%,var(--card-background-color))}.view-panel.chips-position-auto .todo-card-layout,.chips-position-right .todo-card-layout,:host([data-expanded-view]) .chips-position-auto .todo-card-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);align-items:start;gap:16px}.view-panel.chips-position-auto .todo-chips,.chips-position-right .todo-chips,:host([data-expanded-view]) .chips-position-auto .todo-chips{margin:0;padding:0 0 0 16px;border-top:0;border-left:1px solid var(--divider-color)}button:disabled{opacity:.45;cursor:default}.error{display:flex;gap:8px;margin:10px 0;padding:10px;border-radius:8px;color:var(--error-color);background:color-mix(in srgb,var(--error-color) 12%,transparent)}main{display:grid;gap:4px}.category{overflow:hidden;border:0;border-radius:7px}.category-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;align-items:center;width:100%;min-height:38px;padding:3px 7px;text-align:left;background:var(--category-color,var(--secondary-background-color))}.category-head.colored{color:var(--category-text-color,#fff)}.category-icon{display:grid;place-items:center;width:calc(var(--ha-list-manager-category-icon-size) + 3px);height:calc(var(--ha-list-manager-category-icon-size) + 3px);margin-right:5px;color:inherit;background:transparent}.category-icon ha-icon{--mdc-icon-size:var(--ha-list-manager-category-icon-size)}.category-icon.large{width:calc(var(--ha-list-manager-category-large-icon-size) + 3px);height:calc(var(--ha-list-manager-category-large-icon-size) + 3px)}.category-icon.large ha-icon{--mdc-icon-size:var(--ha-list-manager-category-large-icon-size)}.category-title{display:flex;flex-direction:column;gap:1px}.category-title strong{font-size:var(--ha-list-manager-category-font-size)}.category-title small{display:flex;align-items:center;gap:3px;color:var(--secondary-text-color);font-size:var(--ha-list-manager-category-secondary-font-size)}.category-title small ha-icon{--mdc-icon-size:var(--ha-list-manager-category-icon-size)}.count{color:var(--secondary-text-color);font-size:var(--ha-list-manager-category-secondary-font-size)}.category-head.colored .count,.category-head.colored .category-title small{color:inherit;opacity:.85}.category-head .warning{display:inline-flex;align-items:center;justify-content:center;margin:0 5px;font-size:var(--ha-list-manager-category-icon-size);line-height:1;color:inherit}.category-head>ha-icon:last-child{--mdc-icon-size:var(--ha-list-manager-category-icon-size)}.items{display:grid;gap:0;padding:0 6px 0 8px}.item{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;border-bottom:0}.items>.item:first-child,.item+.item{padding-top:var(--ha-list-manager-item-divider-after-spacing)}.item:not(:last-child){padding-bottom:var(--ha-list-manager-item-divider-before-spacing)}.item-dividers .item{position:relative}.item-dividers .item:not(:last-child){padding-bottom:calc(var(--ha-list-manager-item-divider-before-spacing) + 1px)}.item-dividers .item:not(:last-child)::after{content:"";position:absolute;z-index:1;left:0;right:0;bottom:0;height:1px;background:var(--divider-color);pointer-events:none}.item:has(.drag){grid-template-columns:auto auto minmax(0,1fr)}.drag{align-self:center;color:var(--secondary-text-color);cursor:grab}.check{align-self:center;padding:0 7px 0 0}.check ha-icon{--mdc-icon-size:19px}.item-main{display:flex;flex-direction:column;align-items:stretch;align-self:center;gap:1px;min-width:0;padding:0;text-align:left}.item-name-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;width:100%}.item-main strong{overflow:hidden;font-size:var(--ha-list-manager-item-font-size);font-weight:500;line-height:1;text-overflow:ellipsis}.interval{color:var(--secondary-text-color);font-size:var(--ha-list-manager-secondary-font-size);line-height:1;white-space:nowrap}.item-main small{color:var(--secondary-text-color);font-size:var(--ha-list-manager-secondary-font-size);line-height:1;white-space:pre-wrap}.completed .item-main strong{text-decoration:line-through;color:var(--secondary-text-color)}.due-holder:empty{display:none}.due{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;font-size:var(--ha-list-manager-tertiary-font-size);line-height:1;color:var(--secondary-text-color)}.due-date{display:flex;align-items:center;gap:4px;min-width:0}.due-date ha-icon{flex:0 0 auto;--mdc-icon-size:15px}.due-remaining{white-space:nowrap;text-align:right}.due.soon{color:var(--warning-color,#f0a000)}.due.overdue{color:var(--error-color);font-weight:600}.empty{display:flex;align-items:center;justify-content:center;gap:8px;min-height:90px;color:var(--secondary-text-color)}.empty ha-icon{--mdc-icon-size:28px}.backdrop{--dialog-inset-top:max(18px,env(safe-area-inset-top,0px),var(--safe-area-inset-top,0px));--dialog-inset-bottom:max(18px,env(safe-area-inset-bottom,0px),var(--safe-area-inset-bottom,0px));position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:var(--dialog-inset-top) max(18px,env(safe-area-inset-right,0px),var(--safe-area-inset-right,0px)) var(--dialog-inset-bottom) max(18px,env(safe-area-inset-left,0px),var(--safe-area-inset-left,0px));overflow:auto;background:rgba(0,0,0,.58);overscroll-behavior:contain}.backdrop.top{z-index:1200}@supports(height:100dvh){.backdrop{height:100dvh;bottom:auto}.dialog{max-height:calc(100dvh - var(--dialog-inset-top,18px) - var(--dialog-inset-bottom,18px))}}.dialog{position:relative;width:min(620px,100%);min-width:0;max-height:calc(100vh - var(--dialog-inset-top,18px) - var(--dialog-inset-bottom,18px));overscroll-behavior:contain;overflow:auto;padding:18px;border-radius:14px;color:var(--primary-text-color);background:var(--card-background-color);box-shadow:0 12px 40px rgba(0,0,0,.45)}.dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.dialog h2{margin:0 0 12px;font-size:23px}.dialog-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;margin-bottom:12px}.dialog-heading h2{margin:0}.unsaved-indicator{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:14px;font-size:12px;color:var(--warning-color,#ff9800);background:color-mix(in srgb,var(--warning-color,#ff9800) 14%,transparent)}.unsaved-indicator ha-icon{--mdc-icon-size:16px}.dialog header p{margin:-12px 0 14px;color:var(--secondary-text-color)}.dialog header>button{padding:3px}.dialog header>button ha-icon{--mdc-icon-size:30px}.dialog>label{display:grid;gap:5px;margin:10px 0;color:var(--secondary-text-color)}.due-editor-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.7fr) auto;align-items:stretch;gap:6px}.due-editor-field{min-width:0;min-inline-size:0;max-width:100%;overflow:hidden}.due-editor-field>input{appearance:none;-webkit-appearance:none;display:block;box-sizing:border-box;width:100%;inline-size:100%;min-width:0;min-inline-size:0;max-width:100%;max-inline-size:100%;height:38px;min-height:38px}.due-editor-field>input::-webkit-date-and-time-value{min-width:0;min-inline-size:0;text-align:start}.due-editor-actions{display:flex;gap:6px}.due-editor-actions .icon-button{width:38px;flex:0 0 38px}.due-editor-row .icon-button{display:grid;place-items:center;min-height:38px;padding:0;border:1px solid var(--divider-color);border-radius:7px;background:var(--secondary-background-color)}.due-editor-row .icon-button ha-icon{--mdc-icon-size:23px}.due-editor-row .icon-button.pressed{filter:brightness(.7)}.fields{display:grid;grid-template-columns:minmax(90px,1fr) minmax(120px,1fr);gap:10px}.fields label{display:grid;gap:7px;color:var(--secondary-text-color)}.recurrence{grid-template-columns:repeat(2,minmax(0,1fr));align-items:end}.recurrence>label{min-width:0;grid-template-rows:auto 38px}.recurrence input,.recurrence select{min-width:0;height:38px}.category-picker{position:relative}.category-options{position:relative;z-index:5;margin-top:4px;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:9px;background:var(--card-background-color);box-shadow:0 8px 24px rgba(0,0,0,.25)}.category-options button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;text-align:left}.category-options button:hover{background:var(--secondary-background-color)}.category-options button>span:last-child{display:flex;flex-direction:column}.category-options small{color:var(--secondary-text-color)}.category-option-icon{display:grid;place-items:center;width:29px;height:29px;border-radius:50%;color:var(--category-color,var(--primary-color));background:color-mix(in srgb,var(--category-color,var(--primary-color)) 20%,transparent)}.template-source-summary{display:grid;gap:8px;margin-top:16px;padding:12px 14px;border-left:4px solid var(--primary-color);border-radius:8px;background:color-mix(in srgb,var(--primary-color) 10%,var(--secondary-background-color))}.template-source-summary>strong{font-size:15px}.template-source-summary dl{display:grid;gap:6px;margin:0}.template-source-summary dl>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px}.template-source-summary dt{color:var(--secondary-text-color)}.template-source-summary dd{min-width:0;margin:0;overflow-wrap:anywhere}.template-source-summary p{margin:2px 0 0;color:var(--secondary-text-color);font-size:13px;line-height:1.45}.edit-shortcuts{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px;position:static}.edit-shortcut{display:grid;place-items:center;width:44px;height:44px;min-width:44px;padding:0;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-color);background:var(--secondary-background-color);touch-action:manipulation}.edit-shortcut ha-icon{--mdc-icon-size:24px}.edit-shortcut:disabled{opacity:.45;cursor:default}.dialog footer{display:flex;flex-wrap:wrap;gap:9px;margin-top:16px}.dialog footer button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:43px;padding:0 16px;border:1px solid var(--divider-color);border-radius:22px}.dialog footer .primary{border-color:var(--primary-color)}.danger{color:var(--error-color)!important;border-color:var(--error-color)!important}.danger.filled{color:#fff!important;background:var(--error-color)}.actions{display:grid;gap:7px}.action{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:10px;min-height:48px;padding:8px 12px;border:1px solid var(--divider-color);border-radius:9px;background:var(--secondary-background-color)}.action input{width:20px;height:20px;min-height:0;padding:0;accent-color:var(--primary-color)}.action.disabled{opacity:.4}.remember{display:flex!important;grid-template-columns:auto 1fr!important;align-items:center;gap:9px!important}.remember input{width:20px;min-height:20px}.confirmation{text-align:center;width:min(480px,100%)}.confirmation footer{justify-content:center}.confirm-icon{--mdc-icon-size:48px;color:var(--error-color)}.share-icon{color:var(--primary-color)}.share-targets{display:flex;flex-direction:column;gap:7px;margin:10px 0;text-align:left}.share-targets label{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:var(--secondary-background-color);cursor:pointer}.share-targets input{width:20px;height:20px;accent-color:var(--primary-color)}@container(max-width:600px){.view-panel.chips-position-auto .todo-card-layout,.chips-position-right .todo-card-layout,:host([data-expanded-view]) .chips-position-auto .todo-card-layout{display:block}.view-panel.chips-position-auto .todo-chips,.chips-position-right .todo-chips,:host([data-expanded-view]) .chips-position-auto .todo-chips{margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--divider-color);border-left:0}ha-card{padding:10px}.list-collapsed .title{margin:0}.option-row button{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;min-height:38px;padding:0;gap:0;border-radius:9px}.option-row button>span{display:none}.title h2{font-size:21px;font-weight:400}.title-actions-wide{display:none}.compact-header-actions{display:block}.compact-actions-toggle{width:38px;padding:0}.input-row{grid-template-columns:1fr}.input-row .primary{height:42px;min-height:42px}.dialog{padding:14px}}@media(max-width:480px){.due-editor-row{grid-template-columns:minmax(0,1fr)}.due-editor-actions{grid-column:1/-1;justify-self:end}}@media(max-width:600px){ha-card,.list-collapsed{padding:10px}.title{height:54px;min-height:54px;margin:0 0 4px}.list-collapsed .title{margin:0}}@container(max-width:420px){.due{gap:6px}.due-date{font-size:11px}}${this._chipStyles()}`;
  }
  _labelStyles() { return `.dismissible-message{align-items:center}.dismissible-message>.message-copy{flex:1;min-width:0;overflow-wrap:anywhere}.dismissible-message>.message-close{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;margin-left:auto;padding:0;border:0;border-radius:50%;color:inherit;background:transparent}.message-close ha-icon{--mdc-icon-size:20px;color:inherit}.message-close:hover,.message-close:focus-visible{outline:0;background:color-mix(in srgb,currentColor 12%,transparent)}.picker-input-row{position:relative}.picker-input-row>input{width:100%;padding-right:86px!important}.picker-input-row .selection-open{position:absolute;z-index:4;right:4px;top:50%;display:grid;place-items:center;width:34px;height:34px;min-width:34px;min-height:34px;margin:0;padding:0;border:0;border-radius:50%;transform:translateY(-50%);color:var(--primary-color);background:transparent}.selection-open ha-icon{--mdc-icon-size:21px}.selection-open:hover,.selection-open:focus-visible{outline:0;background:color-mix(in srgb,var(--primary-color) 16%,transparent)}.selection-open:disabled,.picker-list-trigger:disabled{opacity:.45;cursor:default}.has-selection-popup>.picker-list-trigger{right:44px}.selection-backdrop{z-index:1100}.selection-popup{width:min(620px,100%);display:flex;flex-direction:column;gap:14px}.selection-popup header,.selection-popup footer{flex:0 0 auto;margin:0}.selection-popup>input{flex:0 0 auto}.selection-chip-grid{display:flex;flex-wrap:wrap;align-content:flex-start;gap:9px;min-height:0;max-height:55vh;overflow:auto;padding:3px}.selection-chip{display:inline-flex;align-items:center;gap:7px;max-width:100%;min-height:42px;padding:7px 12px;border:1px solid color-mix(in srgb,var(--selection-color,var(--primary-color)) 64%,var(--divider-color));border-radius:23px;background:color-mix(in srgb,var(--selection-color,var(--primary-color)) 16%,var(--card-background-color));color:var(--primary-text-color)}.selection-chip span{overflow-wrap:anywhere}.selection-chip>ha-icon:not(.selection-check){flex:0 0 auto;--mdc-icon-size:20px;box-sizing:content-box;padding:4px;border-radius:50%;color:var(--selection-ink,#fff);background:var(--selection-color,var(--primary-color))}.selection-chip.selected{border:2px solid var(--selection-color,var(--primary-color));padding:6px 11px;background:color-mix(in srgb,var(--selection-color,var(--primary-color)) 27%,var(--card-background-color))}.selection-chip .selection-check{color:var(--primary-text-color);--mdc-icon-size:18px}.selection-chip:hover,.selection-chip:focus-visible{outline:2px solid var(--primary-color);outline-offset:1px}.picker-trigger-host{position:relative}.picker-trigger-host input{padding-right:44px!important}.picker-list-trigger{position:absolute!important;z-index:4;right:4px;top:50%;display:grid!important;place-items:center;width:34px!important;height:34px!important;min-width:34px!important;min-height:34px!important;padding:0!important;transform:translateY(-50%);border:0!important;border-radius:50%!important;color:var(--primary-color)!important;background:transparent!important;cursor:pointer}.picker-list-trigger:hover,.picker-list-trigger:focus-visible,.picker-list-trigger.active{outline:0;background:color-mix(in srgb,var(--primary-color) 16%,transparent)!important}.picker-list-trigger ha-icon{--mdc-icon-size:21px}.picker-current{box-shadow:inset 3px 0 0 var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))!important}.item-labels{display:flex;width:100%;flex-wrap:wrap;gap:4px;margin-top:2px}.item-label{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;line-height:1;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 55%,var(--divider-color));border-radius:14px;color:var(--primary-text-color);background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent);font-size:var(--ha-list-manager-tertiary-font-size)}.item-label ha-icon{--mdc-icon-size:13px;color:var(--label-color,var(--primary-color))}.label-selector{display:grid;gap:9px;margin:16px 0 0;padding:0;border:0;border-radius:0;color:var(--secondary-text-color);min-inline-size:0}.label-selector legend{padding:0}.selected-labels{display:flex;flex-wrap:wrap;gap:7px}.selected-label{display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:3px 9px;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 58%,var(--divider-color));border-radius:18px;background:color-mix(in srgb,var(--label-color,var(--primary-color)) 22%,transparent)}.selected-label ha-icon{--mdc-icon-size:17px;color:var(--label-color,var(--primary-color))}.selected-label .remove-label{color:var(--secondary-text-color)}.label-search{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center}.label-search>ha-icon{grid-column:1;grid-row:1;position:relative;z-index:1;margin-left:10px;pointer-events:none}.label-search>input{grid-column:1/-1;grid-row:1;padding-left:42px}.label-options{grid-column:1/-1;display:grid;max-height:230px;overflow:auto;margin-top:4px;border:1px solid var(--divider-color);border-radius:9px;background:var(--card-background-color)}.label-options button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;text-align:left}.label-options button>span:last-child{display:flex;min-width:0;flex-direction:column;gap:2px}.label-options button small{color:var(--secondary-text-color)}.label-options button:hover{background:var(--secondary-background-color)}.label-option-icon{display:grid;place-items:center;width:29px;height:29px;border-radius:50%;color:var(--label-color,var(--primary-color));background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent)}.label-empty{margin:0;padding:12px;color:var(--secondary-text-color)}.task-input>input.has-chip-trigger{padding-right:78px!important}.clear-input.with-chip-trigger{right:39px}.chip-popup-trigger{position:absolute;z-index:3;right:5px;top:5px;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:50%;color:var(--primary-color);background:transparent}.chip-popup-trigger:hover{color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 10%,transparent)}.chip-popup-trigger ha-icon{--mdc-icon-size:21px}.chips-empty{display:block;padding:7px 2px;color:var(--secondary-text-color);font-size:13px}.todo-chip-groups{display:grid!important;gap:7px;width:100%}.todo-chip-group,.todo-chip-category-expanded{min-width:0;overflow:hidden;border:1px solid var(--divider-color);border-radius:9px}.todo-chip-category-head,.todo-chip-category-selector{display:grid;grid-template-columns:22px minmax(0,1fr) auto 20px;align-items:center;gap:7px;width:100%;min-height:40px;padding:6px 8px;border:0;border-radius:0;color:var(--primary-text-color);background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 15%,var(--card-background-color));text-align:left;cursor:pointer}.todo-chip-category-head:hover{border:0;background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 23%,var(--card-background-color))}.todo-chip-category-head>ha-icon:first-child,.todo-chip-category-selector>ha-icon:first-child{color:var(--category-chip-color,var(--primary-color))}.todo-chip-category-head strong,.todo-chip-category-selector strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.todo-chip-category-head>span,.todo-chip-category-selector>span{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:color-mix(in srgb,var(--primary-text-color) 8%,transparent);font-size:12px}.todo-chip-category-items,.todo-chip-category-expanded>div{display:flex;flex-wrap:wrap;gap:7px;padding:8px;border-top:1px solid var(--divider-color)}.todo-chip-flow{display:flex;flex-wrap:wrap;gap:7px}.todo-chip-flow>.todo-chip-category-expanded{flex:0 0 100%;width:100%}.todo-chip-category-selector{width:auto;border:1px solid color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 52%,var(--divider-color));border-radius:9px}.todo-chip-category-selector:hover,.todo-chip-category-selector.active{border-color:var(--category-chip-color,var(--primary-color));background:color-mix(in srgb,var(--category-chip-color,var(--primary-color)) 27%,var(--card-background-color))}.layout-compact .todo-chip-category-selector{grid-template-columns:20px minmax(0,auto);min-height:34px;border-radius:18px}.todo-chip-dialog-grid{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.chip-action-dialog{width:min(520px,100%)}.chip-menu-actions{display:grid;gap:8px;margin-top:16px}.chip-menu-actions button{display:grid;grid-template-columns:30px minmax(0,1fr);align-items:center;gap:10px;width:100%;padding:11px 13px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color);text-align:left}.chip-menu-actions span{display:flex;flex-direction:column;gap:2px}.chip-menu-actions small{color:var(--secondary-text-color)}`; }
  _lock() {
    if (!this._scrollLocked) {
      this._scrollLocked = true;
      this._oldOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
  }
  _unlock() {
    if (this._scrollLocked) {
      document.body.style.overflow = this._expandedView ? "hidden" : this._oldOverflow || "";
      this._scrollLocked = false;
    }
  }
  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    if (!this.shadowRoot) return;
    if (this._selectionPopup && (this._selectionPopup.parent !== this._dialog || this._selectionPopup.listId !== this._listId())) this._selectionPopup = null;
    const previousCard = this.shadowRoot.querySelector("ha-card");
    if (this._expandedView && previousCard?.scrollTop > 0) this._expandedScrollTop = previousCard.scrollTop;
    const active = this.shadowRoot.activeElement;
    const focusAttr = active?.getAttributeNames?.().find((name) => name.startsWith("data-"));
    const focusValue = focusAttr ? active.getAttribute(focusAttr) : null;
    const focusCategory = active?.closest?.(".category")?.dataset.categoryId;
    const supportsSelection = active?.tagName === "TEXTAREA"
      || (active?.tagName === "INPUT" && ["text", "search", "url", "tel", "password", "email"].includes(active.type));
    const selection = supportsSelection ? [active.selectionStart, active.selectionEnd] : null;
    const input = this._inputHtml(), options = this._optionsHtml(), titleWarning = this._items.some((item) => this._isDue(item));
    const contentDisplay = this._config.content_display || "card_and_large";
    const largeViewEnabled = contentDisplay !== "card_only";
    const largeOnly = contentDisplay === "large_only";
    const collapsible = this._config.collapsible !== false && !largeOnly;
    const collapsed = !this._expandedView && (largeOnly || (collapsible && this._listCollapsed()));
    const listBody = `${this._config.input_row_position === "top" ? input : ""}${this._config.option_row_position === "top" ? options : ""}<div class="status-region">${this._noticeHtml("notification", this._notificationStatus, "success")}</div>${this._noticeHtml("error", this._error)}<main>${this._contentHtml()}</main>${this._config.option_row_position === "bottom" ? options : ""}${this._config.input_row_position === "bottom" ? input : ""}`;
    const cardBody = collapsed ? "" : `<div class="todo-card-layout"><div class="todo-list-column">${listBody}</div>${this._chipsHtml()}</div>`;
    const expandedLabel = this._expandedView ? haListManagerTodoCardText("ui.close_large_view", {}, this._hass) : haListManagerTodoCardText("ui.open_large_view", {}, this._hass);
    const titleIconStyle = `color:${esc(this._configuredChipColor(this._config.title_icon_color_rgb, "var(--primary-color)"))}`;
    const titleIcon = largeViewEnabled
      ? `<button type="button" class="title-icon title-expand-toggle" style="${titleIconStyle}" data-toggle-expanded-view aria-pressed="${this._expandedView}" aria-label="${expandedLabel}" title="${expandedLabel}"><ha-icon icon="${esc(this._config.title_icon || "mdi:checkbox-marked-outline")}"></ha-icon></button>`
      : `<span class="title-icon title-static-icon" style="${titleIconStyle}"><ha-icon icon="${esc(this._config.title_icon || "mdi:checkbox-marked-outline")}"></ha-icon></span>`;
    const titleDue = this._titleInfo();
    const titleContent = `<span class="title-heading"><h2>${esc(this._config.title || this._list?.name || haListManagerTodoCardText("ui.tasks", {}, this._hass))}</h2>${this._config.show_title_exclamation_mark && titleWarning ? `<span class="warning" aria-label="${haListManagerTodoCardText("todo.due_tasks", {}, this._hass)}">⚠</span>` : ""}</span><span class="title-meta">${titleDue}${titleDue ? `<span class="title-separator">·</span>` : ""}<span class="open">${haListManagerTodoCardText("ui.open_count", {p0:(this._items.filter((item) => !item.completed).length)}, this._hass)}</span></span>`;
    const titleCopy = largeOnly
      ? `<button type="button" class="title-copy" data-toggle-expanded-view aria-expanded="${this._expandedView}">${titleContent}</button>`
      : collapsible
        ? `<button type="button" class="title-copy" data-toggle-list aria-expanded="${collapsed ? "false" : "true"}">${titleContent}</button>`
        : `<div class="title-copy">${titleContent}</div>`;
    const hasNotificationTarget = this._notificationAssignments.some((assignment) => assignment.manual_enabled && assignment.profile?.enabled);
    const shareButton = this._config.show_share_button !== false && hasNotificationTarget ? `<button class="title-action" type="button" data-send-list title="${haListManagerTodoCardText("ui.share_list", {}, this._hass)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:share-variant-outline"></ha-icon><span>${haListManagerTodoCardText("ui.share", {}, this._hass)}</span></button>` : "";
    const pdfButton = this._config.show_pdf_export_button === true ? `<button class="title-action" type="button" data-export-pdf title="${haListManagerTodoCardText("ui.export_list_pdf", {}, this._hass)}" ${this._pdfExporting ? "disabled" : ""}><ha-icon icon="mdi:file-pdf-box"></ha-icon><span>${this._pdfExporting ? "PDF …" : "PDF"}</span></button>` : "";
    const compactMenuItems = `${shareButton ? `<button type="button" data-send-list><ha-icon icon="mdi:share-variant-outline"></ha-icon><span>${haListManagerTodoCardText("ui.share_list", {}, this._hass)}</span></button>` : ""}${pdfButton ? `<button type="button" data-export-pdf ${this._pdfExporting ? "disabled" : ""}><ha-icon icon="mdi:file-pdf-box"></ha-icon><span>${this._pdfExporting ? haListManagerTodoCardText("ui.pdf_creating", {}, this._hass) : haListManagerTodoCardText("ui.export_pdf", {}, this._hass)}</span></button>` : ""}`;
    const titleActions = shareButton || pdfButton ? `<div class="title-actions"><div class="title-actions-wide">${shareButton}${pdfButton}</div><div class="compact-header-actions"><button type="button" class="title-action compact-actions-toggle" data-toggle-header-menu aria-expanded="${this._headerMenuOpen}" title="${haListManagerTodoCardText("ui.actions", {}, this._hass)}"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>${this._headerMenuOpen ? `<div class="compact-actions-menu">${compactMenuItems}</div>` : ""}</div></div>` : "";
    const title = `<div class="title">${titleIcon}${titleCopy}${titleActions}</div>`;
    const view = ["panel", "mobile"].includes(this._config.view_mode)
      ? this._config.view_mode
      : (this._isPanelDashboardView() ? "panel" : "auto");
    const itemFontSize = this._config.item_font_size;
    const categoryFontSize = itemFontSize * this._config.category_font_scale / 100;
    const categorySecondaryFontSize = Math.max(9, itemFontSize - 3);
    const categoryIconSize = Math.max(18, itemFontSize * 1.25);
    const categoryLargeIconSize = Math.max(22, itemFontSize * 1.5);
    const dividerBeforeSpacing = this._config.item_divider_before_spacing;
    const dividerAfterSpacing = this._config.item_divider_after_spacing;
    const appearanceStyle = `--ha-list-manager-item-font-size:${itemFontSize}px;--ha-list-manager-secondary-font-size:${Math.max(10, itemFontSize - 2)}px;--ha-list-manager-tertiary-font-size:${Math.max(9, itemFontSize - 3)}px;--ha-list-manager-category-font-size:${categoryFontSize.toFixed(2)}px;--ha-list-manager-category-secondary-font-size:${categorySecondaryFontSize.toFixed(2)}px;--ha-list-manager-category-icon-size:${categoryIconSize.toFixed(2)}px;--ha-list-manager-category-large-icon-size:${categoryLargeIconSize.toFixed(2)}px;--ha-list-manager-item-divider-before-spacing:${dividerBeforeSpacing}px;--ha-list-manager-item-divider-after-spacing:${dividerAfterSpacing}px`;
    const dividerClass = this._config.show_item_dividers ? "item-dividers" : "";
    const markup = `<style>${this._styles()}${this._labelFilterStyles()}${this._filterHostStyles()}${this._labelStyles()}${globalThis.HaListManagerDialogSections.styles()}</style><ha-card class="view-${view} chips-position-${esc(this._config.chips_position || "auto")} ${dividerClass} ${collapsed ? "list-collapsed" : ""}" style="${appearanceStyle}">${title}${cardBody}${this._editorHtml()}${this._actionHtml()}${this._templateDialogHtml()}${this._confirmationHtml()}${this._chipDialogHtml()}${this._chipMenuHtml()}${this._renderLabelFilterDialog()}<div data-selection-popup-host>${this._selectionPopupHtml()}</div></ha-card>`;
    this._clearRenderListeners();
    const template = document.createElement("template");
    template.innerHTML = markup;
    this._patchDom(this.shadowRoot, template.content);
    this._bind();
    if (focusAttr) {
      const next = [...this.shadowRoot.querySelectorAll(`[${focusAttr}]`)]
        .find((element) => element.getAttribute(focusAttr) === focusValue && (focusCategory == null || element.closest?.(".category")?.dataset.categoryId === focusCategory));
      if (next && this.shadowRoot.activeElement !== next) next.focus({ preventScroll: true });
      if (selection && next?.setSelectionRange) next.setSelectionRange(selection[0], selection[1]);
    }
    this._restoreSelectionParent();
    this._restoreExpandedScroll();
  }
  // Keep HA's live card, scroll anchors and focused controls mounted. Like the
  // shopping card's quantity updates, a refresh only changes existing content.
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
      const triggerHost = input.closest(".picker-input-row") || searchRow || menuHost;
      const menu = menuHost?.querySelector(menuSelector);
      if (!triggerHost || !menu || triggerHost.querySelector(":scope > [data-picker-list-trigger]")) return;
      triggerHost.classList.add("picker-trigger-host");
      input.style.setProperty("padding-right", triggerHost.querySelector("[data-open-selection]") ? "86px" : "44px", "important");
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "picker-list-trigger";
      trigger.dataset.pickerListTrigger = "";
      trigger.disabled = this._busy || input.disabled;
      if (triggerHost.querySelector("[data-open-selection]")) triggerHost.classList.add("has-selection-popup");
      trigger.title = haListManagerTodoCardText("ui.open_picker_close_keyboard", {}, this._hass);
      trigger.setAttribute("aria-label", trigger.title);
      trigger.innerHTML = '<ha-icon icon="mdi:gesture-tap-button"></ha-icon>';
      this._listen(trigger, "pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
      this._listen(trigger, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this._busy || input.disabled) return;
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
          if (this._selectionPopup) return;
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

  _configureCategory() { const input = this.shadowRoot.querySelector("[data-d-category]"), menu = this.shadowRoot.querySelector("[data-category-options]"); if (!input || !menu || !this._dialog) return; const filter = () => { const query = input.value.trim().toLocaleLowerCase(); menu.querySelectorAll("[data-category-option]").forEach((button) => { const category = this._selectionOptions("categories").find((entry) => !entry.uncategorized && entry.id === button.dataset.categoryOption); const name = category?.name || haListManagerTodoCardText("ui.general", {}, this._hass); const hide = Boolean(query && !name.toLocaleLowerCase().includes(query)); button.hidden = hide; button.style.display = hide ? "none" : ""; }); menu.hidden = false; }; this._listen(input, "focus", filter); this._listen(input, "input", (event) => { this._dialog.category_id = null; this._dialog.category_name = event.target.value; filter(); }); this._listen(input, "blur", () => setTimeout(() => { menu.hidden = true; }, 120)); menu.querySelectorAll("[data-category-option]").forEach((button) => this._listen(button, "mousedown", (event) => { event.preventDefault(); const category = this._selectionOptions("categories").find((entry) => !entry.uncategorized && entry.id === button.dataset.categoryOption); this._dialog.category_id = category && !category.dynamic ? category.id : null; this._dialog.category_name = category?.name || ""; this._render(); })); }
  _configureLabels() {
    const input = this.shadowRoot.querySelector("[data-label-input]"), menu = this.shadowRoot.querySelector("[data-label-options]"), draft = this._dialog;
    if (!input || !menu || !draft) return;
    const available = () => { const query = input.value.trim().toLocaleLowerCase(); return this._labels.filter((label) => !draft.label_ids.includes(label.id) && label.name.toLocaleLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name, haListManagerTodoCardTextLocale(this._hass), { sensitivity: "base" })); };
    const choose = (id) => { if (!id || draft.label_ids.includes(id)) return; draft.label_ids = [...draft.label_ids, id]; this._render(); };
    const renderMenu = () => { const labels = available(); this._clearRenderListeners(menu); menu.innerHTML = labels.length ? labels.map((label) => `<button type="button" data-label-option="${esc(label.id)}"><span class="label-option-icon" style="${label.color ? `--label-color:${esc(label.color)}` : ""}"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon></span><span><strong>${esc(label.name)}${globalThis.HaListManagerDialogSections.labelMarker(label, haListManagerTodoCardText("labels.filter_label", {}, this._hass))}</strong><small>${esc(label.scope === "global" ? haListManagerTodoCardText("ui.global", {}, this._hass) : label.scope === "list" ? haListManagerTodoCardText("ui.this_list", {}, this._hass) : haListManagerTodoCardText("ui.todo", {}, this._hass))}${label.hide_in_items ? ` – ${haListManagerTodoCardText("labels.filter_label", {}, this._hass)}` : ""}</small></span></button>`).join("") : `<p class="label-empty">${haListManagerTodoCardText("labels.no_matches", {}, this._hass)}</p>`; menu.hidden = false; menu.querySelectorAll("[data-label-option]").forEach((button) => this._listen(button, "mousedown", (event) => { event.preventDefault(); choose(button.dataset.labelOption); })); };
    this._listen(input, "focus", renderMenu); this._listen(input, "input", renderMenu); this._listen(input, "keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); choose(available()[0]?.id); } }); this._listen(input, "blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    this._bindSelectedLabelRemovals(this.shadowRoot);
  }
  _bindContent(root = this.shadowRoot, bindCategories = true) {
    if (bindCategories) root.querySelectorAll("[data-category]").forEach((button) => this._listen(button, "click", () => this._toggleCategory(button.dataset.category, button)));
    root.querySelectorAll("[data-edit]").forEach((button) => this._listen(button, "click", () => { const item = this._items.find((entry) => entry.id === button.dataset.edit); if (item) this._openEditor(item, "", button.closest("[data-item-id]")); }));
    root.querySelectorAll("[data-item-action]").forEach((button) => {
      const item = this._items.find((entry) => entry.id === button.dataset.itemAction);
      if (!item) return;
      const cancel = () => { clearTimeout(this._pressTimer); this._pressTimer = null; };
      this._listen(button, "click", (event) => {
        if (Date.now() < this._suppressActionClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
        const behavior = this._config.todo_action_behavior;
        if (behavior === "click_default_long_menu") this._execute(item, this._config.todo_default_action, button.closest("[data-item-id]"));
        else this._openAction(item, button.closest("[data-item-id]"));
      });
      this._listen(button, "pointerdown", (event) => {
        if (typeof event.button === "number" && event.button !== 0) return;
        cancel();
        const behavior = this._config.todo_action_behavior;
        if (!["click_menu_long_default", "click_default_long_menu"].includes(behavior)) return;
        this._pressTimer = setTimeout(() => {
          this._suppressActionClickUntil = Date.now() + 900;
          if (behavior === "click_menu_long_default") this._execute(item, this._config.todo_default_action, button.closest("[data-item-id]"));
          else this._openAction(item, button.closest("[data-item-id]"));
        }, 600);
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach((type) => this._listen(button, type, cancel));
      this._listen(button, "contextmenu", (event) => event.preventDefault());
    });
    if (this._config.sort_mode === "manual") root.querySelectorAll("[draggable=true]").forEach((row) => {
      this._listen(row, "dragstart", (event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", row.dataset.itemId); row.classList.add("dragging"); });
      this._listen(row, "dragend", () => row.classList.remove("dragging"));
      this._listen(row, "dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
      this._listen(row, "drop", (event) => { event.preventDefault(); this._moveItem(event.dataTransfer.getData("text/plain"), row.dataset.itemId); });
    });
  }
  _refreshFilteredContent() {
    if (this._config.allow_filter) {
      const main = this.shadowRoot.querySelector("main");
      if (main) { this._clearRenderListeners(main); main.innerHTML = this._contentHtml(); this._bindContent(main); }
      const toggle = this.shadowRoot.querySelector("[data-toggle-categories]");
      if (toggle) toggle.disabled = this._searchExpandsGroups() || !this._groups().length;
    }
    if (this._config.filter_chips !== false) {
      const chips = this.shadowRoot.querySelector(".todo-chips");
      if (chips) { this._clearRenderListeners(chips); chips.outerHTML = this._chipsHtml(); const nextChips = this.shadowRoot.querySelector(".todo-chips"); globalThis.HaListManagerDialogSections.bindQuick(this); this._bindVisibleTemplateActions(nextChips); this._bindLabelFilterControls(nextChips); }
    }
  }
  _clearInput() {
    this._input = "";
    const input = this.shadowRoot.querySelector("[data-new-task]");
    if (input) input.value = "";
    const clear = this.shadowRoot.querySelector("[data-clear-input]");
    if (clear) clear.hidden = true;
    if (this._config.allow_filter || this._config.filter_chips !== false) this._refreshFilteredContent();
    input?.focus();
  }
  _bindTemplateButton(button, chip, dialog = false) {
    if (!button || !chip) return;
    this._listen(button, "click", async (event) => {
      if (Date.now() < this._suppressChipClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
      if (dialog) { this._chipDialog = false; this._unlock(); }
      await this._useTemplateChip(chip);
    });
    if (this._config.show_important_chips === false) return;
    const cancel = () => { clearTimeout(this._chipPressTimer); this._chipPressTimer = null; };
    this._listen(button, "pointerdown", (event) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      cancel(); this._chipPressTimer = setTimeout(() => {
        this._suppressChipClickUntil = Date.now() + 900; this._chipDialog = false;
        this._chipMenu = { chip, status: "" }; this._lock(); this._render();
      }, 650);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((type) => this._listen(button, type, cancel));
    this._listen(button, "contextmenu", (event) => event.preventDefault());
  }
  _bindVisibleTemplateActions(root = this.shadowRoot) {
    if (!root) return; const chips = this._displayChips();
    this._listen(root.querySelector("[data-toggle-chip-categories]"), "click", () => this._toggleAllChipCategories());
    root.querySelectorAll("[data-todo-chip]").forEach((button) => this._bindTemplateButton(button, chips.find((chip) => chip.id === button.dataset.todoChip), false));
    root.querySelectorAll("[data-todo-chip-category]").forEach((button) => this._listen(button, "click", () => this._toggleChipCategory(button.dataset.todoChipCategory, button.dataset.dialogCategory === "1")));
  }
  _bind() {
    globalThis.HaListManagerDialogSections.bindQuick(this);
    const root = this.shadowRoot;
    globalThis.HaListManagerDialogSections.bind(this, root);
    root.querySelectorAll("[data-dismiss-message]").forEach((button) => { this._listen(button, "pointerdown", (event) => event.preventDefault()); this._listen(button, "click", (event) => { event.preventDefault(); event.stopPropagation(); this._dismissMessage(button.dataset.dismissMessage, button); }); });
    root.querySelectorAll("[data-open-selection]").forEach((button) => { this._listen(button, "pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); }); this._listen(button, "click", (event) => { event.preventDefault(); event.stopPropagation(); this._openSelectionPopup(button.dataset.openSelection, button); }); });
    this._bindSelectionPopup(root.querySelector("[data-selection-popup-host]") || root); const input = root.querySelector("[data-new-task]"); this._listen(input, "input", (event) => { this._input = event.target.value; const clear = root.querySelector("[data-clear-input]"); if (clear) clear.hidden = !this._input; if (this._config.allow_filter || this._config.filter_chips !== false) this._refreshFilteredContent(); }); this._listen(input, "keydown", (event) => { if (event.key === "Enter" && this._input.trim()) this._openEditor(null, this._input.trim()); }); this._listen(root.querySelector("[data-clear-input]"), "click", () => this._clearInput()); this._listen(root.querySelector("[data-add-task]"), "click", () => { if (this._input.trim()) this._openEditor(null, this._input.trim()); });
    this._listen(root.querySelector("[data-toggle-header-menu]"), "click", () => { this._headerMenuOpen = !this._headerMenuOpen; this._render(); });
    root.querySelectorAll("[data-send-list]").forEach((button) => this._listen(button, "click", () => { this._headerMenuOpen = false; this._requestShare(); }));
    root.querySelectorAll("[data-export-pdf]").forEach((button) => this._listen(button, "click", () => { this._headerMenuOpen = false; this._exportPdf(); }));
    this._listen(root, "click", (event) => { if (this._headerMenuOpen && !event.target.closest(".compact-header-actions")) { this._headerMenuOpen = false; this._render(); } });
    this._listen(root.querySelector("ha-card"), "scroll", (event) => { if (this._expandedView) this._expandedScrollTop = event.currentTarget.scrollTop; }, { passive: true });
    root.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => this._listen(element, "click", (event) => this._toggleExpandedView(event)));
    const chips = this._displayChips(); this._bindVisibleTemplateActions(root);
    root.querySelectorAll("[data-dialog-todo-chip]").forEach((button) => this._bindTemplateButton(button, chips.find((chip) => chip.id === button.dataset.dialogTodoChip), true));
    this._listen(root.querySelector("[data-open-chip-dialog]"), "click", () => { this._chipDialog = true; this._lock(); this._render(); });
    root.querySelectorAll("[data-close-chip-dialog]").forEach((element) => this._listen(element, "click", (event) => { if (element === event.target || element.matches("button")) { this._chipDialog = false; this._unlock(); this._render(); } }));
    root.querySelectorAll("[data-close-chip-menu]").forEach((element) => this._listen(element, "click", (event) => { if (element === event.target || element.matches("button")) { this._chipMenu = null; this._unlock(); this._render(); } }));
    this._listen(root.querySelector("[data-toggle-important-template]"), "click", () => this._toggleImportantChip(this._chipMenu?.chip));
    this._listen(root.querySelector("[data-toggle-list]"), "click", () => { if (!this._expandedView) this._toggleList(); });
    this._bindContent(root);
    this._listen(root.querySelector("[data-clear-completed]"), "click", () => { this._confirmation = { type: "clear" }; this._lock(); this._render(); });
    this._listen(root.querySelector("[data-toggle-categories]"), "click", () => this._toggleAllCategories());
    this._listen(root.querySelector("[data-toggle-grouping]"), "click", () => this._toggleGrouping());
    this._listen(root.querySelector("[data-d-paused]"), "change", (event) => { this._dialog.monitoring_paused = event.target.checked; this._updateDialogDirtyState(); });
    root.querySelectorAll("[data-close]").forEach((button) => this._listen(button, "click", () => this._closeDialogs())); this._listen(root.querySelector("[data-d-name]"), "input", (event) => { this._dialog.name = event.target.value; }); this._listen(root.querySelector("[data-d-description]"), "input", (event) => { this._dialog.description = event.target.value; }); this._listen(root.querySelector("[data-d-date]"), "input", (event) => { this._dialog.due_date = event.target.value; const time = root.querySelector("[data-d-time]"); if (time) time.disabled = !event.target.value; }); this._listen(root.querySelector("[data-d-time]"), "input", (event) => { this._dialog.due_time = event.target.value; }); this._listen(root.querySelector("[data-d-interval]"), "input", (event) => { this._dialog.interval_value = event.target.value; }); this._listen(root.querySelector("[data-d-unit]"), "change", (event) => { this._dialog.interval_unit = event.target.value; }); this._listen(root.querySelector("[data-copy-due]"), "click", (event) => this._copyDueSettings(event.currentTarget)); this._listen(root.querySelector("[data-paste-due]"), "click", () => this._pasteDueSettings()); this._listen(root.querySelector("[data-save]"), "click", () => this._saveEditor()); this._listen(root.querySelector("[data-request-delete]"), "click", () => { this._confirmation = { type: "delete", item: this._dialog.item }; this._render(); });
    root.querySelectorAll("[data-save-item-template]").forEach((button) => this._listen(button, "click", () => this._openEditorTemplate(button)));
    this._listen(root.querySelector("[data-run-action]"), "click", () => { const chosen = root.querySelector('input[name="todo-action"]:checked')?.value; if (chosen) this._execute(this._actionDialog.item, chosen); }); root.querySelectorAll('input[name="todo-action"]').forEach((radio) => this._listen(radio, "change", () => { this._actionDialog.action = radio.value; }));
    this._listen(root.querySelector("[data-template-name]"), "input", (event) => { this._templateDialog.name = event.target.value; });
    this._listen(root.querySelector("[data-template-item-name]"), "input", (event) => { this._templateDialog.item_name = event.target.value; const save = root.querySelector("[data-save-template]"); if (save) save.disabled = !event.target.value.trim() || this._busy; });
    this._listen(root.querySelector("[data-template-color]"), "input", (event) => { this._templateDialog.color = event.target.value; });
    this._listen(root.querySelector("[data-template-scope]"), "change", (event) => { this._templateDialog.scope = event.target.value; });
    this._listen(root.querySelector("[data-template-mode]"), "change", (event) => { this._templateDialog.add_mode = event.target.value; });
    const templateIcon = root.querySelector("[data-template-icon]"); if (templateIcon && this._templateDialog) { templateIcon.hass = this._hass; templateIcon.selector = { icon: {} }; templateIcon.value = this._templateDialog.icon || undefined; this._listen(templateIcon, "value-changed", (event) => { this._templateDialog.icon = event.detail.value || ""; }); }
    this._listen(root.querySelector("[data-save-template]"), "click", () => this._saveTemplateFromItem());
    this._listen(root.querySelector("[data-confirm-delete]"), "click", () => this._confirmation.type === "clear" ? this._clearCompleted() : this._deleteItem(this._confirmation.item));
    this._listen(root.querySelector("[data-confirm-share]"), "click", () => this._confirmShare());
    root.querySelectorAll("[data-share-profile]").forEach((checkbox) => this._listen(checkbox, "change", () => { const selected = new Set(this._confirmation?.selectedIds || []); if (checkbox.checked) selected.add(checkbox.dataset.shareProfile); else selected.delete(checkbox.dataset.shareProfile); this._confirmation.selectedIds = [...selected]; const send = root.querySelector("[data-confirm-share]"); if (send) send.disabled = selected.size === 0; }));
    this._listen(root, "input", () => this._updateDialogDirtyState());
    this._listen(root, "change", () => this._updateDialogDirtyState());
    this._bindFilterMenu(root);
    this._bindLabelFilter(root);
    this._bindDiscardConfirmation();
    this._configureCategory(); this._configureLabels(); this._installPickerListTriggers();
  }
}

class HaListManagerTodoCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); this._form = null; }
  set hass(value) { this._hass = value; haListManagerTodoCardTextUpdateTranslations(this, value); this._render(); }
  setConfig(config) { this._config = { ...HaListManagerTodoCard.getStubConfig(this._hass), ...config }; this._render(); }
  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return; if (!this._config) return; if (!this._form) { this._form = document.createElement("ha-form"); this._form.addEventListener("value-changed", (event) => { this._config = { ...this._config, ...event.detail.value }; this.dispatchEvent(new CustomEvent("config-changed", { bubbles: true, composed: true, detail: { config: this._config } })); }); this.shadowRoot.append(this._form); } const definition = HaListManagerTodoCard.getConfigForm(this._hass); this._form.hass = this._hass; this._form.data = this._config; this._form.schema = definition.schema; this._form.computeLabel = definition.computeLabel; this._form.computeHelper = definition.computeHelper; }
}

globalThis.HaListManagerFilters.install(HaListManagerTodoCard.prototype);

if (!customElements.get("ha-list-manager-todo-card-editor")) customElements.define("ha-list-manager-todo-card-editor", HaListManagerTodoCardEditor);
if (!customElements.get("ha-list-manager-todo-card")) customElements.define("ha-list-manager-todo-card", HaListManagerTodoCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "ha-list-manager-todo-card")) window.customCards.push({ type: "ha-list-manager-todo-card", name: "HA List Manager · To-do", preview: false });
console.info(`%c HA-LIST-MANAGER-TODO-CARD %c ${CARD_VERSION} `, "color:white;background:#03a9f4;font-weight:bold", "color:#03a9f4;background:white;font-weight:bold");
