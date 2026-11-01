/**
 * Replay integrity (#340, #362): the model-facing projection must never hand
 * a provider a history it rejects. Two independent wire corruptions are pinned
 * here, both repaired at READ time (the stored record is never mutated):
 *
 *  - #340: a learner's answer is a toolResult for a question call that lives
 *    in an aborted assistant generation. Pi's provider transform
 *    (dist/api/transform-messages.js:172-192) drops the aborted assistant but
 *    keeps the result, shipping a function_call_output with no matching call
 *    (HTTP 400 on every later turn). The projection converts that orphan
 *    result into a user message, preserving the answer text and timestamp.
 *  - #362(b): after switching to Gemini's native API mid-session, a foreign
 *    provider's toolCall parts replay without the thought_signature Gemini
 *    validates (pi strips foreign signatures but cannot remove the part).
 *    `sanitizeForeignToolPairs` neutralizes the foreign pair on replay.
 *
 * The pi transform is imported for real (the dependency the repo already pins)
 * so the #340 assertion is made against the ACTUAL replay consumer, not a
 * hand-rolled mirror of it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transformMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js";
import {
	callResultPairsValid,
	INTERRUPTED_TEXT,
	makeConvertToLlm,
	repairOrphanToolResults,
	sanitizeForeignToolPairs,
	toLlmMessages,
	type LhMessage,
} from "../src/core/native-messages.ts";

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The current engine for the OpenAI-side cases: pi only reads
 *  provider/api/id and input modalities here (its isSameModel replay check and
 *  the image downgrade pass). */
const OPENAI_MODEL = { provider: "openai", api: "openai-responses", id: "gpt-replay-test", input: ["text"] };
/** The switched-to target that 400s on unsigned foreign calls. */
const GOOGLE_MODEL = { provider: "google", api: "google-generative-ai", id: "gemini-flash-latest", input: ["text", "image"] };

function assistant(overrides: Record<string, unknown>): LhMessage {
	return {
		id: "asst_1",
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-replay-test",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp: 1000,
		...overrides,
	} as unknown as LhMessage;
}

function toolResult(overrides: Record<string, unknown>): LhMessage {
	return {
		id: "result_1",
		role: "toolResult",
		toolCallId: "call_1|fc_1",
		toolName: "ask_user_question",
		content: [{ type: "text", text: '{"kind":"ask","text":"my unfinished answer"}' }],
		isError: false,
		timestamp: 2000,
		...overrides,
	} as unknown as LhMessage;
}

function compactionMarker(firstKeptMessageId: string): LhMessage {
	return {
		id: "compact_1",
		role: "custom",
		customType: "compaction",
		content: "COMPACTED HISTORY\n\nsummary of the earlier lesson",
		display: true,
		details: { firstKeptMessageId },
		timestamp: 500,
	} as unknown as LhMessage;
}

const wireStrings = (messages: readonly unknown[]): string => JSON.stringify(messages);

describe("#340 — orphan toolResult repair at replay", () => {
	// The exact persisted shape from the issue: aborted assistant carrying the
	// ask_user_question call, then the learner's successful answer result.
	const abortedQuestion = assistant({
		stopReason: "aborted",
		content: [{ type: "toolCall", id: "call_1|fc_1", name: "ask_user_question", arguments: { question: "Which?" } }],
	});
	const answerResult = toolResult({});

	it("repairs the poisoned pair before pi's transform: no orphan crosses the wire", () => {
		const projected = toLlmMessages([abortedQuestion, answerResult], { model: OPENAI_MODEL as never });
		const wire = transformMessages(projected as never, OPENAI_MODEL as never, undefined);
		assert.deepEqual(callResultPairsValid(wire as never), [], "every surviving toolResult has a surviving call");
		const userMessages = wire.filter((m: { role: string }) => m.role === "user");
		assert.equal(userMessages.length, 1, "the learner's answer survives as a user message");
		assert.match(JSON.stringify(userMessages), /my unfinished answer/);
		assert.ok(!wire.some((m: { role: string }) => m.role === "toolResult"), "the aborted assistant's result is not left orphaned");
	});

	it("preserves the answer result's exact content and timestamp", () => {
		const projected = toLlmMessages([abortedQuestion, answerResult]);
		const converted = projected.find((m) => m.role === "user") as { content: unknown[]; timestamp: number };
		assert.deepEqual(converted.content, [{ type: "text", text: '{"kind":"ask","text":"my unfinished answer"}' }]);
		assert.equal(converted.timestamp, 2000);
	});

	it("leaves a clean call/result pair untouched (byte-identical projection)", () => {
		const cleanCall = assistant({ content: [{ type: "toolCall", id: "call_1|fc_1", name: "quiz", arguments: { question: "q" } }] });
		const projected = toLlmMessages([cleanCall, answerResult]);
		assert.equal(projected[0]!.role, "assistant");
		assert.equal(projected[1]!.role, "toolResult");
		assert.equal(JSON.stringify(toLlmMessages([cleanCall, answerResult])), JSON.stringify(projected), "no repair on a valid history");
		const wire = transformMessages(projected as never, OPENAI_MODEL as never, undefined);
		assert.deepEqual(callResultPairsValid(wire as never), []);
	});

	it("still synthesizes INTERRUPTED_TEXT only for a clean dangling call, and never a result for an aborted call", () => {
		const dangling = assistant({ content: [{ type: "toolCall", id: "call_dangling", name: "quiz", arguments: { question: "q" } }] });
		const projected = toLlmMessages([dangling]);
		const synthesized = projected.find((m) => m.role === "toolResult") as { content: { text: string }[] } | undefined;
		assert.ok(synthesized, "a completed generation's unanswered call gets the interrupted result");
		assert.equal(synthesized.content[0]!.text, INTERRUPTED_TEXT);

		const abortedNoAnswer = toLlmMessages([assistant({ stopReason: "aborted", content: [{ type: "toolCall", id: "call_x", name: "quiz", arguments: {} }] })]);
		assert.ok(!abortedNoAnswer.some((m) => m.role === "toolResult"), "an aborted generation's call must not gain a fabricated result");
	});

	it("is idempotent — repairing a repaired projection changes nothing", () => {
		const once = toLlmMessages([abortedQuestion, answerResult]);
		const twice = repairOrphanToolResults(once);
		assert.deepEqual(twice, once);
	});

	it("repairs a result orphaned by the compaction cut", () => {
		// The assistant that owned r0 was compacted away; the cut starts AT the
		// result, so the retained tail projects the result without its call.
		const messages = [
			assistant({ id: "asst_cut", content: [{ type: "toolCall", id: "call_1|fc_1", name: "quiz", arguments: {} }] }),
			toolResult({ id: "result_kept" }),
			compactionMarker("result_kept"),
		];
		const projected = toLlmMessages(messages);
		assert.deepEqual(callResultPairsValid(projected), [], "the cut is another orphan source the repair must cover");
		assert.ok(projected.some((m) => m.role === "user" && JSON.stringify(m).includes("my unfinished answer")));
	});

	it("the factory feeds the same repaired projection the agent will send", () => {
		const viaFactory = makeConvertToLlm(OPENAI_MODEL as never)([abortedQuestion, answerResult] as never);
		const direct = toLlmMessages([abortedQuestion, answerResult], { model: OPENAI_MODEL as never });
		assert.deepEqual(viaFactory, direct);
	});
});

