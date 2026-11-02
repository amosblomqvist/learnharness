import assert from "node:assert/strict";
import { it } from "node:test";
import { applyOrganizationAction, canMoveFolder, emptySourceOrganization, folderIsEmpty, parseOrganizationAction, parseSourceOrganization, placeImportedSource } from "../src/core/source-organization.ts";
import { sourceFileLabel } from "../src/core/source-label.ts";

let sequence = 0;
const fresh = () => ({ id: `folder_${++sequence}`, createdAt: "2026-10-30T00:00:00Z" });
const apply = (state: ReturnType<typeof emptySourceOrganization>, raw: unknown, ids = ["s1", "s2"]) => {
	const action = parseOrganizationAction(raw);
	assert.notEqual(action.action, "rename-source");
	return applyOrganizationAction(state, action as Exclude<typeof action, { action: "rename-source" }>, new Set(ids), fresh());
};

it("labels remove only the final extension, retaining spelling, punctuation and ordering prefixes", () => {
	for (const [path, label] of [["notes/09_chapter3normal.md", "09_chapter3normal"], ["My_Notes.v2.pdf", "My_Notes.v2"], ["x/a-b.txt", "a-b"], [".hidden", ".hidden"], ["README", "README"]]) assert.equal(sourceFileLabel(path!), label);
});

it("folder import builds only needed ancestors, distinguishing same basenames by source ID", () => {
	let state = placeImportedSource(emptySourceOrganization(), "s1", "Course/Week 1/notes.md", fresh);
	state = placeImportedSource(state, "s2", "Course/Week 2/notes.md", fresh);
	assert.deepEqual(state.folders.map((f) => f.importPath), ["Course", "Course/Week 1", "Course/Week 2"]);
	assert.notEqual(state.placements.s1?.folderId, state.placements.s2?.folderId);
	assert.equal(state.folders[1]?.parentId, state.folders[0]?.id);
	assert.deepEqual(parseSourceOrganization(state), state);
});

it("renames/moves preserve associations and re-import preserves individual names and placements", () => {
	let state = placeImportedSource(emptySourceOrganization(), "s1", "Course/Sub/a.md", fresh);
	const root = state.folders[0]!.id, sub = state.folders[1]!.id;
	state = apply(state, { action: "rename-folder", id: sub, name: "Renamed" });
	state = apply(state, { action: "move", kind: "folder", id: sub, parentId: null });
	state = apply(state, { action: "move", kind: "source", id: "s1", parentId: root });
	state.placements.s1!.name = "My title";
	assert.equal(placeImportedSource(state, "s1", "Course/Sub/a.md", fresh), state);
	state = placeImportedSource(state, "s2", "Course/Sub/b.md", fresh);
	assert.equal(state.placements.s2?.folderId, sub);
	assert.deepEqual(state.placements.s1, { folderId: root, name: "My title" });
	assert.equal(state.folders.find((f) => f.id === sub)?.name, "Renamed");
	assert.equal(state.folders.find((f) => f.id === sub)?.parentId, null);
});

it("reusing a moved subtree does not recreate unused deleted ancestors", () => {
	let state = placeImportedSource(emptySourceOrganization(), "s1", "Course/Sub/a.md", fresh);
	const root = state.folders[0]!.id, sub = state.folders[1]!.id;
	state = apply(state, { action: "move", kind: "folder", id: sub, parentId: null });
	state = apply(state, { action: "delete-folder", id: root });
	state = placeImportedSource(state, "s2", "Course/Sub/b.md", fresh);
	assert.equal(state.folders.length, 1);
	assert.equal(state.placements.s2?.folderId, sub);
});

it("cycles and missing parents are refused; moving never changes a source key", () => {
	let state = placeImportedSource(emptySourceOrganization(), "s1", "A/B/C/a.md", fresh);
	const [a, b, c] = state.folders.map((f) => f.id);
	assert.equal(canMoveFolder(state, a!, c!), false);
	assert.equal(canMoveFolder(state, a!, a!), false);
	assert.throws(() => apply(state, { action: "move", kind: "folder", id: a, parentId: c }), /descendants/);
	assert.throws(() => apply(state, { action: "move", kind: "source", id: "s1", parentId: "missing" }), /no longer exists/);
	state = apply(state, { action: "move", kind: "source", id: "s1", parentId: b });
	assert.deepEqual(Object.keys(state.placements), ["s1"]);
});

it("only structurally empty folders can be removed; an empty source record still makes a folder nonempty", () => {
	let state = placeImportedSource(emptySourceOrganization(), "s1", "A/B/a.md", fresh);
	const a = state.folders[0]!.id, b = state.folders[1]!.id;
	assert.equal(folderIsEmpty(state, b, new Set(["s1"])), false);
	assert.throws(() => apply(state, { action: "delete-folder", id: b }), /Only empty/);
	assert.throws(() => apply(state, { action: "delete-folder", id: a }), /Only empty/);
	state = apply(state, { action: "move", kind: "source", id: "s1", parentId: null });
	state = apply(state, { action: "delete-folder", id: b });
	assert.equal(state.folders.length, 1);
	assert.equal(state.placements.s1?.folderId, null);
});

it("action validation rejects invalid shapes, but trims nonempty names like session renaming", () => {
	for (const raw of [null, [], {}, { action: "create-folder", name: "", parentId: null }, { action: "create-folder", name: "x" }, { action: "move", kind: "node", id: "x", parentId: null }, { action: "rename-source", id: "x", name: 4 }]) assert.throws(() => parseOrganizationAction(raw));
	assert.deepEqual(parseOrganizationAction({ action: "rename-source", id: "s1", name: "  New name  " }), { action: "rename-source", id: "s1", name: "New name" });
});

it("corrupt/newer organization refuses instead of silently resetting or allowing cycles", () => {
	for (const raw of [{ version: 2, folders: [], placements: {} }, { version: 1, folders: [{ id: "a", name: "A", parentId: "a", createdAt: "x" }], placements: {} }, { version: 1, folders: [], placements: { s: { folderId: "gone" } } }]) assert.throws(() => parseSourceOrganization(raw), /invalid or newer/);
});
