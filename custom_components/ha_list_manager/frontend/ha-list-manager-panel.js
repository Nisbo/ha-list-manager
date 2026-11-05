// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerPanelTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerPanelTextLanguage(hass = null) {
  return haListManagerPanelTextLocale(hass).toLowerCase().split("-")[0] === "de" ? "de" : "en";
}
function haListManagerPanelText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerPanelTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerPanelTextLocale(hass));
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
function haListManagerPanelTextUpdateTranslations(element, hass) {
  if (!hass) return false;
  const previous = element._nativeTranslationState;
  const language = String(hass.language || haListManagerPanelTextLocale(hass));
  const connection = hass.connection || hass;
  const changed = !previous || previous.language !== language || previous.connection !== connection;
  const wasReady = previous?.ready;
  let state = previous;
  if (changed) {
    state = { language, connection, previousLocalize: previous?.localize, switched: Boolean(previous && previous.language !== language), localize: hass.localize, renderedLocalize: hass.localize, ready: false };
    // Preloaded resources are immediately usable, including in an editor.
    state.ready = Boolean(haListManagerPanelText("ui.cancel", {}, hass)) && (!state.switched || hass.localize !== state.previousLocalize);
    element._nativeTranslationState = state;
    haListManagerPanelTextLoadTranslations(hass).then((localize) => {
      if (element._nativeTranslationState !== state) return;
      state.needsRefresh = Boolean(localize && localize !== state.renderedLocalize);
      const current = element._hass;
      if (!current || String(current.language || haListManagerPanelTextLocale(current)) !== language || (current.connection || current) !== connection) return;
      if (haListManagerPanelText("ui.cancel", {}, current) && (!state.switched || current.localize !== state.previousLocalize) && (!state.ready || (state.needsRefresh && current.localize !== state.renderedLocalize))) {
        state.ready = true;
        state.needsRefresh = false;
        state.renderedLocalize = current.localize;
        element._render();
      }
    }).catch((error) => {
      if (element._nativeTranslationState === state) console.warn(error);
    });
  } else if (!state.ready && haListManagerPanelText("ui.cancel", {}, hass) && (!state.switched || hass.localize !== state.previousLocalize)) {
    state.ready = true;
  }
  const refresh = state.ready && state.needsRefresh && hass.localize !== state.renderedLocalize;
  if (state.ready && (changed || !wasReady || refresh)) { state.renderedLocalize = hass.localize; state.needsRefresh = false; }
  state.localize = hass.localize;
  return state.ready && (changed || !wasReady || refresh);
}
function haListManagerPanelTextRequest(hass, message) {
  return hass.callWS(message.type?.startsWith("ha_list_manager/") ? { ...message, language: haListManagerPanelTextLanguage(hass) } : message);
}

const PANEL_VERSION = "1.0.0b5";
const GROUP_PICKER_RESULT_LIMIT = 100;
const API = "ha_list_manager";
const ITEMS_EVENT = "ha_list_manager_items_changed";

const SECTIONS = (hass = null) => ([
  ["overview", haListManagerPanelText("ui.overview", {}, hass), "mdi:view-dashboard-outline"],
  ["lists", haListManagerPanelText("ui.lists", {}, hass), "mdi:format-list-bulleted"],
  ["products", haListManagerPanelText("ui.products", {}, hass), "mdi:barcode-scan"],
  ["categories", haListManagerPanelText("ui.categories", {}, hass), "mdi:shape-outline"],
  ["labels", haListManagerPanelText("ui.labels", {}, hass), "mdi:label-multiple-outline"],
  ["chips", haListManagerPanelText("ui.chips_and_templates", {}, hass), "mdi:gesture-tap-button"],
  ["dishes", haListManagerPanelText("recipes.dishes", {}, hass), "mdi:food-variant"],
  ["inventory", haListManagerPanelText("ui.inventory", {}, hass), "mdi:package-variant-closed"],
  ["entity_history", haListManagerPanelText("ui.entity_inventory", {}, hass), "mdi:database-clock-outline"],
  ["history", haListManagerPanelText("ui.scanner", {}, hass), "mdi:barcode-scan"],
  ["notifications", haListManagerPanelText("ui.notifications", {}, hass), "mdi:bell-outline"],
  ["settings", haListManagerPanelText("ui.settings", {}, hass), "mdi:cog-outline"],
  ["backup", haListManagerPanelText("backup.title", {}, hass), "mdi:database-export-outline"],
  ["statistics", haListManagerPanelText("ui.statistics", {}, hass), "mdi:chart-box-outline"],
].map(([id, label, icon]) => ({ id, label, icon })));

const LIST_TYPES = (hass = null) => ({
  shopping: { label: haListManagerPanelText("ui.shopping_list", {}, hass), icon: "mdi:cart-outline" },
  bring: { label: haListManagerPanelText("ui.bring", {}, hass), icon: "mdi:cart-arrow-down" },
  todo: { label: haListManagerPanelText("todo.task_list", {}, hass), icon: "mdi:checkbox-marked-outline" },
  inventory: { label: haListManagerPanelText("ui.inventory_list", {}, hass), icon: "mdi:package-variant-closed" },
});
const SCANNER_ACTIONS = (hass = null) => ({
  add: { label: haListManagerPanelText("ui.stock_in", {}, hass), icon: "mdi:package-variant-plus" },
  remove: { label: haListManagerPanelText("inventory.withdraw", {}, hass), icon: "mdi:package-variant-minus" },
  register: { label: haListManagerPanelText("ui.register", {}, hass), icon: "mdi:package-variant" },
  correct: { label: haListManagerPanelText("inventory.correct", {}, hass), icon: "mdi:square-edit-outline" },
});

class HaListManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = undefined;
    this._activeSection = "overview";
    this._selectedListId = null;
    this._loaded = false;
    this._loading = false;
    this._itemsLoading = false;
    this._itemsRequestId = 0;
    this._itemsLoadingListId = null;
    this._busy = false;
    this._error = "";
    this._navigationScrollLeft = 0;
    this._info = null;
    this._lists = [];
    this._items = [];
    this._products = [];
    this._productsLoaded = false;
    this._productsLoading = false;
    this._productSearch = "";
    this._productSearchTimer = undefined;
    this._productRequestId = 0;
    this._productLabelFilter = "";
    this._productPage = 1;
    this._productPageSize = 25;
    this._productTotal = 0;
    this._listItemSearch = "";
    this._listDetailTab = "overview";
    this._listAssignmentGroups = [];
    this._listAssignmentsLoading = false;
    this._listAssignmentsRequestId = 0;
    this._categories = [];
    this._dynamicCategories = [];
    this._categoriesLoaded = false;
    this._categoriesLoading = false;
    this._categoryOrderEditing = false;
    this._categoryOrderMode = "global";
    this._categoryOrderListId = "";
    this._categoryOrderListType = "shopping";
    this._categoryOrderCategories = [];
    this._categoryOrderOriginal = [];
    this._categoryOrderLoading = false;
    this._categoryOrderSaving = false;
    this._categoryOrderDraggedId = "";
    this._categoryOrderCustom = false;
    this._categoryTab = "global";
    this._categorySpecificListId = "";
    this._categorySpecificMode = "rules";
    this._categoryProductSearchTimer = undefined;
    this._categoryProductRequestId = 0;
    this._categoryProductPageRequestId = 0;
    this._dishProductSearchTimer = undefined;
    this._dishProductRequestId = 0;
    this._selectedCategoryId = null;
    this._categoryDetailTab = "rules";
    this._categoryRules = [];
    this._categoryRulesLoading = false;
    this._categoryRuleDraft = "";
    this._categoryRuleEditingIndex = -1;
    this._categoryProducts = [];
    this._categoryProductsLoading = false;
    this._favorites = [];
    this._favoriteBusy = false;
    this._labels = [];
    this._labelsLoaded = false;
    this._labelsLoading = false;
    this._labelSearch = "";
    this._labelTab = "global";
    this._labelSpecificListId = "";
    this._chips = [];
    this._chipsLoaded = false;
    this._chipsLoading = false;
    this._chipSearch = "";
    this._chipTab = "global";
    this._chipSpecificListId = "";
    this._dishes = [];
    this._dishesLoaded = false;
    this._dishesLoading = false;
    this._dishSearch = "";
    this._inventoryEntries = [];
    this._inventoryGroups = [];
    this._inventoryGroupSearch = "";
    this._inventoryGroupShowGrouped = false;
    this._inventoryLoading = false;
    this._inventoryRequestId = 0;
    this._inventoryLoadingListId = null;
    this._inventoryProducts = [];
    this._selectedInventoryListId = null;
    this._inventoryRestockSettings = { target_list_id: null, enabled: false, mode: null, fixed_quantity: null };
    this._inventoryRestockPreview = [];
    this._trackedEntities = [];
    this._entityHistoryCandidate = "";
    this._entityHistoryTab = "add";
    this._entityHistorySearch = "";
    this._entityHistoryImportOptions = { start: "", end: "", recorder: true, statistics: false };
    this._scanners = [];
    this._scannersLoaded = false;
    this._scannersLoading = false;
    this._scannerTarget = null;
    this._scanHistory = [];
    this._scanHistoryTotal = 0;
    this._scanHistoryLoaded = false;
    this._scanHistoryLoading = false;
    this._pendingScans = [];
    this._scanHistoryTab = null;
    this._scanHistoryPage = 1;
    this._scanHistoryPageSize = 100;
    this._scanQueuePage = 1;
    this._scanQueuePageSize = 100;
    this._simulationStatus = null;
    this._simulation = { scanner_id: "", list_id: "", action: "add", ean: "", quantity: 1, corrected_stock: "", delay: "0" };
    this._simulationTimer = null;
    this._simulationCountdown = 0;
    this._dashboardUsages = new Map();
    this._dashboardUsagesLoaded = false;
    this._dashboardUsagesLoading = false;
    this._dashboardUsagesError = "";
    this._lovelaceSubscriptionRequested = false;
    this._unsubscribeLovelace = null;
    this._settings = { append_brand_to_product_name: false, append_quantity_to_product_name: false, scanner_default_list_id: null, scanner_default_action: "add", tandoor_url: "", tandoor_token: "", tandoor_token_configured: false };
    this._settingsLoaded = false;
    this._tandoorTestStatus = "";
    this._notificationProfiles = [];
    this._notificationAssignments = [];
    this._notificationEntityPlatforms = {};
    this._notificationStatus = "";
    this._notificationTab = "profiles";
    this._expandedNotificationLists = new Set();
    this._expandedNotificationProfiles = new Set();
    this._dialog = null;
    this._dataManagementTab = "backup";
    this._legacyImport = { draft: null, plan: null, result: null, selections: [], files: [], includeItems: true, busy: false, operation: "", error: "", status: "", feedbackTarget: "input", confirmed: false, requestId: 0 };
    this._legacyImportPickers = new WeakSet();
    this._bringRefreshTimer = null;
    this._bringSyncing = false;
    this._unsubscribeItems = null;
    this._itemsSubscriptionRequested = false;
    this._pageScrollLocks = [];
  }

  set hass(value) {
    this._hass = value;
    const translationsChanged = haListManagerPanelTextUpdateTranslations(this, this._hass);
    if (this.isConnected) {
      this._ensureLoaded();
      this._ensureLovelaceSubscription();
      this._ensureItemsSubscription();
    }

    if (translationsChanged) this._render();
  }
  set narrow(value) { this.toggleAttribute("narrow", Boolean(value)); }
  set route(value) {
    this._route = value;
    const changed = this._applyRouteSection();
    if (changed && this.isConnected) {
      if (this._activeSection === "products" && !this._productsLoaded) this._loadProducts();
      else this._render();
    }
  }
  set panel(value) { this._panel = value; }

  connectedCallback() {
    this._applyRouteSection();
    this._render();
    this._ensureLoaded();
    this._ensureLovelaceSubscription();
    this._ensureItemsSubscription();
    if (!this._bringRefreshTimer) {
      this._bringRefreshTimer = setInterval(() => {
        const list = this._findList(this._selectedListId);
        const editing = Boolean(this._dialog || this.shadowRoot?.activeElement?.matches?.("input, textarea"));
        if (document.visibilityState === "visible" && list?.list_type === "bring" && !this._itemsLoading && !editing) this._loadItems(true);
      }, 15000);
    }
  }

  disconnectedCallback() {
    if (this._backupDownload) URL.revokeObjectURL(this._backupDownload.url);
    this._backupDownload = null;
    clearTimeout(this._productSearchTimer);
    clearTimeout(this._categoryProductSearchTimer);
    clearTimeout(this._dishProductSearchTimer);
    for (let dialog = this._dialog; dialog; dialog = dialog.return_dialog) clearTimeout(dialog.product_search_timer);
    if (this._simulationTimer) clearInterval(this._simulationTimer);
    this._simulationTimer = null;
    this._simulationCountdown = 0;
    this._unsubscribeLovelace?.();
    this._unsubscribeLovelace = null;
    this._lovelaceSubscriptionRequested = false;
    this._lovelaceSubscriptionToken = null;
    this._unsubscribeItems?.();
    this._unsubscribeItems = null;
    this._itemsSubscriptionRequested = false;
    this._itemsSubscriptionToken = null;
    if (this._bringRefreshTimer) clearInterval(this._bringRefreshTimer);
    this._bringRefreshTimer = null;
    this._setPageScrollLocked(false);
  }

  async _ensureItemsSubscription() {
    if (!this._hass?.connection || this._itemsSubscriptionRequested) return;
    this._itemsSubscriptionRequested = true;
    const token = this._itemsSubscriptionToken = {};
    try {
      const unsubscribe = await this._hass.connection.subscribeEvents((event) => {
        if (this.isConnected && this._itemsSubscriptionToken === token && event.data?.list_id === this._selectedListId) this._loadItems(true);
      }, ITEMS_EVENT);
      if (this.isConnected && this._itemsSubscriptionToken === token) this._unsubscribeItems = unsubscribe;
      else unsubscribe();
    } catch (_error) {
      if (this._itemsSubscriptionToken === token) this._itemsSubscriptionRequested = false;
    }
  }

  async _ensureLovelaceSubscription() {
    if (!this._hass?.connection || this._lovelaceSubscriptionRequested) return;
    this._lovelaceSubscriptionRequested = true;
    const token = this._lovelaceSubscriptionToken = {};
    try {
      const unsubscribe = await this._hass.connection.subscribeEvents(() => {
        if (!this.isConnected || this._lovelaceSubscriptionToken !== token) return;
        this._dashboardUsagesLoaded = false;
        this._dashboardUsages = new Map();
        const list = this._findList(this._selectedListId);
        if (this._activeSection === "lists" && list?.list_type === "inventory") this._loadDashboardUsages();
      }, "lovelace_updated");
      if (this.isConnected && this._lovelaceSubscriptionToken === token) this._unsubscribeLovelace = unsubscribe;
      else unsubscribe();
    } catch (_error) {
      if (this._lovelaceSubscriptionToken === token) this._lovelaceSubscriptionRequested = false;
    }
  }

  _applyRouteSection() {
    const routePath = String(this._route?.path || "").replace(/^\/+|\/+$/g, "").split("/")[0];
    const locationPath = typeof location === "undefined" ? "" : location.pathname.split("/").filter(Boolean)[1] || "";
    let section = routePath || locationPath;
    if (section === "scanners") {
      this._scanHistoryTab = "devices";
      section = "history";
    }
    if (!SECTIONS(this._hass).some((item) => item.id === section) || this._activeSection === section) return false;
    this._activeSection = section;
    return true;
  }

  async _ensureLoaded() {
    if (!this._hass || this._loading || this._loaded) return;
    await this._loadData();
  }

  async _loadData() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    this._error = "";
    this._render();
    try {
      const [info, records, categoryRecords, labelRecords, chipRecords, dishRecords, settings, scannerRecords, scannerTarget, pendingScans, notificationProfiles, notificationAssignments, trackedEntities, favoriteRecords, notificationEntities] = await Promise.all([
        haListManagerPanelTextRequest(this._hass, { type: `${API}/info` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/lists/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/categories/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/labels/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/chips/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/dishes/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/settings/get` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanners/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/target/get` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/queue/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/profiles/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/assignments/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/favorites/list` }),
        this._hass.callWS({ type: "config/entity_registry/list" }).catch(() => []),
      ]);
      this._info = info;
      this._lists = records.lists || [];
      this._categories = categoryRecords.categories || [];
      this._dynamicCategories = categoryRecords.dynamic || [];
      this._categoriesLoaded = true;
      this._labels = labelRecords.labels || [];
      this._labelsLoaded = true;
      this._chips = chipRecords.chips || [];
      this._chipsLoaded = true;
      this._dishes = dishRecords.dishes || [];
      this._dishesLoaded = true;
      this._settings = settings;
      this._settingsLoaded = true;
      this._scanners = scannerRecords.scanners || [];
      this._scannersLoaded = true;
      this._scannerTarget = scannerTarget.target || null;
      this._pendingScans = pendingScans.scans || [];
      this._notificationEntityPlatforms = Object.fromEntries((Array.isArray(notificationEntities) ? notificationEntities : []).map((entity) => [entity.entity_id, entity.platform]));
      this._notificationProfiles = notificationProfiles.profiles || [];
      this._notificationAssignments = notificationAssignments.assignments || [];
      this._trackedEntities = trackedEntities.entities || [];
      this._favorites = favoriteRecords.favorites || [];
      if (this._selectedListId && !this._findList(this._selectedListId)) {
        this._selectedListId = null;
        this._items = [];
      }
      this._loaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._loading = false;
      this._render();
      if (this._loaded && this._activeSection === "products" && !this._productsLoaded) this._loadProducts();
      if (this._loaded && this._activeSection === "history" && !this._scanHistoryLoaded) this._loadScanHistory();
      if (this._loaded && this._activeSection === "backup") this._loadDataBackupInfo();
    }
  }

  async _loadItems(quiet = false) {
    const listId = this._selectedListId;
    if (!listId || (this._itemsLoading && this._itemsLoadingListId === listId)) return;
    const requestId = ++this._itemsRequestId;
    this._itemsLoadingListId = listId;
    let shouldRender = !quiet;
    this._itemsLoading = true;
    this._error = "";
    if (!quiet) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/items/list`, list_id: listId });
      if (requestId !== this._itemsRequestId || listId !== this._selectedListId) return;
      const nextItems = result.items || [];
      const changed = JSON.stringify(nextItems) !== JSON.stringify(this._items);
      this._items = nextItems;
      if (result.sync_status) this._updateListSyncStatus(listId, result.sync_status);
      shouldRender ||= changed;
    } catch (error) {
      if (requestId !== this._itemsRequestId || listId !== this._selectedListId) return;
      this._error = this._formatError(error);
      shouldRender = true;
    } finally {
      if (requestId === this._itemsRequestId) {
        this._itemsLoading = false;
        this._itemsLoadingListId = null;
        if (shouldRender) this._render();
      }
    }
  }

  _updateListSyncStatus(listId, syncStatus) {
    this._lists = this._lists.map((list) => list.id === listId
      ? { ...list, sync_status: syncStatus }
      : list);
  }

  async _syncBringList() {
    if (!this._selectedListId || this._bringSyncing) return;
    const listId = this._selectedListId;
    this._bringSyncing = true;
    this._error = "";
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/lists/sync`, list_id: listId });
      this._items = result.items || [];
      if (result.sync_status) this._updateListSyncStatus(listId, result.sync_status);
    } catch (error) {
      this._error = this._formatError(error);
      try {
        const records = await haListManagerPanelTextRequest(this._hass, { type: `${API}/lists/list` });
        this._lists = records.lists || this._lists;
      } catch (_refreshError) {
        // Keep the original synchronization error visible.
      }
    } finally {
      this._bringSyncing = false;
      this._render();
    }
  }

  async _loadProducts(restoreSearchFocus = false) {
    if (!this._hass) return;
    const requestId = ++this._productRequestId;
    this._productsLoading = true;
    this._error = "";
    if (!this._productsLoaded) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/products/list`,
        search: this._productSearch.trim(),
        label_id: this._productLabelFilter || null,
        limit: this._productPageSize,
        offset: (this._productPage - 1) * this._productPageSize,
      });
      if (requestId !== this._productRequestId) return;
      this._productTotal = Number(result.total || 0);
      const pageCount = Math.max(1, Math.ceil(this._productTotal / this._productPageSize));
      if (this._productPage > pageCount) {
        this._productPage = pageCount;
        this._productsLoaded = false;
        setTimeout(() => this._loadProducts(restoreSearchFocus), 0);
        return;
      }
      this._products = result.products || [];
      this._productsLoaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      if (requestId === this._productRequestId) {
        this._productsLoading = false;
        this._render();
        if (restoreSearchFocus) {
          const field = this.shadowRoot.querySelector("[data-product-search]");
          field?.focus();
          field?.setSelectionRange?.(field.value.length, field.value.length);
        }
      }
    }
  }

  async _loadCategories() {
    if (!this._hass || this._categoriesLoading) return;
    this._categoriesLoading = true;
    this._error = "";
    if (!this._categoriesLoaded) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/categories/list` });
      this._categories = result.categories || [];
      this._dynamicCategories = result.dynamic || [];
      this._categoriesLoaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._categoriesLoading = false;
      this._render();
    }
  }

  async _loadCategoryOrder(mode = this._categoryOrderMode, listId = this._categoryOrderListId) {
    if (!this._hass || this._categoryOrderLoading) return;
    if (!["global", "list_type"].includes(mode) && !listId) return;
    this._categoryOrderMode = mode;
    if (listId) this._categoryOrderListId = listId;
    this._categoryOrderLoading = true;
    this._error = "";
    this._render();
    try {
      const payload = { type: `${API}/categories/order/get` };
      if (mode === "global") payload.scope = "global";
      else if (mode === "list_type") { payload.scope = "list_type"; payload.list_type = this._categoryOrderListType; }
      else if (mode === "list") { payload.scope = "list"; payload.list_id = listId; }
      else payload.list_id = listId;
      const result = await haListManagerPanelTextRequest(this._hass, payload);
      this._categoryOrderCategories = result.categories || [];
      this._categoryOrderOriginal = this._categoryOrderCategories.map((category) => category.id);
      this._categoryOrderCustom = Boolean(result.custom);
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._categoryOrderLoading = false;
      this._render();
    }
  }

  _categoryOrderDirty() {
    return this._categoryOrderCategories.map((category) => category.id).join("\u0000") !== this._categoryOrderOriginal.join("\u0000");
  }

  _moveCategoryOrder(categoryId, targetPosition) {
    const categories = [...this._categoryOrderCategories];
    const current = categories.findIndex((category) => category.id === categoryId);
    if (current < 0) return;
    const target = Math.max(0, Math.min(categories.length - 1, Number(targetPosition) || 0));
    const [category] = categories.splice(current, 1);
    categories.splice(target, 0, category);
    this._categoryOrderCategories = categories;
    this._render();
  }

  async _saveCategoryOrder(close = false) {
    if (this._categoryOrderSaving || (!["global", "list_type"].includes(this._categoryOrderMode) && !this._categoryOrderListId)) return;
    this._categoryOrderSaving = true;
    this._error = "";
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/categories/order/set`,
        category_ids: this._categoryOrderCategories.map((category) => category.id),
        ...(this._categoryOrderMode === "global" ? { scope: "global" } : {}),
        ...(this._categoryOrderMode === "list_type" ? { scope: "list_type", list_type: this._categoryOrderListType } : {}),
        ...(this._categoryOrderMode === "list" ? { scope: "list", list_id: this._categoryOrderListId } : {}),
        ...(this._categoryOrderMode === "combined" ? { list_id: this._categoryOrderListId } : {}),
      });
      this._categoryOrderCategories = result.categories || [];
      this._categoryOrderOriginal = this._categoryOrderCategories.map((category) => category.id);
      this._categoryOrderCustom = Boolean(result.custom);
      const updated = new Map(this._categoryOrderCategories.map((category) => [category.id, category]));
      this._categories = this._categories.map((category) => updated.get(category.id) || category);
      if (close) this._categoryOrderEditing = false;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._categoryOrderSaving = false;
      this._render();
    }
  }

  async _resetCombinedCategoryOrder() {
    if (this._categoryOrderSaving || !this._categoryOrderListId) return;
    this._categoryOrderSaving = true;
    this._error = "";
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/categories/order/reset`,
        list_id: this._categoryOrderListId,
      });
      this._categoryOrderCategories = result.categories || [];
      this._categoryOrderOriginal = this._categoryOrderCategories.map((category) => category.id);
      this._categoryOrderCustom = false;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._categoryOrderSaving = false;
      this._render();
    }
  }

  async _loadLabels() {
    if (!this._hass || this._labelsLoading) return;
    this._labelsLoading = true;
    this._error = "";
    if (!this._labelsLoaded) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/labels/list` });
      this._labels = result.labels || [];
      this._labelsLoaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._labelsLoading = false;
      this._render();
    }
  }

  async _loadChips() {
    if (!this._hass || this._chipsLoading) return;
    this._chipsLoading = true;
    this._error = "";
    if (!this._chipsLoaded) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/chips/list` });
      this._chips = result.chips || [];
      this._chipsLoaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._chipsLoading = false;
      this._render();
    }
  }

  async _loadDishes() {
    if (!this._hass || this._dishesLoading) return;
    this._dishesLoading = true;
    this._error = "";
    if (!this._dishesLoaded) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/dishes/list` });
      this._dishes = result.dishes || [];
      this._dishesLoaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._dishesLoading = false;
      this._render();
    }
  }

  async _loadSettings() {
    if (!this._hass) return;
    try {
      this._settings = await haListManagerPanelTextRequest(this._hass, { type: `${API}/settings/get` });
      this._settingsLoaded = true;
    } catch (error) {
      this._error = this._formatError(error);
    }
    this._render();
  }

  async _loadInventory() {
    if (!this._hass) return;
    const inventoryLists = this._lists.filter((list) => list.list_type === "inventory");
    if (!inventoryLists.some((list) => list.id === this._selectedInventoryListId)) {
      this._selectedInventoryListId = inventoryLists[0]?.id || null;
    }
    const listId = this._selectedInventoryListId;
    if (!listId) {
      this._inventoryRequestId += 1;
      this._inventoryLoading = false;
      this._inventoryLoadingListId = null;
      this._inventoryEntries = [];
      this._inventoryGroups = [];
      this._inventoryRestockPreview = [];
      this._render();
      return;
    }
    if (this._inventoryLoading && this._inventoryLoadingListId === listId) return;
    const requestId = ++this._inventoryRequestId;
    this._inventoryLoadingListId = listId;
    this._inventoryLoading = true;
    this._error = "";
    this._render();
    try {
      const [inventory, products, groups, restock, preview] = await Promise.all([
        haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/list`, list_id: listId }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/products/list`, search: "", label_id: null, limit: 100, offset: 0 }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/groups/list`, list_id: listId }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/restock/settings/get`, list_id: listId }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/restock/preview`, list_id: listId }),
      ]);
      if (requestId !== this._inventoryRequestId || listId !== this._selectedInventoryListId) return;
      this._inventoryEntries = inventory.entries || [];
      this._inventoryGroups = groups.groups || [];
      this._inventoryRestockSettings = restock.settings || this._inventoryRestockSettings;
      this._inventoryRestockPreview = preview.items || [];
      // Picker results must not replace the filtered/paginated Products page.
      this._inventoryProducts = products.products || [];
      this._inventoryProductTotal = Number(products.total || this._inventoryProducts.length);
    } catch (error) {
      if (requestId !== this._inventoryRequestId || listId !== this._selectedInventoryListId) return;
      this._error = this._formatError(error);
    } finally {
      if (requestId === this._inventoryRequestId) {
        this._inventoryLoading = false;
        this._inventoryLoadingListId = null;
        this._render();
      }
    }
  }

  async _loadScanners() {
    if (!this._hass || this._scannersLoading) return;
    this._scannersLoading = true;
    this._error = "";
    this._render();
    try {
      const [records, target, pending] = await Promise.all([
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanners/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/target/get` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/queue/list` }),
      ]);
      this._scanners = records.scanners || [];
      this._scannerTarget = target.target || null;
      this._pendingScans = pending.scans || [];
      this._scannersLoaded = true;
    } catch (error) { this._error = this._formatError(error); }
    finally { this._scannersLoading = false; this._render(); }
  }

  async _loadScanHistory() {
    if (!this._hass || this._scanHistoryLoading) return;
    const hadPendingScans = this._pendingScans.length > 0;
    this._scanHistoryLoading = true;
    this._error = "";
    this._render();
    try {
      const [result, pending] = await Promise.all([
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/history`, limit: this._scanHistoryPageSize, offset: (this._scanHistoryPage - 1) * this._scanHistoryPageSize }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/queue/list` }),
      ]);
      this._scanHistory = result.history || [];
      this._scanHistoryTotal = result.total ?? this._scanHistory.length;
      this._pendingScans = pending.scans || [];
      if (!this._scanHistoryTab || (!hadPendingScans && this._pendingScans.length)) this._scanHistoryTab = this._pendingScans.length ? "queue" : "history";
      if (this._scanHistoryTab === "queue" && !this._pendingScans.length) this._scanHistoryTab = "history";
      const historyPages = Math.max(1, Math.ceil(this._scanHistoryTotal / this._scanHistoryPageSize));
      if (this._scanHistoryPage > historyPages) this._scanHistoryPage = historyPages;
      const queuePages = Math.max(1, Math.ceil(this._pendingScans.length / this._scanQueuePageSize));
      if (this._scanQueuePage > queuePages) this._scanQueuePage = queuePages;
      this._scanHistoryLoaded = true;
    } catch (error) { this._error = this._formatError(error); }
    finally { this._scanHistoryLoading = false; this._render(); }
  }

  _listEntityMap() {
    const result = new Map();
    for (const [entityId, state] of Object.entries(this._hass?.states || {})) {
      const listId = state.attributes?.list_id;
      if (listId) result.set(entityId, listId);
    }
    return result;
  }

  _findListCards(node, entityMap, context, usages) {
    if (Array.isArray(node)) {
      node.forEach((item) => this._findListCards(item, entityMap, context, usages));
      return;
    }
    if (!node || typeof node !== "object") return;
    if ([
      "custom:ha-list-manager-shopping-card",
      "custom:ha-list-manager-todo-card",
      "custom:ha-list-manager-inventory-card",
    ].includes(node.type)) {
      const listId = node.list_id || entityMap.get(node.entity);
      if (listId) {
        const entries = usages.get(listId) || [];
        if (!entries.some((entry) => entry.url === context.url)) entries.push({ ...context, entity: node.entity || "" });
        usages.set(listId, entries);
      }
    }
    Object.values(node).forEach((value) => this._findListCards(value, entityMap, context, usages));
  }

  async _loadDashboardUsages(force = false) {
    if (!this._hass || this._dashboardUsagesLoading || (this._dashboardUsagesLoaded && !force)) return;
    this._dashboardUsagesLoading = true;
    this._dashboardUsagesError = "";
    this._render();
    try {
      const response = await haListManagerPanelTextRequest(this._hass, { type: "lovelace/dashboards/list" });
      const dashboards = Array.isArray(response) ? response : response?.dashboards || [];
      const candidates = [...dashboards];
      if (!candidates.some((dashboard) => dashboard.url_path === "lovelace" || dashboard.url_path == null)) {
        candidates.unshift({ title: haListManagerPanelText("ui.overview", {}, this._hass), url_path: null });
      }
      const configurations = await Promise.allSettled(candidates.map(async (dashboard) => {
        const message = { type: "lovelace/config" };
        if (dashboard.url_path) message.url_path = dashboard.url_path;
        const config = await haListManagerPanelTextRequest(this._hass, message);
        return { dashboard, config };
      }));
      const entityMap = this._listEntityMap();
      const usages = new Map();
      for (const result of configurations) {
        if (result.status !== "fulfilled") continue;
        const { dashboard, config } = result.value;
        const dashboardPath = dashboard.url_path || "lovelace";
        const dashboardTitle = dashboard.title || (dashboardPath === "lovelace" ? haListManagerPanelText("ui.overview", {}, this._hass) : dashboardPath);
        (config?.views || []).forEach((view, index) => {
          const viewPath = String(view.path || index);
          this._findListCards(view, entityMap, {
            dashboard: dashboardTitle,
            view: view.title || view.path || haListManagerPanelText("ui.view_number", {p0:(index + 1)}, this._hass),
            url: `/${dashboardPath}/${viewPath}`,
          }, usages);
        });
      }
      this._dashboardUsages = usages;
      this._dashboardUsagesLoaded = true;
    } catch (error) {
      this._dashboardUsagesError = this._formatError(error);
    } finally {
      this._dashboardUsagesLoading = false;
      this._render();
    }
  }

  _render() {
    if (!this._hass || this._nativeTranslationState?.ready === false) return;
    const language = String(this._hass?.language || haListManagerPanelTextLocale(this._hass));
    const languageChanged = this._renderedLanguage !== language;
    this._renderedLanguage = language;
    if (!languageChanged && this._activeSection === "backup" && this._dataManagementTab === "import" && this.shadowRoot.querySelector("[data-legacy-import-view]")) {
      this._updateLegacyImport();
      return;
    }
    if (!languageChanged && this._activeSection === "backup" && this._dataManagementTab === "backup" && this.shadowRoot.querySelector("[data-backup-view]")) {
      this._updateDataBackup();
      return;
    }
    const navigationScrollLeft = this.shadowRoot.querySelector("nav")?.scrollLeft ?? this._navigationScrollLeft;
    this._navigationScrollLeft = navigationScrollLeft;
    const navigation = SECTIONS(this._hass).map(({ id, label, icon }) => `
      <button class="nav-item${id === this._activeSection ? " active" : ""}" type="button" data-section="${id}">
        <ha-icon icon="${icon}"></ha-icon><span>${label}</span>
      </button>`).join("");
    const content = this._renderContent();
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="page">
        <header class="page-header">
          <div class="title-wrap"><ha-icon icon="mdi:cart-variant"></ha-icon><div><h1>HA List Manager</h1><p>${haListManagerPanelText("ui.backend_management", {}, this._hass)} <span class="version">v${PANEL_VERSION}</span></p></div></div>
          <span class="release-stage">${haListManagerPanelText("ui.beta", {}, this._hass)}</span>
        </header>
        <div class="layout"><nav aria-label="${haListManagerPanelText("ui.administration", {}, this._hass)}">${navigation}</nav><main>${this._renderPageFavorite()}${content}</main></div>
      </div>
      ${this._activeSection === "backup" ? `<div data-backup-dialog>${this._renderDialog()}</div>` : this._renderDialog()}`;
    const navigationElement = this.shadowRoot.querySelector("nav");
    if (navigationElement) navigationElement.scrollLeft = navigationScrollLeft;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (navigationElement?.isConnected) navigationElement.scrollLeft = navigationScrollLeft;
    }));
    this._bindEvents();
    this._initializeRenderedComponents();
    this._setPageScrollLocked(Boolean(this._dialog));
    const samplesList = this.shadowRoot.querySelector(".entity-samples-list");
    if (samplesList && this._dialog?.kind === "entity-samples") samplesList.scrollTop = this._dialog.scroll_top || 0;

  }

  _renderContent() {
    if (this._loading && !this._loaded) return this._loadingCard(haListManagerPanelText("ui.backend_loading", {}, this._hass));
    if (this._error && !this._loaded) return `<ha-card class="empty-state"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><h3>${haListManagerPanelText("ui.backend_unreachable", {}, this._hass)}</h3><p>${this._escape(this._error)}</p><button class="ha-button" type="button" data-retry>${haListManagerPanelText("ui.retry", {}, this._hass)}</button></ha-card>`;
    if (this._activeSection === "overview") return this._renderOverview();
    if (this._activeSection === "lists") return this._selectedListId ? this._renderListDetail() : this._renderLists();
    if (this._activeSection === "products") return this._renderProducts();
    if (this._activeSection === "categories") return this._selectedCategoryId ? this._renderCategoryProductsPage() : this._renderCategories();
    if (this._activeSection === "labels") return this._renderLabels();
    if (this._activeSection === "chips") return this._renderChips();
    if (this._activeSection === "dishes") return this._renderDishes();
    if (this._activeSection === "inventory") return this._renderInventory();
    if (this._activeSection === "entity_history") return this._renderEntityHistory();
    if (this._activeSection === "history") return this._renderScanHistory();
    if (this._activeSection === "notifications") return this._renderNotifications();
    if (this._activeSection === "settings") return this._renderSettings();
    if (this._activeSection === "backup") return this._renderDataManagement();
    if (this._activeSection === "statistics") return this._renderStatistics();
    return this._renderOverview();
  }

  _currentFavoriteTarget() {
    if (this._activeSection === "overview" || this._categoryOrderEditing) return null;
    if (this._activeSection === "categories") {
      return this._selectedCategoryId
        ? { section: "categories", tab: this._categoryDetailTab, target_id: this._selectedCategoryId }
        : { section: "categories", tab: this._categoryTab, target_id: null };
    }
    if (this._activeSection === "labels") return { section: "labels", tab: this._labelTab, target_id: null };
    if (this._activeSection === "chips") return { section: "chips", tab: this._chipTab, target_id: null };
    if (this._activeSection === "dishes") return { section: "dishes", tab: null, target_id: null };
    if (this._activeSection === "lists") return { section: "lists", tab: this._selectedListId ? this._listDetailTab : null, target_id: this._selectedListId };
    if (this._activeSection === "history") return { section: "history", tab: this._scanHistoryTab || "history", target_id: null };
    if (this._activeSection === "notifications") return { section: "notifications", tab: this._notificationTab || "profiles", target_id: null };
    return { section: this._activeSection, tab: null, target_id: null };
  }

  _favoriteMatches(favorite, target) {
    return Boolean(target)
      && favorite.section === target.section
      && (favorite.tab || "") === (target.tab || "")
      && (favorite.target_id || "") === (target.target_id || "");
  }

  _renderPageFavorite() {
    const target = this._currentFavoriteTarget();
    if (!target) return "";
    const active = this._favorites.some((favorite) => this._favoriteMatches(favorite, target));
    return `<div class="page-favorite-toolbar"><button class="icon-button page-favorite-toggle ${active ? "active" : ""}" type="button" data-toggle-page-favorite title="${active ? haListManagerPanelText("ui.remove_favorite", {}, this._hass) : haListManagerPanelText("ui.add_favorite", {}, this._hass)}" aria-label="${active ? haListManagerPanelText("ui.remove_favorite", {}, this._hass) : haListManagerPanelText("ui.add_favorite", {}, this._hass)}" ${this._favoriteBusy ? "disabled" : ""}><ha-icon icon="mdi:star${active ? "" : "-outline"}"></ha-icon></button></div>`;
  }

  _favoritePresentation(favorite) {
    const section = favorite.section;
    if (section === "categories" && favorite.target_id) {
      const category = this._findCategory(favorite.target_id);
      if (!category) return { title: haListManagerPanelText("ui.category_unavailable", {}, this._hass), subtitle: haListManagerPanelText("ui.favorite_removable", {}, this._hass), icon: "mdi:alert-circle-outline", missing: true };
      const list = category.list_id ? this._findList(category.list_id) : null;
      const scope = category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : category.scope === "list_type" ? (LIST_TYPES(this._hass)[category.list_type]?.label || category.list_type) : (list?.name || haListManagerPanelText("ui.unknown_list", {}, this._hass));
      const detail = favorite.tab === "products" ? haListManagerPanelText("ui.product_assignments", {}, this._hass) : haListManagerPanelText("ui.automatic_assignments", {}, this._hass);
      return { title: category.name, subtitle: `${scope} · ${detail}`, icon: category.icon || "mdi:shape-outline" };
    }
    if (section === "lists" && favorite.target_id) {
      const list = this._findList(favorite.target_id);
      if (!list) return { title: haListManagerPanelText("ui.list_unavailable", {}, this._hass), subtitle: haListManagerPanelText("ui.favorite_removable", {}, this._hass), icon: "mdi:alert-circle-outline", missing: true };
      const detail = favorite.tab === "items" ? haListManagerPanelText("ui.entries", {}, this._hass) : haListManagerPanelText("ui.overview", {}, this._hass);
      return { title: list.name, subtitle: `${LIST_TYPES(this._hass)[list.list_type]?.label || haListManagerPanelText("ui.list", {}, this._hass)} · ${detail}`, icon: list.icon || "mdi:format-list-bulleted" };
    }
    const tabNames = { global: haListManagerPanelText("ui.global", {}, this._hass), shopping: haListManagerPanelText("ui.shopping_list", {}, this._hass), inventory: haListManagerPanelText("ui.inventory", {}, this._hass), todo: haListManagerPanelText("ui.todo", {}, this._hass), specific: haListManagerPanelText("ui.specific", {}, this._hass), dynamic: haListManagerPanelText("ui.dynamic", {}, this._hass), queue: haListManagerPanelText("ui.scan_queue", {}, this._hass), history: haListManagerPanelText("ui.history", {}, this._hass), devices: haListManagerPanelText("ui.devices", {}, this._hass), simulation: haListManagerPanelText("scanner.simulation", {}, this._hass), profiles: haListManagerPanelText("ui.delivery_targets", {}, this._hass), assignments: haListManagerPanelText("ui.assign_lists", {}, this._hass) };
    const sections = {
      lists: [haListManagerPanelText("ui.lists", {}, this._hass), "mdi:format-list-bulleted"], products: [haListManagerPanelText("ui.products", {}, this._hass), "mdi:barcode-scan"], categories: [haListManagerPanelText("ui.categories", {}, this._hass), "mdi:shape-outline"], labels: [haListManagerPanelText("ui.labels", {}, this._hass), "mdi:label-multiple-outline"], chips: [haListManagerPanelText("ui.chips_and_templates", {}, this._hass), "mdi:gesture-tap-button"], dishes: [haListManagerPanelText("recipes.dishes", {}, this._hass), "mdi:food-variant"], inventory: [haListManagerPanelText("ui.inventory", {}, this._hass), "mdi:package-variant-closed"], entity_history: [haListManagerPanelText("ui.entity_inventory", {}, this._hass), "mdi:database-clock-outline"], history: [haListManagerPanelText("ui.scanner", {}, this._hass), "mdi:barcode-scan"], notifications: [haListManagerPanelText("ui.notifications", {}, this._hass), "mdi:bell-outline"], settings: [haListManagerPanelText("ui.settings", {}, this._hass), "mdi:cog-outline"], backup: [haListManagerPanelText("backup.title", {}, this._hass), "mdi:database-export-outline"], statistics: [haListManagerPanelText("ui.statistics", {}, this._hass), "mdi:chart-box-outline"],
    };
    const [title, icon] = sections[section] || [section, "mdi:bookmark-outline"];
    return { title, subtitle: favorite.tab ? tabNames[favorite.tab] || favorite.tab : haListManagerPanelText("ui.backend_page", {}, this._hass), icon };
  }

  _renderFavoriteShortcuts() {
    if (!this._favorites.length) return `<section class="favorite-overview"><div class="favorite-overview-heading"><ha-icon icon="mdi:star"></ha-icon><div><h3>${haListManagerPanelText("ui.quick_access", {}, this._hass)}</h3><p>${haListManagerPanelText("help.open_saved_pages", {}, this._hass)}</p></div></div><ha-card class="empty-state compact favorite-empty"><ha-icon icon="mdi:star-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_shortcuts", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.favorite_backend_page_hint", {}, this._hass)}</p></ha-card></section>`;
    const rows = this._favorites.map((favorite) => {
      const view = this._favoritePresentation(favorite);
      return `<article class="favorite-shortcut ${view.missing ? "missing" : ""}"><button type="button" data-open-favorite="${favorite.id}" ${view.missing ? "disabled" : ""}><ha-icon icon="${this._escape(view.icon)}"></ha-icon><span><strong>${this._escape(view.title)}</strong><small>${this._escape(view.subtitle)}</small></span></button><button class="icon-button active" type="button" data-remove-favorite="${favorite.id}" title="${haListManagerPanelText("ui.remove_favorite", {}, this._hass)}" aria-label="${haListManagerPanelText("ui.remove_named_favorite", {p0:(this._escape(view.title))}, this._hass)}"><ha-icon icon="mdi:star"></ha-icon></button></article>`;
    }).join("");
    return `<section class="favorite-overview"><div class="favorite-overview-heading"><ha-icon icon="mdi:star"></ha-icon><div><h3>${haListManagerPanelText("ui.quick_access", {}, this._hass)}</h3><p>${haListManagerPanelText("help.open_saved_pages", {}, this._hass)}</p></div></div><div class="favorite-shortcut-grid">${rows}</div></section>`;
  }

  async _setFavorite(target, enabled) {
    if (!target || this._favoriteBusy) return;
    this._favoriteBusy = true;
    this._error = "";
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/favorites/set`,
        section: target.section,
        tab: target.tab || null,
        target_id: target.target_id || null,
        enabled,
      });
      this._favorites = result.favorites || [];
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._favoriteBusy = false;
      this._render();
    }
  }

  _toggleCurrentFavorite() {
    const target = this._currentFavoriteTarget();
    if (!target) return;
    const active = this._favorites.some((favorite) => this._favoriteMatches(favorite, target));
    this._setFavorite(target, !active);
  }

  _openFavorite(favoriteId) {
    const favorite = this._favorites.find((entry) => entry.id === favoriteId);
    if (!favorite || this._favoritePresentation(favorite).missing) return;
    this._dialog = null;
    this._error = "";
    this._selectedListId = null;
    this._selectedCategoryId = null;
    this._categoryRules = [];
    this._categoryProducts = [];
    this._listAssignmentGroups = [];
    this._activeSection = favorite.section;
    if (favorite.section === "lists" && favorite.target_id) {
      this._selectedListId = favorite.target_id;
      this._listDetailTab = favorite.tab === "items" ? "items" : "overview";
      this._items = [];
      this._render();
      const list = this._findList(favorite.target_id);
      if (list?.list_type === "inventory") {
        this._selectedInventoryListId = list.id;
        this._inventoryEntries = [];
        this._inventoryGroups = [];
        this._loadInventory();
      } else {
        this._loadItems();
        this._loadListAssignments(list.id);
      }
      this._loadDashboardUsages();
      return;
    }
    if (favorite.section === "categories") {
      if (favorite.target_id) {
        const category = this._findCategory(favorite.target_id);
        if (!category) return;
        this._openCategoryProductsPage(category, ["rules", "products"].includes(favorite.tab) ? favorite.tab : "rules");
        return;
      }
      this._categoryTab = favorite.tab || "global";
    } else if (favorite.section === "labels") this._labelTab = favorite.tab || "global";
    else if (favorite.section === "chips") this._chipTab = favorite.tab || "global";
    else if (favorite.section === "history") this._scanHistoryTab = favorite.tab || "history";
    else if (favorite.section === "notifications") this._notificationTab = favorite.tab || "profiles";
    this._render();
    if (favorite.section === "categories" && this._categoryTab === "specific") {
      this._categorySpecificListId = this._categorySpecificListId || this._lists[0]?.id || "";
      if (this._categorySpecificListId) this._loadListAssignments(this._categorySpecificListId, true);
    }
    if (favorite.section === "products" && !this._productsLoaded) this._loadProducts();
    if (favorite.section === "history" && !this._scanHistoryLoaded) this._loadScanHistory();
    if (favorite.section === "backup") this._loadDataBackupInfo();
  }

  _renderOverview() {
    return `${this._heading("mdi:view-dashboard-outline", haListManagerPanelText("ui.overview", {}, this._hass), haListManagerPanelText("ui.reopen_frequent_sections", {}, this._hass))}${this._inlineError()}${this._renderFavoriteShortcuts()}`;
  }

  _renderStatistics() {
    const info = this._info || {};
    const stats = info.statistics || {};
    const value = (name, fallback = 0) => Number(stats[name] ?? fallback);
    return `${this._heading("mdi:chart-box-outline", haListManagerPanelText("ui.statistics", {}, this._hass), haListManagerPanelText("ui.overview_description", {}, this._hass))}${this._inlineError()}
      <h3 class="overview-section-title">${haListManagerPanelText("ui.lists_and_entries", {}, this._hass)}</h3>
      <div class="overview-grid">
        ${this._overviewCard("mdi:format-list-bulleted", haListManagerPanelText("ui.lists", {}, this._hass), value("lists_total", info.list_count ?? this._lists.length), [
          [haListManagerPanelText("ui.shopping", {}, this._hass), value("lists_shopping")], [haListManagerPanelText("ui.bring", {}, this._hass), value("lists_bring")], [haListManagerPanelText("ui.tasks", {}, this._hass), value("lists_todo")], [haListManagerPanelText("ui.inventory", {}, this._hass), value("lists_inventory")],
        ])}
        ${this._overviewCard("mdi:format-list-checks", haListManagerPanelText("ui.shopping_task_entries", {}, this._hass), value("items_total"), [
          [haListManagerPanelText("ui.open", {}, this._hass), value("items_open")], [haListManagerPanelText("ui.completed", {}, this._hass), value("items_completed")],
        ])}
        ${this._overviewCard("mdi:playlist-edit", haListManagerPanelText("ui.entries_by_list_type", {}, this._hass), value("items_shopping") + value("items_bring") + value("items_todo"), [
          [haListManagerPanelText("ui.shopping", {}, this._hass), value("items_shopping")], [haListManagerPanelText("ui.bring", {}, this._hass), value("items_bring")], [haListManagerPanelText("ui.tasks", {}, this._hass), value("items_todo")],
        ])}
        ${this._overviewCard("mdi:package-variant-closed", haListManagerPanelText("inventory.products_in_inventory", {}, this._hass), value("inventory_entries"), [
          [haListManagerPanelText("ui.total_stock", {}, this._hass), value("inventory_stock")], [haListManagerPanelText("inventory.below_minimum", {}, this._hass), value("inventory_below_minimum")],
        ], value("inventory_below_minimum") > 0 ? "warning" : "")}
      </div>
      <h3 class="overview-section-title">${haListManagerPanelText("products.database_and_assignments", {}, this._hass)}</h3>
      <div class="overview-grid">
        ${this._overviewCard("mdi:barcode-scan", haListManagerPanelText("products.saved_products", {}, this._hass), value("products_total", info.product_count ?? this._products.length), [
          [haListManagerPanelText("ui.with_ean", {}, this._hass), value("products_with_ean")], [haListManagerPanelText("ui.without_ean", {}, this._hass), Math.max(0, value("products_total", info.product_count ?? this._products.length) - value("products_with_ean"))],
        ])}
        ${this._overviewCard("mdi:link-variant", haListManagerPanelText("products.assigned", {}, this._hass), value("products_assigned"), [
          [haListManagerPanelText("ui.unassigned", {}, this._hass), value("products_unassigned")], [haListManagerPanelText("products.linked_list_items", {}, this._hass), value("product_item_links")],
        ])}
        ${this._overviewCard("mdi:shape-outline", haListManagerPanelText("ui.categories", {}, this._hass), value("categories_saved", info.category_count ?? this._categories.length), [
          [haListManagerPanelText("ui.dynamic_in_lists", {}, this._hass), value("categories_dynamic")],
        ])}
        ${this._overviewCard("mdi:label-multiple-outline", haListManagerPanelText("ui.labels", {}, this._hass), value("labels_total", info.label_count ?? this._labels.length), [
          [haListManagerPanelText("ui.assignments", {}, this._hass), value("label_assignments")],
        ])}
      </div>
      <h3 class="overview-section-title">${haListManagerPanelText("ui.scanners_and_notifications", {}, this._hass)}</h3>
      <div class="overview-grid">
        ${this._overviewCard("mdi:barcode", haListManagerPanelText("ui.scanner", {}, this._hass), value("scanners_total", this._scanners.length), [
          [haListManagerPanelText("ui.active", {}, this._hass), value("scanners_enabled")], [haListManagerPanelText("ui.pending_scans", {}, this._hass), value("scans_pending")], [haListManagerPanelText("ui.scan_history_count", {}, this._hass), value("scans_total")],
        ], value("scans_pending") > 0 ? "warning" : "")}
        ${this._overviewCard("mdi:bell-outline", haListManagerPanelText("ui.delivery_targets", {}, this._hass), value("notification_profiles", this._notificationProfiles.length), [
          [haListManagerPanelText("ui.list_assignments", {}, this._hass), value("notification_assignments", this._notificationAssignments.length)],
        ])}
      </div>
      <p class="overview-note"><ha-icon icon="mdi:database-lock-outline"></ha-icon><span>${haListManagerPanelText("help.local_data_bring_sync", {}, this._hass)}</span></p>`;
  }

  _renderEntityHistory() {
    const query = this._entityHistorySearch.trim().toLocaleLowerCase();
    const matches = (record) => `${this._hass?.states?.[record.entity_id]?.attributes?.friendly_name || ""} ${record.entity_id}`.toLocaleLowerCase().includes(query);
    const rows = this._trackedEntities.map((record) => {
      const state = this._hass?.states?.[record.entity_id];
      const name = state?.attributes?.friendly_name || record.entity_id;
      const domain = record.entity_id.split(".", 1)[0];
      const booleanDomains = new Set(["automation", "binary_sensor", "fan", "input_boolean", "light", "switch"]);
      const currentValue = state?.state;
      const booleanValue = ["on", "off", "true", "false"].includes(String(currentValue || "").toLowerCase());
      const valueType = booleanDomains.has(domain) || booleanValue
        ? haListManagerPanelText("ui.on_off", {}, this._hass)
        : currentValue !== undefined && currentValue !== "" && Number.isFinite(Number(currentValue))
          ? haListManagerPanelText("ui.number", {}, this._hass)
          : haListManagerPanelText("ui.text", {}, this._hass);
      const period = record.first_recorded_at && record.last_recorded_at
        ? haListManagerPanelText("ui.range_from_to", {p0:(this._formatDue(record.first_recorded_at)), p1:(this._formatDue(record.last_recorded_at))}, this._hass)
        : haListManagerPanelText("ui.no_time_range_yet", {}, this._hass);
      const details = [
        haListManagerPanelText("history.data_point_count", {p0:(Number(record.sample_count || 0).toLocaleString(haListManagerPanelTextLocale(this._hass)))}, this._hass),
        ...(record.hidden_count ? [haListManagerPanelText("history.hidden_count", { count: record.hidden_count }, this._hass)] : []),
        valueType,
        period,
      ].join(" · ");
      return `<div class="entity-history-row" data-entity-history-row data-history-search-value="${this._escape(`${name} ${record.entity_id}`.toLocaleLowerCase())}" ${matches(record) ? "" : "hidden"}>
        <div class="entity-history-icon"><ha-icon icon="${this._escape(state?.attributes?.icon || "mdi:chart-timeline-variant")}"></ha-icon></div>
        <div class="entity-history-details"><strong>${this._escape(name)}</strong><code>${this._escape(record.entity_id)}</code><small>${this._escape(details)}</small></div>
        <div class="entity-history-actions"><button class="ha-button compact" type="button" data-entity-samples="${this._escape(record.entity_id)}"><ha-icon icon="mdi:table-edit"></ha-icon>${haListManagerPanelText("history.measurements", {}, this._hass)}</button><button class="ha-button compact" type="button" data-import-entity-history="${this._escape(record.entity_id)}"><ha-icon icon="mdi:database-import-outline"></ha-icon>${haListManagerPanelText("history.fill", {}, this._hass)}</button><button class="ha-button ${record.enabled ? "" : "primary"}" type="button" data-toggle-entity-history="${this._escape(record.entity_id)}" data-enabled="${record.enabled ? "1" : "0"}">
          <ha-icon icon="${record.enabled ? "mdi:pause" : "mdi:play"}"></ha-icon>${record.enabled ? haListManagerPanelText("ui.pause", {}, this._hass) : haListManagerPanelText("history.resume", {}, this._hass)}
        </button><button class="icon-button danger" type="button" title="${haListManagerPanelText("history.delete_archive", {}, this._hass)}" data-delete-entity-history="${this._escape(record.entity_id)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>
      </div>`;
    }).join("");
    const header = `${this._heading("mdi:database-clock-outline", haListManagerPanelText("ui.entity_inventory", {}, this._hass), haListManagerPanelText("help.history_independent_storage", {}, this._hass))}<div class="scan-history-tabs label-tabs" role="tablist">${[["add", "mdi:database-plus-outline", haListManagerPanelText("history.tab_add", {}, this._hass)], ["manage", "mdi:table-cog", haListManagerPanelText("history.tab_manage", {}, this._hass)]].map(([id, icon, label]) => `<button type="button" role="tab" data-entity-history-tab="${id}" class="${this._entityHistoryTab === id ? "active" : ""}" aria-selected="${this._entityHistoryTab === id}"><ha-icon icon="${icon}"></ha-icon>${label}${id === "manage" ? `<span>${this._trackedEntities.length}</span>` : ""}</button>`).join("")}</div>${this._inlineError()}`;
    if (this._entityHistoryTab === "add") return `${header}<ha-card class="entity-history-intro"><div><strong>${haListManagerPanelText("ui.unchanged_original_values", {}, this._hass)}</strong><p>${haListManagerPanelText("help.history_sample_storage", {}, this._hass)}</p></div></ha-card>
      <ha-card class="entity-history-add"><ha-entity-picker data-entity-history-picker></ha-entity-picker><button class="ha-button primary" type="button" data-add-entity-history><ha-icon icon="mdi:database-plus-outline"></ha-icon>${haListManagerPanelText("history.record", {}, this._hass)}</button></ha-card>`;
    return `${header}<div class="search-field"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-entity-history-search aria-label="${haListManagerPanelText("history.search_entities", {}, this._hass)}" placeholder="${haListManagerPanelText("history.search_entities", {}, this._hass)}" value="${this._escape(this._entityHistorySearch)}"></div>
      <ha-card class="entity-history-list" data-entity-history-list ${this._trackedEntities.some(matches) ? "" : "hidden"}>${rows}</ha-card>
      <ha-card class="empty-state compact" data-entity-history-empty ${this._trackedEntities.some(matches) ? "hidden" : ""}><ha-icon icon="mdi:database-clock-outline"></ha-icon><h3>${this._trackedEntities.length ? haListManagerPanelText("history.no_matching_entities", {}, this._hass) : haListManagerPanelText("history.no_entity_selected", {}, this._hass)}</h3></ha-card>`;
  }

  _filterEntityHistoryRows() {
    const query = this._entityHistorySearch.trim().toLocaleLowerCase();
    let visible = 0;
    this.shadowRoot.querySelectorAll("[data-entity-history-row]").forEach((row) => {
      row.hidden = !row.dataset.historySearchValue.includes(query);
      if (!row.hidden) visible += 1;
    });
    const list = this.shadowRoot.querySelector("[data-entity-history-list]");
    if (list) list.hidden = !visible;
    const empty = this.shadowRoot.querySelector("[data-entity-history-empty]");
    if (empty) empty.hidden = Boolean(visible);
  }

  _entitySampleSource(record) {
    const source = record.original_source || record.source;
    const label = source === "long_term_statistics" ? haListManagerPanelText("history.hourly", {}, this._hass)
      : source === "manual" ? haListManagerPanelText("history.manual", {}, this._hass)
      : source === "recorder" ? haListManagerPanelText("history.recorder", {}, this._hass) : haListManagerPanelText("history.live", {}, this._hass);
    return record.source === "corrected" ? `${label} · ${haListManagerPanelText("history.corrected", {}, this._hass)}` : label;
  }

  async _openEntitySamples(entityId) {
    this._error = "";
    const dialog = { kind: "entity-samples", entity_id: entityId, records: [], cursors: [], before_id: null,
      from: "", until: "", show_hidden: false, loading: false, truncated: false, scroll_top: 0, status: "", error: "" };
    this._dialog = dialog;
    await this._loadEntitySamples(dialog);
  }

  async _loadEntitySamples(dialog) {
    dialog.loading = true;
    dialog.error = "";
    this._render();
    try {
      if (dialog.from && dialog.until && dialog.from > dialog.until) throw new Error(haListManagerPanelText("history.invalid_range", {}, this._hass));
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/get`, entity_id: dialog.entity_id,
        latest: true, limit: 100, include_hidden: Boolean(dialog.show_hidden), ...(dialog.before_id ? { before_id: dialog.before_id } : {}),
        ...(dialog.from ? { start_time: new Date(`${dialog.from}T00:00:00`).toISOString() } : {}),
        ...(dialog.until ? { end_time: new Date(`${dialog.until}T23:59:59.999`).toISOString() } : {}),
      });
      if (this._dialog !== dialog) return;
      dialog.records = (result.states || []).slice().reverse();
      dialog.truncated = Boolean(result.truncated);
    } catch (error) {
      dialog.error = this._formatError(error);
    } finally {
      dialog.loading = false;
      if (this._dialog === dialog) this._render();
    }
  }

  _renderEntitySamples() {
    const dialog = this._dialog;
    const name = this._hass?.states?.[dialog.entity_id]?.attributes?.friendly_name || dialog.entity_id;
    const rows = dialog.records.map((record) => `<div class="entity-sample-row ${record.hidden ? "sample-hidden" : ""}"><div>${record.hidden ? `<span class="entity-sample-hidden"><ha-icon icon="mdi:eye-off-outline"></ha-icon>${haListManagerPanelText("history.hidden", {}, this._hass)}</span>` : ""}<strong>${this._escape(record.state)} ${this._escape(record.attributes?.unit_of_measurement || "")}</strong><small>${this._escape(new Intl.DateTimeFormat(haListManagerPanelTextLocale(this._hass), { dateStyle: "short", timeStyle: "medium" }).format(new Date(record.last_updated)))}</small><small>${this._escape(this._entitySampleSource(record))}</small></div><button class="icon-button" type="button" data-edit-entity-sample="${record.id}" title="${haListManagerPanelText("history.edit_sample", {}, this._hass)}" aria-label="${haListManagerPanelText("history.edit_sample", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button></div>`).join("");
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog entity-samples-dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(haListManagerPanelText("history.measurements", {}, this._hass))}<p><strong>${this._escape(name)}</strong></p><p class="field-help">${haListManagerPanelText("history.archive_help", {}, this._hass)}</p><details class="entity-sample-filters" data-history-filters ${dialog.filter_open ? "open" : ""}><summary>${haListManagerPanelText("history.date_filter", {}, this._hass)}</summary><div class="field-grid"><label class="field"><span>${haListManagerPanelText("history.from", {}, this._hass)}</span><input type="date" data-history-range="from" value="${this._escape(dialog.from)}"></label><label class="field"><span>${haListManagerPanelText("history.until", {}, this._hass)}</span><input type="date" data-history-range="until" value="${this._escape(dialog.until)}"></label></div><div class="dialog-actions"><button class="ha-button" type="button" data-history-filter ${dialog.loading ? "disabled" : ""}><ha-icon icon="mdi:filter-outline"></ha-icon>${haListManagerPanelText("history.apply_filter", {}, this._hass)}</button></div></details><div class="dialog-actions"><button class="ha-button primary" type="button" data-add-entity-sample ${dialog.loading ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("history.add_sample", {}, this._hass)}</button></div><label class="entity-sample-visibility"><input type="checkbox" data-show-hidden-samples ${dialog.show_hidden ? "checked" : ""} ${dialog.loading ? "disabled" : ""}>${haListManagerPanelText("history.show_hidden", {}, this._hass)}</label><small>${haListManagerPanelText("history.page_help", {}, this._hass)}</small>${dialog.error ? `<div class="inline-error">${this._escape(dialog.error)}</div>` : ""}${dialog.status ? `<div class="entity-sample-status" role="status">${this._escape(dialog.status)}</div>` : ""}<div class="entity-samples-list">${dialog.loading ? haListManagerPanelText("history.loading", {}, this._hass) : rows || haListManagerPanelText("history.no_samples", {}, this._hass)}</div><div class="dialog-actions"><button class="ha-button" type="button" data-history-newer ${!dialog.cursors.length || dialog.loading ? "disabled" : ""}>${haListManagerPanelText("history.newer", {}, this._hass)}</button><button class="ha-button" type="button" data-history-older ${!dialog.truncated || dialog.loading ? "disabled" : ""}>${haListManagerPanelText("history.older", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.close", {}, this._hass)}</button></div></section></div>`;
  }

  _entitySampleLocalTime(timestamp) {
    const date = new Date(timestamp);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
  }

  _openEntitySampleEditor(record = null) {
    const parent = this._dialog;
    const attributes = record?.attributes || parent.records[0]?.attributes || this._hass?.states?.[parent.entity_id]?.attributes || {};
    const localTime = this._entitySampleLocalTime(record?.last_updated || new Date().toISOString());
    this._dialog = { kind: "entity-sample-editor", entity_id: parent.entity_id, record, return_dialog: parent,
      initial_time: localTime, draft: { hidden: Boolean(record?.hidden), state: record?.state || "", timestamp: localTime, attributes: JSON.stringify(attributes, null, 2) }, error: "" };
    this._render();
    this.shadowRoot.querySelector('[data-history-field="state"]')?.focus({ preventScroll: true });
  }

  _renderEntitySampleEditor() {
    const { record, draft, error } = this._dialog;
    const original = record?.original;
    const manual = record && (record.original_source || record.source) === "manual";
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(record ? haListManagerPanelText("history.edit_sample", {}, this._hass) : haListManagerPanelText("history.add_sample", {}, this._hass))}<p class="field-help">${haListManagerPanelText("history.archive_help", {}, this._hass)}</p>${record ? `<p>${this._escape(haListManagerPanelText("history.source", { source: this._entitySampleSource(record) }, this._hass))}</p>` : ""}<label class="field"><span>${haListManagerPanelText("history.sample_state", {}, this._hass)}</span><input type="text" maxlength="255" required data-history-field="state" value="${this._escape(draft.state)}"><small>${haListManagerPanelText("history.state_help", {}, this._hass)}</small></label><label class="field"><span>${haListManagerPanelText("history.sample_time", {}, this._hass)}</span><input type="datetime-local" required step="0.001" data-history-field="timestamp" value="${this._escape(draft.timestamp)}"></label><details class="entity-sample-attributes"><summary>${haListManagerPanelText("history.attributes", {}, this._hass)}</summary><label class="field"><small>${haListManagerPanelText("history.attributes_help", {}, this._hass)}</small><textarea rows="6" data-history-field="attributes">${this._escape(draft.attributes)}</textarea></label></details>${record && !manual ? `<label class="entity-sample-visibility"><input type="checkbox" data-hide-entity-sample ${draft.hidden ? "checked" : ""}>${haListManagerPanelText("history.hidden", {}, this._hass)}</label><p class="field-help">${haListManagerPanelText("history.hide_help", {}, this._hass)}</p>` : ""}${original ? `<details class="entity-sample-attributes"><summary>${haListManagerPanelText("history.corrected", {}, this._hass)}</summary><p>${this._escape(haListManagerPanelText("history.original", { state: original.state, time: this._formatDue(original.last_updated) }, this._hass))}</p><strong>${haListManagerPanelText("history.original_attributes", {}, this._hass)}</strong><pre>${this._escape(JSON.stringify(original.attributes, null, 2))}</pre></details>` : ""}${error ? `<div class="inline-error" role="alert">${this._escape(error)}</div>` : ""}<div class="dialog-actions">${manual ? `<button class="ha-button destructive" type="button" data-delete-entity-sample ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:delete-outline"></ha-icon>${haListManagerPanelText("history.delete_sample", {}, this._hass)}</button>` : ""}<button class="ha-button primary" type="button" data-save-entity-sample ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  async _saveEntitySample() {
    if (this._busy || this._dialog?.kind !== "entity-sample-editor") return;
    const dialog = this._dialog;
    const { draft, record } = dialog;
    let attributes, timestamp;
    try {
      attributes = JSON.parse(draft.attributes);
      if (!attributes || Array.isArray(attributes) || typeof attributes !== "object") throw new Error();
    } catch (_error) {
      dialog.error = haListManagerPanelText("history.invalid_attributes", {}, this._hass); this._render(); return;
    }
    try {
      timestamp = record && draft.timestamp === dialog.initial_time ? record.last_updated : new Date(draft.timestamp).toISOString();
    } catch (_error) {
      dialog.error = haListManagerPanelText("history.invalid_time", {}, this._hass); this._render(); return;
    }
    this._busy = true;
    dialog.error = "";
    const saveButton = this.shadowRoot.querySelector("[data-save-entity-sample]");
    if (saveButton) saveButton.disabled = true;
    try {
      const state = /^[-+]?\d+,\d+$/.test(draft.state.trim()) ? draft.state.trim().replace(",", ".") : draft.state;
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/sample/save`, entity_id: dialog.entity_id,
        state, attributes, timestamp, ...(record ? { record_id: record.id } : {}),
        ...(record && (record.original_source || record.source) !== "manual" ? { hidden: Boolean(draft.hidden) } : {}) });
      this._dialog = dialog.return_dialog;
      this._dialog.status = haListManagerPanelText("history.saved", {}, this._hass);
      await this._loadEntitySamples(this._dialog);
      const list = await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/list` });
      this._trackedEntities = list.entities || [];
    } catch (error) {
      this._dialog.error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _openDeleteEntitySample() {
    const editor = this._dialog;
    if (this._busy || editor?.kind !== "entity-sample-editor" || !editor.record) return;
    this._dialog = { kind: "entity-sample-delete", record: editor.record, entity_id: editor.entity_id, return_dialog: editor, error: "" };
    this._render();
  }

  _renderDeleteEntitySample() {
    const { record, error } = this._dialog;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog" role="alertdialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(haListManagerPanelText("history.delete_title", {}, this._hass))}<p><strong>${this._escape(record.state)}</strong> · ${this._escape(this._formatDue(record.last_updated))}</p><p class="field-help">${haListManagerPanelText("history.delete_help", {}, this._hass)}</p>${error ? `<div class="inline-error" role="alert">${this._escape(error)}</div>` : ""}<div class="dialog-actions"><button class="ha-button destructive" type="button" data-confirm-delete-entity-sample ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:delete-outline"></ha-icon>${haListManagerPanelText("ui.delete", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  async _deleteEntitySample() {
    if (this._busy || this._dialog?.kind !== "entity-sample-delete") return;
    const dialog = this._dialog;
    this._busy = true;
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/sample/delete`, entity_id: dialog.entity_id, record_id: dialog.record.id });
      this._dialog = dialog.return_dialog.return_dialog;
      this._dialog.status = haListManagerPanelText("history.deleted", {}, this._hass);
      await this._loadEntitySamples(this._dialog);
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/list` });
      this._trackedEntities = result.entities || [];
    } catch (error) {
      this._dialog.error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setEntityTracking(entityId, enabled, askImport = false) {
    if (!entityId || this._busy) return;
    this._busy = true;
    this._error = "";
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/set`, entity_id: entityId, enabled });
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/list` });
      this._trackedEntities = result.entities || [];
      if (enabled) {
        this._entityHistoryCandidate = "";
        if (this._entityHistoryTab === "add") this._entityHistorySearch = "";
        this._entityHistoryTab = "manage";
        if (askImport) this._dialog = { kind: "entity-history-import-choice", entity_id: entityId, completed: false, status: "", error: "" };
      }
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _deleteEntityHistory(entityId) {
    if (!entityId || this._busy || !window.confirm(haListManagerPanelText("history.confirm_delete_archive", {p0:(entityId)}, this._hass))) return;
    this._busy = true;
    this._error = "";
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/delete`, entity_id: entityId });
      this._trackedEntities = this._trackedEntities.filter((record) => record.entity_id !== entityId);
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _openEntityHistoryImport(entityId) {
    if (!entityId || this._busy) return;
    this._error = "";
    this._dialog = { kind: "entity-history-import", entity_id: entityId,
      draft: { ...this._entityHistoryImportOptions }, completed: false, status: "", error: "" };
    this._render();
  }

  _renderEntityHistoryImport() {
    const dialog = this._dialog;
    const choice = dialog.kind === "entity-history-import-choice";
    const name = this._hass?.states?.[dialog.entity_id]?.attributes?.friendly_name || dialog.entity_id;
    const draft = dialog.draft || {};
    const title = dialog.completed ? haListManagerPanelText("history.import_finished", {}, this._hass) : choice ? haListManagerPanelText("history.import_question", {}, this._hass) : haListManagerPanelText("history.backfill", {}, this._hass);
    const form = choice ? `<p class="field-help">${haListManagerPanelText("history.import_choice_help", {}, this._hass)}</p>` : `<p class="field-help">${haListManagerPanelText("help.history_import_missing", {}, this._hass)}</p>
      <div class="field-grid"><label class="field"><span>${haListManagerPanelText("ui.from_optional", {}, this._hass)}</span><input type="date" data-history-import-field="start" value="${this._escape(draft.start)}" ${this._busy ? "disabled" : ""}></label><label class="field"><span>${haListManagerPanelText("ui.until_inclusive_optional", {}, this._hass)}</span><input type="date" data-history-import-field="end" value="${this._escape(draft.end)}" ${this._busy ? "disabled" : ""}></label></div>
      <div class="entity-history-import-sources"><label><input type="checkbox" data-history-import-field="recorder" ${draft.recorder ? "checked" : ""} ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.recorder_states_attributes", {}, this._hass)}</label><label><input type="checkbox" data-history-import-field="statistics" ${draft.statistics ? "checked" : ""} ${this._busy ? "disabled" : ""}>${haListManagerPanelText("history.add_long_term_statistics", {}, this._hass)}</label></div>
      <p class="field-help">${haListManagerPanelText("help.imported_hourly_statistics", {}, this._hass)}</p>`;
    const actions = dialog.completed ? `<button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.close", {}, this._hass)}</button>`
      : choice ? `<button class="ha-button primary" type="button" data-history-import-complete ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:database-import-outline"></ha-icon>${haListManagerPanelText("history.import_complete", {}, this._hass)}</button><button class="ha-button" type="button" data-history-import-select ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:calendar-range"></ha-icon>${haListManagerPanelText("history.import_selection", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog ${this._busy ? "disabled" : ""}>${haListManagerPanelText("history.import_no", {}, this._hass)}</button>`
      : `<button class="ha-button primary" type="button" data-history-import-run ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:database-import-outline"></ha-icon>${haListManagerPanelText("history.fill", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button>`;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog entity-import-dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(title)}<p><strong>${this._escape(name)}</strong></p><p class="field-help entity-import-id">${this._escape(dialog.entity_id)}</p>${dialog.completed ? "" : form}${dialog.status ? `<div class="entity-import-status" role="status">${this._escape(dialog.status)}</div>` : ""}${dialog.error ? `<div class="inline-error" role="alert">${this._escape(dialog.error)}</div>` : ""}<div class="dialog-actions">${actions}</div></section></div>`;
  }

  _entityHistoryImportSummary(result) {
    const parts = [];
    const summary = (label, counts) => {
      const values = [haListManagerPanelText("history.imported_count", { count: Number(counts.imported || 0) }, this._hass)];
      if (counts.updated) values.push(haListManagerPanelText("history.imported_values_replaced", {p0: counts.updated}, this._hass));
      if (counts.already_stored) values.push(haListManagerPanelText("history.timestamps_already_saved", {p0: counts.already_stored}, this._hass));
      if (counts.unchanged) values.push(haListManagerPanelText("ui.discarded_unchanged", {p0: counts.unchanged}, this._hass));
      if (!counts.imported && !counts.updated && !counts.already_stored && !counts.unchanged) values.push(haListManagerPanelText("ui.no_data_found_lowercase", {}, this._hass));
      return `${label}: ${values.join(", ")}`;
    };
    if (result.recorder) parts.push(summary(haListManagerPanelText("ui.recorder", {}, this._hass), result.recorder));
    if (result.long_term_statistics) parts.push(summary(haListManagerPanelText("history.long_term_statistics", {}, this._hass), result.long_term_statistics));
    if (result.truncated) parts.push(haListManagerPanelText("history.import_limit_reached", {}, this._hass));
    return parts.join(" · ");
  }

  async _importEntityHistory(entityId, options = null) {
    const dialog = this._dialog;
    if (!entityId || this._busy || !["entity-history-import", "entity-history-import-choice"].includes(dialog?.kind) || dialog.entity_id !== entityId || dialog.completed) return;
    const draft = options || dialog.draft;
    dialog.error = "";
    let range;
    try {
      if (!draft || (!draft.recorder && !draft.statistics)) throw new Error(haListManagerPanelText("errors.source_required", {}, this._hass));
      if (draft.start && draft.end && draft.start > draft.end) throw new Error(haListManagerPanelText("history.invalid_range", {}, this._hass));
      range = { ...(draft.start ? { start_time: new Date(`${draft.start}T00:00:00`).toISOString() } : {}),
        ...(draft.end ? { end_time: new Date(`${draft.end}T23:59:59.999`).toISOString() } : {}) };
    } catch (error) {
      dialog.error = this._formatError(error); this._render(); return;
    }
    if (!options) this._entityHistoryImportOptions = { ...draft };
    this._busy = true;
    dialog.status = haListManagerPanelText("history.import_running", {}, this._hass);
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/import`, entity_id: entityId,
        ...range, include_recorder: Boolean(draft.recorder), include_long_term_statistics: Boolean(draft.statistics) });
      dialog.status = this._entityHistoryImportSummary(result);
      dialog.completed = true;
      const list = await haListManagerPanelTextRequest(this._hass, { type: `${API}/entity_history/list` });
      this._trackedEntities = list.entities || [];
    } catch (error) {
      dialog.error = this._formatError(error);
      if (!dialog.completed) dialog.status = "";
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _renderLists() {
    const rows = this._lists.map((record) => {
      const type = LIST_TYPES(this._hass)[record.list_type] || LIST_TYPES(this._hass).shopping;
      return `<article class="list-row">
        <button class="list-open" type="button" data-open-list="${record.id}">
          <span class="list-icon"><ha-icon icon="${this._escape(record.icon || type.icon)}"></ha-icon></span>
          <span class="list-details"><strong>${this._escape(record.name)}</strong><small>${type.label}</small></span>
          <ha-icon class="chevron" icon="mdi:chevron-right"></ha-icon>
        </button>
        <div class="row-actions">
          <button class="icon-button" type="button" data-list-script="${record.id}" title="${haListManagerPanelText("scripts.title", {}, this._hass)}"><ha-icon icon="mdi:script-text-outline"></ha-icon></button>
          <button class="icon-button" type="button" data-edit-list="${record.id}" title="${haListManagerPanelText("ui.edit_list", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button>
          <button class="icon-button danger" type="button" data-delete-list="${record.id}" title="${haListManagerPanelText("ui.delete_list", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
        </div>
      </article>`;
    }).join("");
    const content = this._lists.length
      ? `<ha-card class="list-card">${rows}</ha-card>`
      : `<ha-card class="empty-state"><ha-icon icon="mdi:playlist-plus"></ha-icon><h3>${haListManagerPanelText("ui.no_lists_created", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_first_list_hint", {}, this._hass)}</p><button class="ha-button primary" type="button" data-add-list><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_first_list", {}, this._hass)}</button></ha-card>`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:format-list-bulleted"></ha-icon><div><h2>${haListManagerPanelText("ui.lists", {}, this._hass)}</h2><p>${haListManagerPanelText("help.backend_list_types", {}, this._hass)}</p></div></div><button class="ha-button primary" type="button" data-add-list><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_list", {}, this._hass)}</button></section>${this._inlineError()}${content}`;
  }

  _renderListDetail() {
    const list = this._findList(this._selectedListId);
    if (!list) return this._renderLists();
    if (list.list_type === "inventory") return this._renderInventoryListDetail(list);
    const type = LIST_TYPES(this._hass)[list.list_type] || LIST_TYPES(this._hass).shopping;
    const tabs = `<div class="scan-history-tabs label-tabs list-detail-tabs" role="tablist"><button type="button" class="${this._listDetailTab === "overview" ? "active" : ""}" data-list-detail-tab="overview" role="tab" aria-selected="${this._listDetailTab === "overview"}"><ha-icon icon="mdi:view-dashboard-outline"></ha-icon>${haListManagerPanelText("ui.overview", {}, this._hass)}</button><button type="button" class="${this._listDetailTab === "items" ? "active" : ""}" data-list-detail-tab="items" role="tab" aria-selected="${this._listDetailTab === "items"}"><ha-icon icon="mdi:format-list-checks"></ha-icon>${haListManagerPanelText("ui.entries", {}, this._hass)}<span>${this._items.length}</span></button></div>`;
    const body = this._listDetailTab === "items"
      ? this._renderListItemsTab(list, type)
      : this._renderListOverview(list);
    return `<button class="back-button" type="button" data-back-lists><ha-icon icon="mdi:arrow-left"></ha-icon>${haListManagerPanelText("ui.back_to_lists", {}, this._hass)}</button>
      <section class="content-header with-action"><div class="heading-wrap"><span class="detail-icon"><ha-icon icon="${this._escape(list.icon || type.icon)}"></ha-icon></span><div><h2>${this._escape(list.name)}</h2><p>${type.label}</p></div></div><div class="header-actions"><button class="ha-button" type="button" data-list-script="${list.id}"><ha-icon icon="mdi:script-text-outline"></ha-icon>${haListManagerPanelText("scripts.title", {}, this._hass)}</button><button class="ha-button" type="button" data-edit-current-list><ha-icon icon="mdi:pencil"></ha-icon>${haListManagerPanelText("ui.edit_list", {}, this._hass)}</button><button class="ha-button primary" type="button" data-add-item><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_entry", {}, this._hass)}</button></div></section>
      ${tabs}${this._inlineError()}${body}`;
  }

  _renderListItemsTab(list, type) {
    const searchPlaceholder = list.list_type === "bring"
      ? haListManagerPanelText("ui.name_category_label", {}, this._hass)
      : haListManagerPanelText("ui.task_search_fields", {}, this._hass);
    const search = this._listItemSearch.trim().toLocaleLowerCase();
    const filteredItems = (search
      ? this._items.filter((item) => [item.name, item.description, item.category, ...(item.labels || []).map((label) => label.name)]
        .some((value) => String(value || "").toLocaleLowerCase().includes(search)))
      : [...this._items]);
    filteredItems.sort((left, right) => left.name.localeCompare(right.name, haListManagerPanelTextLocale(this._hass), { sensitivity: "base", numeric: true }));
    const rows = filteredItems.map((item) => this._renderItemRow(item, list.list_type)).join("");
    const content = this._itemsLoading
      ? this._loadingCard(haListManagerPanelText("ui.entries_loading", {}, this._hass))
      : filteredItems.length
        ? `<ha-card class="list-card item-card">${rows}</ha-card>`
        : this._items.length
          ? `<ha-card class="empty-state"><ha-icon icon="mdi:magnify-close"></ha-icon><h3>${haListManagerPanelText("ui.no_entry_matches", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.change_search_more_entries", {}, this._hass)}</p></ha-card>`
          : `<ha-card class="empty-state"><ha-icon icon="mdi:text-box-plus-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_entries", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.list_empty", {p0:(type.label)}, this._hass)}</p><button class="ha-button primary" data-add-item><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_first_entry", {}, this._hass)}</button></ha-card>`;
    return `<div class="search-field"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-list-item-search value="${this._escape(this._listItemSearch)}" placeholder="${searchPlaceholder}"></div>${content}`;
  }

  _renderListScopePills(records, kind) {
    if (!records.length) return `<p class="muted-copy">${haListManagerPanelText("ui.no_own_list_definitions", {p0:(kind === "category" ? haListManagerPanelText("ui.categories", {}, this._hass) : kind === "label" ? haListManagerPanelText("ui.labels", {}, this._hass) : haListManagerPanelText("ui.chips", {}, this._hass))}, this._hass)}</p>`;
    return `<div class="list-scope-pills">${records.map((record) => {
      const action = kind === "category" ? `data-manage-category-detail="${record.id}"` : kind === "label" ? `data-edit-label="${record.id}"` : `data-edit-chip="${record.id}"`;
      const icon = kind === "chip" ? "mdi:gesture-tap-button" : record.icon || (kind === "category" ? "mdi:shape-outline" : "mdi:label-outline");
      return `<button type="button" ${action} style="${record.color ? `--scope-color:${this._escape(record.color)}` : ""}"><ha-icon icon="${this._escape(icon)}"></ha-icon><span>${this._escape(record.name)}</span></button>`;
    }).join("")}</div>`;
  }

  _listAssignmentTotals() {
    return this._listAssignmentGroups.reduce((totals, group) => ({
      rules: totals.rules + group.rules.length,
      products: totals.products + group.products.length,
    }), { rules: 0, products: 0 });
  }

  _renderListAssignmentLinks(list) {
    const totals = this._listAssignmentTotals();
    const count = (value) => this._listAssignmentsLoading ? "…" : value;
    const summary = list.list_type === "todo"
      ? `${count(totals.rules)} ${totals.rules === 1 ? haListManagerPanelText("ui.rule", {}, this._hass) : haListManagerPanelText("ui.rules", {}, this._hass)}`
      : `${count(totals.rules)} ${totals.rules === 1 ? haListManagerPanelText("ui.rule", {}, this._hass) : haListManagerPanelText("ui.rules", {}, this._hass)} · ${count(totals.products)} ${totals.products === 1 ? haListManagerPanelText("ui.product", {}, this._hass) : haListManagerPanelText("ui.products", {}, this._hass)}`;
    return `<div class="list-assignment-links">
      <button type="button" data-open-list-assignments><ha-icon icon="mdi:link-variant"></ha-icon><span class="list-assignment-link-copy"><span>${haListManagerPanelText("products.manage_assignments", {}, this._hass)}</span><strong>${summary}</strong></span></button>
    </div>`;
  }

  _renderListAvailability(list, categoryCount, labelCount, chipCount) {
    const typeLabel = list.list_type === "bring" ? haListManagerPanelText("ui.shopping_list", {}, this._hass) : (LIST_TYPES(this._hass)[list.list_type]?.label || haListManagerPanelText("ui.list_type", {}, this._hass));
    const toggle = (key, enabled, row, column) => `<button class="list-availability-toggle ${enabled ? "enabled" : "disabled"}" type="button" data-toggle-list-scope="${key}" title="${this._escape(`${row}: ${column} ${enabled ? haListManagerPanelText("ui.deactivate_verb", {}, this._hass) : haListManagerPanelText("ui.activate_verb", {}, this._hass)}`)}" aria-label="${this._escape(`${row}: ${column}, derzeit ${enabled ? haListManagerPanelText("ui.enabled_click_disable", {}, this._hass) : haListManagerPanelText("ui.disabled_click_enable", {}, this._hass)}`)}"><ha-icon icon="mdi:${enabled ? "check-circle" : "circle-outline"}"></ha-icon></button>`;
    const own = (count, row) => `<span class="list-availability-own" title="${this._escape(`${count} eigene ${row}`)}"><ha-icon icon="mdi:check-circle"></ha-icon><strong>${count}</strong></span>`;
    const chipLabel = list.list_type === "todo" ? haListManagerPanelText("todo.templates_title", {}, this._hass) : haListManagerPanelText("ui.item_chips", {}, this._hass);
    const globalChipCell = list.list_type === "todo" ? `<span class="list-availability-own" title="${haListManagerPanelText("ui.global_chips_exclude_todo", {}, this._hass)}">–</span>` : toggle("use_global_chips", list.use_global_chips, chipLabel, haListManagerPanelText("ui.general_items", {}, this._hass));
    return `<ha-card class="detail-section list-availability"><div class="section-heading"><div><h3>${haListManagerPanelText("ui.available_content", {}, this._hass)}</h3><p>${haListManagerPanelText("help.content_enablement", {}, this._hass)}</p></div></div>
      <div class="list-availability-matrix" role="table" aria-label="${haListManagerPanelText("ui.available_content", {}, this._hass)}">
        <span class="matrix-corner" aria-hidden="true"></span><strong role="columnheader">${haListManagerPanelText("ui.global", {}, this._hass)}</strong><strong role="columnheader">${this._escape(typeLabel)}</strong><strong role="columnheader">${haListManagerPanelText("ui.custom", {}, this._hass)}</strong>
        <strong role="rowheader">${haListManagerPanelText("ui.categories", {}, this._hass)}</strong>${toggle("use_global_categories", list.use_global_categories, haListManagerPanelText("ui.categories", {}, this._hass), haListManagerPanelText("ui.global", {}, this._hass))}${toggle("use_type_categories", list.use_type_categories, haListManagerPanelText("ui.categories", {}, this._hass), typeLabel)}${own(categoryCount, haListManagerPanelText("ui.categories", {}, this._hass))}
        <strong role="rowheader">${haListManagerPanelText("ui.labels", {}, this._hass)}</strong>${toggle("use_global_labels", list.use_global_labels, haListManagerPanelText("ui.labels", {}, this._hass), haListManagerPanelText("ui.global", {}, this._hass))}${toggle("use_type_labels", list.use_type_labels, haListManagerPanelText("ui.labels", {}, this._hass), typeLabel)}${own(labelCount, haListManagerPanelText("ui.labels", {}, this._hass))}
        <strong role="rowheader">${chipLabel}</strong>${globalChipCell}${toggle("use_type_chips", list.use_type_chips, chipLabel, typeLabel)}${own(chipCount, chipLabel)}
      </div>
      ${list.list_type === "shopping" && list.provider === "local" ? `<div class="list-dishes-toggle"><span><strong>${haListManagerPanelText("recipes.dishes", {}, this._hass)}</strong><small>${haListManagerPanelText("help.include_shared_dishes", {}, this._hass)}</small></span>${toggle("use_dishes", list.use_dishes, haListManagerPanelText("recipes.dishes", {}, this._hass), haListManagerPanelText("ui.this_list", {}, this._hass))}</div>` : ""}
      ${list.list_type === "shopping" && list.provider === "local" ? `<div class="list-dishes-toggle"><span><strong>${haListManagerPanelText("ui.tandoor_recipe_source", {}, this._hass)}</strong><small>${haListManagerPanelText("help.tandoor_recipe_search", {}, this._hass)}</small></span>${toggle("use_tandoor", list.use_tandoor, haListManagerPanelText("ui.tandoor_recipe_source", {}, this._hass), haListManagerPanelText("ui.this_list", {}, this._hass))}</div>` : ""}
      <p class="field-help list-availability-help">${haListManagerPanelText("help.list_content_always_active", {}, this._hass)}</p>
    </ha-card>`;
  }

  _renderDashboardUsage(list) {
    const usages = this._dashboardUsages.get(list.id) || [];
    let content;
    if (this._dashboardUsagesLoading && !this._dashboardUsagesLoaded) content = `<div class="usage-state"><ha-circular-progress active></ha-circular-progress><span>${haListManagerPanelText("ui.searching_dashboards", {}, this._hass)}</span></div>`;
    else if (this._dashboardUsagesError) content = `<div class="usage-state error-text"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${this._escape(this._dashboardUsagesError)}</span></div>`;
    else if (usages.length) content = `<div class="dashboard-usage-list">${usages.map((usage) => `<a href="${this._escape(usage.url)}"><ha-icon icon="mdi:view-dashboard-outline"></ha-icon><span><strong>${this._escape(usage.dashboard)}</strong><small>${this._escape(usage.view)}</small></span><ha-icon icon="mdi:open-in-new"></ha-icon></a>`).join("")}</div>`;
    else content = `<p class="muted-copy">${haListManagerPanelText("ui.list_dashboard_not_found", {}, this._hass)}</p>`;
    return `<ha-card class="detail-section dashboard-usage-card"><div class="section-heading"><div><h3>${haListManagerPanelText("ui.used_on", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.cards_using_list", {}, this._hass)}</p></div><button class="icon-button" type="button" data-refresh-dashboard-usages title="${haListManagerPanelText("ui.refresh_dashboard_assignments", {}, this._hass)}"><ha-icon icon="mdi:refresh"></ha-icon></button></div>${content}</ha-card>`;
  }

  _renderListOverview(list) {
    const categories = this._categories.filter((record) => record.scope === "list" && record.list_id === list.id);
    const labels = this._labels.filter((record) => record.scope === "list" && record.list_id === list.id);
    const chips = this._chips.filter((record) => record.scope === "list" && record.list_id === list.id);
    const open = this._items.filter((item) => !item.completed).length;
    const completed = this._items.length - open;
    const bringStatus = list.list_type === "bring" ? this._renderBringSyncStatus(list) : "";
    const contentCards = [
      [haListManagerPanelText("categories.own", {}, this._hass), haListManagerPanelText("help.list_own_categories", {}, this._hass), "category", categories, `<button class="icon-button" type="button" data-add-list-category title="${haListManagerPanelText("ui.add_category", {}, this._hass)}" aria-label="${haListManagerPanelText("ui.add_category", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button>`],
      [haListManagerPanelText("ui.custom_labels", {}, this._hass), haListManagerPanelText("labels.this_list_only_help", {}, this._hass), "label", labels, `<button class="icon-button" type="button" data-add-label data-label-scope="list" data-label-list-id="${list.id}" title="${haListManagerPanelText("ui.add_label", {}, this._hass)}" aria-label="${haListManagerPanelText("ui.add_label", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button>`],
      [list.list_type === "todo" ? haListManagerPanelText("todo.own_templates", {}, this._hass) : haListManagerPanelText("ui.custom_item_chips", {}, this._hass), list.list_type === "todo" ? haListManagerPanelText("help.list_todo_templates", {}, this._hass) : haListManagerPanelText("chips.this_list_quick_inputs_help", {}, this._hass), "chip", chips, `<button class="icon-button" type="button" data-add-chip data-chip-scope="list" data-chip-list-id="${list.id}" data-chip-kind="${list.list_type === "todo" ? "todo_template" : "entry"}" title="${haListManagerPanelText("ui.add_named", {p0:(list.list_type === "todo" ? haListManagerPanelText("ui.template", {}, this._hass) : haListManagerPanelText("ui.chip", {}, this._hass))}, this._hass)}" aria-label="${haListManagerPanelText("ui.add_named", {p0:(list.list_type === "todo" ? haListManagerPanelText("ui.template", {}, this._hass) : haListManagerPanelText("ui.chip", {}, this._hass))}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button>`],
    ].map(([title, description, kind, records, action]) => `<ha-card class="detail-section list-scope-card"><div class="section-heading"><div><h3>${title}</h3><p>${description}</p></div>${action}</div>${this._renderListScopePills(records, kind)}${kind === "category" ? this._renderListAssignmentLinks(list) : ""}</ha-card>`).join("");
    return `${bringStatus}<div class="inventory-detail-stats list-detail-stats"><ha-card><strong>${this._items.length}</strong><span>${haListManagerPanelText("ui.entries", {}, this._hass)}</span></ha-card><ha-card><strong>${open}</strong><span>offen</span></ha-card><ha-card><strong>${completed}</strong><span>erledigt</span></ha-card><ha-card><strong>${categories.length + labels.length + chips.length}</strong><span>${haListManagerPanelText("ui.custom_content", {}, this._hass)}</span></ha-card></div>
      <div class="list-scope-grid">${contentCards}</div>
      <div class="inventory-detail-grid list-overview-bottom">${this._renderListAvailability(list, categories.length, labels.length, chips.length)}${this._renderDashboardUsage(list)}</div>`;
  }

  _renderBringSyncStatus(list) {
    const sync = list.sync_status || {};
    const state = this._bringSyncing ? "syncing" : (sync.status || "never");
    const labels = {
      never: [haListManagerPanelText("ui.not_synced_yet", {}, this._hass), "mdi:cloud-question-outline"],
      syncing: [haListManagerPanelText("ui.sync_in_progress", {}, this._hass), "mdi:sync"],
      ok: [haListManagerPanelText("ui.synced", {}, this._hass), "mdi:cloud-check-outline"],
      error: [haListManagerPanelText("ui.sync_failed", {}, this._hass), "mdi:cloud-alert-outline"],
    };
    const [statusLabel, statusIcon] = labels[state] || labels.never;
    const open = this._items.filter((item) => !item.completed).length;
    const completed = this._items.filter((item) => item.completed).length;
    const timestamp = (value) => value ? this._formatDue(value) : haListManagerPanelText("ui.not_available_yet", {}, this._hass);
    return `<ha-card class="bring-sync-card ${state}">
      <div class="bring-sync-header"><div><ha-icon icon="${statusIcon}"></ha-icon><span><strong>${statusLabel}</strong><small>${haListManagerPanelText("ui.bring_sync", {}, this._hass)}</small></span></div><button class="ha-button" type="button" data-sync-bring ${this._bringSyncing ? "disabled" : ""}><ha-icon icon="mdi:sync"></ha-icon>${this._bringSyncing ? haListManagerPanelText("ui.synchronizing", {}, this._hass) : haListManagerPanelText("ui.sync_now", {}, this._hass)}</button></div>
      <div class="bring-sync-details"><span><small>${haListManagerPanelText("ui.linked_entity", {}, this._hass)}</small><strong>${this._escape(list.external_entity_id || haListManagerPanelText("ui.not_configured", {}, this._hass))}</strong></span><span><small>${haListManagerPanelText("ui.last_successful_sync", {}, this._hass)}</small><strong>${this._escape(timestamp(sync.last_success_at))}</strong></span><span><small>${haListManagerPanelText("ui.last_detected_change", {}, this._hass)}</small><strong>${this._escape(timestamp(sync.last_change_at))}</strong></span><span><small>${haListManagerPanelText("ui.entries", {}, this._hass)}</small><strong>${haListManagerPanelText("ui.open_completed_counts", {p0:(open), p1:(completed)}, this._hass)}</strong></span></div>
      ${sync.last_error ? `<p class="bring-sync-error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${this._escape(sync.last_error)}</span></p>` : ""}
    </ha-card>`;
  }

  _renderInventoryListDetail(list) {
    const type = LIST_TYPES(this._hass).inventory;
    const groupedIds = new Set(this._inventoryGroups.flatMap((group) => group.member_ids || []));
    const ungrouped = this._inventoryEntries.filter((entry) => !groupedIds.has(entry.id));
    const belowMinimum = ungrouped.filter((entry) => entry.minimum_stock !== null && entry.stock < entry.minimum_stock).length
      + this._inventoryGroups.filter((group) => {
        if (group.minimum_stock === null) return false;
        const stock = (group.member_ids || []).map((id) => this._findInventoryEntry(id)).filter(Boolean).reduce((sum, entry) => sum + entry.stock, 0);
        return stock < group.minimum_stock;
      }).length;
    const totalStock = this._inventoryEntries.reduce((sum, entry) => sum + entry.stock, 0);
    const categories = this._categories.filter((category) => category.scope === "list" && category.list_id === list.id);
    const categoryContent = categories.length
      ? `<div class="list-category-chips">${categories.map((category) => `<span style="${category.color ? `--category-color:${this._escape(category.color)}` : ""}"><ha-icon icon="${this._escape(category.icon || "mdi:shape-outline")}"></ha-icon>${this._escape(category.name)}</span>`).join("")}</div>`
      : `<p class="muted-copy">${haListManagerPanelText("inventory.no_own_categories_help", {}, this._hass)}</p>`;
    return `<button class="back-button" type="button" data-back-lists><ha-icon icon="mdi:arrow-left"></ha-icon>${haListManagerPanelText("ui.back_to_lists", {}, this._hass)}</button>
      <section class="content-header with-action"><div class="heading-wrap"><span class="detail-icon"><ha-icon icon="${this._escape(list.icon || type.icon)}"></ha-icon></span><div><h2>${this._escape(list.name)}</h2><p>${type.label}</p></div></div><div class="header-actions"><button class="ha-button" type="button" data-list-script="${list.id}"><ha-icon icon="mdi:script-text-outline"></ha-icon>${haListManagerPanelText("scripts.title", {}, this._hass)}</button><button class="ha-button" type="button" data-edit-current-list><ha-icon icon="mdi:pencil"></ha-icon>${haListManagerPanelText("ui.edit_list", {}, this._hass)}</button><button class="ha-button primary" type="button" data-open-inventory-section><ha-icon icon="mdi:package-variant-closed"></ha-icon>${haListManagerPanelText("ui.open_in_inventory", {}, this._hass)}</button></div></section>
      ${this._inlineError()}<div class="inventory-detail-stats"><ha-card><strong>${this._inventoryEntries.length}</strong><span>${haListManagerPanelText("ui.item", {}, this._hass)}</span></ha-card><ha-card><strong>${totalStock}</strong><span>${haListManagerPanelText("ui.total_stock", {}, this._hass)}</span></ha-card><ha-card><strong>${this._inventoryGroups.length}</strong><span>${haListManagerPanelText("ui.groups", {}, this._hass)}</span></ha-card><ha-card class="${belowMinimum ? "warning" : ""}"><strong>${belowMinimum}</strong><span>${haListManagerPanelText("ui.below_minimum_lowercase", {}, this._hass)}</span></ha-card></div>
      <div class="inventory-detail-grid"><ha-card class="detail-section"><div class="section-heading"><div><h3>${haListManagerPanelText("categories.own", {}, this._hass)}</h3><p>${haListManagerPanelText("help.inventory_categories_scope", {}, this._hass)}</p></div><button class="ha-button" type="button" data-add-list-category><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.add_category", {}, this._hass)}</button></div>${categoryContent}</ha-card>
      ${this._renderDashboardUsage(list)}</div>`;
  }

  _renderItemRow(item, listType) {
    const canComplete = listType !== "inventory";
    const parts = [];
    if (listType !== "todo") parts.push(haListManagerPanelText("ui.count_value", {p0:(item.quantity)}, this._hass));
    if (item.category) parts.push(item.category);
    if (item.due_at) parts.push(haListManagerPanelText("ui.due_value", {p0:(this._formatDue(item.due_at))}, this._hass));
    const displayName = listType === "todo"
      ? String(item.name || "").replace(/\s*\{\{\d+[HDM]\}\}\s*$/i, "").trim()
      : item.name;
    return `<article class="item-row${item.completed ? " completed" : ""}">
      <div class="item-check">${canComplete ? `<ha-checkbox data-toggle-item="${item.id}" title="${haListManagerPanelText("ui.completed", {}, this._hass)}"></ha-checkbox>` : `<ha-icon icon="mdi:package-variant"></ha-icon>`}</div>
      <button class="item-open" type="button" data-edit-item="${item.id}">
        <strong>${this._escape(displayName)}</strong>
        ${parts.length ? `<small>${this._escape(parts.join(" · "))}</small>` : ""}
        ${item.description ? `<span>${this._escape(item.description)}</span>` : ""}
        ${this._renderLabelChips(item.labels)}
      </button>
      <button class="icon-button danger" type="button" data-delete-item="${item.id}" title="${haListManagerPanelText("ui.delete_entry", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
    </article>`;
  }

  _renderProductPagination() {
    const total = this._productTotal;
    const pageCount = Math.max(1, Math.ceil(total / this._productPageSize));
    const first = total ? (this._productPage - 1) * this._productPageSize + 1 : 0;
    const last = Math.min(total, this._productPage * this._productPageSize);
    return `<div class="scan-pagination product-pagination"><span>${haListManagerPanelText("ui.page_range", {p0:(first), p1:(last), p2:(total)}, this._hass)}</span><label>${haListManagerPanelText("ui.products_per_page", {}, this._hass)} <select data-product-page-size>${[10, 25, 50, 100].map((size) => `<option value="${size}" ${size === this._productPageSize ? "selected" : ""}>${size}</option>`).join("")}</select></label><div><button class="icon-button" type="button" data-product-page="previous" title="${haListManagerPanelText("ui.previous_page", {}, this._hass)}" ${this._productPage <= 1 ? "disabled" : ""}><ha-icon icon="mdi:chevron-left"></ha-icon></button><span>${haListManagerPanelText("ui.page_of_total", {p0:(this._productPage), p1:(pageCount)}, this._hass)}</span><button class="icon-button" type="button" data-product-page="next" title="${haListManagerPanelText("ui.next_page", {}, this._hass)}" ${this._productPage >= pageCount ? "disabled" : ""}><ha-icon icon="mdi:chevron-right"></ha-icon></button></div></div>`;
  }

  _renderProducts() {
    const filtered = Boolean(this._productSearch.trim() || this._productLabelFilter);
    const rows = this._products.map((product) => {
      const details = [product.brand, product.package_quantity].filter(Boolean);
      const categoryAssignments = (product.category_assignments || []).map((assignment) => {
        const scope = assignment.scope === "global"
          ? haListManagerPanelText("ui.global", {}, this._hass)
          : assignment.scope === "list_type"
            ? assignment.list_type === "shopping" ? haListManagerPanelText("ui.shopping", {}, this._hass) : haListManagerPanelText("ui.inventory", {}, this._hass)
            : this._findList(assignment.list_id)?.name || haListManagerPanelText("ui.list", {}, this._hass);
        return `${scope}: ${assignment.category?.name || haListManagerPanelText("ui.unknown", {}, this._hass)}`;
      });
      return `<article class="product-row">
        ${product.image_url ? `<button class="product-image" type="button" data-view-product-image="${product.id}" title="${haListManagerPanelText("ui.enlarge_product_image", {}, this._hass)}"><img src="${this._escape(product.image_url)}" alt="${haListManagerPanelText("products.image_alt", {p0:(this._escape(product.name))}, this._hass)}"></button>` : `<div class="product-image"><ha-icon icon="mdi:barcode-scan"></ha-icon></div>`}
        <button class="product-open" type="button" data-edit-product="${product.id}">
          <strong>${this._escape(product.name)}</strong>
          ${details.length ? `<small>${this._escape(details.join(" · "))}</small>` : ""}
          ${categoryAssignments.length ? `<small class="product-category-summary">${this._escape(categoryAssignments.join(" · "))}</small>` : ""}
          <span>${product.ean ? `EAN ${this._escape(product.ean)}` : haListManagerPanelText("ui.without_ean", {}, this._hass)}</span>
          ${this._renderLabelChips(product.labels)}
        </button>
        <div class="row-actions">
          <button class="icon-button" type="button" data-edit-product="${product.id}" title="${haListManagerPanelText("products.edit", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button>
          <button class="icon-button danger" type="button" data-delete-product="${product.id}" title="${haListManagerPanelText("products.delete", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
        </div>
      </article>`;
    }).join("");
    let content;
    if (this._productsLoading && !this._productsLoaded) content = this._loadingCard(haListManagerPanelText("ui.loading_products", {}, this._hass));
    else if (this._products.length) content = `<ha-card class="list-card product-card">${rows}</ha-card>${this._renderProductPagination()}`;
    else content = `<ha-card class="empty-state"><ha-icon icon="mdi:barcode-off"></ha-icon><h3>${filtered ? haListManagerPanelText("ui.no_product_matches", {}, this._hass) : haListManagerPanelText("ui.no_products", {}, this._hass)}</h3><p>${filtered ? haListManagerPanelText("ui.change_search_or_label_filter", {}, this._hass) : haListManagerPanelText("help.products_independent", {}, this._hass)}</p><button class="ha-button primary" data-add-product><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("products.create", {}, this._hass)}</button></ha-card>`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:barcode-scan"></ha-icon><div><h2>${haListManagerPanelText("ui.products", {}, this._hass)}</h2><p>${haListManagerPanelText("products.local_data_help", {}, this._hass)}</p></div></div><button class="ha-button primary" data-add-product><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("products.create", {}, this._hass)}</button></section>
      <div class="product-filters"><div class="search-field"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-product-search value="${this._escape(this._productSearch)}" placeholder="${haListManagerPanelText("ui.product_search_fields", {}, this._hass)}"></div><ha-select data-product-label-filter></ha-select></div>
      ${this._inlineError()}${content}`;
  }

  _renderCategories() {
    if (this._categoriesLoading && !this._categoriesLoaded) return this._loadingCard(haListManagerPanelText("categories.loading", {}, this._hass));
    if (this._categoryOrderEditing) return this._renderCategoryOrder();
    const alphabetical = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const assignmentGroups = new Map(this._listAssignmentGroups.map((group) => [group.category.id, group]));
    const renderCategory = (category, detailMode = "") => {
      const list = category.list_id ? this._findList(category.list_id) : null;
      const group = assignmentGroups.get(category.id);
      const ruleCount = group?.rules?.length || 0;
      const productCount = group?.products?.length || 0;
      const summary = list?.list_type === "todo"
        ? `${ruleCount} ${ruleCount === 1 ? haListManagerPanelText("ui.rule", {}, this._hass) : haListManagerPanelText("ui.rules", {}, this._hass)}`
        : `${ruleCount} ${ruleCount === 1 ? haListManagerPanelText("ui.rule", {}, this._hass) : haListManagerPanelText("ui.rules", {}, this._hass)} · ${productCount} ${productCount === 1 ? haListManagerPanelText("ui.product", {}, this._hass) : haListManagerPanelText("ui.products", {}, this._hass)}`;
      const scope = detailMode === "summary"
        ? this._listAssignmentsLoading ? haListManagerPanelText("ui.assignments_loading", {}, this._hass) : summary
        : category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : category.scope === "list_type" ? haListManagerPanelText("ui.list_type_value", {p0:(LIST_TYPES(this._hass)[category.list_type]?.label || category.list_type)}, this._hass) : haListManagerPanelText("ui.list_named", {p0:(list?.name || haListManagerPanelText("ui.unknown", {}, this._hass))}, this._hass);
      const color = category.color
        ? `<span class="color-swatch" style="--category-color:${this._escape(category.color)}" title="${this._escape(category.color)}"></span>`
        : `<span class="color-swatch default" title="${haListManagerPanelText("ui.default_color", {}, this._hass)}"><ha-icon icon="mdi:palette-outline"></ha-icon></span>`;
      return `<article class="category-row">
        <button class="category-open" type="button" data-manage-category-detail="${category.id}" data-category-detail-target="${detailMode === "summary" ? this._categorySpecificMode : detailMode || "rules"}"><span class="category-symbol" style="${category.color ? `--category-color:${this._escape(category.color)}` : ""}"><ha-icon icon="${this._escape(category.icon || "mdi:shape-outline")}"></ha-icon></span><span class="category-open-copy"><strong>${this._escape(category.name)}</strong><small>${this._escape(scope)}</small></span></button>
        ${color}
        <div class="row-actions"><button class="icon-button" type="button" data-edit-category="${category.id}" title="${haListManagerPanelText("ui.edit_category", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-category="${category.id}" title="${haListManagerPanelText("categories.delete", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>
      </article>`;
    };
    const tabs = [
      ["global", haListManagerPanelText("ui.global", {}, this._hass), (category) => category.scope === "global"],
      ["shopping", haListManagerPanelText("ui.shopping_list", {}, this._hass), (category) => category.scope === "list_type" && category.list_type === "shopping"],
      ["inventory", haListManagerPanelText("ui.inventory", {}, this._hass), (category) => category.scope === "list_type" && category.list_type === "inventory"],
      ["todo", haListManagerPanelText("ui.todo", {}, this._hass), (category) => category.scope === "list_type" && category.list_type === "todo"],
      ["specific", haListManagerPanelText("ui.specific", {}, this._hass), (category) => category.scope === "list"],
      ["dynamic", haListManagerPanelText("ui.dynamic", {}, this._hass), () => false],
    ];
    const activeTab = tabs.find(([id]) => id === this._categoryTab) || tabs[0];
    const descriptions = {
      global: haListManagerPanelText("help.global_categories", {}, this._hass),
      shopping: haListManagerPanelText("help.shopping_type_categories", {}, this._hass),
      inventory: haListManagerPanelText("help.inventory_type_categories", {}, this._hass),
      todo: haListManagerPanelText("help.todo_type_categories", {}, this._hass),
      specific: haListManagerPanelText("help.manage_list_categories", {}, this._hass),
      dynamic: haListManagerPanelText("help.dynamic_categories", {}, this._hass),
    };
    const filtered = this._categories.filter(activeTab[2]).sort(alphabetical);
    const tabBar = `<div class="scan-history-tabs label-tabs" role="tablist">${tabs.map(([id, title, test]) => `<button type="button" class="${activeTab[0] === id ? "active" : ""}" data-category-tab="${id}" role="tab" aria-selected="${activeTab[0] === id}">${this._escape(title)}<span>${id === "dynamic" ? this._dynamicCategories.length : this._categories.filter(test).length}</span></button>`).join("")}</div>`;
    let specificPicker = "";
    let permanentSections = "";
    if (activeTab[0] === "specific") {
      const selectedList = this._findList(this._categorySpecificListId) || this._lists[0] || null;
      const selectedListId = selectedList?.id || "";
      const categories = filtered.filter((category) => category.list_id === selectedListId);
      specificPicker = selectedList ? `<section class="category-specific-picker"><ha-select data-category-specific-list></ha-select></section>` : "";
      permanentSections = selectedList
        ? `<section class="category-specific-heading"><div><h3>${haListManagerPanelText("categories.for_this_list", {}, this._hass)}</h3><p>${haListManagerPanelText("help.manage_category_products", {}, this._hass)}</p></div></section><ha-card class="list-card">${categories.length ? categories.map((category) => renderCategory(category, "summary")).join("") : `<div class="category-list-empty">${haListManagerPanelText("ui.no_local_categories", {}, this._hass)}</div>`}</ha-card>`
        : `<ha-card class="empty-state compact"><ha-icon icon="mdi:format-list-bulleted"></ha-icon><h3>${haListManagerPanelText("ui.no_list_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_list_first", {}, this._hass)}</p></ha-card>`;
    } else if (filtered.length) {
      permanentSections = `<ha-card class="list-card">${filtered.map((category) => renderCategory(category)).join("")}</ha-card>`;
    }
    const dynamicRows = this._dynamicCategories.map((category) => `<article class="dynamic-category-row">
      <div><strong>${this._escape(category.name)}</strong><small>${this._escape(category.list_name)} · ${category.item_count} ${category.item_count === 1 ? haListManagerPanelText("ui.entry", {}, this._hass) : haListManagerPanelText("ui.entries", {}, this._hass)}</small></div>
      <button class="ha-button" type="button" data-promote-category data-name="${this._escape(category.name)}" data-list-id="${category.list_id}"><ha-icon icon="mdi:content-save-plus-outline"></ha-icon>${haListManagerPanelText("ui.apply_permanently", {}, this._hass)}</button>
    </article>`).join("");
    const permanent = activeTab[0] === "dynamic" ? "" : permanentSections || `<ha-card class="empty-state compact"><ha-icon icon="mdi:shape-plus-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_categories_scope", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_matching_category_hint", {}, this._hass)}</p></ha-card>`;
    const dynamic = activeTab[0] === "dynamic"
      ? dynamicRows
        ? `<ha-card class="list-card">${dynamicRows}</ha-card>`
        : `<ha-card class="empty-state compact"><ha-icon icon="mdi:shape-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_dynamic_categories", {}, this._hass)}</h3><p>${haListManagerPanelText("help.dynamic_category_origin", {}, this._hass)}</p></ha-card>`
      : "";
    const addDefaults = activeTab[0] === "global"
      ? `data-category-scope="global"`
      : activeTab[0] === "specific"
        ? `data-category-scope="list" data-category-list-id="${this._escape(this._categorySpecificListId || this._lists[0]?.id || "")}"`
        : `data-category-scope="list_type" data-category-list-type="${activeTab[0]}"`;
    const categoryActions = activeTab[0] === "dynamic" ? "" : `<div class="category-page-actions"><button class="ha-button" type="button" data-edit-category-order><ha-icon icon="mdi:sort-variant"></ha-icon>${haListManagerPanelText("categories.edit_order", {}, this._hass)}</button><button class="ha-button primary" type="button" data-add-category ${addDefaults}><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("categories.create", {}, this._hass)}</button></div>`;
    return `<section class="content-header"><div class="heading-wrap"><ha-icon icon="mdi:shape-outline"></ha-icon><div><h2>${haListManagerPanelText("ui.categories", {}, this._hass)}</h2><p>${this._escape(descriptions[activeTab[0]])}</p></div></div></section>${tabBar}${specificPicker}${categoryActions}${this._inlineError()}${permanent}${dynamic}`;
  }

  _renderCategoryProductsPage() {
    const record = this._findCategory(this._selectedCategoryId);
    if (!record) return `<ha-card class="empty-state"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><h3>${haListManagerPanelText("ui.category_not_found", {}, this._hass)}</h3><button class="ha-button" type="button" data-back-categories>${haListManagerPanelText("ui.back_categories", {}, this._hass)}</button></ha-card>`;
    const list = this._findList(record.list_id);
    const canManageProducts = record.scope === "list" && list?.list_type !== "todo";
    const scope = record.scope === "global"
      ? haListManagerPanelText("ui.global", {}, this._hass)
      : record.scope === "list_type"
        ? haListManagerPanelText("ui.list_type_value", {p0:(LIST_TYPES(this._hass)[record.list_type]?.label || record.list_type)}, this._hass)
        : haListManagerPanelText("ui.list_named", {p0:(list?.name || haListManagerPanelText("ui.unknown", {}, this._hass))}, this._hass);
    const ruleRows = this._categoryRules.map((rule, index) => `<article class="category-rule-row"><code>${this._escape(rule.pattern)}</code><div class="row-actions"><button class="icon-button" type="button" data-edit-category-rule="${index}" title="${haListManagerPanelText("ui.edit_rule", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-category-rule="${index}" title="${haListManagerPanelText("ui.delete_rule", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div></article>`).join("");
    const editing = this._categoryRuleEditingIndex >= 0;
    const rulesContent = this._categoryRulesLoading
      ? `<div class="category-rule-state"><ha-circular-progress active></ha-circular-progress>${haListManagerPanelText("ui.loading_rules", {}, this._hass)}</div>`
      : ruleRows || `<p class="category-rule-empty">${haListManagerPanelText("categories.no_auto_rules", {}, this._hass)}</p>`;
    const rulesSection = `<ha-card class="detail-section category-rule-section"><div class="section-heading"><div><h3>${haListManagerPanelText("ui.automatic_assignment", {}, this._hass)}</h3><p>${haListManagerPanelText("help.category_name_assignment", {}, this._hass)}</p></div><button class="ha-button" type="button" data-open-category-rule-bulk><ha-icon icon="mdi:text-box-edit-outline"></ha-icon>${haListManagerPanelText("ui.edit_multiple_rules", {}, this._hass)}</button></div><div class="category-rule-quick"><input type="text" maxlength="100" value="${this._escape(this._categoryRuleDraft)}" placeholder="${haListManagerPanelText("ui.assignment_rule_example", {}, this._hass)}" autocomplete="off" data-category-rule-input><button class="ha-button primary" type="button" data-save-category-rule>${editing ? haListManagerPanelText("ui.save_change", {}, this._hass) : haListManagerPanelText("ui.add", {}, this._hass)}</button>${editing ? `<button class="ha-button" type="button" data-cancel-category-rule>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button>` : ""}</div><p class="field-help">${haListManagerPanelText("categories.rule_examples", {exact: `<code>${this._escape(haListManagerPanelText("products.example_tomatoes", {}, this._hass))}</code>`, prefix: `<code>${this._escape(haListManagerPanelText("ui.prefix_match_example", {}, this._hass))}</code>`, word: `<code>${this._escape(haListManagerPanelText("ui.contains_match_example", {}, this._hass))}</code>`}, this._hass)}</p><div class="category-rule-list">${rulesContent}</div></ha-card>`;
    const rows = this._categoryProducts.map((product) => `<article class="category-product-page-row">
      ${this._categoryProductIdentity(product)}
      <button class="ha-button compact" type="button" data-remove-category-product-page="${product.id}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:link-variant-off"></ha-icon>${haListManagerPanelText("ui.remove_assignment", {}, this._hass)}</button>
    </article>`).join("");
    const productContent = this._categoryProductsLoading
      ? this._loadingCard(haListManagerPanelText("ui.assigned_products_loading", {}, this._hass))
      : rows
        ? `<ha-card class="list-card category-product-page-list">${rows}</ha-card>`
        : `<ha-card class="empty-state"><ha-icon icon="mdi:package-variant-plus"></ha-icon><h3>${haListManagerPanelText("products.none_assigned", {}, this._hass)}</h3><p>${haListManagerPanelText("help.assign_products", {}, this._hass)}</p><button class="ha-button primary" type="button" data-open-category-product-search><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.assign_product", {}, this._hass)}</button></ha-card>`;
    const productsSection = canManageProducts ? `<section class="category-products-section"><div class="section-heading"><div><h3>${haListManagerPanelText("products.assigned", {}, this._hass)}</h3><p>${haListManagerPanelText("help.fixed_list_product_assignments", {}, this._hass)}</p></div><button class="ha-button primary" type="button" data-open-category-product-search><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.assign_product", {}, this._hass)}</button></div>${productContent}</section>` : "";
    const detailTabs = canManageProducts ? `<div class="scan-history-tabs label-tabs category-detail-tabs" role="tablist"><button type="button" class="${this._categoryDetailTab === "rules" ? "active" : ""}" data-category-detail-tab="rules" role="tab" aria-selected="${this._categoryDetailTab === "rules"}"><ha-icon icon="mdi:format-list-checks"></ha-icon>${haListManagerPanelText("ui.automatic_assignments", {}, this._hass)}<span>${this._categoryRules.length}</span></button><button type="button" class="${this._categoryDetailTab === "products" ? "active" : ""}" data-category-detail-tab="products" role="tab" aria-selected="${this._categoryDetailTab === "products"}"><ha-icon icon="mdi:package-variant"></ha-icon>${haListManagerPanelText("ui.product_assignments", {}, this._hass)}<span>${this._categoryProducts.length}</span></button></div>` : "";
    const detailContent = canManageProducts && this._categoryDetailTab === "products" ? productsSection : rulesSection;
    const backLabel = haListManagerPanelText("ui.back_categories", {}, this._hass);
    return `<section class="category-product-page-header"><button class="icon-button category-product-back" type="button" data-back-categories title="${backLabel}" aria-label="${backLabel}"><ha-icon icon="mdi:arrow-left"></ha-icon></button><div class="heading-wrap"><div class="category-symbol" style="${record.color ? `--category-color:${this._escape(record.color)}` : ""}"><ha-icon icon="${this._escape(record.icon || "mdi:shape-outline")}"></ha-icon></div><div><h2>${this._escape(record.name)}</h2><p>${this._escape(scope)} · ${this._categoryRules.length} ${this._categoryRules.length === 1 ? haListManagerPanelText("ui.rule", {}, this._hass) : haListManagerPanelText("ui.rules", {}, this._hass)}${canManageProducts ? ` · ${this._categoryProducts.length} ${this._categoryProducts.length === 1 ? haListManagerPanelText("ui.product", {}, this._hass) : haListManagerPanelText("ui.products", {}, this._hass)}` : ""}</p></div></div></section>${detailTabs}${this._inlineError()}${detailContent}`;
  }

  _renderCategoryOrder() {
    const lists = this._lists.filter((list) => list.enabled !== false);
    const selectedList = lists.find((list) => list.id === this._categoryOrderListId);
    const mode = this._categoryOrderMode;
    const originText = (category) => mode === "combined"
      ? (category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : category.scope === "list_type" ? haListManagerPanelText("ui.list_type", {}, this._hass) : haListManagerPanelText("ui.this_list", {}, this._hass))
      : (mode === "global" ? haListManagerPanelText("categories.global_base_order", {}, this._hass) : mode === "list_type" ? haListManagerPanelText("ui.list_type_value", {p0:(LIST_TYPES(this._hass)[this._categoryOrderListType]?.label || this._categoryOrderListType)}, this._hass) : haListManagerPanelText("ui.list_named", {p0:(selectedList?.name || "")}, this._hass));
    const rows = this._categoryOrderCategories.map((category, index) => {
      const global = category.scope === "global";
      return `<article class="category-order-row" draggable="true" data-category-order-row="${category.id}">
        <span class="drag-handle" title="${haListManagerPanelText("ui.drag", {}, this._hass)}"><ha-icon icon="mdi:drag"></ha-icon></span>
        <div class="category-symbol" style="${category.color ? `--category-color:${this._escape(category.color)}` : ""}"><ha-icon icon="${this._escape(category.icon || (global ? "mdi:earth" : "mdi:format-list-bulleted"))}"></ha-icon></div>
        <div class="category-order-name"><strong>${this._escape(category.name)}</strong><small>${this._escape(originText(category))}</small></div>
        <label class="category-position-field"><span>${haListManagerPanelText("ui.position", {}, this._hass)}</span><input type="number" min="1" max="${this._categoryOrderCategories.length}" step="1" value="${index + 1}" data-category-order-position="${category.id}"></label>
        <div class="category-order-arrows"><button class="icon-button" type="button" data-category-order-up="${category.id}" ${index === 0 ? "disabled" : ""} title="${haListManagerPanelText("ui.move_up", {}, this._hass)}"><ha-icon icon="mdi:arrow-up"></ha-icon></button><button class="icon-button" type="button" data-category-order-down="${category.id}" ${index === this._categoryOrderCategories.length - 1 ? "disabled" : ""} title="${haListManagerPanelText("ui.move_down", {}, this._hass)}"><ha-icon icon="mdi:arrow-down"></ha-icon></button></div>
      </article>`;
    }).join("");
    const content = this._categoryOrderLoading
      ? this._loadingCard(haListManagerPanelText("categories.loading_order", {}, this._hass))
      : `<ha-card class="list-card category-order-list">${rows || `<div class="empty-state compact"><p>${haListManagerPanelText("ui.no_permanent_categories_available", {}, this._hass)}</p></div>`}</ha-card>`;
    const modeHelp = mode === "global"
      ? haListManagerPanelText("help.base_category_order", {}, this._hass)
      : mode === "list_type"
        ? haListManagerPanelText("help.category_type_sorting", {}, this._hass)
      : mode === "list"
        ? haListManagerPanelText("help.sort_own_categories", {}, this._hass)
        : this._categoryOrderCustom
          ? haListManagerPanelText("help.custom_combined_order", {}, this._hass)
          : haListManagerPanelText("help.inherited_category_order", {}, this._hass);
    const listSelector = ["global", "list_type"].includes(mode) ? "" : `<label><span>${haListManagerPanelText("ui.list", {}, this._hass)}</span><select data-category-order-list ${this._categoryOrderDirty() ? "disabled" : ""}>${lists.map((list) => `<option value="${list.id}" ${list.id === this._categoryOrderListId ? "selected" : ""}>${this._escape(list.name)}</option>`).join("")}</select></label>`;
    const typeSelector = mode === "list_type" ? `<label><span>${haListManagerPanelText("ui.list_type", {}, this._hass)}</span><select data-category-order-list-type ${this._categoryOrderDirty() ? "disabled" : ""}>${["shopping", "inventory", "todo"].map((type) => `<option value="${type}" ${type === this._categoryOrderListType ? "selected" : ""}>${this._escape(LIST_TYPES(this._hass)[type]?.label || type)}</option>`).join("")}</select></label>` : "";
    const customState = mode === "combined" ? `<span class="category-order-state ${this._categoryOrderCustom ? "custom" : "inherited"}"><ha-icon icon="${this._categoryOrderCustom ? "mdi:call-split" : "mdi:source-branch"}"></ha-icon>${this._categoryOrderCustom ? haListManagerPanelText("ui.custom_order_active", {}, this._hass) : haListManagerPanelText("categories.base_orders_active", {}, this._hass)}</span>` : "";
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:sort-variant"></ha-icon><div><h2>${haListManagerPanelText("ui.category_order", {}, this._hass)}</h2><p>${haListManagerPanelText("help.central_category_order", {}, this._hass)}</p></div></div><button class="ha-button" type="button" data-cancel-category-order><ha-icon icon="mdi:close"></ha-icon>${haListManagerPanelText("ui.close", {}, this._hass)}</button></section>
      <ha-card class="category-order-controls"><div class="category-order-selectors"><label><span>${haListManagerPanelText("ui.edit_sort_order", {}, this._hass)}</span><select data-category-order-mode ${this._categoryOrderDirty() ? "disabled" : ""}><option value="global" ${mode === "global" ? "selected" : ""}>${haListManagerPanelText("categories.global_base_order", {}, this._hass)}</option><option value="list_type" ${mode === "list_type" ? "selected" : ""}>${haListManagerPanelText("ui.categories_by_list_type", {}, this._hass)}</option><option value="list" ${mode === "list" ? "selected" : ""}>${haListManagerPanelText("ui.list_categories", {}, this._hass)}</option><option value="combined" ${mode === "combined" ? "selected" : ""}>${haListManagerPanelText("ui.combined_list_exception", {}, this._hass)}</option></select></label>${typeSelector}${listSelector}</div><p><ha-icon icon="mdi:information-outline"></ha-icon><span>${haListManagerPanelText("help.category_manual_order", {p0:(this._escape(modeHelp))}, this._hass)}</span></p>${customState}</ha-card>
      ${this._inlineError()}${content}<div class="category-order-actions"><button class="ha-button primary" type="button" data-save-category-order ${!this._categoryOrderDirty() || this._categoryOrderSaving ? "disabled" : ""}>${this._categoryOrderSaving ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save_order", {}, this._hass)}</button><button class="ha-button" type="button" data-reset-category-order ${!this._categoryOrderDirty() ? "disabled" : ""}>${haListManagerPanelText("ui.discard_changes", {}, this._hass)}</button>${mode === "combined" && this._categoryOrderCustom ? `<button class="ha-button" type="button" data-reset-combined-category-order ${this._categoryOrderSaving ? "disabled" : ""}><ha-icon icon="mdi:backup-restore"></ha-icon>${haListManagerPanelText("ui.restore_base_orders", {}, this._hass)}</button>` : ""}</div>`;
  }

  _renderLabels() {
    if (this._labelsLoading && !this._labelsLoaded) return this._loadingCard(haListManagerPanelText("ui.loading_labels", {}, this._hass));
    const search = this._labelSearch.trim().toLocaleLowerCase();
    const searchedLabels = search
      ? this._labels.filter((label) => label.name.toLocaleLowerCase().includes(search))
      : this._labels;
    const row = (label) => {
      const color = label.color
        ? `<span class="color-swatch" style="--category-color:${this._escape(label.color)}" title="${this._escape(label.color)}"></span>`
        : `<span class="color-swatch default" title="${haListManagerPanelText("ui.default_color", {}, this._hass)}"><ha-icon icon="mdi:palette-outline"></ha-icon></span>`;
      return `<article class="category-row definition-row">
        <div class="category-symbol" style="${label.color ? `--category-color:${this._escape(label.color)}` : ""}"><ha-icon icon="${this._escape(label.icon || "mdi:label-outline")}"></ha-icon></div>
        <button class="category-open" type="button" data-edit-label="${label.id}"><strong>${this._escape(label.name)}</strong><small>${this._escape(this._labelScopeText(label))} · ${this._labelUsageText(label)}</small></button>
        ${color}
        <div class="row-actions"><button class="icon-button" type="button" data-edit-label="${label.id}" title="${haListManagerPanelText("ui.edit_label", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-label="${label.id}" title="${haListManagerPanelText("labels.delete", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>
      </article>`;
    };
    const tabs = [
      ["global", haListManagerPanelText("ui.global", {}, this._hass), (label) => label.scope === "global"],
      ["shopping", haListManagerPanelText("ui.shopping_list", {}, this._hass), (label) => label.scope === "list_type" && label.list_type === "shopping"],
      ["inventory", haListManagerPanelText("ui.inventory", {}, this._hass), (label) => label.scope === "list_type" && label.list_type === "inventory"],
      ["todo", haListManagerPanelText("ui.todo", {}, this._hass), (label) => label.scope === "list_type" && label.list_type === "todo"],
      ["specific", haListManagerPanelText("ui.specific", {}, this._hass), (label) => label.scope === "list"],
    ];
    const activeTab = tabs.find(([id]) => id === this._labelTab) || tabs[0];
    const descriptions = {
      global: haListManagerPanelText("help.global_labels_scope", {}, this._hass),
      shopping: haListManagerPanelText("help.shopping_type_labels", {}, this._hass),
      inventory: haListManagerPanelText("help.inventory_type_labels", {}, this._hass),
      todo: haListManagerPanelText("help.todo_type_labels", {}, this._hass),
      specific: haListManagerPanelText("ui.select_list_manage_labels", {}, this._hass),
    };
    const filteredLabels = searchedLabels.filter(activeTab[2]);
    const tabBar = `<div class="scan-history-tabs label-tabs" role="tablist">${tabs.map(([id, title, test]) => `<button type="button" class="${activeTab[0] === id ? "active" : ""}" data-label-tab="${id}" role="tab" aria-selected="${activeTab[0] === id}">${this._escape(title)}<span>${this._labels.filter(test).length}</span></button>`).join("")}</div>`;
    const selectedList = this._findList(this._labelSpecificListId) || this._lists[0] || null;
    const selectedListId = selectedList?.id || "";
    const specificPicker = activeTab[0] === "specific" && selectedList
      ? `<section class="category-specific-picker"><ha-select data-label-specific-list></ha-select></section>`
      : "";
    let rows = "";
    if (activeTab[0] === "specific") {
      const entries = filteredLabels.filter((label) => label.list_id === selectedListId);
      rows = entries.length ? `<ha-card class="list-card">${entries.map(row).join("")}</ha-card>` : "";
    } else if (filteredLabels.length) {
      rows = `<ha-card class="list-card">${filteredLabels.map(row).join("")}</ha-card>`;
    }
    const content = rows
      ? rows
      : activeTab[0] === "specific" && !selectedList
        ? `<ha-card class="empty-state compact"><ha-icon icon="mdi:format-list-bulleted"></ha-icon><h3>${haListManagerPanelText("ui.no_list_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_list_first", {}, this._hass)}</p></ha-card>`
        : this._labelSearch.trim()
        ? `<ha-card class="empty-state"><ha-icon icon="mdi:magnify-close"></ha-icon><h3>${haListManagerPanelText("labels.no_matches", {}, this._hass)}</h3><p>${haListManagerPanelText("labels.change_search_for_more", {}, this._hass)}</p></ha-card>`
        : activeTab[0] === "specific"
          ? `<ha-card class="empty-state compact"><ha-icon icon="mdi:label-multiple-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_custom_labels", {}, this._hass)}</h3><p>${haListManagerPanelText("labels.no_own_list_labels", {}, this._hass)}</p></ha-card>`
          : this._labels.length
            ? `<ha-card class="empty-state"><ha-icon icon="mdi:label-off-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_labels_scope_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_matching_label", {}, this._hass)}</p></ha-card>`
        : `<ha-card class="empty-state"><ha-icon icon="mdi:label-multiple-outline"></ha-icon><h3>${haListManagerPanelText("ui.no_labels", {}, this._hass)}</h3><p>${haListManagerPanelText("help.label_purpose", {}, this._hass)}</p><button class="ha-button primary" type="button" data-add-label><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_first_label", {}, this._hass)}</button></ha-card>`;
    const addDefaults = activeTab[0] === "global"
      ? `data-label-scope="global"`
      : activeTab[0] === "specific"
        ? `data-label-scope="list" data-label-list-id="${this._escape(selectedListId)}"`
        : `data-label-scope="list_type" data-label-list-type="${activeTab[0]}"`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:label-multiple-outline"></ha-icon><div><h2>${haListManagerPanelText("ui.labels", {}, this._hass)}</h2><p>${this._escape(descriptions[activeTab[0]])}</p></div></div><button class="ha-button primary" type="button" data-add-label ${addDefaults}><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("labels.create", {}, this._hass)}</button></section>${tabBar}${specificPicker}<div class="search-field"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-label-search value="${this._escape(this._labelSearch)}" placeholder="${haListManagerPanelText("ui.search_label", {}, this._hass)}"></div>${this._inlineError()}${content}`;
  }

  _renderChips() {
    if (this._chipsLoading && !this._chipsLoaded) return this._loadingCard(haListManagerPanelText("ui.loading_chips", {}, this._hass));
    const search = this._chipSearch.trim().toLocaleLowerCase();
    const searched = search
      ? this._chips.filter((chip) => chip.name.toLocaleLowerCase().includes(search))
      : this._chips;
    const row = (chip) => {
      const color = chip.color
        ? `<span class="color-swatch" style="--category-color:${this._escape(chip.color)}" title="${this._escape(chip.color)}"></span>`
        : `<span class="color-swatch default" title="${haListManagerPanelText("ui.default_color", {}, this._hass)}"><ha-icon icon="mdi:palette-outline"></ha-icon></span>`;
      const target = chip.chip_kind === "todo_template"
        ? (" " + haListManagerPanelText("todo.task_suffix", {p0:(chip.template_data?.item_name || chip.name)}, this._hass))
        : chip.product_name ? (" " + haListManagerPanelText("ui.product_suffix", {p0:(chip.product_name)}, this._hass)) : (" " + haListManagerPanelText("chips.direct_name_suffix", {}, this._hass));
      return `<article class="category-row definition-row">
        <div class="category-symbol" style="${chip.color ? `--category-color:${this._escape(chip.color)}` : ""}"><ha-icon icon="${this._escape(chip.icon || (chip.chip_kind === "todo_template" ? "mdi:checkbox-marked-outline" : "mdi:gesture-tap-button"))}"></ha-icon></div>
        <button class="category-open" type="button" data-edit-chip="${chip.id}"><strong>${this._escape(chip.name)}</strong><small>${this._escape(this._labelScopeText(chip) + target)}</small></button>
        ${color}
        <div class="row-actions"><button class="icon-button" type="button" data-edit-chip="${chip.id}" title="${haListManagerPanelText("ui.edit_chip", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-chip="${chip.id}" title="${haListManagerPanelText("chips.delete", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>
      </article>`;
    };
    const tabs = [
      ["global", haListManagerPanelText("ui.general_items", {}, this._hass), (chip) => chip.scope === "global" && chip.chip_kind === "entry"],
      ["shopping", haListManagerPanelText("ui.shopping_list", {}, this._hass), (chip) => chip.scope === "list_type" && chip.list_type === "shopping"],
      ["inventory", haListManagerPanelText("ui.inventory", {}, this._hass), (chip) => chip.scope === "list_type" && chip.list_type === "inventory"],
      ["todo", haListManagerPanelText("todo.templates_title", {}, this._hass), (chip) => chip.scope === "list_type" && chip.list_type === "todo" && chip.chip_kind === "todo_template"],
      ["specific", haListManagerPanelText("ui.specific", {}, this._hass), (chip) => chip.scope === "list"],
    ];
    const activeTab = tabs.find(([id]) => id === this._chipTab) || tabs[0];
    const descriptions = {
      global: haListManagerPanelText("help.general_item_chip_availability", {}, this._hass),
      shopping: haListManagerPanelText("help.shopping_type_chips", {}, this._hass),
      inventory: haListManagerPanelText("help.inventory_type_chips", {}, this._hass),
      todo: haListManagerPanelText("help.global_todo_templates", {}, this._hass),
      specific: haListManagerPanelText("chips.select_list_to_manage", {}, this._hass),
    };
    const filtered = searched.filter(activeTab[2]);
    const tabBar = `<div class="scan-history-tabs label-tabs" role="tablist">${tabs.map(([id, title, test]) => `<button type="button" class="${activeTab[0] === id ? "active" : ""}" data-chip-tab="${id}" role="tab" aria-selected="${activeTab[0] === id}">${this._escape(title)}<span>${this._chips.filter(test).length}</span></button>`).join("")}</div>`;
    const selectedList = this._findList(this._chipSpecificListId) || this._lists[0] || null;
    const selectedListId = selectedList?.id || "";
    const specificPicker = activeTab[0] === "specific" && selectedList
      ? `<section class="category-specific-picker"><ha-select data-chip-specific-list></ha-select></section>`
      : "";
    let rows = "";
    if (activeTab[0] === "specific") {
      const entries = filtered.filter((chip) => chip.list_id === selectedListId);
      rows = entries.length ? `<ha-card class="list-card">${entries.map(row).join("")}</ha-card>` : "";
    } else if (filtered.length) rows = `<ha-card class="list-card">${filtered.map(row).join("")}</ha-card>`;
    const content = rows
      ? rows
      : activeTab[0] === "specific" && !selectedList
        ? `<ha-card class="empty-state compact"><ha-icon icon="mdi:format-list-bulleted"></ha-icon><h3>${haListManagerPanelText("ui.no_list_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_list_first", {}, this._hass)}</p></ha-card>`
        : this._chipSearch.trim()
        ? `<ha-card class="empty-state"><ha-icon icon="mdi:magnify-close"></ha-icon><h3>${haListManagerPanelText("chips.no_matches", {}, this._hass)}</h3><p>${haListManagerPanelText("chips.refine_search", {}, this._hass)}</p></ha-card>`
        : activeTab[0] === "specific"
          ? `<ha-card class="empty-state compact"><ha-icon icon="mdi:gesture-tap-button"></ha-icon><h3>${haListManagerPanelText("chips.no_own_chips", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.no_custom_list_chips", {}, this._hass)}</p></ha-card>`
          : this._chips.length
            ? `<ha-card class="empty-state"><ha-icon icon="mdi:gesture-tap-button"></ha-icon><h3>${haListManagerPanelText("ui.no_chips_in_scope", {}, this._hass)}</h3><p>${haListManagerPanelText("chips.create_matching_help", {}, this._hass)}</p></ha-card>`
        : `<ha-card class="empty-state"><ha-icon icon="mdi:gesture-tap-button"></ha-icon><h3>${haListManagerPanelText("ui.no_chips_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("help.chip_purpose", {}, this._hass)}</p><button class="ha-button primary" type="button" data-add-chip><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("chips.create_first", {}, this._hass)}</button></ha-card>`;
    const addDefaults = activeTab[0] === "global"
      ? `data-chip-scope="global" data-chip-kind="entry"`
      : activeTab[0] === "specific"
        ? `data-chip-scope="list" data-chip-list-id="${this._escape(selectedListId)}" data-chip-kind="${selectedList?.list_type === "todo" ? "todo_template" : "entry"}"`
        : `data-chip-scope="list_type" data-chip-list-type="${activeTab[0]}" data-chip-kind="${activeTab[0] === "todo" ? "todo_template" : "entry"}"`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:gesture-tap-button"></ha-icon><div><h2>${haListManagerPanelText("ui.quick_entries_todo_templates", {}, this._hass)}</h2><p>${this._escape(descriptions[activeTab[0]])}</p></div></div><button class="ha-button primary" type="button" data-add-chip ${addDefaults}><ha-icon icon="mdi:plus"></ha-icon>${activeTab[0] === "todo" || selectedList?.list_type === "todo" ? haListManagerPanelText("ui.create_todo_template", {}, this._hass) : haListManagerPanelText("chips.create", {}, this._hass)}</button></section>${tabBar}${specificPicker}<div class="search-field"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-chip-search value="${this._escape(this._chipSearch)}" placeholder="${haListManagerPanelText("ui.search_chip_template", {}, this._hass)}"></div>${this._inlineError()}${content}`;
  }

  _renderDishes() {
    if (this._dishesLoading && !this._dishesLoaded) return this._loadingCard(haListManagerPanelText("ui.dishes_loading", {}, this._hass));
    const query = this._dishSearch.trim().toLocaleLowerCase();
    const dishes = query
      ? this._dishes.filter((dish) => dish.name.toLocaleLowerCase().includes(query)
        || (dish.items || []).some((item) => item.name.toLocaleLowerCase().includes(query)))
      : this._dishes;
    const rows = dishes.map((dish) => `<article class="category-row definition-row dish-row">
      <div class="category-symbol" style="${dish.color ? `--category-color:${this._escape(dish.color)}` : ""}"><ha-icon icon="mdi:food-variant"></ha-icon></div>
      <button class="category-open" type="button" data-edit-dish="${dish.id}"><strong>${this._escape(dish.name)}</strong><small>${dish.items.length} ${dish.items.length === 1 ? haListManagerPanelText("ui.ingredient", {}, this._hass) : haListManagerPanelText("ui.ingredients", {}, this._hass)}</small></button>
      ${dish.color ? `<span class="color-swatch" style="--category-color:${this._escape(dish.color)}"></span>` : `<span class="color-swatch default"><ha-icon icon="mdi:palette-outline"></ha-icon></span>`}
      <div class="row-actions"><button class="icon-button" type="button" data-edit-dish="${dish.id}" title="${haListManagerPanelText("ui.edit_dish", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-dish="${dish.id}" title="${haListManagerPanelText("recipes.delete_dish", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>
    </article>`).join("");
    const content = rows
      ? `<ha-card class="list-card">${rows}</ha-card>`
      : `<ha-card class="empty-state"><ha-icon icon="mdi:food-variant"></ha-icon><h3>${query ? haListManagerPanelText("ui.no_matching_dishes", {}, this._hass) : haListManagerPanelText("ui.no_dishes_yet", {}, this._hass)}</h3><p>${query ? haListManagerPanelText("ui.change_search_term", {}, this._hass) : haListManagerPanelText("help.dish_ingredients", {}, this._hass)}</p></ha-card>`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:food-variant"></ha-icon><div><h2>${haListManagerPanelText("recipes.dishes", {}, this._hass)}</h2><p>${haListManagerPanelText("help.central_dishes", {}, this._hass)}</p></div></div><button class="ha-button primary" type="button" data-add-dish><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("recipes.create_dish", {}, this._hass)}</button></section><div class="search-field"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-dish-search value="${this._escape(this._dishSearch)}" placeholder="${haListManagerPanelText("ui.search_dish_ingredient", {}, this._hass)}"></div>${this._inlineError()}${content}`;
  }

  _scannerRouteText(scanner) {
    if (scanner.routing === "active_target") return haListManagerPanelText("scanner.active_then_default", {}, this._hass);
    const list = this._findList(scanner.list_id);
    return `${list?.name || haListManagerPanelText("ui.unknown_list", {}, this._hass)} · ${SCANNER_ACTIONS(this._hass)[scanner.action]?.label || scanner.action}`;
  }

  _renderScannerDevices() {
    if (this._scannersLoading && !this._scannersLoaded) return this._loadingCard(haListManagerPanelText("ui.scanners_loading", {}, this._hass));
    const targetList = this._scannerTarget ? this._findList(this._scannerTarget.list_id) : null;
    const target = this._scannerTarget
      ? `<div class="active-target"><ha-icon icon="mdi:access-point-check"></ha-icon><div><strong>${this._escape(targetList?.name || haListManagerPanelText("ui.unknown_list", {}, this._hass))}</strong><small>${haListManagerPanelText("ui.active_since", {p0:(this._escape(SCANNER_ACTIONS(this._hass)[this._scannerTarget.action]?.label || this._scannerTarget.action)), p1:(this._escape(this._formatScanTime(this._scannerTarget.updated_at)))}, this._hass)}</small></div><button class="ha-button" type="button" data-clear-scanner-target>${haListManagerPanelText("ui.disable", {}, this._hass)}</button></div>`
      : `<div class="active-target inactive"><ha-icon icon="mdi:access-point-off"></ha-icon><div><strong>${haListManagerPanelText("ui.no_card_scan_target", {}, this._hass)}</strong><small>${haListManagerPanelText("help.scanner_dynamic_default", {}, this._hass)}</small></div></div>`;
    const rows = this._scanners.map((scanner) => `<article class="scanner-row ${scanner.enabled ? "" : "disabled"}"><span class="scanner-icon"><ha-icon icon="mdi:barcode-scan"></ha-icon></span><button type="button" class="scanner-open" data-edit-scanner="${scanner.id}"><strong>${this._escape(scanner.name)}</strong><small>${this._escape(scanner.address)}</small><span>${this._escape(this._scannerRouteText(scanner))}</span></button><span class="scanner-state ${scanner.enabled ? "enabled" : ""}">${scanner.enabled ? haListManagerPanelText("ui.active", {}, this._hass) : haListManagerPanelText("ui.disabled", {}, this._hass)}</span><div class="row-actions"><button class="icon-button" type="button" data-edit-scanner="${scanner.id}" title="${haListManagerPanelText("scanner.edit", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-scanner="${scanner.id}" title="${haListManagerPanelText("ui.delete_scanner", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div></article>`).join("");
    const scannerList = rows ? `<ha-card class="list-card">${rows}</ha-card>` : `<ha-card class="empty-state compact"><ha-icon icon="mdi:barcode-scan"></ha-icon><h3>${haListManagerPanelText("ui.no_scanner_configured", {}, this._hass)}</h3><p>${haListManagerPanelText("help.scanner_simulation_persistent", {}, this._hass)}</p></ha-card>`;
    return `
      <ha-card class="scanner-requirements"><ha-icon icon="mdi:bluetooth-connect"></ha-icon><div><h3>${haListManagerPanelText("scanner.supported_hardware", {}, this._hass)}</h3><p>${haListManagerPanelText("scanner.hardware_requirements", {model: `<strong>${this._escape(haListManagerPanelText("ui.eyoyo_ey_015p", {}, this._hass))}</strong>`}, this._hass)}</p><a class="ha-button" href="https://github.com/lyntoo/eyoyo-ey015p-ble-ha" target="_blank" rel="noopener noreferrer"><ha-icon icon="mdi:github"></ha-icon>${haListManagerPanelText("ui.integration_github", {}, this._hass)}<ha-icon icon="mdi:open-in-new"></ha-icon></a></div></ha-card>
      <ha-card class="scanner-target-card"><div class="section-heading"><div><h3>${haListManagerPanelText("scanner.active_scan_target", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.one_active_inventory_card", {}, this._hass)}</p></div></div>${target}</ha-card>
      <section class="content-header with-action scanner-heading"><div><h3>${haListManagerPanelText("scanner.configured_scanners", {}, this._hass)}</h3><p>${haListManagerPanelText("help.scanner_mac_address", {}, this._hass)} <code>eyoyo_barcode_scanned</code>.</p></div><button class="ha-button primary" type="button" data-add-scanner><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_scanner", {}, this._hass)}</button></section>${scannerList}`;
  }

  _renderScannerSimulation() {
    const status = this._simulationStatus ? `<div class="simulation-result ${this._escape(this._simulationStatus.tone)}"><ha-icon icon="mdi:${this._simulationStatus.tone === "success" ? "check-circle-outline" : "alert-circle-outline"}"></ha-icon><span>${this._escape(this._simulationStatus.text)}</span></div>` : "";
    return `<ha-card class="simulation-card"><div class="section-heading"><div><h3>${haListManagerPanelText("ui.simulate_scanner", {}, this._hass)}</h3><p>${haListManagerPanelText("help.scanner_test_workflow", {}, this._hass)}</p></div></div><div class="simulation-grid"><ha-select data-simulation-scanner></ha-select><ha-select data-simulation-list></ha-select><ha-select data-simulation-action></ha-select><ha-select data-simulation-delay></ha-select><label class="field"><span>EAN</span><input inputmode="numeric" data-simulation-ean value="${this._escape(this._simulation.ean)}" placeholder="${haListManagerPanelText("ui.ean_example", {}, this._hass)}"></label><label class="field"><span>${haListManagerPanelText("ui.count", {}, this._hass)}</span><input type="number" min="1" step="1" value="${this._escape(this._simulation.quantity)}" data-simulation-quantity></label>${this._simulation.action === "correct" ? `<label class="field" data-corrected-stock-field><span>${haListManagerPanelText("ui.new_stock", {}, this._hass)}</span><input type="number" min="0" step="1" value="${this._escape(this._simulation.corrected_stock)}" placeholder="${haListManagerPanelText("ui.required", {}, this._hass)}" data-simulation-stock></label>` : ""}</div>${status}<div class="settings-actions"><button class="ha-button primary" type="button" data-run-simulation ${this._busy || this._simulationCountdown ? "disabled" : ""}><ha-icon icon="mdi:play"></ha-icon>${this._simulationCountdown ? haListManagerPanelText("scanner.scan_countdown", {p0:(this._simulationCountdown)}, this._hass) : this._busy ? haListManagerPanelText("ui.processing", {}, this._hass) : haListManagerPanelText("ui.execute_scan", {}, this._hass)}</button></div></ha-card>`;
  }

  _formatScanTime(value) {
    if (!value) return "–";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(haListManagerPanelTextLocale(this._hass), { dateStyle: "short", timeStyle: "medium" }).format(date);
  }

  _renderScanPagination(kind, total, page, pageSize) {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const first = total ? (page - 1) * pageSize + 1 : 0;
    const last = Math.min(total, page * pageSize);
    return `<div class="scan-pagination"><span>${haListManagerPanelText("ui.page_range", {p0:(first), p1:(last), p2:(total)}, this._hass)}</span><label>${haListManagerPanelText("ui.entries_per_page", {}, this._hass)} <select data-scan-page-size="${kind}">${[10, 25, 50, 100].map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size}</option>`).join("")}</select></label><div><button class="icon-button" type="button" data-scan-page="${kind}:previous" title="${haListManagerPanelText("ui.previous_page", {}, this._hass)}" ${page <= 1 ? "disabled" : ""}><ha-icon icon="mdi:chevron-left"></ha-icon></button><span>${haListManagerPanelText("ui.page_of_total", {p0:(page), p1:(pageCount)}, this._hass)}</span><button class="icon-button" type="button" data-scan-page="${kind}:next" title="${haListManagerPanelText("ui.next_page", {}, this._hass)}" ${page >= pageCount ? "disabled" : ""}><ha-icon icon="mdi:chevron-right"></ha-icon></button></div></div>`;
  }

  _renderScanHistory() {
    if (this._scanHistoryLoading && !this._scanHistoryLoaded) return this._loadingCard(haListManagerPanelText("scanner.loading_history", {}, this._hass));
    const rows = this._scanHistory.map((record) => {
      const list = this._findList(record.list_id);
      const action = SCANNER_ACTIONS(this._hass)[record.action]?.label || record.action || haListManagerPanelText("ui.no_target", {}, this._hass);
      const stock = record.stock_before === null || record.stock_after === null ? "" : `<span>${haListManagerPanelText("ui.stock_change", {p0:(record.stock_before), p1:(record.stock_after)}, this._hass)}</span>`;
      const tone = ["success", "resolved"].includes(record.status) ? "success" : ["queued", "offered", "needs_input", "not_found", "processing"].includes(record.status) ? "warning" : ["ignored", "dismissed"].includes(record.status) ? "neutral" : "error";
      return `<article class="history-row"><span class="history-status ${tone}"><ha-icon icon="mdi:${tone === "success" ? "check-circle-outline" : tone === "warning" ? "pencil-clock-outline" : tone === "neutral" ? "minus-circle-outline" : "alert-circle-outline"}"></ha-icon></span><div class="history-main"><strong>${this._escape(record.product_name || `EAN ${record.ean}`)}</strong><small>${this._escape(this._formatScanTime(record.scanned_at))} · ${this._escape(record.scanner_name || (record.source === "simulation" ? haListManagerPanelText("scanner.simulation", {}, this._hass) : record.scanner_address || haListManagerPanelText("scanner.unknown", {}, this._hass)))}</small><span>${this._escape(`${action}${list ? ` · ${list.name}` : ""}`)}</span>${stock}${record.message ? `<em>${this._escape(record.message)}</em>` : ""}</div><code>${this._escape(record.ean)}</code></article>`;
    }).join("");
    const queueStart = (this._scanQueuePage - 1) * this._scanQueuePageSize;
    const visiblePendingScans = this._pendingScans.slice(queueStart, queueStart + this._scanQueuePageSize);
    const pendingRows = visiblePendingScans.map((scan) => {
      const list = this._findList(scan.list_id);
      const action = SCANNER_ACTIONS(this._hass)[scan.action]?.label || scan.action || haListManagerPanelText("ui.no_action", {}, this._hass);
      return `<article class="history-row pending-history-row"><span class="history-status warning"><ha-icon icon="mdi:tray-alert"></ha-icon></span><div class="history-main"><strong>${this._escape(scan.product_name || `EAN ${scan.ean}`)}</strong><small>${this._escape(this._formatScanTime(scan.scanned_at))} · ${this._escape(action)}${list ? ` · ${this._escape(list.name)}` : ""}</small><em>${this._escape(scan.message || haListManagerPanelText("scanner.waiting_process_here", {}, this._hass))}</em></div><div class="row-actions"><button class="ha-button compact" type="button" data-edit-pending-scan="${scan.id}"><ha-icon icon="mdi:pencil-outline"></ha-icon>${haListManagerPanelText("ui.edit", {}, this._hass)}</button><button class="icon-button danger" type="button" data-dismiss-pending-scan="${scan.id}" title="${haListManagerPanelText("ui.discard", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div></article>`;
    }).join("");
    const queueContent = pendingRows ? `<ha-card class="list-card history-card">${pendingRows}</ha-card>${this._renderScanPagination("queue", this._pendingScans.length, this._scanQueuePage, this._scanQueuePageSize)}` : `<ha-card class="empty-state"><ha-icon icon="mdi:tray-check"></ha-icon><h3>${haListManagerPanelText("scanner.no_open_scans", {}, this._hass)}</h3><p>${haListManagerPanelText("help.scanner_pending_queue", {}, this._hass)}</p></ha-card>`;
    const historyContent = rows ? `<ha-card class="list-card history-card">${rows}</ha-card>${this._renderScanPagination("history", this._scanHistoryTotal, this._scanHistoryPage, this._scanHistoryPageSize)}` : `<ha-card class="empty-state"><ha-icon icon="mdi:history"></ha-icon><h3>${haListManagerPanelText("ui.no_scans_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("help.scanner_history_sources", {}, this._hass)}</p></ha-card>`;
    const activeTab = ["queue", "history", "devices", "simulation"].includes(this._scanHistoryTab) ? this._scanHistoryTab : "history";
    const tab = (id, icon, label) => `<button type="button" class="${activeTab === id ? "active" : ""}" data-history-tab="${id}" role="tab" aria-selected="${activeTab === id}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`;
    const tabs = `<div class="scan-history-tabs" role="tablist">${tab("queue", "mdi:tray-alert", haListManagerPanelText("scanner.queue_with_suffix", {p0:(this._pendingScans.length ? ` (${this._pendingScans.length})` : "")}, this._hass))}${tab("history", "mdi:history", haListManagerPanelText("ui.history", {}, this._hass))}${tab("devices", "mdi:barcode-scan", haListManagerPanelText("ui.devices", {}, this._hass))}${tab("simulation", "mdi:test-tube", haListManagerPanelText("scanner.simulation", {}, this._hass))}</div>`;
    const content = activeTab === "queue" ? queueContent : activeTab === "history" ? historyContent : activeTab === "devices" ? this._renderScannerDevices() : this._renderScannerSimulation();
    const refresh = ["queue", "history"].includes(activeTab) ? `<button class="ha-button" type="button" data-refresh-history><ha-icon icon="mdi:refresh"></ha-icon>${haListManagerPanelText("ui.refresh", {}, this._hass)}</button>` : "";
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:barcode-scan"></ha-icon><div><h2>${haListManagerPanelText("ui.scanner", {}, this._hass)}</h2><p>${haListManagerPanelText("help.scanner_overview", {}, this._hass)}</p></div></div>${refresh}</section>${this._inlineError()}${tabs}${content}`;
  }

  _renderSettings() {
    return `${this._heading("mdi:cog-outline", haListManagerPanelText("ui.settings", {}, this._hass), haListManagerPanelText("help.backend_defaults", {}, this._hass))}${this._inlineError()}
      <ha-card class="settings-card">
        <h3>${haListManagerPanelText("ui.product_name_after_lookup", {}, this._hass)}</h3>
        <p class="field-help">${haListManagerPanelText("help.default_product_name_details", {}, this._hass)}</p>
        <label class="setting-row"><ha-checkbox data-setting-brand></ha-checkbox><span><strong>${haListManagerPanelText("products.append_brand", {}, this._hass)}</strong><small>${haListManagerPanelText("help.append_brand_if_missing", {}, this._hass)}</small></span></label>
        <label class="setting-row"><ha-checkbox data-setting-quantity></ha-checkbox><span><strong>${haListManagerPanelText("ui.append_package_quantity", {}, this._hass)}</strong><small>${haListManagerPanelText("ui.product_name_example", {}, this._hass)}</small></span></label>
      </ha-card>
      <ha-card class="settings-card scanner-defaults"><h3>${haListManagerPanelText("ui.default_scanner_target", {}, this._hass)}</h3><p class="field-help">${haListManagerPanelText("help.default_inventory_target", {}, this._hass)}</p><div class="field-grid scanner-default-grid"><ha-select data-setting-scanner-list></ha-select><ha-select data-setting-scanner-action></ha-select></div></ha-card>
      <ha-card class="settings-card"><h3>${haListManagerPanelText("ui.tandoor_recipe_source", {}, this._hass)}</h3><p class="field-help">${haListManagerPanelText("help.tandoor_credentials", {}, this._hass)}</p><label class="field"><span>${haListManagerPanelText("recipes.tandoor_url", {}, this._hass)}</span><input type="url" data-setting-tandoor-url value="${this._escape(this._settings.tandoor_url || "")}" placeholder="https://rezepte.example.local" autocomplete="url"></label><label class="field"><span>${haListManagerPanelText("ui.api_token", {}, this._hass)}</span><input type="password" data-setting-tandoor-token value="" placeholder="${this._settings.tandoor_token_configured ? haListManagerPanelText("ui.token_saved_placeholder", {}, this._hass) : haListManagerPanelText("ui.tandoor_api_token", {}, this._hass)}" autocomplete="new-password"></label><div class="settings-inline-actions"><button class="ha-button" type="button" data-test-tandoor ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:connection"></ha-icon>${haListManagerPanelText("ui.test_connection", {}, this._hass)}</button><a class="ha-button" href="https://github.com/TandoorRecipes/recipes" target="_blank" rel="noopener noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>${haListManagerPanelText("ui.tandoor_recipe_source", {}, this._hass)}</a>${this._tandoorTestStatus ? `<span class="field-help settings-test-status">${this._escape(this._tandoorTestStatus)}</span>` : ""}</div></ha-card>
      <div class="settings-actions"><button class="ha-button primary" type="button" data-save-settings ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save_settings", {}, this._hass)}</button></div>`;
  }

  _renderNotifications() {
    const providerLabels = {
      notify_entity: haListManagerPanelText("notifications.entity_target", {}, this._hass),
      notify_service: haListManagerPanelText("notifications.notify_service", {}, this._hass),
      ntfy: haListManagerPanelText("ui.ntfy", {}, this._hass),
      persistent: haListManagerPanelText("notifications.ha_notification_area", {}, this._hass),
    };
    const providerIcons = {
      notify_entity: "mdi:cellphone-message",
      notify_service: "mdi:email-outline",
      ntfy: "mdi:message-badge-outline",
      persistent: "mdi:bell-badge-outline",
    };
    const rows = this._notificationProfiles.map((profile) => {
      const assigned = this._notificationAssignments.filter((item) => item.profile_id === profile.id).length;
      const target = profile.provider === "persistent" ? "Home Assistant" : profile.target;
      const telegram = profile.provider === "notify_entity" && this._notificationIsTelegram(profile.target);
      return `<article class="notification-profile-row ${profile.enabled ? "" : "disabled"}"><span class="notification-profile-icon"><ha-icon icon="${telegram ? "mdi:send" : providerIcons[profile.provider] || "mdi:bell-outline"}"></ha-icon></span><div class="notification-profile-main"><strong>${this._escape(profile.name)}</strong><small>${this._escape(telegram ? "Telegram" : providerLabels[profile.provider] || profile.provider)} · ${this._escape(target)}</small><span>${haListManagerPanelText(assigned === 1 ? "notifications.assigned_list" : "notifications.assigned_lists", { count: assigned }, this._hass)} · ${profile.enabled ? haListManagerPanelText("ui.active", {}, this._hass) : haListManagerPanelText("ui.disabled", {}, this._hass)}</span></div><div class="row-actions"><button class="ha-button compact" type="button" data-test-notification="${profile.id}" ${!profile.enabled || this._busy ? "disabled" : ""}><ha-icon icon="mdi:send-check-outline"></ha-icon>${haListManagerPanelText("ui.test", {}, this._hass)}</button><button class="icon-button" type="button" data-edit-notification="${profile.id}" title="${haListManagerPanelText("notifications.edit_target", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-notification="${profile.id}" title="${haListManagerPanelText("ui.delete_delivery_target", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div></article>`;
    }).join("");
    const profileContent = rows ? `<ha-card class="list-card">${rows}</ha-card>` : `<ha-card class="empty-state compact"><ha-icon icon="mdi:bell-plus-outline"></ha-icon><h3>${haListManagerPanelText("notifications.no_target_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("notifications.create_target_help", {}, this._hass)}</p></ha-card>`;
    const assignableLists = this._lists.filter((list) => list.list_type !== "inventory");
    const modeLabels = {
      off: haListManagerPanelText("ui.automatic_off", {}, this._hass),
      changes: haListManagerPanelText("ui.changes", {}, this._hass),
      full: haListManagerPanelText("notifications.full_list", {}, this._hass),
      changes_and_full: haListManagerPanelText("ui.changes_and_list", {}, this._hass),
    };
    const listCards = assignableLists.map((list) => {
      const supportsQuantityEvents = list.list_type !== "todo";
      const assignments = new Map(this._notificationAssignments.filter((item) => item.list_id === list.id).map((item) => [item.profile_id, item]));
      const selected = new Set(assignments.keys());
      const automaticCount = [...assignments.values()].filter((item) => item.automatic_mode !== "off" && item.profile?.enabled).length;
      const manualSelected = [...assignments.values()].some((item) => item.manual_enabled && item.profile?.enabled);
      const listExpanded = this._expandedNotificationLists.has(list.id);
      const selectedLabel = `${selected.size} ${selected.size === 1 ? haListManagerPanelText("ui.target", {}, this._hass) : haListManagerPanelText("ui.targets", {}, this._hass)}`;
      const automaticLabel = automaticCount ? `${automaticCount} automatisch` : haListManagerPanelText("ui.no_automation", {}, this._hass);
      const choices = this._notificationProfiles.length ? this._notificationProfiles.map((profile) => {
        const assignment = assignments.get(profile.id) || {
          manual_enabled: true, automatic_mode: "off", delay_seconds: 15,
          notify_on_add: true, notify_on_increase: true, notify_on_decrease: true,
          notify_on_edit: true, notify_on_complete: false, notify_on_reopen: false,
          notify_on_delete: true,
        };
        const key = `${list.id}:${profile.id}`;
        const checked = selected.has(profile.id);
        const settingsExpanded = checked && this._expandedNotificationProfiles.has(key);
        const delayLabel = assignment.delay_seconds === 0 ? haListManagerPanelText("ui.immediately_lowercase", {}, this._hass) : haListManagerPanelText("ui.after_seconds", {p0:(assignment.delay_seconds)}, this._hass);
        const summaryParts = [];
        if (assignment.manual_enabled) summaryParts.push(haListManagerPanelText("ui.manual", {}, this._hass));
        if (assignment.automatic_mode !== "off") summaryParts.push(`${modeLabels[assignment.automatic_mode] || assignment.automatic_mode} · ${delayLabel}`);
        if (!summaryParts.length) summaryParts.push(haListManagerPanelText("ui.no_active_delivery_method", {}, this._hass));
        const eventOptions = [
          ["add", haListManagerPanelText("ui.added", {}, this._hass)],
          ...(supportsQuantityEvents ? [["increase", haListManagerPanelText("ui.count_increased", {}, this._hass)], ["decrease", haListManagerPanelText("ui.quantity_decreased", {}, this._hass)]] : []),
          ["edit", haListManagerPanelText("ui.edited", {}, this._hass)],
          ["complete", haListManagerPanelText("ui.completed", {}, this._hass)], ["reopen", haListManagerPanelText("ui.reopened", {}, this._hass)],
          ["delete", haListManagerPanelText("ui.deleted", {}, this._hass)],
        ].map(([eventName, label]) => `<label><input type="checkbox" data-notification-event="${key}:${eventName}" ${assignment[`notify_on_${eventName}`] ? "checked" : ""}>${label}</label>`).join("");
        return `<div class="notification-assignment-choice ${profile.enabled ? "" : "disabled"}" data-notification-assignment-card="${key}"><div class="notification-assignment-heading"><label class="notification-assignment-identity"><input type="checkbox" data-notification-assignment="${key}" ${checked ? "checked" : ""} ${profile.enabled ? "" : "disabled"}><span><strong>${this._escape(profile.name)}</strong><small>${this._escape(providerLabels[profile.provider] || profile.provider)}${checked ? ` · ${this._escape(summaryParts.join(" · "))}` : ""}</small></span></label><button class="ha-button compact notification-settings-toggle" type="button" data-toggle-notification-settings="${key}" ${checked && profile.enabled ? "" : "disabled"}><span>${haListManagerPanelText("ui.settings", {}, this._hass)}</span><ha-icon icon="mdi:chevron-${settingsExpanded ? "up" : "down"}"></ha-icon></button></div><div class="notification-assignment-settings" data-notification-assignment-settings="${key}" ${settingsExpanded ? "" : "hidden"}><label class="notification-inline-toggle"><input type="checkbox" data-notification-manual="${key}" ${assignment.manual_enabled ? "checked" : ""}><span><strong>${haListManagerPanelText("notifications.offer_manual_send", {}, this._hass)}</strong><small>${haListManagerPanelText("help.share_destination", {}, this._hass)}</small></span></label><div class="notification-automatic-grid"><label class="field"><span>${haListManagerPanelText("ui.automatic_content", {}, this._hass)}</span><select data-notification-mode="${key}"><option value="off" ${assignment.automatic_mode === "off" ? "selected" : ""}>${haListManagerPanelText("ui.off", {}, this._hass)}</option><option value="changes" ${assignment.automatic_mode === "changes" ? "selected" : ""}>${haListManagerPanelText("ui.collected_changes", {}, this._hass)}</option><option value="full" ${assignment.automatic_mode === "full" ? "selected" : ""}>${haListManagerPanelText("notifications.full_list", {}, this._hass)}</option><option value="changes_and_full" ${assignment.automatic_mode === "changes_and_full" ? "selected" : ""}>${haListManagerPanelText("notifications.changes_and_full_list", {}, this._hass)}</option></select></label><label class="field notification-delay"><span>${haListManagerPanelText("ui.wait_time", {}, this._hass)}</span><div><input type="number" min="0" max="86400" step="1" value="${this._escape(assignment.delay_seconds)}" data-notification-delay="${key}"><span>${haListManagerPanelText("ui.seconds", {}, this._hass)}</span></div></label></div><fieldset class="notification-events" ${assignment.automatic_mode === "off" ? "disabled" : ""} data-notification-events="${key}"><legend>${haListManagerPanelText("notifications.notify_on", {}, this._hass)}</legend>${eventOptions}</fieldset><small class="notification-delay-help">${haListManagerPanelText("help.notification_delay", {}, this._hass)}</small></div></div>`;
      }).join("") : `<p class="field-help">${haListManagerPanelText("ui.create_delivery_target_first", {}, this._hass)}</p>`;
      return `<ha-card class="notification-list-card ${listExpanded ? "expanded" : ""}"><button class="notification-list-toggle" type="button" data-toggle-notification-list="${list.id}" aria-expanded="${listExpanded}"><span><strong>${this._escape(list.name)}</strong><small>${this._escape(LIST_TYPES(this._hass)[list.list_type]?.label || list.list_type)} · ${selectedLabel} · ${automaticLabel}</small></span><ha-icon icon="mdi:chevron-${listExpanded ? "up" : "down"}"></ha-icon></button><div class="notification-list-body" data-notification-list-body="${list.id}" ${listExpanded ? "" : "hidden"}><div class="notification-list-actions"><button class="ha-button compact" type="button" data-send-list-notification="${list.id}" ${!manualSelected || this._busy ? "disabled" : ""}><ha-icon icon="mdi:share-variant-outline"></ha-icon>${haListManagerPanelText("notifications.send_now", {}, this._hass)}</button><button class="ha-button primary compact" type="button" data-save-notification-assignments="${list.id}" ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.save_assignment", {}, this._hass)}</button></div><div class="notification-assignment-grid">${choices}</div></div></ha-card>`;
    }).join("");
    const status = this._notificationStatus ? `<div class="notification-status"><ha-icon icon="mdi:check-circle-outline"></ha-icon>${this._escape(this._notificationStatus)}</div>` : "";
    const tabs = `<div class="scan-history-tabs notification-tabs"><button class="${this._notificationTab === "profiles" ? "active" : ""}" type="button" data-notification-tab="profiles"><ha-icon icon="mdi:bell-cog-outline"></ha-icon>${haListManagerPanelText("ui.delivery_targets", {}, this._hass)}</button><button class="${this._notificationTab === "assignments" ? "active" : ""}" type="button" data-notification-tab="assignments"><ha-icon icon="mdi:link-variant"></ha-icon>${haListManagerPanelText("ui.assign_lists", {}, this._hass)}</button></div>`;
    const action = this._notificationTab === "profiles" ? `<button class="ha-button primary" type="button" data-add-notification><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.create_delivery_target", {}, this._hass)}</button>` : "";
    const content = this._notificationTab === "profiles"
      ? `<section class="notification-section"><h3>${haListManagerPanelText("ui.delivery_targets", {}, this._hass)}</h3><p>${haListManagerPanelText("help.notification_target_types", {}, this._hass)}</p>${profileContent}</section>`
      : `<section class="notification-section"><h3>${haListManagerPanelText("ui.assign_lists", {}, this._hass)}</h3><p>${haListManagerPanelText("help.delivery_list_assignments", {}, this._hass)}</p>${listCards || `<ha-card class="empty-state compact"><p>${haListManagerPanelText("ui.no_shopping_todo_lists", {}, this._hass)}</p></ha-card>`}</section>`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:bell-outline"></ha-icon><div><h2>${haListManagerPanelText("ui.notifications", {}, this._hass)}</h2><p>${haListManagerPanelText("notifications.central_management_help", {}, this._hass)}</p></div></div>${action}</section>${this._inlineError()}${status}${tabs}${content}`;
  }

  _renderInventory() {
    const lists = this._lists.filter((list) => list.list_type === "inventory");
    if (!lists.length) {
      return `${this._heading("mdi:package-variant-closed", haListManagerPanelText("ui.inventory", {}, this._hass), haListManagerPanelText("inventory.backend_stock_help", {}, this._hass))}${this._inlineError()}<ha-card class="empty-state"><ha-icon icon="mdi:playlist-plus"></ha-icon><h3>${haListManagerPanelText("inventory.no_list_yet", {}, this._hass)}</h3><p>${haListManagerPanelText("ui.create_inventory_list_first", {}, this._hass)}</p></ha-card>`;
    }
    const rows = this._inventoryEntries.map((entry) => {
      const product = entry.product;
      const state = entry.stock === 0 ? "empty" : entry.minimum_stock !== null && entry.stock < entry.minimum_stock ? "low" : "";
      const details = [product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : null].filter(Boolean);
      const categoryName = entry.category?.name || entry.category_name;
      if (categoryName) details.push(categoryName);
      return `<article class="inventory-row ${state}">
        ${product.image_url ? `<button class="inventory-image" type="button" data-view-inventory-image="${entry.id}" title="${haListManagerPanelText("ui.enlarge_product_image", {}, this._hass)}"><img src="${this._escape(product.image_url)}" alt="${haListManagerPanelText("products.image_alt", {p0:(this._escape(product.name))}, this._hass)}"></button>` : `<div class="inventory-image"><ha-icon icon="mdi:package-variant-closed"></ha-icon></div>`}
        <button class="inventory-open" type="button" data-edit-inventory="${entry.id}"><strong>${this._escape(product.name)}${this._inventoryRestockFlag("entry", entry.id)}</strong>${details.length ? `<small>${this._escape(details.join(" · "))}</small>` : ""}<small>${entry.minimum_stock === null ? haListManagerPanelText("ui.no_minimum_stock", {}, this._hass) : haListManagerPanelText("inventory.minimum_stock_value", {p0:(entry.minimum_stock)}, this._hass)} · ${this._escape(this._inventoryRestockSummary(entry))}</small></button>
        <div class="inventory-stock"><button class="icon-button" type="button" data-adjust-inventory="${entry.id}" data-delta="-1" title="${haListManagerPanelText("ui.decrease_stock", {}, this._hass)}"><ha-icon icon="mdi:minus"></ha-icon></button><strong>${entry.stock}</strong><button class="icon-button" type="button" data-adjust-inventory="${entry.id}" data-delta="1" title="${haListManagerPanelText("ui.increase_stock", {}, this._hass)}"><ha-icon icon="mdi:plus"></ha-icon></button></div>
        <div class="row-actions"><button class="icon-button" type="button" data-edit-inventory="${entry.id}" title="${haListManagerPanelText("ui.edit_inventory_entry", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-inventory="${entry.id}" title="${haListManagerPanelText("ui.remove_from_inventory", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>
      </article>`;
    }).join("");
    const groupRows = this._inventoryGroups.map((group) => {
      const members = group.member_ids.map((id) => this._findInventoryEntry(id)).filter(Boolean);
      const stock = members.reduce((sum, entry) => sum + entry.stock, 0);
      return `<article class="inventory-group-row"><span class="detail-icon"><ha-icon icon="mdi:group"></ha-icon></span><button class="inventory-open" type="button" data-edit-inventory-group="${group.id}"><strong>${this._escape(group.name)}${this._inventoryRestockFlag("group", group.id)}</strong><small>${members.map((entry) => entry.product.name).join(" · ")}</small><small>${haListManagerPanelText("ui.total_stock_summary", {p0:(stock), p1:(group.minimum_stock === null ? "" : (" " + haListManagerPanelText("inventory.minimum_value_suffix", {p0:(group.minimum_stock)}, this._hass))), p2:(this._escape(this._inventoryRestockSummary(group)))}, this._hass)}</small></button><div class="row-actions"><button class="icon-button" type="button" data-edit-inventory-group="${group.id}" title="${haListManagerPanelText("ui.edit_group", {}, this._hass)}"><ha-icon icon="mdi:pencil"></ha-icon></button><button class="icon-button danger" type="button" data-delete-inventory-group="${group.id}" title="${haListManagerPanelText("ui.dissolve_group", {}, this._hass)}"><ha-icon icon="mdi:ungroup"></ha-icon></button></div></article>`;
    }).join("");
    const content = this._inventoryLoading
      ? this._loadingCard(haListManagerPanelText("inventory.loading", {}, this._hass))
      : rows
        ? `${groupRows ? `<section class="inventory-groups"><h3>${haListManagerPanelText("ui.groups", {}, this._hass)}</h3><p>${haListManagerPanelText("help.inventory_group_variants", {}, this._hass)}</p><ha-card class="list-card">${groupRows}</ha-card></section>` : ""}<section class="inventory-products"><h3>${haListManagerPanelText("ui.item", {}, this._hass)}</h3><ha-card class="list-card">${rows}</ha-card></section>`
        : `<ha-card class="empty-state"><ha-icon icon="mdi:package-variant"></ha-icon><h3>${haListManagerPanelText("products.none_assigned", {}, this._hass)}</h3><p>${haListManagerPanelText("inventory.assign_products_help", {}, this._hass)}</p><button class="ha-button primary" type="button" data-add-inventory><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.add_product", {}, this._hass)}</button></ha-card>`;
    return `<section class="content-header with-action"><div class="heading-wrap"><ha-icon icon="mdi:package-variant-closed"></ha-icon><div><h2>${haListManagerPanelText("ui.inventory", {}, this._hass)}</h2><p>${haListManagerPanelText("help.inventory_management", {}, this._hass)}</p></div></div><div class="header-actions"><button class="ha-button" type="button" data-list-script="${this._selectedInventoryListId}"><ha-icon icon="mdi:script-text-outline"></ha-icon>${haListManagerPanelText("scripts.title", {}, this._hass)}</button><button class="ha-button" type="button" data-inventory-restock-settings><ha-icon icon="mdi:cog-transfer-outline"></ha-icon>${haListManagerPanelText("inventory.restock", {}, this._hass)}</button><button class="ha-button" type="button" data-add-inventory-group ${this._inventoryEntries.length < 2 ? "disabled" : ""}><ha-icon icon="mdi:account-multiple-plus-outline"></ha-icon>${haListManagerPanelText("ui.create_group", {}, this._hass)}</button><button class="ha-button primary" type="button" data-add-inventory><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.add_product", {}, this._hass)}</button></div></section><div class="inventory-toolbar"><ha-select data-inventory-list-filter></ha-select></div>${this._inlineError()}${content}`;
  }

  _renderDialog() {
    if (!this._dialog) return "";
    if (["entity-history-import", "entity-history-import-choice"].includes(this._dialog.kind)) return this._renderEntityHistoryImport();
    if (this._dialog.kind === "entity-samples") return this._renderEntitySamples();
    if (this._dialog.kind === "entity-sample-editor") return this._renderEntitySampleEditor();
    if (this._dialog.kind === "entity-sample-delete") return this._renderDeleteEntitySample();
    if (this._dialog.kind === "data-restore") return this._renderDataRestore();
    if (this._dialog.kind === "data-backup-delete") return this._renderDataBackupDelete();
    if (this._dialog.kind === "image-viewer") {
      return `<div class="dialog-backdrop image-backdrop" data-close-dialog><section class="dialog image-dialog" role="dialog" aria-modal="true" data-dialog-panel>
        ${this._dialogHeader(this._dialog.record.name)}
        <img src="${this._escape(this._openFoodFactsImageUrl(this._dialog.record.image_url, "400"))}" alt="${haListManagerPanelText("products.image_alt", {p0:(this._escape(this._dialog.record.name))}, this._hass)}">
      </section></div>`;
    }
    if (["delete-list", "delete-item", "delete-product", "delete-category", "delete-label", "delete-chip", "delete-dish", "delete-inventory", "delete-inventory-group", "delete-scanner", "delete-notification", "delete-category-rule"].includes(this._dialog.kind)) {
      const isList = this._dialog.kind === "delete-list";
      const isProduct = this._dialog.kind === "delete-product";
      const isCategory = this._dialog.kind === "delete-category";
      const isCategoryRule = this._dialog.kind === "delete-category-rule";
      const isLabel = this._dialog.kind === "delete-label";
      const isChip = this._dialog.kind === "delete-chip";
      const isDish = this._dialog.kind === "delete-dish";
      const isInventory = this._dialog.kind === "delete-inventory";
      const isInventoryGroup = this._dialog.kind === "delete-inventory-group";
      const isScanner = this._dialog.kind === "delete-scanner";
      const isNotification = this._dialog.kind === "delete-notification";
      const isBringList = isList && this._dialog.record.list_type === "bring";
      const label = isList ? haListManagerPanelText("ui.list", {}, this._hass) : isProduct ? haListManagerPanelText("ui.product", {}, this._hass) : isCategory ? haListManagerPanelText("ui.category", {}, this._hass) : isCategoryRule ? haListManagerPanelText("ui.rule", {}, this._hass) : isLabel ? haListManagerPanelText("ui.label", {}, this._hass) : isChip ? haListManagerPanelText("ui.chip", {}, this._hass) : isDish ? haListManagerPanelText("ui.dish", {}, this._hass) : isInventory ? haListManagerPanelText("ui.inventory_assignment", {}, this._hass) : isInventoryGroup ? haListManagerPanelText("inventory.group", {}, this._hass) : isScanner ? haListManagerPanelText("ui.scanner", {}, this._hass) : isNotification ? haListManagerPanelText("notifications.delivery_target", {}, this._hass) : haListManagerPanelText("ui.entry", {}, this._hass);
      const linkedChipCount = this._dialog.linked_chip_count;
      const productChipNotice = isProduct && linkedChipCount
        ? (linkedChipCount === 1 ? (" " + haListManagerPanelText("chips.product_unlinked_one", {count: linkedChipCount}, this._hass)) : (" " + haListManagerPanelText("chips.product_unlinked_many", {count: linkedChipCount}, this._hass)))
        : "";
      return `<div class="dialog-backdrop" data-close-dialog><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>
        ${this._dialogHeader(isInventoryGroup ? haListManagerPanelText("inventory.confirm_dissolve_group", {}, this._hass) : haListManagerPanelText("ui.confirm_delete_named", {p0:(label)}, this._hass))}<p>${isInventoryGroup ? haListManagerPanelText("ui.dissolve_group_warning", {p0:(this._escape(this._dialog.record.name))}, this._hass) : isBringList ? haListManagerPanelText("bring.unlink_effect", {p0:(this._escape(this._dialog.record.name))}, this._hass) : haListManagerPanelText("ui.confirm_permanent_remove_named", {p0:(this._escape(isInventory ? this._dialog.record.product.name : this._dialog.record.name)), p1:(isList ? (" " + haListManagerPanelText("ui.delete_list_items_warning", {}, this._hass)) : isCategory ? (" " + haListManagerPanelText("categories.delete_assignment_impact", {}, this._hass)) : isCategoryRule ? (" " + haListManagerPanelText("categories.delete_rule_impact", {}, this._hass)) : isInventory ? (" " + haListManagerPanelText("inventory.product_record_kept", {}, this._hass)) : productChipNotice)}, this._hass)}</p>
        ${this._dialogError()}
        <div class="dialog-actions"><button class="ha-button destructive" data-confirm-delete ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.processing", {}, this._hass) : isInventoryGroup ? haListManagerPanelText("ui.dissolve_group", {}, this._hass) : haListManagerPanelText("ui.delete", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
      </section></div>`;
    }
    if (this._dialog.kind === "list-script") return this._renderListScriptDialog();
    if (this._dialog.kind === "list-editor") return this._renderListDialog();
    if (this._dialog.kind === "list-scope-toggle") return this._renderListScopeToggleDialog();
    if (this._dialog.kind === "product-editor") return this._renderProductDialog();
    if (this._dialog.kind === "category-rules-bulk") return this._renderCategoryRulesBulkDialog();
    if (this._dialog.kind === "category-products") return this._renderCategoryProductsDialog();
    if (this._dialog.kind === "category-editor") return this._renderCategoryDialog();
    if (this._dialog.kind === "label-editor") return this._renderLabelDialog();
    if (this._dialog.kind === "chip-editor") return this._renderChipDialog();
    if (this._dialog.kind === "dish-editor") return this._renderDishDialog();
    if (this._dialog.kind === "inventory-editor") return this._renderInventoryDialog();
    if (this._dialog.kind === "inventory-group-editor") return this._renderInventoryGroupDialog();
    if (this._dialog.kind === "inventory-restock-settings") return this._renderInventoryRestockSettingsDialog();
    if (this._dialog.kind === "scanner-editor") return this._renderScannerDialog();
    if (this._dialog.kind === "notification-editor") return this._renderNotificationDialog();
    return this._renderItemDialog();
  }

  _dialogHeader(title) {
    return `<div class="dialog-header"><h2>${this._escape(title)}</h2><button class="icon-button dialog-close" type="button" data-cancel-dialog title="${haListManagerPanelText("ui.close", {}, this._hass)}" aria-label="${haListManagerPanelText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>`;
  }

  _restockModeLabel(mode) {
    return ({ continuous: haListManagerPanelText("ui.restock_continuous_shortfall", {}, this._hass), fixed: haListManagerPanelText("ui.fixed_quantity_below_minimum", {}, this._hass), one_to_one: haListManagerPanelText("ui.restock_each_withdrawal", {}, this._hass), disabled: haListManagerPanelText("inventory.no_auto_restock", {}, this._hass) })[mode] || haListManagerPanelText("ui.no_default_rule_option", {}, this._hass);
  }

  _inventoryRestockLatch(sourceType, sourceId) {
    return this._inventoryRestockPreview.find((item) => item.source_type === sourceType && item.source_id === sourceId && item.latched) || null;
  }

  _inventoryRestockFlag(sourceType, sourceId) {
    if (!this._inventoryRestockLatch(sourceType, sourceId)) return "";
    return `<ha-icon class="inventory-restock-flag" icon="mdi:flag" title="${haListManagerPanelText("inventory.restock_sent_locked", {}, this._hass)}"></ha-icon>`;
  }

  _inventoryRestockRuleMarkup(draft, kind = haListManagerPanelText("ui.item", {}, this._hass)) {
    const standardMode = this._inventoryRestockSettings.mode || null;
    const standardQuantity = this._inventoryRestockSettings.fixed_quantity;
    const standard = standardMode === "fixed" && standardQuantity
      ? `${this._restockModeLabel(standardMode)} (${standardQuantity})`
      : this._restockModeLabel(standardMode);
    const mode = draft.restock_mode || "inherit";
    const effectiveMode = mode === "inherit" ? standardMode : mode;
    const missingMinimum = effectiveMode === "fixed" && String(draft.minimum_stock ?? "").trim() === "";
    const inheritedFixedWithoutQuantity = mode === "inherit" && standardMode === "fixed" && !standardQuantity;
    const sourceId = kind === haListManagerPanelText("ui.item", {}, this._hass) ? this._dialog?.record?.id : null;
    const containingGroup = sourceId ? this._inventoryGroups.find((group) => (group.member_ids || []).includes(sourceId)) : null;
    const latchType = containingGroup || kind === haListManagerPanelText("inventory.group", {}, this._hass) ? "group" : "entry";
    const latchId = containingGroup?.id || this._dialog?.record?.id;
    const latched = latchId ? this._inventoryRestockLatch(latchType, latchId) : null;
    return `<label class="field"><span>${haListManagerPanelText("ui.restock_rule", {}, this._hass)}</span><select data-inventory-restock-rule>
      <option value="inherit" ${mode === "inherit" ? "selected" : ""}>${haListManagerPanelText("inventory.use_list_default_value", {p0:(this._escape(standard))}, this._hass)}</option>
      <option value="disabled" ${mode === "disabled" ? "selected" : ""}>${haListManagerPanelText("inventory.no_auto_restock", {}, this._hass)}</option>
      <option value="continuous" ${mode === "continuous" ? "selected" : ""}>${haListManagerPanelText("ui.restock_continuous_shortfall", {}, this._hass)}</option>
      <option value="fixed" ${mode === "fixed" ? "selected" : ""}>${haListManagerPanelText("ui.fixed_quantity_below_minimum", {}, this._hass)}</option>
      <option value="one_to_one" ${mode === "one_to_one" ? "selected" : ""}>${haListManagerPanelText("ui.restock_each_withdrawal", {}, this._hass)}</option>
    </select></label>
    ${mode === "fixed" ? `<label class="field"><span>${haListManagerPanelText("ui.fixed_restock_quantity", {}, this._hass)}</span><input type="number" min="1" max="1000000" step="1" data-inventory-restock-quantity value="${this._escape(draft.restock_quantity)}"></label><p class="field-help inventory-minimum-help">${haListManagerPanelText("help.automatic_manual_restock_quantity", {p0:(kind === haListManagerPanelText("inventory.group", {}, this._hass) ? haListManagerPanelText("ui.the_group", {}, this._hass) : haListManagerPanelText("ui.this_item", {}, this._hass))}, this._hass)}</p>` : ""}
    ${missingMinimum ? `<div class="inventory-restock-notice"><ha-icon icon="mdi:alert-outline"></ha-icon><span>${haListManagerPanelText("help.fixed_restock_minimum_required", {}, this._hass)}</span></div>` : ""}
    ${latched ? `<div class="inventory-restock-latch-notice"><ha-icon icon="mdi:flag"></ha-icon><span><strong>${haListManagerPanelText("inventory.restock_lock_active", {}, this._hass)}</strong><small>${haListManagerPanelText("help.restock_lock_release", {p0:(containingGroup ? haListManagerPanelText("inventory.group_already_restocked", {p0:(this._escape(containingGroup.name))}, this._hass) : haListManagerPanelText("ui.already_restocked", {}, this._hass))}, this._hass)}</small></span><button class="ha-button compact" type="button" data-reset-inventory-restock-latch="${latchType}:${this._escape(latchId)}" title="${haListManagerPanelText("help.reset_restock_lock", {}, this._hass)}"><ha-icon icon="mdi:flag-remove-outline"></ha-icon>${haListManagerPanelText("ui.reset_lock", {}, this._hass)}</button></div>` : ""}
    ${inheritedFixedWithoutQuantity ? `<div class="inventory-restock-notice"><ha-icon icon="mdi:information-outline"></ha-icon><span>${haListManagerPanelText("help.fixed_default_without_quantity", {p0:(kind === haListManagerPanelText("inventory.group", {}, this._hass) ? haListManagerPanelText("ui.this_group", {}, this._hass) : haListManagerPanelText("ui.this_item", {}, this._hass))}, this._hass)}</span></div>` : ""}
    ${containingGroup ? `<div class="inventory-restock-notice"><ha-icon icon="mdi:account-group-outline"></ha-icon><span>${haListManagerPanelText("help.group_overrides_item_restock", {p0:(this._escape(containingGroup.name))}, this._hass)}</span></div>` : ""}
    ${kind === haListManagerPanelText("inventory.group", {}, this._hass) ? `<p class="field-help">${haListManagerPanelText("help.group_restock_rule_priority", {}, this._hass)}</p>` : ""}`;
  }

  _inventoryRestockSummary(source) {
    const mode = source.restock_mode || this._inventoryRestockSettings.mode;
    if (!mode || mode === "disabled") return haListManagerPanelText("inventory.no_auto_restock", {}, this._hass);
    if (mode !== "fixed") return this._restockModeLabel(mode);
    const quantity = source.restock_mode === "fixed" ? source.restock_quantity : this._inventoryRestockSettings.fixed_quantity;
    return quantity ? haListManagerPanelText("ui.fixed_quantity_value", {p0:(quantity)}, this._hass) : haListManagerPanelText("inventory.fixed_quantity_unset", {}, this._hass);
  }

  _renderInventoryRestockSettingsDialog() {
    const settings = this._dialog.draft;
    const targets = this._lists
      .filter((list) => list.list_type === "shopping" && list.provider === "local")
      .map((list) => `<option value="${this._escape(list.id)}" ${list.id === settings.target_list_id ? "selected" : ""}>${this._escape(list.name)}</option>`)
      .join("");
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog inventory-restock-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(haListManagerPanelText("ui.automatic_restock", {}, this._hass))}
      <p class="field-help">${haListManagerPanelText("help.inventory_restock_settings", {}, this._hass)}</p>
      <label class="setting-row inventory-restock-toggle"><input type="checkbox" data-inventory-restock-enabled ${settings.enabled ? "checked" : ""}><span><strong>${haListManagerPanelText("ui.automatic_restock", {}, this._hass)}</strong><small>${haListManagerPanelText("help.inventory_restock_transfer", {}, this._hass)}</small></span></label>
      <label class="field"><span>${haListManagerPanelText("shopping.target_list", {}, this._hass)}</span><select data-inventory-restock-target><option value="">${haListManagerPanelText("ui.please_select", {}, this._hass)}</option>${targets}</select></label>
      <label class="field"><span>${haListManagerPanelText("inventory.default_rule_help", {}, this._hass)}</span><select data-inventory-restock-mode><option value="none" ${!settings.mode ? "selected" : ""}>${haListManagerPanelText("ui.no_default_rule_option", {}, this._hass)}</option><option value="continuous" ${settings.mode === "continuous" ? "selected" : ""}>${haListManagerPanelText("ui.restock_continuous_shortfall", {}, this._hass)}</option><option value="fixed" ${settings.mode === "fixed" ? "selected" : ""}>${haListManagerPanelText("ui.fixed_quantity_below_minimum", {}, this._hass)}</option><option value="one_to_one" ${settings.mode === "one_to_one" ? "selected" : ""}>${haListManagerPanelText("ui.restock_each_withdrawal", {}, this._hass)}</option></select></label>
      ${settings.mode === "fixed" ? `<label class="field"><span>${haListManagerPanelText("ui.default_quantity_optional", {}, this._hass)}</span><input type="number" min="1" max="1000000" step="1" data-inventory-restock-default-quantity value="${this._escape(settings.fixed_quantity ?? "")}" placeholder="${haListManagerPanelText("ui.rule_empty_per_item", {}, this._hass)}"></label><p class="field-help">${haListManagerPanelText("help.default_fixed_restock_quantity", {}, this._hass)}</p>` : ""}
      <div class="restock-mode-help"><p><strong>${haListManagerPanelText("ui.no_default_rule", {}, this._hass)}</strong> ${haListManagerPanelText("help.restock_rules_only", {}, this._hass)}</p><p><strong>${haListManagerPanelText("inventory.continuous_shortage_restock", {}, this._hass)}</strong> ${haListManagerPanelText("help.continuous_shortfall_quantity", {}, this._hass)}</p><p><strong>${haListManagerPanelText("ui.restock_fixed_threshold_quantity", {}, this._hass)}</strong> ${haListManagerPanelText("help.fixed_restock_trigger", {}, this._hass)}</p><p><strong>${haListManagerPanelText("inventory.each_withdrawal_one_to_one", {}, this._hass)}</strong> ${haListManagerPanelText("help.transfer_every_removal", {}, this._hass)}</p></div>
      <p class="field-help"><strong>${haListManagerPanelText("inventory.manual_shortage_transfer", {}, this._hass)}</strong> ${haListManagerPanelText("help.manual_shortage_calculation", {}, this._hass)}</p>
      <p class="field-help">${haListManagerPanelText("help.restock_rule_precedence", {}, this._hass)}</p>
      ${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" data-save-inventory-restock-settings ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _productCategoryForList(product, listId) {
    return (product.category_assignments || []).find((assignment) => assignment.scope === "list" && assignment.list_id === listId) || null;
  }

  _categoryProductIdentity(product) {
    const details = [product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : haListManagerPanelText("ui.without_ean", {}, this._hass)].filter(Boolean);
    const image = product.image_url
      ? `<span class="category-product-image"><img src="${this._escape(product.image_url)}" alt=""></span>`
      : `<span class="category-product-image"><ha-icon icon="mdi:barcode-scan"></ha-icon></span>`;
    return `${image}<span class="category-product-copy"><strong>${this._escape(product.name)}</strong><small>${this._escape(details.join(" · "))}</small></span>`;
  }

  _renderCategoryProductResults() {
    const dialog = this._dialog;
    if (dialog?.kind !== "category-products") return "";
    if (dialog.search_loading) return `<div class="category-product-state"><ha-circular-progress active></ha-circular-progress>${haListManagerPanelText("products.searching", {}, this._hass)}</div>`;
    if (!dialog.search_results.length) return `<div class="category-product-state">${haListManagerPanelText("ui.no_matching_products", {}, this._hass)}</div>`;
    const listId = dialog.record.list_id;
    const visibleProducts = dialog.search_results.filter((product) => {
      const assignment = this._productCategoryForList(product, listId);
      return dialog.show_assigned || !assignment;
    });
    if (!visibleProducts.length) return `<div class="category-product-state">${haListManagerPanelText("categories.all_matches_assigned", {}, this._hass)}</div>`;
    const rows = visibleProducts.map((product) => {
      const assignment = this._productCategoryForList(product, listId);
      const isCurrent = assignment?.category_id === dialog.record.id;
      const status = isCurrent
        ? `<span class="category-product-status current"><ha-icon icon="mdi:check-circle-outline"></ha-icon>${haListManagerPanelText("ui.already_here", {}, this._hass)}</span>`
        : assignment
          ? `<span class="category-product-status conflict"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${haListManagerPanelText("ui.already_in_target", {p0:(this._escape(assignment.category?.name || haListManagerPanelText("ui.another_category", {}, this._hass)))}, this._hass)}</span>`
          : `<span class="category-product-status"><ha-icon icon="mdi:plus-circle-outline"></ha-icon>${haListManagerPanelText("ui.assign", {}, this._hass)}</span>`;
      return `<button class="category-product-result${assignment && !isCurrent ? " conflict" : ""}" type="button" data-assign-category-product="${product.id}" ${isCurrent ? "disabled" : ""}>${this._categoryProductIdentity(product)}${status}</button>`;
    }).join("");
    const note = dialog.search_total > dialog.search_results.length
      ? `<p class="category-product-result-note">${haListManagerPanelText("ui.search_result_count", {p0:(dialog.search_results.length), p1:(dialog.search_total)}, this._hass)}</p>`
      : "";
    return `${rows}${note}`;
  }

  _renderCategoryProductsDialog() {
    const { record } = this._dialog;
    const list = this._findList(record.list_id);
    const confirmation = this._dialog.move_confirmation;
    const moveDialog = confirmation ? `<div class="dialog-backdrop nested-confirmation"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" data-dialog-panel><div class="confirmation-icon"><ha-icon icon="mdi:alert-outline"></ha-icon></div><h3>${haListManagerPanelText("ui.move_product_confirm", {}, this._hass)}</h3><p>${haListManagerPanelText("categories.confirm_reassign_product", {p0:(this._escape(confirmation.product.name)), p1:(this._escape(list?.name || haListManagerPanelText("ui.this_list_fragment", {}, this._hass))), p2:(this._escape(confirmation.category.category?.name || confirmation.category.name || haListManagerPanelText("ui.unknown", {}, this._hass))), p3:(this._escape(record.name))}, this._hass)}</p><div class="dialog-actions"><button class="ha-button primary" type="button" data-confirm-category-product-move>${haListManagerPanelText("ui.move", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-category-product-move>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>` : "";
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog category-products-dialog" role="dialog" aria-modal="true" data-dialog-panel data-category-products-dialog>
      ${this._dialogHeader(haListManagerPanelText("ui.assign_product", {}, this._hass))}
      <p>${haListManagerPanelText("help.assign_category_products", {p0:(this._escape(record.name))}, this._hass)}</p>
      <label class="category-product-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" value="${this._escape(this._dialog.search)}" placeholder="${haListManagerPanelText("ui.search_product_brand_ean", {}, this._hass)}" autocomplete="off" data-category-product-search></label>
      <label class="category-product-filter"><input type="checkbox" data-category-product-show-assigned ${this._dialog.show_assigned ? "checked" : ""}>${haListManagerPanelText("ui.show_assigned_products", {}, this._hass)}</label>
      <div class="category-product-results" data-category-product-results>${this._renderCategoryProductResults()}</div>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.close", {}, this._hass)}</button></div>
    </section>${moveDialog}</div>`;
  }

  _renderCategoryRulesBulkDialog() {
    const { record, text } = this._dialog;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog category-rules-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(haListManagerPanelText("ui.edit_multiple_rules", {}, this._hass))}
      <p>${haListManagerPanelText("help.category_rule_lines", {p0:(this._escape(record.name))}, this._hass)}</p>
      <label class="field"><span>${haListManagerPanelText("ui.assignment_rules", {}, this._hass)}</span><textarea rows="10" maxlength="10100" data-category-rules-bulk placeholder="${haListManagerPanelText("categories.match_rules_example", {}, this._hass)}">${this._escape(text)}</textarea></label>
      <p class="field-help">${haListManagerPanelText("categories.rule_examples_limit", {exact: `<code>${this._escape(haListManagerPanelText("products.example_tomatoes", {}, this._hass))}</code>`, prefix: `<code>${this._escape(haListManagerPanelText("ui.prefix_match_example", {}, this._hass))}</code>`, word: `<code>${this._escape(haListManagerPanelText("ui.contains_match_example", {}, this._hass))}</code>`}, this._hass)}</p>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" type="button" data-save-category-rules-bulk ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save_rules", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _notificationIsTelegram(target) {
    return this._notificationEntityPlatforms[target] === "telegram_bot";
  }

  _notificationFormatOptions(draft) {
    const options = [["plain", haListManagerPanelText("ui.text", {}, this._hass)]];
    const telegram = draft.provider === "telegram";
    if (draft.provider !== "notify_entity" || telegram) {
      options.push(["markdown", haListManagerPanelText("ui.markdown", {}, this._hass)]);
      if (draft.provider === "notify_service" || telegram) options.push(["html", "HTML"]);
    }
    return options;
  }

  _renderNotificationDialog() {
    const { record, draft } = this._dialog;
    const ntfyAvailable = Boolean(this._hass?.services?.ntfy?.publish);
    const providerHelp = {
      telegram: haListManagerPanelText("help.telegram_delivery", {}, this._hass),
      notify_entity: haListManagerPanelText("help.notify_entity_delivery", {}, this._hass),
      notify_service: haListManagerPanelText("help.classic_notify_services", {}, this._hass),
      ntfy: ntfyAvailable ? haListManagerPanelText("help.ntfy_delivery", {}, this._hass) : haListManagerPanelText("notifications.ntfy_not_installed", {}, this._hass),
      persistent: haListManagerPanelText("help.persistent_notification", {}, this._hass),
    };
    const needsEntity = ["notify_entity", "telegram", "ntfy"].includes(draft.provider);
    const needsService = draft.provider === "notify_service";
    const hasSeparateNotifyService = Object.keys(this._hass?.services?.notify || {}).some((service) => !["notify", "send_message", "persistent_notification", "ntfy"].includes(service) && !service.startsWith("mobile_app_") && !this._notificationIsTelegram(`notify.${service}`));
    const notifyEntityPicker = customElements.get("ha-generic-picker")
      ? `<ha-generic-picker class="selector-field" data-notification-target-picker></ha-generic-picker>`
      : `<ha-selector class="selector-field" data-notification-target-selector></ha-selector>`;
    const targetField = needsEntity
      ? `<div class="notification-target-field">${draft.provider !== "ntfy" ? notifyEntityPicker : `<ha-selector class="selector-field" data-notification-target-selector></ha-selector>`}<small data-notification-target-id>${draft.target ? this._escape(draft.target) : draft.provider === "ntfy" && !ntfyAvailable ? haListManagerPanelText("ui.no_ntfy_entity", {}, this._hass) : ""}</small></div>`
      : needsService
        ? `<div class="notification-target-field"><ha-select class="selector-field" data-notification-service-select></ha-select><small>${hasSeparateNotifyService ? haListManagerPanelText("help.separate_delivery_methods", {}, this._hass) : haListManagerPanelText("notifications.no_notify_service", {}, this._hass)}</small></div>`
        : "";
    const formatOptions = this._notificationFormatOptions(draft);
    const formatSelect = formatOptions.map(([value, label]) => `<option value="${value}" ${draft.message_format === value ? "selected" : ""}>${label}</option>`).join("");
    const clickField = draft.provider === "notify_entity" ? `<label class="field" data-notification-click-field><span>${haListManagerPanelText("ui.open_on_tap_optional", {}, this._hass)}</span><input type="text" maxlength="1000" data-notification-click-url value="${this._escape(draft.click_url)}" placeholder="${haListManagerPanelText("ui.dashboard_path_example", {}, this._hass)}"><small>${haListManagerPanelText("help.notification_open_path", {}, this._hass)}</small></label>` : "";
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog notification-dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(record ? haListManagerPanelText("notifications.edit_target", {}, this._hass) : haListManagerPanelText("ui.create_delivery_target", {}, this._hass))}<label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-notification-name value="${this._escape(draft.name)}" placeholder="${haListManagerPanelText("ui.family_phones_example", {}, this._hass)}"></label><label class="field"><span>${haListManagerPanelText("ui.delivery_method", {}, this._hass)}</span><select data-notification-provider><option value="telegram" ${draft.provider === "telegram" ? "selected" : ""}>Telegram</option><option value="notify_entity" ${draft.provider === "notify_entity" ? "selected" : ""}>${haListManagerPanelText("notifications.entity_target", {}, this._hass)}</option><option value="persistent" ${draft.provider === "persistent" ? "selected" : ""}>${haListManagerPanelText("notifications.persistent_target", {}, this._hass)}</option><option value="notify_service" ${draft.provider === "notify_service" ? "selected" : ""}>${haListManagerPanelText("notifications.separate_notify_service", {}, this._hass)}</option><option value="ntfy" ${draft.provider === "ntfy" ? "selected" : ""}>${haListManagerPanelText("ui.ntfy", {}, this._hass)}</option></select><small>${this._escape(providerHelp[draft.provider] || "")}</small></label>${targetField}${clickField}<div class="field-grid notification-message-fields"><label class="field"><span>${haListManagerPanelText("ui.title_optional", {}, this._hass)}</span><input type="text" maxlength="200" data-notification-title value="${this._escape(draft.title)}" placeholder="${haListManagerPanelText("ui.default_list_name", {}, this._hass)}"></label><label class="field"><span>${haListManagerPanelText("notifications.message_format", {}, this._hass)}</span><select data-notification-format>${formatSelect}</select><small data-notification-format-help ${draft.provider === "telegram" ? "" : "hidden"}>${draft.provider === "telegram" ? haListManagerPanelText("help.telegram_formats", {}, this._hass) : ""}</small></label></div><label class="setting-row compact-setting"><ha-checkbox data-notification-enabled></ha-checkbox><span><strong>${haListManagerPanelText("ui.delivery_target_enabled", {}, this._hass)}</strong><small>${haListManagerPanelText("help.disabled_destinations", {}, this._hass)}</small></span></label>${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" type="button" data-save-notification ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _renderCategoryDialog() {
    const draft = this._dialog.draft;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog category-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? haListManagerPanelText("ui.edit_category", {}, this._hass) : haListManagerPanelText("categories.create", {}, this._hass))}
      <label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-category-name value="${this._escape(draft.name)}" autocomplete="off"></label>
      <ha-selector class="selector-field" data-category-scope-selector></ha-selector>
      ${draft.scope === "list_type" ? `<ha-selector class="selector-field" data-category-list-type-selector></ha-selector>` : ""}
      ${draft.scope === "list" ? `<ha-selector class="selector-field" data-category-list-selector></ha-selector>` : ""}
      <ha-selector class="selector-field" data-category-icon-selector></ha-selector>
      <label class="field"><span>${haListManagerPanelText("ui.base_position_optional", {}, this._hass)}</span><input type="number" min="1" max="1000001" step="1" data-category-position value="${this._escape(draft.position)}"></label>
      <p class="field-help">${haListManagerPanelText("help.category_sort_position", {}, this._hass)}</p>
      <div class="color-field"><ha-input class="selector-field" type="color" data-category-color-selector></ha-input><button class="ha-button" type="button" data-clear-category-color ${draft.color ? "" : "disabled"}><ha-icon icon="mdi:palette-remove-outline"></ha-icon>${haListManagerPanelText("ui.use_default_color", {}, this._hass)}</button></div>
      <p class="field-help">${haListManagerPanelText("help.card_default_color", {}, this._hass)}</p>
      ${this._dialog.record ? "" : `<label class="field"><span>${haListManagerPanelText("categories.optional_auto_assignment", {}, this._hass)}</span><textarea rows="5" maxlength="10100" data-category-initial-rules placeholder="${haListManagerPanelText("categories.match_rules_example", {}, this._hass)}">${this._escape(draft.rules_text || "")}</textarea><small>${haListManagerPanelText("help.assignment_rules_per_line", {}, this._hass)}</small></label>`}
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-category ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderLabelDialog() {
    const draft = this._dialog.draft;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog category-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? haListManagerPanelText("ui.edit_label", {}, this._hass) : haListManagerPanelText("labels.create", {}, this._hass))}
      <label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-label-name value="${this._escape(draft.name)}" autocomplete="off"></label>
      <ha-select class="selector-field" data-label-scope-select></ha-select>
      ${draft.scope === "list_type" ? `<ha-select class="selector-field" data-label-list-type-select></ha-select>` : ""}
      ${draft.scope === "list" ? `<ha-select class="selector-field" data-label-list-select></ha-select>` : ""}
      <ha-selector class="selector-field" data-label-icon-selector></ha-selector>
      <div class="color-field"><ha-input class="selector-field" type="color" data-label-color-selector></ha-input><button class="ha-button" type="button" data-clear-label-color ${draft.color ? "" : "disabled"}><ha-icon icon="mdi:palette-remove-outline"></ha-icon>${haListManagerPanelText("ui.use_default_color", {}, this._hass)}</button></div>
      <p class="field-help">${haListManagerPanelText("help.label_scope", {}, this._hass)}</p>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-label ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderChipDialog() {
    const draft = this._dialog.draft;
    const isTodo = draft.chip_kind === "todo_template";
    const targetList = this._findList(draft.list_id);
    const availableCategories = this._categories.filter((category) => category.scope === "global" || (category.scope === "list_type" && category.list_type === "todo") || (draft.scope === "list" && category.scope === "list" && category.list_id === targetList?.id));
    const availableLabels = this._labels.filter((label) => label.scope === "global" || (label.scope === "list_type" && label.list_type === "todo") || (draft.scope === "list" && label.scope === "list" && label.list_id === targetList?.id));
    const selectedLabels = availableLabels.filter((label) => draft.label_ids?.includes(label.id));
    const selectedProduct = (this._dialog.product_options || []).find((product) => product.id === draft.product_id)
      || (draft.product_id ? { id: draft.product_id, name: this._dialog.record?.product_name || haListManagerPanelText("ui.linked_product", {}, this._hass) } : null);
    const productSummary = selectedProduct
      ? `<div class="chip-product-selected"><span>${this._categoryProductIdentity(selectedProduct)}</span><button class="icon-button" type="button" data-clear-chip-product title="${haListManagerPanelText("products.remove_link", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>`
      : "";
    const conflict = draft.conflict;
    const dueHelp = {
      none: haListManagerPanelText("help.chip_without_due_date", {}, this._hass),
      today: haListManagerPanelText("help.chip_due_today", {}, this._hass),
      tomorrow: haListManagerPanelText("help.todo_chip_due_tomorrow", {}, this._hass),
      offset: haListManagerPanelText("help.due_date_offset", {}, this._hass),
      next_weekday: haListManagerPanelText("help.chip_next_weekday", {}, this._hass),
    }[draft.due_mode] || "";
    const todoFields = `<label class="field"><span>${haListManagerPanelText("ui.task_name", {}, this._hass)}</span><input type="text" maxlength="200" data-chip-item-name value="${this._escape(draft.item_name)}" autocomplete="off" placeholder="${haListManagerPanelText("ui.task_name_example", {}, this._hass)}"></label>
      <label class="field"><span>${haListManagerPanelText("ui.description_optional", {}, this._hass)}</span><textarea data-chip-description rows="3" maxlength="2000">${this._escape(draft.description)}</textarea></label>
      <label class="field"><span>${haListManagerPanelText("ui.category", {}, this._hass)}</span><div class="chip-template-combo"><input type="text" data-chip-category-combo role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" value="${this._escape(draft.category_name)}" placeholder="${haListManagerPanelText("ui.search_category", {}, this._hass)}"><div class="chip-template-options" data-chip-category-options hidden>${availableCategories.map((category) => `<button type="button" data-chip-category-option="${this._escape(category.id)}" style="${category.color ? `--label-color:${this._escape(category.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(category.icon || "mdi:shape-outline")}"></ha-icon></span><span><strong>${this._escape(category.name)}</strong><small>${this._escape(this._labelScopeText(category))}</small></span></button>`).join("")}</div></div></label>
      <div class="label-selector chip-template-label-selector"><span>${haListManagerPanelText("ui.labels_optional", {}, this._hass)}</span>${selectedLabels.length ? `<div class="selected-labels">${selectedLabels.map((label) => `<button type="button" class="selected-label" data-chip-remove-label="${this._escape(label.id)}" style="${label.color ? `--label-color:${this._escape(label.color)}` : ""}"><ha-icon icon="${this._escape(label.icon || "mdi:label-outline")}"></ha-icon><span>${this._escape(label.name)}</span><ha-icon class="remove-label" icon="mdi:close"></ha-icon></button>`).join("")}</div>` : ""}<div class="label-combo chip-template-combo"><div class="label-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" data-chip-label-combo role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" placeholder="${haListManagerPanelText("ui.browse_labels", {}, this._hass)}"></div><div class="label-picker-options chip-template-options" data-chip-label-options hidden>${availableLabels.filter((label) => !draft.label_ids.includes(label.id)).map((label) => `<button type="button" data-chip-label-option="${this._escape(label.id)}" style="${label.color ? `--label-color:${this._escape(label.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(label.icon || "mdi:label-outline")}"></ha-icon></span><span><strong>${this._escape(label.name)}</strong><small>${this._escape(this._labelScopeText(label))}</small></span></button>`).join("")}</div></div></div>
      <div class="field-grid"><label class="field"><span>${haListManagerPanelText("ui.due_date", {}, this._hass)}</span><select data-chip-due-mode><option value="none" ${draft.due_mode === "none" ? "selected" : ""}>${haListManagerPanelText("ui.no_due_date", {}, this._hass)}</option><option value="today" ${draft.due_mode === "today" ? "selected" : ""}>${haListManagerPanelText("todo.on_click_day", {}, this._hass)}</option><option value="tomorrow" ${draft.due_mode === "tomorrow" ? "selected" : ""}>${haListManagerPanelText("ui.following_day", {}, this._hass)}</option><option value="offset" ${draft.due_mode === "offset" ? "selected" : ""}>${haListManagerPanelText("ui.after_interval", {}, this._hass)}</option><option value="next_weekday" ${draft.due_mode === "next_weekday" ? "selected" : ""}>${haListManagerPanelText("todo.next_selected_weekday", {}, this._hass)}</option></select></label><label class="field"><span>${haListManagerPanelText("ui.time_optional", {}, this._hass)}</span><input type="time" data-chip-due-time value="${this._escape(draft.due_time)}" ${draft.due_mode === "none" ? "disabled" : ""}></label></div>
      <p class="field-help todo-template-due-help">${this._escape(dueHelp)}</p>
      ${draft.due_mode === "offset" ? `<div class="field-grid"><label class="field"><span>${haListManagerPanelText("ui.interval_spacing", {}, this._hass)}</span><input type="number" min="1" max="1000000" data-chip-due-offset value="${this._escape(draft.due_offset_value)}"></label><label class="field"><span>${haListManagerPanelText("ui.unit", {}, this._hass)}</span><select data-chip-due-unit><option value="H" ${draft.due_offset_unit === "H" ? "selected" : ""}>${haListManagerPanelText("ui.hours", {}, this._hass)}</option><option value="D" ${draft.due_offset_unit === "D" ? "selected" : ""}>${haListManagerPanelText("ui.days", {}, this._hass)}</option><option value="M" ${draft.due_offset_unit === "M" ? "selected" : ""}>${haListManagerPanelText("ui.months", {}, this._hass)}</option></select></label></div>` : ""}
      ${draft.due_mode === "next_weekday" ? `<label class="field"><span>${haListManagerPanelText("ui.weekday", {}, this._hass)}</span><select data-chip-weekday>${[[haListManagerPanelText("ui.monday", {}, this._hass), 1], [haListManagerPanelText("ui.tuesday", {}, this._hass), 2], [haListManagerPanelText("ui.wednesday", {}, this._hass), 3], [haListManagerPanelText("ui.thursday", {}, this._hass), 4], [haListManagerPanelText("ui.friday", {}, this._hass), 5], [haListManagerPanelText("ui.saturday", {}, this._hass), 6], [haListManagerPanelText("ui.sunday", {}, this._hass), 0]].map(([name, value]) => `<option value="${value}" ${draft.due_weekday === value ? "selected" : ""}>${name}</option>`).join("")}</select><small>${haListManagerPanelText("help.next_weekday", {}, this._hass)}</small></label>` : ""}
      <div class="field-grid todo-template-recurrence"><label class="field"><span>${haListManagerPanelText("ui.repeat_every_optional", {}, this._hass)}</span><input type="number" min="1" max="1000000" data-chip-recurrence value="${this._escape(draft.recurrence_interval)}"></label><label class="field"><span>${haListManagerPanelText("ui.unit", {}, this._hass)}</span><select data-chip-recurrence-unit><option value="H" ${draft.recurrence_unit === "H" ? "selected" : ""}>${haListManagerPanelText("ui.hours", {}, this._hass)}</option><option value="D" ${draft.recurrence_unit === "D" ? "selected" : ""}>${haListManagerPanelText("ui.days", {}, this._hass)}</option><option value="M" ${draft.recurrence_unit === "M" ? "selected" : ""}>${haListManagerPanelText("ui.months", {}, this._hass)}</option></select></label></div>
      <p class="field-help">${haListManagerPanelText("help.task_recurrence", {}, this._hass)}</p>
      <label class="field"><span>${haListManagerPanelText("ui.on_click", {}, this._hass)}</span><select data-chip-add-mode><option value="direct" ${draft.add_mode === "direct" ? "selected" : ""}>${haListManagerPanelText("ui.add_directly", {}, this._hass)}</option><option value="edit" ${draft.add_mode === "edit" ? "selected" : ""}>${haListManagerPanelText("ui.edit_before_adding", {}, this._hass)}</option></select></label>`;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog category-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? (isTodo ? haListManagerPanelText("ui.edit_todo_template", {}, this._hass) : haListManagerPanelText("ui.edit_chip", {}, this._hass)) : (isTodo ? haListManagerPanelText("ui.create_todo_template", {}, this._hass) : haListManagerPanelText("chips.create", {}, this._hass)))}
      <label class="field"><span>${isTodo ? haListManagerPanelText("ui.chip_name", {}, this._hass) : haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-chip-name value="${this._escape(draft.name)}" autocomplete="off" placeholder="${isTodo ? haListManagerPanelText("ui.bin_name_example", {}, this._hass) : haListManagerPanelText("ui.milk_example", {}, this._hass)}"></label>
      ${isTodo ? `<ha-selector class="selector-field" data-chip-icon-selector></ha-selector>${todoFields}` : `<p class="field-help">${haListManagerPanelText("help.chip_name", {}, this._hass)}</p><label class="field"><span>${haListManagerPanelText("ui.product_link_optional", {}, this._hass)}</span><div class="chip-product-combo"><div class="chip-product-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" data-chip-product-search autocomplete="off" placeholder="${haListManagerPanelText("products.search_placeholder", {}, this._hass)}"></div><div class="chip-product-options" data-chip-product-options hidden></div></div></label>${productSummary}<p class="field-help">${haListManagerPanelText("help.chip_product_link", {}, this._hass)}</p>`}
      <ha-select class="selector-field" data-chip-scope-select></ha-select>
      ${!isTodo && draft.scope === "list_type" ? `<ha-select class="selector-field" data-chip-list-type-select></ha-select>` : ""}
      ${draft.scope === "list" ? `<label class="field"><span>${haListManagerPanelText("ui.target_list", {}, this._hass)}</span><div class="chip-template-combo"><input type="text" data-chip-list-combo role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" value="${this._escape(targetList?.name || "")}" placeholder="${haListManagerPanelText("ui.search_lists", {}, this._hass)}"><div class="chip-template-options" data-chip-list-options hidden>${this._lists.filter((list) => isTodo ? list.list_type === "todo" : list.list_type !== "todo").map((list) => `<button type="button" data-chip-list-option="${this._escape(list.id)}"><ha-icon icon="${this._escape(list.icon || "mdi:format-list-bulleted")}"></ha-icon><span><strong>${this._escape(list.name)}</strong><small>${this._escape(LIST_TYPES(this._hass)[list.list_type]?.label || list.list_type)}</small></span></button>`).join("")}</div></div></label>` : ""}
      <div class="color-field"><ha-input class="selector-field" type="color" data-chip-color-selector></ha-input><button class="ha-button" type="button" data-clear-chip-color ${draft.color ? "" : "disabled"}><ha-icon icon="mdi:palette-remove-outline"></ha-icon>${haListManagerPanelText("ui.use_default_color", {}, this._hass)}</button></div>
      <p class="field-help">${isTodo ? haListManagerPanelText("help.todo_template_separation", {}, this._hass) : haListManagerPanelText("help.item_chip_scopes", {}, this._hass)}</p>
      ${conflict ? `<div class="chip-conflict"><ha-icon icon="mdi:alert-outline"></ha-icon><div><strong>${haListManagerPanelText("ui.destination_name_exists", {p0:(this._escape(conflict.name))}, this._hass)}</strong><span>${haListManagerPanelText("help.replace_chip_scope", {}, this._hass)}</span><div><button class="ha-button destructive" type="button" data-replace-chip>${haListManagerPanelText("ui.replace_existing_chip", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-chip-replace>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></div></div>` : ""}
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-chip ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderInventoryDialog() {
    const draft = this._dialog.draft;
    if (this._dialog.pendingScan) return this._renderPendingScanDialog();
    const selectedProduct = this._dialog.record?.product || this._findInventoryProduct(draft.product_id);
    const productDefaultCategory = this._inventoryProductDefaultCategory(selectedProduct, this._selectedInventoryListId);
    const selectedInventoryCategory = this._findCategory(draft.category_id)?.name || "";
    const categoryHelp = !draft.category_id
      ? productDefaultCategory
        ? haListManagerPanelText("help.inventory_product_category_default", {p0:(this._escape(productDefaultCategory))}, this._hass)
        : selectedProduct ? haListManagerPanelText("ui.product_category_unset", {}, this._hass) : haListManagerPanelText("help.selected_product_default", {}, this._hass)
      : productDefaultCategory
        ? selectedInventoryCategory === productDefaultCategory
          ? haListManagerPanelText("inventory.effective_product_category", {p0:(this._escape(selectedInventoryCategory))}, this._hass)
          : haListManagerPanelText("inventory.category_override_notice", {p0:(this._escape(selectedInventoryCategory)), p1:(this._escape(productDefaultCategory))}, this._hass)
        : haListManagerPanelText("help.inventory_category_local", {}, this._hass);
    const categoryHelpMarkup = productDefaultCategory
      ? `<div class="inventory-category-notice"><ha-icon icon="mdi:information-outline"></ha-icon><span>${categoryHelp}</span></div>`
      : `<p class="field-help inventory-category-help">${categoryHelp}</p>`;
    const dialogTitle = this._dialog.record ? haListManagerPanelText("ui.edit_inventory_item", {}, this._hass) : haListManagerPanelText("inventory.add_product", {}, this._hass);
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(dialogTitle)}
      ${this._dialog.record ? `<div class="inventory-dialog-product inventory-dialog-product-actions"><span><strong>${this._escape(this._dialog.record.product.name)}</strong>${this._dialog.record.product.ean ? `<small>EAN ${this._escape(this._dialog.record.product.ean)}</small>` : ""}</span><button class="ha-button compact" type="button" data-edit-inventory-product><ha-icon icon="mdi:pencil-outline"></ha-icon>${haListManagerPanelText("products.edit_details", {}, this._hass)}</button></div>` : `${this._inventoryProductPickerMarkup()}<p class="field-help inventory-product-help">${haListManagerPanelText("help.link_inventory_product", {}, this._hass)}</p><button class="ha-button inventory-create-product" type="button" data-new-inventory-product><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("products.record_new", {}, this._hass)}</button>`}
      <div class="field-grid product-grid"><label class="field"><span>${haListManagerPanelText("ui.stock", {}, this._hass)}</span><input type="number" min="0" max="1000000" step="1" data-inventory-stock value="${this._escape(draft.stock)}"></label><label class="field"><span>${haListManagerPanelText("ui.minimum_stock_optional", {}, this._hass)}</span><input type="number" min="0" max="1000000" step="1" data-inventory-minimum value="${this._escape(draft.minimum_stock)}" placeholder="${haListManagerPanelText("ui.empty_disables", {}, this._hass)}"></label></div>
      <p class="field-help inventory-minimum-help">${haListManagerPanelText("help.minimum_stock", {}, this._hass)}</p>
      ${this._inventoryRestockRuleMarkup(draft)}
      ${this._inventoryEntryCategoryPickerMarkup()}
      ${categoryHelpMarkup}
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-inventory ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderPendingScanDialog() {
    const { draft, pendingScan, record } = this._dialog;
    const product = this._findInventoryProduct(pendingScan.product_id) || record?.product || null;
    const locked = Boolean(product);
    const image = draft.image_url ? `<img class="contained-product-image" src="${this._escape(this._openFoodFactsImageUrl(draft.image_url, "400"))}" alt="${haListManagerPanelText("ui.product_image", {}, this._hass)}">` : `<ha-icon icon="mdi:image-outline"></ha-icon>`;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog product-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(haListManagerPanelText("ui.edit_pending_scan", {}, this._hass))}
      <div class="pending-scan-notice"><ha-icon icon="mdi:barcode-scan"></ha-icon><div><strong>${haListManagerPanelText("ui.name_quantity", {p0:(this._escape(SCANNER_ACTIONS(this._hass)[pendingScan.action]?.label || pendingScan.action)), p1:(this._escape(pendingScan.quantity || 1))}, this._hass)}</strong><span>${haListManagerPanelText("ui.scan_stock_pending_save", {}, this._hass)}</span></div></div>
      <div class="product-dialog-top"><div>
        <label class="field"><span>${haListManagerPanelText("products.custom_name", {}, this._hass)}</span><input type="text" maxlength="200" data-scan-product-name value="${this._escape(draft.name)}" ${locked ? "readonly" : ""}></label>
        <label class="field"><span>EAN</span><input type="text" value="${this._escape(draft.ean)}" readonly></label>
      </div><div class="product-preview">${image}</div></div>
      <label class="field"><span>${haListManagerPanelText("products.original_name", {}, this._hass)}</span><input type="text" maxlength="300" data-scan-product-original-name value="${this._escape(draft.original_name)}" ${locked ? "readonly" : ""}></label>
      <div class="field-grid product-grid"><label class="field"><span>${haListManagerPanelText("ui.brand_optional", {}, this._hass)}</span><input type="text" maxlength="200" data-scan-product-brand value="${this._escape(draft.brand)}" ${locked ? "readonly" : ""}></label><label class="field"><span>${haListManagerPanelText("ui.package_quantity_optional", {}, this._hass)}</span><input type="text" maxlength="100" data-scan-product-quantity value="${this._escape(draft.package_quantity)}" ${locked ? "readonly" : ""}></label></div>
      <div class="field-grid product-grid"><label class="field"><span>${record ? haListManagerPanelText("ui.stock_after_scan", {}, this._hass) : haListManagerPanelText("ui.initial_stock", {}, this._hass)}</span><input type="number" min="0" max="1000000" step="1" data-inventory-stock value="${this._escape(draft.stock)}"></label><label class="field"><span>${haListManagerPanelText("ui.minimum_stock_optional", {}, this._hass)}</span><input type="number" min="0" max="1000000" step="1" data-inventory-minimum value="${this._escape(draft.minimum_stock)}" placeholder="${haListManagerPanelText("ui.empty_disables", {}, this._hass)}"></label></div>
      ${this._inventoryRestockRuleMarkup(draft)}
      <label class="field"><span>${haListManagerPanelText("ui.category", {}, this._hass)}</span>${this._pendingScanCategoryPickerMarkup()}</label>
      <p class="field-help">${haListManagerPanelText("help.inventory_category_link", {}, this._hass)}</p>
      ${this._renderLabelSelector(draft.label_ids || [])}
      <label class="field"><span>${haListManagerPanelText("ui.optional_image_url", {}, this._hass)}</span><input type="url" maxlength="1000" data-scan-product-image value="${this._escape(draft.image_url)}" ${locked ? "readonly" : ""}></label>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-inventory ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderInventoryGroupDialog() {
    const draft = this._dialog.draft;
    const selected = new Set(draft.member_ids || []);
    const currentGroupId = this._dialog.record?.id || "";
    const groupByEntry = new Map();
    this._inventoryGroups.forEach((group) => (group.member_ids || []).forEach((entryId) => groupByEntry.set(entryId, group)));
    const query = this._inventoryGroupSearch.trim().toLocaleLowerCase();
    const matches = this._inventoryEntries
      .filter((entry) => selected.has(entry.id) || this._inventoryGroupShowGrouped || !groupByEntry.has(entry.id) || groupByEntry.get(entry.id)?.id === currentGroupId)
      .filter((entry) => !query || [entry.product.name, entry.product.original_name, entry.product.brand, entry.product.ean].some((value) => String(value || "").toLocaleLowerCase().includes(query)))
      .sort((a, b) => a.product.name.localeCompare(b.product.name));
    const choices = matches.slice(0, GROUP_PICKER_RESULT_LIMIT).map((entry) => {
      const source = groupByEntry.get(entry.id);
      const otherGroup = source && source.id !== currentGroupId ? source : null;
      return `<label class="group-member-choice${otherGroup ? " belongs-to-group" : ""}"><ha-checkbox data-admin-group-member="${entry.id}"></ha-checkbox><span><strong>${this._escape(entry.product.name)}</strong><small>${haListManagerPanelText("inventory.stock_value", {p0:(entry.stock)}, this._hass)}</small>${otherGroup ? `<small class="move-note"><ha-icon icon="mdi:alert-outline"></ha-icon>${haListManagerPanelText("ui.current_location", {p0:(this._escape(otherGroup.name))}, this._hass)}</small>` : ""}</span></label>`;
    }).join("") || `<p class="field-help group-picker-empty">${haListManagerPanelText("ui.no_items_found", {}, this._hass)}</p>`;
    const resultNote = matches.length > GROUP_PICKER_RESULT_LIMIT ? `<p class="group-result-note">${haListManagerPanelText("ui.items_shown_search_more", {p0:(GROUP_PICKER_RESULT_LIMIT), p1:(matches.length)}, this._hass)}</p>` : "";
    const moveConfirmation = this._dialog.move_confirmation ? `<div class="dialog-backdrop nested-confirmation"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" data-dialog-panel><div class="confirmation-icon"><ha-icon icon="mdi:alert-outline"></ha-icon></div><h3>${this._dialog.move_confirmation.dissolves ? haListManagerPanelText("ui.move_dissolve_group_confirm", {}, this._hass) : haListManagerPanelText("ui.move_item_group_confirm", {}, this._hass)}</h3><p>${this._escape(this._dialog.move_confirmation.message)}</p><div class="dialog-actions"><button class="ha-button primary" data-confirm-group-moves>${this._dialog.move_confirmation.action === "select" ? haListManagerPanelText("ui.move_item", {}, this._hass) : haListManagerPanelText("ui.move_and_save", {}, this._hass)}</button><button class="ha-button" data-cancel-group-moves>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>` : "";
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog inventory-group-dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(this._dialog.record ? haListManagerPanelText("ui.edit_group", {}, this._hass) : haListManagerPanelText("ui.create_group", {}, this._hass))}<label class="field"><span>${haListManagerPanelText("ui.group_name", {}, this._hass)}</span><input type="text" maxlength="200" data-inventory-group-name value="${this._escape(draft.name)}" autocomplete="off"></label><div class="inventory-group-fields"><label class="field"><span>${haListManagerPanelText("ui.minimum_stock_optional", {}, this._hass)}</span><input type="number" min="0" max="1000000" step="1" data-inventory-group-minimum value="${this._escape(draft.minimum_stock)}"></label>${this._inventoryGroupCategoryPickerMarkup()}</div>${this._inventoryRestockRuleMarkup(draft, haListManagerPanelText("inventory.group", {}, this._hass))}<fieldset class="group-member-list"><legend>${haListManagerPanelText("ui.member_count", {p0:(selected.size)}, this._hass)}</legend><div class="group-move-warning"><ha-icon icon="mdi:alert-outline"></ha-icon><span>${haListManagerPanelText("help.single_group_membership", {}, this._hass)}</span><label class="show-grouped-toggle"><input type="checkbox" data-admin-show-grouped ${this._inventoryGroupShowGrouped ? "checked" : ""}>${haListManagerPanelText("ui.show_grouped_items", {}, this._hass)}</label></div><label class="group-member-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" value="${this._escape(this._inventoryGroupSearch)}" placeholder="${haListManagerPanelText("ui.search_item_brand_ean", {}, this._hass)}" autocomplete="off" data-inventory-group-search></label><div class="group-member-scroll">${choices}${resultNote}</div></fieldset>${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" data-save-inventory-group ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section>${moveConfirmation}</div>`;
  }

  _renderScannerDialog() {
    const draft = this._dialog.draft;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog scanner-dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(this._dialog.record ? haListManagerPanelText("scanner.edit", {}, this._hass) : haListManagerPanelText("ui.create_scanner", {}, this._hass))}<label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-scanner-name value="${this._escape(draft.name)}" placeholder="${haListManagerPanelText("scanner.name_example", {}, this._hass)}"></label><label class="field"><span>${haListManagerPanelText("ui.address", {}, this._hass)}</span><input type="text" maxlength="100" data-scanner-address value="${this._escape(draft.address)}" placeholder="AA:FC:87:59:04:38"></label><label class="setting-row compact-setting"><ha-checkbox data-scanner-enabled></ha-checkbox><span><strong>${haListManagerPanelText("ui.scanner_enabled", {}, this._hass)}</strong><small>${haListManagerPanelText("help.disabled_scanner_events", {}, this._hass)}</small></span></label><ha-select class="selector-field" data-scanner-routing></ha-select>${draft.routing === "fixed" ? `<div class="field-grid scanner-route-fields"><ha-select data-scanner-list></ha-select><ha-select data-scanner-action></ha-select></div>` : `<p class="field-help">${haListManagerPanelText("help.active_inventory_target", {}, this._hass)}</p>`}${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" data-save-scanner ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  _renderListDialog() {
    const draft = this._dialog.draft;
    const impact = this._dialog.scope_confirmation;
    const confirmation = impact ? `<div class="dialog-backdrop nested-confirmation"><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" data-dialog-panel><div class="confirmation-icon"><ha-icon icon="mdi:alert-outline"></ha-icon></div><h3>${haListManagerPanelText("ui.hide_sections_confirm", {}, this._hass)}</h3><p>${haListManagerPanelText("settings.scope_change_impact", {p0:(impact.category_reassigned), p1:(impact.category_cleared), p2:(impact.label_reassigned), p3:(impact.label_removed)}, this._hass)}</p><div class="dialog-actions"><button class="ha-button primary" data-confirm-list-scopes>${haListManagerPanelText("ui.apply_change", {}, this._hass)}</button><button class="ha-button" data-cancel-list-scopes>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>` : "";
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? haListManagerPanelText("ui.edit_list", {}, this._hass) : haListManagerPanelText("ui.create_list", {}, this._hass))}
      <label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-list-name autocomplete="off" value="${this._escape(draft.name)}" placeholder="${haListManagerPanelText("shopping.list_name_example", {}, this._hass)}"></label>
      ${this._dialog.record ? `<div class="immutable-field"><span>${haListManagerPanelText("ui.list_type", {}, this._hass)}</span><strong><ha-icon icon="${this._escape(LIST_TYPES(this._hass)[draft.list_type]?.icon || "mdi:format-list-bulleted")}"></ha-icon>${this._escape(LIST_TYPES(this._hass)[draft.list_type]?.label || draft.list_type)}</strong><small>${haListManagerPanelText("help.list_type_immutable", {}, this._hass)}</small></div>` : `<ha-select class="selector-field" data-list-type-select></ha-select>`}
      ${draft.list_type === "bring" ? `<ha-selector class="selector-field" data-list-external-entity-selector></ha-selector><p class="field-help">${haListManagerPanelText("help.bring_list_link", {}, this._hass)}</p>` : ""}
      <ha-selector class="selector-field" data-list-icon-selector></ha-selector>
      <p class="field-help">${haListManagerPanelText("help.default_list_icon", {}, this._hass)}</p>
      <fieldset class="option-group"><legend>${haListManagerPanelText("categories.available", {}, this._hass)}</legend>
        <label class="setting-row compact-setting"><ha-checkbox data-list-use-global-categories></ha-checkbox><span><strong>${haListManagerPanelText("ui.global_categories", {}, this._hass)}</strong><small>${haListManagerPanelText("help.offer_global_categories", {}, this._hass)}</small></span></label>
        <label class="setting-row compact-setting"><ha-checkbox data-list-use-type-categories></ha-checkbox><span><strong>${haListManagerPanelText("ui.categories_this_list_type", {}, this._hass)}</strong><small>${haListManagerPanelText("help.include_list_type_definitions", {}, this._hass)}</small></span></label>
        <p class="field-help">${haListManagerPanelText("help.category_scope_priority", {}, this._hass)}</p>
      </fieldset>
      <fieldset class="option-group"><legend>${haListManagerPanelText("ui.available_labels", {}, this._hass)}</legend>
        <label class="setting-row compact-setting"><ha-checkbox data-list-use-global-labels></ha-checkbox><span><strong>${haListManagerPanelText("ui.global_labels", {}, this._hass)}</strong><small>${haListManagerPanelText("help.show_global_labels", {}, this._hass)}</small></span></label>
        <label class="setting-row compact-setting"><ha-checkbox data-list-use-type-labels></ha-checkbox><span><strong>${haListManagerPanelText("labels.for_list_type", {}, this._hass)}</strong><small>${haListManagerPanelText("ui.offer_named_in_list", {p0:(draft.list_type === "todo" ? haListManagerPanelText("ui.todo_labels", {}, this._hass) : draft.list_type === "inventory" ? haListManagerPanelText("ui.inventory_labels", {}, this._hass) : haListManagerPanelText("ui.shopping_list_labels", {}, this._hass))}, this._hass)}</small></span></label>
        <p class="field-help">${haListManagerPanelText("help.list_labels_precedence", {}, this._hass)}</p>
      </fieldset>
      <fieldset class="option-group"><legend>${draft.list_type === "todo" ? haListManagerPanelText("ui.available_todo_templates", {}, this._hass) : haListManagerPanelText("ui.available_item_chips", {}, this._hass)}</legend>
        ${draft.list_type === "todo" ? "" : `<label class="setting-row compact-setting"><ha-checkbox data-list-use-global-chips></ha-checkbox><span><strong>${haListManagerPanelText("chips.general_items", {}, this._hass)}</strong><small>${haListManagerPanelText("help.offer_shared_quick_actions", {}, this._hass)}</small></span></label>`}
        <label class="setting-row compact-setting"><ha-checkbox data-list-use-type-chips></ha-checkbox><span><strong>${draft.list_type === "todo" ? haListManagerPanelText("ui.templates_all_todo_lists", {}, this._hass) : haListManagerPanelText("chips.for_list_type", {}, this._hass)}</strong><small>${draft.list_type === "todo" ? haListManagerPanelText("help.include_shared_todo_templates", {}, this._hass) : haListManagerPanelText("help.list_type_quick_actions", {}, this._hass)}</small></span></label>
        <p class="field-help">${draft.list_type === "todo" ? haListManagerPanelText("help.todo_local_templates", {}, this._hass) : haListManagerPanelText("help.own_item_chips", {}, this._hass)}</p>
      </fieldset>
      ${draft.list_type === "shopping" && this._dialog.record?.provider !== "bring" ? `<fieldset class="option-group"><legend>${haListManagerPanelText("recipes.dishes", {}, this._hass)}</legend><label class="setting-row compact-setting"><ha-checkbox data-list-use-dishes></ha-checkbox><span><strong>${haListManagerPanelText("ui.use_dishes_in_list", {}, this._hass)}</strong><small>${haListManagerPanelText("recipes.central_dishes_help", {}, this._hass)}</small></span></label></fieldset>` : ""}
      ${draft.list_type === "shopping" && this._dialog.record?.provider !== "bring" ? `<fieldset class="option-group"><legend>${haListManagerPanelText("ui.tandoor_recipe_source", {}, this._hass)}</legend><label class="setting-row compact-setting"><ha-checkbox data-list-use-tandoor></ha-checkbox><span><strong>${haListManagerPanelText("ui.use_tandoor_in_list", {}, this._hass)}</strong><small>${haListManagerPanelText("help.recipe_search_settings", {}, this._hass)}</small></span></label><label class="setting-row compact-setting"><ha-checkbox data-list-tandoor-include-ingredients></ha-checkbox><span><strong>${haListManagerPanelText("ui.search_ingredients_default", {}, this._hass)}</strong><small>${haListManagerPanelText("help.recipe_ingredient_search_default", {}, this._hass)}</small></span></label><label class="field"><span>${haListManagerPanelText("ui.max_recipes_shown", {}, this._hass)}</span><select data-list-tandoor-result-limit>${[10, 25, 50, 100].map((value) => `<option value="${value}" ${Number(draft.tandoor_result_limit || 100) === value ? "selected" : ""}>${value}</option>`).join("")}</select><small>${haListManagerPanelText("help.recipe_search_limit", {}, this._hass)}</small></label><label class="setting-row compact-setting"><ha-checkbox data-list-tandoor-skip-small-units></ha-checkbox><span><strong>${haListManagerPanelText("ui.exclude_small_recipe_amounts", {}, this._hass)}</strong><small>${haListManagerPanelText("help.recipe_checkbox_default", {}, this._hass)}</small></span></label><label class="field"><span>${haListManagerPanelText("ui.additional_unselected_units", {}, this._hass)}</span><input type="text" data-list-tandoor-excluded-units value="${this._escape(draft.tandoor_excluded_units || "")}" placeholder="${haListManagerPanelText("recipes.unit_examples", {}, this._hass)}"><small>${haListManagerPanelText("help.additional_recipe_units", {}, this._hass)}</small></label></fieldset>` : ""}
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-list ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section>${confirmation}</div>`;
  }

  _renderListScopeToggleDialog() {
    const { key, enabled, impact, list } = this._dialog;
    if (key === "use_dishes") return `<div class="dialog-backdrop" data-close-dialog><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" data-dialog-panel><div class="confirmation-icon"><ha-icon icon="mdi:${enabled ? "check-circle-outline" : "alert-outline"}"></ha-icon></div><h3>${haListManagerPanelText("recipes.confirm_dishes_action", {p0:(enabled ? haListManagerPanelText("ui.activate_verb", {}, this._hass) : haListManagerPanelText("ui.deactivate_verb", {}, this._hass))}, this._hass)}</h3><p>${enabled ? haListManagerPanelText("ui.shared_dishes_enabled", {p0:(this._escape(list.name))}, this._hass) : haListManagerPanelText("ui.hide_dishes_warning", {p0:(this._escape(list.name))}, this._hass)}</p>${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" type="button" data-confirm-list-scope-toggle ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : enabled ? haListManagerPanelText("ui.enable", {}, this._hass) : haListManagerPanelText("ui.disable", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
    if (key === "use_tandoor") return `<div class="dialog-backdrop" data-close-dialog><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" data-dialog-panel><div class="confirmation-icon"><ha-icon icon="mdi:${enabled ? "check-circle-outline" : "alert-outline"}"></ha-icon></div><h3>${haListManagerPanelText("recipes.confirm_tandoor_action", {p0:(enabled ? haListManagerPanelText("ui.activate_verb", {}, this._hass) : haListManagerPanelText("ui.deactivate_verb", {}, this._hass))}, this._hass)}</h3><p>${enabled ? haListManagerPanelText("recipes.search_enabled_for", {p0:(this._escape(list.name))}, this._hass) : haListManagerPanelText("ui.hide_tandoor_search_warning", {p0:(this._escape(list.name))}, this._hass)}</p>${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" type="button" data-confirm-list-scope-toggle ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : enabled ? haListManagerPanelText("ui.enable", {}, this._hass) : haListManagerPanelText("ui.disable", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
    const typeLabel = list.list_type === "bring" ? haListManagerPanelText("ui.shopping_list", {}, this._hass) : (LIST_TYPES(this._hass)[list.list_type]?.label || haListManagerPanelText("ui.list_type", {}, this._hass));
    const definitions = key.includes("categories") ? haListManagerPanelText("ui.categories", {}, this._hass) : key.includes("labels") ? haListManagerPanelText("ui.labels", {}, this._hass) : haListManagerPanelText("ui.chips", {}, this._hass);
    const scopedDefinitions = key.includes("global") ? haListManagerPanelText("ui.global_content_named", {p0:(definitions)}, this._hass) : haListManagerPanelText("ui.scoped_content_named", {p0:(definitions), p1:(typeLabel)}, this._hass);
    const definitionKind = key.includes("categories") ? "categories" : key.includes("labels") ? "labels" : "chips";
    const title = enabled
      ? { categories: haListManagerPanelText("scope.enable_categories", {}, this._hass), labels: haListManagerPanelText("scope.enable_labels", {}, this._hass), chips: haListManagerPanelText("scope.enable_chips", {}, this._hass) }[definitionKind]
      : { categories: haListManagerPanelText("scope.disable_categories", {}, this._hass), labels: haListManagerPanelText("scope.disable_labels", {}, this._hass), chips: haListManagerPanelText("scope.disable_chips", {}, this._hass) }[definitionKind];
    const details = [];
    if (!enabled && definitionKind === "categories") {
      if (impact.category_reassigned) details.push((impact.category_reassigned === 1 ? haListManagerPanelText("categories.reassigned_one", {count: impact.category_reassigned}, this._hass) : haListManagerPanelText("categories.reassigned_many", {count: impact.category_reassigned}, this._hass)));
      if (impact.category_cleared) details.push((impact.category_cleared === 1 ? haListManagerPanelText("categories.cleared_one", {count: impact.category_cleared}, this._hass) : haListManagerPanelText("categories.cleared_many", {count: impact.category_cleared}, this._hass)));
    }
    if (!enabled && definitionKind === "labels") {
      if (impact.label_reassigned) details.push((impact.label_reassigned === 1 ? haListManagerPanelText("labels.reassigned_one", {count: impact.label_reassigned}, this._hass) : haListManagerPanelText("labels.reassigned_many", {count: impact.label_reassigned}, this._hass)));
      if (impact.label_removed) details.push((impact.label_removed === 1 ? haListManagerPanelText("labels.removed_one", {count: impact.label_removed}, this._hass) : haListManagerPanelText("labels.removed_many", {count: impact.label_removed}, this._hass)));
    }
    let explanation;
    if (enabled) explanation = haListManagerPanelText("ui.available_in_target_scope", {p0:(scopedDefinitions), p1:(list.name)}, this._hass);
    else if (definitionKind === "chips") explanation = haListManagerPanelText("ui.hide_chip_content_warning", {p0:(scopedDefinitions), p1:(list.name)}, this._hass);
    else if (details.length) explanation = haListManagerPanelText("ui.definitions_retained_suffix", {p0:(details.join(". "))}, this._hass);
    else explanation = haListManagerPanelText("settings.hide_scope_no_entries", {p0:(scopedDefinitions), p1:(list.name)}, this._hass);
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog confirmation-dialog" role="alertdialog" aria-modal="true" data-dialog-panel>
      <div class="confirmation-icon"><ha-icon icon="mdi:${enabled ? "check-circle-outline" : "alert-outline"}"></ha-icon></div>
      <h3>${this._escape(title)}</h3>
      <p>${this._escape(explanation)}</p>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" type="button" data-confirm-list-scope-toggle ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : enabled ? haListManagerPanelText("ui.enable", {}, this._hass) : haListManagerPanelText("ui.disable", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderDishDialog() {
    const draft = this._dialog.draft;
    const rows = draft.items.map((item, index) => {
      const productDetails = [item.product_brand, item.product_package_quantity, item.product_ean ? `EAN ${item.product_ean}` : haListManagerPanelText("ui.without_ean", {}, this._hass)].filter(Boolean).join(" · ");
      const ingredient = item.product_id
        ? `<span class="dish-ingredient-product-info"><strong>${this._escape(item.product_name || item.name)}</strong><small>${this._escape(productDetails)}</small></span>`
        : `<input class="dish-ingredient-name" type="text" maxlength="200" data-dish-item-name="${index}" value="${this._escape(item.name)}" placeholder="${haListManagerPanelText("products.name_example", {}, this._hass)}" aria-label="${haListManagerPanelText("recipes.ingredient_number", {p0:(index + 1)}, this._hass)}">`;
      return `<div class="dish-ingredient-row">
      ${ingredient}
      <input class="dish-ingredient-quantity" type="number" min="1" max="1000000" step="1" data-dish-item-quantity="${index}" value="${this._escape(item.quantity)}" aria-label="${haListManagerPanelText("recipes.ingredient_quantity", {p0:(index + 1)}, this._hass)}">
      <button class="icon-button danger" type="button" data-remove-dish-item="${index}" title="${haListManagerPanelText("ui.remove_ingredient", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
    </div>`;
    }).join("");
    const ingredientList = rows
      ? `<div class="dish-ingredient-header" aria-hidden="true"><span>${haListManagerPanelText("ui.ingredient", {}, this._hass)}</span><span>${haListManagerPanelText("ui.count", {}, this._hass)}</span><span></span></div>${rows}`
      : `<p class="dish-ingredient-empty">${haListManagerPanelText("recipes.no_ingredients_help", {}, this._hass)}</p>`;
    const productPicker = this._dialog.product_picker_open ? this._renderDishProductPicker() : "";
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog dish-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? haListManagerPanelText("ui.edit_dish", {}, this._hass) : haListManagerPanelText("recipes.create_dish", {}, this._hass))}
      <label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="100" data-dish-name value="${this._escape(draft.name)}" autocomplete="off" placeholder="${haListManagerPanelText("ui.pasta_example", {}, this._hass)}"></label>
      <label class="field"><span>${haListManagerPanelText("ui.optional_color", {}, this._hass)}</span><div class="color-input"><input type="color" data-dish-color value="${this._escape(draft.color || "#795548")}"><button class="ha-button" type="button" data-clear-dish-color>${haListManagerPanelText("ui.use_default_color", {}, this._hass)}</button></div></label>
      <section class="dish-ingredients"><div class="section-heading"><div><h3>${haListManagerPanelText("ui.ingredients", {}, this._hass)}</h3><p>${haListManagerPanelText("help.linked_product_defaults", {}, this._hass)}</p></div></div>${ingredientList}<div class="dish-ingredient-actions"><button class="ha-button compact" type="button" data-add-dish-product><ha-icon icon="mdi:package-variant-plus"></ha-icon>${haListManagerPanelText("ui.add_product", {}, this._hass)}</button><button class="ha-button compact" type="button" data-add-free-dish-item><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("shopping.add_custom_item", {}, this._hass)}</button></div></section>
      <details class="dish-quick-import" ${draft.quick_items ? "open" : ""}><summary>${haListManagerPanelText("recipes.enter_multiple_ingredients", {}, this._hass)}</summary><p class="field-help">${haListManagerPanelText("help.ingredient_lines", {}, this._hass)}</p><textarea rows="5" data-dish-quick-items placeholder="${haListManagerPanelText("recipes.ingredient_example", {}, this._hass)}">${this._escape(draft.quick_items || "")}</textarea><button class="ha-button compact" type="button" data-import-dish-items>${haListManagerPanelText("ui.apply_lines", {}, this._hass)}</button></details>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-dish ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section>${productPicker}</div>`;
  }

  _renderDishProductPickerResults() {
    const dialog = this._dialog;
    if (dialog?.kind !== "dish-editor" || !dialog.product_picker_open) return "";
    if (dialog.product_search_loading) return `<div class="category-product-state"><ha-circular-progress active></ha-circular-progress>${haListManagerPanelText("products.searching", {}, this._hass)}</div>`;
    const products = dialog.product_search_results || [];
    if (!products.length) return `<div class="category-product-state">${haListManagerPanelText("ui.no_matching_products", {}, this._hass)}</div>`;
    const linkedIds = new Set(dialog.draft.items.map((item) => item.product_id).filter(Boolean));
    const rows = products.map((product) => {
      const linked = linkedIds.has(product.id);
      const status = linked
        ? `<span class="category-product-status current"><ha-icon icon="mdi:check-circle-outline"></ha-icon>${haListManagerPanelText("recipes.already_in_dish", {}, this._hass)}</span>`
        : `<span class="category-product-status"><ha-icon icon="mdi:plus-circle-outline"></ha-icon>${haListManagerPanelText("ui.add", {}, this._hass)}</span>`;
      return `<button class="category-product-result" type="button" data-select-dish-product="${this._escape(product.id)}" ${linked ? "disabled" : ""}>${this._categoryProductIdentity(product)}${status}</button>`;
    }).join("");
    const note = dialog.product_search_total > products.length
      ? `<p class="category-product-result-note">${haListManagerPanelText("ui.search_result_count", {p0:(products.length), p1:(dialog.product_search_total)}, this._hass)}</p>`
      : "";
    return `${rows}${note}`;
  }

  _renderDishProductPicker() {
    return `<div class="dialog-backdrop nested-dish-product-picker" data-dish-product-picker-backdrop><section class="dialog category-products-dialog" role="dialog" aria-modal="true" data-dish-product-picker-panel>
      <div class="dialog-header"><h2>${haListManagerPanelText("ui.add_product", {}, this._hass)}</h2><button class="icon-button dialog-close" type="button" data-close-dish-product-picker title="${haListManagerPanelText("ui.close", {}, this._hass)}" aria-label="${haListManagerPanelText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>
      <p>${haListManagerPanelText("products.select_database_product_help", {}, this._hass)}</p>
      <label class="category-product-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" value="${this._escape(this._dialog.product_search || "")}" placeholder="${haListManagerPanelText("ui.search_product_brand_ean", {}, this._hass)}" autocomplete="off" data-dish-product-search></label>
      <div class="category-product-results" data-dish-product-results>${this._renderDishProductPickerResults()}</div>
      <div class="dialog-actions"><button class="ha-button" type="button" data-close-dish-product-picker>${haListManagerPanelText("ui.close", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderItemDialog() {
    const list = this._findList(this._selectedListId);
    const draft = this._dialog.draft;
    const hasStockFields = list.list_type !== "todo";
    const hasDue = list.list_type === "todo";
    const isBring = list.list_type === "bring";
    const hasDescription = !isBring;
    const canSaveDynamicCategory = this._canSaveDynamicCategory(draft.dynamic_category, this._selectedListId);
    const categoryFields = `${this._itemCategoryPickerMarkup(this._selectedListId, draft.category_id)}<div class="dynamic-category-field"><label class="field"><span>${haListManagerPanelText("ui.dynamic_category_optional", {}, this._hass)}</span><input type="text" maxlength="100" data-item-dynamic-category value="${this._escape(draft.dynamic_category)}" placeholder="${haListManagerPanelText("ui.dynamic_category_fallback", {}, this._hass)}"></label><button class="ha-button" type="button" data-save-dynamic-category ${canSaveDynamicCategory ? "" : "disabled"}><ha-icon icon="mdi:content-save-plus-outline"></ha-icon>${haListManagerPanelText("ui.save_permanently", {}, this._hass)}</button></div>`;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? haListManagerPanelText("ui.edit_entry", {}, this._hass) : haListManagerPanelText("ui.create_entry", {}, this._hass))}
      <label class="field"><span>${haListManagerPanelText("ui.name", {}, this._hass)}</span><input type="text" maxlength="200" data-item-name value="${this._escape(draft.name)}" autocomplete="off"></label>
      ${["shopping", "bring"].includes(list.list_type) ? `<label class="setting-row"><input type="checkbox" data-item-offer-only ${draft.offer_only ? "checked" : ""}><span>${haListManagerPanelText("ui.buy_on_offer_only", {}, this._hass)}</span></label>` : ""}
      ${hasDescription ? `<label class="field"><span>${haListManagerPanelText("ui.description_optional", {}, this._hass)}</span><textarea maxlength="2000" data-item-description rows="3">${this._escape(draft.description)}</textarea></label>` : ""}
      ${hasStockFields ? `${isBring ? `<div class="field-grid bring-detail-fields"><label class="field quantity-field"><span>${haListManagerPanelText("ui.count", {}, this._hass)}</span><input type="number" min="1" max="1000000" step="1" data-item-quantity value="${draft.quantity}"></label><label class="field"><span>${haListManagerPanelText("ui.quantity_description_optional", {}, this._hass)}</span><input type="text" maxlength="2000" data-item-description value="${this._escape(draft.description)}" placeholder="${haListManagerPanelText("ui.package_description_example", {}, this._hass)}"></label></div><p class="field-help bring-format-help">${haListManagerPanelText("help.bring_quantity_parsing", {}, this._hass)}</p><div class="bring-live-preview"><span>${haListManagerPanelText("bring.preview", {}, this._hass)}</span><strong data-bring-preview-name>${this._escape(draft.name.trim() || haListManagerPanelText("ui.item_name", {}, this._hass))}</strong><small data-bring-preview-value ${this._bringPreviewValue(draft.quantity, draft.description) ? "" : "hidden"}>${this._escape(this._bringPreviewValue(draft.quantity, draft.description))}</small></div>` : `<label class="field quantity-field"><span>${haListManagerPanelText("ui.count", {}, this._hass)}</span><input type="number" min="0" max="1000000" step="1" data-item-quantity value="${draft.quantity}"></label>`}` : ""}
      ${categoryFields}
      ${hasDue ? `<div class="field-grid todo-due-fields"><label class="field"><span>${haListManagerPanelText("ui.due_on_optional", {}, this._hass)}</span><input type="date" data-item-due-date value="${this._escape(draft.due_date)}"></label><label class="field"><span>${haListManagerPanelText("ui.time_optional", {}, this._hass)}</span><input type="time" data-item-due-time value="${this._escape(draft.due_time)}" ${draft.due_date ? "" : "disabled"}></label></div><div class="field-grid todo-recurrence-fields"><label class="field"><span>${haListManagerPanelText("ui.repeat_every_optional", {}, this._hass)}</span><input type="number" min="1" max="1000000" step="1" data-item-recurrence-interval value="${this._escape(draft.recurrence_interval)}" placeholder="${haListManagerPanelText("todo.no_interval", {}, this._hass)}"></label><label class="field"><span>${haListManagerPanelText("ui.unit", {}, this._hass)}</span><select data-item-recurrence-unit><option value="H" ${draft.recurrence_unit === "H" ? "selected" : ""}>${haListManagerPanelText("ui.hours", {}, this._hass)}</option><option value="D" ${draft.recurrence_unit === "D" ? "selected" : ""}>${haListManagerPanelText("ui.days", {}, this._hass)}</option><option value="M" ${draft.recurrence_unit === "M" ? "selected" : ""}>${haListManagerPanelText("ui.months", {}, this._hass)}</option></select></label></div>` : ""}
      ${this._renderLabelSelector(draft.label_ids)}
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-item ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _renderProductDialog() {
    const draft = this._dialog.draft;
    const action = this._dialog.record ? haListManagerPanelText("ui.refresh", {}, this._hass) : haListManagerPanelText("ui.fetch", {}, this._hass);
    const image = draft.image_url
      ? `<img class="contained-product-image" src="${this._escape(this._openFoodFactsImageUrl(draft.image_url, "400"))}" alt="${haListManagerPanelText("ui.product_image", {}, this._hass)}">`
      : `<ha-icon icon="mdi:image-outline"></ha-icon>`;
    return `<div class="dialog-backdrop" data-close-dialog><section class="dialog product-dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(this._dialog.record ? haListManagerPanelText("products.edit", {}, this._hass) : haListManagerPanelText("products.create", {}, this._hass))}
      <div class="product-dialog-top"><div>
        <label class="field"><span>${haListManagerPanelText("products.custom_name", {}, this._hass)}</span><input type="text" maxlength="200" data-product-name value="${this._escape(draft.name)}" autocomplete="off"></label>
        <div class="name-options"><button class="ha-button compact${draft.append_brand ? " active" : ""}" type="button" data-toggle-product-brand><ha-icon icon="mdi:tag-outline"></ha-icon>${haListManagerPanelText("ui.brand", {}, this._hass)}</button><button class="ha-button compact${draft.append_quantity ? " active" : ""}" type="button" data-toggle-product-quantity><ha-icon icon="mdi:scale-balance"></ha-icon>${haListManagerPanelText("ui.amount", {}, this._hass)}</button></div>
        <div class="ean-lookup-block"><div class="ean-lookup-row"><label class="field"><span>${haListManagerPanelText("ui.ean_optional", {}, this._hass)}</span><input class="${draft.ean_error ? "invalid" : ""}" type="text" inputmode="numeric" maxlength="32" data-product-ean value="${this._escape(draft.ean)}" autocomplete="off">${draft.ean_error ? `<small class="field-error">${this._escape(draft.ean_error)}</small>` : ""}</label><div class="lookup-action"><button class="ha-button" type="button" data-lookup-product ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:cloud-download-outline"></ha-icon>${this._busy ? haListManagerPanelText("ui.please_wait", {}, this._hass) : action}</button></div></div>${draft.lookup_status ? `<small class="lookup-status ${draft.lookup_status.type}">${this._escape(draft.lookup_status.text)}</small>` : ""}</div>
      </div><div class="product-preview">${image}</div></div>
      <label class="field"><span>${haListManagerPanelText("products.original_name", {}, this._hass)}</span><input type="text" data-product-original-name value="${this._escape(draft.original_name)}" readonly placeholder="${haListManagerPanelText("ui.taken_from_open_food_facts", {}, this._hass)}"></label>
      <div class="field-grid product-grid"><label class="field"><span>${haListManagerPanelText("ui.brand_optional", {}, this._hass)}</span><input type="text" maxlength="200" data-product-brand value="${this._escape(draft.brand)}"></label><label class="field"><span>${haListManagerPanelText("ui.package_quantity_optional", {}, this._hass)}</span><input type="text" maxlength="100" data-product-quantity value="${this._escape(draft.package_quantity)}" placeholder="${haListManagerPanelText("ui.package_volume_example", {}, this._hass)}"></label></div>
      ${this._productCategoryAssignmentsMarkup()}
      <label class="field"><span>${haListManagerPanelText("ui.optional_image_url", {}, this._hass)}</span><input type="url" maxlength="1000" data-product-image value="${this._escape(draft.image_url)}" placeholder="${haListManagerPanelText("ui.image_url_example", {}, this._hass)}"></label>
      ${this._renderLabelSelector(draft.label_ids)}
      <p class="field-help">${haListManagerPanelText("help.refresh_openfoodfacts_product", {p0:(action)}, this._hass)}</p>
      ${this._dialogError()}
      <div class="dialog-actions"><button class="ha-button primary" data-save-product ${this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("ui.save_pending", {}, this._hass) : haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div>
    </section></div>`;
  }

  _bindEvents() {
    this.shadowRoot.querySelectorAll("[data-list-script]").forEach(button => button.addEventListener("click", () => this._openListScript(button.dataset.listScript)));
    if (this._dialog?.kind === "list-script") {
      const dialog = this._dialog;
      const selector = this.shadowRoot.querySelector("[data-script-entity]");
      if (selector) {
        selector.hass = this._hass;
        selector.label = haListManagerPanelText("scripts.script", {}, this._hass);
        selector.required = false;
        selector.selector = {entity: {filter: {domain: "script"}}};
        selector.value = dialog.draft.script_entity || undefined;
        selector.addEventListener("value-changed", event => {dialog.draft.script_entity = event.detail.value || null;});
      }
      this.shadowRoot.querySelector("[data-script-enabled]")?.addEventListener("change", event => {dialog.draft.enabled = event.target.checked;});
      this.shadowRoot.querySelectorAll("[data-script-event]").forEach(input => input.addEventListener("change", () => {
        const selected = new Set(dialog.draft.events);
        if (input.checked) selected.add(input.dataset.scriptEvent); else selected.delete(input.dataset.scriptEvent);
        dialog.draft.events = [...selected];
      }));
      this.shadowRoot.querySelector("[data-script-select-all]")?.addEventListener("click", () => {dialog.draft.events = dialog.options.map(option => option.event); this._render();});
      this.shadowRoot.querySelector("[data-script-select-none]")?.addEventListener("click", () => {dialog.draft.events = []; this._render();});
      this.shadowRoot.querySelector("[data-script-save]")?.addEventListener("click", () => this._saveListScript());
    }

    this.shadowRoot.querySelector("nav")?.addEventListener("scroll", (event) => {
      this._navigationScrollLeft = event.currentTarget.scrollLeft;
    }, { passive: true });
    this.shadowRoot.querySelector("[data-toggle-page-favorite]")?.addEventListener("click", () => this._toggleCurrentFavorite());
    this.shadowRoot.querySelectorAll("[data-open-favorite]").forEach((button) => button.addEventListener("click", () => this._openFavorite(button.dataset.openFavorite)));
    this.shadowRoot.querySelectorAll("[data-remove-favorite]").forEach((button) => button.addEventListener("click", () => {
      const favorite = this._favorites.find((entry) => entry.id === button.dataset.removeFavorite);
      if (favorite) this._setFavorite(favorite, false);
    }));
    this.shadowRoot.querySelectorAll("[data-section]").forEach((button) => button.addEventListener("click", () => {
      const navigationElement = button.closest("nav");
      if (navigationElement && window.matchMedia("(max-width: 760px)").matches) {
        const centeredScrollLeft = button.offsetLeft + (button.offsetWidth / 2) - (navigationElement.clientWidth / 2);
        navigationElement.scrollLeft = Math.max(0, centeredScrollLeft);
        this._navigationScrollLeft = navigationElement.scrollLeft;
      }
      this._activeSection = button.dataset.section;
      this._selectedListId = null;
      this._selectedCategoryId = null;
      this._categoryProducts = [];
      this._items = [];
      this._listItemSearch = "";
      this._listDetailTab = "overview";
      this._listAssignmentGroups = [];
      this._error = "";
      if (this._activeSection === "overview") {
        this._refreshInfo().then(() => this._render()).catch((error) => { this._error = this._formatError(error); this._render(); });
      }
      else if (this._activeSection === "products" && !this._productsLoaded) this._loadProducts();
      else if (this._activeSection === "categories" && !this._categoriesLoaded) this._loadCategories();
      else if (this._activeSection === "categories" && this._categoryTab === "specific") {
        this._categorySpecificListId = this._categorySpecificListId || this._lists[0]?.id || "";
        this._render();
        if (this._categorySpecificListId) this._loadListAssignments(this._categorySpecificListId, true);
      }
      else if (this._activeSection === "labels" && !this._labelsLoaded) this._loadLabels();
      else if (this._activeSection === "chips" && !this._chipsLoaded) this._loadChips();
      else if (this._activeSection === "dishes" && !this._dishesLoaded) this._loadDishes();
      else if (this._activeSection === "inventory") this._loadInventory();
      else if (this._activeSection === "entity_history") this._render();
      else if (this._activeSection === "history") this._loadScanHistory();
      else if (this._activeSection === "settings") {
        if (!this._settingsLoaded) this._loadSettings();
        else this._render();
      }
      else if (this._activeSection === "backup") this._loadDataBackupInfo();
      else this._render();
    }));
    this.shadowRoot.querySelector("[data-retry]")?.addEventListener("click", () => { this._loaded = false; this._loadData(); });
    this.shadowRoot.querySelectorAll("[data-entity-history-tab]").forEach((button) => button.addEventListener("click", () => {
      this._entityHistoryTab = button.dataset.entityHistoryTab;
      this._render();
    }));
    this.shadowRoot.querySelector("[data-entity-history-search]")?.addEventListener("input", (event) => {
      this._entityHistorySearch = event.target.value;
      this._filterEntityHistoryRows();
    });
    this.shadowRoot.querySelectorAll("[data-history-import-field]").forEach((input) => input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
      this._dialog.draft[input.dataset.historyImportField] = input.type === "checkbox" ? input.checked : input.value;
    }));
    this.shadowRoot.querySelector("[data-history-import-select]")?.addEventListener("click", () => this._openEntityHistoryImport(this._dialog.entity_id));
    this.shadowRoot.querySelector("[data-history-import-complete]")?.addEventListener("click", () => this._importEntityHistory(this._dialog.entity_id, { start: "", end: "", recorder: true, statistics: true }));
    this.shadowRoot.querySelector("[data-history-import-run]")?.addEventListener("click", () => this._importEntityHistory(this._dialog.entity_id));
    this.shadowRoot.querySelector("[data-show-hidden-samples]")?.addEventListener("change", (event) => {
      const dialog = this._dialog;
      dialog.show_hidden = event.target.checked;
      dialog.cursors = []; dialog.before_id = null; dialog.scroll_top = 0;
      this._loadEntitySamples(dialog);
    });
    this.shadowRoot.querySelector("[data-hide-entity-sample]")?.addEventListener("change", (event) => { this._dialog.draft.hidden = event.target.checked; });
    this.shadowRoot.querySelector("[data-delete-entity-sample]")?.addEventListener("click", () => this._openDeleteEntitySample());
    this.shadowRoot.querySelector("[data-confirm-delete-entity-sample]")?.addEventListener("click", () => this._deleteEntitySample());
    this.shadowRoot.querySelector("[data-add-entity-history]")?.addEventListener("click", () => {
      const entityId = this.shadowRoot.querySelector("[data-entity-history-picker]")?.value || this._entityHistoryCandidate;
      if (entityId) this._setEntityTracking(entityId, true, true);
    });
    this.shadowRoot.querySelectorAll("[data-toggle-entity-history]").forEach((button) => button.addEventListener("click", () => {
      this._setEntityTracking(button.dataset.toggleEntityHistory, button.dataset.enabled !== "1");
    }));
    this.shadowRoot.querySelectorAll("[data-delete-entity-history]").forEach((button) => button.addEventListener("click", () => {
      this._deleteEntityHistory(button.dataset.deleteEntityHistory);
    }));
    this.shadowRoot.querySelectorAll("[data-import-entity-history]").forEach((button) => button.addEventListener("click", () => {
      this._openEntityHistoryImport(button.dataset.importEntityHistory);
    }));
    this.shadowRoot.querySelectorAll("[data-entity-samples]").forEach((button) => button.addEventListener("click", () => this._openEntitySamples(button.dataset.entitySamples)));
    this.shadowRoot.querySelector("[data-add-entity-sample]")?.addEventListener("click", () => this._openEntitySampleEditor());
    this.shadowRoot.querySelectorAll("[data-edit-entity-sample]").forEach((button) => button.addEventListener("click", () => this._openEntitySampleEditor(this._dialog.records.find((record) => record.id === Number(button.dataset.editEntitySample)))));
    this.shadowRoot.querySelectorAll("[data-history-field]").forEach((input) => input.addEventListener("input", () => { this._dialog.draft[input.dataset.historyField] = input.value; }));
    this.shadowRoot.querySelectorAll("[data-history-range]").forEach((input) => input.addEventListener("input", () => { this._dialog[input.dataset.historyRange] = input.value; }));
    this.shadowRoot.querySelector(".entity-samples-list")?.addEventListener("scroll", (event) => { if (this._dialog?.kind === "entity-samples") this._dialog.scroll_top = event.target.scrollTop; });
    this.shadowRoot.querySelector("[data-save-entity-sample]")?.addEventListener("click", () => this._saveEntitySample());
    this.shadowRoot.querySelector("[data-history-filters]")?.addEventListener("toggle", (event) => { if (this._dialog?.kind === "entity-samples") this._dialog.filter_open = event.target.open; });
    this.shadowRoot.querySelector("[data-history-filter]")?.addEventListener("click", () => {
      const dialog = this._dialog;
      dialog.cursors = []; dialog.before_id = null; dialog.scroll_top = 0;
      this._loadEntitySamples(dialog);
    });
    this.shadowRoot.querySelector("[data-history-older]")?.addEventListener("click", () => {
      const dialog = this._dialog;
      dialog.cursors.push(dialog.before_id); dialog.before_id = dialog.records.at(-1)?.id; dialog.scroll_top = 0;
      this._loadEntitySamples(dialog);
    });
    this.shadowRoot.querySelector("[data-history-newer]")?.addEventListener("click", () => {
      const dialog = this._dialog;
      dialog.before_id = dialog.cursors.pop() || null; dialog.scroll_top = 0;
      this._loadEntitySamples(dialog);
    });
    this.shadowRoot.querySelectorAll("[data-add-list]").forEach((button) => button.addEventListener("click", () => this._openListDialog(null)));
    this.shadowRoot.querySelectorAll("[data-open-list]").forEach((button) => button.addEventListener("click", () => {
      this._selectedListId = button.dataset.openList;
      this._items = [];
      this._listItemSearch = "";
      this._listDetailTab = "overview";
      this._listAssignmentGroups = [];
      const list = this._findList(this._selectedListId);
      if (list?.list_type === "inventory") {
        this._selectedInventoryListId = list.id;
        this._inventoryEntries = [];
        this._inventoryGroups = [];
        this._loadInventory();
      } else {
        this._loadItems();
        this._loadListAssignments(list.id);
      }
      this._loadDashboardUsages();
    }));
    this.shadowRoot.querySelector("[data-back-lists]")?.addEventListener("click", () => { this._selectedListId = null; this._items = []; this._listItemSearch = ""; this._listDetailTab = "overview"; this._listAssignmentGroups = []; this._error = ""; this._render(); });
    this.shadowRoot.querySelectorAll("[data-list-detail-tab]").forEach((button) => button.addEventListener("click", () => {
      this._listDetailTab = button.dataset.listDetailTab;
      this._listItemSearch = "";
      this._render();
    }));
    this.shadowRoot.querySelectorAll("[data-open-list-assignments]").forEach((button) => button.addEventListener("click", () => {
      const listId = this._selectedListId;
      this._activeSection = "categories";
      this._categoryTab = "specific";
      this._categorySpecificListId = listId;
      this._categorySpecificMode = "rules";
      this._selectedListId = null;
      this._error = "";
      this._render();
      this._loadListAssignments(listId, true);
    }));
    this.shadowRoot.querySelector("[data-sync-bring]")?.addEventListener("click", () => this._syncBringList());
    this.shadowRoot.querySelectorAll("[data-edit-list]").forEach((button) => button.addEventListener("click", () => this._openListDialog(this._findList(button.dataset.editList))));
    this.shadowRoot.querySelectorAll("[data-edit-current-list]").forEach((button) => button.addEventListener("click", () => this._openListDialog(this._findList(this._selectedListId))));
    this.shadowRoot.querySelectorAll("[data-toggle-list-scope]").forEach((button) => button.addEventListener("click", () => this._openListScopeToggle(button.dataset.toggleListScope)));
    this.shadowRoot.querySelector("[data-open-inventory-section]")?.addEventListener("click", () => {
      this._selectedInventoryListId = this._selectedListId;
      this._selectedListId = null;
      this._activeSection = "inventory";
      this._loadInventory();
    });
    this.shadowRoot.querySelector("[data-refresh-dashboard-usages]")?.addEventListener("click", () => { this._dashboardUsagesLoaded = false; this._loadDashboardUsages(true); });
    this.shadowRoot.querySelectorAll("[data-delete-list]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-list", this._findList(button.dataset.deleteList))));
    this.shadowRoot.querySelector("[data-add-notification]")?.addEventListener("click", () => this._openNotificationDialog(null));
    this.shadowRoot.querySelectorAll("[data-edit-notification]").forEach((button) => button.addEventListener("click", () => this._openNotificationDialog(this._notificationProfiles.find((profile) => profile.id === button.dataset.editNotification))));
    this.shadowRoot.querySelectorAll("[data-delete-notification]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-notification", this._notificationProfiles.find((profile) => profile.id === button.dataset.deleteNotification))));
    this.shadowRoot.querySelectorAll("[data-test-notification]").forEach((button) => button.addEventListener("click", () => this._testNotification(button.dataset.testNotification)));
    this.shadowRoot.querySelectorAll("[data-notification-tab]").forEach((button) => button.addEventListener("click", () => {
      this._notificationTab = button.dataset.notificationTab;
      this._notificationStatus = "";
      this._render();
    }));
    this.shadowRoot.querySelectorAll("[data-toggle-notification-list]").forEach((button) => button.addEventListener("click", () => {
      const listId = button.dataset.toggleNotificationList;
      const body = this.shadowRoot.querySelector(`[data-notification-list-body="${listId}"]`);
      const expanded = !this._expandedNotificationLists.has(listId);
      if (expanded) this._expandedNotificationLists.add(listId);
      else this._expandedNotificationLists.delete(listId);
      if (body) body.hidden = !expanded;
      button.setAttribute("aria-expanded", String(expanded));
      const icon = button.querySelector("ha-icon");
      if (icon) icon.setAttribute("icon", `mdi:chevron-${expanded ? "up" : "down"}`);
    }));
    this.shadowRoot.querySelectorAll("[data-toggle-notification-settings]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.toggleNotificationSettings;
      const settings = this.shadowRoot.querySelector(`[data-notification-assignment-settings="${key}"]`);
      const expanded = !this._expandedNotificationProfiles.has(key);
      if (expanded) this._expandedNotificationProfiles.add(key);
      else this._expandedNotificationProfiles.delete(key);
      if (settings) settings.hidden = !expanded;
      const icon = button.querySelector("ha-icon");
      if (icon) icon.setAttribute("icon", `mdi:chevron-${expanded ? "up" : "down"}`);
    }));
    this.shadowRoot.querySelectorAll("[data-save-notification-assignments]").forEach((button) => button.addEventListener("click", () => this._saveNotificationAssignments(button.dataset.saveNotificationAssignments)));
    this.shadowRoot.querySelectorAll("[data-notification-assignment]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      const key = checkbox.dataset.notificationAssignment;
      const settings = this.shadowRoot.querySelector(`[data-notification-assignment-settings="${key}"]`);
      const toggle = this.shadowRoot.querySelector(`[data-toggle-notification-settings="${key}"]`);
      if (checkbox.checked) this._expandedNotificationProfiles.add(key);
      else this._expandedNotificationProfiles.delete(key);
      if (settings) settings.hidden = !checkbox.checked;
      if (toggle) {
        toggle.disabled = !checkbox.checked;
        const icon = toggle.querySelector("ha-icon");
        if (icon) icon.setAttribute("icon", `mdi:chevron-${checkbox.checked ? "up" : "down"}`);
      }
    }));
    this.shadowRoot.querySelectorAll("[data-notification-mode]").forEach((select) => select.addEventListener("change", () => {
      const events = this.shadowRoot.querySelector(`[data-notification-events="${select.dataset.notificationMode}"]`);
      if (events) events.disabled = select.value === "off";
    }));
    this.shadowRoot.querySelectorAll("[data-send-list-notification]").forEach((button) => button.addEventListener("click", () => this._sendListNotification(button.dataset.sendListNotification)));
    this.shadowRoot.querySelectorAll("[data-add-item]").forEach((button) => button.addEventListener("click", () => this._openItemDialog(null)));
    this.shadowRoot.querySelector("[data-add-list-category]")?.addEventListener("click", () => this._openCategoryDialog(null, { scope: "list", list_id: this._selectedListId }));
    this.shadowRoot.querySelectorAll("[data-edit-item]").forEach((button) => button.addEventListener("click", () => this._openItemDialog(this._findItem(button.dataset.editItem))));
    this.shadowRoot.querySelectorAll("[data-delete-item]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-item", this._findItem(button.dataset.deleteItem))));
    this.shadowRoot.querySelectorAll("[data-toggle-item]").forEach((checkbox) => checkbox.addEventListener("change", () => this._toggleItem(checkbox.dataset.toggleItem)));
    this.shadowRoot.querySelectorAll("[data-add-product]").forEach((button) => button.addEventListener("click", () => this._openProductDialog(null)));
    this.shadowRoot.querySelectorAll("[data-view-product-image]").forEach((button) => button.addEventListener("click", () => this._openImageDialog(this._findProduct(button.dataset.viewProductImage))));
    this.shadowRoot.querySelectorAll("[data-view-inventory-image]").forEach((button) => button.addEventListener("click", () => this._openImageDialog(this._findInventoryEntry(button.dataset.viewInventoryImage)?.product)));
    this.shadowRoot.querySelectorAll("[data-edit-product]").forEach((button) => button.addEventListener("click", () => this._openProductDialog(this._findProduct(button.dataset.editProduct))));
    this.shadowRoot.querySelectorAll("[data-delete-product]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-product", this._findProduct(button.dataset.deleteProduct))));
    this.shadowRoot.querySelectorAll("[data-category-tab]").forEach((button) => button.addEventListener("click", () => {
      this._categoryTab = button.dataset.categoryTab;
      if (this._categoryTab === "specific") {
        this._categorySpecificMode = "rules";
        const listId = this._categorySpecificListId || this._lists[0]?.id || "";
        this._categorySpecificListId = listId;
        const list = this._findList(listId);
        if (list?.list_type === "todo") this._categorySpecificMode = "rules";
        this._listAssignmentGroups = [];
        this._render();
        if (listId) this._loadListAssignments(listId, true);
      } else this._render();
    }));
    this.shadowRoot.querySelectorAll("[data-add-category]").forEach((button) => button.addEventListener("click", () => this._openCategoryDialog(null, { scope: button.dataset.categoryScope, list_type: button.dataset.categoryListType, list_id: button.dataset.categoryListId })));
    this.shadowRoot.querySelector("[data-edit-category-order]")?.addEventListener("click", () => {
      const specific = this._categoryTab === "specific";
      const listType = ["shopping", "inventory", "todo"].includes(this._categoryTab) ? this._categoryTab : "";
      const mode = specific ? "list" : listType ? "list_type" : "global";
      const preferred = specific
        ? this._findList(this._categorySpecificListId)
        : this._lists.find((list) => (!listType || list.list_type === listType) && list.enabled !== false) || this._lists.find((list) => list.enabled !== false);
      this._categoryOrderEditing = true;
      this._categoryOrderMode = mode;
      if (listType) this._categoryOrderListType = listType;
      this._categoryOrderListId = preferred?.id || "";
      this._categoryOrderCategories = [];
      this._categoryOrderOriginal = [];
      this._categoryOrderCustom = false;
      this._loadCategoryOrder(mode, preferred?.id || "");
    });
    this.shadowRoot.querySelector("[data-cancel-category-order]")?.addEventListener("click", () => {
      if (this._categoryOrderDirty()) {
        this._error = haListManagerPanelText("errors.save_order_before_closing", {}, this._hass);
        this._render();
        return;
      }
      this._categoryOrderEditing = false;
      this._error = "";
      this._render();
    });
    this.shadowRoot.querySelector("[data-category-order-mode]")?.addEventListener("change", (event) => this._loadCategoryOrder(event.target.value, this._categoryOrderListId));
    this.shadowRoot.querySelector("[data-category-order-list]")?.addEventListener("change", (event) => this._loadCategoryOrder(this._categoryOrderMode, event.target.value));
    this.shadowRoot.querySelector("[data-category-order-list-type]")?.addEventListener("change", (event) => { this._categoryOrderListType = event.target.value; this._loadCategoryOrder("list_type", this._categoryOrderListId); });
    this.shadowRoot.querySelector("[data-save-category-order]")?.addEventListener("click", () => this._saveCategoryOrder(false));
    this.shadowRoot.querySelector("[data-reset-combined-category-order]")?.addEventListener("click", () => this._resetCombinedCategoryOrder());
    this.shadowRoot.querySelector("[data-reset-category-order]")?.addEventListener("click", () => {
      const byId = new Map(this._categoryOrderCategories.map((category) => [category.id, category]));
      this._categoryOrderCategories = this._categoryOrderOriginal.map((id) => byId.get(id)).filter(Boolean);
      this._error = "";
      this._render();
    });
    this.shadowRoot.querySelectorAll("[data-category-order-up]").forEach((button) => button.addEventListener("click", () => {
      const index = this._categoryOrderCategories.findIndex((category) => category.id === button.dataset.categoryOrderUp);
      this._moveCategoryOrder(button.dataset.categoryOrderUp, index - 1);
    }));
    this.shadowRoot.querySelectorAll("[data-category-order-down]").forEach((button) => button.addEventListener("click", () => {
      const index = this._categoryOrderCategories.findIndex((category) => category.id === button.dataset.categoryOrderDown);
      this._moveCategoryOrder(button.dataset.categoryOrderDown, index + 1);
    }));
    this.shadowRoot.querySelectorAll("[data-category-order-position]").forEach((input) => input.addEventListener("change", () => {
      const position = Number(input.value);
      if (!Number.isInteger(position) || position < 1 || position > this._categoryOrderCategories.length) {
        this._error = haListManagerPanelText("ui.position_out_of_range", {p0:(this._categoryOrderCategories.length)}, this._hass);
        this._render();
        return;
      }
      this._error = "";
      this._moveCategoryOrder(input.dataset.categoryOrderPosition, position - 1);
    }));
    this.shadowRoot.querySelectorAll("[data-category-order-row]").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        this._categoryOrderDraggedId = row.dataset.categoryOrderRow;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", this._categoryOrderDraggedId);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => { this._categoryOrderDraggedId = ""; row.classList.remove("dragging"); });
      row.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const draggedId = this._categoryOrderDraggedId || event.dataTransfer.getData("text/plain");
        const target = this._categoryOrderCategories.findIndex((category) => category.id === row.dataset.categoryOrderRow);
        if (draggedId) this._moveCategoryOrder(draggedId, target);
      });
    });
    this.shadowRoot.querySelectorAll("[data-manage-category-detail]").forEach((button) => button.addEventListener("click", () => this._openCategoryProductsPage(this._findCategory(button.dataset.manageCategoryDetail), button.dataset.categoryDetailTarget)));
    this.shadowRoot.querySelectorAll("[data-category-detail-tab]").forEach((button) => button.addEventListener("click", () => {
      this._categoryDetailTab = button.dataset.categoryDetailTab;
      this._error = "";
      this._render();
    }));
    this.shadowRoot.querySelector("[data-back-categories]")?.addEventListener("click", () => {
      this._selectedCategoryId = null;
      this._categoryDetailTab = "rules";
      this._categoryRules = [];
      this._categoryRuleDraft = "";
      this._categoryRuleEditingIndex = -1;
      this._categoryProducts = [];
      this._error = "";
      this._render();
      if (this._categoryTab === "specific" && this._categorySpecificListId) this._loadListAssignments(this._categorySpecificListId, true);
    });
    this.shadowRoot.querySelector("[data-category-rule-input]")?.addEventListener("input", (event) => { this._categoryRuleDraft = event.target.value; });
    this.shadowRoot.querySelector("[data-category-rule-input]")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._saveCategoryRule();
      }
    });
    this.shadowRoot.querySelector("[data-save-category-rule]")?.addEventListener("click", () => this._saveCategoryRule());
    this.shadowRoot.querySelector("[data-cancel-category-rule]")?.addEventListener("click", () => {
      this._categoryRuleDraft = "";
      this._categoryRuleEditingIndex = -1;
      this._error = "";
      this._render();
      this.shadowRoot.querySelector("[data-category-rule-input]")?.focus();
    });
    this.shadowRoot.querySelectorAll("[data-edit-category-rule]").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.editCategoryRule);
      this._categoryRuleEditingIndex = index;
      this._categoryRuleDraft = this._categoryRules[index]?.pattern || "";
      this._error = "";
      this._render();
      const input = this.shadowRoot.querySelector("[data-category-rule-input]");
      input?.focus();
      input?.select();
    }));
    this.shadowRoot.querySelectorAll("[data-delete-category-rule]").forEach((button) => button.addEventListener("click", () => this._deleteCategoryRule(Number(button.dataset.deleteCategoryRule))));
    this.shadowRoot.querySelector("[data-open-category-rule-bulk]")?.addEventListener("click", () => this._openCategoryRulesBulkDialog());
    this.shadowRoot.querySelectorAll("[data-open-category-product-search]").forEach((button) => button.addEventListener("click", () => {
      this._openCategoryProductsDialog(this._findCategory(this._selectedCategoryId));
    }));
    this.shadowRoot.querySelectorAll("[data-remove-category-product-page]").forEach((button) => button.addEventListener("click", () => {
      this._removeCategoryProductFromPage(button.dataset.removeCategoryProductPage);
    }));
    this.shadowRoot.querySelectorAll("[data-edit-category]").forEach((button) => button.addEventListener("click", () => this._openCategoryDialog(this._findCategory(button.dataset.editCategory))));
    this.shadowRoot.querySelectorAll("[data-delete-category]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-category", this._findCategory(button.dataset.deleteCategory))));
    this.shadowRoot.querySelectorAll("[data-promote-category]").forEach((button) => button.addEventListener("click", () => this._openCategoryDialog(null, { name: button.dataset.name, scope: "list", list_id: button.dataset.listId })));
    this.shadowRoot.querySelectorAll("[data-label-tab]").forEach((button) => button.addEventListener("click", () => { this._labelTab = button.dataset.labelTab; this._render(); }));
    this.shadowRoot.querySelectorAll("[data-add-label]").forEach((button) => button.addEventListener("click", () => this._openLabelDialog(null, { scope: button.dataset.labelScope, list_type: button.dataset.labelListType, list_id: button.dataset.labelListId })));
    this.shadowRoot.querySelectorAll("[data-edit-label]").forEach((button) => button.addEventListener("click", () => this._openLabelDialog(this._findLabel(button.dataset.editLabel))));
    this.shadowRoot.querySelectorAll("[data-delete-label]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-label", this._findLabel(button.dataset.deleteLabel))));
    this.shadowRoot.querySelectorAll("[data-chip-tab]").forEach((button) => button.addEventListener("click", () => { this._chipTab = button.dataset.chipTab; this._render(); }));
    this.shadowRoot.querySelectorAll("[data-add-chip]").forEach((button) => button.addEventListener("click", () => this._openChipDialog(null, { scope: button.dataset.chipScope, list_type: button.dataset.chipListType, list_id: button.dataset.chipListId, chip_kind: button.dataset.chipKind })));
    this.shadowRoot.querySelectorAll("[data-edit-chip]").forEach((button) => button.addEventListener("click", () => this._openChipDialog(this._findChip(button.dataset.editChip))));
    this.shadowRoot.querySelectorAll("[data-delete-chip]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-chip", this._findChip(button.dataset.deleteChip))));
    this.shadowRoot.querySelectorAll("[data-add-dish]").forEach((button) => button.addEventListener("click", () => this._openDishDialog(null)));
    this.shadowRoot.querySelectorAll("[data-edit-dish]").forEach((button) => button.addEventListener("click", () => this._openDishDialog(this._findDish(button.dataset.editDish))));
    this.shadowRoot.querySelectorAll("[data-delete-dish]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-dish", this._findDish(button.dataset.deleteDish))));
    this.shadowRoot.querySelector("[data-dish-search]")?.addEventListener("input", (event) => { this._updateLocalSearch("_dishSearch", "[data-dish-search]", event.target.value, event.target.selectionStart); });
    this.shadowRoot.querySelectorAll("[data-add-inventory]").forEach((button) => button.addEventListener("click", () => this._openInventoryDialog(null)));
    this.shadowRoot.querySelectorAll("[data-edit-inventory]").forEach((button) => button.addEventListener("click", () => this._openInventoryDialog(this._findInventoryEntry(button.dataset.editInventory))));
    this.shadowRoot.querySelectorAll("[data-delete-inventory]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-inventory", this._findInventoryEntry(button.dataset.deleteInventory))));
    this.shadowRoot.querySelectorAll("[data-adjust-inventory]").forEach((button) => button.addEventListener("click", () => this._adjustInventory(button.dataset.adjustInventory, Number(button.dataset.delta))));
    this.shadowRoot.querySelector("[data-inventory-restock-settings]")?.addEventListener("click", () => this._openInventoryRestockSettingsDialog());
    this.shadowRoot.querySelector("[data-add-inventory-group]")?.addEventListener("click", () => this._openInventoryGroupDialog(null));
    this.shadowRoot.querySelectorAll("[data-edit-inventory-group]").forEach((button) => button.addEventListener("click", () => this._openInventoryGroupDialog(this._findInventoryGroup(button.dataset.editInventoryGroup))));
    this.shadowRoot.querySelectorAll("[data-delete-inventory-group]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-inventory-group", this._findInventoryGroup(button.dataset.deleteInventoryGroup))));
    this.shadowRoot.querySelector("[data-product-search]")?.addEventListener("input", (event) => {
      this._productSearch = event.target.value;
      this._productPage = 1;
      clearTimeout(this._productSearchTimer);
      this._productSearchTimer = setTimeout(() => this._loadProducts(true), 250);
    });
    this.shadowRoot.querySelectorAll("[data-product-page]").forEach((button) => button.addEventListener("click", () => {
      const pageCount = Math.max(1, Math.ceil(this._productTotal / this._productPageSize));
      const next = button.dataset.productPage === "previous" ? this._productPage - 1 : this._productPage + 1;
      this._productPage = Math.max(1, Math.min(pageCount, next));
      this._loadProducts();
    }));
    this.shadowRoot.querySelector("[data-product-page-size]")?.addEventListener("change", (event) => {
      this._productPageSize = Number(event.target.value) || 25;
      this._productPage = 1;
      this._loadProducts();
    });
    this.shadowRoot.querySelector("[data-list-item-search]")?.addEventListener("input", (event) => {
      this._updateLocalSearch("_listItemSearch", "[data-list-item-search]", event.target.value, event.target.selectionStart);
    });
    this.shadowRoot.querySelector("[data-label-search]")?.addEventListener("input", (event) => {
      this._updateLocalSearch("_labelSearch", "[data-label-search]", event.target.value, event.target.selectionStart);
    });
    this.shadowRoot.querySelector("[data-chip-search]")?.addEventListener("input", (event) => {
      this._updateLocalSearch("_chipSearch", "[data-chip-search]", event.target.value, event.target.selectionStart);
    });
    this.shadowRoot.querySelector("[data-inventory-group-search]")?.addEventListener("input", (event) => {
      this._updateLocalSearch("_inventoryGroupSearch", "[data-inventory-group-search]", event.target.value, event.target.selectionStart);
    });
    this.shadowRoot.querySelector("[data-category-product-search]")?.addEventListener("input", (event) => {
      if (this._dialog?.kind !== "category-products") return;
      this._dialog.search = event.target.value;
      clearTimeout(this._categoryProductSearchTimer);
      this._categoryProductSearchTimer = setTimeout(() => this._loadCategoryProducts(), 250);
    });
    this.shadowRoot.querySelector("[data-category-product-show-assigned]")?.addEventListener("change", (event) => {
      if (this._dialog?.kind !== "category-products") return;
      this._dialog.show_assigned = event.target.checked;
      this._updateCategoryProductDialogParts();
    });
    this.shadowRoot.querySelector("[data-category-products-dialog]")?.addEventListener("click", (event) => {
      const assign = event.target.closest("[data-assign-category-product]");
      if (assign && !assign.disabled) this._setCategoryProduct(assign.dataset.assignCategoryProduct, this._dialog.record.id);
    });
    this.shadowRoot.querySelector("[data-confirm-category-product-move]")?.addEventListener("click", () => {
      const confirmation = this._dialog?.move_confirmation;
      if (confirmation) this._setCategoryProduct(confirmation.product.id, this._dialog.record.id, true);
    });
    this.shadowRoot.querySelector("[data-cancel-category-product-move]")?.addEventListener("click", () => {
      if (this._dialog?.kind !== "category-products") return;
      this._dialog.move_confirmation = null;
      this._render();
      this.shadowRoot.querySelector("[data-category-product-search]")?.focus();
    });
    this.shadowRoot.querySelector("[data-admin-show-grouped]")?.addEventListener("change", (event) => { this._inventoryGroupShowGrouped = event.target.checked; this._render(); });
    this.shadowRoot.querySelectorAll("[data-cancel-dialog]:not([data-backup-dialog] [data-cancel-dialog])").forEach((button) => button.addEventListener("click", () => this._closeDialog()));
    this.shadowRoot.querySelectorAll("[data-dialog-panel]").forEach((panel) => panel.addEventListener("click", (event) => event.stopPropagation()));
    this.shadowRoot.querySelector("[data-save-list]")?.addEventListener("click", () => this._saveList());
    this.shadowRoot.querySelector("[data-save-item]")?.addEventListener("click", () => this._saveItem());
    this.shadowRoot.querySelector("[data-save-dynamic-category]")?.addEventListener("click", () => this._openDynamicCategoryDialog());
    this.shadowRoot.querySelector("[data-save-product]")?.addEventListener("click", () => this._saveProduct());
    this.shadowRoot.querySelector("[data-lookup-product]")?.addEventListener("click", () => this._lookupProduct());
    this.shadowRoot.querySelector("[data-toggle-product-brand]")?.addEventListener("click", () => { this._dialog.draft.append_brand = !this._dialog.draft.append_brand; this._applyProductNameOptions(); });
    this.shadowRoot.querySelector("[data-toggle-product-quantity]")?.addEventListener("click", () => { this._dialog.draft.append_quantity = !this._dialog.draft.append_quantity; this._applyProductNameOptions(); });
    this._bindBackupEvents();
    this._bindDataManagementEvents();
    this._bindLegacyImportEvents();
    this.shadowRoot.querySelector("[data-save-settings]")?.addEventListener("click", () => this._saveSettings());
    this.shadowRoot.querySelector("[data-test-tandoor]")?.addEventListener("click", () => this._testTandoor());
    this.shadowRoot.querySelector("[data-save-category]")?.addEventListener("click", () => this._saveCategory());
    this.shadowRoot.querySelector("[data-save-category-rules-bulk]")?.addEventListener("click", () => this._saveCategoryRulesBulk());
    this.shadowRoot.querySelector("[data-save-label]")?.addEventListener("click", () => this._saveLabel());
    this.shadowRoot.querySelector("[data-save-chip]")?.addEventListener("click", () => this._saveChip());
    this.shadowRoot.querySelector("[data-save-dish]")?.addEventListener("click", () => this._saveDish());
    this.shadowRoot.querySelector("[data-add-free-dish-item]")?.addEventListener("click", () => {
      this._dialog.draft.items.push({ name: "", product_id: null, product_name: "", quantity: 1 });
      this._render();
      const inputs = this.shadowRoot.querySelectorAll("[data-dish-item-name]");
      inputs[inputs.length - 1]?.focus();
    });
    this.shadowRoot.querySelector("[data-add-dish-product]")?.addEventListener("click", () => this._openDishProductPicker());
    this.shadowRoot.querySelectorAll("[data-close-dish-product-picker]").forEach((button) => button.addEventListener("click", () => this._closeDishProductPicker()));
    this.shadowRoot.querySelector("[data-dish-product-picker-backdrop]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) this._closeDishProductPicker();
    });
    this.shadowRoot.querySelector("[data-dish-product-picker-panel]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const productButton = event.target.closest("[data-select-dish-product]");
      if (productButton && !productButton.disabled) this._selectDishProduct(productButton.dataset.selectDishProduct);
    });
    this.shadowRoot.querySelector("[data-dish-product-search]")?.addEventListener("input", (event) => {
      if (this._dialog?.kind !== "dish-editor" || !this._dialog.product_picker_open) return;
      this._dialog.product_search = event.target.value;
      clearTimeout(this._dishProductSearchTimer);
      this._dishProductSearchTimer = setTimeout(() => this._loadDishProducts(), 250);
    });
    this.shadowRoot.querySelectorAll("[data-remove-dish-item]").forEach((button) => button.addEventListener("click", () => { this._dialog.draft.items.splice(Number(button.dataset.removeDishItem), 1); this._render(); }));
    this.shadowRoot.querySelector("[data-import-dish-items]")?.addEventListener("click", () => this._importDishItems());
    this.shadowRoot.querySelector("[data-clear-dish-color]")?.addEventListener("click", () => { this._dialog.draft.color = ""; this._render(); });
    this.shadowRoot.querySelector("[data-replace-chip]")?.addEventListener("click", () => this._saveChip(true));
    this.shadowRoot.querySelector("[data-cancel-chip-replace]")?.addEventListener("click", () => { this._dialog.draft.conflict = null; this._render(); });
    this.shadowRoot.querySelector("[data-clear-chip-product]")?.addEventListener("click", () => { this._dialog.draft.product_id = null; this._render(); });
    this.shadowRoot.querySelector("[data-save-inventory]")?.addEventListener("click", () => this._saveInventory());
    this.shadowRoot.querySelector("[data-new-inventory-product]")?.addEventListener("click", () => {
      const returnDialog = this._dialog;
      this._openProductDialog(null, { returnDialog });
    });
    this.shadowRoot.querySelector("[data-edit-inventory-product]")?.addEventListener("click", () => {
      const returnDialog = this._dialog;
      this._openProductDialog(returnDialog?.record?.product || null, { returnDialog });
    });
    this.shadowRoot.querySelector("[data-save-inventory-group]")?.addEventListener("click", () => this._saveInventoryGroup());
    this.shadowRoot.querySelector("[data-save-inventory-restock-settings]")?.addEventListener("click", () => this._saveInventoryRestockSettings());
    this.shadowRoot.querySelectorAll("[data-reset-inventory-restock-latch]").forEach((button) => button.addEventListener("click", () => {
      const [sourceType, sourceId] = button.dataset.resetInventoryRestockLatch.split(":");
      this._resetInventoryRestockLatch(sourceType, sourceId);
    }));
    this.shadowRoot.querySelectorAll("[data-add-scanner]").forEach((button) => button.addEventListener("click", () => this._openScannerDialog(null)));
    this.shadowRoot.querySelectorAll("[data-edit-scanner]").forEach((button) => button.addEventListener("click", () => this._openScannerDialog(this._scanners.find((scanner) => scanner.id === button.dataset.editScanner))));
    this.shadowRoot.querySelectorAll("[data-delete-scanner]").forEach((button) => button.addEventListener("click", () => this._openDeleteDialog("delete-scanner", this._scanners.find((scanner) => scanner.id === button.dataset.deleteScanner))));
    this.shadowRoot.querySelector("[data-save-scanner]")?.addEventListener("click", () => this._saveScanner());
    this.shadowRoot.querySelector("[data-save-notification]")?.addEventListener("click", () => this._saveNotification());
    this.shadowRoot.querySelector("[data-clear-scanner-target]")?.addEventListener("click", () => this._clearScannerTarget());
    this.shadowRoot.querySelector("[data-run-simulation]")?.addEventListener("click", () => this._runScannerSimulation());
    this.shadowRoot.querySelectorAll("[data-history-tab]").forEach((button) => button.addEventListener("click", () => {
      this._scanHistoryTab = button.dataset.historyTab;
      if (["queue", "history"].includes(this._scanHistoryTab) && !this._scanHistoryLoaded) this._loadScanHistory();
      else this._render();
    }));
    this.shadowRoot.querySelectorAll("[data-scan-page-size]").forEach((select) => select.addEventListener("change", async () => {
      const size = Number(select.value);
      if (![10, 25, 50, 100].includes(size)) return;
      if (select.dataset.scanPageSize === "history") {
        this._scanHistoryPageSize = size;
        this._scanHistoryPage = 1;
        await this._loadScanHistory();
      } else {
        this._scanQueuePageSize = size;
        this._scanQueuePage = 1;
        this._render();
      }
    }));
    this.shadowRoot.querySelectorAll("[data-scan-page]").forEach((button) => button.addEventListener("click", async () => {
      const [kind, direction] = button.dataset.scanPage.split(":");
      const delta = direction === "next" ? 1 : -1;
      if (kind === "history") {
        this._scanHistoryPage = Math.max(1, this._scanHistoryPage + delta);
        await this._loadScanHistory();
      } else {
        const pages = Math.max(1, Math.ceil(this._pendingScans.length / this._scanQueuePageSize));
        this._scanQueuePage = Math.min(pages, Math.max(1, this._scanQueuePage + delta));
        this._render();
      }
    }));
    this.shadowRoot.querySelectorAll("[data-edit-pending-scan]").forEach((button) => button.addEventListener("click", () => this._openPendingScanEditor(this._pendingScans.find((scan) => scan.id === button.dataset.editPendingScan))));
    this.shadowRoot.querySelectorAll("[data-dismiss-pending-scan]").forEach((button) => button.addEventListener("click", () => this._dismissPendingScan(button.dataset.dismissPendingScan)));
    this.shadowRoot.querySelector("[data-refresh-history]")?.addEventListener("click", () => this._loadScanHistory());
    this.shadowRoot.querySelector("[data-confirm-group-moves]")?.addEventListener("click", () => {
      const confirmation = this._dialog?.move_confirmation;
      if (confirmation?.action === "select") {
        this._dialog.draft.member_ids = [...new Set([...(this._dialog.draft.member_ids || []), confirmation.entry_id])];
        this._dialog.draft.confirmed_move_ids = [...new Set([...(this._dialog.draft.confirmed_move_ids || []), confirmation.entry_id])];
        this._dialog.move_confirmation = "";
        this._render();
      } else this._saveInventoryGroup(true);
    });
    this.shadowRoot.querySelector("[data-cancel-group-moves]")?.addEventListener("click", () => { this._dialog.move_confirmation = ""; this._render(); });
    this.shadowRoot.querySelector("[data-confirm-list-scopes]")?.addEventListener("click", () => this._saveList(true));
    this.shadowRoot.querySelector("[data-cancel-list-scopes]")?.addEventListener("click", () => { this._dialog.scope_confirmation = null; this._render(); });
    this.shadowRoot.querySelector("[data-confirm-list-scope-toggle]")?.addEventListener("click", () => this._confirmListScopeToggle());
    this.shadowRoot.querySelector("[data-clear-category-color]")?.addEventListener("click", () => { this._dialog.draft.color = ""; this._render(); });
    this.shadowRoot.querySelector("[data-clear-label-color]")?.addEventListener("click", () => { this._dialog.draft.color = ""; this._render(); });
    this.shadowRoot.querySelector("[data-clear-chip-color]")?.addEventListener("click", () => { this._dialog.draft.color = ""; this._render(); });
    this.shadowRoot.querySelector("[data-confirm-delete]")?.addEventListener("click", () => this._confirmDelete());
    this.shadowRoot.querySelectorAll(".dialog input,.dialog textarea,.dialog select").forEach((field) => {
      field.addEventListener("keydown", (event) => event.stopPropagation());
      field.addEventListener("keyup", (event) => event.stopPropagation());
    });
    this.shadowRoot.querySelector("[data-list-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-category-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-category-initial-rules]")?.addEventListener("input", (event) => { this._dialog.draft.rules_text = event.target.value; });
    this.shadowRoot.querySelector("[data-category-rules-bulk]")?.addEventListener("input", (event) => { this._dialog.text = event.target.value; });
    this.shadowRoot.querySelector("[data-category-position]")?.addEventListener("input", (event) => { this._dialog.draft.position = event.target.value; });
    this.shadowRoot.querySelector("[data-label-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-item-name]")?.addEventListener("input", (event) => { this._dialog.draft.item_name = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-description]")?.addEventListener("input", (event) => { this._dialog.draft.description = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-due-mode]")?.addEventListener("change", (event) => {
      const scrollTop = event.target.closest("[data-dialog-panel]")?.scrollTop || 0;
      this._dialog.draft.due_mode = event.target.value;
      this._render();
      requestAnimationFrame(() => {
        const panel = this.shadowRoot.querySelector("[data-dialog-panel]");
        if (panel) panel.scrollTop = scrollTop;
        this.shadowRoot.querySelector("[data-chip-due-mode]")?.focus();
      });
    });
    this.shadowRoot.querySelector("[data-chip-due-time]")?.addEventListener("input", (event) => { this._dialog.draft.due_time = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-due-offset]")?.addEventListener("input", (event) => { this._dialog.draft.due_offset_value = Number(event.target.value); });
    this.shadowRoot.querySelector("[data-chip-due-unit]")?.addEventListener("change", (event) => { this._dialog.draft.due_offset_unit = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-weekday]")?.addEventListener("change", (event) => { this._dialog.draft.due_weekday = Number(event.target.value); });
    this.shadowRoot.querySelector("[data-chip-recurrence]")?.addEventListener("input", (event) => { this._dialog.draft.recurrence_interval = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-recurrence-unit]")?.addEventListener("change", (event) => { this._dialog.draft.recurrence_unit = event.target.value; });
    this.shadowRoot.querySelector("[data-chip-add-mode]")?.addEventListener("change", (event) => { this._dialog.draft.add_mode = event.target.value; });
    this.shadowRoot.querySelector("[data-dish-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-dish-color]")?.addEventListener("input", (event) => { this._dialog.draft.color = event.target.value; });
    this.shadowRoot.querySelector("[data-dish-quick-items]")?.addEventListener("input", (event) => { this._dialog.draft.quick_items = event.target.value; });
    this.shadowRoot.querySelectorAll("[data-dish-item-name]").forEach((input) => input.addEventListener("input", () => { this._dialog.draft.items[Number(input.dataset.dishItemName)].name = input.value; }));
    this.shadowRoot.querySelectorAll("[data-dish-item-quantity]").forEach((input) => input.addEventListener("input", () => { this._dialog.draft.items[Number(input.dataset.dishItemQuantity)].quantity = input.value; }));
    this._configureChipProductPicker();
    this._configureTodoChipPickers();
    this.shadowRoot.querySelector("[data-inventory-stock]")?.addEventListener("input", (event) => { this._dialog.draft.stock = event.target.value; });
    this.shadowRoot.querySelector("[data-inventory-minimum]")?.addEventListener("input", (event) => { this._dialog.draft.minimum_stock = event.target.value; });
    this.shadowRoot.querySelector("[data-inventory-restock-quantity]")?.addEventListener("input", (event) => { this._dialog.draft.restock_quantity = event.target.value; });
    this.shadowRoot.querySelector("[data-inventory-restock-rule]")?.addEventListener("change", (event) => {
      this._dialog.draft.restock_mode = event.target.value;
      this._render();
      this.shadowRoot.querySelector("[data-inventory-restock-rule]")?.focus();
    });
    this._configurePendingScanCategoryPicker();
    this._configureItemCategoryPicker();
    this._configureProductCategoryPicker();
    for (const [selector, key] of [["[data-scan-product-name]", "name"], ["[data-scan-product-original-name]", "original_name"], ["[data-scan-product-brand]", "brand"], ["[data-scan-product-quantity]", "package_quantity"], ["[data-scan-product-image]", "image_url"]]) {
      this.shadowRoot.querySelector(selector)?.addEventListener("input", (event) => { this._dialog.draft[key] = event.target.value; });
    }
    this.shadowRoot.querySelector("[data-inventory-group-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-inventory-group-minimum]")?.addEventListener("input", (event) => { this._dialog.draft.minimum_stock = event.target.value; });
    this.shadowRoot.querySelector("[data-inventory-restock-enabled]")?.addEventListener("change", (event) => { this._dialog.draft.enabled = event.target.checked; });
    this.shadowRoot.querySelector("[data-inventory-restock-target]")?.addEventListener("change", (event) => { this._dialog.draft.target_list_id = event.target.value; });
    this.shadowRoot.querySelector("[data-inventory-restock-mode]")?.addEventListener("change", (event) => {
      this._dialog.draft.mode = event.target.value === "none" ? null : event.target.value;
      this._render();
      this.shadowRoot.querySelector("[data-inventory-restock-mode]")?.focus();
    });
    this.shadowRoot.querySelector("[data-inventory-restock-default-quantity]")?.addEventListener("input", (event) => { this._dialog.draft.fixed_quantity = event.target.value; });
    this.shadowRoot.querySelector("[data-scanner-name]")?.addEventListener("input", (event) => { this._dialog.draft.name = event.target.value; });
    this.shadowRoot.querySelector("[data-scanner-address]")?.addEventListener("input", (event) => { this._dialog.draft.address = event.target.value; });
    for (const [selector, key] of [["[data-notification-name]", "name"], ["[data-notification-title]", "title"], ["[data-notification-click-url]", "click_url"]]) this.shadowRoot.querySelector(selector)?.addEventListener("input", (event) => { this._dialog.draft[key] = event.target.value; });
    this.shadowRoot.querySelector("[data-notification-provider]")?.addEventListener("change", (event) => {
      this._dialog.draft.provider = event.target.value;
      this._dialog.draft.target = event.target.value === "persistent" ? "notify.persistent_notification" : "";
      this._dialog.draft.click_url = "";
      this._dialog.draft.message_format = "plain";
      this._render();
    });
    this.shadowRoot.querySelector("[data-notification-format]")?.addEventListener("change", (event) => { this._dialog.draft.message_format = event.target.value; });
    this.shadowRoot.querySelector("[data-simulation-ean]")?.addEventListener("input", (event) => { this._simulation.ean = event.target.value; });
    this.shadowRoot.querySelector("[data-simulation-quantity]")?.addEventListener("input", (event) => { this._simulation.quantity = event.target.value; });
    this.shadowRoot.querySelector("[data-simulation-stock]")?.addEventListener("input", (event) => { this._simulation.corrected_stock = event.target.value; });
    this.shadowRoot.querySelectorAll("[data-admin-group-member]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      const selected = new Set(this._dialog.draft.member_ids || []);
      if (checkbox.checked) {
        const warning = this._inventoryEntryMoveWarning(checkbox.dataset.adminGroupMember);
        if (warning) {
          checkbox.checked = false;
          this._dialog.move_confirmation = { action: "select", entry_id: checkbox.dataset.adminGroupMember, ...warning };
          this._render();
          return;
        }
        selected.add(checkbox.dataset.adminGroupMember);
      } else {
        selected.delete(checkbox.dataset.adminGroupMember);
        this._dialog.draft.confirmed_move_ids = (this._dialog.draft.confirmed_move_ids || []).filter((id) => id !== checkbox.dataset.adminGroupMember);
      }
      this._dialog.draft.member_ids = [...selected];
      this._dialog.move_confirmation = "";
    }));
    for (const [selector, key] of [["[data-item-name]", "name"], ["[data-item-description]", "description"]]) {
      this.shadowRoot.querySelector(selector)?.addEventListener("input", (event) => { this._dialog.draft[key] = event.target.value; this._updateBringPreview(); });
    }
    this.shadowRoot.querySelector("[data-item-offer-only]")?.addEventListener("change", (event) => { this._dialog.draft.offer_only = event.target.checked; });
    const itemDueTime = this.shadowRoot.querySelector("[data-item-due-time]");
    this.shadowRoot.querySelector("[data-item-due-date]")?.addEventListener("input", (event) => {
      this._dialog.draft.due_date = event.target.value;
      if (itemDueTime) itemDueTime.disabled = !event.target.value;
    });
    itemDueTime?.addEventListener("input", (event) => { this._dialog.draft.due_time = event.target.value; });
    this.shadowRoot.querySelector("[data-item-dynamic-category]")?.addEventListener("input", (event) => {
      this._dialog.draft.dynamic_category = event.target.value;
      if (event.target.value) {
        this._dialog.draft.category_id = "";
        const picker = this.shadowRoot.querySelector("[data-item-category-search]");
        if (picker) picker.value = "";
      }
      const saveButton = this.shadowRoot.querySelector("[data-save-dynamic-category]");
      if (saveButton) saveButton.disabled = !this._canSaveDynamicCategory(event.target.value, this._selectedListId);
    });
    this.shadowRoot.querySelector("[data-item-quantity]")?.addEventListener("input", (event) => { this._dialog.draft.quantity = event.target.value; this._updateBringPreview(); });
    this.shadowRoot.querySelector("[data-item-recurrence-interval]")?.addEventListener("input", (event) => { this._dialog.draft.recurrence_interval = event.target.value; });
    this.shadowRoot.querySelector("[data-item-recurrence-unit]")?.addEventListener("change", (event) => { this._dialog.draft.recurrence_unit = event.target.value; });
    for (const [selector, key] of [["[data-product-name]", "name"], ["[data-product-ean]", "ean"], ["[data-product-brand]", "brand"], ["[data-product-quantity]", "package_quantity"], ["[data-product-image]", "image_url"]]) {
      this.shadowRoot.querySelector(selector)?.addEventListener("input", (event) => {
        this._dialog.draft[key] = event.target.value;
        if (key === "name") {
          this._dialog.draft.base_name = event.target.value;
          this._dialog.draft.append_brand = false;
          this._dialog.draft.append_quantity = false;
          this.shadowRoot.querySelector("[data-toggle-product-brand]")?.classList.remove("active");
          this.shadowRoot.querySelector("[data-toggle-product-quantity]")?.classList.remove("active");
        }
        if (key === "ean") {
          this._dialog.draft.ean_error = "";
          this._dialog.draft.lookup_status = null;
        }
      });
    }
    this._configureLabelSelector();
    this._installPickerListTriggers();
    this._bindDialogScrollGuard();
  }

  _initializeRenderedComponents() {
    const entityHistoryPicker = this.shadowRoot.querySelector("[data-entity-history-picker]");
    if (entityHistoryPicker) {
      entityHistoryPicker.hass = this._hass;
      entityHistoryPicker.value = this._entityHistoryCandidate;
      entityHistoryPicker.label = haListManagerPanelText("ui.home_assistant_entity", {}, this._hass);
      entityHistoryPicker.addEventListener("value-changed", (event) => {
        this._entityHistoryCandidate = event.detail?.value || "";
      });
    }
    this.shadowRoot.querySelectorAll("ha-checkbox[data-toggle-item]").forEach((checkbox) => { checkbox.checked = Boolean(this._findItem(checkbox.dataset.toggleItem)?.completed); });
    this.shadowRoot.querySelectorAll("ha-checkbox[data-admin-group-member]").forEach((checkbox) => { checkbox.checked = Boolean(this._dialog?.draft?.member_ids?.includes(checkbox.dataset.adminGroupMember)); });
    const notificationEnabled = this.shadowRoot.querySelector("[data-notification-enabled]");
    if (notificationEnabled) { notificationEnabled.checked = Boolean(this._dialog?.draft?.enabled); notificationEnabled.addEventListener("change", () => { this._dialog.draft.enabled = notificationEnabled.checked; }); }
    const inventoryLists = this._lists.filter((list) => list.list_type === "inventory");
    if (!this._simulation.list_id && inventoryLists.length) this._simulation.list_id = inventoryLists[0].id;
    const configureSelect = (selector, label, options, value, handler, clearable = false) => {
      const select = this.shadowRoot.querySelector(selector);
      if (!select) return null;
      const selectedValue = value || "";
      select.label = label;
      select.clearable = clearable;
      select.options = options;
      select.value = selectedValue;
      const initialize = async () => {
        await (select.updateComplete || Promise.resolve());
        select.value = selectedValue;
        await (select.updateComplete || Promise.resolve());
        select.addEventListener("selected", (event) => {
          const nextValue = event.detail?.value || "";
          handler(nextValue, select);
          select.value = nextValue;
        });
      };
      initialize();
      return select;
    };
    const simulationWithoutDevice = "__simulation_without_device__";
    configureSelect("[data-simulation-scanner]", haListManagerPanelText("ui.scanner_optional", {}, this._hass), [{ value: simulationWithoutDevice, label: haListManagerPanelText("ui.simulation_without_device", {}, this._hass) }, ...this._scanners.map((scanner) => ({ value: scanner.id, label: scanner.name }))], this._simulation.scanner_id || simulationWithoutDevice, (value) => { this._simulation.scanner_id = value === simulationWithoutDevice ? "" : value; });
    configureSelect("[data-simulation-list]", haListManagerPanelText("ui.inventory_list", {}, this._hass), inventoryLists.map((list) => ({ value: list.id, label: list.name })), this._simulation.list_id, (value) => { this._simulation.list_id = value; });
    configureSelect("[data-simulation-action]", haListManagerPanelText("ui.action", {}, this._hass), Object.entries(SCANNER_ACTIONS(this._hass)).map(([value, item]) => ({ value, label: item.label })), this._simulation.action, (value) => { this._simulation.action = value || "add"; this._render(); });
    configureSelect("[data-simulation-delay]", haListManagerPanelText("ui.execute_scan", {}, this._hass), [{ value: "0", label: haListManagerPanelText("ui.immediately", {}, this._hass) }, { value: "5", label: haListManagerPanelText("ui.in_five_seconds", {}, this._hass) }, { value: "10", label: haListManagerPanelText("ui.in_ten_seconds", {}, this._hass) }, { value: "20", label: haListManagerPanelText("ui.in_twenty_seconds", {}, this._hass) }], this._simulation.delay || "0", (value) => { this._simulation.delay = value || "0"; });
    const specificListId = this._categorySpecificListId || this._lists[0]?.id || "";
    configureSelect("[data-category-specific-list]", haListManagerPanelText("ui.list", {}, this._hass), this._lists.map((list) => ({ value: list.id, label: `${list.name} · ${LIST_TYPES(this._hass)[list.list_type]?.label || list.list_type}` })), specificListId, (value) => {
      if (!value || value === this._categorySpecificListId) return;
      this._categorySpecificListId = value;
      if (this._findList(value)?.list_type === "todo") this._categorySpecificMode = "rules";
      this._listAssignmentGroups = [];
      this._error = "";
      this._render();
      this._loadListAssignments(value, true);
    });
    const specificListOptions = this._lists.map((list) => ({ value: list.id, label: `${list.name} · ${LIST_TYPES(this._hass)[list.list_type]?.label || list.list_type}` }));
    const labelSpecificListId = this._findList(this._labelSpecificListId)?.id || this._lists[0]?.id || "";
    configureSelect("[data-label-specific-list]", haListManagerPanelText("ui.list", {}, this._hass), specificListOptions, labelSpecificListId, (value) => {
      if (!value || value === this._labelSpecificListId) return;
      this._labelSpecificListId = value;
      this._error = "";
      this._render();
    });
    const chipSpecificListId = this._findList(this._chipSpecificListId)?.id || this._lists[0]?.id || "";
    configureSelect("[data-chip-specific-list]", haListManagerPanelText("ui.list", {}, this._hass), specificListOptions, chipSpecificListId, (value) => {
      if (!value || value === this._chipSpecificListId) return;
      this._chipSpecificListId = value;
      this._error = "";
      this._render();
    });
    const inventoryListFilter = this.shadowRoot.querySelector("[data-inventory-list-filter]");
    if (inventoryListFilter) {
      inventoryListFilter.label = haListManagerPanelText("ui.inventory_list", {}, this._hass);
      inventoryListFilter.options = this._lists.filter((list) => list.list_type === "inventory").map((list) => ({ value: list.id, label: list.name }));
      inventoryListFilter.value = this._selectedInventoryListId || "";
      inventoryListFilter.addEventListener("selected", (event) => {
        const value = event.detail?.value;
        if (value && value !== this._selectedInventoryListId) {
          this._selectedInventoryListId = value;
          this._inventoryEntries = [];
          this._loadInventory();
        }
      });
    }
    const productLabelFilter = this.shadowRoot.querySelector("[data-product-label-filter]");
    if (productLabelFilter) {
      productLabelFilter.label = haListManagerPanelText("ui.filter_by_label", {}, this._hass);
      productLabelFilter.clearable = true;
      productLabelFilter.options = this._labels.map((label) => ({ value: label.id, label: label.name }));
      productLabelFilter.value = this._productLabelFilter;
      productLabelFilter.addEventListener("selected", (event) => {
        this._productLabelFilter = event.detail?.value || "";
        this._productPage = 1;
        this._loadProducts();
      });
    }
    if (this._dialog?.kind === "list-editor") {
      const typeSelect = this.shadowRoot.querySelector("[data-list-type-select]");
      if (typeSelect) {
        typeSelect.label = haListManagerPanelText("ui.list_type", {}, this._hass);
        typeSelect.options = Object.entries(LIST_TYPES(this._hass)).map(([value, data]) => ({ value, label: data.label }));
        typeSelect.value = this._dialog.draft.list_type;
        typeSelect.addEventListener("selected", (event) => {
          const value = event.detail?.value;
          if (Object.hasOwn(LIST_TYPES(this._hass), value)) {
            typeSelect.value = value;
            this._dialog.draft.list_type = value;
            if (value !== "bring") this._dialog.draft.external_entity_id = "";
            this._render();
          }
        });
      }
      const iconSelector = this.shadowRoot.querySelector("[data-list-icon-selector]");
      iconSelector.hass = this._hass;
      iconSelector.label = haListManagerPanelText("ui.symbol_optional", {}, this._hass);
      iconSelector.required = false;
      iconSelector.selector = { icon: {} };
      iconSelector.value = this._dialog.draft.icon || undefined;
      iconSelector.addEventListener("value-changed", (event) => { this._dialog.draft.icon = event.detail.value || ""; });
      const externalEntitySelector = this.shadowRoot.querySelector("[data-list-external-entity-selector]");
      if (externalEntitySelector) {
        externalEntitySelector.hass = this._hass;
        externalEntitySelector.label = haListManagerPanelText("ui.bring_list", {}, this._hass);
        externalEntitySelector.required = true;
        externalEntitySelector.selector = { entity: { filter: { domain: "todo", integration: "bring" } } };
        externalEntitySelector.value = this._dialog.draft.external_entity_id || undefined;
        externalEntitySelector.addEventListener("value-changed", (event) => {
          const value = event.detail.value || "";
          this._dialog.draft.external_entity_id = value;
          if (!this._dialog.draft.name.trim() && value) {
            this._dialog.draft.name = this._hass.states[value]?.attributes?.friendly_name || value.split(".").pop();
            const nameInput = this.shadowRoot.querySelector("[data-list-name]");
            if (nameInput) nameInput.value = this._dialog.draft.name;
          }
        });
      }
      for (const [selector, key] of [
        ["[data-list-use-global-categories]", "use_global_categories"],
        ["[data-list-use-type-categories]", "use_type_categories"],
        ["[data-list-use-global-labels]", "use_global_labels"],
        ["[data-list-use-type-labels]", "use_type_labels"],
        ["[data-list-use-global-chips]", "use_global_chips"],
        ["[data-list-use-type-chips]", "use_type_chips"],
        ["[data-list-use-dishes]", "use_dishes"],
        ["[data-list-use-tandoor]", "use_tandoor"],
        ["[data-list-tandoor-skip-small-units]", "tandoor_skip_small_units"],
        ["[data-list-tandoor-include-ingredients]", "tandoor_include_ingredients"],
      ]) {
        const checkbox = this.shadowRoot.querySelector(selector);
        if (checkbox) {
          checkbox.checked = Boolean(this._dialog.draft[key]);
          checkbox.addEventListener("change", () => { this._dialog.draft[key] = checkbox.checked; });
        }
      }
      const excludedUnits = this.shadowRoot.querySelector("[data-list-tandoor-excluded-units]");
      if (excludedUnits) excludedUnits.addEventListener("input", () => { this._dialog.draft.tandoor_excluded_units = excludedUnits.value; });
      const resultLimit = this.shadowRoot.querySelector("[data-list-tandoor-result-limit]");
      if (resultLimit) resultLimit.addEventListener("change", () => { this._dialog.draft.tandoor_result_limit = Number(resultLimit.value); });
      return;
    }
    if (this._dialog?.kind === "scanner-editor") {
      const draft = this._dialog.draft;
      const enabled = this.shadowRoot.querySelector("[data-scanner-enabled]");
      if (enabled) { enabled.checked = draft.enabled; enabled.addEventListener("change", () => { draft.enabled = enabled.checked; }); }
      configureSelect("[data-scanner-routing]", haListManagerPanelText("ui.assignment", {}, this._hass), [{ value: "active_target", label: haListManagerPanelText("ui.active_card_default_target", {}, this._hass) }, { value: "fixed", label: haListManagerPanelText("ui.fixed_list_action", {}, this._hass) }], draft.routing, (value) => { draft.routing = value || "active_target"; if (draft.routing === "active_target") { draft.list_id = ""; draft.action = ""; } this._render(); });
      if (draft.routing === "fixed") {
        configureSelect("[data-scanner-list]", haListManagerPanelText("ui.inventory_list", {}, this._hass), inventoryLists.map((list) => ({ value: list.id, label: list.name })), draft.list_id, (value) => { draft.list_id = value; });
        configureSelect("[data-scanner-action]", haListManagerPanelText("ui.action", {}, this._hass), Object.entries(SCANNER_ACTIONS(this._hass)).map(([value, item]) => ({ value, label: item.label })), draft.action, (value) => { draft.action = value; });
      }
      return;
    }
    if (this._dialog?.kind === "notification-editor") {
      const draft = this._dialog.draft;
      const targetPicker = this.shadowRoot.querySelector("[data-notification-target-picker]");
      if (targetPicker) {
        const items = Object.values(this._hass?.states || {})
          .filter((entity) => entity.entity_id?.startsWith("notify.") && this._notificationIsTelegram(entity.entity_id) === (draft.provider === "telegram"))
          .map((entity) => ({
            id: entity.entity_id,
            primary: entity.attributes?.friendly_name || entity.entity_id,
            secondary: entity.entity_id,
            icon: entity.attributes?.icon || "mdi:message-badge-outline",
            sorting_label: entity.attributes?.friendly_name || entity.entity_id,
          }))
          .sort((left, right) => left.sorting_label.localeCompare(right.sorting_label, haListManagerPanelTextLocale(this._hass), { sensitivity: "base" }));
        targetPicker.label = haListManagerPanelText(draft.provider === "telegram" ? "notifications.telegram_target" : "ui.target", {}, this._hass);
        targetPicker.searchLabel = haListManagerPanelText(draft.provider === "telegram" ? "notifications.search_telegram_chats" : "ui.browse_notify_entities", {}, this._hass);
        targetPicker.required = true;
        targetPicker.noSort = true;
        targetPicker.useTopLabel = true;
        targetPicker.getItems = () => items;
        targetPicker.notFoundLabel = haListManagerPanelText(draft.provider === "telegram" ? "notifications.no_telegram_chat" : "ui.no_matching_notify_entity", {}, this._hass);
        targetPicker.valueRenderer = (value) => {
          const headline = document.createElement("span");
          headline.slot = "headline";
          headline.textContent = items.find((item) => item.id === value)?.primary || value || "";
          return headline;
        };
        targetPicker.value = draft.target || "";
        targetPicker.addEventListener("value-changed", (event) => {
          draft.target = event.detail?.value || "";
          targetPicker.value = draft.target;
          const targetId = this.shadowRoot.querySelector("[data-notification-target-id]");
          if (targetId) targetId.textContent = draft.target;
        });
      }
      const targetSelector = this.shadowRoot.querySelector("[data-notification-target-selector]");
      if (targetSelector) {
        targetSelector.hass = this._hass;
        targetSelector.label = haListManagerPanelText(draft.provider === "ntfy" ? "notifications.ntfy_target" : draft.provider === "telegram" ? "notifications.telegram_target" : "ui.target", {}, this._hass);
        targetSelector.required = true;
        targetSelector.selector = {
          entity: {
            filter: {
              domain: "notify",
              ...(draft.provider === "ntfy" ? { integration: "ntfy" } : draft.provider === "telegram" ? { integration: "telegram_bot" } : {}),
            },
            ...(draft.provider === "notify_entity" ? { exclude_entities: Object.keys(this._notificationEntityPlatforms).filter((entityId) => this._notificationIsTelegram(entityId)) } : {}),
          },
        };
        targetSelector.value = draft.target || undefined;
        targetSelector.addEventListener("value-changed", (event) => {
          draft.target = event.detail?.value || "";
          targetSelector.value = draft.target || undefined;
          const targetId = this.shadowRoot.querySelector("[data-notification-target-id]");
          if (targetId) targetId.textContent = draft.target;
        });
      }
      const serviceOptions = Object.entries(this._hass?.services?.notify || {})
        .filter(([service]) => !["notify", "send_message", "persistent_notification", "ntfy"].includes(service) && !service.startsWith("mobile_app_") && !this._notificationIsTelegram(`notify.${service}`))
        .map(([service]) => ({
          value: `notify.${service}`,
          label: `${service.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())} · notify.${service}`,
        }))
        .sort((left, right) => left.label.localeCompare(right.label, haListManagerPanelTextLocale(this._hass), { sensitivity: "base" }));
      configureSelect(
        "[data-notification-service-select]", haListManagerPanelText("notifications.notify_service", {}, this._hass), serviceOptions,
        draft.target, (value) => { draft.target = value; }, true,
      );
      return;
    }
    if (this._dialog?.kind === "inventory-editor") {
      this._configureInventoryProductPicker();
      this._configureInventoryEntryCategoryPicker();
      return;
    }
    if (this._dialog?.kind === "inventory-group-editor") {
      this._configureInventoryGroupCategoryPicker();
      return;
    }
    if (this._activeSection === "settings" && !this._dialog) {
      const brand = this.shadowRoot.querySelector("[data-setting-brand]");
      const quantity = this.shadowRoot.querySelector("[data-setting-quantity]");
      if (brand) { brand.checked = this._settings.append_brand_to_product_name; brand.addEventListener("change", () => { this._settings.append_brand_to_product_name = brand.checked; }); }
      if (quantity) { quantity.checked = this._settings.append_quantity_to_product_name; quantity.addEventListener("change", () => { this._settings.append_quantity_to_product_name = quantity.checked; }); }
      const tandoorUrl = this.shadowRoot.querySelector("[data-setting-tandoor-url]");
      const tandoorToken = this.shadowRoot.querySelector("[data-setting-tandoor-token]");
      if (tandoorUrl) tandoorUrl.addEventListener("input", () => { this._settings.tandoor_url = tandoorUrl.value; this._tandoorTestStatus = ""; });
      if (tandoorToken) tandoorToken.addEventListener("input", () => { this._settings.tandoor_token = tandoorToken.value; this._tandoorTestStatus = ""; });
      configureSelect("[data-setting-scanner-list]", haListManagerPanelText("ui.default_inventory_list", {}, this._hass), inventoryLists.map((list) => ({ value: list.id, label: list.name })), this._settings.scanner_default_list_id || "", (value) => { this._settings.scanner_default_list_id = value || null; }, true);
      configureSelect("[data-setting-scanner-action]", haListManagerPanelText("ui.default_action", {}, this._hass), Object.entries(SCANNER_ACTIONS(this._hass)).map(([value, item]) => ({ value, label: item.label })), this._settings.scanner_default_action || "add", (value) => { this._settings.scanner_default_action = value || "add"; });
    }
    if (this._dialog?.kind === "label-editor") {
      const draft = this._dialog.draft;
      configureSelect(
        "[data-label-scope-select]", haListManagerPanelText("ui.scope", {}, this._hass),
        [
          { value: "global", label: haListManagerPanelText("ui.global_in_all_lists", {}, this._hass) },
          { value: "list_type", label: haListManagerPanelText("ui.for_list_type", {}, this._hass) },
          { value: "list", label: haListManagerPanelText("ui.specific_list_only", {}, this._hass) },
        ], draft.scope, (value) => {
          draft.scope = value || "global";
          this._render();
        },
      );
      configureSelect(
        "[data-label-list-type-select]", haListManagerPanelText("ui.list_type", {}, this._hass),
        [
          { value: "shopping", label: haListManagerPanelText("ui.shopping_including_bring", {}, this._hass) },
          { value: "inventory", label: haListManagerPanelText("ui.inventory", {}, this._hass) },
          { value: "todo", label: haListManagerPanelText("ui.todo", {}, this._hass) },
        ], draft.list_type, (value) => { draft.list_type = value || "shopping"; },
      );
      configureSelect(
        "[data-label-list-select]", haListManagerPanelText("ui.list", {}, this._hass),
        this._lists.map((list) => ({ value: list.id, label: `${list.name} · ${LIST_TYPES(this._hass)[list.list_type]?.label || list.list_type}` })),
        draft.list_id, (value) => { draft.list_id = value || ""; },
      );
      const iconSelector = this.shadowRoot.querySelector("[data-label-icon-selector]");
      iconSelector.hass = this._hass;
      iconSelector.label = haListManagerPanelText("ui.symbol_optional", {}, this._hass);
      iconSelector.required = false;
      iconSelector.selector = { icon: {} };
      iconSelector.value = draft.icon || undefined;
      iconSelector.addEventListener("value-changed", (event) => { draft.icon = event.detail.value || ""; });
      const colorSelector = this.shadowRoot.querySelector("[data-label-color-selector]");
      const updateColor = (value) => {
        draft.color = this._rgbToHex(value);
        const clearButton = this.shadowRoot.querySelector("[data-clear-label-color]");
        if (clearButton) clearButton.disabled = !draft.color;
      };
      colorSelector.label = haListManagerPanelText("ui.optional_color", {}, this._hass);
      colorSelector.required = false;
      colorSelector.value = draft.color || "";
      colorSelector.addEventListener("input", () => updateColor(colorSelector.value));
      colorSelector.addEventListener("change", () => updateColor(colorSelector.value));
      return;
    }
    if (this._dialog?.kind === "chip-editor") {
      const draft = this._dialog.draft;
      const isTodo = draft.chip_kind === "todo_template";
      configureSelect(
        "[data-chip-scope-select]", haListManagerPanelText("ui.scope", {}, this._hass),
        isTodo ? [
          { value: "list_type", label: haListManagerPanelText("ui.all_todo_lists", {}, this._hass) },
          { value: "list", label: haListManagerPanelText("ui.specific_todo_list_only", {}, this._hass) },
        ] : [
          { value: "global", label: haListManagerPanelText("chips.general_items_scope", {}, this._hass) },
          { value: "list_type", label: haListManagerPanelText("ui.for_list_type", {}, this._hass) },
          { value: "list", label: haListManagerPanelText("ui.specific_list_only", {}, this._hass) },
        ], draft.scope, (value) => { draft.scope = value || (isTodo ? "list_type" : "global"); if (draft.scope === "list" && !this._findList(draft.list_id)) draft.list_id = this._lists.find((list) => list.list_type === (isTodo ? "todo" : "shopping"))?.id || ""; this._render(); },
      );
      configureSelect(
        "[data-chip-list-type-select]", haListManagerPanelText("ui.list_type", {}, this._hass),
        [
          { value: "shopping", label: haListManagerPanelText("ui.shopping_including_bring", {}, this._hass) },
          { value: "inventory", label: haListManagerPanelText("ui.inventory", {}, this._hass) },
        ], draft.list_type, (value) => { draft.list_type = value || "shopping"; },
      );
      const iconSelector = this.shadowRoot.querySelector("[data-chip-icon-selector]");
      if (iconSelector) { iconSelector.hass = this._hass; iconSelector.label = haListManagerPanelText("ui.symbol_optional", {}, this._hass); iconSelector.required = false; iconSelector.selector = { icon: {} }; iconSelector.value = draft.icon || undefined; iconSelector.addEventListener("value-changed", (event) => { draft.icon = event.detail.value || ""; }); }
      const colorSelector = this.shadowRoot.querySelector("[data-chip-color-selector]");
      const updateColor = (value) => {
        draft.color = this._rgbToHex(value);
        const clearButton = this.shadowRoot.querySelector("[data-clear-chip-color]");
        if (clearButton) clearButton.disabled = !draft.color;
      };
      colorSelector.label = haListManagerPanelText("ui.optional_color", {}, this._hass);
      colorSelector.required = false;
      colorSelector.value = draft.color || "";
      colorSelector.addEventListener("input", () => updateColor(colorSelector.value));
      colorSelector.addEventListener("change", () => updateColor(colorSelector.value));
      return;
    }
    if (this._dialog?.kind !== "category-editor") return;
    const draft = this._dialog.draft;
    const configure = (selector, label, definition, value, handler, required = false) => {
      if (!selector) return;
      selector.hass = this._hass;
      selector.label = label;
      selector.required = required;
      selector.selector = definition;
      selector.value = value;
      selector.addEventListener("value-changed", handler);
    };
    configure(this.shadowRoot.querySelector("[data-category-scope-selector]"), haListManagerPanelText("ui.validity", {}, this._hass), { select: { mode: "dropdown", options: [{ value: "global", label: haListManagerPanelText("ui.global_all_lists", {}, this._hass) }, { value: "list_type", label: haListManagerPanelText("ui.for_list_type", {}, this._hass) }, { value: "list", label: haListManagerPanelText("ui.single_list_only", {}, this._hass) }] } }, draft.scope, (event) => {
      draft.scope = event.detail.value;
      if (draft.scope === "global") { draft.list_id = ""; draft.list_type = "shopping"; }
      else if (draft.scope === "list_type") draft.list_id = "";
      else if (!draft.list_id) draft.list_id = this._lists[0]?.id || "";
      this._render();
    }, true);
    configure(this.shadowRoot.querySelector("[data-category-list-type-selector]"), haListManagerPanelText("ui.list_type", {}, this._hass), { select: { mode: "dropdown", options: ["shopping", "inventory", "todo"].map((value) => ({ value, label: LIST_TYPES(this._hass)[value]?.label || value })) } }, draft.list_type, (event) => { draft.list_type = event.detail.value; }, true);
    configure(this.shadowRoot.querySelector("[data-category-list-selector]"), haListManagerPanelText("ui.list", {}, this._hass), { select: { mode: "dropdown", options: this._lists.map((list) => ({ value: list.id, label: list.name })) } }, draft.list_id, (event) => { draft.list_id = event.detail.value; }, true);
    configure(this.shadowRoot.querySelector("[data-category-icon-selector]"), haListManagerPanelText("ui.symbol_optional", {}, this._hass), { icon: {} }, draft.icon || undefined, (event) => { draft.icon = event.detail.value || ""; });
    const colorSelector = this.shadowRoot.querySelector("[data-category-color-selector]");
    const updateColor = (value) => {
      draft.color = this._rgbToHex(value);
      const clearButton = this.shadowRoot.querySelector("[data-clear-category-color]");
      if (clearButton) clearButton.disabled = !draft.color;
    };
    colorSelector.label = haListManagerPanelText("ui.optional_color", {}, this._hass);
    colorSelector.required = false;
    colorSelector.value = draft.color || "";
    colorSelector.addEventListener("input", () => updateColor(colorSelector.value));
    colorSelector.addEventListener("change", () => updateColor(colorSelector.value));
  }

  async _openListScript(listId) {
    const list = this._findList(listId);
    if (!list) return;
    this._error = "";
    const dialog = {kind: "list-script", list, loading: true, options: [], draft: {enabled: false, script_entity: null, events: []}};
    this._dialog = dialog;
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {type: `${API}/lists/script/get`, list_id: listId});
      if (this._dialog !== dialog) return;
      dialog.draft = {...result.settings, events: [...result.settings.events]};
      dialog.options = result.options || [];
    } catch (error) {
      if (this._dialog === dialog) this._error = this._formatError(error) || haListManagerPanelText("scripts.load_error", {}, this._hass);
    } finally {
      dialog.loading = false;
      if (this._dialog === dialog) this._render();
    }
  }

  _renderListScriptDialog() {
    const {list, draft, options, loading} = this._dialog;
    const groups = [...new Set(options.map(option => option.group))];
    return `<div class="dialog-backdrop"><section class="dialog list-script-dialog" role="dialog" aria-modal="true"><div class="dialog-header"><div><h2>${haListManagerPanelText("scripts.title", {}, this._hass)}</h2><p>${this._escape(list.name)}</p></div><button class="icon-button" type="button" data-cancel-dialog aria-label="${haListManagerPanelText("ui.close", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>
      <p class="field-help">${haListManagerPanelText("scripts.help", {}, this._hass)}</p>
      ${loading ? this._loadingCard(haListManagerPanelText("scripts.loading", {}, this._hass)) : `<label class="setting-row"><input type="checkbox" data-script-enabled ${draft.enabled ? "checked" : ""}><span><strong>${haListManagerPanelText("scripts.enabled", {}, this._hass)}</strong></span></label>
      <ha-selector class="selector-field" data-script-entity></ha-selector>
      <div class="dialog-actions"><button class="ha-button" type="button" data-script-select-all>${haListManagerPanelText("scripts.all", {}, this._hass)}</button><button class="ha-button" type="button" data-script-select-none>${haListManagerPanelText("scripts.none", {}, this._hass)}</button></div>
      ${groups.map(group => `<fieldset class="option-group"><legend>${({list:haListManagerPanelText("scripts.list", {}, this._hass),inventory:haListManagerPanelText("scripts.inventory", {}, this._hass),scanner:haListManagerPanelText("scripts.scanner", {}, this._hass),restock:haListManagerPanelText("scripts.restock", {}, this._hass)}[group])}</legend>${options.filter(option => option.group === group).map(option => `<label class="setting-row compact-setting"><input type="checkbox" data-script-event="${option.event}" ${draft.events.includes(option.event) ? "checked" : ""}><span>${this._escape(option.label)}</span></label>`).join("")}</fieldset>`).join("")}
      `}
      ${this._dialogError()}<div class="dialog-actions"><button class="ha-button primary" type="button" data-script-save ${this._busy || loading ? "disabled" : ""}>${haListManagerPanelText("ui.save", {}, this._hass)}</button><button class="ha-button" type="button" data-cancel-dialog>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  async _saveListScript() {
    if (this._busy || this._dialog?.loading) return;
    const dialog = this._dialog;
    await this._runDialogAction(async () => {
      await haListManagerPanelTextRequest(this._hass, {type: `${API}/lists/script/set`, list_id: dialog.list.id,
        enabled: dialog.draft.enabled, script_entity: dialog.draft.script_entity || null, events: dialog.draft.events});
      if (this._dialog === dialog) this._dialog = null;
    });
  }

  _openListDialog(record) {
    this._error = "";
    this._dialog = { kind: "list-editor", record, draft: {
      name: record?.name || "", list_type: record?.list_type || "shopping",
      external_entity_id: record?.external_entity_id || "", icon: record?.icon || "",
      use_global_categories: record?.use_global_categories !== false,
      use_type_categories: record?.use_type_categories !== false,
      use_global_labels: record?.use_global_labels !== false,
      use_type_labels: record?.use_type_labels !== false,
      use_global_chips: record?.use_global_chips !== false,
      use_type_chips: record?.use_type_chips !== false,
      use_dishes: record?.use_dishes === true,
      use_tandoor: record?.use_tandoor === true,
      tandoor_skip_small_units: record?.tandoor_skip_small_units === true,
      tandoor_include_ingredients: record?.tandoor_include_ingredients !== false,
      tandoor_excluded_units: record?.tandoor_excluded_units || "",
      tandoor_result_limit: Number(record?.tandoor_result_limit || 100),
    } };
    this._render();
    this.shadowRoot.querySelector("[data-list-name]").focus();
  }

  async _openListScopeToggle(key) {
    const keys = [
      "use_global_categories", "use_type_categories",
      "use_global_labels", "use_type_labels",
      "use_global_chips", "use_type_chips",
    ];
    const list = this._findList(this._selectedListId);
    if (this._busy || !list || (!keys.includes(key) && !["use_dishes", "use_tandoor"].includes(key))) return;
    if (["use_dishes", "use_tandoor"].includes(key)) {
      this._dialog = { kind: "list-scope-toggle", key, enabled: !list[key], impact: {}, list, settings: { [key]: !list[key] } };
      this._render();
      return;
    }
    const settings = Object.fromEntries(keys.map((name) => [name, list[name] !== false]));
    settings[key] = !settings[key];
    this._busy = true;
    this._error = "";
    try {
      const preview = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/lists/scope-impact`,
        list_id: list.id,
        ...settings,
      });
      this._dialog = {
        kind: "list-scope-toggle",
        key,
        enabled: settings[key],
        impact: preview.impact || {},
        list,
        settings,
      };
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _openItemDialog(record) {
    const list = this._findList(this._selectedListId);
    const categoryId = record?.category_id || this._matchCategoryId(record?.category, this._selectedListId) || "";
    const dueAt = record?.due_at || "";
    this._error = "";
    this._dialog = { kind: "item-editor", record, draft: {
      name: record?.name || "",
      description: record?.description || "", offer_only: record?.offer_only === true,
      quantity: record?.quantity ?? (list.list_type === "inventory" ? 0 : 1),
      category_id: categoryId,
      dynamic_category: categoryId ? "" : (record?.category || ""),
      due_date: dueAt ? dueAt.slice(0, 10) : "",
      due_time: dueAt.includes("T") ? dueAt.slice(11, 16) : "",
      recurrence_interval: record?.recurrence_interval ?? "",
      recurrence_unit: record?.recurrence_unit || "D",
      completed: record?.completed || false,
      label_ids: (record?.labels || []).map((label) => label.id),
      product_id: record?.product_id || null,
    } };
    this._render();
    this.shadowRoot.querySelector("[data-item-name]").focus();
  }

  _openProductDialog(record, { returnDialog = null } = {}) {
    this._error = "";
    const originalName = record?.original_name || record?.name || "";
    const parsedName = this._parseProductName(record?.name || "", record?.brand || "", record?.package_quantity || "");
    const categoryAssignments = record?.category_assignments || [];
    this._dialog = { kind: "product-editor", record, return_dialog: returnDialog, draft: {
      name: record?.name || "",
      base_name: parsedName.base_name,
      original_name: originalName,
      ean: record?.ean || "",
      brand: record?.brand || "",
      package_quantity: record?.package_quantity || "",
      global_category_id: categoryAssignments.find((item) => item.scope === "global")?.category_id || "",
      shopping_category_id: categoryAssignments.find((item) => item.scope === "list_type" && item.list_type === "shopping")?.category_id || "",
      inventory_category_id: categoryAssignments.find((item) => item.scope === "list_type" && item.list_type === "inventory")?.category_id || "",
      list_category_assignments: categoryAssignments.filter((item) => item.scope === "list").map((item) => ({ list_id: item.list_id, category_id: item.category_id })),
      image_url: record?.image_url || "",
      append_brand: record ? parsedName.append_brand : this._settings.append_brand_to_product_name,
      append_quantity: record ? parsedName.append_quantity : this._settings.append_quantity_to_product_name,
      ean_error: "",
      lookup_status: null,
      label_ids: (record?.labels || []).map((label) => label.id),
    } };
    this._render();
    this.shadowRoot.querySelector("[data-product-name]").focus();
  }

  _openImageDialog(record) {
    if (!record?.image_url) return;
    this._error = "";
    this._dialog = { kind: "image-viewer", record };
    this._render();
  }

  _openDynamicCategoryDialog() {
    if (this._dialog?.kind !== "item-editor") return;
    const name = this._dialog.draft.dynamic_category.trim();
    if (!this._canSaveDynamicCategory(name, this._selectedListId)) return;
    const returnDialog = this._dialog;
    this._openCategoryDialog(null, {
      name,
      scope: "list",
      list_id: this._selectedListId,
      return_dialog: returnDialog,
    });
  }

  async _lookupProduct() {
    if (this._busy || this._dialog?.kind !== "product-editor") return;
    const ean = String(this._dialog.draft.ean || "").trim();
    if (!/^\d{4,32}$/.test(ean)) {
      this._dialog.draft.ean_error = haListManagerPanelText("errors.ean_digits_required", {}, this._hass);
      this._dialog.draft.lookup_status = null;
      this._render();
      return;
    }
    this._busy = true;
    this._error = "";
    this._dialog.draft.lookup_status = null;
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/products/lookup`, ean, product_id: this._dialog.record?.id || null });
      if (result.duplicate && result.duplicate.id !== this._dialog.record?.id) {
        const duplicate = result.duplicate;
        this._dialog.record = duplicate;
        this._dialog.draft = {
          name: duplicate.name || "",
          base_name: this._parseProductName(duplicate.name || "", duplicate.brand || "", duplicate.package_quantity || "").base_name,
          original_name: duplicate.original_name || duplicate.name || "",
          ean: duplicate.ean || "",
          brand: duplicate.brand || "",
          package_quantity: duplicate.package_quantity || "",
          category: duplicate.category || "",
          image_url: duplicate.image_url || "",
          append_brand: this._parseProductName(duplicate.name || "", duplicate.brand || "", duplicate.package_quantity || "").append_brand,
          append_quantity: this._parseProductName(duplicate.name || "", duplicate.brand || "", duplicate.package_quantity || "").append_quantity,
          ean_error: haListManagerPanelText("products.existing_ean_opened", {}, this._hass),
          lookup_status: { type: "warning", text: haListManagerPanelText("ui.existing_product_opened", {}, this._hass) },
          label_ids: (duplicate.labels || []).map((label) => label.id),
        };
        return;
      }
      const product = result.product;
      if (!product) {
        this._dialog.draft.lookup_status = { type: "warning", text: haListManagerPanelText("products.ean_data_not_found", {}, this._hass) };
        return;
      }
      const draft = this._dialog.draft;
      draft.original_name = product.name || "";
      draft.ean = product.ean || ean;
      draft.brand = product.brand || "";
      draft.package_quantity = product.package_quantity || "";
      draft.image_url = product.image_url || "";
      draft.ean_error = "";
      if (!draft.name.trim()) {
        draft.base_name = product.name || "";
        this._applyProductNameOptions(false);
      }
      draft.lookup_status = { type: "success", text: haListManagerPanelText("products.loaded_unsaved", {}, this._hass) };
    } catch (error) {
      this._dialog.draft.lookup_status = error?.code === "product_not_found"
        ? { type: "warning", text: haListManagerPanelText("products.ean_data_not_found", {}, this._hass) }
        : { type: "error", text: this._formatError(error) };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _nameContains(name, value) {
    return Boolean(value && name && name.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  }

  _parseProductName(name, brand, quantity) {
    let baseName = String(name || "").trim();
    let appendQuantity = false;
    let appendBrand = false;
    const removeSuffix = (value) => {
      const suffix = value ? ` – ${String(value).trim()}` : "";
      if (suffix && baseName.endsWith(suffix)) {
        baseName = baseName.slice(0, -suffix.length).trim();
        return true;
      }
      return false;
    };
    appendQuantity = removeSuffix(quantity);
    appendBrand = removeSuffix(brand);
    return { base_name: baseName, append_brand: appendBrand, append_quantity: appendQuantity };
  }

  _applyProductNameOptions(render = true) {
    const draft = this._dialog?.draft;
    if (!draft) return;
    let name = (draft.base_name || draft.name || draft.original_name || "").trim();
    if (draft.append_brand && draft.brand && !this._nameContains(name, draft.brand)) name += ` – ${draft.brand.trim()}`;
    if (draft.append_quantity && draft.package_quantity && !this._nameContains(name, draft.package_quantity)) name += ` – ${draft.package_quantity.trim()}`;
    draft.name = name;
    if (render) this._render();
  }

  _renderDataManagement() {
    const importing = this._dataManagementTab === "import";
    return `<div class="scan-history-tabs" role="tablist"><button type="button" role="tab" data-data-management-tab="backup" aria-selected="${!importing}" class="${importing ? "" : "active"}"><ha-icon icon="mdi:database-export-outline"></ha-icon>${haListManagerPanelText("legacy_import.backups_tab", {}, this._hass)}</button><button type="button" role="tab" data-data-management-tab="import" aria-selected="${importing}" class="${importing ? "active" : ""}"><ha-icon icon="mdi:database-import-outline"></ha-icon>${haListManagerPanelText("legacy_import.import_tab", {}, this._hass)}</button></div>${importing ? this._renderLegacyImport() : this._renderDataBackup()}`;
  }

  _bindDataManagementEvents() {
    this.shadowRoot.querySelectorAll("[data-data-management-tab]").forEach(button => {
      button.disabled = this._busy || this._legacyImport.busy;
      button.onclick = () => {
        if (this._busy || this._legacyImport.busy) return;
        this._dataManagementTab = button.dataset.dataManagementTab;
        this._render();
        if (this._dataManagementTab === "backup") this._loadDataBackupInfo();
      };
    });
  }

  _renderLegacyImportFeedback(target) {
    const state = this._legacyImport;
    if (state.feedbackTarget !== target) return "";
    return `${state.error ? `<p class="inline-error" role="alert">${this._escape(state.error)}</p>` : ""}${state.status ? `<p class="backup-notice${state.busy ? "" : " backup-success"}" role="status"><ha-icon icon="${state.busy ? "mdi:progress-clock" : "mdi:check-circle-outline"}"></ha-icon><span>${this._escape(state.status)}</span></p>` : ""}`;
  }

  _renderLegacyImportWarnings(warnings = []) {
    const notes = warnings.map(warning => typeof warning === "string" ? { message: warning } : warning).filter(warning => warning?.message);
    if (!notes.length) return "";
    const order = ["review", "security", "inventory", "backend", "appearance", "adjusted", "excluded", "unmapped"];
    const groups = new Map();
    for (const warning of notes.slice(0, 100)) {
      const group = order.includes(warning.group) ? warning.group : "unmapped";
      if (!groups.has(group)) groups.set(group, { count: 0, reasons: new Map() });
      const section = groups.get(group), key = `${warning.reason || warning.code || "note"}\n${warning.message}`;
      section.count++;
      if (!section.reasons.has(key)) section.reasons.set(key, { message: warning.message, affected: new Map() });
      const reason = section.reasons.get(key);
      let source = warning.source_name || warning.source || "";
      const legacyCard = /^card-(\d+)$/.exec(source);
      if (legacyCard) source = haListManagerPanelText("legacy_import.warning_card", { number: legacyCard[1] }, this._hass);
      if (source || warning.field) {
        if (!reason.affected.has(source)) reason.affected.set(source, new Set());
        if (warning.field) reason.affected.get(source).add(warning.field);
      }
    }
    return `<details class="legacy-import-notes" open><summary>${haListManagerPanelText("legacy_import.warnings", {}, this._hass)} (${notes.length})</summary>${order.filter(group => groups.has(group)).map(group => {
      const section = groups.get(group);
      return `<details class="legacy-import-warning-group" data-legacy-warning-group="${group}"><summary>${haListManagerPanelText(`legacy_import.warning_group_${group}`, {}, this._hass)} (${section.count})</summary>${[...section.reasons.values()].map(reason => `<div class="legacy-import-warning-reason"><p>${this._escape(reason.message)}</p>${reason.affected.size ? `<ul>${[...reason.affected].map(([source, fields]) => `<li>${source ? `<strong>${this._escape(source)}</strong>` : ""}${fields.size ? `${source ? ": " : ""}<code>${this._escape([...fields].join(", "))}</code>` : ""}</li>`).join("")}</ul>` : ""}</div>`).join("")}</details>`;
    }).join("")}${notes.length > 100 ? `<p class="field-help">${haListManagerPanelText("legacy_import.sample_limit", { shown: 100, total: notes.length }, this._hass)}</p>` : ""}</details>`;
  }

  _legacyImportListTypeLabel(listType, withEan = false) {
    return listType === "inventory" ? haListManagerPanelText(withEan ? "ui.inventory" : "legacy_import.inventory_simple", {}, this._hass) : LIST_TYPES(this._hass)[listType]?.label || listType;
  }

  _renderLegacyEanSource(selection, listType, index) {
    return `<div data-legacy-ean-section="${index}" ${listType === "inventory" ? "" : "hidden"}><label class="setting-row"><input type="checkbox" data-legacy-ean-enable="${index}" ${selection.ean_enabled ? "checked" : ""}><span>${haListManagerPanelText("legacy_import.ean_enable", {}, this._hass)}</span></label><div data-legacy-ean-source-wrapper="${index}" ${selection.ean_enabled ? "" : "hidden"}><ha-selector data-legacy-ean-source="${index}"></ha-selector></div><p class="field-help">${haListManagerPanelText("legacy_import.ean_help", {}, this._hass)}</p></div>`;
  }

  _renderLegacyEanProducts(data) {
    const products = data.ean_products || [], counts = data.ean_counts;
    if (!counts) return "";
    return `<section class="legacy-import-preview-list"><h4>${haListManagerPanelText("legacy_import.ean_products", {}, this._hass)}</h4><p>${haListManagerPanelText("legacy_import.ean_counts", counts, this._hass)}</p><p class="field-help">${haListManagerPanelText("legacy_import.ean_help", {}, this._hass)}</p><details><summary>${haListManagerPanelText("ui.products", {}, this._hass)} (${counts.total})</summary><div class="legacy-import-item-list">${products.slice(0, 20).map(product => `<div><strong>${this._escape(product.name)}</strong><small>${this._escape([product.ean, product.brand, product.package_quantity].filter(Boolean).join(" · "))} · ${haListManagerPanelText(product.existing ? "legacy_import.ean_existing" : "legacy_import.ean_new", {}, this._hass)}</small></div>`).join("")}${counts.total > products.length || products.length > 20 ? `<p class="field-help">${haListManagerPanelText("legacy_import.sample_limit", { shown: Math.min(20, products.length), total: counts.total }, this._hass)}</p>` : ""}</div></details></section>`;
  }

  _renderLegacyEanConflicts(list) {
    const conflicts = list.ean_conflicts || [];
    if (!conflicts.length) return "";
    return `<div class="legacy-import-ean-conflicts"><h4>${haListManagerPanelText("legacy_import.ean_conflicts", {}, this._hass)}</h4><p class="field-help">${haListManagerPanelText("legacy_import.ean_conflicts_help", {}, this._hass)}</p>${conflicts.map(conflict => `<label class="field"><span>${this._escape(conflict.name)} · ${haListManagerPanelText("legacy_import.inventory_stock", { stock: conflict.stock }, this._hass)}</span><select data-legacy-ean-choice="${this._escape(conflict.source_uid)}" data-legacy-ean-list="${this._escape(list.source_entity || "")}"><option value="" ${!conflict.selected ? "selected" : ""}>${haListManagerPanelText("legacy_import.ean_choose", {}, this._hass)}</option><option value="generic" ${conflict.selected === "generic" ? "selected" : ""}>${haListManagerPanelText("legacy_import.ean_keep_generic", {}, this._hass)}</option>${(conflict.candidates || []).map(product => `<option value="${this._escape(product.ean)}" ${conflict.selected === product.ean ? "selected" : ""}>${this._escape([product.name, product.brand, product.package_quantity, product.ean].filter(Boolean).join(" · "))}</option>`).join("")}</select></label>`).join("")}${list.ean_conflicts_total > conflicts.length ? `<p class="field-help">${haListManagerPanelText("legacy_import.sample_limit", { shown: conflicts.length, total: list.ean_conflicts_total }, this._hass)}</p>` : ""}</div>`;
  }

  _renderLegacyImportSources() {
    const state = this._legacyImport;
    if (!state.draft || state.result) return "";
    const cards = state.draft.cards || [];
    return `<ha-card class="settings-card"><h3>${haListManagerPanelText("legacy_import.sources_title", {}, this._hass)}</h3><label class="field"><span>${haListManagerPanelText("legacy_import.data_mode", {}, this._hass)}</span><select data-legacy-import-items><option value="true" ${state.includeItems ? "selected" : ""}>${haListManagerPanelText("legacy_import.with_entries", {}, this._hass)}</option><option value="false" ${state.includeItems ? "" : "selected"}>${haListManagerPanelText("legacy_import.without_entries", {}, this._hass)}</option></select></label><p class="field-help" data-legacy-source-help>${haListManagerPanelText(state.includeItems ? "legacy_import.sources_help" : "legacy_import.no_entries_help", {}, this._hass)}</p>${cards.map((card, index) => {
      const selection = state.selections[index] || {};
      const listType = selection.list_type || card.mode;
      return `<section class="legacy-import-source"><h4>${this._escape(card.title || selection.target_name)} <small data-legacy-type-caption="${index}">${this._escape(this._legacyImportListTypeLabel(listType, selection.ean_enabled))}</small></h4>${card.mode === "shopping" ? `<label class="field legacy-import-type-field"><span>${haListManagerPanelText("legacy_import.import_list_type", {}, this._hass)}</span><select data-legacy-list-type="${index}"><option value="shopping" ${listType === "shopping" ? "selected" : ""}>${this._escape(this._legacyImportListTypeLabel("shopping"))}</option><option value="inventory" ${listType === "inventory" ? "selected" : ""}>${haListManagerPanelText("legacy_import.inventory_simple", {}, this._hass)}</option></select></label>` : ""}<p class="field-help" data-legacy-inventory-help="${index}" ${listType === "inventory" && state.includeItems ? "" : "hidden"}>${haListManagerPanelText(selection.ean_enabled ? "legacy_import.inventory_ean_help" : "legacy_import.inventory_help", {}, this._hass)}</p>${this._renderLegacyEanSource(selection, listType, index)}<div class="field-grid" data-legacy-source-fields data-no-source="${!state.includeItems}"><div data-legacy-source-wrapper ${state.includeItems ? "" : "hidden"}><ha-selector data-legacy-source="${index}"></ha-selector></div><label class="field"><span>${haListManagerPanelText("legacy_import.new_list_name", {}, this._hass)}</span><input type="text" required maxlength="200" data-legacy-target-name="${index}" value="${this._escape(selection.target_name)}"></label></div><div data-legacy-draft-warnings ${state.plan ? "hidden" : ""}>${this._renderLegacyImportWarnings(card.warnings)}</div></section>`;
    }).join("")}<div data-legacy-draft-warnings ${state.plan ? "hidden" : ""}>${this._renderLegacyImportWarnings(state.draft.warnings)}</div><p class="field-help">${haListManagerPanelText("legacy_import.expires_help", {}, this._hass)}</p><div data-legacy-feedback="sources">${this._renderLegacyImportFeedback("sources")}</div><div class="settings-inline-actions"><button class="ha-button primary" type="button" data-legacy-preview ${state.busy || !this._legacyImportSourcesValid() ? "disabled" : ""}><ha-icon icon="mdi:clipboard-text-search-outline"></ha-icon>${state.operation === "preview" ? haListManagerPanelText("legacy_import.previewing", {}, this._hass) : haListManagerPanelText("legacy_import.preview", {}, this._hass)}</button><button class="ha-button" type="button" data-legacy-reset ${state.busy ? "disabled" : ""}>${haListManagerPanelText("legacy_import.reset", {}, this._hass)}</button></div></ha-card>`;
  }

  _legacyImportItemDetails(item, listType) {
    if (listType === "inventory") {
      const parts = [haListManagerPanelText("legacy_import.inventory_stock", { stock: item.stock ?? item.quantity ?? 0 }, this._hass), item.category, item.product_ean];
      if (item.merged_count > 1) parts.push(haListManagerPanelText("legacy_import.inventory_merged", { count: item.merged_count }, this._hass));
      if (item.hidden) parts.push(haListManagerPanelText("legacy_import.inventory_hidden", {}, this._hass));
      return parts.filter(value => value !== null && value !== undefined && value !== "").join(" · ");
    }
    const parts = [listType === "shopping" ? item.quantity : null, item.category];
    if (item.due_at) {
      const value = String(item.due_at), dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
      const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
      const options = { dateStyle: "medium", ...(dateOnly ? { timeZone: "UTC" } : value.includes("T") ? { timeStyle: "short" } : {}) };
      parts.push(Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(haListManagerPanelTextLocale(this._hass), options).format(date));
    }
    const unit = { H: "hours", D: "days", M: "months" }[item.recurrence_unit];
    if (item.recurrence_interval > 0 && unit) parts.push(haListManagerPanelText("ui.every_interval", { p0: item.recurrence_interval, p1: haListManagerPanelText(`ui.${unit}`, {}, this._hass) }, this._hass));
    if (item.completed) parts.push(haListManagerPanelText("ui.completed", {}, this._hass));
    return parts.filter(value => value !== null && value !== undefined && value !== "").join(" · ");
  }

  _renderLegacyImportPreview() {
    const state = this._legacyImport;
    if (!state.plan || state.result) return "";
    const sample = (values, total, render) => `${values.slice(0, 20).map(render).join("")}${total > 20 ? `<p class="field-help">${haListManagerPanelText("legacy_import.sample_limit", { shown: Math.min(20, values.length), total }, this._hass)}</p>` : ""}`;
    return `<ha-card class="settings-card"><h3>${haListManagerPanelText("legacy_import.preview_title", {}, this._hass)}</h3>${(state.plan.lists || []).map(list => {
      const categories = list.categories || [], chips = list.chips || [], items = list.items || [];
      const inventory = list.list_type === "inventory", withItems = list.include_items !== false && state.plan.include_items !== false;
      const counts = { items: items.length, completed: items.filter(item => item.completed).length, categories: categories.length, chips: chips.length, products: inventory ? items.length : 0, hidden: items.filter(item => item.hidden).length, ...list.counts };
      return `<section class="legacy-import-preview-list"><h4>${this._escape(list.name)}</h4><p class="field-help">${this._escape(this._legacyImportListTypeLabel(list.list_type, list.ean_enabled))} · ${this._escape(withItems ? list.source_entity : haListManagerPanelText("legacy_import.no_entries_preview", {}, this._hass))}</p><p>${haListManagerPanelText(inventory ? "legacy_import.inventory_counts" : "legacy_import.counts", counts, this._hass)}</p>${inventory && withItems ? `<p class="field-help">${haListManagerPanelText(list.ean_enabled ? "legacy_import.inventory_ean_help" : "legacy_import.inventory_help", {}, this._hass)}</p>` : ""}${this._renderLegacyEanConflicts(list)}<details><summary>${haListManagerPanelText("ui.categories", {}, this._hass)} (${counts.categories})</summary><div class="legacy-import-definitions">${sample(categories, counts.categories, category => {
        const color = /^#[0-9a-f]{6}$/i.test(category.color || "") ? category.color : "";
        return `<div class="legacy-import-category"><span class="legacy-import-color"${color ? ` style="--import-color:${color}"` : ""}><ha-icon icon="${this._escape(category.icon || "mdi:shape-outline")}"></ha-icon></span><span><strong>${this._escape(category.name)}</strong><small>${haListManagerPanelText("legacy_import.category_rules", { count: (category.rules || []).length }, this._hass)}${color ? ` · ${color}` : ""}</small></span></div>`;
      })}</div></details><details><summary>${haListManagerPanelText("ui.chips_and_templates", {}, this._hass)} (${counts.chips})</summary><div class="legacy-import-chip-list">${sample(chips, counts.chips, chip => `<span>${this._escape(chip.name)}</span>`)}</div></details><details><summary>${haListManagerPanelText("ui.entries", {}, this._hass)} (${counts.items})</summary><div class="legacy-import-item-list">${sample(items, counts.items, item => `<div><strong>${this._escape(item.name)}</strong><small>${this._escape(this._legacyImportItemDetails(item, list.list_type))}</small></div>`)}</div></details></section>`;
    }).join("")}${this._renderLegacyEanProducts(state.plan)}${this._renderLegacyImportWarnings(state.plan.warnings)}${(state.plan.lists || []).some(list => list.ean_conflicts?.length) ? `<div class="settings-inline-actions"><button class="ha-button" type="button" data-legacy-ean-recheck ${state.busy || !this._legacyImportSourcesValid() ? "disabled" : ""}><ha-icon icon="mdi:clipboard-check-outline"></ha-icon>${haListManagerPanelText("legacy_import.ean_recheck", {}, this._hass)}</button></div>` : ""}<p class="field-help">${haListManagerPanelText("legacy_import.apply_help", {}, this._hass)}</p><label class="setting-row"><input type="checkbox" data-legacy-confirm ${state.confirmed ? "checked" : ""} ${state.busy || !state.plan.can_import ? "disabled" : ""}><span>${haListManagerPanelText("legacy_import.confirm", {}, this._hass)}</span></label><div data-legacy-feedback="preview">${this._renderLegacyImportFeedback("preview")}</div><div class="settings-inline-actions"><button class="ha-button primary" type="button" data-legacy-apply ${state.busy || !state.confirmed || !state.plan.can_import ? "disabled" : ""}><ha-icon icon="mdi:database-import-outline"></ha-icon>${state.operation === "apply" ? haListManagerPanelText("legacy_import.applying", {}, this._hass) : haListManagerPanelText("legacy_import.apply", {}, this._hass)}</button></div></ha-card>`;
  }

  _renderLegacyImportResult() {
    const state = this._legacyImport, result = state.result;
    if (!result) return "";
    const yaml = Array.isArray(result.cards_yaml) ? result.cards_yaml.join("\n---\n") : String(result.cards_yaml || "");
    return `<ha-card class="settings-card"><h3>${haListManagerPanelText("legacy_import.result_title", {}, this._hass)}</h3><p>${haListManagerPanelText("legacy_import.created_lists", { count: (result.lists || []).length }, this._hass)}</p><div class="legacy-import-results">${(result.lists || []).map(list => `<div><strong>${this._escape(list.name)}</strong><button class="ha-button" type="button" data-legacy-open-list="${this._escape(list.list_id || list.id)}">${haListManagerPanelText("legacy_import.list_created", {}, this._hass)}</button></div>`).join("")}</div>${result.ean_counts ? `<p>${haListManagerPanelText("legacy_import.ean_result", result.ean_counts, this._hass)}</p>` : ""}${result.backup?.name ? `<p class="field-help">${this._escape(haListManagerPanelText("legacy_import.backup_created", { name: result.backup.name }, this._hass))}</p>` : ""}<p>${haListManagerPanelText("legacy_import.result_help", {}, this._hass)}</p><label class="field"><span>${haListManagerPanelText("legacy_import.card_yaml", {}, this._hass)}</span><textarea readonly rows="12" class="legacy-import-yaml" data-legacy-result-yaml>${this._escape(yaml)}</textarea></label><div data-legacy-feedback="result">${this._renderLegacyImportFeedback("result")}</div><div class="settings-inline-actions"><button class="ha-button primary" type="button" data-legacy-copy><ha-icon icon="mdi:content-copy"></ha-icon>${haListManagerPanelText("legacy_import.copy_yaml", {}, this._hass)}</button><button class="ha-button" type="button" data-legacy-reset>${haListManagerPanelText("legacy_import.new_import", {}, this._hass)}</button></div></ha-card>`;
  }

  _renderLegacyImport() {
    const state = this._legacyImport;
    return `<div data-legacy-import-view><section class="content-header"><div><h2>${haListManagerPanelText("legacy_import.import_tab", {}, this._hass)}</h2><p>${haListManagerPanelText("legacy_import.intro", {}, this._hass)}</p></div></section><p class="field-help">${haListManagerPanelText("legacy_import.scope_help", {}, this._hass)}</p><ha-card class="settings-card" data-legacy-input-block ${state.draft || state.result ? "hidden" : ""}><label class="field"><span>${haListManagerPanelText("legacy_import.yaml_label", {}, this._hass)}</span><textarea rows="12" maxlength="262144" class="legacy-import-yaml" data-legacy-yaml spellcheck="false" autocomplete="off" autocapitalize="off"></textarea><small>${haListManagerPanelText("legacy_import.yaml_help", {}, this._hass)}</small></label><div class="settings-inline-actions"><button class="ha-button" type="button" data-legacy-select-yaml><ha-icon icon="mdi:file-upload-outline"></ha-icon>${haListManagerPanelText("legacy_import.upload_yaml", {}, this._hass)}</button><input hidden type="file" accept=".yaml,.yml,text/yaml,application/yaml" data-legacy-yaml-file></div><h4>${haListManagerPanelText("legacy_import.files_label", {}, this._hass)}</h4><p class="field-help">${haListManagerPanelText("legacy_import.files_help", {}, this._hass)}</p><div data-legacy-files>${this._renderLegacyImportFiles()}</div><button class="ha-button" type="button" data-legacy-select-files><ha-icon icon="mdi:file-upload-outline"></ha-icon>${haListManagerPanelText("legacy_import.upload_files", {}, this._hass)}</button><input hidden type="file" multiple accept=".txt,.ini,.yaml,.yml,text/plain" data-legacy-files-input><p class="field-help">${haListManagerPanelText("legacy_import.credentials_help", {}, this._hass)}</p><div data-legacy-feedback="input">${this._renderLegacyImportFeedback("input")}</div><div class="settings-inline-actions"><button class="ha-button primary" type="button" data-legacy-analyze ${state.busy ? "disabled" : ""}><ha-icon icon="mdi:clipboard-check-outline"></ha-icon>${state.operation === "analyze" ? haListManagerPanelText("legacy_import.analyzing", {}, this._hass) : haListManagerPanelText("legacy_import.analyze", {}, this._hass)}</button></div></ha-card><div data-legacy-sources-block data-key="${this._escape(state.draft?.draft_id || "")}">${this._renderLegacyImportSources()}</div><div data-legacy-preview-block data-key="${this._escape(state.plan?.plan_id || "")}">${this._renderLegacyImportPreview()}</div><div data-legacy-result-block data-key="${this._escape(state.result ? "complete" : "")}">${this._renderLegacyImportResult()}</div></div>`;
  }

  _renderLegacyImportFiles() {
    return this._legacyImport.files.map((file, index) => `<div class="legacy-import-file"><span>${this._escape(file.name)}</span><button class="icon-button danger" type="button" data-legacy-remove-file="${index}" title="${haListManagerPanelText("ui.delete", {}, this._hass)}"><ha-icon icon="mdi:close"></ha-icon></button></div>`).join("");
  }

  _legacyImportSourcesValid() {
    const state = this._legacyImport;
    return state.selections.length > 0 && state.selections.every((selection, index) => {
      const originalType = state.draft?.cards?.[index]?.mode, listType = selection.list_type || originalType;
      const validType = ["shopping", "todo", "inventory"].includes(listType) && (listType === originalType || originalType === "shopping" && listType === "inventory");
      return validType && (!state.includeItems || /^todo\.[a-z0-9_]+$/i.test(selection.entity_id || "")) && (listType !== "inventory" || !selection.ean_enabled || /^todo\.[a-z0-9_]+$/i.test(selection.ean_entity_id || "") && selection.ean_entity_id !== selection.entity_id) && String(selection.target_name || "").trim();
    });
  }

  _updateLegacyImport() {
    // Keep editable source rows and the YAML textarea mounted while HA refreshes.
    const state = this._legacyImport;
    const slots = [
      ["[data-legacy-sources-block]", state.draft?.draft_id || "", () => this._renderLegacyImportSources()],
      ["[data-legacy-preview-block]", state.plan?.plan_id || "", () => this._renderLegacyImportPreview()],
      ["[data-legacy-result-block]", state.result ? "complete" : "", () => this._renderLegacyImportResult()],
    ];
    for (const [selector, key, render] of slots) {
      const node = this.shadowRoot.querySelector(selector);
      if (node && node.dataset.key !== String(key)) { node.innerHTML = render(); node.dataset.key = String(key); }
    }
    const inputBlock = this.shadowRoot.querySelector("[data-legacy-input-block]");
    if (inputBlock) inputBlock.hidden = Boolean(state.draft || state.result);
    this.shadowRoot.querySelectorAll("[data-legacy-draft-warnings]").forEach(node => { node.hidden = Boolean(state.plan); });
    const fileList = this.shadowRoot.querySelector("[data-legacy-files]");
    const fileMarkup = this._renderLegacyImportFiles();
    if (fileList && fileList.innerHTML !== fileMarkup) fileList.innerHTML = fileMarkup;
    this.shadowRoot.querySelectorAll("[data-legacy-feedback]").forEach(node => {
      const markup = this._renderLegacyImportFeedback(node.dataset.legacyFeedback);
      if (node.innerHTML !== markup) node.innerHTML = markup;
    });
    this.shadowRoot.querySelectorAll("[data-legacy-import-view] button, [data-legacy-import-view] input, [data-legacy-import-view] textarea, [data-legacy-import-view] select, [data-legacy-import-view] ha-selector").forEach(control => { control.disabled = state.busy; });
    this.shadowRoot.querySelectorAll("[data-legacy-source-wrapper]").forEach(wrapper => { wrapper.hidden = !state.includeItems; });
    this.shadowRoot.querySelectorAll("[data-legacy-source-fields]").forEach(row => { row.dataset.noSource = String(!state.includeItems); });
    this.shadowRoot.querySelectorAll("[data-legacy-list-type]").forEach(select => {
      const index = Number(select.dataset.legacyListType), listType = state.selections[index]?.list_type || state.draft?.cards?.[index]?.mode;
      if (select.value !== listType) select.value = listType;
    });
    this.shadowRoot.querySelectorAll("[data-legacy-type-caption]").forEach(caption => {
      const index = Number(caption.dataset.legacyTypeCaption), listType = state.selections[index]?.list_type || state.draft?.cards?.[index]?.mode;
      caption.textContent = this._legacyImportListTypeLabel(listType, state.selections[index]?.ean_enabled);
    });
    this.shadowRoot.querySelectorAll("[data-legacy-inventory-help]").forEach(help => {
      const index = Number(help.dataset.legacyInventoryHelp), listType = state.selections[index]?.list_type || state.draft?.cards?.[index]?.mode;
      help.hidden = listType !== "inventory" || !state.includeItems;
      help.textContent = haListManagerPanelText(state.selections[index]?.ean_enabled ? "legacy_import.inventory_ean_help" : "legacy_import.inventory_help", {}, this._hass);
    });
    this.shadowRoot.querySelectorAll("[data-legacy-ean-section]").forEach(section => {
      const index = Number(section.dataset.legacyEanSection);
      section.hidden = (state.selections[index]?.list_type || state.draft?.cards?.[index]?.mode) !== "inventory";
    });
    this.shadowRoot.querySelectorAll("[data-legacy-ean-enable]").forEach(input => {
      const index = Number(input.dataset.legacyEanEnable);
      input.checked = Boolean(state.selections[index]?.ean_enabled);
    });
    this.shadowRoot.querySelectorAll("[data-legacy-ean-source-wrapper]").forEach(wrapper => {
      wrapper.hidden = !state.selections[Number(wrapper.dataset.legacyEanSourceWrapper)]?.ean_enabled;
    });
    const mode = this.shadowRoot.querySelector("[data-legacy-import-items]");
    if (mode) mode.value = String(state.includeItems);
    const sourceHelp = this.shadowRoot.querySelector("[data-legacy-source-help]");
    if (sourceHelp) sourceHelp.textContent = haListManagerPanelText(state.includeItems ? "legacy_import.sources_help" : "legacy_import.no_entries_help", {}, this._hass);
    const preview = this.shadowRoot.querySelector("[data-legacy-preview]");
    if (preview) preview.disabled = state.busy || !this._legacyImportSourcesValid();
    const confirmation = this.shadowRoot.querySelector("[data-legacy-confirm]");
    if (confirmation) { confirmation.checked = state.confirmed; confirmation.disabled = state.busy || !state.plan?.can_import; }
    const apply = this.shadowRoot.querySelector("[data-legacy-apply]");
    if (apply) apply.disabled = state.busy || !state.confirmed || !state.plan?.can_import;
    for (const [selector, key, pending] of [["[data-legacy-analyze]", "analyze", "analyzing"], ["[data-legacy-preview]", "preview", "previewing"], ["[data-legacy-apply]", "apply", "applying"]]) {
      const button = this.shadowRoot.querySelector(selector);
      if (button?.lastChild?.nodeType === 3) button.lastChild.textContent = haListManagerPanelText(`legacy_import.${state.operation === key ? pending : key}`, {}, this._hass);
    }
    this._bindDataManagementEvents();
    this._bindLegacyImportEvents();
    this._updateDataManagementFavorite();
  }

  _setLegacyImportItems(includeItems) {
    const state = this._legacyImport;
    if (state.busy || state.includeItems === includeItems) return;
    state.includeItems = includeItems;
    this._invalidateLegacyImportPreview();
  }

  _setLegacyImportListType(index, listType) {
    const state = this._legacyImport, card = state.draft?.cards?.[index], selection = state.selections[index];
    if (state.busy || !selection || card?.mode !== "shopping" || !["shopping", "inventory"].includes(listType) || (selection.list_type || card.mode) === listType) return;
    selection.list_type = listType;
    this._invalidateLegacyImportPreview();
  }

  _invalidateLegacyImportPreview() {
    const state = this._legacyImport;
    state.plan = null; state.confirmed = false; state.error = ""; state.status = "";
    this._updateLegacyImport();
  }

  _bindLegacyImportEvents() {
    if (!this.shadowRoot.querySelector("[data-legacy-import-view]")) return;
    const state = this._legacyImport;
    const click = (selector, handler) => { const button = this.shadowRoot.querySelector(selector); if (button) button.onclick = handler; };
    click("[data-legacy-select-yaml]", () => this.shadowRoot.querySelector("[data-legacy-yaml-file]")?.click());
    click("[data-legacy-select-files]", () => this.shadowRoot.querySelector("[data-legacy-files-input]")?.click());
    click("[data-legacy-analyze]", () => this._analyzeLegacyImport());
    click("[data-legacy-preview]", () => this._previewLegacyImport());
    click("[data-legacy-ean-recheck]", () => this._previewLegacyImport());
    click("[data-legacy-apply]", () => this._applyLegacyImport());
    click("[data-legacy-copy]", () => this._copyLegacyImportYaml());
    this.shadowRoot.querySelectorAll("[data-legacy-reset]").forEach(button => { button.onclick = () => this._resetLegacyImport(); });
    this.shadowRoot.querySelectorAll("[data-legacy-remove-file]").forEach(button => { button.onclick = () => { if (!state.busy) { state.files.splice(Number(button.dataset.legacyRemoveFile), 1); this._updateLegacyImport(); } }; });
    for (const [selector, yaml] of [["[data-legacy-yaml-file]", true], ["[data-legacy-files-input]", false]]) {
      const input = this.shadowRoot.querySelector(selector);
      if (input) input.onchange = event => { const files = [...(event.target.files || [])]; event.target.value = ""; this._readLegacyImportFiles(files, yaml); };
    }
    this.shadowRoot.querySelectorAll("[data-legacy-target-name]").forEach(input => {
      input.oninput = () => { state.selections[Number(input.dataset.legacyTargetName)].target_name = input.value; this._invalidateLegacyImportPreview(); };
    });
    const mode = this.shadowRoot.querySelector("[data-legacy-import-items]");
    if (mode) mode.onchange = () => this._setLegacyImportItems(mode.value === "true");
    this.shadowRoot.querySelectorAll("[data-legacy-list-type]").forEach(select => {
      select.onchange = () => this._setLegacyImportListType(Number(select.dataset.legacyListType), select.value);
    });
    this.shadowRoot.querySelectorAll("[data-legacy-source]").forEach(picker => {
      const index = Number(picker.dataset.legacySource);
      picker.hass = this._hass;
      picker.label = haListManagerPanelText("legacy_import.source_entity", {}, this._hass);
      picker.required = state.includeItems;
      picker.disabled = state.busy || !state.includeItems;
      picker.selector = { entity: { filter: { domain: "todo" } } };
      if (picker.value !== state.selections[index]?.entity_id) picker.value = state.selections[index]?.entity_id || undefined;
      if (!this._legacyImportPickers.has(picker)) {
        this._legacyImportPickers.add(picker);
        picker.addEventListener("value-changed", event => {
          if (state.busy) return;
          state.selections[index].entity_id = event.detail?.value || "";
          state.selections[index].ean_choices = {};
          this._invalidateLegacyImportPreview();
        });
      }
    });
    this.shadowRoot.querySelectorAll("[data-legacy-ean-enable]").forEach(input => {
      input.onchange = () => {
        if (state.busy) return;
        const selection = state.selections[Number(input.dataset.legacyEanEnable)];
        selection.ean_enabled = input.checked;
        selection.ean_choices = {};
        this._invalidateLegacyImportPreview();
      };
    });
    this.shadowRoot.querySelectorAll("[data-legacy-ean-source]").forEach(picker => {
      const index = Number(picker.dataset.legacyEanSource), selection = state.selections[index];
      const enabled = selection?.ean_enabled && (selection.list_type || state.draft?.cards?.[index]?.mode) === "inventory";
      picker.hass = this._hass;
      picker.label = haListManagerPanelText("legacy_import.ean_source", {}, this._hass);
      picker.required = Boolean(enabled);
      picker.disabled = state.busy || !enabled;
      picker.selector = { entity: { filter: { domain: "todo" } } };
      if (picker.value !== selection?.ean_entity_id) picker.value = selection?.ean_entity_id || undefined;
      if (!this._legacyImportPickers.has(picker)) {
        this._legacyImportPickers.add(picker);
        picker.addEventListener("value-changed", event => {
          if (state.busy) return;
          selection.ean_entity_id = event.detail?.value || "";
          selection.ean_choices = {};
          this._invalidateLegacyImportPreview();
        });
      }
    });
    this.shadowRoot.querySelectorAll("[data-legacy-ean-choice]").forEach(select => {
      select.onchange = () => {
        if (state.busy || !state.plan) return;
        for (const selection of state.selections) {
          if (selection.entity_id !== select.dataset.legacyEanList) continue;
          selection.ean_choices ||= {};
          if (select.value) selection.ean_choices[select.dataset.legacyEanChoice] = select.value;
          else delete selection.ean_choices[select.dataset.legacyEanChoice];
        }
        state.confirmed = false; state.plan.can_import = false;
        state.feedbackTarget = "preview"; state.error = "";
        state.status = haListManagerPanelText("legacy_import.ean_choice_pending", {}, this._hass);
        // Keep every conflict select mounted while the remaining choices are made.
        this._updateLegacyImport();
      };
    });
    const confirmation = this.shadowRoot.querySelector("[data-legacy-confirm]");
    if (confirmation) confirmation.onchange = () => { state.confirmed = confirmation.checked; const apply = this.shadowRoot.querySelector("[data-legacy-apply]"); if (apply) apply.disabled = state.busy || !state.confirmed || !state.plan?.can_import; };
    this.shadowRoot.querySelectorAll("[data-legacy-open-list]").forEach(button => { button.onclick = () => {
      this._activeSection = "lists";
      this._selectedListId = button.dataset.legacyOpenList;
      this._items = [];
      this._listItemSearch = "";
      this._listDetailTab = "overview";
      this._listAssignmentGroups = [];
      const list = this._findList(this._selectedListId);
      if (list?.list_type === "inventory") {
        this._selectedInventoryListId = list.id;
        this._inventoryEntries = [];
        this._inventoryGroups = [];
        this._loadInventory();
      } else {
        this._loadItems();
        this._loadListAssignments(this._selectedListId);
      }
      this._loadDashboardUsages();
    }; });
  }

  async _readLegacyImportFiles(files, yaml) {
    const state = this._legacyImport;
    if (state.busy || !files.length) return;
    state.feedbackTarget = "input"; state.error = ""; state.status = "";
    if (files.some(file => file.size > 256 * 1024)) { state.error = haListManagerPanelText("legacy_import.file_too_large", { maximum: 256 }, this._hass); this._updateLegacyImport(); return; }
    if (!yaml && state.files.length + files.length > 20) { state.error = haListManagerPanelText("legacy_import.files_too_many", { maximum: 20 }, this._hass); this._updateLegacyImport(); return; }
    if (!yaml && new Set([...state.files, ...files].map(file => file.name)).size !== state.files.length + files.length) { state.error = haListManagerPanelText("legacy_import.duplicate_file", {}, this._hass); this._updateLegacyImport(); return; }
    state.busy = true; this._updateLegacyImport();
    try {
      if (yaml) {
        const text = await files[0].text();
        const textarea = this.shadowRoot.querySelector("[data-legacy-yaml]");
        if (textarea) textarea.value = text;
      } else {
        const loaded = await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() })));
        state.files.push(...loaded);
      }
    } catch (_error) { state.error = haListManagerPanelText("legacy_import.file_read_failed", {}, this._hass); }
    finally { state.busy = false; this._updateLegacyImport(); }
  }

  async _analyzeLegacyImport() {
    const state = this._legacyImport;
    if (state.busy) return;
    const input = this.shadowRoot.querySelector("[data-legacy-yaml]");
    const yaml = input?.value || "";
    state.feedbackTarget = "input"; state.error = ""; state.status = "";
    if (!yaml.trim()) { state.error = haListManagerPanelText("legacy_import.yaml_required", {}, this._hass); this._updateLegacyImport(); return; }
    if (new TextEncoder().encode(yaml).length > 256 * 1024) { state.error = haListManagerPanelText("legacy_import.file_too_large", { maximum: 256 }, this._hass); this._updateLegacyImport(); return; }
    const requestId = ++state.requestId;
    state.busy = true; state.operation = "analyze";
    const files = Object.fromEntries(state.files.map(file => [file.name, file.text]));
    // Keep credentials only in the submitted request, never in browser persistence.
    if (input) input.value = "";
    state.files = [];
    this._updateLegacyImport();
    try {
      const draft = await haListManagerPanelTextRequest(this._hass, { type: `${API}/legacy_import/analyze`, yaml, files });
      if (state.requestId !== requestId) return;
      state.draft = draft; state.plan = null; state.result = null; state.confirmed = false; state.includeItems = true;
      state.selections = (draft.cards || []).map(card => ({ card_id: card.id, entity_id: card.source_entity || "", list_type: card.mode, ean_enabled: false, ean_entity_id: card.ean_source_entity || "", ean_choices: {}, target_name: String(card.target_name || card.title || this._hass.states?.[card.source_entity]?.attributes?.friendly_name || card.source_entity || "").slice(0, 200) }));
    } catch (error) { if (state.requestId === requestId) state.error = this._formatError(error); }
    finally { if (state.requestId === requestId) { state.busy = false; state.operation = ""; this._updateLegacyImport(); } }
  }

  async _previewLegacyImport() {
    const state = this._legacyImport;
    if (state.busy || !state.draft || !this._legacyImportSourcesValid()) return;
    state.busy = true; state.operation = "preview"; state.error = ""; state.status = ""; state.feedbackTarget = "sources"; state.plan = null; state.confirmed = false;
    this._updateLegacyImport();
    try {
      state.plan = await haListManagerPanelTextRequest(this._hass, { type: `${API}/legacy_import/preview`, draft_id: state.draft.draft_id, include_items: state.includeItems, sources: state.selections.map((selection, index) => { const enabled = selection.ean_enabled && (selection.list_type || state.draft.cards[index]?.mode) === "inventory"; return { card_id: selection.card_id, entity_id: selection.entity_id, list_type: selection.list_type, target_name: selection.target_name.trim(), ean_entity_id: enabled ? selection.ean_entity_id : null, ean_choices: enabled ? { ...selection.ean_choices } : {} }; }) });
    } catch (error) { state.error = this._formatError(error); }
    finally { state.busy = false; state.operation = ""; this._updateLegacyImport(); }
  }

  async _applyLegacyImport() {
    const state = this._legacyImport;
    if (state.busy || !state.plan?.can_import || !state.confirmed || state.result) return;
    state.busy = true; state.operation = "apply"; state.error = ""; state.status = ""; state.feedbackTarget = "preview";
    this._updateLegacyImport();
    try {
      state.result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/legacy_import/apply`, plan_id: state.plan.plan_id, confirm: true });
      state.plan = null; state.draft = null; state.selections = []; state.confirmed = false;
      this._categoriesLoaded = false; this._chipsLoaded = false; this._productsLoaded = false;
      // Refresh navigation data after success; a refresh error must not turn a
      // completed import into an apparent failed import that invites a retry.
      const refreshed = await Promise.allSettled([
        haListManagerPanelTextRequest(this._hass, { type: `${API}/lists/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/categories/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/chips/list` }),
        haListManagerPanelTextRequest(this._hass, { type: `${API}/info` }),
      ]);
      if (refreshed[0].status === "fulfilled") this._lists = refreshed[0].value.lists || [];
      if (refreshed[1].status === "fulfilled") { this._categories = refreshed[1].value.categories || []; this._dynamicCategories = refreshed[1].value.dynamic || []; this._categoriesLoaded = true; }
      if (refreshed[2].status === "fulfilled") { this._chips = refreshed[2].value.chips || []; this._chipsLoaded = true; }
      if (refreshed[3].status === "fulfilled") this._info = refreshed[3].value;
    } catch (error) { state.error = this._formatError(error); }
    finally { state.busy = false; state.operation = ""; this._updateLegacyImport(); }
  }

  async _copyLegacyImportYaml() {
    const state = this._legacyImport, input = this.shadowRoot.querySelector("[data-legacy-result-yaml]");
    if (!input) return;
    const result = state.result;
    state.feedbackTarget = "result"; state.error = ""; state.status = "";
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(input.value); copied = true; }
      catch (_error) { /* Fall back to the selected textarea when access is denied. */ }
    }
    if (state.result !== result || this.shadowRoot.querySelector("[data-legacy-result-yaml]") !== input) return;
    if (!copied) {
      // Plain HTTP HA instances have no Clipboard API. Keep this fallback
      // synchronous on the button click so the browser still sees a user action.
      const previousFocus = this.shadowRoot.activeElement;
      input.focus({ preventScroll: true }); input.select();
      input.setSelectionRange?.(0, input.value.length);
      try { copied = document.execCommand?.("copy") === true; }
      catch (_error) { /* Leave the YAML selected for manual copying. */ }
      if (copied && previousFocus !== input) previousFocus?.focus({ preventScroll: true });
    }
    if (copied) state.status = haListManagerPanelText("legacy_import.copied", {}, this._hass);
    else state.error = haListManagerPanelText("legacy_import.copy_failed", {}, this._hass);
    this._updateLegacyImport();
  }

  _resetLegacyImport() {
    const state = this._legacyImport;
    if (state.busy) return;
    const input = this.shadowRoot.querySelector("[data-legacy-yaml]");
    if (input) input.value = "";
    Object.assign(state, { draft: null, plan: null, result: null, selections: [], files: [], includeItems: true, error: "", status: "", operation: "", feedbackTarget: "input", confirmed: false, requestId: state.requestId + 1 });
    this._updateLegacyImport();
  }

  _bindBackupEvents() {
    const click = (selector, handler) => {
      const button = this.shadowRoot.querySelector(selector);
      if (button) button.onclick = handler;
    };
    this.shadowRoot.querySelectorAll("[data-backup-download]").forEach(button => {button.onclick = () => this._downloadDataBackup(button.dataset.backupDownload);});
    this.shadowRoot.querySelectorAll("[data-backup-restore]").forEach(button => {button.onclick = () => this._openDataRestore(button.dataset.backupRestore);});
    this.shadowRoot.querySelectorAll("[data-backup-delete]").forEach(button => {button.onclick = () => this._openDataRestore(button.dataset.backupDelete, true);});
    click("[data-backup-create]", () => this._createDataBackup());
    click("[data-backup-refresh]", () => {this._beginBackupAction(); this._loadDataBackupInfo();});
    click("[data-backup-delete-confirm]", () => this._deleteDataBackup());
    click("[data-backup-select]", () => this.shadowRoot.querySelector("[data-backup-file]")?.click());
    click("[data-restore-data]", () => this._restoreDataBackup());
    click("[data-backup-reload]", () => window.location.reload());
    this.shadowRoot.querySelectorAll("[data-backup-dialog] [data-cancel-dialog]").forEach(button => {button.onclick = () => this._closeDialog();});
    const input = this.shadowRoot.querySelector("[data-backup-file]");
    if (input) input.onchange = event => {
      const file = event.target.files?.[0];
      event.target.value = "";
      this._prepareDataRestore(file);
    };
    const confirm = this.shadowRoot.querySelector("[data-restore-confirm]");
    if (confirm) confirm.onchange = event => {
      this._dialog.confirmed = event.target.checked;
      this.shadowRoot.querySelector("[data-restore-data]").disabled = !event.target.checked || this._busy;
    };
  }

  _updateDataBackup() {
    // Keep the page, focused action and unchanged archive rows mounted. Rebuilding
    // the shadow tree makes mobile HA lose its document scroll/focus anchor.
    const template = document.createElement("template");
    template.innerHTML = this._renderDataBackup();
    for (const selector of ["[data-backup-database-path]", "[data-backup-archive-path]"]) {
      const current = this.shadowRoot.querySelector(selector);
      const next = template.content.querySelector(selector);
      if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
    }
    const records = this.shadowRoot.querySelector("[data-backup-records]");
    const nextRecords = template.content.querySelector("[data-backup-records]");
    if (records.dataset.records !== nextRecords.dataset.records) {
      records.innerHTML = nextRecords.innerHTML;
      records.dataset.records = nextRecords.dataset.records;
    }
    for (const current of this.shadowRoot.querySelectorAll("[data-backup-feedback]")) {
      const next = template.content.querySelector(`[data-backup-feedback="${current.dataset.backupFeedback}"]`);
      if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
    }
    const dialog = this.shadowRoot.querySelector("[data-backup-dialog]");
    const dialogMarkup = this._renderDialog();
    if (dialog.innerHTML !== dialogMarkup) {
      dialog.innerHTML = dialogMarkup;
      this._bindDialogScrollGuard();
    }
    this._updateDataManagementFavorite();
    this.shadowRoot.querySelectorAll("[data-backup-view] button, [data-backup-dialog] button, [data-backup-file], [data-restore-confirm]").forEach(control => {control.disabled = this._busy;});
    const restore = this.shadowRoot.querySelector("[data-restore-data]");
    if (restore) restore.disabled = this._busy || !this._dialog?.confirmed;
    this._bindBackupEvents();
    this._bindDataManagementEvents();
    this._setPageScrollLocked(Boolean(this._dialog));
  }

  _updateDataManagementFavorite() {
    const favorite = this.shadowRoot.querySelector("[data-toggle-page-favorite]");
    if (favorite) {
      const target = this._currentFavoriteTarget();
      const active = this._favorites.some(entry => this._favoriteMatches(entry, target));
      const label = active ? haListManagerPanelText("ui.remove_favorite", {}, this._hass) : haListManagerPanelText("ui.add_favorite", {}, this._hass);
      favorite.classList.toggle("active", active);
      favorite.title = label; favorite.setAttribute("aria-label", label);
      favorite.querySelector("ha-icon").setAttribute("icon", `mdi:star${active ? "" : "-outline"}`);
      favorite.disabled = this._favoriteBusy;
    }
  }

  async _loadDataBackupInfo() {
    try { this._backupInfo = await this._backupRequest("info"); }
    catch (error) { this._error = this._formatError(error); }
    this._render();
  }

  _beginBackupAction(target = "controls") {
    this._backupFeedbackTarget = target;
    this._backupStatus = "";
    this._backupRemoved = null;
    this._error = "";
    if (this._backupDownload) URL.revokeObjectURL(this._backupDownload.url);
    this._backupDownload = null;
    this._backupRestored = false;
  }

  _renderDataBackupFeedback(target) {
    if ((this._backupFeedbackTarget || "controls") !== target) return "";
    return `${this._error ? this._inlineError() : ""}
      ${this._backupStatus ? `<p class="backup-notice${this._busy ? "" : " backup-success"}" role="status"><ha-icon icon="${this._busy ? "mdi:progress-clock" : "mdi:check-circle-outline"}"></ha-icon><span>${this._escape(this._backupStatus)}</span></p>` : ""}
      ${this._backupDownload ? `<a class="ha-button" href="${this._escape(this._backupDownload.url)}" download="${this._escape(this._backupDownload.name)}"><ha-icon icon="mdi:download-outline"></ha-icon>${haListManagerPanelText("backup.save_file", {}, this._hass)}</a>` : ""}
      ${this._backupRestored ? `<button class="ha-button" data-backup-reload>${haListManagerPanelText("backup.reload", {}, this._hass)}</button>` : ""}`.trim();
  }

  _renderDataBackup() {
    const records = this._backupInfo?.backups || [];
    const origins = {uploaded:haListManagerPanelText("backup.origin_uploaded", {}, this._hass),created:haListManagerPanelText("backup.origin_created", {}, this._hass),safety:haListManagerPanelText("backup.origin_safety", {}, this._hass),before_import:haListManagerPanelText("legacy_import.backup_origin", {}, this._hass)};
    const rows = records.map(record => `<article class="backup-record${record.origin === "safety" ? " backup-safety" : ""}"><div class="backup-record-heading"><ha-icon icon="${record.origin === "safety" ? "mdi:backup-restore" : record.origin === "uploaded" ? "mdi:upload-outline" : record.origin === "before_import" ? "mdi:database-clock-outline" : "mdi:database-check-outline"}"></ha-icon><strong>${this._escape(record.origin === "safety" ? haListManagerPanelText("backup.origin_safety", {}, this._hass) : record.name)}</strong></div>${record.origin === "safety" ? `<p class="field-help">${haListManagerPanelText("backup.safety_explanation", {}, this._hass)}</p>` : ""}<p class="field-help">${record.origin === "safety" ? "" : `<span class="backup-origin">${this._escape(origins[record.origin] || record.origin)}</span> · `}${haListManagerPanelText("backup.stored_at", {}, this._hass)} ${this._escape(this._formatScanTime(record.created_at))} · ${(Number(record.size || 0) / 1048576).toLocaleString(haListManagerPanelTextLocale(this._hass), {maximumFractionDigits:2})} MiB</p>
      <div class="settings-inline-actions"><button class="ha-button" data-backup-download="${this._escape(record.id)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:download-outline"></ha-icon>${haListManagerPanelText("backup.file_download", {}, this._hass)}</button><button class="ha-button" data-backup-restore="${this._escape(record.id)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:database-import-outline"></ha-icon>${haListManagerPanelText("backup.file_restore", {}, this._hass)}</button><button class="ha-button destructive" data-backup-delete="${this._escape(record.id)}" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:delete-outline"></ha-icon>${haListManagerPanelText("ui.delete", {}, this._hass)}</button></div><div data-backup-feedback="${this._escape(record.id)}">${this._renderDataBackupFeedback(record.id)}</div></article>`);
    // Keep the deletion result at the removed row until the next action.
    if (this._backupRemoved) {
      const removed = this._backupRemoved;
      rows.splice(removed.index, 0, `<article class="backup-record"><strong>${this._escape(removed.name)}</strong><div data-backup-feedback="${this._escape(removed.id)}">${this._renderDataBackupFeedback(removed.id)}</div></article>`);
    }
    return `<div data-backup-view><section class="content-header"><div><h2>${haListManagerPanelText("backup.title", {}, this._hass)}</h2><p>${haListManagerPanelText("backup.archive_intro", {}, this._hass)}</p></div></section>
      <ha-card class="settings-card data-backup-card"><div class="settings-inline-actions"><button class="ha-button primary" data-backup-create ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:database-plus-outline"></ha-icon>${haListManagerPanelText("backup.create", {}, this._hass)}</button><button class="ha-button backup-accent" data-backup-select ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:upload-outline"></ha-icon>${haListManagerPanelText("backup.upload", {}, this._hass)}</button><button class="ha-button" data-backup-refresh ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:refresh"></ha-icon>${haListManagerPanelText("ui.refresh", {}, this._hass)}</button></div>
      <div data-backup-feedback="controls">${this._renderDataBackupFeedback("controls")}</div>
      <input type="file" hidden accept=".db,.sqlite,.sqlite3" data-backup-file ${this._busy ? "disabled" : ""}>
      <p class="field-help">${haListManagerPanelText("backup.archive_help", {}, this._hass)}</p><p class="field-help">${haListManagerPanelText("backup.limit", {}, this._hass)}</p><div class="backup-notice"><ha-icon icon="mdi:shield-lock-outline"></ha-icon><span>${haListManagerPanelText("backup.private", {}, this._hass)}</span></div>
      </ha-card>
      <ha-card class="settings-card data-backup-card"><h3>${haListManagerPanelText("backup.saved", {}, this._hass)}</h3><div data-backup-records data-records="${this._escape(JSON.stringify({records, removed:this._backupRemoved || null}))}">${rows.join("") || `<p class="field-help">${haListManagerPanelText("backup.empty", {}, this._hass)}</p>`}</div></ha-card>

      <ha-card class="settings-card data-backup-card"><details data-backup-storage><summary>${haListManagerPanelText("backup.storage_title", {}, this._hass)}</summary><p>${haListManagerPanelText("backup.database_location", {}, this._hass)}<br><code data-backup-database-path>${this._escape(this._backupInfo?.database_path || "")}</code></p><p>${haListManagerPanelText("backup.archive_location", {}, this._hass)}<br><code data-backup-archive-path>${this._escape(this._backupInfo?.archive_path || "")}</code></p><p class="field-help">${haListManagerPanelText("backup.directory_auto", {}, this._hass)}</p></details></ha-card></div>`;
  }

  _openDataRestore(backupId, deleting = false) {
    const record = this._backupInfo?.backups?.find(entry => entry.id === backupId);
    if (!record || this._busy) return;
    this._dialog = {kind:deleting ? "data-backup-delete" : "data-restore", backup_id:record.id, filename:record.origin === "safety" ? haListManagerPanelText("backup.origin_safety", {}, this._hass) : record.name, summary:record.summary || {}, confirmed:false};
    this._error = ""; this._render();
  }

  _renderDataBackupDelete() {
    return `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>${this._dialogHeader(haListManagerPanelText("backup.delete_title", {}, this._hass))}<p><strong>${this._escape(this._dialog.filename)}</strong></p><p>${haListManagerPanelText("backup.delete_help", {}, this._hass)}</p>${this._dialogError()}<div class="dialog-actions"><button class="ha-button destructive" data-backup-delete-confirm ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.delete", {}, this._hass)}</button><button class="ha-button" data-cancel-dialog ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  async _createDataBackup() {
    if (this._busy) return;
    this._beginBackupAction();
    this._busy = true; this._render();
    try {
      await this._backupRequest("create", {method:"POST"});
      this._backupInfo = await this._backupRequest("info");
      this._backupStatus = haListManagerPanelText("backup.created", {}, this._hass);
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _deleteDataBackup() {
    if (this._busy || this._dialog?.kind !== "data-backup-delete") return;
    this._beginBackupAction(this._dialog.backup_id);
    const removed = {id:this._dialog.backup_id, name:this._dialog.filename,
      index:this._backupInfo.backups.findIndex(record => record.id === this._dialog.backup_id)};
    this._busy = true; this._render();
    try {
      await this._backupRequest("delete", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({backup_id:this._dialog.backup_id,confirm:true})});
      this._dialog = null;
      this._backupInfo = await this._backupRequest("info");
      this._backupRemoved = removed;
      this._backupStatus = haListManagerPanelText("backup.deleted", {}, this._hass);
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  _renderDataRestore() {
    const d = this._dialog;
    return `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" data-dialog-panel>
      ${this._dialogHeader(haListManagerPanelText("backup.restore_title", {}, this._hass))}<p><strong>${this._escape(d.filename)}</strong></p>
      <p class="field-help">${haListManagerPanelText("backup.summary", {p0:d.summary.lists,p1:d.summary.products,p2:d.summary.inventory,p3:d.summary.items}, this._hass)}</p>
      <p class="field-help">${haListManagerPanelText("backup.schema", {version:d.summary.schema_version}, this._hass)}</p>
      <p class="field-help">${haListManagerPanelText("backup.archive_restore_help", {}, this._hass)}</p>
      <p class="field-help">${haListManagerPanelText("backup.replace_help", {}, this._hass)}</p><p class="field-help">${haListManagerPanelText("backup.safety", {}, this._hass)}</p>
      <label class="setting-row"><input type="checkbox" data-restore-confirm ${d.confirmed ? "checked" : ""} ${this._busy ? "disabled" : ""}><span>${haListManagerPanelText("backup.confirm", {}, this._hass)}</span></label>
      ${this._dialogError()}<div class="dialog-actions"><button class="ha-button destructive" type="button" data-restore-data ${!d.confirmed || this._busy ? "disabled" : ""}>${this._busy ? haListManagerPanelText("backup.working", {}, this._hass) : haListManagerPanelText("backup.restore", {}, this._hass)}</button>
      <button class="ha-button" type="button" data-cancel-dialog ${this._busy ? "disabled" : ""}>${haListManagerPanelText("ui.cancel", {}, this._hass)}</button></div></section></div>`;
  }

  async _backupRequest(operation, options = {}) {
    const separator = operation.includes("?") ? "&" : "?";
    const response = await this._hass.fetchWithAuth(`/api/${API}/backup/${operation}${separator}language=${encodeURIComponent(haListManagerPanelTextLanguage(this._hass))}`, options);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || haListManagerPanelText("backup.failed", {}, this._hass));
    }
    return operation.startsWith("download?") ? response : response.json();
  }

  async _downloadDataBackup(backupId) {
    if (this._busy) return;
    this._beginBackupAction(backupId);
    this._busy = true; this._render();
    try {
      const response = await this._backupRequest(`download?backup_id=${encodeURIComponent(backupId)}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "ha-list-manager.db";
      this._backupDownload = {url, name:link.download};
      link.click();
      this._backupStatus = haListManagerPanelText("backup.downloaded", {}, this._hass);
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _prepareDataRestore(file) {
    if (!file || this._busy) return;
    this._beginBackupAction();
    if (file.size > 512 * 1024 * 1024) { this._error = haListManagerPanelText("backup.too_large", {}, this._hass); this._render(); return; }
    this._busy = true; this._error = ""; this._backupStatus = haListManagerPanelText("backup.working", {}, this._hass); this._render();
    try {
      await this._backupRequest(`validate?filename=${encodeURIComponent(file.name)}`, {method:"POST", headers:{"Content-Type":"application/octet-stream"}, body:file});
      this._backupInfo = await this._backupRequest("info");
      this._backupStatus = haListManagerPanelText("backup.uploaded", {}, this._hass);
    } catch (error) { this._backupStatus = ""; this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _restoreDataBackup() {
    if (this._busy || this._dialog?.kind !== "data-restore" || !this._dialog.confirmed) return;
    this._beginBackupAction(this._dialog.backup_id);
    this._busy = true; this._render();
    try {
      await this._backupRequest("restore", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({backup_id:this._dialog.backup_id,confirm:true})});
      this._dialog = null; this._backupRestored = true;
      this._backupStatus = haListManagerPanelText("backup.complete", {}, this._hass);
      this._backupInfo = await this._backupRequest("info");
      this._settingsLoaded = false;
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _saveSettings() {
    if (this._busy) return;
    await this._runDialogAction(async () => {
      this._settings = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/settings/update`,
        append_brand_to_product_name: Boolean(this._settings.append_brand_to_product_name),
        append_quantity_to_product_name: Boolean(this._settings.append_quantity_to_product_name),
        scanner_default_list_id: this._settings.scanner_default_list_id || null,
        scanner_default_action: this._settings.scanner_default_action || "add",
        tandoor_url: String(this._settings.tandoor_url || "").trim() || null,
        tandoor_token: String(this._settings.tandoor_token || "").trim() || null,
      });
      this._settings.tandoor_token = "";
      this._settingsLoaded = true;
    });
  }

  async _testTandoor() {
    if (this._busy) return;
    this._busy = true;
    this._tandoorTestStatus = haListManagerPanelText("ui.checking_connection", {}, this._hass);
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/tandoor/test`,
        url: String(this._settings.tandoor_url || "").trim() || null,
        token: String(this._settings.tandoor_token || "").trim() || null,
      });
      this._tandoorTestStatus = haListManagerPanelText("tandoor.connection_success", {p0:(Number(result.recipe_count || 0))}, this._hass);
    } catch (error) {
      this._tandoorTestStatus = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _openCategoryDialog(record, defaults = {}) {
    this._error = "";
    this._dialog = { kind: "category-editor", record, return_dialog: defaults.return_dialog || null, draft: {
      name: record?.name || defaults.name || "",
      scope: record?.scope || defaults.scope || "global",
      list_type: record?.list_type || defaults.list_type || "shopping",
      list_id: record?.list_id || defaults.list_id || "",
      icon: record?.icon || "",
      color: record?.color || "",
      position: record ? record.position + 1 : "",
      rules_text: defaults.rules_text || "",
    } };
    this._render();
    this.shadowRoot.querySelector("[data-category-name]")?.focus();
  }

  _openCategoryProductsPage(record, preferredTab = "rules") {
    if (!record) return;
    this._activeSection = "categories";
    this._selectedCategoryId = record.id;
    const supportsProducts = record.scope === "list" && this._findList(record.list_id)?.list_type !== "todo";
    this._categoryDetailTab = preferredTab === "products" && supportsProducts ? "products" : "rules";
    this._categoryRules = [];
    this._categoryRulesLoading = true;
    this._categoryRuleDraft = "";
    this._categoryRuleEditingIndex = -1;
    this._categoryProducts = [];
    this._categoryProductsLoading = record.scope === "list" && this._findList(record.list_id)?.list_type !== "todo";
    this._error = "";
    this._render();
    this._loadCategoryRules();
    if (this._categoryProductsLoading) this._loadCategoryProductPage();
  }

  async _loadListAssignments(listId, quiet = false) {
    const list = this._findList(listId);
    if (!this._hass || !list) return;
    const categories = this._categories.filter((record) => record.scope === "list" && record.list_id === listId);
    const requestId = ++this._listAssignmentsRequestId;
    this._listAssignmentsLoading = true;
    if (!quiet) this._render();
    try {
      const groups = await Promise.all(categories.map(async (category) => {
        const [rulesResult, productsResult] = await Promise.all([
          haListManagerPanelTextRequest(this._hass, { type: `${API}/categories/rules/list`, category_id: category.id }),
          list.list_type === "todo"
            ? Promise.resolve({ assigned: [] })
            : haListManagerPanelTextRequest(this._hass, { type: `${API}/categories/products/list`, category_id: category.id }),
        ]);
        return { category, rules: rulesResult.rules || [], products: productsResult.assigned || [] };
      }));
      if (requestId !== this._listAssignmentsRequestId || !this._isListAssignmentContext(listId)) return;
      this._listAssignmentGroups = groups;
    } catch (error) {
      if (requestId !== this._listAssignmentsRequestId || !this._isListAssignmentContext(listId)) return;
      this._error = this._formatError(error);
    } finally {
      if (requestId !== this._listAssignmentsRequestId || !this._isListAssignmentContext(listId)) return;
      this._listAssignmentsLoading = false;
      this._render();
    }
  }

  _isListAssignmentContext(listId) {
    return this._selectedListId === listId
      || (this._activeSection === "categories" && this._categoryTab === "specific" && this._categorySpecificListId === listId);
  }

  async _loadCategoryRules() {
    const record = this._findCategory(this._selectedCategoryId);
    if (!this._hass || !record) return;
    this._categoryRulesLoading = true;
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/categories/rules/list`,
        category_id: record.id,
      });
      if (this._selectedCategoryId !== record.id) return;
      this._categoryRules = result.rules || [];
    } catch (error) {
      if (this._selectedCategoryId !== record.id) return;
      this._error = this._formatError(error);
    } finally {
      if (this._selectedCategoryId !== record.id) return;
      this._categoryRulesLoading = false;
      if (!this._dialog) this._render();
    }
  }

  async _loadCategoryProductPage(quiet = false) {
    const record = this._findCategory(this._selectedCategoryId);
    if (!this._hass || !record) return;
    const requestId = ++this._categoryProductPageRequestId;
    const wasLoading = this._categoryProductsLoading;
    this._categoryProductsLoading = true;
    if (!quiet && !wasLoading) this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/categories/products/list`,
        category_id: record.id,
      });
      if (requestId !== this._categoryProductPageRequestId || this._selectedCategoryId !== record.id) return;
      this._categoryProducts = result.assigned || [];
    } catch (error) {
      if (requestId !== this._categoryProductPageRequestId || this._selectedCategoryId !== record.id) return;
      this._error = this._formatError(error);
    } finally {
      if (requestId !== this._categoryProductPageRequestId || this._selectedCategoryId !== record.id) return;
      this._categoryProductsLoading = false;
      if (!quiet && !this._dialog) this._render();
    }
  }

  _openCategoryProductsDialog(record) {
    if (!record?.list_id || this._findList(record.list_id)?.list_type === "todo") return;
    this._error = "";
    this._dialog = {
      kind: "category-products",
      record,
      search: "",
      search_results: [],
      search_total: 0,
      search_loading: true,
      show_assigned: false,
      assigned: [],
      move_confirmation: null,
    };
    this._render();
    this._loadCategoryProducts();
    this.shadowRoot.querySelector("[data-category-product-search]")?.focus();
  }

  async _loadCategoryProducts() {
    const dialog = this._dialog;
    if (!this._hass || dialog?.kind !== "category-products") return;
    const requestId = ++this._categoryProductRequestId;
    dialog.search_loading = true;
    this._updateCategoryProductDialogParts();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/categories/products/list`,
        category_id: dialog.record.id,
        search: dialog.search.trim(),
      });
      if (requestId !== this._categoryProductRequestId || this._dialog !== dialog) return;
      dialog.assigned = result.assigned || [];
      dialog.search_results = result.products || [];
      dialog.search_total = Number(result.total || 0);
      dialog.search_loading = false;
      this._updateCategoryProductDialogParts();
    } catch (error) {
      if (requestId !== this._categoryProductRequestId || this._dialog !== dialog) return;
      dialog.search_loading = false;
      this._error = this._formatError(error);
      this._render();
    }
  }

  _updateCategoryProductDialogParts() {
    if (this._dialog?.kind !== "category-products") return;
    const results = this.shadowRoot.querySelector("[data-category-product-results]");
    if (results) results.innerHTML = this._renderCategoryProductResults();
  }

  _categoryDialogProduct(productId) {
    if (this._dialog?.kind !== "category-products") return null;
    return [...this._dialog.search_results, ...this._dialog.assigned].find((product) => product.id === productId) || null;
  }

  async _setCategoryProduct(productId, categoryId, replaceExisting = false) {
    const dialog = this._dialog;
    if (this._busy || dialog?.kind !== "category-products") return;
    this._busy = true;
    this._error = "";
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/products/category/set`,
        product_id: productId,
        list_id: dialog.record.list_id,
        category_id: categoryId,
        replace_existing: replaceExisting,
      });
      if (this._dialog !== dialog) return;
      if (result.conflict) {
        const product = this._categoryDialogProduct(productId) || result.product;
        dialog.move_confirmation = { product, category: result.conflict };
        this._render();
        return;
      }
      dialog.move_confirmation = null;
      this._productsLoaded = false;
      await this._loadCategoryProducts();
      await this._loadCategoryProductPage(true);
    } catch (error) {
      this._error = this._formatError(error);
      this._render();
    } finally {
      this._busy = false;
    }
  }

  async _removeCategoryProductFromPage(productId) {
    const record = this._findCategory(this._selectedCategoryId);
    if (this._busy || !record) return;
    this._busy = true;
    this._error = "";
    this._render();
    try {
      await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/products/category/set`,
        product_id: productId,
        list_id: record.list_id,
        category_id: null,
        replace_existing: true,
      });
      this._productsLoaded = false;
      await this._loadCategoryProductPage(true);
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _openCategoryRulesBulkDialog() {
    const record = this._findCategory(this._selectedCategoryId);
    if (!record) return;
    this._error = "";
    this._dialog = {
      kind: "category-rules-bulk",
      record,
      text: this._categoryRules.map((rule) => rule.pattern).join("\n"),
    };
    this._render();
    this.shadowRoot.querySelector("[data-category-rules-bulk]")?.focus();
  }

  async _replaceCategoryRules(patterns, closeDialog = false) {
    const record = this._findCategory(this._selectedCategoryId) || this._dialog?.record;
    if (this._busy || !record) return;
    this._busy = true;
    this._error = "";
    let saved = false;
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/categories/rules/set`,
        category_id: record.id,
        patterns,
      });
      this._categoryRules = result.rules || [];
      this._categoryRuleDraft = "";
      this._categoryRuleEditingIndex = -1;
      if (closeDialog) this._dialog = null;
      saved = true;
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
      const focusSelector = closeDialog && !saved
        ? "[data-category-rules-bulk]"
        : !closeDialog && this._categoryRuleEditingIndex < 0
          ? "[data-category-rule-input]"
          : "";
      if (focusSelector) {
        setTimeout(() => {
          const field = this.shadowRoot.querySelector(focusSelector);
          field?.focus();
          if (field?.tagName === "TEXTAREA") field.setSelectionRange(field.value.length, field.value.length);
        }, 0);
      }
    }
  }

  _saveCategoryRule() {
    const pattern = this._categoryRuleDraft.trim();
    if (!pattern) {
      this._error = haListManagerPanelText("ui.assignment_rule_required", {}, this._hass);
      this._render();
      this.shadowRoot.querySelector("[data-category-rule-input]")?.focus();
      return;
    }
    const patterns = this._categoryRules.map((rule) => rule.pattern);
    if (this._categoryRuleEditingIndex >= 0) patterns[this._categoryRuleEditingIndex] = pattern;
    else patterns.push(pattern);
    this._replaceCategoryRules(patterns);
  }

  _deleteCategoryRule(index) {
    const rule = this._categoryRules[index];
    if (this._busy || !rule || !this._selectedCategoryId) return;
    this._openDeleteDialog("delete-category-rule", {
      name: rule.pattern,
      category_id: this._selectedCategoryId,
    });
  }

  _saveCategoryRulesBulk() {
    if (this._dialog?.kind !== "category-rules-bulk") return;
    const patterns = this._dialog.text.split(/\r?\n/);
    this._replaceCategoryRules(patterns, true);
  }

  _openLabelDialog(record, defaults = {}) {
    this._error = "";
    this._dialog = { kind: "label-editor", record, draft: {
      name: record?.name || "",
      icon: record?.icon || "",
      color: record?.color || "",
      scope: record?.scope || defaults.scope || "global",
      list_type: record?.list_type || defaults.list_type || "shopping",
      list_id: record?.list_id || defaults.list_id || this._lists[0]?.id || "",
    } };
    this._render();
    this.shadowRoot.querySelector("[data-label-name]")?.focus();
  }

  async _openChipDialog(record, defaults = {}) {
    this._error = "";
    const destinationList = this._findList(record?.list_id || defaults.list_id);
    const chipKind = record?.chip_kind || defaults.chip_kind || (record?.list_type === "todo" || defaults.list_type === "todo" || destinationList?.list_type === "todo" ? "todo_template" : "entry");
    const template = record?.template_data || {};
    this._dialog = { kind: "chip-editor", record, draft: {
      name: record?.name || "",
      chip_kind: chipKind,
      icon: record?.icon || (chipKind === "todo_template" ? "mdi:checkbox-marked-outline" : ""),
      color: record?.color || "",
      scope: record?.scope || defaults.scope || (chipKind === "todo_template" ? "list_type" : "global"),
      list_type: chipKind === "todo_template" ? "todo" : record?.list_type || defaults.list_type || "shopping",
      list_id: record?.list_id || defaults.list_id || this._lists.find((list) => list.list_type === (chipKind === "todo_template" ? "todo" : "shopping"))?.id || "",
      product_id: record?.product_id || null,
      item_name: template.item_name || record?.name || "",
      description: template.description || "",
      category_id: template.category_id || null,
      category_name: template.category_name || "",
      label_ids: [...(template.label_ids || [])],
      due_mode: template.due_mode || "none",
      due_time: template.due_time || "",
      due_offset_value: template.due_offset_value || 1,
      due_offset_unit: template.due_offset_unit || "D",
      due_weekday: Number.isInteger(template.due_weekday) ? template.due_weekday : 1,
      recurrence_interval: template.recurrence_interval || "",
      recurrence_unit: template.recurrence_unit || "D",
      add_mode: template.add_mode || "edit",
      conflict: null,
    } };
    this._render();
    this.shadowRoot.querySelector("[data-chip-name]")?.focus();
    if (chipKind === "todo_template") return;
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/products/list`, limit: 100, offset: 0 });
      if (this._dialog?.kind === "chip-editor") {
        this._dialog.product_options = result.products || [];
        this._render();
        this.shadowRoot.querySelector("[data-chip-name]")?.focus();
      }
    } catch (_error) {}
  }

  async _openDishDialog(record) {
    this._error = "";
    this._dialog = { kind: "dish-editor", record, product_picker_open: false, product_search: "", product_search_results: [], product_search_total: 0, product_search_loading: false, draft: {
      name: record?.name || "", color: record?.color || "",
      items: (record?.items || []).map((item) => ({
        name: item.product_id ? (item.product_name || item.name || "") : (item.name || ""),
        product_id: item.product_id || null,
        product_name: item.product_name || "",
        product_brand: item.product_brand || "",
        product_package_quantity: item.product_package_quantity || "",
        product_ean: item.product_ean || "",
        quantity: item.quantity || 1,
      })),
      quick_items: "",
    } };
    this._render();
    this.shadowRoot.querySelector("[data-dish-name]")?.focus();
  }

  _openDishProductPicker() {
    if (this._dialog?.kind !== "dish-editor") return;
    this._dialog.product_picker_open = true;
    this._dialog.product_search = "";
    this._dialog.product_search_results = [];
    this._dialog.product_search_total = 0;
    this._dialog.product_search_loading = true;
    this._render();
    this._loadDishProducts();
    this.shadowRoot.querySelector("[data-dish-product-search]")?.focus();
  }

  _closeDishProductPicker() {
    if (this._dialog?.kind !== "dish-editor") return;
    clearTimeout(this._dishProductSearchTimer);
    this._dialog.product_picker_open = false;
    this._render();
    this.shadowRoot.querySelector("[data-add-dish-product]")?.focus();
  }

  async _loadDishProducts() {
    const dialog = this._dialog;
    if (!this._hass || dialog?.kind !== "dish-editor" || !dialog.product_picker_open) return;
    const requestId = ++this._dishProductRequestId;
    dialog.product_search_loading = true;
    this._updateDishProductPickerResults();
    try {
      const search = dialog.product_search.trim();
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/products/list`, search: search || undefined, limit: 100, offset: 0 });
      if (requestId !== this._dishProductRequestId || this._dialog !== dialog || !dialog.product_picker_open) return;
      dialog.product_search_results = result.products || [];
      dialog.product_search_total = Number(result.total || dialog.product_search_results.length);
      dialog.product_search_loading = false;
      this._updateDishProductPickerResults();
    } catch (error) {
      if (requestId !== this._dishProductRequestId || this._dialog !== dialog || !dialog.product_picker_open) return;
      dialog.product_search_loading = false;
      this._error = this._formatError(error);
      this._render();
      this.shadowRoot.querySelector("[data-dish-product-search]")?.focus();
    }
  }

  _updateDishProductPickerResults() {
    if (this._dialog?.kind !== "dish-editor" || !this._dialog.product_picker_open) return;
    const results = this.shadowRoot.querySelector("[data-dish-product-results]");
    if (results) results.innerHTML = this._renderDishProductPickerResults();
  }

  _selectDishProduct(productId) {
    const dialog = this._dialog;
    if (dialog?.kind !== "dish-editor" || !dialog.product_picker_open) return;
    const product = (dialog.product_search_results || []).find((entry) => entry.id === productId);
    if (!product || dialog.draft.items.some((item) => item.product_id === product.id)) return;
    const item = {
      name: product.name,
      product_id: product.id,
      product_name: product.name,
      product_brand: product.brand || "",
      product_package_quantity: product.package_quantity || "",
      product_ean: product.ean || "",
      quantity: 1,
    };
    dialog.draft.items.push(item);
    dialog.product_picker_open = false;
    this._render();
    this.shadowRoot.querySelector("[data-add-dish-product]")?.focus();
  }

  _parseDishQuickItems(value) {
    return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(.*?)(?:\s*\((\d+)\))?$/);
      return { name: (match?.[1] || line).trim(), product_id: null, product_name: "", quantity: Math.max(1, Number(match?.[2]) || 1) };
    }).filter((item) => item.name);
  }

  _importDishItems(render = true) {
    if (this._dialog?.kind !== "dish-editor") return false;
    const parsed = this._parseDishQuickItems(this._dialog.draft.quick_items);
    if (!parsed.length) return false;
    const emptyOnly = this._dialog.draft.items.length === 1 && !this._dialog.draft.items[0].name.trim();
    this._dialog.draft.items = emptyOnly ? parsed : [...this._dialog.draft.items, ...parsed];
    this._dialog.draft.quick_items = "";
    if (render) this._render();
    return true;
  }

  _openInventoryDialog(record) {
    this._error = "";
    this._dialog = { kind: "inventory-editor", record,
      product_options: this._inventoryProducts.slice(0, 100),
      product_total: this._inventoryProductTotal ?? this._inventoryProducts.length,
      draft: {
      product_id: record?.product_id || "",
      stock: record?.stock ?? 0,
      minimum_stock: record?.minimum_stock ?? "",
      restock_quantity: record?.restock_quantity ?? 1,
      restock_mode: record?.restock_mode || "inherit",
      category_id: record?.category_id || "",
      hidden: record?.hidden === true,
    } };
    this._render();
  }

  async _openPendingScanEditor(scan) {
    if (!scan || this._busy) return;
    this._error = "";
    this._selectedInventoryListId = scan.list_id;
    await this._loadInventory();
    const record = this._inventoryEntries.find((entry) => entry.id === scan.inventory_entry_id || entry.product_id === scan.product_id) || null;
    const product = this._findInventoryProduct(scan.product_id) || record?.product || null;
    const quantity = Math.max(1, Number(scan.quantity) || 1);
    const stock = record
      ? scan.action === "add" ? record.stock + quantity : scan.action === "remove" ? Math.max(0, record.stock - quantity) : record.stock
      : scan.action === "add" ? quantity : 0;
    this._dialog = { kind: "inventory-editor", record, pendingScan: scan, draft: {
      product_id: scan.product_id || record?.product_id || "",
      stock,
      minimum_stock: record?.minimum_stock ?? "",
      restock_quantity: record?.restock_quantity ?? 1,
      restock_mode: record?.restock_mode || "inherit",
      category_id: record?.category_id || "",
      category_name: record?.category_name || record?.category?.name || product?.category || "",
      hidden: record?.hidden === true,
      name: product?.name || scan.product_name || "",
      original_name: product?.original_name || product?.name || scan.product_name || "",
      ean: product?.ean || scan.ean || "",
      brand: product?.brand || "",
      package_quantity: product?.package_quantity || "",
      image_url: product?.image_url || "",
      label_ids: (product?.labels || []).map((label) => label.id),
    } };
    this._render();
  }

  _openInventoryGroupDialog(record) {
    this._error = "";
    this._inventoryGroupSearch = "";
    this._inventoryGroupShowGrouped = false;
    this._dialog = { kind: "inventory-group-editor", record, draft: {
      name: record?.name || "",
      minimum_stock: record?.minimum_stock ?? "",
      restock_quantity: record?.restock_quantity ?? 1,
      restock_mode: record?.restock_mode || "inherit",
      category_id: record?.category_id || "",
      member_ids: [...(record?.member_ids || [])],
      confirmed_move_ids: [],
    } };
    this._render();
    this.shadowRoot.querySelector("[data-inventory-group-name]")?.focus();
  }

  _openInventoryRestockSettingsDialog() {
    this._error = "";
    this._dialog = { kind: "inventory-restock-settings", draft: {
      enabled: this._inventoryRestockSettings.enabled === true,
      target_list_id: this._inventoryRestockSettings.target_list_id || "",
      mode: this._inventoryRestockSettings.mode || null,
      fixed_quantity: this._inventoryRestockSettings.fixed_quantity ?? "",
    } };
    this._render();
  }

  _openScannerDialog(record) {
    const firstInventory = this._lists.find((list) => list.list_type === "inventory");
    this._error = "";
    this._dialog = { kind: "scanner-editor", record, draft: {
      name: record?.name || "",
      address: record?.address || "",
      enabled: record?.enabled !== false,
      routing: record?.routing || "active_target",
      list_id: record?.list_id || firstInventory?.id || "",
      action: record?.action || "add",
    } };
    this._render();
    this.shadowRoot.querySelector("[data-scanner-name]")?.focus();
  }

  async _openNotificationDialog(record) {
    const request = this._notificationOpenRequest = {};
    const previousDialog = this._dialog;
    const section = this._activeSection;
    this._error = "";
    let entities;
    try {
      entities = await this._hass.callWS({ type: "config/entity_registry/list" });
    } catch (error) {
      if (this._notificationOpenRequest !== request || this._dialog !== previousDialog || this._activeSection !== section) return;
      this._error = this._formatError(error);
      this._render();
      return;
    }
    if (this._notificationOpenRequest !== request || this._dialog !== previousDialog || this._activeSection !== section) return;
    this._notificationEntityPlatforms = Object.fromEntries(entities.map((entity) => [entity.entity_id, entity.platform]));
    this._dialog = { kind: "notification-editor", record, draft: {
      name: record?.name || "",
      provider: record?.provider === "notify_entity" && this._notificationIsTelegram(record.target) ? "telegram" : record?.provider || "notify_entity",
      target: record?.target || "",
      title: record?.title || "",
      click_url: record?.click_url || "",
      message_format: record?.message_format || "plain",
      enabled: record?.enabled ?? true,
    } };
    this._render();
    this.shadowRoot.querySelector("[data-notification-name]")?.focus();
  }

  async _saveNotification() {
    if (this._busy) return;
    const { record, draft } = this._dialog;
    draft.name = draft.name.trim();
    draft.target = draft.provider === "persistent"
      ? "notify.persistent_notification"
      : draft.target.trim();
    if (!draft.name) return this._showDialogError(haListManagerPanelText("errors.name_required", {}, this._hass));
    if (!draft.target) return this._showDialogError(haListManagerPanelText("ui.entity_or_service_required", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/notifications/profiles/${record ? "update" : "create"}`,
        name: draft.name,
        provider: draft.provider === "telegram" ? "notify_entity" : draft.provider,
        target: draft.target,
        title: draft.title.trim() || null,
        click_url: draft.provider === "notify_entity" ? draft.click_url.trim() || null : null,
        message_format: draft.message_format,
        enabled: Boolean(draft.enabled),
      };
      if (record) payload.profile_id = record.id;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      await this._reloadNotifications();
    });
  }

  async _reloadNotifications() {
    const [profiles, assignments] = await Promise.all([
      haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/profiles/list` }),
      haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/assignments/list` }),
    ]);
    this._notificationProfiles = profiles.profiles || [];
    this._notificationAssignments = assignments.assignments || [];
  }

  async _saveNotificationAssignments(listId) {
    if (this._busy) return;
    const supportsQuantityEvents = this._findList(listId)?.list_type !== "todo";
    let invalidDelay = false;
    let missingAutomaticEvent = false;
    const assignments = [...this.shadowRoot.querySelectorAll(`[data-notification-assignment^="${listId}:"]:checked`)].map((input) => {
      const key = input.dataset.notificationAssignment;
      const profileId = key.slice(listId.length + 1);
      const delay = Number(this.shadowRoot.querySelector(`[data-notification-delay="${key}"]`)?.value ?? 15);
      if (!Number.isInteger(delay) || delay < 0 || delay > 86400) invalidDelay = true;
      const eventEnabled = (eventName) => Boolean(this.shadowRoot.querySelector(`[data-notification-event="${key}:${eventName}"]`)?.checked);
      const assignment = {
        profile_id: profileId,
        manual_enabled: Boolean(this.shadowRoot.querySelector(`[data-notification-manual="${key}"]`)?.checked),
        automatic_mode: this.shadowRoot.querySelector(`[data-notification-mode="${key}"]`)?.value || "off",
        delay_seconds: delay,
        notify_on_add: eventEnabled("add"),
        notify_on_increase: supportsQuantityEvents && eventEnabled("increase"),
        notify_on_decrease: supportsQuantityEvents && eventEnabled("decrease"),
        notify_on_edit: eventEnabled("edit"),
        notify_on_complete: eventEnabled("complete"),
        notify_on_reopen: eventEnabled("reopen"),
        notify_on_delete: eventEnabled("delete"),
      };
      if (assignment.automatic_mode !== "off" && ![
        assignment.notify_on_add, assignment.notify_on_increase,
        assignment.notify_on_decrease, assignment.notify_on_edit,
        assignment.notify_on_complete, assignment.notify_on_reopen,
        assignment.notify_on_delete,
      ].some(Boolean)) missingAutomaticEvent = true;
      return assignment;
    });
    if (invalidDelay) {
      this._error = haListManagerPanelText("errors.wait_time_range", {}, this._hass);
      this._render();
      return;
    }
    if (missingAutomaticEvent) {
      this._error = haListManagerPanelText("ui.notification_event_required", {}, this._hass);
      this._render();
      return;
    }
    this._busy = true;
    this._notificationStatus = "";
    this._error = "";
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/assignments/set`, list_id: listId, assignments });
      await this._reloadNotifications();
      this._notificationStatus = haListManagerPanelText("products.assignment_saved", {p0:(this._findList(listId)?.name || haListManagerPanelText("ui.list", {}, this._hass))}, this._hass);
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _testNotification(profileId) {
    if (this._busy) return;
    this._busy = true;
    this._notificationStatus = "";
    this._error = "";
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/test`, profile_id: profileId });
      this._notificationStatus = haListManagerPanelText("ui.test_message_sent", {p0:(this._notificationProfiles.find((item) => item.id === profileId)?.name || haListManagerPanelText("notifications.delivery_target", {}, this._hass))}, this._hass);
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _sendListNotification(listId) {
    if (this._busy) return;
    this._busy = true;
    this._notificationStatus = "";
    this._error = "";
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/send_list`, list_id: listId });
      const count = (result.sent_profile_ids || []).length;
      this._notificationStatus = haListManagerPanelText("ui.named_list_sent_to", {name: this._findList(listId)?.name || haListManagerPanelText("ui.list", {}, this._hass), count, targets: haListManagerPanelText(count === 1 ? "ui.target" : "ui.targets", {}, this._hass)}, this._hass);
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _saveScanner() {
    if (this._busy || this._dialog?.kind !== "scanner-editor") return;
    const { record, draft } = this._dialog;
    draft.name = draft.name.trim();
    draft.address = draft.address.trim();
    if (!draft.name || !draft.address) return this._showDialogError(haListManagerPanelText("errors.enter_scanner_name_address", {}, this._hass));
    if (draft.routing === "fixed" && (!draft.list_id || !draft.action)) return this._showDialogError(haListManagerPanelText("errors.select_fixed_list_action", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/scanners/${record ? "update" : "create"}`,
        name: draft.name, address: draft.address,
        enabled: Boolean(draft.enabled), routing: draft.routing,
        list_id: draft.routing === "fixed" ? draft.list_id : null,
        action: draft.routing === "fixed" ? draft.action : null,
      };
      if (record) payload.scanner_id = record.id;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      this._scannersLoaded = false;
      await this._loadScanners();
    });
  }

  async _clearScannerTarget() {
    if (this._busy) return;
    this._busy = true;
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/target/clear` });
      this._scannerTarget = null;
      this._error = "";
    } catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  async _runScannerSimulation() {
    if (this._busy) return;
    const ean = String(this._simulation.ean || "").trim();
    if (!/^\d{4,32}$/.test(ean)) {
      this._simulationStatus = { tone: "error", text: haListManagerPanelText("errors.ean_digits_required", {}, this._hass) };
      this._render();
      return;
    }
    if (!this._simulation.list_id) {
      this._simulationStatus = { tone: "error", text: haListManagerPanelText("errors.select_inventory_list", {}, this._hass) };
      this._render();
      return;
    }
    if (this._simulation.action === "correct" && String(this._simulation.corrected_stock).trim() === "") {
      this._simulationStatus = { tone: "error", text: haListManagerPanelText("errors.enter_corrected_stock", {}, this._hass) };
      this._render();
      return;
    }
    const delay = Math.max(0, Number(this._simulation.delay) || 0);
    await this._executeScannerSimulation(delay);
  }

  async _executeScannerSimulation(delaySeconds = 0) {
    const ean = String(this._simulation.ean || "").trim();
    this._busy = true;
    this._simulationStatus = null;
    this._render();
    try {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/scanner/simulate`, ean,
        scanner_id: this._simulation.scanner_id || null,
        list_id: this._simulation.list_id,
        action: this._simulation.action,
        quantity: Math.max(1, Math.floor(Number(this._simulation.quantity) || 1)),
        corrected_stock: this._simulation.action === "correct" ? Math.max(0, Math.floor(Number(this._simulation.corrected_stock))) : null,
        delay_seconds: delaySeconds,
      });
      if (result.scheduled) {
        this._simulationCountdown = result.delay_seconds;
        this._simulationStatus = { tone: "warning", text: haListManagerPanelText("scanner.inventory_ready_message", {p0:(result.message)}, this._hass) };
        this._simulationTimer = setInterval(() => {
          this._simulationCountdown = Math.max(0, this._simulationCountdown - 1);
          if (!this._simulationCountdown) {
            clearInterval(this._simulationTimer);
            this._simulationTimer = null;
            this._simulationStatus = { tone: "warning", text: haListManagerPanelText("ui.scheduled_scan_executed", {}, this._hass) };
          }
          this._render();
        }, 1000);
        return;
      }
      const history = result.history || {};
      const needsReview = ["queued", "offered", "not_found", "needs_input"].includes(history.status);
      const guidance = needsReview ? (" " + haListManagerPanelText("scanner.open_target_or_queue", {}, this._hass)) : "";
      this._simulationStatus = { tone: history.status === "success" ? "success" : needsReview ? "warning" : "error", text: `${history.message || (needsReview ? haListManagerPanelText("scanner.scan_waiting", {}, this._hass) : haListManagerPanelText("scanner.scan_processed", {}, this._hass))}${guidance}` };
      this._scanHistoryLoaded = false;
      await this._loadScanners();
      if (this._selectedInventoryListId === this._simulation.list_id) await this._loadInventory();
    } catch (error) { this._simulationStatus = { tone: "error", text: this._formatError(error) }; }
    finally { this._busy = false; this._render(); }
  }

  async _dismissPendingScan(scanId) {
    if (this._busy) return;
    this._busy = true;
    try { await haListManagerPanelTextRequest(this._hass, { type: `${API}/scanner/queue/dismiss`, scan_id: scanId }); }
    catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._scanHistoryLoaded = false; await this._loadScanHistory(); }
  }

  _inventoryGroupMoveSummary(record, memberIds, excludedIds = []) {
    const currentGroupId = record?.id || "";
    const excluded = new Set(excludedIds);
    const selected = new Set(memberIds.filter((id) => !excluded.has(id)));
    const moves = new Map();
    this._inventoryGroups.forEach((group) => {
      if (group.id === currentGroupId) return;
      const moving = (group.member_ids || []).filter((entryId) => selected.has(entryId));
      if (moving.length) moves.set(group, moving);
    });
    if (!moves.size) return "";
    const parts = [...moves].map(([group, moving]) => {
      const names = moving.map((id) => this._findInventoryEntry(id)?.product?.name).filter(Boolean).join(", ");
      const dissolves = (group.member_ids || []).length - moving.length < 2;
      return (dissolves ? haListManagerPanelText("inventory.group_move_dissolves_summary", {items: names || haListManagerPanelText("ui.item_count", {p0: moving.length}, this._hass), group: group.name}, this._hass) : haListManagerPanelText("inventory.group_move_summary", {items: names || haListManagerPanelText("ui.item_count", {p0: moving.length}, this._hass), group: group.name}, this._hass));
    });
    return { message: haListManagerPanelText("inventory.group_assignment_changes", {p0: parts.join(" · ")}, this._hass), dissolves: [...moves].some(([group, moving]) => (group.member_ids || []).length - moving.length < 2) };
  }

  _inventoryEntryMoveWarning(entryId) {
    const source = this._inventoryGroups.find((group) => group.id !== this._dialog?.record?.id && (group.member_ids || []).includes(entryId));
    if (!source) return null;
    const entry = this._findInventoryEntry(entryId);
    const dissolves = (source.member_ids || []).length <= 2;
    return {
      dissolves,
      message: dissolves
        ? haListManagerPanelText("inventory.member_move_dissolves_group", {p0:(entry?.product?.name || haListManagerPanelText("ui.the_item", {}, this._hass)), p1:(source.name)}, this._hass)
        : haListManagerPanelText("inventory.item_moving_to_group", {p0:(entry?.product?.name || haListManagerPanelText("ui.the_item", {}, this._hass)), p1:(source.name)}, this._hass),
    };
  }

  async _openDeleteDialog(kind, record) {
    this._error = "";
    this._dialog = { kind, record, linked_chip_count: null };
    this._render();
    if (kind !== "delete-product" || !record) return;
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/chips/list` });
      if (this._dialog?.kind === kind && this._dialog.record?.id === record.id) {
        this._dialog.linked_chip_count = (result.chips || []).filter((chip) => chip.product_id === record.id).length;
        this._render();
      }
    } catch (_error) {}
  }
  _closeDialog() {
    if (this._busy) return;
    clearTimeout(this._dialog?.product_search_timer);
    if (this._dialog?.kind === "category-products") clearTimeout(this._categoryProductSearchTimer);
    if (this._dialog?.kind === "dish-editor") clearTimeout(this._dishProductSearchTimer);
    this._dialog = this._dialog?.return_dialog || null;
    this._error = "";
    this._render();
  }

  async _saveList(scopeConfirmed = false) {
    if (this._busy) return;
    const { record, draft } = this._dialog;
    draft.name = draft.name.trim();
    if (!draft.name) return this._showDialogError(haListManagerPanelText("errors.name_required", {}, this._hass));
    if (draft.list_type === "bring" && !draft.external_entity_id) return this._showDialogError(haListManagerPanelText("ui.select_bring_list_required", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = { type: `${API}/lists/${record ? "update" : "create"}`, name: draft.name, icon: draft.icon || null };
      payload.use_global_categories = Boolean(draft.use_global_categories);
      payload.use_type_categories = Boolean(draft.use_type_categories);
      payload.use_global_labels = Boolean(draft.use_global_labels);
      payload.use_type_labels = Boolean(draft.use_type_labels);
      payload.use_global_chips = Boolean(draft.use_global_chips);
      payload.use_type_chips = Boolean(draft.use_type_chips);
      payload.use_dishes = Boolean(draft.use_dishes);
      payload.use_tandoor = Boolean(draft.use_tandoor);
      payload.tandoor_skip_small_units = Boolean(draft.tandoor_skip_small_units);
      payload.tandoor_include_ingredients = Boolean(draft.tandoor_include_ingredients);
      payload.tandoor_excluded_units = String(draft.tandoor_excluded_units || "").trim();
      payload.tandoor_result_limit = Number(draft.tandoor_result_limit || 100);
      if (!record) payload.list_type = draft.list_type;
      if (draft.list_type === "bring") payload.external_entity_id = draft.external_entity_id;
      if (record) payload.list_id = record.id;
      const scopeChanged = record && [
        "use_global_categories", "use_type_categories", "use_global_labels",
        "use_type_labels", "use_global_chips", "use_type_chips",
      ].some((key) => Boolean(payload[key]) !== (record[key] !== false));
      if (scopeChanged && !scopeConfirmed) {
        const preview = await haListManagerPanelTextRequest(this._hass, {
          type: `${API}/lists/scope-impact`, list_id: record.id,
          use_global_categories: payload.use_global_categories,
          use_type_categories: payload.use_type_categories,
          use_global_labels: payload.use_global_labels,
          use_type_labels: payload.use_type_labels,
          use_global_chips: payload.use_global_chips,
          use_type_chips: payload.use_type_chips,
        });
        if (preview.impact?.affected_total) {
          this._dialog.scope_confirmation = preview.impact;
          return;
        }
      }
      if (record) payload.confirm_scope_changes = scopeConfirmed;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      this._loaded = false;
      await this._loadData();
    });
  }

  async _confirmListScopeToggle() {
    if (this._busy || this._dialog?.kind !== "list-scope-toggle") return;
    const dialog = this._dialog;
    await this._runDialogAction(async () => {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/lists/update`,
        list_id: dialog.list.id,
        ...dialog.settings,
        confirm_scope_changes: true,
      });
      this._lists = this._lists.map((list) => list.id === result.list.id ? result.list : list);
      this._dialog = null;
      await this._loadItems(true);
    });
  }

  async _saveItem() {
    if (this._busy) return;
    const { record, draft } = this._dialog;
    draft.name = draft.name.trim();
    const quantity = Number(draft.quantity);
    const recurrenceInterval = String(draft.recurrence_interval ?? "").trim() === "" ? null : Number(draft.recurrence_interval);
    const dueAt = draft.due_date ? `${draft.due_date}${draft.due_time ? `T${draft.due_time}:00` : ""}` : null;
    if (!draft.name) return this._showDialogError(haListManagerPanelText("errors.name_required", {}, this._hass));
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) return this._showDialogError(haListManagerPanelText("errors.quantity_range", {}, this._hass));
    if (recurrenceInterval !== null && (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 1000000)) return this._showDialogError(haListManagerPanelText("errors.repeat_interval_range", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/items/${record ? "update" : "create"}`,
        name: draft.name,
        offer_only: draft.offer_only === true,
        description: draft.description.trim() || null,
        quantity,
        category_id: draft.category_id || null,
        category: draft.category_id ? null : (draft.dynamic_category.trim() || null),
        due_at: dueAt,
        recurrence_interval: recurrenceInterval,
        recurrence_unit: recurrenceInterval === null ? null : draft.recurrence_unit,
        label_ids: draft.label_ids || [],
        product_id: draft.product_id || null,
      };
      if (record) { payload.item_id = record.id; payload.completed = Boolean(draft.completed); }
      else payload.list_id = this._selectedListId;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      this._categoriesLoaded = false;
      await Promise.all([this._loadItems(), this._loadCategories(), this._loadLabels()]);
    });
  }

  async _toggleItem(itemId) {
    const item = this._findItem(itemId);
    if (!item) return;
    try {
      await haListManagerPanelTextRequest(this._hass, { type: `${API}/items/set_completed`, item_id: item.id, completed: !item.completed });
      await this._loadItems();
    } catch (error) { this._error = this._formatError(error); this._render(); }
  }

  async _saveProduct() {
    if (this._busy) return;
    const { record, draft, return_dialog: returnDialog } = this._dialog;
    draft.name = draft.name.trim();
    draft.ean = draft.ean.trim();
    if (!draft.name) return this._showDialogError(haListManagerPanelText("errors.enter_product_name", {}, this._hass));
    if (draft.ean && (!/^\d{4,32}$/.test(draft.ean))) return this._showDialogError(haListManagerPanelText("ui.ean_length_invalid", {}, this._hass));
    if ((draft.list_category_assignments || []).some((item) => !item.list_id || !item.category_id)) return this._showDialogError(haListManagerPanelText("ui.complete_list_exceptions", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/products/${record ? "update" : "create"}`,
        ean: draft.ean || null,
        name: draft.name,
        original_name: draft.original_name.trim() || null,
        brand: draft.brand.trim() || null,
        package_quantity: draft.package_quantity.trim() || null,
        category: null,
        category_ids: [
          draft.global_category_id,
          draft.shopping_category_id,
          draft.inventory_category_id,
          ...(draft.list_category_assignments || []).map((item) => item.category_id),
        ].filter(Boolean),
        image_url: draft.image_url.trim() || null,
        label_ids: draft.label_ids || [],
      };
      if (record) payload.product_id = record.id;
      const result = await haListManagerPanelTextRequest(this._hass, payload);
      this._productsLoaded = false;
      if (returnDialog && result.product) {
        returnDialog.draft.product_id = result.product.id;
        await Promise.all([this._loadInventory(), this._loadLabels(), this._refreshInfo()]);
        if (returnDialog.record) {
          returnDialog.record = this._inventoryEntries.find((entry) => entry.id === returnDialog.record.id) || returnDialog.record;
        }
        this._dialog = returnDialog;
      } else {
        this._dialog = null;
        await Promise.all([this._loadProducts(), this._loadLabels(), this._refreshInfo()]);
      }
    });
  }

  async _saveCategory() {
    if (this._busy) return;
    const { record, draft, return_dialog: returnDialog } = this._dialog;
    draft.name = draft.name.trim();
    if (!draft.name) return this._showDialogError(haListManagerPanelText("errors.category_name_required", {}, this._hass));
    if (draft.scope === "list_type" && !draft.list_type) return this._showDialogError(haListManagerPanelText("errors.select_list_type", {}, this._hass));
    if (draft.scope === "list" && !draft.list_id) return this._showDialogError(haListManagerPanelText("errors.list_required", {}, this._hass));
    const displayedPosition = draft.position === "" ? null : Number(draft.position);
    if (displayedPosition !== null && (!Number.isInteger(displayedPosition) || displayedPosition < 1 || displayedPosition > 1000001)) return this._showDialogError(haListManagerPanelText("errors.sort_position_range", {}, this._hass));
    const position = displayedPosition === null ? null : displayedPosition - 1;
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/categories/${record ? "update" : "create"}`,
        name: draft.name,
        scope: draft.scope,
        list_type: draft.scope === "list_type" ? draft.list_type : null,
        list_id: draft.scope === "list" ? draft.list_id : null,
        icon: draft.icon || null,
        color: draft.color || null,
        position,
      };
      if (record) payload.category_id = record.id;
      else payload.rules = String(draft.rules_text || "").split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean);
      const result = await haListManagerPanelTextRequest(this._hass, payload);
      this._categoriesLoaded = false;
      await Promise.all([this._loadCategories(), this._refreshInfo()]);
      if (this._selectedListId) await this._loadListAssignments(this._selectedListId, true);
      if (returnDialog && result.category) {
        returnDialog.draft.category_id = result.category.id;
        returnDialog.draft.dynamic_category = "";
        this._dialog = returnDialog;
      } else {
        this._dialog = null;
      }
    });
  }

  async _saveLabel() {
    if (this._busy) return;
    const { record, draft } = this._dialog;
    draft.name = draft.name.trim();
    if (!draft.name) return this._showDialogError(haListManagerPanelText("ui.label_name_required", {}, this._hass));
    if (draft.scope === "list" && !draft.list_id) return this._showDialogError(haListManagerPanelText("errors.list_required", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/labels/${record ? "update" : "create"}`,
        name: draft.name,
        icon: draft.icon || null,
        color: draft.color || null,
        scope: draft.scope,
        list_type: draft.scope === "list_type" ? draft.list_type : null,
        list_id: draft.scope === "list" ? draft.list_id : null,
      };
      if (record) payload.label_id = record.id;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      this._labelsLoaded = false;
      await Promise.all([this._loadLabels(), this._refreshInfo()]);
      if (this._productsLoaded) await this._loadProducts();
      if (this._selectedListId) await this._loadItems();
    });
  }

  _normalizedChipName(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase(); }

  _configureChipProductPicker() {
    const input = this.shadowRoot.querySelector("[data-chip-product-search]");
    const menu = this.shadowRoot.querySelector("[data-chip-product-options]");
    const dialog = this._dialog;
    if (!input || !menu || dialog?.kind !== "chip-editor") return;
    const renderOptions = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const products = (dialog.product_options || [])
        .filter((product) => !query || [product.name, product.brand, product.ean].some((value) => String(value || "").toLocaleLowerCase().includes(query)))
        .slice(0, 100);
      menu.innerHTML = products.length
        ? products.map((product) => `<button type="button" data-chip-product="${this._escape(product.id)}">${this._categoryProductIdentity(product)}</button>`).join("")
        : `<p class="category-product-state">${haListManagerPanelText("ui.no_matching_products", {}, this._hass)}</p>`;
      menu.hidden = false;
      menu.querySelectorAll("[data-chip-product]").forEach((button) => button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const product = (dialog.product_options || []).find((entry) => entry.id === button.dataset.chipProduct);
        if (!product) return;
        dialog.draft.product_id = product.id;
        if (!dialog.draft.name.trim()) dialog.draft.name = product.name;
        this._render();
        this.shadowRoot.querySelector("[data-chip-name]")?.focus();
      }));
    };
    input.addEventListener("focus", renderOptions);
    input.addEventListener("input", () => {
      renderOptions();
      clearTimeout(dialog.product_search_timer);
      const search = input.value.trim();
      dialog.product_search_timer = setTimeout(async () => {
        try {
          const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/products/list`, search: search || undefined, limit: 100, offset: 0 });
          if (this._dialog !== dialog || input.value.trim() !== search) return;
          dialog.product_options = result.products || [];
          renderOptions();
        } catch (_error) {}
      }, 180);
    });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 120));
  }

  _installPickerListTriggers(root = this.shadowRoot) {
    const inputSelector = "[data-category-input],[data-label-input],[data-d-category],[data-dish-category-search],[data-tandoor-category-search],[data-chip-category-combo],[data-chip-label-combo],[data-inventory-category-name],[data-inventory-product-search],[data-inventory-entry-category-search],[data-inventory-group-category-search],[data-item-category-search],[data-product-global-category],[data-product-shopping-category],[data-product-inventory-category],[data-product-exception-category]";
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
      trigger.title = haListManagerPanelText("ui.open_picker_close_keyboard", {}, this._hass);
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

  _configureTodoChipPickers() {
    const dialog = this._dialog;
    if (dialog?.kind !== "chip-editor" || dialog.draft.chip_kind !== "todo_template") return;
    const configureCombo = (inputSelector, menuSelector, optionSelector, onInput, onChoose) => {
      const input = this.shadowRoot.querySelector(inputSelector); const menu = this.shadowRoot.querySelector(menuSelector);
      if (!input || !menu) return;
      const filter = () => {
        const query = input.value.trim().toLocaleLowerCase();
        menu.querySelectorAll(optionSelector).forEach((button) => {
          const text = button.textContent.toLocaleLowerCase(); button.hidden = Boolean(query && !text.includes(query));
        });
        menu.hidden = false; input.setAttribute("aria-expanded", "true");
      };
      input.addEventListener("focus", filter);
      input.addEventListener("input", () => { onInput(input.value); filter(); });
      input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; input.setAttribute("aria-expanded", "false"); }, 120));
      menu.querySelectorAll(optionSelector).forEach((button) => button.addEventListener("mousedown", (event) => { event.preventDefault(); onChoose(button); }));
    };
    configureCombo("[data-chip-list-combo]", "[data-chip-list-options]", "[data-chip-list-option]", () => {}, (button) => { dialog.draft.list_id = button.dataset.chipListOption; this._render(); });
    configureCombo("[data-chip-category-combo]", "[data-chip-category-options]", "[data-chip-category-option]", (value) => { dialog.draft.category_id = null; dialog.draft.category_name = value; }, (button) => { const category = this._categories.find((entry) => entry.id === button.dataset.chipCategoryOption); dialog.draft.category_id = category?.id || null; dialog.draft.category_name = category?.name || ""; this._render(); });
    configureCombo("[data-chip-label-combo]", "[data-chip-label-options]", "[data-chip-label-option]", () => {}, (button) => { const id = button.dataset.chipLabelOption; if (!dialog.draft.label_ids.includes(id)) dialog.draft.label_ids.push(id); this._render(); });
    this.shadowRoot.querySelectorAll("[data-chip-remove-label]").forEach((button) => button.addEventListener("click", () => { dialog.draft.label_ids = dialog.draft.label_ids.filter((id) => id !== button.dataset.chipRemoveLabel); this._render(); }));
  }

  _chipDestinationConflict(record, draft) {
    const key = this._normalizedChipName(draft.name);
    return this._chips.find((chip) => chip.id !== record?.id
      && this._normalizedChipName(chip.name) === key
      && chip.scope === draft.scope
      && (draft.scope !== "list_type" || chip.list_type === draft.list_type)
      && (draft.scope !== "list" || chip.list_id === draft.list_id));
  }

  async _saveChip(replaceExisting = false) {
    if (this._busy) return;
    const { record, draft } = this._dialog;
    draft.name = draft.name.trim();
    if (!draft.name) return this._showDialogError(haListManagerPanelText("ui.chip_name_required", {}, this._hass));
    if (draft.scope === "list" && !draft.list_id) return this._showDialogError(haListManagerPanelText("errors.list_required", {}, this._hass));
    const isTodo = draft.chip_kind === "todo_template";
    if (isTodo && !draft.item_name.trim()) return this._showDialogError(haListManagerPanelText("errors.task_name_required", {}, this._hass));
    if (isTodo && draft.scope === "global") return this._showDialogError(haListManagerPanelText("errors.todo_global_templates", {}, this._hass));
    if (isTodo && draft.scope === "list" && this._findList(draft.list_id)?.list_type !== "todo") return this._showDialogError(haListManagerPanelText("errors.select_todo_list", {}, this._hass));
    if (!isTodo && draft.scope === "list" && this._findList(draft.list_id)?.list_type === "todo") return this._showDialogError(haListManagerPanelText("chips.todo_assignment_forbidden", {}, this._hass));
    const conflict = this._chipDestinationConflict(record, draft);
    if (record && conflict && !replaceExisting) {
      draft.conflict = conflict;
      this._render();
      return;
    }
    await this._runDialogAction(async () => {
      const payload = {
        type: `${API}/chips/${record ? "update" : "create"}`,
        name: draft.name,
        color: draft.color || null,
        chip_kind: draft.chip_kind,
        icon: draft.icon || null,
        scope: draft.scope,
        list_type: draft.scope === "list_type" ? (isTodo ? "todo" : draft.list_type) : null,
        list_id: draft.scope === "list" ? draft.list_id : null,
        product_id: isTodo ? null : draft.product_id || null,
        template_data: isTodo ? {
          item_name: draft.item_name.trim(), description: draft.description.trim() || null,
          category_id: draft.category_id || null, category_name: draft.category_id ? null : draft.category_name.trim() || null,
          label_ids: draft.label_ids || [], due_mode: draft.due_mode, due_time: draft.due_time || null,
          due_offset_value: draft.due_mode === "offset" ? Number(draft.due_offset_value) : null,
          due_offset_unit: draft.due_offset_unit, due_weekday: draft.due_mode === "next_weekday" ? Number(draft.due_weekday) : null,
          recurrence_interval: String(draft.recurrence_interval).trim() ? Number(draft.recurrence_interval) : null,
          recurrence_unit: String(draft.recurrence_interval).trim() ? draft.recurrence_unit : null,
          add_mode: draft.add_mode,
        } : null,
      };
      if (record) {
        payload.chip_id = record.id;
        payload.replace_existing = Boolean(replaceExisting);
      }
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      this._chipsLoaded = false;
      await Promise.all([this._loadChips(), this._refreshInfo()]);
    });
  }

  async _saveDish() {
    if (this._busy || this._dialog?.kind !== "dish-editor") return;
    const { record, draft } = this._dialog;
    const name = draft.name.trim();
    if (!name) return this._showDialogError(haListManagerPanelText("ui.dish_name_required", {}, this._hass));
    this._importDishItems(false);
    const items = draft.items.map((item) => ({
      name: String(item.product_id ? (item.product_name || item.name) : item.name || "").trim(), product_id: item.product_id || null,
      quantity: Number(item.quantity),
    }));
    if (!items.length) return this._showDialogError(haListManagerPanelText("ui.ingredient_required", {}, this._hass));
    if (items.some((item) => !item.name)) return this._showDialogError(haListManagerPanelText("errors.free_ingredient_name_required", {}, this._hass));
    if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000000)) return this._showDialogError(haListManagerPanelText("ui.count_range_required", {}, this._hass));
    await this._runDialogAction(async () => {
      const payload = { type: `${API}/dishes/${record ? "update" : "create"}`, name, color: draft.color || null, items };
      if (record) payload.dish_id = record.id;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      this._dishesLoaded = false;
      await this._loadDishes();
    });
  }

  async _saveInventory() {
    if (this._busy) return;
    const { record, draft, pendingScan } = this._dialog;
    const stock = Number(draft.stock);
    const minimumStock = String(draft.minimum_stock).trim() === "" ? null : Number(draft.minimum_stock);
    const restockQuantity = Number(draft.restock_quantity);
    const restockMode = draft.restock_mode || "inherit";
    if (pendingScan && !draft.product_id && !String(draft.name || "").trim()) return this._showDialogError(haListManagerPanelText("errors.enter_product_name", {}, this._hass));
    if (!pendingScan && !record && !draft.product_id) return this._showDialogError(haListManagerPanelText("errors.product_required", {}, this._hass));
    if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) return this._showDialogError(haListManagerPanelText("errors.stock_range", {}, this._hass));
    if (minimumStock !== null && (!Number.isInteger(minimumStock) || minimumStock < 0 || minimumStock > 1000000)) return this._showDialogError(haListManagerPanelText("errors.minimum_stock_range", {}, this._hass));
    if (restockMode === "fixed" && minimumStock === null) return this._showDialogError(haListManagerPanelText("errors.fixed_restock_needs_minimum", {}, this._hass));
    if (restockMode === "fixed" && (!Number.isInteger(restockQuantity) || restockQuantity < 1 || restockQuantity > 1000000)) return this._showDialogError(haListManagerPanelText("errors.fixed_restock_range", {}, this._hass));
    await this._runDialogAction(async () => {
      if (pendingScan) {
        const categoryName = String(draft.category_name || "").trim();
        const categoryId = this._matchCategoryId(categoryName, this._selectedInventoryListId) || draft.category_id || null;
        const existingProduct = this._findInventoryProduct(pendingScan.product_id) || record?.product || null;
        if (existingProduct) {
          const updateResult = await haListManagerPanelTextRequest(this._hass, {
            type: `${API}/products/update`,
            product_id: existingProduct.id,
            ean: existingProduct.ean || null,
            name: existingProduct.name,
            original_name: existingProduct.original_name || null,
            brand: existingProduct.brand || null,
            package_quantity: existingProduct.package_quantity || null,
            category: existingProduct.category || null,
            image_url: existingProduct.image_url || null,
            label_ids: draft.label_ids || [],
          });
          if (updateResult?.product) {
            const productIndex = this._products.findIndex((item) => item.id === existingProduct.id);
            if (productIndex !== -1) this._products[productIndex] = updateResult.product;
          }
        }
        const productData = pendingScan.product_id ? {} : {
          name: String(draft.name || "").trim(),
          original_name: String(draft.original_name || "").trim() || null,
          brand: String(draft.brand || "").trim() || null,
          package_quantity: String(draft.package_quantity || "").trim() || null,
          product_category: categoryName || null,
          image_url: String(draft.image_url || "").trim() || null,
          label_ids: draft.label_ids || [],
        };
        await haListManagerPanelTextRequest(this._hass, {
          type: `${API}/scanner/queue/resolve`,
          scan_id: pendingScan.id,
          corrected_stock: stock,
          minimum_stock: minimumStock,
          restock_quantity: restockQuantity,
          restock_mode: restockMode,
          category_id: categoryId,
          category: categoryId ? null : categoryName || null,
          ...productData,
        });
        this._dialog = null;
        this._scanHistoryLoaded = false;
        await Promise.all([this._loadScanHistory(), this._loadInventory()]);
        return;
      }
      const payload = {
        type: `${API}/inventory/${record ? "update" : "create"}`,
        stock,
        minimum_stock: minimumStock,
        restock_quantity: restockQuantity,
        restock_mode: restockMode,
        category_id: draft.category_id || null,
        hidden: draft.hidden === true,
      };
      if (record) payload.entry_id = record.id;
      else {
        payload.list_id = this._selectedInventoryListId;
        payload.product_id = draft.product_id;
      }
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      await this._loadInventory();
    });
  }

  async _saveInventoryGroup(moveConfirmed = false) {
    if (this._busy) return;
    const { record, draft } = this._dialog;
    const name = String(draft.name || "").trim();
    const minimumStock = String(draft.minimum_stock).trim() === "" ? null : Number(draft.minimum_stock);
    const restockQuantity = Number(draft.restock_quantity);
    const restockMode = draft.restock_mode || "inherit";
    const memberIds = [...new Set(draft.member_ids || [])];
    if (!name) return this._showDialogError(haListManagerPanelText("errors.enter_group_name", {}, this._hass));
    if (minimumStock !== null && (!Number.isInteger(minimumStock) || minimumStock < 0 || minimumStock > 1000000)) return this._showDialogError(haListManagerPanelText("errors.minimum_stock_range", {}, this._hass));
    if (restockMode === "fixed" && minimumStock === null) return this._showDialogError(haListManagerPanelText("errors.fixed_restock_needs_minimum", {}, this._hass));
    if (restockMode === "fixed" && (!Number.isInteger(restockQuantity) || restockQuantity < 1 || restockQuantity > 1000000)) return this._showDialogError(haListManagerPanelText("errors.fixed_restock_range", {}, this._hass));
    if (memberIds.length < 2) return this._showDialogError(haListManagerPanelText("ui.group_needs_two_items", {}, this._hass));
    const moveSummary = this._inventoryGroupMoveSummary(record, memberIds, draft.confirmed_move_ids || []);
    if (moveSummary && !moveConfirmed) {
      this._dialog.move_confirmation = { action: "save", ...moveSummary };
      this._render();
      return;
    }
    this._dialog.move_confirmation = "";
    await this._runDialogAction(async () => {
      const payload = { type: `${API}/inventory/groups/${record ? "update" : "create"}`, name, minimum_stock: minimumStock, restock_quantity: restockQuantity, restock_mode: restockMode, category_id: draft.category_id || null, category: null, member_ids: memberIds };
      if (record) payload.group_id = record.id; else payload.list_id = this._selectedInventoryListId;
      await haListManagerPanelTextRequest(this._hass, payload);
      this._dialog = null;
      await this._loadInventory();
    });
  }

  async _saveInventoryRestockSettings() {
    if (this._busy || this._dialog?.kind !== "inventory-restock-settings") return;
    const { draft } = this._dialog;
    const enabled = draft.enabled === true;
    const targetListId = draft.target_list_id || null;
    const mode = draft.mode || null;
    const fixedQuantity = String(draft.fixed_quantity).trim() === "" ? null : Number(draft.fixed_quantity);
    if (enabled && !targetListId) return this._showDialogError(haListManagerPanelText("errors.shopping_target_required", {}, this._hass));
    if (mode === "fixed" && fixedQuantity !== null && (!Number.isInteger(fixedQuantity) || fixedQuantity < 1 || fixedQuantity > 1000000)) return this._showDialogError(haListManagerPanelText("errors.default_quantity_range", {}, this._hass));
    await this._runDialogAction(async () => {
      const result = await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/inventory/restock/settings/set`,
        list_id: this._selectedInventoryListId,
        target_list_id: targetListId,
        enabled,
        mode,
        fixed_quantity: mode === "fixed" ? fixedQuantity : null,
      });
      this._inventoryRestockSettings = result.settings;
      this._dialog = null;
      await this._loadInventory();
    });
  }

  async _adjustInventory(entryId, delta) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const restoreScroll = () => window.scrollTo(scrollX, scrollY);
    try {
      const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/adjust`, entry_id: entryId, delta });
      const index = this._inventoryEntries.findIndex((entry) => entry.id === entryId);
      if (index !== -1) this._inventoryEntries[index] = result.entry;
      const preview = await haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/restock/preview`, list_id: this._selectedInventoryListId });
      this._inventoryRestockPreview = preview.items || [];
      this._render();
      restoreScroll();
      requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
    } catch (error) {
      this._error = this._formatError(error);
      this._render();
      restoreScroll();
      requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
    }
  }

  async _resetInventoryRestockLatch(sourceType, sourceId) {
    if (this._busy || !this._selectedInventoryListId) return;
    const dialogScrollTop = this.shadowRoot.querySelector("[data-dialog-panel]")?.scrollTop || 0;
    this._busy = true;
    this._render();
    try {
      await haListManagerPanelTextRequest(this._hass, {
        type: `${API}/inventory/restock/latch/reset`,
        list_id: this._selectedInventoryListId,
        source_type: sourceType,
        source_id: sourceId,
      });
      const preview = await haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/restock/preview`, list_id: this._selectedInventoryListId });
      this._inventoryRestockPreview = preview.items || [];
      this._error = "";
    } catch (error) {
      this._error = this._formatError(error);
    } finally {
      this._busy = false;
      this._render();
      requestAnimationFrame(() => {
        const panel = this.shadowRoot.querySelector("[data-dialog-panel]");
        if (panel) panel.scrollTop = dialogScrollTop;
      });
    }
  }

  async _refreshInfo() {
    this._info = await haListManagerPanelTextRequest(this._hass, { type: `${API}/info` });
  }

  async _confirmDelete() {
    if (this._busy) return;
    const { kind, record } = this._dialog;
    if (kind === "delete-category-rule") {
      if (record.category_id !== this._selectedCategoryId) return this._closeDialog();
      return this._replaceCategoryRules(
        this._categoryRules.filter((rule) => rule.pattern !== record.name).map((rule) => rule.pattern),
        true,
      );
    }
    await this._runDialogAction(async () => {
      if (kind === "delete-list") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/lists/delete`, list_id: record.id });
        if (this._selectedListId === record.id) this._selectedListId = null;
        this._dialog = null;
        this._loaded = false;
        await this._loadData();
      } else if (kind === "delete-item") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/items/delete`, item_id: record.id });
        this._dialog = null;
        this._categoriesLoaded = false;
        await Promise.all([this._loadItems(), this._loadCategories(), this._loadLabels()]);
      } else if (kind === "delete-category") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/categories/delete`, category_id: record.id });
        this._dialog = null;
        this._categoriesLoaded = false;
        await Promise.all([this._loadCategories(), this._refreshInfo()]);
        if (this._selectedListId) await this._loadListAssignments(this._selectedListId, true);
      } else if (kind === "delete-label") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/labels/delete`, label_id: record.id });
        this._dialog = null;
        this._labelsLoaded = false;
        await Promise.all([this._loadLabels(), this._refreshInfo()]);
        if (this._productsLoaded) await this._loadProducts();
        if (this._selectedListId) await this._loadItems();
      } else if (kind === "delete-chip") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/chips/delete`, chip_id: record.id });
        this._dialog = null;
        this._chipsLoaded = false;
        await Promise.all([this._loadChips(), this._refreshInfo()]);
      } else if (kind === "delete-dish") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/dishes/delete`, dish_id: record.id });
        this._dialog = null;
        this._dishesLoaded = false;
        await this._loadDishes();
      } else if (kind === "delete-inventory") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/delete`, entry_id: record.id });
        this._dialog = null;
        await this._loadInventory();
      } else if (kind === "delete-inventory-group") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/inventory/groups/delete`, group_id: record.id });
        this._dialog = null;
        await this._loadInventory();
      } else if (kind === "delete-scanner") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/scanners/delete`, scanner_id: record.id });
        this._dialog = null;
        this._scannersLoaded = false;
        await this._loadScanners();
      } else if (kind === "delete-notification") {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/notifications/profiles/delete`, profile_id: record.id });
        this._dialog = null;
        this._notificationStatus = "";
        await this._reloadNotifications();
      } else {
        await haListManagerPanelTextRequest(this._hass, { type: `${API}/products/delete`, product_id: record.id });
        this._dialog = null;
        this._productsLoaded = false;
        await Promise.all([this._loadProducts(), this._loadLabels(), this._refreshInfo()]);
      }
    });
  }

  async _runDialogAction(action) {
    this._busy = true;
    this._error = "";
    try { await action(); }
    catch (error) { this._error = this._formatError(error); }
    finally { this._busy = false; this._render(); }
  }

  _showDialogError(message) { this._error = message; this._render(); }
  _findList(id) { return this._lists.find((record) => record.id === id); }
  _findItem(id) { return this._items.find((record) => record.id === id); }
  _findProduct(id) { return this._products.find((record) => record.id === id); }
  _findInventoryProduct(id) {
    const choices = this._dialog?.kind === "inventory-editor" ? this._dialog.product_options || [] : [];
    return choices.find((product) => product.id === id) || this._inventoryProducts.find((product) => product.id === id) || this._findProduct(id);
  }
  _findCategory(id) { return this._categories.find((record) => record.id === id); }
  _findLabel(id) { return this._labels.find((record) => record.id === id); }
  _findChip(id) { return this._chips.find((record) => record.id === id); }
  _findDish(id) { return this._dishes.find((record) => record.id === id); }
  _findInventoryEntry(id) { return this._inventoryEntries.find((record) => record.id === id); }
  _findInventoryGroup(id) { return this._inventoryGroups.find((record) => record.id === id); }
  _renderLabelSelector(selectedIds = []) {
    const availableLabels = this._dialog?.kind === "item-editor" ? this._labelsForList(this._selectedListId) : this._labels;
    if (!availableLabels.length) return `<div class="label-selector"><span>${haListManagerPanelText("ui.labels_optional", {}, this._hass)}</span><p class="field-help">${haListManagerPanelText("ui.no_labels_in_scope", {}, this._hass)}</p></div>`;
    const selected = availableLabels.filter((label) => selectedIds.includes(label.id));
    const chips = selected.map((label) => `<button type="button" class="selected-label" data-remove-label="${this._escape(label.id)}" style="${label.color ? `--label-color:${this._escape(label.color)}` : ""}" title="${haListManagerPanelText("ui.remove_named", {p0:(this._escape(label.name))}, this._hass)}"><ha-icon icon="${this._escape(label.icon || "mdi:label-outline")}"></ha-icon><span>${this._escape(label.name)}</span><ha-icon class="remove-label" icon="mdi:close"></ha-icon></button>`).join("");
    return `<div class="label-selector"><span>${haListManagerPanelText("ui.labels_optional", {}, this._hass)}</span>${chips ? `<div class="selected-labels">${chips}</div>` : ""}<div class="label-combo"><div class="label-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="text" placeholder="${haListManagerPanelText("ui.browse_labels", {}, this._hass)}" autocomplete="off" data-label-input></div><div class="label-picker-options" data-label-options hidden></div></div></div>`;
  }
  _configureLabelSelector() {
    const input = this.shadowRoot.querySelector("[data-label-input]");
    const menu = this.shadowRoot.querySelector("[data-label-options]");
    const draft = this._dialog?.draft;
    if (!input || !menu || !draft) return;
    const availableLabels = this._dialog?.kind === "item-editor" ? this._labelsForList(this._selectedListId) : this._labels;
    draft.label_ids = [...new Set(draft.label_ids || [])];
    const choose = (label) => {
      if (!label || draft.label_ids.includes(label.id)) return;
      draft.label_ids = [...draft.label_ids, label.id];
      this._render();
    };
    const matches = () => {
      const query = input.value.trim().toLocaleLowerCase();
      return availableLabels.filter((label) => !draft.label_ids.includes(label.id) && label.name.toLocaleLowerCase().includes(query));
    };
    const renderOptions = () => {
      const available = matches();
      menu.innerHTML = available.length
        ? available.map((label) => `<button type="button" data-label-option="${this._escape(label.id)}" style="${label.color ? `--label-color:${this._escape(label.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(label.icon || "mdi:label-outline")}"></ha-icon></span><span><strong>${this._escape(label.name)}</strong><small>${this._escape(this._labelScopeText(label))}</small></span></button>`).join("")
        : `<p class="label-empty">${haListManagerPanelText("labels.no_matches", {}, this._hass)}</p>`;
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
  _renderLabelChips(labels = []) {
    if (!labels?.length) return "";
    return `<span class="label-chips">${labels.map((label) => `<span class="label-chip" style="${label.color ? `--label-color:${this._escape(label.color)}` : ""}"><ha-icon icon="${this._escape(label.icon || "mdi:label-outline")}"></ha-icon>${this._escape(label.name)}</span>`).join("")}</span>`;
  }
  _labelUsageText(label) {
    const products = Number(label.product_count || 0);
    const items = Number(label.item_count || 0);
    if (!products && !items) return haListManagerPanelText("ui.not_used_yet", {}, this._hass);
    return `${products} ${products === 1 ? haListManagerPanelText("ui.product", {}, this._hass) : haListManagerPanelText("ui.products", {}, this._hass)} · ${items} ${items === 1 ? haListManagerPanelText("ui.list_item", {}, this._hass) : haListManagerPanelText("ui.list_entries", {}, this._hass)}`;
  }
  _labelScopeText(label) {
    if (label.scope === "list") return haListManagerPanelText("ui.list_named", {p0:(this._findList(label.list_id)?.name || haListManagerPanelText("ui.no_longer_exists", {}, this._hass))}, this._hass);
    if (label.scope === "list_type") return ({ shopping: haListManagerPanelText("ui.shopping_lists", {}, this._hass), inventory: haListManagerPanelText("ui.inventory", {}, this._hass), todo: haListManagerPanelText("ui.todo", {}, this._hass) })[label.list_type] || haListManagerPanelText("ui.list_type", {}, this._hass);
    return haListManagerPanelText("ui.global", {}, this._hass);
  }
  _labelsForList(listId) {
    const list = this._findList(listId);
    if (!list) return this._labels.filter((label) => label.scope === "global");
    const type = list.list_type === "bring" ? "shopping" : list.list_type;
    const labels = this._labels.filter((label) =>
      (label.scope === "global" && list.use_global_labels !== false)
      || (label.scope === "list_type" && list.use_type_labels !== false && label.list_type === type)
      || (label.scope === "list" && label.list_id === listId)
    );
    const rank = { global: 1, list_type: 2, list: 3 };
    const selected = new Map();
    for (const label of labels) {
      const key = label.name.toLocaleLowerCase();
      if (!selected.has(key) || rank[label.scope] > rank[selected.get(key).scope]) selected.set(key, label);
    }
    return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name, haListManagerPanelTextLocale(this._hass), { sensitivity: "base" }));
  }
  _updateLocalSearch(key, selector, value, cursor) {
    this[key] = value;
    this._render();
    const field = this.shadowRoot.querySelector(selector);
    field?.focus();
    const position = Number.isInteger(cursor) ? cursor : field?.value?.length;
    field?.setSelectionRange?.(position, position);
  }
  _categoriesForList(listId) {
    const language = haListManagerPanelTextLocale(this._hass);
    const list = this._findList(listId);
    const type = list?.list_type === "bring" ? "shopping" : list?.list_type;
    const categories = this._categories.filter((category) =>
      (category.scope === "global" && list?.use_global_categories !== false)
      || (category.scope === "list_type" && list?.use_type_categories !== false && category.list_type === type)
      || (category.scope === "list" && category.list_id === listId)
    );
    const rank = { global: 1, list_type: 2, list: 3 };
    const selected = new Map();
    for (const category of categories) {
      const key = category.name.toLocaleLowerCase();
      if (!selected.has(key) || rank[category.scope] > rank[selected.get(key).scope]) selected.set(key, category);
    }
    return [...selected.values()]
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name, language, { sensitivity: "base" });
        if (byName) return byName;
        if (left.scope === right.scope) return 0;
        return left.scope === "list" ? -1 : 1;
      });
  }
  _pendingScanCategoryChoices(listId) {
    const choices = this._categoriesForList(listId).map((category) => ({ ...category, dynamic: false }));
    const knownNames = new Set(choices.map((category) => category.name.trim().toLocaleLowerCase()).filter(Boolean));
    this._dynamicCategories
      .filter((category) => category.list_id === listId)
      .forEach((category) => {
        const name = String(category.name || "").trim();
        const key = name.toLocaleLowerCase();
        if (!name || knownNames.has(key)) return;
        knownNames.add(key);
        choices.push({ id: `dynamic:${key}`, name, scope: "dynamic", dynamic: true, icon: "mdi:shape-plus-outline" });
      });
    return choices.sort((left, right) => left.name.localeCompare(right.name, haListManagerPanelTextLocale(this._hass), { sensitivity: "base" }));
  }
  _productCategoryOptions(scope, context = "") {
    const language = haListManagerPanelTextLocale(this._hass);
    return this._categories
      .filter((category) => category.scope === scope && (
        scope === "global"
        || (scope === "list_type" && category.list_type === context)
        || (scope === "list" && category.list_id === context)
      ))
      .sort((left, right) => left.name.localeCompare(right.name, language, { sensitivity: "base" }))
      .map((category) => ({
        value: category.id,
        label: category.name,
        icon: category.icon || (category.scope === "global" ? "mdi:earth" : "mdi:format-list-bulleted"),
        color: category.color || "",
        secondary: category.scope === "global"
          ? haListManagerPanelText("ui.global", {}, this._hass)
          : category.scope === "list_type"
            ? category.list_type === "shopping" ? haListManagerPanelText("ui.shopping_lists", {}, this._hass) : haListManagerPanelText("ui.inventory_lists", {}, this._hass)
            : haListManagerPanelText("ui.this_list", {}, this._hass),
      }));
  }
  _productCategoryComboMarkup(attribute, label) {
    return `<label class="field product-category-combo-field"><span>${this._escape(label)}</span><div class="category-combo"><input type="text" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" ${attribute}><div class="category-picker-options" hidden></div></div></label>`;
  }
  _productCategoryAssignmentsMarkup() {
    const draft = this._dialog?.draft || {};
    const exceptions = draft.list_category_assignments || [];
    return `<section class="product-category-assignments">
      <h4>${haListManagerPanelText("ui.category_assignment", {}, this._hass)}</h4>
      <p class="field-help">${haListManagerPanelText("help.scope_priority", {}, this._hass)}</p>
      ${this._productCategoryComboMarkup("data-product-global-category", haListManagerPanelText("ui.global", {}, this._hass))}
      <details class="product-category-overrides" ${exceptions.length || draft.shopping_category_id || draft.inventory_category_id ? "open" : ""}>
        <summary>${haListManagerPanelText("ui.differing_assignments", {}, this._hass)}</summary>
        <div class="product-type-categories">${this._productCategoryComboMarkup("data-product-shopping-category", haListManagerPanelText("ui.optional_shopping_lists", {}, this._hass))}${this._productCategoryComboMarkup("data-product-inventory-category", haListManagerPanelText("ui.optional_inventory_lists", {}, this._hass))}</div>
        <div class="product-list-exceptions">
          <strong>${haListManagerPanelText("ui.list_exceptions", {}, this._hass)}</strong>
          ${exceptions.length ? exceptions.map((assignment, index) => `<div class="product-list-exception">${this._productCategoryComboMarkup(`data-product-exception-list="${index}"`, haListManagerPanelText("ui.list", {}, this._hass))}${this._productCategoryComboMarkup(`data-product-exception-category="${index}"`, haListManagerPanelText("ui.category", {}, this._hass))}<button class="icon-button" type="button" data-remove-product-exception="${index}" title="${haListManagerPanelText("ui.remove_exception", {}, this._hass)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>`).join("") : `<p class="field-help">${haListManagerPanelText("help.no_list_exceptions", {}, this._hass)}</p>`}
          <button class="ha-button compact" type="button" data-add-product-exception><ha-icon icon="mdi:plus"></ha-icon>${haListManagerPanelText("ui.add_exception", {}, this._hass)}</button>
        </div>
      </details>
      <p class="field-help">${haListManagerPanelText("help.select_saved_categories", {}, this._hass)}</p>
    </section>`;
  }
  _configureProductCategoryPicker() {
    const draft = this._dialog?.kind === "product-editor" ? this._dialog.draft : null;
    if (!draft) return;
    const configure = (selector, options, value, handler, emptyOption = { label: haListManagerPanelText("ui.general", {}, this._hass), secondary: haListManagerPanelText("ui.no_category", {}, this._hass), icon: "mdi:shape-outline", color: "" }) => {
      const input = this.shadowRoot.querySelector(selector);
      const menu = input?.parentElement?.querySelector(".category-picker-options");
      if (!input || !menu) return;
      input.value = options.find((option) => option.value === value)?.label || "";
      const close = () => { menu.hidden = true; input.setAttribute("aria-expanded", "false"); };
      const choose = (option) => {
        value = option?.value || "";
        handler(value);
        input.value = option?.label || "";
        close();
      };
      const renderOptions = () => {
        const query = input.value.trim().toLocaleLowerCase();
        const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(query));
        const optionMarkup = (option, optionValue) => `<button type="button" data-product-combo-value="${this._escape(optionValue)}" style="${option.color ? `--label-color:${this._escape(option.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(option.icon || "mdi:shape-outline")}"></ha-icon></span><span><strong>${this._escape(option.label)}</strong><small>${this._escape(option.secondary || "")}</small></span></button>`;
        menu.innerHTML = `${emptyOption ? optionMarkup(emptyOption, "") : ""}${matches.map((option) => optionMarkup(option, option.value)).join("")}${matches.length ? "" : `<p class="picker-empty">${haListManagerPanelText("ui.no_matching_saved_category", {}, this._hass)}</p>`}`;
        menu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        menu.querySelectorAll("[data-product-combo-value]").forEach((button) => button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          choose(options.find((option) => option.value === button.dataset.productComboValue) || null);
        }));
      };
      input.addEventListener("focus", () => { input.select(); renderOptions(); });
      input.addEventListener("input", renderOptions);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { close(); return; }
        if (event.key !== "Enter") return;
        event.preventDefault();
        const query = input.value.trim().toLocaleLowerCase();
        choose(options.find((option) => option.label.toLocaleLowerCase().includes(query)) || null);
      });
      input.addEventListener("blur", () => setTimeout(() => {
        input.value = options.find((option) => option.value === value)?.label || "";
        close();
      }, 120));
    };
    configure("[data-product-global-category]", this._productCategoryOptions("global"), draft.global_category_id, (value) => { draft.global_category_id = value; });
    configure("[data-product-shopping-category]", this._productCategoryOptions("list_type", "shopping"), draft.shopping_category_id, (value) => { draft.shopping_category_id = value; });
    configure("[data-product-inventory-category]", this._productCategoryOptions("list_type", "inventory"), draft.inventory_category_id, (value) => { draft.inventory_category_id = value; });
    (draft.list_category_assignments || []).forEach((assignment, index) => {
      const usedListIds = new Set(draft.list_category_assignments.filter((_item, itemIndex) => itemIndex !== index).map((item) => item.list_id));
      const lists = this._lists.filter((list) => ["shopping", "inventory"].includes(list.list_type) && !usedListIds.has(list.id));
      configure(`[data-product-exception-list="${index}"]`, lists.map((list) => ({
        value: list.id,
        label: list.name,
        icon: list.icon || (list.list_type === "inventory" ? "mdi:package-variant-closed" : "mdi:cart-outline"),
        secondary: list.list_type === "inventory" ? haListManagerPanelText("ui.inventory_list", {}, this._hass) : haListManagerPanelText("ui.shopping_list", {}, this._hass),
      })), assignment.list_id, (value) => {
        assignment.list_id = value;
        assignment.category_id = "";
        this._render();
      }, null);
      configure(`[data-product-exception-category="${index}"]`, this._productCategoryOptions("list", assignment.list_id), assignment.category_id, (value) => { assignment.category_id = value; });
    });
    this.shadowRoot.querySelector("[data-add-product-exception]")?.addEventListener("click", () => {
      const used = new Set((draft.list_category_assignments || []).map((item) => item.list_id));
      const list = this._lists.find((item) => ["shopping", "inventory"].includes(item.list_type) && !used.has(item.id) && this._productCategoryOptions("list", item.id).length);
      if (!list) return this._showDialogError(haListManagerPanelText("categories.no_other_saved_list", {}, this._hass));
      draft.list_category_assignments.push({ list_id: list.id, category_id: "" });
      this._render();
    });
    this.shadowRoot.querySelectorAll("[data-remove-product-exception]").forEach((button) => button.addEventListener("click", () => {
      draft.list_category_assignments.splice(Number(button.dataset.removeProductException), 1);
      this._render();
    }));
  }
  _pendingScanCategoryPickerMarkup() {
    const value = this._dialog?.draft?.category_name || "";
    return `<div class="category-combo"><input type="text" maxlength="100" value="${this._escape(value)}" placeholder="${haListManagerPanelText("ui.category_search_or_create", {}, this._hass)}" autocomplete="off" data-inventory-category-name><div class="category-picker-options" data-inventory-category-options hidden></div></div>`;
  }
  _configurePendingScanCategoryPicker() {
    const picker = this.shadowRoot.querySelector("[data-inventory-category-name]");
    const menu = this.shadowRoot.querySelector("[data-inventory-category-options]");
    const draft = this._dialog?.draft;
    if (!picker || !menu || !draft) return;
    const categories = this._pendingScanCategoryChoices(this._selectedInventoryListId);
    const apply = (value, selected = null) => {
      const raw = String(value || "");
      const normalized = raw.trim();
      const match = selected || categories.find((category) => category.name.localeCompare(normalized, undefined, { sensitivity: "base" }) === 0);
      draft.category_id = match && !match.dynamic ? match.id : "";
      draft.category_name = match?.name || raw;
      picker.value = match?.name || raw;
    };
    const renderOptions = () => {
      const query = picker.value.trim().toLocaleLowerCase();
      const matches = categories.filter((category) => category.name.toLocaleLowerCase().includes(query));
      menu.innerHTML = matches.length
        ? matches.map((category) => `<button type="button" data-inventory-category-option="${this._escape(category.id)}"><ha-icon icon="${this._escape(category.icon || (category.scope === "global" ? "mdi:earth" : category.dynamic ? "mdi:shape-plus-outline" : "mdi:format-list-bulleted"))}"></ha-icon><span><strong>${this._escape(category.name)}</strong><small>${category.dynamic ? haListManagerPanelText("ui.dynamic_in_inventory", {}, this._hass) : category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : haListManagerPanelText("ui.this_list", {}, this._hass)}</small></span></button>`).join("")
        : `<p class="picker-empty">${haListManagerPanelText("categories.no_saved_match_dynamic", {}, this._hass)}</p>`;
      menu.hidden = false;
      menu.querySelectorAll("[data-inventory-category-option]").forEach((button) => button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const category = categories.find((item) => item.id === button.dataset.inventoryCategoryOption);
        apply(category?.name || "", category || null);
        menu.hidden = true;
      }));
    };
    picker.addEventListener("focus", renderOptions);
    picker.addEventListener("input", () => { apply(picker.value); renderOptions(); });
    picker.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 120));
  }
  _inventoryProductDefaultCategory(product, listId) {
    if (!product) return "";
    const list = this._findList(listId);
    const assignments = product.category_assignments || [];
    const listAssignment = assignments.find((assignment) => assignment.scope === "list" && assignment.list_id === listId);
    const typeAssignment = list?.use_type_categories === false ? null : assignments.find((assignment) => assignment.scope === "list_type" && assignment.list_type === "inventory");
    const globalAssignment = list?.use_global_categories === false ? null : assignments.find((assignment) => assignment.scope === "global");
    return listAssignment?.category?.name || typeAssignment?.category?.name || globalAssignment?.category?.name || product.category || "";
  }
  _inventoryProductOptionsMarkup(products, total = products.length) {
    const draft = this._dialog?.draft || {};
    const assigned = new Set(this._inventoryEntries.map((entry) => entry.product_id));
    const options = products.map((product) => {
      const alreadyAssigned = assigned.has(product.id);
      const details = [product.brand, product.package_quantity, product.ean ? `EAN ${product.ean}` : haListManagerPanelText("ui.without_ean", {}, this._hass)].filter(Boolean);
      const image = product.image_url
        ? `<span class="inventory-product-option-image"><img src="${this._escape(product.image_url)}" alt=""></span>`
        : `<span class="inventory-product-option-image"><ha-icon icon="mdi:barcode-scan"></ha-icon></span>`;
      return `<button type="button" class="${product.id === draft.product_id ? "picker-current" : ""}" data-inventory-product-option="${this._escape(product.id)}" data-product-search="${this._escape([product.name, ...details].join(" "))}" ${alreadyAssigned ? "disabled" : ""}>${image}<span><strong>${this._escape(product.name)}</strong><small>${this._escape(alreadyAssigned ? haListManagerPanelText("inventory.already_present", {p0:(details.join(" · "))}, this._hass) : details.join(" · "))}</small></span></button>`;
    }).join("");
    const limitNote = total > products.length ? `<p class="picker-empty inventory-product-limit-note">${haListManagerPanelText("ui.results_narrow_search", {p0:(this._escape(products.length)), p1:(this._escape(total))}, this._hass)}</p>` : "";
    return `${options || `<p class="picker-empty">${haListManagerPanelText("ui.no_matching_product", {}, this._hass)}</p>`}${limitNote}`;
  }
  _inventoryProductPickerMarkup() {
    const draft = this._dialog?.draft || {};
    const products = this._dialog?.product_options || this._inventoryProducts.slice(0, 100);
    const selected = products.find((product) => product.id === draft.product_id) || this._findInventoryProduct(draft.product_id);
    return `<label class="field"><span>${haListManagerPanelText("ui.product", {}, this._hass)}</span><div class="category-combo inventory-product-combo"><input type="text" value="${this._escape(selected?.name || "")}" placeholder="${haListManagerPanelText("ui.search_product_brand_ean", {}, this._hass)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" data-inventory-product-search><button class="inventory-product-clear" type="button" data-clear-inventory-product-search title="${haListManagerPanelText("ui.clear_product_selection_search", {}, this._hass)}" aria-label="${haListManagerPanelText("ui.clear_product_selection_search", {}, this._hass)}" ${selected ? "" : "hidden"}><ha-icon icon="mdi:close"></ha-icon></button><div class="category-picker-options inventory-product-picker-options" data-inventory-product-options hidden>${this._inventoryProductOptionsMarkup(products, this._dialog?.product_total ?? products.length)}</div></div></label>`;
  }
  _configureInventoryProductPicker() {
    const input = this.shadowRoot.querySelector("[data-inventory-product-search]");
    const menu = this.shadowRoot.querySelector("[data-inventory-product-options]");
    const clearButton = this.shadowRoot.querySelector("[data-clear-inventory-product-search]");
    const dialog = this._dialog?.kind === "inventory-editor" ? this._dialog : null;
    const draft = dialog?.draft;
    if (!input || !menu || !draft || !dialog) return;
    input.style.setProperty("padding-right", "82px", "important");
    const selectedProduct = () => (dialog.product_options || []).find((product) => product.id === draft.product_id) || this._findInventoryProduct(draft.product_id);
    const selectedName = () => selectedProduct()?.name || "";
    const bindOptions = () => {
      menu.querySelectorAll("[data-inventory-product-option]:not([disabled])").forEach((button) => button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const productId = button.dataset.inventoryProductOption || "";
        const product = (dialog.product_options || []).find((item) => item.id === productId);
        if (product && !this._inventoryProducts.some((item) => item.id === product.id)) this._inventoryProducts.push(product);
        draft.product_id = productId;
        input.value = product?.name || "";
        menu.hidden = true;
        input.setAttribute("aria-expanded", "false");
        this._render();
      }));
    };
    const renderOptions = () => {
      const products = dialog.product_options || [];
      menu.innerHTML = this._inventoryProductOptionsMarkup(products, dialog.product_total ?? products.length);
      bindOptions();
    };
    const filter = () => {
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      menu.querySelector("[data-inventory-product-empty]")?.remove();
      menu.querySelectorAll("[data-inventory-product-option]").forEach((button) => {
        const show = !query || String(button.dataset.productSearch || "").toLocaleLowerCase().includes(query);
        button.hidden = !show;
        button.style.display = show ? "" : "none";
        if (show) visible += 1;
      });
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (!visible) menu.insertAdjacentHTML("beforeend", `<p class="picker-empty" data-inventory-product-empty>${haListManagerPanelText("ui.no_matching_product", {}, this._hass)}</p>`);
    };
    input.addEventListener("focus", filter);
    input.addEventListener("input", () => {
      filter();
      if (clearButton) clearButton.hidden = !input.value;
      clearTimeout(dialog.product_search_timer);
      const search = input.value.trim();
      dialog.product_search_timer = setTimeout(async () => {
        try {
          const result = await haListManagerPanelTextRequest(this._hass, { type: `${API}/products/list`, search: search || undefined, limit: 100, offset: 0 });
          if (this._dialog !== dialog || input.value.trim() !== search) return;
          dialog.product_options = result.products || [];
          dialog.product_total = Number(result.total || dialog.product_options.length);
          renderOptions();
          menu.hidden = false;
          input.setAttribute("aria-expanded", "true");
        } catch (_error) {}
      }, 180);
    });
    input.addEventListener("blur", () => setTimeout(() => {
      menu.hidden = true;
      input.value = selectedName();
      if (clearButton) clearButton.hidden = !input.value;
      input.setAttribute("aria-expanded", "false");
    }, 120));
    clearButton?.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
    clearButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(dialog.product_search_timer);
      draft.product_id = "";
      dialog.product_options = this._inventoryProducts.slice(0, 100);
      dialog.product_total = this._inventoryProductTotal ?? dialog.product_options.length;
      this._render();
    });
    bindOptions();
  }
  _inventoryEntryCategoryPickerMarkup() {
    const draft = this._dialog?.draft || {};
    const selected = this._findCategory(draft.category_id);
    const option = (category) => {
      const selectedOption = (category?.id || "") === (draft.category_id || "");
      const name = category?.name || haListManagerPanelText("ui.use_product_default", {}, this._hass);
      const scope = !category ? haListManagerPanelText("inventory.no_own_category", {}, this._hass) : category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : category.scope === "list_type" ? haListManagerPanelText("ui.inventory", {}, this._hass) : haListManagerPanelText("ui.this_list", {}, this._hass);
      return `<button type="button" class="${selectedOption ? "picker-current" : ""}" data-inventory-entry-category-option="${this._escape(category?.id || "")}" data-category-name="${this._escape(name)}" style="${category?.color ? `--label-color:${this._escape(category.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(category?.icon || (category?.scope === "global" ? "mdi:earth" : category ? "mdi:format-list-bulleted" : "mdi:backup-restore"))}"></ha-icon></span><span><strong>${this._escape(name)}</strong><small>${scope}</small></span></button>`;
    };
    return `<label class="field"><span>${haListManagerPanelText("ui.optional_category", {}, this._hass)}</span><div class="category-combo"><input type="text" value="${this._escape(selected?.name || haListManagerPanelText("ui.use_product_default", {}, this._hass))}" placeholder="${haListManagerPanelText("ui.search_category", {}, this._hass)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" data-inventory-entry-category-search><div class="category-picker-options" data-inventory-entry-category-options hidden>${option(null)}${this._categoriesForList(this._selectedInventoryListId).map(option).join("")}</div></div></label>`;
  }
  _configureInventoryEntryCategoryPicker() {
    const input = this.shadowRoot.querySelector("[data-inventory-entry-category-search]");
    const menu = this.shadowRoot.querySelector("[data-inventory-entry-category-options]");
    const draft = this._dialog?.kind === "inventory-editor" ? this._dialog.draft : null;
    if (!input || !menu || !draft) return;
    const selectedName = () => this._findCategory(draft.category_id)?.name || haListManagerPanelText("ui.use_product_default", {}, this._hass);
    const filter = () => {
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      menu.querySelector("[data-inventory-entry-category-empty]")?.remove();
      menu.querySelectorAll("[data-inventory-entry-category-option]").forEach((button) => {
        const show = !query || String(button.dataset.categoryName || "").toLocaleLowerCase().includes(query);
        button.hidden = !show;
        button.style.display = show ? "" : "none";
        if (show) visible += 1;
      });
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (!visible) menu.insertAdjacentHTML("beforeend", `<p class="picker-empty" data-inventory-entry-category-empty>${haListManagerPanelText("ui.no_category_match", {}, this._hass)}</p>`);
    };
    input.addEventListener("focus", filter);
    input.addEventListener("input", filter);
    input.addEventListener("blur", () => setTimeout(() => {
      menu.hidden = true;
      input.value = selectedName();
      input.setAttribute("aria-expanded", "false");
    }, 120));
    menu.querySelectorAll("[data-inventory-entry-category-option]").forEach((button) => button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      draft.category_id = button.dataset.inventoryEntryCategoryOption || "";
      input.value = selectedName();
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      this._render();
    }));
  }
  _inventoryGroupCategoryPickerMarkup() {
    const draft = this._dialog?.draft || {};
    const selected = this._findCategory(draft.category_id);
    const option = (category) => {
      const selectedOption = (category?.id || "") === (draft.category_id || "");
      const scope = !category ? haListManagerPanelText("ui.no_category", {}, this._hass) : category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : category.scope === "list_type" ? haListManagerPanelText("ui.inventory", {}, this._hass) : haListManagerPanelText("ui.this_list", {}, this._hass);
      return `<button type="button" class="${selectedOption ? "picker-current" : ""}" data-inventory-group-category-option="${this._escape(category?.id || "")}" data-category-name="${this._escape(category?.name || haListManagerPanelText("ui.no_category", {}, this._hass))}" style="${category?.color ? `--label-color:${this._escape(category.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(category?.icon || (category?.scope === "global" ? "mdi:earth" : category ? "mdi:format-list-bulleted" : "mdi:shape-outline"))}"></ha-icon></span><span><strong>${this._escape(category?.name || haListManagerPanelText("ui.no_category", {}, this._hass))}</strong><small>${scope}</small></span></button>`;
    };
    return `<label class="field"><span>${haListManagerPanelText("ui.optional_category", {}, this._hass)}</span><div class="category-combo"><input type="text" value="${this._escape(selected?.name || "")}" placeholder="${haListManagerPanelText("ui.search_category", {}, this._hass)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" data-inventory-group-category-search><div class="category-picker-options" data-inventory-group-category-options hidden>${option(null)}${this._categoriesForList(this._selectedInventoryListId).map(option).join("")}</div></div></label>`;
  }
  _configureInventoryGroupCategoryPicker() {
    const input = this.shadowRoot.querySelector("[data-inventory-group-category-search]");
    const menu = this.shadowRoot.querySelector("[data-inventory-group-category-options]");
    const draft = this._dialog?.kind === "inventory-group-editor" ? this._dialog.draft : null;
    if (!input || !menu || !draft) return;
    const selectedName = () => this._findCategory(draft.category_id)?.name || "";
    const filter = () => {
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      menu.querySelector("[data-group-category-empty]")?.remove();
      menu.querySelectorAll("[data-inventory-group-category-option]").forEach((button) => {
        const show = !query || String(button.dataset.categoryName || "").toLocaleLowerCase().includes(query);
        button.hidden = !show;
        button.style.display = show ? "" : "none";
        if (show) visible += 1;
      });
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (!visible) menu.insertAdjacentHTML("beforeend", `<p class="picker-empty" data-group-category-empty>${haListManagerPanelText("ui.no_category_match", {}, this._hass)}</p>`);
    };
    input.addEventListener("focus", filter);
    input.addEventListener("input", filter);
    input.addEventListener("blur", () => setTimeout(() => {
      menu.hidden = true;
      input.value = selectedName();
      input.setAttribute("aria-expanded", "false");
    }, 120));
    menu.querySelectorAll("[data-inventory-group-category-option]").forEach((button) => button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      draft.category_id = button.dataset.inventoryGroupCategoryOption || "";
      input.value = this._findCategory(draft.category_id)?.name || "";
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      this._render();
    }));
  }
  _itemCategoryPickerMarkup(listId, selectedId) {
    const selected = this._findCategory(selectedId);
    const option = (category) => `<button type="button" data-item-category-option="${this._escape(category?.id || "")}" data-category-name="${this._escape(category?.name || haListManagerPanelText("ui.general", {}, this._hass))}" style="${category?.color ? `--category-color:${this._escape(category.color)}` : ""}"><span class="label-option-icon"><ha-icon icon="${this._escape(category?.icon || (category?.scope === "global" ? "mdi:earth" : category ? "mdi:format-list-bulleted" : "mdi:shape-outline"))}"></ha-icon></span><span><strong>${this._escape(category?.name || haListManagerPanelText("ui.general", {}, this._hass))}</strong><small>${category ? (category.scope === "global" ? haListManagerPanelText("ui.global", {}, this._hass) : haListManagerPanelText("ui.this_list", {}, this._hass)) : haListManagerPanelText("ui.no_category", {}, this._hass)}</small></span></button>`;
    return `<label class="field"><span>${haListManagerPanelText("ui.saved_category_optional", {}, this._hass)}</span><div class="category-combo"><input type="text" value="${this._escape(selected?.name || "")}" placeholder="${haListManagerPanelText("ui.search_category", {}, this._hass)}" autocomplete="off" data-item-category-search><div class="category-picker-options" data-item-category-options hidden>${option(null)}${this._categoriesForList(listId).map(option).join("")}</div></div></label>`;
  }
  _configureItemCategoryPicker() {
    const input = this.shadowRoot.querySelector("[data-item-category-search]");
    const menu = this.shadowRoot.querySelector("[data-item-category-options]");
    const draft = this._dialog?.kind === "item-editor" ? this._dialog.draft : null;
    if (!input || !menu || !draft) return;
    const filter = () => {
      const query = input.value.trim().toLocaleLowerCase();
      menu.querySelectorAll("[data-item-category-option]").forEach((button) => {
        const visible = !query || String(button.dataset.categoryName || "").toLocaleLowerCase().includes(query);
        button.hidden = !visible;
        button.style.display = visible ? "" : "none";
      });
      menu.hidden = false;
    };
    input.addEventListener("focus", filter);
    input.addEventListener("input", () => { draft.category_id = ""; filter(); });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 120));
    menu.querySelectorAll("[data-item-category-option]").forEach((button) => button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const category = this._findCategory(button.dataset.itemCategoryOption);
      draft.category_id = category?.id || "";
      draft.dynamic_category = "";
      input.value = category?.name || "";
      const dynamic = this.shadowRoot.querySelector("[data-item-dynamic-category]");
      if (dynamic) dynamic.value = "";
      const saveButton = this.shadowRoot.querySelector("[data-save-dynamic-category]");
      if (saveButton) saveButton.disabled = true;
      menu.hidden = true;
    }));
  }
  _canSaveDynamicCategory(name, listId) {
    const normalized = String(name || "").trim();
    return Boolean(normalized && !this._matchCategoryId(normalized, listId));
  }
  _matchCategoryId(name, listId) {
    if (!name) return "";
    return this._categoriesForList(listId).find((category) => category.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)?.id || "";
  }
  _heading(icon, title, text) { return `<section class="content-header"><ha-icon icon="${icon}"></ha-icon><div><h2>${title}</h2><p>${text}</p></div></section>`; }
  _overviewCard(icon, title, total, details = [], state = "") {
    const rows = details.map(([label, value]) => `<span><small>${this._escape(label)}</small><strong>${Number(value || 0)}</strong></span>`).join("");
    return `<ha-card class="overview-card ${state}"><div class="overview-card-head"><ha-icon icon="${icon}"></ha-icon><div><span>${this._escape(title)}</span><strong>${Number(total || 0)}</strong></div></div>${rows ? `<div class="overview-card-details">${rows}</div>` : ""}</ha-card>`;
  }
  _inlineError() { return this._error ? `<div class="inline-error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${this._escape(this._error)}</div>` : ""; }
  _dialogError() { return this._error ? `<div class="inline-error dialog-error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${this._escape(this._error)}</div>` : ""; }
  _loadingCard(text) { return `<ha-card class="empty-state loading"><ha-circular-progress active></ha-circular-progress><p>${text}</p></ha-card>`; }
  _formatDue(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(haListManagerPanelTextLocale(this._hass), { dateStyle: "medium", timeStyle: "short" }).format(date); }
  _bringPreviewValue(quantity, description) {
    const count = Math.max(1, Number.parseInt(quantity, 10) || 1);
    const details = String(description || "").trim();
    if (details) return count === 1 ? details : `${count} x ${details}`;
    return count === 1 ? "" : String(count);
  }
  _updateBringPreview() {
    const name = this.shadowRoot?.querySelector("[data-bring-preview-name]");
    const value = this.shadowRoot?.querySelector("[data-bring-preview-value]");
    const draft = this._dialog?.draft;
    if (!name || !value || !draft) return;
    name.textContent = draft.name.trim() || haListManagerPanelText("ui.item_name", {}, this._hass);
    const preview = this._bringPreviewValue(draft.quantity, draft.description);
    value.textContent = preview;
    value.hidden = !preview;
  }
  _formatError(error) {
    if (error?.code === "already_exists") return haListManagerPanelText("ui.list_name_exists", {}, this._hass);
    if (error?.code === "ean_already_exists") return haListManagerPanelText("ui.ean_already_assigned", {}, this._hass);
    if (error?.code === "category_already_exists") return haListManagerPanelText("errors.category_name_scope_exists", {}, this._hass);
    if (error?.code === "label_already_exists") return haListManagerPanelText("errors.label_name_exists", {}, this._hass);
    if (error?.code === "chip_already_exists") return haListManagerPanelText("ui.chip_name_exists_in_scope", {}, this._hass);
    if (error?.code === "scanner_exists") return haListManagerPanelText("errors.scanner_address_exists", {}, this._hass);
    if (error?.code === "product_not_found") return haListManagerPanelText("products.ean_data_not_found", {}, this._hass);
    if (error?.code === "lookup_unavailable") return haListManagerPanelText("ui.open_food_facts_unavailable", {}, this._hass);
    if (error?.code === "not_found") return haListManagerPanelText("errors.record_missing_reload", {}, this._hass);
    return error?.message || haListManagerPanelText("ui.request_failed", {}, this._hass);
  }
  _openFoodFactsImageUrl(value, size = "400") {
    const url = String(value || "");
    if (!/^https:\/\/(?:images|static)\.openfoodfacts\.org\//i.test(url)) return url;
    return url.replace(/\.(?:100|200|400|full)\.jpg(?=\?|$)/i, `.${size}.jpg`);
  }

  _setPageScrollLocked(locked) {
    if (!locked) {
      for (const { element, overflow, overscrollBehavior } of this._pageScrollLocks) {
        element.style.overflow = overflow;
        element.style.overscrollBehavior = overscrollBehavior;
      }
      this._pageScrollLocks = [];
      return;
    }
    if (this._pageScrollLocks.length) return;
    const candidates = new Set([document.documentElement, document.body]);
    let node = this;
    while (node) {
      if (node instanceof HTMLElement) candidates.add(node);
      const root = node.getRootNode?.();
      node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    for (const element of candidates) {
      if (!element) continue;
      const style = getComputedStyle(element);
      // In the backup view, locking overflowing but non-scrolling HA wrappers
      // clips the document to the viewport and resets its scroll position.
      if (this._activeSection === "backup" && element !== document.scrollingElement
          && !["auto", "scroll"].includes(style.overflowY)) continue;
      const scrollable = element === document.documentElement
        || element === document.body
        || ["auto", "scroll"].includes(style.overflowY)
        || element.scrollHeight > element.clientHeight + 1;
      if (!scrollable) continue;
      this._pageScrollLocks.push({
        element,
        overflow: element.style.overflow,
        overscrollBehavior: element.style.overscrollBehavior,
      });
      element.style.overflow = "hidden";
      element.style.overscrollBehavior = "none";
    }
  }

  _bindDialogScrollGuard() {
    this.shadowRoot.querySelectorAll(".dialog-backdrop").forEach((backdrop) => {
      const canScroll = (target, deltaY) => {
        let node = target instanceof Element ? target : null;
        while (node && node !== backdrop) {
          const style = getComputedStyle(node);
          const max = node.scrollHeight - node.clientHeight;
          if ((style.overflowY === "auto" || style.overflowY === "scroll") && max > 1) {
            if (deltaY < 0 && node.scrollTop > 0) return true;
            if (deltaY > 0 && node.scrollTop < max - 1) return true;
          }
          node = node.parentElement;
        }
        return false;
      };
      let previousTouchY = null;
      backdrop.addEventListener("touchstart", (event) => { previousTouchY = event.touches[0]?.clientY ?? null; }, { passive: true });
      backdrop.addEventListener("touchmove", (event) => {
        const currentY = event.touches[0]?.clientY;
        if (previousTouchY === null || currentY === undefined) { event.preventDefault(); return; }
        const deltaY = previousTouchY - currentY;
        previousTouchY = currentY;
        if (!canScroll(event.target, deltaY)) event.preventDefault();
      }, { passive: false });
      backdrop.addEventListener("wheel", (event) => { if (!canScroll(event.target, event.deltaY)) event.preventDefault(); }, { passive: false });
    });
  }

  _escape(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }
  _rgbToHex(value) {
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
    if (value && !Array.isArray(value) && typeof value === "object") value = [value.r, value.g, value.b];
    if (!Array.isArray(value) || value.length < 3) return "";
    return `#${value.slice(0, 3).map((part) => Math.max(0, Math.min(255, Number(part) || 0)).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  }

  _styles() { return `
    .legacy-import-warning-group{margin-top:10px;padding-top:10px;border-top:1px solid var(--divider-color)}.legacy-import-warning-reason{margin-top:10px}.legacy-import-warning-reason p{margin:0}.legacy-import-warning-reason ul{margin-top:6px}.legacy-import-warning-reason code{font-size:12px;overflow-wrap:anywhere;white-space:normal}.legacy-import-type-field{margin-bottom:14px}[data-legacy-inventory-help][hidden]{display:none}
    [data-legacy-input-block][hidden],[data-legacy-source-wrapper][hidden],[data-legacy-ean-section][hidden],[data-legacy-ean-source-wrapper][hidden]{display:none}.legacy-import-ean-conflicts{margin:14px 0;padding:12px;border-left:3px solid var(--warning-color,#ffa600);border-radius:6px;background:color-mix(in srgb,var(--warning-color,#ffa600) 8%,transparent)}[data-legacy-import-view] [data-legacy-source-fields][data-no-source="true"]{grid-template-columns:minmax(0,1fr)}[data-legacy-source-wrapper]{min-width:0}[data-legacy-import-view]>.content-header{padding-right:54px}[data-legacy-import-view] .settings-card{margin-top:16px}[data-legacy-import-view] p{line-height:1.5}[data-legacy-import-view] h4{margin:0 0 10px;font-size:16px}[data-legacy-import-view] h4 small{display:block;margin-top:4px;color:var(--secondary-text-color);font-weight:400}[data-legacy-import-view] .field-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:end}[data-legacy-import-view] .field-grid>.field{margin-top:0}[data-legacy-import-view] ha-selector{min-width:0}[data-legacy-import-view] .setting-row{align-items:center;border-bottom:0}[data-legacy-import-view] .setting-row input{flex:0 0 auto;width:20px;height:20px;accent-color:var(--primary-color)}.legacy-import-yaml{font-family:var(--code-font-family,monospace)!important;font-size:13px!important;line-height:1.5;tab-size:2;white-space:pre;overflow-wrap:normal;overflow:auto}.legacy-import-source,.legacy-import-preview-list{margin-top:18px;padding:14px;border:1px solid var(--divider-color);border-radius:10px;overflow-wrap:anywhere}.legacy-import-notes{margin-top:14px;padding:10px 12px;border-left:3px solid var(--warning-color,#ffa600);border-radius:6px;background:color-mix(in srgb,var(--warning-color,#ffa600) 8%,transparent)}.legacy-import-notes summary{color:var(--warning-color,#ffa600)}.legacy-import-notes ul{padding-left:20px;margin-bottom:0}.legacy-import-notes li+li{margin-top:7px}.legacy-import-preview-list>details{margin-top:12px;padding-top:10px;border-top:1px solid var(--divider-color)}[data-legacy-import-view] summary{cursor:pointer}.legacy-import-definitions,.legacy-import-item-list{display:grid;gap:9px;margin-top:12px}.legacy-import-category{display:flex;align-items:center;gap:10px}.legacy-import-color{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:8px;color:var(--import-color,var(--primary-color));background:color-mix(in srgb,var(--import-color,var(--primary-color)) 16%,transparent)}.legacy-import-category>span:last-child,.legacy-import-item-list>div{display:flex;min-width:0;flex-direction:column;gap:4px}.legacy-import-category small,.legacy-import-item-list small{color:var(--secondary-text-color);line-height:1.4}.legacy-import-chip-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.legacy-import-chip-list>span{padding:5px 9px;border:1px solid var(--divider-color);border-radius:999px;background:var(--secondary-background-color)}.legacy-import-chip-list>.field-help{flex-basis:100%}.legacy-import-file,.legacy-import-results>div{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;padding:8px 10px;border:1px solid var(--divider-color);border-radius:8px;overflow-wrap:anywhere}.legacy-import-results>div{flex-wrap:wrap}.legacy-import-file>span{min-width:0}.legacy-import-file .icon-button{flex-shrink:0}[data-legacy-feedback]:empty{display:none}[data-legacy-feedback]{margin-top:12px}@media(max-width:600px){[data-legacy-import-view] .field-grid{grid-template-columns:minmax(0,1fr)}.legacy-import-source,.legacy-import-preview-list{padding:11px}[data-legacy-import-view] .settings-inline-actions>.ha-button{max-width:100%;white-space:normal}}
    .inventory-restock-latch-notice{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;margin-top:10px;padding:11px 13px;border-left:4px solid var(--warning-color,#f0a000);border-radius:7px;background:color-mix(in srgb,var(--warning-color,#f0a000) 10%,transparent)}.inventory-restock-latch-notice>ha-icon{color:var(--warning-color,#f0a000)}.inventory-restock-latch-notice>span{display:flex;flex-direction:column;gap:3px}.inventory-restock-latch-notice small{color:var(--secondary-text-color);line-height:1.45}.inventory-restock-latch-notice .ha-button{white-space:nowrap}.inventory-restock-flag{display:inline-block;margin-left:7px;vertical-align:-3px;--mdc-icon-size:18px;color:var(--warning-color,#f0a000)}@media(max-width:600px){.inventory-restock-latch-notice{grid-template-columns:auto minmax(0,1fr)}.inventory-restock-latch-notice .ha-button{grid-column:2;justify-self:start}}
    .list-dishes-toggle{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:12px;padding:12px 14px;border-top:1px solid var(--divider-color)}.list-dishes-toggle>span{display:flex;min-width:0;flex-direction:column;gap:3px}.list-dishes-toggle small{color:var(--secondary-text-color);line-height:1.35}.dish-dialog{width:min(820px,100%)}.dish-ingredients{margin-top:20px}.dish-ingredient-header,.dish-ingredient-row{display:grid;grid-template-columns:minmax(240px,1fr) 110px 42px;align-items:center;gap:10px}.dish-ingredient-header{padding:12px 0 5px;color:var(--secondary-text-color);font-size:14px}.dish-ingredient-row{padding:9px 0;border-bottom:1px solid var(--divider-color)}.dish-ingredient-row>input{box-sizing:border-box;width:100%;min-width:0;min-height:48px;padding:12px;border:1px solid var(--divider-color);border-radius:6px;color:var(--primary-text-color);background:var(--secondary-background-color)}.dish-ingredient-product-info{display:flex;min-width:0;min-height:48px;box-sizing:border-box;flex-direction:column;justify-content:center;gap:3px;padding:5px 2px}.dish-ingredient-product-info strong,.dish-ingredient-product-info small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dish-ingredient-product-info small{color:var(--secondary-text-color);font-size:12px}.dish-ingredient-empty{margin:12px 0 4px;padding:15px;border:1px dashed var(--divider-color);border-radius:8px;color:var(--secondary-text-color);text-align:center}.dish-ingredient-actions{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:8px;margin-top:12px}.nested-dish-product-picker{z-index:1100}.dish-quick-import{margin-top:18px;padding:12px;border:1px solid var(--divider-color);border-radius:9px}.dish-quick-import summary{cursor:pointer;font-weight:500}.dish-quick-import textarea{box-sizing:border-box;width:100%;margin-top:10px;padding:10px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color);font:inherit}.dish-quick-import .ha-button{margin-top:9px}.color-input{display:flex;align-items:center;gap:10px}.color-input input{width:72px}.dish-row .category-symbol{color:var(--category-color,var(--primary-color))}@media(max-width:760px){.dish-ingredient-header,.dish-ingredient-row{grid-template-columns:minmax(0,1fr) 90px 42px}.dish-ingredient-name,.dish-ingredient-product-info{grid-column:1;grid-row:1}.dish-ingredient-quantity{grid-column:2;grid-row:1}.dish-ingredient-row>.icon-button{grid-column:3;grid-row:1}.dish-ingredient-actions{display:grid;grid-template-columns:1fr}.dish-ingredient-actions .ha-button{width:100%}.color-input{align-items:stretch;flex-direction:column}.color-input input{width:100%}}
    .chip-template-combo{position:relative}.chip-template-combo>input{width:100%}.chip-template-options{position:absolute;z-index:31;top:calc(100% + 4px);left:0;right:0;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35)}.chip-template-options>button{display:grid;grid-template-columns:30px minmax(0,1fr);align-items:center;gap:9px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.chip-template-options>button:hover{background:var(--secondary-background-color)}.chip-template-options>button>span:last-child{display:flex;min-width:0;flex-direction:column;gap:2px}.chip-template-options small{color:var(--secondary-text-color)}.chip-template-label-selector{margin-top:16px}.todo-template-recurrence{grid-template-columns:minmax(180px,1fr) minmax(180px,1fr);align-items:end}.todo-template-recurrence>.field>span{display:flex;align-items:flex-end;min-height:42px}.category-dialog textarea{box-sizing:border-box;width:100%;padding:10px 11px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color);font:inherit;resize:vertical}.chip-product-combo{position:relative}.chip-product-search{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;padding:0 10px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color)}.chip-product-search ha-icon{color:var(--secondary-text-color)}.chip-product-search input{min-height:46px;border:0;outline:0;background:transparent}.chip-product-options{position:absolute;z-index:30;top:calc(100% + 4px);left:0;right:0;max-height:280px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35)}.chip-product-options>button{display:grid;grid-template-columns:48px minmax(0,1fr);align-items:center;gap:10px;width:100%;min-height:62px;padding:7px 10px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.chip-product-options>button:hover{background:var(--secondary-background-color)}.chip-product-selected{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;border:1px solid var(--primary-color);border-radius:8px}.chip-product-selected>span{display:grid;grid-template-columns:48px minmax(0,1fr);align-items:center;gap:10px}.chip-conflict{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;margin-top:16px;padding:12px;border-left:4px solid var(--warning-color,#f0a000);border-radius:7px;background:color-mix(in srgb,var(--warning-color,#f0a000) 12%,transparent)}.chip-conflict>ha-icon{color:var(--warning-color,#f0a000)}.chip-conflict>div{display:flex;flex-direction:column;gap:6px}.chip-conflict span{color:var(--secondary-text-color);line-height:1.45}.chip-conflict>div>div{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
    :host{display:block;min-height:100%;color:var(--primary-text-color);background:var(--primary-background-color)}*{box-sizing:border-box}button,input,textarea,select{font:inherit}.page{max-width:1440px;margin:0 auto;padding:24px}.page-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.title-wrap,.heading-wrap{display:flex;align-items:center;gap:14px;min-width:0}.title-wrap>ha-icon{--mdc-icon-size:36px;color:var(--primary-color)}h1,h2,h3,p{margin:0}h1{font-size:28px;font-weight:500}.page-header p,.content-header p{color:var(--secondary-text-color);margin-top:4px}.version{font-size:12px}.release-stage{padding:6px 10px;border-radius:999px;color:var(--warning-color,#f0a000);background:color-mix(in srgb,var(--warning-color,#f0a000) 14%,transparent);font-weight:600}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:24px;align-items:start}nav{display:flex;flex-direction:column;gap:4px;padding:8px;background:var(--card-background-color);border-radius:12px}.nav-item{width:100%;display:flex;align-items:center;gap:12px;min-height:46px;padding:0 14px;border:0;border-radius:8px;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.nav-item:hover{background:var(--secondary-background-color)}.nav-item.active{color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 13%,transparent);font-weight:600}main{position:relative;min-width:0}.page-favorite-toolbar{position:absolute;z-index:4;top:0;right:0}.page-favorite-toggle{border:1px solid var(--divider-color);background:var(--card-background-color)}.page-favorite-toggle.active,.favorite-shortcut>.icon-button.active{color:#ffc107}.page-favorite-toggle:disabled{opacity:.55}.page-favorite-toolbar+.content-header,.page-favorite-toolbar+.category-product-page-header{padding-right:54px}.content-header{display:flex;align-items:center;gap:12px;margin:4px 0 20px}.content-header.with-action{justify-content:space-between}.header-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}.content-header>ha-icon,.heading-wrap>ha-icon{--mdc-icon-size:30px;color:var(--primary-color)}h2{font-size:24px;font-weight:500}ha-card{padding:18px}.list-details small,.item-open small{color:var(--secondary-text-color);font-size:14px}.empty-state{margin-top:16px}.empty-state p,.field-help{color:var(--secondary-text-color);line-height:1.55}.empty-state{min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px}.empty-state>ha-icon{--mdc-icon-size:42px;color:var(--secondary-text-color)}.list-card{padding:0;overflow:hidden}.list-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;border-bottom:1px solid var(--divider-color)}.list-row:last-child,.item-row:last-child,.product-row:last-child{border-bottom:0}.list-open{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:14px;width:100%;min-height:72px;padding:12px 8px 12px 18px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.list-open:hover,.item-open:hover,.product-open:hover{background:var(--secondary-background-color)}.list-icon,.detail-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,transparent)}.list-details{display:flex;flex-direction:column;gap:4px;min-width:0}.list-details strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chevron{color:var(--secondary-text-color)}.row-actions{display:flex;gap:2px;padding-right:8px}.icon-button{display:grid;place-items:center;width:42px;height:42px;border:0;border-radius:50%;color:var(--primary-text-color);background:transparent;cursor:pointer}.icon-button:hover{background:var(--secondary-background-color)}.icon-button.danger:hover{color:var(--error-color)}.ha-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 16px;border:1px solid var(--divider-color);border-radius:20px;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}.ha-button:hover{background:var(--secondary-background-color)}.ha-button.primary{color:var(--text-primary-color,#fff);border-color:var(--primary-color);background:var(--primary-color)}.ha-button.destructive{color:#fff;border-color:var(--error-color);background:var(--error-color)}.ha-button:disabled{opacity:.6;cursor:default}.back-button{display:inline-flex;align-items:center;gap:7px;margin:0 0 14px;padding:7px 10px;border:0;border-radius:8px;color:var(--primary-color);background:transparent;cursor:pointer}.back-button:hover{background:var(--secondary-background-color)}.inline-error{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:12px 14px;border-left:4px solid var(--error-color);background:color-mix(in srgb,var(--error-color) 10%,transparent)}.detail-icon{width:46px;height:46px}.item-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;min-height:68px;border-bottom:1px solid var(--divider-color)}.item-check{display:grid;place-items:center;width:58px;color:var(--secondary-text-color)}.item-open{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;min-height:68px;padding:11px 8px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.item-open span{color:var(--secondary-text-color);font-size:14px}.item-row.completed .item-open strong{text-decoration:line-through;color:var(--secondary-text-color)}.search-field{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:0 14px;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color)}.search-field ha-icon{color:var(--secondary-text-color)}.search-field input{width:100%;min-height:50px;border:0;outline:0;color:var(--primary-text-color);background:transparent}.product-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;min-height:82px;border-bottom:1px solid var(--divider-color)}.product-image{position:relative;display:grid;place-items:center;width:58px;height:58px;margin-left:14px;padding:0;overflow:hidden;border:0;border-radius:8px;color:var(--secondary-text-color);background:var(--secondary-background-color)}button.product-image{cursor:pointer}button.product-image:hover{outline:2px solid var(--primary-color)}.product-image img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;object-position:center}.product-open{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;min-height:80px;padding:12px 14px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.product-open small,.product-open span{color:var(--secondary-text-color);font-size:14px}.product-dialog{width:min(650px,100%)}.product-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.55);overscroll-behavior:contain;touch-action:none}.dialog{width:min(560px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:24px;border-radius:12px;color:var(--primary-text-color);background:var(--card-background-color);box-shadow:0 12px 40px rgba(0,0,0,.35);overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y}.dialog-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.dialog-close{flex:0 0 auto;margin:-8px -8px -8px 0}.dialog>p{line-height:1.5}.field{display:flex;flex-direction:column;gap:7px;margin-top:16px;color:var(--secondary-text-color)}.field input,.field textarea,.field select{width:100%;padding:12px;border:1px solid var(--divider-color);border-radius:6px;color:var(--primary-text-color);background:var(--secondary-background-color)}.field input,.field select{min-height:48px}.field textarea{resize:vertical}.field input:focus,.field textarea:focus,.field select:focus{outline:2px solid var(--primary-color);outline-offset:1px}.selector-field{display:block;margin-top:16px}.quantity-field{max-width:180px}.field-grid{display:grid;grid-template-columns:140px minmax(0,1fr);gap:14px}.field-help{margin-top:12px;font-size:14px}.bring-live-preview{display:flex;flex-direction:column;gap:4px;margin-top:12px;padding:12px 14px;border-left:3px solid var(--primary-color);border-radius:8px;background:color-mix(in srgb,var(--primary-color) 9%,var(--secondary-background-color))}.bring-live-preview>span{color:var(--secondary-text-color);font-size:13px}.bring-live-preview>strong{font-size:16px}.bring-live-preview>small{color:var(--primary-text-color);font-size:15px}.immutable-field{display:flex;flex-direction:column;gap:7px;margin-top:16px;padding:12px 14px;border:1px solid var(--divider-color);border-radius:8px;color:var(--secondary-text-color);background:var(--secondary-background-color)}.immutable-field strong{display:flex;align-items:center;gap:8px;color:var(--primary-text-color)}.immutable-field small{line-height:1.4}.dialog-error{margin-top:16px}.dialog-actions{display:flex;justify-content:flex-start;flex-wrap:wrap;gap:10px;margin-top:24px}.image-dialog{width:min(900px,100%)}.image-dialog>img{display:block;width:100%;height:auto;max-height:calc(100vh - 130px);margin:0 auto;object-fit:contain}.dynamic-category-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px}.dynamic-category-field .ha-button{margin-bottom:3px}
    [data-backup-view]>.content-header{padding-right:54px}.backup-record{margin-top:14px;padding:16px;border:1px solid var(--divider-color);border-left:4px solid var(--primary-color);border-radius:10px}.backup-record-heading{display:flex;align-items:center;gap:10px}.backup-record-heading ha-icon,.backup-origin,.backup-accent{color:var(--primary-color)}.backup-safety{border-left-color:var(--warning-color,#ffa600)}.backup-safety .backup-record-heading ha-icon,.backup-safety .backup-origin{color:var(--warning-color,#ffa600)}.backup-notice{display:flex;align-items:center;gap:10px;padding:12px 14px;border-left:3px solid var(--primary-color);border-radius:8px;background:color-mix(in srgb,var(--primary-color) 10%,transparent);line-height:1.5}.backup-notice ha-icon{flex-shrink:0;color:var(--primary-color)}.backup-success{border-color:var(--success-color,#43a047);background:color-mix(in srgb,var(--success-color,#43a047) 10%,transparent)}.backup-success ha-icon{color:var(--success-color,#43a047)}.data-backup-card .ha-button.backup-accent{color:var(--primary-color);border-color:var(--primary-color)}.backup-record strong{overflow-wrap:anywhere}.data-backup-card{margin-top:16px}.data-backup-card p{margin-top:10px}.data-backup-card .settings-inline-actions{margin-top:16px}.data-backup-card a.ha-button,[data-backup-feedback] a.ha-button{text-decoration:none}[data-backup-feedback]{margin-top:12px}[data-backup-feedback]:empty{display:none}[data-backup-feedback] .ha-button{margin-top:10px}.data-backup-card code{overflow-wrap:anywhere;white-space:normal}.data-backup-card li{margin-bottom:8px}.data-backup-card summary{cursor:pointer;color:var(--primary-color);margin-top:16px}
    .list-script-dialog{width:min(720px,100%)}.list-script-dialog input[type=checkbox]{width:20px;min-height:20px;flex:0 0 auto}.list-script-dialog .setting-row{padding:9px 0}
    .inventory-restock-dialog{width:min(680px,100%)}.inventory-restock-toggle{align-items:center}.inventory-restock-toggle input{flex:0 0 auto;width:22px;height:22px}.restock-mode-help{margin-top:16px;padding:11px 13px;border-left:4px solid var(--primary-color);border-radius:7px;background:color-mix(in srgb,var(--primary-color) 8%,transparent)}.restock-mode-help p{margin:6px 0;color:var(--secondary-text-color);font-size:14px;line-height:1.45}.inventory-restock-notice{display:flex;align-items:flex-start;gap:9px;margin-top:10px;padding:11px 13px;border-left:4px solid var(--warning-color,#f0a000);border-radius:7px;background:color-mix(in srgb,var(--warning-color,#f0a000) 10%,transparent)}.inventory-restock-notice ha-icon{flex:0 0 auto;--mdc-icon-size:21px;color:var(--warning-color,#f0a000)}.inventory-restock-notice span{line-height:1.45}.inventory-product-help{margin-top:7px}.inventory-create-product{margin-top:10px}.inventory-minimum-help{margin-top:7px}.inventory-category-help{margin-top:7px}.inventory-category-notice{display:flex;align-items:flex-start;gap:9px;margin-top:10px;padding:11px 13px;border-left:4px solid var(--primary-color);border-radius:7px;color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-color) 11%,var(--card-background-color))}.inventory-category-notice ha-icon{flex:0 0 auto;--mdc-icon-size:21px;color:var(--primary-color)}.inventory-category-notice span{line-height:1.45}.inventory-product-clear{position:absolute;z-index:5;right:43px;top:50%;display:grid;place-items:center;width:34px;height:34px;padding:0;transform:translateY(-50%);border:0;border-radius:50%;color:var(--secondary-text-color);background:transparent;cursor:pointer}.inventory-product-clear[hidden]{display:none}.inventory-product-clear:hover,.inventory-product-clear:focus-visible{color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 12%,transparent)}.inventory-product-clear ha-icon{--mdc-icon-size:21px}.inventory-dialog-product-actions{align-items:center;justify-content:space-between;flex-direction:row;gap:14px}.inventory-dialog-product-actions>span{display:flex;min-width:0;flex-direction:column;gap:4px}.category-picker-options.inventory-product-picker-options button{grid-template-columns:44px minmax(0,1fr);gap:12px;min-height:60px}.inventory-product-picker-options button:disabled{opacity:.58;cursor:default}.inventory-product-option-image{position:relative!important;display:grid!important;place-items:center;width:42px;height:42px;overflow:hidden;border-radius:7px;color:var(--secondary-text-color);background:var(--secondary-background-color)}.inventory-product-option-image img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
    .empty-state.compact{min-height:170px}.category-list-empty{padding:18px;color:var(--secondary-text-color);text-align:center}.category-page-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin:14px 0 18px}.category-specific-picker{display:grid;grid-template-columns:minmax(220px,440px);align-items:center;margin:18px 0 12px}.category-specific-heading{margin:18px 0 10px}.category-specific-heading>div{min-width:0}.category-specific-heading h3{margin:0 0 4px}.category-specific-heading p{margin:0;color:var(--secondary-text-color);line-height:1.45}.category-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;min-height:64px;border-bottom:1px solid var(--divider-color)}.category-row.definition-row{grid-template-columns:auto minmax(0,1fr) auto auto}.category-row.definition-row>.category-symbol{margin-left:14px}.category-row.definition-row>.category-open{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 14px}.category-row.definition-row>.category-open strong,.category-row.definition-row>.category-open small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.category-row.definition-row>.row-actions{grid-column:4}.category-row:last-child,.dynamic-category-row:last-child{border-bottom:0}.category-symbol{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;color:var(--category-color,var(--primary-color));background:color-mix(in srgb,var(--category-color,var(--primary-color)) 14%,transparent)}.category-open{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;gap:12px;width:100%;min-height:63px;padding:10px 14px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.category-open-copy{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:4px}.category-open-copy strong,.category-open-copy small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.category-open:hover{background:var(--secondary-background-color)}.category-open small,.dynamic-category-row small{color:var(--secondary-text-color);font-size:14px}.color-swatch{width:26px;height:26px;border:2px solid var(--divider-color);border-radius:50%;background:var(--category-color)}.color-swatch.default{display:grid;place-items:center;width:34px;height:34px;color:var(--secondary-text-color);background:transparent}.color-swatch.default ha-icon{--mdc-icon-size:22px}.dynamic-category-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:72px;padding:10px 14px 10px 18px;border-bottom:1px solid var(--divider-color)}.dynamic-category-row>div{display:flex;flex-direction:column;gap:4px;min-width:0}.color-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px}.color-field .ha-button{margin-bottom:3px}.category-product-page-header{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:14px;margin-bottom:22px}.category-product-page-header .heading-wrap{display:flex;align-items:center;gap:12px}.category-product-page-header h2{margin:0}.category-product-page-header p{margin:4px 0 0;color:var(--secondary-text-color)}.category-product-page-header .category-symbol{margin-left:0}.category-product-back{width:44px;height:44px}.category-rule-section{margin-bottom:24px}.category-rule-quick{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:9px}.category-rule-quick input{min-height:44px;padding:8px 11px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);background:var(--secondary-background-color)}.category-rule-list{margin-top:12px;border:1px solid var(--divider-color);border-radius:9px;overflow:hidden}.category-rule-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;min-height:54px;padding:5px 8px 5px 14px;border-bottom:1px solid var(--divider-color)}.category-rule-row:last-child{border-bottom:0}.category-rule-row code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--primary-text-color);font-size:15px}.category-rule-state{display:flex;align-items:center;justify-content:center;gap:8px;min-height:72px;color:var(--secondary-text-color)}.category-rule-state ha-circular-progress{width:24px;height:24px}.category-rule-empty{margin:0;padding:18px;color:var(--secondary-text-color);text-align:center}.category-products-section{margin-top:24px}.category-rules-dialog textarea,.category-dialog textarea{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);background:var(--secondary-background-color);font:inherit;resize:vertical}.category-product-page-list{padding:0;overflow:hidden}.category-product-page-row{display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:12px;min-height:76px;padding:8px 14px;border-bottom:1px solid var(--divider-color)}.category-product-page-row:last-child{border-bottom:0}.category-dialog{width:min(620px,100%)}.category-products-dialog{width:min(760px,100%)}.category-products-dialog>p{color:var(--secondary-text-color)}.category-product-search{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;margin-top:16px;padding:0 12px;border:1px solid var(--divider-color);border-radius:9px;background:var(--secondary-background-color)}.category-product-search ha-icon{color:var(--secondary-text-color)}.category-product-search input{width:100%;min-height:48px;border:0;outline:0;color:var(--primary-text-color);background:transparent}.category-product-filter{display:flex;align-items:center;gap:8px;margin:10px 2px 0;color:var(--secondary-text-color);font-size:14px;cursor:pointer}.category-product-filter input{width:18px;height:18px;margin:0;accent-color:var(--primary-color)}.category-product-results{max-height:min(31vh,300px);overflow:auto;border:1px solid var(--divider-color);border-radius:9px;overscroll-behavior:contain}.category-product-results{margin-top:8px}.category-product-result{display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;min-height:64px;padding:7px 10px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left}.category-product-result{cursor:pointer}.category-product-result:hover{background:var(--secondary-background-color)}.category-product-result.conflict{background:color-mix(in srgb,var(--warning-color,#f0a000) 7%,transparent)}.category-product-result:disabled{opacity:.72;cursor:default}.category-product-result:last-child{border-bottom:0}.category-product-image{position:relative;display:grid;place-items:center;width:44px;height:44px;overflow:hidden;border-radius:7px;color:var(--secondary-text-color);background:var(--secondary-background-color)}.category-product-image img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.category-product-copy{display:flex;min-width:0;flex-direction:column;gap:3px}.category-product-copy strong,.category-product-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.category-product-copy small{color:var(--secondary-text-color);font-size:13px}.category-product-status{display:flex;align-items:center;gap:5px;color:var(--primary-color);font-size:13px;white-space:nowrap}.category-product-status.current{color:var(--success-color,#43a047)}.category-product-status.conflict{color:var(--warning-color,#f0a000)}.category-product-status ha-icon{--mdc-icon-size:18px}.category-product-state{display:flex;align-items:center;justify-content:center;gap:9px;min-height:72px;padding:14px;color:var(--secondary-text-color);text-align:center}.category-product-state ha-circular-progress{width:24px;height:24px}.category-product-result-note{margin:0;padding:8px 10px;color:var(--secondary-text-color);font-size:12px}.inventory-toolbar{display:grid;grid-template-columns:minmax(220px,360px);margin-bottom:16px}.inventory-detail-stats{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px;margin-bottom:18px}.inventory-detail-stats ha-card{display:flex;flex-direction:column;gap:3px;padding:16px}.inventory-detail-stats strong{font-size:25px}.inventory-detail-stats span{color:var(--secondary-text-color)}.inventory-detail-stats .warning strong{color:var(--warning-color,#f0a000)}.inventory-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.detail-section{padding:18px}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.section-heading h3{margin:0 0 4px}.section-heading p{margin:0;color:var(--secondary-text-color)}.muted-copy{margin:8px 0 0;color:var(--secondary-text-color);line-height:1.5}.list-category-chips{display:flex;flex-wrap:wrap;gap:8px}.list-category-chips span{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:16px;color:var(--primary-text-color);background:color-mix(in srgb,var(--category-color,var(--primary-color)) 18%,transparent)}.list-category-chips ha-icon{--mdc-icon-size:18px;color:var(--category-color,var(--primary-color))}.dashboard-usage-list{display:grid;gap:8px}.dashboard-usage-list a{display:grid;grid-template-columns:28px minmax(0,1fr) 24px;align-items:center;gap:8px;padding:10px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);text-decoration:none}.dashboard-usage-list a:hover{border-color:var(--primary-color);background:var(--secondary-background-color)}.dashboard-usage-list a>span{display:flex;flex-direction:column;gap:3px}.dashboard-usage-list small{color:var(--secondary-text-color)}.usage-state{display:flex;align-items:center;gap:9px;min-height:50px;color:var(--secondary-text-color)}.usage-state ha-circular-progress{width:28px;height:28px}.error-text{color:var(--error-color)}.inventory-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;min-height:82px;border-bottom:1px solid var(--divider-color);border-left:4px solid transparent}.inventory-row.low{border-left-color:var(--warning-color,#f0a000)}.inventory-row.empty{border-left-color:var(--error-color)}.inventory-image{position:relative;display:grid;place-items:center;width:54px;height:54px;margin-left:12px;overflow:hidden;border-radius:8px;color:var(--secondary-text-color);background:var(--secondary-background-color)}button.inventory-image{padding:0;border:0;cursor:pointer}button.inventory-image:hover{outline:2px solid var(--primary-color)}.inventory-image img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.inventory-open{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-height:80px;padding:12px 14px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.inventory-open:hover{background:var(--secondary-background-color)}.inventory-open small,.inventory-dialog-product small{color:var(--secondary-text-color);font-size:14px}.inventory-stock{display:grid;grid-template-columns:42px minmax(38px,auto) 42px;align-items:center;text-align:center}.inventory-stock>strong{font-size:20px}.inventory-dialog-product{display:flex;flex-direction:column;gap:4px;padding:12px 0}.inventory-groups{margin-bottom:22px}.inventory-groups>h3,.inventory-products>h3{margin:0 0 6px}.inventory-groups>p{margin:0 0 10px;color:var(--secondary-text-color)}.inventory-group-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;min-height:82px;border-bottom:1px solid var(--divider-color)}.inventory-group-row .detail-icon{margin-left:12px}.group-member-list{margin-top:18px;padding:10px 14px;border:1px solid var(--divider-color);border-radius:10px}.group-member-list legend{padding:0 6px}.group-member-choice{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--divider-color)}.group-member-choice:last-child{border-bottom:0}.group-member-choice>span{display:flex;flex-direction:column}.group-member-choice small{color:var(--secondary-text-color)}.inventory-group-dialog{width:min(720px,100%)}.inventory-group-fields{display:grid;grid-template-columns:minmax(180px,1fr) minmax(0,1fr);gap:14px;align-items:end}.inventory-group-fields .selector-field{width:100%}.group-move-warning{display:flex;flex-wrap:wrap;align-items:flex-start;gap:9px;margin:7px 0 12px;padding:10px 12px;border-left:4px solid var(--warning-color,#f0a000);border-radius:6px;background:color-mix(in srgb,var(--warning-color,#f0a000) 14%,var(--card-background-color));font-size:13px;line-height:1.45}.group-move-warning ha-icon{flex:0 0 auto;color:var(--warning-color,#f0a000)}.group-move-warning>span{flex:1;min-width:0}.show-grouped-toggle{display:flex;flex:0 0 100%;align-items:center;gap:8px;margin:4px 0 0 33px;color:var(--primary-text-color)}.show-grouped-toggle input{width:18px;height:18px}.group-member-search{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;margin:0 0 9px;padding:0 10px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color)}.group-member-search input{width:100%;min-height:44px;border:0;outline:0;color:var(--primary-text-color);background:transparent}.group-member-scroll{max-height:min(45vh,430px);overflow:auto;overscroll-behavior:contain}.group-member-choice.belongs-to-group{background:color-mix(in srgb,var(--warning-color,#f0a000) 7%,transparent)}.group-member-choice .move-note{display:flex;align-items:center;gap:4px;color:var(--warning-color,#f0a000)}.group-member-choice .move-note ha-icon{--mdc-icon-size:16px}.group-result-note,.group-picker-empty{padding:10px 4px;color:var(--secondary-text-color);font-size:12px}.nested-confirmation{z-index:1100}.confirmation-dialog{width:min(480px,100%);text-align:center}.confirmation-dialog>p{margin-top:10px;color:var(--secondary-text-color);line-height:1.5}.confirmation-dialog .dialog-actions{justify-content:center}.confirmation-icon{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 12px;border-radius:50%;color:var(--warning-color,#f0a000);background:color-mix(in srgb,var(--warning-color,#f0a000) 14%,transparent)}.confirmation-icon ha-icon{--mdc-icon-size:31px}
    .scanner-requirements,.scanner-target-card,.simulation-card,.scanner-defaults{margin-top:16px}.scanner-requirements{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:start;gap:14px}.scanner-requirements>ha-icon{--mdc-icon-size:34px;color:var(--primary-color)}.scanner-requirements>div{display:flex;flex-direction:column;align-items:flex-start;gap:10px}.scanner-requirements p{color:var(--secondary-text-color);line-height:1.55}.scanner-requirements .ha-button{text-decoration:none}.scanner-default-grid,.scanner-route-fields{grid-template-columns:repeat(2,minmax(0,1fr));align-items:end}.active-target{display:flex;align-items:center;gap:14px;padding:14px;border-left:4px solid var(--success-color,#43a047);border-radius:8px;background:color-mix(in srgb,var(--success-color,#43a047) 10%,transparent)}.active-target.inactive{border-left-color:var(--secondary-text-color);background:var(--secondary-background-color)}.active-target>ha-icon{--mdc-icon-size:30px;color:var(--success-color,#43a047)}.active-target.inactive>ha-icon{color:var(--secondary-text-color)}.active-target>div{display:flex;flex:1;flex-direction:column;gap:4px}.active-target small{color:var(--secondary-text-color)}.scanner-heading{margin-top:26px}.scanner-heading>div>p{margin-top:4px}.scanner-heading code{font-size:13px}.scanner-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;min-height:82px;border-bottom:1px solid var(--divider-color)}.scanner-row:last-child,.history-row:last-child{border-bottom:0}.scanner-row.disabled{opacity:.62}.scanner-icon{display:grid;place-items:center;width:48px;height:48px;margin-left:14px;border-radius:50%;color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 13%,transparent)}.scanner-open{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-height:80px;padding:10px 14px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.scanner-open:hover{background:var(--secondary-background-color)}.scanner-open small,.scanner-open span{color:var(--secondary-text-color)}.scanner-state{margin-right:8px;padding:4px 8px;border-radius:12px;color:var(--secondary-text-color);background:var(--secondary-background-color);font-size:12px}.scanner-state.enabled{color:var(--success-color,#43a047);background:color-mix(in srgb,var(--success-color,#43a047) 12%,transparent)}.simulation-grid{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr));column-gap:16px;row-gap:20px;align-items:end}.simulation-grid>.field{margin-top:0}.scanner-route-fields{margin-top:14px}.simulation-result{display:flex;align-items:center;gap:9px;margin-top:14px;padding:11px 13px;border-left:4px solid var(--error-color);background:color-mix(in srgb,var(--error-color) 10%,transparent)}.simulation-result.success{border-left-color:var(--success-color,#43a047);background:color-mix(in srgb,var(--success-color,#43a047) 10%,transparent)}.simulation-result.warning{border-left-color:var(--warning-color,#f0a000);background:color-mix(in srgb,var(--warning-color,#f0a000) 10%,transparent)}.scan-history-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0;border-bottom:1px solid var(--divider-color)}.scan-history-tabs button{display:flex;align-items:center;gap:8px;padding:11px 16px;border:0;border-bottom:3px solid transparent;color:var(--secondary-text-color);background:transparent;cursor:pointer}.scan-history-tabs button.active{border-bottom-color:var(--primary-color);color:var(--primary-color)}.scan-history-tabs ha-icon{--mdc-icon-size:21px}.label-tabs button>span{min-width:24px;padding:2px 7px;border-radius:999px;background:var(--secondary-background-color);font-size:12px}.todo-due-fields{grid-template-columns:minmax(150px,1fr) minmax(110px,.65fr)}.todo-recurrence-fields{grid-template-columns:minmax(100px,1fr) minmax(120px,1fr)}.scan-pagination{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:14px;margin:12px 0 24px;color:var(--secondary-text-color);font-size:13px}.scan-pagination label,.scan-pagination>div{display:flex;align-items:center;gap:8px}.scan-pagination select{min-height:34px;padding:4px 28px 4px 9px;border:1px solid var(--divider-color);border-radius:6px;color:var(--primary-text-color);background:var(--card-background-color)}.scan-pagination .icon-button:disabled{opacity:.35;cursor:default}.history-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:12px;padding:14px;border-bottom:1px solid var(--divider-color)}.history-status{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;color:var(--error-color);background:color-mix(in srgb,var(--error-color) 12%,transparent)}.history-status.success{color:var(--success-color,#43a047);background:color-mix(in srgb,var(--success-color,#43a047) 12%,transparent)}.history-status.warning{color:var(--warning-color,#f0a000);background:color-mix(in srgb,var(--warning-color,#f0a000) 12%,transparent)}.history-status.neutral{color:var(--secondary-text-color);background:var(--secondary-background-color)}.history-main{display:flex;flex-direction:column;gap:3px}.history-main small,.history-main span,.history-main em{color:var(--secondary-text-color);font-size:13px}.history-main em{margin-top:3px}.history-row>code{color:var(--secondary-text-color);font-size:12px}.pending-history-row>.row-actions{display:flex;align-items:center;gap:5px}.pending-scan-notice{display:flex;align-items:flex-start;gap:11px;margin:4px 0 12px;padding:11px 13px;border-left:4px solid var(--warning-color,#f0a000);border-radius:6px;background:color-mix(in srgb,var(--warning-color,#f0a000) 12%,transparent)}.pending-scan-notice>ha-icon{color:var(--warning-color,#f0a000)}.pending-scan-notice>div{display:flex;flex-direction:column;gap:3px}.pending-scan-notice span{color:var(--secondary-text-color);font-size:13px;line-height:1.45}.compact-setting{margin-top:8px}.scanner-dialog{width:min(620px,100%)}
    .category-order-controls{display:grid;grid-template-columns:minmax(240px,360px) minmax(0,1fr);align-items:center;gap:18px;margin-bottom:14px;padding:16px}.category-order-selectors{display:grid;gap:10px}.category-order-controls label{display:flex;flex-direction:column;gap:6px;color:var(--secondary-text-color)}.category-order-controls select{min-height:46px;padding:0 12px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color)}.category-order-controls p{display:flex;align-items:flex-start;gap:9px;margin:0;color:var(--secondary-text-color);line-height:1.45}.category-order-controls p ha-icon{flex:0 0 auto;color:var(--primary-color)}.category-order-state{grid-column:1/-1;display:inline-flex;align-items:center;gap:7px;width:max-content;max-width:100%;padding:6px 10px;border-radius:16px;color:var(--secondary-text-color);background:var(--secondary-background-color);font-size:13px}.category-order-state.custom{color:var(--warning-color,#f0a000);background:color-mix(in srgb,var(--warning-color,#f0a000) 13%,transparent)}.category-order-state ha-icon{--mdc-icon-size:18px}.category-order-row{display:grid;grid-template-columns:42px 58px minmax(0,1fr) 110px 92px;align-items:center;min-height:76px;border-bottom:1px solid var(--divider-color)}.category-order-row:last-child{border-bottom:0}.category-order-row.dragging{opacity:.45}.drag-handle{display:grid;place-items:center;height:100%;color:var(--secondary-text-color);cursor:grab}.drag-handle:active{cursor:grabbing}.category-order-name{display:flex;flex-direction:column;gap:4px;min-width:0}.category-order-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.category-order-name small{color:var(--secondary-text-color)}.category-position-field{display:flex;flex-direction:column;gap:3px;color:var(--secondary-text-color);font-size:12px}.category-position-field input{width:86px;min-height:40px;padding:0 8px;border:1px solid var(--divider-color);border-radius:6px;color:var(--primary-text-color);background:var(--secondary-background-color)}.category-order-arrows{display:flex}.category-order-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
    .favorite-overview{margin:0 0 22px}.favorite-overview-heading{display:flex;align-items:center;gap:11px;margin-bottom:10px}.favorite-overview-heading>ha-icon{color:#ffc107;--mdc-icon-size:27px}.favorite-overview-heading p{margin-top:3px;color:var(--secondary-text-color)}.favorite-shortcut-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.favorite-shortcut{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;min-height:70px;border:1px solid var(--divider-color);border-radius:11px;background:var(--card-background-color);overflow:hidden}.favorite-shortcut>button:first-child{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:10px;min-height:68px;padding:9px 8px 9px 14px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.favorite-shortcut>button:first-child:hover{background:var(--secondary-background-color)}.favorite-shortcut>button:first-child>ha-icon{color:var(--primary-color)}.favorite-shortcut>button:first-child>span{display:flex;flex-direction:column;gap:3px;min-width:0}.favorite-shortcut strong,.favorite-shortcut small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.favorite-shortcut small{color:var(--secondary-text-color)}.favorite-shortcut.missing{opacity:.7}.overview-section-title{margin:26px 0 12px;font-size:18px;font-weight:600}.overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.overview-card{display:flex;flex-direction:column;gap:16px;min-height:142px}.overview-card-head{display:flex;align-items:center;gap:14px}.overview-card-head>ha-icon{--mdc-icon-size:30px;color:var(--primary-color)}.overview-card.warning .overview-card-head>ha-icon{color:var(--warning-color,#f0a000)}.overview-card-head>div{display:flex;flex:1;align-items:baseline;justify-content:space-between;gap:12px}.overview-card-head span{color:var(--secondary-text-color)}.overview-card-head strong{font-size:28px;font-weight:500}.overview-card-details{display:flex;flex-wrap:wrap;gap:8px 20px;padding-top:13px;border-top:1px solid var(--divider-color)}.overview-card-details>span{display:flex;align-items:baseline;gap:7px}.overview-card-details small{color:var(--secondary-text-color);font-size:13px}.overview-card-details strong{font-size:14px}.overview-note{display:flex;align-items:flex-start;gap:10px;margin-top:18px;padding:4px 2px;color:var(--secondary-text-color);font-size:13px;line-height:1.5}.overview-note ha-icon{flex:0 0 auto;--mdc-icon-size:19px;color:var(--primary-color)}
    .favorite-empty{min-height:150px}.list-detail-tabs{margin-bottom:18px}.list-detail-tabs button{display:inline-flex;align-items:center;gap:7px}.list-detail-tabs ha-icon{--mdc-icon-size:19px}.list-scope-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:16px}.list-scope-card{min-width:0}.list-scope-card .section-heading{align-items:center}.list-scope-card .section-heading .icon-button{flex:0 0 auto}.list-scope-pills{display:flex;flex-wrap:wrap;gap:6px}.list-scope-pills button{display:inline-flex;align-items:center;gap:5px;max-width:100%;min-height:28px;padding:3px 8px;border:1px solid color-mix(in srgb,var(--scope-color,var(--primary-color)) 45%,var(--divider-color));border-radius:15px;color:var(--primary-text-color);background:color-mix(in srgb,var(--scope-color,var(--primary-color)) 17%,transparent);font-size:12px;cursor:pointer}.list-scope-pills button:hover{border-color:var(--scope-color,var(--primary-color));background:color-mix(in srgb,var(--scope-color,var(--primary-color)) 25%,transparent)}.list-scope-pills ha-icon{flex:0 0 auto;--mdc-icon-size:15px;color:var(--scope-color,var(--primary-color))}.list-scope-pills span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.list-assignment-links{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--divider-color)}.list-assignment-links button{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:7px;width:100%;min-height:46px;padding:6px 10px;border:1px solid var(--divider-color);border-radius:23px;color:var(--secondary-text-color);background:transparent;font-size:12px;text-align:left;cursor:pointer}.list-assignment-links button:hover{border-color:var(--primary-color);color:var(--primary-color);background:var(--secondary-background-color)}.list-assignment-links ha-icon{--mdc-icon-size:16px}.list-assignment-link-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.list-assignment-link-copy>span,.list-assignment-link-copy>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.list-assignment-links strong{color:var(--primary-text-color);font-size:12px;font-weight:600}.list-overview-bottom{margin-top:0}.list-availability-matrix{display:grid;grid-template-columns:minmax(94px,1.25fr) repeat(3,minmax(64px,1fr));align-items:center;margin-top:12px;border-top:1px solid var(--divider-color);border-left:1px solid var(--divider-color);border-radius:10px;overflow:hidden}.list-availability-matrix>*{display:flex;align-items:center;justify-content:center;min-height:43px;padding:6px;border-right:1px solid var(--divider-color);border-bottom:1px solid var(--divider-color);text-align:center}.list-availability-matrix>strong[role="rowheader"]{justify-content:flex-start;padding-left:10px}.list-availability-matrix>strong[role="columnheader"]{font-size:12px;color:var(--secondary-text-color)}.list-availability-toggle{border-top:0;border-left:0;background:transparent;color:var(--secondary-text-color);cursor:pointer}.list-availability-toggle:hover{background:var(--secondary-background-color)}.list-availability-toggle ha-icon,.list-availability-own ha-icon{--mdc-icon-size:21px}.list-availability-toggle.enabled ha-icon,.list-availability-own ha-icon{color:var(--success-color,#43a047)}.list-availability-toggle.disabled ha-icon{color:var(--disabled-text-color,var(--secondary-text-color))}.list-availability-own{gap:5px}.list-availability-own strong{font-size:13px}.list-availability-help{margin:10px 0 0}.list-detail-stats{margin-top:0}
    .entity-history-row[hidden],.entity-history-list[hidden],[data-entity-history-empty][hidden]{display:none}.entity-sample-visibility{display:flex;align-items:center;gap:8px;margin:14px 0}.entity-sample-visibility input{width:18px;height:18px}.entity-sample-hidden{display:inline-flex;align-items:center;gap:5px;color:var(--warning-color,#ffb300);font-size:12px}.entity-sample-hidden ha-icon{--mdc-icon-size:17px}.sample-hidden{border-left:3px solid var(--warning-color,#ffb300);padding-left:9px}.entity-history-intro{margin-bottom:14px;border-left:4px solid var(--primary-color)}.entity-history-intro p{margin-top:5px;color:var(--secondary-text-color);line-height:1.5}.entity-history-add{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px;margin-bottom:14px}.entity-import-id{overflow-wrap:anywhere}.entity-import-status{margin:14px 0;padding:10px 12px;border-left:4px solid var(--primary-color);background:color-mix(in srgb,var(--primary-color) 10%,transparent);line-height:1.5}.entity-history-import-sources{display:flex;flex-wrap:wrap;gap:10px 22px;margin:14px 0}.entity-history-import-sources label{display:flex;align-items:center;gap:8px}.entity-history-import-sources input{width:18px;height:18px}.entity-history-list{padding:0;overflow:hidden}.dialog.entity-samples-dialog{display:flex;flex-direction:column;width:min(850px,calc(100vw - 40px))}.entity-samples-dialog>*{flex-shrink:0}.entity-samples-dialog .field-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.entity-sample-filters{margin:12px 0}.entity-sample-filters summary{cursor:pointer;color:var(--primary-color)}.entity-sample-filters[open] summary{margin-bottom:12px}@media(max-width:600px){.entity-samples-dialog .field-grid{grid-template-columns:1fr}.entity-samples-dialog .dialog-actions .ha-button{flex:1 1 auto;min-height:44px;height:auto;padding:10px 14px}}.entity-samples-list{flex:1 1 auto;min-height:0;max-height:45vh;overflow:auto;overscroll-behavior:contain;margin:16px 0}.entity-sample-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 4px;border-bottom:1px solid var(--divider-color)}.entity-sample-row>div{display:flex;min-width:0;flex-direction:column;gap:4px}.entity-sample-row strong{overflow-wrap:anywhere}.entity-sample-row small{color:var(--secondary-text-color)}.entity-sample-status{padding:12px;color:var(--success-color,#43a047)}.entity-sample-attributes{margin:14px 0}.entity-sample-attributes summary{cursor:pointer;color:var(--primary-color)}.entity-sample-attributes pre{white-space:pre-wrap;overflow-wrap:anywhere}.entity-sample-attributes textarea{width:100%;box-sizing:border-box;font:inherit}.entity-history-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:13px;min-height:86px;padding:10px 16px;border-bottom:1px solid var(--divider-color)}.entity-history-row:last-child{border-bottom:0}.entity-history-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 13%,transparent)}.entity-history-details{display:flex;min-width:0;flex-direction:column;gap:3px}.entity-history-details code,.entity-history-details small{overflow:hidden;color:var(--secondary-text-color);text-overflow:ellipsis;white-space:nowrap}.entity-history-actions{display:flex;align-items:center;gap:4px}
    .bring-sync-card{margin-bottom:16px;padding:16px 18px}.bring-sync-card.error{border-left:4px solid var(--error-color)}.bring-sync-card.syncing{border-left:4px solid var(--primary-color)}.bring-sync-header,.bring-sync-header>div{display:flex;align-items:center;gap:12px}.bring-sync-header{justify-content:space-between}.bring-sync-header>div>ha-icon{--mdc-icon-size:28px;color:var(--success-color,#43a047)}.bring-sync-card.error .bring-sync-header>div>ha-icon{color:var(--error-color)}.bring-sync-card.syncing .bring-sync-header>div>ha-icon,.bring-sync-card.never .bring-sync-header>div>ha-icon{color:var(--primary-color)}.bring-sync-header span{display:flex;flex-direction:column;gap:3px}.bring-sync-header small,.bring-sync-details small{color:var(--secondary-text-color);font-size:13px}.bring-sync-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px 24px;margin-top:16px;padding-top:15px;border-top:1px solid var(--divider-color)}.bring-sync-details>span{display:flex;flex-direction:column;gap:4px;min-width:0}.bring-sync-details strong{overflow-wrap:anywhere;font-size:14px}.bring-sync-error{display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:11px 12px;border-radius:8px;color:var(--error-color);background:color-mix(in srgb,var(--error-color) 10%,transparent);line-height:1.4}.bring-sync-error ha-icon{flex:0 0 auto;--mdc-icon-size:20px}
    @media(max-width:760px){.inventory-detail-stats{grid-template-columns:repeat(2,minmax(100px,1fr))}.inventory-detail-grid,.list-scope-grid{grid-template-columns:1fr}.simulation-grid{grid-template-columns:1fr 1fr}.page{padding:16px}.page-header{align-items:flex-start}h1{font-size:23px}.layout{display:block}nav{flex-direction:row;overflow-x:auto;margin-bottom:20px;padding:6px}nav::after{content:"";flex:0 0 calc(50vw - 48px)}.nav-item{width:auto;flex:0 0 auto;padding:0 12px}.overview-grid{grid-template-columns:1fr}.bring-sync-header{align-items:flex-start;flex-direction:column}.bring-sync-details{grid-template-columns:1fr}.release-stage{font-size:12px}.content-header.with-action{align-items:flex-start}.category-order-controls{grid-template-columns:1fr}}
    .ean-lookup-block{margin-top:16px}.ean-lookup-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px}.ean-lookup-row>.field{margin-top:0}.lookup-action{display:flex;align-items:flex-end;margin-bottom:4px}.lookup-status{display:block;margin-top:7px;font-size:13px;line-height:1.3}.lookup-status.success{color:var(--success-color,#43a047)}.lookup-status.warning{color:var(--warning-color,#f0a000)}.lookup-status.error{color:var(--error-color)}.product-dialog-top{display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:18px;align-items:start}.product-preview{position:relative;display:grid;place-items:center;width:130px;height:150px;margin-top:16px;overflow:hidden;border:1px solid var(--divider-color);border-radius:10px;color:var(--secondary-text-color);background:var(--secondary-background-color)}.product-preview img,.contained-product-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;object-position:center}.product-preview ha-icon{--mdc-icon-size:42px}.name-options{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.ha-button.compact{min-height:34px;padding:0 12px;font-size:14px}.ha-button.compact.active{color:var(--primary-color);border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,transparent)}.field input[readonly]{color:var(--secondary-text-color)}.field input.invalid{border-color:var(--error-color)}.field-error{color:var(--error-color);font-size:13px}.product-category-assignments{display:grid;gap:10px;margin-top:18px;padding:14px;border:1px solid var(--divider-color);border-radius:10px}.product-category-assignments h4{margin:0;font-size:17px}.product-category-assignments>.field-help{margin:0}.product-category-combo-field{min-width:0;margin-top:10px}.product-category-combo-field input{width:100%}.product-category-overrides{border-top:1px solid var(--divider-color);padding-top:9px}.product-category-overrides summary{cursor:pointer;color:var(--primary-text-color);font-weight:500}.product-type-categories{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;margin-top:4px}.product-list-exceptions{display:grid;gap:9px;margin-top:14px}.product-list-exception{display:grid;grid-template-columns:minmax(0,1fr) 42px;align-items:center;gap:0 8px;padding:10px;border:1px solid var(--divider-color);border-radius:8px}.product-list-exception .product-category-combo-field{grid-column:1/2}.product-list-exception .icon-button{grid-column:2;grid-row:1/3;align-self:center}.settings-card{max-width:760px}.settings-card+.settings-card{margin-top:16px}.settings-inline-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px}.settings-inline-actions .ha-button{text-decoration:none}.settings-test-status{flex-basis:100%;margin-top:2px}.settings-card>h3{margin-bottom:6px}.setting-row{display:flex;align-items:flex-start;gap:12px;padding:16px 0;border-bottom:1px solid var(--divider-color);cursor:pointer}.setting-row>span{display:flex;flex-direction:column;gap:4px}.setting-row small{color:var(--secondary-text-color);line-height:1.4}.settings-actions{margin-top:18px}.product-filters{display:grid;grid-template-columns:minmax(0,1fr) minmax(190px,280px);gap:12px;align-items:start;margin-bottom:16px}.product-filters .search-field{margin-bottom:0}.picker-trigger-host{position:relative}.picker-trigger-host input{padding-right:44px!important}.picker-list-trigger{position:absolute!important;z-index:4;right:5px;top:50%;display:grid!important;place-items:center;width:34px!important;height:34px!important;min-width:34px!important;min-height:34px!important;padding:0!important;transform:translateY(-50%);border:0!important;border-radius:50%!important;color:var(--primary-color)!important;background:transparent!important;cursor:pointer}.picker-list-trigger:hover,.picker-list-trigger:focus-visible,.picker-list-trigger.active{outline:0;background:color-mix(in srgb,var(--primary-color) 16%,transparent)!important}.picker-list-trigger ha-icon{--mdc-icon-size:21px}.picker-current{box-shadow:inset 3px 0 0 var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))!important}.category-combo{position:relative}.category-combo>input{width:100%}.category-picker-options{position:absolute;z-index:20;top:calc(100% + 4px);left:0;right:0;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35);overscroll-behavior:contain}.category-picker-options button{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;gap:8px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.category-picker-options button:hover{background:var(--secondary-background-color)}.category-picker-options button>span{display:flex;flex-direction:column;min-width:0}.category-picker-options small{color:var(--secondary-text-color)}.category-picker-options .picker-empty{padding:12px}.label-selector{display:grid;gap:8px;margin:18px 0 0;padding:12px 14px 14px;border:1px solid var(--divider-color);border-radius:10px;color:var(--secondary-text-color)}.label-selector>div{display:block}.selected-labels{display:flex!important;flex-wrap:wrap;gap:7px!important}.selected-label{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:3px 8px;border:1px solid color-mix(in srgb,var(--label-color,var(--primary-color)) 58%,var(--divider-color));border-radius:18px;color:var(--primary-text-color);background:color-mix(in srgb,var(--label-color,var(--primary-color)) 24%,var(--card-background-color));cursor:pointer}.selected-label ha-icon{--mdc-icon-size:18px;color:var(--label-color,var(--primary-color))}.selected-label .remove-label{--mdc-icon-size:17px;color:var(--secondary-text-color)}.label-combo{position:relative}.label-search{display:grid!important;grid-template-columns:26px minmax(0,1fr);align-items:center;min-height:45px;padding:0 10px;border:1px solid var(--divider-color);border-radius:7px;background:var(--secondary-background-color)}.label-search ha-icon{--mdc-icon-size:21px}.label-search input{width:100%;min-height:42px!important;padding:0!important;border:0!important;outline:0;background:transparent!important;color:var(--primary-text-color)}.label-picker-options{position:absolute;z-index:21;top:calc(100% + 4px);left:0;right:0;max-height:260px;overflow:auto;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);box-shadow:0 8px 25px rgba(0,0,0,.35);overscroll-behavior:contain}.label-picker-options button{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:8px;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--divider-color);color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.label-picker-options button>span:last-child{display:flex;min-width:0;flex-direction:column;gap:2px}.label-picker-options button small{display:block;color:var(--secondary-text-color)}.label-picker-options button:hover{background:var(--secondary-background-color)}.label-option-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;color:var(--label-color,var(--primary-color));background:color-mix(in srgb,var(--label-color,var(--primary-color)) 20%,transparent)}.label-option-icon ha-icon{--mdc-icon-size:19px}.label-empty{margin:0;padding:13px;color:var(--secondary-text-color)}.label-chips{display:flex!important;flex-wrap:wrap;gap:5px;margin-top:3px}.label-chip{display:inline-flex!important;align-items:center;gap:4px;width:auto;padding:3px 7px;border-radius:999px;color:var(--primary-text-color)!important;background:color-mix(in srgb,var(--label-color,var(--primary-color)) 18%,transparent);font-size:12px!important}.label-chip ha-icon{--mdc-icon-size:15px;color:var(--label-color,var(--primary-color))}
    .notification-section{margin-top:24px}.notification-section>h3{margin-bottom:4px}.notification-section>p{margin:0 0 12px;color:var(--secondary-text-color)}.notification-profile-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;min-height:84px}.notification-profile-row.disabled{opacity:.62}.notification-profile-icon{display:grid;place-items:center;width:48px;height:48px;margin-left:14px;border-radius:50%;color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 13%,transparent)}.notification-profile-main{display:flex;flex-direction:column;gap:3px;padding:12px 14px}.notification-profile-main small,.notification-profile-main span{color:var(--secondary-text-color)}.notification-list-card{margin-bottom:12px;padding:15px}.notification-assignment-grid{display:grid;grid-template-columns:1fr;gap:8px;margin-top:13px}.notification-assignment-choice{padding:10px 12px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color)}.notification-assignment-choice.disabled{opacity:.55}.notification-assignment-choice input{width:19px;height:19px}.notification-assignment-heading{display:flex;align-items:center;gap:10px;cursor:pointer}.notification-assignment-heading>span,.notification-inline-toggle>span{display:flex;flex-direction:column;min-width:0}.notification-assignment-choice small{color:var(--secondary-text-color)}.notification-assignment-settings{display:grid;gap:12px;margin:12px 0 2px 29px;padding-top:12px;border-top:1px solid var(--divider-color)}.notification-assignment-settings[hidden]{display:none}.notification-inline-toggle{display:flex;align-items:flex-start;gap:10px;cursor:pointer}.notification-automatic-grid{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,280px);gap:12px}.notification-automatic-grid .field{margin-top:0}.notification-delay>div{display:grid;grid-template-columns:minmax(110px,140px) auto;justify-content:start;align-items:center;gap:10px}.notification-assignment-choice .notification-delay input{width:100%;height:48px;min-width:110px}.notification-delay>div>span{color:var(--secondary-text-color)}.notification-events{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0;padding:11px 12px;border:1px solid var(--divider-color);border-radius:8px}.notification-events legend{padding:0 5px;color:var(--secondary-text-color)}.notification-events label{display:flex;align-items:center;gap:7px}.notification-events:disabled{opacity:.55}.notification-delay-help{line-height:1.4}.notification-status{display:flex;align-items:center;gap:9px;margin:12px 0;padding:11px 13px;border-left:4px solid var(--success-color,#43a047);border-radius:6px;background:color-mix(in srgb,var(--success-color,#43a047) 10%,transparent)}.notification-status ha-icon{color:var(--success-color,#43a047)}.notification-dialog{width:min(650px,100%)}.notification-dialog [data-notification-click-field][hidden],.notification-dialog [data-notification-format-help][hidden]{display:none}.notification-target-field{display:flex;flex-direction:column;gap:4px;margin-top:14px}.notification-target-field>small{min-height:18px;color:var(--secondary-text-color);font-size:12px;overflow-wrap:anywhere}.notification-message-fields{grid-template-columns:minmax(0,1fr) minmax(150px,210px)}.field select{box-sizing:border-box;width:100%;min-height:48px;padding:0 12px;border:1px solid var(--divider-color);border-radius:7px;color:var(--primary-text-color);background:var(--secondary-background-color);font:inherit}.field small{color:var(--secondary-text-color);line-height:1.4}
    .notification-list-card{padding:0;overflow:hidden}.notification-list-toggle{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;min-height:72px;padding:13px 16px;border:0;color:var(--primary-text-color);background:transparent;text-align:left;cursor:pointer}.notification-list-toggle:hover{background:var(--secondary-background-color)}.notification-list-toggle>span{display:flex;flex-direction:column;gap:4px;min-width:0}.notification-list-toggle strong{font-size:17px}.notification-list-toggle small{color:var(--secondary-text-color)}.notification-list-toggle ha-icon{flex:0 0 auto;color:var(--secondary-text-color)}.notification-list-body[hidden]{display:none}.notification-list-body{padding:0 14px 14px;border-top:1px solid var(--divider-color)}.notification-list-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding-top:12px}.notification-assignment-heading{justify-content:space-between}.notification-assignment-identity{display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer}.notification-assignment-identity>span{display:flex;flex-direction:column;min-width:0}.notification-assignment-identity small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notification-settings-toggle{flex:0 0 auto}.notification-settings-toggle ha-icon{--mdc-icon-size:19px}
    @media(max-width:520px){.inventory-dialog-product-actions{align-items:stretch;flex-direction:column}.inventory-dialog-product-actions .ha-button{width:100%}.category-row.definition-row{grid-template-columns:auto minmax(0,1fr) auto}.category-row.definition-row>.category-symbol{grid-column:1;margin-left:10px}.category-row.definition-row>.category-open{grid-column:2;display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 8px}.category-row.definition-row>.category-open strong,.category-row.definition-row>.category-open small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.category-row.definition-row>.row-actions{grid-column:3;grid-row:1;padding-right:2px}.entity-history-add{grid-template-columns:1fr}.entity-history-add .ha-button{width:100%}.entity-history-row{grid-template-columns:44px minmax(0,1fr);align-items:start;padding:12px}.entity-history-details{grid-column:2;min-width:0}.entity-history-actions{grid-column:1/3;display:flex;flex-wrap:wrap;justify-content:flex-end;width:100%;padding-top:8px}.entity-history-actions .ha-button{flex:1 1 auto}.notification-profile-row{grid-template-columns:48px minmax(0,1fr);align-items:start;padding:10px 8px}.notification-profile-icon{margin-left:0}.notification-profile-main{min-width:0;padding:4px 10px}.notification-profile-main small,.notification-profile-main span{overflow-wrap:anywhere}.notification-profile-row>.row-actions{grid-column:1/3;justify-content:flex-end;width:100%;padding:4px 0 0}.category-page-actions{flex-direction:column}.category-page-actions .ha-button{width:100%}.category-specific-picker{grid-template-columns:minmax(0,1fr)}.inventory-detail-stats{grid-template-columns:1fr 1fr}.section-heading{flex-direction:column}.list-scope-card .section-heading,.dashboard-usage-card .section-heading{display:grid;grid-template-columns:minmax(0,1fr) 42px;align-items:start;width:100%}.list-scope-card .section-heading>div,.dashboard-usage-card .section-heading>div{min-width:0;text-align:left}.list-scope-card .section-heading>.icon-button,.dashboard-usage-card .section-heading>.icon-button{grid-column:2;grid-row:1;justify-self:end;margin:0}.section-heading .ha-button{width:100%}.category-rule-quick{grid-template-columns:1fr}.category-rule-quick .ha-button{width:100%}.content-header.with-action{display:block}.content-header.with-action>.ha-button,.content-header.with-action>.header-actions{width:100%;margin-top:14px}.header-actions .ha-button{width:100%}.category-product-page-header{grid-template-columns:auto minmax(0,1fr)}.category-product-page-header>.ha-button{grid-column:1/3;width:100%}.category-product-page-row{grid-template-columns:48px minmax(0,1fr)}.category-product-page-row>.ha-button{grid-column:2;justify-self:start}.dialog{padding:20px}.dialog-actions .ha-button{flex:1}.field-grid,.scanner-default-grid,.scanner-route-fields,.product-grid,.color-field,.ean-lookup-row,.product-dialog-top,.dynamic-category-field,.product-filters,.inventory-group-fields,.simulation-grid,.notification-automatic-grid{grid-template-columns:1fr}.active-target{align-items:flex-start;flex-wrap:wrap}.active-target .ha-button{width:100%}.scanner-row{grid-template-columns:auto minmax(0,1fr) auto}.scanner-state{grid-column:2}.scanner-row>.row-actions{grid-column:3;grid-row:1/3}.history-row{grid-template-columns:auto minmax(0,1fr)}.history-row>code{grid-column:2}.product-preview{grid-row:1;width:100%;height:150px}.lookup-action,.lookup-action .ha-button,.dynamic-category-field .ha-button{width:100%;margin-bottom:0}.list-open{padding-left:12px}.row-actions{padding-right:2px}.item-check{width:46px}.product-image{width:48px;height:48px;margin-left:8px}.product-open{padding-left:10px}.category-row{grid-template-columns:minmax(0,1fr) auto}.category-row>.color-swatch{display:none}.category-row>.row-actions{grid-column:2}.dynamic-category-row{align-items:flex-start;flex-direction:column}.dynamic-category-row .ha-button{width:100%}.inventory-toolbar{grid-template-columns:1fr}.inventory-row{grid-template-columns:auto minmax(0,1fr) auto}.inventory-stock{grid-column:2;justify-content:start}.inventory-row>.row-actions{grid-column:3;grid-row:1/3}.inventory-image{width:44px;height:44px;margin-left:8px}.inventory-open{padding-left:8px}.category-order-row{grid-template-columns:34px 48px minmax(0,1fr) 76px}.category-order-row .category-symbol{width:38px;height:38px}.category-position-field input{width:68px}.category-order-arrows{grid-column:3/5;justify-content:flex-end;padding:0 6px 6px}.category-order-actions .ha-button{flex:1}.todo-due-fields{grid-template-columns:minmax(130px,1fr) minmax(90px,.65fr)}.todo-recurrence-fields{grid-template-columns:minmax(90px,1fr) minmax(110px,1fr)}}
  `; }
}

if (!customElements.get("ha-list-manager-panel")) customElements.define("ha-list-manager-panel", HaListManagerPanel);
