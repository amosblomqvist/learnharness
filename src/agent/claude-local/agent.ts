/**
 * ClaudeLocalAgent — the pi `Agent` replacement for lesson turns on the
 * Local Claude route (owner decision 2026-10-27: "replace the Agent").
 * Claude Code runs the tool loop inside the user's own `claude`; this
 * class owns everything the app's loop otherwise owns around it, in pi's
 * exact event vocabulary (LiveAgent — live-agent.ts), so the turn runner,
 * the record, the wire, the usage listener and the steer registry cannot
 * tell the two engines apart:
 *
 *   agent_start → [turn_start → (steer messages) → message_start, message_update..., message_end
 *     → tool_execution_start/end per call → tool-result message_start/end per result → turn_end] per model call
 *     → agent_end
 *
 * Stateless per turn like pi's Agent: the record is the state
 * (state.messages = the record + this run's additions), rebuilt every
 * POST, discarded at settle. One `claude` child per Claude Code turn; a
 * steer that arrives while the child runs is delivered at the END of that
 * child's turn as the next input of a fresh child in the same run (pi
 * delivers at the next tool boundary — same visible outcome, no mid-turn
 * injection into an undocumented queue). A cleanly posed question ends
 * the run (finishTurn → PostToolBatch stop); an abort kills the child and
 * ends the partial message with stopReason "aborted".
 */
import type { AgentEvent, AgentMessage, AgentTool, FinishTurn, PrepareRequest, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type AssistantMessage, type ClientIdentity, type ImageContent, type Message, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ClaudeLocalScope, ClaudeLocalSystemPromptMode, ClaudeLocalUsageReport } from "../../core/contracts/claude-local.ts";
import type { LiveAgent } from "../live-agent.ts";
import type { AdmissionScope, NoDispatchKind, SubscriptionDispatchLifecycle } from "../subscription-request-cycle.ts";
import { markUnadmittedUsage } from "../subscription-request-cycle.ts";
import * as bridge from "./bridge.ts";
import type { ClaudeLocalLaunch } from "./bridge.ts";
import { withoutStderr } from "./launch.ts";
import { claudeLocalError, runClaudeTurn } from "./run.ts";
import { loadClaudeQuery, type ClaudeQuery, type SDKMessage } from "./sdk.ts";
import { emptyAssistant } from "./stream-mapper.ts";
import { flattenTranscript } from "./transcript.ts";

/** Everything the adapter reads from the route's runtime; the bridge in
 *  production, a fake in tests. */
export interface ClaudeLocalRuntime {
	launch(): ClaudeLocalLaunch | undefined;
	systemPromptMode(): ClaudeLocalSystemPromptMode;
	scope(selectedModelId: string): ClaudeLocalScope;
	admissionScope(scope: ClaudeLocalScope): AdmissionScope;
	scopeCurrent(scope: ClaudeLocalScope): boolean;
	backgroundAllowed(): boolean;
	abortController(background: boolean): { controller: AbortController; release(): void };
	denial(scope: ClaudeLocalScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): NoDispatchKind;
	noteUsage(report: ClaudeLocalUsageReport): void;
	/** A turn found Claude Code set up to bill an API key (system/init):
	 *  mark the route not-ready until the next probe. */
	noteApiKeySource?(source: string): void;
	query(): Promise<ClaudeQuery>;
}
export const productionRuntime: ClaudeLocalRuntime = {
	launch: bridge.claudeLocalLaunch,
	systemPromptMode: bridge.claudeLocalSystemPromptMode,
	scope: bridge.claudeLocalScope,
	admissionScope: bridge.claudeLocalAdmissionScope,
	scopeCurrent: bridge.claudeLocalScopeCurrent,
	backgroundAllowed: bridge.claudeLocalBackgroundAllowed,
	abortController: bridge.claudeLocalAbortController,
	denial: bridge.claudeLocalDenial,
	noteUsage: bridge.noteClaudeLocalUsage,
	noteApiKeySource: bridge.noteClaudeLocalApiKeySource,
	query: () => loadClaudeQuery(),
};

