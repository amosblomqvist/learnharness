import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, JsonObject, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createPluginAgentService, type PluginAgentServiceDeps } from "../src/agent/plugin-agents.ts";
import { createPluginAgentRecordStore } from "../src/store/plugin-agent-records.ts";
import type { PluginAgentDefinition, PluginAgentRecord, PluginAgentService, PluginAgentSnapshot, PluginCallPurpose } from "../src/core/plugin-agents.ts";
import type { PiEngine } from "../src/agent/models.ts";

const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const spec = { provider: "fixture", id: "fixture-model" };
const output = (content: AssistantMessage["content"] = [{ type: "text", text: "Done" }], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant", api: "fixture" as never, provider: "fixture", model: "fixture-model", content, usage,
	stopReason, timestamp: 42,
});
const call = (id: string, name: string, args: JsonObject = {}) => ({ type: "toolCall" as const, id, name, arguments: args });
const result = { content: [{ type: "text" as const, text: "server result" }], details: { completed: true } };
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
type Script = AssistantMessage | ((context: TranscriptContext, stream: AssistantMessageEventStream) => AssistantMessage | Promise<AssistantMessage>);
function scripted(scripts: Script[]) {
	const contexts: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: { api: "fixture", provider: "fixture", id: "fixture-model", contextWindow: 8192, maxTokens: 1024 } as never,
		streamFn: (_model, context) => {
			contexts.push(structuredClone(context));
			const stream = new AssistantMessageEventStream();
			const script = scripts.shift();
			assert(script, "unexpected provider request");
			void Promise.resolve().then(async () => {
				const m = typeof script === "function" ? await script(context, stream) : script;
				stream.push({ type: "start", partial: m });
				if (m.stopReason === "error" || m.stopReason === "aborted") stream.push({ type: "error", reason: m.stopReason, error: m });
				else { assert.notEqual(m.stopReason, "pending"); stream.push({ type: "done", reason: m.stopReason as "stop" | "length" | "toolUse" | "deferred", message: m }); }
				stream.end();
			});
			return stream;
		},
	};
	return { engine, contexts };
}
function fixture(t: TestContext, scripts: Script[], extra: Partial<PluginAgentServiceDeps> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "lh-plugin-agent-test-"));
	const store = createPluginAgentRecordStore(join(directory, "agents"));
	const fake = scripted(scripts);
	const purposes: PluginCallPurpose[] = [];
	const deps: PluginAgentServiceDeps = { store, engineFor: (_model, purpose) => { purposes.push(purpose); return fake.engine; }, ...extra };
	const service = createPluginAgentService(deps);
	t.after(async () => { await service.dispose().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });
	const definition: PluginAgentDefinition = { id: "helper", instructions: "Fixture instructions", model: spec };
	return { directory, store, service, deps, definition, purposes, ...fake };
}
function waitFor(service: PluginAgentService, id: string, predicate: (s: PluginAgentSnapshot) => boolean): Promise<PluginAgentSnapshot> {
	return new Promise((resolve, reject) => {
		let detach: (() => void) | undefined;
		const timeout = setTimeout(() => { detach?.(); reject(new Error(`Timed out: ${JSON.stringify(service.get(id))}`)); }, 3000);
		detach = service.subscribe(id, (s) => {
			if (!predicate(s)) return;
			clearTimeout(timeout);
			queueMicrotask(() => { detach?.(); resolve(s); });
		});
	});
}
const settled = (service: PluginAgentService, id: string) => waitFor(service, id, (s) => s.status !== "running");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("send launches server-owned work promptly, preserves native content, deduplicates and detaches views", async (t) => {
	const gate = deferred();
	const native = output([{ type: "thinking", thinking: "private", thinkingSignature: "provider-signature" }, { type: "text", text: "Done", textSignature: "native-text" }]);
	let billed = 0;
	const f = fixture(t, [async () => { await gate.promise; return native; }], { onUsage: (_model, u) => { billed += u.totalTokens; } });
	f.service.register(f.definition);
	const { id } = f.service.create("helper");
	await assert.rejects(f.service.run(id, { requestId: "empty" }), /send.*explicitPrompt/);
	const accepted = await f.service.send(id, "Plugin-authored task", { requestId: "one", purpose: "background" });
	assert.equal(accepted.status, "running");
	assert.equal(f.store.get(id)?.messages[0]?.role, "user");
	assert.equal((await f.service.send(id, "retry", { requestId: "one" })).messages.length, 1);
	await assert.rejects(f.service.send(id, "concurrent", { requestId: "two" }), /busy/);
	let views = 0;
	const detach = f.service.subscribe(id, (s) => { views++; s.messages.length = 0; });
	detach();
	gate.resolve();
	const final = await settled(f.service, id);
	assert.equal(final.status, "idle");
	assert.deepEqual(final.messages.at(-1), native);
	assert.deepEqual(f.store.get(id)?.messages.at(-1), native);
	assert.equal(views, 1);
	assert.equal(billed, 3);
	assert.deepEqual(f.purposes, ["background"]);
	assert.equal(f.contexts.length, 1);
	await assert.rejects(f.service.run(id, { requestId: "assistant-tail" }), /send.*explicitPrompt/);
});

