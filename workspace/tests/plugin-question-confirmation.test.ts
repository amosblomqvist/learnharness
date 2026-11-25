import assert from "node:assert/strict";
import { test } from "node:test";
import { capturePluginQuestionDismissal, confirmPluginQuestionDismissal } from "../components/plugin-question-dismissal.ts";
import { SessionModel } from "../components/session-core.ts";
import { escAbortTarget } from "../components/chat.tsx";
import type { LhMessage, PluginQuestionSnapshot } from "../src/core/index.ts";

const snapshot: PluginQuestionSnapshot = { protocolVersion: 2, requiresGrading: true, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1, occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "plugin_code" }, input: { question: "Code?", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: true, requiresAnswerRefinement: false };
const record = (saved = snapshot): LhMessage[] => [{ role: "assistant", id: saved.occurrence.messageId, content: [{ type: "toolCall", id: saved.occurrence.toolCallId, name: saved.occurrence.toolName, arguments: saved.input }], lhQuestions: { "0": saved }, stopReason: "toolUse", timestamp: 0 }] as unknown as LhMessage[];
const none = { abortAsk: false, mermaidFocus: false, planOpen: false, setupOpen: false, pending: false, problem: false, busy: false };

test("canonical plugin questions use the existing question confirmation without outranking layers", () => {
	const messages = record(); const target = capturePluginQuestionDismissal(messages)!;
	assert.deepEqual(target, { questionId: "q1", occurrence: snapshot.occurrence });
	assert.notEqual(target.occurrence, snapshot.occurrence); assert.ok(Object.isFrozen(target)); assert.ok(Object.isFrozen(target.occurrence));
	assert.equal(escAbortTarget({ ...none, pending: !!target, busy: true }), "question");
	for (const layer of ["mermaidFocus", "planOpen", "setupOpen"] as const) assert.notEqual(escAbortTarget({ ...none, pending: !!target, [layer]: true }), "question");
	assert.equal(escAbortTarget({ ...none, pending: true, abortAsk: true }), null);
});

test("confirmation uses its captured identity, detaches locally BEFORE dismissal and never stops a successor", () => {
	const target = capturePluginQuestionDismissal(record())!; const calls: unknown[] = [];
	const state = { canonicalMessages: record(), reconciliation: "ready" as const, stop() { calls.push("detach"); }, async dismissPluginQuestion(occurrence: unknown, questionId?: string) { calls.push({ occurrence, questionId }); } };
	confirmPluginQuestionDismissal(target, state);
	assert.deepEqual(calls, ["detach", { occurrence: snapshot.occurrence, questionId: "q1" }]);
	calls.length = 0;
	for (const current of [[], record({ ...snapshot, questionId: "q2" }), record({ ...snapshot, occurrence: { ...snapshot.occurrence, messageId: "new-assistant" } })]) confirmPluginQuestionDismissal(target, { ...state, canonicalMessages: current });
	for (const reconciliation of ["syncing", "failed"] as const) confirmPluginQuestionDismissal(target, { ...state, reconciliation });
	assert.deepEqual(calls, [], "stale/non-authoritative confirmation does not detach, dismiss or abort");
});

test("a bound unreadable plugin occurrence can be captured without inventing an answer", () => {
	const messages = record({ ...snapshot, protocolVersion: 99 } as unknown as PluginQuestionSnapshot);
	const target = capturePluginQuestionDismissal(messages)!;
	assert.deepEqual(target, { occurrence: snapshot.occurrence, questionId: "q1" });
	let dismissed = 0;
	confirmPluginQuestionDismissal(target, { canonicalMessages: messages, reconciliation: "ready", stop() {}, async dismissPluginQuestion() { dismissed++; } });
	assert.equal(dismissed, 1);
});

test("binding-only unreadable confirmation sends the captured identity through the real session model", async () => {
	const messages = record({ ...snapshot, pluginId: "INVALID" });
	const requests: Array<{ url: string; body?: string }> = [];
	const model = new SessionModel({ chatId: "chat", initialMessages: messages, fetch: async (url, init) => {
		requests.push({ url: String(url), body: init?.body as string | undefined });
		return String(url).endsWith("/dismiss") ? Response.json({ ok: true }) : Response.json({ messages, turnInFlight: false });
	} });
	await model.reconcile();
	const captured = capturePluginQuestionDismissal(model.getState().canonicalMessages)!;
	assert.equal(captured.questionId, "q1");
	confirmPluginQuestionDismissal(captured, { ...model.getState(), stop: () => model.stop(), dismissPluginQuestion: (occurrence, questionId) => model.dismissPluginQuestion(occurrence, questionId) });
	const dismissal = requests.find(request => request.url.endsWith("/dismiss"));
	assert.ok(dismissal, "binding-only identity must not silently disappear after local detach");
	assert.deepEqual(JSON.parse(dismissal.body!).input, { type: "dismiss-plugin-question", questionId: "q1", occurrence: snapshot.occurrence });
});

test("busy grading confirmation preserves drafts, sends just /dismiss and ignores its retired submit failure", { timeout: 10000 }, async () => {
	const messages = record(); const calls: string[] = [];
	let resolvePost!: (value: Response) => void;
	const post = new Promise<Response>(resolve => { resolvePost = resolve; });
	let resolveStarted!: () => void; const started = new Promise<void>(resolve => { resolveStarted = resolve; });
	const model = new SessionModel({ chatId: "chat", initialMessages: messages, fetch: async url => {
		calls.push(String(url));
		if (String(url) === "/api/chat") { resolveStarted(); return post; }
		if (String(url).endsWith("/dismiss")) return Response.json({ ok: true, parked: true }, { status: 202 });
		return Response.json({ messages, turnInFlight: true, pluginQuestionAvailability: { questionId: snapshot.questionId, status: "available" } });
	} });
	await model.reconcile();
	const draft = model.pluginQuestionDraft(snapshot); draft.answer = { status: "ready", value: "code" }; draft.thinking = "keep thinking";
	const sending = model.send({ type: "plugin-question-answer", questionId: snapshot.questionId, occurrence: snapshot.occurrence, answer: "code", thinking: draft.thinking });
	await Promise.race([started, sending.then(() => { throw new Error("The grading submission never reached POST"); })]); assert.equal(model.readyRef, false); assert.equal(model.status, "submitted");
	const target = capturePluginQuestionDismissal(model.getState().canonicalMessages)!;
	confirmPluginQuestionDismissal(target, { ...model.getState(), stop: () => model.stop(), dismissPluginQuestion: (occurrence, questionId) => model.dismissPluginQuestion(occurrence, questionId) });
	resolvePost(Response.json({ error: "Question unavailable" }, { status: 400 })); await sending;
	await Promise.resolve(); await Promise.resolve();
	assert.equal(calls.filter(url => url.endsWith("/dismiss")).length, 1);
	assert.equal(calls.includes("/api/activity/abort"), false, "the server performs adjacent park+Stop");
	assert.equal(model.getState().error, null); assert.equal(draft.thinking, "keep thinking"); assert.deepEqual(draft.answer, { status: "ready", value: "code" });
});
