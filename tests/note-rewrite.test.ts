/**
 * Note rewrite: locate the highlight, the rewrite turns, and the service
 * on pi's faux provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-note-rewrite-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { createNoteRewriter } = await import("../src/server/note-rewrite.ts");
const { composeNoteRewriteInstructions } = await import("../src/agent/note-review.ts");
const core = await import("../src/core/index.ts");
import { createFauxCore, fauxAssistantMessage, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { LhMessage, SideChatAnchor, SideChatThread } from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";

const { locateHighlight, cleanReplacement, noteRewriteModelTurns, sideChatLessonDocument, newSideThread, newSideQuestion, newUserMessage, SIDE_REVIEW_REQUEST } = core;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

let seq = 0;
function assistant(content: AssistantMessage["content"]): LhMessage {
	return { ...fauxAssistantMessage("x"), content, id: `msg_a${seq++}` } as LhMessage;
}
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] });

const MESSAGES_WITH_OPEN_CHECK = [
	assistant([
		text("Derivatives measure change."),
		call("q2", "quiz", {
			type: "check",
			nodeId: "limits",
			question: "Which limit defines the derivative?",
			options: [
				{ label: "Difference quotient as h→0", value: "dq" },
				{ label: "Area under the curve", value: "area" },
			],
			explanation: "SECRET-EXPLANATION the slope is the limit of secants",
			correctAnswer: "dq",
		}),
	]),
];
const OPEN_CHECK_KEY_TEXT = "SECRET-";

const AT = "2026-11-05T00:00:00.000Z";
const ANCHOR: SideChatAnchor = { messageId: "msg_1", partId: "msg_1-t0", blockIndex: 0, blockText: "A paragraph." };
const reviewThread = (id: string, messages: SideChatThread["messages"]): SideChatThread => ({
	...newSideThread(ANCHOR, AT, { highlight: "A fixed?", from: 0 }),
	id,
	messages,
});
const question = newSideQuestion(SIDE_REVIEW_REQUEST, [], AT);
const reply = { id: "r1", role: "assistant" as const, text: "Close, but A moves.", at: AT };
const answeredReview = reviewThread("side_answered", [question, reply]);

describe("locateHighlight / cleanReplacement", () => {
	it("locateHighlight picks the nearest occurrence and refuses missing text", () => {
		const notes = "x fixed? y fixed? z";
		assert.deepEqual(locateHighlight(notes, "fixed?", 11), { from: 11, to: 17 });
		assert.deepEqual(locateHighlight(notes, "fixed?", 0), { from: 2, to: 8 });
		assert.equal(locateHighlight(notes, "gone", 0), null);
		assert.equal(locateHighlight(notes, "", 0), null);
	});
	it("locateHighlight breaks ties toward the earlier occurrence", () => {
		assert.deepEqual(locateHighlight("ab ab ab", "ab", 3), { from: 3, to: 5 });
		assert.deepEqual(locateHighlight("ab..ab", "ab", 2), { from: 0, to: 2 });
	});
	it("cleanReplacement strips one fence around an unfenced highlight", () => {
		assert.equal(cleanReplacement("```\n$A$ moves\n```\n", "A fixed?"), "$A$ moves");
		assert.equal(cleanReplacement("```md\n$A$ moves\n```", "A fixed?"), "$A$ moves");
		assert.equal(cleanReplacement("  plain  ", "A fixed?"), "plain");
	});
	it("cleanReplacement keeps the fences of a fenced highlight and of separate blocks", () => {
		assert.equal(cleanReplacement("```py\nx = 2\n```", "```py\nx = 1\n```"), "```py\nx = 2\n```");
		const two = "```\na\n```\nthen\n```\nb\n```";
		assert.equal(cleanReplacement(two, "a then b"), two);
	});
});

describe("note rewrite turns", () => {
	it("carry the review conversation and no open answer key", () => {
		const [turn] = noteRewriteModelTurns(answeredReview, sideChatLessonDocument(MESSAGES_WITH_OPEN_CHECK), "A fixed?");
		assert.match(turn!.text, /<review>\nLearner: Review this part of my notes\.\nReviewer: Close, but/);
		assert.match(turn!.text, /Rewrite the highlighted part\.$/);
		assert.doesNotMatch(turn!.text, new RegExp(OPEN_CHECK_KEY_TEXT));
	});
	it("instructions are the base alone", () => {
		const s = composeNoteRewriteInstructions();
		assert.match(s, /^## Note rewrite/);
		assert.doesNotMatch(s, /\n---\n/);
	});
});

describe("note rewrite service", () => {
	const faux = createFauxCore({});
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const rewriter = createNoteRewriter({ chatStore, engineFor: async () => engine, instructions: () => "REWRITE" });

	const chat = chatStore.createChat("rewrite");
	chatStore.saveMessages(chat.id, [newUserMessage("teach me"), assistant([text("First paragraph.")])]);
	chatStore.saveNotes(chat.id, "A fixed?");
	const sideThread: SideChatThread = { ...newSideThread(ANCHOR, AT), id: "side_plain", messages: [newSideQuestion("why?", [], AT), reply] };
	const unanswered = reviewThread("side_unanswered", [question]);
	const failed = reviewThread("side_failed", [question, { ...reply, error: "boom" }]);
	chatStore.updateSideChats(chat.id, () => [answeredReview, sideThread, unanswered, failed]);

	it("returns the replacement, logs usage, edits nothing", async () => {
		faux.appendResponses([() => fauxAssistantMessage("```\n$A^\\tau$ moves via the network\n```")]);
		const before = chatStore.getChat(chat.id)!;
		const turnsBefore = before.turns?.length ?? 0;
		const res = await rewriter.rewrite(chat.id, answeredReview.id);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { replacement: "$A^\\tau$ moves via the network" });
		const after = chatStore.getChat(chat.id)!;
		assert.equal(after.notes, before.notes);
		assert.deepEqual(after.messages, before.messages);
		assert.deepEqual(after.sideChats, before.sideChats);
		assert.equal(after.turns!.length, turnsBefore + 1);
	});

	it("refuses side threads, unanswered reviews, unknown ids", async () => {
		assert.equal((await rewriter.rewrite(chat.id, sideThread.id)).status, 400);
		assert.equal((await rewriter.rewrite(chat.id, unanswered.id)).status, 409);
		assert.equal((await rewriter.rewrite(chat.id, failed.id)).status, 409);
		assert.equal((await rewriter.rewrite(chat.id, "side_missing")).status, 404);
		assert.equal((await rewriter.rewrite("chat_missing", answeredReview.id)).status, 404);
	});

	it("answers 502 when the reply was cut off at the output limit", async () => {
		faux.appendResponses([() => fauxAssistantMessage("A moves via the", { stopReason: "length" })]);
		const res = await rewriter.rewrite(chat.id, answeredReview.id);
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: "The rewrite was cut off before it finished." });
	});

	it("answers 502 when the model returns nothing", async () => {
		faux.appendResponses([() => fauxAssistantMessage("  ")]);
		const res = await rewriter.rewrite(chat.id, answeredReview.id);
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: "The rewrite failed." });
	});
});
