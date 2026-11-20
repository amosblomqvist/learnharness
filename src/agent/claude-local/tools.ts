/**
 * The in-process tool bridge (Local Claude route): the app's AgentTools,
 * served to the user's Claude Code through ONE in-process MCP server over
 * the SDK's stdio control channel. Claude Code runs the agent loop and
 * calls the tools; the handler here runs the SAME `execute` bodies pi's
 * loop would, in this Next process, with the same argument heal and
 * TypeBox validation — the model sees the identical retryable error text.
 *
 * Built directly on the MCP SDK's low-level handlers rather than the Agent
 * SDK's `tool()`: `tool()` requires a zod shape and the round trip loses
 * nested TypeBox schemas, while a TypeBox schema already IS JSON Schema and
 * is served verbatim. `alwaysLoad` keeps every schema in the prompt (tool
 * search would otherwise defer them).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { CLAUDE_LOCAL } from "../../core/contracts/claude-local.ts";
import type { McpSdkServerConfigWithInstance } from "./sdk.ts";

/** What the agent learns about each call, in pi's vocabulary. */
export interface ToolBridgeEvents {
	/** Resolve the model's tool_use id for a call the server received (the
	 *  CLI passes it in `_meta`; the agent correlates by name/args otherwise). */
	toolUseIdFor(name: string, args: unknown, meta: string | undefined): string;
	onStart(call: { toolCallId: string; toolName: string; args: unknown }): Promise<void> | void;
	onEnd(call: { toolCallId: string; toolName: string; args: unknown; result: AgentToolResult<unknown>; isError: boolean; durationMs: number }): Promise<void> | void;
	/** The run's abort signal (forwarded into execute). */
	signal: AbortSignal;
}

/** pi's own wording for a thrown execute (agent-loop createErrorToolResult). */
function errorResult(message: string): AgentToolResult<unknown> { return { content: [{ type: "text", text: message }], details: {} }; }

function toMcpResult(result: AgentToolResult<unknown>, isError: boolean): CallToolResult {
	const content: CallToolResult["content"] = [];
	for (const part of result.content ?? []) {
		if (part.type === "text") content.push({ type: "text", text: part.text });
		else if (part.type === "image") content.push({ type: "image", data: part.data, mimeType: part.mimeType });
	}
	if (content.length === 0) content.push({ type: "text", text: "" });
	return { content, ...(isError ? { isError: true } : {}) };
}

export function createToolBridge(tools: AgentTool<any>[], events: ToolBridgeEvents): McpSdkServerConfigWithInstance {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const server = new McpServer({ name: CLAUDE_LOCAL.mcpServerName, version: "1" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters as unknown as { type: "object"; [key: string]: unknown },
			_meta: { "anthropic/alwaysLoad": true },
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name;
		const rawArgs = request.params.arguments ?? {};
		const meta = request.params._meta?.["claudecode/toolUseId"];
		const toolCallId = events.toolUseIdFor(name, rawArgs, typeof meta === "string" ? meta : undefined);
		const tool = byName.get(name);
		const started = performance.now();
		let result: AgentToolResult<unknown>;
		let isError = false;
		await events.onStart({ toolCallId, toolName: name, args: rawArgs });
		if (!tool) { result = errorResult(`Tool "${name}" is not available.`); isError = true; }
		else {
			try {
				// pi's prepare path: heal, then validate against the TypeBox schema.
				const call: ToolCall = { type: "toolCall", id: toolCallId, name, arguments: rawArgs as ToolCall["arguments"] };
				const prepared = tool.prepareArguments ? { ...call, arguments: tool.prepareArguments(call.arguments) as ToolCall["arguments"] } : call;
				const args = validateToolArguments(tool, prepared);
				try {
					result = await tool.execute(toolCallId, args, events.signal);
					isError = result.isError === true;
				} catch (error) {
					result = errorResult(error instanceof Error ? error.message : String(error));
					isError = true;
				}
			} catch (error) {
				result = errorResult(error instanceof Error ? error.message : String(error));
				isError = true;
			}
		}
		await events.onEnd({ toolCallId, toolName: name, args: rawArgs, result, isError, durationMs: Math.round(performance.now() - started) });
		return toMcpResult(result, isError);
	});
	return { type: "sdk", name: CLAUDE_LOCAL.mcpServerName, instance: server };
}
