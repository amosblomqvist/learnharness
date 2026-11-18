import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import type { GraphNode } from "../src/core/index.ts";

// The sidebar's folder Delete (owner, 2026-11-18): the folder, its
// subfolders and every session inside go; imported notes inside move to the
// deleted folder's parent; the traces choice applies to every session.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-deletion-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { DELETE } = await import("../app/api/graph/sources/folders/[id]/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n"); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const remove = (id: string, mode: string | null) => DELETE(
	new Request(`http://localhost/api/graph/sources/folders/${id}${mode ? `?mode=${mode}` : ""}`, { method: "DELETE" }),
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
	assert.equal((await remove("nope", "preserve-graph")).status, 404);
});
