/**
 * One Claude Code TURN as a stream of pi-shaped events (Local Claude
 * route). `runClaudeTurn` starts the user's own `claude` through the Agent
 * SDK with the flattened transcript as its only input, serves the app's
 * tools through the in-process bridge (tools.ts) and translates everything
 * the child reports into the vocabulary the rest of the app already
 * speaks: pi AssistantMessageEvents for the model's messages, tool
 * execution start/end for the bridge's calls, the turn's result.
 *
 * Both consumers ride this one runner: the ClaudeLocalAgent (agent.ts:
 * lesson turns with tools) and the tool-less StreamFunction (stream.ts:
 * compaction summaries). What is fixed here, for every call:
 *
 *   - `tools: []` (no Claude Code built-ins), `settingSources: []` (no
 *     CLAUDE.md, hooks or MCP config of the user's), `strictMcpConfig`,
 *     `persistSession: false` (nothing under ~/.claude/projects), the
 *     scrubbed env and the app-owned cwd (launch.ts);
 *   - the system prompt is the app's composed prompt — as a custom string
 *     (default) or appended to the `claude_code` preset (the settings
 *     switch) — never empty, never Claude Code's alone;
 *   - permissions stay in default mode with ONLY the app's tool server
 *     pre-approved (allowedTools `mcp__learnharness`); a PreToolUse hook
 *     denies anything else by name (defence in depth), and a PostToolBatch
 *     hook stops the loop when a batch terminates (a cleanly posed
 *     question) — pi's finishTurn, in CC terms;
 *   - `total_cost_usd` is never read; `rate_limit_event` is reported for
 *     the status card, never persisted.
 */
import type { AgentToolResult, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { CLAUDE_LOCAL, type ClaudeLocalSystemPromptMode, type ClaudeLocalUsageReport } from "../../core/contracts/claude-local.ts";
import type { ClaudeLocalLaunch } from "./bridge.ts";
import { claudeLaunchOptions } from "./launch.ts";
import { ClaudeStreamMapper } from "./stream-mapper.ts";
import { createToolBridge } from "./tools.ts";
import { toolPrefixNote } from "./transcript.ts";
import type { ClaudeQuery, ClaudeQueryOptions, HookCallback, SDKUserMessage } from "./sdk.ts";

export type ClaudeTurnEvent =
	| { type: "assistant"; event: AssistantMessageEvent }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; args: unknown; result: AgentToolResult<unknown>; isError: boolean; durationMs: number }
	| { type: "usage"; report: ClaudeLocalUsageReport }
	/** Claude Code finished the turn (end of its loop): the last assistant
	 *  message's stop reason decides what the agent does next. */
	| { type: "result"; ok: boolean; errors: string[]; terminalReason?: string };

export interface ClaudeTurnParams {
	query: ClaudeQuery;
	launch: ClaudeLocalLaunch;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	systemPromptMode: ClaudeLocalSystemPromptMode;
	/** The flattened transcript: text blocks of ONE user message. */
	blocks: string[];
	tools: AgentTool<any>[];
	signal: AbortSignal;
	/** The batch-level stop rule (pi's finishTurn, applied once per completed
	 *  tool batch): return true to end the run after this batch. */
	shouldStopAfterBatch?: (calls: { toolCallId: string; toolName: string; isError: boolean; terminate: boolean }[]) => boolean;
	/** Called right before the child is spawned (the admission commit). */
	beforeDispatch?: () => void;
	/** The child's stderr tail (diagnostics in error messages). */
	onStderr?: (line: string) => void;
}

/** pi thinking level → the SDK's effort + thinking mode. */
export function thinkingOptions(level: ThinkingLevel): Pick<ClaudeQueryOptions, "effort" | "thinking"> {
	if (level === "off") return { thinking: { type: "disabled" } };
	const effort = level === "minimal" ? "low" : level;
	// Summarized thinking: the transcript shows thinking the way pi's own
	// Anthropic route does (Claude Code omits it by default).
	return { effort, thinking: { type: "adaptive", display: "summarized" } };
}

