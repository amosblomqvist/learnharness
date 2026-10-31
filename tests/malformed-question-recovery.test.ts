import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatInput } from "../src/core/input-events.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-malformed-question-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "offline-key-presence-only";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { SessionModel } = await import("../components/session-core.ts");
const { pendingQuestionOf, danglingQuestionOf, hasUnresolvedQuestion, malformedQuestionsOf, newUserMessage, newAnswerResult, needsContinuation, nativeInputCause } = await import("../src/core/native-messages.ts");
const { findPendingToolCall } = await import("../src/core/pending.ts");
const { projectView } = await import("../src/core/view.ts");
const { parseQuestionInput } = await import("../src/core/tool-parts.ts");
const { inputAppends, parseChatInput, questionRecoveryAppends, endsInFailedTurn } = await import("../src/core/input-events.ts");

const valid = { type: "check", nodeId: "fixture", question: "Which is even?", options: [{ label: "2", value: "a" }, { label: "3", value: "b" }], correctAnswer: "a", explanation: "2 is divisible by 2." };
const partial = { type: "check", nodeId: "fixture", question: "What follows from $\\frac" };
function assistant(input: unknown = partial, stopReason = "toolUse", id = "fixture-assistant", callId = "bad", tool = "quiz"): AssistantMessage & { id: string } {
	return { ...fauxAssistantMessage([fauxToolCall(tool, input as JsonObject, { id: callId })], { stopReason: stopReason as AssistantMessage["stopReason"] }), id };
}
function scripted(steps: FauxResponseStep[]) {
	const histories: unknown[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map(step => (context, options, state, model) => {
		histories.push(structuredClone(context.messages));
		return typeof step === "function" ? step(context, options, state, model) : step;
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine, histories };
}
const replacement = () => fauxAssistantMessage([fauxToolCall("quiz", valid, { id: "replacement" })], { stopReason: "toolUse" });
function configured(messages: LhMessage[] = []) {
	const chat = chatStore.createChat("Offline malformed question");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "fixture", title: "Fixture" }], edges: [], version: 1 });
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}
function request(chatId: string, input: unknown) {
	return new Request("http://test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, input }) });
}
async function turn(chatId: string, input: unknown, engine: PiEngine) {
	const response = await handleChatRequest(request(chatId, input), opts => createTeacherAgent(undefined, { ...opts, engine }));
	if (response.ok) { const handle = runningTurn(chatId); if (handle) await new Response(handle.subscribe()).text(); }
	return response;
}
const recover = (messageId = "fixture-assistant", contentIndex = 0, toolCallId = "bad"): Extract<ChatInput, { type: "retry-question" }> => ({ type: "retry-question", messageId, contentIndex, toolCallId });

for (const stopReason of ["error", "aborted"]) for (const input of [partial, valid]) {
	test(`${stopReason} generation never owns a question, even with ${input === valid ? "valid-looking" : "partial"} arguments`, async () => {
		const { engine } = scripted([() => ({ ...assistant(input, stopReason), errorMessage: "Offline interrupted response" })]);
		const id = configured();
		assert.equal((await turn(id, { type: "text", text: "offline fixture" }, engine)).status, 200);
		const messages = chatStore.getChat(id)!.messages;
		assert.equal(messages.filter(m => m.role === "toolResult").length, 0);
		assert.equal(pendingQuestionOf(messages), null);
		assert.equal(findPendingToolCall(projectView(messages), pendingQuestionOf(messages)), null);
		assert.equal(danglingQuestionOf(messages), null);
		assert.equal(malformedQuestionsOf(messages).length, 0, "existing failure Retry/new-message path owns recovery");
		assert.ok(hasUnresolvedQuestion(messages), "unblocking the composer must not authorize a background wake");
		assert.equal(needsContinuation(messages), false);
		assert.equal(endsInFailedTurn(messages), stopReason === "error");
		assert.throws(() => inputAppends({ messages }, { type: "answer", toolCallId: "bad", answer: {} as never }));
	});
}

test("actual compatible adapter EOF → loop → settlement retains failure but never mounts a question", async () => {
	const faux = createFauxCore({});
	let requests = 0;
	const model = { ...faux.getModel(), api: "openai-completions" as const, provider: "offline", baseUrl: "https://offline.invalid/v1" };
	const engine: PiEngine = { model, streamFn: (m, context, options) => streamSimple(m as typeof model, context, {
		...options, apiKey: "offline-dummy", maxRetries: 0,
		fetch: async input => {
			assert.match(String(input), /^https:\/\/offline\.invalid\//); requests++;
			return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "bad", type: "function", function: { name: "quiz", arguments: '{"question":"unfinished' } }] }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	}) };
	const id = configured();
	await turn(id, { type: "text", text: "offline fixture" }, engine);
	const messages = chatStore.getChat(id)!.messages;
	assert.equal(requests, 1);
	assert.match(JSON.stringify(messages.at(-1)), /Stream ended without finish_reason/);
	assert.equal(messages.at(-1)?.role, "assistant");
	assert.ok(hasUnresolvedQuestion(messages));
	assert.equal(pendingQuestionOf(messages), null);
});

