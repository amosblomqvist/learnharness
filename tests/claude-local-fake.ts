/**
 * A fake Claude Code for the Local Claude tests: a `query()` stand-in that
 * never spawns anything, answers the probe's control requests, speaks REAL
 * MCP to the app's in-process tool bridge over an in-memory transport,
 * invokes the hooks the runner registers, and replays scripted model
 * output as the SDK's own stream_event / assistant / result messages —
 * including Claude Code's habit of echoing each completed block as a full
 * `assistant` message before the stream's message_stop.
 *
 * By default a step's tools run strictly after its message_stop, one at a
 * time. Opt-in step options close the fidelity gaps of that default:
 * `parallelTools` (the batch's calls run concurrently), `toolsDuringStream`
 * (each call starts as soon as its block completes, while the message still
 * streams), `controlAhead` (the batch's control requests — hooks and tool
 * calls — run before the consumer receives the message they belong to, as
 * the SDK's reader can run ahead of its message queue), `echo` (per-block,
 * cumulative or one full `assistant` echo), and the `{ apiRetry }` step
 * (Claude Code's `system/api_retry` notice). Like the CLI it also resolves
 * permissions (a call the PreToolUse hook leaves undecided runs only when
 * allowedTools pre-approves it — `mcp__<server>` or the exact name — or
 * canUseTool allows it), reports the tool server's status at init
 * (`mcpStatus`), delivers stderr (`{ emitStderr }`, a crash's `stderr`) the
 * way the SDK does, and prices every result (FAKE_COST_USD) so a reader of
 * total_cost_usd would show. A call's `rawJson` streams a verbatim (possibly
 * malformed) argument body, and a step's `parentToolUseId` makes it a
 * sub-agent's output (stamped with that parent id, its calls never run).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClaudeQuery, HookCallback, SDKMessage } from "../src/agent/claude-local/sdk.ts";

/** Every result reports a nonzero total_cost_usd, as a real CLI does: the
 *  app must never read it (plan usage is labelled, never priced). */
export const FAKE_COST_USD = 0.0421;

export interface FakeToolCall {
	name: string; args: Record<string, unknown>; id?: string;
	/** A Claude Code built-in: its name reaches the hook unprefixed. */ raw?: boolean;
	/** The input_json_delta body streamed for this call, verbatim (a malformed
	 *  body models a broken stream); Claude Code's own echo, hooks and MCP call
	 *  still carry `args` (what it parsed itself). */ rawJson?: string;
}
export type FakeStep =
	| {
		text?: string; thinking?: string; tools?: FakeToolCall[]; model?: string;
		/** No stream events: only Claude Code's per-block `assistant` echoes (the fallback path). */ unstreamed?: boolean;
		/** Run the batch's calls concurrently (default: one at a time). */ parallelTools?: boolean;
		/** Start each call when its tool_use block completes, before message_stop. */ toolsDuringStream?: boolean;
		/** Run the batch (hooks + calls) before the message's own events reach the consumer. */ controlAhead?: boolean;
		/** The API's stop reason (default: tool_use with tools, else end_turn). */ stopReason?: string;
		/** How Claude Code echoes the message as `assistant` messages: one block
		 *  each (default), each echo carrying every block so far (cumulative), or
		 *  one echo of the whole message after its last block (full). */ echo?: "block" | "cumulative" | "full";
		/** The message is a sub-agent's output: every stream_event and echo
		 *  carries this parent_tool_use_id, and its tool calls never run here
		 *  (the sub-agent's own loop would run them). */ parentToolUseId?: string;
	}
	| { error: string }
	/** Claude Code's synthetic API-failure assistant message (e.g. rate_limit) followed by an is_error result. */
	| { apiError: string; text: string }
	/** Claude Code's `system/api_retry` notice (a retryable API failure it retries itself). */
	| { apiRetry: string }
	/** The child crashes; `stderr` is what it printed first: delivered to an
	 *  `options.stderr` callback when one is set and appended to the error as
	 *  the SDK does (". stderr: <tail>"). */
	| { crash: string; stderr?: string }
	/** The child prints to stderr (reaches only an `options.stderr` callback, as in the SDK). */
	| { emitStderr: string };

