import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { folderDeletionScope, type GraphNode } from "../src/core/index.ts";

// The sidebar's folder Delete (owner, 2026-11-18): the folder, its
// subfolders and every session inside go; imported notes inside move to the
// deleted folder's parent; the traces choice applies to every session.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-deletion-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { DELETE } = await import("../app/api/graph/sources/folders/[id]/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { deleteFolderWithSessions } = await import("../src/server/source-deletion.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n"); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const scopeOf = (id: string) => folderDeletionScope(sourceDirectory.read(), id);
const remove = (id: string, mode: string | null, scope: unknown = scopeOf(id)) => DELETE(
	new Request(`http://localhost/api/graph/sources/folders/${id}${mode ? `?mode=${mode}` : ""}`, {
		method: "DELETE", body: JSON.stringify(scope), headers: { "Content-Type": "application/json" },
	}),
	{ params: Promise.resolve({ id }) },
);
const node = (id: string, sources: string[]): GraphNode =>
	({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-10-30", provenance: sources.map((chatId) => ({ chatId, messageId: "m" })) });

function setup() {
	const teach = stores.chatStore.createChat("Inner teaching");
	const practice = stores.chatStore.createChat("Outer drill", "practice");
	const kept = stores.chatStore.createChat("Elsewhere");
	stores.graphStore.upsertSource({ id: "book", filePath: "book.md", importedAt: "2026-10-30" });
	stores.graphStore.appendNode(node("teach_only", [teach.id]));
	stores.graphStore.appendNode(node("shared", [teach.id, kept.id]));
	stores.graphStore.appendNode(node("book_only", ["book"]));
	stores.sourceOrganizationStore.write({ version: 1, folders: [
		{ id: "top", name: "Top", parentId: null, createdAt: "now" },
		{ id: "outer", name: "Outer", parentId: "top", createdAt: "now" },
		{ id: "inner", name: "Inner", parentId: "outer", createdAt: "now" },
		{ id: "side", name: "Side", parentId: "top", createdAt: "now" },
	], placements: {
		[teach.id]: { folderId: "inner" },
		[practice.id]: { folderId: "outer" },
		[kept.id]: { folderId: "side" },
		book: { folderId: "inner", name: "My book" },
	} });
	return { teach, practice, kept };
}

it("deletes the folder, its subfolders and every session inside; notes move to the parent; graph kept by default", async () => {
	const { teach, practice, kept } = setup();
	const response = await remove("outer", "preserve-graph");
	assert.equal(response.status, 200);
	const body = await response.json() as { deletedChatIds: string[]; graphRevision: number };
	assert.deepEqual(new Set(body.deletedChatIds), new Set([teach.id, practice.id]), "practice sessions go too");
	assert.equal(typeof body.graphRevision, "number");
	assert.equal(stores.chatStore.getChat(teach.id), null);
	assert.equal(stores.chatStore.getChat(practice.id), null);
	assert.ok(stores.chatStore.getChat(kept.id));
	const { organization } = sourceDirectory.read();
	assert.deepEqual(organization.folders.map((f) => f.id), ["top", "side"]);
	assert.deepEqual(organization.placements, { [kept.id]: { folderId: "side" }, book: { folderId: "top", name: "My book" } });
	assert.deepEqual(stores.graphStore.readNodes().map((n) => n.id).sort(), ["book_only", "shared", "teach_only"], "unchecked: the graph keeps their contributions");
});

it("with traces checked the sessions' graph traces go; shared topics and notes survive", async () => {
	const { teach } = setup();
	assert.equal((await remove("outer", "delete-nodes")).status, 200);
	const nodes = stores.graphStore.readNodes();
	assert.deepEqual(nodes.map((n) => n.id).sort(), ["book_only", "shared"]);
	assert.ok(nodes.every((n) => n.provenance.every((p) => p.chatId !== teach.id)));
});

it("a top-level folder's notes move to the top level", async () => {
	setup();
	assert.equal((await remove("top", "preserve-graph")).status, 200);
	const { organization } = sourceDirectory.read();
	assert.deepEqual(organization.folders, []);
	assert.deepEqual(organization.placements, { book: { folderId: null, name: "My book" } });
});

it("a running turn inside refuses with nothing deleted; the mode is required; unknown folders 404", async () => {
	const { teach, practice } = setup();
	const before = structuredClone(sourceDirectory.read().organization);
	beginTurn(teach.id);
	try {
		const response = await remove("outer", "delete-nodes");
		assert.equal(response.status, 409);
		const body = await response.json() as { error: string; code: string };
		assert.equal(body.code, "turn_in_flight");
		assert.match(body.error, /Inner teaching/);
	} finally { endTurn(teach.id); }
	assert.ok(stores.chatStore.getChat(teach.id) && stores.chatStore.getChat(practice.id));
	assert.deepEqual(sourceDirectory.read().organization, before);
	assert.equal(stores.graphStore.readNodes().length, 3);
	assert.equal((await remove("outer", null)).status, 400);
	assert.equal((await remove("nope", "preserve-graph", scopeOf("outer"))).status, 404);
});

it("rejects a stale confirmation even if a moved session was replaced and the count is unchanged", async () => {
	const { teach, practice, kept } = setup();
	const reviewed = scopeOf("outer")!;
	sourceDirectory.change({ action: "move", kind: "source", id: teach.id, parentId: "side" });
	sourceDirectory.change({ action: "move", kind: "source", id: kept.id, parentId: "inner" });
	assert.equal(scopeOf("outer")!.chatIds.length, reviewed.chatIds.length);
	const response = await remove("outer", "delete-nodes", reviewed);
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "folder_scope_changed");
	assert.ok([teach, practice, kept].every((chat) => stores.chatStore.getChat(chat.id)));
	assert.deepEqual(sourceDirectory.read().organization.folders.map((f) => f.id), ["top", "outer", "inner", "side"]);
	assert.equal(stores.graphStore.readNodes().length, 3);
	assert.equal((await remove("outer", "preserve-graph")).status, 200, "a freshly reviewed scope can be deleted");
	assert.ok(stores.chatStore.getChat(teach.id), "the moved-out chat survives");
});

it("requires a scope and protects the no-confirmation path for a folder that gained a session", async () => {
	const { kept } = setup();
	const state = sourceDirectory.read().organization;
	state.folders.push({ id: "empty", name: "Empty", parentId: null, createdAt: "now" });
	stores.sourceOrganizationStore.write(state);
	const empty = scopeOf("empty")!;
	assert.deepEqual(empty.chatIds, []);
	assert.equal((await remove("empty", "preserve-graph", null)).status, 400);
	sourceDirectory.change({ action: "move", kind: "source", id: kept.id, parentId: "empty" });
	assert.equal((await remove("empty", "preserve-graph", empty)).status, 409);
	assert.ok(stores.chatStore.getChat(kept.id));
	sourceDirectory.change({ action: "move", kind: "source", id: kept.id, parentId: "side" });
	assert.equal((await remove("empty", "preserve-graph", empty)).status, 200, "unchanged empty scopes still delete immediately");
});

it("rechecks after yielding for extraction wind-down, before starting destructive writes", async () => {
	const { teach, practice, kept } = setup();
	const pending = deleteFolderWithSessions("outer", "delete-nodes", scopeOf("outer"));
	// The initial guard ran synchronously. Mutate before the continuation resumes.
	sourceDirectory.change({ action: "move", kind: "source", id: kept.id, parentId: "inner" });
	await assert.rejects(pending, { status: 409, code: "folder_scope_changed" });
	assert.ok([teach, practice, kept].every((chat) => stores.chatStore.getChat(chat.id)));
	assert.equal(stores.graphStore.readNodes().length, 3);
});
