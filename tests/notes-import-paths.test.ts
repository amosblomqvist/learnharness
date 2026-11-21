import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-paths-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json"); fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction, stores } = await import("../src/server/index.ts");
const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const original = extraction.importNotes;
after(() => { extraction.importNotes = original; });
function request(names: string[], paths?: unknown[]) {
	const form = new FormData();
	for (const name of names) form.append("files", new File(["notes"], name));
	for (const p of paths ?? []) form.append("paths", typeof p === "string" ? p : new Blob(["not a path"]));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

function offlinePipeline() {
	return createExtractionPipeline({ ...stores, engineFor: (role) => {
		const faux = createFauxCore({});
		const call = role === "extractor"
			? fauxToolCall("submit_findings", { propositions: [], chains: [] })
			: fauxToolCall("submit_review", { links: [] });
		faux.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" })]);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	} });
}

it("folder-relative identity separates duplicate basenames and builds nested organization", async () => {
	const pipeline = offlinePipeline();
	extraction.importNotes = pipeline.importNotes;
	const paths = ["Course/Week 1/same.md", "Course/Week 2/same.md"];
	const response = await POST(request(["same.md", "same.md"], paths)); assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.deepEqual(results.map((r: { filePath: string }) => r.filePath).sort(), [...paths].sort());
	assert.deepEqual(stores.sourceOrganizationStore.read().folders.map((f) => f.importPath), ["Course", "Course/Week 1", "Course/Week 2"]);
	const sources = stores.graphStore.readSources();
	assert.deepEqual(sources.map((source) => source.filePath).sort(), paths);
	assert.deepEqual(Object.keys(stores.sourceOrganizationStore.read().placements).sort(), sources.map((source) => source.id).sort());
	assert.ok(results.every((row: { outcome: string }) => row.outcome === "completed"));
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

it("reopening a folder uses the persisted byte hash and confirmed moves keep the original placement", async () => {
	const saved = extraction.importFolderNotes;
	async function folderUpload(filePath: string, moveFrom?: string) {
		// New pipeline per request: the durable source record carries the identity.
		extraction.importFolderNotes = offlinePipeline().importFolderNotes;
		const form = new FormData();
		form.set("mode", "folder");
		form.set("files", new File(["a separate fixture"], filePath.split("/").at(-1)!));
		form.set("paths", filePath);
		if (moveFrom) form.set("moveFrom", moveFrom);
		const { results } = await (await POST(new Request("http://localhost/api/graph/import", { method: "POST", body: form }))).json();
		return results[0];
	}
	try {
		const from = "Biology/first.md", to = "Biology/archive/renamed.md";
		assert.equal((await folderUpload(from)).outcome, "completed");
		const original = stores.graphStore.readSources().find((s) => s.filePath === from)!;
		const organization = stores.sourceOrganizationStore.read();
		assert.equal((await folderUpload(from)).outcome, "skipped");
		assert.equal((await folderUpload(to)).previousPath, from);
		assert.equal((await folderUpload(to, from)).outcome, "skipped");
		assert.equal((await folderUpload(to)).outcome, "skipped");
		const sources = stores.graphStore.readSources();
		assert.deepEqual(sources.filter((s) => s.filePath === from || s.filePath === to), [{ ...original, filePath: to }]);
		assert.deepEqual(stores.sourceOrganizationStore.read(), organization);
	} finally { extraction.importFolderNotes = saved; }
});
