import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { noteEvidence } from "../src/core/note-evidence.ts";
import { noteDocumentHtml, noteTextHtml } from "../src/core/note-render.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { NoteDocument, NoteMode } from "../src/core/session-notes.ts";

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
	fs.readFileSync(new URL("./fixtures/session-notes/diagonalization.json", import.meta.url), "utf8"),
);

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

it("resolves sections after later graph extraction and removes attachments and tag membership on session deletion", async () => {
	const { stores, sourceDirectory, noteIndex, deleteChatSession } = await import("../src/server/index.ts");
	const session = stores.chatStore.createChat("A previous teaching session");
	const practice = stores.chatStore.createChat("Practice session", "practice");
	const edition = { document: sample, fingerprint: "test", writtenAt: "now" };
	notesStore.savePdf(session.id, edition, Buffer.from("%PDF-test"));
	notesStore.savePdf(
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
	const links = noteIndex("n_method");
	assert.deepEqual(
		links.map(n => [n.chatId, n.sectionId]),
		[
			[session.id, "eigenbasis"],
			[practice.id, "diagonalize"],
		],
	);
	const tag = sourceDirectory.change({ action: "create-tag", name: "Linear algebra", parentId: null }).createdTagId!;
	sourceDirectory.change({ action: "tag-sources", sourceIds: [session.id, practice.id], add: [tag], remove: [] });
	const outcome = await deleteChatSession(session.id, "preserve-graph");
	assert.equal(outcome.ok, true);
	assert.equal(fs.existsSync(path.join(root, "notes", session.id)), false);
	assert.ok(!sourceDirectory.read().organization.placements[session.id]?.tagIds?.length);
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
		mode: "final",
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
	api.changeSessionNotes(chat.id, { action: "set-live", enabled: true });
	await idle();
	assert.deepEqual(
		api.sessionNotes(chat.id).live?.document.sections.map(s => s.sourceIds[0]),
		["a"],
	);
	chat.messages.push(atTopic("b2", "B", "Still B"));
	api.updateLiveNotes(chat.id);
	await idle();
	assert.deepEqual(modes, ["live"]);
	api.changeSessionNotes(chat.id, { action: "generate" });
	api.changeSessionNotes(chat.id, { action: "generate" });
	await idle();
	const first = api.sessionNotes(chat.id).final!;
	assert.deepEqual(
		first.document.sections.map(s => s.sourceIds[0]),
		["a", "b", "b2"],
	);
	chat.messages.push(atTopic("c", "A", "Revisit A"));
	api.sessionNotes(chat.id, true); // Reopening catches a boundary previously saved while the worker was offline.
	await idle();
	assert.equal(api.sessionNotes(chat.id).outdated, true);
	failPrint = true;
	api.changeSessionNotes(chat.id, { action: "generate" });
	await idle();
	assert.equal(api.sessionNotes(chat.id).final?.fingerprint, first.fingerprint);
	assert.equal(api.sessionNotes(chat.id).pdfPending, true);
	failPrint = false;
	api.changeSessionNotes(chat.id, { action: "retry-pdf" });
	await idle();
	assert.equal(api.sessionNotes(chat.id).outdated, false);
	assert.equal(api.sessionNotesPdf(chat.id).toString(), "%PDF-fixture");
	assert.deepEqual(modes, ["live", "final", "live", "final"]);
	pausePrint = true;
	api.changeSessionNotes(chat.id, { action: "generate" });
	await delay(5);
	assert.ok(hold);
	deleted = true;
	api.discardSessionNotes(chat.id);
	hold();
	await delay(5);
	assert.equal(fs.existsSync(path.join(root, "notes", chat.id)), false);
});
