import "./ha-list-manager-frontend-refresh.js";
import "./ha-list-manager-dialog-sections.js?v=1.1.0b3-labels";

const API = "ha_list_manager";
const ELEMENT = "ha-list-manager-watchlist-card";
const CHANGE_EVENT = "ha_list_manager_watchlist_changed";
const DEFAULT_CARD_ICON = "mdi:filmstrip-box-multiple";
const CARD_DEFAULTS = {
  title_icon: DEFAULT_CARD_ICON,
  collapsible: true,
  start_collapsed: false,
  icon_expand: true,
  show_expand: true,
  hide_header_in_panel_and_fullscreen: false,
  remember_position: true,
};
const OFFER_FILTERS = { flatrate: "filter_my_subscriptions", free: "provider_free", ads: "provider_ads" };
const defaultView = () => ({ kind: "tv", title: "", group: false, season: null, query: "", genre: "", label: "", offers: [], filtersOpen: false, orderGroup: null, sort: "title", scroll: 0, detailScroll: 0, seasonScroll: 0 });
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const icon = name => `<ha-icon icon="mdi:${name}" aria-hidden="true"></ha-icon>`;
const labelColor = label => /^#[0-9a-f]{6}$/i.test(label.color || "") ? label.color : "";
const keyOf = title => `${title.kind}:${title.id}`;
const seen = (title, season = -1, episode = -1) =>
  title.seen?.some(([number, entry]) => number === season && entry === episode);
const released = (entry, today) => !entry.date || entry.date <= today;
const groupSeasons = title => title.seasons?.some(season => season.number > 0)
  ? title.seasons.filter(season => season.number > 0) : title.seasons || [];
const validImage = path => /^\/[A-Za-z0-9]+\.(?:jpg|jpeg|png|webp)$/.test(path || "");
const image = (path, size, fallback, eager = false) => validImage(path)
  ? `<img src="https://image.tmdb.org/t/p/${size}${escape(path)}" alt="" loading="${eager ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer">`
  : icon(fallback);

class HaListManagerWatchlistCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.config = {};
    this.library = { titles: [], collections: [], labels: [], configured: false };
    this.favoritePending = new Set();
    this.favoriteUpdates = new Map();
    this.view = defaultView();
    this.explorePages = [];
    this.availability = new Map();
    this.orderChoices = new Map();
    this.online = null;
    this.episodes = null;
    this.ready = false;
    this.busy = false;
    this.loadId = 0;
    this.seasonId = 0;
    this.searchId = 0;
    this.onVisible = () => {
      if (document.hidden) this.saveView();
      else if (this.ready) void this.loadLibrary();
    };
    this.onPageHide = () => this.saveView();
    this.onReconnect = () => { if (this.ready) void this.loadLibrary(true); };
    this.onResize = () => {
      this.queueLayout();
      for (const dropdown of this.openDropdowns()) this.syncDropdown(dropdown);
    };
    this.onFullscreenChange = () => {
      if (this.nativeFullscreen && !this.ownsFullscreen()) this.setFullscreen(false);
    };
    this.onOutsideDropdown = event => {
      for (const dropdown of this.openDropdowns()) {
        if (!event.composedPath().includes(dropdown)) dropdown.open = false;
      }
    };
    this.onEscape = event => {
      if (event.key !== "Escape") return;
      const dropdowns = this.openDropdowns();
      if (dropdowns.length) {
        event.preventDefault();
        for (const dropdown of dropdowns) dropdown.open = false;
        dropdowns[0].querySelector("summary").focus({ preventScroll: true });
        return;
      }
      if (this.shadowRoot.querySelector("dialog[open]")) return;
      if (event.composedPath().includes(this) && this.filterToggle.getAttribute("aria-expanded") === "true"
          && this.filterToggle.getClientRects().length) {
        event.preventDefault();
        this.setFiltersOpen(false);
        this.filterToggle.focus({ preventScroll: true });
        return;
      }
      if (this.fullscreen && !this.nativeFullscreen) void this.setFullscreen(false);
      else if (this.large && !this.fullscreen) this.setLarge(false);
    };
  }

  static getStubConfig() { return { type: `custom:${ELEMENT}`, ...CARD_DEFAULTS }; }

  static getConfigForm(hass) {
    const text = (key, localize) => {
      const translate = typeof localize === "function" ? localize : hass?.localize;
      return translate?.(`component.${API}.config_panel.watchlist.${key}`) || undefined;
    };
    return {
      schema: [
        { name: "card_behavior", type: "expandable", flatten: true, expanded: true, icon: "mdi:card-outline", schema: [
          { name: "title", selector: { text: {} } },
          { name: "title_icon", selector: { icon: {} }, default: CARD_DEFAULTS.title_icon },
          { name: "title_icon_color_rgb", selector: { color_rgb: {} } },
          ...["collapsible", "start_collapsed", "icon_expand", "show_expand", "hide_header_in_panel_and_fullscreen", "remember_position"]
            .map(name => ({ name, selector: { boolean: {} }, default: CARD_DEFAULTS[name] })),
        ] },
        { name: "tv_playback", type: "expandable", flatten: true, icon: "mdi:cast", schema: [
          { name: "default_player", selector: { text: {} } },
        ] },
      ],
      computeLabel: (field, localize) => text(field.name === "tv_playback" ? "play_title" : `option_${field.name}`, localize),
      computeHelper: (field, localize) => field.type === "expandable" ? undefined : text(`help_${field.name}`, localize),
    };
  }

  getCardSize() { return this.isCollapsed() ? 1 : 7; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6, min_rows: 1 }; }

  set preview(active) { this.toggleAttribute("data-edit-preview", Boolean(active)); }

  setConfig(config) {
    const previous = this.config;
    this.config = { ...CARD_DEFAULTS, ...config };
    this.toggleAttribute("data-hide-header", this.config.hide_header_in_panel_and_fullscreen === true);
    if (!this.ready || previous.start_collapsed !== this.config.start_collapsed) {
      this.collapsed = Boolean(this.config.start_collapsed);
    }
    if (this.large && !this.config.icon_expand) this.setLarge(false);
    if (this.fullscreen && !this.config.show_expand) void this.setFullscreen(false);
    this.queueLayout();
    if (this.ready) this.render();
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    if (!this.isConnected) return;
    globalThis.HaListManagerFrontendRefresh?.attach(this);
    if (!this.ready || previous?.connection !== hass.connection || previous?.user?.id !== hass.user?.id) {
      void this.start();
    } else if (previous?.language !== hass.language) {
      void this.loadTranslations(hass);
    } else if (previous?.localize !== hass.localize && this.t("title")) {
      this.render();
    }
  }

  connectedCallback() {
    if (!this.frame) this.mount();
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    document.addEventListener("keydown", this.onEscape);
    document.addEventListener("pointerdown", this.onOutsideDropdown);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this);
      this.resizeObserver.observe(this.controls);
      this.resizeObserver.observe(this.navigation);
    }
    this.queueLayout();
    if (this._hass) {
      globalThis.HaListManagerFrontendRefresh?.attach(this);
      void this.start();
    }
  }

  disconnectedCallback() {
    this.saveView();
    this.ready = false;
    this.generation = (this.generation || 0) + 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.starting = null;
    this.connection?.removeEventListener?.("ready", this.onReconnect);
    this.connection = null;
    globalThis.HaListManagerFrontendRefresh?.detach(this);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("pagehide", this.onPageHide);
    clearTimeout(this.saveTimer);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener("keydown", this.onEscape);
    document.removeEventListener("pointerdown", this.onOutsideDropdown);
    for (const dialog of this.shadowRoot.querySelectorAll("dialog[open]")) dialog.close();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = null;
    this.setLarge(false);
    void this.setFullscreen(false);
  }

  isCollapsed() { return this.config.collapsible && this.collapsed && !this.large && !this.fullscreen; }

  viewBounds() {
    for (let node = this; node; node = node.parentElement || node.getRootNode()?.host) {
      if (node.matches?.("hui-view,hui-masonry-view,hui-sections-view,hui-panel-view")) return node;
    }
    return null;
  }

  queueLayout() {
    if (!this.isConnected || this.layoutFrame != null) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = null;
      const toolbar = this.controls.hidden ? this.navigation : this.controls;
      this.frame.style.scrollPaddingTop = `${toolbar.offsetHeight}px`;
      const top = Math.max(0, this.getBoundingClientRect().top);
      const viewport = window.visualViewport?.height || window.innerHeight;
      const view = this.viewBounds();
      const panel = view?.localName === "hui-panel-view" || view?.querySelector("hui-panel-view");
      this.toggleAttribute("data-panel", Boolean(panel));
      if (panel && !this.large && !this.fullscreen) {
        this.style.setProperty("--watchlist-panel-height", `${Math.max(76, viewport - top - 12)}px`);
      }
      if (this.large) {
        const rect = view?.getBoundingClientRect();
        const bounds = rect?.width > 0
          ? { top: Math.max(0, rect.top), left: Math.max(0, rect.left), right: Math.max(0, window.innerWidth - rect.right) }
          : { top: 56, left: 0, right: 0 };
        for (const [side, value] of Object.entries(bounds)) this.style.setProperty(`--watchlist-${side}`, `${value}px`);
      }
    });
  }

  setLarge(active) {
    if (Boolean(this.large) === active) return;
    this.saveView();
    this.large = active;
    this.toggleAttribute("data-large", active);
    if (active) {
      this.previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("transitionend", this.onResize, true);
    } else {
      document.body.style.overflow = this.previousOverflow || "";
      document.removeEventListener("transitionend", this.onResize, true);
    }
    if (this.isConnected) this.renderAtSavedScroll();
    this.queueLayout();
  }

  ownsFullscreen() {
    return document.fullscreenElement === this || this.getRootNode()?.fullscreenElement === this;
  }

  async setFullscreen(active) {
    const run = this.fullscreenRun = (this.fullscreenRun || 0) + 1;
    this.saveView();
    this.fullscreen = active;
    this.toggleAttribute("data-fullscreen", active);
    if (active && this.requestFullscreen) {
      try {
        await this.requestFullscreen();
        if (run !== this.fullscreenRun || !this.isConnected) {
          if (this.ownsFullscreen() && (!this.isConnected || !this.fullscreen)) await document.exitFullscreen?.().catch(() => {});
          return;
        }
        this.nativeFullscreen = true;
      } catch { /* The fixed full-viewport view remains usable if the browser refuses native fullscreen. */ }
    } else if (!active) {
      this.nativeFullscreen = false;
      if (this.ownsFullscreen()) await document.exitFullscreen?.().catch(() => {});
    }
    if (run === this.fullscreenRun && this.isConnected) this.renderAtSavedScroll();
    this.queueLayout();
  }

  renderAtSavedScroll() {
    this.render();
    this.frame.scrollTop = this.view[this.scrollKey()];
  }

  t(key, values = {}) {
    return this._hass?.localize?.(`component.${API}.config_panel.watchlist.${key}`, values) || "";
  }

  ws(action, params = {}) {
    const language = this._hass.locale?.language || this._hass.language || "en";
    return this._hass.callWS({ type: `${API}/watchlist/${action}`, language, ...params });
  }

  async loadTranslations(hass) {
    try {
      await hass.loadBackendTranslation?.("config_panel", API);
    } catch {
      await hass.loadBackendTranslation?.("config_panel").catch(() => {});
    }
    if (this._hass?.language === hass.language && this.isConnected) this.render();
  }

  async start() {
    if (this.starting === this._hass.connection && this.starting) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const generation = this.generation = (this.generation || 0) + 1;
    this.exploreDialog.close();
    this.progressDialog.close();
    this.availability.clear();
    this.orderChoices.clear();
    const hass = this._hass;
    this.starting = hass.connection;
    this.connection?.removeEventListener?.("ready", this.onReconnect);
    this.connection = hass.connection;
    this.connection?.addEventListener?.("ready", this.onReconnect);
    try {
      this.restoreView();
      this.allFavorites = false;
      this.favoritePending.clear();
      this.favoriteUpdates.clear();
      this.ready = true;
      this.online = null;
      this.onlinePending = false;
      this.busy = false;
      this.actionError = "";
      this.episodes = null;
      await this.loadTranslations(hass);
      if (this.generation !== generation) return;
      void this.loadLibrary(true);
      const unsubscribe = await hass.connection?.subscribeMessage?.(
        event => {
          if (this.generation !== generation) return;
          const update = event?.data?.favorite_update;
          if (update) this.applyFavoriteUpdate(update);
          else void this.loadLibrary().then(() => {
            if (event?.data?.sync && this.generation === generation && this.view.season === null && this.view.orderGroup === null)
              void this.loadAvailability(this.current());
          });
        },
        { type: `${API}/subscribe`, event_type: CHANGE_EVENT },
      );
      if (this.generation !== generation) unsubscribe?.();
      else {
        this.unsubscribe = unsubscribe;
        // Catch a mutation that landed between the first read and subscription.
        if (unsubscribe) void this.loadLibrary(true);
      }
    } catch {
      // The card can still be refreshed manually if live updates are unavailable.
    } finally {
      if (this.generation === generation) this.starting = null;
    }
  }

  async loadLibrary(restore = false) {
    const id = ++this.loadId;
    const generation = this.generation;
    const updates = new Map();
    this.favoriteUpdates = updates;
    try {
      const value = await this.ws("state");
      if (id !== this.loadId || generation !== this.generation) return;
      this.libraryError = "";
      this.applyLibrary(value, updates);
      if (restore) {
        const seasons = this.current()?.seasons || [];
        if (this.view.season !== null && !seasons.some(season => season.number === this.view.season)) this.view.season = null;
        if (this.view.season !== null && this.episodes === null) void this.loadSeason();
        if (this.view.season === null) void this.loadAvailability(this.current());
        this.frame.scrollTop = this.view[this.scrollKey()];
      }
    } catch (error) {
      if (id !== this.loadId || generation !== this.generation) return;
      this.libraryError = error?.message || this.t("load_failed");
      this.render();
    }
  }

  applyLibrary(data, updates) {
    const regionChanged = this.library.region !== data.region;
    this.library = data;
    if (updates) {
      for (const [key, update] of updates) {
        const title = this.findTitle(key);
        if (title) Object.assign(title, update);
      }
    }
    if (this.view.orderGroup !== null && !this.current()?.episode_order?.groups?.[this.view.orderGroup]) this.view.orderGroup = null;
    if (!data.configured || !data.region) this.view.offers = [];
    if (!data.preferences?.show_all_favorites) this.allFavorites = false;
    this.libraryLoaded = true;
    if (this.view.group) {
      const collection = this.current()?.collection;
      if (collection) this.view.title = `collection:${collection.id}`;
      this.view.group = false;
    }
    if (this.view.title && !this.current()) {
      this.view.title = "";
      this.view.group = false;
      this.view.season = null;
      this.view.detailScroll = 0;
    }
    this.render();
    this.paintAvailability();
    if (regionChanged) {
      const title = this.current();
      if (title && this.view.season === null) void this.loadAvailability(title);
      const preview = this.explorePages.at(-1);
      if (preview?.type === "preview" && preview.data) void this.loadAvailability(preview.data);
    }
  }

  get storageKey() {
    return `${ELEMENT}:${this._hass?.user?.id || ""}:${location.pathname}:${this.config.title || ""}`;
  }

  restoreView() {
    this.view = defaultView();
    this.collapsed = Boolean(this.config.start_collapsed);
    if (!this.config.remember_position) return;
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) || "null");
      if (saved && ["tv", "movie", "favorites"].includes(saved.kind)) {
        Object.assign(this.view, saved);
        if (saved.season !== null && saved.seasonScroll === undefined) {
          this.view.seasonScroll = saved.detailScroll || 0;
          this.view.detailScroll = 0;
        }
      }
      const collapsed = localStorage.getItem(`${this.storageKey}:collapsed`);
      if (collapsed === "0" || collapsed === "1") this.collapsed = collapsed === "1";
    } catch { /* Browser storage can be disabled. */ }
  }

  scrollKey() {
    return !this.view.title ? "scroll" : this.view.season === null && this.view.orderGroup === null ? "detailScroll" : "seasonScroll";
  }

  resetLibraryScroll() {
    this.view.scroll = this.frame.scrollTop = Math.min(this.frame.scrollTop, this.frame.querySelector("header").offsetHeight);
  }

  saveView() {
    clearTimeout(this.saveTimer);
    if (!this.ready || !this.body) return;
    if (!this.isCollapsed() && (this.view.season === null || this.episodes !== null)) this.view[this.scrollKey()] = this.frame.scrollTop;
    if (!this.config.remember_position) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.view));
    } catch { /* The shared watchlist remains usable without browser storage. */ }
  }

  mount() {
    this.shadowRoot.innerHTML = `<style>${STYLE}${globalThis.HaListManagerDialogSections.confirmationIconStyles()}</style><ha-card></ha-card><dialog class="label-dialog">
      <header><h3 id="watchlist-label-title"></h3><button type="button" data-action="cancel-labels" class="icon-button">${icon("close")}</button></header>
      <div class="label-dialog-body"><input type="search" data-label-search><div class="label-options"></div>
        <div class="label-error error" role="status"></div></div>
      <div class="label-dialog-actions actions"><button type="button" data-action="apply-labels" class="primary"></button>
        <button type="button" data-action="cancel-labels"></button></div>
    </dialog><dialog class="watchlist-dialog remove-dialog" role="alertdialog" aria-labelledby="watchlist-remove-title"
      aria-describedby="watchlist-remove-message"></dialog>
    <dialog class="watchlist-dialog progress-dialog" role="alertdialog" aria-labelledby="watchlist-progress-title"
      aria-describedby="watchlist-progress-message"></dialog>
    <dialog class="watchlist-dialog image-dialog" aria-labelledby="watchlist-image-title"></dialog>
    <dialog class="watchlist-dialog explore-dialog" aria-labelledby="watchlist-explore-title"></dialog>`;
    this.removeDialog = this.shadowRoot.querySelector(".remove-dialog");
    this.progressDialog = this.shadowRoot.querySelector(".progress-dialog");
    this.imageDialog = this.shadowRoot.querySelector(".image-dialog");
    this.exploreDialog = this.shadowRoot.querySelector(".explore-dialog");
    this.exploreDialog.addEventListener("click", event => this.handleExploreClick(event));
    this.exploreDialog.addEventListener("input", event => {
      if (event.target.matches("[data-dialog-search]")) this.filterExplore(event.target);
    });
    this.exploreDialog.addEventListener("scroll", () => {
      for (const dropdown of this.openDropdowns()) this.syncDropdown(dropdown);
    }, true);
    this.exploreDialog.addEventListener("change", event => {
      const { target } = event;
      const page = this.explorePages.at(-1);
      if (!target.matches("[data-provider-id]") || page?.type !== "subscriptions") return;
      const id = Number(target.dataset.providerId);
      if (target.checked) page.draft.add(id);
      else page.draft.delete(id);
    });
    this.exploreDialog.addEventListener("close", () => {
      if (this.exploreDialog.open) return;
      this.explorePages = [];
      this.exploreDialog.replaceChildren();
      const trigger = this.exploreTrigger;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else if (trigger?.hasAttribute("data-availability-trigger")) {
        this.frame.querySelector("[data-availability-trigger]")?.focus({ preventScroll: true });
      }
      else if (trigger?.dataset.action === "subscriptions") {
        this.frame.querySelector('[data-action="subscriptions"]')?.focus({ preventScroll: true });
      }
      this.exploreTrigger = null;
    });
    this.mountMediaDialogs();
    this.labelDialog = this.shadowRoot.querySelector("dialog");
    this.labelDialog.setAttribute("aria-labelledby", "watchlist-label-title");
    this.labelDialog.addEventListener("click", event => this.handleLabelDialog(event));
    this.labelDialog.addEventListener("cancel", event => { if (this.busy) event.preventDefault(); });
    this.labelDialog.addEventListener("close", () => {
      if (this.labelDialog.open) return;
      this.labelDraft = null;
      if (!this.isConnected) return;
      if (this.actionError) {
        this.actionError = "";
        this.render();
      }
      const trigger = this.body.querySelector(".title-menu summary, .section-heading [data-action=edit-labels]");
      trigger?.focus({ preventScroll: true });
    });
    this.labelDialog.querySelector("[data-label-search]").addEventListener("input", () => this.renderLabelDialog());
    this.card = this.shadowRoot.querySelector("ha-card");
    this.frame = document.createElement("section");
    this.frame.className = "frame";
    this.frame.innerHTML = `<header></header><nav class="detail-navigation" hidden></nav><div class="controls">
      <nav></nav><form class="search">${this.searchField("", "local_search")}
        <button class="online" type="submit"></button>
        <button class="filter-toggle" type="button" aria-controls="watchlist-filters" aria-expanded="false">${icon("filter-variant")}</button></form>
      <span class="toolbar-fullscreen"></span>
      <div class="filters" id="watchlist-filters"><label class="favorites-switch" hidden><input type="checkbox" data-all-favorites><span></span></label>
        <select data-filter="sort"></select>
        <select data-filter="genre"></select><details class="label-filter">
        <summary></summary><div class="label-filter-options" popover="manual"></div></details><div class="offer-filters" hidden></div></div>
    </div><div class="notice" role="status" aria-live="polite"></div><div class="body"></div>`;
    this.favoriteNotice = document.createElement("div");
    this.favoriteNotice.className = "favorite-notice";
    this.favoriteNotice.setAttribute("role", "status");
    this.card.append(this.frame, this.favoriteNotice);
    this.body = this.frame.querySelector(".body");
    this.navigation = this.frame.querySelector(".detail-navigation");
    this.labelFilter = this.frame.querySelector(".label-filter");
    this.shadowRoot.addEventListener("toggle", event => {
      if (!event.target.matches?.(".label-filter, details.title-menu, details.availability-menu")) return;
      if (!event.target.open && event.target.matches(".title-menu")) this.setMenuPage(event.target, false);
      this.syncDropdown(event.target);
    }, true);
    this.controls = this.frame.querySelector(".controls");
    this.filters = this.controls.querySelector(".filters");
    this.filterToggle = this.controls.querySelector(".filter-toggle");
    this.filterToggle.addEventListener("click", () => {
      this.setFiltersOpen(!this.view.filtersOpen);
    });
    this.input = this.controls.querySelector(".search-input input");
    this.clearSearch = this.controls.querySelector(".clear-search");
    this.frame.addEventListener("click", event => this.handleClick(event));
    this.frame.addEventListener("change", event => this.handleChange(event));
    this.frame.addEventListener("error", event => {
      if (event.target.tagName === "IMG") event.target.hidden = true;
    }, true);
    const updateSearch = () => {
      this.view.query = this.input.value;
      this.resetLibraryScroll();
      this.online = null;
      this.onlinePending = false;
      this.searchId++;
      this.render();
      this.saveView();
    };
    this.input.addEventListener("input", updateSearch);
    this.clearSearch.addEventListener("click", () => {
      this.resetSearch(this.input, updateSearch);
    });
    this.frame.querySelector("form").addEventListener("submit", event => {
      event.preventDefault();
      void this.search();
    });
    this.frame.addEventListener("scroll", () => {
      for (const dropdown of this.openDropdowns()) this.syncDropdown(dropdown);
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveView(), 100);
    }, { passive: true });

  }

  mountMediaDialogs() {
    this.progressDialog.addEventListener("cancel", event => { if (this.busy) event.preventDefault(); });
    this.progressDialog.addEventListener("click", async event => {
      if (this.busy) return;
      const action = event.target.closest("button")?.dataset.action;
      if (action === "cancel-progress") this.progressDialog.close();
      if (action !== "confirm-progress" || !this.progressConfirmation) return;
      const { command, title, params } = this.progressConfirmation;
      const button = event.target.closest("button");
      button.disabled = true;
      if (await this.mutate(command, title, params)) this.progressDialog.close();
      else {
        button.disabled = false;
        this.progressDialog.querySelector("[data-progress-error]").textContent = this.actionError;
      }
    });
    this.progressDialog.addEventListener("close", () => {
      const trigger = this.progressConfirmation?.trigger;
      this.progressConfirmation = null;
      const fallback = this.body.querySelector('.section-heading.seasons button[data-action="seen"], .title-actions button[data-action="seen"], .title-menu summary');
      this.focusAfterDialog(trigger?.isConnected ? trigger : fallback);
    });
    this.removeDialog.addEventListener("cancel", event => { if (this.busy) event.preventDefault(); });
    this.removeDialog.addEventListener("click", async event => {
      if (this.busy) return;
      const action = event.target.closest("button")?.dataset.action;
      if (action === "cancel-remove") this.removeDialog.close();
      if (action === "confirm-remove") {
        const title = this.current();
        if (title && await this.mutate("title", title, { action: "remove" })) {
          this.removeDialog.close();
          this.frame.scrollTop = this.view.scroll;
          this.saveView();
        }
      }
    });
    this.removeDialog.addEventListener("close", () => {
      const trigger = this.body.querySelector(".title-menu summary") ||
        this.controls.querySelector('button[aria-pressed="true"]');
      this.focusAfterDialog(trigger);
    });
    this.imageDialog.addEventListener("click", event => {
      if (event.target === this.imageDialog || event.target.closest("[data-close-image]")) this.imageDialog.close();
    });
    this.imageDialog.addEventListener("close", () => {
      const source = this.imageDialog.dataset.path;
      this.imageDialog.replaceChildren();
      const trigger = [...this.body.querySelectorAll("[data-action=view-image]")].find(button => button.dataset.image === source);
      this.focusAfterDialog(trigger);
    });
  }

  focusAfterDialog(trigger) {
    if (!this.isConnected) return;
    if (this.actionError) {
      this.actionError = "";
      this.render();
    }
    const restored = trigger?.isConnected ? trigger : this.frame.querySelector('[data-action=collapse], [data-action=large]');
    restored?.focus({ preventScroll: true });
  }

  openRemoveDialog(title) {
    this.actionError = "";
    this.removeDialog.innerHTML = globalThis.HaListManagerDialogSections.removeConfirmation({
      title: this.t("remove_title"),
      message: this.t("remove_named", { title: title.title }),
      headingId: "watchlist-remove-title", messageId: "watchlist-remove-message",
      status: '<div class="error" data-remove-error role="status"></div>',
      actions: `<button type="button" data-action="confirm-remove" class="danger filled">${escape(this.t("confirm_remove"))}</button>
        <button type="button" data-action="cancel-remove">${escape(this.t("cancel"))}</button>`,
    });
    this.removeDialog.showModal();
    this.removeDialog.querySelector("[data-action=cancel-remove]").focus();
  }

  confirmProgress(command, title, params, trigger, label, message) {
    this.actionError = "";
    const removing = command === "continue" && params.season === undefined;
    this.progressConfirmation = { command, title, params, trigger: trigger.closest("details")?.querySelector("summary") || trigger };
    this.progressDialog.innerHTML = globalThis.HaListManagerDialogSections.removeConfirmation({
      title: label, message, icon: removing ? "mdi:playlist-remove" : command === "continue" ? "mdi:playlist-play" : "mdi:check-all",
      headingId: "watchlist-progress-title", messageId: "watchlist-progress-message",
      status: '<div class="error" data-progress-error role="status"></div>',
      actions: `<button type="button" data-action="confirm-progress" class="primary">${escape(this.t(removing ? "confirm_remove" : "confirm_progress"))}</button>
        <button type="button" data-action="cancel-progress">${escape(this.t("cancel"))}</button>`,
    });
    this.progressDialog.showModal();
    this.progressDialog.querySelector("[data-action=cancel-progress]").focus();
  }

  async changeContinue(title, trigger, remove = false) {
    const current = title.continue_watching;
    const previous = current ? [current.season, current.episode] : null;
    const params = { mode: title.progress_mode || "shared", previous };
    if (remove) {
      this.confirmProgress("continue", title, params, trigger, this.t("remove_continue_confirm"),
        this.t("remove_continue_message", { title: title.title }));
      return;
    }
    const first = title.episode_order?.groups.flatMap(group => group.episodes)
      .find(item => released(item, this.today()));
    const season = trigger.hasAttribute("data-season")
      ? Number(trigger.dataset.episodeSeason ?? this.view.season)
      : first?.season ?? groupSeasons(title).filter(row => row.count && released(row, this.today()))
        .sort((a, b) => a.number - b.number)[0]?.number;
    if (season === undefined || season === null) return;
    const episode = Number(trigger.dataset.continueEpisode || (!trigger.hasAttribute("data-season") && first?.number) || 1);
    Object.assign(params, { season, episode });
    if (current && (current.season !== season || current.episode !== episode)) {
      const message = this.t("replace_continue_message", {
        title: title.title, previous: this.t("continue_episode", current),
        next: this.t("continue_episode", params),
      });
      this.confirmProgress("continue", title, params, trigger, this.t("replace_continue"), message);
      return;
    }
    await this.mutate("continue", title, params);
  }

  openImageDialog(path, caption, still) {
    if (!validImage(path)) return;
    const close = escape(this.t("close_image"));
    this.imageDialog.dataset.path = path;
    this.imageDialog.innerHTML = `<section class="image-viewer">
      <header><h3 id="watchlist-image-title">${escape(caption)}</h3>
        <button class="icon-button" type="button" data-close-image title="${close}" aria-label="${close}">${icon("close")}</button></header>
      <div class="image-viewer-body">${image(path, still ? "original" : "w780", "image-broken", true)}</div>
    </section>`;
    const preview = this.imageDialog.querySelector("img");
    preview.alt = caption;
    preview.addEventListener("error", () => {
      const message = document.createElement("p");
      message.textContent = this.t("image_unavailable");
      preview.replaceWith(message);
    }, { once: true });
    this.imageDialog.showModal();
    this.imageDialog.querySelector("[data-close-image]").focus();
  }

  openExplore(page, trigger) {
    if (!this.exploreDialog.open) {
      this.explorePages = [];
      this.exploreTrigger = trigger;
      this.exploreDialog.showModal();
    } else {
      const previous = this.explorePages.at(-1);
      previous.scroll = this.exploreDialog.querySelector(".explore-body").scrollTop;
      previous.focus = trigger && [...this.exploreDialog.querySelectorAll("button, summary")].indexOf(trigger);
    }
    this.explorePages.push(page);
    if (page.type === "upcoming-help") this.renderExplore();
    else void this.loadExplore(page);
  }

  async loadExplore(page) {
    page.error = "";
    this.renderExplore();
    const generation = this.generation;
    const params = page.title ? { kind: page.title.kind, media_id: page.title.id } : {};
    const active = () => this.generation === generation && this.exploreDialog.open
      && this.explorePages.includes(page);
    try {
      if (page.type === "subscriptions") {
        page.data = await this.ws("subscriptions/get");
        page.draft = new Set(page.data.own);
      } else if (page.type === "cast") {
        page.data = await this.ws("cast", params);
        if (this.generation === generation) this.updateCastPreview(page.title, page.data.slice(0, 12));
      } else if (page.type === "episode-orders") {
        page.data = await this.ws("orders", { media_id: page.title.id });
        this.orderChoices.set(page.title.id, page.data);
      } else if (page.type === "play") {
        const availability = await this.ws("availability", { ...params, cached_only: true, playback: true });
        page.data = availability.record?.data.groups || {};
        page.lastSource = availability.last_source;
      } else if (page.type === "preview") page.data = await this.ws("preview", params);
      else if (page.type === "appearances") page.data = await this.ws("appearances", {
        media_id: page.title.id, person_id: page.personId, credit_ids: (page.title.credit_ids || []).slice(0, 12),
      });
      else {
        let personId = page.actor.id;
        if (!personId) {
          const summary = await this.ws("cast", { ...params, full: false });
          if (!active()) return;
          const matching = summary.filter(person => person.name === page.actor.name);
          if (matching.length === 1) personId = matching[0].id;
          else {
            const roles = matching.filter(person => person.role === page.actor.role);
            if (roles.length === 1) personId = roles[0].id;
          }
          if (!personId) throw new Error(this.t("actor_unavailable"));
        }
        page.data = await this.ws("filmography", { person_id: personId });
      }
    } catch (error) {
      page.error = error?.message || this.t("load_failed");
    }
    if (active() && this.explorePages.at(-1) === page) {
      this.renderExplore();
      if (page.type === "preview" && page.data) void this.loadAvailability(page.data);
    }
  }

  async handleExploreClick(event) {
    const button = event.target.closest("button[data-action]");
    const page = this.explorePages.at(-1);
    if (!page) return;
    const { action, index, kind } = button?.dataset || {};
    const title = page.data;
    const trigger = this.closeAvailabilityMenu(event) || button;
    if (event.target === this.exploreDialog || action === "close-explore") this.exploreDialog.close();
    else if (action === "back-explore") {
      this.explorePages.pop();
      this.renderExplore(true);
      const previous = this.explorePages.at(-1);
      if (previous?.type === "preview" && previous.data) void this.loadAvailability(previous.data);
    } else if (action === "clear-dialog-search") {
      const input = button.parentElement.querySelector("[data-dialog-search]");
      this.resetSearch(input, () => this.filterExplore(input));
    } else if (action === "retry-explore") void this.loadExplore(page);
    else if (action === "cast-all") this.openExplore({ type: "cast", title }, button);
    else if (action === "actor") {
      const actor = (page.type === "cast" ? title : title.cast)[Number(index)];
      this.openExplore({ type: "person", title: page.type === "cast" ? page.title : title, actor }, button);
    } else if (action === "filmography-filter") {
      page.kind = kind;
      this.renderExplore();
      this.exploreDialog.querySelector(`[data-kind="${kind}"]`).focus({ preventScroll: true });
    } else if (action === "filmography-title") {
      const related = title.titles[Number(index)];
      const saved = this.findTitle(keyOf(related));
      if (saved) this.openFromExplore(saved);
      else this.openExplore({ type: "preview", title: related }, button);
    } else if (action === "appearances") {
      this.openExplore({ type: "appearances", title: title.titles[Number(index)], personId: title.id }, button);
    } else if (action === "refresh-availability") {
      void this.loadAvailability(title, true);
    } else if (action === "subscriptions") {
      this.openExplore({ type: "subscriptions" }, trigger);
    } else if (action === "save-subscriptions") {
      await this.saveSubscriptions(page);
    } else if (action === "open-explored") this.openFromExplore(this.findTitle(keyOf(title)));
    else if (action === "set-episode-order") {
      button.disabled = true;
      if (await this.mutate("order", page.title, { order: button.dataset.order })) this.exploreDialog.close();
      else if (this.exploreDialog.open && this.explorePages.at(-1) === page) {
        page.error = this.actionError;
        this.renderExplore();
      }
    } else if (action === "send-play") {
      if (page.pending) return;
      const playerSelect = this.exploreDialog.querySelector("[data-play-player]");
      const sourceSelect = this.exploreDialog.querySelector("[data-play-provider]");
      const player = playerSelect.value;
      if (!player) return;
      const source = sourceSelect.value;
      const storageKey = `${this.storageKey}:play-target`;
      const status = this.exploreDialog.querySelector("[data-play-status]");
      const active = () => this.exploreDialog.open && this.explorePages.at(-1) === page;
      status.textContent = "";
      page.pending = button.disabled = playerSelect.disabled = sourceSelect.disabled = true;
      try {
        await this.ws("play", { kind: page.title.kind, media_id: page.title.id, player,
          ...(page.episode ? { season: page.season, episode: page.episode } : {}),
          ...(source.startsWith("local:") ? { local_source: source.slice(6) } : source ? { provider_id: Number(source) } : {}) });
        try { localStorage.setItem(storageKey, player); } catch { /* Playback still works without browser storage. */ }
        if (active()) this.exploreDialog.close();
      } catch (error) {
        if (active()) status.textContent = error?.message || this.t("play_failed");
      } finally {
        page.pending = button.disabled = playerSelect.disabled = sourceSelect.disabled = false;
      }
    } else if (action === "add-explored") {
      if (this.busy) return;
      button.disabled = true;
      if (await this.mutate("title", title, { action: "add" })) {
        if (this.exploreDialog.open && this.explorePages.at(-1) === page) this.renderExplore();
      } else if (this.exploreDialog.open && this.explorePages.at(-1) === page) {
        button.disabled = false;
        this.exploreDialog.querySelector(".explore-feedback").textContent = this.actionError;
      }
    }
  }

  openFromExplore(title) {
    if (!title) return;
    this.exploreTrigger = null;
    this.exploreDialog.close();
    this.select(title);
    this.frame.querySelector('.detail-navigation button[data-action="back"]')?.focus({ preventScroll: true });
  }

  searchField(value, label, dialog = false) {
    const name = escape(this.t(label));
    const clear = escape(this.t("clear_search"));
    return `<div class="search-input">${icon("magnify")}<input type="search" value="${escape(value)}"
      placeholder="${name}" aria-label="${name}" ${dialog ? "data-dialog-search" : 'maxlength="200"'}>
      <button class="clear-search" type="button" title="${clear}" aria-label="${clear}"
        ${dialog ? 'data-action="clear-dialog-search"' : ""} ${value ? "" : "hidden"}>${icon("close")}</button></div>`;
  }

  resetSearch(input, update) {
    input.value = "";
    update();
    input.focus({ preventScroll: true });
  }

  filterExplore(input) {
    const page = this.explorePages.at(-1);
    page.query = input.value;
    input.nextElementSibling.hidden = !page.query;
    const query = page.query.trim().toLocaleLowerCase();
    if (page.type === "subscriptions") {
      let matches = false;
      for (const row of this.exploreDialog.querySelectorAll("[data-provider-option]")) {
        row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
        matches ||= !row.hidden;
      }
      this.exploreDialog.querySelector("[data-provider-empty]").hidden = matches;
      return;
    }
    let count = 0;
    for (const item of this.exploreDialog.querySelectorAll("[data-actor-index]")) {
      const { name, role } = page.data[Number(item.dataset.actorIndex)];
      item.hidden = !`${name} ${role}`.toLocaleLowerCase().includes(query);
      if (!item.hidden) count++;
    }
    this.exploreDialog.querySelector("[data-cast-empty]").hidden = Boolean(count);
  }

  renderExplore(restore = false) {
    const page = this.explorePages.at(-1);
    if (!this.exploreDialog.open || !page) return;
    const label = page.type === "upcoming-help" ? this.t("new_episodes")
      : page.type === "play" ? this.t("play_title")
      : page.type === "episode-orders" ? this.t("episode_order")
      : page.type === "subscriptions" ? this.t("my_subscriptions") : page.type === "cast" ? this.t("cast")
      : page.type === "person" ? page.actor.name : page.title.title;
    let content;
    if (page.type === "upcoming-help") {
      content = `<p>${escape(this.t("new_episodes_help_started"))}</p>
        <ul><li>${escape(this.t("new_episodes_help_next"))}</li><li>${escape(this.t("new_episodes_help_recent"))}</li></ul>
        <p>${escape(this.t("new_episodes_help_visibility"))}</p>`;
    } else if (page.error) content = `<p role="alert" class="error">${escape(page.error)}</p>${this.button("retry-explore", this.t("retry"), "refresh")}`;
    else if (!page.data) content = `<p role="status">${escape(this.t("loading_details"))}</p>`;
    else if (page.type === "cast") content = `<p>${escape(page.title.title)}</p>
      ${this.searchField(page.query, "search_cast", true)}
      ${this.castList(page.data, "cast-grid")}<p data-cast-empty ${page.data.length ? "hidden" : ""}>${escape(this.t("no_cast"))}</p>`;
    else if (page.type === "person") content = this.renderFilmography(page);
    else if (page.type === "appearances") content = this.renderAppearances(page.data);
    else if (page.type === "subscriptions") content = this.renderSubscriptions(page);
    else if (page.type === "play") content = this.renderPlay(page);
    else if (page.type === "episode-orders") {
      const current = page.title.episode_order?.id || "";
      const choices = [{ id: "", name: this.t("order_original") }, ...page.data];
      content = (page.data.length || current) ? `<p>${escape(page.title.title)}</p>
        <div class="order-choices">${choices.map(order => this.button("set-episode-order",
          order.name, order.id === current ? "radiobox-marked" : "radiobox-blank",
          `data-order="${escape(order.id)}" aria-pressed="${order.id === current}"`)).join("")}</div>`
        : `<p>${escape(this.t("order_unavailable"))}</p>`;
    }
    else content = this.renderPreview(page.data);
    this.exploreDialog.innerHTML = `<header><div class="actions">
      ${this.explorePages.length > 1 ? this.button("back-explore", this.t("back"), "arrow-left", "", "icon-button") : ""}
      <h3 id="watchlist-explore-title">${escape(label)}</h3></div>
      ${this.button("close-explore", this.t("close_details"), "close", "", "icon-button")}</header>
      <div class="explore-body">${content}</div>`;
    this.exploreDialog.querySelector("[data-play-player]")?.addEventListener("change", event => {
      this.exploreDialog.querySelector('[data-action="send-play"]').disabled = page.pending || !event.target.value;
    });
    const search = this.exploreDialog.querySelector("[data-dialog-search]");
    if (search && page.query) this.filterExplore(search);
    if (restore) this.exploreDialog.querySelector(".explore-body").scrollTop = page.scroll || 0;
    const controls = this.exploreDialog.querySelectorAll("button, summary");
    const focus = restore ? controls[page.focus] : null;
    (focus || this.exploreDialog.querySelector('[data-action="close-explore"]')).focus({ preventScroll: true });
  }

  renderPlay(page) {
    const players = this.library.players || [];
    const { own = [], household = [] } = this.library.subscriptions || {};
    const offeredSubscriptions = page.data.flatrate || [];
    const groups = [
      [this.t("in_my_subscriptions"), offeredSubscriptions.filter(provider => own.includes(provider.id))],
      [this.t("play_local_sources"), (this.library.local_sources || []).map(name => ({ local: true, name }))],
      [this.t("in_household_subscriptions"), offeredSubscriptions.filter(provider => household.includes(provider.id))],
      ...["flatrate", "free", "ads", "rent", "buy"].map(kind =>
        [this.t("play_other_group", { offer: this.t(`provider_${kind}`) }), page.data[kind] || []]),
    ];
    const lastSource = page.lastSource;
    const selected = lastSource?.local_source ? `local:${lastSource.local_source}` : String(lastSource?.provider_id ?? "");
    const seenProviders = new Set();
    const options = groups.map(([label, providers]) => {
      const choices = providers.map(provider => {
        if (!provider.local && !provider.id) return "";
        const value = provider.local ? `local:${provider.name}` : String(provider.id);
        if (seenProviders.has(value)) return "";
        seenProviders.add(value);
        return `<option value="${escape(value)}" ${selected === value ? "selected" : ""}>${escape(provider.name)}</option>`;
      }).join("");
      return choices ? `<optgroup label="${escape(label)}">${choices}</optgroup>` : "";
    }).join("");
    let remembered = "";
    try { remembered = localStorage.getItem(`${this.storageKey}:play-target`); } catch {}
    const defaultPlayer = [this.config.default_player, remembered].find(player => players.includes(player))
      || (players.length === 1 ? players[0] : "");
    return `<p><strong>${escape(page.title.title)}</strong>${page.episode
      ? ` · ${escape(this.t("continue_episode", page))}` : ""}</p>
      <div class="play-fields"><label>${escape(this.t("play_player"))}<select data-play-player>
        <option value="" ${defaultPlayer ? "" : "selected"} disabled>${escape(this.t("play_choose_player"))}</option>
        ${players.map(player => `<option ${player === defaultPlayer ? "selected" : ""}>${escape(player)}</option>`).join("")}</select></label>
      <label>${escape(this.t("play_provider"))}<select data-play-provider>
        <option value="">${escape(this.t("play_no_provider"))}</option>
        ${options}</select></label></div>
      ${this.button("send-play", this.t("play_title"), "cast", defaultPlayer ? "" : "disabled", "primary")}
      <p role="status" data-play-status></p>`;
  }

  renderSubscriptions(page) {
    if (!page.data.region) return `<p>${escape(this.t("choose_streaming_region"))}</p>`;
    const known = new Set(page.data.providers.map(item => item.id));
    const providers = [...page.data.providers, ...page.data.own.filter(id => !known.has(id)).map(id =>
      ({ id, name: this.t("unknown_provider", { id }) }))]
      .sort((a, b) => Number(page.draft.has(b.id)) - Number(page.draft.has(a.id)) || a.name.localeCompare(b.name));
    return `<p>${escape(this.t("subscriptions_help"))}</p>
      <p class="subscription-hint">${escape(this.t("subscriptions_free_help"))}</p>
      ${this.searchField(page.query, "search_providers", true)}
      <div class="subscription-options">${providers.map(provider => `<label data-provider-option>
        <input type="checkbox" data-provider-id="${escape(provider.id)}" ${page.draft.has(provider.id) ? "checked" : ""}>
        ${image(provider.logo, "w45", "television")}<span>${escape(provider.name)}</span></label>`).join("")}</div>
      <p data-provider-empty ${providers.length ? "hidden" : ""}>${escape(this.t("no_matching_providers"))}</p>
      <p class="explore-feedback error" role="status"></p>
      <div class="actions">${this.button("save-subscriptions", this.t("save_subscriptions"), "check", "", "primary")}</div>`;
  }

  async saveSubscriptions(page) {
    if (page.saving) return;
    page.saving = true;
    const generation = this.generation;
    const button = this.exploreDialog.querySelector('[data-action="save-subscriptions"]');
    button.setAttribute("aria-disabled", "true");
    const choices = this.exploreDialog.querySelectorAll("[data-provider-id]");
    for (const choice of choices) choice.disabled = true;
    try {
      const { region, own, household } = await this.ws("subscriptions/save", {
        region: page.data.region, provider_ids: [...page.draft],
      });
      if (generation !== this.generation) return;
      if (region === this.library.region) {
        this.library.subscriptions = { own, household };
        this.paintAvailability();
      }
      if (this.exploreDialog.open && this.explorePages.at(-1) === page) {
        if (this.explorePages.length > 1) {
          this.explorePages.pop();
          this.renderExplore(true);
        } else this.exploreDialog.close();
      }
    } catch (error) {
      if (generation === this.generation && this.explorePages.at(-1) === page) {
        this.exploreDialog.querySelector(".explore-feedback").textContent = error?.message || this.t("load_failed");
      }
    } finally {
      page.saving = false;
      button.removeAttribute("aria-disabled");
      for (const choice of choices) choice.disabled = false;
    }
  }

  renderPreview(title) {
    const saved = this.findTitle(keyOf(title));
    return `<div class="preview-heading"><div class="poster">${image(title.poster, "w154", "filmstrip")}</div>
      <div><p class="meta">${escape([title.date?.slice(0, 4), ...(title.genres || []).map(genre => genre.name)]
        .filter(Boolean).join(" · "))}</p>${title.overview ? `<p>${escape(title.overview)}</p>` : ""}</div></div>
      <div class="actions">${this.button(saved ? "open-explored" : "add-explored", this.t(saved ? "open_saved" : "add"),
        saved ? "arrow-right" : "plus", "", "primary")}</div><p class="explore-feedback error" role="status"></p>
      ${this.availabilitySection(title)}
      ${this.renderCast(title)}`;
  }

  renderFilmography(page) {
    const selected = page.kind || "all";
    return `<div class="actor-heading"><div class="cast-photo">${image(page.data.photo, "w185", "account-outline")}</div>
      <div><strong>${escape(page.title.title)}</strong>${page.actor.role ? `<p>${escape(page.actor.role)}</p>` : ""}
      ${this.actorAge(page.data)}</div></div>
      <h4>${escape(this.t("filmography"))}</h4>
      <div class="actions">${[["all", "all_titles"], ["movie", "films"], ["tv", "series"]].map(([kind, label]) =>
        this.button("filmography-filter", this.t(label), kind === "movie" ? "movie-open-outline" : kind === "tv" ? "television" : "filmstrip",
          `data-kind="${kind}" aria-pressed="${selected === kind}"`, selected === kind ? "selected" : "")).join("")}</div>
      <ul class="filmography-list">${page.data.titles.map((title, index) => {
        if (selected !== "all" && title.kind !== selected) return "";
        const saved = Boolean(this.findTitle(keyOf(title)));
        return `<li><button type="button" data-action="filmography-title" data-index="${index}">
          <span class="poster">${image(title.poster, "w154", "filmstrip")}</span><span><strong>${escape(title.title)}</strong>
          <small>${escape([this.t(title.kind === "tv" ? "series" : "film"), title.date?.slice(0, 4),
            ...(title.roles || [])].filter(Boolean).join(" · "))}</small>
          <small>${escape(this.t(saved ? "open_saved" : "preview_title"))}</small></span>${icon("chevron-right")}</button>
          ${title.kind === "tv" && page.data.id ? this.button("appearances", this.t("show_appearances"), "format-list-numbered",
            `data-index="${index}" title="${escape(this.t("show_appearances"))}"`, "icon-button appearance-button") : ""}</li>`;
      }).join("")}</ul>${page.data.titles.some(title => selected === "all" || title.kind === selected) ? ""
        : `<p>${escape(this.t("no_matches"))}</p>`}`;
  }

  actorAge({ birthday, deathday }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || "")) return "";
    const date = this.formatDate(birthday);
    const end = deathday || this.today();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < birthday || end > this.today()) return "";
    const age = Number(end.slice(0, 4)) - Number(birthday.slice(0, 4)) - (end.slice(5) < birthday.slice(5) ? 1 : 0);
    return `<p class="actor-age">${escape(this.t(deathday ? "actor_age_at_death" : "actor_age", { date, age }))}</p>`;
  }

  renderAppearances({ episodes, seasons, roles, episode_count: count, series_episode_count: total, all_regular: all }) {
    const ordinary = episodes.filter(episode => episode.season !== 0);
    const specials = episodes.filter(episode => episode.season === 0);
    const seasonList = seasons.length === 1 ? this.t("season_number", { number: seasons[0] })
      : seasons.length ? this.t("credited_seasons", { seasons: seasons.every((season, index) => season === seasons[0] + index)
        ? `${seasons[0]}–${seasons.at(-1)}` : seasons.join(", ") }) : "";
    const countLabel = all ? this.t("all_credited_episodes", { count, total })
      : count > 0 ? this.t(count === 1 ? "credited_episode" : "credited_episodes", { count }) : "";
    const summary = (seasonList || (!episodes.length && countLabel))
      ? `<p>${escape([...roles, countLabel, seasonList].filter(Boolean).join(" · "))}</p>` : "";
    const list = (items, isSpecial = false) => items.length ? `<ul class="appearance-list">${items.map(episode => {
      const label = this.t(isSpecial ? "special_episode" : "continue_episode", episode);
      return `<li><strong>${escape(label)}${episode.title && episode.title !== label ? ` · ${escape(episode.title)}` : ""}</strong>
      ${episode.roles.length ? `<small>${escape(episode.roles.join(" · "))}</small>` : ""}</li>`;
    }).join("")}</ul>`
      : "";
    return `<h4>${escape(this.t("appearances"))}</h4>${summary}${list(ordinary)}
      ${specials.length ? `<h4>${escape(this.t("specials"))}</h4>${list(specials, true)}` : ""}
      ${!summary && !episodes.length ? `<p>${escape(this.t("no_appearances"))}</p>` : ""}`;
  }

  availabilityKey(title) {
    return `${this.library.region || ""}:${keyOf(title)}`;
  }

  async loadAvailability(title, refresh = false) {
    if (!title || title.kind === "collection" || !this.library.region || !this.library.configured) return;
    const key = this.availabilityKey(title);
    const previous = this.availability.get(key);
    if (previous?.pending) return;
    const entry = { ...previous, pending: true, error: "" };
    this.availability.set(key, entry);
    const generation = this.generation;
    const update = () => {
      if (generation !== this.generation || this.availability.get(key) !== entry) return false;
      this.paintAvailability(key);
      return true;
    };
    update();
    const params = { kind: title.kind, media_id: title.id };
    try {
      if (!refresh) {
        const cached = await this.ws("availability", { ...params, cached_only: true });
        if (cached.region !== this.library.region) return;
        entry.record = cached.record;
        if (!update() || (entry.record && !entry.record.stale)) return;
      }
      const result = await this.ws("availability", { ...params, refresh });
      if (result.region === this.library.region) entry.record = result.record;
    } catch (error) {
      entry.error = error?.message || this.t("load_failed");
    } finally {
      entry.pending = false;
      update();
    }
  }

  availabilitySection(title) {
    if (!this.library.configured) return "";
    const key = this.availabilityKey(title);
    return `<section class="availability" data-availability="${escape(key)}">${this.availabilityContent(this.availability.get(key))}</section>`;
  }

  paintAvailability(key) {
    for (const section of this.shadowRoot.querySelectorAll("[data-availability]")) {
      const sectionKey = section.dataset.availability;
      if (key && sectionKey !== key) continue;
      const focus = this.shadowRoot.activeElement;
      const action = section.contains(focus) ? focus?.dataset.action : null;
      const expanded = section.querySelector(".other-providers")?.open;
      const menuOpen = section.querySelector(".availability-menu")?.open;
      const menuFocused = section.contains(focus) && focus?.hasAttribute("data-availability-trigger");
      section.innerHTML = this.availabilityContent(this.availability.get(sectionKey), expanded, menuOpen);
      if (action) [...section.querySelectorAll("button")].find(button => button.dataset.action === action)
        ?.focus({ preventScroll: true });
      else if (menuFocused) section.querySelector("[data-availability-trigger]")?.focus({ preventScroll: true });
    }
  }

  providerGroup(label, providers, household = false) {
    if (!providers.length) return "";
    return `<div><dt>${household ? icon("home-account") : ""}${escape(label)}</dt>
      <dd>${providers.map(provider => `<span class="provider">${image(provider.logo, "w45", "television")}
        <span>${escape(provider.name)}${provider.withAds ? ` <small>· ${escape(this.t("provider_with_ads"))}</small>` : ""}</span></span>`).join("")}</dd></div>`;
  }

  providerGroups(groups) {
    const { own = [], household = [] } = this.library.subscriptions || {};
    const freeProviders = groups.free || [];
    const freeIds = new Set(freeProviders.map(provider => provider.id ?? provider.name));
    const free = this.providerGroup(this.t("provider_free"), [...freeProviders, ...(groups.ads || [])
      .filter(provider => !freeIds.has(provider.id ?? provider.name)).map(provider => ({ ...provider, withAds: true }))]);
    const paid = ["rent", "buy"].map(type => this.providerGroup(this.t(`provider_${type}`), groups[type] || [])).join("");
    const subscription = groups.flatrate || [];
    if (!own.length && !household.length) {
      return { main: this.providerGroup(this.t("provider_flatrate"), subscription) + free + paid, remaining: "", missing: false };
    }
    const mine = subscription.filter(provider => own.includes(provider.id));
    const shared = subscription.filter(provider => !own.includes(provider.id) && household.includes(provider.id));
    const remaining = this.providerGroup(this.t("provider_flatrate"), subscription.filter(provider =>
      !own.includes(provider.id) && !household.includes(provider.id))) + paid;
    const main = this.providerGroup(this.t("in_my_subscriptions"), mine)
      + this.providerGroup(this.t("in_household_subscriptions"), shared, true) + free;
    return { main, remaining, missing: Boolean(own.length && !mine.length) };
  }

  availabilityContent(entry, expanded = false, menuOpen = false) {
    const region = this.library.region;
    if (!region) return `<h3>${escape(this.t("where_to_watch"))}</h3><p>${escape(this.t("choose_streaming_region"))}</p>`;
    const locale = this._hass.locale?.language || this._hass.language || "en";
    const country = new Intl.DisplayNames([locale], { type: "region" }).of(region);
    const record = entry?.record;
    const groups = record?.data.groups || {};
    const hasProviders = Object.values(groups).some(providers => providers.length);
    const date = record && new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(record.checked_at));
    const link = record?.data.link;
    const { main, remaining, missing } = this.providerGroups(groups);
    return `<div class="section-heading"><h3>${escape(this.t("where_to_watch"))} · ${escape(country)}</h3>
      <details class="availability-menu" ${menuOpen ? "open" : ""}><summary data-availability-trigger
        aria-label="${escape(this.t("availability_actions"))}" title="${escape(this.t("availability_actions"))}">${icon("dots-vertical")}</summary>
        <div class="label-filter-options availability-menu-options" popover="manual">
          ${this.button("subscriptions", this.t("my_subscriptions"), "playlist-check", 'aria-haspopup="dialog"')}
          ${this.button("refresh-availability", this.t("refresh_availability"), "refresh", entry?.pending ? "disabled" : "")}
          ${/^https:\/\/www\.themoviedb\.org\//.test(link || "") ? `<a href="${escape(link)}" target="_blank" rel="noopener noreferrer">
            ${icon("open-in-new")}${escape(this.t("provider_details"))}</a>` : ""}
          ${date ? `<small>${escape(this.t("availability_checked", { time: date }))}</small>` : ""}
        </div></details></div>
      ${hasProviders && missing ? `<p>${escape(this.t("not_in_my_subscriptions"))}</p>` : ""}
      ${main ? `<dl>${main}</dl>` : !hasProviders && record ? `<p>${escape(this.t("no_streaming_providers", { country }))}</p>` : ""}
      ${entry?.pending ? `<p role="status">${escape(this.t("loading_availability"))}</p>` : ""}
      ${entry?.error ? `<p class="error" role="status">${escape(entry.error)}</p>
        ${date ? `<small>${escape(this.t("availability_checked", { time: date }))}</small>` : ""}` : ""}
      ${record ? `<div class="availability-footer">${remaining ? `<details class="other-providers" ${expanded ? "open" : ""}>
        <summary>${escape(this.t("other_providers"))}</summary><dl>${remaining}</dl></details>` : ""}<small>JustWatch</small></div>` : ""}`;
  }

  findTitle(key) {
    const items = key.startsWith("collection:") ? this.library.collections || [] : this.library.titles;
    return items.find(title => keyOf(title) === key);
  }

  current() { return this.findTitle(this.view.title); }

  async search(page = 1) {
    const query = this.view.query.trim();
    if (!query || this.view.kind === "favorites" || !this.library.configured || this.onlinePending || this.busy) return;
    const id = ++this.searchId;
    const generation = this.generation;
    this.onlinePending = true;
    this.actionError = "";
    this.render();
    try {
      const result = await this.ws("search", { kind: this.view.kind, query, page });
      if (id !== this.searchId || generation !== this.generation) return;
      this.online = { ...result, page, results: page > 1
        ? [...this.online.results, ...result.results] : result.results };
      if (page === 1) this.resetLibraryScroll();
    } catch (error) {
      if (id === this.searchId && generation === this.generation) this.actionError = error.message || this.t("load_failed");
    } finally {
      if (id === this.searchId && generation === this.generation) {
        this.onlinePending = false;
        this.render();
      }
    }
  }

  async loadSeason(refresh = false, resume = null) {
    const title = this.current();
    if (title?.kind !== "tv") return;
    const number = this.view.season;
    if (!title.seasons?.some(season => season.number === number)) {
      this.episodes = [];
      this.render();
      return;
    }
    const id = ++this.seasonId;
    const generation = this.generation;
    const scroll = this.view.seasonScroll;
    this.seasonError = "";
    this.episodes = null;
    this.render();
    try {
      const episodes = await this.ws("season", { media_id: title.id, season: number, refresh });
      if (id === this.seasonId && generation === this.generation && this.view.title === keyOf(title) && this.view.season === number) {
        this.episodes = episodes;
        if (resume !== null) this.resumeEpisode = episodes.find(episode => episode.number === resume)?.number;
        this.render();
        const row = resume ? this.body.querySelector("[data-resume-episode]") : null;
        if (row) {
          this.frame.scrollTop += row.getBoundingClientRect().top - this.frame.getBoundingClientRect().top
            - this.navigation.offsetHeight - 10;
          row.focus({ preventScroll: true });
          this.saveView();
        } else this.frame.scrollTop = scroll;
      }
    } catch (error) {
      if (id === this.seasonId && generation === this.generation) {
        this.seasonError = error.message || this.t("load_failed");
        this.render();
      }
    }
  }

  select(title) {
    this.saveView();
    this.view.title = keyOf(title);
    this.view.group = false;
    this.view.season = null;
    this.view.orderGroup = null;
    this.view.detailScroll = 0;
    this.resumeEpisode = null;
    this.seasonId++;
    this.episodes = null;
    this.seasonError = "";
    this.actionError = "";
    this.render();
    this.frame.scrollTop = 0;
    this.saveView();
    void this.loadAvailability(title);
  }

  async mutate(action, title, params = {}) {
    if (this.busy) return false;
    const generation = this.generation;
    this.busy = true;
    this.actionError = "";
    this.render();
    try {
      const value = await this.ws(action, { kind: title.kind, media_id: title.id, ...params });
      if (generation !== this.generation) return false;
      ++this.loadId;
      this.applyLibrary(value);
      return true;
    } catch (error) {
      if (generation === this.generation) this.actionError = error.message || this.t("load_failed");
      return false;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }

  async handleClick(event) {
    const button = event.target.closest("button[data-action]");
    const availabilityTrigger = this.closeAvailabilityMenu(event);
    if (!button) return;
    const { action, id, kind, episode } = button.dataset;
    const current = this.current();
    const target = id ? this.findTitle(`${kind}:${id}`) : current;
    const menu = button.closest("details.title-menu");
    if (menu) {
      if (action === "show-progress-modes" || action === "show-title-actions") {
        this.setMenuPage(menu, action === "show-progress-modes");
        menu.querySelector(action === "show-progress-modes" ? "[data-action=progress-mode]" : "[data-action=show-progress-modes]")
          ?.focus({ preventScroll: true });
        return;
      }
      menu.open = false;
      menu.querySelector("summary")?.focus({ preventScroll: true });
    }
    if (action === "fullscreen") {
      await this.setFullscreen(!this.fullscreen);
    } else if (action === "large") {
      if (this.fullscreen) await this.setFullscreen(false);
      this.setLarge(!this.large);
    } else if (action === "collapse") {
      this.saveView();
      this.collapsed = !this.collapsed;
      if (this.config.remember_position) {
        try { localStorage.setItem(`${this.storageKey}:collapsed`, this.collapsed ? "1" : "0"); } catch {}
      }
      this.renderAtSavedScroll();
    } else if (action === "home" || (action === "tab" && this.view.kind !== kind)) {
      const query = action === "home" || kind === "favorites" || this.view.kind === "favorites" ? "" : this.view.query;
      this.allFavorites = false;
      this.view = { ...defaultView(), kind: kind || "tv", query, sort: this.view.sort, offers: this.view.offers, filtersOpen: this.view.filtersOpen };
      this.online = null;
      this.onlinePending = false;
      this.actionError = "";
      this.resumeEpisode = null;
      this.episodes = null;
      this.seasonError = "";
      this.searchId++;
      this.seasonId++;
      if (action === "home") this.frame.scrollTop = 0;
      else this.resetLibraryScroll();
      this.render();
      this.saveView();
    } else if (action === "filter-label") {
      this.view.label = button.dataset.labelId || "";
      this.labelFilter.open = false;
      this.resetLibraryScroll();
      this.render();
      this.saveView();
      this.labelFilter.querySelector("summary").focus({ preventScroll: true });
    } else if (action === "edit-labels" && current) {
      this.openLabelDialog(current);
    } else if (action === "back") {
      this.saveView();
      this.seasonId++;
      this.resumeEpisode = null;
      if (this.view.orderGroup !== null) this.view.orderGroup = null;
      else if (this.view.season !== null) this.view.season = null;
      else this.view.title = "";
      this.actionError = "";
      this.renderAtSavedScroll();
      this.saveView();
      if (this.view.title) void this.loadAvailability(this.current());
    } else if (action === "open-season" && current) {
      this.openSeason(Number(button.dataset.number));
    } else if (action === "open-order-group" && current) {
      this.openOrderGroup(Number(button.dataset.number));
    } else if (action === "episode-orders" && current) {
      this.openExplore({ type: "episode-orders", title: current }, menu?.querySelector("summary") || button);
    } else if (action === "play" && current) {
      this.openExplore({ type: "play", title: current, season: Number(button.dataset.episodeSeason),
        episode: Number(episode) || null }, menu?.querySelector("summary") || button);
    } else if (action === "upcoming-help") {
      this.openExplore({ type: "upcoming-help" }, button);
    } else if (action === "upcoming" && target) {
      const season = Number(button.dataset.season);
      this.select(target);
      if (target.seasons?.some(item => item.number === season)) this.openSeason(season, Number(episode));
    } else if (action === "continue" && target?.continue_watching) {
      const next = target.continue_watching;
      this.select(target);
      const group = target.episode_order?.groups.findIndex(entry => entry.episodes.some(item =>
        item.season === next.season && item.number === next.episode));
      if (group >= 0) this.openOrderGroup(group, next);
      else this.openSeason(next.season, next.episode);
    } else if (action === "local") {
      this.searchId++;
      this.online = null;
      this.onlinePending = false;
      this.actionError = "";
      this.render();
    } else if (action === "more") {
      await this.search(this.online.page + 1);
    } else if (action === "reload") {
      await this.loadLibrary(true);
    } else if (action === "season-retry") {
      await this.loadSeason();
    } else if (action === "open" && target) {
      this.select(target);
    } else if (action === "preview") {
      const title = this.online?.results.find(item => keyOf(item) === `${kind}:${id}`);
      if (title) this.openExplore({ type: "preview", title }, button);
    } else if (action === "cast-all" && current) {
      this.openExplore({ type: "cast", title: current }, button);
    } else if (action === "actor" && current) {
      this.openExplore({ type: "person", title: current, actor: current.cast[Number(button.dataset.index)] }, button);
    } else if (action === "refresh-availability" && current) {
      void this.loadAvailability(current, true);
    } else if (action === "subscriptions") {
      this.openExplore({ type: "subscriptions" }, availabilityTrigger || button);
    } else if (action === "add" && !target) {
      await this.mutate("title", { kind, id: Number(id) }, { action: "add" });
    } else if (action === "add-all" && current) {
      await this.mutate("title", current, { action: "add_collection" });
    } else if (action === "remove-prompt" && current) {
      this.openRemoveDialog(current);
    } else if (action === "view-image") {
      this.openImageDialog(button.dataset.image, button.dataset.caption, button.hasAttribute("data-still"));
    } else if (action === "favorite" && target) {
      await this.changeFavorite(target);
    } else if (action === "progress-mode" && target) {
      await this.mutate("progress_mode", target, { mode: button.dataset.mode });
      this.body.querySelector(".title-menu summary")?.focus({ preventScroll: true });
    } else if (action === "refresh" && current) {
      if (await this.mutate("title", current, { action: "refresh" }) && this.view.season !== null) {
        if (this.current()?.seasons?.some(season => season.number === this.view.season)) await this.loadSeason(true);
        else {
          this.view.season = null;
          this.renderAtSavedScroll();
        }
      }
    } else if (action === "set-continue" && target?.kind === "tv") {
      await this.changeContinue(target, button);
    } else if (action === "remove-continue" && target?.continue_watching) {
      await this.changeContinue(target, button, true);
    } else if (action === "seen" && target) {
      const params = { seen: button.dataset.seen === "true", mode: target.progress_mode || "shared" };
      if (button.hasAttribute("data-season")) params.season = Number(button.dataset.episodeSeason ?? this.view.season);
      if (episode) params.episode = Number(episode);
      if (target.kind === "tv" && params.episode === undefined) {
        const season = target.seasons?.find(row => row.number === params.season);
        const message = this.t(season ? "confirm_season_progress" : "confirm_series_progress", {
          title: target.title, season: season ? this.seasonName(season) : "",
          scope: this.t(params.mode === "personal" ? "mode_personal" : "mode_shared"),
        });
        this.confirmProgress("progress", target, params, button, button.textContent.trim(), message);
      } else await this.mutate("progress", target, params);
    }
  }

  openOrderGroup(index, resume = null) {
    this.saveView();
    this.view.orderGroup = index;
    this.view.season = null;
    this.view.seasonScroll = 0;
    this.seasonId++;
    this.orderResume = resume;
    this.frame.scrollTop = 0;
    this.render();
    const row = this.body.querySelector("[data-resume-episode]");
    if (row) {
      this.frame.scrollTop += row.getBoundingClientRect().top - this.frame.getBoundingClientRect().top
        - this.navigation.offsetHeight - 10;
      row.focus({ preventScroll: true });
    }
    this.saveView();
  }

  openSeason(number, resume = null) {
    this.saveView();
    this.resumeEpisode = null;
    this.view.orderGroup = null;
    this.view.season = number;
    this.view.seasonScroll = 0;
    this.frame.scrollTop = 0;
    void this.loadSeason(false, resume);
    this.saveView();
  }

  handleChange(event) {
    const { filter } = event.target.dataset;
    if (event.target.hasAttribute("data-all-favorites")) {
      this.allFavorites = this.library.preferences?.show_all_favorites && event.target.checked;
      this.reconcileFavorites();
      this.updateFilterIndicator();
      this.resetLibraryScroll();
      return;
    }
    if (event.target.dataset.offer) {
      const selected = new Set(this.view.offers);
      const offer = event.target.dataset.offer;
      if (event.target.checked) selected.add(offer);
      else selected.delete(offer);
      this.view.offers = [...selected];
      this.resetLibraryScroll();
      this.render();
      this.saveView();
    } else if (filter) {
      this.view[filter] = event.target.value;
      this.resetLibraryScroll();
      this.render();
      this.saveView();
    }
  }

  button(action, label, glyph, attributes = "", style = "") {
    return `<button class="${style}" type="button" data-action="${action}" aria-label="${escape(label)}" ${attributes}>${icon(glyph)}<span>${escape(label)}</span></button>`;
  }

  mediaButton(action, label, glyph, title, extra = "", style = "") {
    return this.button(action, label, glyph,
      `data-id="${title.id}" data-kind="${title.kind}" ${extra} ${this.busy ? "disabled" : ""}`, style);
  }

  render() {
    if (!this.frame || !this._hass) return;
    const scroll = this.frame.scrollTop;
    const active = this.shadowRoot.activeElement;
    const action = active?.dataset.action;
    const actionId = active?.dataset.id;
    const actionKind = active?.dataset.kind;
    const actionSeen = active?.dataset.seen;
    const actionSeason = active?.hasAttribute("data-season");
    const episode = active?.dataset.episode;
    const continueEpisode = active?.dataset.continueEpisode;
    const episodeSeason = active?.dataset.episodeSeason;
    const seasonNumber = active?.dataset.number;
    const title = this.current();
    const name = this.config.title || this.t("title");
    const collapsed = Boolean(this.isCollapsed());
    this.toggleAttribute("data-collapsed", collapsed);
    const enlarge = this.t(this.large ? "reduce" : "expand");
    const fullscreenLabel = this.t(this.fullscreen ? "exit_fullscreen" : "fullscreen");
    const fullscreenButton = this.config.show_expand ? this.button("fullscreen", fullscreenLabel,
      this.fullscreen ? "fullscreen-exit" : "fullscreen",
      `aria-pressed="${Boolean(this.fullscreen)}" title="${escape(fullscreenLabel)}" data-compact`, "icon-button fullscreen-button") : "";
    const header = this.frame.querySelector("header");
    const rgb = this.config.title_icon_color_rgb;
    if (Array.isArray(rgb) && rgb.length === 3 && rgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
      this.frame.style.setProperty("--wl-header-accent", `rgb(${rgb.join(", ")})`);
    } else this.frame.style.removeProperty("--wl-header-accent");
    const brandIcon = `<ha-icon icon="${escape(this.config.title_icon || DEFAULT_CARD_ICON)}" aria-hidden="true"></ha-icon>`;
    header.innerHTML = `<div class="brand">
      ${this.config.icon_expand ? `<button class="brand-icon" type="button" data-action="large" title="${escape(enlarge)}"
        aria-label="${escape(enlarge)}" aria-pressed="${Boolean(this.large)}">${brandIcon}</button>`
        : `<span class="brand-icon">${brandIcon}</span>`}
      <h2 class="brand-heading">${!this.config.collapsible || this.large || this.fullscreen ? escape(name) : `<button type="button" class="brand-title" data-action="collapse"
        aria-expanded="${!collapsed}" title="${escape(this.t(collapsed ? "open_card" : "collapse_card"))}">${escape(name)}</button>`}</h2>
      </div>
      ${collapsed ? fullscreenButton : ""}`;
    const navigation = this.navigation;
    const inSeason = title?.kind === "tv" && (this.view.season !== null || this.view.orderGroup !== null);
    navigation.hidden = collapsed || !title;
    navigation.setAttribute("aria-label", name);
    navigation.innerHTML = navigation.hidden ? "" : `
      ${this.button("back", this.t(inSeason ? "back_to_seasons" : "back"), "arrow-left")}
      ${inSeason ? this.button("home", this.t("watchlist_home"), "home-outline",
        `title="${escape(this.t("watchlist_home"))}"`, "icon-button") : ""}
      ${fullscreenButton}`;
    this.controls.querySelector(".toolbar-fullscreen").innerHTML = !collapsed && !title ? fullscreenButton : "";
    this.renderControls(title);
    this.frame.querySelector(".notice").textContent = this.actionError || this.libraryError ||
      (this.busy ? this.t("saving") : this.onlinePending ? this.t("searching") : "");
    this.frame.querySelector(".notice").classList.toggle("error", Boolean(this.actionError || this.libraryError));
    this.favoriteNotice.textContent = "";
    this.body.hidden = collapsed;
    this.body.innerHTML = collapsed ? "" : title
      ? (title.kind === "collection" ? this.renderGroup(title) : this.renderTitle(title)) : this.renderLibrary();
    this.frame.scrollTop = scroll;
    if (this.labelDialog.open) this.renderLabelDialog();
    if (this.removeDialog.open) {
      for (const button of this.removeDialog.querySelectorAll("button")) button.disabled = this.busy;
      this.removeDialog.querySelector("[data-remove-error]").textContent = this.actionError;
    }
    if (action && !active.isConnected) {
      const matching = [...this.frame.querySelectorAll("button[data-action]")].find(button =>
        button.dataset.action === action && button.dataset.id === actionId && button.dataset.kind === actionKind &&
        button.dataset.episode === episode && button.dataset.episodeSeason === episodeSeason && button.dataset.continueEpisode === continueEpisode &&
        button.dataset.number === seasonNumber && button.hasAttribute("data-season") === actionSeason &&
        (action === "seen" || button.dataset.seen === actionSeen));
      if (matching && !matching.disabled) matching.focus({ preventScroll: true });
      else if ((action === "home" || action === "back") && !title) {
        this.controls.querySelector('nav button[aria-pressed="true"]')?.focus({ preventScroll: true });
      }
    }
  }

  renderControls(title) {
    this.controls.hidden = Boolean(title) || this.isCollapsed();
    this.renderFiltersOpen();
    if (this.controls.hidden) return;
    const t = key => escape(this.t(key));
    const kind = this.view.kind;
    this.controls.querySelector("nav").innerHTML = [["tv", "series", "television"], ["movie", "films", "movie-open-outline"], ["favorites", "favorites", "star-outline"]]
      .map(([value, label, glyph]) => this.button("tab", this.t(label), glyph,
        `data-kind="${value}" aria-pressed="${kind === value}" title="${t(label)}"`, kind === value ? "selected" : "")).join("") +
      (this.library.configured && this.library.region
        ? this.button("subscriptions", this.t("my_subscriptions"), "playlist-check", `title="${t("my_subscriptions")}"`) : "");
    if (this.input.value !== this.view.query) this.input.value = this.view.query;
    this.input.placeholder = this.t("local_search");
    this.input.setAttribute("aria-label", this.t("local_search"));
    this.clearSearch.hidden = !this.view.query;
    this.clearSearch.title = this.t("clear_search");
    this.clearSearch.setAttribute("aria-label", this.clearSearch.title);
    const search = this.controls.querySelector(".online");
    search.innerHTML = `${icon("cloud-search-outline")}<span>${t("online_search")}</span>`;
    search.setAttribute("aria-label", this.t("online_search"));
    search.title = this.t("online_search");
    search.hidden = kind === "favorites";
    search.disabled = search.hidden || !this.library.configured || !this.view.query.trim() || this.onlinePending || this.busy;
    this.filters.hidden = this.filterToggle.hidden = Boolean(this.online);
    const toggle = this.controls.querySelector("[data-all-favorites]");
    toggle.parentElement.hidden = kind !== "favorites" || !this.library.preferences?.show_all_favorites;
    toggle.checked = Boolean(this.allFavorites);
    toggle.nextElementSibling.textContent = this.t("show_all_favorites");
    const items = [...this.library.titles, ...(this.library.collections || [])].filter(title => this.matchesTab(title, true));
    const genres = new Map(items.flatMap(title => title.genres || []).map(genre => [String(genre.id), genre.name]));
    this.renderFilter("genre", this.t("all_genres"), [...genres.entries()].sort((a, b) => a[1].localeCompare(b[1])));
    const sort = this.controls.querySelector('[data-filter="sort"]');
    sort.setAttribute("aria-label", this.t("sort_titles"));
    sort.innerHTML = `<option value="title">${t("sort_title")}</option><option value="recent">${t("sort_recent")}</option>`;
    sort.value = this.view.sort === "recent" ? "recent" : "title";
    this.renderLabelFilter();
    const offers = this.controls.querySelector(".offer-filters");
    offers.hidden = !this.library.region || !this.library.configured;
    const focusedOffer = this.shadowRoot.activeElement?.dataset.offer;
    offers.innerHTML = Object.entries(OFFER_FILTERS).map(([value, label]) =>
      `<label><input type="checkbox" data-offer="${value}" ${this.view.offers.includes(value) ? "checked" : ""}>
        <span>${t(label)}</span></label>`).join("");
    if (focusedOffer) offers.querySelector(`[data-offer="${focusedOffer}"]`)?.focus({ preventScroll: true });
    this.updateFilterIndicator();
  }

  setFiltersOpen(open) {
    this.view.filtersOpen = open;
    this.renderFiltersOpen();
    this.saveView();
  }

  renderFiltersOpen() {
    const open = !this.controls.hidden && !this.online && this.view.filtersOpen === true;
    this.filters.toggleAttribute("data-open", open);
    this.filterToggle.setAttribute("aria-expanded", String(open));
    if (!open) this.labelFilter.open = false;
  }

  updateFilterIndicator() {
    const active = Boolean(this.view.genre || this.view.label || this.view.offers.length || this.view.sort === "recent"
      || this.view.kind === "favorites" && this.allFavorites);
    this.filterToggle.toggleAttribute("data-active", active);
    this.filterToggle.setAttribute("aria-label", this.t("filters"));
    this.filterToggle.title = this.t(active ? "filters_active" : "filters");
    this.filterToggle.setAttribute("aria-description", active ? this.t("filters_active") : "");
  }

  renderFilter(name, label, options) {
    const select = this.controls.querySelector(`[data-filter=${name}]`);
    select.setAttribute("aria-label", label);
    select.innerHTML = `<option value="">${escape(label)}</option>${options.map(([id, name]) =>
      `<option value="${escape(id)}">${escape(name)}</option>`).join("")}`;
    select.value = this.view[name];
    if (select.selectedIndex < 0 && this.libraryLoaded) {
      select.value = "";
      this.view[name] = "";
    }
    select.hidden = options.length === 0;
  }

  openDropdowns() {
    return [...this.shadowRoot.querySelectorAll(".label-filter[open], details.title-menu[open], details.availability-menu[open]")];
  }

  closeAvailabilityMenu(event) {
    const action = event.target.closest(".availability-menu button, .availability-menu a");
    if (!action) return null;
    const menu = action.closest(".availability-menu");
    const trigger = menu.querySelector("summary");
    menu.open = false;
    trigger.focus({ preventScroll: true });
    return trigger;
  }

  syncDropdown(dropdown) {
    const menu = dropdown.querySelector("[popover]");
    if (!menu?.showPopover) return;
    if (!this.isConnected || !dropdown.open) {
      if (menu.matches(":popover-open")) menu.hidePopover();
      return;
    }
    const summary = dropdown.querySelector("summary").getBoundingClientRect();
    const viewport = window.visualViewport?.height || window.innerHeight;
    const spaceBelow = viewport - summary.bottom - 8;
    const above = spaceBelow < 160 && summary.top > spaceBelow + 8;
    const alignRight = dropdown.matches(".availability-menu, .episode-menu");
    const left = dropdown.matches(".title-menu")
      ? Math.max(8, Math.min(summary.left, window.innerWidth - 320 - 8)) : summary.left;
    const right = Math.max(8, window.innerWidth - summary.right);
    const maxWidth = Math.max(90, Math.min(320, window.innerWidth - (alignRight ? right : left) - 8));
    const horizontal = alignRight ? [`${right}px`, "auto"] : ["auto", `${left}px`];
    menu.style.inset = above
      ? `auto ${horizontal[0]} ${viewport - summary.top + 4}px ${horizontal[1]}`
      : `${summary.bottom + 4}px ${horizontal[0]} auto ${horizontal[1]}`;
    menu.style.maxHeight = `${Math.max(65, Math.min(350, above ? summary.top - 8 : spaceBelow))}px`;
    menu.style.maxWidth = `${maxWidth}px`;
    menu.style.minWidth = `${Math.min(maxWidth, summary.width)}px`;
    if (!menu.matches(":popover-open")) menu.showPopover();
  }

  setMenuPage(menu, showModes) {
    const main = menu.querySelector("[data-menu-main]");
    const modes = menu.querySelector("[data-menu-modes]");
    if (!modes) return;
    main.hidden = showModes;
    modes.hidden = !showModes;
  }

  labelContents(label) {
    return `<ha-icon icon="${escape(label.icon || "mdi:tag-outline")}" aria-hidden="true"></ha-icon><span>${escape(label.name)}</span>`;
  }

  labelStyle(label) {
    const color = labelColor(label);
    return color ? `style="--label-color:${color}"` : "";
  }

  renderLabelFilter() {
    const items = this.library.labels;
    const active = items.find(label => label.id === this.view.label);
    if (!active && this.libraryLoaded) this.view.label = "";
    this.labelFilter.hidden = !items.length;
    if (!items.length || this.online) this.labelFilter.open = false;
    const all = { id: "", name: this.t("all_labels"), icon: "mdi:tag-multiple-outline" };
    const summary = this.labelFilter.querySelector("summary");
    summary.innerHTML = this.labelContents(active || all) + icon("chevron-down");
    summary.style.setProperty("--label-color", labelColor(active || all) || "var(--wl-accent)");
    this.labelFilter.querySelector(".label-filter-options").innerHTML = [all, ...items].map(label =>
      `<button type="button" data-action="filter-label" data-label-id="${escape(label.id)}" class="label-filter-option"
         aria-pressed="${label.id === (active?.id || "")}" ${this.labelStyle(label)}>${this.labelContents(label)}</button>`
    ).join("");
  }

  openLabelDialog(title) {
    const original = new Set(title.label_ids || []);
    this.labelDraft = { key: keyOf(title), original, selected: new Set(original) };
    this.actionError = "";
    this.labelDialog.querySelector("[data-label-search]").value = "";
    this.renderLabelDialog();
    this.labelDialog.showModal();
    this.labelDialog.querySelector("[data-action=cancel-labels]").focus({ preventScroll: true });
  }

  renderLabelDialog() {
    const draft = this.labelDraft;
    if (!draft) return;
    if (keyOf(this.current() || {}) !== draft.key) {
      this.labelDialog.close();
      return;
    }
    const input = this.labelDialog.querySelector("[data-label-search]");
    const query = input.value.trim().toLocaleLowerCase();
    const options = this.labelDialog.querySelector(".label-options");
    const active = this.shadowRoot.activeElement?.dataset.labelId;
    this.labelDialog.querySelector("h3").textContent = this.t("edit_labels");
    input.placeholder = this.t("search_labels");
    input.setAttribute("aria-label", this.t("search_labels"));
    options.innerHTML = this.library.labels.filter(label => label.name.toLocaleLowerCase().includes(query))
      .map(label => `<button type="button" data-action="toggle-label" data-label-id="${escape(label.id)}" class="label-choice"
        aria-pressed="${draft.selected.has(label.id)}" ${this.labelStyle(label)} ${this.busy ? "disabled" : ""}>
        ${this.labelContents(label)}${draft.selected.has(label.id) ? icon("check") : ""}</button>`).join("") ||
      `<p>${escape(this.t("no_labels"))}</p>`;
    const button = this.labelDialog.querySelector("[data-action=apply-labels]");
    button.textContent = this.t(this.busy ? "saving" : "apply_labels");
    button.disabled = this.busy;
    for (const cancel of this.labelDialog.querySelectorAll("[data-action=cancel-labels]")) {
      cancel.setAttribute("aria-label", this.t("cancel"));
      if (!cancel.classList.contains("icon-button")) cancel.textContent = this.t("cancel");
      cancel.disabled = this.busy;
    }
    this.labelDialog.querySelector(".label-error").textContent = this.actionError;
    if (active) [...options.querySelectorAll("button")].find(button => button.dataset.labelId === active)?.focus({ preventScroll: true });
  }

  async handleLabelDialog(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || this.busy || !this.labelDraft) return;
    const { action, labelId } = button.dataset;
    const { original, selected } = this.labelDraft;
    if (action === "cancel-labels") {
      this.labelDialog.close();
    } else if (action === "toggle-label") {
      if (selected.has(labelId)) selected.delete(labelId);
      else selected.add(labelId);
      this.renderLabelDialog();
    } else if (action === "apply-labels") {
      const current = new Set(this.library.labels.map(label => label.id));
      const added = [...selected].filter(id => !original.has(id) && current.has(id));
      const removed = [...original].filter(id => !selected.has(id));
      const title = this.current();
      if (title && ((!added.length && !removed.length) || await this.mutate("label", title, { added, removed }))) {
        this.labelDialog.close();
      }
    }
  }

  matchesTab(title, includeAll = false) {
    if (this.view.kind === "favorites") {
      return Boolean(title.favorite || ((includeAll || this.allFavorites) && title.any_favorite));
    }
    return title.kind === this.view.kind
      || (this.view.kind === "movie" && title.kind === "collection" && title.in_library);
  }

  libraryItems() {
    const normalize = value => String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
    const words = normalize(this.view.query).trim().split(/\s+/).filter(Boolean);
    const matches = title =>
      (!this.view.genre || title.genres?.some(genre => String(genre.id) === this.view.genre))
      && (!this.view.label || title.label_ids?.includes(this.view.label))
      && words.every(word => normalize(`${title.title} ${title.original_title || ""} ${title.collection?.name || ""}`).includes(word));
    const offers = this.library.region ? this.view.offers : [];
    const selection = this.library.subscriptions?.own || [];
    const available = title => {
      if (!offers.length) return true;
      const data = this.library.availability?.[keyOf(title)];
      return offers.some(offer => offer === "flatrate"
        ? data?.flatrate?.some(id => selection.includes(id)) : data?.[offer]?.length);
    };
    const titles = this.library.titles.filter(title => this.matchesTab(title) && matches(title) && available(title));
    const collections = (this.library.collections || []).filter(title => this.matchesTab(title) &&
      (offers.length
        ? this.library.titles.some(movie => movie.collection?.id === title.id && available(movie)
          && (matches(title) || matches(movie)))
        : matches(title) || (this.view.kind === "movie" && titles.some(movie => movie.collection?.id === title.id))));
    const groupedIds = new Set(collections.map(title => title.id));
    const dates = new Map();
    if (this.view.sort === "recent") for (const movie of titles) {
      const id = movie.collection?.id;
      if (id && movie.added_at > (dates.get(id) || "")) dates.set(id, movie.added_at);
    }
    const added = title => (title.kind === "collection" ? dates.get(title.id) : title.added_at) || "";
    return [...titles.filter(title => this.view.kind !== "movie" || !groupedIds.has(title.collection?.id)), ...collections]
      .sort((a, b) => (this.view.sort === "recent" ? added(b).localeCompare(added(a)) : 0) || a.title.localeCompare(b.title));
  }

  renderLibrary() {
    if (!this.libraryLoaded && !this.libraryError) return this.empty("loading", "filmstrip");
    if (this.libraryError && !this.library.titles.length) {
      return `<div class="empty">${this.button("reload", this.t("retry"), "refresh")}</div>`;
    }
    if (this.online) {
      return `<div class="section-heading"><h3>${escape(this.t("online_results"))}</h3>${this.button("local", this.t("my_library"), "arrow-left")}</div>
        <div class="poster-grid">${this.online.results.map(title => this.tile(title, true)).join("")}</div>
        ${this.online.results.length ? "" : this.empty("no_matches", "magnify")}
        ${this.online.more ? `<div class="end">${this.button("more", this.t("more"), "chevron-down", this.onlinePending ? "disabled" : "")}</div>` : ""}`;
    }
    const items = this.libraryItems();
    const continuing = this.renderContinueWatching(items);
    const upcoming = this.renderUpcoming();
    const unchecked = this.view.offers.length && this.library.region
      ? this.library.titles.filter(title => (this.matchesTab(title) || this.view.kind === "favorites" &&
        this.library.collections?.some(group => this.matchesTab(group) && group.id === title.collection?.id))
        && !this.library.availability?.[keyOf(title)]).length : 0;
    return `${!this.library.configured ? `<p class="setup">${escape(this.t("setup"))}</p>` : ""}
      ${continuing}
      ${upcoming}
      ${items.length && (continuing || upcoming) ? `<h3 class="series-list-heading">${escape(this.t("all_series"))}</h3>` : ""}
      ${unchecked ? `<p class="unchecked-offers" role="status">${escape(this.t(unchecked === 1 ? "unchecked_title" : "unchecked_titles", { count: unchecked }))}</p>` : ""}
      <div class="poster-grid" data-library-grid ${items.length ? "" : "hidden"}>${items.map(title => this.tile(title, false)).join("")}</div>
      <div data-library-empty ${items.length ? "hidden" : ""}>${this.empty(
        this.view.query || this.view.genre || this.view.label || this.view.offers.length ? "no_matches" : this.view.kind === "favorites" ? "no_favorites" : "empty", "filmstrip",
      )}</div>`;
  }

  renderUpcoming() {
    if (this.view.kind !== "tv" || this.view.query.trim() || this.view.genre || this.view.label || this.view.offers.length) return "";
    const today = this.today();
    const recent = new Date(`${today}T00:00:00Z`);
    recent.setUTCDate(recent.getUTCDate() - 7);
    const cutoff = recent.toISOString().slice(0, 10);
    const upcoming = this.library.titles.filter(title => title.kind === "tv" && title.seen?.length
      && !["Ended", "Canceled"].includes(title.status)).flatMap(title => {
      const { last_airing: last, next_airing: next } = title;
      const items = [];
      if (last?.date >= cutoff && last.date <= today && !seen(title, last.season, last.number)) items.push({ title, item: last });
      if (next?.date >= today && !seen(title, next.season, next.number)
          && !items.some(({ item }) => item.season === next.season && item.number === next.number)) items.push({ title, item: next });
      return items;
    }).sort((a, b) => Number(a.item.date < today) - Number(b.item.date < today)
      || a.item.date.localeCompare(b.item.date) || a.title.title.localeCompare(b.title.title));
    if (!upcoming.length) return "";
    const help = escape(this.t("new_episodes_help"));
    return `<section class="upcoming-section"><div class="upcoming-heading">
      <h3>${escape(this.t("new_episodes"))}</h3>
      <button type="button" class="upcoming-info" data-action="upcoming-help" aria-haspopup="dialog" aria-label="${help}" title="${help}">
        ${icon("information-outline")}
      </button>
      </div><div class="upcoming-row">
      ${upcoming.map(({ title, item }) => {
        const meta = this.t("continue_episode", { season: item.season, episode: item.number });
        return `<button type="button" data-action="upcoming" data-kind="tv" data-id="${title.id}"
          data-season="${escape(item.season)}" data-episode="${escape(item.number)}">
          ${icon("calendar-clock-outline")}<span><strong>${escape(title.title)}</strong>
          <small>${escape(meta)} · ${escape(item.title || this.t("new_episode"))}</small>
          <small>${escape(this.t("original_air_date", { date: this.formatDate(item.date) }))}</small></span></button>`;
      }).join("")}</div></section>`;
  }

  renderContinueWatching(items) {
    if (this.view.kind !== "tv" || this.view.query.trim() || this.view.genre || this.view.label || this.view.offers.length) return "";
    const inProgress = items.filter(title => title.continue_watching).sort((a, b) => {
      const left = a.continue_watching.watched_at || "";
      const right = b.continue_watching.watched_at || "";
      return right.localeCompare(left) || a.title.localeCompare(b.title);
    });
    if (!inProgress.length) return "";
    return `<section class="continue-watching" aria-labelledby="watchlist-continue-title">
      <h3 id="watchlist-continue-title">${escape(this.t("continue_watching"))}</h3>
      <div class="continue-row">${inProgress.map(title => {
        const next = title.continue_watching;
        const episode = this.t("continue_episode", { season: next.season, episode: next.episode });
        return `<div class="continue-item"><button class="continue-card" type="button" data-action="continue" data-id="${title.id}" data-kind="tv"
          aria-label="${escape(this.t("continue_title", { title: title.title, episode }))}">
          <span class="continue-art">${image(next.still || title.backdrop || title.poster, next.still ? "w300" : "w342", "television")}
            <span class="continue-play">${icon("play-circle-outline")}</span></span>
          <span class="continue-copy"><strong>${escape(title.title)}</strong><small>${escape(episode)}</small>
            ${next.title ? `<small>${escape(next.title)}</small>` : ""}</span>
        </button>${this.mediaButton("remove-continue", this.t("remove_continue_title", { title: title.title }),
          "close", title, `title="${escape(this.t("remove_continue"))}"`, "icon-button continue-remove")}</div>`;
      }).join("")}</div></section>`;
  }

  reconcileFavorites() {
    const grid = this.body.querySelector("[data-library-grid]");
    if (this.view.kind !== "favorites" || !grid) return;
    const scroll = this.frame.scrollTop;
    const items = this.libraryItems();
    const existing = new Map([...grid.children].map(tile => [tile.dataset.key, tile]));
    let next = grid.firstElementChild;
    for (const title of items) {
      const key = keyOf(title);
      const node = existing.get(key);
      if (!node) {
        next ? next.insertAdjacentHTML("beforebegin", this.tile(title, false)) : grid.insertAdjacentHTML("beforeend", this.tile(title, false));
      } else {
        if (node !== next) grid.insertBefore(node, next);
        next = node.nextElementSibling;
        existing.delete(key);
      }
    }
    for (const node of existing.values()) node.remove();
    grid.hidden = !items.length;
    this.body.querySelector("[data-library-empty]").hidden = Boolean(items.length);
    this.frame.scrollTop = scroll;
  }

  empty(key, glyph) { return `<div class="empty">${icon(glyph)}<p>${escape(this.t(key))}</p></div>`; }

  tile(title, online) {
    const collection = title.kind === "collection" ? title.collection : null;
    const status = collection ? this.groupProgress(collection) : this.progress(title);
    const exists = online && this.library.titles.some(entry => keyOf(entry) === keyOf(title));
    const key = escape(keyOf(title));
    const media = `data-id="${title.id}" data-kind="${title.kind}"`;
    const poster = `<div class="poster">${image(title.poster, "w342", "filmstrip")}
      ${status && !online ? `<span class="poster-status">${escape(status.text)}</span>` : ""}</div>
      <div class="tile-caption"><strong>${escape(title.title)}</strong>${collection
        ? `<small>${escape(this.t("collection"))}</small>` : `<small>${escape(title.date?.slice(0, 4))}</small>`}</div>`;
    if (!online) return `<div class="tile saved-tile" ${media} data-key="${key}">
      <button class="tile-open" type="button" data-action="open" ${media}>${poster}</button>
      ${this.favoriteButton(title, true, "poster-favorite")}</div>`;
    return `<article class="tile online-tile">${poster}
      ${exists ? this.mediaButton("open", this.t("open_saved"), "arrow-right", title)
        : this.mediaButton("preview", this.t("preview_title"), "information-outline", title)
          + this.mediaButton("add", this.t("add"), "plus", title, "", "primary")}</article>`;
  }

  favoriteButton(title, compact = false, style = "") {
    const label = this.t(title.favorite ? "unfavorite" : "favorite");
    return this.mediaButton("favorite", label,
      title.favorite ? "star" : "star-outline", title,
      `aria-pressed="${Boolean(title.favorite)}" title="${escape(label)}" data-favorite-key="${escape(keyOf(title))}" ${compact ? "data-compact" : ""}`,
      `${compact ? "icon-button" : ""} ${title.favorite ? "favorite-active" : ""} ${style}`);
  }

  updateFavoriteButtons(title) {
    const key = keyOf(title);
    for (const button of this.frame.querySelectorAll("[data-favorite-key]")) {
      if (button.dataset.favoriteKey !== key) continue;
      const favorite = Boolean(title.favorite);
      const label = this.t(favorite ? "unfavorite" : "favorite");
      button.classList.toggle("favorite-active", favorite);
      button.setAttribute("aria-pressed", String(favorite));
      button.setAttribute("aria-label", label);
      button.title = label;
      button.querySelector("ha-icon")?.setAttribute("icon", favorite ? "mdi:star" : "mdi:star-outline");
      const text = button.querySelector("span");
      if (text) text.textContent = label;
      button.setAttribute("aria-busy", String(this.favoritePending.has(key)));
      button.disabled = this.busy;
    }
  }

  applyFavoriteUpdate(update) {
    const key = keyOf(update);
    const patch = { ...this.favoriteUpdates.get(key) };
    for (const field of ["favorite", "any_favorite"]) {
      if (Object.hasOwn(update, field)) patch[field] = update[field];
    }
    this.favoriteUpdates.set(key, patch);
    const title = this.findTitle(key);
    if (!title || Object.keys(patch).every(field => Boolean(title[field]) === patch[field])) return;
    Object.assign(title, patch);
    this.reconcileFavorites();
    this.updateFavoriteButtons(title);
  }

  async changeFavorite(title) {
    const key = keyOf(title);
    if (this.favoritePending.has(key) || this.busy) return;
    const notice = this.favoriteNotice;
    notice.textContent = "";
    const generation = this.generation;
    this.favoritePending.add(key);
    this.updateFavoriteButtons(title);
    try {
      const result = await this.ws("favorite", { kind: title.kind, media_id: title.id, favorite: !title.favorite });
      if (generation === this.generation) this.applyFavoriteUpdate(result);
    } catch (error) {
      if (generation === this.generation) {
        notice.textContent = error.message || this.t("load_failed");
      }
    } finally {
      if (generation === this.generation) {
        this.favoritePending.delete(key);
        this.updateFavoriteButtons(this.findTitle(key) || title);
      }
    }
  }

  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  progress(title) {
    if (title.kind === "movie") return { text: this.t(seen(title) ? "seen" : "unseen") };
    const seasons = groupSeasons(title).filter(season => released(season, this.today()));
    const numbers = new Set(seasons.map(season => season.number));
    const count = seasons.reduce((total, season) => total + season.count, 0);
    const watched = title.seen?.filter(([number]) => numbers.has(number)).length || 0;
    return { text: this.t("progress", { seen: watched, total: Math.max(count, watched) }), complete: count > 0 && watched >= count };
  }

  groupProgress(collection) {
    const parts = collection.parts.filter(part => released(part, this.today()));
    const count = parts.filter(part => seen(this.library.titles.find(title => keyOf(title) === keyOf(part)) || {})).length;
    return { text: this.t("progress", { seen: count, total: parts.length }) };
  }

  previewImage(path, caption, still = false, css = still ? "still" : "hero-poster poster") {
    const markup = image(path, still ? "w300" : css === "part-poster" ? "w154" : "w342", still ? "television" : "filmstrip", !still);
    if (!validImage(path)) return `<div class="${css}">${markup}</div>`;
    const label = escape(this.t("view_image", { title: caption }));
    return `<button class="${css} preview-image" type="button" data-action="view-image" data-image="${escape(path)}"
      data-caption="${escape(caption)}" ${still ? "data-still" : ""} title="${label}" aria-label="${label}" aria-haspopup="dialog">
      ${markup}</button>`;
  }

  hero(title, name = title.title, description = title.overview, progress = this.progress(title)) {
    const labels = this.library.labels.filter(label => title.label_ids?.includes(label.id));
    const updated = title.kind === "tv" && title.metadata_updated_at ? new Date(title.metadata_updated_at) : null;
    const updateLabel = updated && !Number.isNaN(updated.valueOf()) ? this.t("title_updated_at", {
      time: new Intl.DateTimeFormat(this._hass.locale?.language || this._hass.language || "en", {
        dateStyle: "medium", timeStyle: "short", timeZone: this._hass.config?.time_zone,
      }).format(updated),
    }) : "";
    return `<section class="hero"><div class="backdrop">${image(title.backdrop, "w780", "filmstrip", true)}</div>
      ${this.previewImage(title.poster, name)}<div class="hero-copy">
      <h3>${escape(name)}</h3><p class="meta">${escape([title.date?.slice(0, 4), ...(title.genres || []).map(genre => genre.name)].filter(Boolean).join(" · "))}</p>
      <div class="hero-status"><span class="progress">${icon("check-circle-outline")}${escape(progress.text)}</span>
        ${title.kind === "collection" ? "" : this.progressScope(title)}</div>
      ${description ? `<p class="synopsis">${escape(description)}</p>` : ""}
      ${labels.length ? `<div class="title-labels">${labels.map(label =>
        `<span class="item-label" ${this.labelStyle(label)}>${this.labelContents(label)}</span>`).join("")}</div>` : ""}
      ${updateLabel ? `<time class="hero-updated" datetime="${escape(title.metadata_updated_at)}">${escape(updateLabel)}</time>` : ""}
      </div></section>`;
  }

  renderGroup(title) {
    const collection = title.collection;
    const missing = collection.parts.some(part => !this.library.titles.some(item => keyOf(item) === keyOf(part)));
    return `${this.hero(title, title.title, title.overview, this.groupProgress(collection))}
      <div class="section-heading"><h3>${escape(this.t("collection"))}</h3><div class="actions">
      ${this.favoriteButton(title)}${this.labelButton()}
      ${missing ? this.mediaButton("add-all", this.t("add_collection"), "playlist-plus", title, "", "primary") : ""}</div></div>
      <div class="entries">${collection.parts.map(part => {
        const saved = this.library.titles.find(item => keyOf(item) === keyOf(part));
        return `<article class="entry part">${this.previewImage(part.poster, part.title, false, "part-poster")}
          <div><strong>${escape(part.title)}</strong><small>${escape(part.date?.slice(0, 4))}</small></div>
          <div class="actions">${saved ? this.mediaButton("open", this.t("details"), "arrow-right", part)
            + this.favoriteButton(saved, true)
            + this.mediaButton("seen", this.t(seen(saved) ? "mark_unseen" : "mark_seen"), seen(saved) ? "check-circle" : "circle-outline",
              saved, `data-seen="${!seen(saved)}"`) : this.mediaButton("add", this.t("add"), "plus", part)}</div></article>`;
      }).join("")}</div>`;
  }

  labelButton() {
    return this.library.labels.length ? this.button("edit-labels", this.t("edit_labels"), "tag-multiple-outline",
      `aria-haspopup="dialog" ${this.busy ? "disabled" : ""}`) : "";
  }

  progressScope(title) {
    const mode = title.progress_mode || this.library.preferences?.default_mode || "shared";
    return `<span class="watch-scope">${icon(mode === "shared" ? "account-multiple-outline" : "account-outline")}
      ${escape(this.t(`mode_${mode}`))}</span>`;
  }

  titleMenu(title, { season = false, reset = false } = {}) {
    const prefs = this.library.preferences || { default_mode: "shared", allow_override: true };
    const active = title.progress_mode || prefs.default_mode;
    const resetAction = reset ? this.mediaButton("seen", this.t(season ? "reset_season" : "reset_series"),
      "undo", title, `data-seen="false" ${season ? "data-season" : ""}`) : "";
    const canContinue = title.kind === "tv" && (season
      ? this.episodes?.some(episode => episode.number === 1 && released(episode, this.today()))
      : groupSeasons(title).some(row => row.count && released(row, this.today())));
    const main = `${prefs.allow_override ? this.button("show-progress-modes", this.t("change_progress_mode"), "account-switch-outline") : ""}
      ${resetAction}
      ${canContinue ? this.mediaButton("set-continue", this.t("add_continue"), "playlist-plus", title, season ? "data-season" : "") : ""}
      ${title.continue_watching ? this.mediaButton("remove-continue", this.t("remove_continue"), "playlist-remove", title) : ""}
      ${!season && title.collection ? this.mediaButton("open", this.t("open_collection"), "filmstrip-box-multiple", { kind: "collection", id: title.collection.id }) : ""}
      ${!season && title.kind === "tv" && (title.episode_order || (title.order_groups_available !== false &&
        this.orderChoices.get(title.id)?.length !== 0))
        ? this.button("episode-orders", this.t("episode_order"), "sort-variant", 'aria-haspopup="dialog"') : ""}
      ${!season && this.library.players?.length ? this.button("play", this.t("play_title"), "cast", 'aria-haspopup="dialog"') : ""}
      ${season ? "" : this.labelButton()}
      ${this.mediaButton("refresh", this.t("refresh_title"), "refresh", title, this.library.configured ? "" : "disabled")}
      ${season ? "" : this.button("remove-prompt", this.t("remove"), "trash-can-outline", `aria-haspopup="dialog" ${this.busy ? "disabled" : ""}`, "danger")}`;
    const modes = prefs.allow_override ? `<div class="title-menu-page" data-menu-modes hidden>
      ${this.button("show-title-actions", this.t("back"), "arrow-left")}
      ${["shared", "personal"].map(value => this.mediaButton("progress-mode",
        this.t(value === prefs.default_mode ? "mode_default" : `mode_${value}`, { mode: this.t(`mode_${value}`) }),
        active === value ? "radiobox-marked" : "radiobox-blank", title,
        `aria-pressed="${active === value}" data-mode="${value}"`,
      )).join("")}</div>` : "";
    return `<details class="title-menu"><summary aria-label="${escape(this.t("more_actions"))}" title="${escape(this.t("more_actions"))}">
      ${icon("dots-vertical")}</summary><div class="title-menu-options label-filter-options" popover="manual">
      <div class="title-menu-page" data-menu-main>${main}</div>${modes}</div></details>`;
  }

  renderTitle(title) {
    const allSeen = title.kind === "movie" ? seen(title) : this.progress(title).complete;
    const anySeen = Boolean(title.seen?.length);
    const canMark = title.kind === "movie" || groupSeasons(title).some(season => season.count && released(season, this.today()));
    if (title.kind === "tv" && this.view.orderGroup !== null) return this.renderOrderedGroup(title);
    if (title.kind === "tv" && this.view.season !== null) return this.renderSeasons(title);
    return `${this.hero(title)}
      <div class="title-actions actions">
      ${canMark ? this.mediaButton("seen", this.t(allSeen ? "mark_unseen" : title.kind === "tv" ? "mark_series" : "mark_seen"),
        allSeen ? "check-circle" : "circle-outline", title, `data-seen="${!allSeen}"`, "primary") : ""}
      ${this.favoriteButton(title, true)}
      ${this.titleMenu(title, { reset: title.kind === "tv" && anySeen && !allSeen })}
      </div>
      ${this.availabilitySection(title)}
      ${title.kind === "tv" ? this.renderSeasonOverview(title) : ""}
      ${this.renderCast(title)}`;
  }

  updateCastPreview(title, cast) {
    title.cast = cast;
    const current = this.current();
    if (!current || keyOf(current) !== keyOf(title)) return;
    current.cast = cast;
    const section = this.body.querySelector(".title-cast");
    if (!section) return;
    if (!cast.length) {
      section.remove();
      return;
    }
    const row = section.querySelector(".cast-row");
    const scroll = row?.scrollLeft || 0;
    if (row) row.outerHTML = this.castList(cast, "cast-row");
    else section.insertAdjacentHTML("beforeend", this.castList(cast, "cast-row"));
    section.querySelector(".cast-row").scrollLeft = scroll;
  }

  renderCast(title) {
    if (title.cast?.length === 0) return "";
    return `<section class="title-cast">
      <div class="section-heading"><h3>${escape(this.t("cast"))}</h3>
        ${this.button("cast-all", this.t("cast_all"), "account-multiple-outline", 'aria-haspopup="dialog"')}</div>
      ${title.cast?.length ? this.castList(title.cast, "cast-row") : ""}</section>`;
  }

  castList(cast, style) {
    return `<ul class="${style}">${cast.map((person, index) => `<li data-actor-index="${index}">
      <button type="button" data-action="actor" data-index="${index}">
        <span class="cast-photo">${image(person.photo, "w185", "account-outline")}</span>
        <strong>${escape(person.name)}</strong>${person.role ? `<small>${escape(person.role)}</small>` : ""}
      </button></li>`).join("")}</ul>`;
  }

  seasonName(season) { return season.name || this.t("season_number", { number: season.number }); }

  renderSeasonOverview(title) {
    if (!title.seasons?.length) return this.empty("no_episodes", "television");
    const seasons = [...title.seasons].sort((a, b) => (a.number || Infinity) - (b.number || Infinity));
    const order = title.episode_order;
    const canonical = `<section class="season-overview" aria-labelledby="watchlist-seasons-heading">
      <h3 id="watchlist-seasons-heading">${escape(this.t("seasons"))}</h3>
      <div class="season-grid">${seasons.map(season => {
        const watched = title.seen?.filter(([number]) => number === season.number).length || 0;
        const total = Math.max(watched, season.count || 0);
        return `<button class="season-tile" type="button" data-action="open-season" data-number="${season.number}">
          <span class="season-art">${image(season.poster, "w185", "television")}</span>
          <span class="season-copy"><strong>${escape(this.seasonName(season))}</strong>
            <small>${escape(this.t("progress", { seen: watched, total }))}</small>
            ${total ? `<progress value="${watched}" max="${total}" aria-hidden="true"></progress>` : ""}</span>
          ${icon("chevron-right")}
        </button>`;
      }).join("")}</div></section>`;
    if (!order) return canonical;
    return `<section class="season-overview"><h3>${escape(order.name)}</h3><div class="season-grid">
      ${order.groups.map((group, index) => {
        const watched = group.episodes.filter(episode => seen(title, episode.season, episode.number)).length;
        return `<button type="button" class="season-tile" data-action="open-order-group" data-number="${index}">
          <span class="season-art">${image(title.poster, "w185", "television")}</span>
          <span class="season-copy"><strong>${escape(group.name || this.t("order_group", { number: index + 1 }))}</strong>
            <small>${escape(this.t("progress", { seen: watched, total: group.episodes.length }))}</small>
            <progress value="${watched}" max="${group.episodes.length}" aria-hidden="true"></progress></span>
          ${icon("chevron-right")}</button>`;
      }).join("")}</div></section><details class="canonical-seasons"><summary>${escape(this.t("order_original"))}</summary>${canonical}</details>`;
  }

  renderOrderedGroup(title) {
    const group = title.episode_order.groups[this.view.orderGroup];
    const highlighted = this.orderResume;
    return `<div class="section-heading"><div><small>${escape(title.title)} · ${escape(title.episode_order.name)}</small>
      <h3>${escape(group.name || this.t("order_group", { number: this.view.orderGroup + 1 }))}</h3></div>
      ${this.progressScope(title)}</div>
      <div class="entries">${group.episodes.map(episode => this.renderEpisode(title, episode.season, episode,
        highlighted?.season === episode.season && highlighted?.episode === episode.number, true)).join("")}</div>`;
  }

  renderSeasons(title) {
    const number = this.view.season;
    const season = title.seasons?.find(season => season.number === number);
    if (!season) return this.renderSeasonOverview(title);
    const completed = this.episodes?.filter(episode => released(episode, this.today())) || [];
    const seasonSeen = completed.length > 0 && completed.every(episode => seen(title, number, episode.number));
    const partial = !seasonSeen && title.seen?.some(([season]) => season === number);
    return `<div class="section-heading seasons"><div><small>${escape(title.title)}</small><h3>${escape(this.seasonName(season))}</h3></div>
      <div class="actions">${this.progressScope(title)}
        ${completed.length ? this.mediaButton("seen", this.t(seasonSeen ? "reset_season" : "mark_season"),
        seasonSeen ? "check-circle" : "check-all", title, `data-season data-seen="${!seasonSeen}"`) : ""}
        ${this.titleMenu(title, { season: true, reset: partial })}</div></div>
      ${this.seasonError ? `<div class="confirmation"><p>${escape(this.seasonError)}</p>${this.button("season-retry", this.t("retry"), "refresh")}</div>`
        : this.episodes === null ? this.empty("loading_season", "television")
        : !this.episodes.length ? this.empty("no_episodes", "television")
        : `<div class="entries">${this.episodes.map(episode => this.renderEpisode(title, number, episode)).join("")}</div>`}`;
  }

  formatDate(value) {
    const date = new Date(value + "T00:00:00Z");
    return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(this._hass.language || "en", {
      dateStyle: "medium", timeZone: "UTC",
    }).format(date);
  }

  renderEpisode(title, number, episode, resume = episode.number === this.resumeEpisode, ordered = false) {
    const watched = seen(title, number, episode.number);
    const available = released(episode, this.today());
    const heading = ordered ? this.t("continue_episode", { season: number, episode: episode.number })
      + (episode.title ? ` · ${episode.title}` : "") : `${episode.number}. ${episode.title}`;
    return `<article class="entry episode ${watched ? "watched" : ""}" ${resume ? 'data-resume-episode tabindex="-1"' : ""}>
      ${this.previewImage(episode.still, `${episode.number}. ${episode.title}`, true)}
      <div><strong>${escape(heading)}</strong>
      <small>${escape([episode.date ? this.formatDate(episode.date) : "",
        episode.minutes ? this.t("minutes", { count: episode.minutes }) : ""].filter(Boolean).join(" · "))}</small>
      ${episode.overview ? `<p>${escape(episode.overview)}</p>` : ""}</div>
      <div class="actions episode-actions">
      ${this.mediaButton("seen", this.t(available ? watched ? "mark_unseen" : "mark_seen" : "unreleased"),
        watched ? "check-circle" : "circle-outline", title,
        `data-season data-episode-season="${number}" data-episode="${episode.number}" data-seen="${!watched}" ${available ? "" : "disabled"}`,
        watched ? "watched-button" : "")}
      ${available ? `<details class="title-menu episode-menu"><summary
        aria-label="${escape(this.t("more_actions"))}" title="${escape(this.t("more_actions"))}">${icon("dots-vertical")}</summary>
        <div class="title-menu-page label-filter-options" popover="manual">
          ${this.mediaButton("set-continue", this.t("add_continue"), "playlist-plus", title,
            `data-season data-episode-season="${number}" data-continue-episode="${episode.number}"`)}
          ${this.library.players?.length ? this.button("play", this.t("play_title"), "cast",
            `data-episode-season="${number}" data-episode="${episode.number}" aria-haspopup="dialog"`) : ""}
        </div></details>` : ""}</div></article>`;
  }
}

