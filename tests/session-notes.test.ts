import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { parseHTML } from "linkedom";
import { bgLlmSlots } from "../src/agent/subagents/bg-llm-semaphore.ts";
import { completedWithin } from "./completion.ts";
import { noteEvidence } from "../src/core/note-evidence.ts";
import { noteDocumentHtml, noteTextHtml } from "../src/core/note-render.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { HANDOUT_PDF_LAYOUT_VERSION, noteHref, noteModeFromQuery, noteSectionHeading, noteSectionText, type NoteDocument, type NoteIndexEntry, type NoteMode, type NotePassage } from "../src/core/session-notes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-notes-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { createSessionNotesService } = await import("../src/server/session-notes.ts");
const { notesStore } = await import("../src/store/session-notes.ts");
const { writeSessionNotes } = await import("../src/agent/subagents/notes-writer.ts");
const said = (
	id: string,
	text: string,
	call?: { id: string; name: string; arguments: Record<string, unknown> },
): LhMessage =>
	({
		id,
		role: "assistant",
		content: [...(text ? [{ type: "text", text }] : []), ...(call ? [{ type: "toolCall", ...call }] : [])],
	}) as LhMessage;
const atTopic = (id: string, topic: string, text: string) =>
	said(id, text, { name: "quiz", id: id + "-q", arguments: { nodeId: topic, explanation: "HIDDEN" } });
const result = (id: string, toolCallId: string, toolName: string, details: unknown) =>
	({ id, role: "toolResult", toolCallId, toolName, details, isError: false }) as LhMessage;
const sample: NoteDocument = JSON.parse(
	fs.readFileSync(new URL("./fixtures/session-notes-diagonalization.json", import.meta.url), "utf8"),
);
function passageNotes(passages: NotePassage[]): NoteDocument {
	return {
		...sample,
		sections: passages.map(p => ({
			id: p.messageId, heading: p.topic, nodeIds: [p.topic], sourceIds: [p.messageId],
			blocks: [{ kind: "paragraph", text: p.text }],
		})),
	};
}
async function notesIdle(api: ReturnType<typeof createSessionNotesService>, id: string) {
	for (let i = 0; i < 100 && api.sessionNotes(id).running.length; i++) await delay(2);
	assert.deepEqual(api.sessionNotes(id).running, []);
}

it("preserves v1 notes and PDF bytes while exposing app terminology and writing the same disk format", () => {
	const id = "legacy_notes", directory = path.join(root, "notes", id);
	const recordPath = path.join(directory, "record.json");
	const edition = (fingerprint: string) => ({ document: sample, fingerprint, writtenAt: "now" });
	const legacy = {
		version: 1, liveEnabled: true, live: edition("live revision"), final: edition("handout revision"),
		pending: edition("pending handout"), failedLive: "failed revision", topics: { matrices: "topic revision" },
		error: { live: "Live notes failed", final: "Handout PDF failed" },
		usage: ["live", "final"].map(mode => ({ at: "now", mode, model: "fixture", step: { inputTokens: 3, outputTokens: 5 } })),
		pdfFile: "00000000-0000-4000-8000-000000000001.pdf",
	};
	const json = JSON.stringify(legacy, null, 2), pdf = Buffer.from("%PDF-existing-handout");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(recordPath, json);
	fs.writeFileSync(path.join(directory, legacy.pdfFile), pdf);
	try {
		const state = notesStore.read(id);
		assert.deepEqual(state, {
			liveNotesEnabled: true, liveNotes: legacy.live, handout: legacy.final,
			pendingHandout: legacy.pending, failedLiveNotes: legacy.failedLive, topics: legacy.topics,
			error: { liveNotes: legacy.error.live, handout: legacy.error.final },
			usage: legacy.usage.map((entry, i) => ({ ...entry, mode: i === 0 ? "liveNotes" : "handout" })),
			pdfFile: legacy.pdfFile,
		});
		assert.deepEqual(notesStore.handoutPdf(id), pdf);
		assert.equal(fs.readFileSync(recordPath, "utf8"), json, "reading existing notes never rewrites them");
		const updatedLiveNotes = edition("updated live notes");
		const step = { inputTokens: 2, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
		notesStore.change(id, record => {
			record.liveNotesEnabled = false;
			record.liveNotes = updatedLiveNotes;
			record.error.liveNotes = "Retry live notes";
			record.usage.push({ at: "later", mode: "handout", model: "fixture", step });
		});
		assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")), {
			...legacy, liveEnabled: false, live: updatedLiveNotes,
			error: { ...legacy.error, live: "Retry live notes" },
			usage: [...legacy.usage, { at: "later", mode: "final", model: "fixture", step }],
		});
		assert.deepEqual(notesStore.read(id), {
			...state, liveNotesEnabled: false, liveNotes: updatedLiveNotes,
			error: { ...state.error, liveNotes: "Retry live notes" },
			usage: [...state.usage, { at: "later", mode: "handout", model: "fixture", step }],
		});
		assert.deepEqual(notesStore.handoutPdf(id), pdf);
	} finally {
		notesStore.delete(id);
	}
});

it("creates links with app terminology and still opens older handout and live notes links", () => {
	for (const mode of ["handout", "liveNotes"] as const) {
		const href = noteHref("lesson 1", mode, "topic/2");
		assert.equal(href, `/chat/lesson%201?notes=${mode}&section=topic%2F2`);
		assert.equal(noteModeFromQuery(new URL(href, "http://localhost").searchParams.get("notes")), mode);
	}
	assert.equal(noteModeFromQuery("final"), "handout");
	assert.equal(noteModeFromQuery("live"), "liveNotes");
	for (const value of [undefined, null, "unknown", ["handout", "liveNotes"]])
		assert.equal(noteModeFromQuery(value), undefined);
});

