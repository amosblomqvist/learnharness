import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createPluginWorkerService } from "../src/agent/plugin-workers.ts";
import { createPluginTaskRecordStore } from "../src/store/plugin-task-records.ts";
import { createPluginBackgroundTool, recoverPluginBackgroundJob } from "../src/server/plugin-background-tools.ts";
import { buildAbortSteer, buildSubagentSteer, isSubagentFailure, type JobRecord, type SteerMessage } from "../src/core/contracts/jobs.ts";
import type { JobStore } from "../src/core/ports.ts";
import { createJobRunner } from "../src/agent/subagents/runner.ts";
import { abortJob, deliverJobResult, recoverStaleJobs, registerLiveAgent, setJobRespawn, setPluginJobRecovery, setTurnRunner, settleSteers, unregisterLiveAgent } from "../src/server/jobs.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore as diskJobs } from "../src/store/jobs.ts";
import type { PluginBackgroundResult, PluginBackgroundTool, PluginTaskOutcome, PluginTaskRecord, PluginWorkerService } from "../src/core/plugin-workers.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function memoryJobs(): JobStore {
	const jobs = new Map<string, JobRecord>();
	return {
		createJob(init) { const job: JobRecord = { ...structuredClone(init), id: `job_${jobs.size}`, status: "running", activity: init.activity ?? "starting", createdAt: "now", updatedAt: "now" }; jobs.set(job.id, job); return structuredClone(job); },
		getJob(id) { return structuredClone(jobs.get(id) ?? null); },
		updateJob(id, patch) { const job = jobs.get(id); if (!job) return null; jobs.set(id, { ...job, ...structuredClone(patch) }); return this.getJob(id); },
		listJobs(chatId) { return [...jobs.values()].filter((job) => job.chatId === chatId).map((job) => structuredClone(job)); },
		findJobByToolCallId(chatId, toolCallId) { return this.listJobs(chatId).find((job) => job.toolCallId === toolCallId) ?? null; },
		deleteJobsForChat(chatId) { const list = this.listJobs(chatId); for (const job of list) jobs.delete(job.id); return list.length; },
	};
}
const schema = Type.Object({ query: Type.String() });
function harness(overrides: Partial<PluginBackgroundTool<typeof schema>> = {}) {
	const jobStore = memoryJobs();
	const active = new AbortController();
	const aborts = new Map<string, AbortController>();
	const deliveries: SteerMessage[] = [];
	const released = deferred<void>();
	let prepareCalls = 0, starts = 0, formats = 0;
	let task: PluginTaskRecord;
	const listeners = new Set<(task: PluginTaskRecord) => void>();
	const waiters = new Set<(outcome: PluginTaskOutcome) => void>();
	const outcome = (): PluginTaskOutcome => task.status === "succeeded" ? { id: task.id, status: "succeeded", result: task.result } : { id: task.id, status: task.status as "failed" | "cancelled" | "interrupted", error: task.error! };
	const workers: PluginWorkerService = {
		register: () => () => {},
		start(definitionId, options) {
			starts++;
			assert.equal(jobStore.listJobs("chat").length, 0, "synchronous acceptance immediately precedes linked job persistence");
			assert.match(options.requestId, /^background_[a-f0-9]{64}$/);
			task = { ...options, definitionId, version: 1, id: "task_1", status: "running", createdAt: "now", updatedAt: "now", messages: [], turns: 0 };
			return structuredClone(task);
		},
		list: () => task ? [structuredClone(task)] : [],
		get: () => structuredClone(task),
		subscribe(id, listener) {
			assert.equal(jobStore.listJobs("chat")[0]!.plugin?.taskId, id, "task linkage precedes callback attachment");
			listeners.add(listener); return () => { listeners.delete(listener); };
		},
		wait: () => task.status === "running" || task.status === "queued" ? new Promise((resolve) => { waiters.add(resolve); }) : Promise.resolve(outcome()),
		cancel() { update({ status: "cancelled", error: { code: "cancelled", message: "Cancelled" } }); },
		dispose: async () => {},
	};
	function update(patch: Partial<PluginTaskRecord>) {
		task = { ...task, ...patch };
		for (const listener of [...listeners]) listener(structuredClone(task));
		if (task.status !== "queued" && task.status !== "running") { for (const resolve of waiters) resolve(outcome()); waiters.clear(); }
	}
	const definition: PluginBackgroundTool<typeof schema> = {
		name: "background_test", label: "Background test", description: "test", parameters: schema, workerId: "worker",
		prepare: (input) => { prepareCalls++; return { input, prompt: input.query, model: { provider: "openai", id: "fake" }, maxTurns: 3 }; },
		format: () => { formats++; return { text: "Model-facing summary", data: { visible: true, html: "<script>never model text</script>" } }; },
		...overrides,
	};
	const common = {
		jobStore,
		deliver: async (steer: SteerMessage) => { deliveries.push(steer); await released.promise; },
		registerAbort: (id: string, controller: AbortController) => { aborts.set(id, controller); },
		unregisterAbort: (id: string) => { aborts.delete(id); },
	};
	const tool = createPluginBackgroundTool({ ...common, pluginId: "test-plugin", context: { chatId: "chat", agent: "teacher" }, definition, workers, signal: active.signal, isActive: () => !active.signal.aborted });
	return { tool, jobStore, active, aborts, deliveries, released, update, common, counts: () => ({ prepareCalls, starts, formats }), task: () => structuredClone(task), job: () => jobStore.listJobs("chat")[0]!, listeners };
}
function result(job: JobRecord) { return job.result as PluginBackgroundResult; }