export interface FakeTurn {
	blocks: string[]; options: Record<string, unknown>; toolCalls: { id: string; name: string; args: unknown; result: unknown; isError: boolean }[]; hookDenials: string[];
	/** How the prompt stream ended: closed by the runner, or only through the SDK abort. */
	promptEnd?: "closed" | "aborted";
	/** The PostToolBatch inputs the hook received. */
	batches: unknown[];
	/** Calls the permission resolver refused (not pre-approved, no canUseTool). */
	permissionDenials: string[];
}

export interface FakeAccount {
	account?: Record<string, unknown>; models?: Array<Record<string, unknown>>;
	/** The init message's apiKeySource (default "none": a plan login). */
	apiKeySource?: string;
	/** The init message's status for the app's tool server (default: "connected"
	 *  once the in-process server connected); "absent" leaves it out of mcp_servers. */
	mcpStatus?: string;
}

export function fakeClaude(script: FakeStep[] | ((blocks: string[], turn: number) => FakeStep[]), account: FakeAccount = {}) {
	const turns: FakeTurn[] = [];
	let counter = 0;
	const query = ((params: { prompt: string | AsyncIterable<{ message: { content: unknown } }>; options?: Record<string, unknown> }) => {
		const options = params.options ?? {};
		const abort = options.abortController as AbortController | undefined;
		let closed!: () => void;
		const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
		const turn: FakeTurn = { blocks: [], options, toolCalls: [], hookDenials: [], batches: [], permissionDenials: [] };
		turns.push(turn);
		const sessionId = `fake-session-${turns.length}`;
		const hooks = (options.hooks ?? {}) as Record<string, { hooks: HookCallback[] }[]>;
		const hook = (event: string) => hooks[event]?.[0]?.hooks[0];
		const stopped = () => abort?.signal.aborted === true;
		function* one(message: SDKMessage | undefined): Generator<SDKMessage> { if (message) yield message; }
		async function* generate(): AsyncGenerator<SDKMessage> {
			// The prompt: one user message, or (the probe) nothing until closed.
			if (typeof params.prompt === "string") turn.blocks = [params.prompt];
			else {
				const prompt = params.prompt[Symbol.asyncIterator]();
				const first = await Promise.race([prompt.next(), closedPromise.then(() => undefined)]);
				if (!first || first.done) return;
				const content = first.value.message.content;
				turn.blocks = Array.isArray(content) ? content.map((block) => (block as { text: string }).text) : [String(content)];
				// Like the CLI, watch stdin: record how the runner ends it.
				void prompt.next().then(() => { turn.promptEnd ??= abort?.signal.aborted ? "aborted" : "closed"; }, () => undefined);
			}
			const server = (options.mcpServers as Record<string, { instance: { connect(t: unknown): Promise<void> } }> | undefined)?.learnharness;
			let client: Client | undefined;
			if (server) {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await server.instance.connect(serverTransport);
				client = new Client({ name: "fake-claude-code", version: "0" });
				await client.connect(clientTransport);
			}
			// Like the CLI, init reports each configured MCP server's status.
			const mcpStatus = account.mcpStatus ?? (client ? "connected" : undefined);
			const mcpServers = server && mcpStatus !== "absent" ? [{ name: "learnharness", status: mcpStatus ?? "failed", source: "sdk" }] : [];
			yield { type: "system", subtype: "init", session_id: sessionId, uuid: "u-init", cwd: String(options.cwd ?? ""), tools: [], mcp_servers: mcpServers, model: String(options.model ?? ""), permissionMode: String(options.permissionMode ?? "default"), apiKeySource: account.apiKeySource ?? "none", claude_code_version: "2.1.311", slash_commands: [], output_style: "default", skills: [], plugins: [] } as unknown as SDKMessage;
			const steps = typeof script === "function" ? script(turn.blocks, turns.length) : script;
			let usageReported = false;
			const signal = () => abort?.signal ?? new AbortController().signal;
			/** One call as Claude Code runs it: PreToolUse, then the MCP call. */
			const runCall = async (call: FakeToolCall & { id: string }) => {
				if (stopped()) return;
				const pre = await hook("PreToolUse")?.({ hook_event_name: "PreToolUse", tool_name: call.raw ? call.name : `mcp__learnharness__${call.name}`, tool_input: call.args, tool_use_id: call.id, session_id: sessionId, transcript_path: "", cwd: "" } as never, call.id, { signal: signal() });
				const decision = (pre as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision;
				if (decision === "deny") { turn.hookDenials.push(call.name); return; }
				// The CLI's permission resolver: a call the hook did not decide runs
				// only when a rule pre-approves it — `mcp__<server>` (every tool of
				// that server) or the exact tool name — or bypass mode is on, or
				// canUseTool allows it; with none of those it is denied (an SDK
				// session has no one to prompt).
				const wire = call.raw ? call.name : `mcp__learnharness__${call.name}`;
				const allowed = (options.allowedTools as string[] | undefined) ?? [];
				const preApproved = decision === "allow" || options.permissionMode === "bypassPermissions" || allowed.includes(wire) || (!call.raw && allowed.includes("mcp__learnharness"));
				if (!preApproved) {
					const canUseTool = options.canUseTool as ((name: string, input: unknown, extra: unknown) => Promise<{ behavior: string }>) | undefined;
					const verdict = canUseTool ? await canUseTool(wire, call.args, { signal: signal(), toolUseID: call.id }) : { behavior: "deny" };
					if (verdict.behavior !== "allow") { turn.permissionDenials.push(call.name); return; }
				}
				if (!client) { turn.toolCalls.push({ id: call.id, name: call.name, args: call.args, result: "no tool server", isError: true }); return; }
				const result = await client.callTool({ name: call.name, arguments: call.args, _meta: { "claudecode/toolUseId": call.id } });
				turn.toolCalls.push({ id: call.id, name: call.name, args: call.args, result: result.content, isError: result.isError === true });
			};
			for (const step of steps) {
				if (stopped()) return;
				if ("emitStderr" in step) { (options.stderr as ((data: string) => void) | undefined)?.(step.emitStderr); continue; }
				if ("crash" in step) {
					if (step.stderr) (options.stderr as ((data: string) => void) | undefined)?.(step.stderr);
					throw new Error(step.stderr ? `${step.crash}. stderr: ${step.stderr}` : step.crash);
				}
				if ("apiRetry" in step) {
					yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1, error_status: 529, error: step.apiRetry, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
					continue;
				}
				if ("apiError" in step) {
					yield { type: "assistant", message: { id: `msg_${++counter}`, type: "message", role: "assistant", model: String(options.model ?? ""), content: [{ type: "text", text: step.text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }, error: step.apiError, parent_tool_use_id: null, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
					yield { type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 1, result: step.text, stop_reason: null, total_cost_usd: FAKE_COST_USD, usage: {} as never, modelUsage: {}, permission_denials: [], terminal_reason: "api_error", uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
					return;
				}
				if ("error" in step) {
					yield { type: "result", subtype: "error_during_execution", duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 1, stop_reason: null, total_cost_usd: FAKE_COST_USD, usage: {} as never, modelUsage: {}, permission_denials: [], errors: [step.error], uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
					return;
				}
				const id = `msg_${++counter}`;
				const model = step.model ?? String(options.model ?? "claude-fake");
				const unstreamed = step.unstreamed === true;
				// controlAhead: the message's own events wait until its batch ran.
				const held: SDKMessage[] = [];
				const send = (message: SDKMessage | undefined): SDKMessage | undefined => { if (message && step.controlAhead) { held.push(message); return undefined; } return message; };
				const parent = step.parentToolUseId ?? null;
				const event = (e: unknown): SDKMessage | undefined => unstreamed ? undefined : send({ type: "stream_event", event: e, parent_tool_use_id: parent, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage);
				const blocks: unknown[] = [];
				yield* one(event({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } } }));
				let index = 0;
				const echoMode = step.echo ?? "block";
				const echoOf = (content: unknown[]): SDKMessage | undefined => send({ type: "assistant", message: { id, type: "message", role: "assistant", model, content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }, parent_tool_use_id: parent, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage);
				const echo = (block: unknown): SDKMessage | undefined => echoMode === "full" ? undefined : echoOf(echoMode === "cumulative" ? [...blocks] : [block]);
				if (step.thinking) {
					yield* one(event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }));
					yield* one(event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: step.thinking } }));
					yield* one(event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-1" } }));
					yield* one(event({ type: "content_block_stop", index }));
					blocks.push({ type: "thinking", thinking: step.thinking, signature: "sig-1" });
					yield* one(echo(blocks[blocks.length - 1]));
					index++;
				}
				if (step.text) {
					yield* one(event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
					const half = Math.ceil(step.text.length / 2);
					yield* one(event({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text.slice(0, half) } }));
					if (stopped()) return;
					yield* one(event({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text.slice(half) } }));
					yield* one(event({ type: "content_block_stop", index }));
					blocks.push({ type: "text", text: step.text });
					yield* one(echo(blocks[blocks.length - 1]));
					index++;
				}
				const streamedCalls = (step.tools ?? []).map((tool) => ({ ...tool, id: tool.id ?? `toolu_${++counter}` }));
				// A sub-agent's calls are its own loop's business, never this batch's.
				const calls = parent ? [] : streamedCalls;
				const inflight: Promise<void>[] = [];
				for (const call of streamedCalls) {
					yield* one(event({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.raw ? call.name : `mcp__learnharness__${call.name}`, input: {} } }));
					const json = call.rawJson ?? JSON.stringify(call.args);
					yield* one(event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 3) } }));
					yield* one(event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(3) } }));
					yield* one(event({ type: "content_block_stop", index }));
					blocks.push({ type: "tool_use", id: call.id, name: call.raw ? call.name : `mcp__learnharness__${call.name}`, input: call.args });
					yield* one(echo(blocks[blocks.length - 1]));
					index++;
					if (step.toolsDuringStream && !parent) {
						// The call starts now; give it a tick to reach the bridge while the message still streams.
						inflight.push(runCall(call));
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				}
				if (echoMode === "full") yield* one(echoOf([...blocks]));
				yield* one(event({ type: "message_delta", delta: { stop_reason: step.stopReason ?? (streamedCalls.length ? "tool_use" : "end_turn"), stop_sequence: null }, usage: { output_tokens: 20, input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } }));
				yield* one(event({ type: "message_stop" }));
				if (!usageReported) { usageReported = true; yield* one(send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.25, resetsAt: 1700000000, rateLimitType: "five_hour", isUsingOverage: false }, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage)); }
				// Claude Code runs the batch: PreToolUse per call, the MCP call, PostToolBatch once.
				if (step.toolsDuringStream) await Promise.all(inflight);
				else if (step.parallelTools) await Promise.all(calls.map(runCall));
				else for (const call of calls) { if (stopped()) return; await runCall(call); }
				if (stopped()) return;
				let stop = false;
				if (calls.length > 0) {
					const input = { hook_event_name: "PostToolBatch", tool_calls: calls.map((call) => ({ tool_name: call.raw ? call.name : `mcp__learnharness__${call.name}`, tool_input: call.args, tool_use_id: call.id })), session_id: sessionId, transcript_path: "", cwd: "" };
					turn.batches.push(input);
					const post = await hook("PostToolBatch")?.(input as never, undefined, { signal: signal() });
					stop = (post as { continue?: boolean } | undefined)?.continue === false;
				}
				for (const message of held.splice(0)) yield message;
				if (stop) {
					yield { type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "tool_use", total_cost_usd: FAKE_COST_USD, usage: {} as never, modelUsage: {}, permission_denials: [], terminal_reason: "hook_stopped", uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
					return;
				}
			}
			if (stopped()) return;
			yield { type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: FAKE_COST_USD, usage: {} as never, modelUsage: {}, permission_denials: [], terminal_reason: "completed", uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
		}
		const iterator = generate();
		return Object.assign(iterator, {
			accountInfo: async () => account.account ?? { subscriptionType: "max", apiProvider: "firstParty" },
			supportedModels: async () => account.models ?? [{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "" }, { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "" }],
			interrupt: async () => undefined,
			close: () => { closed(); abort?.abort(); },
		});
	}) as unknown as ClaudeQuery;
	return { query, turns };
}
