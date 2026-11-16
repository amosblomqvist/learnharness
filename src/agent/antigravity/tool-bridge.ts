import { AsyncLocalStorage } from "node:async_hooks";
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
import type { AcpMcpServer } from "./acp-client.ts";
import { ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS } from "./constants.ts";

export const ANTIGRAVITY_MCP_SERVER_NAME = "learnharness";

const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;

export type AntigravityPendingToolCall = { id: string; name: string; arguments: JsonObject };

export type AntigravityBridgeCallbacks = {
	onCall(): void;
	onError(error: Error): void;
	onCancel?(call: AntigravityPendingToolCall): void;
};

export interface AntigravityToolBridge {
	readonly url: string;
	readonly authorization: string;
	readonly requestTimeoutMs: number;
	toAcpMcpServer(): AcpMcpServer;
	waitForToolCalls(count: number): Promise<AntigravityPendingToolCall[]>;
	resolveToolCall(call: AntigravityPendingToolCall, result: ToolResultMessage): void;
	getPendingToolCalls(): AntigravityPendingToolCall[];
	close(): Promise<void>;
	closeSync(): void;
}

type ToolCallWaiter = {
	count: number;
	resolve: (calls: AntigravityPendingToolCall[]) => void;
	reject: (error: Error) => void;
};

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
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as McpTool["inputSchema"],
	};
}

class ToolCallQueue {
	private readonly results = new Map<AntigravityPendingToolCall, (result: CallToolResult) => void>();
	private waiters: ToolCallWaiter[] = [];

	add(
		call: AntigravityPendingToolCall,
		signal: AbortSignal,
		onCancel?: (call: AntigravityPendingToolCall) => void,
		res?: http.ServerResponse,
	): Promise<CallToolResult> {
		const result = new Promise<CallToolResult>((resolve) => {
			const cancel = () => {
				const settle = this.results.get(call);
				if (!settle) return;
				settle({ content: [{ type: "text", text: "MCP request cancelled" }], isError: true });
				onCancel?.(call);
			};
			const onResClose = () => {
				if (res && !res.writableEnded) {
					cancel();
				}
			};
			this.results.set(call, (value) => {
				this.results.delete(call);
				signal.removeEventListener("abort", cancel);
				res?.removeListener("close", onResClose);
				resolve(value);
			});
			signal.addEventListener("abort", cancel, { once: true });
			res?.once("close", onResClose);
			if (signal.aborted || (res && res.closed && !res.writableEnded)) cancel();
		});

		this.wakeWaiters();
		return result;
	}

	waitFor(count: number): Promise<AntigravityPendingToolCall[]> {
		return new Promise((resolve, reject) => {
			this.waiters.push({ count, resolve, reject });
			this.wakeWaiters();
		});
	}

	resolve(call: AntigravityPendingToolCall, result: ToolResultMessage): void {
		this.results.get(call)?.(toCallToolResult(result));
	}

	list(): AntigravityPendingToolCall[] {
		return [...this.results.keys()];
	}

	clear(): void {
		for (const settle of [...this.results.values()]) {
			settle({ content: [{ type: "text", text: "MCP bridge closed" }], isError: true });
		}
		for (const waiter of this.waiters) {
			waiter.reject(new Error("antigravity tool bridge closed"));
		}
		this.waiters = [];
	}

	private wakeWaiters(): void {
		const calls = this.list();
		const ready = this.waiters.filter((waiter) => calls.length >= waiter.count);
		this.waiters = this.waiters.filter((waiter) => calls.length < waiter.count);
		for (const waiter of ready) waiter.resolve(calls);
	}
}

function createMcpServer(
	tools: Tool[],
	queue: ToolCallQueue,
	seenIds: Set<string>,
	callbacks?: AntigravityBridgeCallbacks,
	responseStore?: AsyncLocalStorage<http.ServerResponse>,
): Server {
	const server = new Server({ name: ANTIGRAVITY_MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(toMcpTool) }));

	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		if (!tools.some((tool) => tool.name === request.params.name)) {
			const error = new McpError(
				ErrorCode.InvalidParams,
				`Antigravity requested an undeclared harness tool: ${request.params.name}`,
			);
			callbacks?.onError(error);
			throw error;
		}

		const candidateMetaId = request.params._meta?.toolUseId ?? request.params._meta?.["claudecode/toolUseId"];
		const id =
			typeof candidateMetaId === "string" && candidateMetaId.trim() && !seenIds.has(candidateMetaId)
				? candidateMetaId
				: `agy-call-${randomUUID()}`;
		seenIds.add(id);

		const result = queue.add(
			{
				id,
				name: request.params.name,
				arguments: (request.params.arguments ?? {}) as JsonObject,
			},
			extra.signal,
			callbacks?.onCancel,
			responseStore?.getStore(),
		);
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

