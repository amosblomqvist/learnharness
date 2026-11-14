import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { PluginTaskRecordStore } from "../core/ports.ts";
import type { PluginCallPurpose, PluginModelSpec } from "../core/plugin-agents.ts";
import type { PluginInferenceOptions } from "../core/plugins.ts";
import type { PluginTaskError, PluginTaskOutcome, PluginTaskRecord, PluginTaskSnapshot, PluginWorkerContext, PluginWorkerDefinition, PluginWorkerService, PluginWorkerStartOptions } from "../core/plugin-workers.ts";
import { validatePluginInferenceOptions, validatePluginSchema } from "../core/plugin-validation.ts";
import { accumulateJobUsage, piUsageToStep } from "../core/contracts/jobs.ts";
import type { PiEngine } from "./models.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";
import { runSubagent } from "./subagents/pi-run.ts";

/** Host observability only: never project prompts, inputs, transcripts or results. */
export type PluginWorkerActivityMetadata = Pick<PluginTaskRecord,
	"id" | "definitionId" | "status" | "createdAt" | "updatedAt" | "activity" | "model" | "usage">;

export interface PluginWorkerServiceDeps {
	store: PluginTaskRecordStore;
	engineFor(model: PluginModelSpec, purpose: PluginCallPurpose, options?: PluginInferenceOptions): PiEngine | Promise<PiEngine>;
	onUsage?: (model: PluginModelSpec, usage: Usage) => void;
	signal?: AbortSignal;
	onChange?: (metadata: PluginWorkerActivityMetadata) => void;
}
const clone = <T>(value: T): T => structuredClone(value);
const terminal = (r: PluginTaskRecord) => r.status !== "queued" && r.status !== "running";
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
function id(value: string, label: string): void {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${label}`);
}
function json(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return Array.from(value, json);
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]));
	}
	throw new Error("Task input/result must be finite JSON data");
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
	return value;
}
async function abortable<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
	const error = () => Object.assign(new Error("Task execution aborted"), { name: "AbortError" });
	if (signal.aborted) throw error();
	let abort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(error()); signal.addEventListener("abort", abort, { once: true }); });
	try { return await Promise.race([Promise.resolve(value), cancelled]); }
	finally { signal.removeEventListener("abort", abort); }
}
const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
function acceptedOptions(value: PluginWorkerStartOptions): PluginWorkerStartOptions {
	if (typeof value?.requestId !== "string" || !value.requestId.length) throw new Error("Invalid worker requestId");
	if (typeof value.prompt !== "string") throw new Error("Explicit worker prompt required");
	if (!Number.isSafeInteger(value.maxTurns) || value.maxTurns < 1) throw new Error("Invalid worker maxTurns");
	if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1)) throw new Error("Invalid worker timeoutMs");
	if (value.purpose !== "user" && value.purpose !== "background") throw new Error("Invalid worker purpose");
	const model = value.model;
	if (!model || typeof model.provider !== "string" || !model.provider.trim() || typeof model.id !== "string" || !model.id.trim()) throw new Error("Explicit worker model required");
	if (model.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(model.thinkingLevel)) throw new Error("Invalid worker thinkingLevel");
	const options: PluginInferenceOptions = JSON.parse(JSON.stringify(validatePluginInferenceOptions(value.options)));
	return { requestId: value.requestId, input: json(value.input), prompt: value.prompt, model: { provider: model.provider, id: model.id, ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }) }, purpose: value.purpose, maxTurns: value.maxTurns,
		...(Object.keys(options).length ? { options } : {}), ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }) };
}
interface Task {
	record: PluginTaskRecord;
	controller: AbortController;
	listeners: Set<(snapshot: PluginTaskSnapshot) => void>;
	waiters: Set<() => void>;
	partial?: AssistantMessage;
	timer?: ReturnType<typeof setTimeout>;
	flush?: ReturnType<typeof setTimeout>;
	notifying?: boolean;
	poisoned?: Error;
	closed?: boolean;
	activityRecord?: PluginTaskRecord;
}

/** Standalone result tasks. One service/writer per directory; no admission pool,
 * replay, DAG, transport, or dependence on a subscribed view. */
export function createPluginWorkerService(deps: PluginWorkerServiceDeps): PluginWorkerService {
	const definitions = new Map<string, PluginWorkerDefinition>();
	const tasks = new Map<string, Task>();
	let disposed = false;
	let acceptanceError: Error | undefined;
	const open = () => { if (acceptanceError) throw acceptanceError; if (disposed || deps.signal?.aborted) throw new Error("Plugin workers are disabled or disposed"); };
	const snapshot = (t: Task): PluginTaskSnapshot => clone({ ...t.record, ...(t.partial ? { partial: t.partial } : {}) });
	const wake = (t: Task) => { for (const listener of [...t.waiters]) listener(); };
	const notify = (t: Task) => {
		if (t.flush) clearTimeout(t.flush); t.flush = undefined;
		wake(t);
		if (!disposed && t.activityRecord !== t.record) {
			t.activityRecord = t.record;
			const { id, definitionId, status, createdAt, updatedAt, activity, model, usage } = t.record;
			try { deps.onChange?.(clone({ id, definitionId, status, createdAt, updatedAt, activity, model, usage })); } catch { /* Observe only. */ }
		}
		if (disposed || t.notifying) return;
		t.notifying = true;
		queueMicrotask(() => {
			t.notifying = false;
			if (disposed) return;
			for (const listener of [...t.listeners]) { try { listener(snapshot(t)); } catch { /* Views do not own execution. */ } }
		});
	};
	const commit = (t: Task, record: PluginTaskRecord) => {
		if (disposed || t.closed) throw new Error("Task writer is closed");
		if (t.poisoned) throw t.poisoned;
		const next = clone({ ...record, updatedAt: new Date().toISOString() });
		try { deps.store.save(next); }
		catch (error) {
			t.poisoned = new Error(`Plugin task storage failed: ${text(error)}`);
			t.controller.abort();
			// A successful result is already authoritative; never replace it with
			// a later checkpoint failure. Otherwise try to durably expose failure.
			let uncertainSuccess = false;
			if (next.status === "succeeded") {
				try { uncertainSuccess = deps.store.get(next.id)?.status === "succeeded"; } catch { uncertainSuccess = true; }
			}
			if (!terminal(t.record) && !uncertainSuccess) {
				const failed: PluginTaskRecord = { ...t.record, status: "failed", completedAt: new Date().toISOString(), error: { code: "storage_error", message: t.poisoned.message } };
				try { deps.store.save(clone(failed)); t.record = failed; } catch { /* wait rejects, rather than inventing a durable terminal state. */ }
			}
			notify(t); throw t.poisoned;
		}
		t.record = next;
		if (terminal(next) && t.timer) { clearTimeout(t.timer); t.timer = undefined; }
		notify(t);
	};
	const finish = (t: Task, status: "failed" | "cancelled" | "interrupted", error: PluginTaskError) => {
		if (terminal(t.record)) return;
		commit(t, { ...t.record, status, error, completedAt: new Date().toISOString() });
		t.controller.abort(); t.partial = undefined;
	};
	for (const loaded of deps.store.list()) {
		id(loaded.id, "task id"); id(loaded.definitionId, "worker id");
		if (typeof loaded.requestId !== "string" || !loaded.requestId.length) throw new Error("Invalid persisted worker requestId");
		if (tasks.has(loaded.id) || [...tasks.values()].some(t => t.record.requestId === loaded.requestId)) throw new Error("Duplicate persisted task identity");
		const t: Task = { record: clone(loaded), controller: new AbortController(), listeners: new Set(), waiters: new Set() };
		tasks.set(loaded.id, t);
		if (!terminal(loaded)) finish(t, "interrupted", { code: "interrupted", message: "Task interrupted by restart; no work was replayed" });
	}
	const task = (key: string) => { id(key, "task id"); const t = tasks.get(key); if (!t) throw new Error(`Plugin task not found: ${key}`); return t; };
	const outcome = (t: Task): PluginTaskOutcome => {
		const r = t.record;
		if (r.status === "succeeded") return { id: r.id, status: r.status, result: clone(r.result) };
		if (r.status === "failed" || r.status === "cancelled" || r.status === "interrupted") return { id: r.id, status: r.status, error: clone(r.error!) };
		throw new Error("Task has not settled");
	};
	const expired = (t: Task) => t.record.timeoutMs !== undefined && Date.now() - Date.parse(t.record.createdAt) >= t.record.timeoutMs;
	const timeoutError: PluginTaskError = { code: "timeout", message: "Worker task timed out" };
	const execute = async (t: Task, d: PluginWorkerDefinition) => {
		const active = () => {
			if (disposed || t.closed || t.poisoned || t.controller.signal.aborted || t.record.status !== "running") throw t.poisoned ?? new Error("Task is no longer running");
			if (expired(t)) { finish(t, "failed", timeoutError); throw new Error(timeoutError.message); }
		};
		try {
			if (disposed || terminal(t.record)) return;
			commit(t, { ...t.record, status: "running", activity: "starting" });
			active();
			const engine = await abortable(deps.engineFor(clone(t.record.model), t.record.purpose, clone(t.record.options)), t.controller.signal);
			active();
			const context: PluginWorkerContext = Object.freeze({ taskId: t.record.id, input: freeze(json(t.record.input)), signal: t.controller.signal });
			const resultValidator = validatePluginSchema(d.resultSchema);
			const names = new Set(["submit_result"]);
			const tools = (d.tools?.(context) ?? []).map((tool): AgentTool<any> => {
				if (typeof tool.name !== "string" || !tool.name.length) throw new Error("Worker tool name is required");
				if (names.has(tool.name)) throw new Error(`Duplicate/reserved worker tool name: ${tool.name}`);
				names.add(tool.name); validatePluginSchema(tool.parameters);
				if (typeof tool.execute !== "function") throw new Error(`Worker tool execute is required: ${tool.name}`);
				return { ...tool, parameters: clone(tool.parameters),
					...(tool.prepareArguments ? { prepareArguments: (...args) => { active(); return tool.prepareArguments!(...args); } } : {}),
					execute: async (...args) => { active(); return tool.execute(...args); } };
			});
			tools.push({ name: "submit_result", label: "Submit result", description: "Submit the final task result. Correct schema/semantic errors and retry before the turn budget ends.",
				parameters: Type.Object({ result: d.resultSchema }, { additionalProperties: false }), executionMode: "sequential",
				execute: async (_id, args) => {
					active();
					const result = freeze(json((args as { result: unknown }).result));
					try { await d.validateResult?.(result, context); }
					catch (error) { active(); return { content: [{ type: "text", text: text(error) }], details: null, isError: true }; }
					active();
					if (!resultValidator.Check(result)) throw new Error("Result no longer satisfies its schema");
					commit(t, { ...t.record, status: "succeeded", result, completedAt: new Date().toISOString(), activity: "result accepted" });
					return { content: [{ type: "text", text: "Task result accepted" }], details: null, terminate: true };
				},
			});
			let batchStart = t.record.messages.length;
			const saveResult = (message: ToolResultMessage) => {
				const messages = [...t.record.messages];
				const old = messages.findIndex((m, i) => i > batchStart && m.role === "toolResult" && m.toolCallId === message.toolCallId);
				if (old >= 0) messages[old] = clone(message);
				else {
					const assistant = messages[batchStart];
					const order = assistant?.role === "assistant" ? assistant.content.filter(c => c.type === "toolCall").map(c => c.id) : [];
					const insertion = messages.findIndex((m, i) => i > batchStart && m.role === "toolResult" && order.indexOf(m.toolCallId) > order.indexOf(message.toolCallId));
					messages.splice(insertion < 0 ? messages.length : insertion, 0, clone(message));
				}
				commit(t, { ...t.record, messages });
			};
			await runSubagent(tools, { engine, systemPrompt: d.instructions, messages: clone(t.record.messages), maxTurns: t.record.maxTurns, abortSignal: t.controller.signal,
				beforeRequest: active, shouldStop: () => terminal(t.record),
				onEvent: (event: AgentEvent) => {
					if (disposed || t.closed || t.poisoned || t.controller.signal.aborted) throw t.poisoned ?? new Error("Task writer is closed");
					if (event.type === "message_update" && event.message.role === "assistant") {
						t.partial = event.message;
						if (!t.flush) { t.flush = setTimeout(() => { if (!disposed && !t.closed) notify(t); }, 100); t.flush.unref?.(); }
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						const m = event.message; t.partial = undefined; batchStart = t.record.messages.length;
						const called = m.content.filter(c => c.type === "toolCall").map(c => c.id);
						const usage = m.stopReason !== "aborted" && usageWasAdmitted(m.usage);
						commit(t, { ...t.record, messages: [...t.record.messages, m], turns: t.record.turns + 1,
							...(usage ? { usage: accumulateJobUsage(t.record.usage, `${m.provider}:${m.model}`, piUsageToStep(m.usage)) } : {}) });
						if (usage) {
							try { deps.onUsage?.(clone(t.record.model), clone(m.usage)); }
							catch (error) { // Accounting writes are also host persistence, never a model-correctable error.
								const failure = new Error(`Plugin task accounting storage failed: ${text(error)}`);
								try { finish(t, "failed", { code: "storage_error", message: failure.message }); }
								finally { t.poisoned ??= failure; t.controller.abort(); notify(t); }
								throw failure;
							}
						}
						if (new Set(called).size !== called.length) {
							const message = "Duplicate tool call IDs in response";
							finish(t, "failed", { code: "run_error", message }); throw new Error(message);
						}
					} else if (event.type === "tool_execution_start") {
						if (!terminal(t.record)) commit(t, { ...t.record, activity: `tool: ${event.toolName}` });
					} else if (event.type === "tool_execution_end") {
						saveResult({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, content: event.result.content ?? [], details: event.result.details,
							usage: event.result.usage, isError: event.isError, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }), timestamp: Date.now() });
					} else if (event.type === "message_end" && event.message.role === "toolResult") saveResult(event.message);
				},
			});
			if (!terminal(t.record)) {
				active();
				finish(t, "failed", { code: t.record.turns >= t.record.maxTurns ? "max_turns" : "no_result", message: t.record.turns >= t.record.maxTurns ? "Worker exhausted maxTurns without an accepted result" : "Worker finished without submitting a result" });
			}
		} catch (error) {
			if (!terminal(t.record) && !t.poisoned && !disposed) {
				try { finish(t, "failed", expired(t) ? timeoutError : { code: "run_error", message: text(error) }); } catch { /* Storage poison is already visible. */ }
			}
		} finally {
			if (t.flush) clearTimeout(t.flush); t.flush = undefined; t.partial = undefined;
			t.closed = true; notify(t);
		}
	};
	const service: PluginWorkerService = {
		register(input) {
			open(); id(input.id, "worker id");
			if (definitions.has(input.id)) throw new Error(`Worker already registered: ${input.id}`);
			if (typeof input.instructions !== "string" || (input.tools !== undefined && typeof input.tools !== "function") || (input.validateResult !== undefined && typeof input.validateResult !== "function")) throw new Error("Invalid worker definition");
			validatePluginSchema(input.resultSchema);
			const d = { ...input, resultSchema: clone(input.resultSchema) }; definitions.set(d.id, d);
			return () => { if (definitions.get(d.id) !== d) return; definitions.delete(d.id); for (const t of tasks.values()) if (t.record.definitionId === d.id && !terminal(t.record)) finish(t, "interrupted", { code: "interrupted", message: "Worker definition unregistered" }); };
		},
		start(definitionId, input) {
			open(); id(definitionId, "worker id");
			const options = acceptedOptions(input);
			const existing = [...tasks.values()].find(t => t.record.requestId === options.requestId);
			if (existing) {
				if (existing.record.definitionId !== definitionId || canonical(acceptedOptions(existing.record)) !== canonical(options)) throw new Error("requestId was already used for a different worker request");
				if (existing.poisoned && !terminal(existing.record)) throw existing.poisoned;
				return snapshot(existing);
			}
			const d = definitions.get(definitionId); if (!d) throw new Error(`Worker definition unavailable: ${definitionId}`);
			const now = new Date().toISOString();
			const record: PluginTaskRecord = { ...options, version: 1, id: randomUUID(), definitionId, createdAt: now, updatedAt: now, status: "queued", messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }], turns: 0 };
			// A post-rename fsync failure has an uncertain durable outcome. Stop
			// further acceptance rather than risking duplicate request identities.
			try { deps.store.save(clone(record)); }
			catch (error) { acceptanceError = new Error(`Plugin task acceptance storage failed: ${text(error)}`); throw acceptanceError; }
			const t: Task = { record, controller: new AbortController(), listeners: new Set(), waiters: new Set() }; tasks.set(record.id, t);
			if (options.timeoutMs !== undefined) {
				const schedule = () => {
					const remaining = options.timeoutMs! - (Date.now() - Date.parse(record.createdAt));
					t.timer = setTimeout(() => {
						if (terminal(t.record)) return;
						if (!expired(t)) { schedule(); return; }
						try { finish(t, "failed", timeoutError); } catch { /* Storage poison is exposed to waiters. */ }
					}, Math.max(0, Math.min(2147483647, remaining)));
					t.timer.unref?.();
				};
				schedule();
			}
			notify(t); queueMicrotask(() => { void execute(t, d); });
			return snapshot(t);
		},
		list() { return [...tasks.values()].map(snapshot); },
		get(key) { return snapshot(task(key)); },
		subscribe(key, listener) { const t = task(key); if (disposed) throw new Error("Plugin workers disposed"); t.listeners.add(listener); try { listener(snapshot(t)); } catch (error) { t.listeners.delete(listener); throw error; } return () => { t.listeners.delete(listener); }; },
		wait(key, signal) {
			const t = task(key);
			return new Promise((resolve, reject) => {
				const aborted = () => { cleanup(); reject(Object.assign(new Error("Task wait aborted"), { name: "AbortError" })); };
				const changed = () => { if (terminal(t.record)) { cleanup(); resolve(outcome(t)); } else if (t.poisoned) { cleanup(); reject(t.poisoned); } };
				const cleanup = () => { t.waiters.delete(changed); signal?.removeEventListener("abort", aborted); };
				if (signal?.aborted) { aborted(); return; }
				t.waiters.add(changed); signal?.addEventListener("abort", aborted, { once: true }); changed();
			});
		},
		cancel(key) { const t = task(key); if (!terminal(t.record)) finish(t, "cancelled", { code: "cancelled", message: "Task cancelled" }); },
		async dispose() {
			if (disposed) return;
			let failure: unknown;
			for (const t of tasks.values()) {
				try { if (!terminal(t.record)) finish(t, "interrupted", { code: "interrupted", message: "Task interrupted by plugin disposal" }); } catch (error) { failure ??= error; }
				t.controller.abort(); t.closed = true; t.partial = undefined;
				if (t.timer) clearTimeout(t.timer); if (t.flush) clearTimeout(t.flush); t.listeners.clear(); wake(t);
			}
			disposed = true; definitions.clear(); deps.signal?.removeEventListener("abort", disabled);
			if (failure) throw failure;
		},
	};
	const disabled = () => { void service.dispose().catch(() => { /* Storage failures remain poisoned, never hidden as success. */ }); };
	deps.signal?.addEventListener("abort", disabled, { once: true }); if (deps.signal?.aborted) disabled();
	return service;
}
