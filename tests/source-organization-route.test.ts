import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { after, it } from "node:test";
import type { ChatListItem } from "../src/core/contracts/chat.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-organization-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { GET, POST } = await import("../app/api/graph/sources/route.ts");
const { GET: GET_CHATS } = await import("../app/api/chats/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { SOURCE_ORGANIZATION_FILE, GRAPH_FORMAT_FILE } = await import("../config.ts");
const { CURRENT_GRAPH_FORMAT_VERSION } = await import("../src/core/contracts/graph.ts");
const change = (action: unknown) => POST(new Request("http://localhost/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
const sourceId = (filePath: string) => `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

it("chats GET returns empty organization without creating graph files", async () => {
	const chatsFirst = await GET_CHATS();
	assert.equal(chatsFirst.status, 200);
	const chatsFirstBody = await chatsFirst.json();
	assert.deepEqual(chatsFirstBody.chats, []);
	assert.deepEqual(chatsFirstBody.organization, { folders: [], placements: {} });
	assert.equal(fs.existsSync(SOURCE_ORGANIZATION_FILE), false);
	assert.equal(fs.existsSync(GRAPH_FORMAT_FILE), false);
});

it("GET is a non-writing read and inventories all sessions, imported records and missing provenance", async () => {
	const before = await GET(); assert.equal(before.status, 200);
	assert.deepEqual((await before.json()).sources, []);
	assert.equal(fs.existsSync(SOURCE_ORGANIZATION_FILE), false);
	const chat = stores.chatStore.createChat("Unextracted session");
	stores.graphStore.upsertSource({ id: sourceId("Root/empty.md"), filePath: "Root/empty.md", importedAt: "2026-10-30T00:00:00Z" });
	stores.graphStore.appendNode({ id: "n_orphan", name: "Orphan", statement: "A record is missing.", aliases: [], createdAt: "2026-10-30T00:00:00Z", provenance: [{ chatId: "gone", messageId: "m1" }] });
	const { sources } = await (await GET()).json();
	assert.equal(sources.find((s: { id: string }) => s.id === chat.id).label, "Unextracted session");
	assert.equal(sources.find((s: { id: string }) => s.id === chat.id).chatKind, "teach", "absent persisted kind still means teaching");
	assert.equal(sources.find((s: { kind: string }) => s.kind === "notes").label, "empty");
	assert.equal(sources.find((s: { id: string }) => s.id === "gone").kind, "missing");
});

it("GET projects practice kind without removing or rewriting sessions, historical graph contributions or folder placements", async () => {
	const practice = stores.chatStore.createChat("Practice source", "practice");
	stores.graphStore.appendNode({ id: "n_practice", name: "Historical", statement: "Historical practice contribution.", aliases: [], createdAt: "2026-10-30", provenance: [{ chatId: practice.id, messageId: "m" }] });
	const created = await (await change({ action: "create-folder", name: "Practice folder", parentId: null })).json();
	assert.equal((await change({ action: "move", kind: "source", id: practice.id, parentId: created.createdFolderId })).status, 200);
	const bytes = () => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
		const file = path.join(entry.parentPath, entry.name); return [file, fs.readFileSync(file).toString("hex")];
	}));
	const before = bytes();
	const directory = await (await GET()).json();
	assert.deepEqual(directory.sources.find((s: { id: string }) => s.id === practice.id), { id: practice.id, kind: "chat", chatKind: "practice", label: practice.title, createdAt: practice.createdAt });
	assert.equal(directory.organization.placements[practice.id].folderId, created.createdFolderId);
	assert.deepEqual(bytes(), before);
});

it("rename/move operations persist independently without changing source IDs, paths, graph ledgers or usage", async () => {
	const filePath = "Course/Sub/My_Notes.v2.pdf", id = sourceId(filePath);
	sourceDirectory.registerImport(filePath);
	stores.graphStore.upsertSource({ id, filePath, importedAt: "2026-10-30T00:00:00Z", extractions: [] });
	const before = { nodes: stores.graphStore.readNodes(), chains: stores.graphStore.readChains(), source: stores.graphStore.readSources().find((s) => s.id === id) };
	let directory = await (await GET()).json();
	const sub = directory.organization.folders.find((f: { importPath?: string }) => f.importPath === "Course/Sub");
	for (const action of [{ action: "rename-folder", id: sub.id, name: "Renamed directory" }, { action: "move", kind: "folder", id: sub.id, parentId: null }, { action: "rename-source", id, name: "Renamed book" }]) assert.equal((await change(action)).status, 200);
	sourceDirectory.registerImport(filePath);
	sourceDirectory.registerImport("Course/Sub/new.txt");
	directory = await (await GET()).json();
	assert.equal(directory.sources.find((s: { id: string }) => s.id === id).label, "Renamed book");
	assert.equal(directory.organization.placements[sourceId("Course/Sub/new.txt")].folderId, sub.id);
	assert.equal(directory.organization.folders.find((f: { id: string }) => f.id === sub.id).parentId, null);
	assert.deepEqual(stores.graphStore.readNodes(), before.nodes); assert.deepEqual(stores.graphStore.readChains(), before.chains);
	assert.deepEqual(stores.graphStore.readSources().find((s) => s.id === id), before.source);
	assert.ok(fs.existsSync(SOURCE_ORGANIZATION_FILE));
});

it("session rename uses its existing title without activity churn; existing root source placement survives reimport", async () => {
	const chat = stores.chatStore.createChat("Original session");
	const response = await change({ action: "rename-source", id: chat.id, name: "Edited session" }); assert.equal(response.status, 200);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Edited session");
	assert.equal(stores.chatStore.getChat(chat.id)?.updatedAt, chat.updatedAt);
	const id = sourceId("Root/empty.md");
	sourceDirectory.registerImport("Root/empty.md");
	assert.equal(stores.sourceOrganizationStore.read().placements[id]?.folderId, null);
	assert.ok(!stores.sourceOrganizationStore.read().folders.some((f) => f.importPath === "Root"));
});

it("server validates cycles, stale sources/parents and nonempty folders, including zero-node files", async () => {
	const created = await (await change({ action: "create-folder", name: "Empty", parentId: null })).json();
	const folder = created.organization.folders.find((f: { name: string }) => f.name === "Empty");
	assert.equal(created.createdFolderId, folder.id, "creation identifies the exact new row, even with duplicate folder names");
	assert.equal((await change({ action: "move", kind: "folder", id: folder.id, parentId: folder.id })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: "unknown", parentId: folder.id })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: sourceId("Root/empty.md"), parentId: folder.id })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: folder.id })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: sourceId("Root/empty.md"), parentId: null })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: folder.id })).status, 200);
});

it("malformed, oversized and failed streams refuse before metadata writes", async () => {
	const before = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	for (const request of [new Request("http://localhost/api/graph/sources", { method: "POST", body: "{" }), new Request("http://localhost/api/graph/sources", { method: "POST", body: "x".repeat(65537) }), new Request("http://localhost/api/graph/sources", { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("synthetic broken stream")); } }), duplex: "half" } as RequestInit)]) assert.equal((await POST(request)).status, 400);
	assert.equal(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"), before);
});

it("newer/corrupt data refuses reads and writes without overwriting its bytes", async () => {
	const before = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	try {
		for (const value of ["{", '{"version":2,"folders":[],"placements":{}}']) {
			fs.writeFileSync(SOURCE_ORGANIZATION_FILE, value);
			assert.equal((await GET()).status, 500);
			assert.equal((await change({ action: "create-folder", name: "Do not overwrite", parentId: null })).status, 500);
			const chatsRes = await GET_CHATS();
			assert.equal(chatsRes.status, 200);
			const chatsBody = await chatsRes.json();
			assert.ok(Array.isArray(chatsBody.chats) && chatsBody.chats.length > 0);
			assert.equal(chatsBody.organization, null);
			assert.equal(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"), value);
		}
	} finally { fs.writeFileSync(SOURCE_ORGANIZATION_FILE, before); }
});

it("chats GET projects folders and chat placements from the shared organization store", async () => {
	const parent = (await (await change({ action: "create-folder", name: "Algebra", parentId: null })).json()).createdFolderId;
	const child = (await (await change({ action: "create-folder", name: "Week 1", parentId: parent })).json()).createdFolderId;
	const teach = stores.chatStore.createChat("Placed teaching session");
	const practice = stores.chatStore.createChat("Placed practice session", "practice");
	const unplaced = stores.chatStore.createChat("Unplaced session");
	assert.equal((await change({ action: "move", kind: "source", id: teach.id, parentId: child })).status, 200);
	assert.equal((await change({ action: "move", kind: "source", id: practice.id, parentId: parent })).status, 200);

	const body = await (await GET_CHATS()).json();
	const byId = new Map<string, ChatListItem>((body.chats as ChatListItem[]).map((chat) => [chat.id, chat]));
	for (const id of [teach.id, practice.id, unplaced.id]) {
		const item = byId.get(id);
		assert.ok(item);
		assert.equal(typeof item.busy, "boolean");
		assert.equal(typeof item.compacting, "boolean");
	}
	assert.equal(byId.get(teach.id)?.kind, "teach");
	assert.equal(byId.get(practice.id)?.kind, "practice");

	const org = body.organization;
	assert.ok(org);
	assert.deepEqual(org.placements[teach.id], { folderId: child });
	assert.deepEqual(org.placements[practice.id], { folderId: parent });
	assert.equal(Object.hasOwn(org.placements, unplaced.id), false);

	const directory = await (await GET()).json();
	const project = ({ id, name, parentId, createdAt }: { id: string; name: string; parentId: string | null; createdAt: string }) => ({ id, name, parentId, createdAt });
	assert.deepEqual(org.folders, directory.organization.folders.map(project));
	assert.equal(directory.organization.placements[teach.id].folderId, child);

	assert.equal((await change({ action: "move", kind: "source", id: teach.id, parentId: null })).status, 200);
	const moved = await (await GET_CHATS()).json();
	assert.deepEqual(moved.organization.placements[teach.id], { folderId: null });
	assert.equal(Object.hasOwn(moved.organization.placements, unplaced.id), false);
});

it("chats GET omits placements of imported sources and deleted chats while folders survive", async () => {
	const filePath = "Mixed/Shared Notes.md";
	const src = sourceId(filePath);
	sourceDirectory.registerImport(filePath);
	stores.graphStore.upsertSource({ id: src, filePath, importedAt: "2026-11-19T00:00:00Z" });
	const doomed = stores.chatStore.createChat("Soon deleted");
	const mixed = stores.sourceOrganizationStore.read().folders.find((f) => f.importPath === "Mixed");
	assert.ok(mixed);
	assert.equal((await change({ action: "move", kind: "source", id: doomed.id, parentId: mixed.id })).status, 200);
	assert.equal(stores.chatStore.deleteChat(doomed.id), true);

	const directory = await (await GET()).json();
	assert.equal(directory.organization.placements[src].folderId, mixed.id);
	assert.equal(directory.organization.placements[doomed.id].folderId, mixed.id);

	const body = await (await GET_CHATS()).json();
	const org = body.organization;
	assert.ok(org);
	assert.equal(Object.hasOwn(org.placements, src), false);
	assert.equal(Object.hasOwn(org.placements, doomed.id), false);
	assert.equal(body.chats.some((c: { id: string }) => c.id === doomed.id), false);
	assert.ok(org.folders.some((f: { id: string }) => f.id === mixed.id));
});

it("a newer graph-format stamp refuses the organization read while chats still list", async () => {
	const stampExisted = fs.existsSync(GRAPH_FORMAT_FILE);
	const stampBytes = stampExisted ? fs.readFileSync(GRAPH_FORMAT_FILE) : null;
	const orgBytes = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	fs.mkdirSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true });
	const futureStamp = JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION + 1 });

	try {
		fs.rmSync(SOURCE_ORGANIZATION_FILE);
		fs.writeFileSync(GRAPH_FORMAT_FILE, futureStamp);

		const res = await GET_CHATS();
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.chats) && body.chats.length > 0);
		assert.equal(body.organization, null);
		assert.equal(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8"), futureStamp);
		assert.equal(fs.existsSync(SOURCE_ORGANIZATION_FILE), false);
	} finally {
		fs.writeFileSync(SOURCE_ORGANIZATION_FILE, orgBytes);
		if (stampBytes === null) fs.rmSync(GRAPH_FORMAT_FILE, { force: true });
		else fs.writeFileSync(GRAPH_FORMAT_FILE, stampBytes);
	}
});

it("chats GET reads organization without touching graph nodes, chains or imported sources", async (t) => {
	const boom = () => { throw new Error("graph read must not run"); };
	t.mock.method(stores.graphStore, "readNodes", boom);
	t.mock.method(stores.graphStore, "readChains", boom);
	t.mock.method(stores.graphStore, "readSources", boom);
	const res = await GET_CHATS();
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.ok(Array.isArray(body.chats));
	assert.ok(body.organization);
	assert.ok(body.organization.folders.length > 0);
	assert.ok(Object.keys(body.organization.placements).length > 0);
});
