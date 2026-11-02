/* Static regression test for the shared list appearance controls. */
const fs = require("fs");
const localizedSource = require("./localization_source");

const paths = process.argv.slice(2);
if (paths.length !== 3) throw new Error("Expected inventory, shopping and todo card paths");

for (const path of paths) {
  const source = localizedSource(fs.readFileSync(path, "utf8"));
  for (const required of [
    'label: "Listendarstellung"',
    'name: "show_item_dividers"',
    'name: "item_divider_before_spacing"',
    'name: "item_divider_after_spacing"',
    'name: "item_font_size"',
    'name: "category_font_scale"',
    'show_item_dividers: true',
    'item_font_size: 16',
    'category_font_scale: 110',
    '--ha-list-manager-item-font-size:',
    '--ha-list-manager-secondary-font-size:',
    '--ha-list-manager-tertiary-font-size:',
    '--ha-list-manager-category-font-size:',
    '--ha-list-manager-item-divider-before-spacing:',
    '--ha-list-manager-item-divider-after-spacing:',
    'item-dividers',
    '--ha-list-manager-category-secondary-font-size:',
    '--ha-list-manager-category-icon-size:',
    'normalizeAppearanceNumber',
  ]) {
    if (!source.includes(required)) throw new Error(`${path} lacks list appearance behavior: ${required}`);
  }
  if (!source.includes('const categorySecondaryFontSize = Math.max(9, itemFontSize - 3);')) throw new Error(`${path} category secondary text must follow the general item size`);
  if (!source.includes('const categoryIconSize = Math.max(18, itemFontSize * 1.25);')) throw new Error(`${path} category icons must follow the general item size`);
  if (source.includes('const categorySecondaryFontSize = Math.max(9, categoryFontSize - 3);')) throw new Error(`${path} category secondary text must not follow the category-name multiplier`);
  for (const removed of ['item_divider_position', 'item-divider-center', 'item-divider-bottom', 'item_divider_offset', 'item_row_spacing', '--ha-list-manager-item-divider-offset', '--ha-list-manager-item-row-spacing']) {
    if (source.includes(removed)) throw new Error(`${path} still contains obsolete divider setting: ${removed}`);
  }
  if (!source.includes('item_divider_before_spacing: "Abstand oberhalb der Trennlinie"')) throw new Error(`${path} does not label the space above the divider clearly`);
  if (!source.includes('item_divider_after_spacing: "Abstand unterhalb der Trennlinie"')) throw new Error(`${path} does not label the space below the divider clearly`);
  if (!source.includes('item_divider_before_spacing: 10') || !source.includes('item_divider_after_spacing: 10')) throw new Error(`${path} divider spacing does not default to 10 px above and below`);
  if (source.includes('--ha-list-manager-item-row-gap:') || source.includes('const itemRowGap = dividerBeforeSpacing + dividerAfterSpacing')) throw new Error(`${path} still uses the obsolete external row-gap calculation`);
}

