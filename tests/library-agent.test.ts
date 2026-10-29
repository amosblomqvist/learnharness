/**
 * COURSE LIBRARY — agent-side pins (course library wave, 2026-10-29): the
 * shared reading surface over every format, the teacher's scoped library
 * tools (incl. library_brief's pdf-job dispatch), the library reader loop
 * on a faux engine, the per-turn manifest, the summary turn-gate, and
 * practice inheritance — under an isolated LH_DATA_DIR, LibreOffice
 * pinned off, the headless renderer faked.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { buildPptx, TINY_PNG } from "./helpers/ooxml.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-agent-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { sofficeOverride } = await import("../src/agent/library/libreoffice.ts");
sofficeOverride.current = null;
const server = await import("../src/server/library.ts");
const agentSeam = await import("../src/server/library-agent.ts");
const { stores } = await import("../src/server/stores.ts");
const { readUnits, searchUnits, viewUnits } = await import("../src/agent/library/readable.ts");
const { libraryTools } = await import("../src/agent/tools/library.ts");
const { runLibraryReader } = await import("../src/agent/subagents/library-reader.ts");
const { subscribe } = await import("../src/core/events.ts");
type HeadlessApi = import("../src/agent/subagents/headless.ts").HeadlessApi;
type PiEngine = import("../src/agent/models.ts").PiEngine;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PDF_FIXTURE = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf")));

const fakeHeadless = (): HeadlessApi & { renders: number[][] } => {
	const renders: number[][] = [];
	return {
		renders,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => {
			throw new Error("unused");
		},
		renderSvg: async () => {
			throw new Error("unused");
		},
		renderPdfPages: async (_p, pages) => {
			renders.push(pages);
			return pages.map((page) => ({ page, png: Buffer.from(TINY_PNG) }));
		},
	};
};

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

async function upload(parentId: string | null, name: string, bytes: Uint8Array) {
	const up = server.uploadLibraryFile(parentId, name, bytes);
	assert.ok(up.ok, up.ok ? "" : up.error);
	await server.processLibraryFile(up.item.id);
	return up.item;
}

// One course: Unit 1 with a lecture deck (extracted), a quiz PDF, and a
// whiteboard photo; a second, unattached course for scope checks.
const course = stores.libraryStore.createFolder(null, "Math 3339");
const unit = stores.libraryStore.createFolder(course.id, "Unit 1");
const lectures = stores.libraryStore.createFolder(unit.id, "Lectures");
stores.libraryStore.updateItem(lectures.id, { tag: "lecture" });
const deck = await upload(lectures.id, "limits.pptx", buildPptx([
	{ title: "Limits", body: ["epsilon-delta definition"], notes: "Quantifier order matters.", image: true },
	{ title: "Continuity", body: ["f is continuous at a"] },
]));
const quiz = await upload(unit.id, "quiz1.pdf", PDF_FIXTURE);
stores.libraryStore.updateItem(quiz.id, { tag: "quiz" });
const photo = await upload(unit.id, "board.png", TINY_PNG);
const other = stores.libraryStore.createFolder(null, "Other course");
const secret = await upload(other.id, "secret.pdf", PDF_FIXTURE);

const chat = stores.chatStore.createChat("Unit 1 prep");
assert.ok(server.setChatAttachments(chat.id, [unit.id]).ok);

describe("reading surface", () => {
	const readables = () => agentSeam.chatLibraryReadables(chat.id);
	const byId = (id: string) => readables().find((r) => r.id === id)!;

	it("scope: an attached folder brings its files with inherited tags; other courses stay out", () => {
		const files = readables();
		assert.deepEqual(new Set(files.map((f) => f.id)), new Set([deck.id, quiz.id, photo.id]));
		assert.equal(byId(deck.id).tag, "lecture");
		assert.equal(byId(quiz.id).tag, "quiz");
		assert.equal(byId(deck.id).path, "Math 3339/Unit 1/Lectures/limits.pptx");
		assert.equal(agentSeam.chatLibraryReadable(chat.id, secret.id), null);
	});

	it("extracted slides read with titles + notes; search finds notes too", async () => {
		const r = await readUnits(byId(deck.id), "1");
		assert.match(r.text, /--- Slide 1: Limits ---/);
		assert.match(r.text, /\[Speaker notes\] Quantifier order matters\./);
		assert.match(r.text, /1 picture/);
		const s = await searchUnits(byId(deck.id), "quantifier");
		assert.deepEqual(s.units, [1]);
	});

	it("PDF pages read and search; out-of-range specs say so", async () => {
		const r = await readUnits(byId(quiz.id), "2");
		assert.match(r.text, /--- Page 2 ---/);
		assert.deepEqual(r.units, [2]);
		assert.match((await readUnits(byId(quiz.id), "9")).text, /No pages selected/);
	});

	it("view: rendered pages, embedded pictures, image files", async () => {
		const headless = fakeHeadless();
		const pdf = await viewUnits(byId(quiz.id), "1-2", { headless });
		assert.equal(pdf.images.length, 2);
		assert.deepEqual(headless.renders, [[1, 2]]);
		const slide = await viewUnits(byId(deck.id), "1-2", { headless });
		assert.equal(slide.images.length, 1);
		assert.match(slide.text, /slide 2: no pictures/);
		const img = await viewUnits(byId(photo.id), "1", { headless });
		assert.equal(img.images.length, 1);
	});
});

describe("library tools", () => {
	const jobs: { kind: string; input: unknown }[] = [];
	const tools = libraryTools({
		files: () => agentSeam.chatLibraryReadables(chat.id),
		headless: fakeHeadless(),
		jobs: {
			chatId: chat.id,
			jobStore: {
				findJobByToolCallId: () => null,
				createJob: (init: { kind: string; input?: unknown }) => {
					jobs.push({ kind: init.kind, input: init.input });
					return { id: "job_x", ...init } as never;
				},
			} as never,
			spawn: () => {},
		},
	});
	const run = async (name: string, args: Record<string, unknown>) => {
		const result = await tools[name]!.execute(`call_${name}`, args as never, undefined, undefined as never);
		return result.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n");
	};

	it("library_ls lists every in-scope file with tag and size", async () => {
		const text = await run("library_ls", {});
		assert.match(text, /Math 3339\/Unit 1\/Lectures\/limits\.pptx \| Lecture \| PPTX, 2 slides/);
		assert.match(text, /quiz1\.pdf \| Quiz \| PDF, 3 pages/);
		assert.doesNotMatch(text, /secret/);
	});

	it("files resolve by id, path, or unique name — never outside scope", async () => {
		assert.match(await run("library_read", { file: "quiz1.pdf", units: "1" }), /--- Page 1 ---/);
		assert.match(await run("library_read", { file: "Math 3339/Unit 1/quiz1.pdf", units: "1" }), /--- Page 1 ---/);
		const denied = await run("library_read", { file: secret.id, units: "1" });
		assert.match(denied, /No attached file matches/);
		assert.doesNotMatch(denied, /secret/);
	});

	it("library_search spans attached files", async () => {
		assert.match(await run("library_search", { query: "continuous" }), /limits\.pptx/);
	});

	it("library_view returns image content", async () => {
		assert.match(await run("library_view", { file: photo.id }), /\[image image\/png\]/);
	});

	it("library_brief dispatches a pdf job naming the library file", async () => {
		const ack = await run("library_brief", { file: deck.id, question: "What do slides define?" });
		assert.match(ack, /Dispatched \(job job_x\)/);
		assert.deepEqual(jobs[0], { kind: "pdf", input: { path: "Math 3339/Unit 1/Lectures/limits.pptx", question: "What do slides define?", fileId: deck.id } });
	});

	it("no jobs context → no library_brief", () => {
		assert.equal("library_brief" in libraryTools({ files: () => [] }), false);
	});
});

describe("library reader (faux engine)", () => {
	const deckReadable = () => agentSeam.chatLibraryReadables(chat.id).find((f) => f.id === deck.id)!;

	it("reads, then delivers; consulted units tracked", async () => {
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("library_read", { units: "1-2" }, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Two slides: limits (slide 1), continuity (slide 2).")]),
		]);
		const result = await runLibraryReader(deckReadable(), "summary", "", { engine, headless: fakeHeadless() });
		assert.equal(result.failed, false);
		assert.deepEqual(result.unitsConsulted, [1, 2]);
		assert.match(result.text, /Two slides/);
	});

	it("an unread finish is nudged once", async () => {
		const engine = fauxEngine([
			fauxAssistantMessage([fauxText("Made-up summary.")]),
			fauxAssistantMessage([fauxToolCall("library_view", { units: "1" }, { id: "v1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Slide 1 shows a figure.")]),
		]);
		const result = await runLibraryReader(deckReadable(), "brief", "What's on slide 1?", { engine, headless: fakeHeadless() });
		assert.equal(result.text, "Slide 1 shows a figure.");
		assert.deepEqual(result.unitsConsulted, [1]);
	});
});

describe("manifest + summary gate", () => {
	it("no attachments → no manifest; attachments → one line per file", () => {
		const bare = stores.chatStore.createChat("Bare");
		assert.equal(agentSeam.materialsManifest(bare.id), undefined);
		const manifest = agentSeam.materialsManifest(chat.id)!;
		assert.match(manifest, /^# COURSE MATERIALS/);
		assert.match(manifest, /\[Quiz\] Math 3339\/Unit 1\/quiz1\.pdf \(id file_[^;]+; PDF, 3 pages\)/);
		assert.match(manifest, /no summary available/);
	});

	it("the turn gate writes every owed summary once, announcing running true→false", async () => {
		const written: string[] = [];
		agentSeam.summaryWriterOverride.current = async (file) => {
			written.push(file.id);
			return { text: `About ${file.name}.`, model: "faux:model", steps: [] };
		};
		const events: boolean[] = [];
		const off = subscribe((e) => {
			if (e.type === "library-summaries-changed") {
				const payload = e as unknown as { chatId: string; running: boolean };
				if (payload.chatId === chat.id) events.push(payload.running);
			}
		});
		await agentSeam.awaitAttachmentSummaries(chat.id);
		off();
		assert.deepEqual(new Set(written), new Set([deck.id, quiz.id, photo.id]));
		assert.deepEqual(events, [true, false]);
		assert.match(agentSeam.materialsManifest(chat.id)!, /Summary: About quiz1\.pdf\./);
		assert.equal(server.chatAttachmentsSnapshot(chat.id).files.every((f) => f.summary === "ready"), true);
		written.length = 0;
		await agentSeam.awaitAttachmentSummaries(chat.id);
		assert.deepEqual(written, [], "cached by content hash");
	});

	it("a failed summary doesn't stall later turns; re-attaching retries it", async () => {
		const fresh = await upload(unit.id, "quiz2.pdf", PDF_FIXTURE);
		let calls = 0;
		agentSeam.summaryWriterOverride.current = async () => {
			calls++;
			throw new Error("no model");
		};
		await agentSeam.awaitAttachmentSummaries(chat.id);
		assert.equal(calls, 1);
		assert.equal(server.chatAttachmentsSnapshot(chat.id).files.find((f) => f.id === fresh.id)?.summary, "failed");
		await agentSeam.awaitAttachmentSummaries(chat.id);
		assert.equal(calls, 1, "the turn gate does not retry a known failure");
		agentSeam.summaryWriterOverride.current = async (file) => ({ text: `About ${file.name}.`, model: "faux:model", steps: [] });
		server.setChatAttachments(chat.id, [unit.id]);
		agentSeam.requestAttachmentSummaries(chat.id);
		await agentSeam.awaitAttachmentSummaries(chat.id);
		await new Promise((r) => setImmediate(r));
		assert.equal(server.chatAttachmentsSnapshot(chat.id).files.find((f) => f.id === fresh.id)?.summary, "ready");
		agentSeam.summaryWriterOverride.current = undefined;
	});
});

describe("practice inheritance", () => {
	it("unions the BIRTH chats' attachments in pick order, skipping notes sources and deleted items", () => {
		const birthA = stores.chatStore.createChat("Birth A");
		const birthB = stores.chatStore.createChat("Birth B");
		const later = stores.chatStore.createChat("Later review");
		server.setChatAttachments(birthA.id, [lectures.id]);
		server.setChatAttachments(birthB.id, [quiz.id, lectures.id]);
		server.setChatAttachments(later.id, [other.id]);
		const node = (id: string, chats: string[]) => ({
			id,
			name: id,
			statement: id,
			aliases: [],
			createdAt: "2026-10-29T00:00:00.000Z",
			provenance: chats.map((chatId) => ({ chatId, messageId: "m" })),
		});
		stores.graphStore.appendNode(node("n_a", [birthA.id, later.id]));
		stores.graphStore.appendNode(node("n_b", [birthB.id]));
		stores.graphStore.appendNode(node("n_notes", ["src_abc"]));
		assert.deepEqual(server.inheritedAttachments(["n_b", "n_a", "n_notes", "n_missing"]), [quiz.id, lectures.id]);
	});
});
