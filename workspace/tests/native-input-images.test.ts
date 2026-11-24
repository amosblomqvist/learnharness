import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { assertNativeSubmissionTarget, inputAppends, parseChatInput, parseUserSteerInput } from "../src/core/input-events.ts";
import { type LhMessage, activeProblemOf, activeProblemOccurrenceOf, newAnswerResult, newUserMessage, newUserSteer, newThinkingMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { dismissedAnswer } from "../src/core/question-core.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "ask_user_question" };
function pose(name = "ask_user_question", id = "pose"): LhMessage {
	return { ...fauxAssistantMessage([fauxToolCall(name, name === "problem" ? { statement: "Work it out" } : { question: "Why?", mode: "text" }, { id: "call" })], { stopReason: "toolUse" }), id } as LhMessage;
}
function activeProblem(): LhMessage[] {
	return [pose("problem"), { id: "ack", role: "toolResult", toolCallId: "call", toolName: "problem", content: [{ type: "text", text: "Problem posed" }], isError: false, timestamp: 1 }];
}

test("native text and steer inputs accept image-only explicit data but never infer image paths", () => {
	assert.deepEqual(parseChatInput({ type: "text", text: "diagram.png" }), { type: "text", text: "diagram.png" });
	assert.equal(newUserMessage("diagram.png").content, "diagram.png");
	for (const type of ["text", "steer"] as const) {
		const raw = { type, text: "", images: [image], ...(type === "steer" ? { id: "steer-1" } : {}) };
		const parsed = type === "steer" ? parseUserSteerInput(raw) : parseChatInput(raw);
		assert.deepEqual(parsed, raw);
		assert.throws(() => type === "steer" ? parseUserSteerInput({ ...raw, images: [] }) : parseChatInput({ ...raw, images: [] }));
		for (const invalid of ["diagram.png", { ...image, data: "data:image/png;base64,AAAA" }, { ...image, data: "%%%" }, { ...image, mimeType: "image/svg+xml" }, { ...image, url: "blob:any" }]) {
			assert.throws(() => type === "steer" ? parseUserSteerInput({ ...raw, images: [invalid] }) : parseChatInput({ ...raw, images: [invalid] }));
		}
	}
	assert.deepEqual(newUserSteer("", "steer-1", [image]).content, [image]);
	const parsed = parseChatInput({ type: "text", text: "", images: [image] });
	assert.deepEqual(inputAppends({ messages: [] }, parsed)[0]!.content, [image]);
});

test("builtin images require exact occurrence while legacy text answers remain compatible", () => {
	const answer = { ...dismissedAnswer("ask", "Why?"), images: { answer: [image], thinking: [] } };
	assert.throws(() => parseChatInput({ type: "answer", toolCallId: "call", answer }));
	const input = parseChatInput({ type: "answer", toolCallId: "call", occurrence, answer });
	assert.equal(input.type, "answer");
	assert.deepEqual(input.type === "answer" && input.answer.images, { answer: [image] });
	assert.doesNotThrow(() => assertNativeSubmissionTarget([pose()], input));
	assert.throws(() => assertNativeSubmissionTarget([pose("ask_user_question", "replacement")], input), /no longer active/);
	assert.equal(inputAppends({ messages: [pose()] }, input)[0]!.role, "toolResult");
	assert.doesNotThrow(() => inputAppends({ messages: [pose()] }, { type: "answer", toolCallId: "call", answer: dismissedAnswer("ask", "Why?") }));
});

test("practice thinking images bind canonical problem and survive stored model replay", () => {
	const raw = { type: "thinking", problemCallId: "call", text: "", images: [image], occurrence: { ...occurrence, toolName: "problem" } };
	const input = parseChatInput(raw);
	const messages = activeProblem();
	assert.doesNotThrow(() => assertNativeSubmissionTarget(messages, input));
	assert.throws(() => assertNativeSubmissionTarget([{ ...messages[0]!, id: "replacement" }, messages[1]!], input), /no longer active/);
	assert.throws(() => parseChatInput({ ...raw, occurrence: undefined }));
	const [marker] = inputAppends({ messages }, input);
	assert.deepEqual((marker as { details: unknown }).details, { problemCallId: "call", text: "", images: [image] });
	const replay = toLlmMessages(JSON.parse(JSON.stringify([marker])));
	assert.deepEqual(replay[0]!.content, [{ type: "text", text: "Your thinking:\n" }, image]);
	assert.deepEqual(toLlmMessages([newThinkingMessage("call", "legacy")])[0]!.content, [{ type: "text", text: "Your thinking:\nlegacy" }]);
});

test("active problem occurrence shares legacy clean activation and preserves the old return shape", () => {
	const messages = activeProblem();
	assert.deepEqual(activeProblemOf(messages), { toolCallId: "call", input: { statement: "Work it out" } });
	assert.deepEqual(activeProblemOccurrenceOf(messages), { ...occurrence, toolName: "problem" });
	assert.equal(activeProblemOccurrenceOf([]), null);
	assert.equal(activeProblemOccurrenceOf([messages[0]!]), null, "a dangling pose never activates");
	const refusal = { ...pose("problem", "refused"), content: [{ type: "toolCall", id: "refused-call", name: "problem", arguments: { statement: "Refused" } }] } as LhMessage;
	const error = { ...messages[1]!, toolCallId: "refused-call", isError: true } as LhMessage;
	assert.deepEqual(activeProblemOccurrenceOf([...messages, refusal, error]), { ...occurrence, toolName: "problem" });
	assert.equal(activeProblemOccurrenceOf([...messages, { id: "dismissed", role: "custom", customType: "problem-dismissed", content: "", display: true, details: { problemCallId: "call" }, timestamp: 2 }]), null);
});

test("plugin input image channels stay outside JSON and empty channels are omitted", () => {
	const base = { type: "plugin-question-answer", questionId: "question-1", occurrence, answer: false };
	assert.deepEqual(parseChatInput({ ...base, images: { answer: [image], thinking: [] } }), { ...base, images: { answer: [image] } });
	assert.deepEqual(parseChatInput({ ...base, images: { answer: [], readingThinking: [] } }), base);
	assert.throws(() => parseChatInput({ ...base, images: { unexpected: [image] } }));
	assert.throws(() => parseChatInput({ ...base, images: { answer: ["drawing.png"] } }));
});

test("model retry appends nothing and reuses accepted native image bytes", () => {
	const accepted = newUserMessage("", [image]);
	const failed = { ...fauxAssistantMessage("", { stopReason: "error" }), id: "failure" } as LhMessage;
	assert.deepEqual(inputAppends({ messages: [accepted, failed] }, { type: "retry" }), []);
	assert.deepEqual(toLlmMessages([accepted])[0]!.content, [image]);
	const result = newAnswerResult("call", "ask", { ...dismissedAnswer("ask", "Why?"), images: { answer: [image] } });
	assert.deepEqual(result.content.filter(block => block.type === "image"), [image]);
});