it("closes a topic at the transition, includes revealed explanations, and never exports unposed answer keys or diagnostics", () => {
	const messages = [
		said("probe", "Diagnostic preamble", { id: "p", name: "probe", arguments: {} }),
		atTopic("a1", "a", "A first explanation"),
		atTopic("a2", "a", "A second explanation"),
		result("r", "a2-q", "quiz", { questionText: "Which direction?", explanation: "Confirmed explanation." }),
		atTopic("b1", "b", "A different topic"),
		atTopic("a3", "a", "A correction to the first topic"),
	];
	const evidence = noteEvidence(messages);
	assert.deepEqual(
		evidence.closed.map(p => p.messageId),
		["a1", "a2", "r", "b1"],
	);
	assert.deepEqual(
		evidence.all.map(p => p.topic),
		["a", "a", "a", "b", "a"],
	);
	assert.doesNotMatch(JSON.stringify(evidence), /Diagnostic preamble|HIDDEN/);
	assert.match(JSON.stringify(evidence), /Confirmed explanation/);
	assert.deepEqual(
		noteEvidence([said("old", "Historical prose")]).all.map(p => p.text),
		["Historical prose"],
	);
});
it("only includes practice solutions after a successful, non-dismissed conclusion", () => {
	const pose = (key: string) => [
		said("p" + key, "", {
			id: key,
			name: "problem",
			arguments: { statement: "Find x", modelSolution: "solution " + key },
		}),
		result("pr" + key, key, "problem", {}),
	];
	const end = (key: string, outcome: string) => [
		said("e" + key, "", { id: "end" + key, name: "conclude", arguments: { outcome } }),
		result("er" + key, "end" + key, "conclude", {}),
	];
	const thinking = {
		id: "attempt",
		role: "custom",
		customType: "practice-thinking",
		details: { problemCallId: "one", text: "An attempted substitution" },
	} as LhMessage;
	const messages = [
		...pose("one"),
		thinking,
		said("hint", "Substitute first."),
		...end("one", "solved"),
		...pose("two"),
		...end("two", "dismissed"),
		...pose("three"),
	];
	const visible = JSON.stringify(noteEvidence(messages, "practice"));
	assert.match(visible, /solution one/);
	assert.match(visible, /Substitute first/);
	assert.doesNotMatch(visible, /solution two|solution three/);
	assert.match(visible, /Learner attempt: An attempted substitution/);
});
it("attaches delayed check answers to the topic that posed them", () => {
	const first = atTopic("a", "first", "First idea.");
	const second = atTopic("b", "second", "Second idea.");
	const late = result("r", "a-q", "quiz", { explanation: "Why the first idea works." });
	const evidence = noteEvidence([first, second, late]);
	assert.deepEqual(
		evidence.closed.map(p => [p.messageId, p.topic]),
		[
			["a", "first"],
			["r", "first"],
		],
	);
});
it("attaches an explicit output step to the check that follows in the same teacher turn", () => {
	const output = said("switch", "", { id: "send", name: "send_to_user", arguments: { message: "The second idea." } });
	assert.equal(output.role, "assistant");
	output.stopReason = "toolUse";
	const evidence = noteEvidence([
		atTopic("a", "first", "First."),
		output,
		result("s", "send", "send_to_user", {}),
		atTopic("b", "second", "Check the second idea."),
	]);
	assert.deepEqual(
		evidence.closed.map(p => p.messageId),
		["a"],
	);
	assert.deepEqual(
		evidence.all.map(p => p.topic),
		["first", "second", "second"],
	);
});
it("renders typeset math and escapes supplied markup in shared print and screen HTML", () => {
	const html = noteDocumentHtml({ ...sample, title: "<img src=x onerror=alert(1)>" });
	assert.match(html, /&lt;img/);
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /class="katex"/);
	assert.match(noteTextHtml("$$A=PDP^{-1}$$", true), /katex-display/);
	assert.match(html, /<strong>Theorem<\/strong>/);
});

it("numbers saved model headings once and preserves numbers that are part of the heading", () => {
	for (const heading of ["8. Eigenvectors", "8) Eigenvectors", "8. 8. Eigenvectors", "8.2. Eigenvectors"]) {
		const html = noteDocumentHtml({ ...sample, sections: [{ ...sample.sections[0]!, heading }] });
		assert.match(html, /<h2><span>1\.<\/span> Eigenvectors<\/h2>/);
	}
	for (const heading of ["2D rotations", "3.14 as an approximation", "$2^n$ powers"])
		assert.equal(noteSectionHeading(heading), heading);
});

it("keeps prose paragraphs and display equations separate, and labels both saved and newly titled examples safely", () => {
	const doc: NoteDocument = { ...sample, sections: [{
		...sample.sections[0]!, blocks: [
			{ kind: "paragraph", text: "First paragraph.\n\nNext paragraph introduces\n$$x=1$$\nThe result." },
			{ kind: "example", title: "Comparing $x^2$ <script>alert(1)</script>", text: "An explanation." },
			{ kind: "example", text: "An older saved example without a title." },
		],
	}, { ...sample.sections[1]!, blocks: [{ kind: "example", title: "Another topic", text: "A different example." }] }] };
	const { document } = parseHTML(noteDocumentHtml(doc));
	assert.deepEqual([...document.querySelectorAll("section:first-of-type > p")].map(p => p.textContent), [
		"First paragraph.", "Next paragraph introduces", "The result.",
	]);
	assert.equal(document.querySelectorAll("p .katex-display").length, 0);
	assert.equal(document.querySelectorAll(".note-equation .katex-display").length, 1);
	assert.deepEqual([...document.querySelectorAll(".note-example strong")].map(p => p.textContent), ["Example 1.1", "Example 1.2", "Example 2.1"]);
	assert.equal(document.querySelectorAll("script").length, 0);
	assert.match(document.querySelector(".note-block-title")!.textContent!, /<script>alert\(1\)<\/script>/);
	assert.match(noteSectionText(doc.sections[0]!), /Comparing \$x\^2\$/);
});

