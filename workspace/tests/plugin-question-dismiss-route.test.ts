import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";
import type { NativePluginQuestionDefinition } from "../src/agent/plugin-question-tools.ts";
import type { QuestionTypeResolver } from "../src/server/plugin-questions.ts";

// Birth-stamp isolation before any config-loading import. Exercise the actual
// route/barrels, with a local resolver only; no plugin startup or network.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-dismiss-route-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.OPENROUTER_API_KEY = "isolated-key-presence-only";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network in dismissal route tests"); };
const globals = globalThis as typeof globalThis & { __lhPlugins?: unknown };
const previousRuntime = globals.__lhPlugins;
let resolveQuestion: QuestionTypeResolver = () => ({ status: "unavailable" });
globals.__lhPlugins = { host: { resolveQuestionType: (...args: Parameters<QuestionTypeResolver>) => resolveQuestion(...args) }, ready: Promise.resolve() };
after(() => {
	globals.__lhPlugins = previousRuntime;
	globalThis.fetch = originalFetch;
	fs.rmSync(root, { recursive: true, force: true });
});
const { POST } = await import("../app/api/chats/[id]/dismiss/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { claimPreparingTurn } = await import("../src/server/turn-preparation.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn, abortTurn } = await import("../src/server/turn-runs.ts");
const { applyParkedDismissal, takeParkedDismissal, parkDismissal } = await import("../src/server/dismissal-park.ts");
const { preparePluginQuestionAnswer, preparePluginQuestionDismissal } = await import("../src/server/plugin-questions.ts");
const { pendingPluginQuestionOf, newUserMessage, danglingQuestionOf, activeProblemOf } = await import("../src/core/native-messages.ts");
const { dismissedAnswer } = await import("../src/core/index.ts");
const { subscribe } = await import("../src/core/events.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}
let serial = 0;
function question(protocolVersion: 1 | 2 = 1) {
	const key = `dismiss-${++serial}`;
	const occurrence = { messageId: `${key}-pose`, contentIndex: 0, toolCallId: `${key}-call`, toolName: "plugin_code" };
	const snapshot: PluginQuestionSnapshot = {
		protocolVersion, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: `${key}-question`, occurrence, contractVersion: 1,
		input: { question: "Write code", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" },
		showThinking: false, requiresAnswerRefinement: false, ...(protocolVersion === 2 ? { requiresGrading: true } : {}),
	};
	const message = { ...fauxAssistantMessage([fauxToolCall(occurrence.toolName, { question: snapshot.input.question, payload: snapshot.input.payload }, { id: occurrence.toolCallId })], { stopReason: "toolUse" }), id: occurrence.messageId, lhQuestions: { "0": snapshot } } as LhMessage;
	const input = { type: "dismiss-plugin-question" as const, questionId: snapshot.questionId, occurrence };
	return { snapshot, message, input };
}
function fixture(t: TestContext, protocolVersion: 1 | 2 = 1) {
	const q = question(protocolVersion), chat = chatStore.createChat("Plugin dismissal route");
	chatStore.saveMessages(chat.id, [q.message]);
	t.after(() => { takeParkedDismissal(chat.id); });
	return { ...q, id: chat.id, saved: () => chatStore.getChat(chat.id)! };
}
function claim(t: TestContext, id: string) {
	const owner = claimPreparingTurn(id);
	assert.ok(owner);
	t.after(() => owner.finish());
	return owner;
}
function post(id: string, input: unknown) {
	return POST(new Request(`http://fixture/api/chats/${id}/dismiss`, { method: "POST", body: JSON.stringify({ input }) }), { params: Promise.resolve({ id }) });
}
function delayedPost(id: string, input: unknown) {
	const started = deferred<void>(), release = deferred<void>();
	const request = new Request(`http://fixture/api/chats/${id}/dismiss`, { method: "POST" });
	request.json = async () => { started.resolve(); await release.promise; return { input }; };
	const response = POST(request, { params: Promise.resolve({ id }) });
	return { response, release: () => release.resolve(), started: Promise.race([started.promise, response.then(r => { throw new Error(`Body was not read: ${r.status}`); })]) };
}
function answer(messages: LhMessage[], snapshot: PluginQuestionSnapshot): LhMessage[] {
	return preparePluginQuestionAnswer({ id: "fixture", messages }, { type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: "code" }, () => ({ status: "available", definition: { id: "code", contractVersion: 1 } as NativePluginQuestionDefinition, signal: new AbortController().signal, requireActive() {} }));
}

test("valid owned plugin dismissal parks before synchronously aborting, without writing until settlement", async t => {
	const f = fixture(t), owner = claim(t, f.id);
	let aborts = 0, parkedOnAbort: unknown;
	owner.signal.addEventListener("abort", () => {
		aborts++;
		parkedOnAbort = takeParkedDismissal(f.id);
		parkDismissal(f.id, parkedOnAbort);
	});
	const response = await post(f.id, f.input);
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { ok: true, parked: true });
	assert.equal(aborts, 1);
	assert.deepEqual(parkedOnAbort, f.input, "park must already exist when abort is delivered");
	assert.equal(owner.signal.aborted, true);
	assert.equal(isTurnRunning(f.id), true);
	assert.ok(runningTurn(f.id));
	assert.equal(f.saved().messages.length, 1);
	applyParkedDismissal(chatStore, f.id);
	owner.finish();
	assert.equal(pendingPluginQuestionOf(f.saved().messages), undefined);
	assert.equal((f.saved().messages.at(-1) as any).details.reason, "dismissed");
	assert.equal(takeParkedDismissal(f.id), null);
});

for (const mismatch of ["questionId", "messageId", "contentIndex", "toolCallId", "toolName", "answered", "different-current"] as const) {
	test(`owned stale plugin target (${mismatch}) neither parks nor aborts`, async t => {
		const f = fixture(t), owner = claim(t, f.id);
		let input = structuredClone(f.input);
		if (mismatch === "questionId") input.questionId = "stale-question";
		else if (mismatch === "contentIndex") input.occurrence.contentIndex++;
		else if (mismatch === "answered") chatStore.saveMessages(f.id, [f.message, ...answer([f.message], f.snapshot)]);
		else if (mismatch === "different-current") chatStore.saveMessages(f.id, [question().message]);
		else input.occurrence[mismatch] = "stale-occurrence";
		const before = f.saved().messages;
		assert.equal((await post(f.id, input)).status, 400);
		assert.equal(owner.signal.aborted, false);
		assert.equal(takeParkedDismissal(f.id), null);
		assert.deepEqual(f.saved().messages, before);
	});
}

for (const mutation of ["answered", "successor", "deleted", "unreadable-rebound"] as const) {
	test(`body-await race (${mutation}) validates current truth and cannot stop the successor`, async t => {
		const f = fixture(t), oldOwner = claim(t, f.id);
		const pending = delayedPost(f.id, f.input);
		t.after(pending.release);
		await pending.started;
		oldOwner.finish();
		if (mutation === "answered") chatStore.saveMessages(f.id, [f.message, ...answer([f.message], f.snapshot)]);
		else if (mutation === "successor") chatStore.saveMessages(f.id, [f.message, ...answer([f.message], f.snapshot), question().message]);
		else if (mutation === "deleted") chatStore.deleteChat(f.id);
		else chatStore.saveMessages(f.id, [{ ...f.message, lhQuestions: { "0": { ...f.snapshot, protocolVersion: 99, questionId: "replacement-binding" } } } as unknown as LhMessage]);
		const successor = claim(t, f.id);
		const before = chatStore.getChat(f.id)?.messages;
		pending.release();
		assert.equal((await pending.response).status, mutation === "deleted" ? 404 : 400);
		assert.equal(successor.signal.aborted, false);
		assert.equal(takeParkedDismissal(f.id), null);
		assert.deepEqual(chatStore.getChat(f.id)?.messages, before);
	});
}

test("idle plugin dismissal persists exact cancellation and notifies once, with no lifecycle or generation", async t => {
	const f = fixture(t), events: string[] = [];
	const off = subscribe(event => { if ("chatId" in event && event.chatId === f.id) events.push(event.type); });
	t.after(off);
	const response = await post(f.id, f.input);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(events, ["record-changed"]);
	assert.equal(isTurnRunning(f.id), false);
	assert.equal(runningTurn(f.id), undefined);
	assert.equal(takeParkedDismissal(f.id), null);
	const result = f.saved().messages.at(-1) as any;
	assert.deepEqual(result.lhQuestionOccurrence, f.input.occurrence);
	assert.deepEqual(result.details, { kind: "plugin-question-cancelled", questionId: f.input.questionId, occurrence: f.input.occurrence, reason: "dismissed" });
	assert.equal(pendingPluginQuestionOf(f.saved().messages), undefined);
});

test("idle body-await dismissal preserves current canonical appends rather than overwriting captured history", async t => {
	const f = fixture(t), pending = delayedPost(f.id, f.input);
	t.after(pending.release);
	await pending.started;
	const concurrent = newUserMessage("Concurrent canonical annotation");
	chatStore.saveMessages(f.id, [f.message, concurrent]);
	pending.release();
	assert.equal((await pending.response).status, 200);
	assert.equal(f.saved().messages[1]!.id, concurrent.id);
	assert.equal(f.saved().messages.length, 3);
});

test("idle target answered while the body is pending is refused without duplicate cancellation", async t => {
	const f = fixture(t), pending = delayedPost(f.id, f.input);
	t.after(pending.release);
	await pending.started;
	const messages = [f.message, ...answer([f.message], f.snapshot)];
	chatStore.saveMessages(f.id, messages);
	pending.release();
	assert.equal((await pending.response).status, 400);
	assert.deepEqual(f.saved().messages, messages);
	assert.equal(takeParkedDismissal(f.id), null);
});

for (const mismatch of [false, true]) test(`unreadable bound plugin target ${mismatch ? "rejects a mismatched questionId without stopping" : "can still be explicitly dismissed"}`, async t => {
	const f = fixture(t), owner = claim(t, f.id);
	chatStore.saveMessages(f.id, [{ ...f.message, lhQuestions: { "0": { ...f.snapshot, protocolVersion: 99 } } } as unknown as LhMessage]);
	const input = { ...f.input, ...(mismatch ? { questionId: "other-question" } : {}) };
	assert.equal((await post(f.id, input)).status, mismatch ? 400 : 202);
	assert.equal(owner.signal.aborted, !mismatch);
	if (mismatch) assert.equal(takeParkedDismissal(f.id), null);
	else {
		applyParkedDismissal(chatStore, f.id);
		assert.deepEqual((f.saved().messages.at(-1) as any).details, { kind: "plugin-question-cancelled", questionId: f.input.questionId, occurrence: f.input.occurrence, reason: "dismissed" });
	}
});

for (const busy of [false, true]) test(`malformed unreadable plugin map permits exact occurrence-only dismissal (${busy ? "owned" : "idle"})`, async t => {
	const f = fixture(t), owner = busy ? claim(t, f.id) : undefined;
	chatStore.saveMessages(f.id, [{ ...f.message, lhQuestions: null } as unknown as LhMessage]);
	const input = { type: "dismiss-plugin-question", occurrence: f.input.occurrence };
	assert.equal((await post(f.id, input)).status, busy ? 202 : 200);
	if (owner) {
		assert.equal(owner.signal.aborted, true);
		applyParkedDismissal(chatStore, f.id);
	}
	assert.deepEqual((f.saved().messages.at(-1) as any).details, { kind: "plugin-question-cancelled", occurrence: f.input.occurrence, reason: "dismissed" });
});

for (const kind of ["question", "problem"] as const) test(`builtin busy ${kind} still only parks, even before its native call materializes`, async t => {
	const id = chatStore.createChat("Builtin busy dismissal").id, owner = claim(t, id);
	t.after(() => takeParkedDismissal(id));
	const input = kind === "question" ? { type: "dismiss", toolCallId: "future-quiz", answer: dismissedAnswer("quiz", "What?") }
		: { type: "dismiss-problem", problemCallId: "future-problem" };
	const response = await post(id, input);
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { ok: true, parked: true });
	assert.equal(owner.signal.aborted, false, "builtin dismissal must not server-abort its owner");
	assert.equal(isTurnRunning(id), true);
	assert.deepEqual(takeParkedDismissal(id), input);
	assert.equal(chatStore.getChat(id)!.messages.length, 0);
});

