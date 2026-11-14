import "./ha-list-manager-scanner-ui.js?v=1.1.0b3-toolbar2";
import "./ha-list-manager-camera.js";
// Camera ownership and shopping scan dialogs stay outside card rerenders.
const instances = new WeakMap();
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const uuid = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (Number(c) ^ (typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(1))[0] : Math.random()*256) & 15 >> Number(c)/4).toString(16));
const styles = `
.hmlm-scan-overlay{position:fixed;inset:0;z-index:11000;display:grid;place-items:center;padding:max(18px,env(safe-area-inset-top),var(--safe-area-inset-top,0px)) max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom),var(--safe-area-inset-bottom,0px)) max(18px,env(safe-area-inset-left));background:#0009;color:var(--primary-text-color)}
.hmlm-scan-overlay[hidden]{display:none!important}.hmlm-scan-overlay *{box-sizing:border-box}.hmlm-scan-overlay .scan-dialog{width:min(640px,100%);max-height:calc(100dvh - max(36px,env(safe-area-inset-top),var(--safe-area-inset-top,0px)) - max(18px,env(safe-area-inset-bottom),var(--safe-area-inset-bottom,0px)));overflow:auto;overscroll-behavior:contain;padding:24px;border-radius:18px;background:var(--card-background-color,#fff);box-shadow:0 4px 24px #0006;font:inherit}.hmlm-scan-overlay header{display:flex;align-items:center;gap:12px;margin-bottom:18px}.hmlm-scan-overlay h2{font-size:24px;margin:0;flex:1}.hmlm-scan-overlay p{line-height:1.5;color:var(--secondary-text-color)}.hmlm-scan-overlay button{font:inherit;color:var(--primary-text-color);background:transparent;border:1px solid var(--divider-color);border-radius:24px;padding:10px 16px;min-height:44px;cursor:pointer}.hmlm-scan-overlay button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color)}.hmlm-scan-overlay button.danger{color:var(--error-color,#db4437);border-color:currentColor}.hmlm-scan-overlay button:disabled{opacity:.45;cursor:default}.hmlm-scan-overlay header button{border:0;padding:8px}.hmlm-scan-overlay .scan-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.hmlm-scan-overlay label{display:flex;flex-direction:column;gap:7px;margin:14px 0}.hmlm-scan-overlay input,.hmlm-scan-overlay select{width:100%;min-width:0;padding:12px;min-height:46px;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color);color:var(--primary-text-color);font:inherit}.hmlm-scan-overlay .scan-labels{display:flex;flex-wrap:wrap;gap:8px}.hmlm-scan-overlay .scan-label{display:inline-flex;flex-direction:row;align-items:center;gap:6px;margin:0;padding:8px;border:1px solid var(--divider-color);border-radius:20px}.hmlm-scan-overlay .scan-label ha-icon{--mdc-icon-size:18px;color:var(--scan-label-color,var(--primary-color))}.hmlm-scan-overlay .scan-label input{width:22px;min-height:22px;height:22px;margin:0}.hmlm-scan-overlay .scan-row{display:block;text-align:left;width:100%;border-radius:8px;margin-top:8px}.hmlm-scan-overlay .scan-warning{color:var(--warning-color,#ffa000)}.hmlm-scan-overlay .scan-error{color:var(--error-color,#db4437)}
`;
class ShoppingScanner {
  constructor(card) { this.card=card; this.session=uuid(); this.scans=[]; this.unsub=[]; this.stopped=true; this.seen=new Set(); }
  get hass(){ return this.card._hass; }
  get listId(){ return this.card._listId(); }
  t(key, values={}) { return this.hass?.localize?.(`component.ha_list_manager.config_panel.scan.${key}`,values)||""; }
  request(path,data={}) { return this.hass.callWS({type:`ha_list_manager/${path}`,language:String(this.hass.language||"en").split("-")[0],...data}); }
  local(){ return this.card._list?.list_type === "shopping" && this.card._list?.provider === "local"; }
  async start(){
    if (!this.stopped || !this.local()) return;
    const generation = this.generation = {};
    this.stopped=false; const connection=this.hass.connection; this.connection=connection;
    try {
      for (const event_type of ["ha_list_manager_scan_processed","ha_list_manager_scanner_target_changed"]){
        const unsubscribe=await connection.subscribeMessage(event=>this.event(event_type,event.data),{type:"ha_list_manager/subscribe",event_type});
        if(this.stopped||this.generation!==generation||this.connection!==connection){unsubscribe();return;}
        this.unsub.push(unsubscribe);
      }
      await this.refresh();
    } catch(error){if(this.generation===generation)this.stop();throw error;}
  }
  async sync(){ await this.start(); if(this.scope !== this.listId){ this.scope=this.listId; this.scans=[]; this.close(); await this.refresh(); } }
  stop(){ this.generation=null;this.refreshToken=null;this.scope=null;this.scans=[];this.target=null;this.stopped=true; this.unsub.splice(0).forEach(fn=>fn());clearInterval(this.heartbeat);this.heartbeat=null;this.close();this.cameraReader?.stop(); }
  async refresh(){
    const listId=this.listId,token=this.refreshToken={};
    if(!listId||!this.local()||this.stopped)return;
    const [queue,target]=await Promise.all([this.request("scanner/queue/list_for_list",{list_id:listId}),this.request("scanner/target/get")]);
    if(this.stopped||this.refreshToken!==token||listId!==this.listId)return;
    const changed=JSON.stringify(this.scans)!==JSON.stringify(queue.scans||[])||JSON.stringify(this.target)!==JSON.stringify(target.target);
    this.scans=queue.scans||[];this.target=target.target;
    if(changed)this.card._render();
  }
  event(type,data){
    if(this.stopped||!data)return;
    if(type.endsWith("target_changed")){this.target=data?.target===null?null:data;this.card._render();return;}
    if(data?.list_id!==this.listId)return;
    if(this.scan?.id===data.id){
      if(!["queued","offered","needs_input","processing"].includes(data.status)){this.close();}
      else {this.scan={...this.scan,...data};this.renderReview();}
    }
    if(data.status==="success"&&!this.seen.has(data.id)){
      this.seen.add(data.id);if(this.seen.size>200)this.seen.delete(this.seen.values().next().value);
      this.notify(data);
      this.card._load(true);
    }
    this.refresh().then(()=>{
      if(data.queued&&!data.collaboration_update&&!this.scan&&!this.portal&&!this.card._dialog&&document.visibilityState==="visible"){
        const record=this.scans.find(s=>s.id===data.id);if(record)this.openReview(record);
      }
    }).catch(()=>{});
  }
  notify(history){
    const message=this.t("added",{quantity:history.quantity,name:history.product_name||history.ean});
    if(this.card._setNotificationStatus)this.card._setNotificationStatus(message);
    else this.card._notificationStatus=message;
  }
  markup(){
    if(!this.local())return "";
    const active=this.target?.list_id===this.listId;
    const title=this.t(active?"scanner_on":"scanner_off")+". "+this.t("scanner_help");
    return `${this.card._config?.show_scanner_target_button === false ? "" : `<button type="button" data-shopping-scanner-target class="list-scanner ${active?"scan-active":""}" aria-pressed="${active}" aria-label="${esc(title)}" title="${esc(title)}"><ha-icon icon="mdi:barcode-scan"></ha-icon><span>${esc(this.t("scanner_label"))}</span></button>`}${this.scans.length?`<button type="button" data-shopping-scan-queue aria-label="${esc(this.t("queue",{count:this.scans.length}))}" title="${esc(this.t("queue",{count:this.scans.length}))}"><ha-icon icon="mdi:playlist-edit"></ha-icon><span>${esc(this.t("queue",{count:this.scans.length}))}</span><small class="scan-queue-count" aria-hidden="true">${this.scans.length}</small></button>`:""}`;
  }
  bind(root){
    this.card._listen(root.querySelector("[data-shopping-scanner-target]"),"click",()=>this.toggleTarget());
    this.card._listen(root.querySelector("[data-shopping-scan-queue]"),"click",()=>this.openQueue());
    this.card._listen(root.querySelector("[data-shopping-camera]"),"click",()=>this.openCamera());
  }
  async toggleTarget(){try{const listId=this.listId;const result=await globalThis.HaListManagerScannerUi.toggle(this.card,{list_id:listId,action:"add"});if(result&&!this.stopped&&this.listId===listId)await this.refresh();}catch(e){this.card._error=e.message||e.error?.message||this.t("capture_failed");this.card._render();}}
  mount(){
    if(this.portal)return this.portal;
    const portal=document.createElement("div");portal.className="hmlm-scan-overlay";portal.innerHTML=`<style>${styles}</style><section class="scan-dialog" role="dialog" aria-modal="true"></section>`;
    portal.addEventListener("click",e=>{if(e.target===portal)this.close();});
    this.keydown=e=>{if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();this.close();}};document.addEventListener("keydown",this.keydown,true);
    this.returnFocus=document.activeElement;document.body.append(portal);this.portal=portal;return portal;
  }
  header(title){return `<header><h2>${esc(title)}</h2><button type="button" data-close aria-label="${esc(this.t("close"))}"><ha-icon icon="mdi:close"></ha-icon></button></header>`;}
  setMarkup(content){
    const portal=this.mount(),dialog=portal.querySelector(".scan-dialog"),top=dialog.scrollTop,focus=document.activeElement;
    const field=focus?.dataset?.scanField,selection=typeof focus?.selectionStart==="number"?[focus.selectionStart,focus.selectionEnd]:null;
    dialog.innerHTML=content;dialog.scrollTop=top;
    if(field){const input=dialog.querySelector(`[data-scan-field="${field}"]`);input?.focus({preventScroll:true});if(selection&&input?.type==="text")input.setSelectionRange(...selection);dialog.scrollTop=top;}
    portal.querySelector("[data-close]")?.addEventListener("click",()=>this.close());
  }
  close(){
    this.lookupCapture=null;
    const scan=this.scan;this.scan=null;this.draft=null;clearInterval(this.heartbeat);this.heartbeat=null;
    this.portal?.remove();this.portal=null;document.removeEventListener?.("keydown",this.keydown,true);
    if(scan)this.request("scanner/queue/view",{scan_id:scan.id,session_id:this.session,open:false}).catch(()=>{});
    this.returnFocus?.focus?.({preventScroll:true});
  }
  openQueue(){this.close();this.setMarkup(this.header(this.t("queue_title"))+this.scans.map(scan=>`<button type="button" class="scan-row" data-open="${esc(scan.id)}">${esc(scan.product_name||scan.ean)} · ${scan.quantity}×</button>`).join("")+(this.scans.length?"":`<p>${esc(this.t("empty"))}</p>`));this.portal.querySelectorAll("[data-open]").forEach(el=>el.onclick=()=>this.openReview(this.scans.find(s=>s.id===el.dataset.open)));}
  async openReview(scan){
    if(!scan)return;
    this.close();this.scan=scan;this.draft={name:scan.product_name||"",brand:"",package_quantity:"",category_id:"",label_ids:[]};this.error="";
    try{
      const result=await this.request("scanner/queue/view",{scan_id:scan.id,session_id:this.session,open:true});
      if(this.scan?.id!==scan.id)return;
      this.scan=result.scan;this.renderReview();
      this.heartbeat=setInterval(()=>{if(this.scan)this.request("scanner/queue/view",{scan_id:this.scan.id,session_id:this.session,open:true}).then(r=>{if(this.scan?.id===r.scan.id){this.scan=r.scan;this.renderReview();}}).catch(()=>this.close());},15000);
    }catch(e){this.close();this.card._error=e.message||e.error?.message||this.t("capture_failed");this.card._render();}
  }
  renderReview(){
    if(!this.scan||!this.draft)return;
    const editing=this.scan.collaboration?.editor_session===this.session,locked=!!this.scan.collaboration?.editor_session&&!editing;
    const field=(key)=>`<label>${esc(this.t(key==="package_quantity"?"package":key))}<input type="text" maxlength="${key==="name"?300:key==="brand"?200:100}" data-scan-field="${key}" value="${esc(this.draft[key])}" ${editing&&!this.saving?"":"disabled"}></label>`;
    const categories=this.card._availableCategories?.()||[],labels=this.card._labels||[];
    this.setMarkup(this.header(this.t("queue_title"))+`<p>EAN ${esc(this.scan.ean)} · ${this.scan.quantity}×</p><p class="${locked?"scan-warning":""}">${esc(this.t(locked?"locked":"view_only"))}</p>${this.scan.collaboration?.viewers>1?`<p>${esc(this.t("open_elsewhere"))}</p>`:""}${field("name")}${field("brand")}${field("package_quantity")}<label>${esc(this.t("category"))}<select data-scan-field="category_id" ${editing&&!this.saving?"":"disabled"}><option value="">${esc(this.t("general"))}</option>${categories.filter(c=>!c.dynamic).map(c=>`<option value="${esc(c.id)}" ${c.id===this.draft.category_id?"selected":""}>${esc(c.name)}</option>`).join("")}</select></label>${labels.length?`<p>${esc(this.t("labels"))}</p>`:""}<div class="scan-labels">${labels.map(l=>`<label class="scan-label" style="--scan-label-color:${/^#[a-f0-9]{6}$/i.test(l.color||"")?l.color:"var(--primary-color)"}"><input type="checkbox" data-scan-label="${esc(l.id)}" ${this.draft.label_ids.includes(l.id)?"checked":""} ${editing&&!this.saving?"":"disabled"}><ha-icon icon="${esc(l.icon||"mdi:label-outline")}"></ha-icon>${esc(l.name)}</label>`).join("")}</div><p class="scan-error" role="alert">${esc(this.error||"")}</p><div class="scan-actions">${editing?`<button class="primary" data-save ${this.saving?"disabled":""}>${esc(this.t("save"))}</button>`:`<button class="primary" data-edit ${locked?"disabled":""}>${esc(this.t("edit"))}</button>`}<button class="danger" data-discard ${locked||this.saving?"disabled":""}>${esc(this.t("discard"))}</button><button data-close>${esc(this.t("close"))}</button></div>`);
    this.portal.querySelectorAll("[data-scan-field]").forEach(el=>el.addEventListener("input",()=>this.draft[el.dataset.scanField]=el.value));
    this.portal.querySelectorAll("[data-scan-label]").forEach(el=>el.onchange=()=>{const ids=new Set(this.draft.label_ids);el.checked?ids.add(el.dataset.scanLabel):ids.delete(el.dataset.scanLabel);this.draft.label_ids=[...ids];});
    this.portal.querySelector("[data-edit]")?.addEventListener("click",async()=>{try{const r=await this.request("scanner/queue/edit",{scan_id:this.scan.id,session_id:this.session});this.scan=r.scan;this.renderReview();}catch(e){this.error=e.message||e.error?.message||this.t("capture_failed");this.renderReview();}});
    this.portal.querySelector("[data-save]")?.addEventListener("click",()=>this.saveReview());
    this.portal.querySelector("[data-discard]")?.addEventListener("click",()=>this.discard());
    this.portal.querySelectorAll("[data-close]").forEach(el=>el.onclick=()=>this.close());
  }
  async saveReview(){
    if(!this.scan||this.saving)return;
    if(!this.draft.name.trim()){this.error=this.t("missing_name");this.renderReview();return;}
    const id=this.scan.id,draft={...this.draft,label_ids:[...this.draft.label_ids]};this.saving=true;this.renderReview();
    try{await this.request("scanner/queue/resolve",{scan_id:id,session_id:this.session,name:draft.name.trim(),brand:draft.brand||null,package_quantity:draft.package_quantity||null,category_id:draft.category_id||null,label_ids:draft.label_ids});if(this.scan?.id===id)this.close();await this.refresh();}catch(e){if(this.scan?.id===id)this.error=e.message||e.error?.message||this.t("capture_failed");}finally{this.saving=false;this.renderReview();}
  }
  async discard(){
    if(!this.scan||!window.confirm(this.t("discard_confirm")))return;
    try{await this.request("scanner/queue/discard",{scan_id:this.scan.id,session_id:this.session});this.close();await this.refresh();}catch(e){this.error=e.message||e.error?.message||this.t("capture_failed");this.renderReview();}
  }
  get camera(){return this.cameraReader?.camera;}
  async openCamera(){
    if(!this.cameraReader)this.cameraReader=new globalThis.HaListManagerCamera({
      hass:()=>this.hass,onCapture:capture=>this.submitCapture(capture),
      onError:message=>{this.card._error=message;this.card._render();},
    });
    await this.cameraReader.open({list_id:this.listId,quantity:this.card._requestedQuantity()});
  }
  closeCamera(){return this.cameraReader?.close()||Promise.resolve();}
  async submitCapture(capture){
    if(this.stopped||capture.list_id!==this.listId)return;
    this.close();this.lookupCapture=capture;
    this.setMarkup(this.header(this.t("camera_title"))+`<p>${esc(this.t("looking_up"))}</p>`);
    try {
      const result=await this.request("scanner/camera",{list_id:capture.list_id,ean:capture.ean,request_id:capture.request_id,quantity:capture.quantity});
      if(this.lookupCapture!==capture||this.stopped||capture.list_id!==this.listId)return;
      if(result.preview){
        const product={...result.preview,_new:!result.preview.id};
        const automatic=await this.card._matchingAutomaticCategory(product.name);
        if(this.lookupCapture!==capture||this.stopped||capture.list_id!==this.listId)return;
        this.close();
        this.card._openDialog(null,product,"",capture.quantity,false,automatic);
        this.card._dialog.camera_capture=capture;
        this.card._dialog.remember_product_category=true;
        this.card._dialog.initialState=this.card._dialogSnapshot();
        this.card._render();
      } else {this.close();this.notify(result.history);await this.card._load(true);}
    } catch(error) {
      if(this.lookupCapture!==capture||this.stopped)return;
      this.setMarkup(this.header(this.t("camera_title"))+`<p class="scan-error">${esc(this.t("capture_failed"))}</p><div class="scan-actions"><button class="primary" data-retry>${esc(this.t("camera_retry"))}</button><button data-close>${esc(this.t("close"))}</button></div>`);
      this.portal.querySelector("[data-retry]").onclick=()=>this.submitCapture(capture);
    }
  }
  async confirmDraft(draft){
    const capture=draft.camera_capture,product=draft.product;
    const payload=this.card._itemDraftPayload(draft,product);
    const result=await this.request("scanner/camera",{
      list_id:capture.list_id,ean:capture.ean,request_id:capture.request_id,confirm:true,
      quantity:payload.quantity,name:payload.name,description:payload.description,
      category_id:payload.category_id,category:payload.category,label_ids:payload.label_ids,
      offer_only:payload.offer_only,remember_product_category:payload.remember_product_category||false,
      remember_product_labels:payload.remember_product_labels||false,
      brand:product.brand||null,package_quantity:product.package_quantity||(product._new?draft.description:null)||null,
      image_url:product.image_url||null,product_source:product.source==="open_food_facts"?"open_food_facts":"manual",
    });
    this.notify(result.history);
  }

}
globalThis.HaListManagerShoppingScanner={for(card){let instance=instances.get(card);if(!instance){instance=new ShoppingScanner(card);instances.set(card,instance);}return instance;},stop(card){instances.get(card)?.stop();},ShoppingScanner};
