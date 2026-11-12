import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AssistantMessage, JsonObject, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { createPluginWorkerService, type PluginWorkerServiceDeps } from "../src/agent/plugin-workers.ts";
import { createPluginTaskRecordStore } from "../src/store/plugin-task-records.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { markUnadmittedUsage } from "../src/agent/subscription-request-cycle.ts";
import type { PluginTaskSnapshot, PluginWorkerDefinition, PluginWorkerStartOptions } from "../src/core/plugin-workers.ts";

const pin = { provider: "worker-fixture", id: "offline", thinkingLevel: "medium" } as const;
const usage = () => ({ input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const call = (name: string, args: JsonObject, id = `call_${name}`): ToolCall => ({ type: "toolCall", id, name, arguments: args });
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = content.some(c => c.type === "toolCall") ? "toolUse" : "stop"): AssistantMessage {
	return { role: "assistant", provider: pin.provider, model: pin.id, api: "fixture" as never, content, stopReason, timestamp: 1, usage: usage() };
}
const submit = (result: unknown, id?: string) => call("submit_result", { result } as JsonObject, id);
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T = void>() { let resolve!: (v: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function options(extra: Partial<PluginWorkerStartOptions> = {}): PluginWorkerStartOptions {
	return { requestId: "request_one", input: { source: { id: "trusted_source" } }, prompt: "Produce the requested result", model: pin, purpose: "background", maxTurns: 4, ...extra };
}
type Script = (context: TranscriptContext, index: number, stream: AssistantMessageEventStream) => AssistantMessage | Promise<AssistantMessage>;
function fixture(t: TestContext, script: Script = () => message([submit("answer")]), override: Partial<PluginWorkerServiceDeps> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "lh-workers-"));
	const store = createPluginTaskRecordStore(join(directory, "tasks"));
	const activation = new AbortController();
	const calls: TranscriptContext[] = [];
	const bound: unknown[][] = [];
	const billed: unknown[] = [];
	let changes = 0;
	const deps: PluginWorkerServiceDeps = { store, signal: activation.signal, onChange: () => { changes++; }, onUsage: (_model, value) => billed.push(value),
		engineFor: (...args) => {
			bound.push(args);
			return { model: { api: "fixture", provider: pin.provider, id: pin.id } as never, level: "medium", streamFn: (_m, context, opts) => {
				const stream = new AssistantMessageEventStream();
				const index = calls.length; calls.push(structuredClone(context));
				const aborted = () => { const m = message([], "aborted"); stream.push({ type: "error", reason: "aborted", error: m }); stream.end(m); };
				opts?.signal?.addEventListener("abort", aborted, { once: true });
				void Promise.resolve().then(() => script(context, index, stream)).then(m => {
					if (m.stopReason === "error" || m.stopReason === "aborted") stream.push({ type: "error", reason: m.stopReason, error: m });
					else if (m.stopReason !== "pending") stream.push({ type: "done", reason: m.stopReason, message: m });
					stream.end(m); opts?.signal?.removeEventListener("abort", aborted);
				});
				return stream;
			} };
		}, ...override };
	const service = createPluginWorkerService(deps);
	t.after(async () => { await service.dispose().catch(() => {}); activation.abort(); rmSync(directory, { recursive: true, force: true }); });
	const register = (definition: Partial<PluginWorkerDefinition> = {}) => service.register({ id: "worker", instructions: "Use submit_result to finish", resultSchema: Type.Unknown(), ...definition });
	return { directory, store, service, calls, bound, billed, activation, register, deps, changes: () => changes };
}

test("acceptance is synchronous, durable and independent of subscribers; native history and tool results persist", async t => {
	const gate = deferred<AssistantMessage>(); const f = fixture(t, () => gate.promise); f.register();
	const initial = f.service.start("worker", options({ options: { temperature: 0.2, maxTokens: 77 } }));
	assert.equal(initial.status, "queued"); assert.equal(f.calls.length, 0);
	assert.deepEqual(f.store.get(initial.id), initial);
	assert.equal(initial.messages[0]?.role, "user");
	const seen: string[] = []; const detach = f.service.subscribe(initial.id, s => seen.push(s.status));
	assert.equal(seen[0], "queued"); detach();
	await tick(); assert.equal(f.calls.length, 1);
	const final = message([{ type: "thinking", thinking: "native", thinkingSignature: "signed" }, submit("answer")]);
	gate.resolve(final);
	assert.deepEqual(await f.service.wait(initial.id), { id: initial.id, status: "succeeded", result: "answer" });
	await tick();
	const saved = f.store.get(initial.id)!;
	assert.equal(saved.status, "succeeded"); assert.deepEqual(saved.messages[1], final);
	assert(saved.messages.some(m => m.role === "toolResult" && !m.isError));
	assert.equal(saved.usage?.steps, 1); assert.equal(f.billed.length, 1); assert(f.changes() > 0);
	assert.deepEqual(f.bound[0], [pin, "background", { temperature: 0.2, maxTokens: 77 }]);
	assert.deepEqual(readdirSync(f.directory), ["tasks"]);
});

test("requestId only deduplicates identical immutable acceptances, including across service restart", async t => {
	const gate = deferred<AssistantMessage>(); const f = fixture(t, () => gate.promise); f.register();
	const requestId = '../学習:chunk:["1",2]';
	const input = options({ requestId }); const accepted = f.service.start("worker", input);
	(input.input as { source: { id: string } }).source.id = "mutated";
	assert.equal((f.service.get(accepted.id).input as { source: { id: string } }).source.id, "trusted_source");
	assert.equal(f.service.start("worker", options({ requestId })).id, accepted.id);
	assert.throws(() => f.service.start("worker", options({ requestId, prompt: "different" })), /requestId/);
	assert.throws(() => f.service.start("different", options({ requestId })), /requestId/);
	await f.service.dispose();
	const restarted = createPluginWorkerService({ ...f.deps }); t.after(() => restarted.dispose());
	assert.equal(restarted.start("worker", options({ requestId })).status, "interrupted");
	assert.equal(restarted.list().length, 1); assert.equal(f.calls.length, 0);
	gate.resolve(message([submit("late")]));
});

test("schema errors and asynchronous semantic correction reuse the native context and immutable trusted input", async t => {
	let validations = 0; let factory = 0;
	const f = fixture(t, (_ctx, i) => message([i === 0 ? call("submit_result", { result: "bad" }) : submit(i === 1 ? 3 : 4)]));
	f.register({ resultSchema: Type.Number(), tools(context) {
		factory++; assert(Object.isFrozen(context)); assert(Object.isFrozen(context.input));
		assert(Object.isFrozen((context.input as { source: object }).source));
		return [];
	}, async validateResult(result, context) {
		validations++; await Promise.resolve(); assert.equal(context.taskId.length > 0, true);
		assert.deepEqual(context.input, { source: { id: "trusted_source" } });
		if (result !== 4) throw new Error("Use four for this source");
	} });
	const started = f.service.start("worker", options());
	assert.equal((await f.service.wait(started.id)).status, "succeeded"); await tick();
	assert.equal(validations, 2); assert.equal(factory, 1); assert.equal(f.calls.length, 3);
	assert(f.calls[1]?.messages.some(m => m.role === "toolResult" && m.isError));
	assert(f.calls[2]?.messages.some(m => m.role === "toolResult" && m.content.some(c => c.type === "text" && c.text.includes("Use four"))));
});

for (const result of [false, 0, "", null]) test(`falsy JSON result ${JSON.stringify(result)} is authoritative`, async t => {
	const f = fixture(t, () => message([submit(result)])); f.register({ resultSchema: result === null ? Type.Null() : Type.Literal(result) });
	const started = f.service.start("worker", options());
	assert.deepEqual(await f.service.wait(started.id), { id: started.id, status: "succeeded", result });
	f.service.cancel(started.id); await f.service.dispose();
	assert.equal(f.store.get(started.id)?.status, "succeeded");
	assert.equal(f.service.get(started.id).result, result);
});

test("batched duplicate submissions cannot overwrite accepted result or run later side effects", async t => {
	let effects = 0; let validations = 0;
	const f = fixture(t, () => message([submit("first", "one"), call("effect", {}, "effect"), submit("second", "two")]));
	f.register({ validateResult: async () => { validations++; await tick(); }, tools: () => [{ name: "effect", label: "effect", description: "side effect", parameters: Type.Object({}), prepareArguments: raw => { effects++; return raw; }, execute: async () => { effects++; return { content: [], details: null }; } }] });
	const started = f.service.start("worker", options());
	assert.equal((await f.service.wait(started.id)).status, "succeeded"); await tick();
	assert.equal(f.service.get(started.id).result, "first"); assert.equal(effects, 0); assert.equal(validations, 1); assert.equal(f.calls.length, 1);
	assert.equal(f.store.get(started.id)?.messages.filter(m => m.role === "toolResult").length, 3);
});

test("completed parallel tool results checkpoint immediately, without replay and in source order", async t => {
	const slow = deferred<void>(); const done = deferred<void>(); let count = 0;
	const f = fixture(t, (_c, i) => message(i === 0 ? [call("slow", {}), call("fast", {})] : [submit("ok")]));
	f.register({ tools: () => ["slow", "fast"].map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => {
		if (name === "slow") await slow.promise;
		count++; if (name === "fast") done.resolve();
		return { content: [{ type: "text" as const, text: name }], details: { native: name } };
	} })) });
	const started = f.service.start("worker", options()); await done.promise; await tick();
	assert(f.store.get(started.id)?.messages.some(m => m.role === "toolResult" && m.toolName === "fast"));
	assert(!f.store.get(started.id)?.messages.some(m => m.role === "toolResult" && m.toolName === "slow"));
	slow.resolve(); await f.service.wait(started.id); await tick();
	assert.equal(count, 2);
	assert.deepEqual(f.store.get(started.id)?.messages.filter(m => m.role === "toolResult").map(m => m.toolName), ["slow", "fast", "submit_result"]);
});