/** The system prompt option for the mode. */
export function systemPromptOption(prompt: string, mode: ClaudeLocalSystemPromptMode, withTools: boolean): ClaudeQueryOptions["systemPrompt"] {
	const text = withTools ? `${prompt}\n\n---\n\n${toolPrefixNote(CLAUDE_LOCAL.mcpServerName)}` : prompt;
	return mode === "preset" ? { type: "preset", preset: "claude_code", append: text } : text;
}

/** The prompt iterable: one user message now; closes when the run ends. */
async function* promptOf(blocks: string[], signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
	yield { type: "user", message: { role: "user", content: blocks.map((text) => ({ type: "text" as const, text })) }, parent_tool_use_id: null };
	// Keep the stream open until the turn ends or the run aborts: closing
	// stdin early would end the child before its result arrives.
	await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
}

export const TOOL_PREFIX = `mcp__${CLAUDE_LOCAL.mcpServerName}__`;

/** Drive one turn; yields pi-shaped events; ends after the result (or an
 *  error/abort, surfaced as the assistant `error` event, then a result). */
export async function* runClaudeTurn(params: ClaudeTurnParams): AsyncGenerator<ClaudeTurnEvent> {
	const { model, signal } = params;
	const serverName = CLAUDE_LOCAL.mcpServerName;
	// The run's own controller: our caller's abort and the SDK's close both route through it.
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	if (signal.aborted) abort.abort(); else signal.addEventListener("abort", onAbort, { once: true });
	// Events from the tool bridge (another async context) are queued here and
	// interleaved with the SDK's own messages in arrival order.
	const queue: ClaudeTurnEvent[] = [];
	let wake: (() => void) | undefined;
	const push = (event: ClaudeTurnEvent) => { queue.push(event); wake?.(); };
	// Correlation for tool_use ids: the streamed tool_use blocks of the current message.
	let mapper = new ClaudeStreamMapper(model, serverName, params.thinkingLevel);
	const streamedCalls: { id: string; name: string; args: unknown; started: boolean }[] = [];
	const batch: { toolCallId: string; toolName: string; isError: boolean; terminate: boolean }[] = [];
	let stopRequested = false;
	let minted = 0;
	const deepEqual = (a: unknown, b: unknown) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
	const bridge = params.tools.length > 0 ? createToolBridge(params.tools, {
		signal: abort.signal,
		toolUseIdFor: (name, args, meta) => {
			const claim = (entry: { id: string; started: boolean } | undefined) => { if (entry) entry.started = true; return entry?.id; };
			if (meta) { const known = streamedCalls.find((c) => c.id === meta); if (known) known.started = true; return meta; }
			return claim(streamedCalls.find((c) => !c.started && c.name === name && deepEqual(c.args, args)))
				?? claim(streamedCalls.find((c) => !c.started && c.name === name))
				?? `${serverName}-${++minted}`;
		},
		onStart: (call) => push({ type: "tool_start", ...call }),
		onEnd: (call) => {
			batch.push({ toolCallId: call.toolCallId, toolName: call.toolName, isError: call.isError, terminate: call.result.terminate === true });
			push({ type: "tool_end", ...call });
		},
	}) : undefined;
	const hooks: NonNullable<ClaudeQueryOptions["hooks"]> = {
		PreToolUse: [{ hooks: [(async (input, toolUseId) => {
			const { tool_name: name = "", tool_input: args } = input as { tool_name?: string; tool_input?: unknown };
			if (name.startsWith(TOOL_PREFIX)) return {};
			// Denied by name: the record still shows the call the model made and
			// an error result for it (pi's blocked-tool shape).
			const reason = `Only LearnHarness tools (${TOOL_PREFIX}*) are available in this lesson.`;
			const id = toolUseId ?? `${serverName}-denied-${++minted}`;
			push({ type: "tool_start", toolCallId: id, toolName: name, args });
			push({ type: "tool_end", toolCallId: id, toolName: name, args, result: { content: [{ type: "text", text: reason }], details: {} }, isError: true, durationMs: 0 });
			return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
		}) satisfies HookCallback] }],
		PostToolBatch: [{ hooks: [(async () => {
			// The batch rule runs once per completed batch (pi's finishTurn):
			// a terminating batch ends Claude Code's loop here, before its
			// next model call.
			const calls = batch.splice(0);
			if (calls.length > 0 && params.shouldStopAfterBatch?.(calls)) { stopRequested = true; return { continue: false, stopReason: "The lesson turn ends here: the learner answers next." }; }
			return {};
		}) satisfies HookCallback] }],
	};
	let stderr = "";
	const options: ClaudeQueryOptions = {
		...claudeLaunchOptions(params.launch),
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		persistSession: false,
		// Permissions: ONLY the app's own tool server is pre-approved (the
		// `mcp__<server>` prefix form); anything else would need a prompt there
		// is no tool for, and the PreToolUse hook denies it by name anyway. No
		// bypass flag — Claude Code refuses that under root and it grants more
		// than this route needs.
		permissionMode: "default",
		...(bridge ? { allowedTools: [`mcp__${serverName}`] } : {}),
		includePartialMessages: true,
		model: model.id,
		...thinkingOptions(params.thinkingLevel),
		systemPrompt: systemPromptOption(params.systemPrompt, params.systemPromptMode, params.tools.length > 0),
		...(bridge ? { mcpServers: { [serverName]: bridge } } : {}),
		hooks,
		abortController: abort,
		stderr: (data) => { stderr = (stderr + data).slice(-2000); params.onStderr?.(data); },
	};
	params.beforeDispatch?.();
	let handle: ReturnType<ClaudeQuery>;
	try { handle = params.query({ prompt: promptOf(params.blocks, abort.signal), options }); }
	catch (error) {
		signal.removeEventListener("abort", onAbort);
		yield { type: "assistant", event: mapper.finish({ reason: "error", message: error instanceof Error ? error.message : String(error) }) };
		yield { type: "result", ok: false, errors: [error instanceof Error ? error.message : String(error)] };
		return;
	}
	// Pump the SDK's iterator into the same queue as the bridge's events.
	let done = false;
	let failure: unknown;
	const pumping = (async () => {
		try { for await (const message of handle) push({ type: "sdk", message } as unknown as ClaudeTurnEvent); }
		catch (error) { failure = error; }
		finally { done = true; wake?.(); }
	})();
	let sawResult = false;
	const seenAssistantIds = new Set<string>();
	try {
		while (!done || queue.length > 0) {
			if (queue.length === 0) { await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined; continue; }
			const next = queue.shift()!;
			// pi's abort semantics: the moment the run is aborted, the message in
			// flight ends as "aborted" and nothing already buffered reaches the
			// views (the child is killed by the SDK's close sequence regardless).
			if (signal.aborted && !sawResult) {
				sawResult = true;
				if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish({ reason: "aborted", message: "Operation aborted" }) };
				yield { type: "result", ok: false, errors: [] };
				break;
			}
			if (next.type !== ("sdk" as never)) { yield next; continue; }
			const message = (next as unknown as { message: import("./sdk.ts").SDKMessage }).message;
			switch (message.type) {
				case "stream_event": {
					if (message.parent_tool_use_id) break; // sub-agent output never reaches the lesson
					if (message.event.type === "message_start") { mapper = new ClaudeStreamMapper(model, serverName, params.thinkingLevel); streamedCalls.length = 0; seenAssistantIds.add(message.event.message.id); }
					for (const event of mapper.handle(message.event)) {
						if (event.type === "toolcall_end") streamedCalls.push({ id: event.toolCall.id, name: event.toolCall.name, args: event.toolCall.arguments, started: false });
						yield { type: "assistant", event };
					}
					if (message.event.type === "message_stop") yield { type: "assistant", event: mapper.finish() };
					break;
				}
				case "assistant": {
					// Claude Code also sends the full message, one content block at a
					// time, BEFORE the stream's message_stop — a duplicate whenever the
					// stream was delivered (its id was seen at message_start). Only a
					// message that never streamed is rebuilt from here.
					if (message.parent_tool_use_id || seenAssistantIds.has(message.message.id) || (mapper.started && !mapper.stopped)) break;
					const fallback = new ClaudeStreamMapper(model, serverName, params.thinkingLevel);
					for (const event of fallback.handle({ type: "message_start", message: { ...message.message, content: [] } })) yield { type: "assistant", event };
					for (const [index, block] of message.message.content.entries()) {
						for (const event of fallback.handle({ type: "content_block_start", index, content_block: block as never })) yield { type: "assistant", event };
						for (const event of fallback.handle({ type: "content_block_stop", index })) yield { type: "assistant", event };
					}
					fallback.handle({ type: "message_delta", delta: { stop_reason: message.message.stop_reason, stop_sequence: null, container: null, stop_details: null }, usage: message.message.usage as never, context_management: null });
					fallback.handle({ type: "message_stop" });
					seenAssistantIds.add(message.message.id);
					yield { type: "assistant", event: fallback.finish() };
					break;
				}
				case "rate_limit_event": {
					const info = message.rate_limit_info;
					yield { type: "usage", report: { status: info.status, ...(info.utilization !== undefined ? { utilization: info.utilization } : {}), ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}), ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}), ...(info.isUsingOverage !== undefined ? { isUsingOverage: info.isUsingOverage } : {}), observedAt: Date.now() } };
					break;
				}
				case "result": {
					sawResult = true;
					const errors = message.subtype === "success" ? (message.is_error ? [message.result] : []) : message.errors;
					if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish(errors.length ? { reason: "error", message: errors.join("; ") } : undefined) };
					yield { type: "result", ok: errors.length === 0 && !message.is_error, errors, ...(message.terminal_reason ? { terminalReason: message.terminal_reason } : {}) };
					// The turn is over: release the prompt stream so the child exits.
					abort.abort();
					break;
				}
				default: break;
			}
		}
		if (!sawResult) {
			const cause = failure instanceof Error ? failure.message : failure ? String(failure) : signal.aborted ? "aborted" : "Claude Code exited without a result";
			const reason = signal.aborted ? "aborted" : "error";
			const detail = stderr.trim() ? `${cause} — ${stderr.trim().split("\n").slice(-3).join(" ")}` : cause;
			if (reason === "error") console.error(`[claude-local] Claude Code turn ended without a result: ${detail}`);
			if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish({ reason, message: detail }) };
			else if (reason === "error" && !stopRequested) {
				mapper = new ClaudeStreamMapper(model, serverName, params.thinkingLevel);
				yield { type: "assistant", event: mapper.finish({ reason, message: detail }) };
			}
			yield { type: "result", ok: false, errors: reason === "aborted" ? [] : [detail] };
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		abort.abort();
		try { handle.close(); } catch { /* already gone */ }
		await pumping.catch(() => undefined);
	}
}

