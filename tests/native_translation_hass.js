/* Test-only Home Assistant translation fixtures. Production uses HA's loader. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const directory = path.join(__dirname, "../custom_components/ha_list_manager/translations");

function flatten(value, prefix = "", result = {}) {
  for (const [key, entry] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") result[full] = entry;
    else flatten(entry, full, result);
  }
  return result;
}
function catalog(language) {
  return flatten(JSON.parse(fs.readFileSync(path.join(directory, `${language}.json`), "utf8")), "component.ha_list_manager");
}
function localizer(language) {
  const english = catalog("en");
  const requested = String(language).toLowerCase().split("-")[0];
  const entries = requested === "de" ? { ...english, ...catalog("de") } : english;
  return (key, values = {}) => (entries[key] || "").replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
}
function nativeHass(options = {}) {
  const language = options.language || options.locale?.language || "de-DE";
  const hass = { locale: { language }, language, connection: {}, ...options };
  hass.localize = localizer(language);
  hass.translationCalls = [];
  hass.loadBackendTranslation = async (category, integration) => {
    assert.equal(category, "config_panel");
    assert.equal(integration, "ha_list_manager");
    hass.translationCalls.push({ category, integration });
    return hass.localize;
  };
  return hass;
}
module.exports = { nativeHass, localizer, catalog, flatten };
