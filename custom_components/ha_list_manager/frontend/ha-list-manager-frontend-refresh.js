/* One update watcher per HA connection, shared by the panel and every card. */
(function registerFrontendRefresh() {
  if (globalThis.HaListManagerFrontendRefresh) return;
  const base = import.meta.url.slice(0, import.meta.url.lastIndexOf("/") + 1);
  const loadedRevision = base.match(/\/ha_list_manager_assets\/([a-f0-9]{24})\//)?.[1] || null;
  const monitors = new Map(), owners = new WeakMap();
  let banner = null;
  const text = (host, key) => host._hass?.localize?.(`component.ha_list_manager.config_panel.frontend_update.${key}`) || "";
  const dirty = () => [...monitors.values()].some(m => [...m.hosts].some(h => h._dialog || h._actionDialog || h._selectionPopup || h._productDialog || h._labelFilterDialog || h._filterDialog || h._templateDialog));
  const currentHost = () => [...monitors.values()].flatMap(m => [...m.hosts]).find(h => h.isConnected);
  async function reload(host, renew = false) {
    if (dirty() && !window.confirm(text(host, "discard"))) return false;
    const result = await host._hass.callWS({type: `ha_list_manager/frontend/${renew ? "renew" : "info"}`});
    if (!/^[a-f0-9]{24}$/.test(result.revision)) throw new Error(text(host, "failed"));
    const url = new URL(window.location.href);
    url.searchParams.set("ha_lm_ui", result.revision);
    window.location.assign(url.href);
    return true;
  }
  function paint() {
    const updated = [...monitors.values()].find(m => m.updated && m.hosts.size);
    if (!updated) { banner?.remove(); banner = null; return; }
    const host = [...updated.hosts].find(h => h.isConnected) || currentHost();
    if (!host) return;
    if (!banner) {
      banner = document.createElement("div");
      banner.dataset.haLmFrontendUpdate = "";
      banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;bottom:calc(12px + env(safe-area-inset-bottom,0px));left:12px;right:12px;max-width:720px;margin:auto;z-index:900;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;box-sizing:border-box;border:1px solid var(--primary-color,#03a9f4);border-radius:12px;background:var(--card-background-color,#202020);color:var(--primary-text-color,#fff);box-shadow:0 4px 18px #0006;font:14px/1.5 var(--paper-font-body1_-_font-family,sans-serif)";
      const message = document.createElement("span"); message.style.flex = "1 1 220px";
      const button = document.createElement("button"); button.type = "button";
      button.style.cssText = "min-height:44px;padding:8px 16px;border:0;border-radius:22px;font:inherit;cursor:pointer;background:var(--primary-color,#03a9f4);color:var(--text-primary-color,#fff)";
      banner.append(message, button); document.body.append(banner);
    }
    banner.firstElementChild.textContent = text(host, "available");
    const button = banner.lastElementChild;
    button.textContent = text(host, "reload");
    button.onclick = async () => {
      button.disabled = true;
      try { await reload(host); }
      catch { if (banner) banner.firstElementChild.textContent = text(host, "failed"); }
      finally { button.disabled = false; }
    };
  }
  function detach(host) {
    const monitor = owners.get(host);
    if (!monitor) return;
    owners.delete(host); monitor.hosts.delete(host);
    if (!monitor.hosts.size) {
      monitor.active = false; clearInterval(monitor.timer);
      monitor.connection.removeEventListener?.("ready", monitor.ready);
      document.removeEventListener("visibilitychange", monitor.visible);
      monitor.unsubscribe?.(); monitors.delete(monitor.connection);
    }
    paint();
  }
  function attach(host) {
    if (!host.isConnected || !host._hass?.connection || !host._hass.callWS) return;
    const connection = host._hass.connection;
    const previous = owners.get(host);
    if (previous?.connection === connection) { paint(); return; }
    detach(host);
    let monitor = monitors.get(connection);
    if (!monitor) {
      monitor = {connection, hosts: new Set(), active: true, busy: false, updated: false, baseline: loadedRevision};
      monitor.check = async () => {
        if (!monitor.active || monitor.busy) return;
        const owner = [...monitor.hosts][0]; if (!owner) return;
        monitor.busy = true;
        try {
          const result = await owner._hass.callWS({type: "ha_list_manager/frontend/info"});
          if (!monitor.active || !/^[a-f0-9]{24}$/.test(result.revision)) return;
          monitor.baseline ||= result.revision;
          monitor.updated = result.revision !== monitor.baseline; paint();
        } catch { /* Reconnection and the next check retry without error banners. */ }
        finally { monitor.busy = false; }
      };
      monitor.ready = () => monitor.check();
      monitor.visible = () => { if (document.visibilityState === "visible") monitor.check(); };
      monitor.timer = setInterval(() => { if (document.visibilityState !== "hidden") monitor.check(); }, 30000);
      connection.addEventListener?.("ready", monitor.ready);
      document.addEventListener("visibilitychange", monitor.visible);
      monitors.set(connection, monitor);
      if (connection.subscribeEvents) {
        Promise.resolve().then(() => monitor.active ? connection.subscribeEvents(monitor.ready, "ha_list_manager_frontend_changed") : null).then(unsubscribe => {
          if (!unsubscribe) return;
          if (monitor.active) monitor.unsubscribe = unsubscribe; else unsubscribe();
        }).catch(() => {});
      }
    }
    monitor.hosts.add(host); owners.set(host, monitor); monitor.check();
  }
  globalThis.HaListManagerFrontendRefresh = {
    attach, detach, reload, assetUrl: filename => base + filename,
  };
})();