test("mixed/multiple input calls persist no placeholders and wait for every validated answer", async (t) => {
	let calls = 0;
	const f = fixture(t, [output([call("ask_a", "ask"), call("side", "side"), call("ask_b", "ask")], "toolUse"), output()]);
	f.service.register({ ...f.definition, tools: [
		{ name: "ask", kind: "input", description: "Ask", parameters: Type.Object({}), resultSchema: Type.Object({ answer: Type.String() }) },
		{ name: "side", description: "Side effect", parameters: Type.Object({}), execute: async () => { calls++; return result; } },
	] });
	const { id } = f.service.create("helper");
	await f.service.send(id, "Start", { requestId: "start" });
	const waiting = await settled(f.service, id);
	assert.equal(waiting.status, "waiting");
	assert.deepEqual(waiting.pending.map((p) => p.toolCallId), ["ask_a", "ask_b"]);
	assert.equal(waiting.messages.filter((m) => m.role === "toolResult").length, 1);
	assert.equal(calls, 1);
	assert.equal(f.contexts.length, 1);
	await assert.rejects(f.service.answer(id, "ask_b", { answer: 1 }, { requestId: "bad" }), /Invalid answer/);
	assert(!f.service.get(id).acceptedInputs.includes("bad"));
	await assert.rejects(f.service.send(id, "Skip", { requestId: "skip" }), /pending/);
	await assert.rejects(f.service.run(id, { requestId: "resume" }), /pending/);
	await f.service.answer(id, "ask_b", { answer: "B" }, { requestId: "b" });
	assert.equal(f.service.get(id).status, "waiting");
	assert.equal(f.contexts.length, 1);
	await f.service.answer(id, "ask_b", { answer: "retry" }, { requestId: "b" });
	await f.service.answer(id, "ask_a", { answer: "A" }, { requestId: "a" });
	const final = await settled(f.service, id);
	assert.equal(final.status, "idle");
	assert.equal(f.contexts.length, 2);
	const tools = f.contexts[1]!.messages.filter((m) => m.role === "toolResult");
	assert.deepEqual(tools.map((m) => m.toolCallId), ["ask_a", "side", "ask_b"]);
	assert.match(JSON.stringify(tools), /answer/);
	assert.deepEqual(final.pending, []);
});

test("input authoring errors never become pending and provider errors persist verbatim", async (t) => {
	const failure = { ...output([], "error"), errorMessage: "fixture provider denied request" };
	const f = fixture(t, [output([call("invalid", "ask", { number: "wrong" }), call("throws", "broken")], "toolUse"), failure]);
	f.service.register({ ...f.definition, tools: [
		{ name: "ask", kind: "input", description: "Ask", parameters: Type.Object({ number: Type.Number() }) },
		{ name: "broken", description: "Failure", parameters: Type.Object({}), execute: async () => { throw new Error("fixture tool failed"); } },
	] });
	const { id } = f.service.create("helper");
	await f.service.send(id, "Go", { requestId: "start" });
	const final = await settled(f.service, id);
	assert.equal(final.status, "error");
	assert.match(final.error!, /fixture provider denied/);
	assert.equal(final.pending.length, 0);
	assert.equal(final.messages.filter((m) => m.role === "toolResult" && m.isError).length, 2);
	assert.deepEqual(final.messages.at(-1), failure);
	assert.equal(f.contexts.length, 2);
});

