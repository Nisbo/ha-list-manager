// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerHistoryCardTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerHistoryCardTextLanguage(hass = null) {
  return haListManagerHistoryCardTextLocale(hass).toLowerCase().split("-")[0] === "de" ? "de" : "en";
}
function haListManagerHistoryCardText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerHistoryCardTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerHistoryCardTextLocale(hass));
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
function haListManagerHistoryCardTextUpdateTranslations(element, hass) {
  if (!hass) return false;
  const previous = element._nativeTranslationState;
  const language = String(hass.language || haListManagerHistoryCardTextLocale(hass));
  const connection = hass.connection || hass;
  const changed = !previous || previous.language !== language || previous.connection !== connection;
  const wasReady = previous?.ready;
  let state = previous;
  if (changed) {
    state = { language, connection, previousLocalize: previous?.localize, switched: Boolean(previous && previous.language !== language), localize: hass.localize, renderedLocalize: hass.localize, ready: false };
    // Preloaded resources are immediately usable, including in an editor.
    state.ready = Boolean(haListManagerHistoryCardText("ui.cancel", {}, hass)) && (!state.switched || hass.localize !== state.previousLocalize);
    element._nativeTranslationState = state;
    haListManagerHistoryCardTextLoadTranslations(hass).then((localize) => {
      if (element._nativeTranslationState !== state) return;
      state.needsRefresh = Boolean(localize && localize !== state.renderedLocalize);
      const current = element._hass;
      if (!current || String(current.language || haListManagerHistoryCardTextLocale(current)) !== language || (current.connection || current) !== connection) return;
      if (haListManagerHistoryCardText("ui.cancel", {}, current) && (!state.switched || current.localize !== state.previousLocalize) && (!state.ready || (state.needsRefresh && current.localize !== state.renderedLocalize))) {
        state.ready = true;
        state.needsRefresh = false;
        state.renderedLocalize = current.localize;
        haListManagerHistoryCardTextUpdateMetadata(current);
        element._render();
      }
    }).catch((error) => {
      if (element._nativeTranslationState === state) console.warn(error);
    });
  } else if (!state.ready && haListManagerHistoryCardText("ui.cancel", {}, hass) && (!state.switched || hass.localize !== state.previousLocalize)) {
    state.ready = true;
  }
  const refresh = state.ready && state.needsRefresh && hass.localize !== state.renderedLocalize;
  if (state.ready && (changed || !wasReady || refresh)) { state.renderedLocalize = hass.localize; state.needsRefresh = false; }
  state.localize = hass.localize;
  if (state.ready && (changed || !wasReady || refresh)) haListManagerHistoryCardTextUpdateMetadata(hass);
  return state.ready && (changed || !wasReady || refresh);
}
function haListManagerHistoryCardTextUpdateMetadata(hass) {
  const metadata = window.customCards?.find((card) => card.type === "ha-list-manager-history-card");
  if (metadata) {
    metadata.name = haListManagerHistoryCardText("history.entity_inventory_title", {}, hass) || metadata.name;
    metadata.description = haListManagerHistoryCardText("help.history_card_description", {}, hass);
  }
}
function haListManagerHistoryCardTextRequest(hass, message) {
  return hass.callWS(message.type?.startsWith("ha_list_manager/") ? { ...message, language: haListManagerHistoryCardTextLanguage(hass) } : message);
}

const HA_LM_HISTORY_API = "ha_list_manager";
const CARD_VERSION = "1.0.0b1";

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

class HaListManagerHistoryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._states = [];
    this._seriesData = [];
    this._loading = false;
    this._loadGeneration = 0;
    this._reloadPending = false;
    this._disconnected = false;
    this._error = "";
    this._truncated = false;
    this._requestTimer = null;
    this._refreshTimer = null;
    this._lastSourceUpdate = "";
    this._collapsed = null;
    this._legendCollapsed = null;
    this._aggregateHelpOpen = false;
    this._activeView = null;
    this._expandedView = false;
    this._expandedViewWasCollapsed = false;
    this._expandedViewport = null;
    this._expandedResizeObserver = null;
    this._expandedResizeFrame = null;
    this._expandedPageOverflow = null;
    this._onExpandedViewResize = () => this._scheduleExpandedViewBounds();
    this._onExpandedViewKeydown = (event) => {
      if (event.key === "Escape" && this._expandedView) this._setExpandedView(false);
    };
  }

  static getConfigElement() {
    return document.createElement("ha-list-manager-history-card-editor");
  }

  static getConfigForm(hass = null) {
    const labels = {
      entity: haListManagerHistoryCardText("ui.entity", {}, hass),
      attribute: haListManagerHistoryCardText("history.optional_attribute", {}, hass),
      min_value: haListManagerHistoryCardText("ui.min_value", {}, hass),
      max_value: haListManagerHistoryCardText("ui.max_value", {}, hass),
      values_to_show: haListManagerHistoryCardText("history.latest_readings", {}, hass),
      hours_to_show: haListManagerHistoryCardText("history.time_range_hours", {}, hass),
      title: haListManagerHistoryCardText("ui.title_optional", {}, hass),
      icon: haListManagerHistoryCardText("ui.icon_optional", {}, hass),
      icon_color: haListManagerHistoryCardText("ui.optional_icon_color", {}, hass),
      series_name: haListManagerHistoryCardText("ui.series_label_optional", {}, hass),
      connect_points: haListManagerHistoryCardText("history.connect_points", {}, hass),
      scale_decimals: haListManagerHistoryCardText("history.max_decimal_places", {}, hass),
      value_fixed_decimals: haListManagerHistoryCardText("history.always_show_full_precision", {}, hass),
      axis_decimals: haListManagerHistoryCardText("history.axis_max_decimals", {}, hass),
      axis_fixed_decimals: haListManagerHistoryCardText("ui.full_precision_scale", {}, hass),
      view: haListManagerHistoryCardText("ui.appearance", {}, hass),
      show_view_toggle: haListManagerHistoryCardText("history.show_view_switch", {}, hass),
      header_value: haListManagerHistoryCardText("history.header_current_value", {}, hass),
      list_rows_before_scroll: haListManagerHistoryCardText("history.rows_before_scroll", {}, hass),
      collapsible: haListManagerHistoryCardText("ui.collapsible_card", {}, hass),
      initially_collapsed: haListManagerHistoryCardText("ui.initially_collapsed", {}, hass),
      legend_collapsible: haListManagerHistoryCardText("ui.legend_collapsible", {}, hass),
      legend_initially_collapsed: haListManagerHistoryCardText("ui.legend_initially_collapsed", {}, hass),
    };
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "entity", required: true, selector: { entity: {} } },
        { type: "expandable", label: haListManagerHistoryCardText("history.primary_entity", {}, hass), icon: "mdi:numeric-1-circle-outline", schema: [
          { name: "series_name", selector: { text: {} } },
          { name: "attribute", selector: { text: {} } },
          { name: "icon", selector: { icon: {} } },
          { name: "icon_color", selector: { color_rgb: {} } },
          { name: "connect_points", selector: { boolean: {} }, default: true },
        ] },
        ...[2, 3, 4, 5].map((index) => ({
          type: "expandable", label: haListManagerHistoryCardText("ui.numbered_entity_optional", {p0:(index)}, hass), icon: `mdi:numeric-${index}-circle-outline`, schema: [
            { name: `entity_${index}`, selector: { entity: {} } },
            { name: `series_name_${index}`, selector: { text: {} } },
            { name: `attribute_${index}`, selector: { text: {} } },
            { name: `icon_${index}`, selector: { icon: {} } },
            { name: `icon_color_${index}`, selector: { color_rgb: {} } },
            { name: `connect_points_${index}`, selector: { boolean: {} }, default: true },
          ],
        })),
        { type: "expandable", label: haListManagerHistoryCardText("ui.filter", {}, hass), icon: "mdi:filter-outline", schema: [
          { name: "min_value", selector: { number: { mode: "box", step: "any" } } },
          { name: "max_value", selector: { number: { mode: "box", step: "any" } } },
        ] },
        { type: "expandable", label: haListManagerHistoryCardText("ui.period_and_count", {}, hass), icon: "mdi:timeline-clock-outline", schema: [
          { name: "values_to_show", selector: { number: { min: 1, max: 20000, mode: "box" } } },
          { name: "hours_to_show", selector: { number: { min: 1, max: 87600, mode: "box", unit_of_measurement: "h" } } },
        ] },
        { type: "expandable", label: haListManagerHistoryCardText("ui.appearance", {}, hass), icon: "mdi:palette-outline", schema: [
          { name: "view", selector: { select: { mode: "dropdown", options: [
            { value: "chart", label: haListManagerHistoryCardText("ui.chart", {}, hass) },
            { value: "list", label: haListManagerHistoryCardText("history.chronological_list", {}, hass) },
          ] } }, default: "chart" },
          { name: "show_view_toggle", selector: { boolean: {} }, default: true },
          { name: "header_value", selector: { select: { mode: "dropdown", options: [
            { value: "none", label: haListManagerHistoryCardText("ui.hide", {}, hass) },
            { value: "entity_1", label: haListManagerHistoryCardText("ui.first_entity", {}, hass) },
            { value: "entity_2", label: haListManagerHistoryCardText("ui.second_entity", {}, hass) },
            { value: "entity_3", label: haListManagerHistoryCardText("history.third_entity", {}, hass) },
            { value: "entity_4", label: haListManagerHistoryCardText("history.fourth_entity", {}, hass) },
            { value: "entity_5", label: haListManagerHistoryCardText("ui.fifth_entity", {}, hass) },
          ] } }, default: "entity_1" },
          { name: "scale_decimals", selector: { number: { min: 0, max: 6, mode: "box" } }, default: 2 },
          { name: "value_fixed_decimals", selector: { boolean: {} }, default: false },
          { name: "axis_decimals", selector: { number: { min: 0, max: 6, mode: "box" } }, default: 2 },
          { name: "axis_fixed_decimals", selector: { boolean: {} }, default: false },
          { name: "list_rows_before_scroll", selector: { number: { min: 3, max: 100, mode: "box" } }, default: 8 },
          { name: "legend_collapsible", selector: { boolean: {} }, default: true },
          { name: "legend_initially_collapsed", selector: { boolean: {} }, default: true },
        ] },
        { type: "expandable", label: haListManagerHistoryCardText("ui.card_behavior", {}, hass), icon: "mdi:card-outline", schema: [
          { name: "collapsible", selector: { boolean: {} }, default: true },
          { name: "initially_collapsed", selector: { boolean: {} }, default: false },
        ] },
      ],
      computeLabel: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerHistoryCard.getConfigForm({ ...(hass || {}), localize }).computeLabel(schema);
        const baseName = String(schema.name || "").replace(/_[2-5]$/, "");
        return labels[schema.name] || labels[baseName] || schema.label || schema.name;
      },
      computeHelper: (schema, localize) => {
        if (typeof localize === "function") return HaListManagerHistoryCard.getConfigForm({ ...(hass || {}), localize }).computeHelper(schema);
        const baseName = String(schema.name || "").replace(/_[2-5]$/, "");
        return ({
        entity: haListManagerHistoryCardText("help.history_source_entity", {}, hass),
        series_name: haListManagerHistoryCardText("help.series_label", {}, hass),
        attribute: haListManagerHistoryCardText("help.history_numeric_attribute", {}, hass),
        min_value: haListManagerHistoryCardText("help.min_value", {}, hass),
        max_value: haListManagerHistoryCardText("help.max_value", {}, hass),
        values_to_show: haListManagerHistoryCardText("help.latest_matching_values", {}, hass),
        hours_to_show: haListManagerHistoryCardText("help.history_time_range_fallback", {}, hass),
        view: haListManagerHistoryCardText("help.history_initial_view", {}, hass),
        show_view_toggle: haListManagerHistoryCardText("help.history_view_buttons", {}, hass),
        header_value: haListManagerHistoryCardText("help.history_header_value_entity", {}, hass),
        scale_decimals: haListManagerHistoryCardText("help.history_decimal_places", {}, hass),
        value_fixed_decimals: haListManagerHistoryCardText("help.decimal_zero_padding", {}, hass),
        axis_decimals: haListManagerHistoryCardText("help.history_axis_decimals", {}, hass),
        axis_fixed_decimals: haListManagerHistoryCardText("help.history_axis_zero_padding", {}, hass),
        list_rows_before_scroll: haListManagerHistoryCardText("help.history_scroll_limit", {}, hass),
        collapsible: haListManagerHistoryCardText("help.card_collapse_control", {}, hass),
        initially_collapsed: haListManagerHistoryCardText("help.initial_browser_state", {}, hass),
        icon: haListManagerHistoryCardText("help.series_icon_override", {}, hass),
        icon_color: haListManagerHistoryCardText("help.series_color", {}, hass),
        connect_points: haListManagerHistoryCardText("help.connect_points", {}, hass),
        title: haListManagerHistoryCardText("help.entity_name_override", {}, hass),
        legend_collapsible: haListManagerHistoryCardText("help.legend_collapsible", {}, hass),
        legend_initially_collapsed: haListManagerHistoryCardText("help.legend_initially_collapsed", {}, hass),
        })[baseName] || "";
      },
    };
  }

  static getStubConfig(hass = null) {
    return { entity: "", hours_to_show: 168 };
  }

  setConfig(config) {
    if (!config?.entity) throw new Error(haListManagerHistoryCardText("ui.select_recorded_entity_required", {}, this._hass) || "component.ha_list_manager.config_panel.ui.select_recorded_entity_required");
    this._loadGeneration += 1;
    this._reloadPending = this._loading;
    this._config = {
      hours_to_show: 168, view: "chart", show_view_toggle: true,
      header_value: "entity_1", scale_decimals: 2, value_fixed_decimals: false,
      axis_decimals: 2, axis_fixed_decimals: false,
      list_rows_before_scroll: 8, collapsible: true, initially_collapsed: false,
      legend_collapsible: true, legend_initially_collapsed: true,
      ...config,
    };
    this._states = [];
    this._seriesData = [];
    this._truncated = false;
    this._error = "";
    this._lastSourceUpdate = "";
    this._collapsed = null;
    this._legendCollapsed = null;
    this._aggregateHelpOpen = false;
    this._activeView = null;
    this._scheduleLoad(0);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const translationsChanged = haListManagerHistoryCardTextUpdateTranslations(this, this._hass);
    const changed = this._seriesConfigs().map((series) => hass?.states?.[series.entity]?.last_updated || "").join("|");
    if (changed && changed !== this._lastSourceUpdate) {
      this._lastSourceUpdate = changed;
      this._scheduleLoad(300);
    }

    if (translationsChanged) this._render();
  }

  connectedCallback() {
    this._disconnected = false;
    this._scheduleLoad(0);
    this._refreshTimer = window.setInterval(() => this._load(), 60000);
  }

  disconnectedCallback() {
    this._disconnected = true;
    this._loadGeneration += 1;
    this._reloadPending = false;
    this._setExpandedView(false);
    clearTimeout(this._requestTimer);
    clearInterval(this._refreshTimer);
  }

  getCardSize() { return 4; }

  _findDashboardViewport() {
    const selector = "hui-view, hui-masonry-view, hui-sections-view, hui-panel-view";
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      if (node.parentElement) { node = node.parentElement; continue; }
      const root = node.getRootNode?.();
      node = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
    }
    return null;
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
    window.removeEventListener("resize", this._onExpandedViewResize);
    document.removeEventListener("transitionrun", this._onExpandedViewResize, true);
    document.removeEventListener("transitionend", this._onExpandedViewResize, true);
  }

  _setExpandedView(expanded) {
    const next = Boolean(expanded);
    if (next === this._expandedView) return;
    this._expandedView = next;
    if (next) {
      this._expandedViewWasCollapsed = this._isCollapsed();
      this.setAttribute("data-expanded-view", "");
      this._watchExpandedViewBounds();
      this._expandedPageOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._onExpandedViewKeydown, true);
      if (this._expandedViewWasCollapsed) this._render();
    } else {
      this._stopWatchingExpandedViewBounds();
      this.removeAttribute("data-expanded-view");
      this.style.removeProperty("--expanded-top");
      this.style.removeProperty("--expanded-left");
      this.style.removeProperty("--expanded-right");
      this.style.removeProperty("--expanded-bottom");
      document.removeEventListener("keydown", this._onExpandedViewKeydown, true);
      document.body.style.overflow = this._expandedPageOverflow || "";
      this._expandedPageOverflow = null;
      const restoreCollapsed = this._expandedViewWasCollapsed;
      this._expandedViewWasCollapsed = false;
      if (restoreCollapsed && this.isConnected) this._render();
    }
    this.shadowRoot?.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => {
      const label = next ? haListManagerHistoryCardText("ui.close_large_view", {}, this._hass) : haListManagerHistoryCardText("ui.open_large_view", {}, this._hass);
      element.setAttribute("aria-pressed", String(next));
      element.setAttribute("title", label);
      element.setAttribute("aria-label", label);
    });
  }

  _toggleExpandedView(event) {
    event?.preventDefault();
    event?.stopPropagation();
    this._setExpandedView(!this._expandedView);
  }

  _scheduleLoad(delay) {
    clearTimeout(this._requestTimer);
    this._requestTimer = window.setTimeout(() => this._load(), delay);
  }

  async _load() {
    if (!this._hass || !this._config.entity || this._disconnected) return;
    if (this._loading) { this._reloadPending = true; return; }
    this._loading = true;
    this._reloadPending = false;
    const generation = this._loadGeneration;
    let shouldRender = false;
    try {
      const valuesToShow = Math.max(0, Math.floor(Number(this._config.values_to_show) || 0));
      const hours = Math.max(1, Number(this._config.hours_to_show) || 168);
      const minValue = this._config.min_value === "" || this._config.min_value === undefined ? null : Number(this._config.min_value);
      const maxValue = this._config.max_value === "" || this._config.max_value === undefined ? null : Number(this._config.max_value);
      const seriesData = await Promise.all(this._seriesConfigs().map(async (series) => {
        try {
          const result = await haListManagerHistoryCardTextRequest(this._hass, {
            type: `${HA_LM_HISTORY_API}/entity_history/get`,
            entity_id: series.entity,
            ...(series.attribute ? { attribute: series.attribute } : {}),
            ...(Number.isFinite(minValue) ? { min_value: minValue } : {}),
            ...(Number.isFinite(maxValue) ? { max_value: maxValue } : {}),
            ...(valuesToShow ? { latest: true, limit: Math.min(valuesToShow, 20000) } : {
              start_time: new Date(Date.now() - hours * 3600000).toISOString(),
              latest: true,
              limit: 20000,
            }),
          });
          // More matching rows are expected when the user asks for the last N.
          // Only safety-scan exhaustion or our own row ceiling needs a warning.
          const technicalLimit = result.query_limited || ((!valuesToShow || valuesToShow > 20000) && result.truncated);
          return { ...series, states: result.states || [], truncated: Boolean(technicalLimit), error: "" };
        } catch (error) {
          return { ...series, states: [], truncated: false, error: error?.message || String(error) };
        }
      }));
      // A previous configuration must never overwrite the newly selected sources.
      if (generation !== this._loadGeneration) return;
      const nextTruncated = seriesData.some((series) => series.truncated);
      const nextError = seriesData.filter((series) => series.error).map((series) => `${series.name}: ${series.error}`).join(" · ");
      shouldRender = !this._sameSeriesData(this._seriesData, seriesData)
        || this._truncated !== nextTruncated
        || this._error !== nextError;
      this._seriesData = seriesData;
      this._states = seriesData[0]?.states || [];
      this._truncated = nextTruncated;
      this._error = nextError;
    } catch (error) {
      if (generation !== this._loadGeneration) return;
      const nextError = error?.message || String(error);
      shouldRender = this._error !== nextError;
      this._error = nextError;
    } finally {
      this._loading = false;
      if (shouldRender) this._render();
      if (this._reloadPending && !this._disconnected) this._scheduleLoad(0);
    }
  }

  _color(value, fallback) {
    if (Array.isArray(value) && value.length === 3) {
      return `rgb(${value.map((part) => Math.max(0, Math.min(255, Number(part) || 0))).join(",")})`;
    }
    return typeof value === "string" && value ? value : fallback;
  }

  _sameSeriesData(previous, next) {
    if (previous.length !== next.length) return false;
    return previous.every((series, seriesIndex) => {
      const candidate = next[seriesIndex];
      if (!candidate || ["entity", "attribute", "name", "icon", "color", "unit", "connectPoints", "truncated", "error"]
        .some((key) => series[key] !== candidate[key]) || series.states.length !== candidate.states.length) return false;
      return series.states.every((record, recordIndex) => {
        const nextRecord = candidate.states[recordIndex];
        return nextRecord && JSON.stringify(record) === JSON.stringify(nextRecord);
      });
    });
  }

  _seriesConfigs() {
    const defaults = ["var(--primary-color)", "#ff9800", "#8e24aa", "#43a047", "#e53935"];
    return [1, 2, 3, 4, 5].map((index) => {
      const suffix = index === 1 ? "" : `_${index}`;
      const entity = String(this._config[`entity${suffix}`] || "").trim();
      if (!entity) return null;
      const state = this._hass?.states?.[entity];
      const attribute = String(this._config[`attribute${suffix}`] || "").trim();
      return {
        index,
        entity,
        attribute,
        name: this._config[`series_name${suffix}`] || state?.attributes?.friendly_name || entity,
        icon: this._config[`icon${suffix}`] || state?.attributes?.icon || "mdi:chart-timeline-variant",
        color: this._color(this._config[`icon_color${suffix}`], defaults[index - 1]),
        connectPoints: this._config[`connect_points${suffix}`] !== false,
        unit: attribute ? "" : (state?.attributes?.unit_of_measurement || ""),
      };
    }).filter(Boolean);
  }

  _value(record, series = this._seriesConfigs()[0]) {
    const path = String(series?.attribute || "").trim();
    if (!path) return record.state;
    return path.split(".").reduce((value, part) => value?.[part], record.attributes);
  }

  _collapseKey() {
    const sources = this._seriesConfigs().map((series) => `${series.entity}:${series.attribute}`).join("|");
    return `ha-list-manager-history-collapsed:${sources}:${this._config.title || ""}`;
  }

  _isCollapsed() {
    if (this._config.collapsible === false) return false;
    if (this._collapsed !== null) return this._collapsed;
    try {
      const stored = localStorage.getItem(this._collapseKey());
      if (stored !== null) return (this._collapsed = stored === "1");
    } catch (_error) { /* Storage may be disabled. */ }
    return (this._collapsed = Boolean(this._config.initially_collapsed));
  }

  _toggleCollapsed() {
    if (this._config.collapsible === false) return;
    this._collapsed = !this._isCollapsed();
    try { localStorage.setItem(this._collapseKey(), this._collapsed ? "1" : "0"); } catch (_error) { /* Storage may be disabled. */ }
    this._render();
  }

  _currentView() {
    return this._activeView || (this._config.view === "list" ? "list" : "chart");
  }

  _isLegendCollapsed() {
    if (this._config.legend_collapsible === false) return false;
    if (this._legendCollapsed !== null) return this._legendCollapsed;
    try {
      const stored = localStorage.getItem(`${this._collapseKey()}:legend`);
      if (stored !== null) return (this._legendCollapsed = stored === "1");
    } catch (_error) { /* Storage may be disabled. */ }
    return (this._legendCollapsed = this._config.legend_initially_collapsed !== false);
  }

  _toggleLegend() {
    if (this._config.legend_collapsible === false) return;
    this._legendCollapsed = !this._isLegendCollapsed();
    try { localStorage.setItem(`${this._collapseKey()}:legend`, this._legendCollapsed ? "1" : "0"); } catch (_error) { /* Storage may be disabled. */ }
    // Preserve the chart, focused button and list scroll position while folding.
    const content = this.shadowRoot.querySelector("[data-legend-content]");
    if (content) content.hidden = this._legendCollapsed;
    this.shadowRoot.querySelector("[data-toggle-legend]")?.setAttribute("aria-expanded", String(!this._legendCollapsed));
    this.shadowRoot.querySelector("[data-legend-chevron]")?.setAttribute("icon", `mdi:chevron-${this._legendCollapsed ? "down" : "up"}`);
  }

  _niceScale(dataMin, dataMax, decimals) {
    const quantum = 10 ** -decimals;
    let min = dataMin;
    let max = dataMax;
    if (min === max) {
      const padding = Math.max(quantum, Math.abs(min) * 0.01 || 1);
      min -= padding;
      max += padding;
    }
    const roughStep = (max - min) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, quantum)));
    const fraction = roughStep / magnitude;
    const niceFraction = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= fraction) || 10;
    const step = Math.max(quantum, niceFraction * magnitude);
    const axisMin = Math.floor((min + step * 1e-10) / step) * step;
    const axisMax = Math.ceil((max - step * 1e-10) / step) * step;
    const ticks = [];
    const intervals = Math.max(1, Math.round((axisMax - axisMin) / step));
    for (let index = intervals; index >= 0; index -= 1) {
      ticks.push(Number((axisMin + index * step).toFixed(12)));
    }
    return { min: axisMin, max: axisMax, ticks };
  }

  _chartData(seriesData) {
    return seriesData.map((series) => ({
      ...series,
      points: series.states.map((record) => ({
        time: new Date(record.last_updated).getTime(),
        raw: this._value(record, series),
        record,
      })).filter((point) => Number.isFinite(point.time) && point.raw !== undefined),
    })).filter((series) => series.points.length);
  }

  _renderChart(seriesData) {
    const plotted = this._chartData(seriesData);
    if (!plotted.length) return `<div class="empty">${haListManagerHistoryCardText("history.no_saved_selection", {}, this._hass)}</div>`;
    const allNumeric = plotted.every((series) => series.points.every((point) => point.raw !== "" && Number.isFinite(Number(point.raw))));
    if (!allNumeric && plotted.length > 1) return `<div class="empty">${haListManagerHistoryCardText("help.numeric_series_requirement", {}, this._hass)}</div>`;
    if (!allNumeric) {
      const points = plotted[0].points;
      const values = points.map((point) => String(point.raw));
      const categories = [...new Set(values)].slice(-8);
      if (new Set(values).size > 8) return this._renderChanges(points);
      return this._renderCategoricalChart(points, categories, plotted[0].color, plotted[0].connectPoints);
    }

    const width = 760, height = 300, left = 112, right = 24, top = 26, bottom = 64;
    const allPoints = plotted.flatMap((series) => series.points);
    const start = Math.min(...allPoints.map((point) => point.time));
    const end = Math.max(...allPoints.map((point) => point.time));
    const span = Math.max(1, end - start);
    const references = this._referenceLines();
    const values = [...allPoints.map((point) => Number(point.raw)), ...references.map((line) => line.value)];
    const axisDecimals = Math.max(0, Math.min(6, Math.floor(Number(this._config.axis_decimals) || 0)));
    const scale = this._niceScale(Math.min(...values), Math.max(...values), axisDecimals);
    const x = (time) => end === start ? (left + width - right) / 2 : left + ((time - start) / span) * (width - left - right);
    const y = (value) => top + (1 - ((Number(value) - scale.min) / Math.max(Number.EPSILON, scale.max - scale.min))) * (height - top - bottom);
    const locale = haListManagerHistoryCardTextLocale(this._hass);
    const date = (time) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(time));
    const paths = plotted.map((series) => {
      const coords = series.points.map((point) => [x(point.time), y(point.raw)]);
      const path = coords.map(([nextX, nextY], index) => `${index ? "L" : "M"} ${nextX.toFixed(2)} ${nextY.toFixed(2)}`).join(" ");
      const line = series.connectPoints !== false && coords.length > 1 ? `<path d="${path}" class="line" style="stroke:${esc(series.color)}"></path>` : "";
      return line + series.points.map((point, index) => this._renderSampleMarker(coords[index], point.record, series.color, `${this._formatValue(point.raw)} · ${date(point.time)}`)).join("");
    }).join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${haListManagerHistoryCardText("ui.saved_history", {}, this._hass)}">
      ${scale.ticks.map((label) => `<line x1="${left}" y1="${y(label)}" x2="${width - right}" y2="${y(label)}" class="grid"></line><text x="${left - 16}" y="${y(label) + 7}" text-anchor="end">${esc(this._formatAxisValue(label))}</text>`).join("")}
      ${paths}
      ${references.map((line) => `<line x1="${left}" y1="${y(line.value)}" x2="${width - right}" y2="${y(line.value)}" class="reference-line" style="stroke:${esc(line.color)}"><title>${esc(line.label)}: ${esc(this._formatValue(line.value))}</title></line>`).join("")}
      <text x="${left}" y="${height - 10}">${esc(date(start))}</text>
      <text x="${width - right}" y="${height - 10}" text-anchor="end">${esc(date(end))}</text>
    </svg>`;
  }

  _referenceLines() {
    return (Array.isArray(this._config.reference_lines) ? this._config.reference_lines : []).slice(0, 10)
      .filter((line) => line && line.value !== "" && line.value != null && Number.isFinite(Number(line.value)))
      .map((line) => ({ value: Number(line.value), label: String(line.label || haListManagerHistoryCardText("history.reference", {}, this._hass)), color: this._color(line.color, "#ff9800") }));
  }

  _isAggregate(record) {
    return (record?.original_source || record?.source) === "long_term_statistics";
  }

  _sourceLabel(record) {
    const source = record?.original_source || record?.source;
    const label = this._isAggregate(record) ? haListManagerHistoryCardText("history.hourly", {}, this._hass)
      : source === "manual" ? haListManagerHistoryCardText("history.manual", {}, this._hass)
      : source === "recorder" ? haListManagerHistoryCardText("history.recorder", {}, this._hass) : haListManagerHistoryCardText("history.live", {}, this._hass);
    return record?.source === "corrected" ? `${label} · ${haListManagerHistoryCardText("history.corrected", {}, this._hass)}` : label;
  }

  _renderSampleMarker([x, y], record, color, label) {
    const title = `<title>${esc(label)} · ${esc(this._sourceLabel(record))}</title>`;
    if (this._isAggregate(record)) return `<circle cx="${x}" cy="${y}" r="5" class="hourly-point" style="stroke:${esc(color)}">${title}</circle>`;
    if (["manual", "corrected"].includes(record?.source)) return `<path d="M ${x} ${y - 6} L ${x + 6} ${y} L ${x} ${y + 6} L ${x - 6} ${y} Z" class="manual-point" style="fill:${esc(color)}">${title}</path>`;
    return `<circle cx="${x}" cy="${y}" r="5" fill="${esc(color)}">${title}</circle>`;
  }

  _toggleAggregateHelp() {
    this._aggregateHelpOpen = !this._aggregateHelpOpen;
    const explanation = this.shadowRoot.querySelector("[data-aggregate-explanation]");
    if (explanation) explanation.hidden = !this._aggregateHelpOpen;
    this.shadowRoot.querySelector("[data-aggregate-help]")?.setAttribute("aria-expanded", String(this._aggregateHelpOpen));
  }

  _renderSourceLegend(seriesData) {
    const records = seriesData.flatMap((series) => series.states);
    const hourly = records.some((record) => this._isAggregate(record));
    const manual = records.some((record) => !this._isAggregate(record) && ["manual", "corrected"].includes(record.source));
    const exact = records.some((record) => !this._isAggregate(record) && !["manual", "corrected"].includes(record.source));
    if (!records.length) return "";
    return `<div class="source-legend">${exact ? `<span><svg class="legend-symbol" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor"></circle></svg>${haListManagerHistoryCardText("history.measurement_point", {}, this._hass)}</span>` : ""}${hourly ? `<span class="aggregate-entry"><svg class="legend-symbol" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"></circle></svg>${haListManagerHistoryCardText("history.hourly", {}, this._hass)}<button type="button" class="aggregate-info" data-aggregate-help aria-label="${haListManagerHistoryCardText("history.aggregate_help_label", {}, this._hass)}" aria-expanded="${this._aggregateHelpOpen}" aria-controls="history-aggregate-explanation"><ha-icon icon="mdi:information-outline" aria-hidden="true"></ha-icon></button></span>` : ""}${manual ? `<span><svg class="legend-symbol" viewBox="0 0 16 16" aria-hidden="true"><path d="M 8 2 L 14 8 L 8 14 L 2 8 Z" fill="currentColor"></path></svg>${haListManagerHistoryCardText("history.manual_corrected", {}, this._hass)}</span>` : ""}</div>${hourly ? `<p id="history-aggregate-explanation" class="aggregate-explanation" data-aggregate-explanation ${this._aggregateHelpOpen ? "" : "hidden"}>${haListManagerHistoryCardText("history.imported_value_help", {}, this._hass)}</p>` : ""}`;
  }

  _renderLegend(seriesData, view, seriesLegend) {
    const plotted = view === "chart" ? this._chartData(seriesData) : [];
    const numeric = plotted.length && plotted.every((series) => series.points.every((point) => point.raw !== "" && Number.isFinite(Number(point.raw))));
    const references = numeric ? this._referenceLines() : [];
    const referenceLegend = references.length ? `<div class="reference-legend">${references.map((line) => `<span><i style="border-color:${esc(line.color)}"></i>${esc(line.label)}: ${esc(this._formatValue(line.value))}</span>`).join("")}</div>` : "";
    const categoricalChart = plotted.length === 1 && new Set(plotted[0].points.map((point) => String(point.raw))).size <= 8;
    const sourceLegend = numeric || categoricalChart ? this._renderSourceLegend(seriesData) : "";
    const content = referenceLegend + sourceLegend + seriesLegend;
    if (!content) return "";
    const collapsed = this._isLegendCollapsed();
    const toggle = this._config.legend_collapsible !== false ? `<button type="button" class="legend-toggle" data-toggle-legend aria-expanded="${!collapsed}" aria-controls="history-legend-content"><span>${haListManagerHistoryCardText("ui.legend", {}, this._hass)}</span><ha-icon data-legend-chevron icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>` : "";
    return `<section class="history-legend">${toggle}<div id="history-legend-content" data-legend-content ${collapsed ? "hidden" : ""}>${content}</div></section>`;
  }

  _renderCategoricalChart(points, categories, color, connectPoints = true) {
    const width = 760, height = 300, left = 112, right = 24, top = 26, bottom = 64;
    const start = points[0].time;
    const end = points[points.length - 1].time;
    const span = Math.max(1, end - start);
    const x = (time) => end === start ? (left + width - right) / 2 : left + ((time - start) / span) * (width - left - right);
    const y = (value) => top + (1 - (categories.indexOf(String(value)) / Math.max(1, categories.length - 1))) * (height - top - bottom);
    const coords = points.map((point) => [x(point.time), y(point.raw)]);
    let path = `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`;
    coords.slice(1).forEach(([nextX, nextY]) => { path += ` H ${nextX.toFixed(2)} V ${nextY.toFixed(2)}`; });
    const locale = haListManagerHistoryCardTextLocale(this._hass);
    const date = (time) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(time));
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${haListManagerHistoryCardText("ui.saved_history", {}, this._hass)}">
      ${categories.map((label) => `<line x1="${left}" y1="${y(label)}" x2="${width - right}" y2="${y(label)}" class="grid"></line><text x="${left - 16}" y="${y(label) + 7}" text-anchor="end">${esc(label)}</text>`).join("")}
      ${connectPoints && coords.length > 1 ? `<path d="${path}" class="line" style="stroke:${esc(color)}"></path>` : ""}
      ${points.map((point, index) => this._renderSampleMarker(coords[index], point.record, color, `${point.raw} · ${date(point.time)}`)).join("")}
      <text x="${left}" y="${height - 10}">${esc(date(start))}</text>
      <text x="${width - right}" y="${height - 10}" text-anchor="end">${esc(date(end))}</text>
    </svg>`;
  }

  _renderChanges(points) {
    const locale = haListManagerHistoryCardTextLocale(this._hass);
    const latest = points.slice(-30).reverse();
    return `<div class="changes">${latest.map((point) => `<div><time>${esc(new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(point.time)))}</time><strong>${esc(typeof point.raw === "object" ? JSON.stringify(point.raw) : point.raw)}</strong></div>`).join("")}</div>`;
  }

  _formatNumber(value, decimals, fixed) {
    const numeric = typeof value === "number" ? value : (typeof value === "string" && /^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim()) ? Number(value.replace(",", ".")) : NaN);
    if (!Number.isFinite(numeric)) {
      return typeof value === "object" ? JSON.stringify(value) : value;
    }
    const digits = Math.max(0, Math.min(6, Math.floor(Number(decimals) || 0)));
    return numeric.toLocaleString(haListManagerHistoryCardTextLocale(this._hass), {
      maximumFractionDigits: digits,
      minimumFractionDigits: fixed ? digits : 0,
    });
  }

  _formatValue(value) {
    return this._formatNumber(value, this._config.scale_decimals, this._config.value_fixed_decimals === true);
  }

  _formatAxisValue(value) {
    return this._formatNumber(value, this._config.axis_decimals, this._config.axis_fixed_decimals === true);
  }

  _renderList(seriesData) {
    const locale = haListManagerHistoryCardTextLocale(this._hass);
    const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "long" });
    const timeFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
    const entries = seriesData.flatMap((series) => series.states.map((record) => ({ series, record })))
      .sort((left, right) => new Date(right.record.last_updated).getTime() - new Date(left.record.last_updated).getTime());
    const groups = new Map();
    entries.forEach(({ series, record }) => {
      const date = new Date(record.last_updated);
      if (Number.isNaN(date.getTime())) return;
      const key = dateFormatter.format(date);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ series, record });
    });
    if (!groups.size) return `<div class="empty">${haListManagerHistoryCardText("history.no_saved_selection", {}, this._hass)}</div>`;
    const rowsBeforeScroll = Math.max(3, Math.min(100, Math.floor(Number(this._config.list_rows_before_scroll) || 8)));
    const scrollable = entries.length > rowsBeforeScroll;
    const maxHeight = rowsBeforeScroll * 80 + 58;
    return `<div class="history-list ${scrollable ? "scrollable" : ""}" ${scrollable ? `style="--history-list-max-height:${maxHeight}px"` : ""}>${[...groups.entries()].map(([date, rows]) => `<section><h3>${esc(date)}</h3>${rows.map(({ series, record }) => {
      const value = this._value(record, series);
      const display = this._formatValue(value);
      return `<div class="history-row"><ha-icon icon="${esc(series.icon)}" style="color:${esc(series.color)}"></ha-icon><div><strong>${esc(display)}${series.unit ? ` ${esc(series.unit)}` : ""}</strong><small>${esc(series.name)} · ${esc(timeFormatter.format(new Date(record.last_updated)))}</small></div><span class="source-badge">${esc(this._sourceLabel(record))}</span></div>`;
    }).join("")}</section>`).join("")}</div>`;
  }

  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    if (!this.shadowRoot) return;
    const previousList = this.shadowRoot.querySelector?.(".history-list.scrollable");
    const previousScrollTop = previousList?.scrollTop;
    const seriesData = this._seriesData.length ? this._seriesData : this._seriesConfigs().map((series) => ({ ...series, states: [], truncated: false, error: "" }));
    const primarySeries = seriesData[0] || this._seriesConfigs()[0];
    const entity = this._hass?.states?.[primarySeries?.entity];
    const title = this._config.title || entity?.attributes?.friendly_name || this._config.entity || haListManagerHistoryCardText("ui.entity_inventory", {}, this._hass);
    const headerSelection = this._config.header_value === "primary" ? "entity_1" : (this._config.header_value || "entity_1");
    const headerIndex = headerSelection === "none" ? null : Number(String(headerSelection).replace("entity_", ""));
    const headerSeries = Number.isFinite(headerIndex) ? seriesData.find((series) => series.index === headerIndex) : null;
    const latestRecord = headerSeries?.states?.[headerSeries.states.length - 1];
    const latest = latestRecord ? this._value(latestRecord, headerSeries) : undefined;
    const valuesToShow = Math.max(0, Math.floor(Number(this._config.values_to_show) || 0));
    const collapsed = !this._expandedView && this._isCollapsed();
    const collapsible = this._config.collapsible !== false;
    const view = this._currentView();
    const content = view === "list" ? this._renderList(seriesData) : this._renderChart(seriesData);
    const showViewToggle = this._config.show_view_toggle !== false;
    const iconColor = primarySeries?.color || "var(--primary-color)";
    const icon = primarySeries?.icon || "mdi:chart-timeline-variant";
    const minValue = this._config.min_value === "" || this._config.min_value === undefined ? null : Number(this._config.min_value);
    const maxValue = this._config.max_value === "" || this._config.max_value === undefined ? null : Number(this._config.max_value);
    const totalPoints = seriesData.reduce((total, series) => total + series.states.length, 0);
    const summaryParts = [
      totalPoints === 1 ? haListManagerHistoryCardText("history.one_point", {}, this._hass) : haListManagerHistoryCardText("ui.point_count", {p0:(totalPoints.toLocaleString(haListManagerHistoryCardTextLocale(this._hass)))}, this._hass),
      ...(seriesData.length > 1 ? [haListManagerHistoryCardText("history.entity_count", {p0:(seriesData.length)}, this._hass)] : []),
      valuesToShow
        ? seriesData.length > 1
          ? (valuesToShow === 1 ? haListManagerHistoryCardText("history.values_per_entity_one", {count: valuesToShow.toLocaleString(haListManagerHistoryCardTextLocale(this._hass))}, this._hass) : haListManagerHistoryCardText("history.values_per_entity_many", {count: valuesToShow.toLocaleString(haListManagerHistoryCardTextLocale(this._hass))}, this._hass))
          : valuesToShow === 1 ? haListManagerHistoryCardText("history.one_value", {}, this._hass) : haListManagerHistoryCardText("history.value_count", {count: valuesToShow.toLocaleString(haListManagerHistoryCardTextLocale(this._hass))}, this._hass)
        : `${Number(this._config.hours_to_show || 168).toLocaleString(haListManagerHistoryCardTextLocale(this._hass))} h`,
      ...(Number.isFinite(minValue) && Number.isFinite(maxValue)
        ? [`${minValue.toLocaleString(haListManagerHistoryCardTextLocale(this._hass))}–${maxValue.toLocaleString(haListManagerHistoryCardTextLocale(this._hass))}`]
        : Number.isFinite(minValue)
          ? [haListManagerHistoryCardText("history.minimum_value", {value: minValue.toLocaleString(haListManagerHistoryCardTextLocale(this._hass))}, this._hass)]
          : Number.isFinite(maxValue)
            ? [haListManagerHistoryCardText("ui.until_value", {p0:(maxValue.toLocaleString(haListManagerHistoryCardTextLocale(this._hass)))}, this._hass)]
            : []),
    ];
    const units = [...new Set(seriesData.map((series) => series.unit).filter(Boolean))];
    const unitWarning = seriesData.length > 1 && units.length > 1 ? haListManagerHistoryCardText("ui.shared_scale_different_units", {}, this._hass) : "";
    const seriesLegend = seriesData.length > 1 ? `<div class="series-legend">${seriesData.map((series) => {
      const record = series.states[series.states.length - 1];
      const value = record ? this._value(record, series) : undefined;
      return `<div><ha-icon icon="${esc(series.icon)}" style="color:${esc(series.color)}"></ha-icon><span>${esc(series.name)}</span><strong>${value === undefined ? "–" : esc(this._formatValue(value))}${series.unit ? ` ${esc(series.unit)}` : ""}</strong></div>`;
    }).join("")}</div>` : "";
    const legend = this._renderLegend(seriesData, view, seriesLegend);
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;--history-icon-color:${iconColor}}:host([data-expanded-view]){position:fixed!important;top:var(--expanded-top,56px)!important;right:var(--expanded-right,0)!important;bottom:var(--expanded-bottom,0)!important;left:var(--expanded-left,0)!important;z-index:9998;min-width:0!important;max-width:none!important;padding:16px;overflow:hidden;background:var(--primary-background-color,#111)}:host([data-expanded-view]) ha-card{height:100%;min-height:0;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,.45)}:host([data-expanded-view]) svg[role="img"]{height:clamp(360px,65vh,720px);max-height:none}:host([data-expanded-view]) .history-list.scrollable{max-height:calc(100vh - 240px)}ha-card{padding:18px;color:var(--primary-text-color)}ha-card.collapsed{height:76px;padding:8px 14px}.history-header{display:flex;align-items:center;gap:8px;width:calc(100% + 8px);margin:-4.5px -4px 18.5px;color:var(--primary-text-color)}.collapsed .history-header{width:100%;height:auto;margin:5.5px 0 0}.entity-icon{display:grid;flex:0 0 auto;place-items:center;width:40px;height:40px;padding:5px;border:0;border-radius:50%;--mdc-icon-size:30px;color:var(--history-icon-color);background:transparent;cursor:pointer}.entity-icon:hover,.entity-icon:focus-visible{outline:0;background:color-mix(in srgb,var(--primary-text-color) 10%,transparent)}.history-title{display:flex;min-width:0;flex:1;flex-direction:column;padding:5px 4px;border:0;color:inherit;background:transparent;text-align:left}.history-title.clickable{cursor:pointer}.history-title.clickable:hover{background:color-mix(in srgb,var(--primary-text-color) 5%,transparent)}h2,p{margin:0}h2{overflow:hidden;font-size:21px;text-overflow:ellipsis;white-space:nowrap}.history-header small,.meta,.empty{color:var(--secondary-text-color)}.current{flex:0 0 auto;font-size:22px;font-weight:500}.current small{font-size:13px;font-weight:400}.header-action{display:grid;flex:0 0 auto;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;color:var(--secondary-text-color);background:transparent;cursor:pointer}.header-action:hover{background:color-mix(in srgb,var(--primary-text-color) 8%,transparent)}.header-action ha-icon{--mdc-icon-size:23px}.view-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}.history-legend{margin-top:8px}.legend-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:32px;padding:4px 0;border:0;color:var(--secondary-text-color);background:transparent;font:inherit;font-size:13px;text-align:left;cursor:pointer}.legend-toggle:focus-visible{outline:2px solid var(--primary-color);outline-offset:3px}.legend-toggle ha-icon{--mdc-icon-size:20px}[data-legend-content][hidden]{display:none}.source-legend .legend-symbol{display:block;flex:0 0 16px;width:16px;height:16px;max-height:16px;overflow:visible}.source-legend{align-items:center}.source-legend .aggregate-entry{white-space:nowrap;flex-wrap:nowrap}.aggregate-info{display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;height:32px;padding:0;border:0;border-radius:50%;color:inherit;background:transparent;cursor:pointer}.aggregate-info:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}.aggregate-info ha-icon{--mdc-icon-size:18px}.aggregate-explanation{margin:4px 0 10px;color:var(--secondary-text-color);font-size:12px;line-height:1.45}[data-aggregate-explanation][hidden]{display:none}.series-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin:2px 0 6px}.series-legend>div{display:grid;grid-template-columns:20px auto auto;align-items:center;gap:4px;min-width:0;font-size:12px}.series-legend ha-icon{--mdc-icon-size:17px}.series-legend span{overflow:hidden;color:var(--secondary-text-color);text-overflow:ellipsis;white-space:nowrap}.series-legend strong{font-weight:500}.meta{flex:1;font-size:12px;line-height:1.35}.view-switch{display:inline-flex;flex:0 0 auto;gap:3px;padding:3px;border:1px solid var(--divider-color);border-radius:17px;background:var(--secondary-background-color)}.view-switch button{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:14px;color:var(--secondary-text-color);background:transparent;cursor:pointer}.view-switch button.active{color:#fff;background:var(--primary-color)}.view-switch ha-icon{--mdc-icon-size:18px}svg{display:block;width:100%;height:auto;max-height:320px;overflow:visible}svg text{fill:var(--secondary-text-color);font:24px sans-serif}.grid{stroke:var(--divider-color);stroke-width:1.5}.line{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round}.hourly-point{fill:var(--ha-card-background,var(--card-background-color,#1c1c1c));stroke-width:3}.manual-point{stroke:var(--ha-card-background,var(--card-background-color,#1c1c1c));stroke-width:1.5}.reference-line{stroke-width:2;stroke-dasharray:3 7}.reference-legend,.source-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0;color:var(--secondary-text-color);font-size:12px}.reference-legend span,.source-legend span{display:inline-flex;align-items:center;gap:5px;overflow-wrap:anywhere}.reference-legend i{width:22px;border-top:2px solid currentColor;flex-shrink:0}.reference-legend i{border-top-style:dotted}.source-badge{max-width:110px;overflow-wrap:anywhere}.empty{display:grid;min-height:150px;place-items:center;text-align:center}.error{margin-bottom:8px;padding:12px;border-left:4px solid var(--error-color);color:var(--error-color);background:color-mix(in srgb,var(--error-color) 10%,transparent)}.changes{max-height:300px;overflow:auto}.changes>div{display:grid;grid-template-columns:minmax(120px,auto) minmax(0,1fr);gap:14px;padding:9px 2px;border-bottom:1px solid var(--divider-color)}.changes time{color:var(--secondary-text-color)}.changes strong{overflow-wrap:anywhere}.history-limit-notice{display:flex;gap:6px;align-items:center;margin-bottom:8px;color:var(--secondary-text-color);font-size:12px}.history-limit-notice ha-icon{--mdc-icon-size:18px}.history-limit-notice ha-icon{flex-shrink:0;color:var(--warning-color,#f0a000)}.unit-warning{color:var(--warning-color,#f0a000)}.history-list.scrollable{max-height:var(--history-list-max-height);padding-right:5px;overflow-y:auto;overscroll-behavior:contain}.history-list section+section{margin-top:18px}.history-list h3{position:sticky;top:0;z-index:1;margin:0;padding:10px 4px;border-bottom:1px solid var(--divider-color);background:var(--ha-card-background,var(--card-background-color));font-size:17px}.history-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:64px;padding:8px 4px;border-bottom:1px dashed var(--divider-color)}.history-row>ha-icon{color:var(--history-icon-color)}.history-row>div{display:flex;min-width:0;flex-direction:column;gap:3px}.history-row strong{overflow-wrap:anywhere;font-weight:500}.history-row small{color:var(--secondary-text-color)}.source-badge{padding:3px 7px;border-radius:12px;color:var(--secondary-text-color);background:var(--secondary-background-color);font-size:11px}
    </style><ha-card class="${collapsed ? "collapsed" : ""}"><div class="history-header"><button type="button" class="entity-icon" data-toggle-expanded-view aria-pressed="${this._expandedView}" title="${this._expandedView ? haListManagerHistoryCardText("ui.close_large_view", {}, this._hass) : haListManagerHistoryCardText("ui.open_large_view", {}, this._hass)}" aria-label="${this._expandedView ? haListManagerHistoryCardText("ui.close_large_view", {}, this._hass) : haListManagerHistoryCardText("ui.open_large_view", {}, this._hass)}"><ha-icon icon="${esc(icon)}"></ha-icon></button><button type="button" class="history-title ${collapsible ? "clickable" : ""}" ${collapsible ? "data-toggle-history" : ""} aria-expanded="${collapsed ? "false" : "true"}"><h2>${esc(title)}</h2>${seriesData.length > 1 ? `<small>${haListManagerHistoryCardText("history.entity_count", {p0:(seriesData.length)}, this._hass)}</small>` : ""}</button>${latest !== undefined && headerSeries ? `<span class="current">${esc(this._formatValue(latest))}${headerSeries.unit ? ` <small>${esc(headerSeries.unit)}</small>` : ""}</span>` : ""}${collapsible ? `<button type="button" class="header-action" data-toggle-history title="${collapsed ? haListManagerHistoryCardText("ui.expand_card", {}, this._hass) : haListManagerHistoryCardText("ui.collapse_card", {}, this._hass)}" aria-label="${collapsed ? haListManagerHistoryCardText("ui.expand_card", {}, this._hass) : haListManagerHistoryCardText("ui.collapse_card", {}, this._hass)}"><ha-icon icon="mdi:chevron-${collapsed ? "down" : "up"}"></ha-icon></button>` : ""}</div>
      ${collapsed ? "" : `${this._error ? `<div class="error">${esc(this._error)}</div>` : ""}${this._truncated ? `<div class="history-limit-notice" role="status"><ha-icon icon="mdi:information-outline"></ha-icon>${haListManagerHistoryCardText("history.query_limit_reached", {}, this._hass)}</div>` : ""}<div class="view-toolbar"><div class="meta">${esc(summaryParts.join(" · "))}${unitWarning ? ` · <span class="unit-warning">${esc(unitWarning)}</span>` : ""}</div>${showViewToggle ? `<div class="view-switch" aria-label="${haListManagerHistoryCardText("ui.appearance", {}, this._hass)}"><button type="button" class="${view === "chart" ? "active" : ""}" data-set-view="chart" title="${haListManagerHistoryCardText("ui.chart", {}, this._hass)}" aria-label="${haListManagerHistoryCardText("ui.chart", {}, this._hass)}"><ha-icon icon="mdi:chart-line"></ha-icon></button><button type="button" class="${view === "list" ? "active" : ""}" data-set-view="list" title="${haListManagerHistoryCardText("ui.list", {}, this._hass)}" aria-label="${haListManagerHistoryCardText("ui.list", {}, this._hass)}"><ha-icon icon="mdi:format-list-bulleted"></ha-icon></button></div>` : ""}</div>${content}${legend}`}
    </ha-card>`;
    this.shadowRoot.querySelectorAll("[data-toggle-expanded-view]").forEach((element) => element.addEventListener("click", (event) => this._toggleExpandedView(event)));
    this.shadowRoot.querySelectorAll("[data-toggle-history]").forEach((element) => element.addEventListener("click", () => this._toggleCollapsed()));
    this.shadowRoot.querySelector("[data-toggle-legend]")?.addEventListener("click", () => this._toggleLegend());
    this.shadowRoot.querySelector("[data-aggregate-help]")?.addEventListener("click", () => this._toggleAggregateHelp());
    this.shadowRoot.querySelectorAll("[data-set-view]").forEach((button) => button.addEventListener("click", () => {
      this._activeView = button.dataset.setView;
      this._render();
    }));
    if (Number.isFinite(previousScrollTop)) {
      const currentList = this.shadowRoot.querySelector(".history-list.scrollable");
      if (currentList) currentList.scrollTop = previousScrollTop;
    }
  }
}

class HaListManagerHistoryCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); this._config = null; this._hass = null; this._form = null; }
  set hass(value) {
    this._hass = value;
    haListManagerHistoryCardTextUpdateTranslations(this, value);
    this._render();
  }
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }
  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._remainingForm = document.createElement("ha-form");
      [this._form, this._remainingForm].forEach((form) => form.addEventListener("value-changed", (event) => {
        this._config = { ...this._config, ...event.detail.value };
        this._notifyConfig();
      }));
      this.shadowRoot.append(this._form);
      this._references = document.createElement("ha-expansion-panel");
      this._references.setAttribute("outlined", "");
      this._references.className = "references";
      this._references.innerHTML = `<ha-icon slot="leading-icon" icon="mdi:chart-line-variant"></ha-icon><div slot="header" role="heading" aria-level="3" data-reference-heading>${haListManagerHistoryCardText("history.references", {}, this._hass)}</div><div class="reference-content"><p data-reference-help>${haListManagerHistoryCardText("history.references_help", {}, this._hass)}</p><div data-reference-rows></div><ha-button appearance="outlined" data-add-reference><ha-icon slot="start" icon="mdi:plus"></ha-icon><span data-add-reference-label>${haListManagerHistoryCardText("history.add_reference", {}, this._hass)}</span></ha-button></div>`;
      const style = document.createElement("style");
      style.textContent = ":host{display:block}.references{display:block;margin:24px 0;--expansion-panel-content-padding:0;border-radius:var(--ha-border-radius-md,12px);--ha-card-border-radius:var(--ha-border-radius-md,12px)}.references [slot=header]{font-weight:500}.references>ha-icon{color:var(--secondary-text-color)}.reference-content{padding:12px}.reference-content p{margin:0 0 24px;color:var(--secondary-text-color);font-size:14px}.reference-content section{margin-bottom:16px;padding:12px;border:1px solid var(--divider-color);border-radius:var(--ha-border-radius-md,12px)}ha-button{margin-top:12px}";
      this.shadowRoot.append(style, this._references, this._remainingForm);
      this._references.querySelector("[data-add-reference]").addEventListener("click", () => {
        const lines = Array.isArray(this._config.reference_lines) ? this._config.reference_lines : [];
        if (lines.length >= 10) return;
        this._config = { ...this._config, reference_lines: [...lines, { label: "", color: [255, 152, 0] }] };
        this._notifyConfig(); this._renderReferences();
      });
    }
    const definition = HaListManagerHistoryCard.getConfigForm(this._hass);
    const split = definition.schema.findIndex((group) => group.schema?.some((field) => field.name === "min_value"));
    [this._form, this._remainingForm].forEach((form, index) => {
      form.hass = this._hass;
      form.data = this._config;
      form.schema = index === 0 ? definition.schema.slice(0, split) : definition.schema.slice(split);
      form.computeLabel = definition.computeLabel;
      form.computeHelper = definition.computeHelper;
    });
    this._renderReferences();
  }

  _notifyConfig() {
    this._form.data = this._config;
    this._remainingForm.data = this._config;
    this.dispatchEvent(new CustomEvent("config-changed", { bubbles: true, composed: true, detail: { config: this._config } }));
  }

  _renderReferences() {
    const lines = Array.isArray(this._config.reference_lines) ? this._config.reference_lines.slice(0, 10) : [];
    const signature = JSON.stringify(lines);
    const language = haListManagerHistoryCardTextLocale(this._hass);
    const computeLabel = (schema) => ({ value: haListManagerHistoryCardText("history.reference_value", {}, this._hass), label: haListManagerHistoryCardText("history.reference_label", {}, this._hass), color: haListManagerHistoryCardText("history.reference_color", {}, this._hass) })[schema.name];
    if (this._referenceLanguage !== language) {
      this._referenceLanguage = language;
      this._references.querySelector("[data-reference-heading]").textContent = haListManagerHistoryCardText("history.references", {}, this._hass);
      this._references.querySelector("[data-reference-help]").textContent = haListManagerHistoryCardText("history.references_help", {}, this._hass);
      this._references.querySelector("[data-add-reference-label]").textContent = haListManagerHistoryCardText("history.add_reference", {}, this._hass);
      this._references.querySelectorAll("[data-remove-reference-label]").forEach((label) => { label.textContent = haListManagerHistoryCardText("history.remove_reference", {}, this._hass); });
      this._references.querySelectorAll("ha-form").forEach((form) => { form.computeLabel = computeLabel; });
    }
    if (signature === this._referenceSignature) {
      this._references.querySelectorAll("ha-form").forEach((form) => { form.hass = this._hass; });
      return;
    }
    this._referenceSignature = signature;
    const rows = this._references.querySelector("[data-reference-rows]");
    rows.replaceChildren();
    lines.forEach((line, index) => {
      const section = document.createElement("section");
      const form = document.createElement("ha-form");
      form.hass = this._hass;
      form.data = line || {};
      form.schema = [{ name: "value", selector: { number: { mode: "box", step: "any" } } }, { name: "label", selector: { text: {} } }, { name: "color", selector: { color_rgb: {} } }];
      form.computeLabel = computeLabel;
      form.addEventListener("value-changed", (event) => {
        event.stopPropagation();
        const next = this._config.reference_lines.slice(); next[index] = { ...next[index], ...event.detail.value };
        this._config = { ...this._config, reference_lines: next };
        this._referenceSignature = JSON.stringify(next);
        this._notifyConfig();
      });
      const remove = document.createElement("ha-button");
      remove.setAttribute("appearance", "plain"); remove.setAttribute("variant", "danger");
      remove.innerHTML = `<ha-icon slot="start" icon="mdi:delete-outline"></ha-icon><span data-remove-reference-label>${haListManagerHistoryCardText("history.remove_reference", {}, this._hass)}</span>`;
      remove.addEventListener("click", () => {
        this._config = { ...this._config, reference_lines: this._config.reference_lines.filter((_, i) => i !== index) };
        this._notifyConfig(); this._renderReferences();
      });
      section.append(form, remove); rows.append(section);
    });
    this._references.querySelector("[data-add-reference]").disabled = lines.length >= 10;
  }
}

if (!customElements.get("ha-list-manager-history-card")) customElements.define("ha-list-manager-history-card", HaListManagerHistoryCard);
if (!customElements.get("ha-list-manager-history-card-editor")) customElements.define("ha-list-manager-history-card-editor", HaListManagerHistoryCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "ha-list-manager-history-card")) window.customCards.push({ type: "ha-list-manager-history-card", name: "HA List Manager · History" });