test("natural completion, correction exhaustion and provider errors have explicit failed outcomes", async t => {
	for (const kind of ["no_result", "max_turns", "run_error"] as const) {
		const f = fixture(t, () => kind === "no_result" ? message([{ type: "text", text: "not a submission" }]) : kind === "max_turns" ? message([submit("bad")]) : { ...message([], "error"), errorMessage: "Provider refused" });
		f.register({ validateResult: () => { throw new Error("Please correct"); } });
		const s = f.service.start("worker", options({ maxTurns: 2 })); const out = await f.service.wait(s.id);
		assert.equal(out.status, "failed"); assert.equal(out.error.code, kind);
		assert.equal(f.calls.length, kind === "max_turns" ? 2 : 1);
	}
});

test("cancel fences async validation; waiter abort and unsubscription do not cancel the task", async t => {
	const validating = deferred<void>(); const release = deferred<void>();
	const f = fixture(t); f.register({ validateResult: async () => { validating.resolve(); await release.promise; } });
	const s = f.service.start("worker", options()); const waiter = new AbortController();
	const wait = f.service.wait(s.id, waiter.signal); waiter.abort(); await assert.rejects(wait, { name: "AbortError" });
	const detach = f.service.subscribe(s.id, () => {}); detach(); await validating.promise;
	assert.equal(f.service.get(s.id).status, "running"); f.service.cancel(s.id);
	assert.equal((await f.service.wait(s.id)).status, "cancelled"); release.resolve(); await tick();
	assert.equal(f.service.get(s.id).status, "cancelled"); assert(!Object.hasOwn(f.service.get(s.id), "result"));
});

