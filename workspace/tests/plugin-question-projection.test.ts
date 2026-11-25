import assert from "node:assert/strict";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { test } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { pendingPluginQuestionOf, pluginQuestionCallsOf, pluginQuestionResultMatches, questionCallsOf, hasUnresolvedQuestion, toLlmMessages, needsContinuation, endsInDismissal, nativeInputCause, newUserMessage } from "../src/core/native-messages.ts";
import { inputAppends, dismissAppends, parseChatInput, parseDismissInput, questionRecoveryAppends } from "../src/core/input-events.ts";
import { projectView } from "../src/core/view.ts";
import { phaseAt3, phaseAt3Lh, teachStepIndex } from "../src/core/phases.ts";
import { derivePlanStatuses, derivePlanStatusesLh } from "../src/core/contracts/plan.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import type { PluginQuestionSnapshot, PluginQuestionAnswer, PluginQuestionOccurrence, JsonValue } from "../src/core/plugin-questions.ts";

function assistant(id = "pose", callId = "call_0", teach = false): LhMessage & { role: "assistant" } {
	const snapshot: PluginQuestionSnapshot = {
		protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code question", variant: teach ? "teach" : "probe",
		questionId: `question-${id}`, occurrence: { messageId: id, contentIndex: 1, toolCallId: callId, toolName: "old_plugin_name" }, contractVersion: 1,
		input: teach ? { question: "Write a value.\n", payload: { privateReference: "PRIVATE-PAYLOAD" }, type: "check", nodeId: "n1" } : { question: "Write a value.\n", payload: { privateReference: "PRIVATE-PAYLOAD" } },
		questionSchema: { type: "object", properties: { privateReference: { type: "string" } }, required: ["privateReference"], additionalProperties: false },
		answerSchema: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "array", items: { type: "string" } }] },
		showThinking: true, requiresAnswerRefinement: false,
	};
	return {
		id, role: "assistant", content: [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
			{ type: "toolCall", id: callId, name: "old_plugin_name", arguments: { question: "RAW-NOT-CANONICAL", payload: { privateReference: "PRIVATE-PAYLOAD" }, nodeId: "wrong-node" } },
		], lhQuestions: { "1": snapshot },
		stopReason: "toolUse", timestamp: 1, api: "openai-completions", provider: "fixture", model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function snapshot(message: LhMessage): PluginQuestionSnapshot { return message.lhQuestions!["1"] as PluginQuestionSnapshot; }
function answer(message: LhMessage, value: JsonValue = false): LhMessage {
	const saved = snapshot(message);
	const details: PluginQuestionAnswer = { kind: "plugin-question", questionId: saved.questionId, pluginId: saved.pluginId, typeId: saved.typeId, contractVersion: saved.contractVersion, answer: value, thinking: "", answeredAt: "2026-11-02T12:00:00Z" };
	return { id: `answer-${message.id}`, role: "toolResult", toolCallId: saved.occurrence.toolCallId, toolName: saved.occurrence.toolName, content: [{ type: "text", text: JSON.stringify(details) }], details: details as unknown as ToolResultMessage["details"], lhQuestionOccurrence: saved.occurrence, isError: false, timestamp: 2 } as LhMessage;
}
function cancellation(message: LhMessage, questionId?: string): LhMessage {
	const occurrence = { messageId: message.id, contentIndex: 1, toolCallId: "call_0", toolName: "old_plugin_name" };
	return { id: `cancel-${message.id}`, role: "toolResult", toolCallId: "call_0", toolName: "old_plugin_name", content: [{ type: "text", text: "The question was dismissed, not answered." }], details: { kind: "plugin-question-cancelled", occurrence, reason: questionId ? "dismissed" : "unreadable-protocol", ...(questionId ? { questionId } : {}) }, isError: false, timestamp: 3 };
}

test("saved plugin authority is independent of current tool names and raw arguments", () => {
	const pose = assistant();
	assert.equal(pendingPluginQuestionOf([pose])?.input.question, "Write a value.\n");
	assert.equal(pluginQuestionCallsOf([pose])[0]?.status, "answerable");
	assert.equal(hasUnresolvedQuestion([pose]), true);
	assert.deepEqual(questionCallsOf([pose]), [], "builtin selector shape and tool-name semantics stay separate");
	assert.equal(pendingPluginQuestionOf([pose, { ...assistant("later"), content: [], lhQuestions: undefined }])?.questionId, snapshot(pose).questionId, "later assistants cannot erase saved authority");
});

test("attempts and failed live calls never become pending and never expose raw tool traces", () => {
	for (const stopReason of ["toolUse", "pending", "error", "aborted"] as const) {
		const pose = assistant();
		const { protocolVersion, pluginId, typeId, label, variant } = snapshot(pose);
		pose.lhQuestions = { "1": { protocolVersion, pluginId, typeId, label, variant } };
		pose.stopReason = stopReason;
		assert.equal(pendingPluginQuestionOf([pose]), undefined);
		assert.equal(hasUnresolvedQuestion([pose]), false);
		assert.doesNotThrow(() => inputAppends({ messages: [pose] }, { type: "text", text: "continue" }));
		const error: LhMessage = { id: "error", role: "toolResult", toolCallId: "call_0", toolName: "old_plugin_name", content: [{ type: "text", text: "Error quotes PRIVATE-PAYLOAD" }], details: { private: "PRIVATE-PAYLOAD" }, isError: true, timestamp: 2 };
		const part = projectView([pose, error], { inFlight: true, streamingIds: new Set([pose.id]), executions: new Map([["call_0", { isError: true, errorText: "PRIVATE-PAYLOAD" }]]) }).flatMap(m => m.parts).find(p => p.pluginQuestion)!;
		assert.equal(part.pluginQuestion?.status, "attempt");
		for (const key of ["input", "rawInput", "result", "errorText"]) assert.equal(part[key], undefined);
		assert(!JSON.stringify(part).includes("PRIVATE-PAYLOAD"));
	}
});

test("malformed-present annotations retain safe classification, exact source index and bypass gates", () => {
	for (const metadata of [null, [], { "1": null }, { "1": undefined }, { "1": { protocolVersion: 99 } }]) {
		const pose = assistant();
		pose.lhQuestions = metadata as never;
		const view = projectView([pose]);
		const part = view.flatMap(m => m.parts).find(p => p.pluginQuestion)!;
		assert.equal(part.pluginQuestion?.status, "unreadable");
		assert.equal(part.sourceContentIndex, 1, "native content index survives reasoning partition");
		assert.equal(part.sourceMessageId, pose.id);
		assert.equal(part.input, undefined);
		assert.equal(pendingPluginQuestionOf([pose]), undefined, "unreadable is not answer authority");
		assert.equal(hasUnresolvedQuestion([pose]), true);
		assert.throws(() => inputAppends({ messages: [pose] }, { type: "continue" }));
		const cancelled = cancellation(pose, undefined);
		assert.equal(hasUnresolvedQuestion([pose, cancelled]), false);
	}
});

test("duplicate native call ids and copied answers cannot resolve another occurrence", () => {
	const old = assistant("old"), newer = assistant("new");
	const oldAnswer = answer(old);
	assert.equal(pendingPluginQuestionOf([old, oldAnswer, newer])?.questionId, snapshot(newer).questionId);
	assert.equal(pendingPluginQuestionOf([old, newer, oldAnswer])?.questionId, snapshot(newer).questionId);
	const misplaced = { ...answer(newer), lhQuestionOccurrence: snapshot(old).occurrence };
	assert.equal(pendingPluginQuestionOf([newer, misplaced])?.questionId, snapshot(newer).questionId);
	const bare = { ...answer(newer), lhQuestionOccurrence: undefined };
	assert.equal(pendingPluginQuestionOf([newer, bare])?.questionId, snapshot(newer).questionId);
	const legacy: LhMessage = { id: "legacy", role: "toolResult", toolCallId: "call_0", toolName: "old_plugin_name", content: [{ type: "text", text: "old" }], details: null, isError: false, timestamp: 2 };
	assert.equal(pendingPluginQuestionOf([newer, legacy])?.questionId, snapshot(newer).questionId);
	const parts = projectView([old, newer, oldAnswer]).flatMap(m => m.parts).filter(p => p.pluginQuestion);
	assert.equal(parts[0]?.state, "output-available");
	assert.equal(parts[1]?.state, "input-available");
	const wire = toLlmMessages([old, oldAnswer, newer, legacy]);
	assert(wire.some(m => m.role === "toolResult" && m.content.some(c => c.type === "text" && c.text.includes("interrupted"))), "old bare-id results must not suppress new-call repair");
});

test("genuine answers preserve false/zero/null/empty values and obey continuation/cause rules", () => {
	const pose = assistant();
	for (const value of [false, 0, null, "", [], "  code\n"] as JsonValue[]) {
		const result = answer(pose, value);
		assert.equal(pendingPluginQuestionOf([pose, result]), undefined);
		assert.deepEqual(pluginQuestionCallsOf([pose, result]), []);
		assert.equal(needsContinuation([pose, result]), true);
		assert.equal(nativeInputCause(result, [pose]), "learner");
		assert.equal(nativeInputCause({ ...result, lhQuestionOccurrence: undefined } as LhMessage, [pose]), "unrecognizable");
	}
	const cancelled = cancellation(pose, snapshot(pose).questionId);
	assert.equal(pendingPluginQuestionOf([pose, cancelled]), undefined);
	assert.equal(endsInDismissal([pose, cancelled]), true);
	assert.equal(needsContinuation([pose, cancelled]), false);
	assert.equal(nativeInputCause(cancelled, [pose]), "neutral");
	assert.equal(needsContinuation([pose, { ...answer(pose), lhQuestionOccurrence: undefined }]), false);
});

test("failed plugin sibling results retain normal native pairing and do not prevent the owed answer reaction", () => {
	const pose = assistant();
	const attempt = assistant("attempt", "bad");
	const { protocolVersion, pluginId, typeId, label, variant } = snapshot(attempt);
	const failedCall = attempt.content[1]!;
	pose.content.push(failedCall);
	pose.lhQuestions!["2"] = { protocolVersion, pluginId, typeId, label, variant };
	const failure: LhMessage = { id: "failed-sibling", role: "toolResult", toolCallId: "bad", toolName: "old_plugin_name", content: [{ type: "text", text: "Authoring validation failed" }], details: undefined, isError: true, timestamp: 2 };
	const messages = [pose, failure, answer(pose)];
	assert.equal(needsContinuation(messages), true);
	const wire = toLlmMessages(messages);
	assert.equal(wire.filter(m => m.role === "toolResult").length, 2, "no duplicate interrupted result for an ordinary failed attempt");
	assert.equal(pendingPluginQuestionOf(messages), undefined);
});

test("only matching identity/owner/contract and exact cancellation occurrence can settle a question", () => {
	const pose = assistant();
	for (const patch of [{ questionId: "wrong" }, { pluginId: "other" }, { typeId: "other" }, { contractVersion: 2 }]) {
		const result = answer(pose);
		if (result.role === "toolResult") result.details = { ...(result.details as object), ...patch } as unknown as ToolResultMessage["details"];
		assert.equal(pendingPluginQuestionOf([pose, result])?.questionId, snapshot(pose).questionId);
	}
	const cancelled = cancellation(pose, snapshot(pose).questionId);
	if (cancelled.role === "toolResult") (cancelled.details as unknown as { occurrence: PluginQuestionOccurrence }).occurrence.messageId = "wrong";
	assert.equal(pluginQuestionResultMatches(cancelled, snapshot(pose).occurrence, { status: "posed", snapshot: snapshot(pose) }), false);
});

test("pure input appends cannot bypass pending plugin contracts or accept plugin answers directly", () => {
	const pose = assistant();
	for (const input of [{ type: "text", text: "bypass" }, { type: "continue" }, { type: "retry" }, { type: "answer", toolCallId: "call_0", answer: {} }, { type: "retry-question", messageId: pose.id, contentIndex: 1, toolCallId: "call_0" }, { type: "thinking", problemCallId: "p", text: "bypass" }, { type: "next" }] as const) assert.throws(() => inputAppends({ messages: [pose] }, input as never));
	assert.throws(() => dismissAppends({ messages: [pose] }, { type: "dismiss", toolCallId: "call_0", answer: { kind: "ask", dismissed: true } as never }));
	assert.throws(() => questionRecoveryAppends([pose], { type: "retry-question", messageId: pose.id, contentIndex: 1, toolCallId: "call_0" }));
	const input = parseChatInput({ type: "plugin-question-answer", questionId: snapshot(pose).questionId, occurrence: snapshot(pose).occurrence, answer: false, thinking: "" });
	assert.throws(() => inputAppends({ messages: [pose] }, input));
	assert.throws(() => inputAppends({ messages: [] }, input));
	assert.throws(() => dismissAppends({ messages: [pose] }, parseDismissInput({ type: "dismiss-plugin-question", occurrence: snapshot(pose).occurrence })));
	assert.equal(inputAppends({ messages: [] }, { type: "text", text: "ordinary" })[0]?.role, "user");
	assert.deepEqual(inputAppends({ messages: [] }, { type: "continue" }), []);
});

test("plugin input parsers preserve host channels and require exact identity and finite JSON", () => {
	const pose = assistant();
	const base = { type: "plugin-question-answer", questionId: snapshot(pose).questionId, occurrence: snapshot(pose).occurrence, answer: "  code\n", thinking: "", readingThinking: " reading " };
	assert.deepEqual(parseChatInput(base), base);
	for (const patch of [{ questionId: undefined }, { occurrence: { toolCallId: "call_0" } }, { occurrence: { ...base.occurrence, contentIndex: -1 } }, { answer: undefined }, { answer: Number.NaN }, { answer: new Date() }, { thinking: null }]) assert.throws(() => parseChatInput({ ...base, ...patch }));
	assert.deepEqual(parseDismissInput({ type: "dismiss-plugin-question", occurrence: base.occurrence }), { type: "dismiss-plugin-question", occurrence: base.occurrence });
});

test("app-only question metadata is stripped from every model-facing message", () => {
	const pose = assistant();
	const result = answer(pose);
	const wire = toLlmMessages([pose, result]);
	for (const message of wire) {
		assert(!("lhQuestions" in message));
		assert(!("lhQuestionOccurrence" in message));
		assert(!("id" in message));
	}
	assert(pose.lhQuestions, "conversion never mutates history");
	assert(result.lhQuestionOccurrence);
});

test("metadata-based teach phase and node positioning ignore failed attempts and raw node tags", () => {
	const done: LhMessage = { ...assistant("probe_done"), content: [{ type: "toolCall", id: "done", name: "probe_done", arguments: {} }], lhQuestions: undefined };
	delete done.lhQuestions;
	const ack: LhMessage = { id: "done-result", role: "toolResult", toolCallId: "done", toolName: "probe_done", content: [{ type: "text", text: "Done" }], details: { ok: true }, isError: false, timestamp: 2 };
	const teach = assistant("teach", "call_0", true);
	const messages = [done, ack, newUserMessage("go"), teach];
	const tree = { version: 1, nodes: [{ id: "n1", title: "Node 1" }, { id: "wrong-node", title: "Wrong" }], edges: [] };
	assert.equal(phaseAt3Lh(messages), "teach");
	assert.equal(phaseAt3(projectView(messages)), "teach");
	assert.equal(derivePlanStatusesLh(tree, messages).current, "n1");
	assert.equal(derivePlanStatuses(tree, projectView(messages)).current, "n1");
	const part = projectView([teach])[0]!.parts.find(p => p.pluginQuestion)!;
	assert.equal(teachStepIndex([{ type: "step-start" }, { type: "text" }, { type: "step-start" }, part]), 2);
	teach.lhQuestions = { "1": { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "teach" } };
	assert.equal(phaseAt3Lh(messages), "plan");
	assert.equal(phaseAt3(projectView(messages)), "plan");
	assert.equal(derivePlanStatusesLh(tree, messages).current, null);
	assert.equal(derivePlanStatuses(tree, projectView(messages)).current, null);
});

test("session Markdown preserves historical string content alongside plugin questions", () => {
	const legacy = [
		{ id: "legacy-user", role: "user", content: "Teach me joins" },
		{ id: "legacy-assistant", role: "assistant", content: "A join combines rows." },
	] as unknown as LhMessage[];
	const pose = assistant();
	const markdown = sessionMarkdown([...legacy, pose, answer(pose, "learner answer")], { anchors: false });
	assert(markdown.includes("### Learner\n\nTeach me joins"));
	assert(markdown.includes("### Teacher\n\nA join combines rows."));
	assert(markdown.includes("learner answer"), "answer binding skips string-content assistants safely");
});

test("session Markdown exports only saved public prompt and bound learner answer/thinking", () => {
	const pose = assistant();
	const result = answer(pose, "  learner code\n");
	if (result.role === "toolResult") result.details = { ...(result.details as object), thinking: "my thinking" };
	const markdown = sessionMarkdown([pose, result], { anchors: false });
	assert(markdown.includes("Write a value."));
	assert(markdown.includes("  learner code\n"));
	assert(markdown.includes("my thinking"));
	assert(!markdown.includes("PRIVATE-PAYLOAD"));
	assert(!markdown.includes("RAW-NOT-CANONICAL"));
	assert(!markdown.includes("reasoning"));
	assert(sessionMarkdown([pose], { anchors: false }).includes("Write a value."));
	const old = assistant("old");
	assert(!sessionMarkdown([pose, answer(old, "STALE-ANSWER")], { anchors: false }).includes("STALE-ANSWER"));
	const check = assistant("check", "call_0", true);
	const code = "```ts\n  const x = false;\n\treturn x;\n```\n";
	const accepted = answer(check, code);
	if (accepted.role === "toolResult") accepted.details = { ...(accepted.details as object), thinking: "  my thinking\n", readingThinking: "  before reveal\n" };
	const exported = sessionMarkdown([check, accepted], { anchors: false });
	assert(exported.includes(code), "learner code whitespace is verbatim");
	assert(exported.includes("**Thinking:**   my thinking\n"));
	assert(exported.includes("**Reading thinking:**   before reveal\n"));
	assert.equal(projectView([check, accepted]).flatMap(m => m.parts).find(p => p.pluginQuestion)?.state, "output-available");
});
