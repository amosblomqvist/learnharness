import assert from "node:assert/strict";
import { test } from "node:test";
import { FAMILY_IDS, mountGallery } from "../src/gallery.ts";
import { openSurfaceDemo } from "../src/surfaces.ts";
import { Scope } from "../src/dom.ts";
import { createFixture } from "./fixture.ts";

const families = ["pickers", "composer", "dictation", "standard-composer", "buttons", "settings", "markdown", "tree", "worker-results", "menus", "dialogs", "surfaces"];
function mounted() {
  const f = createFixture();
  const dispose = mountGallery(f.root, f.context, f.controller.signal);
  return { ...f, dispose };
}

test("single gallery, twelve families cover fourteen public APIs without backend/app/storage calls", () => {
  const f = mounted();
  try {
    assert.deepEqual([...FAMILY_IDS], families);
    assert.equal(f.root.querySelectorAll('[data-showcase="gallery"]').length, 1);
    assert.deepEqual([...f.root.querySelectorAll("[data-family]")].map(node => (node as HTMLElement).dataset.family), families);
    for (const family of families) { f.find(`reset-${family}`, "mountButton"); assert.ok(f.root.querySelector(`[data-state="${family}"]`)); }
    for (const method of ["mountModelPicker", "mountThinkingPicker", "mountKnowledgePicker", "mountComposer", "mountDictation", "mountStandardComposer", "mountButton", "mountSettingsRows", "mountMarkdown", "mountTree", "mountWorkerResult"]) assert.ok(f.records.some(entry => entry.method === method), method);
    assert.deepEqual(f.calls, []);
    assert.equal(f.records.filter(entry => entry.method === "openSurface").length, 0, "Gallery surfaces open only after an explicit click");
    assert.equal(f.find("open-surface").props.label, "Open surface");
    assert.deepEqual(f.state("surfaces"), { target: "current page", opens: 0, closed: 0, lastCallback: "none" });
    f.dispose(); f.dispose();
    assert.equal(f.root.childElementCount, 0);
    assert.ok(f.records.every(entry => entry.disposed === 1));
  } finally { f.restore(); }
});

test("every family reset replaces its body/lifetime without touching sibling state", async () => {
  const f = mounted();
  try {
    for (const id of families) {
      const section = f.root.querySelector(`[data-family="${id}"]`)!;
      const readout = section.querySelector(`[data-state="${id}"]`)!;
      const initial = f.state(id);
      const siblings = families.filter(other => other !== id).map(other => f.root.querySelector(`[data-state="${other}"]`));
      const widgets = f.records.filter(record => !record.disposed && section.contains(record.container) && !record.container.closest(`[data-example="reset-${id}"]`));
      await f.find(`reset-${id}`).props.onClick();
      assert.equal(readout.isConnected, false, `${id}: old local body removed`);
      assert.deepEqual(f.state(id), initial, `${id}: defaults restored`);
      assert.ok(widgets.every(widget => widget.signal.aborted && widget.disposed === 1), `${id}: old widgets disposed`);
      assert.ok(siblings.every(node => node!.isConnected), `${id}: sibling bodies retained`);
    }
  } finally { f.restore(); }
});

