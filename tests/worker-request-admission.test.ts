import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Model, type Api, type StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { configureWorkerRequestAdmission, refreshWorkerRequestAdmission, workerRequestStream } from "../src/agent/worker-request-admission.ts";
import { usageWasAdmitted } from "../src/agent/subscription-request-cycle.ts";

const key = Symbol.for("lh.worker-request-admission.pool.v1");
const globals = globalThis as typeof globalThis & { [key]?: { active: number; limit: number; queue: unknown[] } };
let previous: typeof globals[typeof key];
beforeEach(() => { previous = globals[key]; delete globals[key]; });
afterEach(() => {
	const state = globals[key];
	globals[key] = previous;
	assert.equal(state?.active ?? 0, 0, "no permits leaked");
	assert.equal(state?.queue.length ?? 0, 0, "no queued requests leaked");
});
const model = { api: "fixture", provider: "fixture", id: "synthetic" } as unknown as Model<Api>;
const context = normalizeContext({ messages: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1, content: [], stopReason,
		usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } } };
}
function finish(source: AssistantMessageEventStream, value = message()) {
	if (value.stopReason === "error" || value.stopReason === "aborted") source.push({ type: "error", reason: value.stopReason, error: value });
	else if (value.stopReason !== "pending") source.push({ type: "done", reason: value.stopReason, message: value });
	source.end();
	return value;
}
function fixture() {
	const sources: AssistantMessageEventStream[] = [];
	const signals: AbortSignal[] = [];
	const stream = workerRequestStream((_model, _context, options) => {
		const source = new AssistantMessageEventStream(); sources.push(source); signals.push(options!.signal!); return source;
	});
	return { stream, sources, signals, call: (signal?: AbortSignal) => stream(model, context, { signal }) };
}
async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("default global capacity is eight, FIFO spans distinct wrappers, and wrapping is idempotent", async () => {
	const a = fixture(), b = fixture();
	assert.equal(workerRequestStream(a.stream), a.stream);
	const streams = Array.from({ length: 12 }, (_, i) => i % 2 ? b.call() : a.call());
	const results = streams.map((stream) => stream.result());
	await tick();
	assert.equal(a.sources.length + b.sources.length, 8);
	assert.equal(globals[key]?.active, 8);
	assert.equal(globals[key]?.queue.length, 4);
	finish(a.sources[0]!); await tick();
	assert.equal(a.sources.length, 5, "ninth request is next, not a private wrapper lane");
	assert.equal(b.sources.length, 4);
	finish(b.sources[0]!); await tick();
	assert.equal(b.sources.length, 5, "tenth request follows ninth");
	finish(a.sources[1]!); await tick();
	finish(b.sources[1]!); await tick();
	assert.equal(a.sources.length + b.sources.length, 12);
	assert.equal(globals[key]?.active, 8);
	for (const source of [...a.sources, ...b.sources]) finish(source);
	await Promise.all(results);
});

test("live increase drains immediately; decrease does not cancel active streams", async () => {
	let limit = 1;
	configureWorkerRequestAdmission(() => limit);
	const f = fixture();
	const streams = Array.from({ length: 5 }, () => f.call());
	const results = streams.map((stream) => stream.result());
	await tick(); assert.equal(f.sources.length, 1);
	limit = 3; refreshWorkerRequestAdmission();
	assert.equal(globals[key]?.active, 3, "capacity reserved during explicit refresh");
	await tick(); assert.equal(f.sources.length, 3);
	limit = 1; refreshWorkerRequestAdmission();
	assert(f.signals.every((signal) => !signal.aborted));
	finish(f.sources[0]!); await tick(); assert.equal(f.sources.length, 3);
	finish(f.sources[1]!); await tick(); assert.equal(f.sources.length, 3);
	finish(f.sources[2]!); await tick(); assert.equal(f.sources.length, 4);
	finish(f.sources[3]!); await tick(); assert.equal(f.sources.length, 5);
	finish(f.sources[4]!); await Promise.all(results);
});

