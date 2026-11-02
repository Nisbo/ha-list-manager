/* Run from either a standalone checkout or the development workspace. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const tests = path.join(root, "tests");
const frontend = path.join(root, "custom_components", "ha_list_manager", "frontend");
const resource = name => path.join(frontend, `ha-list-manager-${name}.js`);
const inventory = resource("inventory-card");
const shopping = resource("shopping-card");
const todo = resource("todo-card");
const history = resource("history-card");
const panel = resource("panel");

// Older harnesses receive production resources explicitly. New self-contained
// harnesses resolve resources relative to their own location.
const argumentsByTest = {
  "history_card_data_smoke.js": [history],
  "history_card_decimal_smoke.js": [history],
  "inventory_card_chip_smoke.js": [inventory],
  "inventory_restock_dialog_smoke.js": [inventory],
  "list_appearance_options_smoke.js": [inventory, shopping, todo],
  "panel_lifecycle_smoke.js": [panel],
  "pdf_export_card_smoke.js": [shopping, inventory, resource("pdf-export")],
  "picker_list_trigger_smoke.js": [panel, inventory, shopping, todo],
  "shopping_card_product_category_smoke.js": [shopping],
  "shopping_product_category_move_smoke.js": [shopping],
  "tandoor_preparation_smoke.js": [shopping],
  "todo_card_load_race_smoke.js": [todo],
  "todo_card_scroll_smoke.js": [todo],
  "todo_card_share_pdf_smoke.js": [todo],
};

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: "inherit", timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of fs.readdirSync(frontend).filter(name => name.endsWith(".js")).sort()) {
  run(["--check", path.join(frontend, file)]);
}
const harnesses = fs.readdirSync(tests).filter(name => name.endsWith("_smoke.js")).sort();
for (const file of harnesses) run([path.join(tests, file), ...(argumentsByTest[file] || [])]);
console.log(`Frontend syntax and ${harnesses.length} regression harnesses passed.`);
