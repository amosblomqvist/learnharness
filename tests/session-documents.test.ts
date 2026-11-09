/**
 * Document-sourced sessions (issue #175) — the creation route's pins,
 * driven directly under an isolated LH_DATA_DIR (the chat-birth-stamp
 * discipline, like tests/graph-context.test.ts):
 *
 *   - a multipart create with an MD fixture → the record carries
 *     sourceDocuments, the staged material file exists under
 *     data/graph/materials, and the SAME text reaches the ordinary
 *     notes-import pipeline (source identity = the path/name hash);
 *   - a tiny PDF goes through the SAME local converter the notes import
 *     uses (readNotesFile → pdf-markdown), converted text staged + handed
 *     to the pipeline;
 *   - the unstubbed pipeline still mints the graph source record before
 *     its model stages refuse (models not configured in this data dir);
 *   - validation: no files in a multipart create, documents on a practice
 *     create, oversized uploads, and an image-only PDF are all refused
 *     with NO session created.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-documents-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { POST } = await import("../app/api/chats/route.ts");
const { extraction } = await import("../src/server/index.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { materialPathFor } = await import("../src/server/session-documents.ts");
const { tinyPdf } = await import("./helpers/tiny-pdf.ts");
const { MAX_IMPORT_BYTES } = await import("../lib/notes-import-limits.ts");
const { PATHS } = await import("../config.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const sourceId = (name: string) => `src_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;

function multipartCreate(title: string, files: File[], kind?: "practice") {
	const form = new FormData();
	form.append("request", JSON.stringify({ title, ...(kind ? { kind } : {}) }));
	for (const file of files) form.append("files", file);
	return new Request("http://test/api/chats", { method: "POST", body: form });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

async function createdId(res: Response): Promise<string> {
	if (res.status !== 200) assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	const { id } = await res.json() as { id: string };
	return id;
}

it("multipart create with an MD fixture: record linkage, staged material, pipeline handoff", async () => {
	const calls: Array<{ filePath: string; text: string }> = [];
	const original = extraction.importNotes;
	extraction.importNotes = async (input) => {
		calls.push({ filePath: input.filePath, text: input.text });
		return { nodes: 0, chains: 0 };
	};
	try {
		const id = await createdId(await POST(multipartCreate("Teach me this paper", [new File(["# Entailment\n\nA entails B."], "paper.md")])));
		const record = chatStore.getChat(id)!;
		assert.ok(record, "the created record exists");
		// Record linkage (the additive contract): id + name + the material path.
		assert.deepEqual(record.sourceDocuments, [{
			sourceId: sourceId("paper.md"),
			name: "paper.md",
			path: materialPathFor(sourceId("paper.md")),
		}]);
		assert.equal(record.kind, undefined, "documents ride a teaching session");
		// The staged converted material, under the data dir, keyed by identity.
		assert.equal(fs.readFileSync(record.sourceDocuments![0]!.path, "utf-8"), "# Entailment\n\nA entails B.");
		assert.ok(record.sourceDocuments![0]!.path.startsWith(PATHS.materials + path.sep));
		await flush();
		// The ordinary pipeline received the SAME text under the identity key.
		assert.deepEqual(calls, [{ filePath: "paper.md", text: "# Entailment\n\nA entails B." }]);
	} finally {
		extraction.importNotes = original;
	}
});

it("a tiny PDF converts through the shared notes-import converter before staging", async () => {
	const calls: Array<{ filePath: string; text: string }> = [];
	const original = extraction.importNotes;
	extraction.importNotes = async (input) => {
		calls.push({ filePath: input.filePath, text: input.text });
		return { nodes: 0, chains: 0 };
	};
	try {
		const bytes = tinyPdf([{ runs: [{ text: "Bayes rule updates belief", x: 72, y: 700, size: 12 }] }]);
		const id = await createdId(await POST(multipartCreate("My lecture", [new File([bytes as BlobPart], "lecture.pdf")])));
		const record = chatStore.getChat(id)!;
		assert.equal(record.sourceDocuments![0]!.name, "lecture.pdf");
		const staged = fs.readFileSync(record.sourceDocuments![0]!.path, "utf-8");
		assert.ok(staged.includes("Bayes rule updates belief"), `converted markdown staged, got: ${staged}`);
		await flush();
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.text.includes("Bayes rule updates belief"), "the pipeline input is the converted markdown");
	} finally {
		extraction.importNotes = original;
	}
});

it("the unstubbed pipeline mints the graph source record (identity = the path/name hash)", async () => {
	const id = await createdId(await POST(multipartCreate("Unconfigured but sourced", [new File(["Notes on entailment."], "identity.md")])));
	const record = chatStore.getChat(id)!;
	await flush();
	const sources = graphStore.readSources();
	const minted = sources.find((s) => s.id === sourceId("identity.md"));
	assert.ok(minted, `the graph source was created (have: ${sources.map((s) => s.id).join(", ")})`);
	assert.equal(minted!.filePath, "identity.md");
	// The staged document's identity matches the record linkage.
	assert.equal(record.sourceDocuments![0]!.sourceId, minted!.id);
});

it("the plain JSON create keeps its shape: no documents, no staging", async () => {
	const stagedBefore = fs.existsSync(PATHS.materials) ? fs.readdirSync(PATHS.materials).length : 0;
	const res = await POST(new Request("http://test/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: "Ordinary goal session" }),
	}));
	const id = await createdId(res);
	const record = chatStore.getChat(id)!;
	assert.equal(record.sourceDocuments, undefined);
	assert.equal(fs.readdirSync(PATHS.materials).length, stagedBefore, "nothing is staged without documents");
});

it("validation refusals create no session", async () => {
	const before = chatStore.listChats().length;

	// Multipart without files.
	const emptyForm = new FormData();
	emptyForm.append("request", JSON.stringify({ title: "No files" }));
	const noFiles = await POST(new Request("http://test/api/chats", { method: "POST", body: emptyForm }));
	assert.equal(noFiles.status, 400);

	// Documents on a practice create.
	const practice = await POST(multipartCreate("Practice from docs", [new File(["x"], "a.md")], "practice"));
	assert.equal(practice.status, 400);
	assert.match(await practice.text(), /teaching sessions/);

	// Image-only PDF: the converter refuses before anything is created.
	const scan = tinyPdf([{ image: true }]);
	const refused = await POST(multipartCreate("Scanned", [new File([scan as BlobPart], "scan.pdf")]));
	assert.equal(refused.status, 400);
	assert.match(await refused.text(), /scan\.pdf/);

	// Oversized upload (aggregate cap, the notes-import limit).
	const huge = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "huge.md");
	const oversized = await POST(multipartCreate("Too big", [huge]));
	assert.equal(oversized.status, 413);

	// A corrupt "request" field.
	const corruptForm = new FormData();
	corruptForm.append("request", "{not json");
	corruptForm.append("files", new File(["x"], "a.md"));
	const corrupt = await POST(new Request("http://test/api/chats", { method: "POST", body: corruptForm }));
	assert.equal(corrupt.status, 400);

	assert.equal(chatStore.listChats().length, before, "no session was created by any refusal");
});
