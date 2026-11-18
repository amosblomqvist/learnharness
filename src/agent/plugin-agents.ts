import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonValue, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type {
	PluginAgentDefinition, PluginAgentInputOptions, PluginAgentRecord, PluginAgentService,
	PluginAgentSnapshot, PluginCallPurpose, PluginModelSpec,
} from "../core/plugin-agents.ts";
import type { PiEngine } from "./models.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";

import type { PluginAgentRecordStore } from "../core/ports.ts";
export type { PluginAgentRecordStore } from "../core/ports.ts";
export interface PluginAgentServiceDeps {
	store: PluginAgentRecordStore;
	engineFor(model: PluginModelSpec, purpose: PluginCallPurpose): Promise<PiEngine> | PiEngine;
	onUsage?: (model: PluginModelSpec, usage: Usage) => void;
	signal?: AbortSignal;
	onChange?: () => void;
}

const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function identifier(id: string, label: string): void {
	if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`Invalid ${label}`);
}
function callIdentifier(id: string): void {
	if (typeof id !== "string" || !id.length || id.length > 512 || /[\x00-\x1f]/.test(id)) throw new Error("Invalid tool call id");
}

/** Find incomplete batches without fabricating tool answers. A later explicit user
 * input is a recovery boundary: the incomplete batch is omitted from model context,
 * but its native messages remain intact on disk. Genuine pending inputs cannot use
 * this escape hatch (send is rejected until they have all been answered). */
function modelHistory(messages: AgentMessage[]): AgentMessage[] {
	const result: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role !== "assistant") { result.push(message); continue; }
		const calls = message.content.filter((c) => c.type === "toolCall");
		if (!calls.length) { result.push(message); continue; }
		let end = i + 1;
		while (end < messages.length && messages[end]!.role === "toolResult") end++;
		const results = messages.slice(i + 1, end) as ToolResultMessage[];
		if (calls.every((c) => results.some((r) => r.toolCallId === c.id))) {
			result.push(...messages.slice(i, end));
		} else if (!messages.slice(end).some((m) => m.role === "user")) {
			throw new Error("Unresolved tool calls: unsafe to resume; use .send(id, explicitPrompt, {requestId, purpose:'background'}) to establish a new task context");
		}
		i = end - 1;
	}
	return result;
}

interface Run {
	controller: AbortController;
	agent?: Agent;
	cancelled: boolean;
}
interface Session {
	record: PluginAgentRecord;
	listeners: Set<(snapshot: PluginAgentSnapshot) => void>;
	run?: Run;
	partial?: AssistantMessage;
	timer?: ReturnType<typeof setTimeout>;
	poisoned?: Error;
	notifyQueued?: boolean;
}

/** Native pi 1.4 Agent orchestration, independent of any transport or view.
 * run() only retries an existing runnable input; starting a task requires send().
 * No tools are replayed after restart, and no input-tool placeholders persist.
 * dispose requests cooperative cancellation; it does not wait for uncooperative
 * plugin code, and such code is prevented from making late managed writes. */
