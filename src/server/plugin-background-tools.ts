/** Native ack-now/result-steer-later adapter. Workers own execution and canonical outcomes. */
import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { buildJobFailureSteer, buildSubagentSteer, type JobRecord, type SteerMessage } from "../core/contracts/jobs.ts";
import type { JobStore } from "../core/ports.ts";
import type { PluginToolContext } from "../core/plugins.ts";
import type { PluginBackgroundResult, PluginBackgroundTool, PluginTaskOutcome, PluginTaskRecord, PluginWorkerService } from "../core/plugin-workers.ts";

interface JobDeliveryDeps {
	jobStore: JobStore;
	deliver: (steer: SteerMessage) => Promise<void>;
	registerAbort: (jobId: string, controller: AbortController) => void;
	unregisterAbort: (jobId: string) => void;
}
export interface PluginBackgroundToolDeps<T extends TSchema> extends JobDeliveryDeps {
	pluginId: string;
	context: PluginToolContext;
	definition: PluginBackgroundTool<T>;
	workers: PluginWorkerService;
	signal: AbortSignal;
	isActive: () => boolean;
}
export interface PluginBackgroundRecoveryDeps extends JobDeliveryDeps {
	/** Safe host read only; works even for disabled plugins. Bootstrap interrupts unfinished tasks. */
	readTask: (pluginId: string, taskId?: string, requestId?: string) => PluginTaskRecord | null | Promise<PluginTaskRecord | null>;
}
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** Stop waiting, not a claim that arbitrary author code can be forcibly killed. */
function abortable<T>(run: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("Background operation wait aborted: plugin disabled or operation cancelled")); };
		if (signal.aborted) { aborted(); return; }
		signal.addEventListener("abort", aborted, { once: true });
		try {
			Promise.resolve(run()).then((value) => { signal.removeEventListener("abort", aborted); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); });
		} catch (error) { signal.removeEventListener("abort", aborted); reject(error); }
	});
}
/** Strict finite JSON snapshot: unsupported data is formatting failure, not storage failure. */
function presentationData(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || ancestors.has(value)) throw new Error("Background presentation data must be finite, acyclic JSON");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => presentationData(entry, ancestors));
		if (Object.getOwnPropertySymbols(value).length) throw new Error("Background presentation data must have JSON string keys");
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, presentationData(entry, ancestors)]));
	} finally { ancestors.delete(value); }
}
function taskOutcome(task: PluginTaskRecord): PluginTaskOutcome | null {
	if (task.status === "succeeded") return { id: task.id, status: "succeeded", result: task.result };
	if (task.status === "queued" || task.status === "running") return null;
	return { id: task.id, status: task.status, error: task.error ?? { code: task.status === "failed" ? "run_error" : task.status, message: `Worker ${task.status}` } };
}
function fallback(job: JobRecord, outcome: PluginTaskOutcome): PluginBackgroundResult {
	const meta = job.plugin!;
	return {
		pluginId: meta.pluginId, toolName: meta.toolName, input: meta.input, outcome,
		text: outcome.status === "succeeded"
			? `Background tool ${meta.toolName} completed successfully. Result:\n${JSON.stringify(outcome.result)}`
			: `Background tool ${meta.toolName} ${outcome.status}: ${outcome.error.message}`,
	};
}
function acknowledge(job: JobRecord) {
	return { content: [{ type: "text" as const, text: `Dispatched ${job.plugin?.toolName ?? "background tool"} — continue your turn. The result will arrive separately.` }], details: { jobId: job.id, dispatched: true } };
}
function deliver(job: JobRecord, result: PluginBackgroundResult, deps: JobDeliveryDeps): void {
	const current = deps.jobStore.getJob(job.id);
	if (current?.delivery?.kind !== "result" || current.delivery.status !== "pending") return;
	// Session delivery owns this promise. Failed starts cannot rewrite the
	// terminal computation or keep worker abort/resources registered.
	void deps.deliver(buildSubagentSteer(job, result)).catch((error: unknown) => {
		console.error(`[plugin job ${job.id}] result delivery remains pending:`, error);
	});
}
async function notifyFailure(job: JobRecord, error: string, deps: JobDeliveryDeps): Promise<void> {
	// Not a worker outcome or learner cancellation. The teacher still needs to
	// learn why its acknowledged dispatch cannot produce a delivered result.
	if (deps.jobStore.getJob(job.id)?.status !== "running") return;
	deps.jobStore.updateJob(job.id, { status: "error", error, activity: "delivery failed", delivery: { kind: "failure", status: "pending" } });
	void deps.deliver(buildJobFailureSteer(job, error)).catch(() => { /* retained session-owned failure notice */ });
}

