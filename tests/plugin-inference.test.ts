import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createPluginInference, type PluginInferenceDeps } from "../src/server/plugin-inference.ts";
import { createPluginAgentService } from "../src/agent/plugin-agents.ts";
import { createPluginAgentRecordStore } from "../src/store/plugin-agent-records.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import type { ModelCatalogResponse } from "../src/core/contracts/models.ts";
import type { PluginModelSpec } from "../src/core/plugin-agents.ts";
import type { PluginInferenceOptions, PluginInferenceRequest } from "../src/core/plugins.ts";
import { usageWasAdmitted, type SubscriptionDispatchLifecycle } from "../src/agent/subscription-request-cycle.ts";

const spec = { provider: "fixture", id: "explicit-model", thinkingLevel: "medium" } as const;
const usage = () => ({ input: 3, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 8, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 } });
function output(model: PluginModelSpec = spec): AssistantMessage {
	return { role: "assistant", api: "fixture" as never, provider: model.provider, model: model.id, timestamp: 1, usage: usage(), stopReason: "toolUse", responseId: "native-response",
		content: [{ type: "thinking", thinking: "Reasoning", thinkingSignature: "native-signature" }, { type: "toolCall", id: "native-call", name: "plugin_tool", arguments: { task: "native arguments" } }, { type: "text", text: "Response", textSignature: "native-text-signature" }] };
}
function listing(model: PluginModelSpec = spec): ModelCatalogResponse {
	return { models: [{ provider: model.provider, id: model.id, name: "Explicit fixture model", reasoning: true, input: ["text"], supportedLevels: ["off", "medium"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
		providers: [{ id: model.provider, envVar: "FIXTURE_KEY", keyPresent: true }], defaults: { model }, rolePins: { researcher: { model }, demoBuilder: null, visualMaker: null, extractor: null, auditor: null }, slots: { strong: { model }, cheap: null, vision: null } };
}
function request(model: PluginModelSpec = spec): PluginInferenceRequest {
	return { model, purpose: "background", context: { systemPrompt: "Plugin task instructions", messages: [{ role: "user", content: "Explicit task", timestamp: 1 }] } };
}
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
type Dispatch = { model: PluginModelSpec; background: boolean; context: TranscriptContext; options: SimpleStreamOptions; lifecycle?: SubscriptionDispatchLifecycle };
function fixture(t: TestContext, customize?: { model?: PluginModelSpec; admitted?: boolean; produce?: (stream: AssistantMessageEventStream, call: Dispatch) => void }) {
	const directory = mkdtempSync(join(tmpdir(), "lh-plugin-inference-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const signal = new AbortController();
	const model = customize?.model ?? spec;
	const catalog = listing(model);
	const calls: Dispatch[] = [];
	let keyPresent = true;
	const deps: PluginInferenceDeps = {
		catalog: () => catalog,
		providerKeyPresent: () => keyPresent,
		engineForSpec: (pin, background, lifecycle) => ({
			model: { api: "fixture", provider: pin.provider, id: pin.id } as never,
			level: pin.thinkingLevel ?? "medium",
			streamFn: (_model, context, options) => {
				const stream = new AssistantMessageEventStream();
				const call: Dispatch = { model: pin, background, context, options: options ?? {}, lifecycle };
				calls.push(call);
				if (lifecycle) {
					const scope = { accountId: "fixture-account", epoch: 1, authorityRevision: 1, selectedModelId: pin.id };
					lifecycle.captured(scope);
					if (customize?.admitted === false) lifecycle.noDispatch("background");
					else lifecycle.beforeDispatch(scope);
				}
				if (customize?.produce) customize.produce(stream, call);
				else {
					const m = output(pin);
					stream.push({ type: "start", partial: m });
					stream.push({ type: "done", reason: "toolUse", message: m });
					stream.end();
				}
				return stream;
			},
		}),
	};
	const adapter = createPluginInference({ signal: signal.signal, dataDirectory: directory }, deps);
	t.after(() => signal.abort());
	return { directory, signal, deps, adapter, calls, catalog, removeKey: () => { keyPresent = false; } };
}
const ledger = (directory: string) => existsSync(join(directory, "usage.jsonl")) ? readFileSync(join(directory, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const collect = async (events: AsyncIterable<AssistantMessageEvent>) => { const all = []; for await (const event of events) all.push(event); return all; };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("catalog is the host's client-safe last-known projection, with defaults, slots and role pins", async (t) => {
	const f = fixture(t);
	const catalog = await f.adapter.inference.catalog();
	assert.deepEqual(catalog, f.catalog);
	catalog.models.length = 0;
	assert.equal((await f.adapter.inference.catalog()).models.length, 1);
	assert.equal(f.calls.length, 0);
	assert.deepEqual(readdirSync(f.directory), []);
});

test("complete preserves native tool calls/signatures and appends per-model plugin-local usage only", async (t) => {
	const f = fixture(t);
	const final = await f.adapter.inference.complete(request());
	assert.deepEqual(final, output());
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0]?.background, true);
	assert.equal(f.calls[0]?.options.reasoning, "medium");
	assert(f.calls[0]?.context.messages.some((m) => m.role === "system" && m.content === "Plugin task instructions"));
	assert.deepEqual(readdirSync(f.directory), ["usage.jsonl"]);
	const rows = ledger(f.directory);
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0].model, spec);
	assert.deepEqual(rows[0].usage, usage());
	assert(!readFileSync(join(f.directory, "usage.jsonl"), "utf8").includes("Explicit task"));
	assert(!readFileSync(join(f.directory, "usage.jsonl"), "utf8").includes("native-signature"));
	await f.adapter.inference.complete({ ...request(), purpose: "user" });
	assert.equal(f.calls[1]?.background, false);
	assert.equal(ledger(f.directory).length, 2);
});

test("stream forwards native events without text-only conversion; native error states are returned by complete", async (t) => {
	const events: AssistantMessageEvent[] = [];
	const expected = { ...output(), stopReason: "error" as const, errorMessage: "Native provider quota error" };
	const f = fixture(t, { produce(stream) {
		const start = { type: "start" as const, partial: output() };
		const end = { type: "error" as const, reason: "error" as const, error: structuredClone(expected) };
		events.push(start, end); stream.push(start); stream.push(end); stream.end();
	} });
	const streamed = await collect(f.adapter.inference.stream(request()));
	assert.deepEqual(streamed, events);
	assert.deepEqual(await f.adapter.inference.complete(request()), expected);
	assert.equal(ledger(f.directory).length, 2, "admitted provider errors retain reported usage");
});

test("every model is explicit and available: missing, unknown, removed keys and fallback engines reject", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.adapter.inference.complete({ ...request(), model: undefined as never }), /explicit model/);
	await assert.rejects(f.adapter.engineFor({ provider: "", id: "" }, "user"), /explicit model/);
	await assert.rejects(f.adapter.engineFor({ provider: "unknown", id: spec.id }, "user"), /Unknown model provider/);
	await assert.rejects(f.adapter.engineFor({ provider: spec.provider, id: "missing" }, "background"), /Selected model unavailable/);
	await assert.rejects(f.adapter.engineFor(spec, "automatic" as never), /purpose/);
	await assert.rejects(f.adapter.engineFor({ ...spec, thinkingLevel: "guess" as never }, "user"), /thinkingLevel/);
	const fallback = createPluginInference({ signal: f.signal.signal, dataDirectory: f.directory }, { ...f.deps, engineForSpec: () => ({ model: { provider: "another-provider", id: "another-model" } as never, streamFn: () => { throw new Error("must not run"); } }) });
	await assert.rejects(fallback.engineFor(spec, "user"), /explicitly selected model/);
	f.removeKey();
	await assert.rejects(f.adapter.engineFor(spec, "user"), (error: unknown) => (error as { code?: string }).code === "provider_key_missing");
	assert.equal(f.calls.length, 0);
	assert.deepEqual(ledger(f.directory), []);
});

test("runtime rejects unsupported transport/auth/deferred options and invalid numeric values", async (t) => {
	const f = fixture(t);
	for (const key of ["apiKey", "headers", "signal", "fetch", "env", "onPayload", "onResponse", "onProviderStreamEvent", "samplingParams", "deferred", "transport", "sessionId", "identity", "telemetry"]) {
		await assert.rejects(f.adapter.inference.complete({ ...request(), options: { [key]: "unsupported" } as PluginInferenceOptions }), new RegExp(`Unsupported plugin inference option: ${key}`));
	}
	for (const options of [{ temperature: NaN }, { temperature: -1 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { maxRetries: -1 }, { maxRetries: 0.2 }, { maxRetryDelayMs: -1 }, { thinkingBudgets: { high: -1 } }, { thinkingBudgets: { max: 100 } }, { cacheRetention: "forever" }, { toolChoice: "required" }]) {
		await assert.rejects(f.adapter.inference.complete({ ...request(), options: options as PluginInferenceOptions }), /Invalid/);
	}
	await assert.rejects(f.adapter.inference.complete({ ...request(), options: { reasoning: "high" } }), /model.thinkingLevel/);
	assert.equal(f.calls.length, 0);
});

test("allowed generation settings are forwarded without host sampling defaults; model thinking remains authoritative", async (t) => {
	const f = fixture(t);
	const options: PluginInferenceOptions = { temperature: 0.7, maxTokens: 128, cacheRetention: "none", reasoning: "medium", thinkingBudgets: { medium: 64 }, toolChoice: "none", timeoutMs: 1000, maxRetries: 0, maxRetryDelayMs: 0, metadata: { request: "plugin-task" } };
	await f.adapter.inference.complete({ ...request(), options });
	assert.deepEqual({ ...f.calls[0]?.options, signal: undefined }, { ...options, signal: undefined });
	await f.adapter.inference.complete(request());
	assert.equal(f.calls[1]?.options.temperature, undefined);
	assert.equal(f.calls[1]?.options.maxTokens, undefined);
});

test("ChatGPT/native subscription admission gates denied usage and preserves background policy with no fallback", async (t) => {
	for (const provider of ["chatgpt", "xai-subscription"]) {
		const pin = { ...spec, provider };
		const f = fixture(t, { model: pin, admitted: false, produce(stream) {
			const failure = { ...output(pin), stopReason: "error" as const, errorMessage: "Background consent disabled. No API-key fallback was used." };
			stream.push({ type: "error", reason: "error", error: failure }); stream.end();
		} });
		const final = await f.adapter.inference.complete(request(pin));
		assert.equal(final.stopReason, "error");
		assert.match(final.errorMessage!, /Background consent disabled/);
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0]?.background, true);
		assert.equal(f.calls[0]?.model.provider, provider);
		assert.deepEqual(ledger(f.directory), []);
	}
});

