const { nativeHass } = require("./native_translation_hass");
/* Production rendering, editor config round trips and archive editing requests. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.nodes = new Map(); this.listeners = new Map(); this.style = {}; this.events = []; this.attributes = new Map(); }
  set innerHTML(value) {
    this.html = value;
    this.children = this.children.filter(child => !child.parsedLabel);
    // Model the labels that production updates in place without rebuilding the
    // reference rows. Other template contents are irrelevant to this fake DOM.
    for (const match of value.matchAll(/<([a-z][\w-]*)\b[^>]*\s(data-reference-heading|data-reference-help|data-add-reference-label|data-remove-reference-label)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const label = new Element(match[1]);
      label.parsedLabel = true;
      label.setAttribute(match[2], "");
      label.textContent = match[3].replace(/<[^>]*>/g, "");
      this.nodes.set(`[${match[2]}]`, label);
      this.children.push(label);
    }
  }
  get innerHTML() { return this.html || ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.nodes.get(selector) || this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.tag === selector || (selector.startsWith("[") && child.attributes.has(selector.slice(1, -1))) ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatchEvent(event) { this.events.push(event); }
  emit(name, value) { this.listeners.get(name)?.({ detail: { value }, stopPropagation() {} }); }
  focus() {}
  setAttribute(name, value) { this.attributes.set(name, value); }
}
class HTMLElement extends Element {
  attachShadow() { return this.shadowRoot = new Element("shadow"); }
}
const registry = new Map();
const storedValues = new Map();
let storageBlocked = false;
const context = vm.createContext({
  console, HTMLElement,
  CustomEvent: class { constructor(type, data) { this.type = type; Object.assign(this, data); } },
  document: { createElement: (tag) => {
    const node = new Element(tag);
    if (tag === "ha-expansion-panel") {
      node.nodes.set("[data-reference-rows]", new Element());
      node.nodes.set("[data-add-reference]", new Element("button"));
      node.children.push(node.nodes.get("[data-reference-rows]"));
    }
    return node;
  }, body: { style: {} }, documentElement: { style: {} } },
  window: { customCards: [], setTimeout: () => 0, setInterval: () => 0 },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {},
  localStorage: {
    getItem: (key) => { if (storageBlocked) throw new Error("Storage blocked"); return storedValues.get(key) ?? null; },
    setItem: (key, value) => { if (storageBlocked) throw new Error("Storage blocked"); storedValues.set(key, value); },
  },
  ResizeObserver: class {},
  customElements: { get: (name) => registry.get(name), define: (name, ctor) => registry.set(name, ctor) },
});
const frontend = path.join(__dirname, "../custom_components/ha_list_manager/frontend");
for (const file of ["ha-list-manager-history-card.js", "ha-list-manager-panel.js"]) {
  // Separate scripts use some identical top-level constants in the browser too.
  vm.runInContext(`{${fs.readFileSync(path.join(frontend, file), "utf8")}\n}`, context);
}
const Card = registry.get("ha-list-manager-history-card");
const Editor = registry.get("ha-list-manager-history-card-editor");
const Panel = registry.get("ha-list-manager-panel");
const record = (source, value, minute, extra = {}) => ({ id: minute + 1, source, state: String(value), attributes: {}, last_updated: `2026-11-01T10:${String(minute).padStart(2,"0")}:00+00:00`, ...extra });

function chartTests() {
  const card = new Card(); card._hass = nativeHass(); card._hass = nativeHass({ locale: { language: "de" } });
  card._config = { entity: "sensor.weight", reference_lines: [{ value: 75, label: "Ziel <Gewicht>", color: [0, 255, 0] }, { value: "", label: "empty" }, { value: "invalid" }, { value: 0, label: "Zero" }] };
  const records = [record("live", 90, 0), record("long_term_statistics", 91, 1), record("corrected", 92, 2, { original_source: "long_term_statistics" }), record("manual", 93, 3), record("corrected", 94, 4, { original_source: "live" })];
  const series = { entity: "sensor.weight", name: "Weight", color: "#123456", states: records };
  const output = card._renderChart([series]);
  assert.equal((output.match(/class="reference-line"/g) || []).length, 2);
  assert.match(output, /Ziel &lt;Gewicht&gt;: 75/);
  assert.match(output, /stroke:rgb\(0,255,0\)/);
  assert.doesNotMatch(output, /class="line hourly"|stroke-dasharray/);
  assert.equal((output.match(/class="line"/g) || []).length, 1);
  assert.equal((output.match(/class="hourly-point"/g) || []).length, 2);
  assert.equal((output.match(/class="manual-point"/g) || []).length, 2);
  assert.match(output, /Aggregierter Importwert · Korrigiert/);
  const legend = card._renderLegend([series], "chart", "");
  assert.match(legend, /class="source-legend"/);
  assert.match(legend, /Messpunkt/);
  assert.doesNotMatch(legend, /Linien verbinden die Messpunkte|gestrichelt/);
  assert.match(legend, /Aggregierter Importwert<button type="button" class="aggregate-info"/);
  assert.match(legend, /data-aggregate-explanation hidden>/);
  assert.match(legend, /<button[^>]+data-aggregate-help[^>]+aria-label="Was bedeutet „aggregiert“\?"[^>]*><ha-icon icon="mdi:information-outline" aria-hidden="true"><\/ha-icon><\/button>/, "The icon-only button belongs immediately after the aggregate label");
  assert.match(legend, /data-legend-content hidden/);
  assert.equal((output.match(/<circle/g) || []).length, 3, "Live values and aggregates must all have visible markers");
  assert.doesNotMatch(output, /NaN|Infinity|<Gewicht>/);
  const list = card._renderList([series]);
  for (const source of ["Live-Aufzeichnung", "Aggregierter Importwert", "Manuell ergänzt", "Korrigiert"]) assert.ok(list.includes(source));
  assert.equal(records.length, 5, "Reference lines must not change the measurement selection");
  const categorical = card._renderChart([{ ...series, states: [record("manual", "on", 0)] }]);
  assert.match(categorical, /class="manual-point"/);
  assert.doesNotMatch(categorical, /class="reference-line"/);
}


function connectionAndAggregateInfoTests() {
  const card = new Card(); card._hass = nativeHass();
  card._hass = nativeHass({ locale: { language: "de" } });
  card._config = { entity: "sensor.first", entity_2: "sensor.second", connect_points: false };
  const configs = card._seriesConfigs();
  assert.equal(configs[0].connectPoints, false);
  assert.equal(configs[1].connectPoints, true, "An omitted setting defaults to connected");
  const series = configs.map((config, i) => ({ ...config, states: [record("live", 90 + i, 0), record("long_term_statistics", 91 + i, 1)] }));
  const mixed = card._renderChart(series);
  assert.equal((mixed.match(/class="line"/g) || []).length, 1, "Only the enabled series is connected");
  assert.equal((mixed.match(/class="hourly-point"/g) || []).length, 2);
  assert.equal((mixed.match(/<circle/g) || []).length, 4, "Disabled lines must retain all point markers");
  const disconnected = series.map((item) => ({ ...item, connectPoints: false }));
  card._config.reference_lines = [{ value: 85, label: "Reference" }];
  const dots = card._renderChart(disconnected);
  assert.doesNotMatch(dots, /class="line"/);
  assert.match(dots, /class="reference-line"/);
  assert.match(dots, /class="grid"/);
  assert.equal(card._sameSeriesData(series, disconnected), false);
  const states = [{ ...series[0], states: [record("live", "off", 0), record("live", "on", 1)] }];
  assert.doesNotMatch(card._renderChart(states), /class="line"/);
  states[0].connectPoints = true;
  assert.match(card._renderChart(states), /class="line"/);
  const exactOnly = [{ ...series[0], states: [record("live", 90, 0), record("manual", 91, 1)] }];
  const legend = card._renderSourceLegend(exactOnly);
  assert.doesNotMatch(legend, /aggregate-help|Aggregierter Importwert|legend-help/);
  card._aggregateHelpOpen = true;
  assert.match(card._renderSourceLegend(series), /aria-expanded="true"/);
  assert.doesNotMatch(card._renderSourceLegend(series), /data-aggregate-explanation hidden>/);
  assert.match(card._renderSourceLegend(series), /Mittelwert.*Zustand.*Summe/);
  const explanation = new Element(), infoButton = new Element();
  card.shadowRoot.nodes.set("[data-aggregate-explanation]", explanation);
  card.shadowRoot.nodes.set("[data-aggregate-help]", infoButton);
  card._render = () => { throw new Error("Info toggling must not redraw the chart"); };
  card._toggleAggregateHelp();
  assert.equal(explanation.hidden, true);
  assert.equal(infoButton.attributes.get("aria-expanded"), "false");
  card._toggleAggregateHelp();
  assert.equal(explanation.hidden, false);
  assert.equal(infoButton.attributes.get("aria-expanded"), "true");
  // Connecting points is purely visual, including the chronological view.
  assert.equal(card._renderList(series), card._renderList(disconnected));
  const definition = Card.getConfigForm(nativeHass());
  for (let index = 1; index <= 5; index++) {
    const name = `connect_points${index === 1 ? "" : `_${index}`}`;
    const field = definition.schema.flatMap((group) => group.schema || []).find((field) => field.name === name);
    assert.ok(field && field.default === true && field.selector.boolean);
    assert.equal(definition.computeLabel(field), "Messpunkte verbinden");
    assert.match(definition.computeHelper(field), /dieser Entität/);
  }
  const editor = new Editor(); editor.hass = nativeHass();
  editor.setConfig({ entity: "sensor.first", connect_points: false, connect_points_2: true });
  editor._form.emit("value-changed", { connect_points_2: false });
  editor._remainingForm.emit("value-changed", { values_to_show: 25 });
  assert.equal(editor.events.at(-1).detail.config.connect_points, false);
  assert.equal(editor.events.at(-1).detail.config.connect_points_2, false);
}

function editorTests() {
  const editor = new Editor();
  editor.setConfig({ entity: "sensor.weight", reference_lines: [{ value: 75, label: "Target", color: [1, 2, 3] }] });
  editor.hass = nativeHass({ locale: { language: "de-DE" } });
  assert.equal(editor._references.tag, "ha-expansion-panel");
  assert.ok(editor._references.attributes.has("outlined"));
  assert.ok(editor._form.schema.every((group) => !group.schema?.some((field) => field.name === "min_value")));
  assert.ok(editor._remainingForm.schema[0].schema.some((field) => field.name === "min_value"));
  const children = editor.shadowRoot.children;
  assert.ok(children.indexOf(editor._form) < children.indexOf(editor._references));
  assert.ok(children.indexOf(editor._references) < children.indexOf(editor._remainingForm));
  let forms = editor._references.querySelectorAll("ha-form");
  assert.equal(forms.length, 1);
  const heading = editor._references.querySelector("[data-reference-heading]");
  const help = editor._references.querySelector("[data-reference-help]");
  const addLabel = editor._references.querySelector("[data-add-reference-label]");
  const removeLabel = editor._references.querySelector("[data-remove-reference-label]");
  assert.equal(heading.textContent, "Referenzlinien");
  assert.match(help.textContent, /Horizontale Hilfslinien/);
  assert.equal(addLabel.textContent, "Referenzlinie hinzufügen");
  assert.equal(removeLabel.textContent, "Referenzlinie entfernen");
  forms[0].emit("value-changed", { value: 76, label: "Goal", color: [3, 2, 1] });
  assert.equal(editor.events.at(-1).detail.config.reference_lines[0].value, 76);
  editor.hass = nativeHass({ locale: { language: "de-DE" } });
  assert.equal(editor._references.querySelectorAll("ha-form")[0], forms[0], "HA updates must not recreate a focused reference input");
  const beforeLanguageChange = JSON.stringify(editor._config);
  const emittedEvents = editor.events.length;
  editor.hass = nativeHass({ locale: { language: "en-GB" } });
  assert.equal(editor._references.querySelectorAll("ha-form")[0], forms[0], "Changing language must preserve the focused reference input");
  assert.equal(editor._references.querySelector("[data-remove-reference-label]"), removeLabel, "Changing language must update the existing remove label");
  assert.equal(heading.textContent, "Reference lines");
  assert.match(help.textContent, /Horizontal reference lines for numeric charts/);
  assert.equal(addLabel.textContent, "Add reference line");
  assert.equal(removeLabel.textContent, "Remove reference line");
  assert.equal(forms[0].computeLabel({ name: "value" }), "Value");
  assert.equal(forms[0].computeLabel({ name: "label" }), "Label");
  assert.equal(forms[0].computeLabel({ name: "color" }), "Color");
  assert.equal(JSON.stringify(editor._config), beforeLanguageChange, "Language changes must preserve user reference labels and settings");
  assert.equal(editor.events.length, emittedEvents, "Changing language must not emit a config mutation");
  editor.hass = nativeHass({ locale: { language: "en-GB" } });
  assert.equal(editor._references.querySelectorAll("ha-form")[0], forms[0], "Ordinary HA updates must keep reference fields mounted after a language change");
  editor._references.querySelector("[data-add-reference]").emit("click");
  assert.equal(editor._config.reference_lines.length, 2);
  const firstSection = editor._references.querySelector("[data-reference-rows]").children[0];
  firstSection.children[1].emit("click");
  assert.equal(editor._config.reference_lines.length, 1);
  editor._remainingForm.emit("value-changed", { values_to_show: 12 });
  editor._form.emit("value-changed", { entity: "sensor.new" });
  assert.equal(editor.events.at(-1).detail.config.entity, "sensor.new");
  assert.equal(editor.events.at(-1).detail.config.reference_lines.length, 1);
  assert.equal(editor.events.at(-1).detail.config.values_to_show, 12);
  assert.equal(editor._form.data, editor._remainingForm.data, "Both form sections must use the latest complete configuration");
}

function legendStorageTests() {
  storedValues.clear();
  const config = { entity: "sensor.weight", title: "Weight", legend_initially_collapsed: true };
  const card = new Card(); card._hass = nativeHass(); card._config = config;
  assert.equal(card._isLegendCollapsed(), true);
  const content = new Element(), toggle = new Element(), arrow = new Element();
  content.hidden = true;
  card.shadowRoot.nodes.set("[data-legend-content]", content);
  card.shadowRoot.nodes.set("[data-toggle-legend]", toggle);
  card.shadowRoot.nodes.set("[data-legend-chevron]", arrow);
  card._render = () => { throw new Error("Folding the legend must not rebuild the chart or reset scroll"); };
  card._toggleLegend();
  assert.equal(content.hidden, false);
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
  assert.equal(arrow.attributes.get("icon"), "mdi:chevron-up");
  const reload = new Card(); reload._hass = nativeHass(); reload._config = { ...config };
  assert.equal(reload._isLegendCollapsed(), false, "Reload must restore the browser choice before applying the initial default");
  reload._toggleLegend();
  const closed = new Card(); closed._hass = nativeHass(); closed._config = { ...config, legend_initially_collapsed: false };
  assert.equal(closed._isLegendCollapsed(), true, "A changed default must not overwrite an existing browser choice");
  closed._config.legend_collapsible = false;
  assert.equal(closed._isLegendCollapsed(), false);
  closed._toggleLegend(); assert.equal(closed._isLegendCollapsed(), false);
  const other = new Card(); other._hass = nativeHass(); other._config = { ...config, title: "Other card", legend_initially_collapsed: false };
  assert.equal(other._isLegendCollapsed(), false, "Separate cards must not share a legend state");
  storageBlocked = true;
  const blocked = new Card(); blocked._hass = nativeHass(); blocked._config = config;
  assert.equal(blocked._isLegendCollapsed(), true);
  blocked._toggleLegend(); assert.equal(blocked._isLegendCollapsed(), false);
  storageBlocked = false;
}

function entityManagementLayoutTests() {
  const panel = new Panel(); panel._hass = nativeHass(); panel._render = () => {};
  panel._hass = nativeHass({ states: { "sensor.weight": { attributes: { friendly_name: "Waage Küche" }, state: "85" } } });
  panel._trackedEntities = [{ entity_id: "sensor.weight", enabled: true, sample_count: 3 }, { entity_id: "sensor.old", enabled: false, sample_count: 1 }];
  const add = panel._renderEntityHistory();
  assert.match(add, /data-entity-history-tab="add"/);
  assert.match(add, /Hinzufügen/); assert.match(add, /Verwalten/);
  assert.doesNotMatch(add, /history.tab_add|history.tab_manage/);
  assert.match(add, /data-entity-history-tab="manage"/);
  assert.match(add, /data-entity-history-picker/);
  assert.doesNotMatch(add, /data-entity-samples=|entity-history-output|type: custom:/);
  panel._entityHistoryTab = "manage";
  assert.match(panel._renderEntityHistory(), /data-entity-history-search/);
  assert.doesNotMatch(panel._renderEntityHistory(), /data-entity-history-picker|entity-history-import|Historie auffüllen/);
  const kitchen = new Element(), old = new Element(), list = new Element(), empty = new Element();
  kitchen.dataset = { historySearchValue: "waage küche sensor.weight" };
  old.dataset = { historySearchValue: "sensor.old" };
  const originalQueryAll = panel.shadowRoot.querySelectorAll.bind(panel.shadowRoot);
  panel.shadowRoot.querySelectorAll = (selector) => selector === "[data-entity-history-row]" ? [kitchen, old] : originalQueryAll(selector);
  panel.shadowRoot.nodes.set("[data-entity-history-list]", list);
  panel.shadowRoot.nodes.set("[data-entity-history-empty]", empty);
  panel._render = () => { throw new Error("Searching must preserve the existing input, focus and page scroll"); };
  for (const term of ["KÜCHE", "sensor.weight"]) {
    panel._entityHistorySearch = term; panel._filterEntityHistoryRows();
    assert.equal(kitchen.hidden, false); assert.equal(old.hidden, true); assert.equal(list.hidden, false);
  }
  panel._entityHistorySearch = "missing"; panel._filterEntityHistoryRows();
  assert.equal(list.hidden, true); assert.equal(empty.hidden, false);
  panel._entityHistorySearch = ""; panel._filterEntityHistoryRows();
  assert.equal(kitchen.hidden, false); assert.equal(old.hidden, false); assert.equal(empty.hidden, true);
}

async function entityImportFlowTests() {
  const panel = new Panel(); panel._hass = nativeHass(); panel._render = () => {};
  const queries = [];
  let fail = false, pendingImport = null, completeImport;
  panel._hass = nativeHass({ states: { "sensor.weight": { attributes: { friendly_name: "Testwaage" } } }, callWS: async (request) => {
    queries.push(request);
    if (request.type.endsWith("/import")) {
      if (pendingImport) await pendingImport;
      if (fail) throw Error("Recorder unavailable");
      return { recorder: { imported: 2, already_stored: 1 }, long_term_statistics: request.include_long_term_statistics ? { imported: 3 } : null, truncated: false };
    }
    return request.type.endsWith("/list") ? { entities: [{ entity_id: "sensor.weight", enabled: true }] } : {};
  } });
  await panel._setEntityTracking("sensor.weight", true, true);
  assert.equal(panel._dialog.kind, "entity-history-import-choice");
  for (const label of ["Historie hinzufügen?", "Komplett", "Auswahl", "Nein"]) assert.ok(panel._renderEntityHistoryImport().includes(label));
  assert.equal(queries.filter(q => q.type.endsWith("/import")).length, 0);
  panel._closeDialog(); // Nein / close dismisses only the prompt.
  assert.equal(panel._dialog, null);
  assert.equal(panel._trackedEntities[0].enabled, true);
  await panel._setEntityTracking("sensor.weight", true); // Resume must not ask again.
  assert.equal(panel._dialog, null);
  panel._openEntityHistoryImport("sensor.weight"); // Row button opens settings only.
  const settings = panel._dialog;
  assert.match(panel._renderEntityHistoryImport(), /data-history-import-field="start"/);
  assert.equal(queries.filter(q => q.type.endsWith("/import")).length, 0);
  settings.draft = { start: "2026-10-11", end: "2026-10-10", recorder: true, statistics: false };
  await panel._importEntityHistory("sensor.weight");
  assert.match(settings.error, /Anfangsdatum/);
  settings.draft = { start: "", end: "", recorder: false, statistics: false };
  await panel._importEntityHistory("sensor.weight");
  assert.match(settings.error, /Quelle/);
  assert.equal(queries.filter(q => q.type.endsWith("/import")).length, 0);
  settings.draft = { start: "2026-10-01", end: "2026-10-02", recorder: true, statistics: false };
  await panel._importEntityHistory("sensor.other"); // A different entity cannot steal the draft.
  assert.equal(queries.filter(q => q.type.endsWith("/import")).length, 0);
  await panel._importEntityHistory("sensor.weight");
  const selected = queries.findLast(q => q.type.endsWith("/import"));
  assert.equal(selected.include_recorder, true); assert.equal(selected.include_long_term_statistics, false);
  assert.equal(selected.start_time, new Date("2026-10-01T00:00:00").toISOString());
  assert.equal(selected.end_time, new Date("2026-10-02T23:59:59.999").toISOString());
  assert.equal(settings.completed, true); assert.match(settings.status, /2 importiert/);
  assert.doesNotMatch(panel._renderEntityHistoryImport(), /data-history-import-run/);
  panel._closeDialog();
  panel._openEntityHistoryImport("sensor.weight");
  assert.equal(panel._dialog.draft.start, "2026-10-01", "Selection preferences survive reopening");
  const completeOptions = { start: "", end: "", recorder: true, statistics: true };
  await panel._setEntityTracking("sensor.weight", true, true);
  const complete = panel._dialog;
  pendingImport = new Promise(resolve => { completeImport = resolve; });
  const running = panel._importEntityHistory("sensor.weight", completeOptions);
  assert.equal(panel._busy, true);
  const count = queries.length;
  await panel._importEntityHistory("sensor.weight", completeOptions);
  assert.equal(queries.length, count, "Busy guard prevents double imports");
  panel._closeDialog(); assert.equal(panel._dialog, complete, "Do not dismiss an in-flight import");
  completeImport(); await running; pendingImport = null;
  const full = queries.findLast(q => q.type.endsWith("/import"));
  assert.equal(full.include_recorder, true); assert.equal(full.include_long_term_statistics, true);
  assert.equal("start_time" in full, false); assert.equal("end_time" in full, false);
  assert.equal(complete.completed, true); assert.match(complete.status, /3 importiert/);
  panel._closeDialog(); panel._openEntityHistoryImport("sensor.weight");
  assert.equal(panel._dialog.draft.start, "2026-10-01", "Komplett must not erase the custom selection");
  fail = true; await panel._importEntityHistory("sensor.weight");
  assert.match(panel._dialog.error, /Recorder unavailable/); assert.equal(panel._busy, false);
  assert.equal(panel._dialog.completed, false); assert.equal(panel._error, "");
  fail = false; await panel._importEntityHistory("sensor.weight");
  assert.equal(panel._dialog.completed, true, "A failed import can be retried from the same popup");
  panel._closeDialog(); panel._openEntityHistoryImport("sensor.weight");
  const summary = panel._entityHistoryImportSummary({ recorder: { imported: 0 }, truncated: true });
  assert.match(summary, /keine Daten/i); assert.match(summary, /200.000|200_000|200 000/);
}

async function panelTests() {
  const panel = new Panel(); panel._hass = nativeHass(); panel._render = () => {};
  const queries = [];
  panel._hass = nativeHass({ states: {}, callWS: async (request) => {
    queries.push(request);
    if (request.type.endsWith("/list")) return { entities: [] };
    return { states: [record("live", 90, 0), record("live", 91, 1)], truncated: true };
  } });
  await panel._openEntitySamples("sensor.weight");
  const parent = panel._dialog;
  assert.equal(queries[0].limit, 100);
  assert.equal(parent.records[0].state, "91");
  parent.scroll_top = 150;
  panel._openEntitySampleEditor({ ...parent.records[0], last_updated: "2026-11-01T10:01:00.123456+00:00" });
  panel._dialog.draft.state = "89,5";
  await panel._saveEntitySample();
  const save = queries.find((query) => query.type.endsWith("sample/save"));
  assert.equal(save.state, "89.5");
  assert.equal(save.timestamp, "2026-11-01T10:01:00.123456+00:00", "Unchanged time must retain full original precision");
  assert.equal(panel._dialog, parent);
  assert.equal(panel._dialog.scroll_top, 150);
  assert.equal(parent.status, "Messwert gespeichert.");
  panel._openEntitySampleEditor();
  panel._dialog.draft.attributes = "[]";
  const before = queries.length;
  await panel._saveEntitySample();
  assert.equal(queries.length, before, "Invalid attributes must never reach the server");
  assert.match(panel._dialog.error, /JSON-Objekt/);
  panel._dialog.draft.attributes = "{}"; panel._dialog.draft.timestamp = "";
  await panel._saveEntitySample();
  assert.equal(queries.length, before);
  panel._closeDialog(); assert.equal(panel._dialog, parent);
  parent.before_id = 20; parent.from = "2026-10-01";
  await panel._loadEntitySamples(parent);
  assert.equal(queries.at(-1).before_id, 20);
  assert.ok(queries.at(-1).start_time);
  panel._hass.callWS = async (request) => {
    queries.push(request);
    return request.type.endsWith("/list") ? { entities: [] } : { states: [record("live", 90, 0, { hidden: true })], truncated: false };
  };
  parent.show_hidden = true;
  await panel._loadEntitySamples(parent);
  assert.equal(queries.at(-1).include_hidden, true);
  assert.match(panel._renderEntitySamples(), /sample-hidden/);
  panel._openEntitySampleEditor(parent.records[0]);
  assert.match(panel._renderEntitySampleEditor(), /data-hide-entity-sample/);
  assert.doesNotMatch(panel._renderEntitySampleEditor(), /data-delete-entity-sample/);
  panel._dialog.draft.hidden = false;
  await panel._saveEntitySample();
  assert.equal(queries.findLast((query) => query.type.endsWith("sample/save")).hidden, false);
  const manual = record("corrected", 92, 3, { original_source: "manual" });
  parent.records = [manual]; panel._dialog = parent;
  panel._openEntitySampleEditor(manual);
  assert.match(panel._renderEntitySampleEditor(), /data-delete-entity-sample/);
  assert.doesNotMatch(panel._renderEntitySampleEditor(), /data-hide-entity-sample/);
  const editor = panel._dialog, beforeDelete = queries.length;
  panel._openDeleteEntitySample();
  assert.match(panel._renderDeleteEntitySample(), /class="ha-button destructive"/);
  panel._closeDialog(); assert.equal(panel._dialog, editor);
  assert.equal(queries.length, beforeDelete, "Cancel must not delete anything");
  panel._openDeleteEntitySample(); await panel._deleteEntitySample();
  assert.equal(queries.findLast((query) => query.type.endsWith("sample/delete")).record_id, manual.id);
  assert.equal(panel._dialog, parent);
  assert.equal(parent.status, "Manueller Messwert gelöscht.");
  // Closing a slow list request must not reopen the dialog later.
  let resolve;
  panel._hass.callWS = () => new Promise((done) => { resolve = done; });
  const loading = panel._loadEntitySamples(parent);
  panel._closeDialog(); resolve({ states: [record("live", 1, 0)] });
  await loading; assert.equal(panel._dialog, null);
}
(async () => { chartTests(); connectionAndAggregateInfoTests(); entityManagementLayoutTests(); editorTests(); legendStorageTests(); await entityImportFlowTests(); await panelTests(); console.log("history reference layout, markers, persistent legend and measurement panel smoke tests passed"); })().catch((error) => { console.error(error); process.exitCode = 1; });