test("successful endRun stops mixed ordinary batches, failed endRun does not", async (t) => {
	for (const failed of [false, true]) {
		const f = fixture(t, [output([call("end", "end"), call("ordinary", "ordinary")], "toolUse"), output()]);
		f.service.register({ ...f.definition, tools: [
			{ name: "end", description: "End", endRun: true, parameters: Type.Object({}), execute: async () => { if (failed) throw new Error("failed"); return result; } },
			{ name: "ordinary", description: "Ordinary", parameters: Type.Object({}), execute: async () => result },
		] });
		const { id } = f.service.create("helper");
		await f.service.send(id, "Go", { requestId: "start" });
		assert.equal((await settled(f.service, id)).status, "idle");
		assert.equal(f.contexts.length, failed ? 2 : 1);
	}
});

test("maxTurns bounds ordinary tool continuation without replacing the native loop", async (t) => {
	const f = fixture(t, [output([call("one", "ordinary")], "toolUse")]);
	f.service.register({ ...f.definition, maxTurns: 1, tools: [{ name: "ordinary", description: "Ordinary", parameters: Type.Object({}), execute: async () => result }] });
	const { id } = f.service.create("helper");
	await f.service.send(id, "Go", { requestId: "start" });
	assert.equal((await settled(f.service, id)).status, "idle");
	assert.equal(f.contexts.length, 1);
});

