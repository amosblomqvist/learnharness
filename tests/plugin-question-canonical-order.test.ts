import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { pendingPluginQuestionOf, type LhMessage, type PluginQuestionSnapshot } from "../src/core/index.ts";

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot: PluginQuestionSnapshot = { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1, occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" }, input: { question: "Question", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false };
const older = [{ id: "u", role: "user", content: "start", timestamp: 1 }] as LhMessage[];
const current = [...older, { id: "a", role: "assistant", content: [{ type: "toolCall", id: "call", name: "code", arguments: snapshot.input }], stopReason: "toolUse", timestamp: 2, lhQuestions: { "0": snapshot } }] as LhMessage[];
const saved = () => Response.json({ messages: current, pluginQuestionAvailability: { questionId: "q1", status: "available" } });
const done = () => new Response("data: [DONE]\n\n");

for (const adoption of ["replace", "append"] as const) test(`late independent ${adoption} GET cannot erase terminal question authority or its draft`, async () => {
	const oldGet = deferred<Response>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => ++reads === 1 ? oldGet.promise : saved() });
	const idle = model.readRecord({ adoption });
	await model.consumeStream(done());
	const draft = model.pluginQuestionDraft(snapshot); draft.answer = { status: "unready", value: "learner draft" };
	oldGet.resolve(Response.json({ messages: older })); assert.equal(await idle, undefined);
	assert.equal(model.readyRef, true); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1"); assert.equal(model.pluginQuestionDraft(snapshot), draft);
});

test("older terminal GET cannot overwrite a newer acknowledged independent GET (reverse completion)", async () => {
	const terminalGet = deferred<Response>(); const started = deferred<void>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => { if (++reads === 1) { started.resolve(); return terminalGet.promise; } return saved(); } });
	const terminal = model.consumeStream(done()); await started.promise;
	assert.ok(await model.readRecord()); const draft = model.pluginQuestionDraft(snapshot); draft.thinking = "kept";
	terminalGet.resolve(Response.json({ messages: older })); await terminal;
	assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1"); assert.equal(model.pluginQuestionDraft(snapshot), draft); assert.equal(model.getState().reconciliation, "ready"); assert.equal(model.readyRef, true);
});

test("newer issued but pending GET does not block the only completed canonical response", async () => {
	const first = deferred<Response>(), second = deferred<Response>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => ++reads === 1 ? first.promise : second.promise });
	const a = model.readRecord(); const b = model.readRecord();
	first.resolve(saved()); assert.ok(await a); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
	second.resolve(Response.json({ messages: [...current, { id: "later", role: "user", content: "later", timestamp: 3 }] })); assert.ok(await b); assert.equal(model.getState().canonicalMessages.at(-1)!.id, "later");
});

test("failure of an older independent GET cannot undo terminal canonical adoption", async () => {
	const first = deferred<Response>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => ++reads === 1 ? first.promise : saved() });
	const independent = model.readRecord(); await model.consumeStream(done());
	first.reject(new Error("old read offline")); await assert.rejects(independent, /old read offline/);
	assert.equal(model.readyRef, true); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});

test("failure of an older terminal GET stays ready when a newer independent GET already adopted", async () => {
	const first = deferred<Response>(), started = deferred<void>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => { if (++reads === 1) { started.resolve(); return first.promise; } return saved(); } });
	const terminal = model.consumeStream(done()); await started.promise; assert.ok(await model.readRecord());
	first.reject(new Error("terminal read offline")); await terminal;
	assert.equal(model.getState().reconciliation, "ready"); assert.equal(model.readyRef, true); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});

test("an older pre-terminal response cannot authorize readiness when the terminal GET fails", async () => {
	const first = deferred<Response>(), terminalRead = deferred<Response>(), started = deferred<void>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => { if (++reads === 1) return first.promise; started.resolve(); return terminalRead.promise; } });
	const idle = model.readRecord(); const terminal = model.consumeStream(done()); await started.promise;
	first.resolve(Response.json({ messages: older })); assert.ok(await idle);
	terminalRead.reject(new Error("terminal read offline")); await terminal;
	assert.equal(model.getState().reconciliation, "failed"); assert.equal(model.readyRef, false);
});

test("a newer failed read does not invalidate an older successful terminal GET", async () => {
	const first = deferred<Response>(), started = deferred<void>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => { if (++reads === 1) { started.resolve(); return first.promise; } throw new Error("newer read offline"); } });
	const terminal = model.consumeStream(done()); await started.promise;
	await assert.rejects(model.readRecord(), /newer read offline/);
	first.resolve(saved()); await terminal;
	assert.equal(model.readyRef, true); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});

test("a new stream epoch invalidates reads started before attachment without delaying attach-first", async () => {
	const oldRead = deferred<Response>(), stream = deferred<Response>(), attached = deferred<void>(); let reads = 0; const urls: string[] = [];
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async url => { urls.push(String(url)); if (String(url).endsWith("/stream")) { attached.resolve(); return stream.promise; } return ++reads === 1 ? oldRead.promise : saved(); } });
	const idle = model.readRecord(); const running = model.resumeStream(false); await attached.promise;
	assert.deepEqual(urls, ["/api/chats/fixture", "/api/chats/fixture/stream"]);
	oldRead.resolve(Response.json({ messages: [] })); assert.equal(await idle, undefined); assert.equal(model.getState().canonicalMessages[0]!.id, "u");
	stream.resolve(done()); await running; assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});

