import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudyMaterials } from "../src/server/study-materials.ts";
import { isSensitivePath } from "../src/agent/tools/fs-shared.ts";
import { materialKey, studyMaterialsPrompt } from "../src/core/study-materials.ts";

async function withFolder(run: (directory: string) => Promise<void>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-material-test-"));
	try { await run(directory); }
	finally { assert.equal(await fs.realpath(path.dirname(directory)), await fs.realpath(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
}
test("Obsidian browses only selected folders, reads Markdown without writes and rejects traversal", async () => {
	await withFolder(async directory => {
		const vault = path.join(directory, "vault"); await fs.mkdir(path.join(vault, "Course"), { recursive: true });
		const file = path.join(vault, "Course", "Note.md"); const text = "# Source\nCompetition definition.\n![[slide.pdf]]";
		await fs.writeFile(file, text); await fs.writeFile(path.join(vault, "ignored.json"), "secret fixture"); await fs.writeFile(path.join(directory, "outside.md"), "outside");
		const service = new StudyMaterials({ obsidianRoot: vault });
		const root = await service.list("obsidian"); assert.equal(root.entries.length, 1); assert.equal(root.entries[0]!.kind, "folder");
		const notes = await service.list("obsidian", "Course"); assert.equal(notes.entries[0]!.title, "Note.md");
		const material = await service.read({ source: "obsidian", id: path.join("Course", "Note.md") });
		assert.equal(material.text, text); assert.equal(material.origin, await fs.realpath(file)); assert(material.notices[0]?.includes("Embedded"));
		assert.equal(await fs.readFile(file, "utf8"), text);
		await assert.rejects(service.read({ source: "obsidian", id: "../outside.md" }), /outside/);
		await assert.rejects(service.read({ source: "obsidian", id: path.join(directory, "outside.md") }), /relative/);
	});
});
test("Notion uses title search, opaque cursors and nested/paginated text with source notices", async () => {
	const id = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222";
	const calls: { url: string; options?: RequestInit }[] = [];
	const fetchLike = (async (url: string | URL | Request, options?: RequestInit) => {
		calls.push({ url: String(url), options });
		if (String(url).endsWith("/search")) return Response.json({ results: [{ id, properties: { Name: { type: "title", title: [{ plain_text: "Lecture" }] } } }], has_more: true, next_cursor: "opaque /+cursor" });
		if (String(url).includes(`/pages/${id}`)) return Response.json({ url: "https://app.notion.com/p/source", properties: { Name: { type: "title", title: [{ plain_text: "Lecture" }] } } });
		if (String(url).includes(`/blocks/${child}`)) return Response.json({ results: [{ id: "third", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Nested text" }] } }], has_more: false });
		if (String(url).includes("start_cursor=")) return Response.json({ results: [{ id: "image", type: "image", image: {} }], has_more: false });
		return Response.json({ results: [{ id: child, type: "paragraph", paragraph: { rich_text: [{ plain_text: "Parent text" }] }, has_children: true }], has_more: true, next_cursor: "opaque /+cursor" });
	}) as typeof fetch;
	const service = new StudyMaterials({ notionToken: "synthetic-private-token" }, fetchLike);
	assert(!JSON.stringify(service.status()).includes("synthetic-private-token"));
	const listed = await service.list("notion", "", "Lecture", "opaque /+cursor"); assert.equal(listed.entries[0]!.title, "Lecture");
	assert.equal(JSON.parse(String(calls[0]!.options!.body)).start_cursor, "opaque /+cursor");
	const material = await service.read({ source: "notion", id });
	assert.equal(material.text, "Parent text\n\nNested text"); assert.equal(material.origin, "https://app.notion.com/p/source"); assert.deepEqual(material.notices, ["Not included in extracted text: image."]);
	assert(calls.every(call => call.url.startsWith("https://api.notion.com/v1/") && call.options?.redirect === "error"));
	assert(calls.slice(1).every(call => call.options?.method === "GET"));
	const before = calls.length; await assert.rejects(service.read({ source: "notion", id: "https://elsewhere.test/" }), /Invalid/); assert.equal(calls.length, before);
});
test("Zotero uses loopback GETs and actual indexed text, never substitutes a paper's metadata", async () => {
	const calls: string[] = [];
	const fetchLike = (async (url: string | URL | Request, options?: RequestInit) => {
		assert.equal(options?.method, "GET"); assert(!new Headers(options?.headers).has("Authorization")); calls.push(String(url));
		if (String(url).includes("/fulltext")) return Response.json({ content: "Actual indexed PDF text" });
		if (String(url).includes("/items/PDF12345")) return Response.json({ key: "PDF12345", data: { itemType: "attachment", title: "Paper.pdf" } });
		if (String(url).includes("/items/NOTE1234")) return Response.json({ key: "NOTE1234", data: { itemType: "note", note: "<p>Saved note</p><script>do not execute</script>" } });
		return Response.json({ key: "PAPER123", data: { itemType: "journalArticle", title: "Only metadata" } });
	}) as typeof fetch;
	const service = new StudyMaterials({ zoteroEnabled: true }, fetchLike);
	assert.equal((await service.read({ source: "zotero", id: "PDF12345" })).text, "Actual indexed PDF text");
	assert.equal((await service.read({ source: "zotero", id: "NOTE1234" })).text, "Saved note");
	await assert.rejects(service.read({ source: "zotero", id: "PAPER123" }), /select a note or indexed PDF/);
	assert(calls.every(url => url.startsWith("http://127.0.0.1:23119/api/users/0/")));
});
test("credentials and temporary credential files are denied to learner-file tools", () => {
	const home = path.resolve(os.tmpdir(), "synthetic-home"), auth = path.join(home, "app", "auth.json");
	const file = path.join(path.dirname(auth), "material-sources-credentials.json");
	assert(isSensitivePath(file, home, auth));
	assert(isSensitivePath(`${file}.11111111-1111-4111-8111-111111111111.tmp`, home, auth));
});
test("the learning request carries selected content and exact origin as quoted data", () => {
	const selected = { source: "obsidian" as const, id: "course.md", title: "Course", origin: "original/course.md", text: "Source text", notices: [] };
	const prompt = studyMaterialsPrompt("Review definitions", [selected]);
	assert(prompt.startsWith("Review definitions")); assert(prompt.includes('"text":"Source text"')); assert(prompt.includes('"origin":"original/course.md"'));
	assert.notEqual(materialKey(selected), materialKey({ ...selected, source: "notion" }));
	assert.throws(() => studyMaterialsPrompt("", []), /Select/);
});