it("downloads PDFs using the current session title, including Unicode and safe header characters", async () => {
	const { stores } = await import("../src/server/index.ts");
	const { GET } = await import("../app/api/chats/[id]/notes/pdf/route.ts");
	const chat = stores.chatStore.createChat("Original title");
	notesStore.saveHandoutPdf(chat.id, { document: sample, fingerprint: "fixture", writtenAt: "now" }, Buffer.from("%PDF-title"));
	try {
		for (const [title, expected] of [
			["Eigenvalues and eigenvectors", "Eigenvalues and eigenvectors.pdf"],
			["Étude de λ", "Étude de λ.pdf"],
			['A/B: "quoted"\r\nlesson', 'A-B- -quoted-lesson.pdf'],
		]) {
			stores.chatStore.renameChat(chat.id, title!);
			const response = await GET(new Request("http://localhost/notes/pdf"), { params: Promise.resolve({ id: chat.id }) });
			assert.equal(response.status, 200);
			const disposition = response.headers.get("content-disposition")!;
			assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!), expected);
			assert.doesNotMatch(disposition, /[\r\n]/);
			assert.ok(!disposition.includes(chat.id));
			assert.equal(await response.text(), "%PDF-title");
		}
	} finally {
		notesStore.delete(chat.id);
		fs.unlinkSync(path.join(root, "chats", chat.id + ".json"));
	}
});

it("repairs a legacy PDF from its saved text without another model run or changing a pending handout", async () => {
	const chat: ChatRecord = { id: "legacy_pdf", title: "Existing notes", createdAt: "now", updatedAt: "now", messages: [] };
	const document = { ...sample, sections: [{ ...sample.sections[0]!, heading: "8. Eigenvectors" }] };
	const edition = { document, fingerprint: "old", writtenAt: "before" };
	notesStore.saveHandoutPdf(chat.id, edition, Buffer.from("%PDF-old"));
	notesStore.change(chat.id, state => {
		delete state.handoutPdfLayoutVersion;
		state.pendingHandout = { ...edition, fingerprint: "pending" };
		state.error.handout = "A pending generation error";
	});
	let printed = 0;
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => { throw new Error("No model is needed"); },
		writeNotes: async () => { throw new Error("Use the existing handout"); },
		printPdf: async doc => {
			printed++;
			assert.match(noteDocumentHtml(doc), /<h2><span>1\.<\/span> Eigenvectors<\/h2>/);
			return Buffer.from("%PDF-corrected");
		},
	});
	assert.equal(new TextDecoder().decode(await api.sessionNotesPdf(chat.id)), "%PDF-corrected");
	assert.equal(new TextDecoder().decode(await api.sessionNotesPdf(chat.id)), "%PDF-corrected");
	assert.equal(printed, 1);
	assert.equal(notesStore.read(chat.id).handoutPdfLayoutVersion, HANDOUT_PDF_LAYOUT_VERSION);
	assert.equal(notesStore.read(chat.id).pendingHandout?.fingerprint, "pending");
	assert.equal(notesStore.read(chat.id).handout?.fingerprint, "old");
	assert.equal(notesStore.read(chat.id).error.handout, "A pending generation error");
});

it("refreshes an old PDF layout without touching its text, and preserves the old file if printing fails", async () => {
	const chat: ChatRecord = { id: "old_layout", title: "Old layout", createdAt: "now", updatedAt: "now", messages: [] };
	const edition = { document: sample, fingerprint: "published", writtenAt: "before" };
	notesStore.saveHandoutPdf(chat.id, edition, Buffer.from("%PDF-old"));
	notesStore.change(chat.id, state => { delete state.handoutPdfLayoutVersion; });
	let fail = true;
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => { throw new Error("No model is needed"); },
		writeNotes: async () => { throw new Error("Use saved text"); },
		printPdf: async doc => {
			assert.deepEqual(doc, sample);
			if (fail) throw new Error("Printer unavailable");
			return Buffer.from("%PDF-new-layout");
		},
	});
	await assert.rejects(api.sessionNotesPdf(chat.id), /Printer unavailable/);
	assert.equal(new TextDecoder().decode(notesStore.handoutPdf(chat.id)!), "%PDF-old");
	assert.equal(notesStore.read(chat.id).handoutPdfLayoutVersion, undefined);
	fail = false;
	assert.equal(new TextDecoder().decode(await api.sessionNotesPdf(chat.id)), "%PDF-new-layout");
	assert.deepEqual(notesStore.read(chat.id).handout, edition);
	assert.deepEqual(notesStore.read(chat.id).usage, []);
});

it("does not replace a newer handout or recreate deleted notes when an older PDF refresh finishes", async () => {
	for (const deleted of [false, true]) {
		const chat: ChatRecord = { id: "refresh_race_" + deleted, title: "Refresh race", createdAt: "now", updatedAt: "now", messages: [] };
		const edition = { document: sample, fingerprint: "published", writtenAt: "before" };
		notesStore.saveHandoutPdf(chat.id, edition, Buffer.from("%PDF-old"));
		notesStore.change(chat.id, state => { delete state.handoutPdfLayoutVersion; });
		const rendering = Promise.withResolvers<Uint8Array>();
		const api = createSessionNotesService({
			chatStore: { getChat: () => chat }, notesStore,
			engineFor: () => { throw new Error("No model is needed"); },
			writeNotes: async () => { throw new Error("Use saved text"); },
			printPdf: () => rendering.promise,
		});
		const download = api.sessionNotesPdf(chat.id);
		if (deleted) notesStore.delete(chat.id);
		else notesStore.saveHandoutPdf(chat.id, { ...edition, writtenAt: "newer", document: { ...sample, title: "New handout" } }, Buffer.from("%PDF-newer"));
		rendering.resolve(Buffer.from("%PDF-refreshed-old"));
		await download;
		if (deleted) assert.equal(fs.existsSync(path.join(root, "notes", chat.id)), false);
		else {
			assert.equal(notesStore.read(chat.id).handout?.writtenAt, "newer");
			assert.equal(new TextDecoder().decode(notesStore.handoutPdf(chat.id)!), "%PDF-newer");
		}
	}
});