test("managed-agent usage checks original admission identity before cloning (including ChatGPT lifecycle denial)", async (t) => {
	for (const admitted of [false, true]) {
		const pin = { ...spec, provider: "chatgpt" };
		const f = fixture(t, { model: pin, admitted, produce(stream) {
			const failure = { ...output(pin), stopReason: "error" as const, errorMessage: admitted ? "Admitted provider error" : "Denied before dispatch" };
			stream.push({ type: "error", reason: "error", error: failure }); stream.end();
		} });
		const service = createPluginAgentService({ store: createPluginAgentRecordStore(join(f.directory, "agents")), engineFor: f.adapter.engineFor, onUsage: f.adapter.onUsage, signal: f.signal.signal });
		t.after(() => service.dispose());
		service.register({ id: "helper", instructions: "Test", model: pin });
		const { id } = service.create("helper");
		await service.send(id, "Explicit plugin task", { requestId: "one", purpose: "background" });
		await new Promise<void>((resolve, reject) => {
			let unsubscribe: (() => void) | undefined;
			const timeout = setTimeout(() => { unsubscribe?.(); reject(new Error("managed call did not settle")); }, 3000);
			unsubscribe = service.subscribe(id, (s) => { if (s.status !== "running") { clearTimeout(timeout); queueMicrotask(() => { unsubscribe?.(); resolve(); }); } });
		});
		assert.equal(service.get(id).status, "error");
		assert.equal(ledger(f.directory).length, admitted ? 1 : 0);
	}
});