export function createPluginBackgroundTool<T extends TSchema>(deps: PluginBackgroundToolDeps<T>): AgentTool<T> {
	const { definition, context, workers, jobStore } = deps;
	const { workerId, prepare, format, ...native } = definition;
	return { ...native, execute: async (toolCallId, input, executionSignal) => {
		const known = jobStore.findJobByToolCallId(context.chatId, toolCallId);
		if (known) return acknowledge(known);
		const preacceptSignal = executionSignal ? AbortSignal.any([executionSignal, deps.signal]) : deps.signal;
		if (preacceptSignal.aborted) throw new Error("Background tool call aborted: plugin disabled or operation cancelled");
		if (!deps.isActive()) throw new Error("Plugin is disabled");
		const requestId = `background_${createHash("sha256").update(JSON.stringify([context.chatId, toolCallId])).digest("hex")}`;
		// An accepted standalone task can survive a failed job write. Never replay
		// preparation or execution when this host-derived acceptance is known.
		let snapshot = workers.list().find((task) => task.requestId === requestId);
		if (snapshot && (snapshot.definitionId !== workerId || snapshot.purpose !== "background")) throw new Error("Background request identity belongs to a different worker or purpose");
		const options = snapshot ? undefined : await abortable(() => prepare.call(definition, input, context), preacceptSignal);
		const accepted = jobStore.findJobByToolCallId(context.chatId, toolCallId);
		if (accepted) return acknowledge(accepted);
		if (preacceptSignal.aborted) throw new Error("Background tool call aborted before worker dispatch: plugin disabled or operation cancelled");
		if (!deps.isActive()) throw new Error("Plugin disabled before worker dispatch");
		// After durable acceptance, the task is detached from the calling turn's
		// executionSignal: only END and the plugin/worker lifetime own it.
		// start accepts synchronously; ALL execution is deferred to a microtask.
		// Acceptance + fully linked job persistence have no yield between them.
		snapshot ??= workers.start(workerId, { ...options!, requestId, purpose: "background" });
		let job: JobRecord;
		try {
			job = jobStore.createJob({ kind: "plugin", chatId: context.chatId, toolCallId, input, activity: snapshot.activity ?? snapshot.status, plugin: {
				pluginId: deps.pluginId, toolName: definition.name, workerId, requestId,
				taskId: snapshot.id, input, label: definition.label,
			} });
		} catch (error) { workers.cancel(snapshot.id); throw error; }
		const controller = new AbortController();
		deps.registerAbort(job.id, controller);
		let terminal = false;
		let unsubscribe: (() => void) | undefined;
		controller.signal.addEventListener("abort", () => { if (!terminal) workers.cancel(snapshot.id); }, { once: true });
		const finish = async (outcome: PluginTaskOutcome): Promise<void> => {
			if (terminal) return;
			terminal = true;
			unsubscribe?.();
			let result = fallback(job, outcome);
			try {
				// Learner abort already owns its separate durable notice. Keep the
				// real task outcome without replacing that notice or invoking authors.
				if (jobStore.getJob(job.id)?.status !== "running") {
					jobStore.updateJob(job.id, { result });
					return;
				}
				// Computation ends now, independently of session delivery. Persist
				// the real generic outcome BEFORE asynchronous author formatting.
				jobStore.updateJob(job.id, { result, status: outcome.status === "succeeded" ? "done" : "error",
					error: outcome.status === "succeeded" ? undefined : outcome.error.message,
					activity: outcome.status === "succeeded" ? "finished" : "failed",
					delivery: { kind: "result", status: "pending" },
				});
				if (deps.signal.aborted || !deps.isActive()) result = { ...result, formatError: "Plugin is disabled; using the persisted worker outcome" };
				else if (!controller.signal.aborted) {
					try {
						const presentation = await abortable(() => format.call(definition, structuredClone(outcome), context), AbortSignal.any([controller.signal, deps.signal]));
						if (deps.signal.aborted || !deps.isActive()) throw new Error("Plugin disabled during result formatting");
						const text = presentation?.text;
						if (typeof text !== "string" || !text.trim()) throw new Error("Background formatter must return nonempty text");
						const rawData = presentation.data;
						const data = rawData === undefined ? undefined : presentationData(rawData);
						result = { ...result, text, ...(data === undefined ? {} : { data }) };
					} catch (error) { result = { ...result, formatError: reason(error) }; }
				}
				jobStore.updateJob(job.id, { result });
				if (!controller.signal.aborted) deliver(job, result, deps);
			} catch (error) {
				const saved = jobStore.getJob(job.id);
				if (saved?.result && saved.delivery?.kind === "result") {
					// The generic outcome was already committed. A later presentation
					// write failure cannot retroactively fail the worker.
					console.error(`[plugin job ${job.id}] presentation persistence failed:`, error);
					deliver(saved, saved.result as PluginBackgroundResult, deps);
				} else await notifyFailure(job, `Background result persistence failed: ${reason(error)}`, deps);
			}
			finally { deps.unregisterAbort(job.id); }
		};
		try {
			const update = (task: PluginTaskRecord) => {
				if (terminal) return;
				jobStore.updateJob(job.id, { usage: task.usage, ...(jobStore.getJob(job.id)?.status === "running" ? { activity: task.activity ?? task.status } : {}) });
				const outcome = taskOutcome(task);
				if (outcome) void finish(outcome);
			};
			unsubscribe = workers.subscribe(snapshot.id, update);
			// Subscription is ephemeral progress only. The canonical waiter also
			// settles on disposal, when progress listeners may already be cleared.
			void workers.wait(snapshot.id).then(finish, async (error: unknown) => {
				if (terminal) return;
				terminal = true;
				unsubscribe?.();
				try { await notifyFailure(job, `Worker outcome unavailable: ${reason(error)}`, deps); }
				finally { deps.unregisterAbort(job.id); }
			}).catch((error: unknown) => { console.error(`[plugin job ${job.id}] outcome delivery failed:`, error); });
			update(workers.get(snapshot.id));
			if (terminal) unsubscribe();
		} catch (error) {
			// A linkage/subscription failure is not a worker failure.
			unsubscribe?.();
			void notifyFailure(job, `Worker dispatch linkage failed: ${reason(error)}`, deps).finally(() => deps.unregisterAbort(job.id));
		}
		return acknowledge(job);
	} };
}

