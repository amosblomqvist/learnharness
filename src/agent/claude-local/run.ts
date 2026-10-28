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
import { describeFailure, errorFields, reportedApiKeySource, reportedMcpStatus, resultFields } from "./reported.ts";
import { ClaudeStreamMapper } from "./stream-mapper.ts";
import { createToolBridge } from "./tools.ts";
import { toolPrefixNote } from "./transcript.ts";
import type { ClaudeQuery, ClaudeQueryOptions, HookCallback, SDKMessage, SDKUserMessage } from "./sdk.ts";

export type ClaudeTurnEvent =
	| { type: "assistant"; event: AssistantMessageEvent }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; args: unknown; result: AgentToolResult<unknown>; isError: boolean; durationMs: number }
	| { type: "usage"; report: ClaudeLocalUsageReport }
	/** Claude Code finished the turn (end of its loop): the last assistant
	 *  message's stop reason decides what the agent does next. */
	| {
		type: "result"; ok: boolean;
		/** Claude Code's own failure text: in memory only, for the masked
		 *  wording (claudeLocalError) — never logged, never shown raw. */
		errors: string[];
		/** The failure's stable fields, rendered for the server log
		 *  (reported.ts describeFailure); never Claude Code's own text. */
		cause?: string;
		/** The failure already reached the record as an error assistant message. */ failedAssistant?: boolean; terminalReason?: string;
	};

/** One completed call of a tool batch, from the bridge's own record of it:
 *  Claude Code's tool_use id, the BARE name and the arguments it was called with. */
