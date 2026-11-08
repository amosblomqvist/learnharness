import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginSubmissionRunner, type SubmissionAttempt, type SubmissionInterceptorRegistration } from "../components/plugin-submission-runner.ts";
import { SessionModel } from "../components/session-core.ts";
import type { PluginSubmission, PluginSubmissionTarget, PluginSurfaceTarget, LhMessage } from "../src/core/index.ts";

const target: PluginSubmissionTarget = { type: "text", sessionId: "chat", sessionKind: "teaching", channels: ["content"], surfaceTarget: {} as PluginSurfaceTarget };
const input: PluginSubmission = { type: "text", content: { text: "draft", images: [] } };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function owner(intercept: SubmissionInterceptorRegistration["interceptor"]["intercept"], options: { signal?: AbortSignal; current?: () => boolean; report?: (error: unknown) => void } = {}): SubmissionInterceptorRegistration {
	return { pluginId: "fixture", pluginName: "Fixture", interceptor: { id: "capture", intercept }, signal: options.signal ?? new AbortController().signal, isCurrent: options.current ?? (() => true), report: options.report ?? (() => {}) };
}

test("reserves before dictation finalization, captures final input/history and never duplicates", async () => {
	const runner = new PluginSubmissionRunner(); const final = deferred<void>(); let text = "before", calls = 0;
	const registration = owner((value, context) => { calls++; assert.equal(value.type, "text"); if (value.type === "text") assert.equal(value.content.text, "after"); assert.ok(Object.isFrozen(context.messages[0])); assert.equal(context.surfaceTarget, target.surfaceTarget); });
	const attempt = runner.begin(target, [registration], () => true)!;
	const capture = attempt.finalize(async () => { await final.promise; return { ...input, content: { text, images: [] } } as PluginSubmission; });
	assert.equal(runner.begin(target, [registration], () => true), null);
	text = "after"; final.resolve(); const value = await capture;
	const history = [{ role: "user", id: "u", content: "history", timestamp: 0 }] as LhMessage[];
	await attempt.prepare(value, history); history[0]!.id = "new";
	assert.equal(calls, 1); attempt.cancel(); assert.equal(runner.occupied, false);
});

test("target change during finalization never captures or intercepts a replacement", async () => {
	const runner = new PluginSubmissionRunner(), final = deferred<void>(); let current = true, calls = 0;
	const attempt = runner.begin(target, [owner(() => { calls++; })], () => current)!;
	const pending = attempt.finalize(async () => { await final.promise; return input; }); current = false; final.resolve();
	await assert.rejects(pending, { name: "AbortError" }); assert.equal(calls, 0); assert.equal(runner.occupied, false);
});

test("cancel/unregister races ignore hooks that ignore their signal and retain the original input", async () => {
	for (const unregister of [false, true]) {
		const pending = deferred<PluginSubmission>(); const abort = new AbortController(); let subsequent = 0;
		const runner = new PluginSubmissionRunner(); const first = owner(() => pending.promise, { signal: abort.signal });
		const second = { ...owner(() => { subsequent++; }), pluginId: "later" };
		const attempt = runner.begin(target, [first, second], () => true)!; const prepared = attempt.prepare(input, []);
		if (unregister) abort.abort(); else runner.cancel();
		await assert.rejects(prepared, { name: "AbortError" });
		pending.resolve({ type: "text", content: { text: "late", images: [] } }); await tick();
		assert.equal(subsequent, 0); assert.equal(input.content.text, "draft"); assert.equal(runner.occupied, false);
	}
});

test("null cancellation, thrown error, invalid replacement and type changes all fail closed", async () => {
	for (const [index, intercept] of [() => null, () => { throw new Error("broken"); }, () => ({ ...input, extra: true }), () => ({ type: "thinking", content: { text: "wrong", images: [] } })].entries()) {
		let later = 0; const runner = new PluginSubmissionRunner();
		const attempt: SubmissionAttempt = runner.begin(target, [owner(intercept as never), { ...owner(() => { later++; }), pluginId: "later" }], () => true)!;
		if (index === 0) assert.equal(await attempt.prepare(input, []), null);
		else await assert.rejects(attempt.prepare(input, []), /Could not prepare submission \(Fixture\): .*Your input has been kept/);
		assert.equal(later, 0); assert.equal(input.content.text, "draft"); assert.equal(runner.occupied, false);
	}
});

test("outputs are detached and deeply frozen before subsequent hooks", async () => {
	const replacement = { type: "text" as const, content: { text: "prepared", images: [] } };
	const runner = new PluginSubmissionRunner(); let observed = "";
	const attempt = runner.begin(target, [owner(() => replacement), { ...owner(value => { assert.ok(Object.isFrozen(value)); if (value.type === "text") { assert.ok(Object.isFrozen(value.content)); observed = value.content.text; } }), pluginId: "later" }], () => true)!;
	const prepared = await attempt.prepare(input, []); replacement.content.text = "mutated";
	assert.equal(observed, "prepared"); assert.equal(prepared?.type === "text" && prepared.content.text, "prepared"); attempt.cancel();
});

