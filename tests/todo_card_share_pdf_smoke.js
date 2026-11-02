const { nativeHass } = require("./native_translation_hass");
/* Browser-independent smoke test for Todo sharing and PDF data. */
const fs = require("fs");
const vm = require("vm");

const registry = new Map();
class HTMLElement {
  attachShadow() {
    this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [], innerHTML: "" };
    return this.shadowRoot;
  }
  dispatchEvent() {}
}
const localValues = new Map();
const context = vm.createContext({
  console, setTimeout, clearTimeout, HTMLElement, CustomEvent: class {},
  ResizeObserver: class { observe() {} disconnect() {} },
  customElements: { get: (name) => registry.get(name), define: (name, constructor) => registry.set(name, constructor) },
  document: { createElement: () => ({ addEventListener: () => {} }), head: { appendChild: () => {} }, body: { style: {} }, documentElement: { style: {} } },
  window: { customCards: [], scrollX: 0, scrollY: 0, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } }, localStorage: { getItem: (key) => localValues.get(key) ?? null, setItem: (key, value) => localValues.set(key, String(value)), removeItem: (key) => localValues.delete(key) },
  navigator: { language: "de-DE" },
});
const cardPath = process.argv[2];
vm.runInContext(fs.readFileSync(cardPath, "utf8"), context, { filename: cardPath });
const TodoCard = registry.get("ha-list-manager-todo-card");
const card = new TodoCard(); card._hass = nativeHass();
card._config = { ...TodoCard.getStubConfig(), show_share_button: true, show_pdf_export_button: true };
card._hass = nativeHass({ locale: { language: "de" } });
card._list = { id: "todo", name: "Aufgaben", list_type: "todo" };
card._categories = [{ id: "home", name: "Haushalt", color: "#123456", scope: "list", position: 0 }];
card._labels = [{ id: "urgent", name: "Dringend" }];
card._chips = [{ id: "chip", name: "Gelbe Tonne", chip_kind: "todo_template", icon: "mdi:trash-can-outline", color: "#ffaa00", template_data: { item_name: "Tonne rausstellen", category_id: "home", label_ids: ["urgent"], due_mode: "tomorrow", due_time: "18:00", recurrence_interval: 14, recurrence_unit: "D", add_mode: "direct" } }];
card._items = [{
  id: "one", name: "Müll rausbringen", description: "Gelbe Tonne", completed: false,
  category_id: "home", due_at: "2000-01-01", recurrence_interval: 7, recurrence_unit: "D", position: 0,
}];
const item = card._pdfSections()[0]?.items[0];
if (!item || item.badge || item.leadingRows.length !== 1 || item.leadingRows[0].tone !== "error" || item.detailRows[0]?.text !== "Gelbe Tonne" || !item.detailRows.some((row) => row.text.includes("Alle 7 Tage"))) throw new Error("Todo PDF columns or details missing");
const timedDueRows = card._pdfDueColumn({ due_at: "2000-01-01T12:34:00", completed: false }, "Überfällig");
if (timedDueRows.length !== 2 || !timedDueRows[0].text.includes("2000") || !timedDueRows[1].text.includes("12:34") || timedDueRows.some((row) => row.tone !== "error")) throw new Error("Timed Todo due date is not split into two red PDF column rows");
const schema = TodoCard.getConfigForm().schema.flatMap((entry) => entry.schema || [entry]);
if (!schema.some((entry) => entry.name === "show_share_button") || !schema.some((entry) => entry.name === "show_pdf_export_button") || !schema.some((entry) => entry.name === "show_chips") || !schema.some((entry) => entry.name === "filter_chips") || !schema.some((entry) => entry.name === "chips_position") || !schema.some((entry) => entry.name === "option_row_position") || !schema.some((entry) => entry.name === "show_category_toggle_button")) throw new Error("Todo action or template editor options missing");
const templateValues = card._templateValues(card._chips[0]);
if (templateValues.name !== "Tonne rausstellen" || templateValues.category_id !== "home" || templateValues.label_ids[0] !== "urgent" || !templateValues.due_at.includes("T18:00:00") || templateValues.recurrence_interval !== 14) throw new Error("Todo template values are incomplete");
if (!card._chipsHtml().includes('data-todo-chip="chip"') || !card._chipsHtml().includes("mdi:trash-can-outline")) throw new Error("Todo template chips are not rendered");
card._importantChipKeys = new Set(["chip:chip"]);
card._config.category_chip_layout = "stacked";
if (!card._chipsHtml().includes("Wichtig") || !card._chipsHtml().includes("Haushalt") || !card._chipsHtml().includes("todo-chip-category-head")) throw new Error("Todo importance or category groups are not rendered");
if (!card._chipsHtml().includes("data-toggle-chip-categories")) throw new Error("Categorized Todo templates have no all-category counter toggle");
const todoRender = card._render;
card._render = () => {};
card._toggleAllChipCategories();
if (!card._chipsHtml().includes('aria-label="Alle Kategorien einklappen"') || (card._chipsHtml().match(/data-todo-chip="chip"/g) || []).length !== 2) throw new Error("Todo template counter did not open every category");
card._toggleAllChipCategories();
if (card._chipsHtml().includes('data-todo-chip="chip"')) throw new Error("Todo template counter did not close every category");
card._render = todoRender;
let optionMarkup = card._optionsHtml();
if (!optionMarkup.includes("data-toggle-categories") || !optionMarkup.includes("Alle Kategorien einklappen") || !optionMarkup.includes("Erledigte löschen") || !optionMarkup.includes('icon="mdi:delete-sweep-outline"')) throw new Error("Todo button bar is incomplete or uses an inconsistent delete icon");
card._config.show_category_toggle_button = false;
if (card._optionsHtml().includes("data-toggle-categories")) throw new Error("Disabled Todo category toggle remained visible");
card._config.show_category_toggle_button = true;
let categoryToggleRenderCount = 0;
card._render = () => { categoryToggleRenderCount += 1; };
card._toggleAllCategories();
if (card._allCategoriesExpanded()) throw new Error("Todo button bar did not collapse every item category");
card._toggleAllCategories();
if (!card._allCategoriesExpanded()) throw new Error("Todo button bar did not expand every item category");
if (categoryToggleRenderCount !== 0) throw new Error("Todo category toggle rerendered the card and can reset mobile scrolling");
card._render = todoRender;
localValues.set(card._filterKey(), "overdue");
optionMarkup = card._optionsHtml();
if (!optionMarkup.includes('class="active"') || !optionMarkup.includes("Überfällig")) throw new Error("Active Todo filter is not highlighted in the button bar");
localValues.delete(card._filterKey());
card._input = "gelbe";
if (card._filteredChips().length !== 1 || !card._chipsHtml().includes("Gelbe Tonne")) throw new Error("Todo templates are not filtered by the input");
card._input = "windows";
if (card._filteredChips().length || !card._chipsHtml().includes("Keine passenden Vorlagen")) throw new Error("Todo template empty filter result is missing");
card._input = "";
if (!card._inputHtml().includes("data-open-chip-dialog")) throw new Error("Todo template input button is missing");
card._confirmation = { type: "share", profiles: [{ id: "phone", name: "Telefon" }], selectedIds: ["phone"] };
if (!card._confirmationHtml().includes("Liste senden?") || !card._confirmationHtml().includes("Telefon")) throw new Error("Todo share confirmation missing");
const styles = card._styles();
if (!styles.includes(".compact-actions-menu") || !styles.includes(".title-actions-wide{display:none}") || !styles.includes(".option-row button:not(:disabled):hover") || !styles.includes(".option-row button.active") || !styles.includes(".option-row button{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;min-height:38px;padding:0;gap:0;border-radius:9px}") || !styles.includes(".option-row button>span{display:none}")) throw new Error("Todo compact, hover or active button bar styling missing");
if (!styles.includes(".todo-chip:hover") || !styles.includes(".todo-chip.colored:hover")) throw new Error("Todo template hover styling missing");
const labelStyles = card._labelStyles();
if (!labelStyles.includes(".todo-chip-category-head:hover") || !labelStyles.includes(".todo-chip-category-selector:hover")) throw new Error("Todo template category hover styling missing");
let appendedFilterPortal = null;
let removedFilterPortal = false;
const filterPortalRoot = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
context.document.createElement = () => ({
  style: {},
  setAttribute: () => {},
  attachShadow: () => filterPortalRoot,
  remove: () => { removedFilterPortal = true; },
});
context.document.body.appendChild = (portal) => { appendedFilterPortal = portal; };
context.requestAnimationFrame = (callback) => { callback(); return 1; };
context.cancelAnimationFrame = () => {};
context.window.scrollTo(7, 420);
context.document.body.style.overflow = "auto";
card._lock();
if (!card._scrollLocked || context.document.body.style.overflow !== "hidden" || context.window.scrollY !== 420) throw new Error("Todo dialog scroll lock differs from the stable shopping-card behavior");
card._lock();
if (card._oldOverflow !== "auto") throw new Error("Nested Todo dialog scroll lock replaced the original overflow state");
card._unlock();
if (card._scrollLocked || context.document.body.style.overflow !== "auto" || context.window.scrollX !== 7 || context.window.scrollY !== 420) throw new Error("Todo dialog scroll unlock changed the mobile page position");
let filterPortalRenderCount = 0;
card._render = () => { filterPortalRenderCount += 1; };
card._openFilterPortal();
if (!appendedFilterPortal || card._filterPortal !== appendedFilterPortal || filterPortalRenderCount !== 0) throw new Error("Opening the Todo filter portal changed the card layout");
card._closeFilterPortal(false);
if (!removedFilterPortal || card._filterPortal !== null || filterPortalRenderCount !== 0) throw new Error("Closing the Todo filter portal changed the card layout");
card._render = todoRender;
const source = require("./localization_source")(fs.readFileSync(cardPath, "utf8"));
if (!source.includes("data-send-list") || !source.includes("data-export-pdf") || !source.includes("notifications/assignments/list") || !source.includes("Als Vorlage speichern") || !source.includes("chips/list")) throw new Error("Todo actions or templates are not wired");
if (!source.includes('class="backdrop top filter-backdrop"') || !source.includes('document.body.appendChild(portal)') || !source.includes('data-ha-list-manager-todo-filter-portal') || !source.includes('this._listen(root.querySelector("[data-open-filter]"), "click", () => this._openFilterPortal()')) throw new Error("Todo filter dialog is not mounted as a document-level portal");
if (!source.includes('class="title-heading"><h2>') || !source.includes('class="title-meta">${titleDue}') || !styles.includes(".title-heading{")) throw new Error("Todo header metadata is not arranged correctly");
if (!source.includes("element.getAttribute(focusAttr) === focusValue") || !source.includes("next.focus({ preventScroll: true })") || !source.includes("this._patchDom(this.shadowRoot, template.content)")) throw new Error("Todo refresh discards live DOM or allows focus to scroll the dashboard");
if (!source.includes('this._listen(button, "click", (event) => {') || !source.includes("_suppressActionClickUntil")) throw new Error("Todo item actions no longer wait for the mobile click");
console.log("todo share and PDF smoke test passed");