test("invalid configure/getter preserves valid configuration and release never consults faulty getter", async () => {
	let value = 1, broken = false;
	configureWorkerRequestAdmission(() => { if (broken) throw new Error("bad settings"); return value; });
	for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => configureWorkerRequestAdmission(() => invalid), RangeError);
	}
	assert.throws(() => configureWorkerRequestAdmission(() => { throw new Error("replacement"); }), /replacement/);
	const f = fixture(), a = f.call(), b = f.call();
	const results = [a.result(), b.result()];
	await tick(); assert.equal(f.sources.length, 1);
	value = 0; assert.throws(refreshWorkerRequestAdmission, RangeError);
	broken = true; assert.throws(refreshWorkerRequestAdmission, /bad settings/);
	finish(f.sources[0]!); await tick();
	assert.equal(f.sources.length, 2, "release uses last valid limit even when getter throws");
	finish(f.sources[1]!); await Promise.all(results);
	broken = false; value = 2; refreshWorkerRequestAdmission();
	assert.equal(globals[key]?.limit, 2, "failed configure never replaced original getter");
});

test("queued/pre-aborted cancellation never invokes transport and preserves no-dispatch usage semantics", async () => {
	configureWorkerRequestAdmission(() => 1);
	const f = fixture(), a = f.call(); const first = a.result();
	await tick();
	const waiting = new AbortController();
	const b = f.call(waiting.signal); const second = b.result();
	waiting.abort();
	const aborted = await second;
	assert.equal(aborted.stopReason, "aborted");
	assert.equal(usageWasAdmitted(aborted.usage), false);
	assert.equal(aborted.usage.totalTokens, 0);
	const already = new AbortController(); already.abort();
	assert.equal((await f.call(already.signal).result()).stopReason, "aborted");
	assert.equal(f.sources.length, 1);
	finish(f.sources[0]!); await first; await tick();
	assert.equal(f.sources.length, 1);
});

test("abort during reserved-permit handoff releases exactly once and skips canceled source", async () => {
	configureWorkerRequestAdmission(() => 1);
	const f = fixture();
	const signal = new AbortController();
	const a = f.call(signal.signal), b = f.call();
	const results = [a.result(), b.result()];
	signal.abort(); // first permit reserved, source microtask has not executed
	await tick(); assert.equal(f.sources.length, 1);
	assert.equal(globals[key]?.active, 1);
	assert.equal((await results[0]!).stopReason, "aborted");
	finish(f.sources[0]!); await results[1];
});

test("active abort wakes blocked iteration/result, aborts source, and hands off once", async () => {
	configureWorkerRequestAdmission(() => 1);
	const f = fixture(), signal = new AbortController();
	const a = f.call(signal.signal), iterator = a[Symbol.asyncIterator]();
	const pending = iterator.next();
	const b = f.call(), second = b.result();
	await tick(); signal.abort();
	const event = await pending;
	assert.equal(event.value?.type, "error");
	const final = await a.result();
	assert.equal(final.stopReason, "aborted");
	assert.equal(usageWasAdmitted(final.usage), true, "invoked source abort is not proof of zero dispatch");
	await iterator.return?.();
	await tick(); assert.equal(f.sources.length, 2);
	assert.equal(f.signals[0]?.aborted, true);
	assert.equal(globals[key]?.active, 1);
	finish(f.sources[1]!); await second;
});

test("source result releases a paused stream, preserving original event identities/order and actual usage", async () => {
	configureWorkerRequestAdmission(() => 1);
	const f = fixture(), a = f.call();
	const iterator = a[Symbol.asyncIterator](); const next = iterator.next();
	await tick();
	const partial = message();
	const start: AssistantMessageEvent = { type: "start", partial };
	const delta: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "native", partial };
	f.sources[0]!.push(start);
	assert.equal((await next).value, start);
	const b = f.call(), second = b.result();
	f.sources[0]!.push(delta);
	const actual = message("toolUse"); actual.responseId = "actual-response";
	const terminal: AssistantMessageEvent = { type: "done", reason: "toolUse", message: actual };
	f.sources[0]!.push(terminal); f.sources[0]!.end();
	await tick(); assert.equal(f.sources.length, 2, "native completion released despite paused consumer");
	assert.equal(await a.result(), actual);
	assert.equal((await iterator.next()).value, delta);
	assert.equal((await iterator.next()).value, terminal);
	assert.equal((await iterator.next()).done, true);
	assert.equal((await a.result()).usage, actual.usage);
	finish(f.sources[1]!); await second;
});

