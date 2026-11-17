import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { JsonValue, PluginQuestionSnapshot, PluginQuestionGradingOutcome } from "../src/core/plugin-questions.ts";
import type { QuestionTypeResolver } from "../src/server/plugin-questions.ts";
import type { NativePluginQuestionDefinition } from "../src/agent/plugin-question-tools.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-grading-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in isolated grading tests"); };
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
const { pendingPluginQuestionOf, toLlmMessages } = await import("../src/core/native-messages.ts");
const { preparePluginQuestionSubmission, preparePluginQuestionAnswer, pluginQuestionAvailabilityOf } = await import("../src/server/plugin-questions.ts");

function fixture(grader: (context: any) => unknown = () => false, protocolVersion: 1 | 2 = 2) {
	const snapshot = {
		protocolVersion, pluginId: "fixture", typeId: "code", label: "Code", variant: "teach", questionId: "question", contractVersion: 1,
		occurrence: { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "plugin_code" },
		input: { question: "Explain?", payload: { privateReference: "SECRET" }, type: "check", nodeId: "node" },
		questionSchema: { type: "object" }, answerSchema: { type: "object", properties: { value: { type: "boolean" } }, required: ["value"], additionalProperties: false },
		showThinking: true, requiresAnswerRefinement: true,
		...(protocolVersion === 2 ? { requiresGrading: true } : {}),
	} as PluginQuestionSnapshot;
	const record = { id: "chat", messages: [{ ...fauxAssistantMessage([
		fauxToolCall("plugin_code", snapshot.input as any, { id: "call" }),
	], { stopReason: "toolUse" }), id: "pose", lhQuestions: { "0": snapshot } } as LhMessage] };
	const activation = new AbortController();
	let active = true, refinements = 0, resolutions = 0;
	const definition = {
		id: "code", label: "Code", contractVersion: 1, showThinking: true,
		questionSchema: snapshot.questionSchema, answerSchema: snapshot.answerSchema,
		teach: { toolName: "plugin_code", description: "Synthetic question" },
		validateAnswer() { refinements++; return []; }, gradeAnswer: grader,
	} as NativePluginQuestionDefinition;
	let registration = definition;
	const resolve: QuestionTypeResolver = () => {
		resolutions++;
		const captured = registration;
		return { status: "available", definition: captured, signal: activation.signal,
			requireActive() { if (!active || captured !== registration) throw new Error("Registration unavailable"); } };
	};
	const input = { type: "plugin-question-answer" as const, questionId: snapshot.questionId, occurrence: snapshot.occurrence,
		answer: { value: false }, thinking: "My thinking", readingThinking: "Reading" };
	return { snapshot, record, activation, definition, resolve, input, deactivate() { active = false; },
		reregister() { registration = { ...definition }; }, counts: () => ({ refinements, resolutions }) };
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function details(messages: LhMessage[]) { return (messages[0] as any).details; }

for (const result of [false, null, 0, "", { score: 0, notes: [false, null] }] satisfies JsonValue[]) test(`grading preserves finite JSON ${JSON.stringify(result)} in native details and model text`, async () => {
	let calls = 0;
	const f = fixture(() => { calls++; return result; });
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	assert.equal(calls, 0, "preparation has no async or grading work");
	assert.deepEqual(f.counts(), { refinements: 1, resolutions: 1 });
	assert(Object.isFrozen(prepared.snapshot));
	assert.equal(prepared.signal, f.activation.signal);
	const grading = await prepared.grade!(new AbortController().signal);
	assert.deepEqual(grading, { result });
	const appends = prepared.finish(f.record, grading);
	assert.equal(calls, 1);
	assert.equal(f.counts().refinements, 1, "finish never repeats answer refinement");
	assert.deepEqual(details(appends).grading, { result });
	assert.deepEqual(details(appends).answer, { value: false });
	assert.deepEqual((appends[0] as any).lhQuestionOccurrence, f.snapshot.occurrence);
	assert.equal(pendingPluginQuestionOf([...f.record.messages, ...appends]), undefined);
	const projected = toLlmMessages(appends)[0]!;
	assert(Array.isArray(projected.content));
	assert.deepEqual(JSON.parse((projected.content[0] as any).text).grading, { result });
});

test("grading receives frozen owned JSON, never freezes a live signal, and clones returned JSON", async () => {
	const returned = { score: [1] };
	const f = fixture(context => {
		assert.equal(context.chatId, "chat"); assert.equal(context.questionId, "question");
		assert.equal(context.variant, "teach"); assert.equal(context.contractVersion, 1);
		assert(Object.isFrozen(context)); assert(Object.isFrozen(context.input.payload)); assert(Object.isFrozen(context.answer));
		assert(!Object.isFrozen(context.signal));
		assert.throws(() => { context.answer.value = true; });
		return returned;
	});
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	f.input.answer.value = true;
	const grading = await prepared.grade!(new AbortController().signal);
	returned.score.push(2);
	assert.deepEqual(grading, { result: { score: [1] } });
	assert.deepEqual(details(prepared.finish(f.record, grading)).answer, { value: false });
	assert(!Object.isFrozen(f.activation.signal));
	assert(!Object.isFrozen(f.input.answer));
});

for (const mode of ["throw", "reject", "non-error", "fake-abort", "nan", "undefined", "cycle", "getter"] as const) test(`ordinary ${mode} becomes accepted grading.error without losing the pending answer`, async () => {
	const f = fixture(() => {
		if (mode === "throw") throw new Error("Grading failed");
		if (mode === "reject") return Promise.reject(new Error("Grading failed"));
		if (mode === "non-error") throw "private failure";
		if (mode === "fake-abort") throw Object.assign(new Error("Not cancellation"), { name: "AbortError" });
		if (mode === "nan") return NaN;
		if (mode === "undefined") return undefined;
		if (mode === "getter") return { get score() { throw new Error("must not invoke"); } };
		const cycle: any = {}; cycle.self = cycle; return cycle;
	});
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	const grading = await prepared.grade!(new AbortController().signal);
	assert("error" in grading);
	assert.equal(typeof grading.error, "string");
	if (mode === "throw" || mode === "reject") assert.equal(grading.error, "Grading failed");
	if (mode === "non-error") assert.equal(grading.error, "An error occurred.");
	if (mode === "fake-abort") assert.equal(grading.error, "Not cancellation");
	assert(pendingPluginQuestionOf(f.record.messages));
	assert.deepEqual(details(prepared.finish(f.record, grading)).grading, grading);
});

for (const mode of ["cancel", "disable", "unregister", "reregister"] as const) test(`${mode} while grading waits for actual settlement then refuses acceptance`, async () => {
	const pending = deferred<JsonValue>(); let calls = 0, signal!: AbortSignal;
	const f = fixture(context => { calls++; signal = context.signal; return pending.promise; });
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	const operation = new AbortController();
	let settled = false;
	const grading = prepared.grade!(operation.signal);
	void grading.then(() => { settled = true; }, () => { settled = true; });
	if (mode === "cancel") operation.abort();
	else if (mode === "disable") f.activation.abort();
	else if (mode === "unregister") f.deactivate();
	else {
		f.reregister();
		assert.equal(f.resolve("fixture", "code", 1).status, "available", "new registration cannot authorize old work");
		assert.equal(f.activation.signal.aborted, false, "registration replacement need not abort the activation signal");
	}
	await Promise.resolve(); await Promise.resolve();
	assert.equal(settled, false, "must hold session ownership while underlying grader is live");
	if (mode === "cancel" || mode === "disable") assert(signal.aborted);
	pending.resolve(false);
	await assert.rejects(grading);
	assert.equal(calls, 1); assert(pendingPluginQuestionOf(f.record.messages));
	assert.throws(() => prepared.finish(f.record, { result: false }));
});

test("cancellation takes priority over callback rejection and pre-aborted operations never invoke grading", async () => {
	const pending = deferred<JsonValue>();
	const f = fixture(() => pending.promise);
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	const operation = new AbortController();
	const grading = prepared.grade!(operation.signal);
	operation.abort(); pending.reject(new Error("ordinary failure"));
	await assert.rejects(grading);
	let calls = 0;
	const other = fixture(() => { calls++; return null; });
	const preAborted = preparePluginQuestionSubmission(other.record, other.input, other.resolve);
	await assert.rejects(preAborted.grade!(operation.signal));
	assert.equal(calls, 0);
});

test("preparation captures the exact requireActive function and activation signal", async () => {
	for (const change of ["registration", "signal"] as const) {
		const f = fixture();
		const resolution = f.resolve("fixture", "code", 1);
		assert.equal(resolution.status, "available");
		if (resolution.status !== "available") throw new Error("fixture unavailable");
		const prepared = preparePluginQuestionSubmission(f.record, f.input, () => resolution);
		resolution.requireActive = () => {};
		resolution.signal = new AbortController().signal;
		if (change === "registration") f.reregister();
		else f.activation.abort();
		await assert.rejects(prepared.grade!(new AbortController().signal));
		assert(pendingPluginQuestionOf(f.record.messages));
	}
});

test("operation cancellation after grading settlement still refuses finish", async () => {
	const f = fixture();
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	const operation = new AbortController();
	const grading = await prepared.grade!(operation.signal);
	operation.abort();
	assert.throws(() => prepared.finish(f.record, grading));
	assert(pendingPluginQuestionOf(f.record.messages));
});

test("synchronous refinement loses exact authority before preparation can return", () => {
	const f = fixture();
	f.definition.validateAnswer = () => { f.reregister(); return []; };
	assert.throws(() => preparePluginQuestionSubmission(f.record, f.input, f.resolve), /unavailable/);
	assert(pendingPluginQuestionOf(f.record.messages));
});

test("each grade invocation calls the captured callback exactly once", async () => {
	let originalCalls = 0, replacementCalls = 0;
	const f = fixture(() => { originalCalls++; return false; });
	const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
	f.definition.gradeAnswer = () => { replacementCalls++; return null; };
	for (let invocation = 0; invocation < 2; invocation++) {
		assert.deepEqual(await prepared.grade!(new AbortController().signal), { result: false });
		assert.equal(originalCalls, invocation + 1);
	}
	assert.equal(replacementCalls, 0);
});

test("protocol v1 never retroactively grades and the synchronous helper refuses grading-required answers", async () => {
	let calls = 0;
	const old = fixture(() => { calls++; return false; }, 1);
	const prepared = preparePluginQuestionSubmission(old.record, old.input, old.resolve);
	assert.equal(prepared.grade, undefined);
	assert.equal(details(prepared.finish(old.record)).grading, undefined);
	assert.equal(details(preparePluginQuestionAnswer(old.record, old.input, old.resolve)).grading, undefined);
	assert.equal(calls, 0);
	const current = fixture();
	assert.throws(() => preparePluginQuestionAnswer(current.record, current.input, current.resolve), /grad/i);
	const required = preparePluginQuestionSubmission(current.record, current.input, current.resolve);
	assert.throws(() => required.finish(current.record, { result: false }), /not completed/);
	await required.grade!(new AbortController().signal);
	for (const bad of [undefined, {}, { error: 7 }, { result: NaN }, { result: null, error: "both" }])
		assert.throws(() => required.finish(current.record, bad as PluginQuestionGradingOutcome));
	assert(pendingPluginQuestionOf(current.record.messages));
});

test("required matching grader controls preparation and response-only availability", () => {
	for (const mode of ["missing", "type", "version"] as const) {
		const f = fixture();
		if (mode === "missing") delete f.definition.gradeAnswer;
		if (mode === "type") f.definition.id = "other";
		if (mode === "version") f.definition.contractVersion = 2;
		assert.equal(pluginQuestionAvailabilityOf(f.record, f.resolve)?.status, "unavailable");
		assert.throws(() => preparePluginQuestionSubmission(f.record, f.input, f.resolve));
		assert(pendingPluginQuestionOf(f.record.messages));
	}
	const old = fixture(() => false, 1); delete old.definition.gradeAnswer;
	assert.equal(pluginQuestionAvailabilityOf(old.record, old.resolve)?.status, "available");
});

test("finish refuses changed pending target, saved contract, chat identity or exact registration", async () => {
	for (const change of ["target", "answerSchema", "input", "grading", "chat", "registration", "activation"] as const) {
		const f = fixture();
		const prepared = preparePluginQuestionSubmission(f.record, f.input, f.resolve);
		const grading = await prepared.grade!(new AbortController().signal);
		const altered = structuredClone(f.record);
		const saved = (altered.messages[0] as any).lhQuestions["0"];
		if (change === "target") saved.questionId = "replacement";
		if (change === "answerSchema") saved.answerSchema = { type: "object" };
		if (change === "input") saved.input.question = "changed";
		if (change === "grading") saved.requiresGrading = false;
		if (change === "chat") altered.id = "different";
		if (change === "registration") f.reregister();
		if (change === "activation") f.activation.abort();
		assert.throws(() => prepared.finish(altered, grading), change);
		assert(pendingPluginQuestionOf(f.record.messages));
	}
});

test("preparation validates applicability, images and saved schema once; finish preserves channels outside model text", async () => {
	const f = fixture();
	const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
	const input = { ...f.input, images: { answer: [image], thinking: [image], readingThinking: [image] } };
	const prepared = preparePluginQuestionSubmission(f.record, input, f.resolve);
	const grading = await prepared.grade!(new AbortController().signal);
	image.data = "bXV0YXRlZA==";
	const saved = prepared.finish(f.record, grading)[0] as any;
	assert.equal(saved.content.filter((block: any) => block.type === "image").length, 3);
	assert.equal(saved.details.images.answer[0].data, "aGVsbG8=");
	assert(!saved.content[0].text.includes("aGVsbG8="));
	assert.equal(f.counts().refinements, 1);
	for (const invalid of [{ ...f.input, answer: true }, { ...f.input, thinking: 5 }, { ...f.input, images: { answer: [{ ...image, data: "%%%" }] } }])
		assert.throws(() => preparePluginQuestionSubmission(f.record, invalid as any, f.resolve));
});