for (const tool of ["quiz", "probe", "ask_user_question", "explain", "recall"]) {
	test(`${tool}: accepted boundary normalization remains displayable without changing the record`, async () => {
		const raw = tool === "ask_user_question" ? { question: "Goal?", options: JSON.stringify(valid.options) }
			: tool === "explain" || tool === "recall" ? { type: '\"check\"', nodeId: "fixture", question: "Explain parity", correctAnswer: "Even numbers are divisible by two." }
			: { ...valid, options: JSON.stringify(valid.options) };
		assert.ok(parseQuestionInput(tool, raw));
		if (tool !== "ask_user_question" && tool !== "quiz") return; // production registries covered by existing question-tool tests
		const before = structuredClone(raw);
		const { engine } = scripted([() => assistant(raw, "toolUse", "raw", "raw-call", tool)]);
		const id = configured();
		await turn(id, { type: "text", text: "offline fixture" }, engine);
		const messages = chatStore.getChat(id)!.messages;
		const pending = pendingQuestionOf(messages)!;
		assert.ok(pending);
		assert.deepEqual(pending.input, before);
		assert.equal(malformedQuestionsOf(messages).length, 0);
		assert.ok(parseQuestionInput(tool, pending.input));
	});
}

for (const stopReason of ["toolUse", "length"]) {
	test(`${stopReason}: invalid/length calls still return model-visible errors and retry normally`, async () => {
		const { engine, histories } = scripted([() => assistant(stopReason === "length" ? valid : partial, stopReason), replacement]);
		const id = configured();
		await turn(id, { type: "text", text: "offline fixture" }, engine);
		const messages = chatStore.getChat(id)!.messages;
		assert.equal(histories.length, 2);
		assert.match(JSON.stringify(histories[1]), /"isError":true/);
		assert.equal(pendingQuestionOf(messages)?.toolCallId, "replacement");
		assert.equal(malformedQuestionsOf(messages).length, 0);
	});
}

test("manual recovery preserves history and successful sibling tools, sends errors instead of learner answers", async () => {
	const bad = assistant();
	if (bad.role === "assistant") bad.content.push(fauxToolCall("save_note", {}, { id: "note" }));
	const before: LhMessage[] = [newUserMessage("fixture"), bad, { id: "note-result", role: "toolResult", toolCallId: "note", toolName: "save_note", content: [{ type: "text", text: "Already saved" }], details: { saved: true }, isError: false, timestamp: 1 }];
	const id = configured(before);
	const { engine, histories } = scripted([replacement]);
	assert.equal(pendingQuestionOf(before), null);
	assert.equal(malformedQuestionsOf(before).length, 1);
	assert.equal(needsContinuation(before), false);
	assert.equal((await turn(id, recover(), engine)).status, 200);
	const saved = chatStore.getChat(id)!.messages;
	assert.deepEqual(saved.slice(0, before.length), before);
	const result = saved[before.length]!;
	assert.equal(result.role, "toolResult");
	assert.ok(result.role === "toolResult" && result.isError && (result.details as { questionRecovery?: boolean })?.questionRecovery);
	assert.equal(nativeInputCause(result, before), "learner");
	assert.match(JSON.stringify(histories[0]), /learner requested a replacement, not an answer/);
	assert.match(JSON.stringify(histories[0]), /Already saved/);
	assert.equal(histories.length, 1, "no replay of prior tools");
	assert.equal(pendingQuestionOf(saved)?.toolCallId, "replacement");
	assert.equal((await turn(id, recover(), engine)).status, 400, "a repeated click cannot request another replacement");
	assert.equal(histories.length, 1);
});

