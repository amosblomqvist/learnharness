import assert from "node:assert/strict";
import { it } from "node:test";
import { applyOrganizationAction, canMoveFolder, chainSourceDirectory, emptySourceOrganization, folderIsEmpty, parseOrganizationAction, parseSourceOrganization } from "../src/core/source-organization.ts";
import { sourceFileLabel } from "../src/core/source-label.ts";
let sequence = 0;
const apply = (state: ReturnType<typeof emptySourceOrganization>, raw: unknown) => {
	const action = parseOrganizationAction(raw);
	if (action.action === "rename-source") throw new Error("Use the server rename path");
	return applyOrganizationAction(state, action, new Set(["a", "b"]), { id: `item_${++sequence}`, createdAt: "now" });
};
it("labels remove only the final extension, retaining spelling, punctuation and ordering prefixes", () => {
	for (const [path, label] of [["notes/09_chapter3normal.md", "09_chapter3normal"], ["My_Notes.v2.pdf", "My_Notes.v2"], ["x/a-b.txt", "a-b"], [".hidden", ".hidden"], ["README", "README"]]) assert.equal(sourceFileLabel(path!), label);
});
it("migrates direct folder placements to stable General tags without mutating existing data or losing memberships", () => {
	const legacy = { version: 1, folders: [
		{ id: "school", name: "School", parentId: null, createdAt: "now" },
		{ id: "course", name: "Course", parentId: "school", createdAt: "now", importPath: "School/Course" },
	], tags: [{ id: "review", name: "Review", parentId: null }], placements: {
		a: { folderId: "course", tagIds: ["review"], name: "Original title" }, b: { folderId: "course" }, c: { folderId: null },
	} };
	const before = structuredClone(legacy), migrated = parseSourceOrganization(legacy);
	assert.deepEqual(legacy, before);
	assert.deepEqual(parseSourceOrganization(legacy), migrated);
	assert.deepEqual(parseSourceOrganization(migrated), migrated);
	assert.equal(migrated.version, 2);
	const general = migrated.tags!.find(t => t.name === "General")!;
	assert.equal(general.parentId, "course");
	assert.deepEqual(migrated.placements.a, { tagIds: ["review", general.id], name: "Original title" });
	assert.deepEqual(migrated.placements.b, { tagIds: [general.id] });
	assert.deepEqual(migrated.placements.c, {});
	assert.deepEqual(migrated.folders, legacy.folders);
	assert.doesNotMatch(JSON.stringify(migrated), /folderId/);
});
it("reuses an existing General tag in the same folder and avoids colliding with unrelated IDs", () => {
	const folders = [{ id: "f", name: "Folder", parentId: null, createdAt: "now" }];
	const legacy = { version: 1, folders, tags: [{ id: "existing", name: "General", parentId: "f" }], placements: { a: { folderId: "f", tagIds: ["existing"] } } };
	const state = parseSourceOrganization(legacy);
	assert.equal(state.tags!.length, 1);
	assert.deepEqual(state.placements.a?.tagIds, ["existing"]);
	const collision = parseSourceOrganization({ ...legacy, tags: [{ id: "tag_folder_f", name: "Other", parentId: null }], placements: { a: { folderId: "f" } } });
	assert.equal(new Set(collision.tags!.map(t => t.id)).size, 2);
	assert.notEqual(collision.placements.a?.tagIds![0], "tag_folder_f");
});
it("folders contain only tags and subfolders; removing a tag leaves material untagged without deleting it", () => {
	let state = apply(emptySourceOrganization(), { action: "create-folder", name: "School", parentId: null });
	const folder = state.folders[0]!.id;
	state = apply(state, { action: "create-tag", name: "Math", parentId: folder });
	const tag = state.tags![0]!.id;
	state = apply(state, { action: "tag-sources", sourceIds: ["a", "b"], add: [tag], remove: [] });
	assert.equal(folderIsEmpty(state, folder), false);
	assert.throws(() => apply(state, { action: "delete-folder", id: folder }), /tags and subfolders/);
	assert.throws(() => apply(state, { action: "move", kind: "source", id: "a", parentId: folder }), /Invalid move/);
	state = apply(state, { action: "delete-tag", id: tag });
	assert.deepEqual(state.placements, { a: { tagIds: [] }, b: { tagIds: [] } });
	assert.equal(folderIsEmpty(state, folder), true);
	state = apply(state, { action: "delete-folder", id: folder });
	assert.deepEqual(state.folders, []);
});
it("moving a tag changes its hierarchy without changing material IDs or memberships; folder cycles remain invalid", () => {
	let state = apply(emptySourceOrganization(), { action: "create-folder", name: "Outer", parentId: null });
	const outer = state.folders[0]!.id;
	state = apply(state, { action: "create-folder", name: "Inner", parentId: outer });
	const inner = state.folders[1]!.id;
	assert.equal(canMoveFolder(state, outer, inner), false);
	assert.throws(() => apply(state, { action: "move", kind: "folder", id: outer, parentId: inner }), /descendants/);
	state = apply(state, { action: "create-tag", name: "Course", parentId: inner });
	const tag = state.tags![0]!.id;
	state = apply(state, { action: "tag-sources", sourceIds: ["a"], add: [tag], remove: [] });
	const placements = structuredClone(state.placements);
	state = apply(state, { action: "update-tag", id: tag, name: "Course", parentId: null });
	assert.deepEqual(state.placements, placements);
	assert.equal(folderIsEmpty(state, inner), true);
});
it("chains projection hides only practice sessions and preserves the shared organization", () => {
	const directory = { organization: emptySourceOrganization(), sources: [
		{ id: "practice", kind: "chat" as const, chatKind: "practice" as const, label: "Practice", createdAt: "now" },
		{ id: "teach", kind: "chat" as const, label: "Teach", createdAt: "now" },
		{ id: "retained", kind: "missing" as const, label: "Retained lesson", createdAt: null },
	] };
	const before = structuredClone(directory), view = chainSourceDirectory(directory);
	assert.deepEqual(view.sources.map(s => s.id), ["teach", "retained"]);
	assert.equal(view.organization, directory.organization);
	assert.deepEqual(directory, before);
});
it("rejects invalid actions and corrupt or newer organization without silently dropping data", () => {
	for (const raw of [null, [], {}, { action: "create-folder", name: "", parentId: null }, { action: "create-folder", name: "x" }, { action: "move", kind: "source", id: "x", parentId: null }, { action: "rename-source", id: "x", name: 4 }]) assert.throws(() => parseOrganizationAction(raw));
	assert.deepEqual(parseOrganizationAction({ action: "rename-source", id: "a", name: "  New name  " }), { action: "rename-source", id: "a", name: "New name" });
	for (const raw of [
		{ version: 3, folders: [], placements: {} },
		{ version: 1, folders: [{ id: "a", name: "A", parentId: "a", createdAt: "x" }], placements: {} },
		{ version: 1, folders: [], placements: { a: { folderId: "gone" } } },
		{ version: 2, folders: [], placements: { a: { folderId: null } } },
		{ version: 2, folders: [], placements: { a: { tagIds: ["gone"] } } },
	]) assert.throws(() => parseSourceOrganization(raw), /invalid or newer/);
});