describe("native plugin background tool adapter", () => {
	it("acks before completion, dedupes retries, links before callbacks, and keeps text separate from data", async () => {
		const h = harness();
		const ack = await h.tool.execute("call", { query: "input" });
		assert.match(ack.content[0]!.type === "text" ? ack.content[0]!.text : "", /Dispatched/);
		assert.equal(h.deliveries.length, 0);
		assert.equal(h.task().purpose, "background");
		assert.deepEqual(await h.tool.execute("call", { query: "retry" }), ack);
		assert.deepEqual(h.counts(), { prepareCalls: 1, starts: 1, formats: 0 });
		h.update({ activity: "searching", usage: { model: "openai:fake", steps: 1, inputTokens: 4, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined } });
		assert.equal(h.job().activity, "searching");
		assert.equal(h.job().usage?.inputTokens, 4);
		h.update({ status: "succeeded", result: false });
		await flush();
		assert.equal(h.deliveries[0]!.id, `steer_${h.job().id}`);
		assert.equal(h.deliveries[0]!.content, "Model-facing summary");
		assert.deepEqual(result(h.job()).data, { visible: true, html: "<script>never model text</script>" });
		assert.deepEqual(result(h.job()).outcome, { id: "task_1", status: "succeeded", result: false });
		assert.equal(h.aborts.has(h.job().id), true, "liveness spans delivery");
		assert.equal(h.listeners.size, 0);
		h.released.resolve(); await flush();
		assert.equal(h.aborts.size, 0);
		assert.deepEqual(await h.tool.execute("call", { query: "retry after delivery" }), ack);
	});

	it("rechecks dedup after asynchronous prepare so concurrent calls accept one task",  async () => {
		const gate = deferred<void>(); let prepares = 0;
		const h = harness({ prepare: async (input) => { prepares++; await gate.promise; return { input, prompt: "prompt", model: { provider: "openai", id: "fake" }, maxTurns: 1 }; } });
		const pending = h.tool.execute("call", { query: "first" });
		const retry = h.tool.execute("call", { query: "second" });
		assert.equal(h.jobStore.listJobs("chat").length, 0);
		assert.equal(prepares, 2, "neither preparation was accepted yet");
		assert.equal(h.counts().starts, 0);
		gate.resolve(); assert.deepEqual(await pending, await retry);
		assert.equal(h.counts().starts, 1);
		assert.equal(h.jobStore.listJobs("chat").length, 1);
		h.update({ status: "failed", error: { code: "no_result", message: "No result" } });
		h.released.resolve(); await flush();
	});

	it("persists honest generic success before async formatting and never lets a formatter mutate the outcome", async () => {
		const gate = deferred<void>();
		const h = harness({ format: async (outcome) => { if (outcome.status === "succeeded") outcome.result = "forged"; await gate.promise; throw new Error("format exploded"); } });
		await h.tool.execute("call", { query: "input" });
		h.update({ status: "succeeded", result: { real: true } });
		assert.deepEqual(result(h.job()).outcome, { id: "task_1", status: "succeeded", result: { real: true } });
		assert.match(result(h.job()).text, /completed successfully/);
		assert.equal(h.deliveries.length, 0);
		gate.resolve(); await flush();
		assert.equal(result(h.job()).formatError, "format exploded");
		assert.equal(isSubagentFailure("plugin", result(h.job())), false);
		assert.equal(h.deliveries.length, 1);
		h.released.resolve(); await flush();
	});

	it("does not call a disabled plugin formatter and retains failed/cancelled/interrupted outcomes", async () => {
		for (const status of ["failed", "cancelled", "interrupted"] as const) {
			const h = harness();
			await h.tool.execute("call", { query: "input" }); h.active.abort();
			h.update({ status, error: { code: status === "failed" ? "no_result" : status, message: `real ${status}` } });
			await flush();
			assert.equal(h.counts().formats, 0);
			assert.equal(result(h.job()).outcome.status, status);
			assert.match(result(h.job()).formatError!, /disabled/);
			assert.equal(isSubagentFailure("plugin", result(h.job())), true);
			assert.match(h.deliveries[0]!.content, new RegExp(`real ${status}`));
			h.released.resolve(); await flush();
		}
	});

	it("END cancels an unfinished task while preserving its real outcome without queuing a result", async () => {
		const h = harness(); await h.tool.execute("call", { query: "input" });
		h.jobStore.updateJob(h.job().id, { status: "error", error: "Aborted by learner", activity: "aborted" });
		h.aborts.get(h.job().id)!.abort();
		await flush();
		assert.equal(h.task().status, "cancelled");
		assert.equal(result(h.job()).outcome.status, "cancelled");
		assert.equal(h.job().activity, "aborted");
		assert.equal(h.deliveries.length, 0);
		assert.equal(h.aborts.size, 0);
	});

	it("abort after task success does not change its immutable outcome", async () => {
		const h = harness(); await h.tool.execute("call", { query: "input" });
		h.update({ status: "succeeded", result: null }); await flush();
		h.jobStore.updateJob(h.job().id, { status: "error", error: "Aborted by learner" });
		h.aborts.get(h.job().id)!.abort();
		assert.equal(h.task().status, "succeeded");
		assert.deepEqual(result(h.job()).outcome, { id: "task_1", status: "succeeded", result: null });
		h.released.resolve(); await flush();
	});

	for (const stop of ["disable", "END"] as const) it(`${stop} stops waiting for a stuck formatter without claiming to kill author code`, async () => {
		const formatting = deferred<{ text: string }>();
		const h = harness({ format: () => formatting.promise });
		await h.tool.execute("call", { query: "input" });
		h.update({ status: "succeeded", result: false }); await flush();
		assert.equal(h.deliveries.length, 0);
		if (stop === "disable") h.active.abort();
		else { h.jobStore.updateJob(h.job().id, { status: "error", error: "Aborted by learner" }); h.aborts.get(h.job().id)!.abort(); }
		await flush();
		assert.equal(result(h.job()).outcome.status, "succeeded");
		assert.match(result(h.job()).text, /completed successfully/);
		assert.match(result(h.job()).formatError!, /aborted/);
		assert.equal(h.deliveries.length, stop === "disable" ? 1 : 0);
		h.released.resolve(); await flush(); assert.equal(h.aborts.size, 0);
		formatting.resolve({ text: "Late stale formatter" }); await flush();
		assert.match(result(h.job()).text, /completed successfully/);
		assert.equal(h.deliveries.length, stop === "disable" ? 1 : 0);
	});

	it("invalid author presentation data is formatting failure, never worker or persistence failure", async () => {
		const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
		for (const data of [cyclic, 1n, () => "function", NaN, Infinity, { nested: undefined }, [Symbol("not JSON")]]) {
			const h = harness({ format: () => ({ text: "Author text", data }) });
			await h.tool.execute("call", { query: "input" }); h.update({ status: "succeeded", result: 0 }); await flush();
			assert.equal(h.job().status, "running", "awaits real delivery instead of retiring accepted success");
			assert.equal(h.job().error, undefined);
			assert.equal(result(h.job()).outcome.status, "succeeded");
			assert.match(result(h.job()).text, /completed successfully/);
			assert.match(result(h.job()).formatError!, /JSON/);
			assert.equal(result(h.job()).data, undefined);
			assert.equal(h.deliveries.length, 1);
			h.released.resolve(); await flush(); assert.equal(h.aborts.size, 0);
		}
	});
	it("empty model text falls back and definition method receivers are preserved", async () => {
		const h = harness({ prepare(input) { assert.equal(this.workerId, "worker"); return { input, prompt: input.query, model: { provider: "offline", id: "fake" }, maxTurns: 1 }; }, format() { assert.equal(this.name, "background_test"); return { text: "  ", data: false }; } });
		await h.tool.execute("call", { query: "input" }); h.update({ status: "succeeded", result: true }); await flush();
		assert.match(result(h.job()).formatError!, /nonempty text/);
		assert.match(result(h.job()).text, /completed successfully/);
		assert.equal(h.deliveries.length, 1);
		h.released.resolve(); await flush();
	});

	it("a failed linked-job write cancels accepted work and retry never replays preparation", async () => {
		const h = harness();
		const createJob = h.jobStore.createJob.bind(h.jobStore);
		h.jobStore.createJob = () => { throw new Error("disk full"); };
		await assert.rejects(h.tool.execute("call", { query: "original" }), /disk full/);
		assert.equal(h.task().status, "cancelled");
		assert.deepEqual(h.counts(), { prepareCalls: 1, starts: 1, formats: 0 });
		h.jobStore.createJob = createJob;
		await h.tool.execute("call", { query: "retry" });
		await flush();
		assert.deepEqual(h.counts(), { prepareCalls: 1, starts: 1, formats: 1 });
		assert.equal(result(h.job()).outcome.status, "cancelled");
		h.released.resolve(); await flush();
	});

	it("a preaborted native execution signal does not prepare, accept, or acknowledge new work", async () => {
		const h = harness(); const execution = new AbortController(); execution.abort();
		await assert.rejects(h.tool.execute("call", { query: "input" }, execution.signal), /aborted/);
		assert.deepEqual(h.counts(), { prepareCalls: 0, starts: 0, formats: 0 });
		assert.equal(h.jobStore.listJobs("chat").length, 0);
		assert.equal(h.aborts.size, 0);
	});
	it("native execution abort races pending prepare and prevents late acceptance while the plugin remains enabled", async () => {
		const gate = deferred<void>(); const execution = new AbortController(); let prepares = 0;
		const h = harness({ prepare: async (input) => { prepares++; await gate.promise; return { input, prompt: "prompt", model: { provider: "openai", id: "fake" }, maxTurns: 1 }; } });
		const pending = h.tool.execute("call", { query: "input" }, execution.signal);
		execution.abort();
		await assert.rejects(pending, /aborted/);
		assert.equal(h.active.signal.aborted, false);
		assert.equal(prepares, 1);
		assert.equal(h.counts().starts, 0);
		assert.equal(h.jobStore.listJobs("chat").length, 0);
		gate.resolve(); await flush();
		assert.equal(h.counts().starts, 0, "late prepare resolution cannot start model work");
		assert.equal(h.jobStore.listJobs("chat").length, 0);
		assert.equal(h.aborts.size, 0);
	});
	it("native execution abort inside synchronous prepare cannot dispatch a worker", async () => {
		const execution = new AbortController();
		const h = harness({ prepare: (input) => { execution.abort(); return { input, prompt: "prompt", model: { provider: "openai", id: "fake" }, maxTurns: 1 }; } });
		await assert.rejects(h.tool.execute("call", { query: "input" }, execution.signal), /aborted/);
		assert.equal(h.counts().starts, 0);
		assert.equal(h.jobStore.listJobs("chat").length, 0);
	});
	it("durably accepted tasks ignore later native execution abort and idempotent retries retain their ack", async () => {
		const h = harness(); const execution = new AbortController();
		const ack = await h.tool.execute("call", { query: "input" }, execution.signal);
		execution.abort();
		assert.equal(h.task().status, "running");
		assert.deepEqual(await h.tool.execute("call", { query: "retry" }, execution.signal), ack);
		assert.deepEqual(h.counts(), { prepareCalls: 1, starts: 1, formats: 0 });
		h.update({ status: "succeeded", result: false }); await flush();
		assert.equal(result(h.job()).outcome.status, "succeeded");
		assert.equal(result(h.job()).formatError, undefined);
		assert.equal(h.deliveries.length, 1);
		h.released.resolve(); await flush(); assert.equal(h.aborts.size, 0);
	});

	it("disable during prepare never starts a task or acknowledges dispatch", async () => {
		const gate = deferred<void>();
		const h = harness({ prepare: async (input) => { await gate.promise; return { input, prompt: "prompt", model: { provider: "openai", id: "fake" }, maxTurns: 1 }; } });
		const pending = h.tool.execute("call", { query: "input" });
		h.active.abort(); gate.resolve();
		await assert.rejects(pending, /disabled/);
		assert.equal(h.counts().starts, 0);
		assert.equal(h.jobStore.listJobs("chat").length, 0);
	});
});