test("timeout and activation disposal persist first terminal outcomes without replay or late writes", async t => {
	const gate = deferred<AssistantMessage>(); const f = fixture(t, () => gate.promise); f.register();
	const timed = f.service.start("worker", options({ timeoutMs: 15 }));
	// Keep the test alive while the worker's lifetime timer is unref'ed.
	const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
	const out = await f.service.wait(timed.id); assert.equal(out.status, "failed"); assert.equal(out.error.code, "timeout");
	const priorCalls = f.calls.length;
	const active = f.service.start("worker", options({ requestId: "active" })); await tick();
	f.activation.abort(); assert.equal((await f.service.wait(active.id)).status, "interrupted");
	assert.throws(() => f.service.start("worker", options({ requestId: "disabled" })), /disabled|disposed/);
	const saved = readFileSync(join(f.directory, "tasks", `${active.id}.json`), "utf8");
	gate.resolve(message([submit("late")])); await tick();
	assert.equal(readFileSync(join(f.directory, "tasks", `${active.id}.json`), "utf8"), saved);
	const restarted = createPluginWorkerService({ ...f.deps, signal: undefined }); t.after(() => restarted.dispose());
	assert.equal(restarted.get(active.id).status, "interrupted"); assert.equal(f.calls.length, priorCalls + 1);
});