test("calls are persisted before side effects and completed siblings checkpoint before the batch ends", async (t) => {
	const gate = deferred();
	const entered = deferred();
	let executions = 0;
	const f = fixture(t, [output([call("quick", "quick"), call("slow", "slow")], "toolUse")]);
	f.service.register({ ...f.definition, tools: [
		{ name: "quick", description: "Quick", parameters: Type.Object({}), execute: async () => {
			executions++;
			const record = f.store.list()[0]!;
			assert.equal(record.status, "running");
			assert.equal(record.messages.at(-1)?.role, "assistant");
			return result;
		} },
		{ name: "slow", description: "Slow", parameters: Type.Object({}), execute: async (_id, _args, signal) => {
			executions++; entered.resolve(); await gate.promise; assert(signal?.aborted); return result;
		} },
	] });
	const { id } = f.service.create("helper");
	await f.service.send(id, "Go", { requestId: "start" });
	await entered.promise;
	await waitFor(f.service, id, (s) => s.messages.some((m) => m.role === "toolResult" && m.toolCallId === "quick"));
	await f.service.dispose();
	const before = f.store.get(id)!;
	assert.equal(before.status, "interrupted");
	gate.resolve(); await tick(); await tick();
	assert.deepEqual(f.store.get(id), before, "no late writes from a cancelled tool");
	const next = scripted([output()]);
	const restarted = createPluginAgentService({ store: f.store, engineFor: () => next.engine });
	t.after(() => restarted.dispose());
	restarted.register({ ...f.definition, tools: [] });
	await assert.rejects(restarted.run(id, { requestId: "unsafe" }), /Unresolved tool calls/);
	assert(!restarted.get(id).acceptedInputs.includes("unsafe"));
	await restarted.send(id, "Explicit plugin recovery task", { requestId: "recovery", purpose: "background" });
	await settled(restarted, id);
	assert.equal(executions, 2);
	assert(!JSON.stringify(next.contexts[0]).includes('"toolCall"'), "incomplete old batch omitted only from model context");
	assert(restarted.get(id).messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall")), "native history retained");
});

test("restart interrupts RUNNING records without rerunning tools; waiting inputs and missing definitions retain history", async (t) => {
	const f = fixture(t, [output([call("ask", "ask")], "toolUse")]);
	const d = { ...f.definition, tools: [{ name: "ask", kind: "input" as const, description: "Ask", parameters: Type.Object({}), resultSchema: Type.String() }] };
	f.service.register(d);
	const { id } = f.service.create("helper");
	await f.service.send(id, "Go", { requestId: "start" });
	await settled(f.service, id);
	await f.service.dispose();
	const saved = f.store.get(id)!;
	const running: PluginAgentRecord = { ...saved, id: "crashed", status: "running" };
	f.store.save(running);
	const next = scripted([output()]);
	const restarted = createPluginAgentService({ store: f.store, engineFor: () => next.engine });
	t.after(() => restarted.dispose());
	assert.equal(restarted.get("crashed").status, "interrupted");
	assert.equal(restarted.get("crashed").pending.length, 1);
	assert.deepEqual(restarted.get(id), saved);
	await assert.rejects(restarted.answer(id, "ask", "answer", { requestId: "answer" }), /definition unavailable/);
	assert.deepEqual(f.store.get(id), saved);
	restarted.register(d);
	await restarted.answer(id, "ask", "answer", { requestId: "answer" });
	assert.equal((await settled(restarted, id)).status, "idle");
	assert.equal(next.contexts.length, 1);
});

test("persistence failure rejects acceptance and prevents inference and false accepted identities", async (t) => {
	const f = fixture(t, []);
	let fail = false;
	const service = createPluginAgentService({ ...f.deps, store: { ...f.store, save(record) { if (fail) throw new Error("fixture disk full"); f.store.save(record); } } });
	t.after(() => service.dispose().catch(() => {}));
	service.register(f.definition);
	const { id } = service.create("helper");
	fail = true;
	await assert.rejects(service.send(id, "Go", { requestId: "rejected" }), /persistence failed/);
	assert.equal(f.contexts.length, 0);
	assert.deepEqual(f.store.get(id)?.acceptedInputs, []);
	assert.deepEqual(service.get(id).acceptedInputs, []);
	assert.equal(service.get(id).status, "error");
	await assert.rejects(service.send(id, "Retry", { requestId: "another" }), /persistence failed/);
});

test("assistant persistence barrier fails closed before side effects", async (t) => {
	const f = fixture(t, [output([call("side", "side")], "toolUse")]);
	let sideEffects = 0;
	const service = createPluginAgentService({ ...f.deps, store: { ...f.store, save(record) {
		if (record.messages.some((m) => m.role === "assistant")) throw new Error("fixture checkpoint failure");
		f.store.save(record);
	} } });
	t.after(() => service.dispose().catch(() => {}));
	service.register({ ...f.definition, tools: [{ name: "side", description: "Side", parameters: Type.Object({}), execute: async () => { sideEffects++; return result; } }] });
	const { id } = service.create("helper");
	await service.send(id, "Go", { requestId: "start" });
	const final = await settled(service, id);
	assert.equal(final.status, "error");
	assert.match(final.error!, /persistence failed/);
	assert.equal(sideEffects, 0);
	assert.equal(f.store.get(id)?.messages.length, 1);
});

test("tool completion checkpoint failure prevents another provider request", async (t) => {
	const f = fixture(t, [output([call("side", "side")], "toolUse")]);
	let sideEffects = 0;
	const service = createPluginAgentService({ ...f.deps, store: { ...f.store, save(record) {
		if (record.messages.some((m) => m.role === "toolResult")) throw new Error("fixture result write failed");
		f.store.save(record);
	} } });
	t.after(() => service.dispose().catch(() => {}));
	service.register({ ...f.definition, tools: [{ name: "side", description: "Side", parameters: Type.Object({}), execute: async () => { sideEffects++; return result; } }] });
	const { id } = service.create("helper");
	await service.send(id, "Go", { requestId: "start" });
	assert.equal((await settled(service, id)).status, "error");
	assert.equal(sideEffects, 1);
	assert.equal(f.contexts.length, 1);
	assert.equal(f.store.get(id)?.messages.at(-1)?.role, "assistant");
});

test("unregister, activation cancellation, and delayed engine disposal cannot launch late work", async (t) => {
	for (const mode of ["unregister", "signal", "dispose"] as const) {
		const gate = deferred<PiEngine>();
		const signal = new AbortController();
		const f = fixture(t, [], { signal: signal.signal, engineFor: () => gate.promise });
		const unregister = f.service.register(f.definition);
		const { id } = f.service.create("helper");
		await f.service.send(id, "Go", { requestId: "start" });
		if (mode === "unregister") unregister();
		else if (mode === "signal") signal.abort();
		else await f.service.dispose();
		const before = f.store.get(id);
		assert.equal(before?.status, "interrupted");
		gate.resolve(f.engine); await tick(); await tick();
		assert.deepEqual(f.store.get(id), before);
		assert.equal(f.contexts.length, 0);
		if (mode !== "unregister") assert.throws(() => f.service.create("helper"), /unavailable/);
	}
});

test("run retries existing persisted user input, but never invents a task", async (t) => {
	const f = fixture(t, []);
	f.service.register(f.definition);
	const created = f.service.create("helper");
	f.store.save({ ...created, status: "running", messages: [{ role: "user", content: "Persisted task before crash", timestamp: 1 }], acceptedInputs: ["old"] });
	await f.service.dispose();
	const next = scripted([output()]);
	const service = createPluginAgentService({ store: f.store, engineFor: () => next.engine });
	t.after(() => service.dispose());
	service.register(f.definition);
	assert.equal(service.get(created.id).status, "interrupted");
	assert.equal((await service.run(created.id, { requestId: "retry" })).status, "running");
	await settled(service, created.id);
	const users = next.contexts[0]!.messages.filter((m) => m.role === "user");
	assert.equal(users.length, 1);
	assert.equal(users[0]?.content, "Persisted task before crash");
});

test("stream observation stores one current partial, coalesces updates, and reattaches snapshot-first", async (t) => {
	const gate = deferred();
	const streamed = deferred();
	const f = fixture(t, [async (_context, stream) => {
		const partial = output([{ type: "text", text: "" }]);
		stream.push({ type: "start", partial });
		for (let i = 0; i < 2000; i++) {
			const next = { ...partial, content: [{ type: "text" as const, text: "x".repeat(i + 1) }] };
			stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: next });
		}
		streamed.resolve(); await gate.promise;
		return output([{ type: "text", text: "x".repeat(2000) }]);
	}]);
	f.service.register(f.definition);
	const { id } = f.service.create("helper");
	let observations = 0;
	const detach = f.service.subscribe(id, () => { observations++; });
	await f.service.send(id, "Go", { requestId: "start" });
	await streamed.promise;
	await tick();
	assert.equal((f.service.get(id).partial?.content[0] as { text: string }).text.length, 2000);
	let reattached: PluginAgentSnapshot | undefined;
	const detachAgain = f.service.subscribe(id, (s) => { reattached = s; });
	assert.equal((reattached?.partial?.content[0] as { text: string }).text.length, 2000);
	assert(observations < 10, `not a chunk log: ${observations}`);
	detach(); detachAgain(); gate.resolve();
	const final = await settled(f.service, id);
	assert.equal(final.partial, undefined);
	assert.equal(final.messages.length, 2);
});

