/* Pointer sorting is owned by one card and only starts on its dedicated grip. */
(() => {
  if (globalThis.HaListManagerItemSort) return;
  const sessions = new WeakMap();
  const lifetimes = new WeakMap();
  const enabled = card => card._config.sort_mode === "manual" && (!card._list?.provider || card._list.provider === "local") && card._groupingMode() !== "labels";
  function cancel(card) {
    const session = sessions.get(card);
    if (!session) return;
    sessions.delete(card);
    cancelAnimationFrame(session.frame);
    session.row.classList.remove("sort-dragging");
    session.target?.classList.remove("sort-before", "sort-after");
    if (session.grip.hasPointerCapture?.(session.pointer)) session.grip.releasePointerCapture(session.pointer);
  }
  function detach(card) {
    cancel(card);
    lifetimes.set(card, (lifetimes.get(card) || 0) + 1);
  }
  function compatible(card, source, target) {
    return source && target && source.id !== target.id
      && card._categoryFor(source).id === card._categoryFor(target).id
      && (card._config.acknowledged !== "end" || source.completed === target.completed);
  }
  async function move(card, sourceId, targetId, after = false) {
    if (card.isConnected === false || card._busy || !enabled(card)) return;
    const source = card._items.find(item => item.id === sourceId), target = card._items.find(item => item.id === targetId);
    if (!compatible(card, source, target)) return;
    // Send all IDs, including filtered/hidden rows. The backend rejects stale sets.
    const ordered = card._items.slice().sort((a,b) => Number(a.position) - Number(b.position)).filter(item => item.id !== sourceId);
    ordered.splice(ordered.findIndex(item => item.id === targetId) + Number(after), 0, source);
    const listId = card._listId(), lifetime = lifetimes.get(card), loadRequestId = card._loadRequestId;
    const connection = card._hass?.connection, userId = card._hass?.user?.id;
    const current = () => card.isConnected !== false && lifetimes.get(card) === lifetime
      && card._listId() === listId && card._hass?.connection === connection && card._hass?.user?.id === userId;
    card._busy = true;
    try {
      const result = await card._saveManualOrder(ordered.map(item => item.id));
      // A newer live refresh may already include other users’ additions.
      if (current() && card._loadRequestId === loadRequestId) card._items = result.items;
    } catch (error) {
      if (current()) {
        await card._load(true);
        if (current()) card._error = error?.message || String(error);
      }
    } finally {
      card._busy = false;
      if (current()) {
        card._render();
        card.shadowRoot.querySelector(`[data-sort-grip="${sourceId}"]`)?.focus({preventScroll:true});
      }
    }
  }

  function scrollParent(row) {
    for (let node = row.parentElement; node; node = node.parentElement || node.getRootNode()?.host) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    }
    return window;
  }
  function point(card, session) {
    const row = card.shadowRoot.elementFromPoint(session.x, session.y)?.closest("[data-item-id]");
    const source = card._items.find(item => item.id === session.id);
    const target = card._visibleItems().find(item => item.id === row?.dataset.itemId);
    session.target?.classList.remove("sort-before", "sort-after");
    session.target = compatible(card, source, target) ? row : null;
    if (session.target) {
      const box = row.getBoundingClientRect();
      session.after = session.y > box.top + box.height / 2;
      row.classList.add(session.after ? "sort-after" : "sort-before");
    }
  }
  function tick(card, session) {
    if (sessions.get(card) !== session || !session.grip.isConnected) { cancel(card); return; }
    if (session.active) {
      const box = session.scroll === window ? {top:0, bottom:window.innerHeight} : session.scroll.getBoundingClientRect();
      const delta = session.y < box.top + 48 ? -12 : session.y > box.bottom - 48 ? 12 : 0;
      if (delta) session.scroll.scrollBy(0, delta);
      point(card, session);
    }
    session.frame = requestAnimationFrame(() => tick(card, session));
  }
  function bind(card, root) {
    root.querySelectorAll("[data-sort-grip]").forEach(grip => {
      card._listen(grip, "click", event => { event.preventDefault(); event.stopPropagation(); });
      card._listen(grip, "keydown", event => {
        if (event.key === "Escape") { cancel(card); event.preventDefault(); return; }
        if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.repeat || card._busy || !enabled(card)) return;
        event.preventDefault(); event.stopPropagation();
        const source = card._items.find(item => item.id === grip.dataset.sortGrip);
        const siblings = card._visibleItems().filter(item => item.id === source?.id || compatible(card, source, item));
        const index = siblings.findIndex(item => item.id === source?.id);
        const target = siblings[index + (event.key === "ArrowUp" ? -1 : 1)];
        if (source && target) move(card, source.id, target.id, event.key === "ArrowDown");
      });
      card._listen(grip, "pointerdown", event => {
        if (event.button !== 0 || !event.isPrimary || card._busy || !enabled(card)) return;
        event.preventDefault(); event.stopPropagation(); cancel(card);
        grip.focus({preventScroll:true});
        const row = grip.closest("[data-item-id]");
        const session = {grip, row, id:grip.dataset.sortGrip, pointer:event.pointerId, x:event.clientX, y:event.clientY, startX:event.clientX, startY:event.clientY, scroll:scrollParent(row), active:false};
        sessions.set(card, session); grip.setPointerCapture(event.pointerId);
        session.frame = requestAnimationFrame(() => tick(card, session));
      });
      card._listen(grip, "pointermove", event => {
        const session = sessions.get(card); if (!session || session.pointer !== event.pointerId) return;
        session.x = event.clientX; session.y = event.clientY;
        if (!session.active && Math.hypot(session.x-session.startX, session.y-session.startY) >= 6) {
          session.active = true; session.row.classList.add("sort-dragging");
        }
        if (session.active) { event.preventDefault(); point(card, session); }
      });
      card._listen(grip, "pointerup", event => {
        const session = sessions.get(card); if (!session || session.pointer !== event.pointerId) return;
        const targetId = session.active && session.target?.dataset.itemId, after = session.after;
        cancel(card);
        if (targetId) move(card, session.id, targetId, after);
      });
      for (const type of ["pointercancel", "lostpointercapture"]) card._listen(grip, type, () => cancel(card));
    });
  }
  const styles = () => `.item.manual-sort:not(.with-image):not(.without-image){grid-template-columns:30px auto minmax(0,1fr)}.item.with-image.manual-sort{grid-template-columns:30px 38px 46px minmax(0,1fr) auto}.item.without-image.manual-sort{grid-template-columns:30px 38px minmax(0,1fr) auto}.item>.sort-grip{width:28px;min-height:44px;padding:0;border:0;background:transparent;color:var(--secondary-text-color);cursor:grab;touch-action:none;user-select:none}.sort-grip ha-icon{--mdc-icon-size:22px;pointer-events:none}.item.sort-dragging{opacity:.45}.item.sort-before{box-shadow:inset 0 3px var(--primary-color)}.item.sort-after{box-shadow:inset 0 -3px var(--primary-color)}.sort-grip:focus-visible{outline:2px solid var(--primary-color);border-radius:4px}`;
  globalThis.HaListManagerItemSort = {enabled, compatible, move, bind, cancel, detach, styles};
})();
