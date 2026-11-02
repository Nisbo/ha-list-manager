const { nativeHass } = require("./native_translation_hass");
/* Exercise production history loading and SVG output without a HA installation. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const registry = new Map();
const timers = new Map();
let timerId = 0;
const schedule = (callback) => { timers.set(++timerId, callback); return timerId; };
const cancel = (id) => timers.delete(id);
const context = vm.createContext({
  HTMLElement: class {
    attachShadow() {
      return this.shadowRoot = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    }
    dispatchEvent() {}
  },
  CustomEvent: class {},
  customElements: { get: (name) => registry.get(name), define: (name, ctor) => registry.set(name, ctor) },
  document: { body: { style: {} }, documentElement: { style: {} } },
  window: { customCards: [], setTimeout: schedule, setInterval: () => 0 },
  clearTimeout: cancel, clearInterval: () => {},
  ResizeObserver: class { observe() {} disconnect() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), context);
const Card = registry.get("ha-list-manager-history-card");
const record = (state, minute = "00") => ({ state, attributes: {}, last_updated: `2026-11-01T10:${minute}:00+00:00` });
function harness(entity = "sensor.old") {
  timers.clear();
  const card = new Card(); card._hass = nativeHass();
  const calls = [];
  card._hass = nativeHass({
    states: {}, locale: { language: "de" },
    callWS: (query) => new Promise((resolve, reject) => calls.push({ query, resolve, reject })),
  });
  card.setConfig({ entity, values_to_show: 1 });
  return { card, calls };
}
function runScheduled() {
  assert.equal(timers.size, 1, "A single immediate follow-up must be scheduled");
  const callback = [...timers.values()][0];
  timers.clear();
  return callback();
}
async function loadingTests() {
  for (const [config, result, warning] of [
    [{ values_to_show: 30 }, { truncated: true }, false],
    [{ values_to_show: 30, min_value: 50 }, { truncated: true }, false],
    [{ values_to_show: 30 }, { truncated: true, query_limited: true }, true],
    [{ hours_to_show: 24 }, { truncated: true }, true],
    [{ values_to_show: 25000 }, { truncated: true }, true],
  ]) {
    const { card, calls } = harness();
    card.setConfig({ entity: "sensor.weight", ...config });
    const load = runScheduled();
    calls[0].resolve({ states: [record("90")], ...result });
    await load;
    assert.equal(card._truncated, warning, "Only technical query limits should warn");
  }
  {
    const { card, calls } = harness();
    const oldLoad = runScheduled();
    card.setConfig({ entity: "sensor.new", values_to_show: 1 });
    await runScheduled(); // A new config arrives while the old request is pending.
    calls[0].resolve({ states: [record("99")], truncated: true });
    await oldLoad;
    assert.equal(card._seriesData.length, 0, "Old results must never be displayed under the new entity");
    assert.equal(card._truncated, false);
    const newLoad = runScheduled();
    assert.equal(calls[1].query.entity_id, "sensor.new");
    calls[1].resolve({ states: [record("21")] });
    await newLoad;
    assert.equal(card._seriesData[0].entity, "sensor.new");
    assert.equal(card._states[0].state, "21");
    assert.equal(timers.size, 0);
  }
  {
    const { card, calls } = harness();
    const load = runScheduled();
    await card._load(); // Live change while the same entity is loading.
    calls[0].resolve({ states: [record("20")] });
    await load;
    const refresh = runScheduled();
    calls[1].resolve({ states: [record("21", "01")] });
    await refresh;
    assert.equal(card._states[0].state, "21", "A busy request must not discard the next update");
  }
  {
    const { card, calls } = harness();
    const load = runScheduled();
    card.setConfig({ entity: "sensor.new" });
    calls[0].reject(new Error("old source failed"));
    await load;
    assert.equal(card._error, "", "Stale errors must not be attached to another entity");
    card.disconnectedCallback();
    assert.equal(timers.size, 0);
  }
  {
    const { card, calls } = harness();
    const load = runScheduled();
    card.disconnectedCallback();
    calls[0].resolve({ states: [record("20")] });
    await load;
    assert.equal(card._states.length, 0);
    assert.equal(timers.size, 0, "Disconnected cards must not keep refreshing");
    card.connectedCallback();
    const reconnect = runScheduled();
    calls[1].resolve({ states: [record("21")] });
    await reconnect;
    assert.equal(card._states[0].state, "21");
  }
}
function displayTests() {
  const { card } = harness();
  const series = { ...card._seriesConfigs()[0], color: "#123456", states: [record("20")] };
  const single = card._renderChart([series]);
  assert.match(single, /<circle cx="424" cy="[\d.]+" r="5" fill="#123456"/);
  assert.doesNotMatch(single, /NaN|Infinity|<path/);
  const categorical = card._renderChart([{ ...series, states: [record("on")] }]);
  assert.match(categorical, /<circle cx="424"/);
  assert.doesNotMatch(categorical, /NaN|Infinity/);
  const multiple = { ...series, states: [record("20"), record("21", "01")] };
  const chart = card._renderChart([multiple]);
  assert.match(chart, /<path d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+" class="line"/);
  assert.equal((chart.match(/<circle/g) || []).length, 2, "Ordinary measurements must have visible circle markers");
  const mixed = card._renderChart([multiple, { ...series, color: "#abcdef" }]);
  assert.match(mixed, /<path/);
  assert.match(mixed, /<circle.*fill="#abcdef"/);
  const steps = card._renderChart([{ ...series, states: [record("on"), record("off", "01")] }]);
  assert.match(steps, /<path d="M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+"/);
  card._seriesData = [series];
  for (const view of ["chart", "list"]) {
    card._activeView = view;
    card._truncated = true;
    card._render();
    assert.match(card.shadowRoot.innerHTML, /class="history-limit-notice" role="status"/);
    assert.match(card.shadowRoot.innerHTML, /Technische Abfragegrenze erreicht/);
    card._truncated = false;
    card._render();
    assert.doesNotMatch(card.shadowRoot.innerHTML, /class="history-limit-notice"/);
  }
  card._truncated = true;
  card.setConfig({ entity: "sensor.new" });
  assert.equal(card._truncated, false, "A new selection must not inherit the old limit warning");
}
(async () => {
  await loadingTests();
  displayTests();
  console.log("history card loading, limit warning and SVG regressions passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