test("restart interrupts both queued and running records, retains completed outcomes, and never invokes an engine", async t => {
	const f = fixture(t); const now = new Date().toISOString();
	for (const status of ["queued", "running"] as const) f.store.save({ ...options({ requestId: status }), version: 1, id: status, definitionId: "missing_definition", createdAt: now, updatedAt: now, status, turns: 0, messages: [{ role: "user", content: "accepted", timestamp: 1 }] });
	const service = createPluginWorkerService(f.deps); t.after(() => service.dispose());
	assert.deepEqual(service.list().map(s => s.status), ["interrupted", "interrupted"]); assert.equal(f.calls.length, 0);
	assert.equal((await service.wait("running")).status, "interrupted");
});

test("assistant call persistence failure prevents side effects; unreadable durable failure rejects wait", async t => {
	let effects = 0; const f = fixture(t, () => message([call("effect", {})]));
	const service = createPluginWorkerService({ ...f.deps, store: { ...f.store, save(r) { if (r.messages.some(m => m.role === "assistant")) throw new Error("disk full"); f.store.save(r); } } }); t.after(() => service.dispose());
	service.register({ id: "worker", instructions: "Do work", resultSchema: Type.String(), tools: () => [{ name: "effect", label: "effect", description: "effect", parameters: Type.Object({}), execute: async () => { effects++; return { content: [], details: null }; } }] });
	const s = service.start("worker", options()); const out = await service.wait(s.id);
	assert.equal(out.status, "failed"); assert.equal(out.error.code, "storage_error"); assert.equal(effects, 0);
	const broken = createPluginWorkerService({ ...f.deps, store: { list: () => [], get: () => null, save(r) { if (r.status !== "queued") throw new Error("all writes lost"); } } }); t.after(() => broken.dispose().catch(() => {}));
	broken.register({ id: "worker", instructions: "Do work", resultSchema: Type.String() });
	const b = broken.start("worker", options()); await assert.rejects(broken.wait(b.id), /storage failed/);
});

test("terminal result write failure cannot acknowledge success or execute subsequent batched effects", async t => {
	let effects = 0; const f = fixture(t, () => message([submit("answer"), call("effect", {})]));
	const service = createPluginWorkerService({ ...f.deps, store: { ...f.store, save(r) { if (r.status === "succeeded") throw new Error("result disk failure"); f.store.save(r); } } }); t.after(() => service.dispose());
	service.register({ id: "worker", instructions: "Do work", resultSchema: Type.String(), tools: () => [{ name: "effect", label: "effect", description: "effect", parameters: Type.Object({}), execute: async () => { effects++; return { content: [], details: null }; } }] });
	const s = service.start("worker", options()); const out = await service.wait(s.id); assert.equal(out.status, "failed"); assert.equal(effects, 0);
	assert(!Object.hasOwn(f.store.get(s.id)!, "result"));
});

