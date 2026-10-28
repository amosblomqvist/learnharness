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
 *   - a UserPromptSubmit hook is the pre-model gate: before any model
 *     request it refuses a turn Claude Code would bill to an API key or a
 *     third-party provider, or one whose tool server did not connect;
 *     system/init repeats the checks as defence in depth;
 *   - `total_cost_usd` is never read; `rate_limit_event` is reported for
 *     the status card, never persisted.
 */
import type { AgentToolResult, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { CLAUDE_LOCAL, type ClaudeLocalSystemPromptMode, type ClaudeLocalUsageReport } from "../../core/contracts/claude-local.ts";
import type { ClaudeLocalLaunch } from "./bridge.ts";
import { claudeLaunchOptions } from "./launch.ts";
import { describeFailure, errorFields, redactedForRecorder, reportedApiKeySource, reportedApiProvider, reportedMcpStatus, reportedNumber, reportedRateLimitStatus, reportedRateLimitType, resultFields } from "./reported.ts";
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
	/** Every raw SDK message, as it arrives (the LH_PROVIDER_EVENTS recorder),
	 *  with Claude Code's own diagnostic text redacted. */
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
	/** What is wrong with the app's tool server, from its reported status
	 *  (undefined when it is connected). Claude Code connects an in-process
	 *  server before the turn and reports it connected or failed (verified
	 *  on 2.1.312); "pending" would be a change in Claude Code and is said so
	 *  in the log. Every non-connected status refuses the turn (owner
	 *  decision 2026-10-28): its tools would be missing from it. */
	const toolServerProblem = (status: string | undefined, where: string): string | undefined => {
		if (status === "connected") return undefined;
		if (status === "pending") return `the LearnHarness tool server was still pending ${where} (unexpected: Claude Code connects an in-process server before the turn)`;
		return `the LearnHarness tool server ${status ? `did not connect (status: ${status})` : "was not reported"} ${where}`;
	};
	/** The pre-model gate's refusal, kept for the result: Claude Code reports
	 *  a turn stopped by UserPromptSubmit as an ordinary success (num_turns 0,
	 *  no errors), so the runner remembers its own verdict. */
	let refused: { detail: string; cause: string } | undefined;
	/** The gate's checks, against the handle (both answer in milliseconds:
	 *  accountInfo is the SDK's cached initialize answer). */
	const preModelRefusal = async (): Promise<{ detail: string; cause: string } | undefined> => {
		const account = await handle.accountInfo().catch(() => undefined);
		// Claude Code leaves apiKeySource out when no key is in use.
		const source = reportedApiKeySource(account?.apiKeySource);
		if (source && source !== "none") {
			params.onApiKeySource?.(source);
			return { detail: `Claude Code would use an API key (apiKeySource: ${source})`, cause: `API key source ${source}` };
		}
		const provider = reportedApiProvider(account?.apiProvider);
		if (provider && provider !== "firstParty") return { detail: `Claude Code is configured for a third-party provider (${provider})`, cause: `API provider ${provider}` };
		if (bridge) {
			const statuses = await handle.mcpServerStatus().catch(() => undefined);
			const problem = toolServerProblem(reportedMcpStatus(statuses?.find((server) => server.name === serverName)?.status), "before the turn");
			if (problem) { console.error(`[claude-local] ${problem}`); return { detail: problem, cause: problem }; }
		}
		return undefined;
	};
	const hooks: NonNullable<ClaudeQueryOptions["hooks"]> = {
		UserPromptSubmit: [{ hooks: [(async () => {
			// The pre-model gate (owner decision 2026-10-28). Claude Code runs this
			// hook once per user message, after it connected the app's tool server
			// and before init or any model request; continue:false stops the turn
			// with zero requests (verified on 2.1.312). system/init, by contrast,
			// arrives after the first request has started.
			refused = await preModelRefusal();
			return refused ? { continue: false, stopReason: "LearnHarness stopped this turn before any model request." } : {};
		}) satisfies HookCallback] }],
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
				// The recorder gets the message with Claude Code's own diagnostic text redacted (reported.ts).
				if (params.onProviderEvent) { try { params.onProviderEvent(redactedForRecorder(message) as SDKMessage); } catch { /* an observer never takes the run down */ } }
				push({ type: "sdk", message } as unknown as ClaudeTurnEvent);
			}
		}
		catch (error) { failure = error; }
		finally { done = true; wake?.(); }
	})();
	let sawResult = false;
	const seenAssistantIds = new Set<string>();
	/** A message rebuilt from Claude Code's `assistant` echoes (no stream
	 *  delivered); `seen` holds the blocks already added, as JSON; `frames`
	 *  the uuids of the echoes applied; `held` its events, released only when
	 *  the message closes. */
	let rebuilt: { id: string; mapper: ClaudeStreamMapper; blocks: number; seen: string[]; frames: Set<string>; held: AssistantMessageEvent[] } | undefined;
	/** Close the rebuilt message. A success releases everything it held. A
	 *  failure (owner decision 2026-10-28) records it EMPTY with the masked
	 *  error — announced by its start only, so none of its text reaches the
	 *  record or the wire: a never-streamed message a failure closes can be
	 *  the failure's own wording (an API-error message without its optional
	 *  `error` field). */
	function* closeRebuilt(failure?: { reason: "error"; message: string }, stop = false): Generator<ClaudeTurnEvent> {
		const closing = rebuilt!;
		rebuilt = undefined;
		// A closed message is done: a late re-send of its id is never rebuilt again.
		seenAssistantIds.add(closing.id);
		if (stop) closing.mapper.handle({ type: "message_stop" });
		const end = closing.mapper.finish(failure);
		if (failure && end.type === "error") {
			end.error.content = [];
			yield { type: "assistant", event: closing.held[0]! };
			yield { type: "assistant", event: end };
			return;
		}
		for (const event of closing.held) yield { type: "assistant", event };
		yield { type: "assistant", event: end };
	}
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
					// The turn's own report, after the pre-model gate. A refusal the gate
					// made ends the turn here (no model request was made). Otherwise init
					// repeats the gate's checks as defence in depth — it arrives after
					// Claude Code has started the first model request (verified on
					// 2.1.312), so it can only cut that turn short: billing an API key
					// (the route only runs on a Claude plan login; the route's status goes
					// not-ready) or a tool server that is not connected (the turn would
					// run as a text-only lesson). The status goes to the server log; the
					// learner sees the masked text.
					if (message.subtype !== "init") break;
					let detail = refused?.detail;
					let cause = refused?.cause;
					if (!detail) {
						const source = reportedApiKeySource(message.apiKeySource);
						if (source && source !== "none") {
							params.onApiKeySource?.(source);
							detail = `Claude Code would use an API key (apiKeySource: ${source})`;
							cause = `API key source ${source}`;
						} else if (bridge) {
							const problem = toolServerProblem(reportedMcpStatus(message.mcp_servers?.find((server) => server.name === serverName)?.status), "at Claude Code's init");
							if (problem) { detail = cause = problem; console.error(`[claude-local] ${problem}`); }
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
						const detail = `${message.error}: ${text}`;
						// An earlier rebuilt message (another id) was complete: release it first.
						if (rebuilt && rebuilt.id !== message.message.id) yield* closeRebuilt();
						if (mapper.started && !mapper.stopped) yield { type: "assistant", event: mapper.finish({ reason: "error", message: detail }) };
						else if (rebuilt) yield* closeRebuilt({ reason: "error", message: detail });
						else yield* failedMessage("error", detail);
						failedAssistant = true;
						seenAssistantIds.add(message.message.id);
						break;
					}
					// Claude Code also sends the full message, one content block at a
					// time, BEFORE the stream's message_stop — a duplicate whenever the
					// stream was delivered (its id was seen at message_start). Only a
					// message that never streamed is rebuilt here: its blocks arrive
					// one `assistant` frame at a time under one id and are accumulated;
					// the message closes when the id changes or the result arrives.
					if (seenAssistantIds.has(message.message.id) || (mapper.started && !mapper.stopped)) break;
					if (rebuilt && rebuilt.id !== message.message.id) yield* closeRebuilt();
					if (!rebuilt) {
						rebuilt = { id: message.message.id, mapper: new ClaudeStreamMapper(model, serverName, params.thinkingLevel), blocks: 0, seen: [], frames: new Set(), held: [] };
						rebuilt.held.push(...rebuilt.mapper.handle({ type: "message_start", message: { ...message.message, content: [] } }));
					}
					// Which blocks a frame adds (owner decision 2026-10-28):
					//  - a frame whose uuid was already applied is an exact re-send: none;
					//  - a ONE-block frame is always a new block (the SDK's documented
					//    shape: one frame per completed block, sdk.d.ts SDKAssistantMessage),
					//    even when it equals the block before it;
					//  - a frame of several blocks that starts with every block seen so far
					//    is a full or cumulative echo: only its tail is new.
					if (message.uuid && rebuilt.frames.has(message.uuid)) break;
					if (message.uuid) rebuilt.frames.add(message.uuid);
					const content = message.message.content.map((block) => JSON.stringify(block));
					const repeats = content.length > 1 && content.length >= rebuilt.seen.length && rebuilt.seen.every((block, index) => content[index] === block);
					for (const block of message.message.content.slice(repeats ? rebuilt.seen.length : 0)) {
						rebuilt.seen.push(JSON.stringify(block));
						const index = rebuilt.blocks++;
						rebuilt.held.push(...rebuilt.mapper.handle({ type: "content_block_start", index, content_block: block as never }));
						rebuilt.held.push(...rebuilt.mapper.handle({ type: "content_block_stop", index }));
					}
					rebuilt.mapper.handle({ type: "message_delta", delta: { stop_reason: message.message.stop_reason, stop_sequence: null, container: null, stop_details: null }, usage: message.message.usage as never, context_management: null });
					break;
				}
				case "rate_limit_event": {
					// Shown on the card: only documented values and finite numbers.
					const info = message.rate_limit_info;
					const status = reportedRateLimitStatus(info?.status);
					if (!status) break;
					const utilization = reportedNumber(info.utilization), resetsAt = reportedNumber(info.resetsAt), rateLimitType = reportedRateLimitType(info.rateLimitType);
					yield { type: "usage", report: { status, ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(rateLimitType ? { rateLimitType } : {}), ...(typeof info.isUsingOverage === "boolean" ? { isUsingOverage: info.isUsingOverage } : {}), observedAt: Date.now() } };
					break;
				}
				case "result": {
					sawResult = true;
					// The turn is over: release the prompt stream so the child exits
					// on its own (before the consumer acts on the result).
					promptDone.abort();
					// A gate refusal whose init never came: the "success" is the stop.
					if (refused) {
						yield* failedMessage("error", refused.detail);
						yield { type: "result", ok: false, errors: [refused.detail], cause: refused.cause, failedAssistant: true };
						break pump;
					}
					const errors = message.subtype === "success" ? (message.is_error ? [message.result] : []) : message.errors;
					const failed = errors.length > 0 || message.is_error;
					if (rebuilt) yield* closeRebuilt(failed && !failedAssistant ? { reason: "error", message: errors.join("; ") || "failed" } : undefined, true);
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
