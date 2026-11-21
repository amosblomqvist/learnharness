import assert from "node:assert/strict";
import { it } from "node:test";
import { createNotesImportQueue } from "../components/notes-import-queue.ts";
import { MAX_IMPORT_BYTES } from "../lib/notes-import-limits.ts";
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
	queue.append([file(".DS_Store", "Root/.DS_Store"), file("a.png", "Root/Images/a.png"), file("notes.md", "Root/Sub/notes.md"), file("bad.pptx", "../bad.pptx")]);
	await tick();
	assert.deepEqual(paths, ["Root/Sub/notes.md"]);
	assert.deepEqual(queue.getSnapshot().errors, ["Skipped 1 file that isn't text, Markdown, or PDF (.png).", "Skipped 1 file with a name the import can't use (e.g. a ':' in the name)."]);
});

it("folder picks skip dot-directories such as .obsidian/ silently, even when the chosen root itself is hidden", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath || f!.name; paths.push(path); return [success(path)]; });
	queue.append([file("app.json", "Vault/.obsidian/app.json"), file("old.md", "Vault/.trash/old.md"), file("notes.md", "Vault/Sub/notes.md")]);
	queue.append([file("a.md", ".notes/a.md")]);
	await tick();
	assert.deepEqual(paths, ["Vault/Sub/notes.md", ".notes/a.md"]);
	assert.deepEqual(queue.getSnapshot().errors, []);
});

it("folder picks skip .git, nested dot-directories and hidden note files, not ordinary names containing dots", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath; paths.push(path); return [success(path)]; });
	queue.append([
		file("config", "Vault/.git/config"),
		file("README.md", "Vault/.git/README.md"),
		file("topic.md", "Vault/Course/Week/.private/Sub/topic.md"),
		file(".draft.md", "Vault/.draft.md"),
		file(".summary.txt", "Vault/Course/.summary.txt"),
		file("notes.v2.md", "Vault/Course.v2/notes.v2.md"),
	]);
	await tick();
	assert.deepEqual(paths, ["Vault/Course.v2/notes.v2.md"]);
	assert.deepEqual(queue.getSnapshot().errors, []);
});

it("individual file picks still import hidden notes and report unsupported dotfiles", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { paths.push(f!.name); return [success(f!.name)]; });
	queue.append([file(".draft.md"), file(".summary.txt"), file(".DS_Store")]);
	await tick();
	assert.deepEqual(paths, [".draft.md", ".summary.txt"]);
	assert.deepEqual(queue.getSnapshot().errors, ["Skipped 1 file that isn't text, Markdown, or PDF (no extension)."]);
});

it("the queue uploads every accepted extension, including the expanded text types in uppercase", async () => {
	const sent: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { sent.push(f!.name); return [success(f!.name)]; });
	const names = ["notes.TXT", "notes.MD", "notes.MARKDOWN", "notes.RST", "notes.ORG", "notes.ADOC", "notes.TEX", "notes.PDF"];
	queue.append(names.map((name) => file(name)));
	await tick();
	assert.deepEqual(sent, names);
	assert.deepEqual(queue.getSnapshot(), { importing: false, errors: [], notices: [], completion: 1 });
});

it("the file type check comes before the size check", () => {
	const queue = createNotesImportQueue(async ([f]) => [success(f!.name)]);
	const huge = file("huge.bin"); Object.defineProperty(huge, "size", { value: Number.MAX_SAFE_INTEGER });
	queue.append([huge]);
	assert.deepEqual(queue.getSnapshot().errors, ["Skipped 1 file that isn't text, Markdown, or PDF (.bin)."]);
});

it("a folder pick of unsupported files gives one summary line with the count and each distinct type once, in first-seen order", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath; paths.push(path); return [success(path)]; });
	queue.append([
		file("Main.java", "Course/src/Main.java"),
		file("Main.class", "Course/bin/Main.class"),
		file("week1.ppt", "Course/Week1/week1.ppt"),
		file("Util.JAVA", "Course/src/Util.JAVA"),
		file("week2.pptx", "Course/Week2/week2.pptx"),
		file("Week2.PPTX", "Course/Week2/Week2.PPTX"),
		file("syllabus.doc", "Course/syllabus.doc"),
		file("notes.md", "Course/notes.md"),
	]);
	await tick();
	assert.deepEqual(paths, ["Course/notes.md"]);
	assert.deepEqual(queue.getSnapshot().errors, ["Skipped 7 files that aren't text, Markdown, or PDF (.java, .class, .ppt, .pptx, .doc)."]);
});

it("one unsupported file uses the singular line; a file with no extension is listed as no extension", () => {
	const single = createNotesImportQueue(async ([f]) => [success(f!.name)]);
	single.append([file("deck.pptx")]);
	assert.deepEqual(single.getSnapshot().errors, ["Skipped 1 file that isn't text, Markdown, or PDF (.pptx)."]);
	const mixed = createNotesImportQueue(async ([f]) => [success(f!.name)]);
	mixed.append([file("Main.java", "Course/Main.java"), file("Makefile", "Course/Makefile")]);
	assert.deepEqual(mixed.getSnapshot().errors, ["Skipped 2 files that aren't text, Markdown, or PDF (.java, no extension)."]);
	const trailingDot = createNotesImportQueue(async ([f]) => [success(f!.name)]);
	trailingDot.append([file("notes.")]);
	assert.deepEqual(trailingDot.getSnapshot().errors, ["Skipped 1 file that isn't text, Markdown, or PDF (no extension)."]);
});

