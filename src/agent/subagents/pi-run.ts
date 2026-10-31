import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "../models.ts";
import { usageWasAdmitted } from "../subscription-request-cycle.ts";
import { providerEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import type { ModelRole } from "../../../config.ts";

/**
 * The shared sub-agent runner (docs/pi-engine-swap.md §6): one helper every
 * background agent (researcher, demo-builder, visual-maker, extractor,
 * auditor) runs on — a stateless pi Agent built per call, driven to
 * completion, with the seams the job runner and the money channel need.
 *
 * Error semantics mirror the old ToolLoopAgent.generate: provider/loop
 * failures THROW (pi encodes them in the stream; this helper surfaces
 * them), and an abort throws an AbortError so every existing
 * `signal.aborted` early-return keeps working unchanged.
 */

export interface SubagentRunOptions {
	/** Named core role for engine resolution and opt-in captures. Optional when
	 * an explicit engine is supplied; plugin runs do not invent core roles. */
	role?: ModelRole;
	/** Explicit engine (also the off-network test seam); required without a role. */
	engine?: PiEngine;
	systemPrompt: string;
	/** Initial transcript (continuation semantics: ends user / toolResult). */
	messages?: AgentMessage[];
	/** Fresh-run prompt text (mutually exclusive with a continuation). */
	prompt?: string;
	/** Max model calls (the old stepCountIs safety net). */
	maxTurns: number;
	/** Abort mid-model-call (the real-kill semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	/** Activity line per tool execution (job record progress). */
	onToolStart?: (toolName: string, args: unknown) => void;
	/** Awaited native checkpoint barrier, before other observers or tool execution. */
	onEvent?: (event: AgentEvent) => void | Promise<void>;
	/** Guard immediately before each native provider request. */
	beforeRequest?: () => void | Promise<void>;
	/** Per completed assistant message (extraction's step log). */
	onAssistantMessage?: (message: AssistantMessage, step: number) => void;
	/** Extra stop rule (extractor: stop after a clean submit). */
	shouldStop?: (message: AssistantMessage, toolResults: ToolResultMessage[]) => boolean;
	/** Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream
	 *  events append to data/debug/provider-events/<chatId>.jsonl (context
	 *  "job:<role>"). Absent or env-off → no observer.
	 *  Also identifies the source in opt-in LH_BACKGROUND_CAPTURE captures. */
	chatId?: string;
}

export interface SubagentRunResult {
	/** The messages this run added (assistant + tool results). */
	newMessages: AgentMessage[];
	/** The final assistant text (the deliverable). */
	text: string;
}

export function subagentEngine(role: ModelRole | undefined, override?: PiEngine): PiEngine {
	// BYOK (owner, 2026-09-22): no factory pins — the override is the only
	// real path (the runner injects settings-resolved engines); a missed
	// injection hits the honest thrower in models.ts instead of a guess.
	if (override) return override;
	if (!role) throw new Error("An explicit engine or configured model role is required");
	return piEngineFor(role);
}

export async function runSubagent(tools: AgentTool<any, any>[], opts: SubagentRunOptions): Promise<SubagentRunResult> {
	if (opts.abortSignal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
	const engine = subagentEngine(opts.role, opts.engine);
	let turns = 0;
	// Debug recorder (owner, 2026-10-04): raw provider events per job run.
	const providerEvents = opts.chatId && opts.role ? providerEventObserver(opts.chatId, `job:${opts.role}`) : undefined;
	const sessionId = randomUUID();
	// Captures have a core-role identity. Explicit plugin engines have no such
	// role; do not misattribute them or invent a new capture product surface.
	const capture = opts.role ? createBackgroundCapture({ role: opts.role, runId: sessionId, sourceId: opts.chatId }) : undefined;
	const agent = new Agent({
		identity: APP_IDENTITY,
		// One unsaved conversation per invocation, stable through every turn.
		sessionId,
		initialState: {
			systemPrompt: opts.systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools,
			messages: opts.messages ?? [],
		},
		streamFn: backgroundCaptureStream(engine.streamFn, capture),
		prepareRequest: async () => {
			if (opts.abortSignal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			await opts.beforeRequest?.();
		},
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		// 0.87.1: shouldStopAfterTurn → finishTurn (same call point; "end"
		// exits before the steering poll, exactly the old boolean-true).
		finishTurn: (turn) => {
			turns++;
			return turns >= opts.maxTurns || opts.shouldStop?.(turn.message, turn.toolResults) === true
				? { action: "end" }
				: undefined;
		},
	});

	const onAbort = () => agent.abort();
	opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

	const before = opts.messages?.length ?? 0;
	let step = 0;
	let errorMessage: string | undefined;
	let aborted = false;
	let runFailure: unknown;

	try {
		agent.subscribe(async (event: AgentEvent) => {
			await opts.onEvent?.(event);
			switch (event.type) {
				case "message_end":
					if ((event.message as { role?: string }).role === "assistant") {
						const m = event.message as AssistantMessage;
						capture?.reply(m);
						if (m.stopReason === "aborted") {
							// The call was cancelled — no completed step, no billed
							// usage (the abort path asserts zero steps).
								aborted = true;
							break;
						}
						if (!usageWasAdmitted(m.usage)) { if (m.stopReason === "error") errorMessage = m.errorMessage ?? "Subagent provider error"; break; }
						step++;
						opts.onUsage?.(m.usage);
						opts.onAssistantMessage?.(m, step);
						if (m.stopReason === "error") errorMessage = m.errorMessage ?? "Subagent provider error";
					} else if (event.message.role === "toolResult") {
						capture?.toolResult(event.message);
					}
					break;
				case "tool_execution_start":
					opts.onToolStart?.(event.toolName, event.args);
					break;
			}
		});
		if (opts.prompt !== undefined) await agent.prompt({
			role: "user",
			content: opts.prompt,
			timestamp: Date.now(),
		});
		else await agent.continue();
	} catch (error) {
		runFailure = error;
		throw error;
	} finally {
		opts.abortSignal?.removeEventListener("abort", onAbort);
		capture?.finish(runFailure);
	}

	if (aborted || opts.abortSignal?.aborted) {
		const err = new Error("aborted");
		err.name = "AbortError";
		capture?.finish(err);
		throw err;
	}
	if (errorMessage !== undefined) throw new Error(errorMessage);

	// 0.87.1: drop the seeded leading SystemMessage (transcript rework —
	// see ui-stream's settleWith) before slicing past the input count, or
	// the seed displaces the slice and the last INPUT message leaks in.
	const newMessages = agent.state.messages
		.filter((m) => (m as { role?: string }).role !== "system")
		.slice(before);
	const assistants = newMessages.filter((m) => (m as { role?: string }).role === "assistant") as AssistantMessage[];
	const last = assistants[assistants.length - 1];
	const text = last
		? last.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
		: "";
	return { newMessages, text };
}