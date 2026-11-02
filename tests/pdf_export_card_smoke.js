const { nativeHass } = require("./native_translation_hass");
/* Browser-independent smoke test for the backend card PDF export data. */
const fs = require("fs");
const vm = require("vm");

const loadCard = (path, elementName) => {
  const registry = new Map();
  class HTMLElement {
    attachShadow() {
      this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [], innerHTML: "" };
      return this.shadowRoot;
    }
    dispatchEvent() {}
  }
  const context = vm.createContext({
    console, setTimeout, clearTimeout, HTMLElement, CustomEvent: class {}, ResizeObserver: class { observe() {} disconnect() {} },
    customElements: { get: (name) => registry.get(name), define: (name, constructor) => registry.set(name, constructor) },
    document: { createElement: () => ({ addEventListener: () => {} }), head: { appendChild: () => {} }, body: { style: {} }, documentElement: { style: {} } },
    window: { customCards: [] }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
  return registry.get(elementName);
};

const ShoppingCard = loadCard(process.argv[2], "ha-list-manager-shopping-card");
const shopping = new ShoppingCard(); shopping._hass = nativeHass();
shopping._config = { ...ShoppingCard.getStubConfig(), show_brand: false, show_quantity: false, quantity_position: "beginning" };
shopping._hass = nativeHass({ locale: { language: "de" } });
shopping._list = { id: "shopping", name: "Einkauf" };
shopping._categories = [{ id: "drinks", name: "Getränke", color: "#123456", scope: "list" }];
shopping._items = [
  { id: "one", name: "Wasser", quantity: 2, completed: false, category_id: "drinks" },
  { id: "two", name: "Brot", quantity: 1, completed: true, category: null },
];
const shoppingSections = shopping._pdfSections();
if (shoppingSections.length !== 2) throw new Error("Shopping PDF categories missing");
if (!shoppingSections.flatMap((section) => section.items).some((item) => item.name === "Wasser" && item.quantityLabel === "2×" && item.checked === false)) throw new Error("Shopping PDF quantity missing");
if (!shoppingSections.flatMap((section) => section.items).some((item) => item.text === "Brot" && item.checked === true)) throw new Error("Shopping PDF completion missing");
if (!ShoppingCard.getConfigForm().schema.flatMap((entry) => entry.schema || [entry]).some((entry) => entry.name === "show_pdf_export_button")) throw new Error("Shopping PDF editor option missing");
if (!shopping._styles().includes(".compact-actions-menu") || !shopping._styles().includes(".title-actions-wide{display:none}")) throw new Error("Shopping mobile action menu missing");

const InventoryCard = loadCard(process.argv[3], "ha-list-manager-inventory-card");
const inventory = new InventoryCard(); inventory._hass = nativeHass();
inventory._config = { ...InventoryCard.getStubConfig() };
inventory._hass = nativeHass({ locale: { language: "de" } });
inventory._categories = [{ id: "drinks", name: "Getränke", color: "#123456", scope: "list" }];
inventory._entries = [
  { id: "one", stock: 3, category_id: "drinks", product: { name: "Wasser", brand: "Marke", package_quantity: "1 l" } },
];
inventory._effectiveEntryCategory = () => inventory._categories[0];
const inventorySections = inventory._pdfSections();
if (inventorySections[0]?.items[0]?.name !== "Wasser – Marke · 1 l" || inventorySections[0]?.items[0]?.stockLabel !== "Bestand 3") throw new Error("Inventory PDF stock missing");
if (!InventoryCard.getConfigForm().schema.flatMap((entry) => entry.schema || [entry]).some((entry) => entry.name === "show_pdf_export_button")) throw new Error("Inventory PDF editor option missing");
if (!inventory._styles().includes(".compact-actions-menu") || !inventory._styles().includes(".inventory-header-actions-wide{display:none}")) throw new Error("Inventory mobile action menu missing");

const exporter = fs.readFileSync(process.argv[4], "utf8");
if (!exporter.includes("/ha_list_manager_static/pdf-lib.min.js") || exporter.includes("cdn.jsdelivr.net")) throw new Error("PDF exporter is not using the bundled library");
if (!exporter.includes("item.detailRows") || !exporter.includes("detailLines")) throw new Error("PDF exporter does not support structured Todo details");
if (!exporter.includes("item.leadingRows") || !exporter.includes('row.tone === "error"')) throw new Error("Overdue Todo due-date columns are not red");
if (!exporter.includes("leadingRows.slice(0, 2)") || !exporter.includes("x: margin + 31")) throw new Error("Todo due dates are not rendered in the second PDF column");
console.log("pdf export card smoke test passed");

// Build the PDF through its real rendering method. Only the pdf-lib drawing
// backend and browser download are fixtures; all label selection stays native.
async function pdfTranslationTests() {
  const assert = require("node:assert/strict");
  for (const language of ["de-DE", "en-GB"]) {
    const texts = [], titles = [], anchors = [], pages = [];
    const font = { encodeText() {}, widthOfTextAtSize: (text, size) => String(text).length * size / 2 };
    const pdf = {
      setTitle: value => titles.push(value), setCreator() {}, setCreationDate() {},
      embedFont: async () => font,
      getForm: () => ({ createCheckBox: () => ({ addToPage() {}, check() {} }) }),
      addPage: () => { const page = { drawText: value => texts.push(value), drawRectangle() {}, drawLine() {} }; pages.push(page); return page; },
      getPageCount: () => pages.length, getPages: () => pages, save: async () => new Uint8Array([37, 80, 68, 70]),
    };
    const context = vm.createContext({
      window: { PDFLib: { PDFDocument: { create: async () => pdf }, StandardFonts: {}, rgb: (...channels) => channels } },
      document: { createElement: () => { const anchor = { click() {}, remove() {} }; anchors.push(anchor); return anchor; }, body: { appendChild() {} } },
      URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} }, Blob, Date, Intl, setTimeout: () => 0,
    });
    vm.runInContext(exporter, context, { filename: process.argv[4] });
    const hass = nativeHass({ language, locale: { language } });
    await context.window.HaListManagerPdfExporter.exportPdf({ hass, sections: [{ name: "", items: [{ name: "User product", checked: true }] }] });
    assert.equal(titles[0], hass.localize("component.ha_list_manager.config_panel.ui.list"));
    assert.ok(texts.includes(hass.localize("component.ha_list_manager.config_panel.ui.general")));
    assert.ok(texts.includes(hass.localize("component.ha_list_manager.config_panel.ui.page_of_total", { p0: 1, p1: 1 })));
    assert.ok(texts.includes("User product"), "PDF language selection preserves the user's product name");
    assert.equal(hass.translationCalls.length, 1, "PDF requests the native integration translation category");
    assert.ok(anchors[0].download.endsWith(".pdf"));
  }
  console.log("PDF rendering uses native HA translations in German and English");
}
pdfTranslationTests().catch(error => { console.error(error); process.exitCode = 1; });