test("accepted success survives a later native acknowledgment checkpoint failure", async t => {
	const f = fixture(t); const service = createPluginWorkerService({ ...f.deps, store: { ...f.store, save(r) { if (r.status === "succeeded" && r.messages.some(m => m.role === "toolResult")) throw new Error("ack disk failure"); f.store.save(r); } } }); t.after(() => service.dispose());
	service.register({ id: "worker", instructions: "Do work", resultSchema: Type.String() });
	const s = service.start("worker", options()); assert.equal((await service.wait(s.id)).status, "succeeded"); await tick(); service.cancel(s.id);
	assert.equal(f.store.get(s.id)?.status, "succeeded"); assert.equal(f.store.get(s.id)?.result, "answer");
});

test("denied usage is not accounted; accounting storage errors stop before tools", async t => {
	const f = fixture(t, () => { const m = message([], "error"); m.errorMessage = "Admission refused"; markUnadmittedUsage(m.usage); return m; }); f.register();
	const s = f.service.start("worker", options()); await f.service.wait(s.id); assert.equal(f.billed.length, 0); assert.equal(f.service.get(s.id).usage, undefined);
	let effects = 0; const good = fixture(t, () => message([submit("answer")]), { onUsage() { effects++; throw new Error("accounting disk failure"); } }); good.register();
	const g = good.service.start("worker", options()); const out = await good.service.wait(g.id); assert.equal(out.status, "failed"); assert.equal(out.error.code, "storage_error"); assert.equal(effects, 1);
});

test("definition/input/options/identifier hygiene rejects before acceptance", async t => {
	const f = fixture(t);
	assert.throws(() => f.register({ resultSchema: { type: "object", properties: [] } as never }), /schema/);
	f.register(); assert.throws(() => f.register(), /already registered/);
	for (const patch of [{ requestId: "" }, { input: undefined }, { input: { bad: Infinity } }, { maxTurns: 0 }, { model: { id: "offline" } }, { purpose: "other" }, { timeoutMs: -1 }, { options: { apiKey: "secret" } }, { options: { maxTokens: Infinity } }]) {
		assert.throws(() => f.service.start("worker", options(patch as never)));
	}
	assert.equal(f.service.list().length, 0); assert.equal(f.calls.length, 0);
	assert.throws(() => f.service.get("../unsafe"), /id/);
	assert.throws(() => f.service.start("missing", options()), /unavailable/);
});

test("stream subscriptions coalesce current progress and reattach without replaying chunks", async t => {
	const gate = deferred<AssistantMessage>(); const streamed = deferred<void>();
	const f = fixture(t, async (_context, _index, stream) => {
		const base = message([{ type: "text", text: "" }]); stream.push({ type: "start", partial: base });
		for (let i = 0; i < 2000; i++) stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: { ...base, content: [{ type: "text", text: "x".repeat(i + 1) }] } });
		streamed.resolve(); return gate.promise;
	}); f.register();
	const started = f.service.start("worker", options()); let observations = 0;
	const detach = f.service.subscribe(started.id, () => { observations++; });
	await streamed.promise; await tick();
	const partial = f.service.get(started.id).partial; assert.equal((partial?.content[0] as { text: string }).text.length, 2000);
	let current: PluginTaskSnapshot | undefined; const reattach = f.service.subscribe(started.id, value => { current = value; });
	assert.equal((current?.partial?.content[0] as { text: string }).text.length, 2000); assert(observations < 10);
	assert.equal(f.store.get(started.id)?.messages.length, 1);
	detach(); reattach(); gate.resolve(message([submit("done")])); await f.service.wait(started.id); await tick();
	assert.equal(f.service.get(started.id).partial, undefined);
});

test("disposal wakes an existing waiter even if interruption persistence permanently fails", async t => {
	const f = fixture(t); let fail = false;
	const service = createPluginWorkerService({ ...f.deps, store: { ...f.store, save(r) { if (fail) throw new Error("storage offline"); f.store.save(r); } } });
	service.register({ id: "worker", instructions: "Do work", resultSchema: Type.String() });
	const started = service.start("worker", options()); const waited = service.wait(started.id);
	fail = true;
	const rejected = assert.rejects(waited, /storage failed/);
	await assert.rejects(service.dispose(), /storage failed/); await rejected;
	assert.equal(f.calls.length, 0); assert.equal(f.store.get(started.id)?.status, "queued");
});