test("activation and caller abort cancel in-flight waits and disable future work without usage writes", async (t) => {
	for (const mode of ["caller", "activation"]) {
		const entered = deferred();
		let transportSignal: AbortSignal | undefined;
		const f = fixture(t, { produce(_stream, call) { transportSignal = call.options.signal; entered.resolve(); /* Deliberately uncooperative producer: no terminal event. */ } });
		const caller = new AbortController();
		const completed = f.adapter.inference.complete({ ...request(), signal: caller.signal });
		await entered.promise;
		if (mode === "caller") caller.abort(); else f.signal.abort();
		const final = await completed;
		assert.equal(final.stopReason, "aborted");
		assert.equal(transportSignal?.aborted, true);
		assert.deepEqual(ledger(f.directory), []);
		if (mode === "activation") {
			await assert.rejects(f.adapter.inference.catalog(), /cancelled or disabled/);
			await assert.rejects(f.adapter.engineFor(spec, "user"), /cancelled or disabled/);
			await assert.rejects(f.adapter.inference.complete(request()), /cancelled or disabled/);
		}
	}
});

test("early stream return aborts its transport, ends native iterator waits and never records partial usage", async (t) => {
	let transportSignal: AbortSignal | undefined;
	const f = fixture(t, { produce(stream, call) { transportSignal = call.options.signal; stream.push({ type: "start", partial: output() }); } });
	for await (const event of f.adapter.inference.stream(request())) { assert.equal(event.type, "start"); break; }
	assert.equal(transportSignal?.aborted, true);
	assert.deepEqual(ledger(f.directory), []);
	await tick();
});

