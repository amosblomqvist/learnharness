import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ImageContent, JsonObject, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

export const BRIDGE_SERVER_NAME = "learnharness";

const MCP_TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;
const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;

export type PendingToolCall = { id: string; name: string; arguments: JsonObject };

type BridgeCallbacks = { onCall(): void; onError(error: Error): void; onCancel?(call: PendingToolCall): void };

export const MCP_IDENTITY_ERROR = "claude CLI compatibility error: MCP calls must include a unique claudecode/toolUseId";

export type ToolBridge = {
	mcpConfig: string;
	allowedTools: string[];
	waitForToolCalls(count: number): Promise<PendingToolCall[]>;
	resolveToolCall(call: PendingToolCall, result: ToolResultMessage): void;
	getPendingToolCalls(): PendingToolCall[];
	close(): Promise<void>;
};

type ToolCallWaiter = {
	count: number;
	resolve: (calls: PendingToolCall[]) => void;
	reject: (error: Error) => void;
};

export function toolNameFromMcp(name: string): string {
	return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function toMcpContent(block: TextContent | ImageContent): CallToolResult["content"][number] {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };

		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
	}
}

function toCallToolResult(result: ToolResultMessage): CallToolResult {
	return { content: result.content.map(toMcpContent), isError: result.isError };
}

function toMcpTool(tool: Tool): McpTool {
	return { name: tool.name, description: tool.description, inputSchema: tool.parameters as McpTool["inputSchema"] };
}

class ToolCallQueue {
	private readonly results = new Map<PendingToolCall, (result: CallToolResult) => void>();
	private waiters: ToolCallWaiter[] = [];

	add(call: PendingToolCall, signal: AbortSignal, onCancel?: (call: PendingToolCall) => void): Promise<CallToolResult> {
		const result = new Promise<CallToolResult>((resolve) => {
			const cancel = () => {
				const settle = this.results.get(call);
				if (!settle) return;
				settle({ content: [{ type: "text", text: "MCP request cancelled" }], isError: true });
				onCancel?.(call);
			};
			this.results.set(call, (result) => {
				this.results.delete(call);
				signal.removeEventListener("abort", cancel);
				resolve(result);
			});
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
		});

		this.wakeWaiters();

		return result;
	}

	waitFor(count: number): Promise<PendingToolCall[]> {
		return new Promise((resolve, reject) => {
			this.waiters.push({ count, resolve, reject });
			this.wakeWaiters();
		});
	}

	resolve(call: PendingToolCall, result: ToolResultMessage): void {
		this.results.get(call)?.(toCallToolResult(result));
	}

	list(): PendingToolCall[] {
		return [...this.results.keys()];
	}

	clear(): void {
		for (const settle of this.results.values()) {
			settle({ content: [{ type: "text", text: "MCP bridge closed" }], isError: true });
		}

		for (const waiter of this.waiters) waiter.reject(new Error("claude-code tool bridge closed"));
		this.waiters = [];
	}

	private wakeWaiters(): void {
		const calls = this.list();

		const ready = this.waiters.filter((waiter) => calls.length >= waiter.count);
		this.waiters = this.waiters.filter((waiter) => calls.length < waiter.count);

		for (const waiter of ready) waiter.resolve(calls);
	}
}

// Low-level Server on purpose: McpServer.registerTool only takes zod schemas, and pi tools carry
// JSON Schema that must reach the CLI unchanged.
function createMcpServer(tools: Tool[], queue: ToolCallQueue, callbacks?: BridgeCallbacks): Server {
	const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(toMcpTool) }));

	const seenIds = new Set<string>();
	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		const id = request.params._meta?.["claudecode/toolUseId"];
		if (typeof id !== "string" || !id.trim() || seenIds.has(id)) {
			const error = new McpError(ErrorCode.InvalidParams, MCP_IDENTITY_ERROR);
			callbacks?.onError(error);
			throw error;
		}
		if (!tools.some((tool) => tool.name === request.params.name)) {
			const error = new McpError(ErrorCode.InvalidParams, "claude CLI requested an undeclared harness tool");
			callbacks?.onError(error);
			throw error;
		}
		seenIds.add(id);
		const result = queue.add({ id, name: request.params.name, arguments: (request.params.arguments ?? {}) as JsonObject }, extra.signal, callbacks?.onCancel);
		callbacks?.onCall();
		return result;
	});

	return server;
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
	if (header === undefined) return false;

	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createHttpServer(transport: StreamableHTTPServerTransport, authorization: string): http.Server {
	const expected = Buffer.from(authorization);

	return http.createServer((req, res) => {
		if (!isAuthorized(req.headers.authorization, expected)) {
			res.writeHead(401).end();
			return;
		}

		transport.handleRequest(req, res).catch((error: unknown) => {
			console.error("claude-code tool bridge request failed", error);

			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
}

function listen(server: http.Server): Promise<AddressInfo> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);

		server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
	});
}

function closeHttpServer(server: http.Server): Promise<void> {
	server.closeAllConnections();

	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function toMcpConfig(port: number, authorization: string): string {
	const server = { type: "http", url: `http://${LOOPBACK_HOST}:${port}/mcp`, headers: { Authorization: authorization } };

	return JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: server } });
}

export async function createToolBridge(tools: Tool[], callbacks?: BridgeCallbacks): Promise<ToolBridge> {
	const authorization = `Bearer ${randomBytes(TOKEN_BYTES).toString("hex")}`;

	const queue = new ToolCallQueue();
	const mcpServer = createMcpServer(tools, queue, callbacks);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	await mcpServer.connect(transport);

	const httpServer = createHttpServer(transport, authorization);
	let port: number;
	try {
		({ port } = await listen(httpServer));
	} catch (error) {
		await mcpServer.close();
		throw error;
	}

	return {
		mcpConfig: toMcpConfig(port, authorization),
		allowedTools: tools.map((tool) => `${MCP_TOOL_PREFIX}${tool.name}`),
		waitForToolCalls: (count) => queue.waitFor(count),
		resolveToolCall: (call, result) => queue.resolve(call, result),
		getPendingToolCalls: () => queue.list(),
		close: async () => {
			queue.clear();
			await mcpServer.close();
			await closeHttpServer(httpServer);
		},
	};
}