describe("plugin job restart recovery", () => {
	function orphan() {
		const h = harness();
		const job = h.jobStore.createJob({ kind: "plugin", chatId: "chat", toolCallId: "call", plugin: { pluginId: "disabled-plugin", toolName: "example", workerId: "worker", requestId: "request", input: { original: true } } });
		h.released.resolve();
		return { ...h, original: job };
	}
	it("re-delivers persisted presentation without reading task or calling plugin code", async () => {
		const h = orphan();
		const saved: PluginBackgroundResult = { pluginId: "disabled-plugin", toolName: "example", input: {}, text: "Saved presentation", data: { kept: true }, outcome: { id: "task", status: "succeeded", result: 0 } };
		h.jobStore.updateJob(h.original.id, { result: saved });
		await recoverPluginBackgroundJob(h.job(), { ...h.common, readTask: () => { throw new Error("must not read"); } });
		assert.deepEqual(h.deliveries[0], { ...buildSubagentSteer(h.job(), saved), timestamp: h.deliveries[0]!.timestamp });
		assert.equal(h.aborts.size, 0);
		assert.deepEqual(h.counts(), { prepareCalls: 0, starts: 0, formats: 0 });
	});
	it("recovers terminal falsy task outcomes via requestId even without a taskId link", async () => {
		for (const value of [false, 0, null, ""]) {
			const h = orphan();
			await recoverPluginBackgroundJob(h.original, { ...h.common, readTask: (pluginId, taskId, requestId) => {
				assert.equal(pluginId, "disabled-plugin"); assert.equal(taskId, undefined); assert.equal(requestId, "request");
				return { id: "canonical", status: "succeeded", result: value } as PluginTaskRecord;
			} });
			assert.deepEqual(result(h.job()).outcome, { id: "canonical", status: "succeeded", result: value });
			assert.equal(h.job().plugin?.taskId, "canonical");
			assert.equal(h.deliveries.length, 1);
			assert.equal(h.aborts.size, 0);
		}
	});
	it("reports missing/unexpected unfinished tasks as pipeline failures without inventing outcomes", async () => {
		for (const status of [null, "queued", "running"] as const) {
			const h = orphan();
			await recoverPluginBackgroundJob(h.original, { ...h.common, readTask: () => status === null ? null : { id: "canonical", status } as PluginTaskRecord });
			assert.equal(h.job().result, undefined);
			assert.equal(h.job().status, "error");
			assert.deepEqual(h.counts(), { prepareCalls: 0, starts: 0, formats: 0 });
			assert.equal(h.deliveries.length, 1);
			assert.equal(h.deliveries[0]!.customType, "subagent-abort");
			assert.equal(h.deliveries[0]!.id, `steer_${h.original.id}`);
			assert.equal((h.deliveries[0]!.details as { aborted?: true }).aborted, undefined);
			assert.match((h.deliveries[0]!.details as { failure: string }).failure, /recovery failed/);
		}
	});
	it("preserves failed/cancelled canonical outcomes", async () => {
		for (const status of ["failed", "cancelled", "interrupted"] as const) {
			const h = orphan();
			const outcome: PluginTaskOutcome = { id: "canonical", status, error: { code: status === "failed" ? "timeout" : status, message: "Canonical error" } };
			await recoverPluginBackgroundJob(h.original, { ...h.common, readTask: () => outcome as PluginTaskRecord });
			assert.deepEqual(result(h.job()).outcome, outcome);
		}
	});
	it("reports unreadable canonical state honestly, never fabricating an interrupted result", async () => {
		const h = orphan();
		await recoverPluginBackgroundJob(h.original, { ...h.common, readTask: () => { throw new Error("corrupt task JSON"); } });
		assert.equal(h.job().result, undefined);
		assert.equal(h.job().status, "error");
		assert.match(h.job().error!, /corrupt task JSON/);
		assert.equal(h.deliveries.length, 1);
		assert.equal(h.deliveries[0]!.customType, "subagent-abort");
		assert.equal((h.deliveries[0]!.details as { aborted?: true }).aborted, undefined);
		assert.match(h.deliveries[0]!.content, /corrupt task JSON/);
		assert.equal(h.aborts.size, 0);
	});
});

