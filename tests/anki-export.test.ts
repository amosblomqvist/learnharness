/**
 * THE ANKI EXPORT (issue #11): session quiz history → .apkg. Two pins:
 *
 *   - the BUILDER roundtrip (core/anki.ts): build a deck from fixture
 *     messages, then parse it back HERE — read the ZIP's central
 *     directory by hand, open collection.anki2 with node:sqlite, and
 *     assert the actual note/card rows, field contents, deck naming, and
 *     deterministic identities across two exports. A real roundtrip, not
 *     a smoke assert.
 *   - the ROUTE contract (app/api/chats/[id]/anki): mirrors the markdown
 *     route test — 404 unknown chat, attachment headers, .apkg filename,
 *     and a zip body that parses back to the same notes.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { ankiCardsOf, buildAnkiApkg } from "../src/core/anki.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-export-"));
process.env.LH_DATA_DIR = TMP_DATA;

// ── fixture builders (the session-markdown test's shapes) ───────────────────

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1_778_400_000_000 } as never;
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 1_778_400_000_100,
	} as never;
}

function result(
	id: string,
	toolCallId: string,
	toolName: string,
	details: unknown,
	isError = false,
): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
		timestamp: 1_778_400_000_200,
	} as never;
}

function callMsg(id: string, callId: string, name: string, args: unknown): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 1_778_400_000_150,
	} as never;
}

/** A teaching session: three card-worthy answers plus noise that exports
 *  nothing (a dismissed check, an ask preference question, an errored
 *  call that is retry context, bare prose). */
const teachingMessages: LhMessage[] = [
	user("u1", "teach me knowledge tracing"),
	teacher("a1", "Belief is a single number updated by Bayes' rule."),
	callMsg("a2", "call-q1", "quiz", {
		type: "check",
		nodeId: "bayes",
		question: "What does T stand for in the two-state update?",
		options: [
			{ label: "The slip rate.", value: "slip" },
			{ label: "The learn rate.", value: "learn" },
			{ label: "The guess rate.", value: "guess" },
		],
		explanation: "T is the learn rate — the probability an unmastered skill becomes mastered between items.",
		correctAnswer: "learn",
	}),
	result(
		"r1",
		"call-q1",
		"quiz",
		{
			kind: "quiz",
			tool: "quiz",
			questionText: "What does T stand for in the two-state update?",
			options: [
				{ index: 1, label: "The slip rate." },
				{ index: 2, label: "The learn rate." },
				{ index: 3, label: "The guess rate." },
			],
			dontKnow: false,
			answers: [{ label: "The slip rate.", value: "slip", index: 1 }],
			correct: false,
			correctIndices: [2],
			explanation: "T is the learn rate — the probability an unmastered skill becomes mastered between items.",
			answeredAt: "2026-11-09T10:00:00.000Z",
		},
	),
	result(
		"r2",
		"call-p1",
		"probe",
		{
			kind: "quiz",
			tool: "probe",
			questionText: "Is mastery directly observable?",
			options: [
				{ index: 1, label: "No — only responses are visible." },
				{ index: 2, label: "Yes." },
			],
			dontKnow: false,
			answers: [{ label: "No — only responses are visible.", value: "no", index: 1 }],
			correct: true,
			correctIndices: [1],
			answeredAt: "2026-11-09T10:01:00.000Z",
		},
	),
	result(
		"r3",
		"call-e1",
		"explain",
		{
			kind: "explain",
			tool: "explain",
			questionText: "Why is the belief update exact rather than an approximation?",
			text: "because the state is just two values",
			committed: "The update is exact because the two-state model is fully summarized by one probability: Bayes' rule over it leaves nothing unsimplified.",
			answeredAt: "2026-11-09T10:02:00.000Z",
		},
	),
	result("r4", "call-q2", "quiz", {
		kind: "quiz",
		questionText: "Skipped before answering?",
		dismissed: true,
		dontKnow: false,
		answers: [],
		answeredAt: "2026-11-09T10:03:00.000Z",
	}),
	result("r5", "call-a1", "ask_user_question", {
		kind: "ask",
		questionText: "Which strand next?",
		answers: ["estimation"],
		dontKnow: false,
		answeredAt: "2026-11-09T10:04:00.000Z",
	}),
	result("r6", "call-q3", "quiz", null, true), // errored pose — retry context
];