test("terminal and result observers can await a child at capacity one (release-before-tools)", async () => {
	configureWorkerRequestAdmission(() => 1);
	let calls = 0;
	const stream = workerRequestStream(() => {
		calls++;
		const source = new AssistantMessageEventStream(); finish(source, message("toolUse")); return source;
	});
	const outer = stream(model, context);
	for await (const event of outer) {
		if (event.type === "done") {
			assert.equal(globals[key]?.active, 0);
			assert.equal((await outer.result()).stopReason, "toolUse");
			assert.equal((await stream(model, context).result()).stopReason, "toolUse");
		}
	}
	assert.equal(calls, 2);
	const result = await stream(model, context).result();
	assert.equal(result.stopReason, "toolUse");
	assert.equal((await stream(model, context).result()).stopReason, "toolUse");
});

/** Same lazy result convention as production PluginStream. */
class PullStream extends AssistantMessageEventStream {
	started = false;
	pulls = 0;
	constructor(private readonly count: number) { super(); }
	override [Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		assert.equal(this.started, false, "no competing result() consumer"); this.started = true;
		const self = this;
		return (async function* () {
			const partial = message();
			for (let i = 0; i < self.count; i++) { self.pulls++; yield { type: "text_delta", contentIndex: 0, delta: String(i), partial } as const; }
			const final = message(); self.end(final); yield { type: "done", reason: "stop", message: final } as const;
		})();
	}
	override result(): Promise<AssistantMessage> {
		if (!this.started) void (async () => { for await (const _event of this) { /* native convention */ } })();
		return super.result();
	}
}

test("result-only drains lazy source with iterator-first setup and no competing consumer", async () => {
	const source = new PullStream(1000);
	const stream = workerRequestStream(() => source)(model, context);
	assert.equal((await stream.result()).stopReason, "stop");
	assert.equal(source.pulls, 1000);
});

test("pull-through does not eagerly buffer events while iterator consumer pauses", async () => {
	const source = new PullStream(1000);
	const stream = workerRequestStream(() => source)(model, context);
	const iterator = stream[Symbol.asyncIterator]();
	await iterator.next(); await tick();
	assert.equal(source.pulls, 1);
	await iterator.return?.();
	assert.equal(source.pulls, 1);
	assert.equal((await stream.result()).stopReason, "aborted");
});

test("native result-only end(message) preserves actual result even without terminal event", async () => {
	const actual = message();
	const stream = workerRequestStream(() => { const source = new AssistantMessageEventStream(); source.end(actual); return source; })(model, context);
	assert.equal(await stream.result(), actual);
});

test("missing terminal/end() terminates iteration and result with SDK error rather than hanging", async () => {
	const partial = message();
	const stream = workerRequestStream(() => {
		const source = new AssistantMessageEventStream(); source.push({ type: "start", partial }); source.end(); return source;
	})(model, context);
	const events = await collect(stream);
	assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
	const final = await stream.result();
	assert.equal(final.stopReason, "error");
	assert.equal(final.usage, partial.usage, "partial usage survives malformed source");
	assert.equal(usageWasAdmitted(final.usage), true);
	const resultOnly = workerRequestStream(() => { const source = new AssistantMessageEventStream(); source.end(); return source; })(model, context);
	assert.equal((await resultOnly.result()).stopReason, "error");
});

test("sync throw and rejected setup/source-result/iterator become SDK errors without permit leaks", async () => {
	configureWorkerRequestAdmission(() => 1);
	class RejectedResult extends AssistantMessageEventStream { override result(): Promise<AssistantMessage> { return Promise.reject(new Error("result failed")); } }
	class RejectedIterator extends AssistantMessageEventStream {
		override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> { throw new Error("iterator failed"); }
	}
	const sources: StreamFunction[] = [
		() => { throw new Error("sync setup failed"); },
		(() => Promise.reject(new Error("async setup failed"))) as unknown as StreamFunction,
		() => new RejectedResult(),
		() => new RejectedIterator(),
	];
	for (const source of sources) {
		const stream = workerRequestStream(source)(model, context);
		const final = await stream.result();
		assert.equal(final.stopReason, "error");
		assert.match(final.errorMessage!, /failed/);
		assert.equal(globals[key]?.active, 0);
	}
});

