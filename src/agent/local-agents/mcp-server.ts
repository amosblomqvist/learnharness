import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The loopback tool bridge (local agent connections, docs/architecture.md
 * §8.2): a minimal MCP Streamable-HTTP server that exposes the CURRENT
 * agent step's app tools to a locally installed vendor CLI (Claude Code,
 * the Antigravity ACP server). The CLI runs its own agent loop; the app's
 * pi-agent-core loop stays the one that EXECUTES tools — a `tools/call`
 * here only hands the call to the run (run.ts), which surfaces it to pi
 * and answers once pi's tool result arrives (possibly minutes later, e.g. a
 * quiz waiting on the learner).
 *
 * Hand-rolled instead of the MCP SDK for one reason: parked calls must
 * survive long waits, so `tools/call` answers over SSE with keep-alive
 * comments — idle HTTP clients otherwise drop the request.
 *
 * Bound to 127.0.0.1 only; every request must carry the per-bridge bearer
 * token (a browser cannot set that header cross-origin); bodies are capped.
 */

export interface BridgeTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface BridgeToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError?: boolean;
}

export interface ToolCallRequest {
	name: string;
	arguments: Record<string, unknown>;
	/** Fires once if the CLI abandons the request before it was answered. */
	abandoned: AbortSignal;
}

export interface ToolBridge {
	readonly url: string;
	readonly token: string;
	close(): Promise<void>;
}

const SERVER_NAME = "learnharness";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number;
interface JsonRpcMessage { jsonrpc?: string; id?: JsonRpcId | null; method?: string; params?: unknown }

function rpcResult(id: JsonRpcId, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: JsonRpcId | null, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function authorized(header: string | undefined, token: string): boolean {
	const presented = Buffer.from(header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "");
	const expected = Buffer.from(token);
	return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export async function startToolBridge(options: {
	tools: () => BridgeTool[];
	call: (request: ToolCallRequest) => Promise<BridgeToolResult>;
}): Promise<ToolBridge> {
	const token = randomBytes(32).toString("hex");
	const open = new Set<http.ServerResponse>();

	async function handle(message: JsonRpcMessage, res: http.ServerResponse, req: http.IncomingMessage): Promise<object | "streamed" | null> {
		const id = message.id;
		if (id === undefined || id === null) return null; // notifications (initialized, cancelled) need no reply
		switch (message.method) {
			case "initialize": {
				const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
				return rpcResult(id, {
					protocolVersion: requested && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: SERVER_NAME, version: "1" },
				});
			}
			case "ping": return rpcResult(id, {});
			case "tools/list": return rpcResult(id, { tools: options.tools() });
			case "tools/call": {
				const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
				if (typeof params.name !== "string") return rpcError(id, -32602, "tool name required");
				const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
				// SSE response: headers now, keep-alive comments while the run
				// waits on pi, then the single result event.
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
				res.flushHeaders();
				const abandoned = new AbortController();
				const keepalive = setInterval(() => { if (!res.writableEnded) res.write(": keep-alive\n\n"); }, KEEPALIVE_MS);
				keepalive.unref();
				const onClose = () => { clearInterval(keepalive); if (!res.writableEnded) abandoned.abort(); };
				req.on("close", onClose); res.on("close", onClose);
				let result: BridgeToolResult;
				try { result = await options.call({ name: params.name, arguments: args, abandoned: abandoned.signal }); }
				catch (error) { result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
				finally { clearInterval(keepalive); }
				if (!res.writableEnded) res.end(`event: message\ndata: ${JSON.stringify(rpcResult(id, result))}\n\n`);
				return "streamed";
			}
			default: return rpcError(id, -32601, `method not found: ${message.method}`);
		}
	}

	const server = http.createServer(async (req, res) => {
		open.add(res); res.on("close", () => open.delete(res));
		if (!authorized(req.headers.authorization, token)) { res.writeHead(401).end(); return; }
		if (req.method === "DELETE") { res.writeHead(200).end(); return; }
		if (req.method !== "POST") { res.writeHead(405, { Allow: "POST, DELETE" }).end(); return; }
		let parsed: unknown;
		try { parsed = JSON.parse(await readBody(req)); }
		catch { if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(rpcError(null, -32700, "parse error"))); return; }
		const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[];
		// A lone, valid tools/call streams its own (SSE) response; everything else answers JSON.
		const lone = !Array.isArray(parsed) && messages[0]?.method === "tools/call";
		const replies: object[] = [];
		for (const message of messages) {
			const reply = lone ? await handle(message, res, req)
				: message?.method === "tools/call" ? (message.id === undefined || message.id === null ? null : rpcError(message.id, -32600, "tools/call cannot be batched"))
				: await handle(message, res, req);
			if (reply === "streamed") return;
			if (reply) replies.push(reply);
		}
		if (replies.length === 0) { res.writeHead(202).end(); return; }
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
	});
	// Parked calls legitimately idle for a long time.
	server.requestTimeout = 0;
	server.headersTimeout = 30_000;
	server.keepAliveTimeout = 60_000;
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		token,
		close: () => new Promise<void>((resolve) => {
			for (const res of open) res.destroy();
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}

/** The name a CLI shows the model for a bridged tool (Claude Code prefixes MCP tools). */
export const CLAUDE_TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
export const BRIDGE_SERVER_NAME = SERVER_NAME;
