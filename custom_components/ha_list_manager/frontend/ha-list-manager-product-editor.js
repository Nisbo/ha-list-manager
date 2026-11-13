// Shared product-only form. Its callers own list/stock context and persistence.
// Loaded as a native module by the cards and panel; translations stay with HA.
(() => {
  if (globalThis.HaListManagerProductEditor) return;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const productFields = ['name', 'original_name', 'ean', 'brand', 'package_quantity', 'image_url'];
  const refreshFields = {original_name:'products.original_name', brand:'ui.brand', package_quantity:'ui.amount', image_url:'ui.optional_image_url'};

  function stageRefresh(draft, product) {
    const incoming = {original_name:product.original_name || product.name, brand:product.brand, package_quantity:product.package_quantity, image_url:product.image_url};
    draft.off_changes = [];
    draft.off_ean = String(draft.ean || '').trim();
    for (const [field, value] of Object.entries(incoming)) {
      const after = String(value || '').trim(), before = String(draft[field] || '');
      // Incomplete external data must never erase a local value.
      if (!after) continue;
      if (!before.trim()) draft[field] = after;
      else if (before !== after) draft.off_changes.push({field, before, after, selected:false});
    }
  }

  function applyRefresh(draft, field, selected) {
    if (!draft || !Object.hasOwn(refreshFields, field) || draft.off_ean !== String(draft.ean || '').trim()) return null;
    const change = draft.off_changes?.find((item) => item.field === field);
    if (!change) return null;
    // Toggling an OFF suggestion back must retain any intervening manual edit.
    if (draft[field] !== (change.selected ? change.after : change.before)) change.before = draft[field];
    draft[field] = selected ? change.after : change.before;
    change.selected = selected;
    return change;
  }

  function renderRefresh(draft, text) {
    if (!draft?.off_changes?.length || draft.off_ean !== String(draft.ean || '').trim()) return '';
    const changes = draft.off_changes.filter((change) => Object.hasOwn(refreshFields, change.field));
    if (!changes.length) return '';
    return `<section class="off-refresh" aria-label="${escapeHtml(text('products.refresh_changes'))}"><strong>${text('products.refresh_changes')}</strong><p>${text('products.refresh_review')}</p>${changes.map((change) => `<label><input type="checkbox" data-off-change="${change.field}" ${change.selected ? 'checked' : ''}><span><strong>${text(refreshFields[change.field])}</strong><small>${escapeHtml(change.before)} → ${escapeHtml(change.after)}</small></span></label>`).join('')}</section>`;
  }

  function snapshot(draft, extra = {}) {
    if (!draft) return null;
    return JSON.stringify({
      ...Object.fromEntries(productFields.map((key) => [key, String(draft[key] || '').trim()])),
      label_ids:[...new Set(draft.label_ids || [])].sort(), ...extra,
    });
  }

  function parseName(name, brand, quantity) {
    let baseName = String(name || '').trim();
    const removeSuffix = (value) => {
      const suffix = value ? ` – ${String(value).trim()}` : '';
      if (!suffix || !baseName.endsWith(suffix)) return false;
      baseName = baseName.slice(0, -suffix.length).trim();
      return true;
    };
    const appendQuantity = removeSuffix(quantity), appendBrand = removeSuffix(brand);
    return {name:String(name || '').trim(), base_name:baseName, append_brand:appendBrand, append_quantity:appendQuantity};
  }

  function buildName(draft) {
    let name = String(draft.base_name || draft.name || draft.original_name || '').trim();
    for (const [enabled, value] of [[draft.append_brand,draft.brand],[draft.append_quantity,draft.package_quantity]]) {
      const part = String(value || '').trim();
      if (enabled && part && !name.toLocaleLowerCase().includes(part.toLocaleLowerCase())) name += ` – ${part}`;
    }
    return name;
  }

  function renderFields(options) {
    const {draft, text, fieldAttribute, lookupAttribute, lookupLabel, lookupIcon = 'mdi:database-search-outline',
      readonly = false, originalReadonly = false, disabled = false, busy = false, nameOptions,
      imageAttribute = '', imageTransform = (url) => url, imageFieldHidden = false, eanStatusHtml = '', eanError = '', packagePlaceholder = text('ui.package_volume_example')} = options;
    const field = (key, label, {readOnly = readonly, type = 'text', hidden = false, max = 200, placeholder = ''} = {}) => {
      const input = `<input type="${hidden ? 'hidden' : type}" ${fieldAttribute(key)} value="${escapeHtml(draft[key])}"${max ? ` maxlength="${max}"` : ''}${key === 'ean' ? ' inputmode="numeric"' : ''}${readOnly ? ' readonly' : ''}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}${key === 'ean' && eanError ? ' class="invalid" aria-invalid="true"' : ''} autocomplete="off">`;
      return hidden ? input : `<label class="field product-editor-field"><span>${text(label)}</span>${input}${key === 'ean' && eanError ? `<small class="field-error">${escapeHtml(eanError)}</small>` : ''}</label>`;
    };
    const buttonClass = nameOptions?.buttonClass || '';
    const nameButtons = nameOptions ? `<div class="name-options"><button type="button" class="${buttonClass}${draft.append_brand ? ' active' : ''}" ${nameOptions.brandAttribute} ${disabled || nameOptions.disabled || (!nameOptions.allowEmpty && !draft.brand) ? 'disabled' : ''}><ha-icon icon="mdi:tag-outline"></ha-icon>${text('ui.brand')}</button><button type="button" class="${buttonClass}${draft.append_quantity ? ' active' : ''}" ${nameOptions.quantityAttribute} ${disabled || nameOptions.disabled || (!nameOptions.allowEmpty && !draft.package_quantity) ? 'disabled' : ''}><ha-icon icon="mdi:scale-balance"></ha-icon>${text('ui.amount')}</button></div>` : '';
    const image = draft.image_url ? `<img src="${escapeHtml(imageTransform(draft.image_url))}" alt="${escapeHtml(draft.name)}">` : '<ha-icon icon="mdi:image-off-outline"></ha-icon>';
    const preview = imageAttribute && draft.image_url
      ? `<button type="button" class="product-editor-image" ${imageAttribute} aria-label="${escapeHtml(text('ui.enlarge_product_image'))}" title="${escapeHtml(text('ui.enlarge_product_image'))}">${image}</button>`
      : `<div class="product-editor-image">${image}</div>`;
    return `<div class="product-editor-fields"><div class="product-editor-top"><div class="product-editor-main">${field('name','products.custom_name')}${nameButtons}<div class="product-editor-ean"><div class="product-editor-ean-row">${field('ean','ui.ean_optional',{max:32})}<button type="button" class="ha-button product-editor-lookup" ${lookupAttribute} ${disabled || busy ? 'disabled' : ''}><ha-icon icon="${escapeHtml(lookupIcon)}"></ha-icon>${lookupLabel}</button></div>${eanStatusHtml}</div></div>${preview}</div>${field('original_name','products.original_name',{readOnly:originalReadonly || readonly})}<div class="product-editor-grid">${field('brand','ui.brand_optional',{max:200})}${field('package_quantity','ui.package_quantity_optional',{max:100,placeholder:packagePlaceholder})}</div>${renderRefresh(draft,text)}${field('image_url','ui.optional_image_url',{type:'url',hidden:imageFieldHidden,max:1000})}</div>`;
  }

  function styles() {
    return `.product-editor-fields{min-width:0}.product-editor-top{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:16px;align-items:start}.product-editor-main{min-width:0}.product-editor-fields .product-editor-field{display:flex;flex-direction:column;gap:6px;margin-top:14px;padding-right:0!important}.product-editor-fields input{min-width:0;width:100%;box-sizing:border-box}.product-editor-image{display:grid;place-items:center;position:static;align-self:start;width:112px;height:112px;margin-top:14px;padding:0;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color);color:var(--secondary-text-color);overflow:hidden}.product-editor-image img{display:block;width:100%;height:100%;object-fit:contain}.product-editor-image>ha-icon{--mdc-icon-size:40px}.product-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.product-editor-ean-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.product-editor-lookup{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:45px;padding:0 14px;border:1px solid var(--divider-color);border-radius:24px;background:var(--card-background-color);color:var(--primary-text-color);cursor:pointer}.product-editor-ean .dialog-status,.product-editor-ean .lookup-status{display:block;margin-top:6px}.product-editor-fields .name-options{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.product-editor-fields .name-options button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 14px;border:1px solid var(--divider-color);border-radius:21px;background:var(--card-background-color);color:var(--primary-text-color);cursor:pointer}.product-editor-fields .name-options button.active{border-color:var(--primary-color);background:var(--primary-color);color:#fff}.product-editor-fields .off-refresh{margin:14px 0;padding:12px;border:1px solid var(--divider-color);border-left:3px solid var(--primary-color);border-radius:8px}.product-editor-fields .off-refresh>p{margin:6px 0 10px;color:var(--secondary-text-color);font-size:14px;line-height:1.4}.product-editor-fields .off-refresh label{display:flex!important;flex-direction:row!important;align-items:flex-start;gap:10px;margin:10px 0!important}.product-editor-fields .off-refresh input[type=checkbox]{flex:0 0 auto;width:20px!important;min-height:20px!important;height:20px;margin:2px 0 0;padding:0;accent-color:var(--primary-color)}.product-editor-fields .off-refresh label>span{display:flex;flex-direction:column;min-width:0;gap:4px}.product-editor-fields .off-refresh small{overflow-wrap:anywhere;white-space:normal;color:var(--secondary-text-color)}.product-editor-fields .field-error{color:var(--error-color);font-size:12px}.product-editor-fields input.invalid{border-color:var(--error-color)}@media(max-width:600px){.product-editor-top{grid-template-columns:minmax(0,1fr)}.product-editor-image{grid-row:1;justify-self:end;width:90px;height:90px;margin:8px 0 0}.product-editor-grid{grid-template-columns:minmax(0,1fr)}}`;
  }

  function cancelRename(host) { host._productRenamePrompt?.(null); }

  function confirmChipRename(host, info) {
    cancelRename(host);
    if (!host.isConnected) return Promise.resolve(null);
    const text = (key, values = {}) => host._hass.localize(`component.ha_list_manager.config_panel.${key}`, values);
    const previousFocus = host.shadowRoot?.activeElement;
    const portal = document.createElement('div');
    portal.setAttribute('data-product-chip-rename', '');
    const root = portal.attachShadow({mode:'open'});
    root.innerHTML = `<style>:host{position:fixed;inset:0;z-index:20000;display:block;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,Roboto,sans-serif)}*{box-sizing:border-box}.backdrop{display:flex;align-items:center;justify-content:center;min-height:100%;padding:max(18px,env(safe-area-inset-top)) 18px max(18px,env(safe-area-inset-bottom));background:rgba(0,0,0,.55);overflow:auto;height:100dvh}.dialog{width:100%;max-width:540px;max-height:100%;overflow:auto;padding:24px;border-radius:16px;background:var(--card-background-color,#fff);box-shadow:0 12px 40px rgba(0,0,0,.35)}h2{margin:0 0 16px;font-size:22px;font-weight:500}p{line-height:1.5;overflow-wrap:anywhere}small{display:block;line-height:1.5;color:var(--secondary-text-color)}footer{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin-top:24px}button{min-height:44px;padding:10px 20px;border:1px solid var(--divider-color);border-radius:24px;font:inherit;color:var(--primary-text-color);background:transparent;cursor:pointer}button.primary{background:var(--primary-color);border-color:var(--primary-color);color:var(--text-primary-color,#fff)}button:focus-visible{outline:2px solid var(--primary-color);outline-offset:3px}</style><div class="backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><h2 id="rename-title">${escapeHtml(text('products.rename_chips_title'))}</h2><p>${escapeHtml(text('products.rename_chips_body', info))}</p><small>${escapeHtml(text('products.rename_chips_hint'))}</small><footer><button class="primary" data-rename-yes>${escapeHtml(text('products.rename_chips_yes'))}</button><button data-rename-no>${escapeHtml(text('products.rename_chips_no'))}</button><button data-rename-cancel>${escapeHtml(text('ui.cancel'))}</button></footer></section></div>`;
    return new Promise(resolve => {
      const finish = choice => {
        if (host._productRenamePrompt !== finish) return;
        host._productRenamePrompt = null;
        portal.remove();
        if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
        resolve(choice);
      };
      host._productRenamePrompt = finish;
      root.querySelector('[data-rename-yes]').addEventListener('click', () => finish(true));
      root.querySelector('[data-rename-no]').addEventListener('click', () => finish(false));
      root.querySelector('[data-rename-cancel]').addEventListener('click', () => finish(null));
      root.querySelector('.backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) finish(null); });
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();finish(null);}
        if (event.key !== 'Tab') return;
        const buttons = [...root.querySelectorAll('button')], first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && root.activeElement === first) {event.preventDefault();last.focus({preventScroll:true});}
        else if (!event.shiftKey && root.activeElement === last) {event.preventDefault();first.focus({preventScroll:true});}
      });
      document.body.appendChild(portal);
      root.querySelector('[data-rename-cancel]').focus({preventScroll:true});
    });
  }

  async function saveProduct(host, request) {
    let result = await request({confirm_chip_rename:true});
    while (result?.chip_rename_confirmation) {
      const info = result.chip_rename_confirmation;
      const choice = await confirmChipRename(host, info);
      if (choice === null || !host.isConnected) return null;
      result = await request({rename_matching_chips:choice, chip_rename_from:info.old_name});
    }
    return result;
  }

  globalThis.HaListManagerProductEditor = Object.freeze({renderFields,renderRefresh,stageRefresh,applyRefresh,snapshot,parseName,buildName,styles,saveProduct,cancelRename});
})();