test("early iterator return, including before first next and while queued, never leaks", async () => {
	configureWorkerRequestAdmission(() => 1);
	const f = fixture();
	const first = f.call(), it = first[Symbol.asyncIterator]();
	await it.return?.();
	assert.equal((await first.result()).stopReason, "aborted");
	await tick(); assert.equal(f.sources.length, 0);
	const active = f.call(); const activeIt = active[Symbol.asyncIterator]();
	const next = activeIt.next(); await tick();
	const queued = f.call(), queuedIt = queued[Symbol.asyncIterator]();
	await queuedIt.return?.();
	assert.equal((await queued.result()).stopReason, "aborted");
	const returned = activeIt.return?.();
	await next; await returned;
	assert.equal((await active.result()).stopReason, "aborted");
	assert.equal(f.signals[0]?.aborted, true);
	assert.equal(f.sources.length, 1);
});

test("abort listeners are removed after successful completion", async () => {
	const controller = new AbortController();
	let added = 0, removed = 0;
	const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
	controller.signal.addEventListener = (...args: Parameters<typeof add>) => { added++; add(...args); };
	controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removed++; remove(...args); };
	const f = fixture(), stream = f.call(controller.signal), result = stream.result();
	await tick(); finish(f.sources[0]!); await result;
	assert.equal(added, 1); assert.equal(removed, 1);
	controller.abort();
	assert.equal((await stream.result()).stopReason, "stop");
});

test("duplicated modules share the same pool/configuration and wrapper metadata", async () => {
	const duplicate = await import(new URL("../src/agent/worker-request-admission.ts?duplicate", import.meta.url).href) as typeof import("../src/agent/worker-request-admission.ts");
	configureWorkerRequestAdmission(() => 1);
	const f = fixture();
	const first = f.call(), result = first.result();
	assert.equal(duplicate.workerRequestStream(f.stream), f.stream);
	const source = new AssistantMessageEventStream();
	let invoked = false;
	const second = duplicate.workerRequestStream(() => { invoked = true; return source; })(model, context);
	const secondResult = second.result();
	await tick(); assert.equal(invoked, false);
	finish(f.sources[0]!); await result; await tick();
	assert.equal(invoked, true);
	finish(source); await secondResult;
});

test("native Agent tool can await an admitted child request at capacity one", { timeout: 3000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	let requests = 0, executions = 0;
	const stream = workerRequestStream((_model, transcript) => {
		requests++;
		const source = new AssistantMessageEventStream();
		const child = transcript.messages.some((entry) => entry.role === "user" && entry.content === "child");
		const continued = transcript.messages.some((entry) => entry.role === "toolResult");
		const output = message(child || continued ? "stop" : "toolUse");
		if (!child && !continued) output.content = [{ type: "toolCall", id: "call", name: "child", arguments: {} }];
		finish(source, output);
		return source;
	});
	const agent = new Agent({ streamFn: stream, initialState: { model, tools: [{
		name: "child", label: "Child", description: "Synthetic child request", parameters: Type.Object({}),
		execute: async () => {
			executions++;
			assert.equal(globals[key]?.active, 0);
			const child = await stream(model, normalizeContext({ messages: [{ role: "user", content: "child", timestamp: 1 }] })).result();
			assert.equal(child.stopReason, "stop");
			return { content: [{ type: "text", text: "finished" }], details: {} };
		},
	}] } });
	await agent.prompt("parent"); await agent.waitForIdle();
	assert.equal(executions, 1);
	assert.equal(requests, 3);
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});