it("resolves sections after later graph extraction and removes notes attachments but preserves retained graph tags on session deletion", async () => {
	const { stores, sourceDirectory, noteIndex, deleteChatSession } = await import("../src/server/index.ts");
	const { GET: getSources } = await import("../app/api/graph/sources/route.ts");
	const { GET: getNodeNotes } = await import("../app/api/graph/nodes/[id]/notes/route.ts");
	const session = stores.chatStore.createChat("A previous teaching session");
	const practice = stores.chatStore.createChat("Practice session", "practice");
	const edition = { document: sample, fingerprint: "test", writtenAt: "now" };
	notesStore.saveHandoutPdf(session.id, edition, Buffer.from("%PDF-test"));
	notesStore.saveHandoutPdf(
		practice.id,
		{ ...edition, document: { ...sample, sections: [{ ...sample.sections[1]!, graphNodeIds: ["n_method"] }] } },
		Buffer.from("%PDF-practice"),
	);
	assert.deepEqual(noteIndex("n_method"), []);
	stores.graphStore.appendNode({
		id: "n_method",
		name: "Eigenvectors",
		statement: "A nonzero vector is scaled.",
		aliases: [],
		createdAt: "now",
		provenance: [{ chatId: session.id, messageId: "m1" }],
	});
	const nodeNotes = await getNodeNotes(new Request("http://localhost/api/graph/nodes/n_method/notes"), {
		params: Promise.resolve({ id: "n_method" }),
	});
	const links: NoteIndexEntry[] = await nodeNotes.json();
	assert.deepEqual(
		links.map(n => [n.chatId, n.sectionId]),
		[
			[session.id, "eigenbasis"],
			[practice.id, "diagonalize"],
		],
	);
	const sources = "http://localhost/api/graph/sources";
	const directory = await (await getSources(new Request(sources))).json();
	const library = await (await getSources(new Request(sources + "?include=notes"))).json();
	assert.deepEqual(library.sources, directory.sources);
	assert.equal(Object.hasOwn(directory, "notes"), false);
	assert.deepEqual(new Set(library.notes.map((n: NoteIndexEntry) => n.chatId)), new Set([session.id, practice.id]));
	const tag = sourceDirectory.change({ action: "create-tag", name: "Linear algebra", parentId: null }).createdTagId!;
	sourceDirectory.change({ action: "tag-sources", sourceIds: [session.id, practice.id], add: [tag], remove: [] });
	const { GET: getChats } = await import("../app/api/chats/route.ts");
	const listed = await (await getChats()).json();
	for (const id of [session.id, practice.id]) {
		assert.deepEqual(listed.chats.find((chat: { id: string }) => chat.id === id).tags.map((tag: { name: string }) => tag.name), ["Linear algebra"]);
	}
	const outcome = await deleteChatSession(session.id, "preserve-graph");
	assert.equal(outcome.ok, true);
	assert.equal(fs.existsSync(path.join(root, "notes", session.id)), false);
	assert.deepEqual(sourceDirectory.read().organization.placements[session.id]?.tagIds, [tag]);
	assert.deepEqual(
		noteIndex("n_method").map(n => n.chatId),
		[practice.id],
	);
});

it("composes a long lesson from all original passages through bounded calls, with validated source anchors", async () => {
	const faux = createFauxCore({});
	const seen = new Set<string>();
	let calls = 0;
	const responder: FauxResponseFactory = ctx => {
		const last = ctx.messages.find(message => message.role === "user");
		assert.ok(last);
		const text =
			typeof last.content === "string"
				? last.content
				: (last.content as { text: string }[]).map(p => p.text).join("");
		const input = text
			.split("Source passages:\n")[1]!
			.split("\n")
			.map(line => JSON.parse(line) as { ids: string[]; text: string });
		const ids = [...new Set(input.flatMap(p => p.ids))];
		for (const id of ids) seen.add(id);
		calls++;
		return fauxAssistantMessage(
			[
				fauxToolCall("submit_notes", {
					overview: "One coherent summary.",
					sections: [
						{
							heading: "Shared mechanism",
							sourceIds: ids,
							blocks: [{ kind: "definition", text: "$Av=\\lambda v$." }],
						},
					],
				}),
			],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 15 }, () => responder));
	const passages = ["first", "middle", "last"].map(id => ({ messageId: id, topic: id, text: id.repeat(1700) }));
	const doc = await writeSessionNotes({
		chatId: "test_long",
		title: "Long lesson",
		mode: "handout",
		practice: false,
		passages,
		engine: { model: { ...faux.getModel(), contextWindow: 4000 }, streamFn: faux.streamSimple },
		signal: new AbortController().signal,
		onUsage() {},
	});
	assert.ok(calls > 1);
	assert.deepEqual([...seen], ["first", "middle", "last"]);
	assert.deepEqual(doc.sections[0]?.sourceIds, ["first", "middle", "last"]);
});

it("stops an unresponsive notes stream, releases its background slot, and ignores a late response", async () => {
	const source = new AssistantMessageEventStream();
	const controller = new AbortController();
	const entered = Promise.withResolvers<AbortSignal>();
	let usage = 0;
	const writing = writeSessionNotes({
		chatId: "stalled_writer", title: "Stalled writer", mode: "liveNotes", practice: false,
		passages: [{ messageId: "m", topic: "A", text: "An explanation." }],
		engine: { model: createFauxCore({}).getModel(), streamFn: (_model, _context, options) => {
			entered.resolve(options!.signal!);
			return source; // Deliberately never acknowledges cancellation.
		} },
		signal: controller.signal, onUsage: () => { usage++; },
	});
	const stopped = assert.rejects(completedWithin(writing, "stalled notes cancellation", 1000), { name: "AbortError" });
	try {
		const signal = await completedWithin(entered.promise, "notes request");
		assert.equal(bgLlmSlots().active, 1);
		controller.abort();
		await stopped;
		assert.ok(signal.aborted, "cancellation still reaches the underlying provider");
		assert.equal(bgLlmSlots().active, 0, "a stalled provider cannot hold a background permit");
	} finally {
		const message = fauxAssistantMessage([fauxToolCall("submit_notes", {
			overview: "Late response", sections: [{ heading: "A", sourceIds: ["m"], blocks: [{ kind: "paragraph", text: "Late notes" }] }],
		})], { stopReason: "toolUse" });
		source.push({ type: "done", reason: "toolUse", message });
		source.end();
		await writing.catch(() => {});
	}
	await delay(0);
	assert.equal(usage, 0, "late provider events cannot update a stopped job");
});