export interface BatchCall { toolCallId: string; toolName: string; args: unknown; isError: boolean; terminate: boolean }

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
	shouldStopAfterBatch?: (calls: BatchCall[]) => boolean;
	/** Called right before the child is spawned (the admission commit). */
	beforeDispatch?: () => void;
	/** Every raw SDK message, as it arrives (the LH_PROVIDER_EVENTS recorder). */
	onProviderEvent?: (message: SDKMessage) => void;
	/** Claude Code reported (system/init) that it would bill an API key: the
	 *  turn is refused, and the route's status is marked not-ready. */
	onApiKeySource?: (source: string) => void;
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
	// The prompt stream's own end: closed after a successful result so the
	// child sees stdin close and exits on its own (the SDK abort stays for
	// real aborts and the final cleanup).
	const promptDone = new AbortController();
	// Events from the tool bridge (another async context) are queued here and
	// interleaved with the SDK's own messages in arrival order.
	const queue: ClaudeTurnEvent[] = [];
	let wake: (() => void) | undefined;
	// An abort wakes the loop at once (an empty queue would otherwise wait
	// for the SDK to close the child's stdout).
	const onAbort = () => { abort.abort(); wake?.(); };
	if (signal.aborted) abort.abort(); else signal.addEventListener("abort", onAbort, { once: true });
	const push = (event: ClaudeTurnEvent) => { queue.push(event); wake?.(); };
	// Correlation for tool_use ids: the streamed tool_use blocks of the current message.
	let mapper = new ClaudeStreamMapper(model, serverName, params.thinkingLevel);
	const streamedCalls: { id: string; name: string; args: unknown; started: boolean }[] = [];
	const batch: BatchCall[] = [];
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
			batch.push({ toolCallId: call.toolCallId, toolName: call.toolName, args: call.args, isError: call.isError, terminate: call.result.terminate === true });
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
	const options: ClaudeQueryOptions = {
		// Isolation (tools: [], settingSources: [], strictMcpConfig,
		// persistSession: false) comes with the launch slice.
		...claudeLaunchOptions(params.launch),
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
		// No `stderr` callback: the child's stderr may carry anything Claude Code
		// prints about its login, so the app never reads, keeps or logs it.
	};
	// Aborted before the spawn: nothing is committed or started (the
	// caller's no-dispatch path reports it).
	if (signal.aborted) {
		signal.removeEventListener("abort", onAbort);
		yield { type: "result", ok: false, errors: [] };
		return;
	}
	params.beforeDispatch?.();
	/** A failure that is its own message (nothing of it streamed), announced
	 *  by its start like every message — so the consumer can never take it
	 *  for the end of the message before it. */
	const failedMessage = (reason: "error" | "aborted", message: string): ClaudeTurnEvent[] => {
		const fresh = new ClaudeStreamMapper(model, serverName, params.thinkingLevel);
		return [{ type: "assistant", event: fresh.start() }, { type: "assistant", event: fresh.finish({ reason, message }) }];
	};
	let handle: ReturnType<ClaudeQuery>;
	try { handle = params.query({ prompt: promptOf(params.blocks, AbortSignal.any([abort.signal, promptDone.signal])), options }); }
	catch (error) {
		signal.removeEventListener("abort", onAbort);
		const detail = error instanceof Error ? error.message : String(error);
		yield* failedMessage("error", detail);
		yield { type: "result", ok: false, errors: [detail], cause: describeFailure(errorFields(error)) };
		return;
	}
	// Pump the SDK's iterator into the same queue as the bridge's events.
	let done = false;
	let failure: unknown;
	const pumping = (async () => {
		try {
			for await (const message of handle) {
				if (params.onProviderEvent) { try { params.onProviderEvent(message); } catch { /* an observer never takes the run down */ } }
				push({ type: "sdk", message } as unknown as ClaudeTurnEvent);
			}
		}
		catch (error) { failure = error; }
		finally { done = true; wake?.(); }
	})();
	let sawResult = false;
	const seenAssistantIds = new Set<string>();
	/** A message rebuilt from Claude Code's `assistant` echoes (no stream
	 *  delivered); `seen` holds the blocks already added, as JSON. */
	let rebuilt: { id: string; mapper: ClaudeStreamMapper; blocks: number; seen: string[] } | undefined;
	/** Set when Claude Code reported the turn's failure as an assistant message. */
	let failedAssistant = false;
	try {
		pump: while (!done || queue.length > 0) {
			// pi's abort semantics: the moment the run is aborted, the message in
			// flight ends as "aborted" and nothing already buffered reaches the
			// views (the child is killed by the SDK's close sequence regardless).
			if (signal.aborted && !sawResult) {
				sawResult = true;
				if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish({ reason: "aborted", message: "Operation aborted" }) };
				yield { type: "result", ok: false, errors: [] };
				break;
			}
			if (queue.length === 0) { await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined; continue; }
			const next = queue.shift()!;
			if (next.type !== ("sdk" as never)) { yield next; continue; }
			const message = (next as unknown as { message: import("./sdk.ts").SDKMessage }).message;
			switch (message.type) {
				case "system": {
					// How Claude Code will bill this turn: anything but no API key is
					// refused before the first model call (the route only runs on a
					// Claude plan login), and the route's status goes not-ready.
					if (message.subtype !== "init") break;
					const source = reportedApiKeySource(message.apiKeySource);
					let detail: string | undefined;
					let cause: string | undefined;
					if (source && source !== "none") {
						params.onApiKeySource?.(source);
						detail = `Claude Code would use an API key (apiKeySource: ${source})`;
						cause = `API key source ${source}`;
					} else if (bridge) {
						// The lesson's tools exist only through the app's in-process server:
						// unless init reports it connected, the turn would run as a
						// text-only lesson — refused before the first model call (the raw
						// status goes to the server log; the learner sees the generic text).
						const status = reportedMcpStatus(message.mcp_servers?.find((server) => server.name === serverName)?.status);
						if (status !== "connected") {
							cause = `the LearnHarness tool server ${status ? `did not connect (status: ${status})` : "was not reported"} at Claude Code's init`;
							detail = cause;
							console.error(`[claude-local] ${cause}`);
						}
					}
					if (!detail) break;
					sawResult = true;
					if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish({ reason: "error", message: detail }) };
					else yield* failedMessage("error", detail);
					yield { type: "result", ok: false, errors: [detail], ...(cause ? { cause } : {}), failedAssistant: true };
					break pump;
				}
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
					if (message.parent_tool_use_id) break;
					// Claude Code's synthetic API-failure message (rate limit, auth,
					// overload…): `error` names the class, the text is its own wording.
					// It is the turn's failure, never a reply — close whatever streamed
					// (or the rebuilt message) as an error and let the result end the turn.
					if (message.error) {
						const text = message.message.content.map((block) => (block as { type: string; text?: string }).type === "text" ? (block as { text?: string }).text ?? "" : "").filter(Boolean).join(" ");
						const target = mapper.started && !mapper.stopped ? mapper : (rebuilt?.id === message.message.id ? rebuilt.mapper : undefined);
						if (target) { if (target === rebuilt?.mapper) rebuilt = undefined; yield { type: "assistant", event: target.finish({ reason: "error", message: `${message.error}: ${text}` }) }; }
						else yield* failedMessage("error", `${message.error}: ${text}`);
						failedAssistant = true;
						seenAssistantIds.add(message.message.id);
						break;
					}
					// Claude Code also sends the full message, one content block at a
					// time, BEFORE the stream's message_stop — a duplicate whenever the
					// stream was delivered (its id was seen at message_start). Only a
					// message that never streamed is rebuilt here: its blocks arrive
					// one `assistant` message at a time under one id and are
					// accumulated; the message closes when the id changes or the
					// result arrives.
					if (seenAssistantIds.has(message.message.id) || (mapper.started && !mapper.stopped)) break;
					if (rebuilt && rebuilt.id !== message.message.id) { yield { type: "assistant", event: rebuilt.mapper.finish() }; rebuilt = undefined; }
					if (!rebuilt) {
						rebuilt = { id: message.message.id, mapper: new ClaudeStreamMapper(model, serverName, params.thinkingLevel), blocks: 0, seen: [] };
						for (const event of rebuilt.mapper.handle({ type: "message_start", message: { ...message.message, content: [] } })) yield { type: "assistant", event };
					}
					// An echo is one new block, or (cumulative / full echo) the message so
					// far: blocks already added are skipped, never duplicated.
					const content = message.message.content.map((block) => JSON.stringify(block));
					const repeats = rebuilt.seen.length > 0 && content.length >= rebuilt.seen.length && rebuilt.seen.every((block, index) => content[index] === block);
					for (const block of message.message.content.slice(repeats ? rebuilt.seen.length : 0)) {
						rebuilt.seen.push(JSON.stringify(block));
						const index = rebuilt.blocks++;
						for (const event of rebuilt.mapper.handle({ type: "content_block_start", index, content_block: block as never })) yield { type: "assistant", event };
						for (const event of rebuilt.mapper.handle({ type: "content_block_stop", index })) yield { type: "assistant", event };
					}
					rebuilt.mapper.handle({ type: "message_delta", delta: { stop_reason: message.message.stop_reason, stop_sequence: null, container: null, stop_details: null }, usage: message.message.usage as never, context_management: null });
					break;
				}
				case "rate_limit_event": {
					const info = message.rate_limit_info;
					yield { type: "usage", report: { status: info.status, ...(info.utilization !== undefined ? { utilization: info.utilization } : {}), ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}), ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}), ...(info.isUsingOverage !== undefined ? { isUsingOverage: info.isUsingOverage } : {}), observedAt: Date.now() } };
					break;
				}
				case "result": {
					sawResult = true;
					// The turn is over: release the prompt stream so the child exits
					// on its own (before the consumer acts on the result).
					promptDone.abort();
					const errors = message.subtype === "success" ? (message.is_error ? [message.result] : []) : message.errors;
					const failed = errors.length > 0 || message.is_error;
					if (rebuilt) { rebuilt.mapper.handle({ type: "message_stop" }); yield { type: "assistant", event: rebuilt.mapper.finish(failed && !failedAssistant ? { reason: "error", message: errors.join("; ") || "failed" } : undefined) }; rebuilt = undefined; }
					else if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish(failed ? { reason: "error", message: errors.join("; ") || "failed" } : undefined) };
					yield { type: "result", ok: !failed, errors, ...(failed ? { cause: describeFailure(resultFields(message)) } : {}), failedAssistant, ...(message.terminal_reason ? { terminalReason: message.terminal_reason } : {}) };
					break;
				}
				default: break;
			}
		}
		if (!sawResult) {
			const detail = failure instanceof Error ? failure.message : failure ? String(failure) : signal.aborted ? "aborted" : "Claude Code exited without a result";
			const reason = signal.aborted ? "aborted" : "error";
			// The log gets the failure's stable fields only (an SDK error's message
			// can carry Claude Code's own text — an error result, a control error).
			const cause = failure ? describeFailure(errorFields(failure)) : detail;
			if (reason === "error") console.error(`[claude-local] Claude Code turn ended without a result: ${cause}`);
			if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish({ reason, message: detail }) };
			else if (reason === "error" && !stopRequested) yield* failedMessage(reason, detail);
			yield { type: "result", ok: false, errors: reason === "aborted" ? [] : [detail], ...(reason === "error" ? { cause } : {}) };
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
	if (/apiKeySource/.test(message)) return `Local Claude runs only on a Claude plan login, and your Claude Code is set up to use an API key. Remove the API key from Claude Code's setup, sign in with your Claude plan, then re-check in Providers.${suffix}`;
	if (/rate.?limit|usage limit|429|exceeded|out of credits|extra usage/i.test(message)) return `Your Claude plan's usage limit was reached. Wait for the window to reset or check your plan at claude.ai, then retry.${suffix}`;
	if (/authentication|not logged in|login|sign.?in|credential|401|403|oauth/i.test(message)) return `Claude Code is not signed in. Run \`claude\` in a terminal, sign in with your Claude plan, then re-check in Providers.${suffix}`;
	if (/ENOENT|not found|could not be started|spawn|exited with code/i.test(message)) return `Claude Code could not be started. Re-check the install in Providers.${suffix}`;
	if (/catalog|model_not_found|issue with the selected model/i.test(message)) return `The selected model is not available from your Claude Code. Re-check in Providers and choose an available model.${suffix}`;
	if (/background/i.test(message)) return `Local Claude background use is off in this app. Enable it in Providers to run this work.${suffix}`;
	return `Local Claude request failed. Check Claude Code and your plan, then retry.${suffix}`;
}

export type { AssistantMessage };