test("activation abort closes an SDK source even while the plugin is paused between iterator pulls", async (t) => {
	let native: AssistantMessageEventStream | undefined;
	const f = fixture(t, { produce(stream) { native = stream; stream.push({ type: "start", partial: output() }); } });
	const iterator = f.adapter.inference.stream(request())[Symbol.asyncIterator]();
	assert.equal((await iterator.next()).value?.type, "start");
	f.signal.abort();
	assert.equal((await native!.result()).stopReason, "aborted", "native result wait is settled without another plugin pull");
	native!.push({ type: "done", reason: "toolUse", message: output() });
	assert.equal((await native!.result()).stopReason, "aborted", "late producer output cannot revive a cancelled source");
	await iterator.return?.();
	assert.deepEqual(ledger(f.directory), []);
});

test("managed engines do not forward Agent transport callbacks, credentials, or caching session identity", async (t) => {
	const f = fixture(t);
	const engine = await f.adapter.engineFor(spec, "user");
	const privateOptions = { apiKey: "secret-not-forwarded", headers: { Authorization: "secret-not-forwarded" }, sessionId: "not-a-plugin-session", fetch: () => { throw new Error("must not be invoked"); }, onPayload: () => { throw new Error("must not be invoked"); }, maxTokens: 64 };
	await collect(engine.streamFn(engine.model, normalizeContext({ messages: [] }), privateOptions as never));
	assert.equal(f.calls[0]?.options.maxTokens, 64);
	for (const key of ["apiKey", "headers", "sessionId", "fetch", "onPayload"]) assert(!(key in f.calls[0]!.options));
	assert.equal(ledger(f.directory).length, 0, "managed engine usage is written only by its host callback");
});

test("held managed engines inherit activation cancellation and revalidate provider availability at dispatch", async (t) => {
	const f = fixture(t);
	const engine = await f.adapter.engineFor(spec, "background");
	f.removeKey();
	const denied = await collect(engine.streamFn(engine.model, normalizeContext({ messages: [] }), {}));
	assert.equal(denied.at(-1)?.type, "error");
	assert.equal(f.calls.length, 0);
	f.signal.abort();
	const cancelled = await collect(engine.streamFn(engine.model, normalizeContext({ messages: [] }), {}));
	assert.equal(cancelled.at(-1)?.type, "error");
	assert.equal((cancelled.at(-1) as { error: AssistantMessage }).error.stopReason, "aborted");
	f.adapter.onUsage(spec, usage());
	assert.deepEqual(ledger(f.directory), []);
});

