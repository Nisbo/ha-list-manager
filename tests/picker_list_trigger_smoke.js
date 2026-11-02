/* Static regression test for keyboard-closing category and label list triggers. */
const fs = require("fs");
const localizedSource = require("./localization_source");
for (const path of process.argv.slice(2)) {
  const source = localizedSource(fs.readFileSync(path, "utf8"));
  for (const required of [
    "_installPickerListTriggers(root = this.shadowRoot)",
    "data-picker-list-trigger",
    "Auswahl öffnen und Tastatur schließen",
    "if (!menu.hidden)",
    'input.value = ""',
    'input.dispatchEvent(new Event("focus"))',
    'button.classList.toggle("picker-current"',
    'menu.querySelector(".picker-current")?.scrollIntoView',
    'root.querySelectorAll(menuSelector).forEach',
    ".picker-trigger-host input{padding-right:44px!important}",
    ".picker-current{",
  ]) {
    if (!source.includes(required)) throw new Error(`${path} lacks picker trigger behavior: ${required}`);
  }
  if (!source.includes("this._installPickerListTriggers")) throw new Error(`${path} does not install picker triggers`);
}
console.log("category and label picker trigger smoke test passed");
