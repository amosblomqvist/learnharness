import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { newAnswerResult, newUserMessage, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "../src/core/pending.ts";
import { type QuestionAnswerData } from "../src/core/question-core.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import { CLAUDE_CODE_PROVIDER } from "../src/core/contracts/claude-code.ts";

const ANSWER_PREFIX = "Learner answer submitted through the question form:\n";

function assertSubmissionContent(submission: { content: unknown }, result: LhMessage): void {
	assert(Array.isArray(submission.content));
	const first = submission.content[0];
	assert.equal(first.type, "text");
	assert(first.text.startsWith(ANSWER_PREFIX), "match the successful live user-answer format");
	assert(Array.isArray(result.content) && result.content[0]?.type === "text");
	assert.equal(first.text.slice(ANSWER_PREFIX.length), result.content[0].text);
	assert.deepEqual(submission.content.slice(1), result.content.slice(1));
}

function pose(tool: string, callId = "question-call"): LhMessage {
	return { ...fauxAssistantMessage([fauxToolCall(tool, { question: "Why?" }, { id: callId })], { stopReason: "toolUse" }), provider: "chatgpt", id: `pose-${callId}` } as LhMessage;
}

function answer(tool: string, updates: Partial<QuestionAnswerData> = {}, callId = "question-call"): LhMessage {
	return newAnswerResult(callId, tool, {
		kind: toolQuestionKind(tool), questionText: "Why?", dontKnow: false,
		answers: [{ index: 1, label: "The first option", value: "first" }], confidence: 70, correct: true,
		thinking: "My reasoning", readingThinking: "My earlier uncertainty",
		answeredAt: "2026-11-11T16:00:00Z", ...updates,
	} satisfies QuestionAnswerData);
}

test("each ChatGPT builtin question answer starts a provider-facing learner turn without changing its record", () => {
	for (const tool of QUESTION_TOOLS) {
		const record = [newUserMessage("Assess my understanding"), pose(tool), answer(tool)];
		const saved = structuredClone(record);
		const wire = toLlmMessages(record);
		assert.equal(wire.length, 4, tool);
		assert.equal(wire[2]!.role, "toolResult", "the native tool call remains fulfilled");
		assert.deepEqual(wire[2]!.content, record[2]!.content);
		assert.equal(wire[3]!.role, "user", "the learner answer must open a new user turn");
		const content = wire[3]!.content;
		assert(Array.isArray(content));
		assertSubmissionContent(wire[3]!, record[2]!);
		assert.deepEqual(record, saved, "provider projection must not persist invented user messages");
		assert.deepEqual(toLlmMessages(record), wire, "repeated requests must not accumulate boundaries");
	}
});

test("answer images and learner pause requests reach the new turn verbatim", () => {
	const image: ImageContent = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
	const result = answer("recall", { text: "Please pause the lesson", thinking: "I want to discuss this first", images: { answer: [image], thinking: [image] } });
	const wire = toLlmMessages([pose("recall"), result]);
	const submission = wire.at(-1)!;
	assert.equal(submission.role, "user");
	assert(Array.isArray(submission.content));
	assertSubmissionContent(submission, result);
	assert.match(JSON.stringify(submission.content), /Please pause the lesson/);
	assert.match(JSON.stringify(submission.content), /I want to discuss this first/);
	assert.equal(submission.content.filter(block => block.type === "image").length, 2);
	assert.doesNotMatch(submission.content[0]!.type === "text" ? submission.content[0]!.text : "", /must|continue|next question/i);
});

test("pose ACKs, dismissals, errors, recovery, interruptions and non-question tools never create learner turns", () => {
	const valid = answer("probe");
	assert(valid.role === "toolResult");
	for (const result of [
		{ ...valid, details: null, content: [{ type: "text", text: "Question posed" }] },
		answer("probe", { dismissed: true }),
		{ ...valid, isError: true },
		{ ...valid, isError: true, details: { questionRecovery: true } },
		{ ...valid, details: undefined, content: [{ type: "text", text: "The question was interrupted" }] },
		{ ...valid, details: { kind: "quiz" } },
	] as LhMessage[]) {
		const wire = toLlmMessages([pose("probe"), result]);
		assert.equal(wire.filter(message => message.role === "user").length, 0);
	}
	for (const tool of ["read", "research", "probe_done", "problem", "conclude"]) {
		assert.equal(toLlmMessages([pose(tool), answer(tool)]).filter(message => message.role === "user").length, 0, tool);
	}
});

test("orphan answers, mismatched calls, duplicate call IDs and failed poses cannot fabricate a learner turn", () => {
	for (const messages of [
		[answer("probe")],
		[pose("recall"), answer("probe")],
		[pose("probe", "other-call"), answer("probe")],
		[pose("probe"), pose("probe"), answer("probe")],
		[{ ...pose("probe"), stopReason: "error" }, answer("probe")],
		[{ ...pose("probe"), stopReason: "aborted" }, answer("probe")],
	] as LhMessage[][]) {
		assert.equal(toLlmMessages(messages).filter(message => message.role === "user").length, 0);
	}
});

test("a newer learner message retires the old answer boundary without changing historical ordering", () => {
	const reply = { ...fauxAssistantMessage("A short assessment"), id: "assessment" } as LhMessage;
	const followUp = newUserMessage("A side question");
	const wire = toLlmMessages([pose("probe"), answer("probe"), reply, followUp]);
	assert.deepEqual(wire.map(message => message.role), ["assistant", "toolResult", "assistant", "user"]);
	assert.equal(wire.at(-1)!.content, "A side question");
});

test("compaction removes old answer boundaries and retains the next real learner turn", () => {
	const old = [pose("probe", "old-call"), answer("probe", {}, "old-call")];
	const kept = [pose("probe"), answer("probe")];
	const summary = newCompactionMarker("Earlier answers are summarized here", {
		firstKeptMessageId: kept[0]!.id, tokensBefore: 1000, at: "2026-11-11T16:01:00Z",
	});
	const wire = toLlmMessages([...old, ...kept, summary]);
	assert.deepEqual(wire.map(message => message.role), ["user", "assistant", "toolResult", "user"]);
	assert.equal(wire.filter(message => message.role === "toolResult").length, 1);
	assertSubmissionContent(wire.at(-1)!, kept[1]!);
});

test("other providers retain their existing answer semantics, including Claude's waiting MCP process", () => {
	for (const provider of [CLAUDE_CODE_PROVIDER, "openai", "anthropic", "custom"]) {
		const call = { ...pose("probe"), provider } as LhMessage;
		const result = answer("probe");
		assert.deepEqual(toLlmMessages([call, result]).map(message => message.role), ["assistant", "toolResult"], provider);
	}
});

test("only the latest real answer gets a boundary, leaving old answer-assessment-continue patterns intact", () => {
	const old = [pose("probe", "old-call"), answer("probe", {}, "old-call")];
	const assessment = { ...fauxAssistantMessage("A short assessment"), id: "assessment" } as LhMessage;
	const record = [...old, assessment, newUserMessage("continue"), pose("probe"), answer("probe")];
	const wire = toLlmMessages(record);
	assert.deepEqual(wire.map(message => message.role), ["assistant", "toolResult", "assistant", "user", "assistant", "toolResult", "user"]);
	assertSubmissionContent(wire.at(-1)!, record.at(-1)!);
});

test("the latest answer boundary survives subsequent internal tool calls until the next learner input", () => {
	const result = answer("probe");
	const internalCall = pose("read", "read-call");
	const internalResult: LhMessage = { id: "read-result", role: "toolResult", toolCallId: "read-call", toolName: "read", content: [{ type: "text", text: "Reference material" }], isError: false, timestamp: 3 };
	const wire = toLlmMessages([pose("probe"), result, internalCall, internalResult]);
	assert.deepEqual(wire.map(message => message.role), ["assistant", "toolResult", "user", "assistant", "toolResult"]);
	assertSubmissionContent(wire[2]!, result);
});