test("malformed siblings share one recovery turn; valid siblings must be answered first", async () => {
	const bad = assistant();
	if (bad.role === "assistant") bad.content.push(fauxToolCall("quiz", valid, { id: "valid-sibling" }), fauxToolCall("quiz", partial, { id: "bad-sibling" }));
	const before = [newUserMessage("fixture"), bad];
	const id = configured(before);
	const { engine, histories } = scripted([replacement]);
	assert.equal(pendingQuestionOf(before)?.toolCallId, "valid-sibling");
	assert.equal((await turn(id, recover(), engine)).status, 400);
	assert.equal(histories.length, 0);
	assert.deepEqual(chatStore.getChat(id)!.messages, before);
	assert.equal((await turn(id, { type: "answer", toolCallId: "valid-sibling", answer: { kind: "quiz", answers: [], dontKnow: true } }, engine)).status, 200);
	assert.equal(histories.length, 0, "answering a valid sibling must not implicitly retry a malformed sibling");
	assert.equal((await turn(id, recover(), engine)).status, 200);
	assert.equal(histories.length, 1);
	const saved = chatStore.getChat(id)!.messages;
	assert.equal(saved.filter(m => m.role === "toolResult" && m.isError).length, 2);
	assert.equal(pendingQuestionOf(saved)?.toolCallId, "replacement");
});

test("interrupted recovery write-ahead stays paused on reopen until explicit input", async () => {
	const before = [newUserMessage("fixture"), assistant()];
	const id = configured(before);
	// The POST durably records these results before starting the replacement.
	// Model a server stop at exactly that boundary: no replacement output.
	const checkpoint = [...before, ...inputAppends({ messages: before }, recover())];
	chatStore.saveMessages(id, checkpoint);
	const reopened = chatStore.getChat(id)!.messages;
	let posts = 0;
	const model = new SessionModel({ chatId: id, initialMessages: reopened, fetch: async () => {
		posts++;
		return new Response("Unexpected automatic request", { status: 500 });
	} });
	await model.continueIfOwed(reopened);
	assert.equal(posts, 0, "the original click did not authorize a restart on reopen");
	assert.equal(needsContinuation(reopened), false);
	assert.equal(pendingQuestionOf(reopened), null);
	assert.equal(malformedQuestionsOf(reopened).length, 0, "resolved calls are not offered again as stale retries");
	const { engine, histories } = scripted([replacement]);
	assert.equal((await turn(id, { type: "text", text: "Please continue with a new question" }, engine)).status, 200);
	assert.equal(histories.length, 1);
	assert.deepEqual(chatStore.getChat(id)!.messages.slice(0, reopened.length), reopened);
	assert.equal(pendingQuestionOf(chatStore.getChat(id)!.messages)?.toolCallId, "replacement");
});

test("ordinary answer and validation/length error result batches still owe continuation", () => {
	const answer = newAnswerResult("bad", "quiz", { kind: "quiz", questionText: valid.question, dontKnow: true, answers: [], answeredAt: "fixture" });
	assert.equal(needsContinuation([assistant(valid), answer]), true);
	for (const stopReason of ["toolUse", "length"]) {
		const owner = assistant(valid, stopReason);
		const recovery = questionRecoveryAppends([assistant()], recover())[0]!;
		if (recovery.role !== "toolResult") assert.fail("expected a tool result");
		const validation = { ...recovery, details: { tool: "quiz", problems: ["Invalid arguments"] } };
		assert.equal(needsContinuation([owner, validation]), true);
	}
});

test("exact occurrence, current authority, and recoverable status are checked before writes or calls", async () => {
	const before = [newUserMessage("fixture"), assistant(), assistant(partial, "toolUse", "newer", "bad")];
	const id = configured(before);
	const { engine, histories } = scripted([replacement]);
	for (const input of [recover(), recover("newer", 1), recover("newer", 0, "other")]) {
		assert.equal((await turn(id, input, engine)).status, 400);
		assert.deepEqual(chatStore.getChat(id)!.messages, before);
	}
	for (const stop of ["error", "aborted", "pending"]) assert.throws(() => questionRecoveryAppends([assistant(partial, stop)], recover()));
	assert.throws(() => questionRecoveryAppends([assistant(valid)], recover()));
	for (const index of [-1, 0.5, "0", null]) assert.throws(() => parseChatInput({ ...recover(), contentIndex: index }));
	assert.equal(histories.length, 0);
	assert.equal(runningTurn(id), undefined);
});

test("reload offers recovery without generating; ordinary composer input also works", async () => {
	const before = [newUserMessage("fixture"), assistant()];
	const id = configured(before);
	let posts = 0;
	const model = new SessionModel({ chatId: id, initialMessages: before, fetch: async () => { posts++; throw new Error("Unexpected automatic request"); } });
	await model.continueIfOwed(before);
	assert.equal(posts, 0);
	assert.equal(pendingQuestionOf(model.getState().nativeMessages), null);
	const { engine, histories } = scripted([replacement]);
	assert.equal((await turn(id, { type: "text", text: "Let's take another approach" }, engine)).status, 200);
	assert.match(JSON.stringify(histories[0]), /Let's take another approach/);
	assert.deepEqual(chatStore.getChat(id)!.messages.slice(0, before.length), before);
});
