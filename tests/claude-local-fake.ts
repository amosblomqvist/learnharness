/**
 * A fake Claude Code for the Local Claude tests: a `query()` stand-in that
 * never spawns anything, answers the probe's control requests, speaks REAL
 * MCP to the app's in-process tool bridge over an in-memory transport,
 * invokes the hooks the runner registers, and replays scripted model
 * output as the SDK's own stream_event / assistant / result messages —
 * including Claude Code's habit of echoing each completed block as a full
 * `assistant` message before the stream's message_stop.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClaudeQuery, HookCallback, SDKMessage } from "../src/agent/claude-local/sdk.ts";

export interface FakeToolCall { name: string; args: Record<string, unknown>; id?: string; /** A Claude Code built-in: its name reaches the hook unprefixed. */ raw?: boolean }
export type FakeStep =
	| { text?: string; thinking?: string; tools?: FakeToolCall[]; model?: string }
	| { error: string }
	| { crash: string };

export interface FakeTurn { blocks: string[]; options: Record<string, unknown>; toolCalls: { id: string; name: string; args: unknown; result: unknown; isError: boolean }[]; hookDenials: string[] }

export function fakeClaude(script: FakeStep[] | ((blocks: string[], turn: number) => FakeStep[]), account: { account?: Record<string, unknown>; models?: Array<Record<string, unknown>> } = {}) {
	const turns: FakeTurn[] = [];
	let counter = 0;
	const query = ((params: { prompt: string | AsyncIterable<{ message: { content: unknown } }>; options?: Record<string, unknown> }) => {
		const options = params.options ?? {};
		const abort = options.abortController as AbortController | undefined;
		let closed!: () => void;
		const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
		const turn: FakeTurn = { blocks: [], options, toolCalls: [], hookDenials: [] };
		turns.push(turn);
		const sessionId = `fake-session-${turns.length}`;
		const hooks = (options.hooks ?? {}) as Record<string, { hooks: HookCallback[] }[]>;
		const hook = (event: string) => hooks[event]?.[0]?.hooks[0];
		const stopped = () => abort?.signal.aborted === true;
		async function* generate(): AsyncGenerator<SDKMessage> {
			// The prompt: one user message, or (the probe) nothing until closed.
			if (typeof params.prompt === "string") turn.blocks = [params.prompt];
			else {
				const first = await Promise.race([params.prompt[Symbol.asyncIterator]().next(), closedPromise.then(() => undefined)]);
				if (!first || first.done) return;
				const content = first.value.message.content;
				turn.blocks = Array.isArray(content) ? content.map((block) => (block as { text: string }).text) : [String(content)];
			}
			const server = (options.mcpServers as Record<string, { instance: { connect(t: unknown): Promise<void> } }> | undefined)?.learnharness;
			let client: Client | undefined;
			if (server) {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await server.instance.connect(serverTransport);
				client = new Client({ name: "fake-claude-code", version: "0" });
				await client.connect(clientTransport);
			}
			yield { type: "system", subtype: "init", session_id: sessionId, uuid: "u-init", cwd: String(options.cwd ?? ""), tools: [], mcp_servers: [], model: String(options.model ?? ""), permissionMode: String(options.permissionMode ?? "default"), apiKeySource: "none", claude_code_version: "2.1.311", slash_commands: [], output_style: "default", skills: [], plugins: [] } as unknown as SDKMessage;
			const steps = typeof script === "function" ? script(turn.blocks, turns.length) : script;
			let usageReported = false;
			for (const step of steps) {
				if (stopped()) return;
				if ("crash" in step) throw new Error(step.crash);
				if ("error" in step) {
					yield { type: "result", subtype: "error_during_execution", duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], errors: [step.error], uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
					return;
				}
				const id = `msg_${++counter}`;
				const model = step.model ?? String(options.model ?? "claude-fake");
				const event = (e: unknown): SDKMessage => ({ type: "stream_event", event: e, parent_tool_use_id: null, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage);
				const blocks: unknown[] = [];
				yield event({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } } });
				let index = 0;
				const echo = (block: unknown): SDKMessage => ({ type: "assistant", message: { id, type: "message", role: "assistant", model, content: [block], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }, parent_tool_use_id: null, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage);
				if (step.thinking) {
					yield event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
					yield event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: step.thinking } });
					yield event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-1" } });
					yield event({ type: "content_block_stop", index });
					blocks.push({ type: "thinking", thinking: step.thinking, signature: "sig-1" });
					yield echo(blocks[blocks.length - 1]);
					index++;
				}
				if (step.text) {
					yield event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
					const half = Math.ceil(step.text.length / 2);
					yield event({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text.slice(0, half) } });
					if (stopped()) return;
					yield event({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text.slice(half) } });
					yield event({ type: "content_block_stop", index });
					blocks.push({ type: "text", text: step.text });
					yield echo(blocks[blocks.length - 1]);
					index++;
				}
				const calls = (step.tools ?? []).map((tool) => ({ ...tool, id: tool.id ?? `toolu_${++counter}` }));
				for (const call of calls) {
					yield event({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.raw ? call.name : `mcp__learnharness__${call.name}`, input: {} } });
					const json = JSON.stringify(call.args);
					yield event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 3) } });
					yield event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(3) } });
					yield event({ type: "content_block_stop", index });
					blocks.push({ type: "tool_use", id: call.id, name: call.raw ? call.name : `mcp__learnharness__${call.name}`, input: call.args });
					yield echo(blocks[blocks.length - 1]);
					index++;
				}
				yield event({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20, input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } });
				yield event({ type: "message_stop" });
				if (!usageReported) { usageReported = true; yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.25, resetsAt: 1700000000, rateLimitType: "five_hour", isUsingOverage: false }, uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage; }
				// Claude Code runs the batch: PreToolUse per call, the MCP call, PostToolBatch once.
				for (const call of calls) {
					if (stopped()) return;
					const pre = await hook("PreToolUse")?.({ hook_event_name: "PreToolUse", tool_name: call.raw ? call.name : `mcp__learnharness__${call.name}`, tool_input: call.args, tool_use_id: call.id, session_id: sessionId, transcript_path: "", cwd: "" } as never, call.id, { signal: abort?.signal ?? new AbortController().signal });
					const decision = (pre as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision;
					if (decision === "deny") { turn.hookDenials.push(call.name); continue; }
					if (!client) { turn.toolCalls.push({ id: call.id, name: call.name, args: call.args, result: "no tool server", isError: true }); continue; }
					const result = await client.callTool({ name: call.name, arguments: call.args, _meta: { "claudecode/toolUseId": call.id } });
					turn.toolCalls.push({ id: call.id, name: call.name, args: call.args, result: result.content, isError: result.isError === true });
				}
				if (calls.length > 0) {
					const post = await hook("PostToolBatch")?.({ hook_event_name: "PostToolBatch", tool_calls: calls.map((call) => ({ tool_name: `mcp__learnharness__${call.name}`, tool_input: call.args })), session_id: sessionId, transcript_path: "", cwd: "" } as never, undefined, { signal: abort?.signal ?? new AbortController().signal });
					if ((post as { continue?: boolean } | undefined)?.continue === false) {
						yield { type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "tool_use", total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], terminal_reason: "hook_stopped", uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
						return;
					}
				}
			}
			if (stopped()) return;
			yield { type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], terminal_reason: "completed", uuid: `u-${++counter}`, session_id: sessionId } as unknown as SDKMessage;
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
