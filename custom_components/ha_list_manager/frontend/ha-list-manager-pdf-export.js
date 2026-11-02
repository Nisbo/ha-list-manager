// Text is loaded and formatted by Home Assistant from translations/*.json.
function haListManagerPdfExportTextLocale(hass = null) {
  return String(hass?.locale?.language || hass?.language || "en").replace("_", "-");
}
function haListManagerPdfExportText(key, values = {}, hass = null) {
  return hass?.localize?.(`component.ha_list_manager.config_panel.${key}`, values) || "";
}
function haListManagerPdfExportTextLoadTranslations(hass) {
  if (!hass?.loadBackendTranslation) return Promise.resolve();
  // Share only in-flight requests: HA owns the resources and language cache.
  // Its native cache marks a category loaded before the first request resolves.
  const pending = globalThis[Symbol.for("ha-list-manager.native-translations")] ||= new WeakMap();
  const connection = hass.connection || hass;
  let languages = pending.get(connection);
  if (!languages) { languages = new Map(); pending.set(connection, languages); }
  const language = String(hass.language || haListManagerPdfExportTextLocale(hass));
  let request = languages.get(language);
  if (!request) {
    // Let HA finish clearing its category cache when a user switches language.
    request = Promise.resolve().then(() => hass.loadBackendTranslation("config_panel", "ha_list_manager")).catch(() => {
      // A failed scoped load remains marked as loaded in HA's native cache.
      // Loading the category restores it and enables HA's reconnect refresh.
      return hass.loadBackendTranslation("config_panel");
    });
    languages.set(language, request);
    const clear = () => { if (languages.get(language) === request) languages.delete(language); };
    request.then(clear, clear);
  }
  return request;
}
// Shared PDF export used by the backend shopping, inventory, and Todo cards.
// pdf-lib is shipped with the integration so exporting also works without
// internet access from the Home Assistant frontend.
(function registerHaListManagerPdfExporter() {
  if (window.HaListManagerPdfExporter) return;

  const PDF_LIB_URL = "/ha_list_manager_static/pdf-lib.min.js?v=1.17.1";
  const ACCENT = [0.02, 0.58, 0.75];

  const loadPdfLib = (hass) => {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (window.__shoppingListImprovedPdfLibPromise) return window.__shoppingListImprovedPdfLibPromise;
    window.__shoppingListImprovedPdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDF_LIB_URL;
      script.async = true;
      script.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error(haListManagerPdfExportText("ui.pdf_library_not_loaded", {}, hass)));
      script.onerror = () => reject(new Error(haListManagerPdfExportText("errors.pdf_library_load_failed", {}, hass)));
      document.head.appendChild(script);
    }).catch((error) => {
      window.__shoppingListImprovedPdfLibPromise = null;
      throw error;
    });
    return window.__shoppingListImprovedPdfLibPromise;
  };

  const colorChannels = (value) => {
    if (typeof value !== "string") return ACCENT;
    const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      let digits = hex[1];
      if (digits.length === 3) digits = digits.split("").map((character) => character + character).join("");
      return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255);
    }
    const channels = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    return channels ? channels.slice(1, 4).map((channel) => Math.min(255, Number(channel)) / 255) : ACCENT;
  };

  const blend = (channels, target, amount) => channels.map((channel, index) => channel + ((target[index] - channel) * amount));

  const safeText = (font, value) => [...String(value ?? "")].map((character) => {
    try { font.encodeText(character); return character; }
    catch (_error) { return "?"; }
  }).join("");

  const wrapText = (font, value, size, maxWidth) => {
    const text = safeText(font, value).replace(/\s+/g, " ").trim();
    if (!text) return [""];
    const words = [];
    for (const part of text.split(" ")) {
      if (font.widthOfTextAtSize(part, size) <= maxWidth) { words.push(part); continue; }
      let fragment = "";
      for (const character of part) {
        const candidate = fragment + character;
        if (fragment && font.widthOfTextAtSize(candidate, size) > maxWidth) { words.push(fragment); fragment = character; }
        else fragment = candidate;
      }
      if (fragment) words.push(fragment);
    }
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
    return lines;
  };

  const fileSafe = (value, hass) => String(value || haListManagerPdfExportText("ui.list", {}, hass)).trim().toLocaleLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";

  async function exportPdf({ title, subtitle, fileName, sections, hass }) {
    const localize = await haListManagerPdfExportTextLoadTranslations(hass);
    if (localize) hass = { ...hass, localize };
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib(hass);
    const pdf = await PDFDocument.create();
    pdf.setTitle(String(title || haListManagerPdfExportText("ui.list", {}, hass)));
    pdf.setCreator("HA List Manager");
    pdf.setCreationDate(new Date());
    const normal = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const form = pdf.getForm();
    const width = 595;
    const height = 842;
    const margin = 38;
    const contentWidth = width - (margin * 2);
    const bottomLimit = 46;
    const dateText = new Date().toLocaleString(haListManagerPdfExportTextLocale(hass));
    let page;
    let y;
    let fieldIndex = 0;
    let rowIndex = 0;

    const drawPageHeader = (continued = false) => {
      page.drawRectangle({ x: 0, y: height - 9, width, height: 9, color: rgb(...ACCENT) });
      page.drawText("HA LIST MANAGER", { x: margin, y: height - 36, size: 7.5, font: bold, color: rgb(...ACCENT), characterSpacing: 1.1 });
      page.drawText(safeText(bold, title || haListManagerPdfExportText("ui.list", {}, hass)), { x: margin, y: height - 66, size: continued ? 18 : 24, font: bold, color: rgb(0.10, 0.12, 0.14) });
      const meta = [subtitle, dateText].filter(Boolean).join("   ·   ");
      page.drawText(safeText(normal, meta), { x: margin, y: height - 84, size: 8.5, font: normal, color: rgb(0.40, 0.43, 0.46) });
      y = height - 111;
    };
    const addPage = () => {
      page = pdf.addPage([width, height]);
      drawPageHeader(pdf.getPageCount() > 1);
    };
    const ensure = (needed, continuation) => {
      if (y - needed >= bottomLimit) return false;
      addPage();
      if (continuation) continuation();
      return true;
    };
    const drawSectionHeader = (section, continued = false) => {
      const color = colorChannels(section.color);
      const background = blend(color, [1, 1, 1], 0.88);
      const labelColor = blend(color, [0, 0, 0], 0.22);
      const label = `${section.name || haListManagerPdfExportText("ui.general", {}, hass)}${continued ? (" " + haListManagerPdfExportText("ui.continued_suffix", {}, hass)) : ""}`;
      page.drawRectangle({ x: margin, y: y - 4, width: contentWidth, height: 26, color: rgb(...background) });
      page.drawRectangle({ x: margin, y: y - 4, width: 5, height: 26, color: rgb(...color) });
      const safeLabel = safeText(bold, label);
      page.drawText(safeLabel, { x: margin + 14, y: y + 5, size: 11, font: bold, color: rgb(...labelColor) });
      const count = String(section.items.length);
      const labelWidth = bold.widthOfTextAtSize(safeLabel, 11);
      page.drawText(count, { x: margin + 22 + labelWidth, y: y + 6, size: 8.5, font: bold, color: rgb(...labelColor) });
      y -= 12;
      rowIndex = 0;
    };

    addPage();
    for (const section of sections || []) {
      if (!section?.items?.length) continue;
      ensure(35);
      drawSectionHeader(section);
      const sectionLeadingWidths = section.items.flatMap((item) => {
        if (Array.isArray(item.leadingRows) && item.leadingRows.length) {
          return item.leadingRows.map((row) => normal.widthOfTextAtSize(safeText(normal, row?.text || ""), 8));
        }
        const badge = safeText(bold, item.badge || item.quantityLabel || item.stockLabel || "");
        return badge ? [bold.widthOfTextAtSize(badge, 9)] : [];
      });
      const badgeColumnWidth = sectionLeadingWidths.length
        ? Math.max(30, ...sectionLeadingWidths) + 8
        : 0;
      for (const item of section.items) {
        const leadingRows = Array.isArray(item.leadingRows) ? item.leadingRows.filter((row) => row?.text) : [];
        const badge = safeText(bold, item.badge || item.quantityLabel || item.stockLabel || "");
        const nameX = margin + 34 + badgeColumnWidth;
        const lines = wrapText(normal, item.name || item.text || "", 10.5, width - margin - nameX);
        const detailLines = Array.isArray(item.detailRows)
          ? item.detailRows.flatMap((row) => wrapText(normal, row?.text || "", 8.5, width - margin - nameX).map((text) => ({ text, tone: row?.tone || "" })))
          : item.details ? wrapText(normal, item.details, 8.5, width - margin - nameX).map((text) => ({ text, tone: "" })) : [];
        const rowHeight = Math.max(29, 11 + lines.length * 12 + detailLines.length * 10);
        ensure(rowHeight, () => drawSectionHeader(section, true));
        if (rowIndex % 2) page.drawRectangle({ x: margin, y: y - rowHeight + 6, width: contentWidth, height: rowHeight, color: rgb(0.965, 0.97, 0.975) });
        const checkbox = form.createCheckBox(`item_${fieldIndex++}`);
        checkbox.addToPage(page, {
          x: margin + 10, y: y - 16, width: 13, height: 13, borderWidth: 1,
          borderColor: rgb(0.36, 0.39, 0.42), backgroundColor: rgb(1, 1, 1),
        });
        if (item.checked) checkbox.check();
        // Keep the control recognizable in PDF viewers that do not paint
        // unchecked AcroForm appearances until the field receives focus.
        page.drawRectangle({ x: margin + 10, y: y - 16, width: 13, height: 13, borderWidth: 0.8, borderColor: rgb(0.36, 0.39, 0.42) });
        lines.forEach((line, index) => page.drawText(line, { x: nameX, y: y - (index * 12) - 13, size: 10.5, font: normal, color: rgb(0.10, 0.12, 0.14) }));
        detailLines.forEach((line, index) => page.drawText(line.text, { x: nameX, y: y - (lines.length * 12) - (index * 10) - 12, size: 8.5, font: normal, color: line.tone === "error" ? rgb(0.75, 0.08, 0.08) : rgb(0.40, 0.43, 0.46) }));
        if (leadingRows.length) {
          leadingRows.slice(0, 2).forEach((row, index) => page.drawText(safeText(normal, row.text), {
            x: margin + 31,
            y: y - 11 - (index * 10),
            size: 8,
            font: normal,
            color: row.tone === "error" ? rgb(0.75, 0.08, 0.08) : rgb(0.32, 0.35, 0.38),
          }));
        } else if (badge) {
          const textWidth = bold.widthOfTextAtSize(badge, 9);
          const pillWidth = textWidth + 12;
          const pillX = nameX - pillWidth - 6;
          page.drawRectangle({ x: pillX, y: y - 19, width: pillWidth, height: 19, color: rgb(0.90, 0.94, 0.96) });
          page.drawText(badge, { x: pillX + 6, y: y - 13, size: 9, font: bold, color: rgb(0.17, 0.33, 0.40) });
        }
        page.drawLine({ start: { x: nameX, y: y - rowHeight + 6 }, end: { x: width - margin, y: y - rowHeight + 6 }, thickness: 0.45, color: rgb(0.87, 0.88, 0.89) });
        y -= rowHeight;
        rowIndex += 1;
      }
      y -= 30;
    }

    const pages = pdf.getPages();
    pages.forEach((pdfPage, index) => {
      pdfPage.drawLine({ start: { x: margin, y: 32 }, end: { x: width - margin, y: 32 }, thickness: 0.6, color: rgb(0.84, 0.85, 0.86) });
      pdfPage.drawText("HA List Manager", { x: margin, y: 18, size: 7.5, font: normal, color: rgb(0.48, 0.50, 0.52) });
      const pageLabel = haListManagerPdfExportText("ui.page_of_total", {p0:(index + 1), p1:(pages.length)}, hass);
      const labelWidth = normal.widthOfTextAtSize(pageLabel, 7.5);
      pdfPage.drawText(pageLabel, { x: width - margin - labelWidth, y: 18, size: 7.5, font: normal, color: rgb(0.48, 0.50, 0.52) });
    });

    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileSafe(fileName || title, hass)}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.HaListManagerPdfExporter = { exportPdf };
})();
