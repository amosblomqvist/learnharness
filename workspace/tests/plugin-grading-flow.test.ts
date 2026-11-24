import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test, type TestContext } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { PluginBackendContext } from "../src/core/plugins.ts";
import type { JsonValue, PluginQuestionGradingContext } from "../src/core/plugin-questions.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-grading-flow-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.OPENROUTER_API_KEY = "isolated-key-presence-only";
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in grading flow"); };
const location = path.join(root, "data", "plugins", "grading-fixture", "dist");
fs.mkdirSync(location, { recursive: true });
fs.writeFileSync(path.join(location, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "grading-fixture", name: "Grading fixture", version: "1.0.0", minAppVersion: "0.4.1", backend: "backend.cjs" }));
fs.writeFileSync(path.join(location, "backend.cjs"), "exports.activate = ctx => ctx.handle('context', () => ctx);");
const { getPluginHost } = await import("../src/server/plugins.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { abortTurn, runningTurn, turnFailure } = await import("../src/server/turn-runs.ts");
const { pendingPluginQuestionOf, newUserMessage } = await import("../src/core/native-messages.ts");
const { parkDismissal } = await import("../src/server/dismissal-park.ts");
const host = await getPluginHost();
await host.setEnabled("grading-fixture", true);
let ctx = await host.call("grading-fixture", "context") as PluginBackendContext;
after(async () => { await host.dispose(); globalThis.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let serial = 0;
async function fixture(t: TestContext, grade: (context: PluginQuestionGradingContext<object, string>) => JsonValue | Promise<JsonValue>, options: { sibling?: boolean; constructorFailure?: boolean } = {}) {
	const id = `code${++serial}`, toolName = `plugin_${id}`;
	const off = ctx.registerQuestionType({ id, label: "Code", contractVersion: 1, showThinking: false,
		questionSchema: Type.Object({}), answerSchema: Type.String({ minLength: 1 }),
		probe: { toolName, description: "Pose code" }, gradeAnswer: grade });
	t.after(off);
	const chat = chatStore.createChat("Isolated grading flow");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const assistantId = `${id}-assistant`;
	const occurrence = { messageId: assistantId, contentIndex: 0, toolCallId: `${id}-call`, toolName };
	const snapshot = { protocolVersion: 2, pluginId: "grading-fixture", typeId: id, label: "Code", variant: "probe", questionId: `${id}-question`, occurrence, contractVersion: 1,
		input: { question: "Write code", payload: {} }, questionSchema: { type: "object", properties: {} }, answerSchema: { type: "string", minLength: 1 }, showThinking: false, requiresAnswerRefinement: false, requiresGrading: true };
	const calls = [fauxToolCall(toolName, snapshot.input, { id: occurrence.toolCallId })];
	const annotations: Record<string, unknown> = { "0": snapshot };
	if (options.sibling) {
		const siblingOccurrence = { ...occurrence, contentIndex: 1, toolCallId: `${id}-sibling-call` };
		calls.push(fauxToolCall(toolName, snapshot.input, { id: siblingOccurrence.toolCallId }));
		const { requiresGrading: _required, ...ungraded } = snapshot;
		annotations["1"] = { ...ungraded, protocolVersion: 1, questionId: `${id}-sibling-question`, occurrence: siblingOccurrence };
	}
	const assistant = { ...fauxAssistantMessage(calls, { stopReason: "toolUse" }), id: assistantId, lhQuestions: annotations } as unknown as LhMessage;
	chatStore.saveMessages(chat.id, [newUserMessage("Start"), assistant]);
	const faux = createFauxCore({}); let factoryCalls = 0, teacherInput = "", engineModel: string | undefined;
	faux.setResponses([context => { teacherInput = context.messages.filter(message => message.role === "toolResult").flatMap(message => message.content.flatMap(block => block.type === "text" ? [block.text] : [])).join("\n"); return fauxAssistantMessage("Continued once after grading"); }]);
	const factory: NonNullable<Parameters<typeof handleChatRequest>[1]> = opts => {
		factoryCalls++;
		engineModel = opts.engine?.model.id;
		if (options.constructorFailure) throw new Error("fixture construction failure");
		return createTeacherAgent(undefined, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, messages: opts.messages });
	};
	const input = { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence, answer: "print(1)" };
	function post(answer: unknown = input.answer, signal?: AbortSignal) {
		return handleChatRequest(new Request("http://fixture/api/chat", { method: "POST", body: JSON.stringify({ chatId: chat.id, input: { ...input, answer } }), signal }), factory);
	}
	async function waitStarted(started: Promise<unknown>, response: Promise<Response>) {
		await Promise.race([started, response.then(r => { throw new Error(`Grading never started: ${r.status}`); })]);
	}
	async function settle(response: Response) {
		assert.equal(response.status, 200, await response.clone().text());
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return { chat, input, off, post, waitStarted, settle, saved: () => chatStore.getChat(chat.id)!, answer: () => chatStore.getChat(chat.id)!.messages.find(m => m.role === "toolResult" && m.toolCallId === occurrence.toolCallId) as any,
		factoryCalls: () => factoryCalls, teacherInput: () => teacherInput, engineModel: () => engineModel };
}

for (const result of [false, null] as const) {
	test(`inline grading saves ${result} before exactly one teacher continuation and exposes attachable busy state`, { timeout: 10000 }, async t => {
		const started = deferred<void>(), release = deferred<JsonValue>(); let grades = 0;
		t.after(() => release.resolve(result));
		const f = await fixture(t, async context => { grades++; assert.equal(context.signal.aborted, false); started.resolve(); return release.promise; });
		const response = f.post(); await f.waitStarted(started.promise, response);
		assert.equal(isTurnRunning(f.chat.id), true); assert.ok(runningTurn(f.chat.id));
		const reattach = new Response(runningTurn(f.chat.id)!.subscribe()).text();
		assert.equal(f.answer(), undefined); assert.equal(f.factoryCalls(), 0);
		assert.equal((await f.post()).status, 409); assert.equal(grades, 1);
		release.resolve(result); await f.settle(await response); await reattach;
		assert.deepEqual(f.answer().details.grading, { result });
		assert.equal(f.factoryCalls(), 1); assert.match(f.teacherInput(), new RegExp(`\\\\?"grading\\\\?":\\{\\\\?"result\\\\?":${result}`));
		assert.equal(isTurnRunning(f.chat.id), false); assert.equal(runningTurn(f.chat.id), undefined);
	});
}

test("validation refusal never grades and ordinary grader failure saves an accepted outcome", { timeout: 10000 }, async t => {
	let grades = 0;
	const f = await fixture(t, () => { grades++; const error = new Error("Tests could not launch"); error.name = "AbortError"; throw error; });
	assert.equal((await f.post("")).status, 400); assert.equal(grades, 0); assert.ok(pendingPluginQuestionOf(f.saved().messages));
	await f.settle(await f.post());
	assert.deepEqual(f.answer().details.grading, { error: "Tests could not launch" }); assert.equal(f.answer().isError, false); assert.equal(grades, 1);
});

test("Stop retains ownership until underlying grading settles, then leaves the answer pending", { timeout: 10000 }, async t => {
	const started = deferred<void>(), release = deferred<JsonValue>(); let signal!: AbortSignal;
	t.after(() => release.resolve(true));
	const f = await fixture(t, async context => { signal = context.signal; started.resolve(); return release.promise; });
	const response = f.post(); await f.waitStarted(started.promise, response);
	const reattach = new Response(runningTurn(f.chat.id)!.subscribe()).text();
	assert.deepEqual(abortTurn(f.chat.id), { ok: true }); assert.equal(signal.aborted, true);
	assert.equal(isTurnRunning(f.chat.id), true); assert.equal((await f.post()).status, 409);
	release.resolve(true); assert.notEqual((await response).status, 200); await reattach;
	assert.equal(f.answer(), undefined); assert.ok(pendingPluginQuestionOf(f.saved().messages)); assert.equal(isTurnRunning(f.chat.id), false); assert.equal(runningTurn(f.chat.id), undefined);
});

test("unregistering a definition cancels cooperative grading and cannot accept its late result", { timeout: 10000 }, async t => {
	const started = deferred<void>(); let gradingSignal!: AbortSignal;
	const f = await fixture(t, async context => {
		gradingSignal = context.signal;
		started.resolve();
		await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
		return true;
	});
	const response = f.post(); await f.waitStarted(started.promise, response);
	f.off(); assert.equal(gradingSignal.aborted, true);
	assert.notEqual((await response).status, 200);
	assert.equal(f.answer(), undefined); assert.equal(f.factoryCalls(), 0); assert.ok(pendingPluginQuestionOf(f.saved().messages)); assert.equal(isTurnRunning(f.chat.id), false); assert.equal(runningTurn(f.chat.id), undefined);
});

test("a model change during grading preserves the admitted model and applies only to the next request", { timeout: 10000 }, async t => {
	const started = deferred<void>(), release = deferred<JsonValue>(); let gradingSignal!: AbortSignal;
	t.after(() => release.resolve(true));
	const f = await fixture(t, async context => { gradingSignal = context.signal; started.resolve(); return release.promise; });
	const response = f.post(); await f.waitStarted(started.promise, response);
	const nextSettings = { model: { provider: "openai", id: "gpt-4" } };
	chatStore.saveSettings(f.chat.id, nextSettings);
	assert.equal(gradingSignal.aborted, false);
	release.resolve(true); await f.settle(await response);
	assert.deepEqual(f.answer().details.grading, { result: true });
	assert.equal(f.engineModel(), "z-ai/glm-5.3-flash"); assert.deepEqual(f.saved().settings, nextSettings);
});

test("HTTP abandonment and view detach do not cancel accepted grading work", { timeout: 10000 }, async t => {
	const started = deferred<void>(), release = deferred<JsonValue>(); let gradingSignal!: AbortSignal;
	t.after(() => release.resolve(true));
	const f = await fixture(t, async context => { gradingSignal = context.signal; started.resolve(); return release.promise; });
	const caller = new AbortController(); const response = f.post(undefined, caller.signal);
	await f.waitStarted(started.promise, response);
	const reader = runningTurn(f.chat.id)!.subscribe().getReader();
	await reader.cancel("view detached"); caller.abort("HTTP request disconnected");
	assert.equal(gradingSignal.aborted, false); assert.equal(isTurnRunning(f.chat.id), true);
	release.resolve(true); await f.settle(await response);
	assert.deepEqual(f.answer().details.grading, { result: true }); assert.equal(f.factoryCalls(), 1);
});

test("session deletion and activation replacement cannot commit a late grade", { timeout: 10000 }, async t => {
	for (const mutate of ["deletion", "activation"] as const) {
		const started = deferred<void>(), release = deferred<JsonValue>(); t.after(() => release.resolve(true));
		const f = await fixture(t, async () => { started.resolve(); return release.promise; });
		const response = f.post(); await f.waitStarted(started.promise, response);
		if (mutate === "deletion") assert.equal(chatStore.deleteChat(f.chat.id), true);
		else { await host.setEnabled("grading-fixture", false); await host.setEnabled("grading-fixture", true); ctx = await host.call("grading-fixture", "context") as PluginBackendContext; }
		release.resolve(true); assert.notEqual((await response).status, 200);
		assert.equal(f.factoryCalls(), 0); assert.equal(isTurnRunning(f.chat.id), false); assert.equal(runningTurn(f.chat.id), undefined);
		if (mutate === "deletion") assert.equal(chatStore.getChat(f.chat.id), null);
		else assert.ok(pendingPluginQuestionOf(f.saved().messages));
	}
});

test("the post-grading save uses current canonical history rather than its captured copy", { timeout: 10000 }, async t => {
	const started = deferred<void>(), release = deferred<JsonValue>(); t.after(() => release.resolve(true));
	const f = await fixture(t, async () => { started.resolve(); return release.promise; });
	const response = f.post(); await f.waitStarted(started.promise, response);
	const concurrent = newUserMessage("External canonical annotation");
	chatStore.saveMessages(f.chat.id, [...f.saved().messages, concurrent]);
	release.resolve(true); await f.settle(await response);
	assert.ok(f.saved().messages.some(message => message.id === concurrent.id)); assert.deepEqual(f.answer().details.grading, { result: true });
});

test("sibling-only acceptance settles waiting views without creating a teacher", { timeout: 10000 }, async t => {
	const started = deferred<void>(), release = deferred<JsonValue>(); t.after(() => release.resolve(true));
	const f = await fixture(t, async () => { started.resolve(); return release.promise; }, { sibling: true });
	const response = f.post(); await f.waitStarted(started.promise, response);
	const reattach = new Response(runningTurn(f.chat.id)!.subscribe()).text();
	release.resolve(true); const accepted = await response; assert.equal(accepted.status, 200); assert.match(await reattach, /turn-settled/);
	assert.deepEqual(f.answer().details.grading, { result: true }); assert.ok(pendingPluginQuestionOf(f.saved().messages)); assert.equal(f.factoryCalls(), 0); assert.equal(isTurnRunning(f.chat.id), false);
});

test("save failure releases ownership without acceptance and explicit resubmission may grade again", { timeout: 10000 }, async t => {
	let grades = 0; const f = await fixture(t, () => { grades++; return true; });
	const save = chatStore.saveMessages;
	chatStore.saveMessages = (id, messages) => { if (id === f.chat.id && messages.some(m => m.role === "toolResult")) throw new Error("fixture disk full"); return save(id, messages); };
	try { assert.equal((await f.post()).status, 500); } finally { chatStore.saveMessages = save; }
	assert.equal(f.answer(), undefined); assert.equal(isTurnRunning(f.chat.id), false); assert.equal(runningTurn(f.chat.id), undefined);
	await f.settle(await f.post()); assert.equal(grades, 2); assert.deepEqual(f.answer().details.grading, { result: true });
});

test("teacher construction failure after durable acceptance does not misreport an unsaved answer", { timeout: 10000 }, async t => {
	const f = await fixture(t, () => true, { constructorFailure: true });
	assert.equal((await f.post()).status, 200);
	assert.deepEqual(f.answer().details.grading, { result: true }); assert.equal(isTurnRunning(f.chat.id), false); assert.equal(runningTurn(f.chat.id), undefined); assert.ok(turnFailure(f.chat.id));
});

test("cancelled grading applies an occurrence-bound parked dismissal before releasing ownership", { timeout: 10000 }, async t => {
	const started = deferred<void>(), release = deferred<JsonValue>(); t.after(() => release.resolve(true));
	const f = await fixture(t, async () => { started.resolve(); return release.promise; });
	const response = f.post(); await f.waitStarted(started.promise, response);
	parkDismissal(f.chat.id, { type: "dismiss-plugin-question", questionId: f.input.questionId, occurrence: f.input.occurrence });
	abortTurn(f.chat.id); release.resolve(true); assert.notEqual((await response).status, 200);
	assert.equal(f.answer().details.kind, "plugin-question-cancelled"); assert.equal(f.answer().details.reason, "dismissed"); assert.equal(pendingPluginQuestionOf(f.saved().messages), undefined); assert.equal(isTurnRunning(f.chat.id), false);
});
