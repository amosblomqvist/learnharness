/**
 * Note reviews: a side thread with a `review` marker. Parse, model turns
 * (lesson + whole notes page + highlight, spoiler rule), the service on
 * pi's faux provider, and the reviewer's instructions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-note-review-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { composeNoteReviewInstructions } = await import("../src/agent/note-review.ts");
const core = await import("../src/core/index.ts");
import { createFauxCore, fauxAssistantMessage, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LhMessage, SideChatAnchor, SideChatThread } from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";

const {
	parseSideAskInput,
	SideChatInputError,
	sideChatLessonDocument,
	sideChatModelTurns,
	newSideThread,
	newSideQuestion,
	newUserMessage,
	SIDE_REVIEW_REQUEST,
	NOTES_MAX_CHARS,
} = core;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures (copied from tests/side-chat.test.ts) ──────────────────────────

let seq = 0;
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): LhMessage {
	const base = fauxAssistantMessage("x");
	return { ...base, content, stopReason, id: `msg_a${seq++}` } as LhMessage;
}
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] });

const QUIZ_ARGS = {
	type: "check",
	nodeId: "limits",
	question: "Which limit defines the derivative?",
	options: [
		{ label: "Difference quotient as h→0", value: "dq" },
		{ label: "Area under the curve", value: "area" },
	],
	explanation: "SECRET-EXPLANATION the slope is the limit of secants",
	correctAnswer: "dq",
};

const MESSAGES_WITH_OPEN_CHECK = [
	assistant([text("Derivatives measure change."), call("q2", "quiz", QUIZ_ARGS), call("q3", "explain", { type: "check", nodeId: "n", question: "Explain the slope.", correctAnswer: "SECRET-COMMITTED" })]),
];
const OPEN_CHECK_KEY_TEXT = "SECRET-";

const ANCHOR: SideChatAnchor = { messageId: "msg_1", partId: "msg_1-t0", blockIndex: 0, blockText: "A paragraph." };
const AT = "2026-11-05T00:00:00.000Z";

// ── input ───────────────────────────────────────────────────────────────────

describe("note review input", () => {
	it("parses review only with an anchor", () => {
		const ask = parseSideAskInput({ anchor: ANCHOR, text: SIDE_REVIEW_REQUEST, review: { highlight: " A stays fixed? ", from: 12 } });
		assert.deepEqual(ask.review, { highlight: "A stays fixed?", from: 12 });
		assert.equal("review" in parseSideAskInput({ anchor: ANCHOR, text: "why?" }), false);
		// Never clipped (Rewrite must find it again in the notes); capped at the notes limit.
		const long = "y".repeat(5_000);
		assert.equal(parseSideAskInput({ anchor: ANCHOR, text: "x", review: { highlight: long, from: 0 } }).review!.highlight, long);
		assert.throws(() => parseSideAskInput({ anchor: ANCHOR, text: "x", review: { highlight: "y".repeat(NOTES_MAX_CHARS + 1), from: 0 } }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ threadId: "t1", text: "x", review: { highlight: "a", from: 0 } }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ threadId: "t1", retry: true, review: { highlight: "a", from: 0 } }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ text: "x", review: { highlight: "a", from: 0 } }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ anchor: ANCHOR, text: "x", review: { highlight: " ", from: 0 } }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ anchor: ANCHOR, text: "x", review: { highlight: "a", from: -1 } }), SideChatInputError);
		assert.throws(() => parseSideAskInput({ anchor: ANCHOR, text: "x", review: "a" }), SideChatInputError);
	});
});

// ── model turns ─────────────────────────────────────────────────────────────

describe("note review turns", () => {
	it("review turns carry lesson, notes and highlight; side turns unchanged", () => {
		const review = { ...newSideThread(ANCHOR, AT, { highlight: "A fixed?", from: 3 }), messages: [newSideQuestion(SIDE_REVIEW_REQUEST, [], AT)] };
		const [first] = sideChatModelTurns(review, "LESSON", "pull ≠ overwrite\nA fixed?");
		assert.match(first!.text, /<lesson>\nLESSON\n<\/lesson>/);
		assert.match(first!.text, /<notes>\npull ≠ overwrite\nA fixed\?\n<\/notes>/);
		assert.match(first!.text, /<highlight>\nA fixed\?\n<\/highlight>/);
		assert.match(first!.text, /Learner: Review this part of my notes\.$/);
		assert.doesNotMatch(first!.text, /<passage>/);

		const followUp = {
			...review,
			messages: [...review.messages, { id: "a1", role: "assistant" as const, text: "Close.", at: AT }, newSideQuestion("and B?", [], AT)],
		};
		assert.deepEqual(sideChatModelTurns(followUp, "LESSON", "A fixed?").map((t) => t.text).slice(1), ["Close.", "Learner: and B?"]);

		const side = { ...newSideThread(ANCHOR, AT), messages: [newSideQuestion("why?", [], AT)] };
		assert.equal("review" in side, false);
		assert.deepEqual(sideChatModelTurns(side, "LESSON", "NOTES"), sideChatModelTurns(side, "LESSON"));
	});

	it("says so when the notes page or the lesson is empty", () => {
		const review = { ...newSideThread(ANCHOR, AT, { highlight: "x", from: 0 }), messages: [newSideQuestion(SIDE_REVIEW_REQUEST, [], AT)] };
		const [first] = sideChatModelTurns(review, "", "  \n");
		assert.match(first!.text, /\(The session has no teaching content yet\.\)/);
		assert.match(first!.text, /\(The notes page is empty\.\)/);
	});

	it("review turns never include an open check's answer key", () => {
		const reviewThread: SideChatThread = {
			...newSideThread(ANCHOR, AT, { highlight: "my draft: B", from: 0 }),
			messages: [newSideQuestion(SIDE_REVIEW_REQUEST, [], AT)],
		};
		const turns = sideChatModelTurns(reviewThread, sideChatLessonDocument(MESSAGES_WITH_OPEN_CHECK), "my draft: B");
		assert.match(turns[0]!.text, /OPEN question/);
		assert.doesNotMatch(turns[0]!.text, new RegExp(OPEN_CHECK_KEY_TEXT));
	});
});

// ── the service, on the faux provider ───────────────────────────────────────

async function readAll(res: Response): Promise<{ type: string }[]> {
	const body = await res.text();
	return body
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as { type: string });
}

function setup() {
	const faux = createFauxCore({});
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const contexts: TranscriptContext[] = [];
	const service = createSideChatService({
		chatStore,
		engineFor: async () => engine,
		instructions: (t) => (t.review ? "REVIEW" : "SIDE"),
	});
	const chat = chatStore.createChat("review");
	const prose = assistant([text("First paragraph.\n\nSecond paragraph."), call("q9", "quiz", QUIZ_ARGS)]);
	chatStore.saveMessages(chat.id, [newUserMessage("teach me"), prose]);
	const anchor: SideChatAnchor = { messageId: prose.id, partId: `${prose.id}-t0`, blockIndex: 1, blockText: "Second paragraph." };
	const answer = (reply: string) =>
		faux.appendResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(reply);
			},
		]);
	return { service, chat, anchor, answer, contexts };
}

describe("note review service", () => {
	it("service: review thread saved with marker, review instructions, notes in context, messages untouched", async () => {
		const { service, chat, anchor, answer, contexts } = setup();
		chatStore.saveNotes(chat.id, "A fixed?");
		const messagesBefore = chatStore.getChat(chat.id)!.messages;
		answer("Close, but A moves.");
		const res = await service.ask(chat.id, parseSideAskInput({ anchor, text: SIDE_REVIEW_REQUEST, review: { highlight: "A fixed?", from: 0 } }));
		await readAll(res);
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.sideChats![0]!.review, { highlight: "A fixed?", from: 0 });
		assert.match(JSON.stringify(contexts[0]), /"REVIEW"/);
		assert.match(JSON.stringify(contexts[0]!.messages), /<notes>\\nA fixed\?/);
		assert.deepEqual(saved.messages, messagesBefore);

		// A follow-up keeps the review instructions and replays as plain Learner text.
		answer("Yes.");
		await readAll(await service.ask(chat.id, parseSideAskInput({ threadId: saved.sideChats![0]!.id, text: "and now?" })));
		assert.match(JSON.stringify(contexts[1]), /"REVIEW"/);
		assert.match(JSON.stringify(contexts[1]!.messages.at(-1)), /Learner: and now\?/);

		// A plain side question in the same session gets the side instructions.
		answer("Because.");
		await readAll(await service.ask(chat.id, parseSideAskInput({ anchor, text: "why?" })));
		assert.match(JSON.stringify(contexts[2]), /"SIDE"/);
		assert.equal(chatStore.getChat(chat.id)!.sideChats![1]!.review, undefined);
	});
});

// ── instructions ────────────────────────────────────────────────────────────

describe("note review instructions", () => {
	it("composes the review base with the shared appendix", () => {
		const s = composeNoteReviewInstructions();
		assert.match(s, /^## Note review/);
		assert.match(s, /\n---\n/);
		assert.match(s, /## Voice/);
		assert.doesNotMatch(s, /## Side questions/);
	});
});