test("registration rejects executable input tools and input endRun rather than silently ignoring author code", async (t) => {
	const f = fixture(t, []);
	let executions = 0;
	const input = { name: "ask", kind: "input", description: "Declarative input", parameters: Type.Object({}) };
	assert.throws(() => f.service.register({ ...f.definition, tools: [{ ...input, execute: async () => { executions++; return result; } }] } as unknown as PluginAgentDefinition), /Input tools are declarative; execute is not allowed/);
	assert.throws(() => f.service.register({ ...f.definition, tools: [{ ...input, endRun: false }] } as unknown as PluginAgentDefinition), /Input tools always pause; endRun is not allowed/);
	assert.throws(() => f.service.register({ ...f.definition, tools: [{ name: "server", description: "Requires execute", parameters: Type.Object({}) }] } as unknown as PluginAgentDefinition), /Missing execute for server tool/);
	assert.equal(executions, 0);
	assert.equal(f.contexts.length, 0);
	assert.deepEqual(f.store.list(), []);
	f.service.register({ ...f.definition, tools: [{ ...input, kind: "input" }] });
	assert.equal(f.service.create("helper").status, "idle", "failed registration does not reserve the definition ID");
});

test("identifier guards cover operations and store paths; corrupt records fail visibly", async (t) => {
	const f = fixture(t, []);
	f.service.register(f.definition);
	const { id } = f.service.create("helper");
	for (const invalid of ["../escape", "", "a/b", "a.b", "x".repeat(129)]) {
		assert.throws(() => f.service.create(invalid), /Invalid/);
		assert.throws(() => f.service.get(invalid), /Invalid/);
		assert.throws(() => f.service.abort(invalid), /Invalid/);
		assert.throws(() => f.service.subscribe(invalid, () => {}), /Invalid/);
		assert.throws(() => f.service.register({ ...f.definition, id: invalid }), /Invalid/);
		await assert.rejects(f.service.send(invalid, "Go", { requestId: "x" }), /Invalid/);
		await assert.rejects(f.service.run(invalid, { requestId: "x" }), /Invalid/);
		await assert.rejects(f.service.answer(invalid, "call", "answer", { requestId: "x" }), /Invalid/);
		await assert.rejects(f.service.send(id, "Go", { requestId: invalid }), /Invalid/);
		assert.throws(() => f.store.get(invalid), /Invalid/);
	}
	assert.deepEqual(readdirSync(join(f.directory, "agents")), [`${id}.json`]);
	const saved = readFileSync(join(f.directory, "agents", `${id}.json`), "utf8");
	writeFileSync(join(f.directory, "agents", `${id}.json`), "{broken");
	assert.throws(() => f.store.list(), /Unable to read/);
	writeFileSync(join(f.directory, "agents", `${id}.json`), saved);
});