describe("#362(b) — foreign tool pairs are neutralized for Gemini's native API", () => {
	const foreignCall = assistant({
		id: "asst_foreign",
		provider: "openrouter",
		api: "openai-completions",
		model: "deepseek/deepseek-replay-test",
		content: [
			{ type: "text", text: "One question before we continue." },
			{ type: "toolCall", id: "call_f|fc_f", name: "ask_user_question", arguments: { question: "Which?" } },
		],
	});
	const foreignAnswer = toolResult({ toolCallId: "call_f|fc_f", content: [{ type: "text", text: "ANSWER-FROM-DEEPSEEK-HISTORY" }] });

	it("drops the foreign functionCall part but keeps its prose and the learner's answer as text", () => {
		const projected = toLlmMessages([foreignCall, foreignAnswer], { model: GOOGLE_MODEL as never });
		const assistantAfter = projected.find((m) => m.role === "assistant") as { content: { type: string }[] } | undefined;
		assert.ok(assistantAfter, "the assistant's prose survives");
		assert.ok(!assistantAfter.content.some((b) => b.type === "toolCall"), "no foreign functionCall reaches Gemini's history");
		assert.ok(projected.some((m) => m.role === "user" && JSON.stringify(m).includes("ANSWER-FROM-DEEPSEEK-HISTORY")), "the learner's answer survives as user text");
		assert.deepEqual(callResultPairsValid(projected), [], "the neutralized pair cannot orphan a result");
	});

	it("a call-only foreign assistant is dropped whole rather than projecting an empty model turn", () => {
		const callOnly = assistant({
			id: "asst_call_only",
			provider: "openrouter",
			api: "openai-completions",
			content: [{ type: "toolCall", id: "call_solo", name: "quiz", arguments: {} }],
		});
		const projected = toLlmMessages([callOnly, toolResult({ toolCallId: "call_solo" })], { model: GOOGLE_MODEL as never });
		assert.ok(!projected.some((m) => m.role === "assistant"), "no empty model content is emitted");
		assert.deepEqual(callResultPairsValid(projected), []);
	});

	it("same-provider Gemini history is untouched — signatures survive", () => {
		const geminiCall = assistant({
			id: "asst_gemini",
			provider: "google",
			api: "google-generative-ai",
			model: "gemini-flash-latest",
			content: [{ type: "toolCall", id: "call_g", name: "quiz", arguments: { question: "q" }, thoughtSignature: "c2lnbmF0dXJl" }],
		});
		const geminiAnswer = toolResult({ toolCallId: "call_g" });
		const projected = toLlmMessages([geminiCall, geminiAnswer], { model: GOOGLE_MODEL as never });
		assert.match(wireStrings(projected), /thoughtSignature/, "same-provider signatures stay for replay");
		assert.ok(projected.some((m) => m.role === "toolResult"), "the pair stays a call/result pair");
	});

	it("is a no-op for every non-Google transport", () => {
		const plain = toLlmMessages([foreignCall, foreignAnswer]);
		const viaOpenAi = toLlmMessages([foreignCall, foreignAnswer], { model: OPENAI_MODEL as never });
		assert.deepEqual(viaOpenAi, plain);
		assert.equal(sanitizeForeignToolPairs(plain, OPENAI_MODEL as never), plain, "returns the same array when nothing applies");
	});
});
