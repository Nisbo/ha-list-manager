// Shared personal label filters and their menu/popups. Each card supplies its own stock/offer modes.
(() => {
  if (globalThis.HaListManagerFilters) return;
  const HA_LM_API = "ha_list_manager";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const uiText = (key, values = {}, hass = null) => hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
  const locale = hass => String(hass?.locale?.language || hass?.language || "en").replace("_","-");
  const sendRequest = (hass,message) => hass.callWS({...message,language:locale(hass).toLowerCase().startsWith("de") ? "de" : "en"});
  class Filters {
  _toggleFilterMenu() {
    const menu = this.shadowRoot.querySelector("[data-filter-menu]");
    const button = this.shadowRoot.querySelector("[data-toggle-filter-menu]");
    if (!menu || !button) return;
    this._filterMenuOpen = !this._filterMenuOpen;
    menu.hidden = !this._filterMenuOpen;
    button.setAttribute("aria-expanded", String(this._filterMenuOpen));
    if (this._filterMenuOpen) {
      this._positionFilterMenu?.(menu,button);
      menu.querySelector("button")?.focus({preventScroll:true});
    }
  }
  _closeFilterMenu(returnFocus = false) {
    this._filterMenuOpen = false;
    const menu = this.shadowRoot.querySelector("[data-filter-menu]");
    if (menu) menu.hidden = true;
    const button = this.shadowRoot.querySelector("[data-toggle-filter-menu]");
    button?.setAttribute("aria-expanded", "false");
    if (returnFocus) button?.focus({preventScroll:true});
  }
  _applyFilterMenuChoice(mode) {
    const anchor = this._capturePageScrollAnchor(this.shadowRoot.querySelector("[data-toggle-filter-menu]"));
    this._closeFilterMenu();
    if (mode === "reset") this._setActiveLabelFilter(null, false);
    this._setFilterMode(mode === "reset" ? "all" : mode);
    this._refreshMetadataUi();
    this._restorePageScrollAnchor(anchor);
    this.shadowRoot.querySelector("[data-toggle-filter-menu]")?.focus({preventScroll:true});
  }
  _renderFilterButton() {
    const offers = this._filterModesEnabled();
    const labels = this._config.show_label_filter_button !== false;
    if (!offers && !labels) return "";
    const mode = this._filterMode();
    const labelFilter = this._activeLabelFilter();
    const active = mode !== "all" || Boolean(labelFilter);
    const title = this._filterText("combined_title");
    return `<div class="filter-menu-host ${this._config.option_row_position === "top" ? "menu-below" : ""}"><button type="button" class="${active ? "active" : ""}" data-toggle-filter-menu aria-haspopup="menu" aria-expanded="${this._filterMenuOpen}" title="${esc(title)}"><ha-icon icon="mdi:filter-variant"></ha-icon><span>${esc(title)}</span></button><div class="filter-menu" data-filter-menu role="menu" aria-label="${esc(title)}" ${this._filterMenuOpen ? "" : "hidden"}>
      ${labels ? `<button type="button" role="menuitem" class="${labelFilter ? "active" : ""}" data-menu-labels aria-haspopup="dialog"><ha-icon icon="mdi:label-multiple-outline"></ha-icon><span>${esc(this._filterText("label_menu"))}</span></button><button type="button" role="menuitem" class="nested-filter-item ${labelFilter?.id ? "active" : ""}" data-menu-presets aria-haspopup="dialog"><ha-icon icon="mdi:filter-variant"></ha-icon><span>${esc(this._filterText("quick_title"))}</span></button>` : ""}
      ${offers ? `${this._filterModeSettings ? `<button type="button" role="menuitem" data-menu-settings aria-haspopup="dialog"><ha-icon icon="mdi:calendar-filter-outline"></ha-icon><span>${esc(this._filterModeHeading())}</span></button>` : `<div class="filter-menu-heading" role="presentation">${esc(this._filterModeHeading())}</div>`}${this._filterModes().map(({value,label}) => `<button type="button" role="menuitemradio" aria-checked="${mode === value}" data-menu-offer="${value}"${this._filterModeSettings ? ' class="nested-filter-item"' : ""}><ha-icon icon="mdi:${mode === value ? "radiobox-marked" : "radiobox-blank"}"></ha-icon><span>${esc(label)}</span></button>`).join("")}${this._filterModeSettings ? `<button type="button" role="menuitem" class="nested-filter-item" data-menu-default><ha-icon icon="mdi:restore"></ha-icon><span>${esc(this._filterText("apply_default"))}</span></button>` : ""}` : ""}
      <div class="filter-menu-divider" role="separator"></div><button type="button" role="menuitem" data-menu-reset><ha-icon icon="mdi:filter-remove-outline"></ha-icon><span>${esc(this._filterText("clear_all"))}</span></button></div></div>`;
  }

  _filterText(key, values = {}) { return uiText(`filters.${key}`, values, this._hass); }
  _filterOwnerKey() { return `${this._hass?.user?.id || ""}:${this._listId() || ""}`; }
  _activeFilterKey() { return `ha-list-manager:shopping-label-filter:${encodeURIComponent(this._filterOwnerKey())}`; }
  _personalFilters() { return this._savedFilterScope === this._filterOwnerKey() ? this._savedLabelFilters : []; }
  _activeLabelFilter() {
    if (this._config.show_label_filter_button === false) return null;
    let selection;
    try { selection = JSON.parse(localStorage.getItem(this._activeFilterKey()) || "null"); } catch (_error) { selection = this._activeFilterMemory.get(this._activeFilterKey()) || null; }
    if (selection?.preset_id) return this._personalFilters().find((filter) => filter.id === selection.preset_id) || null;
    if (!Array.isArray(selection?.label_ids) || (!selection.label_ids.length && !selection.include_unlabeled)) return null;
    return selection;
  }
  _matchesLabelFilter(item, filter = this._activeLabelFilter()) {
    if (!filter) return true;
    const labels = item.labels || [];
    return (!labels.length && filter.include_unlabeled) || labels.some((label) => filter.label_ids.includes(label.id));
  }
  _setActiveLabelFilter(selection, refresh = true) {
    this._activeFilterMemory.set(this._activeFilterKey(), selection);
    try {
      if (selection) localStorage.setItem(this._activeFilterKey(), JSON.stringify(selection));
      else localStorage.removeItem(this._activeFilterKey());
    } catch (_error) {}
    if (refresh) this._refreshFilterView();
  }
  _invalidateSavedLabelFilters() {
    // Missed events while detached/offline must be fetched once on return.
    this._labelFiltersRequest++;
    this._savedFiltersStale = true;
  }
  async _loadSavedLabelFilters(refresh = true) {
    if (!this._hass?.user?.id || !this._listId()) return;
    const scope = this._filterOwnerKey();
    const request = ++this._labelFiltersRequest;
    const result = await sendRequest(this._hass, {type: `${HA_LM_API}/label_filters/list`, list_id: this._listId()});
    if (request !== this._labelFiltersRequest || scope !== this._filterOwnerKey()) return;
    this._savedLabelFilters = result.filters || [];
    this._savedFilterScope = scope;
    this._savedFiltersStale = false;
    if (refresh) this._refreshMetadataUi();
  }
  _refreshFilterView() {
    const anchor = this._labelFilterDialog?.pageAnchor || this._capturePageScrollAnchor();
    this._refreshMetadataUi();
    this._restorePageScrollAnchor(anchor);
  }
  _openLabelFilter(view = "selection") {
    this._closeFilterMenu();
    const pageAnchor = this._capturePageScrollAnchor(this.shadowRoot.querySelector("[data-toggle-filter-menu]"));
    const active = this._activeLabelFilter();
    this._chipDialog = false;
    this._labelFilterDialog = { view, pageAnchor, scrolls:{}, activateOnSave:true, label_ids: [...(active?.label_ids || [])], include_unlabeled: !!active?.include_unlabeled,
      name: active?.name || "", id: active?.id || null, revision: active?.revision, query: "", status: "", busy: false };
    this._lockScroll(); this._refreshMetadataUi();
    this.shadowRoot.querySelector("[data-close-label-filter]")?.focus({preventScroll: true});
  }
  _closeLabelFilter() {
    if (this._labelFilterDialog?.busy) return;
    const anchor = this._labelFilterDialog?.pageAnchor || this._capturePageScrollAnchor();
    this._labelFilterDialog = null;
    this._chipDialog = false;
    this._unlockScroll();
    this._refreshMetadataUi();
    this._restorePageScrollAnchor(anchor);
    this.shadowRoot.querySelector("[data-toggle-filter-menu], [data-open-chip-dialog]")?.focus({preventScroll: true});
  }

  _chooseSavedFilter(id) {
    if (this._personalFilters().some((entry) => entry.id === id)) this._setActiveLabelFilter({preset_id: id});
  }
  _changeFilterChoice(id) {
    const dialog = this._labelFilterDialog;
    if (!dialog || dialog.busy) return;
    if (id === "__unlabeled__") dialog.include_unlabeled = !dialog.include_unlabeled;
    else dialog.label_ids = dialog.label_ids.includes(id) ? dialog.label_ids.filter((value) => value !== id) : [...dialog.label_ids, id];
    dialog.status = "";
    this._setActiveLabelFilter(dialog.label_ids.length || dialog.include_unlabeled
      ? {label_ids: dialog.label_ids, include_unlabeled: dialog.include_unlabeled} : null);
  }
  async _saveLabelFilter() {
    const dialog = this._labelFilterDialog;
    if (!dialog || dialog.busy) return;
    const scope = this._filterOwnerKey();
    dialog.busy = true; dialog.status = ""; dialog.error = false; this._refreshMetadataUi();
    try {
      const result = await sendRequest(this._hass, {type: `${HA_LM_API}/label_filters/save`,
        list_id: this._listId(), name: dialog.name, label_ids: dialog.label_ids, include_unlabeled: dialog.include_unlabeled,
        ...(dialog.editing && dialog.id ? {filter_id: dialog.id, revision: dialog.revision} : {})});
      if (scope !== this._filterOwnerKey() || this._labelFilterDialog !== dialog) return;
      this._savedLabelFilters = [...this._personalFilters().filter((filter) => filter.id !== result.filter.id), result.filter]
        .sort((a, b) => a.name.localeCompare(b.name, locale(this._hass), {sensitivity: "base", numeric: true}));
      this._savedFilterScope = scope;
      Object.assign(dialog, result.filter, {label_ids: [...result.filter.label_ids], status: this._filterText("saved")});
      if (dialog.activateOnSave !== false) this._setActiveLabelFilter({preset_id: result.filter.id}, false);
      dialog.view = dialog.afterSave || "selection"; dialog.history = dialog.view === "manage" ? ["selection"] : [];
      Object.assign(dialog,{editing:false,id:null,revision:undefined,name:"",activateOnSave:true,afterSave:"selection"});
    } catch (error) { if (this._labelFilterDialog === dialog) { dialog.status = error?.message || String(error); dialog.error = true; } }
    finally { if (this._labelFilterDialog === dialog) { dialog.busy = false; this._refreshMetadataUi(); } }
  }
  async _deleteLabelFilter() {
    const dialog = this._labelFilterDialog;
    const filter = this._personalFilters().find((entry) => entry.id === dialog?.deleteId);
    if (!dialog || !filter || dialog.busy) return;
    dialog.busy = true; this._refreshMetadataUi();
    try {
      await sendRequest(this._hass, {type: `${HA_LM_API}/label_filters/delete`,
        list_id: this._listId(), filter_id: filter.id, revision: filter.revision});
      if (this._labelFilterDialog !== dialog) return;
      this._savedLabelFilters = this._personalFilters().filter((entry) => entry.id !== filter.id);
      if (dialog.id === filter.id) Object.assign(dialog, {id: null, revision: undefined, name: "", label_ids: [], include_unlabeled: false});
      dialog.deleteId = null; dialog.status = this._filterText("deleted"); dialog.view = "manage"; dialog.history = ["selection"];
    } catch (error) { if (this._labelFilterDialog === dialog) { dialog.status = error?.message || String(error); dialog.error = true; } }
    finally { if (this._labelFilterDialog === dialog) { dialog.busy = false; this._refreshMetadataUi(); } }
  }
  _filterView(view, back = false) {
    const dialog = this._labelFilterDialog;
    if (!dialog || dialog.busy) return;
    dialog.scrolls ||= {};
    dialog.scrolls[dialog.view || "selection"] = this.shadowRoot.querySelector("[data-label-filter-dialog]")?.scrollTop || 0;
    if (!back && view !== (dialog.view || "selection")) (dialog.history ||= []).push(dialog.view || "selection");
    if (view === "manage") Object.assign(dialog,{editing:false,id:null,revision:undefined,name:"",activateOnSave:true,afterSave:"selection"});
    dialog.view = view; dialog.status = ""; dialog.error = false;
    this._refreshMetadataUi();
    const node = this.shadowRoot.querySelector("[data-label-filter-dialog]");
    if (node) node.scrollTop = dialog.scrolls[view] || 0;
    this.shadowRoot.querySelector(view === "name" ? "[data-filter-name]" : "[data-close-label-filter]")?.focus({preventScroll: true});
  }
  _backFilterView() {
    const dialog = this._labelFilterDialog;
    if (!dialog || dialog.busy) return;
    this._filterView(dialog.history?.pop() || "selection", true);
  }
  _cancelFilterView() {
    if (this._labelFilterDialog?.view && !["selection","presets"].includes(this._labelFilterDialog.view)) this._backFilterView();
    else this._closeLabelFilter();
  }
  _editSavedFilter(id, rename = false) {
    const filter = this._personalFilters().find((entry) => entry.id === id);
    if (!filter) return;
    const old = this._labelFilterDialog || {};
    this._labelFilterDialog = {...old, ...filter, label_ids: [...filter.label_ids], query: "", busy: false,
      editing:true, activateOnSave: !rename, afterSave: "manage", status: "", error: false};
    if (!rename) this._setActiveLabelFilter({preset_id: id}, false);
    this._filterView(rename ? "name" : "selection");
  }
  _beginFilterSave() {
    const dialog = this._labelFilterDialog;
    if (!dialog || dialog.busy) return;
    // Applying a preset is separate from explicitly editing its definition.
    if (!dialog.editing) Object.assign(dialog,{editing:false,id:null,revision:undefined,name:"",activateOnSave:true,afterSave:"selection"});
    this._filterView("name");
  }
  _openSavedFilterMenu(id) {
    const filter = this._personalFilters().find((entry) => entry.id === id);
    if (!filter) return;
    this._openLabelFilter();
    this._labelFilterDialog.menuId = id;
    this._filterView("menu");
  }
  _renderLabelFilterControls(manage = false) {
    if (this._config.show_label_filter_button === false) return "";
    const active = this._activeLabelFilter();
    const filters = this._personalFilters();
    return `<section class="quick-filter-section">${manage ? '<div class="filter-section-title">' : ""}<h3>${esc(this._filterText("quick_title"))} <span>${filters.length}</span></h3>${manage ? `<button type="button" class="filter-header-button" data-manage-filters><ha-icon icon="mdi:pencil-outline"></ha-icon><span>${esc(this._filterText("manage_button"))}</span></button></div>` : ""}<div class="label-filter-controls">
      ${filters.map((filter) => `<button type="button" class="filter-preset ${active?.id === filter.id ? "active" : ""}" data-label-filter-preset="${esc(filter.id)}" aria-pressed="${active?.id === filter.id}" title="${esc(this._filterText("hold_actions", {name:filter.name}))}"><span>${esc(filter.name)}</span></button>`).join("")}</div></section>`;
  }
  _renderLabelFilterChoices() {
    const dialog = this._labelFilterDialog;
    if (!dialog) return "";
    const query = dialog.query.trim().toLocaleLowerCase();
    const labels = this._labels.filter((label) => !query || label.name.toLocaleLowerCase().includes(query));
    return [{id: "__unlabeled__", name: this._filterText("unlabeled"), icon: "mdi:label-off-outline"}, ...labels].map((label) => {
      const selected = label.id === "__unlabeled__" ? dialog.include_unlabeled : dialog.label_ids.includes(label.id);
      return `<button type="button" class="filter-label ${selected ? "selected" : ""}" data-filter-label="${esc(label.id)}" aria-pressed="${selected}" ${dialog.busy ? "disabled" : ""} style="${label.color ? `--filter-color:${esc(label.color)}` : ""}"><ha-icon icon="${esc(label.icon || "mdi:label-outline")}"></ha-icon><span>${esc(label.name)}</span><ha-icon icon="mdi:${selected ? "checkbox-marked" : "checkbox-blank-outline"}"></ha-icon></button>`;
    }).join("");
  }
  _renderLabelFilterDialog() {
    const dialog = this._labelFilterDialog;
    if (!dialog) return "";
    const view = dialog.view || "selection";
    const text = (key) => this._filterText(key);
    const saved = this._personalFilters();
    const missing = dialog.label_ids.some((id) => !this._labels.some((label) => label.id === id));
    const title = text(view === "manage" ? "manage" : view === "name" ? (dialog.activateOnSave === false ? "rename" : "save") : view === "menu" ? "actions" : view === "confirm" ? "delete" : view === "presets" ? "quick_title" : "title");
    const button = (attr, label, primary = false, icon = "") => `<button type="button" ${attr} class="${primary ? "primary" : ""}" ${dialog.busy ? "disabled" : ""}>${icon ? `<ha-icon icon="${icon}"></ha-icon>` : ""}${esc(label)}</button>`;
    let content;
    if (view === "presets") {
      content = `${this._renderLabelFilterControls(true)}${saved.length ? "" : `<p class="field-help">${esc(text("none_saved"))}</p>`}<footer>${button("data-close-label-filter",uiText("ui.close", {}, this._hass))}</footer>`;
    } else if (view === "manage") {
      content = `<div class="saved-filters">${saved.length ? saved.map((filter) => `<div class="saved-filter"><strong>${esc(filter.name)}</strong>${[
        ["load-filter", "apply", "mdi:check"], ["edit-filter", "edit", "mdi:pencil-outline"],
        ["rename-filter", "rename", "mdi:form-textbox"], ["delete-filter", "delete", "mdi:delete-outline"]
      ].map(([attr,key,icon]) => `<button type="button" class="icon-button ${key === "delete" ? "danger" : ""}" data-${attr}="${esc(filter.id)}" title="${esc(text(key))}" aria-label="${esc(text(key)+": "+filter.name)}" ${dialog.busy ? "disabled" : ""}><ha-icon icon="${icon}"></ha-icon></button>`).join("")}</div>`).join("") : `<p class="field-help">${esc(text("none_saved"))}</p>`}</div><footer>${button("data-new-filter",text("new_filter"))}${button("data-filter-back",text("back"))}</footer>`;
    } else if (view === "name") {
      content = `<label><span>${esc(text("name"))}</span><input data-filter-name value="${esc(dialog.name)}" maxlength="80" autocomplete="off" ${dialog.busy ? "disabled" : ""}></label><footer>${button("data-save-label-filter",text("save"),true)}${button("data-filter-back",uiText("ui.cancel", {}, this._hass))}</footer>`;
    } else if (view === "menu") {
      const filter = saved.find((entry) => entry.id === dialog.menuId);
      content = `<p><strong>${esc(filter?.name || "")}</strong></p><div class="filter-menu-actions">${button(`data-edit-filter="${esc(dialog.menuId)}"`,text("edit"),false,"mdi:pencil-outline")}${button(`data-delete-filter="${esc(dialog.menuId)}"`,text("delete"),false,"mdi:delete-outline")}</div>`;
    } else if (view === "confirm") {
      const filter = saved.find((entry) => entry.id === dialog.deleteId);
      content = `<p>${esc(this._filterText("confirm_named_delete",{name:filter?.name || ""}))}</p><footer><button type="button" class="danger" data-confirm-filter-delete ${dialog.busy ? "disabled" : ""}>${esc(text("delete"))}</button>${button("data-filter-back",uiText("ui.cancel", {}, this._hass))}</footer>`;
    } else {
      content = `<div class="label-filter-selection-heading"><h3>${esc(text("labels"))}</h3><button type="button" class="filter-header-button" data-manage-filters><ha-icon icon="mdi:pencil-outline"></ha-icon><span>${esc(text("manage_button"))}</span></button></div><label><span>${esc(text("search"))}</span><input type="search" data-filter-search value="${esc(dialog.query)}" autocomplete="off"></label><div class="filter-label-grid" data-filter-label-grid>${this._renderLabelFilterChoices()}</div>
        ${missing ? `<p class="filter-warning">${esc(text("missing"))}<button type="button" data-remove-missing-labels>${esc(text("remove_missing"))}</button></p>` : ""}<footer>${button("data-name-label-filter",text("save_selection"),true)}${button("data-close-label-filter",uiText("ui.close", {}, this._hass))}${button("data-clear-close-filter",text("clear_close"))}</footer>`;

    }
    return `<div class="backdrop label-filter-backdrop" data-label-filter-backdrop><section class="dialog label-filter-dialog filter-view-${view}" data-label-filter-dialog role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><div class="filter-header-actions"><button type="button" class="icon-button" data-close-label-filter aria-label="${uiText("ui.close", {}, this._hass)}" ${dialog.busy ? "disabled" : ""}><ha-icon icon="mdi:close"></ha-icon></button></div></header>${content}${dialog.status ? `<p class="filter-status ${dialog.error ? "error" : ""}" role="status">${esc(dialog.status)}</p>` : ""}</section></div>`;
  }
  _bindLabelFilter(root) {
    this._listen(root.querySelector("[data-label-filter-dialog]"), "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this._cancelFilterView(); }
      if (event.key === "Enter" && event.target.matches("[data-filter-name]")) { event.preventDefault(); this._saveLabelFilter(); }
      if (event.key === "Tab") {
        const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled)")];
        const first = buttons[0], last = buttons.at(-1), active = this.shadowRoot.activeElement;
        if (event.shiftKey && active === first) { event.preventDefault(); last?.focus({preventScroll: true}); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus({preventScroll: true}); }
      }
    });
    this._bindLabelFilterControls(root);
    root.querySelectorAll("[data-close-label-filter]").forEach((button) => this._listen(button, "click", () => this._closeLabelFilter()));
    this._listen(root.querySelector("[data-label-filter-backdrop]"), "click", (event) => { if (event.target === event.currentTarget) this._closeLabelFilter(); });
    this._bindFilterChoices(root);
    this._listen(root.querySelector("[data-filter-search]"), "input", (event) => {
      this._labelFilterDialog.query = event.target.value;
      const grid = root.querySelector("[data-filter-label-grid]");
      this._clearRenderListeners(grid); grid.innerHTML = this._renderLabelFilterChoices(); this._bindFilterChoices(grid);
    });
    this._listen(root.querySelector("[data-filter-name]"), "input", (event) => { this._labelFilterDialog.name = event.target.value; });
    this._listen(root.querySelector("[data-save-label-filter]"), "click", () => this._saveLabelFilter());
    this._listen(root.querySelector("[data-name-label-filter]"), "click", () => this._beginFilterSave());
    this._listen(root.querySelector("[data-manage-filters]"), "click", () => this._filterView("manage"));
    this._listen(root.querySelector("[data-new-filter]"), "click", () => { Object.assign(this._labelFilterDialog,{editing:false,id:null,revision:undefined,name:"",activateOnSave:true,afterSave:"selection"}); this._filterView("selection"); });
    this._listen(root.querySelector("[data-filter-back]"), "click", () => this._backFilterView());
    this._listen(root.querySelector("[data-clear-close-filter]"), "click", () => { this._setActiveLabelFilter(null,false); this._closeLabelFilter(); });
    root.querySelectorAll("[data-load-filter]").forEach((button) => this._listen(button,"click",()=>{this._chooseSavedFilter(button.dataset.loadFilter);this._closeLabelFilter();}));
    root.querySelectorAll("[data-edit-filter]").forEach((button) => this._listen(button,"click",()=>this._editSavedFilter(button.dataset.editFilter)));
    root.querySelectorAll("[data-rename-filter]").forEach((button) => this._listen(button,"click",()=>this._editSavedFilter(button.dataset.renameFilter,true)));
    root.querySelectorAll("[data-delete-filter]").forEach((button) => this._listen(button,"click",()=>{this._labelFilterDialog.deleteId=button.dataset.deleteFilter;this._filterView("confirm");}));
    this._listen(root.querySelector("[data-confirm-filter-delete]"),"click",()=>this._deleteLabelFilter());
    this._listen(root.querySelector("[data-remove-missing-labels]"),"click",()=>{
      this._labelFilterDialog.label_ids=this._labelFilterDialog.label_ids.filter(id=>this._labels.some(label=>label.id===id));
      this._setActiveLabelFilter({label_ids:this._labelFilterDialog.label_ids,include_unlabeled:this._labelFilterDialog.include_unlabeled});
    });
  }
  _bindLabelFilterControls(root) {
    root.querySelectorAll("[data-open-label-filter]").forEach((button)=>this._listen(button,"click",()=>this._openLabelFilter()));
    root.querySelectorAll("[data-label-filter-preset]").forEach((button)=>{
      const id=button.dataset.labelFilterPreset;
      const cancel=()=>{clearTimeout(this._filterPressTimer);this._filterPressTimer=null;};
      let startPoint=null;
      const open=()=>{cancel();this._filterSuppressClickUntil=Date.now()+800;this._openSavedFilterMenu(id);};
      this._listen(button,"pointerdown",event=>{
        if(event.button!==undefined&&event.button!==0)return;
        cancel();startPoint={x:event.clientX,y:event.clientY};
        this._filterPressTimer=setTimeout(()=>{if(button.isConnected)open();},600);
      });
      this._listen(button,"pointermove",event=>{if(startPoint&&Math.hypot(event.clientX-startPoint.x,event.clientY-startPoint.y)>10)cancel();});
      ["pointerup","pointercancel","pointerleave"].forEach(type=>this._listen(button,type,cancel));
      this._listen(button,"contextmenu",event=>{event.preventDefault();event.stopPropagation();if(Date.now()>=this._filterSuppressClickUntil || !this._filterSuppressClickUntil)open();});
      this._listen(button,"click",event=>{
        if(Date.now()<this._filterSuppressClickUntil){event.preventDefault();event.stopPropagation();return;}
        this._setActiveLabelFilter(this._activeLabelFilter()?.id===id?null:{preset_id:id},false);
        if (this._labelFilterDialog) {
          const active = this._activeLabelFilter();
          Object.assign(this._labelFilterDialog,{id:active?.id || null,revision:active?.revision,name:active?.name || "",label_ids:[...(active?.label_ids || [])],include_unlabeled:!!active?.include_unlabeled,status:""});
          if (this._labelFilterDialog.view === "presets") this._closeLabelFilter();
          else this._refreshFilterView();
        } else this._refreshFilterView();
      });
    });
  }
  _bindFilterMenu(root) {
    this._listen(root.querySelector("[data-toggle-filter-menu]"), "click", () => this._toggleFilterMenu());
    const menu = root.querySelector("[data-filter-menu]");
    if (!menu) return;
    menu.querySelectorAll("button").forEach(button => this._listen(button, "pointerdown", event => {
      // Keep Safari's focus loss from hiding a menu item before its tap arrives.
      if (event.button === 0) event.preventDefault();
    }));
    this._listen(menu.querySelector("[data-menu-labels]"), "click", () => this._openLabelFilter());
    this._listen(menu.querySelector("[data-menu-presets]"), "click", () => this._openLabelFilter("presets"));
    menu.querySelectorAll("[data-menu-offer]").forEach(button => this._listen(button, "click", () => this._applyFilterMenuChoice(button.dataset.menuOffer)));
    this._listen(menu.querySelector("[data-menu-reset]"), "click", () => this._applyFilterMenuChoice("reset"));
    this._listen(menu.querySelector("[data-menu-settings]"), "click", () => {this._closeFilterMenu();this._filterModeSettings();});
    this._listen(menu.querySelector("[data-menu-default]"), "click", () => {this._setActiveLabelFilter(null,false);this._applyFilterMenuChoice(this._savedTaskFilter());});
    const host = root.querySelector(".filter-menu-host");
    this._listen(host,"focusout",event=>{if (!event.currentTarget.contains(event.relatedTarget)) this._closeFilterMenu();});
    this._listen(host,"keydown",event=>{
      if (event.key === "Escape") { event.preventDefault();event.stopPropagation();this._closeFilterMenu(true);return; }
      if (!["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return;
      event.preventDefault();
      if (!this._filterMenuOpen) { this._toggleFilterMenu();return; }
      const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
      const current = buttons.indexOf(root.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1 : (current+(event.key === "ArrowUp" ? -1 : 1)+buttons.length)%buttons.length;
      buttons[next]?.focus({preventScroll:true});
    });
  }
  _bindFilterChoices(root) {
    root.querySelectorAll("[data-filter-label]").forEach((button)=>this._listen(button,"click",()=>this._changeFilterChoice(button.dataset.filterLabel)));
  }

  _labelFilterStyles() {
    const size = this._config.chip_font_size;
    const growth = Math.max(0, (size || 16) - 16);
    return `.label-filter-controls{display:flex;flex-wrap:wrap;gap:6px;min-width:0;max-width:100%}.label-filter-dialog{width:min(680px,100%)}.filter-label-grid{display:flex;flex-wrap:wrap;gap:8px;max-height:none;overflow:visible;padding:3px}.filter-label{display:inline-flex;align-items:center;gap:7px;max-width:100%;min-height:44px;padding:7px 11px;border:1px solid var(--divider-color);border-radius:22px;background:var(--secondary-background-color);color:var(--primary-text-color);text-align:left}.filter-label span{overflow-wrap:anywhere}.filter-label ha-icon{--mdc-icon-size:20px;flex-shrink:0;color:var(--filter-color,var(--primary-color))}.filter-label.selected{border-color:var(--filter-color,var(--primary-color));background:color-mix(in srgb,var(--filter-color,var(--primary-color)) 18%,var(--card-background-color))}.saved-filters{display:grid;gap:5px}.saved-filter{display:grid;grid-template-columns:minmax(0,1fr) repeat(4,36px);align-items:center;gap:5px;border-bottom:1px solid var(--divider-color)}.filter-warning{padding:9px;border-left:3px solid var(--warning-color);color:var(--warning-color)}.filter-status{overflow-wrap:anywhere;color:var(--primary-color)}.filter-label:focus-visible,.filter-preset:focus-visible{outline:2px solid var(--primary-color);outline-offset:1px}ha-card .quick-filter-section{margin:0 0 18px;padding:0 0 18px;border-bottom:1px solid var(--divider-color)}:is(.quick-chips,.quick-chips-panel).label-filter-only .quick-filter-section{margin:0;padding:0;border:0}
      ha-card .quick-filter-section h3{display:flex;align-items:center;gap:6px;margin:0 0 8px;color:var(--secondary-text-color);font-size:13px;font-weight:500}
      ha-card .quick-filter-section h3 span{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:var(--secondary-background-color);font-size:12px}
      ha-card .label-filter-controls{display:flex;flex-wrap:wrap;gap:${7 + growth / 2}px;min-width:0;max-width:100%}
      ha-card .label-filter-controls button{display:inline-flex;align-items:center;justify-content:center;max-width:100%;min-height:${32 + growth * 2}px;padding:${4 + growth / 4}px ${11 + growth / 2}px;border:1px solid var(--divider-color);border-radius:8px;box-sizing:border-box;font-size:${size == null ? "inherit" : `${size}px`};line-height:1.35;color:var(--primary-text-color);background:var(--secondary-background-color);overflow-wrap:anywhere;cursor:pointer;touch-action:manipulation}
      ha-card .chip-dialog .label-filter-controls button{min-height:${38 + growth * 2}px;padding:${6 + growth / 4}px ${13 + growth / 2}px}
      ha-card .label-filter-controls button.active{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 14%,var(--secondary-background-color));box-shadow:inset 0 2px 5px rgba(0,0,0,.35);color:var(--primary-color)}
      ha-card .label-filter-controls button:hover,ha-card .label-filter-controls button:focus-visible{outline:1px solid var(--primary-color);outline-offset:1px}
      .dialog-chip-section h3{display:flex;align-items:center;gap:6px;margin:0 0 8px;color:var(--secondary-text-color);font-size:13px;font-weight:500}.dialog-chip-section h3 span{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:var(--secondary-background-color);font-size:12px}.dialog-chip-section .dialog-chip-grid{margin-top:0}.dialog-chip-section+.dialog-chip-section{border-top:1px solid var(--divider-color);margin-top:18px;padding-top:18px}
      .filter-header-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;min-height:40px;padding:7px 12px;border:1px solid var(--primary-color);border-radius:20px;background:var(--primary-color);color:var(--text-primary-color,#fff);font:inherit;cursor:pointer}.filter-header-button ha-icon{--mdc-icon-size:20px;flex-shrink:0}.filter-view-menu{width:min(420px,100%);box-sizing:border-box}
      @media(max-width:600px){.chip-dialog header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.chip-dialog header>[data-close-chip-dialog]{grid-column:2;grid-row:1}.chip-dialog header>.filter-header-button{grid-column:1/-1;grid-row:2;justify-self:start}.filter-view-selection header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.filter-view-selection .filter-header-actions{display:contents}.filter-view-selection [data-close-label-filter]{grid-column:2;grid-row:1}}
      .filter-menu-host{position:relative;flex:0 0 auto}.filter-menu{position:absolute;z-index:35;bottom:calc(100% + 6px);left:0;width:270px;max-width:calc(100vw - 48px);box-sizing:border-box;padding:6px;border:1px solid var(--divider-color);border-radius:9px;background:var(--card-background-color);box-shadow:0 8px 24px rgba(0,0,0,.3)}.filter-menu-host.menu-below .filter-menu{top:calc(100% + 6px);bottom:auto}:is(.option-row,.tools) .filter-menu button{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;height:auto;min-height:42px;padding:9px 10px;border:0;border-radius:5px;font:inherit;color:var(--primary-text-color);background:transparent;text-align:left;white-space:normal}:is(.option-row,.tools) .filter-menu button>span{display:inline}:is(.option-row,.tools) .filter-menu button:hover,:is(.option-row,.tools) .filter-menu button:focus-visible,:is(.option-row,.tools) .filter-menu [aria-checked="true"],:is(.option-row,.tools) .filter-menu button.active{color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}:is(.option-row,.tools) .filter-menu .nested-filter-item{padding-left:28px}.filter-menu-heading{padding:12px 10px 5px;color:var(--secondary-text-color);font-size:13px}.filter-menu-divider{margin:6px 0;border-top:1px solid var(--divider-color)}.filter-section-title,.label-filter-selection-heading{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px}.filter-section-title h3,.label-filter-selection-heading h3{flex:1;margin:0!important;font-size:14px;font-weight:500;color:var(--secondary-text-color)}

      .filter-header-actions{display:flex;gap:8px;flex:0 0 auto}.filter-view-name{width:min(440px,100%)}.saved-filter strong{min-width:0;overflow-wrap:anywhere;font-weight:400}.filter-menu-actions{display:grid;gap:10px}.filter-menu-actions button{display:flex;align-items:center;gap:9px;min-height:44px;padding:8px 12px;border:1px solid var(--divider-color);border-radius:9px;background:transparent;color:var(--primary-text-color);font:inherit;text-align:left;cursor:pointer}.filter-menu-actions [data-delete-filter]{border-color:var(--error-color);color:var(--error-color)}`;
  }


  }
  globalThis.HaListManagerFilters = {
    install(prototype) {
      for (const key of Object.getOwnPropertyNames(Filters.prototype)) {
        if (key !== "constructor") Object.defineProperty(prototype,key,Object.getOwnPropertyDescriptor(Filters.prototype,key));
      }
    },
    init(card) {
      card._activeFilterMemory = new Map(); card._savedLabelFilters = []; card._savedFilterScope = null;
      card._savedFiltersStale = true; card._labelFiltersRequest = 0; card._labelFilterDialog = null; card._filterMenuOpen = false;
    },
  };
})();