function listen(server: http.Server): Promise<AddressInfo> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
	});
}

function closeHttpServer(server: http.Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	server.closeAllConnections();
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

type SessionEntry = {
	server: Server;
	transport: StreamableHTTPServerTransport;
};

export async function createAntigravityToolBridge(
	tools: Tool[],
	callbacks?: AntigravityBridgeCallbacks,
): Promise<AntigravityToolBridge> {
	const authorization = `Bearer ${randomBytes(TOKEN_BYTES).toString("hex")}`;
	const expected = Buffer.from(authorization);
	const queue = new ToolCallQueue();
	const seenIds = new Set<string>();
	const sessions = new Map<string, SessionEntry>();
	const ephemeralEntries = new Set<SessionEntry>();
	const responseStore = new AsyncLocalStorage<http.ServerResponse>();
	let closing = false;

	const openSession = async (): Promise<SessionEntry> => {
		const mcpServer = createMcpServer(tools, queue, seenIds, callbacks, responseStore);
		let entry!: SessionEntry;
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sessionId) => {
				sessions.set(sessionId, entry);
			},
		});
		entry = { server: mcpServer, transport };
		ephemeralEntries.add(entry);
		transport.onclose = () => {
			ephemeralEntries.delete(entry);
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
			}
		};
		await mcpServer.connect(transport);
		return entry;
	};

	const httpServer = http.createServer((req, res) => {
		if (!isAuthorized(req.headers.authorization, expected)) {
			res.writeHead(401).end();
			return;
		}
		if ((req.url ?? "").split("?")[0] !== "/mcp") {
			res.writeHead(404).end();
			return;
		}
		if (closing) {
			res.writeHead(503).end();
			return;
		}

		void (async () => {
			const headerId = req.headers["mcp-session-id"];
			const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;
			let entry: SessionEntry | undefined;
			if (sessionId) {
				entry = sessions.get(sessionId);
				if (!entry) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
					return;
				}
			} else {
				entry = await openSession();
			}
			const handle = () => entry.transport.handleRequest(req, res);
			await (req.method === "POST" ? responseStore.run(res, handle) : handle());
		})().catch((error: unknown) => {
			console.error("antigravity tool bridge request failed", error);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	// Hold open tool calls across 10-minute learner question pauses without hitting Node's 5-minute default requestTimeout.
	httpServer.requestTimeout = ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS;

	let port: number;
	try {
		({ port } = await listen(httpServer));
	} catch (error) {
		await closeHttpServer(httpServer).catch(() => {});
		throw error;
	}

	const url = `http://${LOOPBACK_HOST}:${port}/mcp`;

	return {
		url,
		authorization,
		requestTimeoutMs: httpServer.requestTimeout,
		toAcpMcpServer: () => ({
			type: "http",
			name: ANTIGRAVITY_MCP_SERVER_NAME,
			url,
			headers: [{ name: "Authorization", value: authorization }],
		}),
		waitForToolCalls: (count) => queue.waitFor(count),
		resolveToolCall: (call, result) => queue.resolve(call, result),
		getPendingToolCalls: () => queue.list(),
		close: async () => {
			closing = true;
			queue.clear();
			const toClose = new Set<SessionEntry>([...sessions.values(), ...ephemeralEntries]);
			sessions.clear();
			ephemeralEntries.clear();
			await Promise.allSettled([...toClose].map((entry) => entry.server.close()));
			await closeHttpServer(httpServer);
		},
		closeSync: () => {
			closing = true;
			queue.clear();
			sessions.clear();
			ephemeralEntries.clear();
			if (httpServer.listening) {
				httpServer.closeAllConnections();
				httpServer.close();
			}
		},
	};
}
