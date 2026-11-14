// Shared editor presentation only; each card owns its draft and picker actions.
(() => {
  if (globalThis.HaListManagerDialogSections) return;
  const choices = new WeakMap();
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
    return `<div class="editor-section-wrap"><details class="editor-section" data-editor-section="${escapeHtml(kind)}" data-editor-context="${escapeHtml(context)}" ${isOpen(card, kind, context) ? "open" : ""}><summary><span class="editor-section-title">${escapeHtml(title)}</span><span class="editor-section-separator">·</span><span class="editor-section-summary" data-editor-summary>${escapeHtml(summary)}</span><ha-icon icon="mdi:chevron-down" aria-hidden="true"></ha-icon></summary><div class="editor-section-body">${content}</div></details>${notice}</div>`;
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

  function styles() {
    return `[data-quick-section-body][hidden]{display:none!important}ha-card h3>button.quick-section-toggle{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}ha-card h3>button.quick-section-toggle:focus-visible{outline:2px solid var(--primary-color)}.quick-section-toggle ha-icon{--mdc-icon-size:17px}.editor-section-wrap{margin-top:14px;min-width:0;border:1px solid var(--divider-color);border-radius:9px}.editor-section{min-width:0}.editor-section-wrap>[data-editor-notice]:not(:empty){padding:0 11px 11px}.editor-section-wrap>[data-editor-notice]>.field-help:first-child{margin-top:0}.editor-section>summary{display:flex;align-items:center;gap:7px;min-height:44px;padding:9px 11px;list-style:none;cursor:pointer;color:var(--primary-text-color);font-size:14px;font-weight:400}.editor-section>summary::-webkit-details-marker{display:none}.editor-section>summary:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px;border-radius:9px}.editor-section-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--secondary-text-color)}.editor-section>summary>ha-icon{flex:0 0 auto;margin-left:auto;--mdc-icon-size:20px;color:var(--secondary-text-color)}.editor-section[open]>summary>ha-icon{transform:rotate(180deg)}.editor-section-body{min-width:0;padding:0 11px 11px}.editor-section-body>.dialog-field,.editor-section-body>.label-selector{margin-top:0}.editor-section-body .selection-field-heading{display:none}`;
  }

  globalThis.HaListManagerDialogSections = { stateKey, isOpen, render, bind, refresh, styles, bindQuick, labelMarker, renderLabelGroups };
})();