const STYLE = `
  .offer-filters, .order-choices, .play-fields { display:flex; flex-wrap:wrap; gap:8px; }
  .offer-filters { flex-basis:100%; }
  .offer-filters label { display:inline-flex; align-items:center; gap:5px; padding:4px 7px; cursor:pointer; }
  .offer-filters input { accent-color:var(--wl-accent); }
  .unchecked-offers, .canonical-seasons summary { color:var(--wl-muted); }
  .canonical-seasons summary { cursor:pointer; }
  .play-fields { margin:0 0 12px; }
  .play-fields label { display:grid; gap:5px; flex:1 1 180px; min-width:0; }
  .upcoming-row { display:flex; gap:8px; overflow-x:auto; padding:4px 1px; }
  .upcoming-row button { min-width:min(200px, 95%); justify-content:flex-start; text-align:left; }
  .upcoming-row span { display:grid; gap:3px; }
  .upcoming-row small { display:block; color:var(--wl-muted); }
  .upcoming-section, .canonical-seasons { margin-block:12px; }
  .upcoming-heading { display:flex; align-items:center; gap:4px; }
  .upcoming-info { display:grid; place-items:center; width:32px; min-height:32px; padding:0; border:0;
    border-radius:50%; background:transparent; color:var(--wl-muted); }
  .upcoming-info ha-icon { --mdc-icon-size:16px; }
  .series-list-heading { margin:16px 0 10px; }

  :host { display: block; --wl-text: var(--primary-text-color); --wl-muted: var(--secondary-text-color);
    --wl-surface: var(--card-background-color, #182027); --wl-line: color-mix(in srgb, var(--wl-text) 15%, transparent);
    --wl-accent: var(--primary-color, #03a9f4); --wl-tint: color-mix(in srgb, var(--wl-accent) 15%, var(--wl-surface)); }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  ha-card { display: block; position: relative; background: var(--wl-surface); color: var(--wl-text); overflow: hidden; }
  .frame { min-height:0; max-height:calc(min(69dvh, 760px) + 74px); overflow:auto; scrollbar-gutter:stable;
    container-type:inline-size; }
  :host([data-panel]) ha-card { height: var(--watchlist-panel-height, calc(100dvh - 80px)); }
  /* Home Assistant places its card actions below the dashboard preview. */
  :host([data-panel][data-edit-preview]:not([data-collapsed], [data-large], [data-fullscreen])) ha-card {
    height: max(76px, calc(var(--watchlist-panel-height, 100dvh - 80px) - 64px)); }
  :host([data-large]) { position: fixed !important; inset: var(--watchlist-top, 56px) var(--watchlist-right, 0) 0 var(--watchlist-left, 0) !important;
    z-index: 9998; padding: 16px; background: var(--primary-background-color, #111); max-width: none !important; }
  :host([data-fullscreen]) { position: fixed !important; inset: 0 !important; z-index: 9999; width: 100vw; height: 100dvh;
    padding: 0; background: var(--primary-background-color, #111); }
  :host([data-large]) ha-card, :host([data-fullscreen]) ha-card { height: 100%; }
  :host([data-fullscreen]) ha-card { border: 0; border-radius: 0; }
  :host([data-panel]) .frame, :host([data-large]) .frame, :host([data-fullscreen]) .frame {
    height:100%; max-height:none; overscroll-behavior:contain; }
  :host([data-collapsed]) ha-card { height: 76px; }
  :host([data-collapsed]) .frame { scrollbar-gutter:auto; }
  :host([data-collapsed]) header { height: 74px; padding: 12px 14px; border-bottom: 0; }
  :host([data-collapsed]) .notice { display: none; }
  header, .brand, .actions, .section-heading, .search, .filters, nav { display: flex; align-items: center; gap: 10px; }
  header { justify-content: space-between; min-height: 74px; padding: 12px 14px; border-bottom: 1px solid var(--wl-line); }
  :host([data-hide-header][data-panel]:not([data-collapsed], [data-large])) .frame > header,
  :host([data-hide-header][data-fullscreen]:not([data-collapsed])) .frame > header { display:none; }
  .brand { min-width: 0; flex:1; gap:8px; }
  .brand > .brand-icon { display:grid; place-items:center; width:35px; height:35px; min-height:0;
    flex:0 0 35px; padding:5px; border:0; border-radius:50%; color:var(--wl-header-accent, var(--wl-accent)); background:transparent; }
  .brand > button.brand-icon:is(:hover, :focus-visible) {
    background:color-mix(in srgb, var(--primary-text-color) 12%, transparent); }
  .brand-icon ha-icon { --mdc-icon-size: 25px; }
  .brand-heading { flex:1; min-width:0; font-family:var(--paper-font-body1_-_font-family, inherit);
    font-size:24px; font-weight:400; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .brand-heading > .brand-title { display:block; min-height:42px; width:100%; padding:0; border:0; border-radius:12px;
    text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .brand-heading > .brand-title:hover:not(:disabled) {
    background:color-mix(in srgb, var(--wl-header-accent, var(--wl-accent)) 12%, transparent); }
  .icon-button { width: 42px; padding: 0; }
  .icon-button span { display: none; }
  .frame > header > .icon-button, .detail-navigation .icon-button { flex: none; }
  .frame > header .fullscreen-button { border-color:transparent; border-radius:12px; }
  .frame > header .fullscreen-button:hover:not(:disabled) {
    background:color-mix(in srgb, var(--wl-header-accent, var(--wl-accent)) 12%, transparent); }
  .frame > header .fullscreen-button ha-icon { --mdc-icon-size:20px; }
  .controls, .detail-navigation { position:sticky; top:0; z-index:2; background:var(--wl-surface); }
  .detail-navigation { flex-wrap:wrap; padding:8px 19px; }
  .detail-navigation button { max-width: 100%; text-align: start; }
  .detail-navigation .fullscreen-button { margin-inline-start:auto; }
  button[data-compact] { display:grid; place-items:center; height:42px; padding:0; }
  button[data-compact] ha-icon { display:block; width:var(--mdc-icon-size); height:var(--mdc-icon-size); line-height:0; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 1.3rem; line-height: 1.2; overflow-wrap: anywhere; }
  h3 { font-size: 1.1rem; }
  button, select, input { font: inherit; color: inherit; }
  button, select { min-height: 42px; border: 1px solid var(--wl-line); border-radius: 11px;
    background: transparent; padding: 7px 11px; cursor: pointer; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-align: center; }
  button:hover:not(:disabled) { background: var(--wl-tint); }
  button:disabled { cursor: default; opacity: .52; }
  button:focus-visible, select:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid var(--wl-accent); outline-offset: 2px; }
  button ha-icon { --mdc-icon-size: 19px; flex: none; }
  .selected, .primary, .online { background: var(--wl-tint); border-color: color-mix(in srgb, var(--wl-accent) 55%, transparent); }
  .selected, .primary { font-weight: 650; }
  .danger { color: var(--error-color, #db4437); }
  .controls nav { grid-area:tabs; flex-wrap:wrap; }
  .controls { padding:8px 19px; display:grid; gap:8px 12px; align-items:center;
    grid-template-columns:minmax(0, 1fr) auto;
    grid-template-areas:"tabs tabs" "search fullscreen"; }
  .search { grid-area:search; min-width:0; }
  .toolbar-fullscreen { grid-area:fullscreen; justify-self:end; display:flex; }
  .controls:has(.toolbar-fullscreen:empty) .search { grid-column-end:-1; }
  .search > .online, .filter-toggle { display:inline-grid; place-items:center; flex:none; width:42px; padding:0; }
  .search > .online > span, .toolbar-fullscreen:empty { display:none; }
  .search-input { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1;
    border: 1px solid var(--wl-line); border-radius: 11px; padding: 0 10px; }
  .search-input ha-icon { color: var(--wl-muted); --mdc-icon-size: 19px; }
  .search-input input { min-width: 0; width: 100%; padding: 10px 0; border: 0; background: transparent; }
  .search-input input::-webkit-search-cancel-button { display: none; }
  .search-input .clear-search { flex: none; width: 36px; min-height: 36px; padding: 0; border: 0; border-radius: 50%; }
  .search-input:focus-within { border-color: var(--wl-accent); }
  .search-input input:focus-visible { outline: 0; }
  select { background: var(--wl-surface); max-width: 100%; }
  .filters { grid-column:1 / -1; flex-wrap:wrap; min-height:0; }
  .filters:not([data-open]) { display:none; }
  .filters:has(> :not([hidden])) { padding-bottom: 2px; }
  .filter-toggle { position:relative; }
  .filter-toggle[data-active]::after { content:""; position:absolute; inset:5px 5px auto auto;
    width:6px; height:6px; border-radius:50%; background:var(--wl-accent); }
  .notice { margin: 0 19px; color: var(--wl-muted); }
  .notice:not(:empty) { padding: 9px 0 0; }
  .error { color: var(--error-color, #db4437); }
  .body { padding:8px 19px 18px; min-height:130px; }
  .poster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(124px, 45%), 1fr)); gap: 13px; }
  :host([data-large]) .poster-grid, :host([data-fullscreen]) .poster-grid { grid-template-columns: repeat(auto-fill, minmax(min(150px, 45%), 1fr)); }
  .tile { display: flex; flex-direction: column; justify-content: flex-start; align-items: stretch; gap: 0;
    padding: 0; min-width: 0; text-align: left; border-radius: 13px; overflow: hidden; border: 1px solid var(--wl-line); }
  .tile-caption { display: grid; align-content: start; gap: 4px; padding: 9px 10px; flex: 1; }
  .saved-tile { position:relative; }
  .tile-open { display:flex; flex-direction:column; align-items:stretch; justify-content:flex-start;
    flex:1; width:100%; gap:0; padding:0; border:0; border-radius:inherit; text-align:left; }
  .tile-open:focus-visible { outline-offset:-2px; }
  .tile-caption strong { overflow-wrap: anywhere; }
  .tile-caption small, small, .meta, .empty, .setup { color: var(--wl-muted); }
  .online-tile > button { margin: 0 8px 8px; }
  .poster, .still, .part-poster { display: grid; place-items: center; position: relative; overflow: hidden;
    color: var(--wl-muted); background: linear-gradient(145deg, var(--wl-tint), var(--wl-surface)); }
  .poster { aspect-ratio: 2 / 3; width: 100%; }
  .poster img, .still img, .part-poster img, .backdrop img { width: 100%; height: 100%; object-fit: cover; }
  .poster > ha-icon { --mdc-icon-size: 35px; }
  .poster-status { position: absolute; bottom: 8px; left: 8px; right: 8px; width: max-content; max-width: calc(100% - 16px);
    padding: 4px 7px; border-radius: 7px; font-size: .75rem; color: #fff; background: #111b; }
  .setup, .confirmation { padding: 12px; border: 1px solid var(--wl-line); border-radius: 10px; margin-bottom: 12px; }
  .confirmation p { margin-bottom: 8px; }
  .empty, .end { text-align: center; padding: 22px 8px; }
  .empty ha-icon { opacity: .8; margin-bottom: 6px; }
  .section-heading { justify-content: space-between; margin: 0 0 12px; flex-wrap: wrap; }
  .hero { position: relative; isolation: isolate; border: 1px solid var(--wl-line); border-radius: 14px; overflow: hidden;
    display: grid; grid-template-columns: minmax(64px, 117px) 1fr; align-items: start; gap: 15px; padding: 15px; background: var(--wl-tint); }
  .backdrop { position: absolute; inset: 0; z-index: -1; opacity: .25; pointer-events: none; }
  .backdrop::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, var(--wl-surface), transparent 75%); }
  .backdrop > ha-icon { display: none; }
  .hero-poster { border-radius: 8px; }
  .hero-copy h3 { font-size: clamp(1.2rem, 3vw, 2rem); line-height: 1.1; overflow-wrap: anywhere; }
  .hero-copy { min-width: 0; }
  .hero-copy:has(.hero-updated) { align-self: stretch; display: flex; flex-direction: column; }
  .hero-updated { margin-top: auto; padding-top: 10px; align-self: flex-end; font-size: .8rem; color: var(--wl-muted); text-align: end; }
  .meta { margin-top: 5px; }
  .progress { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; margin: 8px 0;
    border-radius: 8px; background: var(--wl-surface); font-weight: 600; }
  .progress ha-icon { --mdc-icon-size: 16px; color: var(--wl-accent); }
  .synopsis { line-height: 1.45; }
  .actions { flex-wrap: wrap; }
  .title-actions, .hero + .section-heading { margin: 12px 0; }
  .title-labels { display:flex; flex-wrap:wrap; gap:7px; margin-top:12px; }
  .item-label, .label-choice { display:inline-flex; align-items:center; gap:5px; color:var(--wl-text);
    background:color-mix(in srgb, var(--label-color,var(--wl-accent)) 20%, var(--wl-surface)); border-radius:20px; }
  .item-label { padding:4px 9px; font-size:.85rem; }
  .item-label ha-icon, .label-choice ha-icon, .label-filter ha-icon { color:var(--label-color,var(--wl-accent)); --mdc-icon-size:18px; }
  .label-choice { border-color:color-mix(in srgb, var(--label-color,var(--wl-accent)) 55%, var(--wl-line)); }
  .label-choice[aria-pressed="true"] { box-shadow:inset 0 0 0 1px var(--label-color,var(--wl-accent));
    background:color-mix(in srgb, var(--label-color,var(--wl-accent)) 31%, var(--wl-surface)); }
  .label-filter { position:relative; min-width:0; max-width:100%; }
  .label-filter summary { display:flex; align-items:center; gap:7px; cursor:pointer; min-height:42px; padding:7px 11px;
    border:1px solid var(--wl-line); border-radius:11px; list-style:none; }
  .label-filter summary::-webkit-details-marker { display:none; }
  .label-filter-options { position:absolute; z-index:5; top:calc(100% + 4px); left:0; width:max-content;
    min-width:100%; max-width:min(320px, 75vw); max-height:min(45dvh, 350px); overflow:auto; padding:4px;
    border:1px solid var(--wl-line); border-radius:10px; background:var(--wl-surface); box-shadow:0 6px 20px #0004; }
  .label-filter-options:popover-open { position:fixed; margin:0; color:var(--wl-text); }
  .label-filter-option { width:100%; display:flex; justify-content:flex-start; text-align:left; border:0; }
  .label-filter-option[aria-pressed="true"] { background:var(--wl-tint); }
  .label-filter-option span { overflow-wrap:anywhere; }
  .label-dialog, .watchlist-dialog { width:min(620px, calc(100% - 30px)); padding:20px; border:0; border-radius:18px;
    color:var(--wl-text); background:var(--wl-surface); max-height:calc(100dvh - 24px); }
  .label-dialog::backdrop, .watchlist-dialog::backdrop { background:#0009; }
  :is(.remove-dialog, .progress-dialog) {
    width:min(460px, calc(100% - 30px)); padding:24px; border:0; border-radius:18px;
    text-align:center; box-shadow:0 16px 50px #0007;
  }
  :is(.remove-dialog, .progress-dialog) h2 { font-size:1.5rem; }
  :is(.remove-dialog, .progress-dialog) p { margin:16px 0 0; color:var(--wl-muted); line-height:1.5; }
  :is(.remove-dialog, .progress-dialog) footer { display:flex; flex-wrap:wrap; gap:10px; justify-content:center; margin-top:20px; }
  :is(.remove-dialog, .progress-dialog) footer button, .label-dialog-actions button { border-radius:999px; padding-inline:17px; }
  .progress-dialog .confirmation-icon { color:var(--wl-accent); background:var(--wl-tint); }
  .remove-dialog footer .filled { color:#fff; background:var(--error-color,#db4437); border-color:transparent; }
  .remove-dialog footer .filled:hover:not(:disabled) { background:color-mix(in srgb,var(--error-color,#db4437) 87%,black); }
  :is([data-remove-error], [data-progress-error]):not(:empty) { margin-top:10px; }
  .image-dialog { width:fit-content; max-width:min(900px, calc(100% - 30px)); padding:18px; border:0; box-shadow:0 16px 50px #0007; }
  .image-viewer-body { display:grid; place-items:center; margin-top:12px; }
  .image-viewer-body img { display:block; max-width:100%; max-height:calc(100dvh - 156px); object-fit:contain; border-radius:8px; }
  .image-viewer header,.label-dialog header { padding:0; border:0; min-height:42px; }
  .image-viewer header h3 { overflow-wrap:anywhere; }
  .preview-image { padding:0; border:0; min-height:0; cursor:zoom-in; }
  .preview-image:hover img { filter:brightness(1.08); }
  .hero-status { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .watch-scope { display:inline-flex; align-items:center; gap:5px; padding:4px 8px; border-radius:8px;
    background:var(--wl-surface); color:var(--wl-muted); font-size:.83rem; }
  .watch-scope ha-icon { --mdc-icon-size:16px; }
  .title-menu, .availability-menu { position:relative; }
  .title-menu summary, .availability-menu summary { display:grid; place-items:center; width:42px; height:42px; cursor:pointer;
    border:1px solid var(--wl-line); border-radius:11px; list-style:none; }
  .title-menu summary::-webkit-details-marker, .availability-menu summary::-webkit-details-marker { display:none; }
  .title-menu summary ha-icon, .availability-menu summary ha-icon { --mdc-icon-size:21px; }
  .title-menu-page { display:grid; gap:2px; }
  .title-menu-page button { justify-content:flex-start; text-align:left; width:100%; border:0; }
  .title-menu-page button[aria-pressed="true"] { background:var(--wl-tint); }
  .title-menu-page button.danger { border-top:1px solid var(--wl-line); }
  .continue-watching { margin:0 0 18px; min-width:0; }
  .continue-watching h3 { margin:0 0 9px; }
  .continue-row { display:grid; grid-auto-flow:column; grid-auto-columns:clamp(165px, 29%, 230px); gap:10px;
    overflow-x:auto; padding:2px 2px 7px; scroll-snap-type:x proximity; }
  .continue-item { display:grid; grid-template-columns:minmax(0, 1fr); grid-template-rows:auto 1fr; scroll-snap-align:start; }
  .continue-card { display:grid; grid-column:1; grid-row:1 / 3; grid-template-rows:subgrid; align-items:stretch;
    text-align:left; padding:0; gap:0; overflow:hidden; }
  .continue-remove { grid-column:1; grid-row:2; align-self:start; justify-self:end; z-index:1;
    margin:8px 7px 0 0; width:30px; min-height:30px;
    border:0; border-radius:50%; }
  .continue-remove ha-icon { --mdc-icon-size:18px; }
  .continue-art { position:relative; display:grid; place-items:center; aspect-ratio:16/9; overflow:hidden;
    background:var(--wl-tint); }
  .continue-art img { width:100%; height:100%; object-fit:cover; }
  .continue-play, .continue-remove { background:#15191dcc; color:white; }
  .continue-remove:hover:not(:disabled) { background:#0a0c0eee; }
  .continue-play { position:absolute; right:7px; bottom:7px; padding:4px;
    border-radius:50%; display:grid; place-items:center; }
  .continue-play ha-icon { --mdc-icon-size:22px; }
  .continue-copy { display:grid; align-content:start; gap:3px; padding:8px 10px; overflow-wrap:anywhere; }
  .continue-copy strong { min-height:27px; padding-inline-end:32px; }
  .continue-copy small { color:var(--wl-muted); }
  .title-cast { margin-top:18px; min-width:0; }
  .cast-row { display:grid; grid-auto-flow:column; grid-auto-columns:108px; gap:10px;
    padding:0 0 7px; margin:9px 0 0; overflow-x:auto; list-style:none; }
  .cast-row button, .cast-grid button { display:flex; flex-direction:column; align-items:stretch; justify-content:flex-start;
    width:100%; height:100%; gap:3px; padding:5px; text-align:start; overflow-wrap:anywhere; }
  .cast-row button small, .cast-grid button small { color:var(--wl-muted); }
  .cast-photo { display:grid; place-items:center; aspect-ratio:2/3; overflow:hidden;
    border-radius:9px; background:var(--wl-tint); }
  .cast-photo img { width:100%; height:100%; object-fit:cover; }
  .explore-dialog[open] { display:flex; flex-direction:column; width:min(700px, calc(100% - 24px));
    padding:0; max-height:calc(100dvh - 24px); overflow:hidden; }
  .explore-dialog header { min-height:0; flex:none; padding:10px 14px; }
  .explore-dialog header .actions { min-width:0; flex-wrap:nowrap; }
  .explore-dialog header button { flex:none; }
  .explore-dialog h3, .explore-body { overflow-wrap:anywhere; }
  .explore-body { display:grid; grid-template-columns:minmax(0, 1fr); gap:10px; overflow-y:auto; min-height:0; padding:14px; }
  .explore-body h4 { margin:0; }
  .explore-body .search-input { min-height:42px; }
  .explore-body .explore-feedback:empty { display:none; }
  .cast-grid, .filmography-list { display:grid; padding:0; margin:0; gap:8px; list-style:none; }
  .cast-grid { grid-template-columns:repeat(auto-fill, minmax(min(105px, 100%), 1fr)); }
  .actor-heading, .preview-heading { display:grid; grid-template-columns:68px minmax(0, 1fr); align-items:start; gap:12px; }
  .actor-heading p, .preview-heading p + p { margin-top:5px; }
  .filmography-list li { display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:center;
    border:1px solid var(--wl-line); border-radius:11px; }
  .filmography-list [data-action="filmography-title"] { display:grid; grid-template-columns:42px minmax(0, 1fr) auto; align-items:center;
    grid-column:1; width:100%; gap:9px; padding:7px; text-align:start; border:0; }
  .filmography-list small { display:block; margin-top:2px; }
  .filmography-list .appearance-button { grid-column:2; margin-inline:3px 7px; }
  .actor-age { color:var(--wl-muted); }
  .appearance-list { list-style:none; padding:0; margin:0; display:grid; gap:8px; }
  .appearance-list li { border:1px solid var(--wl-line); border-radius:9px; padding:9px 12px; }
  .appearance-list small { display:block; }
  .availability { container-type:inline-size; min-width:0; border:1px solid var(--wl-line); border-radius:12px;
    padding:5px 11px 8px; margin:10px 0; }
  .availability .section-heading { margin:0; }
  .availability-menu-options { inset-inline: auto 0; min-width:0; }
  .availability-menu-options button, .availability-menu-options a { display:flex; align-items:center; gap:6px;
    justify-content:flex-start; width:100%; min-height:42px; border:0; border-radius:8px; padding:7px 10px;
    color:var(--wl-text); text-align:start; text-decoration:none; }
  .availability-menu-options a:hover { background:var(--wl-tint); }
  .availability-menu-options small { display:block; padding:5px 10px; max-width:255px; }
  .availability dl { display:grid; gap:5px; margin:4px 0; }
  .availability dl > div { display:grid; gap:3px 9px; align-items:start; }
  .availability dt { font-weight:650; font-size:.88rem; align-self:center; }
  .availability dt ha-icon { --mdc-icon-size:17px; margin-inline-end:5px; }
  .availability dd { display:flex; flex-wrap:wrap; gap:4px; margin:0; min-width:0; }
  .provider { display:inline-flex; align-items:center; gap:5px; max-width:100%; border:1px solid var(--wl-line);
    border-radius:6px; padding:3px 6px; font-size:.88rem; overflow-wrap:anywhere; }
  .provider img { flex:none; width:18px; height:18px; border-radius:4px; }
  .availability-footer { display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:start; gap:6px; margin-top:3px; }
  .availability-footer > small { grid-column:2; grid-row:1; }
  .other-providers { grid-column:1; grid-row:1; min-width:0; }
  .other-providers summary { cursor:pointer; font-size:.88rem; }
  @container (min-width:500px) {
    .availability dl > div { grid-template-columns:clamp(110px, 23cqw, 165px) minmax(0, 1fr); }
  }
  .subscription-hint { color:var(--wl-muted); font-size:.87rem; }
  .subscription-options { display:grid; gap:6px; }
  .subscription-options label { display:grid; grid-template-columns:20px 25px minmax(0, 1fr); align-items:center;
    gap:8px; min-height:42px; padding:7px 9px; border:1px solid var(--wl-line); border-radius:8px; cursor:pointer; }
  .subscription-options input { accent-color:var(--wl-accent); }
  .subscription-options img { width:25px; height:25px; border-radius:5px; }
  .entry[data-resume-episode] { border-color:var(--wl-accent); background:var(--wl-tint); }
  .favorites-switch { display:flex; gap:7px; min-height:42px; align-items:center; margin-inline-end:4px; }
  .favorites-switch input { accent-color:var(--wl-accent); }
  .favorite-active { color:#eab54a; }
  .saved-tile .poster-favorite { position:absolute; top:8px; right:8px; width:32px; height:32px; min-height:32px;
    padding:0; border:0; border-radius:50%; color:white; background:#15191d66; }
  .saved-tile .poster-favorite.favorite-active { color:#eab54a; }
  .saved-tile .poster-favorite:hover:not(:disabled) { background:#0a0c0eee; }
  .poster-favorite ha-icon { --mdc-icon-size:18px; filter:drop-shadow(0 1px 2px #000b); }
  .favorite-notice { position:absolute; z-index:2; bottom:10px; inset-inline-end:10px; max-width:calc(100% - 20px);
    padding:9px 12px; border:1px solid var(--wl-line); border-radius:10px; color:var(--wl-text); background:var(--wl-surface); }
  .favorite-notice:empty { padding:0; border:0; }
  .label-dialog-body { display:grid; gap:12px; margin-top:12px; }
  .label-dialog input { width:100%; padding:9px 12px; background:transparent;
    border:1px solid var(--wl-line); border-radius:10px; }
  .label-options { display:flex; flex-wrap:wrap; gap:8px; max-height:45dvh; overflow:auto; padding:3px; }
  .label-dialog-actions { justify-content:flex-start; margin-top:14px; }
  .label-error:empty { display:none; }
  .season-overview { margin:20px 0; }
  .season-overview h3 { margin-bottom:10px; font-size:1.25rem; }
  .season-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap:12px; }
  .season-tile { display:grid; grid-template-columns:84px minmax(0, 1fr) auto; gap:12px; padding:10px;
    text-align:start; background:color-mix(in srgb, var(--wl-text) 3%, var(--wl-surface)); }
  .season-tile > ha-icon { color:var(--wl-accent); }
  .season-copy { display:grid; gap:5px; min-width:0; overflow-wrap:anywhere; }
  .season-copy strong { font-size:1.13rem; }
  .season-copy progress { appearance:none; width:100%; max-width:180px; height:5px; margin:3px 0 0;
    border:0; border-radius:4px; overflow:hidden; background:var(--wl-line); accent-color:var(--wl-accent); }
  .season-copy progress::-webkit-progress-bar { background:var(--wl-line); }
  .season-copy progress::-webkit-progress-value { background:var(--wl-accent); }
  .season-copy progress::-moz-progress-bar { background:var(--wl-accent); }
  .season-art { display:grid; place-items:center; aspect-ratio:2 / 3; border-radius:8px; overflow:hidden; background:var(--wl-tint); }
  .season-art img { width: 100%; height: 100%; object-fit: cover; }
  .entries { display: grid; gap: 8px; }
  .entry { display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; gap: 11px; align-items: start;
    border: 1px solid var(--wl-line); border-radius: 10px; padding: 9px; }
  .entry.watched { background: var(--wl-tint); }
  .part { grid-template-columns: 45px minmax(0, 1fr) auto; align-items: center; }
  .entry > div { min-width: 0; overflow-wrap: anywhere; }
  .episode-menu > .label-filter-options:not(:popover-open) { right:0; left:auto; }
  .entry small { display: block; margin-top: 3px; }
  .entry p { margin-top: 5px; line-height: 1.4; color: var(--wl-muted); }
  .still, .part-poster { border-radius: 6px; aspect-ratio: 16 / 9; }
  .part-poster { aspect-ratio: 2 / 3; }
  .watched-button { color: var(--wl-accent); }
  @media (max-width: 600px) {
    :host([data-large]) { padding: 6px; }
    :host([data-fullscreen]) { padding: 0; }
  }
  @container (max-width: 600px) {
    .frame > header, .detail-navigation, .controls, .body { padding-inline: 12px; }
    .brand-heading { font-size:21px; }
    .hero { grid-template-columns: 64px minmax(0, 1fr); gap: 9px; padding: 10px; }
    .hero-copy .synopsis { font-size: .88rem; }
    .hero-updated { align-self: flex-start; text-align: start; }
    .season-overview { margin:15px 0; }
    .season-grid { gap:8px; }
    .season-tile { grid-template-columns:54px minmax(0, 1fr) auto; gap:9px; padding:8px; }
    .season-copy strong { font-size:1.05rem; }
    .entry { grid-template-columns: 53px minmax(0, 1fr); }
    .entry > .actions { grid-area: 2 / 2; justify-self: start; max-width: 100%; flex-wrap: wrap; }
    .entry > .episode-actions { display:grid; grid-template-columns:minmax(0, 1fr) auto; }
    .entry p { font-size: .85rem; }
  }
  @container (min-width: 860px) {
    .controls { grid-template-columns:auto minmax(0, 1fr) auto;
      grid-template-areas:"tabs search fullscreen"; }
    .controls nav { flex-wrap:nowrap; }
  }
  @container (max-width: 500px) {
    .controls { grid-template-areas:"tabs fullscreen" "search search"; }
    .controls:has(.toolbar-fullscreen:empty) nav { grid-column-end:-1; }
    .controls nav { flex-wrap:nowrap; }
    .controls nav button {
      display:inline-grid; place-items:center; flex:none; width:min(42px, calc((100% - 30px) / 4)); padding:0;
    }
    .controls nav button > span { display:none; }
    .search { gap:7px; }
    .filters[data-open] { display:grid; grid-template-columns:minmax(0, 1fr); }
  }
`;

if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, HaListManagerWatchlistCard);
window.customCards ||= [];
if (!window.customCards.some(card => card.type === ELEMENT)) {
  window.customCards.push({ type: ELEMENT, name: "HA List Manager · Watchlist", preview: true });
}