test("controlled linked pickers keep local values and reset only their family", async () => {
  const f = mounted();
  try {
    const model = f.find("model-picker"), thinking = f.find("thinking-picker"), knowledge = f.find("knowledge-picker");
    await model.props.onChange({ provider: "custom", id: "offline-fixture" });
    assert.deepEqual(thinking.props.model, { provider: "custom", id: "offline-fixture" });
    await thinking.props.onChange("high");
    await knowledge.props.onChange(["synthetic-prop"]);
    assert.equal(thinking.props.value, "high");
    assert.deepEqual(knowledge.props.value, ["synthetic-prop"]);
    await model.props.onChange({ provider: "custom", id: "second-fixture" });
    assert.equal(thinking.props.value, undefined, "Model change clears linked thinking");
    const composer = f.find("composer");
    await composer.props.onChange("unrelated retained draft");
    await f.find("reset-pickers").props.onClick();
    assert.equal(model.signal.aborted, true);
    assert.equal(f.find("model-picker").props.value, undefined);
    assert.deepEqual(f.find("knowledge-picker").props.value, []);
    assert.equal(f.find("composer"), composer);
    assert.equal(f.state("composer").draft, "unrelated retained draft");
    const before = f.state("pickers");
    await model.props.onChange({ provider: "custom", id: "stale-callback" });
    assert.deepEqual(f.state("pickers"), before, "Aborted picker callback cannot update replacement state");
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("composer and standard composer Send/Stop are local controlled simulations", async () => {
  const f = mounted();
  try {
    const composer = f.find("composer");
    assert.equal(composer.props.canSend, false); assert.equal(composer.props.autoFocus, false);
    await composer.props.onChange("  "); assert.equal(composer.props.canSend, false);
    await composer.props.onChange("local ordinary draft"); assert.equal(composer.props.canSend, true);
    await composer.props.onSend(); assert.equal(composer.props.busy, true); assert.equal(f.state("composer").sends, 1);
    await composer.props.onStop(); assert.equal(composer.props.busy, false);
    await composer.props.onSend(); await f.find("complete-composer").props.onClick(); assert.equal(composer.props.busy, false);
    const standard = f.find("standard-composer");
    assert.equal(standard.props.composer.canSend, undefined);
    assert.equal(Object.hasOwn(standard.props.composer, "canSend"), false, "Native preset must retain text-or-active-dictation readiness fallback");
    await standard.props.composer.onChange("standard local draft");
    await standard.props.dictation.onTranscript("explicit unit transcript");
    assert.match(standard.props.composer.value, /standard local draft\nexplicit unit transcript/);
    await standard.props.model.onChange({ provider: "custom", id: "fixture" });
    await standard.props.thinking.onChange("high");
    await standard.props.model.onChange({ provider: "custom", id: "other-fixture" });
    assert.equal(standard.props.thinking.value, undefined);
    await standard.props.composer.onSend(); assert.equal(standard.props.composer.busy, true);
    assert.equal(f.state("standard-composer").lastSent, standard.props.composer.value);
    await standard.props.composer.onStop(); assert.equal(standard.props.composer.busy, false);
    await f.find("reset-composer").props.onClick(); assert.equal(f.find("composer").props.value, "");
    assert.match(standard.props.composer.value, /standard local draft/);
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("dictation never starts on mount/reset, transcripts stay local, abort ignores late delivery", async () => {
  const f = mounted();
  try {
    const dictation = f.find("dictation");
    assert.deepEqual(dictation.dictation, { toggle: 0, finish: 0, cancel: 0 });
    await dictation.props.onTranscript("first"); await dictation.props.onTranscript("second");
    assert.equal(f.state("dictation").transcript, "first\nsecond");
    assert.equal(f.state("dictation").deliveries, 2);
    await f.find("reset-dictation").props.onClick();
    assert.deepEqual(f.find("dictation").dictation, { toggle: 0, finish: 0, cancel: 0 });
    assert.equal(f.state("dictation").transcript, "");
    await dictation.props.onTranscript("late"); assert.equal(f.state("dictation").transcript, "");
  } finally { f.restore(); }
});

test("buttons expose every variant/size; manual async completes and pending reset resolves", async () => {
  const f = mounted();
  try {
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost", "link"]) assert.equal(f.find(`button-variant-${variant}`).props.variant, variant);
    for (const size of ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"]) {
      const props = f.find(`button-size-${size}`).props;
      assert.equal(props.size, size); if (size.startsWith("icon")) assert.ok(props.title);
    }
    assert.equal(f.find("button-disabled").props.disabled, true);
    await f.find("button-variant-outline").props.onClick(); assert.equal(f.state("buttons").clicks, 1);
    let settled = false;
    const pending = f.find("button-async").props.onClick().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false); assert.equal(f.state("buttons").pending, true);
    assert.equal(f.find("complete-button-async").props.disabled, false);
    await f.find("complete-button-async").props.onClick(); await pending;
    assert.equal(f.state("buttons").pending, false);
    const resetPending = f.find("button-async").props.onClick();
    await f.find("reset-buttons").props.onClick(); await resetPending;
    assert.equal(f.state("buttons").pending, false); assert.equal(f.state("buttons").clicks, 0);
    const disposePending = f.find("button-async").props.onClick(); f.dispose(); await disposePending;
  } finally { f.restore(); }
});

test("settings provide five typed rows, validators and local controlled acknowledgment", async () => {
  const f = mounted();
  try {
    const widget = f.find("settings-rows");
    const rows = () => widget.props.rows as Array<Record<string, any>>;
    assert.deepEqual([...new Set(rows().map(row => row.type))], ["toggle", "text", "dropdown", "number", "slider"]);
    assert.equal(rows().find(row => row.key === "disabled")!.disabled, true);
    const text = rows().find(row => row.key === "text")!;
    assert.ok(text.validate("  ")); assert.ok(text.validate("ab")); assert.equal(text.validate(" valid "), undefined);
    for (const key of ["number", "slider"]) {
      const row = rows().find(row => row.key === key)!;
      assert.ok(row.validate(1.5)); assert.equal(row.validate(3), undefined); assert.equal(row.step, 1); assert.ok(row.min < row.max);
    }
    await text.onChange("Valid local text"); assert.equal(f.state("settings").text, "Valid local text");
    assert.equal(rows().find(row => row.key === "text")!.value, "Valid local text");
    await f.find("reset-settings").props.onClick(); assert.equal(f.state("settings").text, "Example");
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("Markdown uses builtin content and worker examples cover exact four-by-three matrix", () => {
  const f = mounted();
  try {
    const text = f.find("markdown").props.text;
    for (const token of ["**host-rendered**", "```ts", "| Example | Value |", "$a^2", "```mermaid"]) assert.ok(text.includes(token), token);
    assert.doesNotMatch(text, /https?:\/\//);
    const workers = f.records.filter(entry => entry.method === "mountWorkerResult");
    assert.equal(workers.length, 12);
    assert.deepEqual(new Set(workers.map(entry => `${entry.props.status}/${entry.props.presentation}`)), new Set(["succeeded", "failed", "cancelled", "interrupted"].flatMap(status => ["collapsed", "card", "plain"].map(presentation => `${status}/${presentation}`))));
    assert.equal(f.state("worker-results").workersStarted, 0);
  } finally { f.restore(); }
});

test("menu/dialog calls retain lifetime ownership; explicit native surfaces preserve the supplied opaque target", async () => {
  const f = mounted();
  try {
    await f.find("menu-up").props.onClick();
    const menu = f.records.findLast(entry => entry.method === "openMenu")!;
    assert.equal(menu.props.preferredSide, "up"); assert.equal(menu.props.items[1].disabled, true);
    await menu.props.items[0].onSelect(); assert.equal(f.state("menus").selection, "first");
    await f.find("dialog-nested").props.onClick();
    assert.ok(f.root.querySelector('[data-showcase="dialog-nested"]'));
    const retained = f.find("dialog-nested-retained-field");
    await retained.props.rows[0].onChange("parent retained");
    await f.find("dialog-nested-child").props.onClick();
    assert.equal(retained.props.rows[0].value, "parent retained");
    assert.equal(f.records.filter(entry => entry.method === "openDialog").length, 2);
    // Opaque unit sentinel is passed unchanged; it is NOT valid for a real host.
    const sentinel = Object.freeze({});
    openSurfaceDemo(f.ui, sentinel as Parameters<typeof openSurfaceDemo>[1], f.controller.signal);
    const surface = f.records.findLast(entry => entry.method === "openSurface")!;
    assert.equal(surface.target, sentinel);
    await f.find("surface-nested").props.onClick();
    assert.equal(f.records.findLast(entry => entry.method === "openSurface")!.target, sentinel);
    f.controller.abort();
    assert.ok(f.records.every(entry => entry.disposed === 1));
    assert.equal(f.root.childElementCount, 0);
  } finally { f.restore(); }
});

test("gallery opens direct page surfaces with shared nested content and local close counts", async () => {
  const f = mounted();
  try {
    const open = f.find("open-surface");
    await open.props.onClick();
    const parent = f.records.findLast(entry => entry.method === "openSurface")!;
    assert.equal(Object.hasOwn(parent, "target"), false, "Direct opening must not supply or manufacture a target");
    assert.ok(parent.container.querySelector('[data-showcase="surface"]'));
    assert.deepEqual(f.state("surfaces"), { target: "current page", opens: 1, closed: 0, lastCallback: "openSurface (current page body)" });
    const retained = f.find("surface-parent-retained-field");
    await retained.props.rows[0].onChange("Kept under a child");
    await f.find("surface-nested").props.onClick();
    const child = f.records.findLast(entry => entry.method === "openSurface")!;
    assert.notEqual(child, parent);
    assert.equal(Object.hasOwn(child, "target"), false, "Nested direct opening uses the same two-argument public API");
    assert.ok(child.container.querySelector('[data-showcase="surface-nested"]'));
    assert.equal(retained.props.rows[0].value, "Kept under a child");
    assert.equal(retained.disposed, 0);
    await f.find("menu-up").props.onClick();
    assert.equal(f.records.findLast(entry => entry.method === "openMenu")!.props.preferredSide, "up");
    await f.find("dialog-ordinary").props.onClick();
    assert.ok(f.records.findLast(entry => entry.method === "openDialog")!.container.querySelector('[data-showcase="dialog-ordinary"]'));
    child.props.onClose(); child.handle.dispose();
    const parentState = JSON.parse(parent.container.querySelector('[data-state="surfaces"]')!.textContent!);
    assert.equal(parentState.nestedOpened, 1); assert.equal(parentState.nestedClosed, 1);
    parent.props.onClose(); parent.handle.dispose();
    assert.deepEqual(f.state("surfaces"), { target: "current page", opens: 1, closed: 1, lastCallback: "surface.onClose" });
    await open.props.onClick();
    assert.equal(f.state("surfaces").opens, 2);
    assert.equal(f.state("surfaces").closed, 1);
    assert.equal(f.find("surface-parent-retained-field").props.rows[0].value, "Retained local text");
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("surface family Reset disposes its direct overlays and stale controls/callbacks cannot reopen or change fresh state", async () => {
  const f = mounted();
  try {
    const reset = f.find("reset-surfaces"), open = f.find("open-surface");
    await open.props.onClick();
    const parent = f.records.findLast(entry => entry.method === "openSurface")!;
    const nested = f.find("surface-nested");
    await nested.props.onClick();
    const child = f.records.findLast(entry => entry.method === "openSurface")!;
    await reset.props.onClick();
    assert.ok(parent.signal.aborted && child.signal.aborted);
    assert.equal(parent.disposed, 1); assert.equal(child.disposed, 1);
    const count = f.records.length, initial = f.state("surfaces");
    await open.props.onClick(); await nested.props.onClick();
    parent.props.onClose(); child.props.onClose();
    assert.equal(f.records.length, count);
    assert.deepEqual(f.state("surfaces"), initial);
    assert.deepEqual(initial, { target: "current page", opens: 0, closed: 0, lastCallback: "none" });
    const fresh = f.find("open-surface");
    assert.notEqual(fresh, open);
    f.controller.abort();
    await fresh.props.onClick();
    assert.equal(f.records.length, count, "Aborted gallery lifetime rejects stale open callbacks");
    assert.ok(f.records.every(record => record.disposed === 1));
  } finally { f.restore(); }
});

test("aborted mount is empty; Scope cleanup is once-only including late-owned cleanup", () => {
  const f = createFixture();
  try {
    f.controller.abort();
    const cleanup = mountGallery(f.root, f.context, f.controller.signal); cleanup();
    assert.equal(f.records.length, 0); assert.equal(f.root.childElementCount, 0);
    const parent = new AbortController(), scope = new Scope(parent.signal);
    let calls = 0; scope.own(() => { calls++; }); parent.abort(); scope.dispose();
    assert.equal(calls, 1); scope.own(() => { calls++; }); assert.equal(calls, 2);
  } finally { f.restore(); }
});