it("times out stalled live notes without replacing saved notes or automatically retrying, then permits Update now", { timeout: 5000 }, async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const manual of [false, true]) {
		const chat: ChatRecord = {
			id: "idle_notes_" + manual, title: "Idle notes", createdAt: "now", updatedAt: "now",
			messages: [atTopic("a", "A", "First"), atTopic("b", "B", "Second")],
		};
		const previous = { document: sample, fingerprint: "previous", writtenAt: "before the stall" };
		notesStore.change(chat.id, state => { state.liveNotesEnabled = true; state.liveNotes = previous; });
		const source = new AssistantMessageEventStream();
		const entered = Promise.withResolvers<AbortSignal>();
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_notes", {
			overview: "Fresh notes", sections: ["a", "b"].map(id => ({
				heading: id, sourceIds: [id], blocks: [{ kind: "paragraph", text: "Updated explanation." }],
			})),
		})], { stopReason: "toolUse" })]);
		let calls = 0;
		const api = createSessionNotesService({
			chatStore: { getChat: () => chat }, notesStore, writeNotes: writeSessionNotes,
			engineFor: () => ({ model: faux.getModel(), streamFn: (model, context, options) => {
				if (++calls > 1) return faux.streamSimple(model, context, options);
				entered.resolve(options!.signal!);
				return source;
			} }),
			printPdf: async () => { throw new Error("No PDF for live notes"); },
		});
		try {
			if (manual) api.changeSessionNotes(chat.id, { action: "update-live-notes" });
			else api.updateLiveNotes(chat.id);
			const signal = await entered.promise;
			api.updateLiveNotes(chat.id); // A new turn can queue an automatic follow-up during the stall.
			t.mock.timers.tick(5 * 60_000 - 1);
			assert.equal(signal.aborted, false);
			t.mock.timers.tick(1);
			assert.equal(signal.aborted, true);
			t.mock.timers.tick(250);
			await nextTurn();
			const view = api.sessionNotes(chat.id, true);
			assert.deepEqual(view.running, []);
			assert.deepEqual(api.runningSessionNotes(), []);
			assert.deepEqual(view.liveNotes, previous);
			assert.match(view.error.liveNotes ?? "", /stopped responding/);
			assert.equal(bgLlmSlots().active, 0);
			api.updateLiveNotes(chat.id);
			await nextTurn();
			assert.equal(calls, 1, "refreshes and queued work must not restart the failed revision");
			api.changeSessionNotes(chat.id, { action: "update-live-notes" });
			await nextTurn();
			assert.deepEqual(api.sessionNotes(chat.id).running, []);
			assert.equal(calls, 2);
			assert.equal(api.sessionNotes(chat.id).error.liveNotes, undefined);
			assert.deepEqual(api.sessionNotes(chat.id).liveNotes?.document.sections.map(s => s.sourceIds[0]), ["a", "b"]);
		} finally {
			for (const run of api.runningSessionNotes()) api.abortSessionNotes(run.id);
			const error = { ...fauxAssistantMessage([]), stopReason: "aborted" as const };
			source.push({ type: "error", reason: "aborted", error });
			source.end();
			t.mock.timers.tick(250);
			await nextTurn();
		}
	}
});

it("keeps a long notes response alive while headers, provider events, or streamed content show progress", { timeout: 5000 }, async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const source = new AssistantMessageEventStream();
	const entered = Promise.withResolvers<SimpleStreamOptions>();
	const model = createFauxCore({}).getModel();
	const controller = new AbortController();
	const writing = writeSessionNotes({
		chatId: "progressing_notes", title: "Long notes response", mode: "handout", practice: false,
		passages: [{ messageId: "m", topic: "A", text: "An explanation." }],
		engine: { model, streamFn: (_model, _context, options) => { entered.resolve(options!); return source; } },
		signal: controller.signal, onUsage() {},
	});
	try {
		const options = await entered.promise;
		t.mock.timers.tick(4 * 60_000);
		await options.onResponse?.({ status: 200, headers: {} }, model);
		t.mock.timers.tick(4 * 60_000);
		await options.onProviderStreamEvent?.({ type: "response.in_progress" }, model);
		t.mock.timers.tick(4 * 60_000);
		const partial = fauxAssistantMessage([]);
		source.push({ type: "start", partial });
		await nextTurn();
		t.mock.timers.tick(4 * 60_000);
		source.push({ type: "thinking_delta", contentIndex: 0, delta: "Still working", partial });
		await nextTurn();
		t.mock.timers.tick(4 * 60_000);
		assert.equal(options.signal?.aborted, false, "the limit is inactivity, not total response duration");
		const message = fauxAssistantMessage([fauxToolCall("submit_notes", {
			overview: "Finished", sections: [{ heading: "A", sourceIds: ["m"], blocks: [{ kind: "paragraph", text: "Notes." }] }],
		})], { stopReason: "toolUse" });
		source.push({ type: "done", reason: "toolUse", message });
		source.end();
		assert.equal((await writing).sections[0]?.heading, "A");
		t.mock.timers.tick(10 * 60_000);
		assert.equal(options.signal?.aborted, false, "completed requests clear their timers");
	} finally {
		controller.abort();
		const error = { ...fauxAssistantMessage([]), stopReason: "aborted" as const };
		source.push({ type: "error", reason: "aborted", error });
		source.end();
		t.mock.timers.tick(250);
		await writing.catch(() => {});
	}
});

it("requires a descriptive title for newly generated examples and retains it in the saved document", async () => {
	const faux = createFauxCore({});
	const block = { kind: "example", text: "Substituting $x=2$ gives $x^2=4$." };
	faux.setResponses([undefined, "Evaluating a square"].map(title => fauxAssistantMessage([fauxToolCall("submit_notes", {
		overview: "Substitution.", sections: [{ heading: "Evaluate an expression", sourceIds: ["m"], blocks: [{ ...block, ...(title ? { title } : {}) }] }],
	})], { stopReason: "toolUse" })));
	let calls = 0;
	const doc = await writeSessionNotes({
		chatId: "example_title", title: "Substitution", mode: "handout", practice: false,
		passages: [{ messageId: "m", topic: "substitution", text: "At x=2, x squared is 4." }],
		engine: { model: faux.getModel(), streamFn: faux.streamSimple }, signal: new AbortController().signal,
		onUsage: () => { calls++; },
	});
	assert.equal(calls, 2);
	assert.equal(doc.sections[0]?.blocks[0]?.title, "Evaluating a square");
});