/** A practice session: one concluded problem (card) and one dismissed
 *  problem (no reveal — the card's refusal law). */
const practiceMessages: LhMessage[] = [
	callMsg("pa1", "call-pr1", "problem", {
		statement: "Name the three load-bearing features of knowledge tracing.",
		mode: "recall",
		target: [],
		modelSolution: "Hidden state, indirect/noisy evidence, and a state that moves over time.",
	}),
	result("pr1", "call-pr1", "problem", null),
	callMsg("pa2", "call-c1", "conclude", { outcome: "solved", verdict: "All three, correctly mapped." }),
	result("pr2", "call-c1", "conclude", null),
	callMsg("pa3", "call-pr2", "problem", { statement: "Define slip.", modelSolution: "P(correct | not mastered)." }),
	result("pr3", "call-pr2", "problem", null),
	callMsg("pa4", "call-c2", "conclude", { outcome: "dismissed" }),
	result("pr4", "call-c2", "conclude", null),
];

// ── the test-side ZIP + SQLite readers (the roundtrip's other half) ─────────

/** Parse a ZIP by walking the end-of-central-directory record backwards,
 *  then the central directory entries, then each local header. */
function readZip(bytes: Buffer): Map<string, Buffer> {
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_536); i--) {
		if (bytes.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	assert.ok(eocd >= 0, "the ZIP carries an end-of-central-directory record");
	const count = bytes.readUInt16LE(eocd + 10);
	const cdStart = bytes.readUInt32LE(eocd + 16);
	const files = new Map<string, Buffer>();
	let p = cdStart;
	for (let i = 0; i < count; i++) {
		assert.equal(bytes.readUInt32LE(p), 0x02014b50, "central directory entry signature");
		const method = bytes.readUInt16LE(p + 10);
		const csize = bytes.readUInt32LE(p + 20);
		const nameLen = bytes.readUInt16LE(p + 28);
		const extraLen = bytes.readUInt16LE(p + 30);
		const commentLen = bytes.readUInt16LE(p + 32);
		const localOffset = bytes.readUInt32LE(p + 42);
		const name = bytes.subarray(p + 46, p + 46 + nameLen).toString("utf8");
		const lnameLen = bytes.readUInt16LE(localOffset + 26);
		const lextraLen = bytes.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + lnameLen + lextraLen;
		const data = bytes.subarray(dataStart, dataStart + csize);
		files.set(name, method === 8 ? Buffer.from(inflateRawSync(data)) : Buffer.from(data));
		p += 46 + nameLen + extraLen + commentLen;
	}
	return files;
}

const scratchDirs: string[] = [];

/** Write collection.anki2 out and open it with node:sqlite — the same
 *  thing Anki's importer does. */
function openCollection(zip: Map<string, Buffer>): DatabaseSync {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-read-"));
	scratchDirs.push(dir);
	fs.writeFileSync(path.join(dir, "collection.anki2"), zip.get("collection.anki2")!);
	return new DatabaseSync(path.join(dir, "collection.anki2"));
}

interface NoteRow {
	id: number;
	guid: string;
	mid: number;
	mod: number;
	usn: number;
	tags: string;
	flds: string;
	sfld: string;
	csum: number;
}
interface CardRow {
	id: number;
	nid: number;
	did: number;
	ord: number;
	type: number;
	queue: number;
	due: number;
	ivl: number;
}

function notesOf(db: DatabaseSync): NoteRow[] {
	return db.prepare("SELECT * FROM notes ORDER BY id").all() as unknown as NoteRow[];
}

function cardsOf(db: DatabaseSync): CardRow[] {
	return db.prepare("SELECT * FROM cards ORDER BY id").all() as unknown as CardRow[];
}

// ── the builder roundtrip ────────────────────────────────────────────────────

describe("buildAnkiApkg — teaching sessions", () => {
	it("roundtrips a real .apkg: zip → sqlite → the exact note/card rows", async () => {
		const bytes = Buffer.from(
			await buildAnkiApkg({
				chatId: "chat_teach_1",
				title: "Bayesian Knowledge Tracing",
				createdAt: "2026-11-09T09:00:00.000Z",
				messages: teachingMessages,
			}),
		);
		assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK", "a ZIP file");

		const zip = readZip(bytes);
		assert.deepEqual([...zip.keys()].sort(), ["collection.anki2", "media"]);
		assert.equal(zip.get("media")!.toString("utf8"), "{}", "text-only export: the media map is empty");

		const db = openCollection(zip);
		// col: the anki2 schema stamp + the named deck + the Basic model.
		const col = db.prepare("SELECT * FROM col").all()[0] as unknown as Record<string, string | number>;
		assert.equal(col.ver, 11, "the legacy anki2 schema version");
		const decks = JSON.parse(col.decks as string) as Record<string, { name: string }>;
		const deckNames = Object.values(decks).map((d) => d.name).sort();
		assert.deepEqual(deckNames, ["Default", "LearnHarness::Bayesian Knowledge Tracing"]);
		const models = JSON.parse(col.models as string) as Record<string, { name: string; flds: { name: string }[] }>;
		const model = Object.values(models)[0]!;
		assert.equal(model.name, "LearnHarness Basic");
		assert.deepEqual(model.flds.map((f) => f.name), ["Front", "Back"]);

		// THREE notes: the graded quiz, the probe, the free recall. The
		// dismissed check, the ask question, and the errored pose export
		// nothing.
		const notes = notesOf(db);
		assert.equal(notes.length, 3);
		const cards = cardsOf(db);
		assert.equal(cards.length, 3);

		// Quiz: Front = question, Back = correct label + explanation.
		const quiz = notes[0]!;
		const [quizFront, quizBack] = quiz.flds.split("\x1f");
		assert.equal(quizFront, "What does T stand for in the two-state update?");
		assert.equal(
			quizBack,
			"The learn rate.\n\nT is the learn rate — the probability an unmastered skill becomes mastered between items.",
		);
		assert.equal(quiz.sfld, quizFront, "the sort field is the front");
		assert.ok(quiz.csum > 0, "the dupe-detection checksum is set");

		// Probe: the correct option label alone (no explanation recorded).
		const probe = notes[1]!;
		assert.equal(probe.flds.split("\x1f")[0], "Is mastery directly observable?");
		assert.equal(probe.flds.split("\x1f")[1], "No — only responses are visible.");

		// Free recall: the back side is the model's committed answer.
		const recall = notes[2]!;
		assert.equal(recall.flds.split("\x1f")[1], "The update is exact because the two-state model is fully summarized by one probability: Bayes' rule over it leaves nothing unsimplified.");

		// Cards: one per note, new queue, due in transcript order, in deck.
		const deckId = Number(Object.keys(decks).find((k) => decks[k]!.name === "LearnHarness::Bayesian Knowledge Tracing"));
		assert.ok(deckId > 1, "the session deck is not the Default deck");
		for (const [i, card] of cards.entries()) {
			assert.equal(card.nid, notes[i]!.id, `card ${i} belongs to note ${i}`);
			assert.equal(card.ord, 0, "Card 1 of the Basic template");
			assert.equal(card.did, deckId, `card ${i} lives in the session deck`);
			assert.equal(card.type, 0, "new");
			assert.equal(card.queue, 0, "new");
			assert.equal(card.due, i + 1, "new-card position follows transcript order");
			assert.equal(card.ivl, 0, "no reviews yet");
		}
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revlog").get() as { n: number }).n, 0, "empty review log");
	});

	it("practice sessions: one card per concluded problem; a dismissed problem never reveals", async () => {
		const cards = ankiCardsOf(practiceMessages);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.source, "practice");
		assert.equal(cards[0]!.front, "Name the three load-bearing features of knowledge tracing.");
		assert.equal(cards[0]!.back, "Hidden state, indirect/noisy evidence, and a state that moves over time.");

		const bytes = Buffer.from(
			await buildAnkiApkg({ chatId: "chat_prac_1", title: "Practice", messages: practiceMessages }),
		);
		const db = openCollection(readZip(bytes));
		const notes = notesOf(db);
		assert.equal(notes.length, 1);
		assert.ok(!notes[0]!.flds.includes("P(correct | not mastered)."), "the dismissed problem's solution stays hidden");
	});

	it("deterministic identities: two exports agree byte-for-byte (re-exports update, not duplicate)", async () => {
		const first = Buffer.from(
			await buildAnkiApkg({
				chatId: "chat_teach_1",
				title: "Bayesian Knowledge Tracing",
				createdAt: "2026-11-09T09:00:00.000Z",
				messages: teachingMessages,
			}),
		);
		const second = Buffer.from(
			await buildAnkiApkg({
				chatId: "chat_teach_1",
				title: "Bayesian Knowledge Tracing",
				createdAt: "2026-11-09T09:00:00.000Z",
				messages: teachingMessages,
			}),
		);
		const firstNotes = notesOf(openCollection(readZip(first)));
		const secondNotes = notesOf(openCollection(readZip(second)));
		assert.deepEqual(
			firstNotes.map((n) => [n.id, n.guid]),
			secondNotes.map((n) => [n.id, n.guid]),
			"same note ids and GUIDs across exports",
		);
		assert.equal(new Set(firstNotes.map((n) => n.guid)).size, firstNotes.length, "GUIDs are unique per card");
		assert.ok(Buffer.compare(first, second) === 0, "the whole .apkg is byte-identical");
	});

	it("a DIFFERENT chat id mints different GUIDs; an evidence-free session exports a valid empty deck", async () => {
		const a = notesOf(
			openCollection(
				readZip(Buffer.from(await buildAnkiApkg({ chatId: "chat_a", title: "T", messages: teachingMessages }))),
			),
		);
		const b = notesOf(
			openCollection(
				readZip(Buffer.from(await buildAnkiApkg({ chatId: "chat_b", title: "T", messages: teachingMessages }))),
			),
		);
		assert.notEqual(a[0]!.guid, b[0]!.guid, "GUIDs are scoped to the chat");

		const empty = Buffer.from(await buildAnkiApkg({ chatId: "chat_empty", title: "Quiet", messages: [user("u1", "hi")] }));
		const db = openCollection(readZip(empty));
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, 0);
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n, 0);
	});
});

