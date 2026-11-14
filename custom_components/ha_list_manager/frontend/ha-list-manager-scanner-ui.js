// Shared scanner target confirmation. No scan processing happens in this UI.
(() => {
  const pending = new WeakMap();
  const toolbars = new WeakMap();
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const text = (host,key,values={}) => host._hass.localize(`component.ha_list_manager.config_panel.scanner_target.${key}`,values);
  const request = (host,path,data={}) => host._hass.callWS({type:`ha_list_manager/${path}`,language:host._hass.language,...data});
  const same = (a,b) => a?.list_id === b?.list_id && a?.action === b?.action;
  function cancel(host) {
    const operation = pending.get(host);
    if (operation) { operation.cancelled = true; operation.close?.(false); }
  }
  function describe(host,target,lists) {
    if (target.action === "product") return text(host,"products");
    const list = lists.find(item=>item.id===target.list_id);
    const kind = list?.list_type === "inventory" ? "inventory" : list?.list_type === "shopping" ? "shopping" : "list";
    return text(host,kind,{name:list?.name || text(host,"unknown")});
  }
  function confirm(host,operation,current,next,lists) {
    return new Promise(resolve => {
      const focus = host.shadowRoot?.activeElement;
      const portal = document.createElement("div"), root = portal.attachShadow({mode:"open"});
      portal.setAttribute("data-scanner-target-confirm", "");
      root.innerHTML = `<style>:host{position:fixed;inset:0;z-index:20000;display:block;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,Roboto,sans-serif)}*{box-sizing:border-box}.backdrop{height:100dvh;display:grid;place-items:center;padding:max(18px,env(safe-area-inset-top),var(--safe-area-inset-top,0px)) 18px max(18px,env(safe-area-inset-bottom));background:#0009}.dialog{width:100%;max-width:520px;max-height:100%;overflow:auto;padding:24px;border-radius:16px;background:var(--card-background-color,#fff);box-shadow:0 8px 32px #0006}h2{margin:0 0 20px;font-size:24px;font-weight:500}p{margin:12px 0;line-height:1.5;overflow-wrap:anywhere}p span{display:block;color:var(--secondary-text-color);font-size:14px}footer{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px;margin-top:24px}button{font:inherit;min-height:44px;padding:10px 20px;border:1px solid var(--divider-color);border-radius:24px;color:var(--primary-text-color);background:transparent;cursor:pointer}button.primary{color:var(--text-primary-color,#fff);background:var(--primary-color);border-color:var(--primary-color)}button:focus-visible{outline:2px solid var(--primary-color);outline-offset:3px}</style><div class="backdrop"><section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="target-title"><h2 id="target-title">${esc(text(host,"title"))}</h2><p><span>${esc(text(host,"current"))}</span>${esc(describe(host,current,lists))}</p><p><span>${esc(text(host,"next"))}</span>${esc(describe(host,next,lists))}</p>${next.mode_label?`<p><span>${esc(text(host,"mode"))}</span>${esc(next.mode_label)}</p>`:""}<footer><button class="primary" data-switch>${esc(text(host,"switch"))}</button><button data-cancel>${esc(host._hass.localize("component.ha_list_manager.config_panel.ui.cancel"))}</button></footer></section></div>`;
      const finish = accepted => {
        if (operation.close !== finish) return;
        operation.close = null;
        portal.remove();
        if (focus?.isConnected) focus.focus({preventScroll:true});
        resolve(accepted);
      };
      operation.close = finish;
      root.querySelector("[data-switch]").onclick = ()=>finish(true);
      root.querySelector("[data-cancel]").onclick = ()=>finish(false);
      root.querySelector(".backdrop").onclick = event=>{if(event.target===event.currentTarget)finish(false);};
      root.addEventListener("keydown",event=>{
        if(event.key==="Escape"){event.preventDefault();event.stopPropagation();finish(false);}
        if(event.key==="Tab"){
          const buttons=[...root.querySelectorAll("button")],first=buttons[0],last=buttons.at(-1);
          if(event.shiftKey&&root.activeElement===first){event.preventDefault();last.focus({preventScroll:true});}
          else if(!event.shiftKey&&root.activeElement===last){event.preventDefault();first.focus({preventScroll:true});}
        }
      });
      document.body.append(portal);
      root.querySelector("[data-cancel]").focus({preventScroll:true});
    });
  }
  async function toggle(host,next) {
    if (pending.has(host)) return null;
    const operation = {cancelled:false};pending.set(host,operation);
    const section = host._activeSection;
    const valid = () => !operation.cancelled && host.isConnected
      && (typeof host._listId !== "function" || host._listId() === next.list_id)
      && (section === undefined || host._activeSection === section);
    try {
      let current = (await request(host,"scanner/target/get")).target;
      const clearing = current && (next.action === "product" ? current.action === "product" : current.list_id === next.list_id);
      if (!clearing && current) {
        const {lists} = await request(host,"lists/list");
        while (current && !same(current,next)) {
          if (!valid() || !await confirm(host,operation,current,next,lists)) return null;
          const latest = (await request(host,"scanner/target/get")).target;
          if (same(latest,current)) break;
          current = latest;
        }
      }
      if (!valid()) return null;
      return await request(host,clearing?"scanner/target/clear":next.action==="product"?"scanner/products/target/set":"scanner/target/set",clearing||next.action==="product"?{}:{list_id:next.list_id,action:next.action});
    } finally { if(pending.get(host)===operation)pending.delete(host); }
  }
  function stopToolbar(host) {
    const state=toolbars.get(host);
    if(state){state.observer?.disconnect();cancelAnimationFrame(state.frame);toolbars.delete(host);}
  }
  function fitToolbar(host) {
    stopToolbar(host);
    const row=host.shadowRoot?.querySelector(".option-row");
    if(!row || typeof ResizeObserver==="undefined")return;
    const selector="[data-shopping-scanner-target], [data-clear-completed]";
    for(const button of row.querySelectorAll(selector)){
      if(!button.hasAttribute("aria-label"))button.setAttribute("aria-label",button.textContent.trim());
      if(!button.title)button.title=button.textContent.trim();
    }
    if(!host.shadowRoot.querySelector("[data-scanner-toolbar-style]")){
      const style=document.createElement("style");style.setAttribute("data-scanner-toolbar-style","");
      style.textContent=`.scanner-toolbar-compact :is(${selector}){flex:0 0 38px;width:38px;min-width:38px;padding:0;gap:0}.scanner-toolbar-compact :is(${selector})>span{display:none}`;
      host.shadowRoot.append(style);
    }
    const state={};toolbars.set(host,state);
    const measure=()=>{
      if(toolbars.get(host)!==state || !row.isConnected)return;
      // Measure the full labels off-layout, so compact mode cannot oscillate
      // when its own narrower buttons trigger another ResizeObserver callback.
      const probe=row.cloneNode(true);probe.classList.remove("scanner-toolbar-compact");
      probe.setAttribute("aria-hidden","true");probe.inert=true;
      probe.style.cssText="position:fixed;visibility:hidden;pointer-events:none;width:max-content;max-width:none;flex-wrap:nowrap;left:-100000px;top:0;margin:0";
      // A cloned ha-icon has no rendered shadow DOM yet and initially measures
      // zero pixels. Reserve its real/CSS size before measuring the full row.
      const icons=Array.from(row.querySelectorAll("ha-icon"));
      probe.querySelectorAll("ha-icon").forEach((icon,index)=>{
        const source=icons[index],rect=source.getBoundingClientRect();
        const size=parseFloat(getComputedStyle(source).getPropertyValue("--mdc-icon-size"))||24;
        Object.assign(icon.style,{display:"inline-flex",width:`${rect.width||size}px`,height:`${rect.height||size}px`,flexShrink:"0"});
      });
      row.parentNode.append(probe);
      let needed=probe.getBoundingClientRect().width;
      const available=row.getBoundingClientRect().width;
      // The actual flex items also catch theme/layout differences from the
      // detached probe. Retain that full width while the labels are hidden.
      if(!row.classList.contains("scanner-toolbar-compact")){
        const css=getComputedStyle(row),px=value=>parseFloat(value)||0;
        const items=Array.from(row.children).filter(item=>getComputedStyle(item).display!=="none");
        const actual=items.reduce((total,item)=>{
          const style=getComputedStyle(item);
          return total+item.getBoundingClientRect().width+px(style.marginLeft)+px(style.marginRight);
        },px(css.paddingLeft)+px(css.paddingRight)+px(css.borderLeftWidth)+px(css.borderRightWidth)+Math.max(0,items.length-1)*px(css.columnGap));
        state.fullWidth=Math.max(needed,actual);
      }
      needed=Math.max(needed,state.fullWidth||0);
      probe.remove();
      row.classList.toggle("scanner-toolbar-compact",available>0&&Math.ceil(needed)+1>Math.floor(available));
    };
    state.observer=new ResizeObserver(()=>{cancelAnimationFrame(state.frame);state.frame=requestAnimationFrame(measure);});
    state.observer.observe(row);measure();
  }
  globalThis.HaListManagerScannerUi={toggle,cancel,fitToolbar,stopToolbar};
})();