describe("real worker/store terminal ownership", () => {
	for (const disable of ["activation-abort", "explicit-dispose"] as const) {
		it(`${disable} wakes the canonical waiter and delivers interrupted fallback`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "lh-background-"));
			const h = harness(); const admission = deferred<void>(); let enabled = true; let formats = 0;
			const store = createPluginTaskRecordStore(join(directory, "tasks"));
			const workers = createPluginWorkerService({ store, signal: h.active.signal, engineFor: async () => { await admission.promise; throw new Error("No inference should run"); } });
			workers.register({ id: "worker", instructions: "Return a result", resultSchema: Type.Unknown() });
			const tool = createPluginBackgroundTool({ ...h.common, workers, pluginId: "example", context: { chatId: "chat", agent: "teacher" }, signal: h.active.signal, isActive: () => enabled && !h.active.signal.aborted, definition: {
				name: "test", label: "test", description: "test", parameters: schema, workerId: "worker",
				prepare: (input) => ({ input, prompt: "Complete the task", model: { provider: "offline", id: "fake" }, maxTurns: 1 }),
				format: () => { formats++; throw new Error("Dead plugin formatter must not run"); },
			} });
			try {
				await tool.execute("call", { query: "input" });
				const taskId = h.job().plugin!.taskId!;
				enabled = false;
				if (disable === "activation-abort") h.active.abort(); else await workers.dispose();
				await flush();
				assert.equal(store.get(taskId)?.status, "interrupted");
				assert.equal(result(h.job()).outcome.status, "interrupted");
				assert.equal(formats, 0); assert.equal(h.deliveries.length, 1);
				assert.equal(h.aborts.has(h.job().id), true, "abort spans terminal delivery");
				h.released.resolve(); await flush();
				assert.equal(h.aborts.size, 0);
			} finally { admission.resolve(); h.released.resolve(); await workers.dispose(); rmSync(directory, { recursive: true, force: true }); }
		});
	}
	it("terminal wait rejection reports storage poison honestly and releases ownership", async () => {
		const h = harness();
		// Suppress ephemeral terminal progress; a poisoned canonical waiter is
		// the only terminal signal and must not be turned into a fake failure task.
		const poison = deferred<never>();
		const workers: PluginWorkerService = {
			register: () => () => {},
			start: (definitionId, options) => ({ ...options, definitionId, version: 1, id: "task", status: "queued", createdAt: "now", updatedAt: "now", messages: [], turns: 0 }),
			list: () => [], get: () => ({ status: "running" } as PluginTaskRecord), subscribe: () => () => {},
			wait: () => poison.promise.then(() => { throw new Error("canonical storage poisoned"); }), cancel: () => {}, dispose: async () => {},
		};
		const tool = createPluginBackgroundTool({ ...h.common, workers, pluginId: "example", context: { chatId: "chat", agent: "teacher" }, signal: h.active.signal, isActive: () => true, definition: {
			name: "test", label: "test", description: "test", parameters: schema, workerId: "worker",
			prepare: (input) => ({ input, prompt: "Complete the task", model: { provider: "offline", id: "fake" }, maxTurns: 1 }), format: () => { throw new Error("must not format"); },
		} });
		await tool.execute("call", { query: "input" }); poison.resolve(undefined as never); await flush();
		assert.equal(h.job().status, "error"); assert.equal(h.job().result, undefined);
		assert.match(h.job().error!, /storage poisoned/);
		assert.equal(h.deliveries[0]!.customType, "subagent-abort");
		assert.equal((h.deliveries[0]!.details as { aborted?: true }).aborted, undefined);
		h.released.resolve(); await flush(); assert.equal(h.aborts.size, 0);
	});
	it("disposal racing async author formatting cannot change accepted worker success", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lh-background-")); const h = harness();
		const formatting = deferred<void>(); const releaseFormat = deferred<void>();
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_result", { result: false })], { stopReason: "toolUse" })]);
		const store = createPluginTaskRecordStore(join(directory, "tasks"));
		const workers = createPluginWorkerService({ store, signal: h.active.signal, engineFor: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }) });
		workers.register({ id: "worker", instructions: "Return a result", resultSchema: Type.Boolean() });
		const tool = createPluginBackgroundTool({ ...h.common, workers, pluginId: "example", context: { chatId: "chat", agent: "teacher" }, signal: h.active.signal, isActive: () => !h.active.signal.aborted, definition: {
			name: "test", label: "test", description: "test", parameters: schema, workerId: "worker",
			prepare: (input) => ({ input, prompt: "Complete the task", model: { provider: "offline", id: "fake" }, maxTurns: 2 }),
			format: async () => { formatting.resolve(); await releaseFormat.promise; return { text: "Stale plugin presentation" }; },
		} });
		try {
			await tool.execute("call", { query: "input" }); await formatting.promise;
			h.active.abort(); releaseFormat.resolve(); await flush();
			assert.equal(store.get(h.job().plugin!.taskId!)?.status, "succeeded");
			assert.deepEqual(result(h.job()).outcome, { id: h.job().plugin!.taskId, status: "succeeded", result: false });
			assert.match(result(h.job()).text, /completed successfully/);
			assert.match(result(h.job()).formatError!, /disabled/);
			assert.equal(h.deliveries.length, 1);
			h.released.resolve(); await flush(); assert.equal(h.aborts.size, 0);
		} finally { releaseFormat.resolve(); h.released.resolve(); await workers.dispose(); rmSync(directory, { recursive: true, force: true }); }
	});
});