test("delayed acceptance of a detached opening cannot strand replacement terminal reconciliation", async () => {
	const ack = deferred<Response>(), canonical = deferred<Response>(), reading = deferred<void>();
	const model = new SessionModel({ chatId: "fixture", initialMessages: [], fetch: async url => {
		if (url === "/api/chat") return ack.promise;
		if (String(url).endsWith("/stream")) return done();
		reading.resolve(); return canonical.promise;
	} });
	const opening = model.send({ type: "text", text: "opening" }, () => {});
	model.stop();
	const replacement = model.resumeStream(false); await reading.promise;
	ack.resolve(Response.json({ ok: true })); assert.equal(await opening, true);
	canonical.resolve(saved()); await replacement;
	assert.equal(model.getState().status, "ready"); assert.equal(model.getState().reconciliation, "ready"); assert.equal(model.readyRef, true);
	assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});

test("current-owner acceptance still invalidates a canonical read begun while its POST was pending", async () => {
	const ack = deferred<Response>(), oldRead = deferred<Response>(), accepted = deferred<void>();
	let closeAck!: () => void; let reads = 0;
	const body = new ReadableStream<Uint8Array>({ start(controller) { closeAck = () => controller.close(); } });
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async url => {
		if (url === "/api/chat") return ack.promise;
		if (String(url).endsWith("/stream")) return done();
		return ++reads === 1 ? oldRead.promise : saved();
	} });
	const sending = model.send({ type: "text", text: "opening" }, () => { accepted.resolve(); });
	const stale = model.readRecord({ adoption: "append" });
	ack.resolve(new Response(body)); await accepted.promise;
	// ACK headers were accepted, but its body is still draining: no replacement
	// stream/read has started, so only the ACK epoch fence can reject this GET.
	assert.equal(reads, 1);
	oldRead.resolve(Response.json({ messages: older })); assert.equal(await stale, undefined);
	closeAck(); await sending;
	assert.equal(model.readyRef, true); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});

test("a legitimately invalidated current terminal GET exposes reconciliation-only retry instead of staying syncing", async () => {
	const canonical = deferred<Response>(), reading = deferred<void>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async url => {
		if (String(url).endsWith("/steer")) return Response.json({ ok: true });
		if (++reads === 1) { reading.resolve(); return canonical.promise; }
		return saved();
	} });
	const terminal = model.consumeStream(done()); await reading.promise;
	await model.steer("in-flight steer");
	canonical.resolve(saved()); await terminal;
	assert.equal(model.getState().status, "ready"); assert.equal(model.getState().reconciliation, "failed"); assert.equal(model.readyRef, false);
	assert.equal(await model.reconcile(), true); assert.equal(model.getState().reconciliation, "ready"); assert.equal(model.readyRef, true);
});

test("reconciliation after stop starts a fresh null-owner read and only joins its current connection", async () => {
	const detached = deferred<Response>(), replacement = deferred<Response>(); let reads = 0;
	const model = new SessionModel({ chatId: "fixture", initialMessages: current, fetch: async () => ++reads === 1 ? detached.promise : replacement.promise });
	const old = model.reconcile();
	model.stop();
	const fresh = model.reconcile();
	assert.equal(reads, 2, "null stream ownership does not make detached work current");
	const joined = model.reconcile();
	assert.equal(reads, 2, "the current connection still deduplicates its own task");
	detached.resolve(saved()); assert.equal(await old, false);
	assert.equal(model.getState().reconciliation, "syncing"); assert.equal(model.readyRef, false);
	const stillJoined = model.reconcile(); assert.equal(reads, 2, "detached finalization must not clear the replacement task");
	replacement.resolve(saved());
	assert.deepEqual(await Promise.all([fresh, joined, stillJoined]), [true, true, true]);
	assert.equal(model.getState().reconciliation, "ready"); assert.equal(model.readyRef, true);
	assert.equal(model.getState().pluginQuestionAvailability?.status, "available");
});

for (const oldResult of ["success", "failure"] as const) {
	for (const replacementResult of ["success", "failure"] as const) test(`detached ${oldResult} cannot overwrite replacement ${replacementResult}`, async () => {
		const detached = deferred<Response>(), replacement = deferred<Response>(); let reads = 0;
		const model = new SessionModel({ chatId: "fixture", initialMessages: current, fetch: async () => ++reads === 1 ? detached.promise : replacement.promise });
		const old = model.reconcile(); model.stop(); const fresh = model.reconcile();
		assert.equal(reads, 2);
		if (replacementResult === "success") replacement.resolve(saved()); else replacement.reject(new Error("current offline"));
		assert.equal(await fresh, replacementResult === "success");
		const expected = replacementResult === "success" ? "ready" : "failed";
		assert.equal(model.getState().reconciliation, expected);
		if (oldResult === "success") detached.resolve(saved()); else detached.reject(new Error("detached offline"));
		assert.equal(await old, false);
		assert.equal(model.getState().reconciliation, expected);
		assert.equal(model.readyRef, replacementResult === "success");
		assert.equal(model.getState().pluginQuestionAvailability?.status, replacementResult === "success" ? "available" : undefined);
	});
}

for (const method of ["setMessages", "adoptRecord"] as const) test(`direct ${method} authority invalidates older canonical GETs`, async () => {
	const oldRead = deferred<Response>();
	const model = new SessionModel({ chatId: "fixture", initialMessages: older, fetch: async () => oldRead.promise });
	const idle = model.readRecord(); model[method](current);
	oldRead.resolve(Response.json({ messages: older })); assert.equal(await idle, undefined); assert.equal(pendingPluginQuestionOf(model.getState().canonicalMessages)?.questionId, "q1");
});