// ── the route contract (mirrors tests/markdown-export.test.ts) ──────────────

/** The route handler + the store seam, loaded AFTER the env is set. */
type Get = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let GET: Get;
let createChat: (title: string, kind?: "practice") => { id: string; title: string; createdAt: string };
let saveMessages: (id: string, messages: unknown[]) => void;

before(async () => {
	const route = await import("../app/api/chats/[id]/anki/route.ts");
	GET = route.GET;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
});

describe("GET /api/chats/:id/anki", () => {
	it("404s an unknown chat", async () => {
		const res = await GET(new Request("http://x/api/chats/nope/anki"), { params: Promise.resolve({ id: "nope" }) });
		assert.equal(res.status, 404);
	});

	it("exports the quiz history as an .apkg attachment that parses back", async () => {
		const chat = createChat("Relational Databases — Joins & Normal Forms");
		saveMessages(chat.id, teachingMessages);
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "application/octet-stream");
		const disposition = res.headers.get("content-disposition") ?? "";
		assert.ok(disposition.startsWith("attachment;"), "it is a download");
		assert.ok(disposition.includes('filename="relational-databases-joins-normal-forms.apkg"'), "slugified title names the file");

		const bytes = Buffer.from(await res.arrayBuffer());
		assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK", "a ZIP body");
		const db = openCollection(readZip(bytes));
		const notes = notesOf(db);
		assert.equal(notes.length, 3, "the three graded answers from the fixture");
		const col = db.prepare("SELECT decks FROM col").get() as unknown as { decks: string };
		assert.ok(col.decks.includes("LearnHarness::Relational Databases — Joins & Normal Forms"), "the deck is named for the session");
		// Deterministic across route calls too: same chat, same GUIDs.
		const again = Buffer.from(await (await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) })).arrayBuffer());
		assert.ok(Buffer.compare(bytes, again) === 0, "re-exports are byte-identical");
	});

	it("an unsalvageable title falls back to 'session'", async () => {
		const chat = createChat("日本語");
		saveMessages(chat.id, teachingMessages);
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		assert.ok((res.headers.get("content-disposition") ?? "").includes('filename="session.apkg"'));
	});

	it("an evidence-free session still returns a valid (empty) deck", async () => {
		const chat = createChat("Quiet one");
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		const db = openCollection(readZip(Buffer.from(await res.arrayBuffer())));
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, 0);
	});
});

after(() => {
	for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
