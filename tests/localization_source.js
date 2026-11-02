/* Resolve only static text references for layout/wiring source inspections.
 * Runtime smoke tests must still execute the original, unmodified source. */
const { catalog } = require('./native_translation_hass');
const prefix = 'component.ha_list_manager.config_panel.';
const messages = Object.fromEntries(Object.entries(catalog('de')).filter(([key]) => key.startsWith(prefix)).map(([key, text]) => [key.slice(prefix.length), text]));
// Only empty parameter objects are safe to resolve. Language context does not
// change these German source inspections, but user interpolation must survive.
const call = String.raw`haListManager\w+Text\(\s*["']([^"'\n]+)["']\s*(?:,\s*\{\s*\}\s*(?:,\s*(?:this\._hass|hass|undefined|language|null)\s*)?)?\)`;
module.exports = source => source
  .replace(new RegExp(String.raw`\$\{\s*${call}\s*\}`, 'g'), (_, key) => messages[key])
  .replace(new RegExp(call, 'g'), (_, key) => JSON.stringify(messages[key]));
