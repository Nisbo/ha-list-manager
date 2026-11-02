/* Native catalog structure, placeholders and every frontend reference agree. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { catalog } = require("./native_translation_hass");
const base = path.join(__dirname, "../custom_components/ha_list_manager");
const prefix = "component.ha_list_manager.config_panel.";
const catalogs = Object.fromEntries(["de", "en"].map(language => [language, catalog(language)]));
assert.deepEqual(Object.keys(catalogs.de).sort(), Object.keys(catalogs.en).sort(), "Every native translation key is available in German and English");
for (const key of Object.keys(catalogs.en)) {
  for (const language of ["de", "en"]) {
    const text = catalogs[language][key];
    assert.equal(text, text.trim(), `${language}.${key}: HA requires trimmed translation values`);
    assert.doesNotMatch(text, /<\/?[a-z][^>]*>/i, `${language}.${key}: native catalogs contain text, not HTML markup`);
  }
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  assert.deepEqual(placeholders(catalogs.de[key]), placeholders(catalogs.en[key]), `${key}: placeholder compatibility`);
  assert.ok(!key.includes("[%key:"), "Custom integrations must ship finished translations");
}
const messages = Object.fromEntries(Object.entries(catalogs.de).filter(([key]) => key.startsWith(prefix)).map(([key, text]) => [key.slice(prefix.length), text]));
const namespaces = new Set(Object.keys(messages).map(key => key.split(".")[0]));
let references = 0, resources = 0;
for (const name of fs.readdirSync(path.join(base, "frontend")).filter(name => /^ha-list-manager-.*\.js$/.test(name))) {
  const source = fs.readFileSync(path.join(base, "frontend", name), "utf8");
  assert.doesNotMatch(source, /GENERATED LOCALIZED TEXTS|TextMessages\s*=|localization\/.*\.json/, `${name}: no private or embedded catalog`);
  assert.match(source, /\.localize\??\.?\(/, `${name}: HA supplies localized text`);
  const keys = new Set([...source.matchAll(/(["'])([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\1/g)].map(match => match[2]).filter(key => namespaces.has(key.split(".")[0])));
  for (const key of keys) {
    for (const language of ["de", "en"]) assert.equal(typeof catalogs[language][prefix + key], "string", `${name}: ${language}.${key}`);
    references++;
  }
  resources++;
}
const staticSource = require("./localization_source");
for (const context of ["this._hass", "hass", "undefined", "language"]) {
  assert.equal(staticSource(`haListManagerTestText("ui.cancel", {}, ${context})`), JSON.stringify(messages["ui.cancel"]));
  assert.equal(staticSource('${haListManagerTestText("ui.cancel", {}, ' + context + ')}'), messages["ui.cancel"]);
}
const dynamic = 'haListManagerTestText("ui.cancel", {p0: user.name}, this._hass)';
assert.equal(staticSource(dynamic), dynamic, "Source inspection leaves user interpolation untouched");
assert.equal(fs.existsSync(path.join(base, "localization")), false, "Old private catalogs have been removed");
assert.equal(fs.existsSync(path.join(base, "../../tools/build_frontend_localization.py")), false, "No translation build generator remains");
console.log(`Native English/German catalogs cover ${references} references in ${resources} frontend resources`);