test("acceptance is live best-effort, once, owner-scoped, and refuses late observer registration", async () => {
	const reports: unknown[] = []; const calls: string[] = []; let late!: () => void; let live = true;
	const a = owner((_input, context) => { context.onAccepted(() => { calls.push("a"); throw new Error("callback failed"); }); late = () => context.onAccepted(() => { calls.push("late"); }); }, { report: error => reports.push(error) });
	const b = { ...owner((_input, context) => { context.onAccepted(async () => { calls.push("b"); }); }), pluginId: "other" };
	const c = { ...owner((_input, context) => context.onAccepted(() => { calls.push("dead"); })), pluginId: "third", isCurrent: () => live };
	const runner = new PluginSubmissionRunner(), attempt = runner.begin(target, [a, b, c], () => true)!;
	await attempt.prepare(input, []); late(); attempt.deliver(); live = false; attempt.accepted(); attempt.accepted(); await tick();
	assert.deepEqual(calls, ["a", "b"]); assert.equal(reports.length, 1); assert.equal(runner.occupied, false);
});

test("HTTP acknowledgment releases the lease before streaming; fresh busy steers may prepare", async () => {
	const stream = deferred<Response>(); let accepts = 0;
	const runner = new PluginSubmissionRunner(); const attempt = runner.begin(target, [owner((_input, context) => context.onAccepted(() => { accepts++; }))], () => true)!;
	await attempt.prepare(input, []); attempt.deliver();
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => String(url) === "/api/chat" ? Response.json({ accepted: true }) : String(url).endsWith("/stream") ? stream.promise : Response.json({ messages: [] }) });
	const sending = model.send({ type: "text", text: "prepared" }, attempt.accepted, undefined, attempt.refused);
	await tick(); assert.equal(accepts, 1); assert.equal(runner.occupied, false);
	const fresh = runner.begin(target, [], () => true); assert.ok(fresh); fresh.cancel();
	model.stop(); stream.resolve(new Response("data: [DONE]\n\n")); await sending;
});

test("refusal never acknowledges; prepared steer-to-send fallback calls hooks and acceptance only once", async () => {
	let hooks = 0, accepts = 0; const sent: unknown[] = [];
	const runner = new PluginSubmissionRunner();
	const attempt = runner.begin(target, [owner((_input, context) => { hooks++; context.onAccepted(() => { accepts++; }); return { type: "text", content: { text: "transformed", images: [] } }; })], () => true)!;
	const prepared = await attempt.prepare(input, []); assert.ok(prepared); attempt.deliver();
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async (url, init) => {
		if (init?.body) sent.push(JSON.parse(String(init.body)));
		if (String(url).endsWith("/steer")) return new Response("settled", { status: 409 });
		if (String(url) === "/api/chat") return Response.json({ accepted: true });
		if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
		return Response.json({ messages: [] });
	} });
	assert.equal(await model.steer(prepared.type === "text" ? prepared.content.text : "", undefined, attempt.accepted, attempt.refused), true);
	assert.equal(hooks, 1); assert.equal(accepts, 1); assert.equal(sent.length, 2); assert.match(JSON.stringify(sent), /transformed/);
	for (const status of [400, 412, 500]) {
		let ack = false, settled = false, posts = 0;
		const refused = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async () => { posts++; return new Response("refused", { status }); } });
		assert.equal(await refused.steer("keep", undefined, () => { ack = true; }, () => { settled = true; }), false);
		assert.equal(ack, false); assert.equal(settled, true); assert.equal(posts, 1);
	}
});

test("model retry reuses accepted transformed history and never re-intercepts learner content", async () => {
	let hooks = 0, accepts = 0; const posted: unknown[] = [];
	const runner = new PluginSubmissionRunner();
	const attempt = runner.begin(target, [owner((_input, context) => { hooks++; context.onAccepted(() => { accepts++; }); return { type: "text", content: { text: "accepted transformed text", images: [] } }; })], () => true)!;
	const prepared = await attempt.prepare(input, []); assert.ok(prepared && prepared.type === "text");
	const history = [{ id: "accepted-user", role: "user", content: prepared.content.text, timestamp: 0 }] as LhMessage[];
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async (url, init) => {
		if (String(url) === "/api/chat") { posted.push(JSON.parse(String(init?.body))); return Response.json({ accepted: true }); }
		if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
		return Response.json({ messages: history });
	} });
	attempt.deliver(); await model.send({ type: "text", text: prepared.content.text }, attempt.accepted, undefined, attempt.refused);
	await model.send({ type: "retry" });
	assert.equal(hooks, 1); assert.equal(accepts, 1);
	assert.deepEqual(posted, [{ chatId: "chat", input: { type: "text", text: "accepted transformed text" } }, { chatId: "chat", input: { type: "retry" } }]);
	assert.equal(model.getState().nativeMessages[0]?.role, "user");
});