test("initial acceptance failure poisons later acceptance and never invokes engines or factories", async t => {
	let factories = 0; const f = fixture(t);
	const service = createPluginWorkerService({ ...f.deps, store: { ...f.store, save() { throw new Error("acceptance offline"); } } }); t.after(() => service.dispose());
	service.register({ id: "worker", instructions: "Do work", resultSchema: Type.String(), tools() { factories++; return []; } });
	assert.throws(() => service.start("worker", options()), /acceptance storage failed/);
	assert.throws(() => service.start("worker", options({ requestId: "second" })), /acceptance storage failed/);
	await tick(); assert.equal(factories, 0); assert.equal(f.calls.length, 0); assert.deepEqual(service.list(), []);
});

test("an uncertain post-commit failure never overwrites canonical accepted success or returns a false durable acknowledgment", async t => {
	const f = fixture(t); const service = createPluginWorkerService({ ...f.deps, store: { ...f.store, save(r) { f.store.save(r); if (r.status === "succeeded") throw new Error("directory fsync uncertain"); } } }); t.after(() => service.dispose().catch(() => {}));
	service.register({ id: "worker", instructions: "Do work", resultSchema: Type.String() });
	const started = service.start("worker", options()); await assert.rejects(service.wait(started.id), /storage failed/);
	assert.equal(f.store.get(started.id)?.status, "succeeded"); assert.equal(f.store.get(started.id)?.result, "answer");
	await service.dispose().catch(() => {}); assert.equal(f.store.get(started.id)?.status, "succeeded");
});

test("cancelled queued tasks never run a factory or engine, and timeout detaches stalled engine resolution", async t => {
	const f = fixture(t); let factories = 0; f.register({ tools: () => { factories++; return []; } });
	const queued = f.service.start("worker", options()); f.service.cancel(queued.id); await tick();
	assert.equal((await f.service.wait(queued.id)).status, "cancelled"); assert.equal(f.calls.length, 0); assert.equal(factories, 0);
	const gate = deferred<never>(); const waiting = createPluginWorkerService({ ...f.deps, engineFor: () => gate.promise }); t.after(() => waiting.dispose());
	waiting.register({ id: "worker", instructions: "Do work", resultSchema: Type.String() });
	const started = waiting.start("worker", options({ requestId: "stalled", timeoutMs: 10 }));
	const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
	const out = await waiting.wait(started.id); assert.equal(out.status, "failed"); assert.equal(out.error.code, "timeout");
});

test("explicit empty prompts are retained, long lifetimes are not truncated by Node timers, and synchronous deadline overrun cannot succeed", async t => {
	const f = fixture(t); f.register();
	const long = f.service.start("worker", options({ prompt: "", timeoutMs: 2147483648 }));
	assert.equal(long.messages[0]?.content, ""); f.service.cancel(long.id); assert.equal((await f.service.wait(long.id)).status, "cancelled");
	const original = Date.now; let clock = original();
	t.mock.method(Date, "now", () => clock);
	const slow = fixture(t); slow.register({ validateResult() { clock += 1000; } });
	const started = slow.service.start("worker", options({ timeoutMs: 100 }));
	const out = await slow.service.wait(started.id); assert.equal(out.status, "failed"); assert.equal(out.error.code, "timeout");
	assert(!Object.hasOwn(slow.service.get(started.id), "result"));
});

test("native reusable runner honestly requires an engine or role and never starts pre-aborted work", async () => {
	await assert.rejects(runSubagent([], { systemPrompt: "", prompt: "explicit", maxTurns: 1 }), /engine or configured model role/);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(runSubagent([], { systemPrompt: "", prompt: "explicit", maxTurns: 1, abortSignal: aborted.signal }), { name: "AbortError" });
});