/** The user-facing wording for a failed turn (masked like the other
 *  subscription routes; always says no API key was involved). */
export function claudeLocalError(message: string): string {
	const suffix = " No API key was used.";
	if (/aborted|cancel/i.test(message)) return `Local Claude request cancelled.${suffix}`;
	if (/rate.?limit|usage limit|429|exceeded|out of credits|extra usage/i.test(message)) return `Your Claude plan's usage limit was reached. Wait for the window to reset or check your plan at claude.ai, then retry.${suffix}`;
	if (/authentication|not logged in|login|sign.?in|credential|401|403|oauth/i.test(message)) return `Claude Code is not signed in. Run \`claude\` in a terminal, sign in with your Claude plan, then re-check in Providers.${suffix}`;
	if (/ENOENT|not found|could not be started|spawn|exited with code/i.test(message)) return `Claude Code could not be started. Re-check the install in Providers.${suffix}`;
	if (/catalog|model/i.test(message)) return `The selected model is not available from your Claude Code. Re-check in Providers and choose an available model.${suffix}`;
	if (/background/i.test(message)) return `Local Claude background use is off in this app. Enable it in Providers to run this work.${suffix}`;
	return `Local Claude request failed. Check Claude Code and your plan, then retry.${suffix}`;
}

export type { AssistantMessage };