export interface ClaudeLocalAgentOptions {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	finishTurn?: FinishTurn;
	prepareRequest?: PrepareRequest;
	/** Whether the next dispatch is background (automatic) work. */
	purpose?: () => boolean;
	lifecycle?: SubscriptionDispatchLifecycle;
	runtime?: ClaudeLocalRuntime;
	/** Parity with pi's Agent (tests pin both): the app identity and the chat id. */
	identity?: ClientIdentity;
	sessionId?: string;
	/** The raw-wire recorder (LH_PROVIDER_EVENTS): every raw SDK message of
	 *  the run, with the model it served — pi's onProviderStreamEvent shape. */
	onProviderEvent?: (message: SDKMessage, model: Model<any>) => void;
}

type Listener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export class ClaudeLocalAgent implements LiveAgent {
	readonly state: LiveAgent["state"];
	/** pi parity: the identity and session id the pi Agent would carry (no
	 *  wire use here — Claude Code sends its own identity). */
	readonly identity?: ClientIdentity;
	readonly sessionId?: string;
	private readonly listeners = new Set<Listener>();
	private readonly steering: AgentMessage[] = [];
	private readonly options: ClaudeLocalAgentOptions;
	private readonly runtime: ClaudeLocalRuntime;
	private active?: { abort: AbortController; promise: Promise<void> };

	constructor(options: ClaudeLocalAgentOptions) {
		this.options = options;
		this.runtime = options.runtime ?? productionRuntime;
		this.identity = options.identity;
		this.sessionId = options.sessionId;
		const system = createInitialSystemMessage(options.systemPrompt, options.tools.map(toToolDeclaration));
		const messages = options.messages[0] && (options.messages[0] as { role?: string }).role === "system" ? [...options.messages] : [...(system ? [system] : []), ...options.messages];
		this.state = { systemPrompt: options.systemPrompt, model: options.model, thinkingLevel: options.thinkingLevel, tools: [...options.tools], messages };
	}
	subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	steer(message: AgentMessage): void { this.steering.push(message); }
	clearSteeringQueue(): void { this.steering.length = 0; }
	abort(): void { this.active?.abort.abort(); }
	waitForIdle(): Promise<void> { return this.active?.promise ?? Promise.resolve(); }
	get signal(): AbortSignal | undefined { return this.active?.abort.signal; }

	/** pi parity: append the prompt message(s) and run. */
	async prompt(input: AgentMessage | AgentMessage[] | string, images?: ImageContent[]): Promise<void> {
		if (this.active) throw new Error("Agent is already processing a prompt. Use steer() to queue messages, or wait for completion.");
		const messages: AgentMessage[] = Array.isArray(input) ? input : typeof input !== "string" ? [input] : [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }];
		this.state.messages.push(...messages);
		await this.continue();
	}
	async continue(): Promise<void> {
		if (this.active) throw new Error("Agent is already processing. Wait for completion before continuing.");
		const last = this.state.messages[this.state.messages.length - 1] as { role?: string } | undefined;
		if (!last || this.state.messages.every((m) => (m as { role?: string }).role === "system")) throw new Error("No messages to continue from");
		if (last.role !== "user" && last.role !== "toolResult" && last.role !== "custom") throw new Error(`Cannot continue from message role: ${last.role}`);
		const abort = new AbortController();
		const promise = this.run(abort.signal).finally(() => { this.active = undefined; });
		this.active = { abort, promise };
		await promise;
	}

	private async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
		for (const listener of [...this.listeners]) {
			try { await listener(event, signal); } catch (error) { console.error("[claude-local] listener failed:", error); }
		}
	}

	private async run(signal: AbortSignal): Promise<void> {
		const { options } = this;
		const emit = (event: AgentEvent) => this.emit(event, signal);
		await emit({ type: "agent_start" });
		for (;;) {
			await emit({ type: "turn_start" });
			// Steering (pi's start-of-turn poll, "all" mode): record and announce
			// every queued message before the request.
			for (const message of this.steering.splice(0)) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				this.state.messages.push(message);
			}
			if (options.prepareRequest) {
				const update = await options.prepareRequest({ context: { messages: this.state.messages, tools: this.state.tools }, model: this.state.model, thinkingLevel: this.state.thinkingLevel }, signal);
				if (update?.model) this.state.model = update.model;
				if (update?.thinkingLevel) this.state.thinkingLevel = update.thinkingLevel;
			}
			const outcome = await this.turn(signal, emit);
			if (outcome === "end" || signal.aborted) break;
			if (this.steering.length === 0) break;
		}
		await emit({ type: "agent_end", messages: [...this.state.messages] });
	}

	/** One Claude Code turn. Returns "end" when the run must stop. */
	private async turn(signal: AbortSignal, emit: (event: AgentEvent) => Promise<void>): Promise<"end" | "continue"> {
		const { options, runtime } = this;
		const model = this.state.model;
		const background = options.purpose?.() ?? false;
		const { controller, release } = runtime.abortController(background);
		const combined = AbortSignal.any([signal, controller.signal]);
		let scope: ClaudeLocalScope | undefined;
		let committed = false;
		// The failure path: an assistant error message (pi's hard exit).
		const fail = async (message: string, reason: "error" | "aborted" = "error") => {
			// The raw cause goes to the server log (the learner sees the masked text).
			if (reason === "error") console.error(`[claude-local] turn failed: ${withoutStderr(message)}`);
			const error: AssistantMessage = { ...emptyAssistant(model, reason), thinkingLevel: this.state.thinkingLevel, errorMessage: claudeLocalError(message) };
			if (!committed) { markUnadmittedUsage(error.usage); options.lifecycle?.noDispatch(runtime.denial(scope, controller, signal.aborted, background)); }
			await emit({ type: "message_start", message: error });
			this.state.messages.push(error);
			await emit({ type: "message_end", message: error });
			await options.finishTurn?.({ message: error, toolResults: [], context: { messages: this.state.messages, tools: this.state.tools }, newMessages: [] }, signal);
			await emit({ type: "turn_end", message: error, toolResults: [] });
			return "end" as const;
		};
		try {
			const launch = runtime.launch();
			if (!launch) return await fail("Local Claude is not ready (model catalog unavailable)");
			try { scope = runtime.scope(model.id); } catch (error) { return await fail(error instanceof Error ? error.message : "model catalog"); }
			options.lifecycle?.captured(runtime.admissionScope(scope));
			if (background && !runtime.backgroundAllowed()) return await fail("background use disabled");
			if (combined.aborted) return await fail("aborted", "aborted");
			const llm = await options.convertToLlm(this.state.messages);
			const blocks = flattenTranscript(llm);
			const query = await runtime.query();
			let current: AssistantMessage | undefined;
			let streamed = false;
			const results: ToolResultMessage[] = [];
			let callsExpected = 0;
			let lastDecision: "end" | "continue" | undefined;
			type ToolEvent = Extract<Awaited<ReturnType<typeof runClaudeTurn>> extends AsyncGenerator<infer E> ? E : never, { type: "tool_start" | "tool_end" }>;
			/** Tool events not yet dispatched: they belong to a message that has
			 *  not ended yet (Claude Code starts a call as soon as its block
			 *  completes, and the SDK's control channel can run a whole batch
			 *  before the consumer reads the message it belongs to). */
			const heldTools: ToolEvent[] = [];
			/** pi's order: a call's events follow its own message's message_end and
			 *  attach to that message's batch — never to an earlier message. */
			const belongsToCurrent = (event: ToolEvent) => !!current && current.stopReason !== "pending"
				&& (current.content.some((c) => c.type === "toolCall" && c.id === event.toolCallId) || (callsExpected > 0 && results.length < callsExpected));
			/** Dispatch the held events that belong to the current message (all of
			 *  them when `all`: the turn is over and nothing else can claim them). */
			const releaseTools = async (all = false) => {
				for (const event of heldTools.splice(0)) {
					if (all || belongsToCurrent(event)) await onToolEvent(event);
					else heldTools.push(event);
				}
			};
			/** The calls that got their tool_execution_start. */
			const startedCalls = new Set<string>();
			/** Synthesize the missing results of an unfinished batch and close it. */
			const closeBatch = async (message: AssistantMessage, text: string) => {
				for (const call of message.content.filter((c) => c.type === "toolCall")) {
					if (results.some((r) => r.toolCallId === call.id)) continue;
					// pi always announces a call before its end, even a call that never ran.
					if (!startedCalls.has(call.id)) { startedCalls.add(call.id); await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }); }
					await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: { content: [{ type: "text", text }], details: {} }, isError: true });
					results.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], details: {}, isError: true, timestamp: Date.now() });
				}
				lastDecision = await finishBatch(message, results.splice(0));
			};
			const onToolEvent = async (event: ToolEvent) => {
				if (event.type === "tool_start") {
					startedCalls.add(event.toolCallId);
					await emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
					return;
				}
				await emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, durationMs: event.durationMs });
				results.push({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, content: event.result.content ?? [], details: event.result.details as ToolResultMessage["details"], isError: event.isError, durationMs: event.durationMs, timestamp: Date.now() });
				if (current && callsExpected > 0 && results.length >= callsExpected) {
					lastDecision = await finishBatch(current, results.splice(0));
					callsExpected = 0;
				}
			};
			const finishBatch = async (message: AssistantMessage, toolResults: ToolResultMessage[]) => {
				// pi: tool-result message artifacts in assistant source order, then finishTurn, then turn_end.
				const order = new Map(message.content.filter((c) => c.type === "toolCall").map((c, index) => [c.id, index]));
				const ordered = [...toolResults].sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0));
				for (const result of ordered) {
					await emit({ type: "message_start", message: result });
					this.state.messages.push(result);
					await emit({ type: "message_end", message: result });
				}
				const decision = await options.finishTurn?.({ message, toolResults: ordered, context: { messages: this.state.messages, tools: this.state.tools }, newMessages: [] }, signal);
				await emit({ type: "turn_end", message, toolResults: ordered });
				return decision?.action === "end" ? "end" : "continue";
			};
			for await (const event of runClaudeTurn({
				query, launch, model, thinkingLevel: this.state.thinkingLevel,
				systemPrompt: this.state.systemPrompt, systemPromptMode: runtime.systemPromptMode(),
				blocks, tools: this.state.tools, signal: combined,
				...(options.onProviderEvent ? { onProviderEvent: (message: SDKMessage) => options.onProviderEvent!(message, model) } : {}),
				onApiKeySource: (source) => runtime.noteApiKeySource?.(source),
				beforeDispatch: () => { if (!runtime.scopeCurrent(scope!)) throw new Error("connection changed"); options.lifecycle?.beforeDispatch(runtime.admissionScope(scope!)); committed = true; },
				shouldStopAfterBatch: (calls) => {
					// pi's stop rules, in pi's precedence: the batch rule first — when
					// every result terminates the run ends, whatever the stopper says —
					// then the app's finishTurn (the question stopper).
					if (calls.length > 0 && calls.every((call) => call.terminate)) return true;
					const stopper = options.finishTurn;
					if (!stopper) return false;
					// Decided from the hook's own data only: the SDK runs this hook
					// ahead of the messages this loop has read, so the consumer-side
					// `current` may not be the batch's message yet. The probe message
					// is rebuilt from the batch's calls (Claude Code's ids, bare names,
					// the arguments the bridge received).
					const message: AssistantMessage = { ...emptyAssistant(model, "toolUse"), content: calls.map((call) => ({ type: "toolCall" as const, id: call.toolCallId, name: call.toolName, arguments: (call.args ?? {}) as Record<string, never> })) };
					// finishTurn is async in pi; the batch hook needs a sync answer. The
					// app's stoppers are pure (teacher-agent makeQuestionStopper), so a
					// synchronous probe with the batch's results is exact.
					const probe = stopper({ message, toolResults: calls.map((call) => ({ role: "toolResult", toolCallId: call.toolCallId, toolName: call.toolName, content: [], isError: call.isError, timestamp: Date.now() })), context: { messages: this.state.messages, tools: this.state.tools }, newMessages: [] }, signal);
					return !!probe && typeof probe === "object" && "action" in probe && (probe as { action?: string }).action === "end";
				},
			})) {
				if (event.type === "assistant") {
					const e = event.event;
					if (e.type === "start") {
						// A batch the child never completed (a denied call, a dropped
						// result) closes with error results before the next message.
						if (current && callsExpected > 0 && results.length < callsExpected) { await closeBatch(current, "The tool call was not completed."); callsExpected = 0; }
						// A new model call. pi emits turn_start before every request after
						// the first (the run's own turn_start preceded this turn), and the
						// admission cycle re-arms its hold on every turn_start — so every
						// in-child request re-commits exactly as pi's per-request dispatch
						// would (the first one committed through the runner's beforeDispatch).
						if (streamed) {
							await emit({ type: "turn_start" });
							if (scope && options.lifecycle) {
								if (!runtime.scopeCurrent(scope)) throw new Error("connection changed");
								options.lifecycle.captured(runtime.admissionScope(scope));
								options.lifecycle.beforeDispatch(runtime.admissionScope(scope));
							}
						}
						// Defensive: a partial that never ended is replaced, never doubled.
						if (current && current.stopReason === "pending") this.state.messages.splice(this.state.messages.lastIndexOf(current as AgentMessage), 1);
						current = e.partial;
						streamed = true;
						this.state.messages.push(current);
						await emit({ type: "message_start", message: { ...current } });
					} else if (e.type === "done" || e.type === "error") {
						const final = e.type === "done" ? e.message : e.error;
						// pi records the requested level on every final message.
						final.thinkingLevel ??= this.state.thinkingLevel;
						if (e.type === "error" && !committed) { markUnadmittedUsage(final.usage); options.lifecycle?.noDispatch(runtime.denial(scope, controller, signal.aborted, background)); }
						if (e.type === "error") final.errorMessage = claudeLocalError(final.errorMessage ?? "failed");
						// Replace the streaming partial in place (pi: a message that never
						// streamed gets its message_start now). Only a partial is replaced:
						// a message that already ended is never overwritten by the next one.
						const index = current && current.stopReason === "pending" ? this.state.messages.lastIndexOf(current as AgentMessage) : -1;
						if (index >= 0) this.state.messages[index] = final;
						else { await emit({ type: "message_start", message: { ...final } }); this.state.messages.push(final); }
						current = final;
						await emit({ type: "message_end", message: final });
						callsExpected = final.content.filter((c) => c.type === "toolCall").length;
						if (final.stopReason === "error" || final.stopReason === "aborted") {
							await options.finishTurn?.({ message: final, toolResults: [], context: { messages: this.state.messages, tools: this.state.tools }, newMessages: [] }, signal);
							await emit({ type: "turn_end", message: final, toolResults: [] });
							return "end";
						}
						if (callsExpected === 0) lastDecision = await finishBatch(final, []);
						// Tool events that arrived before this message ended replay now, in
						// pi's order: message_end before any tool_execution_*; the batch
						// closes as soon as its last result is in.
						await releaseTools();
					} else if (current) {
						current = e.partial;
						const index = this.state.messages.length - 1;
						this.state.messages[index] = current;
						// pi stops reading the stream at abort; the child needs ~2 s to
						// die, so its trailing chunks must not reach the views.
						if (!signal.aborted) await emit({ type: "message_update", message: { ...current }, assistantMessageEvent: e });
					}
				} else if (event.type === "tool_start" || event.type === "tool_end") {
					if (heldTools.length === 0 && belongsToCurrent(event)) await onToolEvent(event);
					else heldTools.push(event);
				} else if (event.type === "usage") {
					runtime.noteUsage(event.report);
				} else if (event.type === "result") {
					await releaseTools(true);
					// Calls the child never answered (an abort mid-batch): close the batch.
					if (current && callsExpected > 0 && results.length < callsExpected) {
						await closeBatch(current, combined.aborted ? "Operation aborted" : "The tool call was not completed.");
						callsExpected = 0;
					}
					if (!streamed && event.ok) {
						// Nothing streamed, nothing failed: an empty turn is still a message.
						const empty: AssistantMessage = { ...emptyAssistant(model, "stop") };
						await emit({ type: "message_start", message: empty }); this.state.messages.push(empty); await emit({ type: "message_end", message: empty });
						lastDecision = await finishBatch(empty, []);
					}
					if (lastDecision === "end" || event.terminalReason === "hook_stopped" || event.terminalReason === "stop_hook_prevented") return "end";
					// A failed turn is terminal. The failure already ended the run when it
					// arrived as the message in flight (the error branch above) or as
					// Claude Code's own error message; otherwise it is reported here.
					// An abort — the caller's or the route's own (a re-probe, consent
					// off) — is a cancelled turn: the masked cancelled message, then end.
					if (!event.ok) return current?.stopReason === "error" || event.failedAssistant ? "end" : combined.aborted ? await fail("aborted", "aborted") : await fail(event.errors.join("; ") || "failed", "error");
					return combined.aborted ? "end" : "continue";
				}
			}
			return "continue";
		} catch (error) {
			return await fail(error instanceof Error ? error.message : String(error), signal.aborted ? "aborted" : "error");
		} finally {
			release();
		}
	}
}