it("loads the notes prompt edited in Settings into the real writer and respects its switch", async () => {
	const { GET: getPrompts } = await import("../app/api/settings/prompts/route.ts");
	const { PUT: putPrompt, DELETE: deletePrompt } = await import("../app/api/settings/prompts/[...segment]/route.ts");
	const { PUT: putSettings } = await import("../app/api/settings/[section]/route.ts");
	const { readSettingsRecord } = await import("../src/server/index.ts");
	const segment = "notes/00-base.md";
	const context = { params: Promise.resolve({ segment: segment.split("/") }) };
	const override = "SYNTHETIC NOTES INSTRUCTIONS";
	const saved = await putPrompt(new Request("http://test/api/settings/prompts", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: override }),
	}), context);
	assert.equal(saved.status, 200);
	try {
		for (const enabled of [false, true, false]) {
			const switched = await putSettings(new Request("http://test/api/settings/agent", {
				method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompts: enabled ? { [segment]: true } : {} }),
			}), { params: Promise.resolve({ section: "agent" }) });
			assert.equal(switched.status, 200);
			const view = await (await getPrompts()).json();
			assert.deepEqual(view.notes.map((row: { path: string }) => row.path), [segment]);
			assert.equal(view.notes[0].enabled, enabled);
			const faux = createFauxCore({});
			faux.setResponses([ctx => {
				assert.equal(ctx.messages.find(message => message.role === "system")?.content,
					enabled ? override : view.notes[0].sourceText.trim());
				return fauxAssistantMessage([fauxToolCall("submit_notes", {
					overview: "An overview.", sections: [{
						heading: "1. Eigenvectors", sourceIds: ["m1"], blocks: [{ kind: "definition", text: "A direction preserved." }],
					}],
				})], { stopReason: "toolUse" });
			}]);
			const doc = await writeSessionNotes({
				chatId: "prompt_test", title: "Eigenvectors", mode: "handout", practice: false,
				passages: [{ messageId: "m1", topic: "basis", text: "An eigenvector preserves its direction." }],
				engine: { model: faux.getModel(), streamFn: faux.streamSimple },
				signal: new AbortController().signal,
				promptSwitches: readSettingsRecord()?.agent?.prompts,
				onUsage() {},
			});
			assert.equal(doc.sections[0]?.heading, "Eigenvectors");
		}
	} finally {
		await deletePrompt(new Request("http://test/api/settings/prompts", { method: "DELETE" }), context);
	}
});

it("keeps the published handout during regeneration, retries just the PDF, and discards in-flight output on deletion", async () => {
	const chat: ChatRecord = {
		id: "fixture",
		title: "Matrix lesson",
		createdAt: "now",
		updatedAt: "now",
		messages: [atTopic("a", "A", "First"), atTopic("b", "B", "Second")],
	};
	const modes: NoteMode[] = [];
	let deleted = false,
		failPrint = false;
	let hold: (() => void) | undefined;
	let pausePrint = false;
	const faux = createFauxCore({});
	const api = createSessionNotesService({
		chatStore: { getChat: () => (deleted ? null : chat) },
		notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => {
			modes.push(opts.mode);
			return {
				...sample,
				title: chat.title,
				sections: opts.passages.map(p => ({
					id: p.messageId,
					heading: p.topic,
					nodeIds: [p.topic],
					sourceIds: [p.messageId],
					blocks: [{ kind: "paragraph", text: p.text }],
				})),
			};
		},
		printPdf: async () => {
			if (pausePrint)
				await new Promise<void>(r => {
					hold = r;
				});
			if (failPrint) throw new Error("Printer failed");
			return Buffer.from("%PDF-fixture");
		},
	});
	async function idle() {
		for (let i = 0; i < 100 && api.sessionNotes(chat.id).running.length; i++) await delay(2);
		assert.deepEqual(api.sessionNotes(chat.id).running, []);
	}
	api.changeSessionNotes(chat.id, { action: "set-live-notes-enabled", enabled: true });
	await idle();
	assert.deepEqual(
		api.sessionNotes(chat.id).liveNotes?.document.sections.map(s => s.sourceIds[0]),
		["a"],
	);
	chat.messages.push(atTopic("b2", "B", "Still B"));
	api.updateLiveNotes(chat.id);
	await idle();
	assert.deepEqual(modes, ["liveNotes"]);
	api.changeSessionNotes(chat.id, { action: "generate-handout" });
	api.changeSessionNotes(chat.id, { action: "generate-handout" });
	await idle();
	const first = api.sessionNotes(chat.id).handout!;
	assert.deepEqual(
		first.document.sections.map(s => s.sourceIds[0]),
		["a", "b", "b2"],
	);
	chat.messages.push(atTopic("c", "A", "Revisit A"));
	api.sessionNotes(chat.id, true); // Reopening catches a boundary previously saved while the worker was offline.
	await idle();
	assert.equal(api.sessionNotes(chat.id).handoutOutdated, true);
	failPrint = true;
	api.changeSessionNotes(chat.id, { action: "generate-handout" });
	await idle();
	assert.equal(api.sessionNotes(chat.id).handout?.fingerprint, first.fingerprint);
	assert.equal(api.sessionNotes(chat.id).handoutPdfPending, true);
	failPrint = false;
	api.changeSessionNotes(chat.id, { action: "retry-handout-pdf" });
	await idle();
	assert.equal(api.sessionNotes(chat.id).handoutOutdated, false);
	assert.equal(new TextDecoder().decode(await api.sessionNotesPdf(chat.id)), "%PDF-fixture");
	assert.deepEqual(modes, ["liveNotes", "handout", "liveNotes", "handout"]);
	pausePrint = true;
	api.changeSessionNotes(chat.id, { action: "generate-handout" });
	await delay(5);
	assert.ok(hold);
	deleted = true;
	api.discardSessionNotes(chat.id);
	hold();
	await delay(5);
	assert.equal(fs.existsSync(path.join(root, "notes", chat.id)), false);
});

