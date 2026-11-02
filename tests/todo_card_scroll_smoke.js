const { nativeHass } = require("./native_translation_hass");
/* Stress the expanded-view fallback with forced DOM replacement and delayed layout. */
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

const frames = new Map();
const timers = new Map();
let nextHandle = 1;
let now = 0;
const flushFrame = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback());
};
const advanceTime = (milliseconds) => {
  const until = now + milliseconds;
  while (true) {
    const pending = [...timers].filter(([, timer]) => timer.at <= until)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!pending) break;
    const [handle, timer] = pending;
    timers.delete(handle);
    now = timer.at;
    timer.callback();
  }
  now = until;
};

// Browser scroll containers start at zero when replaced. Row positions depend on
// both document layout and the current container scroll, as in getBoundingClientRect.
class ShadowRoot {
  constructor() {
    this.activeElement = null;
    this.rowPositions = new Map([["target", 2200]]);
    this.replaceCard();
  }
  replaceCard() {
    this.card = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) };
  }
  set innerHTML(value) { this.html = value; this.replaceCard(); }
  querySelector(selector) { return selector === "ha-card" ? this.card : null; }
  querySelectorAll(selector) {
    if (selector !== "[data-item-id]") return [];
    return [...this.rowPositions].map(([itemId, position]) => ({
      dataset: { itemId },
      getBoundingClientRect: () => ({ top: 100 + position - this.card.scrollTop }),
    }));
  }
  targetOffset() { return this.rowPositions.get("target") - this.card.scrollTop; }
}
class HTMLElement {
  constructor() { this.style = { removeProperty() {} }; }
  attachShadow() { this.shadowRoot = new ShadowRoot(); return this.shadowRoot; }
  dispatchEvent() {}
  setAttribute() {}
  removeAttribute() {}
}
const registry = new Map();
const context = vm.createContext({
  console, HTMLElement, CustomEvent: class {},
  setTimeout(callback, delay) {
    const handle = nextHandle++;
    timers.set(handle, { callback, at: now + delay });
    return handle;
  },
  clearTimeout: (handle) => timers.delete(handle),
  requestAnimationFrame(callback) {
    const handle = nextHandle++;
    frames.set(handle, callback);
    return handle;
  },
  cancelAnimationFrame: (handle) => frames.delete(handle),
  customElements: { get: (name) => registry.get(name), define: (name, ctor) => registry.set(name, ctor) },
  document: {
    createElement: () => ({}), head: { appendChild() {} }, body: { style: {} },
    addEventListener() {}, removeEventListener() {},
  },
  window: { customCards: [], addEventListener() {}, removeEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { language: "de-DE" },
});
const cardPath = process.argv[2];
vm.runInContext(fs.readFileSync(cardPath, "utf8"), context, { filename: cardPath });
const TodoCard = registry.get("ha-list-manager-todo-card");

const fixture = () => {
  const card = new TodoCard(); card._hass = nativeHass();
  card._config = { ...TodoCard.getStubConfig(), view_mode: "mobile", list_id: "todo" };
  card._list = { id: "todo", name: "Aufgaben", list_type: "todo" };
  card._items = [{ id: "target", name: "Aufgabe", completed: false }];
  card._expandedView = true;
  // Keep the production _render and scroll methods; omit unrelated markup and
  // event binding. The _patchDom stub below deliberately replaces the scroller.
  for (const method of ["_inputHtml", "_optionsHtml", "_contentHtml", "_chipsHtml", "_titleInfo",
    "_editorHtml", "_actionHtml", "_templateDialogHtml", "_confirmationHtml", "_chipDialogHtml",
    "_chipMenuHtml", "_styles", "_labelStyles"]) card[method] = () => "";
  card._bind = () => {};
  // Stress the expanded fallback with a replaced scroller even though normal
  // production refreshes now retain DOM nodes.
  card._patchDom = (parent) => { parent.innerHTML = ""; };
  return card;
};
const stop = (card) => {
  card._stopWatchingExpandedViewBounds();
  assert.equal(frames.size, 0, "Closing the view left a pending animation frame");
  assert.equal(timers.size, 0, "Closing the view left a delayed scroll correction");
};

async function main() {
  const repeated = fixture();
  repeated.shadowRoot.card.scrollTop = 1900;
  for (let render = 0; render < 4; render += 1) {
    repeated._render();
    assert.equal(repeated.shadowRoot.card.scrollTop, 1900,
      `Render ${render + 1} exposed the top of the list before the next animation frame`);
  }
  // A transient zero from a just-created element must not erase the saved position.
  repeated.shadowRoot.card.scrollTop = 0;
  repeated._render();
  assert.equal(repeated.shadowRoot.card.scrollTop, 1900, "A transient zero erased the saved position");
  flushFrame();
  assert.equal(repeated.shadowRoot.card.scrollTop, 1900, "The following frame changed the position");
  stop(repeated);

  const anchored = fixture();
  anchored.shadowRoot.card.scrollTop = 1900;
  const offset = anchored.shadowRoot.targetOffset();
  anchored._rememberExpandedScroll("target");
  anchored.shadowRoot.rowPositions.set("target", 2350);
  anchored._render();
  assert.equal(anchored.shadowRoot.targetOffset(), offset, "Changed rows moved the acted-on task immediately");
  anchored.shadowRoot.rowPositions.set("target", 2400);
  flushFrame();
  assert.equal(anchored.shadowRoot.targetOffset(), offset, "Layout in the next frame moved the task");
  anchored.shadowRoot.rowPositions.set("target", 2440);
  advanceTime(80);
  assert.equal(anchored.shadowRoot.targetOffset(), offset, "Delayed icon layout moved the task");
  anchored.shadowRoot.rowPositions.set("target", 2480);
  advanceTime(180);
  assert.equal(anchored.shadowRoot.targetOffset(), offset, "The final delayed layout moved the task");
  assert.equal(anchored._expandedScrollAnchor, null, "The action anchor remained active after settling");
  stop(anchored);

  const editor = fixture();
  editor.shadowRoot.card.scrollTop = 1900;
  let editorRenders = 0;
  const renderEditor = editor._render.bind(editor);
  editor._render = () => {
    renderEditor();
    editorRenders += 1;
    assert.equal(editor.shadowRoot.card.scrollTop, 1900, "An editor transition exposed the list top");
  };
  editor._hass = nativeHass({ callWS: async () => ({}) });
  editor._load = async () => editor._render();
  editor._openEditor(editor._items[0]);
  await editor._saveEditor();
  assert.ok(editorRenders >= 5, "The test did not exercise opening, busy, close, reload, and final renders");
  assert.equal(editor._dialog, null, "Saving did not close the editor");
  stop(editor);

  const closing = fixture();
  closing.shadowRoot.card.scrollTop = 1900;
  closing._rememberExpandedScroll("target");
  closing._render();
  flushFrame();
  assert.ok(timers.size > 0, "The test did not reach a delayed layout correction");
  closing._expandedPageOverflow = "auto";
  closing._oldOverflow = "hidden";
  closing._scrollLocked = true;
  context.document.body.style.overflow = "hidden";
  closing._setExpandedView(false);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(closing._expandedScrollAnchor, null);
  assert.equal(context.document.body.style.overflow, "hidden", "Closing the large view unlocked an open dialog");
  closing._unlock();
  assert.equal(context.document.body.style.overflow, "auto", "Closing the dialog did not restore the original page lock");
  advanceTime(1000);
  console.log("todo expanded scroll smoke test passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
