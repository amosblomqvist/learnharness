import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { PluginQuestionLedger } from "../src/agent/plugin-question-tools.ts";
import {
	freezePluginQuestionValue, preparePluginQuestionType, readPluginQuestionAnnotation, readPluginQuestionAnswer,
	readPluginQuestionSnapshot, validatePluginQuestionAnswer,
	type PluginQuestionSnapshot, type PluginQuestionTypeDefinition,
} from "../src/core/plugin-questions.ts";

const occurrence = { messageId: "assistant", contentIndex: 0, toolCallId: "call", toolName: "ask_example" };
function definition(extra: Record<string, unknown> = {}): PluginQuestionTypeDefinition {
	return { id: "example", label: "Example", contractVersion: 1, showThinking: false,
		questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(),
		probe: { toolName: "ask_example", description: "Ask an example" }, ...extra };
}
function snapshot(extra: Record<string, unknown> = {}): PluginQuestionSnapshot {
	return { protocolVersion: 1, pluginId: "fixture", typeId: "example", label: "Example", variant: "probe",
		questionId: "question", occurrence, contractVersion: 1, input: { question: "Question?", payload: { source: "source" } },
		questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(), showThinking: false,
		requiresAnswerRefinement: false, ...extra } as PluginQuestionSnapshot;
}
function answer(grading?: unknown) {
	return { kind: "plugin-question", questionId: "question", pluginId: "fixture", typeId: "example", contractVersion: 1,
		answer: false, answeredAt: "2026-11-06T00:00:00.000Z", ...(grading !== undefined ? { grading } : {}) };
}
const graded = () => snapshot({ protocolVersion: 2, requiresGrading: true });

test("prepared grading callbacks may be sync or async and retain identity without loosening refinements", () => {
	for (const gradeAnswer of [() => false, async () => null]) {
		const original = definition({ gradeAnswer });
		const prepared = preparePluginQuestionType(original);
		assert.equal((prepared as unknown as Record<string, unknown>).gradeAnswer, gradeAnswer);
		assert.ok(Object.isFrozen(prepared));
		assert.equal(Object.isFrozen(original), false);
	}
	for (const gradeAnswer of [null, true, "grade", {}]) assert.throws(() => preparePluginQuestionType(definition({ gradeAnswer })));
	for (const key of ["validateQuestion", "validateAnswer"]) assert.throws(() => preparePluginQuestionType(definition({ [key]: async () => undefined })), /synchronous/);
});

test("freezing owned grading contexts never freezes or disables the cancellation signal", () => {
	const controller = new AbortController();
	const context = freezePluginQuestionValue({ signal: controller.signal, input: { payload: { source: "source" } }, answer: { code: "answer" } });
	assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.input.payload)); assert.ok(Object.isFrozen(context.answer));
	assert.equal(Object.isFrozen(controller.signal), false);
	controller.abort(); assert.equal(context.signal.aborted, true);
});

test("v2 requirements survive canonical snapshot and attempt reconstructions", () => {
	const saved = graded();
	const canonical = readPluginQuestionSnapshot(saved)!;
	assert.ok(canonical);
	assert.equal(canonical.protocolVersion, 2);
	assert.equal((canonical as unknown as Record<string, unknown>).requiresGrading, true);
	assert.deepEqual(readPluginQuestionSnapshot(canonical), canonical);
	assert.ok(Object.isFrozen(canonical.input.payload));
	const attempt = { protocolVersion: 2, requiresGrading: true, pluginId: "fixture", typeId: "example", label: "Example", variant: "probe" };
	assert.deepEqual(readPluginQuestionAnnotation(attempt), { status: "attempt", attempt });
	for (const invalid of [snapshot({ protocolVersion: 2 }), snapshot({ protocolVersion: 2, requiresGrading: false }), snapshot({ requiresGrading: true }), snapshot({ requiresGrading: false })]) {
		assert.equal(readPluginQuestionAnnotation(invalid).status, "unreadable");
	}
	assert.equal(readPluginQuestionSnapshot(snapshot())?.protocolVersion, 1);
});