it("manually refreshes the current topic while paused, retries unchanged material, and leaves the handout and PDF intact", async () => {
	const chat: ChatRecord = {
		id: "manual_live", title: "Current topic", createdAt: "now", updatedAt: "now",
		messages: [atTopic("a", "A", "First explanation"), atTopic("a2", "A", "Current explanation")],
	};
	const published = { document: sample, fingerprint: "saved", writtenAt: "before" };
	notesStore.saveHandoutPdf(chat.id, published, Buffer.from("%PDF-saved"));
	const faux = createFauxCore({});
	let calls = 0, fail = false;
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => {
			calls++;
			assert.equal(opts.mode, "liveNotes");
			assert.deepEqual(opts.passages.map(p => p.messageId), ["a", "a2"]);
			if (fail) throw new Error("Live writer failed");
			return passageNotes(opts.passages);
		},
		printPdf: async () => { throw new Error("A live refresh must not print a PDF"); },
	});
	assert.deepEqual(api.sessionNotes(chat.id, true).running, []);
	assert.equal(calls, 0);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	const firstLiveNotes = api.sessionNotes(chat.id).liveNotes;
	assert.deepEqual(firstLiveNotes?.document.sections.map(s => s.sourceIds[0]), ["a", "a2"]);
	assert.equal(api.sessionNotes(chat.id).liveNotesEnabled, false);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	assert.equal(calls, 2, "Update now forces a refresh even when the lesson has not changed");
	fail = true;
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	assert.equal(api.sessionNotes(chat.id).error.liveNotes, "Live writer failed");
	assert.deepEqual(api.sessionNotes(chat.id).liveNotes?.document, firstLiveNotes?.document);
	fail = false;
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	assert.equal(calls, 4, "a failed revision can be retried explicitly");
	assert.equal(api.sessionNotes(chat.id).error.liveNotes, undefined);
	assert.equal(api.sessionNotes(chat.id, true).liveNotesEnabled, false);
	api.updateLiveNotes(chat.id);
	await notesIdle(api, chat.id);
	assert.equal(calls, 4);
	assert.deepEqual(api.sessionNotes(chat.id).handout, published);
	assert.equal(new TextDecoder().decode(await api.sessionNotesPdf(chat.id)), "%PDF-saved");
});

it("resumes automatic summaries without dropping current-topic material captured by Update now", async () => {
	const chat: ChatRecord = {
		id: "manual_then_auto", title: "Revisiting topics", createdAt: "now", updatedAt: "now",
		messages: [atTopic("a", "A", "First"), atTopic("b", "B", "Second"), atTopic("a2", "A", "Revisited A")],
	};
	const faux = createFauxCore({});
	let calls = 0;
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => { calls++; return passageNotes(opts.passages); },
		printPdf: async () => { throw new Error("No PDF for live notes"); },
	});
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	api.changeSessionNotes(chat.id, { action: "set-live-notes-enabled", enabled: true });
	api.sessionNotes(chat.id, true);
	await notesIdle(api, chat.id);
	assert.equal(calls, 1, "resuming does not replace the manual refresh with an older closed-topic summary");
	chat.messages.push(result("late", "a-q", "quiz", { explanation: "A delayed explanation from the earlier visit" }));
	api.updateLiveNotes(chat.id);
	await notesIdle(api, chat.id);
	assert.equal(calls, 2);
	assert.deepEqual(api.sessionNotes(chat.id).liveNotes?.document.sections.map(s => s.sourceIds[0]), ["a", "a2", "late", "b"]);
	chat.messages.push(atTopic("c", "C", "Third topic"));
	api.updateLiveNotes(chat.id);
	await notesIdle(api, chat.id);
	assert.equal(calls, 3);
	assert.deepEqual(api.sessionNotes(chat.id).liveNotes?.document.sections.map(s => s.sourceIds[0]), ["a", "a2", "late", "b"]);
});

it("retains a requested manual refresh across an automatic run and pause, without duplicating it", async () => {
	const chat: ChatRecord = {
		id: "queued_manual", title: "Concurrent notes", createdAt: "now", updatedAt: "now",
		messages: [atTopic("a", "A", "First"), atTopic("b", "B", "Second")],
	};
	const faux = createFauxCore({});
	const releases: (() => void)[] = [];
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => {
			await new Promise<void>(resolve => releases.push(resolve));
			opts.signal.throwIfAborted();
			return passageNotes(opts.passages);
		},
		printPdf: async () => { throw new Error("No PDF for live notes"); },
	});
	api.changeSessionNotes(chat.id, { action: "set-live-notes-enabled", enabled: true });
	await delay(5);
	assert.equal(releases.length, 1);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	api.changeSessionNotes(chat.id, { action: "set-live-notes-enabled", enabled: false });
	chat.messages.push(atTopic("b2", "B", "More current material"));
	releases[0]!();
	await delay(5);
	assert.equal(releases.length, 2);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	api.changeSessionNotes(chat.id, { action: "set-live-notes-enabled", enabled: false });
	releases[1]!();
	await notesIdle(api, chat.id);
	assert.equal(releases.length, 2, "concurrent requests share the same manual refresh");
	assert.equal(api.sessionNotes(chat.id).liveNotesEnabled, false);
	assert.deepEqual(api.sessionNotes(chat.id).liveNotes?.document.sections.map(s => s.sourceIds[0]), ["a", "b", "b2"]);
});