it("names the import can't use are counted into one line, and path safety is checked before type", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath || f!.name; paths.push(path); return [success(path)]; });
	queue.append([file("https:::eclass.yorku.ca:pluginfile.php:7873036:mod_resource:content:2:W5.txt.pdf", "Course/https:::eclass.yorku.ca:pluginfile.php:7873036:mod_resource:content:2:W5.txt.pdf"), file("a:b.pptx", "Course/a:b.pptx"), file("notes.md", "Course/notes.md")]);
	await tick();
	assert.deepEqual(paths, ["Course/notes.md"]);
	assert.deepEqual(queue.getSnapshot().errors, ["Skipped 2 files with names the import can't use (e.g. a ':' in the name)."]);
	const single = createNotesImportQueue(async ([f]) => [success(f!.name)]);
	single.append([file("a:b.md")]);
	assert.deepEqual(single.getSnapshot().errors, ["Skipped 1 file with a name the import can't use (e.g. a ':' in the name)."]);
});

it("in one pick the too-big file keeps its own line, hidden files stay silent, supported files upload, and each summary sits at its first file", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath; paths.push(path); return [success(path)]; });
	const huge = file("big.md", "Course/big.md"); Object.defineProperty(huge, "size", { value: MAX_IMPORT_BYTES + 1 });
	queue.append([
		file("notes.md", "Course/notes.md"),
		file("Main.java", "Course/Main.java"),
		huge,
		file("a:b.txt", "Course/a:b.txt"),
		file("Main.class", "Course/Main.class"),
		file(".DS_Store", "Course/.DS_Store"),
		file("c:d.txt", "Course/c:d.txt"),
		file("slides.pdf", "Course/slides.pdf"),
	]);
	await tick();
	assert.deepEqual(paths, ["Course/notes.md", "Course/slides.pdf"]);
	assert.deepEqual(queue.getSnapshot().errors, [
		"Skipped 2 files that aren't text, Markdown, or PDF (.java, .class).",
		"Course/big.md: Too big. Max 25 MB.",
		"Skipped 2 files with names the import can't use (e.g. a ':' in the name).",
	]);
});

it("each pick gets its own summary lines, so a later pick during an import adds to the list", async () => {
	let resolve!: (rows: NotesImportResult[]) => void;
	const queue = createNotesImportQueue(() => new Promise((done) => { resolve = done; }));
	queue.append([file("notes.md"), file("a.ppt")]);
	queue.append([file("b.doc"), file("c.doc")]);
	assert.deepEqual(queue.getSnapshot().errors, ["Skipped 1 file that isn't text, Markdown, or PDF (.ppt).", "Skipped 2 files that aren't text, Markdown, or PDF (.doc)."]);
	resolve([success("notes.md")]);
	await tick();
	assert.equal(queue.getSnapshot().importing, false);
});

it("an all-skipped selection publishes completion without validation errors or uploads and allows later work", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { paths.push(f!.name); return [success(f!.name)]; });
	let publications = 0;
	const unsubscribe = queue.subscribe(() => { publications++; });
	const oversized = file("large.pdf", "Vault/.private/large.pdf");
	Object.defineProperty(oversized, "size", { value: Number.MAX_SAFE_INTEGER });
	queue.append([file("config", "Vault/.git/config"), file(".draft.md", "Vault/.draft.md"), oversized]);
	assert.equal(publications, 1);
	assert.deepEqual(queue.getSnapshot(), { importing: false, errors: [], notices: [], completion: 1 });
	await tick();
	assert.deepEqual(paths, []);
	assert.equal(publications, 1, "no asynchronous settlement for skipped files");
	queue.append([file("notes.md")]);
	await tick();
	assert.deepEqual(paths, ["notes.md"]);
	assert.deepEqual(queue.getSnapshot(), { importing: false, errors: [], notices: [], completion: 2 });
	unsubscribe();
});

it("an all-skipped append does not complete or disturb an active import", async () => {
	let calls = 0;
	let resolve!: (rows: NotesImportResult[]) => void;
	const queue = createNotesImportQueue(() => { calls++; return new Promise((done) => { resolve = done; }); });
	queue.append([file("notes.md")]);
	queue.append([file("config", "Vault/.git/config"), file(".draft.md", "Vault/.draft.md")]);
	assert.equal(calls, 1);
	assert.deepEqual(queue.getSnapshot(), { importing: true, errors: [], notices: [], completion: 0 });
	resolve([success("notes.md")]);
	await tick();
	assert.equal(calls, 1);
	assert.deepEqual(queue.getSnapshot(), { importing: false, errors: [], notices: [], completion: 1 });
});

it("synchronous transport failures settle one wave once without reentrant pump recursion", async () => {
	let calls = 0;
	const queue = createNotesImportQueue(() => { calls++; throw new Error("transport failure"); });
	queue.append([file("a.md"), file("b.md"), file("c.md"), file("d.md")]);
	await tick();
	assert.equal(calls, 4); assert.equal(queue.getSnapshot().completion, 1); assert.equal(queue.getSnapshot().importing, false);
	assert.equal(queue.getSnapshot().errors.length, 4);
});