test("source-supplied abort terminal/result retains actual billed usage", async () => {
	const actual = message("aborted"); actual.errorMessage = "native cancellation";
	const controller = new AbortController();
	const stream = workerRequestStream((_model, _context, options) => {
		const source = new AssistantMessageEventStream();
		options!.signal!.addEventListener("abort", () => finish(source, actual), { once: true });
		return source;
	})(model, context, { signal: controller.signal });
	const iterator = stream[Symbol.asyncIterator](), pending = iterator.next();
	await tick(); controller.abort();
	const terminal = (await pending).value;
	assert.equal(terminal?.type, "error");
	assert.equal(await stream.result(), actual);
	assert.equal((await stream.result()).usage, actual.usage);
	await iterator.return?.();
});

test("caller abort during synchronous source construction preserves native abort terminal/usage", { timeout: 2000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	for (const resultOnly of [true, false]) {
		const caller = new AbortController(), actual = message("aborted");
		actual.errorMessage = "native constructor cancellation";
		const stream = workerRequestStream((_model, _context, options) => {
			const source = new AssistantMessageEventStream();
			options!.signal!.addEventListener("abort", () => finish(source, actual), { once: true });
			caller.abort(); // Native abort terminal exists before the factory returns.
			return source;
		})(model, context, { signal: caller.signal });
		if (!resultOnly) {
			const events = await collect(stream);
			assert.equal(events.length, 1);
			assert.equal(events[0]?.type, "error");
			if (events[0]?.type === "error") assert.equal(events[0].error, actual);
		}
		const final = await stream.result();
		assert.equal(final, actual);
		assert.equal(final.usage.totalTokens, 7);
		assert.equal(final.usage.cost.total, 3);
		assert.equal(globals[key]?.active, 0);
	}
});

test("source construction cancellation without native terminal never waits for missing setup/result", { timeout: 2000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	for (const neverResolves of [false, true]) {
		const caller = new AbortController();
		const factory = (() => {
			caller.abort();
			return neverResolves ? new Promise(() => {}) : new AssistantMessageEventStream();
		}) as StreamFunction;
		const stream = workerRequestStream(factory)(model, context, { signal: caller.signal });
		assert.equal((await stream.result()).stopReason, "aborted");
		assert.equal(globals[key]?.active, 0);
	}
});

test("uncooperative next()/return() cannot strand wrapper return/result or leak abort listeners", { timeout: 2000 }, async () => {
	configureWorkerRequestAdmission(() => 1);
	let entered!: () => void, rejectLate!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const late = new Promise<IteratorResult<AssistantMessageEvent>>((_resolve, reject) => { rejectLate = reject; });
	let added = 0, removed = 0;
	class Uncooperative extends AssistantMessageEventStream {
		override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
			return {
				next: () => { entered(); return late; },
				return: () => new Promise(() => {}),
			};
		}
		override end(): void { /* Deliberately ignores native cancellation. */ }
	}
	const stream = workerRequestStream((_model, _context, options) => {
		const signal = options!.signal!;
		const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = (...args: Parameters<typeof add>) => { added++; add(...args); };
		signal.removeEventListener = (...args: Parameters<typeof remove>) => { removed++; remove(...args); };
		return new Uncooperative();
	})(model, context);
	const iterator = stream[Symbol.asyncIterator](), pending = iterator.next();
	await started;
	await iterator.return?.(); // Neither the source next() nor return() settles.
	await pending;
	assert.equal((await stream.result()).stopReason, "aborted");
	assert.equal(globals[key]?.active, 0);
	assert.equal(added, 1); assert.equal(removed, 1);
	// A late rejection must already have a handler after the cancellation race.
	rejectLate(new Error("late ignored provider failure")); await tick();
	const child = workerRequestStream(() => { const source = new AssistantMessageEventStream(); finish(source); return source; })(model, context);
	assert.equal((await child.result()).stopReason, "stop");
});

test("public end(message) cancellation seam releases and closes underlying source", async () => {
	configureWorkerRequestAdmission(() => 1);
	const f = fixture(), a = f.call(), b = f.call();
	const iterator = a[Symbol.asyncIterator](); const next = iterator.next();
	const second = b.result();
	await tick(); const actual = message("aborted");
	a.end(actual);
	assert.equal(await a.result(), actual);
	await next; await iterator.return?.();
	await tick(); assert.equal(f.sources.length, 2);
	assert.equal(f.signals[0]?.aborted, true);
	finish(f.sources[1]!); await second;
});