it("does not immediately restart automatic work after a manual refresh is stopped or fails", async () => {
	const chat: ChatRecord = {
		id: "stopped_manual", title: "Stop live work", createdAt: "now", updatedAt: "now",
		messages: [atTopic("a", "A", "First"), atTopic("b", "B", "Second")],
	};
	notesStore.change(chat.id, state => { state.liveNotesEnabled = true; });
	const faux = createFauxCore({});
	let release: (() => void) | undefined, calls = 0;
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => {
			calls++;
			if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
			opts.signal.throwIfAborted();
			if (calls === 2) throw new Error("Writer failed");
			return passageNotes(opts.passages);
		},
		printPdf: async () => { throw new Error("No PDF for live notes"); },
	});
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await delay(5);
	assert.ok(release);
	assert.deepEqual(api.abortSessionNotes("liveNotes" + chat.id), { ok: true });
	release();
	await notesIdle(api, chat.id);
	assert.deepEqual(api.sessionNotes(chat.id, true).running, []);
	api.updateLiveNotes(chat.id);
	assert.equal(calls, 1);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	assert.equal(api.sessionNotes(chat.id, true).error.liveNotes, "Writer failed");
	assert.deepEqual(api.sessionNotes(chat.id, true).running, []);
	api.updateLiveNotes(chat.id);
	assert.equal(calls, 2);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	assert.equal(calls, 3, "Update now can explicitly retry both stopped and failed work");
	assert.ok(api.sessionNotes(chat.id).liveNotes);
});

it("refuses a manual practice refresh until a problem is completed and excludes the next unsolved problem", async () => {
	const chat: ChatRecord = {
		id: "manual_practice", kind: "practice", title: "Practice", createdAt: "now", updatedAt: "now",
		messages: [
			said("p", "", { id: "p1", name: "problem", arguments: { statement: "Solve this", modelSolution: "Completed solution" } }),
			result("pr", "p1", "problem", {}),
		],
	};
	const faux = createFauxCore({});
	let written: NotePassage[] = [];
	const api = createSessionNotesService({
		chatStore: { getChat: () => chat }, notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => { written = opts.passages; return passageNotes(opts.passages); },
		printPdf: async () => { throw new Error("No PDF for live notes"); },
	});
	assert.throws(() => api.changeSessionNotes(chat.id, { action: "update-live-notes" }), { status: 409 });
	assert.deepEqual(written, []);
	chat.messages.push(
		said("end", "Solved", { id: "end1", name: "conclude", arguments: { outcome: "solved" } }),
		result("ended", "end1", "conclude", {}),
		said("next", "", { id: "p2", name: "problem", arguments: { statement: "Next problem", modelSolution: "Unrevealed solution" } }),
		result("next-result", "p2", "problem", {}),
	);
	api.changeSessionNotes(chat.id, { action: "update-live-notes" });
	await notesIdle(api, chat.id);
	assert.match(JSON.stringify(written), /Completed solution/);
	assert.doesNotMatch(JSON.stringify(written), /Next problem|Unrevealed solution/);
});

it("publishes live notes and handout writers in the activity feed and stops each through the dock endpoint", async () => {
	const { stores } = await import("../src/server/index.ts");
	const { GET: getActivity } = await import("../app/api/activity/route.ts");
	const { POST: abortActivity } = await import("../app/api/activity/abort/route.ts");
	const { subscribe } = await import("../src/core/events.ts");
	const sharedWork = (globalThis as typeof globalThis & {
		__lhNoteWork: NonNullable<Parameters<typeof createSessionNotesService>[1]>;
	}).__lhNoteWork;
	const chat = stores.chatStore.createChat("Notes activity");
	stores.chatStore.saveMessages(chat.id, [atTopic("a", "A", "First"), atTopic("b", "B", "Second")]);
	const published = { document: sample, fingerprint: "published", writtenAt: "before" };
	notesStore.saveHandoutPdf(chat.id, published, Buffer.from("%PDF-published"));
	const release = new Map<NoteMode, () => void>();
	const faux = createFauxCore({});
	let events = 0;
	const stopEvents = subscribe(event => { if (event.type === "notes-changed" && event.chatId === chat.id) events++; });
	const api = createSessionNotesService({
		chatStore: stores.chatStore, notesStore,
		engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		writeNotes: async opts => {
			opts.onUsage({ ...fauxAssistantMessage("fixture").usage, input: 12, output: 5 }, "faux:notes");
			await new Promise<void>(resolve => { release.set(opts.mode, resolve); });
			opts.signal.throwIfAborted();
			return sample;
		},
		printPdf: async () => Buffer.from("%PDF-new"),
	}, sharedWork);
	try {
		api.changeSessionNotes(chat.id, { action: "generate-handout" });
		api.changeSessionNotes(chat.id, { action: "set-live-notes-enabled", enabled: true });
		await delay(5);
		const feed = await (await getActivity()).json();
		const runs = feed.notes.filter((run: { chatId: string }) => run.chatId === chat.id);
		assert.deepEqual(new Set(runs.map((run: { mode: string }) => run.mode)), new Set(["liveNotes", "handout"]));
		assert.ok(runs.every((run: { title: string; usage: { steps: number } }) => run.title === chat.title && run.usage.steps === 1));
		assert.ok(events >= 4, "admission and usage both notify the activity reader");
		for (const run of runs) {
			const response = await abortActivity(new Request("http://test/api/activity/abort", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "notes", id: run.id }),
			}));
			assert.equal(response.status, 200);
			release.get(run.mode)!();
		}
		await delay(5);
		assert.equal(api.runningSessionNotes().length, 0);
		assert.deepEqual(api.sessionNotes(chat.id, true).running, [], "a refresh does not restart the stopped live revision");
		assert.equal(notesStore.read(chat.id).handout?.fingerprint, "published");
		assert.deepEqual((await (await getActivity()).json()).notes, []);
		const stoppedAgain = await abortActivity(new Request("http://test/api/activity/abort", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "notes", id: runs[0].id }),
		}));
		assert.equal(stoppedAgain.status, 409);
	} finally {
		for (const run of api.runningSessionNotes()) api.abortSessionNotes(run.id);
		for (const resume of release.values()) resume();
		await delay(5);
		stopEvents();
		notesStore.delete(chat.id);
		fs.unlinkSync(path.join(root, "chats", chat.id + ".json"));
	}
});
