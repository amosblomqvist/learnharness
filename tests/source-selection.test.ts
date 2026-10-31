import assert from "node:assert/strict";
import { it } from "node:test";
import { folderEntries, folderEntryCheck, toggleSourceEntries, type SourceDirectory, type SourceEntrySelection } from "../src/core/index.ts";
const directory: SourceDirectory = {
	organization: { version: 1, folders: [
		{ id: "outer", name: "Outer", parentId: null, createdAt: "now" },
		{ id: "inner", name: "Inner", parentId: "outer", createdAt: "now" },
		{ id: "empty", name: "Empty", parentId: "outer", createdAt: "now" },
	], placements: { a: { folderId: "inner" }, b: { folderId: "inner" } } },
	sources: ["a", "b", "outside"].map((id) => ({ id, kind: "notes", label: id, createdAt: "now" })),
};
const none = (): SourceEntrySelection => ({ sources: new Set(), folders: new Set() });
it("folders select all nested sources and empty subfolders, independent of graph contents", () => {
	assert.deepEqual(folderEntries(directory, "outer"), { sources: ["a", "b"], folders: ["outer", "inner", "empty"] });
	const selected = toggleSourceEntries(directory, none(), "folder", "outer", true);
	assert.deepEqual([...selected.sources], ["a", "b"]);
	assert.equal(folderEntryCheck(directory, "outer", selected).checked, true);
	assert.equal(selected.sources.has("outside"), false);
	assert.deepEqual(toggleSourceEntries(directory, selected, "folder", "outer", false), none());
});
it("individual source selection rolls up checks without selecting other sources that share its nodes", () => {
	let selected = toggleSourceEntries(directory, none(), "source", "a", true);
	assert.equal(selected.sources.has("b"), false);
	assert.deepEqual(folderEntryCheck(directory, "inner", selected), { checked: false, indeterminate: true });
	selected = toggleSourceEntries(directory, selected, "source", "b", true);
	assert.equal(folderEntryCheck(directory, "inner", selected).checked, true);
	assert.deepEqual(folderEntryCheck(directory, "outer", selected), { checked: false, indeterminate: true });
	selected = toggleSourceEntries(directory, selected, "folder", "empty", true);
	assert.equal(folderEntryCheck(directory, "outer", selected).checked, true);
	selected = toggleSourceEntries(directory, selected, "source", "a", false);
	assert.equal(selected.folders.has("inner"), false); assert.equal(selected.folders.has("outer"), false);
	assert.equal(selected.folders.has("empty"), true);
});
it("a folder containing only another empty folder is fully selectable", () => {
	const emptyTree = { ...directory, sources: [], organization: { ...directory.organization, placements: {} } };
	const selected = toggleSourceEntries(emptyTree, none(), "folder", "outer", true);
	assert.equal(folderEntryCheck(emptyTree, "outer", selected).checked, true);
	assert.equal(selected.folders.size, 3);
});
