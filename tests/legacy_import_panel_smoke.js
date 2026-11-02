const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { nativeHass } = require('./native_translation_hass');
let Panel;
const context = vm.createContext({
  console, Date, Intl, TextEncoder, setTimeout, clearTimeout,
  HTMLElement: class { attachShadow() { return this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [] }; } },
  customElements: { get: () => null, define: (name, ctor) => { Panel = ctor; } },
  document: { documentElement: { lang: 'en' }, body: { style: {} } }, window: {},
  navigator: { clipboard: { writeText: async () => {} } },
});
vm.runInContext(fs.readFileSync(path.join(root, 'custom_components/ha_list_manager/frontend/ha-list-manager-panel.js'), 'utf8'), context);
const create = (language = 'en') => {
  const panel = new Panel();
  panel._hass = nativeHass({ language, states: { 'todo.groceries': { attributes: { friendly_name: 'Groceries' } } } });
  panel._activeSection = 'backup'; panel._dataManagementTab = 'import';
  return panel;
};
async function main() {
  for (const language of ['en', 'de']) {
    const panel = create(language);
    assert.match(panel._renderDataManagement(), /data-data-management-tab="backup"/);
    assert.match(panel._renderDataManagement(), /data-legacy-import-view/);
    assert.ok(panel._renderLegacyImport().includes(language === 'de' ? 'Konfiguration prüfen' : 'Check configuration'));
    assert.match(panel._renderLegacyImport(), /maxlength="262144"/);
    panel._legacyImport.draft = { draft_id: 'no-entity', cards: [{ id: 'card-1', mode: 'todo', title: 'Tasks', target_name: 'New tasks' }] };
    panel._legacyImport.selections = [{ card_id: 'card-1', entity_id: '', target_name: 'New tasks' }];
    const nativeText = key => panel._hass.localize('component.ha_list_manager.config_panel.legacy_import.' + key);
    let sourceHtml = panel._renderLegacyImportSources();
    for (const key of ['data_mode', 'with_entries', 'without_entries']) assert.ok(nativeText(key) && sourceHtml.includes(nativeText(key)), language + ': native import-mode label ' + key);
    assert.equal(panel._legacyImportSourcesValid(), false);
    panel._setLegacyImportItems(false);
    sourceHtml = panel._renderLegacyImportSources();
    assert.match(sourceHtml, /data-legacy-source-wrapper hidden/);
    assert.ok(sourceHtml.includes(nativeText('no_entries_help')));
    assert.equal(panel._legacyImportSourcesValid(), true);
    panel._legacyImport.plan = { include_items: false, can_import: true, lists: [{ list_type: 'todo', name: 'New tasks', source_entity: null, counts: { items: 0, completed: 0, categories: 0, chips: 0 }, items: [], categories: [], chips: [] }] };
    const emptyHtml = panel._renderLegacyImportPreview();
    assert.ok(emptyHtml.includes(nativeText('no_entries_preview')));
    assert.ok(!emptyHtml.includes(' · null'));
    const dateOnly = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date('2026-11-02T00:00:00Z'));
    assert.equal(panel._legacyImportItemDetails({ due_at: '2026-11-02' }, 'todo'), dateOnly, 'Date-only deadlines must not shift to the previous day or show a time');
    const timestamp = '2026-11-02T15:45:00Z';
    const localTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
    assert.equal(panel._legacyImportItemDetails({ due_at: timestamp }, 'todo'), localTime);
    assert.equal(panel._legacyImportItemDetails({ due_at: 'invalid-date' }, 'todo'), 'invalid-date');
    const repeated = panel._legacyImportItemDetails({ recurrence_interval: 3, recurrence_unit: 'D' }, 'todo');
    assert.equal(repeated, panel._hass.localize('component.ha_list_manager.config_panel.ui.every_interval', { p0: 3, p1: panel._hass.localize('component.ha_list_manager.config_panel.ui.days') }));
    panel._backupInfo = { backups: [{ id: 'backup-1', origin: 'before_import', name: 'Pre-import', created_at: '2026-11-02T10:00:00Z' }] };
    assert.ok(panel._renderDataBackup().includes(language === 'de' ? 'Automatisch vor Datenübernahme' : 'Automatically before data import'));
    // Inventory is a deliberate simplified import; zero and hidden stock are not completed tasks.
    const stockDetails = panel._legacyImportItemDetails({ stock: 0, category: 'Freezer', hidden: true, merged_count: 2, completed: true, due_at: '2000-01-01', recurrence_interval: 7, recurrence_unit: 'D' }, 'inventory');
    assert.ok(stockDetails.includes(nativeText('inventory_stock').replace('{stock}', '0')));
    assert.ok(stockDetails.includes(nativeText('inventory_merged').replace('{count}', '2')));
    assert.ok(stockDetails.includes(nativeText('inventory_hidden')));
    assert.ok(!stockDetails.includes('2000') && !stockDetails.includes(language === 'de' ? 'Erledigt' : 'Completed'));
    panel._legacyImport.draft.cards[0].mode = 'inventory';
    panel._legacyImport.selections[0].list_type = 'inventory';
    assert.ok(!panel._renderLegacyImportSources().includes('data-legacy-list-type='), 'Existing inventory cards stay inventory');
    assert.ok(panel._renderLegacyImportSources().includes(nativeText('inventory_simple')));
    panel._legacyImport.draft.cards[0].mode = 'todo';
    panel._legacyImport.selections[0].list_type = 'todo';
    panel._setLegacyImportListType(0, 'inventory');
    assert.equal(panel._legacyImport.selections[0].list_type, 'todo', 'General tasks must not become products through the selector');
    // A reason is explained once, with readable card names and the affected settings beneath it.
    const grouped = panel._renderLegacyImportWarnings([
      { group: 'backend', reason: 'notifications', source: 'card-1', source_name: 'Groceries', field: 'notify_entity', message: 'Configure notifications in the backend.' },
      { group: 'backend', reason: 'notifications', source: 'card-1', source_name: 'Groceries', field: 'notify_on_change', message: 'Configure notifications in the backend.' },
      { group: 'backend', reason: 'notifications', source: 'card-2', source_name: 'Pantry', field: 'notify_entity', message: 'Configure notifications in the backend.' },
      { group: 'security', reason: 'credentials', source_name: 'Groceries', field: 'longlived_token', message: 'Credentials discarded <script>' },
    ]);
    assert.equal(grouped.split('Configure notifications in the backend.').length - 1, 1, 'A shared reason must not be repeated for each setting or card');
    assert.ok(grouped.includes('Groceries') && grouped.includes('Pantry') && grouped.includes('notify_on_change'));
    assert.ok(grouped.includes(nativeText('warning_group_backend')) && grouped.includes(nativeText('warning_group_security')));
    assert.ok(!grouped.includes('card-1') && !grouped.includes('card-2'));
    assert.ok(grouped.includes('&lt;script&gt;') && !grouped.includes('<script>'));
    const fallback = panel._renderLegacyImportWarnings([{ source: 'card-1', field: 'custom_setting', message: 'Fallback reason' }]);
    assert.ok(!fallback.includes('card-1') && fallback.includes(nativeText('warning_card').replace('{number}', '1')));
    assert.ok(panel._renderLegacyImportWarnings(['Legacy plain warning']).includes('Legacy plain warning'));
  }
  const panel = create(), calls = [];
  const input = { value: 'type: custom:ha-shopping-list-improved\nentity: todo.groceries\nlonglived_token: PRIVATE_EXAMPLE', disabled: false };
  const slots = Object.fromEntries(['sources', 'preview', 'result'].map(name => [`[data-legacy-${name}-block]`, { dataset: { key: '' }, innerHTML: '' }]));
  const inputBlock = { hidden: false }, files = { innerHTML: '' }, preview = { disabled: true };
  const nodes = { '[data-legacy-import-view]': {}, '[data-legacy-yaml]': input, '[data-legacy-input-block]': inputBlock, '[data-legacy-files]': files, '[data-legacy-preview]': preview, ...slots };
  panel.shadowRoot.querySelector = selector => nodes[selector] || null;
  panel.shadowRoot.querySelectorAll = () => [];
  Object.defineProperty(panel.shadowRoot, 'innerHTML', { set() { throw Error('Wizard updates must not rebuild the panel'); } });
  const draft = { draft_id: 'draft-1', cards: [{ id: 'card-1', source_entity: 'todo.groceries', mode: 'shopping', title: 'Groceries', target_name: 'New groceries' }], warnings: [{ message: 'Ignored unsupported secret field: longlived_token' }] };
  const plan = { plan_id: 'plan-1', can_import: true, lists: [{ name: 'New groceries', list_type: 'shopping', source_entity: 'todo.groceries', counts: { items: 10000, completed: 4, categories: 1, chips: 500 }, categories: [{ name: 'Drinks', color: '#00008B', icon: 'mdi:bottle-soda', rules: ['Water'] }], chips: Array.from({ length: 20 }, (_, i) => ({ name: `Chip ${i}` })), items: Array.from({ length: 20 }, (_, i) => ({ name: `Entry ${i}`, quantity: 1, category: 'Drinks' })) }], warnings: [{ message: 'Named color darkblue converted to #00008B' }] };
  const inventoryPlan = { ...plan, plan_id: 'inventory-plan', lists: [{ ...plan.lists[0], list_type: 'inventory', counts: { items: 1, products: 1, hidden: 0, categories: 1, chips: 2 }, items: [{ name: 'Milk', stock: 5, quantity: 5, merged_count: 2, category: 'Drinks', hidden: false }] }] };
  const result = { lists: [{ name: 'New groceries', list_id: 'list-1' }], cards_yaml: ['type: custom:ha-list-manager-shopping-card\nlist_id: list-1', 'type: custom:ha-list-manager-todo-card\nlist_id: list-2'], backup: { id: 'backup-1', name: 'Backup before data import' } };
  panel._hass.callWS = async request => {
    calls.push(request);
    assert.equal(request.language, 'en');
    if (request.type.endsWith('/analyze')) { assert.equal(input.value, '', 'Submitted raw YAML is cleared before awaiting the server'); return draft; }
    if (request.type.endsWith('/preview')) return request.sources[0].list_type === 'inventory' ? inventoryPlan : plan;
    if (request.type.endsWith('/apply')) return result;
    if (request.type.endsWith('/lists/list')) return { lists: [{ id: 'list-1', name: 'New groceries' }] };
    throw Error('Refresh unavailable');
  };
  panel._legacyImport.files = [{ name: 'categories.txt', text: 'Drinks' }];
  await panel._analyzeLegacyImport();
  assert.equal(calls[0].files['categories.txt'], 'Drinks');
  assert.equal(input.value, ''); assert.equal(panel._legacyImport.files.length, 0);
  assert.equal(JSON.stringify(panel._legacyImport).includes('PRIVATE_EXAMPLE'), false);
  assert.equal(panel._legacyImport.selections[0].entity_id, 'todo.groceries');
  assert.equal(panel._legacyImport.selections[0].list_type, 'shopping');
  assert.match(panel._renderLegacyImportSources(), /data-legacy-list-type="0"/);
  assert.equal(inputBlock.hidden, true); assert.equal(preview.disabled, false); assert.equal(panel._legacyImport.includeItems, true);
  assert.ok(slots['[data-legacy-sources-block]'].innerHTML.includes('Ignored unsupported secret field'));
  assert.ok(!slots['[data-legacy-sources-block]'].innerHTML.includes('PRIVATE_EXAMPLE'));
  // Editing only invalidates the preview, preserving source fields and their focus.
  let sourceWrites = 0, sourceMarkup = slots['[data-legacy-sources-block]'].innerHTML;
  Object.defineProperty(slots['[data-legacy-sources-block]'], 'innerHTML', { get() { return sourceMarkup; }, set(value) { sourceWrites++; sourceMarkup = value; } });
  const target = { dataset: { legacyTargetName: '0' }, value: '  Updated groceries  ' };
  const picker = { dataset: { legacySource: '0' }, listeners: [], addEventListener(name, fn) { this.listeners.push(fn); } };
  const draftWarning = { hidden: false }, sourceWrapper = { hidden: false }, sourceFields = { dataset: {} }, mode = { value: 'true' }, sourceHelp = { textContent: '' };
  const typeSelect = { dataset: { legacyListType: '0' }, value: 'shopping' }, typeCaption = { dataset: { legacyTypeCaption: '0' }, textContent: '' }, inventoryHelp = { dataset: { legacyInventoryHelp: '0' }, hidden: true };
  nodes['[data-legacy-import-items]'] = mode; nodes['[data-legacy-source-help]'] = sourceHelp;
  panel.shadowRoot.querySelectorAll = selector => selector === '[data-legacy-target-name]' ? [target] : selector === '[data-legacy-source]' ? [picker] : selector === '[data-legacy-draft-warnings]' ? [draftWarning] : selector === '[data-legacy-source-wrapper]' ? [sourceWrapper] : selector === '[data-legacy-source-fields]' ? [sourceFields] : selector === '[data-legacy-list-type]' ? [typeSelect] : selector === '[data-legacy-type-caption]' ? [typeCaption] : selector === '[data-legacy-inventory-help]' ? [inventoryHelp] : [];
  panel._bindLegacyImportEvents(); panel._bindLegacyImportEvents();
  assert.equal(picker.selector.entity.filter.domain, 'todo'); assert.equal(picker.listeners.length, 1);
  target.oninput(); assert.equal(sourceWrites, 0); assert.equal(panel._legacyImport.selections[0].target_name, target.value);
  typeSelect.value = 'inventory'; typeSelect.onchange();
  assert.equal(panel._legacyImport.selections[0].list_type, 'inventory');
  assert.equal(sourceWrites, 0, 'Changing list type must preserve all source and name inputs');
  assert.equal(inventoryHelp.hidden, false);
  assert.equal(typeCaption.textContent, panel._hass.localize('component.ha_list_manager.config_panel.legacy_import.inventory_simple'));
  await panel._previewLegacyImport();
  assert.equal(calls.find(c => c.type.endsWith('/preview')).sources[0].list_type, 'inventory');
  assert.equal(panel._legacyImport.plan, inventoryPlan);
  const inventoryHtml = panel._renderLegacyImportPreview();
  assert.ok(inventoryHtml.includes(panel._hass.localize('component.ha_list_manager.config_panel.legacy_import.inventory_help')));
  assert.ok(inventoryHtml.includes('Stock: 5') && inventoryHtml.includes('Combined from 2 entries'));
  assert.ok(inventoryHtml.includes('1 new products') && !inventoryHtml.includes('completed'));
  panel._legacyImport.error = 'Old inventory preview'; panel._legacyImport.confirmed = true;
  typeSelect.value = 'shopping'; typeSelect.onchange();
  assert.equal(panel._legacyImport.plan, null); assert.equal(panel._legacyImport.error, ''); assert.equal(panel._legacyImport.confirmed, false);
  assert.equal(inventoryHelp.hidden, true); assert.equal(sourceWrites, 0);
  await panel._previewLegacyImport();
  assert.equal(draftWarning.hidden, true, 'Draft warnings disappear once the preview provides the same warnings');
  assert.equal(sourceWrites, 0, 'Hiding draft warnings must preserve the source controls');
  assert.match(panel._renderLegacyImportSources(), /data-legacy-draft-warnings hidden/);
  assert.equal(calls.find(c => c.type.endsWith('/preview')).sources[0].target_name, 'Updated groceries');
  assert.equal(calls.find(c => c.type.endsWith('/preview')).include_items, true, 'Existing entry import remains the default');
  const html = panel._renderLegacyImportPreview();
  assert.ok(html.includes('10000')); assert.ok(html.includes('500')); assert.ok(html.includes('20'));
  assert.ok(html.includes('Entry 19')); assert.ok(!html.includes('Entry 20'));
  assert.ok(html.includes('--import-color:#00008B')); assert.ok(html.includes('data-legacy-confirm'));
  // Changing entry mode invalidates stale previews without replacing source/name inputs.
  panel._legacyImport.error = 'Source unavailable'; panel._legacyImport.confirmed = true;
  mode.value = 'false'; mode.onchange();
  assert.equal(panel._legacyImport.includeItems, false); assert.equal(panel._legacyImport.plan, null);
  assert.equal(panel._legacyImport.confirmed, false); assert.equal(panel._legacyImport.error, '');
  assert.equal(sourceWrites, 0, 'Changing entry mode must not replace editable source rows');
  assert.equal(sourceWrapper.hidden, true); assert.equal(sourceFields.dataset.noSource, 'true');
  assert.equal(picker.disabled, true); assert.equal(picker.required, false); assert.equal(picker.value, 'todo.groceries');
  assert.equal(panel._legacyImport.selections[0].target_name, target.value);
  assert.ok(sourceHelp.textContent.includes('empty') || sourceHelp.textContent.length > 20);
  mode.value = 'true'; mode.onchange();
  assert.equal(picker.disabled, false); assert.equal(picker.required, true); assert.equal(picker.value, 'todo.groceries');
  assert.equal(sourceWrapper.hidden, false); assert.equal(sourceFields.dataset.noSource, 'false');
  panel._legacyImport.selections[0].entity_id = '';
  assert.equal(panel._legacyImportSourcesValid(), false, 'With entries still requires a source');
  mode.value = 'false'; mode.onchange();
  assert.equal(panel._legacyImportSourcesValid(), true, 'Configuration-only imports do not need an entity');
  assert.equal(preview.disabled, false);
  const emptyPlan = { ...plan, plan_id: 'empty-plan', include_items: false, lists: [{ ...plan.lists[0], include_items: false, source_entity: null, counts: { items: 0, completed: 0, categories: 1, chips: 500 }, items: [] }] };
  const callWS = panel._hass.callWS;
  panel._hass.callWS = async request => {
    if (request.type.endsWith('/preview')) { calls.push(request); assert.equal(request.include_items, false); assert.equal(request.sources[0].entity_id, ''); return emptyPlan; }
    return callWS(request);
  };
  await panel._previewLegacyImport();
  assert.equal(panel._legacyImport.plan, emptyPlan);
  assert.ok(!panel._renderLegacyImportPreview().includes('todo.groceries'));
  assert.equal(sourceWrites, 0);
  panel._legacyImport.selections[0].target_name = ' ';
  assert.equal(panel._legacyImportSourcesValid(), false, 'Names remain required without entries');
  panel._legacyImport.selections[0].target_name = target.value;
  panel._hass.callWS = callWS;
  const before = calls.length; await panel._applyLegacyImport(); assert.equal(calls.length, before, 'Apply requires confirmation');
  panel._legacyImport.confirmed = true;
  await Promise.all([panel._applyLegacyImport(), panel._applyLegacyImport()]);
  assert.equal(calls.filter(c => c.type.endsWith('/apply')).length, 1, 'Repeated clicks must not apply twice');
  assert.equal(panel._legacyImport.result, result); assert.equal(panel._legacyImport.error, '', 'Successful import survives navigation refresh failure');
  const resultHtml = panel._renderLegacyImportResult();
  assert.ok(resultHtml.includes('\n---\n')); assert.ok(resultHtml.includes('Backup before data import'));
  assert.equal(panel._lists[0].id, 'list-1');
  // Opening an imported inventory must load real stock, rather than ordinary list items.
  for (const listType of ['inventory', 'shopping', 'todo']) {
    const opened = create(), listId = 'imported-' + listType;
    const button = { dataset: { legacyOpenList: listId } }, navigation = [];
    opened._lists = [{ id: listId, list_type: listType, name: 'Imported list' }];
    opened._selectedInventoryListId = 'previous-inventory';
    opened._inventoryEntries = [{ id: 'stale', stock: 99 }]; opened._inventoryGroups = [{ id: 'stale-group' }];
    opened._items = [{ id: 'stale-item' }]; opened._listItemSearch = 'old search'; opened._listAssignmentGroups = [{ id: 'old-assignment' }];
    opened._listDetailTab = 'assignments'; opened._render = () => {};
    opened.shadowRoot.querySelector = selector => selector === '[data-legacy-import-view]' ? {} : null;
    opened.shadowRoot.querySelectorAll = selector => selector === '[data-legacy-open-list]' ? [button] : [];
    opened._loadItems = () => navigation.push('items');
    opened._loadListAssignments = id => navigation.push('assignments:' + id);
    opened._loadDashboardUsages = () => navigation.push('dashboards');
    const stockRows = Array.from({ length: 4 }, (_, index) => ({ id: 'stock-' + index, stock: index + 1 }));
    const stockRequests = [];
    opened._hass.callWS = async request => {
      stockRequests.push(request);
      if (request.type.endsWith('/inventory/list')) return { entries: stockRows };
      if (request.type.endsWith('/products/list')) return { products: [], total: 0 };
      if (request.type.endsWith('/inventory/groups/list')) return { groups: [] };
      if (request.type.endsWith('/inventory/restock/settings/get')) return { settings: { enabled: false } };
      if (request.type.endsWith('/inventory/restock/preview')) return { items: [] };
      throw Error('Unexpected result navigation request: ' + request.type);
    };
    const loadInventory = opened._loadInventory.bind(opened);
    let inventoryLoad;
    opened._loadInventory = () => { navigation.push('inventory'); inventoryLoad = loadInventory(); return inventoryLoad; };
    opened._bindLegacyImportEvents(); button.onclick();
    if (inventoryLoad) await inventoryLoad;
    assert.equal(opened._activeSection, 'lists'); assert.equal(opened._selectedListId, listId);
    assert.equal(opened._listDetailTab, 'overview'); assert.equal(opened._listItemSearch, '');
    assert.equal(opened._items.length, 0); assert.equal(opened._listAssignmentGroups.length, 0);
    if (listType === 'inventory') {
      assert.deepEqual(navigation, ['inventory', 'dashboards']);
      assert.equal(opened._selectedInventoryListId, listId);
      assert.equal(opened._inventoryEntries.length, 4);
      assert.equal(opened._inventoryEntries.reduce((sum, entry) => sum + entry.stock, 0), 10);
      assert.equal(opened._inventoryGroups.length, 0);
      assert.equal(stockRequests.find(request => request.type.endsWith('/inventory/list')).list_id, listId);
    } else {
      assert.deepEqual(navigation, ['items', 'assignments:' + listId, 'dashboards']);
      assert.equal(inventoryLoad, undefined); assert.equal(stockRequests.length, 0);
    }
  }
  // Retry keeps the same plan ID after a lost response; server idempotency applies.
  const retry = create(); retry._updateLegacyImport = () => {};
  retry._legacyImport.plan = plan; retry._legacyImport.confirmed = true;
  let attempts = 0;
  retry._hass.callWS = async request => {
    if (request.type.endsWith('/apply')) { assert.equal(request.plan_id, 'plan-1'); if (!attempts++) throw { message: 'Connection interrupted' }; return result; }
    return {};
  };
  await retry._applyLegacyImport(); assert.equal(retry._legacyImport.plan, plan); assert.equal(retry._legacyImport.confirmed, true);
  await retry._applyLegacyImport(); assert.equal(retry._legacyImport.result, result);
  // Size and duplicate checks happen before reading files or making API requests.
  const limits = create(); limits._updateLegacyImport = () => {};
  await limits._readLegacyImportFiles([{ size: 257 * 1024, name: 'large.yaml', text: () => { throw Error('must not read'); } }], true);
  assert.ok(limits._legacyImport.error.includes('256'));
  limits._legacyImport.files = [{ name: 'same.txt' }];
  await limits._readLegacyImportFiles([{ name: 'same.txt', size: 1 }], false);
  assert.ok(limits._legacyImport.error);
  panel._resetLegacyImport(); assert.equal(panel._legacyImport.includeItems, true); assert.equal(panel._legacyImport.draft, null); assert.equal(panel._legacyImport.result, null); assert.equal(inputBlock.hidden, false);
  assert.equal(sourceWrites, 1, 'Reset replaces source rows once');
  console.log('Legacy import wizard: DE/EN, simplified inventory, grouped reasons, with/without entries, safe input disposal, HA todo selector, stable fields, preview limits, explicit confirmation, retry and result tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
