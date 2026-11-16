import "./ha-list-manager-frontend-refresh.js";
// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerTandoorCardTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerTandoorCardTextLanguage(hass = null) {
  return haListManagerTandoorCardTextLocale(hass).toLowerCase().split("-")[0] === "de" ? "de" : "en";
}
function haListManagerTandoorCardText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerTandoorCardTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerTandoorCardTextLocale(hass));
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
function haListManagerTandoorCardTextUpdateTranslations(element, hass) {
  if (!hass) return false;
  const previous = element._nativeTranslationState;
  const language = String(hass.language || haListManagerTandoorCardTextLocale(hass));
  const connection = hass.connection || hass;
  const changed = !previous || previous.language !== language || previous.connection !== connection;
  const wasReady = previous?.ready;
  let state = previous;
  if (changed) {
    state = { language, connection, previousLocalize: previous?.localize, switched: Boolean(previous && previous.language !== language), localize: hass.localize, renderedLocalize: hass.localize, ready: false };
    // Preloaded resources are immediately usable, including in an editor.
    state.ready = Boolean(haListManagerTandoorCardText("ui.cancel", {}, hass)) && (!state.switched || hass.localize !== state.previousLocalize);
    element._nativeTranslationState = state;
    haListManagerTandoorCardTextLoadTranslations(hass).then((localize) => {
      if (element._nativeTranslationState !== state) return;
      state.needsRefresh = Boolean(localize && localize !== state.renderedLocalize);
      const current = element._hass;
      if (!current || String(current.language || haListManagerTandoorCardTextLocale(current)) !== language || (current.connection || current) !== connection) return;
      if (haListManagerTandoorCardText("ui.cancel", {}, current) && (!state.switched || current.localize !== state.previousLocalize) && (!state.ready || (state.needsRefresh && current.localize !== state.renderedLocalize))) {
        state.ready = true;
        state.needsRefresh = false;
        state.renderedLocalize = current.localize;
        haListManagerTandoorCardTextUpdateMetadata(current);
        element._render();
      }
    }).catch((error) => {
      if (element._nativeTranslationState === state) console.warn(error);
    });
  } else if (!state.ready && haListManagerTandoorCardText("ui.cancel", {}, hass) && (!state.switched || hass.localize !== state.previousLocalize)) {
    state.ready = true;
  }
  const refresh = state.ready && state.needsRefresh && hass.localize !== state.renderedLocalize;
  if (state.ready && (changed || !wasReady || refresh)) { state.renderedLocalize = hass.localize; state.needsRefresh = false; }
  state.localize = hass.localize;
  if (state.ready && (changed || !wasReady || refresh)) haListManagerTandoorCardTextUpdateMetadata(hass);
  return state.ready && (changed || !wasReady || refresh);
}
function haListManagerTandoorCardTextUpdateMetadata(hass) {
  const metadata = window.customCards?.find((card) => card.type === "ha-list-manager-tandoor-card");
  if (metadata) {
    metadata.name = haListManagerTandoorCardText("library.title", {}, hass) || metadata.name;
    metadata.description = haListManagerTandoorCardText("library.description", {}, hass);
  }
}
function haListManagerTandoorCardTextRequest(hass, message) {
  return hass.callWS(message.type?.startsWith("ha_list_manager/") ? { ...message, language: haListManagerTandoorCardTextLanguage(hass) } : message);
}

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const freshState = () => ({bookId:null,query:"",page:1,recipeId:null,servings:null,libraryScroll:0,recipeScroll:0,checked:[],steps:[],searchIngredients:false,searchText:false});
const positive = value => Number.isInteger(Number(value)) && Number(value)>0 ? Number(value) : null;

