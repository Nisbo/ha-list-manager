const { nativeHass } = require("./native_translation_hass");
/* Exercise manual restock eligibility, request guarding and dialog feedback. */
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");
const registry = new Map();
class HTMLElement {
  attachShadow() {
    this.shadowRoot = { querySelector: () => null, querySelectorAll: () => [], innerHTML: "" };
    return this.shadowRoot;
  }
}
const context = vm.createContext({
  console, HTMLElement,
  customElements: { get: name => registry.get(name), define: (name, constructor) => registry.set(name, constructor) },
  document: { body: { style: {} } }, window: { customCards: [] },
});
const path = process.argv[2];
vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
const Card = registry.get("ha-list-manager-inventory-card");
const eligible = {
  source_type: "entry", source_id: "milk", name: "Milch", stock: 1, minimum_stock: 2,
  quantity: 1, latched: false, skipped: false, already_open: 99,
  effective_mode: "fixed", effective_fixed_quantity: 6,
};
const blocked = { ...eligible, latched: true, skipped: true };
const fixture = (rows = [eligible], target = "shopping") => {
  const card = new Card(), calls = [], renders = []; card._hass = nativeHass();
  card._config = { list_id: "pantry" };
  card._restockDialog = { view: "preview", target_list_id: target };
  card._restockPreview = rows;
  card._hass = nativeHass({ locale: { language: "de-DE" }, callWS: async request => { calls.push(request); return { target_list_id: "shopping", items: [] }; } });
  card._render = () => renders.push(card._renderRestockDialog());
  let loads = 0;
  card._load = async () => { loads += 1; card._render(); };
  return { card, calls, renders, loads: () => loads };
};
const button = (markup, attribute) => {
  const match = markup.match(new RegExp(`<button\\b[^>]*\\b${attribute}\\b[^>]*>`));
  assert.ok(match, `Missing ${attribute} button`);
  return match[0];
};
const disabled = markup => /\sdisabled(?:\s|>)/.test(markup);
const text = markup => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function main() {
  const manualTransfer = { transferred_at: "2026-10-19T10:11:00Z", quantity: 1, target_list_id: "shopping", target_list_name: 'Einkauf <img src=x onerror="alert(1)"> & Vorrat', mode: null };
  const automaticTransfer = { transferred_at: "2026-10-18T09:05:00Z", quantity: 6, target_list_id: "other-shopping", target_list_name: "Familieneinkauf", mode: "fixed" };
  const historyRow = { ...eligible, last_manual_transfer: manualTransfer, last_automatic_transfer: automaticTransfer };
  const history = fixture([historyRow]);
  history.card._hass.locale = { language: "de-DE" };
  history.card._hass.config = { time_zone: "Europe/Berlin" };
  const dateText = (transfer, language, timeZone) => new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(transfer.transferred_at));
  const historyMarkup = history.card._renderRestockTransferHistory(historyRow);
  assert.match(historyMarkup, /Zuletzt manuell aus dem Inventar übertragen:/);
  assert.match(historyMarkup, /Zuletzt automatisch nachbestellt:/);
  assert.ok(historyMarkup.includes(dateText(manualTransfer, "de-DE", "Europe/Berlin")), "Manual timestamp ignores HA language or time zone");
  assert.ok(historyMarkup.includes(dateText(automaticTransfer, "de-DE", "Europe/Berlin")), "Automatic timestamp ignores HA language or time zone");
  assert.match(historyMarkup, /1×/);
  assert.match(historyMarkup, /6×/);
  assert.match(historyMarkup, /Familieneinkauf/);
  assert.match(historyMarkup, /Grund: Feste Menge/);
  assert.match(historyMarkup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; Vorrat/);
  assert.doesNotMatch(historyMarkup, /<img|<script/, "Transfer target names injected HTML");
  assert.ok(history.card._renderRestockDialog().includes(historyMarkup), "History is not displayed in its preview row");
  assert.match(history.card._renderRestockDialog(), /vor Einführung der Protokollierung/);
  history.card._hass = nativeHass({ ...history.card._hass, language: "en-GB", locale: { language: "en-GB" } });
  history.card._hass.config.time_zone = "UTC";
  assert.ok(history.card._renderRestockTransferHistory(historyRow).includes(dateText(manualTransfer, "en-GB", "UTC")), "Changing HA locale and time zone did not change the displayed date");
  for (const [mode, label] of [["continuous", "Minimum stock"], ["fixed", "Fixed quantity"], ["one_to_one", "1:1"]]) {
    const automaticOnly = history.card._renderRestockTransferHistory({ ...eligible, last_automatic_transfer: { ...automaticTransfer, mode } });
    assert.ok(automaticOnly.includes(`Reason: ${label}`));
    assert.match(automaticOnly, /Last manually transferred from inventory: Not logged yet/);
  }
  assert.match(history.card._renderRestockTransferHistory({ ...eligible, last_manual_transfer: manualTransfer }), /Last automatically restocked: Not logged yet/);
  assert.match(history.card._renderRestockTransferHistory(eligible), /No restock orders recorded yet/);
  const invalidDate = history.card._renderRestockTransferHistory({ ...eligible, last_manual_transfer: { ...manualTransfer, transferred_at: "kein Datum" } });
  assert.match(invalidDate, /Time unavailable/);
  assert.doesNotMatch(invalidDate, /Invalid Date/);
  history.card._hass.config.time_zone = "Invalid/Zone";
  assert.ok(history.card._renderRestockTransferHistory(historyRow).includes(new Date(manualTransfer.transferred_at).toISOString()), "Invalid HA time-zone settings broke a valid recorded timestamp");

  const locked = fixture([blocked]);
  assert.match(history.card._renderRestockDialog(), /<details class="restock-explanation">/);
  assert.match(history.card._renderRestockDialog(), /<details class="restock-details">/);
  assert.doesNotMatch(history.card._renderRestockTransferHistory(eligible, true), /logged/);
  assert.doesNotMatch(history.card._renderRestockTransferHistory(historyRow, true), /Familieneinkauf|Reason:/);
  const lockedMarkup = locked.card._renderRestockDialog();
  const explanation = text(lockedMarkup);
  assert.match(explanation, /Nachbestellsperre aktiv/);
  assert.match(explanation, /Fehlbestand 1/);
  assert.match(explanation, /automatisch.*6|6.*automatisch/i);
  assert.match(explanation, /99/);
  assert.match(explanation, /zurücksetzen/i);
  assert.match(explanation, /nicht.*(sende|übertr)|keine.*(Bestellung|Übertragung)/i,
    "Reset help must explain that resetting alone sends nothing");
  assert.ok(disabled(button(lockedMarkup, "data-apply-restock")), "An entirely blocked preview can be applied");
  assert.ok(!disabled(button(lockedMarkup, "data-reset-restock-latch")), "A blocked source cannot be reset");

  const mixed = fixture([blocked, { ...eligible, source_id: "bread", name: "Brot" }]);
  assert.ok(!disabled(button(mixed.card._renderRestockDialog(), "data-apply-restock")), "A mixed preview cannot send eligible shortages");
  assert.match(text(mixed.card._renderRestockDialog()), /1 Artikel übertragen/);
  for (const [rows, target] of [[[], "shopping"], [[eligible], null], [[blocked], "shopping"]]) {
    const state = fixture(rows, target);
    assert.ok(disabled(button(state.card._renderRestockDialog(), "data-apply-restock")), "An unavailable transfer button is enabled");
    await state.card._applyRestockPreview();
    assert.equal(state.calls.length, 0, "An ineligible preview sent an apply request");
  }
  const busy = fixture([blocked, eligible]);
  busy.card._busy = true;
  const busyMarkup = busy.card._renderRestockDialog();
  assert.ok(disabled(button(busyMarkup, "data-apply-restock")));
  assert.ok(disabled(button(busyMarkup, "data-reset-restock-latch")));
  await busy.card._applyRestockPreview();
  await busy.card._resetRestockLatch("entry", "milk");
  assert.equal(busy.calls.length, 0, "An operation in progress allowed another restock request");

  const duplicate = fixture([{ ...eligible, quantity: 99 }]);
  let finish;
  duplicate.card._hass.callWS = request => { duplicate.calls.push(request); return new Promise(resolve => { finish = resolve; }); };
  const first = duplicate.card._applyRestockPreview();
  assert.ok(disabled(button(duplicate.renders[0] || "", "data-apply-restock")), "The pending request did not disable its visible button");
  await duplicate.card._applyRestockPreview();
  assert.equal(duplicate.calls.length, 1, "A double click duplicated the apply request");
  assert.equal(duplicate.calls[0].type, "ha_list_manager/inventory/restock/apply");
  finish({ target_list_id: "shopping", items: [{ quantity: 3 }] });
  await first;
  assert.equal(duplicate.card._restockDialog, null, "A successful transfer left the preview open");
  assert.match(duplicate.card._actionStatus, /\b3\b/);
  assert.doesNotMatch(duplicate.card._actionStatus, /\b99\b/, "Feedback used the stale preview instead of the backend result");
  assert.equal(duplicate.loads(), 1);

  const stale = fixture();
  stale.card._hass.callWS = async request => {
    stale.calls.push(request);
    return request.type.endsWith("/preview")
      ? { target_list_id: "shopping", items: [blocked] }
      : { target_list_id: "shopping", items: [] };
  };
  await stale.card._applyRestockPreview();
  assert.ok(stale.card._restockDialog, "A now-blocked preview was closed as a successful transfer");
  assert.equal(stale.card._restockPreview[0].skipped, true, "A zero transfer did not refresh the preview");
  assert.ok(stale.card._restockDialog.status, "A zero transfer has no explanation");
  assert.doesNotMatch(stale.card._actionStatus, /wurden.*übertragen/i);
  assert.ok(disabled(button(stale.card._renderRestockDialog(), "data-apply-restock")));

  const failure = fixture();
  const dialog = failure.card._restockDialog;
  failure.card._hass.callWS = async () => { throw Error("Übertragung fehlgeschlagen"); };
  await failure.card._applyRestockPreview();
  assert.equal(failure.card._restockDialog, dialog, "An error discarded the preview");
  assert.match(failure.card._error, /Übertragung fehlgeschlagen/);
  assert.equal(failure.loads(), 0);

  const reset = fixture([{ ...blocked, source_type: "group", source_id: "milk-group" }]);
  reset.card._hass.callWS = async request => {
    reset.calls.push(request);
    return request.type.endsWith("/preview")
      ? { target_list_id: "shopping", items: [historyRow] }
      : { success: true };
  };
  await reset.card._resetRestockLatch("group", "milk-group");
  assert.deepEqual(reset.calls.map(request => request.type), [
    "ha_list_manager/inventory/restock/latch/reset",
    "ha_list_manager/inventory/restock/preview",
  ]);
  assert.equal(reset.calls[0].source_type, "group");
  assert.equal(reset.calls[0].source_id, "milk-group");
  assert.equal(reset.card._restockPreview[0].skipped, false);
  assert.equal(reset.card._restockPreview[0].last_manual_transfer, manualTransfer, "Reset discarded the backend's manual transfer history");
  assert.equal(reset.card._restockPreview[0].last_automatic_transfer, automaticTransfer, "Reset discarded the backend's automatic transfer history");
  assert.match(reset.card._renderRestockDialog(), /Zuletzt manuell aus dem Inventar übertragen:/);
  assert.match(reset.card._renderRestockDialog(), /Zuletzt automatisch nachbestellt:/);
  assert.ok(!disabled(button(reset.card._renderRestockDialog(), "data-apply-restock")));
  console.log("inventory restock dialog smoke test passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
