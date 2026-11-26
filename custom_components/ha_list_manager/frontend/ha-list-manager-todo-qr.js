import "./ha-list-manager-qr-encoder.js";
import "./ha-list-manager-camera.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const prefix='HA-LM:TODO:1:';
const styles=`.todo-qr-overlay{position:fixed;inset:0;z-index:11001;display:grid;place-items:center;padding:18px;background:#0009;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,inherit)}.todo-qr-overlay *{box-sizing:border-box}.todo-qr-panel{width:min(540px,100%);max-height:calc(100dvh - 36px);overflow:auto;padding:22px;border-radius:var(--ha-card-border-radius,12px);background:var(--card-background-color,#222)}.todo-qr-panel header{display:flex;align-items:center;gap:12px}.todo-qr-panel h2{font-size:22px;font-weight:400;flex:1;margin:0}.todo-qr-panel p{line-height:1.5;overflow-wrap:anywhere}.todo-qr-panel button,.todo-qr-panel select{font:inherit;color:inherit;background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:10px;padding:10px 14px;min-height:44px;cursor:pointer}.todo-qr-panel button:disabled{opacity:.5;cursor:default}.todo-qr-panel ha-icon{--mdc-icon-size:20px}.todo-qr-panel select{width:100%;margin:10px 0}.todo-qr-panel footer{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.todo-qr-image{display:grid;place-items:center;min-height:245px;background:white;border-radius:8px;padding:20px}.todo-qr-image canvas,.todo-qr-image img{width:220px!important;height:220px!important;max-width:100%}.todo-qr-panel .help{font-size:13px;color:var(--secondary-text-color)}.todo-qr-panel [data-qr-status]{color:var(--error-color)}.todo-qr-panel .primary{color:var(--text-primary-color,#fff);background:var(--primary-color)}.todo-qr-print{position:fixed;width:1px;height:1px;right:0;bottom:0;border:0}`;
class TaskQr {
  constructor(card){this.card=card;this.generation=0;this.camera=new globalThis.HaListManagerCamera({hass:()=>card._hass,allowText:true,onCapture:c=>this.capture(c),onError:e=>this.error(e)});}
  t(key){return this.card._hass?.localize?.(`component.ha_list_manager.config_panel.todoqr.${key}`)||'';}
  api(type,data){return this.card._hass.callWS({type:'ha_list_manager/todo_qr/'+type,language:this.card._hass.language,...data});}
  action(a){return this.t('action_'+a);}
  error(e){if(this.portal)this.portal.querySelector('[data-qr-status]').textContent=String(e?.message||e);else if(this.card.isConnected){this.card._error=String(e?.message||e);this.card._render();}}
  close(){this.generation++;this.portal?.remove();if(this.overflow!==undefined){document.body.style.overflow=this.overflow;this.overflow=undefined}if(this.previousFocus?.isConnected)this.previousFocus.focus?.({preventScroll:true});this.previousFocus=null;this.portal=null;this.card._todoQrDialog=null;document.removeEventListener('keydown',this.escape,true);this.printFrame?.remove();this.printFrame=null;clearTimeout(this.printTimer);this._applying=false;}
  stop(){this.close();this.camera.stop();}
  dialog(title){
    this.close();this.card._todoQrDialog=true;this.previousFocus=this.card.shadowRoot?.activeElement||document.activeElement;this.overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    this.portal=document.createElement('div');this.portal.className='todo-qr-overlay';this.portal.innerHTML=`<style>${styles}</style><section class="todo-qr-panel" role="dialog" aria-modal="true"><header><h2>${esc(title)}</h2><button data-qr-close aria-label="${esc(this.t('close'))}"><ha-icon icon="mdi:close"></ha-icon></button></header><div data-qr-body></div><p data-qr-status role="status"></p><footer></footer></section>`;
    this.escape=e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(!this._applying)this.close()}
      else if(e.key==='Tab'){
        const controls=[...this.portal.querySelectorAll('button:not(:disabled),select:not(:disabled)')],first=controls[0],last=controls.at(-1),active=document.activeElement;
        if(!first){e.preventDefault();return}
        if(e.shiftKey&&(active===first||!this.portal.contains(active))){e.preventDefault();last.focus({preventScroll:true})}
        else if(!e.shiftKey&&(active===last||!this.portal.contains(active))){e.preventDefault();first.focus({preventScroll:true})}
      }
    };document.addEventListener('keydown',this.escape,true);this.portal.querySelector('[data-qr-close]').onclick=()=>{if(!this._applying)this.close()};document.body.append(this.portal);this.portal.querySelector('[data-qr-close]').focus();return this.portal;
  }
  async create(item){
    const portal=this.dialog(this.t('create'));const generation=this.generation;
    const available=a=>!['now','next'].includes(a)||Boolean(item.due_at&&this.card._interval(item));
    this.actionValue=available('now')?'now':'checked';
    portal.querySelector('[data-qr-body]').innerHTML=`<p><strong>${esc(this.card._name(item))}</strong></p><label>${esc(this.t('choose'))}<select data-qr-action>${['now','next','done','checked'].map(a=>`<option value="${a}" ${a===this.actionValue?'selected':''} ${available(a)?'':'disabled'}>${esc(this.action(a))}</option>`).join('')}</select></label><div class="todo-qr-image" data-qr-image></div><p class="help">${esc(this.t('code_help'))}</p><p class="help">${esc(this.t('duplicates_help'))}</p>`;
    portal.querySelector('footer').innerHTML=`<button data-qr-copy>${esc(this.t('copy_image'))}</button><button data-qr-download>${esc(this.t('download'))}</button><button data-qr-print>${esc(this.t('print'))}</button>`;
    portal.querySelector('[data-qr-copy]').onclick=()=>this.export('copy');portal.querySelector('[data-qr-download]').onclick=()=>this.export('download');portal.querySelector('[data-qr-print]').onclick=()=>this.export('print');
    const draw=async()=>{const run=++this.drawRun;this.actionValue=portal.querySelector('[data-qr-action]').value;this.code=prefix+item.id+':'+this.actionValue;this.label=this.card._name(item);portal.querySelectorAll('footer button').forEach(b=>b.disabled=true);try{await this.api('preview',{code:this.code});await globalThis.HaListManagerQrEncoder.load();if(!this.card.isConnected||this.generation!==generation||run!==this.drawRun)return;const holder=portal.querySelector('[data-qr-image]');holder.replaceChildren();new window.QRCode(holder,{text:this.code,width:220,height:220,correctLevel:window.QRCode.CorrectLevel.M});this.canvas=holder.querySelector('canvas');if(!this.canvas)throw Error(this.t('failed'));portal.querySelector('[data-qr-status]').textContent='';portal.querySelectorAll('footer button').forEach(b=>b.disabled=false);}catch(e){if(this.generation===generation&&run===this.drawRun)this.error(e)}};
    this.drawRun=0;portal.querySelector('[data-qr-action]').onchange=draw;await draw();
  }
  async export(mode){
    if(!this.canvas||!this.portal)return;
    const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=1250;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,1000,1250);c.imageSmoothingEnabled=false;c.drawImage(this.canvas,100,70,800,800);c.fillStyle='#111';c.font='bold 32px sans-serif';c.textAlign='center';
    let line='',y=930;for(const word of this.label.split(/\s+/)){if(c.measureText(line+' '+word).width>900){c.fillText(line,500,y);y+=40;line=''}line+=(line?' ':'')+word;if(y>1050)break}c.fillText(line,500,y);c.font='26px sans-serif';c.fillText(this.action(this.actionValue),500,1150,900);
    try{
      if(mode==='copy'){if(!navigator.clipboard?.write||!window.ClipboardItem)throw Error(this.t('copy_unavailable'));const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);if(this.portal)this.portal.querySelector('[data-qr-status]').textContent=this.t('copied');}
      else if(mode==='download'){const a=document.createElement('a');a.download='todo-qr-'+this.actionValue+'.png';a.href=canvas.toDataURL();a.click();}
      else{this.printFrame?.remove();clearTimeout(this.printTimer);const frame=document.createElement('iframe');this.printFrame=frame;frame.className='todo-qr-print';frame.title=this.t('print');frame.srcdoc=`<!doctype html><html><head><title>${esc(this.label)}</title><style>body{margin:0;text-align:center}img{width:95mm;max-width:100%}</style></head><body><img src="${canvas.toDataURL()}" alt="${esc(this.label)}"></body></html>`;frame.onload=()=>{frame.contentWindow.addEventListener('afterprint',()=>{frame.remove();if(this.printFrame===frame)this.printFrame=null},{once:true});frame.contentWindow.print()};document.body.append(frame);this.printTimer=setTimeout(()=>{frame.remove();if(this.printFrame===frame)this.printFrame=null},60000);}
    }catch(e){this.error(e)}
  }
  openCamera(){if(this.portal||this._applying)return;this.camera.open();}
  async capture(capture){
    if(this.portal||this._applying||!this.card.isConnected)return;
    const portal=this.dialog(this.t('scan'));const generation=this.generation;this.code=capture.ean;this.requestId=capture.request_id;
    try{const result=await this.api('preview',{code:this.code});if(generation!==this.generation||!this.card.isConnected)return;portal.querySelector('[data-qr-body]').innerHTML=`<p><strong>${esc(result.item.name)}</strong></p><p>${esc(result.list_name)}</p><p>${esc(this.action(result.action))}</p><p class="help">${esc(this.t('duplicates_help'))}</p>`;portal.querySelector('footer').innerHTML=`<button class="primary" data-qr-apply>${esc(this.t('apply'))}</button>`;portal.querySelector('[data-qr-apply]').onclick=()=>this.apply();if(this.card._config.todo_qr_direct===true)await this.apply();}catch(e){if(generation===this.generation)this.error(e)}
  }
  async apply(){
    if(this._applying||!this.portal)return;this._applying=true;const generation=this.generation;this.portal.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{const result=await this.api('apply',{code:this.code,request_id:this.requestId});if(generation!==this.generation||!this.card.isConnected)return;this.close();this.card._notificationStatus=this.t(result.duplicate?'duplicate':'applied');await this.card._load(true);}catch(e){if(generation===this.generation){this._applying=false;this.portal.querySelectorAll('button').forEach(b=>b.disabled=false);this.error(e)}}
  }
}
globalThis.HaListManagerTodoQr={for(card){return card._todoQr||(card._todoQr=new TaskQr(card));}};
