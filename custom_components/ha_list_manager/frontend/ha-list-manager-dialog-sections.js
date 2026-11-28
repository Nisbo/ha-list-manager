// Shared editor presentation and keyboard handling; cards own drafts, pickers and saves.
(() => {
  if (globalThis.HaListManagerDialogSections) return;
  const choices = new WeakMap();
  const enterPending = new WeakSet();
  const actionPending = new WeakSet();
  const focusedDrafts = new WeakMap();
  const focusedActions = new WeakSet();
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

  function stateKey(card, context, kind) {
    const identity = card._config?.card_id || card._config?.entity || card._config?.list_id
      || card._listId?.() || card._inventoryListId?.() || card._list?.id || "default";
    return ["ha-list-manager:editor-section", card._hass?.user?.id || "", card.localName || card.constructor.name,
      identity, context, kind].map((value) => encodeURIComponent(value)).join(":");
  }

  function isOpen(card, kind, context = "item") {
    const key = stateKey(card, context, kind);
    if (choices.get(card)?.has(key)) return choices.get(card).get(key);
    try { return localStorage.getItem(key) !== "0"; }
    catch (_error) { return true; }
  }

  function render(card, { kind, title, summary, content, notice = "", context = "item" }) {
    const summaryMarkup = summary == null ? "" : `<span class="editor-section-separator">·</span><span class="editor-section-summary" data-editor-summary>${escapeHtml(summary)}</span>`;
    return `<div class="editor-section-wrap"><details class="editor-section" data-editor-section="${escapeHtml(kind)}" data-editor-context="${escapeHtml(context)}" ${isOpen(card, kind, context) ? "open" : ""}><summary><span class="editor-section-title">${escapeHtml(title)}</span>${summaryMarkup}<ha-icon icon="mdi:chevron-down" aria-hidden="true"></ha-icon></summary><div class="editor-section-body">${content}</div></details>${notice}</div>`;
  }

  function refresh(card, root = card.shadowRoot) {
    root?.querySelectorAll("[data-editor-section]").forEach((section) => {
      const value = card._editorSectionSummary?.(section.dataset.editorSection, section.dataset.editorContext);
      const summary = section.querySelector("[data-editor-summary]");
      if (summary && value != null) summary.textContent = value;
    });
  }

  function bind(card, root = card.shadowRoot) {
    root?.querySelectorAll("[data-editor-section]").forEach((section) => {
      if (section._haLmSectionBound) { section._haLmSectionBound.previous = section.open; return; }
      section._haLmSectionBound = { previous: section.open };
      section.addEventListener("toggle", () => {
        // Parsing an initially open details also queues a toggle event.
        if (section.open === section._haLmSectionBound.previous) return;
        section._haLmSectionBound.previous = section.open;
        const key = stateKey(card, section.dataset.editorContext, section.dataset.editorSection);
        if (!choices.has(card)) choices.set(card, new Map());
        choices.get(card).set(key, section.open);
        try { localStorage.setItem(key, section.open ? "1" : "0"); }
        catch (_error) { /* Keep the current choice while browser storage is unavailable. */ }
      });
    });
    refresh(card, root);
    bindSaveEnter(card, root);
    bindAdditionalEnter(card, root);
  }

  async function handleEnter(card, event, action) {
    if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || card._busy || card._dialogSavePending || enterPending.has(card) || actionPending.has(card)) return;
    enterPending.add(card);
    try { await action(); }
    finally { enterPending.delete(card); }
  }

  function bindSaveEnter(card, root) {
    const save = root?.querySelector("[data-save-dialog],[data-save],[data-save-product-transfer]");
    const dialog = save?.closest?.(".dialog");
    if (!dialog) return;
    dialog.setAttribute?.("tabindex", "-1");
    if (focusedDrafts.get(card) !== card._dialog) {
      const draft = card._dialog;
      focusedDrafts.set(card, draft);
      // Run after the card restores its previous focus during DOM patching.
      // Focusing the dialog accepts hardware Enter without a soft keyboard.
      Promise.resolve().then(() => {
        if (card._dialog !== draft || !dialog.isConnected) return;
        const active = root.activeElement;
        if (active && active !== dialog && dialog.contains(active)) return;
        const name = dialog.querySelector('[data-d-name],[data-field="name"],[data-product-field="name"]');
        if (card._config?.focus_dialog_input === true && name) name.focus?.({ preventScroll: true });
        else dialog.focus?.({ preventScroll: true });
      });
    }
    bindActionEnter(card, root, {
      button: "[data-save-dialog],[data-save],[data-save-product-transfer]",
      lookup: target => target?.matches?.('[data-field="ean"],[data-product-field="ean"]')
        ? "[data-lookup-ean],[data-lookup-product-ean]" : null,
      allowed: () => card._dialog && ![card._confirmation, card._selectionPopup, card._imageDialog,
        card._itemAction, card._memberPicker, card._groupPicker, card._templateDialog,
        card._actionDialog, card._chipDialog, card._filterDialog, card._restockDialog, card._pendingScanPicker].some(Boolean),
      action: (_target, lookup) => lookup
        ? (card._lookupDialogEan ? card._lookupDialogEan() : card._lookupProductTransferEan())
        : (card._saveEditor ? card._saveEditor() : card._saveDialog()),
    });
  }

  async function runAction(card, action) {
    if (card._busy || card._dialogSavePending || actionPending.has(card)) return;
    actionPending.add(card);
    try { return await action(); }
    finally { actionPending.delete(card); }
  }

  function bindActionEnter(card, root, options) {
    const button = root?.querySelector(options.button), dialog = button?.closest?.(".dialog");
    if (!dialog) return;
    // Patched dialogs retain the listener but always resolve their current action.
    dialog._haLmEnterAction = options;
    if (options.focus && !focusedActions.has(options.focus)) {
      dialog.setAttribute?.("tabindex", "-1");
      Promise.resolve().then(() => {
        if (!dialog.isConnected || dialog._haLmEnterAction.focus !== options.focus || focusedActions.has(options.focus)) return;
        focusedActions.add(options.focus);
        const input = options.focusInput && dialog.querySelector(options.focusInput);
        if (card._config?.focus_dialog_input === true && input) input.focus?.({preventScroll:true});
        else if (!dialog.contains?.(root.activeElement)) dialog.focus?.({preventScroll:true});
      });
    }
    if (dialog._haLmSaveEnterBound) return;
    dialog._haLmSaveEnterBound = true;
    dialog.addEventListener("keydown", event => {
      const action = dialog._haLmEnterAction;
      if (card._config?.save_dialog_on_enter !== true || !dialog.isConnected || action.allowed && !action.allowed()) return;
      const target = event.composedPath?.()[0] || event.target;
      if (target?.getRootNode && target.getRootNode() !== dialog.getRootNode()) return;
      if (target?.closest?.(".dialog") && target.closest(".dialog") !== dialog) return;
      if (target?.closest?.('textarea,select,button,a,summary,[contenteditable="true"],[data-d-category],[data-category-input],[data-label-input],[role="combobox"],.picker-trigger-host input')
          || target?.disabled || target?.readOnly) return;
      const types = ["text", "search", "number", "email", "url", "tel", ...(action.checks ? ["radio", "checkbox"] : [])];
      if (target?.tagName === "INPUT" && !types.includes(target.type)) return;
      const lookup = action.lookup?.(target), control = dialog.querySelector(lookup || action.button);
      if (!control || control.disabled) return;
      return handleEnter(card, event, () => runAction(card, () => action.action(target, Boolean(lookup))));
    }, true);
  }

  function bindAdditionalEnter(card, root) {
    bindActionEnter(card, root, {button:"[data-save-template]", focus:card._templateDialog, focusInput:"[data-template-name]", allowed:()=>Boolean(card._templateDialog),
      action:()=>card._saveTemplateFromItem()});
    bindActionEnter(card, root, {button:"[data-confirm-item-action]", focus:card._itemAction, allowed:()=>Boolean(card._itemAction),
      action:()=>card._confirmItemAction()});
    bindActionEnter(card, root, {button:"[data-run-action]", checks:true, focus:card._actionDialog,
      allowed:()=>Boolean(card._actionDialog) && root.querySelector('input[name="todo-action"]:checked')?.value !== "delete",
      action:()=>card._runTaskAction()});
    bindActionEnter(card, root, {button:"[data-save-label-filter]", focus:card._labelFilterDialog, allowed:()=>Boolean(card._labelFilterDialog),
      action:()=>card._saveLabelFilter()});
    if (card._labelFilterDialog?.view === "selection") {
      bindActionEnter(card, root, {button:"[data-close-label-filter]", checks:true, focus:card._labelFilterDialog,
        allowed:()=>Boolean(card._labelFilterDialog) && !card._labelFilterDialog.busy,
        action:()=>card._closeLabelFilter()});
    }
  }

  function labelMarker(label, title = "") {
    if (!label?.hide_in_items) return "";
    return `<ha-icon class="filter-label-marker" icon="mdi:eye-off-outline" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" style="--mdc-icon-size:15px;flex-shrink:0;margin-inline-start:.3em;color:inherit!important;vertical-align:middle;position:relative;top:-.12em"></ha-icon>`;
  }

  function renderLabelGroups(entries, renderEntry, filterTitle, otherTitle) {
    if (!entries.some(entry => entry.hide_in_items)) return entries.map(renderEntry).join("");
    const indexed = entries.map((entry, index) => ({ entry, index }));
    return [
      { title: filterTitle, items: indexed.filter(({ entry }) => entry.hide_in_items) },
      { title: otherTitle, items: indexed.filter(({ entry }) => !entry.hide_in_items) },
    ].filter(group => group.items.length).map((group, index) =>
      `<div class="label-group-heading" style="flex-basis:100%;grid-column:1/-1;width:100%;box-sizing:border-box;font-size:14px;font-weight:400;color:var(--secondary-text-color);padding:12px 0 4px;${index ? "border-top:1px solid var(--divider-color);margin-top:8px;" : ""}">${escapeHtml(group.title)}</div>${group.items.map(({ entry, index }) => renderEntry(entry, index)).join("")}`
    ).join("");
  }

  function bindQuick(card, root = card.shadowRoot) {
    const scope = "aside.quick-chips, aside.quick-chips-panel, aside.todo-chips, .chip-dialog";
    root?.querySelectorAll(`${scope.split(", ").map(selector => selector + " h3").join(",")}`).forEach(heading => {
      const parent = heading.parentElement;
      const kind = parent.classList.contains("quick-filter-section") ? "filters"
        : parent.classList.contains("dish-chips") || parent.classList.contains("dialog-dishes") ? "dishes" : "chips";
      let button = heading.querySelector("[data-quick-section-toggle]");
      if (!button) {
        const title = [...heading.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join("").trim();
        if (!title) return;
        button = document.createElement("button");
        button.type = "button"; button.dataset.quickSectionToggle = kind;
        button.className = "quick-section-toggle";
        button.innerHTML = `${escapeHtml(title)}<ha-icon icon="mdi:chevron-down" aria-hidden="true"></ha-icon>`;
        [...heading.childNodes].filter(node => node.nodeType === 3).forEach(node => node.remove());
        heading.prepend(button);
      }
      const bodies = []; let sibling = heading.nextElementSibling;
      while (sibling) { bodies.push(sibling); sibling.dataset.quickSectionBody = kind; sibling = sibling.nextElementSibling; }
      const query = (card._inputValue ?? card._input ?? "").trim();
      const searchOpen = Boolean(query && bodies.some(body => body.querySelector("button")));
      const apply = () => {
        const open = searchOpen || isOpen(card, kind, "quick");
        button.setAttribute("aria-expanded", String(open));
        button.querySelector("ha-icon").style.transform = open ? "rotate(180deg)" : "";
        bodies.forEach(body => { body.hidden = !open; });
      };
      button._haLmQuickState = {bodies, kind};
      if (!button._haLmQuickBound) {
        button._haLmQuickBound = true;
        button.addEventListener("click", () => {
          const anchor = card._capturePageScrollAnchor?.(button);
          const key = stateKey(card, "quick", kind);
          if (!choices.has(card)) choices.set(card, new Map());
          const open = button.getAttribute("aria-expanded") !== "true";
          choices.get(card).set(key, open);
          try { localStorage.setItem(key, open ? "1" : "0"); } catch (_error) {}
          button.setAttribute("aria-expanded", String(open));
          button.querySelector("ha-icon").style.transform = open ? "rotate(180deg)" : "";
          button._haLmQuickState.bodies.forEach(body => { body.hidden = !open; });
          if (anchor) card._restorePageScrollAnchor?.(anchor);
        });
      }
      apply();
    });
  }

  function removeConfirmation({ title, message, actions, headingId, messageId, status = "", icon = "mdi:delete-outline" }) {
    const id = value => value ? ` id="${escapeHtml(value)}"` : "";
    return `<span class="confirmation-icon"><ha-icon icon="${escapeHtml(icon)}" aria-hidden="true"></ha-icon></span>
      <h2${id(headingId)}>${escapeHtml(title)}</h2><p${id(messageId)}>${escapeHtml(message)}</p>
      ${status}<footer>${actions}</footer>`;
  }

  function confirmationIconStyles() {
    return `.confirmation-icon{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 12px;border-radius:50%;
      color:var(--error-color,#db4437);background:color-mix(in srgb,var(--error-color,#db4437) 14%,transparent)}
      .confirmation-icon ha-icon{--mdc-icon-size:31px}`;
  }

  function styles() {
    return `[data-quick-section-body][hidden]{display:none!important}ha-card h3>button.quick-section-toggle{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}ha-card h3>button.quick-section-toggle:focus-visible{outline:2px solid var(--primary-color)}.quick-section-toggle ha-icon{--mdc-icon-size:17px}.editor-section-wrap{margin-top:14px;min-width:0;border:1px solid var(--divider-color);border-radius:9px}.editor-section{min-width:0}.editor-section-wrap>[data-editor-notice]:not(:empty){padding:0 11px 11px}.editor-section-wrap>[data-editor-notice]>.field-help:first-child{margin-top:0}.editor-section>summary{display:flex;align-items:center;gap:7px;min-height:44px;padding:9px 11px;list-style:none;cursor:pointer;color:var(--primary-text-color);font-size:14px;font-weight:400}.editor-section>summary::-webkit-details-marker{display:none}.editor-section>summary:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px;border-radius:9px}.editor-section-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--secondary-text-color)}.editor-section>summary>ha-icon{flex:0 0 auto;margin-left:auto;--mdc-icon-size:20px;color:var(--secondary-text-color)}.editor-section[open]>summary>ha-icon{transform:rotate(180deg)}.editor-section-body{min-width:0;padding:0 11px 11px}.editor-section-body>.dialog-field,.editor-section-body>.label-selector{margin-top:0}.editor-section-body .selection-field-heading{display:none}`;
  }

  function prepareAddFocus(card, selector) {
    if (card._config.refocus_after_add !== true) return;
    const config = card._config;
    const listId = card._listId();
    const connection = card._hass?.connection;
    const userId = card._hass?.user?.id;
    return () => {
      if (!card.isConnected || card._config !== config || card._listId() !== listId
          || card._hass?.connection !== connection || card._hass?.user?.id !== userId) return;
      if (card._dialog || card.shadowRoot.querySelector('[aria-modal="true"]')) return;
      const input = card.shadowRoot.querySelector(selector);
      if (input?.getClientRects().length && !input.disabled && !input.readOnly) {
        input.focus({ preventScroll: true });
      }
    };
  }

  globalThis.HaListManagerDialogSections = { stateKey, isOpen, render, bind, refresh, styles, removeConfirmation, confirmationIconStyles, bindQuick, labelMarker, renderLabelGroups, handleEnter, bindActionEnter, runAction, prepareAddFocus };
})();