for (const kind of ["question", "problem"] as const) test(`builtin idle ${kind} still writes its native dismissal`, async () => {
	const id = chatStore.createChat("Builtin idle dismissal").id;
	const call = kind === "question" ? fauxToolCall("quiz", { question: "What?", options: [{ label: "Yes" }, { label: "No" }], correctAnswer: "Yes", explanation: "Because" }, { id: "builtin-quiz" })
		: fauxToolCall("problem", { statement: "Prove it", mode: "recall" }, { id: "builtin-problem" });
	chatStore.saveMessages(id, [
		{ ...fauxAssistantMessage([call], { stopReason: "toolUse" }), id: `builtin-${kind}-pose` } as LhMessage,
		...(kind === "problem" ? [{ id: "builtin-problem-ack", role: "toolResult", toolCallId: "builtin-problem", toolName: "problem", content: [{ type: "text", text: "Problem posed" }], details: {}, isError: false, timestamp: Date.now() } as LhMessage] : []),
	]);
	const input = kind === "question" ? { type: "dismiss", toolCallId: "builtin-quiz", answer: dismissedAnswer("quiz", "What?") }
		: { type: "dismiss-problem", problemCallId: "builtin-problem" };
	assert.equal((await post(id, input)).status, 200);
	assert.equal(isTurnRunning(id), false);
	if (kind === "question") assert.equal(danglingQuestionOf(chatStore.getChat(id)!.messages), null);
	else assert.equal(activeProblemOf(chatStore.getChat(id)!.messages), null);
});

