import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PluginTreeRow } from "learnharness-plugin-api";
import { mountGallery } from "../src/gallery.ts";
import { createFixture, type MountRecord } from "./fixture.ts";

const defaults = { selectionEnabled: false, selectedOccurrenceKeys: [], expanded: { "example-folder": true, "another-folder": true }, draft: "Local draft", lastCallback: "none" };
function mounted() {
  const f = createFixture(); const dispose = mountGallery(f.root, f.context, f.controller.signal);
  return { ...f, dispose };
}
function rows(tree: MountRecord): PluginTreeRow[] {
  const all: PluginTreeRow[] = [];
  const visit = (entries: readonly PluginTreeRow[]) => { for (const row of entries) { all.push(row); if (row.children) visit(row.children); } };
  visit(tree.props.rows); return all;
}
function occurrence(tree: MountRecord, key: string): PluginTreeRow {
  const row = rows(tree).find(row => row.key === key); assert.ok(row, key); return row;
}
function edit(input: HTMLInputElement, value: string): void {
  input.value = value;
  const event = input.ownerDocument.createEvent("Event"); event.initEvent("input", true, false); input.dispatchEvent(event);
}

test("directory fixture mounts only the public tree with optional controls, compact metadata and caller-owned scroll width", () => {
  const f = mounted();
  try {
    const tree = f.find("tree", "mountTree");
    assert.equal(tree.props.label, "Directory example"); assert.equal(tree.props.header, "Name");
    assert.deepEqual(tree.props.columns, [{ key: "kind", header: "Kind", width: 56 }, { key: "state", header: "State", width: 80 }]);
    assert.deepEqual(rows(tree).map(row => row.key), ["example-folder", "example-folder/shared-item", "example-folder/draft-note", "another-folder", "another-folder/shared-item"]);
    assert.equal(rows(tree).filter(row => row.content === "Shared item").length, 2, "one logical fixture item has independent occurrences");
    assert.ok(rows(tree).every(row => row.selection === undefined));
    assert.equal(typeof occurrence(tree, "example-folder/draft-note").content, "function");
    assert.deepEqual(f.state("tree"), defaults); assert.equal(f.find("toggle-tree-selection").props.label, "Enable selection");
    assert.equal(tree.container.style.minWidth, "36rem"); assert.equal(tree.container.parentElement!.style.overflowX, "auto");
    assert.equal(f.root.querySelector('input[aria-label="Directory draft"]')?.getAttribute("type"), "text");
    assert.deepEqual(f.calls, []);
    const source = readFileSync(new URL("../src/tree.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /addEventListener\(["'](?:keydown|keyup|keypress)|chain-navigation|tree-presentation|components\//, "row navigation and presentation are host-owned, not copied by the plugin");
  } finally { f.restore(); }
});

test("selection callbacks are occurrence-local without parent cascade and survive hiding/re-enabling checkboxes", async () => {
  const f = mounted();
  try {
    const tree = f.find("tree"); const factory = occurrence(tree, "example-folder/draft-note").content;
    await f.find("toggle-tree-selection").props.onClick();
    assert.equal(f.state("tree").selectionEnabled, true); assert.equal(f.find("toggle-tree-selection").props.label, "Disable selection");
    assert.ok(rows(tree).every(row => row.selection?.checked === false));
    const first = occurrence(tree, "example-folder/shared-item").selection!;
    await first.onChange(true);
    assert.deepEqual(f.state("tree").selectedOccurrenceKeys, ["example-folder/shared-item"]);
    assert.equal(occurrence(tree, "another-folder/shared-item").selection!.checked, false);
    assert.equal(occurrence(tree, "example-folder").selection!.checked, false, "child selection never cascades upward");
    await occurrence(tree, "example-folder").selection!.onChange(true);
    assert.equal(occurrence(tree, "example-folder/draft-note").selection!.checked, false, "parent selection never cascades downward");
    await occurrence(tree, "another-folder/shared-item").selection!.onChange(true);
    await occurrence(tree, "example-folder/shared-item").selection!.onChange(false);
    assert.deepEqual(f.state("tree").selectedOccurrenceKeys, ["example-folder", "another-folder/shared-item"]);
    await f.find("toggle-tree-selection").props.onClick();
    assert.equal(f.state("tree").selectionEnabled, false); assert.ok(rows(tree).every(row => row.selection === undefined));
    assert.deepEqual(f.state("tree").selectedOccurrenceKeys, ["example-folder", "another-folder/shared-item"]);
    const hidden = f.state("tree"); await first.onChange(true); assert.deepEqual(f.state("tree"), hidden, "a held hidden selection callback is inert");
    await f.find("toggle-tree-selection").props.onClick();
    assert.equal(occurrence(tree, "example-folder").selection!.checked, true);
    assert.equal(occurrence(tree, "another-folder/shared-item").selection!.checked, true);
    assert.equal(occurrence(tree, "example-folder/shared-item").selection!.checked, false);
    assert.equal(occurrence(tree, "example-folder/draft-note").content, factory);
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("the stable rich factory retains the local draft through updates, while collapse cleans its mount and expansion restores the value", async () => {
  const f = mounted();
  try {
    const tree = f.find("tree"); const factory = occurrence(tree, "example-folder/draft-note").content;
    const input = f.root.querySelector<HTMLInputElement>('input[aria-label="Directory draft"]')!;
    const firstMount = tree.treeContents[0]!;
    edit(input, "  retained local draft  ");
    assert.equal(f.state("tree").draft, "  retained local draft  "); assert.equal(f.state("tree").lastCallback, "draft.onInput");
    await f.find("toggle-tree-selection").props.onClick();
    await occurrence(tree, "another-folder").disclosure!.onChange(false);
    assert.equal(f.root.querySelector('input[aria-label="Directory draft"]'), input);
    assert.equal(occurrence(tree, "example-folder/draft-note").content, factory);
    assert.equal(tree.treeContents.length, 1); assert.equal(firstMount.signal.aborted, false);
    await occurrence(tree, "example-folder").disclosure!.onChange(false);
    assert.equal(f.root.querySelector('input[aria-label="Directory draft"]'), null);
    assert.equal(firstMount.signal.aborted, true); assert.equal(firstMount.disposed, 1);
    assert.equal(f.state("tree").draft, "  retained local draft  ");
    assert.deepEqual(f.state("tree").expanded, { "example-folder": false, "another-folder": false });
    edit(input, "obsolete detached edit"); assert.equal(f.state("tree").draft, "  retained local draft  ", "unmounted content removes its listener");
    await occurrence(tree, "example-folder").disclosure!.onChange(true);
    const restored = f.root.querySelector<HTMLInputElement>('input[aria-label="Directory draft"]')!;
    assert.notEqual(restored, input); assert.equal(restored.value, "  retained local draft  ");
    assert.equal(tree.treeContents.length, 2); assert.equal(tree.treeContents[1]!.signal.aborted, false);
    assert.equal(occurrence(tree, "example-folder/draft-note").content, factory);
    assert.equal(tree.props.rows[0].cells.state, "Expanded");
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("family Reset restores only tree defaults and fences old callbacks and rich factories", async () => {
  const f = mounted();
  try {
    const old = f.find("tree"), composer = f.find("composer");
    await composer.props.onChange("unrelated composer draft");
    const oldInput = f.root.querySelector<HTMLInputElement>('input[aria-label="Directory draft"]')!; edit(oldInput, "temporary tree draft");
    await f.find("toggle-tree-selection").props.onClick();
    const select = occurrence(old, "another-folder/shared-item").selection!.onChange;
    await select(true);
    const disclosure = occurrence(old, "example-folder").disclosure!.onChange;
    const factory = occurrence(old, "example-folder/draft-note").content;
    assert.equal(typeof factory, "function");
    await disclosure(false); const toggle = f.find("toggle-tree-selection").props.onClick;
    await f.find("reset-tree").props.onClick();
    const current = f.find("tree"); assert.notEqual(current, old);
    assert.equal(old.signal.aborted, true); assert.equal(old.disposed, 1); assert.ok(old.treeContents.every(content => content.disposed === 1 && content.signal.aborted));
    assert.deepEqual(f.state("tree"), defaults); assert.equal(f.root.querySelector<HTMLInputElement>('input[aria-label="Directory draft"]')!.value, "Local draft");
    assert.equal(f.find("composer"), composer); assert.equal(f.state("composer").draft, "unrelated composer draft");
    await select(false); await disclosure(true); await toggle(); edit(oldInput, "obsolete edit");
    assert.deepEqual(f.state("tree"), defaults);
    const staleContainer = document.createElement("div");
    if (typeof factory === "function") { const dispose = await factory(staleContainer, new AbortController().signal); dispose?.(); }
    assert.equal(staleContainer.childElementCount, 0, "old family factories cannot mount content after Reset");
    assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});

test("view abort disposes current tree content once and ignores every held local callback", async () => {
  const f = mounted();
  try {
    const tree = f.find("tree"); await f.find("toggle-tree-selection").props.onClick();
    const select = occurrence(tree, "example-folder").selection!.onChange;
    const disclosure = occurrence(tree, "example-folder").disclosure!.onChange;
    const toggle = f.find("toggle-tree-selection").props.onClick;
    const input = f.root.querySelector<HTMLInputElement>('input[aria-label="Directory draft"]')!;
    const readout = f.root.querySelector('[data-state="tree"]')!; const before = readout.textContent;
    f.controller.abort(); f.dispose();
    assert.equal(tree.disposed, 1); assert.ok(tree.treeContents.every(content => content.disposed === 1 && content.signal.aborted));
    assert.equal(f.root.childElementCount, 0);
    await select(true); await disclosure(false); await toggle(); edit(input, "late edit");
    assert.equal(readout.textContent, before); assert.deepEqual(f.calls, []);
  } finally { f.restore(); }
});