test("dispatch-time host refusals retain safe Error.message while cancellation remains explicitly aborted", async (t) => {
	const f = fixture(t);
	const engine = await f.adapter.engineFor(spec, "user");
	f.removeKey();
	const refused = await collect(engine.streamFn(engine.model, normalizeContext({ messages: [] }), {}));
	assert.match((refused.at(-1) as { error: AssistantMessage }).error.errorMessage!, /key is set.*Settings/);
	for (const thrown of [new Error("Selected connection disconnected mid-run; reconnect explicitly"), "opaque non-Error refusal"]) {
		const adapter = createPluginInference({ signal: f.signal.signal, dataDirectory: f.directory }, {
			...f.deps, providerKeyPresent: () => true,
			engineForSpec(model, background, lifecycle) {
				if (lifecycle) throw thrown;
				return f.deps.engineForSpec(model, background);
			},
		});
		const held = await adapter.engineFor(spec, "user");
		const events = await collect(held.streamFn(held.model, normalizeContext({ messages: [] }), {}));
		const final = (events.at(-1) as { error: AssistantMessage }).error;
		assert.equal(final.stopReason, "error");
		assert.equal(final.errorMessage, thrown instanceof Error ? thrown.message : "Plugin inference transport failed or ended without a terminal response");
	}
	f.signal.abort();
	const aborted = await collect(engine.streamFn(engine.model, normalizeContext({ messages: [] }), {}));
	assert.equal((aborted.at(-1) as { error: AssistantMessage }).error.stopReason, "aborted");
	assert.equal((aborted.at(-1) as { error: AssistantMessage }).error.errorMessage, "Plugin inference cancelled or disabled");
	await assert.rejects(f.adapter.engineFor(spec, "user"), (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("native SDK Agent executes a tool batch then continues through PluginStream.result without losing admitted usage identity", { timeout: 3000 }, async (t) => {
	const nativeUsage: AssistantMessage["usage"][] = [];
	const f = fixture(t, { produce(stream, call) {
		const m = call.context.messages.some((message) => message.role === "toolResult")
			? { ...output(), stopReason: "stop" as const, content: [{ type: "text" as const, text: "Tool result received", textSignature: "final-native-signature" }] }
			: output();
		nativeUsage.push(m.usage);
		stream.push({ type: "start", partial: m });
		stream.push({ type: "done", reason: m.stopReason as "toolUse" | "stop", message: m }); stream.end();
	} });
	const engine = await f.adapter.engineFor(spec, "user");
	let executions = 0;
	const agent = new Agent({ streamFn: engine.streamFn, initialState: { model: engine.model, thinkingLevel: engine.level, systemPrompt: "SDK loop fixture", tools: [{
		name: "plugin_tool", label: "Fixture", description: "Test native tool execution", parameters: Type.Object({ task: Type.String() }),
		execute: async (id, input) => { executions++; assert.equal(id, "native-call"); assert.deepEqual(input, { task: "native arguments" }); return { content: [{ type: "text", text: "Native tool completed" }], details: {} }; },
	}] } });
	let observations = 0;
	agent.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		assert.equal(event.message.usage, nativeUsage[observations], "SDK result retains the original usage object");
		assert(usageWasAdmitted(event.message.usage));
		f.adapter.onUsage(spec, event.message.usage); observations++;
	});
	await agent.prompt("Explicit SDK task");
	await agent.waitForIdle();
	assert.equal(executions, 1);
	assert.equal(observations, 2);
	assert.equal(f.calls.length, 2);
	assert(f.calls[1]?.context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "native-call"));
	const assistants = agent.state.messages.filter((message) => message.role === "assistant");
	assert.deepEqual(assistants[0]?.content, output().content, "native tool call and signatures survive SDK round trip");
	assert.equal(assistants.at(-1)?.stopReason, "stop");
	assert.equal(ledger(f.directory).length, 2);
});

test("SDK subscription tool continuation preserves original admitted and denied usage identities independently", { timeout: 3000 }, async (t) => {
	const pin = { ...spec, provider: "chatgpt" };
	const nativeUsage: AssistantMessage["usage"][] = [];
	const f = fixture(t, { model: pin, admitted: false, produce(stream, call) {
		const continuation = call.context.messages.some((message) => message.role === "toolResult");
		if (!continuation) call.lifecycle!.beforeDispatch({ accountId: "fixture-account", epoch: 1, authorityRevision: 1, selectedModelId: pin.id });
		const m = continuation ? { ...output(pin), stopReason: "error" as const, errorMessage: "Background consent revoked before continuation" } : output(pin);
		nativeUsage.push(m.usage);
		if (continuation) stream.push({ type: "error", reason: "error", error: m });
		else { stream.push({ type: "start", partial: m }); stream.push({ type: "done", reason: "toolUse", message: m }); }
		stream.end();
	} });
	const engine = await f.adapter.engineFor(pin, "background");
	const agent = new Agent({ streamFn: engine.streamFn, initialState: { model: engine.model, thinkingLevel: engine.level, tools: [{ name: "plugin_tool", label: "Fixture", description: "Fixture", parameters: Type.Object({ task: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "Completed" }], details: {} }) }] } });
	let observed = 0;
	agent.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		assert.equal(event.message.usage, nativeUsage[observed]);
		assert.equal(usageWasAdmitted(event.message.usage), observed === 0);
		f.adapter.onUsage(pin, event.message.usage); observed++;
	});
	await agent.prompt("Explicit background task");
	assert.equal(observed, 2);
	assert.equal(f.calls.length, 2);
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
	assert.equal((agent.state.messages.at(-1) as AssistantMessage).errorMessage, "Background consent revoked before continuation");
	assert.equal(ledger(f.directory).length, 1, "denied continuation never becomes a billed line");
});

