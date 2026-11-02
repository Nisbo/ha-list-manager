/* Execute the unmodified resources against HA's native localization contract. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { nativeHass, catalog } = require("./native_translation_hass");
const frontend = path.join(__dirname, "../custom_components/ha_list_manager/frontend");
const prefix = "component.ha_list_manager.config_panel.";
const catalogs = Object.fromEntries(["de", "en"].map(language => [language, catalog(language)]));
const namespaces = new Set(Object.keys(catalogs.en).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split(".")[0]));

function resource(file) {
  const registry = new Map();
  const element = () => ({ innerHTML: "", querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, append() {}, appendChild() {}, setAttribute() {} });
  const context = vm.createContext({
    console: { info() {}, log() {}, warn() {}, error: console.error }, Date, Intl,
    HTMLElement: class { attachShadow() { return this.shadowRoot = element(); } dispatchEvent() {} },
    customElements: { get: name => registry.get(name), define: (name, ctor) => registry.set(name, ctor) },
    window: { customCards: [], setInterval: () => 0 },
    document: { createElement: element, body: { style: {} }, documentElement: { lang: "de-DE", style: {} } },
    navigator: { language: "de-DE" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const source = fs.readFileSync(path.join(frontend, file), "utf8");
  const helperName = source.match(/function (haListManager\w+Text)\(/)?.[1];
  assert.ok(helperName, `${file}: a native localization bridge exists`);
  vm.runInContext(source, context, { filename: file });
  return { source, registry, context, loadTranslations: vm.runInContext(helperName + "LoadTranslations", context), helper: vm.runInContext(helperName, context), locale: vm.runInContext(helperName + "Locale", context) };
}
const interpolate = (template, values) => template.replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
let keysChecked = 0;
const loaded = [];
for (const file of fs.readdirSync(frontend).filter(name => /^ha-list-manager-.*\.js$/.test(name))) {
  const entry = resource(file); loaded.push(entry);
  const keys = new Set([...entry.source.matchAll(/(["'])([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\1/g)].map(match => match[2]).filter(key => namespaces.has(key.split(".")[0])));
  for (const key of keys) for (const language of ["de-DE", "en-GB", "fr-FR"]) {
    const template = catalogs[language.startsWith("de") ? "de" : "en"][prefix + key];
    assert.equal(typeof template, "string", `${file}: ${key} exists`);
    const values = Object.freeze(Object.fromEntries([...template.matchAll(/\{(\w+)\}/g)].map(match => [match[1], `Milk {p0} {count} <b>ä</b> ${match[1]}`])));
    const hass = nativeHass({ language, locale: { language }, states: { "sensor.user": { name: "Getränke" } } });
    const before = JSON.stringify({ values, states: hass.states });
    assert.equal(entry.helper(key, values, hass), interpolate(template, values), `${file}: ${language}.${key}`);
    assert.equal(JSON.stringify({ values, states: hass.states }), before, "Localization leaves user data and placeholders intact");
    keysChecked++;
  }
  const calls = [], values = Object.freeze({ count: 2 });
  const result = entry.helper("ui.save", values, { localize: (key, substitutions) => { calls.push([key, substitutions]); return "Supplied by HA"; } });
  assert.equal(result, "Supplied by HA", `${file}: production delegates to hass.localize`);
  assert.equal(calls[0][0], prefix + "ui.save");
  assert.equal(calls[0][1], values, "HA receives the original placeholder object");
  assert.equal(entry.locale(nativeHass({ language: "en-GB" })), "en-GB", "Regional Intl locale is retained");
}

const flush = () => new Promise(setImmediate);
async function lifecycleTests() {
  for (const { loadTranslations } of loaded) {
    const hass = nativeHass({ language: "en-GB" });
    const requests = [];
    hass.loadBackendTranslation = async (category, integration) => {
      requests.push([category, integration]);
      if (integration) throw new Error("Temporary native category load failure");
      return hass.localize;
    };
    assert.equal(await loadTranslations(hass), hass.localize, "The native category fallback returns HA's localizer");
    assert.deepEqual(requests, [["config_panel", "ha_list_manager"], ["config_panel", undefined]],
      "A failed scoped native load retries once through HA's category loader");
  }
  for (const { registry, helper } of loaded) for (const [name, Component] of registry) {
    if (name.endsWith("-editor")) continue; // Editor form persistence is tested in localization_workflows_smoke.
    const component = new Component();
    component._config = { ...(Component.getStubConfig?.() || {}), list_id: "test", entity: "sensor.weight" };
    component._list = { id: "test", name: "User title" };
    let renders = 0;
    component._render = () => { renders++; };
    for (const method of ["_load", "_subscribe", "_scheduleLoad", "_ensureLoaded", "_ensureLovelaceSubscription", "_ensureItemsSubscription"]) component[method] = () => {};
    const german = nativeHass({ language: "de-DE", states: {} });
    component.hass = german;
    await flush();
    assert.equal(german.translationCalls.length, 1, `${name}: load the native integration category on first hass`);
    const first = renders;
    for (let update = 0; update < 5; update++) component.hass = { ...german, states: {} };
    await flush();
    assert.equal(renders, first, `${name}: ordinary HA updates do not redraw or move the scroller`);
    assert.equal(german.translationCalls.length, 1, `${name}: unchanged language does not request translations again`);
    const english = nativeHass({ language: "en-GB", states: {} });
    component.hass = english;
    await flush();
    assert.equal(english.translationCalls.length, 1, `${name}: language switch loads the selected language`);
    assert.ok(renders > first, `${name}: language switch updates visible text`);
    assert.equal(helper("ui.save", {}, component._hass), "Save");
    const afterSwitch = renders;
    for (let update = 0; update < 5; update++) component.hass = { ...english, states: {} };
    await flush();
    assert.equal(renders, afterSwitch, `${name}: translated steady state stays mounted`);

    // A pending request from the former language must not redraw or replace the
    // selected language. Native HA publishes current resources on a new hass.
    const old = nativeHass({ language: "de-DE", states: {} });
    let finishOld;
    old.localize = () => "";
    old.loadBackendTranslation = () => new Promise(resolve => { finishOld = resolve; });
    component.hass = old;
    const current = nativeHass({ language: "en-GB", states: {} });
    component.hass = current;
    await flush();
    const beforeStale = renders;
    finishOld(nativeHass({ language: "de-DE" }).localize);
    await flush();
    assert.equal(helper("ui.save", {}, component._hass), "Save", `${name}: stale request cannot restore German`);
    assert.equal(renders, beforeStale, `${name}: stale completion causes no extra redraw`);

    // HA replaces hass.localize while publishing fetched resources, before the
    // loader promise settles. Use the latest hass rather than its old closure.
    const delayed = nativeHass({ language: "de-DE", states: {} });
    delayed.localize = current.localize; // stale English resources while loading
    let finishDelayed;
    delayed.loadBackendTranslation = () => new Promise(resolve => { finishDelayed = resolve; });
    const beforeDelayed = renders;
    component.hass = delayed;
    await flush();
    assert.equal(renders, beforeDelayed, `${name}: old English resources are not rendered as German`);
    const translated = { ...delayed, localize: nativeHass({ language: "de-DE" }).localize };
    component.hass = translated;
    finishDelayed(translated.localize);
    await flush();
    assert.equal(helper("ui.save", {}, component._hass), "Speichern", `${name}: latest native resources become visible`);
    assert.equal(renders, beforeDelayed + 1, `${name}: completion updates the component exactly once`);

    const disconnected = nativeHass({ language: "en-GB", states: {} });
    disconnected.localize = () => "";
    disconnected.loadBackendTranslation = async () => { throw new Error("HA reconnecting"); };
    component.hass = disconnected;
    await flush();
    const beforeRecovery = renders;
    component.hass = { ...disconnected, localize: nativeHass({ language: "en-GB" }).localize };
    await flush();
    assert.equal(helper("ui.save", {}, component._hass), "Save", `${name}: a later native resource update repairs a failed initial load`);
    assert.equal(renders, beforeRecovery + 1, `${name}: reconnect resource publication renders once`);


  }
}
lifecycleTests().then(() => console.log(`Native HA localization verified: ${keysChecked} lookups, language switches, pending-load races and stable scroll rendering`)).catch(error => { console.error(error); process.exitCode = 1; });
