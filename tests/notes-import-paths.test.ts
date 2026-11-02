import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-paths-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json"); fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction, stores } = await import("../src/server/index.ts");
const original = extraction.importNotes;
after(() => { extraction.importNotes = original; });
function request(names: string[], paths?: unknown[]) {
	const form = new FormData();
	for (const name of names) form.append("files", new File(["notes"], name));
	for (const p of paths ?? []) form.append("paths", typeof p === "string" ? p : new Blob(["not a path"]));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("folder-relative identity separates duplicate basenames and builds nested organization", async () => {
	const called: string[] = [];
	extraction.importNotes = async ({ filePath }) => { called.push(filePath); return { nodes: 0, chains: 0 }; };
	const paths = ["Course/Week 1/same.md", "Course/Week 2/same.md"];
	const response = await POST(request(["same.md", "same.md"], paths)); assert.equal(response.status, 200);
	assert.deepEqual(called, paths);
	const { results } = await response.json();
	assert.deepEqual(results.map((r: { filePath: string }) => r.filePath).sort(), [...paths].sort());
	assert.deepEqual(stores.sourceOrganizationStore.read().folders.map((f) => f.importPath), ["Course", "Course/Week 1", "Course/Week 2"]);
	assert.equal(Object.keys(stores.sourceOrganizationStore.read().placements).length, 2);
});

it("Chromium full relative multipart filenames and ordinary basename requests both remain valid", async () => {
	const called: string[] = [];
	extraction.importNotes = async ({ filePath }) => { called.push(filePath); return { nodes: 0, chains: 0 }; };
	assert.equal((await POST(request(["Folder/Sub/notes.txt"], ["Folder/Sub/notes.txt"]))).status, 200);
	assert.equal((await POST(request(["loose.md"]))).status, 200);
	assert.deepEqual(called, ["Folder/Sub/notes.txt", "loose.md"]);
});

it("all unsafe/mismatched paths are refused before the pipeline or organizational writes", async () => {
	let calls = 0;
	extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
	const before = stores.sourceOrganizationStore.read();
	for (const paths of [["../notes.md"], ["/notes.md"], ["C:/notes.md"], ["a\\notes.md"], ["a//notes.md"], ["a/./notes.md"], ["a/\u0001notes.md"], ["wrong.md"], ["notes.md", "extra.md"], [42], ["a/" + "x".repeat(1024) + "/notes.md"]]) {
		assert.equal((await POST(request(["notes.md"], paths))).status, 400, String(paths));
	}
	assert.equal(calls, 0); assert.deepEqual(stores.sourceOrganizationStore.read(), before);
});