test("managed accounting write failures are visible without logging request content; onUsage itself throws", { timeout: 3000 }, async (t) => {
	const f = fixture(t, { produce(stream) {
		const m = { ...output(), stopReason: "stop" as const, content: [{ type: "text" as const, text: "Native success" }] };
		stream.push({ type: "start", partial: m }); stream.push({ type: "done", reason: "stop", message: m }); stream.end();
	} });
	const blocked = join(f.directory, "not-a-directory"); writeFileSync(blocked, "fixture");
	const broken = createPluginInference({ signal: f.signal.signal, dataDirectory: blocked }, f.deps);
	assert.throws(() => broken.onUsage(spec, usage()), /EEXIST|ENOTDIR/);
	const errors = t.mock.method(console, "error", () => {});
	const service = createPluginAgentService({ store: createPluginAgentRecordStore(join(f.directory, "agents")), engineFor: broken.engineFor, onUsage: broken.onUsage });
	t.after(() => service.dispose());
	service.register({ id: "helper", instructions: "Fixture", model: spec });
	const { id } = service.create("helper");
	await service.send(id, "Private plugin request contents", { requestId: "one" });
	await new Promise<void>((resolve) => {
		let unsubscribe: (() => void) | undefined;
		unsubscribe = service.subscribe(id, (snapshot) => { if (snapshot.status !== "running") queueMicrotask(() => { unsubscribe?.(); resolve(); }); });
	});
	assert.equal(service.get(id).status, "idle", "accounting failure does not erase an already committed native response");
	assert.equal(errors.mock.callCount(), 1);
	assert.deepEqual(errors.mock.calls[0]?.arguments, ["[plugin-agents] Plugin accounting failure", { definitionId: "helper", sessionId: id }]);
	assert(!JSON.stringify(errors.mock.calls).includes("Private plugin request contents"));
	assert(!existsSync(join(f.directory, "usage.jsonl")));
});

