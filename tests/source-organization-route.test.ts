import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { after, it } from "node:test";
import { libraryRows } from "../src/core/tag-library.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-organization-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { GET, POST } = await import("../app/api/graph/sources/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { SOURCE_ORGANIZATION_FILE } = await import("../config.ts");
const change = (action: unknown) => POST(new Request("http://localhost/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
const sourceId = (filePath: string) => `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

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

it("GET projects practice kind without rewriting sessions, graph contributions or tags", async () => {
	const practice = stores.chatStore.createChat("Practice source", "practice");
	stores.graphStore.appendNode({ id: "n_practice", name: "Historical", statement: "Historical practice contribution.", aliases: [], createdAt: "2026-10-30", provenance: [{ chatId: practice.id, messageId: "m" }] });
	const folder = sourceDirectory.change({ action: "create-folder", name: "Practice folder", parentId: null }).createdFolderId!;
	const tag = sourceDirectory.change({ action: "create-tag", name: "Course", parentId: folder }).createdTagId!;
	sourceDirectory.change({ action: "tag-sources", sourceIds: [practice.id], add: [tag], remove: [] });
	const bytes = () => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
		const file = path.join(entry.parentPath, entry.name); return [file, fs.readFileSync(file).toString("hex")];
	}));
	const before = bytes(), directory = await (await GET()).json();
	assert.deepEqual(directory.sources.find((s: { id: string }) => s.id === practice.id), { id: practice.id, kind: "chat", chatKind: "practice", label: practice.title, createdAt: practice.createdAt });
	assert.deepEqual(directory.organization.placements[practice.id].tagIds, [tag]);
	assert.deepEqual(bytes(), before);
});

it("tag organization and renaming leave source IDs, original paths, graph ledgers and usage intact", async () => {
	const filePath = "Course/Sub/My_Notes.v2.pdf", id = sourceId(filePath);
	stores.graphStore.upsertSource({ id, filePath, importedAt: "2026-10-30T00:00:00Z", extractions: [] });
	const before = { nodes: stores.graphStore.readNodes(), chains: stores.graphStore.readChains(), source: stores.graphStore.readSources().find(s => s.id === id) };
	const folder = sourceDirectory.change({ action: "create-folder", name: "Library", parentId: null }).createdFolderId!;
	const tag = sourceDirectory.change({ action: "create-tag", name: "Course", parentId: folder }).createdTagId!;
	for (const action of [
		{ action: "tag-sources", sourceIds: [id], add: [tag], remove: [] },
		{ action: "update-tag", id: tag, name: "Course", parentId: null },
		{ action: "rename-source", id, name: "Renamed book" },
	]) assert.equal((await change(action)).status, 200);
	const directory = await (await GET()).json();
	assert.equal(directory.sources.find((s: { id: string }) => s.id === id).label, "Renamed book");
	assert.deepEqual(directory.organization.placements[id], { tagIds: [tag], name: "Renamed book" });
	assert.deepEqual(stores.graphStore.readNodes(), before.nodes); assert.deepEqual(stores.graphStore.readChains(), before.chains);
	assert.deepEqual(stores.graphStore.readSources().find(s => s.id === id), before.source);
});

it("session rename uses its existing title without activity churn", async () => {
	const chat = stores.chatStore.createChat("Original session");
	assert.equal((await change({ action: "rename-source", id: chat.id, name: "Edited session" })).status, 200);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Edited session");
	assert.equal(stores.chatStore.getChat(chat.id)?.updatedAt, chat.updatedAt);
});

it("refuses direct source moves and folder cycles; folder deletion depends only on tags and subfolders", async () => {
	const folder = sourceDirectory.change({ action: "create-folder", name: "Empty", parentId: null }).createdFolderId!;
	assert.equal((await change({ action: "move", kind: "folder", id: folder, parentId: folder })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: sourceId("Root/empty.md"), parentId: folder })).status, 400);
	const tag = sourceDirectory.change({ action: "create-tag", name: "Empty tag", parentId: folder }).createdTagId!;
	assert.equal((await change({ action: "delete-folder", id: folder })).status, 400);
	assert.equal((await change({ action: "update-tag", id: tag, name: "Empty tag", parentId: null })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: folder })).status, 200);
});

it("retained concepts keep their title and tags in the graph without leaving an invisible folder occupant", async () => {
	const { deleteChatSession } = await import("../src/server/chats.ts");
	const { folderEntries } = await import("../src/core/source-selection.ts");
	const chat = stores.chatStore.createChat("Synthetic retained lesson");
	stores.graphStore.appendNode({ id: "n_retained_folder", name: "Retained concept", statement: "A saved concept survives its conversation.", aliases: [], createdAt: "2026-11-07", provenance: [{ chatId: chat.id, messageId: "m1" }] });
	const parent = sourceDirectory.change({ action: "create-folder", name: "School", parentId: null }).createdFolderId!;
	const folder = sourceDirectory.change({ action: "create-folder", name: "Semester", parentId: parent }).createdFolderId!;
	const tag = sourceDirectory.change({ action: "create-tag", name: "Course", parentId: folder }).createdTagId!;
	sourceDirectory.change({ action: "tag-sources", sourceIds: [chat.id], add: [tag], remove: [] });
	assert.equal((await deleteChatSession(chat.id, "preserve-graph")).ok, true);
	const retainedGraph = stores.graphStore.readNodes();
	assert.ok(retainedGraph.some(node => node.id === "n_retained_folder"));
	const library = await (await GET(new Request("http://localhost/api/graph/sources?include=notes"))).json();
	assert.deepEqual(library.sources.find((source: { id: string }) => source.id === chat.id), { id: chat.id, kind: "missing", label: chat.title, createdAt: null });
	assert.deepEqual(library.organization.placements[chat.id].tagIds, [tag]);
	assert.deepEqual(folderEntries(library, folder).sources, [chat.id], "graph browsing still finds retained concepts through their tags");
	for (const scope of [{ kind: "all" }, { kind: "untagged" }, { kind: "folder", id: folder }, { kind: "tag", id: tag }] as const)
		assert.ok(!libraryRows(library, scope, "").some(row => row.source.id === chat.id), "deleted sessions are absent from Tags");
	assert.equal((await change({ action: "delete-folder", id: folder })).status, 400, "the visible Course tag is still in the folder");
	assert.equal((await change({ action: "delete-tag", id: tag })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: folder })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: parent })).status, 200);
	assert.deepEqual(stores.graphStore.readNodes(), retainedGraph, "removing tags and folders never deletes concepts");
	assert.equal(stores.chatStore.getChat(chat.id), null);
});

it("reads legacy direct placements without writing and persists the tag conversion on the next edit", async () => {
	const saved = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	const legacy = JSON.stringify({ version: 1, folders: [{ id: "old", name: "Old folder", parentId: null, createdAt: "now" }], placements: { gone: { folderId: "old" } } });
	try {
		fs.writeFileSync(SOURCE_ORGANIZATION_FILE, legacy);
		const first = await (await GET()).json(), second = await (await GET()).json();
		assert.deepEqual(first.organization, second.organization);
		assert.equal(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"), legacy);
		assert.equal(first.organization.version, 2);
		const general = first.organization.tags.find((tag: { name: string }) => tag.name === "General");
		assert.equal(general.parentId, "old");
		assert.deepEqual(first.organization.placements.gone.tagIds, [general.id]);
		assert.equal((await change({ action: "rename-folder", id: "old", name: "Renamed" })).status, 200);
		const written = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
		assert.equal(JSON.parse(written).version, 2);
		assert.doesNotMatch(written, /folderId/);
	} finally { fs.writeFileSync(SOURCE_ORGANIZATION_FILE, saved); }
});

it("malformed, oversized and failed streams refuse before metadata writes", async () => {
	const before = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	for (const request of [new Request("http://localhost/api/graph/sources", { method: "POST", body: "{" }), new Request("http://localhost/api/graph/sources", { method: "POST", body: "x".repeat(65537) }), new Request("http://localhost/api/graph/sources", { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("synthetic broken stream")); } }), duplex: "half" } as RequestInit)]) assert.equal((await POST(request)).status, 400);
	assert.equal(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"), before);
});

it("newer/corrupt data refuses reads and writes without overwriting its bytes", async () => {
	const before = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	try {
		for (const value of ["{", '{"version":3,"folders":[],"placements":{}}']) {
			fs.writeFileSync(SOURCE_ORGANIZATION_FILE, value);
			assert.equal((await GET()).status, 500);
			assert.equal((await change({ action: "create-folder", name: "Do not overwrite", parentId: null })).status, 500);
			assert.equal(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"), value);
		}
	} finally { fs.writeFileSync(SOURCE_ORGANIZATION_FILE, before); }
});

it("applies each file’s tag edits after successful extraction and preserves tags when reimport fails", async () => {
	const { POST: importFiles } = await import("../app/api/graph/import/route.ts");
	const { extraction } = await import("../src/server/index.ts");
	const original = extraction.importNotes;
	const tag = sourceDirectory.change({ action: "create-tag", name: "Course", parentId: null }).createdTagId!;
	const extra = sourceDirectory.change({ action: "create-tag", name: "Revision", parentId: null }).createdTagId!;
	const files = ["Unit/a.md", "Unit/b.md"];
	let failPath: string | undefined;
	extraction.importNotes = async ({ filePath }) => {
		if (filePath === failPath) throw new Error("Fixture extraction failure");
		stores.graphStore.upsertSource({ id: sourceId(filePath), filePath, importedAt: "now", extractions: [] });
		return { nodes: 0, chains: 0 };
	};
	async function upload(edits: { add: string[]; remove: string[] }[]) {
		const form = new FormData();
		for (const [i, file] of files.entries()) {
			form.append("files", new File(["Course material."], path.basename(file)));
			form.append("paths", file);
			form.append("tagChanges", JSON.stringify(edits[i]));
		}
		return importFiles(new Request("http://localhost/api/graph/import", { method: "POST", body: form }));
	}
	const foldersBefore = sourceDirectory.read().organization.folders;
	const selected = () => files.map(file => sourceDirectory.read().organization.placements[sourceId(file)]?.tagIds ?? []);
	try {
		const initial = await upload([{ add: [tag, extra], remove: [] }, { add: [tag], remove: [] }]);
		assert.ok((await initial.json()).results.every((r: { ok: boolean }) => r.ok));
		assert.deepEqual(selected(), [[tag, extra], [tag]]);
		assert.deepEqual(sourceDirectory.read().organization.folders, foldersBefore, "import paths do not silently create a parallel folder hierarchy");
		failPath = files[1];
		const reimport = await upload([{ add: [], remove: [tag] }, { add: [], remove: [tag] }]);
		assert.equal((await reimport.json()).results.filter((r: { ok: boolean }) => r.ok).length, 1);
		assert.deepEqual(selected(), [[extra], [tag]]);
		assert.equal((await upload([{ add: ["deleted"], remove: [] }, { add: [], remove: [] }])).status, 400);
		assert.deepEqual(selected(), [[extra], [tag]]);
	} finally { extraction.importNotes = original; }
});