describe("shared native job integration regressions", () => {
	function setup() {
		const chat = chatStore.createChat("Test: plugin background delivery");
		const job = diskJobs.createJob({ kind: "plugin", chatId: chat.id, toolCallId: "call", plugin: { pluginId: "example", toolName: "example", workerId: "worker", requestId: "request", taskId: "task" } });
		const payload: PluginBackgroundResult = { pluginId: "example", toolName: "example", input: {}, text: "Real worker success", outcome: { id: "task", status: "succeeded", result: true } };
		diskJobs.updateJob(job.id, { result: payload });
		return { chat, job, steer: buildSubagentSteer(job, payload), cleanup() {
			unregisterLiveAgent(chat.id); endTurn(chat.id);
			diskJobs.updateJob(job.id, { status: "error" });
			diskJobs.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id);
			setTurnRunner(async () => 200); setJobRespawn(() => {}); setPluginJobRecovery(async () => {});
		} };
	}
	it("core runner ignores plugin tasks entirely", async () => {
		const jobStore = memoryJobs();
		const job = jobStore.createJob({ kind: "plugin", chatId: "chat", toolCallId: "call" });
		const runner = createJobRunner({ jobStore, chatStore, deliver: async () => { assert.fail("no delivery"); }, engineFor: () => { assert.fail("no builtin engine resolution"); } });
		await runner.runJob(job.id);
		assert.equal(jobStore.getJob(job.id)?.status, "running");
	});
	it("dedupes result/abort ids already handed to a live native run", async () => {
		const h = setup();
		const handed: SteerMessage[] = [];
		try {
			assert.equal(beginTurn(h.chat.id), true);
			registerLiveAgent(h.chat.id, { steer: (steer: SteerMessage) => handed.push(steer) } as never);
			const delivery = deliverJobResult(h.steer);
			assert.equal(deliverJobResult(h.steer), delivery, "duplicates share original delivery ownership");
			assert.equal(handed.length, 1);
			assert.deepEqual(abortJob(h.job.id), { ok: true });
			assert.equal(handed.length, 1, "abort must not hand a contradictory same-id marker to pi");
			assert.equal(handed[0]!.customType, "subagent-steer");
			unregisterLiveAgent(h.chat.id); settleSteers(h.chat.id, [h.steer]);
			await delivery;
			assert.equal((diskJobs.getJob(h.job.id)!.result as PluginBackgroundResult).outcome.status, "succeeded");
		} finally { h.cleanup(); }
	});
	it("aborting pending delivery replaces stale pre-idle cargo with exactly one abort marker", async () => {
		const h = setup(); let markers: SteerMessage[] = [];
		try {
			assert.equal(beginTurn(h.chat.id), true);
			setTurnRunner(async (_chatId, input) => { assert.equal(input.type, "steers"); if (input.type === "steers") markers = input.steers as SteerMessage[]; return 200; });
			const old = deliverJobResult(h.steer);
			assert.equal(abortJob(h.job.id).ok, true);
			const aborted = deliverJobResult(buildAbortSteer(h.job));
			endTurn(h.chat.id); await old; await aborted;
			assert.equal(markers.length, 1);
			assert.equal(markers[0]!.customType, "subagent-abort");
			assert.equal((markers[0]!.details as { aborted: true }).aborted, true);
		} finally { h.cleanup(); }
	});
	it("dedupes abort against dequeued in-flight wake cargo", async () => {
		const h = setup(); const entered = deferred<void>(); const release = deferred<number>(); let calls = 0;
		try {
			setTurnRunner(async (_chatId, input) => { calls++; assert.equal(input.type, "steers"); entered.resolve(); return release.promise; });
			const delivery = deliverJobResult(h.steer);
			await entered.promise;
			assert.equal(abortJob(h.job.id).ok, true);
			assert.equal(deliverJobResult(buildAbortSteer(h.job)), delivery);
			release.resolve(200); await delivery;
			assert.equal(calls, 1);
			assert.equal((diskJobs.getJob(h.job.id)!.result as PluginBackgroundResult).outcome.status, "succeeded");
		} finally { release.resolve(200); h.cleanup(); }
	});
	it("recovery sweep routes plugin jobs only through safe recovery, never the builtin respawn", async () => {
		const h = setup(); let recovered = 0; let respawned = 0;
		try {
			diskJobs.updateJob(h.job.id, { result: undefined });
			setJobRespawn(() => { respawned++; });
			setPluginJobRecovery(async (job) => { if (job.id === h.job.id) recovered++; });
			const global = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
			if (global.__lhWakePipeline) global.__lhWakePipeline.lastSweepAt = 0;
			recoverStaleJobs();
			assert.equal(recovered, 1); assert.equal(respawned, 0);
		} finally { h.cleanup(); }
	});
});