class HaListManagerTandoorCard extends HTMLElement {
  constructor() {
    super();this.attachShadow({mode:"open"});this._config={};this._state=freshState();this._books=[];this._recipes=[];this._lists=[];this._recipe=null;
    this._configured=null;this._loading=false;this._error="";this._epoch=0;this._browseRun=0;this._recipeRun=0;this._count=0;this._hasNext=false;
    this._searchTimer=null;this._saveTimer=null;this._frame=null;this._connection=null;this._selection=null;this._expanded=false;this._large=false;this._collapsed=false;this._fullscreenRun=0;
    this._visible=()=>{if(document.visibilityState==="hidden")this._save();};
    this._leave=()=>this._save();
    this._ready=()=>this._initialize();
    this._fullChange=()=>{if(!document.fullscreenElement&&this._nativeFullscreen)this._setExpanded(false);};
    this._layoutChanged=()=>this._queueLayout();
    this._escape=event=>{if(event.key==="Escape"&&!this._selection){if(this._expanded)this._setExpanded(false);else if(this._large)this._setLarge(false);}};
  }
  static getStubConfig(){return {type:"custom:ha-list-manager-tandoor-card",layout:"auto",remember_position:true,show_expand:true,icon_expand:true,collapsible:true,height:740};}
  static getConfigElement(){return document.createElement("ha-list-manager-tandoor-card-editor");}
  static getConfigForm(hass,lists=[]){
    const t=key=>haListManagerTandoorCardText(`library.${key}`,{},hass);
    return {schema:[{name:"title",selector:{text:{}}},{name:"list_id",selector:{select:{options:[{value:"",label:t("choose_later")},...lists.map(list=>({value:list.id,label:list.name}))],mode:"dropdown"}}},
      {name:"layout",selector:{select:{mode:"dropdown",options:[{value:"auto",label:t("layout_auto")},{value:"card",label:t("layout_card")},{value:"panel",label:t("layout_panel")}]}}},
      {name:"welcome_heading",selector:{text:{}}},{name:"welcome_title",selector:{text:{}}},{name:"welcome_description",selector:{text:{multiline:true}}},
      {name:"height",selector:{number:{min:400,max:1400,step:20,mode:"box",unit_of_measurement:"px"}}},
      {name:"icon_expand",selector:{boolean:{}}},{name:"collapsible",selector:{boolean:{}}},{name:"remember_position",selector:{boolean:{}}},{name:"show_expand",selector:{boolean:{}}},{name:"card_id",selector:{text:{}}}],
      computeLabel:schema=>t(`option_${schema.name}`),computeHelper:schema=>t(`help_${schema.name}`)};
  }
  setConfig(config){
    if(!config||typeof config!=="object")throw new Error("Invalid card configuration");
    this._save();this._config={...HaListManagerTandoorCard.getStubConfig(),...config};
    this._config.height=Math.min(1400,Math.max(400,Number(this._config.height)||740));
    this._scope=null;this._epoch++;this._recipeRun++;this._browseRun++;this._recipe=null;this._configured=null;
    clearTimeout(this._searchTimer);this._selection?.remove();this._selection=null;this._dialog=null;
    if(this._large&&this._config.icon_expand===false)this._setLarge(false,false);
    this._applyLayout();if(this._hass&&this.isConnected)this._initialize();else this._render();
  }
  set hass(hass){
    this._hass=hass;globalThis.HaListManagerFrontendRefresh?.attach(this);
    const translated=haListManagerTandoorCardTextUpdateTranslations(this,hass);
    const connection=hass?.connection;
    if(connection!==this._connection){this._connection?.removeEventListener?.("ready",this._ready);this._connection=connection;if(this.isConnected)connection?.addEventListener?.("ready",this._ready);this._initialized=false;}
    if(this._scope&&this._scope!==this._storageKey())this._initialized=false;
    if(this._selection)this._selection.hass=hass;
    if(this.isConnected&&hass?.callWS&&!this._initialized)this._initialize();else if(translated)this._render();
  }
  connectedCallback(){
    globalThis.HaListManagerFrontendRefresh?.attach(this);this._connection?.addEventListener?.("ready",this._ready);
    document.addEventListener("visibilitychange",this._visible);window.addEventListener("pagehide",this._leave);document.addEventListener("fullscreenchange",this._fullChange);document.addEventListener("keydown",this._escape);
    window.addEventListener("resize",this._layoutChanged);window.visualViewport?.addEventListener("resize",this._layoutChanged);
    if(typeof ResizeObserver!=="undefined"){this._resizeObserver=new ResizeObserver(this._layoutChanged);this._resizeObserver.observe(this);}
    this._applyLayout();if(this._hass?.callWS)this._initialize();else this._render();
  }
  disconnectedCallback(){
    this._save();this._epoch++;this._recipeRun++;this._browseRun++;this._fullscreenRun++;this._initialized=false;
    clearTimeout(this._searchTimer);clearTimeout(this._saveTimer);if(this._frame!==null)cancelAnimationFrame(this._frame);this._frame=null;
    this._selection?.remove();this._selection=null;this._dialog=null;this._setLarge(false,false);
    window.removeEventListener("resize",this._layoutChanged);window.visualViewport?.removeEventListener("resize",this._layoutChanged);this._resizeObserver?.disconnect();this._resizeObserver=null;
    if(this._layoutFrame!=null)cancelAnimationFrame(this._layoutFrame);this._layoutFrame=null;
    this._connection?.removeEventListener?.("ready",this._ready);globalThis.HaListManagerFrontendRefresh?.detach(this);
    document.removeEventListener("visibilitychange",this._visible);window.removeEventListener("pagehide",this._leave);document.removeEventListener("fullscreenchange",this._fullChange);document.removeEventListener("keydown",this._escape);
    if(this._nativeFullscreen&&this._ownsFullscreen())document.exitFullscreen?.().catch(()=>{});this._nativeFullscreen=false;this._expanded=false;this.removeAttribute("data-expanded");
  }
  getCardSize(){return this._isCollapsed()?1:10;}
  getGridOptions(){return {columns:12,rows:"auto",min_columns:6,min_rows:1};}
  _text(key,values={}){return haListManagerTandoorCardText(`library.${key}`,values,this._hass);}
  _api(command,data={}){return haListManagerTandoorCardTextRequest(this._hass,{type:`ha_list_manager/${command}`,...data});}
  _storageKey(){return `ha-list-manager:tandoor:v1:${encodeURIComponent(this._hass?.user?.id||"user")}:${encodeURIComponent(this._config.card_id||`${window.location.pathname}:${this._config.title||"tandoor"}`)}`;}
  _readState(){
    this._state=freshState();if(this._config.remember_position===false)return;
    try{const raw=JSON.parse(localStorage.getItem(this._storageKey())||"null");if(!raw||raw.version!==1)return;
      this._state={...freshState(),bookId:positive(raw.bookId),recipeId:positive(raw.recipeId),query:typeof raw.query==="string"?raw.query.slice(0,200):"",page:Math.min(100000,positive(raw.page)||1),servings:Math.min(100,positive(raw.servings)||0)||null,
        libraryScroll:Math.min(10000000,Math.max(0,Number(raw.libraryScroll)||0)),recipeScroll:Math.min(10000000,Math.max(0,Number(raw.recipeScroll)||0)),
        searchIngredients:raw.searchIngredients===true,searchText:raw.searchText===true,
        checked:Array.isArray(raw.checked)?raw.checked.slice(0,500).map(String):[],steps:Array.isArray(raw.steps)?raw.steps.slice(0,500).map(String):[]};
    }catch{/* Restricted storage must not prevent cooking. */}
  }
  _viewKey(){return this._state.recipeId?`recipe:${this._state.recipeId}`:`library:${this._state.bookId}:${this._state.query}:${this._state.page}:${this._state.searchIngredients}:${this._state.searchText}`;}
  _rememberScroll(){if(!this._renderedReady||this._renderedKey!==this._viewKey())return;const body=this.shadowRoot.querySelector(".body");if(body)this._state[this._state.recipeId?"recipeScroll":"libraryScroll"]=body.scrollTop;}
  _save(){
    clearTimeout(this._saveTimer);this._rememberScroll();if(!this._hass||!this._scope||this._config.remember_position===false)return;
    try{localStorage.setItem(this._scope,JSON.stringify({version:1,...this._state}));}catch{/* localStorage can be disabled or full. */}
  }
  _scheduleSave(){clearTimeout(this._saveTimer);this._saveTimer=setTimeout(()=>this._save(),150);}
  _isCollapsed(){return this._config.collapsible!==false&&this._collapsed&&!this._large&&!this._expanded;}
  _toggleCollapsed(){
    if(this._config.collapsible===false||this._large||this._expanded)return;
    this._save();this._collapsed=!this._collapsed;
    try{localStorage.setItem(`${this._storageKey()}:collapsed`,this._collapsed?"1":"0");}catch{}
    this._render();
  }
  _findLargeViewport(){
    for(let node=this;node;node=node.parentElement||node.getRootNode?.().host){
      if(node.matches?.("hui-view,hui-masonry-view,hui-sections-view,hui-panel-view"))return node;
    }
    return null;
  }
  _updateLargeBounds(){
    const rect=this._largeViewport?.getBoundingClientRect?.();
    const top=rect?.width>0?Math.max(0,rect.top):56,left=rect?.width>0?Math.max(0,rect.left):0;
    const right=rect?.width>0?Math.max(0,window.innerWidth-rect.right):0;
    // A masonry view can be only one collapsed card high. Its content height
    // must not constrain the expanded reading area below HA navigation.
    const bottom=0;
    for(const [side,value] of Object.entries({top,left,right,bottom}))this.style.setProperty(`--library-large-${side}`,`${value}px`);
  }
  _setLarge(active,render=true){
    active=Boolean(active);if(active===this._large)return;this._save();this._large=active;this.toggleAttribute("data-large",active);
    if(active){
      this._largeViewport=this._findLargeViewport();this._largeOverflow=document.body.style.overflow;document.body.style.overflow="hidden";
      if(this._largeViewport&&typeof ResizeObserver!=="undefined"){this._largeObserver=new ResizeObserver(this._layoutChanged);this._largeObserver.observe(this._largeViewport);}
      document.addEventListener("transitionrun",this._layoutChanged,true);document.addEventListener("transitionend",this._layoutChanged,true);this._updateLargeBounds();
    }else{
      this._largeObserver?.disconnect();this._largeObserver=null;this._largeViewport=null;
      document.removeEventListener("transitionrun",this._layoutChanged,true);document.removeEventListener("transitionend",this._layoutChanged,true);
      document.body.style.overflow=this._largeOverflow||"";this._largeOverflow=null;
    }
    if(render&&this.isConnected)this._render();this._queueLayout();
  }
  async _toggleIconView(){
    if(this._config.icon_expand===false)return;
    if(this._expanded)await this._setExpanded(false);
    this._setLarge(!this._large);
  }
  _applyLayout(){
    let panel=this._config.layout==="panel";
    if(this._config.layout!=="card")for(let node=this;node;node=node.parentElement||node.getRootNode?.().host){if(node.localName==="hui-panel-view"){panel=true;break;}}
    this.toggleAttribute("data-panel",panel);this.style.setProperty("--library-height",`${this._config.height||740}px`);this._panelLayout=panel;this._queueLayout();
  }
  _queueLayout(){
    if(!this.isConnected||this._layoutFrame!=null)return;
    this._layoutFrame=requestAnimationFrame(()=>{this._layoutFrame=null;if(!this.isConnected)return;if(this._large){this._updateLargeBounds();return;}if(!this._panelLayout||this._expanded)return;
      const viewport=window.visualViewport?.height||window.innerHeight;const top=this.getBoundingClientRect().top;
      this.style.setProperty("--library-panel-height",`${Math.max(320,viewport-Math.max(0,top)-12)}px`);
    });
  }
  _ownsFullscreen(){return document.fullscreenElement===this||this.getRootNode?.().fullscreenElement===this;}
  async _setExpanded(active){
    const run=++this._fullscreenRun;
    this._rememberScroll();this._expanded=Boolean(active);this.toggleAttribute("data-expanded",this._expanded);
    if(active&&this.requestFullscreen){
      try{
        await this.requestFullscreen();
        // Browser permission can resolve after navigation or a second toggle.
        if(run!==this._fullscreenRun||!this.isConnected){
          if(this._ownsFullscreen()&&(!this.isConnected||!this._expanded))await document.exitFullscreen?.().catch(()=>{});
          return;
        }
        this._nativeFullscreen=true;
      }catch{if(run===this._fullscreenRun)this._nativeFullscreen=false;}
    }else if(!active&&this._nativeFullscreen){
      this._nativeFullscreen=false;
      if(this._ownsFullscreen())await document.exitFullscreen?.().catch(()=>{});
    }
    if(run===this._fullscreenRun&&this.isConnected)this._render();
  }
  async _initialize(){
    if(!this.isConnected||!this._hass?.callWS||this._hass.connection?.connected===false)return;
    const scope=this._storageKey();if(this._scope!==scope){this._scope=scope;this._readState();try{this._collapsed=localStorage.getItem(`${scope}:collapsed`)==="1";}catch{this._collapsed=false;}this._recipe=null;this._recipes=[];this._renderedKey=null;}
    this._initialized=true;const epoch=++this._epoch;this._loading=true;this._error="";this._render();
    try{
      const [info,lists]=await Promise.all([this._api("tandoor/library/info"),this._api("lists/list")]);if(epoch!==this._epoch||!this.isConnected)return;
      this._configured=info.configured;this._books=info.books||[];this._lists=(lists.lists||[]).filter(list=>list.enabled&&list.list_type==="shopping"&&list.provider==="local"&&list.use_tandoor);
      if(this._state.bookId&&!this._books.some(book=>book.id===this._state.bookId)){this._state.bookId=null;this._state.page=1;}
      if(info.configured){await this._browse();if(epoch===this._epoch&&this._state.recipeId)await this._openRecipe(this._state.recipeId,true);}
    }catch(error){if(epoch===this._epoch)this._error=error?.message||String(error);}
    finally{if(epoch===this._epoch){this._loading=false;this._render();this._save();}}
  }
  async _browse({incremental=false}={}){
    if(!this._configured)return;const run=++this._browseRun,epoch=this._epoch;this._browsing=true;this._error="";if(!incremental||!this._patchLibraryResults())this._render();
    try{const result=await this._api("tandoor/library/browse",{query:this._state.query,page:this._state.page,page_size:24,include_ingredients:this._state.searchIngredients,include_text:this._state.searchText,...(this._state.bookId?{book_id:this._state.bookId}:{})});
      if(run!==this._browseRun||epoch!==this._epoch||!this.isConnected)return;
      this._recipes=result.recipes||[];this._count=Number(result.count)||0;this._hasNext=Boolean(result.has_next);
    }catch(error){if(run===this._browseRun&&epoch===this._epoch)this._error=error?.message||String(error);}
    finally{if(run===this._browseRun&&epoch===this._epoch){this._browsing=false;if(!incremental||!this._patchLibraryResults())this._render();this._save();}}
  }
  async _openRecipe(id,restoring=false){
    clearTimeout(this._searchTimer);this._rememberScroll();id=positive(id);if(!id)return;
    if(!restoring){this._state.recipeScroll=0;this._state.checked=[];this._state.steps=[];this._state.servings=null;}
    this._state.recipeId=id;this._recipe=null;this._error="";this._recipeLoading=true;const run=++this._recipeRun,epoch=this._epoch;this._save();this._render();
    try{const {recipe}=await this._api("tandoor/library/recipe",{recipe_id:id});if(run!==this._recipeRun||epoch!==this._epoch||!this.isConnected)return;
      this._recipe=recipe;if(!this._state.servings)this._state.servings=positive(recipe.servings);this._save();
    }catch(error){if(run===this._recipeRun&&epoch===this._epoch)this._error=error?.message||String(error);}
    finally{if(run===this._recipeRun&&epoch===this._epoch){this._recipeLoading=false;this._render();}}
  }
  _goBack(){this._rememberScroll();this._recipeRun++;this._state.recipeId=null;this._recipe=null;this._error="";this._recipeLoading=false;this._save();this._render();}
  _book(id){this._rememberScroll();this._state.bookId=positive(id);this._state.query="";this._state.page=1;this._state.libraryScroll=0;clearTimeout(this._searchTimer);this._save();this._browse();}
  _amount(ingredient){
    if(ingredient.no_amount)return "";const amount=Number(ingredient.amount);if(!Number.isFinite(amount)||amount===0)return "";
    const scale=Number(this._recipe?.servings)>0&&this._state.servings?this._state.servings/Number(this._recipe.servings):1;
    return `${new Intl.NumberFormat(haListManagerTandoorCardTextLocale(this._hass),{maximumFractionDigits:3}).format(amount*scale)}${ingredient.unit?` ${ingredient.unit}`:""}`;
  }
  _meta(recipe){const time=Number(recipe.working_time||0)+Number(recipe.waiting_time||0);return `${time>0?`<span><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(time)} ${this._text("minutes")}</span>`:""}${Number(recipe.servings)>0?`<span><ha-icon icon="mdi:silverware-fork-knife"></ha-icon>${esc(recipe.servings)} ${this._text("servings_short")}</span>`:""}`;}
  _image(recipe,hero=false){return `<div class="photo ${hero?"large":""}"><ha-icon icon="mdi:silverware-fork-knife"></ha-icon>${recipe.image?`<img src="${esc(recipe.image)}" alt="" loading="${hero?"eager":"lazy"}" decoding="async">`:""}</div>`;}
  _welcomeText(name,fallback){
    const value=this._config[name];
    return typeof value==="string"&&value.trim()?value.trim():this._text(fallback);
  }
  _renderLibrary(){
    const book=this._books.find(book=>book.id===this._state.bookId),filtered=Boolean(book||this._state.query),hero=!filtered;
    const books=[{id:"",name:this._text("all_recipes")},...this._books];
    return `<section class="welcome ${hero?"":"compact"}"><div class="welcome-copy"><span class="eyebrow">${esc(hero?this._welcomeText("welcome_heading","eyebrow"):this._text("eyebrow"))}</span><h1>${esc(book?.name||(hero?this._welcomeText("welcome_title","welcome"):this._text("search_results")))}</h1><p data-library-summary>${esc(hero?this._welcomeText("welcome_description","welcome_help"):this._text("recipe_count",{count:this._count}))}</p></div><div class="welcome-art" aria-hidden="true"><ha-icon icon="mdi:book-open-page-variant-outline"></ha-icon><i></i><b></b></div></section>
      <div class="searchbar"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-search maxlength="200" autocomplete="off" value="${esc(this._state.query)}" aria-label="${this._text("search")}" placeholder="${this._text(book?"search_book":"search")}"><button class="icon" data-clear-search title="${this._text("clear_search")}" ${this._state.query?"":"hidden"}><ha-icon icon="mdi:close"></ha-icon></button></div>
      <div class="search-options"><span>${this._text("search_names")}</span><label><input type="checkbox" data-search-ingredients ${this._state.searchIngredients?"checked":""}>${this._text("search_ingredients")}</label><label><input type="checkbox" data-search-text ${this._state.searchText?"checked":""}>${this._text("search_text")}</label></div>
      <p class="search-help" data-search-content-help ${this._state.query&&(this._state.searchIngredients||this._state.searchText)?"":"hidden"}>${this._text("search_content_help")}</p>
      <section class="books-section"><div class="section-head"><h2>${this._text("cookbooks")}</h2><span>${this._books.length}</span></div><div class="books">${books.map((item,index)=>`<button class="book ${String(item.id)===String(this._state.bookId||"")?"selected":""}" data-book="${esc(item.id)}" style="--book-hue:${(index*47+18)%360}" aria-pressed="${String(item.id)===String(this._state.bookId||"")}"><ha-icon icon="${item.id?"mdi:book-open-variant":"mdi:bookshelf"}"></ha-icon><strong>${esc(item.name)}</strong><ha-icon class="book-arrow" icon="mdi:arrow-top-right"></ha-icon></button>`).join("")}</div></section>
      ${this._renderLibraryResults()}`;
  }
  _renderLibraryResults(){
    const book=this._books.find(book=>book.id===this._state.bookId);
    return `<section data-library-results aria-busy="${Boolean(this._browsing)}">      <div class="section-head recipe-heading"><h2>${esc(book?.name||this._text("recipes"))}</h2><span>${this._text("recipe_count",{count:this._count})}</span><span class="results-progress" data-results-progress role="status" ${this._browsing?"":"hidden"}><ha-circular-progress active size="small"></ha-circular-progress>${this._text("searching")}</span></div>
      ${this._browsing?`<div class="status" role="status"><ha-circular-progress active></ha-circular-progress>${this._text("loading")}</div>`:`<div class="recipes">${this._recipes.map(recipe=>`<button class="recipe-tile" data-recipe="${recipe.id}">${this._image(recipe)}<div class="tile-copy"><h3>${esc(recipe.name)}</h3><div class="meta">${this._meta(recipe)}</div><span class="read-recipe">${this._text("open_recipe")}<ha-icon icon="mdi:arrow-right"></ha-icon></span></div></button>`).join("")}</div>${!this._recipes.length&&!this._error?`<div class="empty"><ha-icon icon="mdi:book-search-outline"></ha-icon><h3>${this._text("empty")}</h3><p>${this._text("empty_help")}</p></div>`:""}`}
      ${this._state.page>1||this._hasNext?`<nav class="pagination" aria-label="${this._text("pages")}"><button data-page="-1" ${this._state.page<=1||this._browsing?"disabled":""}><ha-icon icon="mdi:chevron-left"></ha-icon>${this._text("previous")}</button><span>${this._text("page",{page:this._state.page})}</span><button data-page="1" ${!this._hasNext||this._browsing?"disabled":""}>${this._text("next")}<ha-icon icon="mdi:chevron-right"></ha-icon></button></nav>`:""}</section>`;
  }
  _updateSearchHint(){
    const hint=this.shadowRoot.querySelector("[data-search-content-help]");
    if(hint)hint.hidden=!(this._state.query&&(this._state.searchIngredients||this._state.searchText));
  }
  _patchLibraryResults(){
    const root=this.shadowRoot.querySelector("[data-library-results]");
    if(!root||this._state.recipeId||this._isCollapsed())return false;
    const body=this.shadowRoot.querySelector(".body"),scroll=body?.scrollTop||0;
    root.setAttribute("aria-busy",String(this._browsing));this._updateSearchHint();
    if(this._browsing){
      const progress=root.querySelector("[data-results-progress]");if(progress)progress.hidden=false;
    }else if(this._error){
      root.querySelector("[data-results-error]")?.remove();
      root.insertAdjacentHTML("afterbegin",`<div class="error" data-results-error role="alert"><span>${esc(this._error)}</span><button data-results-retry>${this._text("retry")}</button></div>`);
      root.querySelector("[data-results-retry]")?.addEventListener("click",()=>this._browse({incremental:true}));
      const progress=root.querySelector("[data-results-progress]");if(progress)progress.hidden=true;
    }else{
      const template=document.createElement("template");template.innerHTML=this._renderLibraryResults();
      root.replaceChildren(...template.content.firstElementChild.childNodes);this._bindLibraryResults(root);
      root.querySelectorAll("img").forEach(image=>image.addEventListener("error",()=>image.remove(),{once:true}));
      const summary=this.shadowRoot.querySelector("[data-library-summary]");
      if(summary)summary.textContent=this._state.query||this._state.bookId?this._text("recipe_count",{count:this._count}):this._welcomeText("welcome_description","welcome_help");
    }
    this._renderedKey=this._viewKey();this._renderedReady=true;
    if(body){body.scrollTop=scroll;this._state.libraryScroll=body.scrollTop;}
    return true;
  }
  _bindLibraryResults(root){
    root.querySelectorAll("[data-recipe]").forEach(button=>button.addEventListener("click",()=>this._openRecipe(button.dataset.recipe)));
    root.querySelectorAll("[data-page]").forEach(button=>button.addEventListener("click",()=>{this._state.page=Math.max(1,this._state.page+Number(button.dataset.page));this._state.libraryScroll=0;this._save();this._browse();}));
  }
  _renderRecipe(){
    const recipe=this._recipe;if(!recipe)return `<div class="status"><ha-circular-progress active ${this._error?"hidden":""}></ha-circular-progress>${this._error?"":this._text("loading")}</div>`;
    const scalable=Number(recipe.servings)>0;
    return `<article class="recipe-detail"><div class="recipe-intro">${this._image(recipe,true)}<div class="recipe-summary"><span class="eyebrow">${this._text("recipe")}</span><h1>${esc(recipe.name)}</h1><div class="meta">${this._meta(recipe)}</div><p>${this._text("cook_help")}</p><div class="serving-row"><span>${this._text("servings")}</span>${scalable?`<div class="stepper"><button data-serving="-1" aria-label="${this._text("less_servings")}"><ha-icon icon="mdi:minus"></ha-icon></button><input data-servings type="number" min="1" max="100" step="1" value="${this._state.servings}" aria-label="${this._text("servings")}"><button data-serving="1" aria-label="${this._text("more_servings")}"><ha-icon icon="mdi:plus"></ha-icon></button></div>`:`<span>${this._text("no_servings")}</span>`}</div></div></div>
      <div class="recipe-columns"><aside class="ingredients-panel"><div class="section-head"><h2>${this._text("ingredients")}</h2><span>${(recipe.ingredients||[]).length}</span></div><div class="ingredients">${(recipe.ingredients||[]).map(item=>`<label class="ingredient ${this._state.checked.includes(String(item.id))?"checked":""}"><input type="checkbox" data-ingredient="${item.id}" ${this._state.checked.includes(String(item.id))?"checked":""}><span class="ingredient-amount">${esc(this._amount(item))}</span><span class="ingredient-name">${esc(item.name)}${item.note?`<small>${esc(item.note)}</small>`:""}</span></label>`).join("")||`<p>${this._text("no_ingredients")}</p>`}</div>
      <div class="shopping"><ha-icon icon="mdi:cart-outline"></ha-icon><h3>${this._text("shopping_title")}</h3><p>${this._text("shopping_help")}</p>${this._lists.length?`<label class="list-label">${this._text("target_list")}<select data-target-list>${this._lists.map(list=>`<option value="${esc(list.id)}" ${list.id===(this._targetList||this._config.list_id)?"selected":""}>${esc(list.name)}</option>`).join("")}</select></label><button class="primary" data-add-ingredients><ha-icon icon="mdi:playlist-plus"></ha-icon>${this._text("choose_ingredients")}</button>`:`<p class="list-help">${this._text("no_list")}</p>`}</div></aside>
      <section class="preparation"><div class="section-head"><h2>${this._text("preparation")}</h2><span>${(recipe.steps||[]).length}</span></div>${(recipe.steps||[]).map((step,index)=>`<section class="step ${this._state.steps.includes(String(step.id))?"done":""}"><button class="step-number" data-step="${step.id}" aria-pressed="${this._state.steps.includes(String(step.id))}" aria-label="${esc(this._text("mark_step",{step:index+1}))}">${this._state.steps.includes(String(step.id))?'<ha-icon icon="mdi:check"></ha-icon>':index+1}</button><div>${step.name?`<h3>${esc(step.name)}</h3>`:""}<p>${esc(step.instruction)}</p></div></section>`).join("")||`<p class="empty-copy">${this._text("no_steps")}</p>`}<button class="text-button" data-reset-cooking><ha-icon icon="mdi:restart"></ha-icon>${this._text("reset_cooking")}</button></section></div></article>`;
  }
  _render(){
    if(!this.shadowRoot)return;this._rememberScroll();
    if(!this.shadowRoot.querySelector("ha-card"))this.shadowRoot.innerHTML=`<style>${this._styles()}</style><ha-card><div class="frame"></div></ha-card><div class="transfer-slot"></div>`;
    const frame=this.shadowRoot.querySelector(".frame");if(!frame)return;
    const focused=this.shadowRoot.activeElement;const input=focused?.matches?.("[data-search]")?{start:focused.selectionStart,end:focused.selectionEnd}:null;
    const title=String(this._config.title||this._text("title")),collapsed=this._isCollapsed();this.toggleAttribute("data-collapsed",collapsed);
    frame.innerHTML=`<header class="toolbar"><div class="brand">${this._config.icon_expand!==false?`<button type="button" class="brand-icon" data-enlarge title="${this._text(this._large?"reduce":"enlarge")}" aria-label="${this._text(this._large?"reduce":"enlarge")}" aria-pressed="${this._large}"><ha-icon icon="mdi:chef-hat"></ha-icon></button>`:`<span class="brand-icon"><ha-icon icon="mdi:chef-hat"></ha-icon></span>`}${this._config.collapsible!==false&&!this._large&&!this._expanded?`<button type="button" class="brand-title" data-collapse aria-expanded="${!collapsed}" title="${this._text(collapsed?"open_card":"collapse_card")}"><strong>${esc(title)}</strong></button>`:`<strong>${esc(title)}</strong>`}</div><div class="toolbar-actions">${this._state.recipeId&&!collapsed?`<button data-back><ha-icon icon="mdi:arrow-left"></ha-icon><span>${this._text("back")}</span></button>`:""}<button class="icon" data-refresh title="${this._text("refresh")}" ${collapsed?"hidden":""} ${this._loading?"disabled":""}><ha-icon icon="mdi:refresh"></ha-icon></button>${this._config.show_expand!==false?`<button class="icon" data-expand title="${this._text(this._expanded?"collapse":"expand")}" aria-pressed="${this._expanded}"><ha-icon icon="mdi:${this._expanded?"fullscreen-exit":"fullscreen"}"></ha-icon></button>`:""}</div></header>
      <div class="body" tabindex="-1" ${collapsed?"hidden":""}>${collapsed?"":this._success?`<div class="success" role="status"><ha-icon icon="mdi:check-circle-outline"></ha-icon><span>${esc(this._success)}</span><button class="icon" data-dismiss-success title="${this._text("close")}"><ha-icon icon="mdi:close"></ha-icon></button></div>`:""}${this._error?`<div class="error" role="alert"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${esc(this._error)}</span><button data-retry>${this._text("retry")}</button></div>`:""}${this._configured===false?`<div class="empty"><ha-icon icon="mdi:chef-hat"></ha-icon><h2>${this._text("not_configured")}</h2><p>${this._text("setup_help")}</p></div>`:this._configured===null?`<div class="status"><ha-circular-progress active ${this._error?"hidden":""}></ha-circular-progress>${this._error?"":this._text("loading")}</div>`:this._state.recipeId?this._renderRecipe():this._renderLibrary()}</div>
      <footer ${collapsed?"hidden":""}><span><ha-icon icon="mdi:book-open-page-variant-outline"></ha-icon>Tandoor Recipes</span>${this._config.remember_position!==false?`<span><ha-icon icon="mdi:bookmark-check-outline"></ha-icon>${this._text("remembered")}</span>`:""}</footer>`;
    this._renderedReady=Boolean(!collapsed&&this._configured&&(this._state.recipeId?this._recipe&&!this._recipeLoading:!this._browsing));
    this._renderedKey=this._viewKey();const body=frame.querySelector(".body"),scroll=this._state[this._state.recipeId?"recipeScroll":"libraryScroll"];
    body.scrollTop=scroll;if(this._frame!==null)cancelAnimationFrame(this._frame);
    if(this.isConnected&&!collapsed)this._frame=requestAnimationFrame(()=>{this._frame=null;if(body.isConnected&&this._renderedKey===this._viewKey())body.scrollTop=scroll;});
    body.addEventListener("scroll",()=>this._scheduleSave(),{passive:true});
    this._bind(frame);if(input){const search=frame.querySelector("[data-search]");search?.focus({preventScroll:true});search?.setSelectionRange?.(input.start,input.end);}
    frame.querySelectorAll("img").forEach(image=>image.addEventListener("error",()=>image.remove(),{once:true}));
  }
  _bind(root){
    const on=(selector,event,fn)=>root.querySelectorAll(selector).forEach(node=>node.addEventListener(event,fn));
    on("[data-enlarge]","click",()=>this._toggleIconView());on("[data-collapse]","click",()=>this._toggleCollapsed());
    on("[data-search-ingredients],[data-search-text]","change",event=>{this._rememberScroll();const field=event.currentTarget.hasAttribute("data-search-ingredients")?"searchIngredients":"searchText";this._state[field]=event.currentTarget.checked;const searching=Boolean(this._state.query.trim());if(searching)this._state.page=1;this._save();clearTimeout(this._searchTimer);this._renderedKey=this._viewKey();this._updateSearchHint();if(searching)this._browse({incremental:true});});
    on("[data-dismiss-success]","click",()=>{this._success="";this._render();});
    on("[data-back]","click",()=>this._goBack());on("[data-refresh],[data-retry]","click",()=>this._initialize());on("[data-expand]","click",()=>this._setExpanded(!this._expanded));
    on("[data-book]","click",event=>this._book(event.currentTarget.dataset.book));this._bindLibraryResults(root);
    on("[data-search]","input",event=>{this._rememberScroll();this._state.query=event.target.value.slice(0,200);this._state.page=1;this._state.libraryScroll=0;this._save();clearTimeout(this._searchTimer);this._browseRun++;this._searchTimer=setTimeout(()=>this._browse(),300);});
    on("[data-clear-search]","click",()=>{this._state.query="";this._state.page=1;this._state.libraryScroll=0;clearTimeout(this._searchTimer);this._browseRun++;this._save();this._browse();});
    const servings=value=>{this._rememberScroll();this._state.servings=Math.max(1,Math.min(100,Math.round(Number(value)||1)));this._save();this._render();};
    on("[data-serving]","click",event=>servings((this._state.servings||1)+Number(event.currentTarget.dataset.serving)));on("[data-servings]","change",event=>servings(event.target.value));
    on("[data-ingredient]","change",event=>{const id=event.currentTarget.dataset.ingredient;this._state.checked=this._state.checked.filter(value=>value!==id);if(event.currentTarget.checked)this._state.checked.push(id);event.currentTarget.closest(".ingredient").classList.toggle("checked",event.currentTarget.checked);this._save();});
    on("[data-step]","click",event=>{this._rememberScroll();const id=event.currentTarget.dataset.step;this._state.steps=this._state.steps.includes(id)?this._state.steps.filter(value=>value!==id):[...this._state.steps,id];this._save();this._render();});
    on("[data-reset-cooking]","click",()=>{this._rememberScroll();this._state.checked=[];this._state.steps=[];this._save();this._render();});
    on("[data-target-list]","change",event=>{this._targetList=event.target.value;});on("[data-add-ingredients]","click",()=>this._addIngredients());
  }
  async _addIngredients(){
    if(this._selectionPending||this._selection||!this._recipe)return;const listId=this.shadowRoot.querySelector("[data-target-list]")?.value;if(!listId)return;
    const epoch=this._epoch,recipeId=this._recipe.id;this._error="";this._selectionPending=true;this._dialog={kind:"tandoor-transfer"};
    try{
      if(!customElements.get("ha-list-manager-recipe-selection"))await import(globalThis.HaListManagerFrontendRefresh.assetUrl("ha-list-manager-shopping-card.js"));
      if(epoch!==this._epoch||!this.isConnected||this._state.recipeId!==recipeId)return;
      const selection=document.createElement("ha-list-manager-recipe-selection");this._selection=selection;this._dialog={kind:"tandoor-transfer"};
      selection.addEventListener("recipe-selection-closed",()=>{selection.remove();if(this._selection===selection){this._selection=null;this._dialog=null;this._render();}});
      selection.addEventListener("recipe-selection-saved",event=>{this._success=event.detail.message;});
      this.shadowRoot.querySelector(".transfer-slot").append(selection);
      await selection.open({hass:this._hass,listId,recipeId,servings:this._state.servings});
    }catch(error){if(epoch!==this._epoch||!this.isConnected)return;this._selection?.remove();this._selection=null;this._dialog=null;this._error=error?.message||String(error);this._render();}
    finally{this._selectionPending=false;if(!this._selection)this._dialog=null;}
  }
  _styles(){return `
:host{display:block;min-width:0;font-family:var(--paper-font-body1_-_font-family,inherit);--cook-accent:#dba777;--cook-soft:color-mix(in srgb,var(--cook-accent) 12%,transparent);--cook-border:color-mix(in srgb,var(--primary-text-color) 11%,transparent)}
*{box-sizing:border-box}ha-card{height:var(--library-height,740px);max-height:90dvh;overflow:hidden;background:var(--ha-card-background,var(--card-background-color,#1e1f21));color:var(--primary-text-color);box-shadow:var(--ha-card-box-shadow,none)}
:host([data-panel]) ha-card{height:var(--library-panel-height,calc(100dvh - var(--header-height,56px) - 28px));max-height:none}
:host([data-large]){position:fixed!important;top:var(--library-large-top,56px)!important;left:var(--library-large-left,0)!important;right:var(--library-large-right,0)!important;bottom:var(--library-large-bottom,0)!important;z-index:9998;max-width:none!important;min-width:0!important;padding:16px;background:var(--primary-background-color,#111)}:host([data-large]) ha-card{height:100%;max-height:none;box-shadow:0 16px 48px #0007}:host([data-collapsed]) ha-card{height:76px!important;max-height:none}:host([data-collapsed]) .toolbar{height:74px;min-height:74px;max-height:74px;padding:12px 14px;border-bottom:0}:host([data-expanded]){position:fixed!important;inset:0!important;z-index:9999;width:100vw;height:100dvh;padding:0;background:var(--primary-background-color,#111)}
:host([data-expanded]) ha-card{height:100dvh;max-height:none;border:0;border-radius:0}.frame{height:100%;display:flex;flex-direction:column;min-height:0}
button,input,select{font:inherit}button{cursor:pointer;color:inherit;border:1px solid var(--cook-border);background:transparent;border-radius:12px;min-height:42px}button:disabled{opacity:.4;cursor:default}button:hover:not(:disabled){background:var(--cook-soft)}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--cook-accent);outline-offset:3px}
[hidden]{display:none!important}ha-icon{--mdc-icon-size:20px;flex:0 0 20px}button,.brand,.meta,.toolbar-actions{display:flex;align-items:center;justify-content:center;gap:9px}
.toolbar{flex:0 0 auto;min-height:74px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:14px;border-bottom:1px solid var(--cook-border)}.brand{justify-content:flex-start;min-width:0;flex:1;gap:8px;min-height:50px}.brand>.brand-icon{display:grid;place-items:center;width:35px;height:35px;border-radius:50%;color:var(--cook-accent);background:transparent}.brand>.brand-icon ha-icon{--mdc-icon-size:25px}.brand>.brand-icon{border:0;padding:5px;min-height:0;flex:0 0 35px}.brand-title{min-width:0;justify-content:flex-start;border:0;background:none;padding:0;text-align:left}.brand strong{display:block;min-width:0;font-size:24px;font-weight:400;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.toolbar-actions{flex-shrink:0}.brand-title{overflow:hidden;flex:1}.results-progress{display:inline-flex;align-items:center;gap:7px;margin-left:auto}.results-progress ha-circular-progress{width:16px;height:16px}.toolbar-actions button{padding:0 12px;border-color:transparent}.toolbar-actions .icon{width:42px;padding:0}
.body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:28px clamp(18px,3vw,40px) 36px;flex:1 1 auto;outline:none}.body>*{max-width:1420px;margin-left:auto;margin-right:auto}h1,h2,h3,p{margin-top:0}h1{font-family:inherit;font-weight:400;letter-spacing:-1.3px;font-size:clamp(30px,3.8vw,52px);line-height:1.12;overflow-wrap:anywhere}h2{font-size:20px;font-weight:600;letter-spacing:-.3px}h3{font-size:17px;line-height:1.35}p{line-height:1.65;color:var(--secondary-text-color)}
.welcome{display:grid;grid-template-columns:minmax(0,1fr) 170px;align-items:center;min-height:170px;border-radius:18px;padding:20px 26px;background:linear-gradient(115deg,var(--cook-soft),color-mix(in srgb,var(--primary-text-color) 2%,transparent));overflow:hidden;position:relative;margin-bottom:24px}.welcome h1{font-size:clamp(30px,3vw,44px);margin:8px 0 12px;max-width:680px}.welcome p{margin:0;max-width:570px;font-size:15px}.eyebrow{font-size:11px;line-height:1.6;letter-spacing:2px;text-transform:uppercase;color:var(--cook-accent);font-weight:700}.welcome.compact{min-height:145px;padding-top:22px;padding-bottom:22px}.welcome.compact h1{font-size:34px}.welcome-art{display:grid;place-items:center;height:130px;position:relative}.welcome-art:before{content:"";position:absolute;width:158px;height:158px;border:1px solid color-mix(in srgb,var(--cook-accent) 25%,transparent);border-radius:50%;transform:rotate(-12deg);background:var(--cook-soft)}.welcome-art ha-icon{--mdc-icon-size:86px;transform:rotate(-12deg);color:var(--cook-accent);opacity:.8}.welcome-art i,.welcome-art b{position:absolute;border:1px solid var(--cook-border);border-radius:50%;width:48px;height:48px;right:10px;bottom:6px}.welcome-art b{width:20px;height:20px;left:25px;top:8px;background:var(--cook-soft)}
.searchbar{border:1px solid var(--cook-border);border-radius:13px;display:flex;align-items:center;gap:13px;padding:4px 12px 4px 17px;min-height:54px;background:color-mix(in srgb,var(--primary-text-color) 3%,transparent);margin-bottom:26px}.searchbar>ha-icon{color:var(--secondary-text-color)}.search-options{display:flex;align-items:center;flex-wrap:wrap;gap:10px 20px;margin-top:-12px;margin-bottom:24px;color:var(--secondary-text-color);font-size:12px}.search-options label{display:inline-flex;align-items:center;gap:7px;cursor:pointer}.search-options input{width:17px;height:17px;margin:0;accent-color:var(--cook-accent)}.search-help{font-size:12px;line-height:1.5;margin-top:-12px;margin-bottom:24px}.searchbar input{width:100%;min-width:0;padding:12px 0;border:0;color:inherit;outline:0;background:none;font-size:15px}.searchbar .icon{border:0;min-width:36px;min-height:36px}input[type=search]::-webkit-search-cancel-button{display:none}
.section-head{display:flex;gap:12px;justify-content:space-between;align-items:center;margin-bottom:16px}.section-head h2{margin:0}.section-head>span{color:var(--secondary-text-color);font-size:12px}.books{display:flex;gap:12px;overflow-x:auto;padding-bottom:9px;scrollbar-width:thin}.book{position:relative;flex:0 0 190px;min-height:94px;padding:14px;align-items:flex-start;justify-content:space-between;flex-direction:column;text-align:left;border-radius:11px;background:linear-gradient(120deg,color-mix(in srgb,hsl(var(--book-hue) 30% 50%) 14%,transparent),color-mix(in srgb,var(--primary-text-color) 2%,transparent));border-color:var(--cook-border)}.book>ha-icon{color:var(--cook-accent);--mdc-icon-size:23px}.book .book-arrow{position:absolute;right:12px;top:15px;--mdc-icon-size:15px;opacity:.5}.book strong{font-size:14px;line-height:1.4;padding-right:4px;overflow-wrap:anywhere}.book.selected{border-color:var(--cook-accent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--cook-accent) 35%,transparent)}.recipe-heading{margin-top:24px}
.recipes{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr));grid-auto-rows:1fr;gap:22px}.recipe-tile{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:0;padding:0;overflow:hidden;text-align:left;border-radius:15px;min-width:0;transition:border-color .15s,box-shadow .15s;background:color-mix(in srgb,var(--primary-text-color) 2%,transparent)}.recipe-tile:hover{border-color:color-mix(in srgb,var(--cook-accent) 60%,transparent);box-shadow:0 8px 24px #0002}.photo{position:relative;aspect-ratio:1.5;overflow:hidden;display:grid;place-items:center;background:linear-gradient(135deg,color-mix(in srgb,var(--cook-accent) 17%,transparent),color-mix(in srgb,var(--primary-text-color) 4%,transparent))}.photo>ha-icon{--mdc-icon-size:48px;color:var(--cook-accent);opacity:.35}.photo img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.recipe-tile>.photo{flex:0 0 auto;width:100%}.tile-copy{padding:17px 18px 14px;display:flex;flex-direction:column;flex:1}.tile-copy>.meta{margin-top:auto}.tile-copy h3{margin:0 0 12px;font-weight:600;font-size:16px;min-height:43px}.meta{justify-content:flex-start;flex-wrap:wrap;gap:14px;color:var(--secondary-text-color);font-size:12px}.meta span{display:inline-flex;align-items:center;gap:5px}.meta ha-icon{--mdc-icon-size:16px;flex-basis:16px}.read-recipe{display:flex;justify-content:space-between;align-items:center;padding-top:16px;margin-top:14px;border-top:1px solid var(--cook-border);color:var(--cook-accent);font-size:12px}.read-recipe ha-icon{--mdc-icon-size:17px}
.pagination{display:flex;align-items:center;justify-content:center;gap:18px;padding-top:28px}.pagination button{padding:0 14px}.pagination span{font-size:13px;color:var(--secondary-text-color)}.status{display:flex;align-items:center;justify-content:center;gap:14px;min-height:200px;color:var(--secondary-text-color);font-size:14px}ha-circular-progress{--mdc-theme-primary:var(--cook-accent)}.empty{text-align:center;padding:52px 24px;color:var(--secondary-text-color)}.empty>ha-icon{--mdc-icon-size:52px;color:var(--cook-accent);margin-bottom:18px}.empty h2,.empty h3{color:var(--primary-text-color)}.empty p{max-width:500px;margin:0 auto}.error,.success{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;border-radius:12px;margin-bottom:22px;border:1px solid var(--error-color,#e86c65);background:color-mix(in srgb,var(--error-color,#e86c65) 8%,transparent);font-size:14px}.error span,.success span{flex:1 1 160px}.error button,.success button{padding:0 10px}.success{border-color:var(--success-color,#67a86d);background:color-mix(in srgb,var(--success-color,#67a86d) 8%,transparent)}
.recipe-intro{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:34px;align-items:center;margin-bottom:38px}.photo.large{border-radius:16px;aspect-ratio:1.45;max-height:400px}.recipe-summary h1{margin:12px 0 18px;font-size:clamp(30px,3vw,44px)}.recipe-summary .meta{margin-bottom:18px}.recipe-summary p{font-size:14px}.serving-row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;border-top:1px solid var(--cook-border);padding-top:18px;font-size:14px}.stepper{display:flex;align-items:center;border:1px solid var(--cook-border);border-radius:12px;overflow:hidden}.stepper button{border:0;border-radius:0;width:40px;min-height:38px}.stepper input{width:55px;text-align:center;min-height:38px;background:transparent;color:inherit;border:0;appearance:textfield}.stepper input::-webkit-inner-spin-button{display:none}
.recipe-columns{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(0,1.5fr);gap:40px;align-items:start}.ingredients-panel{min-width:0}.ingredients{border:1px solid var(--cook-border);padding:6px 17px;border-radius:14px}.ingredient{display:flex;align-items:baseline;gap:11px;min-height:56px;padding:16px 0;border-bottom:1px solid var(--cook-border);cursor:pointer}.ingredient:last-child{border-bottom:0}.ingredient input{margin:0;align-self:flex-start;flex:0 0 18px;width:18px;height:18px;accent-color:var(--cook-accent)}.ingredient-amount{font-size:13px;flex:0 1 auto;min-width:45px;color:var(--cook-accent);overflow-wrap:anywhere}.ingredient-name{font-size:14px;min-width:0;overflow-wrap:anywhere}.ingredient-name small{display:block;margin-top:5px;font-size:12px;color:var(--secondary-text-color);line-height:1.5}.ingredient.checked .ingredient-name,.ingredient.checked .ingredient-amount{text-decoration:line-through;opacity:.5}
.shopping{padding:23px;margin-top:24px;border-radius:14px;background:var(--cook-soft);border:1px solid color-mix(in srgb,var(--cook-accent) 20%,transparent)}.shopping>ha-icon{--mdc-icon-size:25px;color:var(--cook-accent);margin-bottom:13px}.shopping h3{margin-bottom:9px}.shopping p{font-size:12px;margin-bottom:18px}.list-label{display:block;font-size:12px;color:var(--secondary-text-color)}select{display:block;width:100%;min-height:44px;border:1px solid var(--cook-border);border-radius:9px;background:var(--card-background-color,#222);color:var(--primary-text-color);padding:8px 11px;margin:8px 0 14px}.primary{background:var(--cook-accent);border:0;color:#23180e;padding:9px 15px;font-weight:600;font-size:13px;min-height:46px;width:100%}.primary:hover:not(:disabled){background:color-mix(in srgb,var(--cook-accent) 80%,white)}
.step{display:grid;grid-template-columns:40px minmax(0,1fr);gap:18px;padding:10px 0 23px}.step-number{width:38px;min-height:38px;height:38px;border-radius:50%;color:var(--cook-accent);font-size:14px;font-weight:600;border-color:color-mix(in srgb,var(--cook-accent) 35%,transparent);background:var(--cook-soft)}.step.done .step-number{background:var(--cook-accent);color:#23180e}.step h3{font-size:17px;margin:6px 0 12px}.step p{white-space:pre-wrap;font-size:15px;line-height:1.9;color:var(--primary-text-color);margin-bottom:0;overflow-wrap:anywhere}.step.done p,.step.done h3{opacity:.45}.text-button{border:0;font-size:12px;color:var(--secondary-text-color);padding:0 12px}.empty-copy{font-size:14px}
footer{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:14px;padding:12px 24px;border-top:1px solid var(--cook-border);font-size:11px;color:var(--secondary-text-color)}footer span{display:flex;align-items:center;gap:7px}footer ha-icon{--mdc-icon-size:15px;flex-basis:15px}
@container(max-width:650px){.recipe-columns{grid-template-columns:minmax(0,1fr)}.recipe-intro{gap:22px}.recipe-summary h1{font-size:32px}.welcome{grid-template-columns:minmax(0,1fr) 125px;padding:24px}.welcome-art ha-icon{--mdc-icon-size:60px}.welcome-art:before{width:110px;height:110px}.welcome-art i{display:none}.toolbar{padding-left:18px;padding-right:18px}}
:host{container-type:inline-size}@container(max-width:600px){:host([data-collapsed]) .toolbar{padding:10px}.brand{min-height:54px}.brand strong{font-size:21px}}@container(max-width:480px){.toolbar{min-height:64px;padding:11px 14px;gap:6px}.brand strong{font-size:21px}.brand>.brand-icon{width:35px;flex-basis:35px;height:35px}.toolbar-actions{gap:0}.toolbar-actions button{padding:0 8px;min-width:36px}.toolbar-actions [data-back] span{display:none}.body{padding:20px 16px 28px}.welcome{grid-template-columns:minmax(0,1fr) 65px;padding:22px 20px;min-height:175px}.welcome h1{font-size:32px}.welcome p{font-size:13px}.welcome-art{height:110px}.welcome-art:before{width:85px;height:85px}.welcome-art ha-icon{--mdc-icon-size:47px}.welcome-art b{display:none}.welcome.compact{min-height:110px}.welcome.compact h1{font-size:29px}.eyebrow{font-size:10px;letter-spacing:1.5px}.recipes{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.tile-copy{padding:12px}.tile-copy h3{font-size:14px;min-height:38px}.tile-copy .meta{font-size:10px;gap:7px}.tile-copy .meta ha-icon{--mdc-icon-size:13px}.read-recipe{font-size:11px;margin-top:10px;padding-top:12px}.recipe-intro{grid-template-columns:minmax(0,1fr);gap:22px;margin-bottom:30px}.photo.large{aspect-ratio:1.7}.recipe-summary h1{font-size:34px}.recipe-columns{gap:32px}.step{gap:12px;grid-template-columns:34px minmax(0,1fr)}.step-number{width:32px;height:32px;min-height:32px}.step p{font-size:14px}footer{padding:11px 16px;font-size:10px}footer span:last-child{max-width:55%;justify-content:flex-end;text-align:right}.book{flex-basis:155px;min-height:104px}.section-head h2{font-size:19px}.pagination{gap:10px}.pagination button{font-size:12px;padding:0 9px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;}
}

class HaListManagerTandoorCardEditor extends HTMLElement {
  constructor(){super();this.attachShadow({mode:"open"});this._lists=[];this._generation=0;}
  setConfig(config){this._config={...HaListManagerTandoorCard.getStubConfig(),...config};this._render();}
  set hass(hass){const first=!this._hass||this._hass.connection!==hass?.connection;this._hass=hass;haListManagerTandoorCardTextUpdateTranslations(this,hass);this._render();if(first)this._loadLists();}
  connectedCallback(){if(this._hass)this._loadLists();}
  disconnectedCallback(){this._generation++;this._hass=null;}
  async _loadLists(){if(!this._hass?.callWS)return;const run=++this._generation;try{const result=await this._hass.callWS({type:"ha_list_manager/lists/list"});if(run!==this._generation||!this.isConnected)return;this._lists=(result.lists||[]).filter(list=>list.enabled&&list.list_type==="shopping"&&list.provider==="local"&&list.use_tandoor);this._render();}catch{/* The card itself explains missing configuration. */}}
  _render(){
    if(!this._config||!this._hass||this._nativeTranslationState?.ready===false)return;
    if(!this._form){this._form=document.createElement("ha-form");this._form.addEventListener("value-changed",event=>{this._config={...this._config,...event.detail.value};this.dispatchEvent(new CustomEvent("config-changed",{bubbles:true,composed:true,detail:{config:this._config}}));});this.shadowRoot.append(this._form);}
    const definition=HaListManagerTandoorCard.getConfigForm(this._hass,this._lists);Object.assign(this._form,{hass:this._hass,data:this._config,schema:definition.schema,computeLabel:definition.computeLabel,computeHelper:definition.computeHelper});
  }
}
if(!customElements.get("ha-list-manager-tandoor-card"))customElements.define("ha-list-manager-tandoor-card",HaListManagerTandoorCard);
if(!customElements.get("ha-list-manager-tandoor-card-editor"))customElements.define("ha-list-manager-tandoor-card-editor",HaListManagerTandoorCardEditor);
window.customCards ||= [];if(!window.customCards.some(card=>card.type==="ha-list-manager-tandoor-card"))window.customCards.push({type:"ha-list-manager-tandoor-card",name:"HA List Manager · Tandoor",preview:true});