test("incomplete transport streams become explicit errors; usage persistence failures are not reported as success", async (t) => {
	const f = fixture(t, { produce(stream) { stream.push({ type: "start", partial: output() }); stream.end(); } });
	assert.equal((await f.adapter.inference.complete(request())).stopReason, "error");
	const g = fixture(t);
	writeFileSync(join(g.directory, "usage.jsonl"), "existing ledger\n");
	// A directory supplied where a file is required fails writes without invoking
	// any real host storage or relying on platform permission behavior.
	const blocked = join(g.directory, "not-a-directory"); writeFileSync(blocked, "fixture");
	const broken = createPluginInference({ signal: g.signal.signal, dataDirectory: blocked }, g.deps);
	await assert.rejects(broken.inference.complete(request()), /EEXIST|ENOTDIR/);
	assert.equal(readFileSync(join(g.directory, "usage.jsonl"), "utf8"), "existing ledger\n");
});

test("bound worker generation options survive every native runner turn without leaking transport identity or changing purpose", async t => {
	const f = fixture(t, { produce(stream, dispatched) {
		const m = f.calls.length === 1 ? output(dispatched.model) : { ...output(dispatched.model), stopReason: "stop" as const, content: [{ type: "text" as const, text: "Finished" }] };
		stream.push({ type: "done", reason: m.stopReason as "toolUse" | "stop", message: m }); stream.end();
	} });
	const bound: PluginInferenceOptions = { temperature: 0.3, maxTokens: 77, cacheRetention: "long", maxRetries: 0, metadata: { tag: "original" } };
	const engine = await f.adapter.engineFor(spec, "background", bound);
	bound.maxTokens = 999; bound.metadata!.tag = "mutated";
	const result = await runSubagent([{ name: "plugin_tool", label: "Fixture", description: "Fixture", parameters: Type.Object({ task: Type.String() }), execute: async () => ({ content: [], details: null }) }], {
		engine, prompt: "Explicit task", systemPrompt: "Use the tool then finish", maxTurns: 3,
		onUsage: value => { assert(usageWasAdmitted(value)); f.adapter.onUsage(spec, value); },
	});
	assert.equal(result.text, "Finished"); assert.equal(f.calls.length, 2); assert.equal(ledger(f.directory).length, 2);
	for (const call of f.calls) {
		assert.equal(call.background, true); assert.equal(call.options.temperature, 0.3); assert.equal(call.options.maxTokens, 77); assert.equal(call.options.cacheRetention, "long");
		assert.deepEqual(call.options.metadata, { tag: "original" }); assert.equal(call.options.reasoning, "medium"); assert.equal(call.options.maxRetries, 0);
		assert.equal(call.options.apiKey, undefined); assert.equal(call.options.headers, undefined); assert.equal(call.options.sessionId, undefined); assert(call.options.signal instanceof AbortSignal);
	}
});

test("engine option binding rejects unsupported transport fields and reasoning overrides before dispatch", async t => {
	const f = fixture(t);
	for (const invalid of [{ apiKey: "secret" }, { signal: new AbortController().signal }, { sessionId: "foreign" }, { temperature: NaN }]) {
		await assert.rejects(f.adapter.engineFor(spec, "user", invalid as never), /Unsupported|Invalid/);
	}
	await assert.rejects(f.adapter.engineFor(spec, "user", { reasoning: "high" }), /thinkingLevel/);
	assert.equal(f.calls.length, 0);
});

test("Claude Code explicit pins retain host availability gating without forwarding private session or auth options", async t => {
	const pin = { provider: "claude-code", id: "sonnet", thinkingLevel: "medium" } as const;
	const f = fixture(t, { model: pin });
	const final = await f.adapter.inference.complete({ ...request(pin), purpose: "user" });
	assert.equal(final.provider, pin.provider); assert.equal(final.model, pin.id); assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0]!.background, false);
	assert.equal(f.calls[0]!.options.apiKey, undefined); assert.equal(f.calls[0]!.options.sessionId, undefined);
	f.removeKey();
	await assert.rejects(f.adapter.inference.complete(request(pin)), /Claude Code is unavailable.*Settings/);
	assert.equal(f.calls.length, 1, "unavailable CLI never dispatches or falls back to an API provider");
});