test("graded answers require exactly one finite JSON result or string error, including falsy results", () => {
	for (const grading of [{ result: false }, { result: null }, { result: 0 }, { result: "" }, { result: { tests: [false, null] } }, { error: "Runner failed" }, { error: "" }]) {
		const persisted = answer(grading);
		const parsed = readPluginQuestionAnswer(persisted, graded());
		assert.deepEqual(parsed, persisted);
		assert.ok(Object.isFrozen(parsed!.grading));
		assert.notEqual(parsed!.grading, grading);
	}
	assert.equal(readPluginQuestionAnswer(answer(), graded()), null);
	for (const grading of [null, false, {}, { result: false, error: "conflict" }, { result: undefined }, { result: NaN }, { result: Infinity }, { result: new Date() }, { error: 1 }, { error: null }, { result: false, extra: true }, { error: "failure", extra: true }]) {
		assert.equal(readPluginQuestionAnswer(answer(grading), graded()), null);
		assert.equal(readPluginQuestionAnswer(answer(grading)), null);
	}
});

test("historical v1 answers ignore grading without rewriting the persisted object or requiring live graders", () => {
	for (const grading of [{ result: false }, { error: "stray" }, { invalid: "old metadata" }, null]) {
		const persisted = answer(grading);
		const before = structuredClone(persisted);
		assert.deepEqual(readPluginQuestionAnswer(persisted, snapshot()), answer());
		assert.deepEqual(persisted, before);
	}
	assert.deepEqual(readPluginQuestionAnswer(answer({ result: null }))?.grading, { result: null });
	let calls = 0;
	assert.equal(validatePluginQuestionAnswer(snapshot(), { chatId: "chat", answer: false }, definition({ gradeAnswer() { calls++; return false; } })).ok, true);
	assert.equal(calls, 0);
});

test("new native graded poses and failed attempts freeze protocol v2 without running the grader", async () => {
	let gradeCalls = 0;
	const prepared = preparePluginQuestionType(definition({ gradeAnswer: async () => { gradeCalls++; return false; } }));
	const ledger = new PluginQuestionLedger([{ pluginId: "fixture", definition: prepared, variant: "probe", signal: new AbortController().signal, requireActive() {} }], "chat");
	let listener!: (event: AgentEvent) => void;
	ledger.bind({ subscribe(callback: typeof listener) { listener = callback; } } as unknown as Agent);
	const args = { question: "Question?", payload: { source: "source" } };
	const call = { type: "toolCall", id: "call", name: "ask_example", arguments: args };
	const assistant = { role: "assistant", content: [call] } as unknown as AgentMessage;
	listener({ type: "message_start", message: assistant });
	const live = ledger.wire({ type: "message_start", message: assistant }, { type: "message_start", message: assistant }) as unknown as { message: { lhQuestions: Record<string, unknown> } };
	assert.deepEqual(live.message.lhQuestions["0"], { protocolVersion: 2, requiresGrading: true, pluginId: "fixture", typeId: "example", label: "Example", variant: "probe" });
	ledger.validatedCall({ toolCall: call, assistantMessage: assistant, args } as never);
	await ledger.tools[0]!.execute("call", args);
	const settled = ledger.settled([assistant], [{ ...assistant, id: "assistant" } as AgentMessage])[0] as unknown as { lhQuestions: Record<string, unknown> };
	const saved = readPluginQuestionSnapshot(settled.lhQuestions["0"]);
	assert.equal(saved?.protocolVersion, 2);
	assert.equal(saved?.requiresGrading, true);
	assert.equal(gradeCalls, 0);

	const badArgs = { question: " ", payload: { source: "source" } };
	const badCall = { ...call, id: "bad-call", arguments: badArgs };
	const badAssistant = { role: "assistant", content: [badCall] } as unknown as AgentMessage;
	listener({ type: "message_start", message: badAssistant });
	ledger.validatedCall({ toolCall: badCall, assistantMessage: badAssistant, args: badArgs } as never);
	const failure = await ledger.tools[0]!.execute("bad-call", badArgs);
	assert.equal(failure.isError, true);
	const failed = ledger.settled([badAssistant], [badAssistant])[0] as unknown as { lhQuestions: Record<string, unknown> };
	const annotation = readPluginQuestionAnnotation(failed.lhQuestions["0"]);
	assert.equal(annotation.status, "attempt");
	if (annotation.status === "attempt") { assert.equal(annotation.attempt.protocolVersion, 2); assert.equal(annotation.attempt.requiresGrading, true); }
	assert.equal(gradeCalls, 0);
});