const [inventory, shopping, todo] = paths.map((path) => localizedSource(fs.readFileSync(path, "utf8")));
if (!todo.includes('--ha-list-manager-category-large-icon-size:') || !todo.includes('var(--ha-list-manager-category-large-icon-size)')) throw new Error("Todo large category icons are not relative");
if (!shopping.includes('Standard sind 10 px. Auch bei ausgeblendeten Trennlinien bleibt dieser Abstand erhalten.')) throw new Error("Shopping spacing help does not explain its default and hidden-divider behavior");
if (!shopping.includes('Standard sind 10 px. Bei ausgeblendeten Trennlinien bilden beide Werte zusammen den Abstand zwischen den Artikeln.')) throw new Error("Shopping spacing help does not explain the combined hidden-divider gap");
if (shopping.includes('.field-grid,.bring-detail-fields')) throw new Error("Shopping card still contains the unused legacy field-grid selector");
if (!inventory.includes('.entry-title{font-size:var(--ha-list-manager-item-font-size);line-height:1}')) throw new Error("Inventory item font is not configurable with a content-tight line box");
if (!inventory.includes('.category-header strong{font-size:var(--ha-list-manager-category-font-size)}')) throw new Error("Inventory category font is not relative");
if (!inventory.includes('.category-header{display:flex;align-items:center;gap:8px;width:100%;min-height:37px;padding:5px 12px')) throw new Error("Inventory category rows do not use the shared height and vertical padding");
if (!inventory.includes('.category-header>ha-icon{--mdc-icon-size:var(--ha-list-manager-category-icon-size)}')) throw new Error("Inventory category icons are not relative");
if (!inventory.includes('.entry{display:grid;align-items:center;padding:0 8px 0 4px')) throw new Error("Inventory rows do not size themselves from their visible content");
if (!inventory.includes('.category-header+.entry,.entry+.entry{padding-top:var(--ha-list-manager-item-divider-after-spacing)}')) throw new Error("Inventory rows do not apply the space below category rows and preceding dividers");
if (!inventory.includes('.entry:not(:last-child){padding-bottom:var(--ha-list-manager-item-divider-before-spacing)}')) throw new Error("Inventory rows do not apply the space above a following divider inside the row");
if (!inventory.includes('.item-dividers .entry:not(:last-child){padding-bottom:calc(var(--ha-list-manager-item-divider-before-spacing) + 1px)}')) throw new Error("Inventory rows do not reserve one pixel for a visible divider");
if (!inventory.includes('.item-dividers .entry:not(:last-child)::after{content:"";position:absolute;z-index:1;left:8px;right:8px;bottom:0')) throw new Error("Inventory divider is not anchored to its reserved pixel at the row bottom");
if (!inventory.includes('.entry-main{display:flex;flex-direction:column;align-items:flex-start;align-self:center;gap:4px;min-width:0;padding:0 8px')) throw new Error("Inventory text is not vertically centered in the visible row envelope");
if (!inventory.includes('.product-image{display:grid;place-items:center;align-self:center;')) throw new Error("Inventory images are not vertically centered in their rows");
if (!shopping.includes('.item-name{font-size:var(--ha-list-manager-item-font-size);line-height:1}')) throw new Error("Shopping item font is not configurable with a content-tight line box");
if (!shopping.includes('.meta{color:var(--secondary-text-color);font-size:var(--ha-list-manager-secondary-font-size);line-height:1}')) throw new Error("Shopping item metadata does not use a content-tight line box");
if (!shopping.includes('.category-header strong{font-size:var(--ha-list-manager-category-font-size)}')) throw new Error("Shopping category font is not relative");
if (!shopping.includes('.category-header{display:flex;align-items:center;gap:6px;width:100%;min-height:37px;padding:5px 8px')) throw new Error("Shopping category rows do not use the shared height and vertical padding");
if (!shopping.includes('.category-header .count{margin-left:2px;font-size:var(--ha-list-manager-category-secondary-font-size)')) throw new Error("Shopping category count is not relative");
if (!shopping.includes('--ha-list-manager-item-divider-after-spacing:')) throw new Error("Shopping card lacks the spacing variable below dividers");
if (!shopping.includes('.item{display:grid;align-items:center;padding:0 4px')) throw new Error("Shopping rows do not size themselves from their visible content");
if (shopping.includes('.item{display:grid;align-items:center;min-height:42px')) throw new Error("Shopping rows still impose a fixed minimum height");
if (!shopping.includes('.category-header+.item,.item+.item{padding-top:var(--ha-list-manager-item-divider-after-spacing)}')) throw new Error("Shopping rows do not apply the space below category rows and preceding dividers");
if (!shopping.includes('.item:not(:last-child){padding-bottom:var(--ha-list-manager-item-divider-before-spacing)}')) throw new Error("Shopping rows do not apply the space above a following divider inside the row");
if (!shopping.includes('.item-dividers .item:not(:last-child){padding-bottom:calc(var(--ha-list-manager-item-divider-before-spacing) + 1px)}')) throw new Error("Shopping rows do not reserve one pixel for a visible divider");
if (!shopping.includes('.item-dividers .item:not(:last-child)::after{content:"";position:absolute;z-index:1;left:4px;right:4px;bottom:0')) throw new Error("Shopping divider is not anchored to its reserved pixel at the row bottom");
if (!shopping.includes('.item-main{display:flex;flex-direction:column;align-items:flex-start;align-self:center;gap:2px;min-width:0;padding:0 6px')) throw new Error("Shopping text is not vertically centered in the visible row envelope");
if (!shopping.includes('.item-image{align-self:center;width:42px;height:42px')) throw new Error("Shopping images are not vertically centered in their rows");
if (!/\.label\{(?=[^}]*font-size:var\(--ha-list-manager-tertiary-font-size\))(?=[^}]*line-height:1(?:;|}))/s.test(shopping)) throw new Error("Shopping labels do not use a content-tight line box");
if (!todo.includes('.item-main strong{overflow:hidden;font-size:var(--ha-list-manager-item-font-size);font-weight:500;line-height:1')) throw new Error("Todo item font is not configurable with a content-tight line box");
if (!todo.includes('.category-title strong{font-size:var(--ha-list-manager-category-font-size)}')) throw new Error("Todo category font is not relative");
if (!todo.includes('.category-title small{display:flex;align-items:center;gap:3px;color:var(--secondary-text-color);font-size:var(--ha-list-manager-category-secondary-font-size)}')) throw new Error("Todo category due date is not relative");
if (!todo.includes('.count{color:var(--secondary-text-color);font-size:var(--ha-list-manager-category-secondary-font-size)}')) throw new Error("Todo category count is not relative");
if (!todo.includes('.items{display:grid;gap:0;padding:0 6px 0 8px}')) throw new Error("Todo rows still use an external grid gap");
if (!todo.includes('.items>.item:first-child,.item+.item{padding-top:var(--ha-list-manager-item-divider-after-spacing)}')) throw new Error("Todo rows do not apply the space below category rows and preceding dividers");
if (!todo.includes('.item:not(:last-child){padding-bottom:var(--ha-list-manager-item-divider-before-spacing)}')) throw new Error("Todo rows do not apply the space above a following divider inside the row");
if (!todo.includes('.item-dividers .item:not(:last-child){padding-bottom:calc(var(--ha-list-manager-item-divider-before-spacing) + 1px)}')) throw new Error("Todo rows do not reserve one pixel for a visible divider");
if (!todo.includes('.item-dividers .item:not(:last-child)::after{content:"";position:absolute;z-index:1;left:0;right:0;bottom:0')) throw new Error("Todo divider is not anchored to its reserved pixel at the row bottom");
if (!todo.includes('.item-main{display:flex;flex-direction:column;align-items:stretch;align-self:center;gap:1px;min-width:0;padding:0')) throw new Error("Todo text is not vertically centered in the visible row envelope");
if (todo.includes('dividerCenterOffset')) throw new Error("Todo divider still contains calculated positioning logic");

console.log("shared list appearance controls smoke test passed");