/** Recovery never calls the plugin, prepares input, or respawns tools/tasks. */
export async function recoverPluginBackgroundJob(job: JobRecord, deps: PluginBackgroundRecoveryDeps): Promise<void> {
	if (job.kind !== "plugin" || (job.status !== "running" && !(job.delivery?.kind === "result" && job.delivery.status === "pending"))) return;
	const controller = new AbortController();
	deps.registerAbort(job.id, controller);
	try {
		let result = job.result as PluginBackgroundResult | undefined;
		if (!result) {
			if (!job.plugin) throw new Error("Plugin job has no durable worker linkage");
			const task = await deps.readTask(job.plugin.pluginId, job.plugin.taskId, job.plugin.requestId);
			if (!task) throw new Error("Canonical worker task is missing; no task was replayed");
			const outcome = taskOutcome(task);
			if (!outcome) throw new Error(`Canonical worker task is unexpectedly ${task.status}; no task was replayed`);
			result = fallback(job, outcome);
			if (controller.signal.aborted || deps.jobStore.getJob(job.id)?.status !== "running") return;
			deps.jobStore.updateJob(job.id, { usage: task.usage, plugin: { ...job.plugin, taskId: task.id } });
		}
		if (!controller.signal.aborted) {
			const current = deps.jobStore.getJob(job.id);
			if (!current) return;
			if (current.status === "running") deps.jobStore.updateJob(job.id, { result,
				status: result.outcome.status === "succeeded" ? "done" : "error",
				error: result.outcome.status === "succeeded" ? undefined : result.outcome.error.message,
				activity: result.outcome.status === "succeeded" ? "finished" : "failed",
				delivery: { kind: "result", status: "pending" },
			});
			deliver(job, result, deps);
		}
	} catch (error) {
		// An unreadable task might have completed. Never fabricate an outcome.
		await notifyFailure(job, `Plugin job recovery failed: ${reason(error)}`, deps);
	} finally { deps.unregisterAbort(job.id); }
}
