import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";

/**
 * MCP client support: connect to local MCP servers over stdio and expose
 * their tools as AgentTools, in the same name → tool record shape the
 * registries (tools.ts) and the sub-agent toolsets already use.
 *
 * SUPPORT ONLY — nothing calls this yet. Which agents get these tools, and
 * where the server list comes from, are separate decisions; the caller
 * passes the list and owns the connections' lifetime (`close()`), so this
 * module keeps no global state. (The other MCP code in the repo,
 * claude-code/tool-bridge.ts, is the opposite direction: LearnHarness as
 * a server for the claude CLI.)
 *
 * - Tools are named `mcp__<server>__<tool>` (the convention tool-bridge.ts
 *   already uses), so servers cannot collide with each other or with the
 *   built-in tools. A name outside providers' tool-name alphabet, over 64
 *   characters, or duplicated is REJECTED, never rewritten.
 * - FAIL FAST, no silent fallback: if any server fails to start, connect
 *   or list, the servers already opened are closed and the load rejects
 *   naming the one that failed.
 * - Calls run through serverExecute: the shared per-call timeout, abort
 *   cascade and result mapping. A result flagged isError throws, which
 *   pi turns into an error tool result the model sees.
 * - The tool list is a snapshot taken at load.
 * - The SDK gives a spawned server only a small safe subset of the app's
 *   environment (HOME, PATH, …) plus the entry's own `env`, so provider
 *   keys reflected into process.env never reach it.
 */

export type McpServerConfig = { name: string; command: string; args?: string[]; env?: Record<string, string> };

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const NO_TEXT = "(no text content)";

type Connected = { client: Client; tools: McpTool[] };

async function connect(server: McpServerConfig): Promise<Connected> {
	const client = new Client({ name: "learnharness", version: "1.0.0" });
	try {
		await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: server.env }));
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined);
			tools.push(...page.tools);
			cursor = page.nextCursor;
		} while (cursor);
		return { client, tools };
	} catch (error) {
		await client.close().catch(() => {});
		throw new Error(`MCP server "${server.name}" failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

/** MCP content blocks → what serverExecute maps: text joined, images kept,
 *  any other kind noted rather than dropped silently. */
function toBody(result: CallToolResult): string | ImageFileResult {
	const texts: string[] = [];
	const images: { data: string; mimeType: string }[] = [];
	for (const block of result.content) {
		if (block.type === "text") texts.push(block.text);
		else if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
		else texts.push(`[${block.type} content not supported]`);
	}
	const text = texts.join("\n\n") || NO_TEXT;
	if (result.isError) throw new Error(text);
	return images.length > 0 ? { text, images } : text;
}

function toAgentTool(client: Client, name: string, tool: McpTool): AgentTool<any> {
	// pi validates plain JSON Schema parameters natively (pi-ai validation.ts).
	const schema = tool.inputSchema as TSchema;
	return {
		name,
		label: name,
		description: tool.description ?? "",
		parameters: schema,
		execute: serverExecute(name, schema, async (input, { signal }) =>
			toBody(
				(await client.callTool(
					{ name: tool.name, arguments: input as Record<string, unknown> },
					undefined,
					{ signal },
				)) as CallToolResult,
			),
		),
	};
}

export async function loadMcpTools(
	servers: McpServerConfig[],
): Promise<{ tools: Record<string, AgentTool<any>>; close(): Promise<void> }> {
	const settled = await Promise.allSettled(servers.map(connect));
	const connected = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
	const close = async () => {
		await Promise.allSettled(connected.map(({ client }) => client.close()));
	};
	try {
		for (const result of settled) if (result.status === "rejected") throw result.reason;
		// No rejection past this point, so `connected` lines up with `servers`.
		const tools: Record<string, AgentTool<any>> = {};
		servers.forEach((server, index) => {
			const { client, tools: listed } = connected[index]!;
			for (const tool of listed) {
				const name = `mcp__${server.name}__${tool.name}`;
				if (!TOOL_NAME.test(name)) {
					throw new Error(
						`MCP tool name "${name}" is invalid: use only letters, digits, "_" and "-", at most 64 characters`,
					);
				}
				if (name in tools) throw new Error(`Duplicate MCP tool name "${name}"`);
				tools[name] = toAgentTool(client, name, tool);
			}
		});
		return { tools, close };
	} catch (error) {
		await close();
		throw error;
	}
}
