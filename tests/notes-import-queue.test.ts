import assert from "node:assert/strict";
import { it } from "node:test";
import { createNotesImportQueue } from "../components/notes-import-queue.ts";
import type { NotesImportResult } from "../components/notes-import.tsx";
const tick = () => new Promise<void>((done) => setImmediate(done));
const file = (name: string, path?: string) => { const f = new File(["notes"], name); if (path) Object.defineProperty(f, "webkitRelativePath", { value: path }); return f; };
const success = (name: string): NotesImportResult => ({ requestIndex: 0, filePath: name, ok: true, outcome: "completed", stats: { nodes: 0 } });

it("one appendable queue stays three-wide across same-tick selections, refilling behind a slow first file", async () => {
	const calls: { file: File; resolve: (rows: NotesImportResult[]) => void; reject: (error: Error) => void }[] = [];
	const queue = createNotesImportQueue(async (files) => new Promise((resolve, reject) => { assert.equal(files.length, 1); calls.push({ file: files[0]!, resolve, reject }); }));
	queue.append([file("a.md"), file("b.md"), file("c.md"), file("d.md")]);
	queue.append([file("e.md"), file("f.md")]);
	assert.equal(calls.length, 3);
	calls[1]!.resolve([success("b.md")]); await tick();
	assert.equal(calls.length, 4); assert.equal(calls[3]!.file.name, "d.md");
	calls[2]!.reject(new Error("lost response")); await tick();
	assert.equal(calls.length, 5); assert.equal(calls[4]!.file.name, "e.md");
	calls[3]!.resolve([success("d.md")]); await tick();
	assert.equal(calls.length, 6);
	calls[4]!.resolve([success("e.md")]); calls[5]!.resolve([success("f.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, true, "slow a still running");
	assert.equal(queue.getSnapshot().completion, 0);
	calls[0]!.resolve([success("a.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, false); assert.equal(queue.getSnapshot().completion, 1);
	assert.deepEqual(queue.getSnapshot().errors, ["c.md: lost response"]);
	assert.equal(calls.length, 6, "no automatic retry");
});

it("errors/notices keep selection order across appends even when requests settle backwards", async () => {
	const pending: ((results: NotesImportResult[]) => void)[] = [];
	const queue = createNotesImportQueue(async () => new Promise((resolve) => pending.push(resolve)));
	queue.append([file("same.md", "A/same.md"), file("same.md", "B/same.md")]);
	queue.append([file("c.pdf", "B/c.pdf")]);
	pending[2]!([{ ...success("B/c.pdf"), notice: "Scanner caveat" }]);
	pending[1]!([{ requestIndex: 0, filePath: "B/same.md", ok: false, outcome: "partial", error: "second" }]);
	pending[0]!([{ requestIndex: 0, filePath: "A/same.md", ok: false, outcome: "busy", error: "first" }]);
	await tick();
	assert.deepEqual(queue.getSnapshot().errors, ["A/same.md: first", "B/same.md: second"]);
	assert.deepEqual(queue.getSnapshot().notices, ["B/c.pdf: Scanner caveat"]);
});

it("unsupported-only directories are never sent; picker .DS_Store is ignored and eligible siblings proceed", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath || f!.name; paths.push(path); return [success(path)]; });
	queue.append([file(".DS_Store", "Root/.DS_Store"), file("a.png", "Root/Images/a.png"), file("notes.md", "Root/Sub/notes.md"), file("bad.txt", "../bad.txt")]);
	await tick();
	assert.deepEqual(paths, ["Root/Sub/notes.md"]);
	assert.deepEqual(queue.getSnapshot().errors, ["Root/Images/a.png: Unsupported format or unsafe relative path.", "../bad.txt: Unsupported format or unsafe relative path."]);
});

it("synchronous transport failures settle one wave once without reentrant pump recursion", async () => {
	let calls = 0;
	const queue = createNotesImportQueue(() => { calls++; throw new Error("transport failure"); });
	queue.append([file("a.md"), file("b.md"), file("c.md"), file("d.md")]);
	await tick();
	assert.equal(calls, 4); assert.equal(queue.getSnapshot().completion, 1); assert.equal(queue.getSnapshot().importing, false);
	assert.equal(queue.getSnapshot().errors.length, 4);
});