export function createPluginAgentService(deps: PluginAgentServiceDeps): PluginAgentService {
	const definitions = new Map<string, PluginAgentDefinition>();
	const sessions = new Map<string, Session>();
	let disposed = false;
	const open = () => { if (disposed || deps.signal?.aborted) throw new Error("Plugin agent service unavailable: disposed or disabled"); };
	const snapshot = (s: Session): PluginAgentSnapshot => clone({ ...s.record, ...(s.partial ? { partial: s.partial } : {}) });
	const notify = (s: Session) => {
		if (s.timer) clearTimeout(s.timer);
		s.timer = undefined;
		if (disposed || s.notifyQueued) return;
		s.notifyQueued = true;
		queueMicrotask(() => {
			s.notifyQueued = false;
			if (disposed) return;
			for (const listener of [...s.listeners]) {
				try { listener(snapshot(s)); } catch { /* Views cannot fail a managed run. */ }
			}
			try { deps.onChange?.(); } catch { /* Notification is not persistence. */ }
		});
	};
	const commit = (s: Session, next: PluginAgentRecord) => {
		if (disposed) throw new Error("Plugin agent service disposed");
		if (s.poisoned) throw s.poisoned;
		const record = clone({ ...next, updatedAt: new Date().toISOString() });
		try { deps.store.save(record); }
		catch (error) {
			s.poisoned = new Error(`Plugin agent persistence failed: ${errorText(error)}`);
			s.run?.controller.abort();
			s.run?.agent?.abort();
			// Never install uncommitted accepted IDs, inputs, or successful results.
			s.record = { ...s.record, status: "error", error: s.poisoned.message };
			notify(s);
			throw s.poisoned;
		}
		s.record = record;
		notify(s);
	};
	for (const loaded of deps.store.list()) {
		identifier(loaded.id, "session id");
		identifier(loaded.definitionId, "definition id");
		if (sessions.has(loaded.id)) throw new Error(`Duplicate plugin agent session: ${loaded.id}`);
		const s: Session = { record: clone(loaded), listeners: new Set() };
		sessions.set(loaded.id, s);
		if (loaded.status === "running") commit(s, { ...loaded, status: "interrupted", error: "Run interrupted by restart; tools were not replayed" });
	}
	const session = (id: string): Session => {
		identifier(id, "session id");
		const s = sessions.get(id);
		if (!s) throw new Error(`Plugin agent session not found: ${id}`);
		return s;
	};
	const definition = (s: Session) => {
		const d = definitions.get(s.record.definitionId);
		if (!d) throw new Error(`Plugin agent definition unavailable: ${s.record.definitionId}`);
		return d;
	};
	const cancel = (s: Session) => {
		const run = s.run;
		if (!run || run.cancelled) return;
		run.cancelled = true;
		run.controller.abort();
		run.agent?.abort();
		s.partial = undefined;
		commit(s, { ...s.record, status: s.record.pending.length ? "waiting" : "interrupted", error: "Run cancelled" });
	};
	const launch = (s: Session, d: PluginAgentDefinition, purpose: PluginCallPurpose) => {
		const run: Run = { controller: new AbortController(), cancelled: false };
		s.run = run; // Reserve the writer before engine resolution or any other await.
		const active = () => {
			if (disposed || run.cancelled || run.controller.signal.aborted || s.poisoned || definitions.get(d.id) !== d) {
				throw new Error("Plugin agent run cancelled or unavailable");
			}
		};
		void (async () => {
			try {
				const engine = await deps.engineFor(clone(d.model), purpose);
				active();
				let turns = 0;
				let endedByTool = false;
				let batchStart = s.record.messages.length;
				const inputs = new Map<string, unknown>();
				const tools: AgentTool[] = (d.tools ?? []).map((tool) => ({
					name: tool.name, label: tool.name, description: tool.description,
					parameters: tool.parameters, prepareArguments: tool.prepareArguments,
					execute: async (id, args, signal, onUpdate) => {
						active();
						if (tool.kind === "input") {
							inputs.set(id, clone(args));
							// Runtime-only sentinel: never emitted as a persisted tool result.
							return { content: [], details: null, terminate: true };
						}
						return tool.execute!(id, args, signal, onUpdate);
					},
				}));
				const agent = new Agent({
					sessionId: s.record.id,
					initialState: {
						systemPrompt: d.instructions, model: engine.model,
						thinkingLevel: engine.level ?? d.model.thinkingLevel,
						messages: clone(modelHistory(s.record.messages)), tools,
					},
					streamFn: engine.streamFn,
					prepareRequest: () => {
						active();
						if (s.record.pending.length) throw new Error("Cannot request model while external input is unresolved");
					},
					finishTurn: () => {
						active();
						turns++;
						if (s.record.pending.length || endedByTool || (d.maxTurns !== undefined && turns >= d.maxTurns)) return { action: "end" };
					},
				});
				run.agent = agent;
				const saveResult = (message: ToolResultMessage) => {
					const messages = [...s.record.messages];
					const old = messages.findIndex((m, i) => i > batchStart && m.role === "toolResult" && m.toolCallId === message.toolCallId);
					if (old >= 0) messages[old] = clone(message);
					else {
						const assistant = messages[batchStart];
						const order = assistant?.role === "assistant" ? assistant.content.filter((c) => c.type === "toolCall").map((c) => c.id) : [];
						const insertion = messages.findIndex((m, i) => i > batchStart && m.role === "toolResult" && order.indexOf(m.toolCallId) > order.indexOf(message.toolCallId));
						messages.splice(insertion < 0 ? messages.length : insertion, 0, clone(message));
					}
					commit(s, { ...s.record, messages });
				};
				agent.subscribe((event) => {
					active();
					if (event.type === "message_update") {
						// Keep ONE SDK-owned latest partial; copy only on observation/flush.
						if (event.message.role !== "assistant") return;
						s.partial = event.message;
						if (!s.timer) {
							s.timer = setTimeout(() => { if (!disposed && !run.cancelled) notify(s); }, 100);
							s.timer.unref?.();
						}
					} else if (event.type === "message_end") {
						const m = event.message;
						if (m.role === "assistant") {
							inputs.clear();
							s.partial = undefined;
							batchStart = s.record.messages.length;
							const ids = m.content.filter((c) => c.type === "toolCall").map((c) => c.id);
							commit(s, { ...s.record, messages: [...s.record.messages, m],
								...(m.stopReason === "error" ? { error: m.errorMessage ?? "Provider error" } : {}) });
							if (new Set(ids).size !== ids.length) throw new Error("Duplicate tool call IDs in assistant response");
							// This awaited native subscription is the side-effect write barrier.
							if (m.stopReason !== "aborted" && usageWasAdmitted(m.usage)) {
								try { deps.onUsage?.(clone(d.model), clone(m.usage)); } catch {
									// Accounting cannot rewrite an already committed response, but
									// failures must be visible. Never log callback errors/request data.
									console.error("[plugin-agents] Plugin accounting failure", { definitionId: d.id, sessionId: s.record.id });
								}
							}
						} else if (m.role === "toolResult" && !inputs.has(m.toolCallId)) saveResult(m);
					} else if (event.type === "tool_execution_end") {
						const tool = d.tools?.find((t) => t.name === event.toolName);
						if (inputs.has(event.toolCallId) && !event.isError) {
							commit(s, { ...s.record, pending: [...s.record.pending, {
								toolCallId: event.toolCallId, toolName: event.toolName, input: inputs.get(event.toolCallId),
							}] });
						} else {
							inputs.delete(event.toolCallId);
							// Checkpoint immediately, even while sibling tools are still running.
							saveResult({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
								content: event.result.content ?? [], details: event.result.details, usage: event.result.usage,
								isError: event.isError, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }), timestamp: Date.now() });
						}
						if (!event.isError && tool?.endRun) endedByTool = true;
					}
				});
				await agent.continue();
				active();
				const last = [...s.record.messages].reverse().find((m) => m.role === "assistant");
				commit(s, { ...s.record, status: last?.role === "assistant" && last.stopReason === "error" ? "error"
					: last?.role === "assistant" && last.stopReason === "aborted" ? "interrupted"
					: s.record.pending.length ? "waiting" : "idle" });
			} catch (error) {
				if (!disposed && !run.cancelled && !s.poisoned) {
					try { commit(s, { ...s.record, status: "error", error: errorText(error) }); } catch { /* commit already failed closed */ }
				}
			} finally {
				if (s.run === run) s.run = undefined;
				if (!disposed) { s.partial = undefined; notify(s); }
			}
		})();
	};
	const accept = (s: Session, options: PluginAgentInputOptions) => {
		open();
		identifier(options?.requestId, "request id");
		if (options.purpose !== undefined && options.purpose !== "user" && options.purpose !== "background") throw new Error("Invalid call purpose");
		if (s.poisoned) throw s.poisoned;
		definition(s);
		if (s.record.acceptedInputs.includes(options.requestId)) return false;
		if (s.run) throw new Error("Plugin agent session is busy");
		return true;
	};
	const accepted = (s: Session, options: PluginAgentInputOptions, patch: Partial<PluginAgentRecord>) => {
		commit(s, { ...s.record, ...patch, error: undefined, acceptedInputs: [...s.record.acceptedInputs, options.requestId] });
	};
	const service: PluginAgentService = {
		register(input) {
			open();
			identifier(input.id, "definition id");
			if (definitions.has(input.id)) throw new Error(`Plugin agent definition already registered: ${input.id}`);
			if (typeof input.instructions !== "string" || !input.model) throw new Error("Invalid plugin agent definition");
			if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)) throw new Error("Invalid maxTurns");
			const names = new Set<string>();
			for (const tool of input.tools ?? []) {
				identifier(tool.name, "tool name");
				if (names.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
				names.add(tool.name);
				if (tool.kind !== undefined && tool.kind !== "server" && tool.kind !== "input") throw new Error("Invalid tool kind");
				const toolName = tool.name;
				if (tool.kind === "input") {
					if (tool.execute !== undefined) throw new Error(`Input tools are declarative; execute is not allowed: ${toolName}`);
					if (tool.endRun !== undefined) throw new Error(`Input tools always pause; endRun is not allowed: ${toolName}`);
				} else if (typeof tool.execute !== "function") throw new Error(`Missing execute for server tool: ${toolName}`);
			}
			const d = { ...input, model: clone(input.model), tools: input.tools?.map((t) => ({ ...t, parameters: clone(t.parameters), resultSchema: t.resultSchema ? clone(t.resultSchema) : undefined })) };
			definitions.set(d.id, d);
			return () => {
				if (definitions.get(d.id) !== d) return;
				definitions.delete(d.id);
				for (const s of sessions.values()) if (s.record.definitionId === d.id) cancel(s);
			};
		},
		create(definitionId) {
			open(); identifier(definitionId, "definition id");
			if (!definitions.has(definitionId)) throw new Error(`Plugin agent definition unavailable: ${definitionId}`);
			const now = new Date().toISOString();
			const s: Session = { listeners: new Set(), record: { version: 1, id: randomUUID(), definitionId,
				createdAt: now, updatedAt: now, messages: [], pending: [], status: "idle", acceptedInputs: [] } };
			commit(s, s.record);
			sessions.set(s.record.id, s);
			return snapshot(s);
		},
		list() { open(); return [...sessions.values()].map(snapshot); },
		get(id) { open(); return snapshot(session(id)); },
		async send(id, text, options) {
			const s = session(id);
			if (!accept(s, options)) return snapshot(s);
			if (typeof text !== "string" || !text.trim()) throw new Error("Explicit nonempty prompt required");
			if (s.record.pending.length) throw new Error("External inputs are pending; answer all pending calls before sending");
			accepted(s, options, { status: "running", messages: [...s.record.messages, { role: "user", content: text, timestamp: Date.now() }] });
			launch(s, definition(s), options.purpose ?? "user");
			return snapshot(s);
		},
		async answer(id, toolCallId, value, options) {
			const s = session(id); callIdentifier(toolCallId);
			if (!accept(s, options)) return snapshot(s);
			const pending = s.record.pending.find((p) => p.toolCallId === toolCallId);
			if (!pending) throw new Error(`Pending input not found: ${toolCallId}`);
			const d = definition(s);
			const tool = d.tools?.find((t) => t.name === pending.toolName && t.kind === "input");
			if (!tool) throw new Error(`Input tool unavailable: ${pending.toolName}`);
			if (tool.resultSchema && !Value.Check(tool.resultSchema, value)) throw new Error(`Invalid answer for ${pending.toolName}`);
			const serialized = JSON.stringify(value);
			if (serialized === undefined) throw new Error("Answer must be JSON serializable");
			const json: JsonValue = JSON.parse(serialized);
			const result = tool.formatResult ? tool.formatResult(clone(json)) : { content: [{ type: "text" as const, text: serialized }], details: json };
			if (result.isError || !Array.isArray(result.content)) throw new Error("Answer formatter must return a successful tool result");
			const remaining = s.record.pending.filter((p) => p !== pending);
			// Source-order tool results, regardless of the order external answers arrive.
			const messages = [...s.record.messages];
			let start = messages.length - 1;
			while (start >= 0 && messages[start]!.role !== "assistant") start--;
			const assistant = messages[start];
			const order = assistant?.role === "assistant" ? assistant.content.filter((c) => c.type === "toolCall").map((c) => c.id) : [];
			const insertion = messages.findIndex((m, i) => i > start && m.role === "toolResult" && order.indexOf(m.toolCallId) > order.indexOf(toolCallId));
			messages.splice(insertion < 0 ? messages.length : insertion, 0, { role: "toolResult", toolCallId, toolName: tool.name,
				content: result.content, details: result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details)), usage: result.usage, isError: false, timestamp: Date.now() });
			accepted(s, options, { messages, pending: remaining, status: remaining.length ? "waiting" : "running" });
			if (!remaining.length) launch(s, d, options.purpose ?? "user");
			return snapshot(s);
		},
		async run(id, options) {
			const s = session(id);
			if (!accept(s, options)) return snapshot(s);
			if (s.record.pending.length) throw new Error("External inputs are pending; answer all pending calls before resuming");
			modelHistory(s.record.messages); // Reject unsafe side-effect replay before acceptance.
			if (!s.record.messages.length || s.record.messages.at(-1)?.role === "assistant") throw new Error("No runnable persisted input; use .send(id, explicitPrompt, {requestId, purpose:'background'}) to start a task");
			accepted(s, options, { status: "running" });
			launch(s, definition(s), options.purpose ?? "background");
			return snapshot(s);
		},
		abort(id) { open(); cancel(session(id)); },
		subscribe(id, listener) {
			open(); const s = session(id);
			s.listeners.add(listener);
			try { listener(snapshot(s)); } catch (error) { s.listeners.delete(listener); throw error; }
			return () => { s.listeners.delete(listener); };
		},
		async dispose() {
			if (disposed) return;
			let failure: unknown;
			for (const s of sessions.values()) {
				try { cancel(s); } catch (error) { failure ??= error; }
				if (s.timer) clearTimeout(s.timer);
				s.listeners.clear();
			}
			disposed = true;
			definitions.clear();
			deps.signal?.removeEventListener("abort", disabled);
			if (failure) throw failure;
		},
	};
	const disabled = () => { void service.dispose().catch(() => { /* Writes failed closed; no further work is allowed. */ }); };
	deps.signal?.addEventListener("abort", disabled, { once: true });
	if (deps.signal?.aborted) disabled();
	return service;
}