test("route cancellation waits for the actual cooperative grader cleanup; handler finally applies the park before releasing ownership", { timeout: 10000 }, async t => {
	const f = fixture(t, 2), started = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<void>();
	t.after(() => { abortTurn(f.id); cleanup.resolve(); });
	chatStore.saveSettings(f.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	let gradingSignal!: AbortSignal, grades = 0, factories = 0, callbackSettled = false;
	const definition = {
		id: "code", contractVersion: 1,
		async gradeAnswer(context: { signal: AbortSignal }) {
			grades++; gradingSignal = context.signal; started.resolve();
			await new Promise<void>(resolve => context.signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
			await cleanup.promise;
			callbackSettled = true;
			return false;
		},
	} as NativePluginQuestionDefinition;
	resolveQuestion = () => ({ status: "available", definition, signal: new AbortController().signal, requireActive() {} });
	t.after(() => { resolveQuestion = () => ({ status: "unavailable" }); });
	const events: string[] = [];
	let settledAfterCleanup = false, cancellationAtSettlement: unknown;
	const off = subscribe(event => {
		if (!("chatId" in event) || event.chatId !== f.id) return;
		events.push(event.type);
		if (event.type === "turn-settled") {
			settledAfterCleanup = callbackSettled;
			cancellationAtSettlement = (f.saved().messages.at(-1) as any)?.details?.reason;
		}
	});
	t.after(off);
	let answerSettled = false;
	const answerResponse = handleChatInput(f.id, { type: "plugin-question-answer", questionId: f.input.questionId, occurrence: f.input.occurrence, answer: "print(1)" }, () => { factories++; throw new Error("Dismissal must never construct a teacher"); });
	void answerResponse.then(() => { answerSettled = true; });
	await Promise.race([started.promise, answerResponse.then(r => { throw new Error(`Grader never started: ${r.status}`); })]);
	const handle = runningTurn(f.id)!;
	const reattach = new Response(handle.subscribe()).text();
	assert.equal((await post(f.id, f.input)).status, 202);
	assert.equal(gradingSignal.aborted, true);
	await aborted.promise;
	assert.equal(callbackSettled, false);
	assert.equal(answerSettled, false);
	assert.equal(isTurnRunning(f.id), true);
	assert.equal(runningTurn(f.id), handle);
	assert.equal(f.saved().messages.length, 1, "the park is not applied ahead of callback cleanup");
	assert.equal(claimPreparingTurn(f.id), null, "cannot admit another writer during callback cleanup");
	cleanup.resolve();
	assert.notEqual((await answerResponse).status, 200);
	await reattach;
	assert.equal(grades, 1); assert.equal(factories, 0);
	assert.deepEqual(events, ["turn-started", "record-changed", "turn-settled"]);
	assert.equal(settledAfterCleanup, true);
	assert.equal(cancellationAtSettlement, "dismissed");
	assert.equal(isTurnRunning(f.id), false);
	assert.equal(runningTurn(f.id), undefined);
	assert.equal(takeParkedDismissal(f.id), null);
	assert.equal(pendingPluginQuestionOf(f.saved().messages), undefined);
	assert.equal((f.saved().messages.at(-1) as any).details.kind, "plugin-question-cancelled");
	assert.equal(f.saved().messages.some(message => message.role === "toolResult" && (message.details as any)?.kind === "plugin-question"), false, "late grading must not accept the abandoned answer");
});
