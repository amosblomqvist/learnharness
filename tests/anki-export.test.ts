/**
 * THE ANKI EXPORT (owner, 2026-11-01): the recall cards the agent wrote.
 * Two layers: the pure engine (ankiCards + ankiTsv) and the route contract
 * (404 unknown chat, TSV attachment, 204 when nothing to export).
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline: the
 * seam is set before any config-loading import, so every app-module import
 * is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	ankiCards,
	ankiTsv,
	newAnswerResult,
	PRACTICE_CONCLUDE_TOOL,
	RECALL_CARDS_TOOL,
	type LhMessage,
} from "../src/core/index.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-export-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Get = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let GET: Get;
let createChat: (title: string, kind?: "practice") => { id: string; title: string };
let saveMessages: (id: string, messages: unknown[]) => void;

before(async () => {
	const route = await import("../app/api/chats/[id]/anki/route.ts");
	GET = route.GET;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
});

// ── builders (native-shaped test fixtures) ──────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

/** One `recall_cards` call and its acknowledgement; `result` = null
 *  leaves the call bare (no result ever landed). */
function recallCall(id: string, cards: unknown[], result: { isError?: boolean } | null = {}): LhMessage[] {
	const call: LhMessage & AssistantMessage = {
		id: `msg_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name: RECALL_CARDS_TOOL, arguments: { cards } as never }],
		timestamp: 1,
		...STAMPS,
	};
	if (result === null) return [call];
	const ack: LhMessage & ToolResultMessage = {
		id: `msg_${id}_ack`,
		role: "toolResult",
		toolCallId: id,
		toolName: RECALL_CARDS_TOOL,
		content: [{ type: "text", text: `Saved ${cards.length} recall card(s).` }],
		details: null,
		isError: result.isError ?? false,
		timestamp: 2,
	};
	return [call, ack];
}

function quizAnswer(opts: { correct: boolean }): LhMessage[] {
	const data: QuestionAnswerData = {
		kind: "quiz",
		tool: "quiz",
		questionText: "Which normal form removes partial dependencies?",
		options: [
			{ index: 1, label: "1NF" },
			{ index: 2, label: "2NF" },
			{ index: 3, label: "3NF" },
		],
		dontKnow: false,
		answers: [{ label: "1NF", value: "a", index: 1 }],
		correctIndices: [2],
		explanation: "2NF removes partial dependencies on a composite key.",
		correct: opts.correct,
		answeredAt: new Date(0).toISOString(),
	};
	return [newAnswerResult("call_quiz", "quiz", data)];
}

function concludeCall(outcome: string): LhMessage[] {
	const call: LhMessage & AssistantMessage = {
		id: "msg_conclude",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_conclude", name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome } }],
		timestamp: 3,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: "msg_conclude_ack",
		role: "toolResult",
		toolCallId: "call_conclude",
		toolName: PRACTICE_CONCLUDE_TOOL,
		content: [{ type: "text", text: "Problem concluded." }],
		details: null,
		isError: false,
		timestamp: 4,
	};
	return [call, ack];
}

// ── the pure engine ─────────────────────────────────────────────────────────

describe("ankiCards (the agent's recall cards)", () => {
	it("a successful call yields its cards, in order, front and back trimmed", () => {
		const cards = ankiCards(recallCall("call_rc", [{ front: "  What is 2+2?  ", back: "  4  " }, { front: "HTTP 201 means?", back: "Created" }]));
		assert.deepEqual(cards, [
			{ front: "What is 2+2?", back: "4", tag: "learnharness" },
			{ front: "HTTP 201 means?", back: "Created", tag: "learnharness" },
		]);
	});

	it("a call with no matching toolResult yields no cards (bare or aborted call)", () => {
		assert.equal(ankiCards(recallCall("call_rc", [{ front: "F", back: "B" }], null)).length, 0);
	});

	it("a call whose toolResult has isError: true yields no cards", () => {
		assert.equal(ankiCards(recallCall("call_rc", [{ front: "F", back: "B" }], { isError: true })).length, 0);
	});

	it("a repeated front (different case) keeps the first card only", () => {
		const cards = ankiCards([
			...recallCall("call_a", [{ front: "What is 2+2?", back: "Four" }]),
			...recallCall("call_b", [{ front: "what is 2+2?", back: "4" }]),
		]);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.back, "Four");
	});

	it("blank or non-string fields are skipped, with no throw", () => {
		const cards = ankiCards(recallCall("call_rc", [
			{ front: "  ", back: "B" },
			{ front: "F", back: " \n " },
			{ front: 7, back: "B" },
			{ front: "Kept", back: "Yes" },
		]));
		assert.deepEqual(cards.map((c) => c.front), ["Kept"]);
	});

	it("a WRONG quiz answer yields NO card (missed answers are not exported)", () => {
		assert.equal(ankiCards(quizAnswer({ correct: false })).length, 0);
	});

	it("a session with only conclude and quiz results yields []", () => {
		assert.equal(ankiCards([...concludeCall("surrendered"), ...quizAnswer({ correct: false })]).length, 0);
	});

	it("the card tag is the caller's (base tag plus session slug)", () => {
		const cards = ankiCards(recallCall("call_rc", [{ front: "F", back: "B" }]), "learnharness relational-databases");
		assert.equal(cards[0]!.tag, "learnharness relational-databases");
	});
});

describe("ankiTsv (Anki's file format)", () => {
	it("writes the header lines, then one 3-field row per card", () => {
		const tsv = ankiTsv([{ front: "Front", back: "Back", tag: "learnharness" }]);
		const lines = tsv.split("\n");
		assert.equal(lines[0], "#separator:tab");
		assert.equal(lines[1], "#html:true");
		assert.equal(lines[2], "#tags column:3");
		assert.equal(lines[3], "Front\tBack\tlearnharness");
	});

	it("escapes HTML and flattens tabs and newlines — one row, always 3 fields", () => {
		const tsv = ankiTsv([{ front: "a\tb\nc", back: "x < y & z > w", tag: "learnharness" }]);
		const row = tsv.split("\n").at(-1)!;
		assert.equal(row, "a b<br>c\tx &lt; y &amp; z &gt; w\tlearnharness");
		assert.equal(row.split("\t").length, 3);
		assert.equal(tsv.split("\n").length, 4, "no field's newline breaks the file");
	});
});

// ── the route ───────────────────────────────────────────────────────────────

describe("GET /api/chats/:id/anki", () => {
	it("404s an unknown chat", async () => {
		const res = await GET(new Request("http://x/api/chats/nope/anki"), { params: Promise.resolve({ id: "nope" }) });
		assert.equal(res.status, 404);
	});

	it("exports the cards as a TSV attachment, filename from the title", async () => {
		const chat = createChat("Relational Databases — Joins");
		saveMessages(chat.id, recallCall("call_rc", [{ front: "Which normal form removes partial dependencies?", back: "2NF" }]));
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "text/tab-separated-values; charset=utf-8");
		const disposition = res.headers.get("content-disposition") ?? "";
		assert.ok(disposition.startsWith("attachment;"), "it is a download");
		assert.ok(disposition.includes('filename="relational-databases-joins-anki.txt"'), "slugified title names the file");
		const body = await res.text();
		assert.ok(body.startsWith("#separator:tab\n#html:true\n#tags column:3\n"), "the Anki headers");
		assert.ok(body.includes("Which normal form removes partial dependencies?\t2NF"), "the card rides the file");
		assert.ok(body.includes("learnharness relational-databases-joins"), "tagged with the base tag plus the session slug");
	});

	it("204s a chat with no cards", async () => {
		const chat = createChat("No cards");
		saveMessages(chat.id, quizAnswer({ correct: true }));
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 204);
		assert.equal(await res.text(), "");
	});
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
