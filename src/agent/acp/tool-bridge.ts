import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { JsonObject, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

export interface PendingAcpTool {
	call: ToolCall;
	complete(result: ToolResultMessage): void;
	cancel(): void;
}

/** Hold native MCP requests until Pi validates/executes them. No application
 * tool executes here. A retained native session owns one bearer and endpoint. */
export async function createToolBridge(tools: Tool[], onCall: (pending: PendingAcpTool) => void, onAbandon: () => void) {
	const token = randomBytes(32).toString("hex");
	const pending = new Set<PendingAcpTool>();
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const server = createServer(async (request, response) => {
		if (request.url !== "/mcp" || request.headers.authorization !== `Bearer ${token}` || request.headers.origin) {
			response.writeHead(403).end(); return;
		}
		if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				size += chunk.length;
				if (size > 16 * 1024 * 1024) { response.writeHead(413).end(); return; }
				chunks.push(Buffer.from(chunk));
			}
			const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				id?: number | string; method?: string;
				params?: { protocolVersion?: string; name?: string; arguments?: unknown };
			};
			if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) { response.writeHead(400).end(); return; }
			if (rpc.id === undefined) { response.writeHead(202).end(); return; }
			let result: unknown;
			let error: { code: number; message: string } | undefined;
			switch (rpc.method) {
				case "initialize":
					result = {
						protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
						capabilities: { tools: {} }, serverInfo: { name: "learnharness", version: "1.0.0" },
					}; break;
				case "ping": result = {}; break;
				case "tools/list":
					result = { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }; break;
				case "tools/call": {
					const name = rpc.params?.name;
					const args = rpc.params?.arguments ?? {};
					if (!name || !byName.has(name)) { error = { code: -32602, message: "Unknown LearnHarness tool" }; break; }
					if (!args || typeof args !== "object" || Array.isArray(args)) { error = { code: -32602, message: "Tool arguments must be an object" }; break; }
					let settled = false;
					const finish = (value: unknown) => {
						if (settled) return;
						settled = true;
						pending.delete(call);
						response.writeHead(200, { "Content-Type": "application/json" });
						response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: value }));
					};
					const call: PendingAcpTool = {
						call: { type: "toolCall", id: `acp_${randomUUID()}`, name, arguments: args as JsonObject },
						complete: (message) => finish({ content: message.content, isError: message.isError }),
						cancel: () => finish({ isError: true, content: [{ type: "text", text: "LearnHarness ended this native session." }] }),
					};
					pending.add(call);
					response.once("close", () => {
						if (settled) return;
						settled = true;
						pending.delete(call);
						onAbandon();
					});
					onCall(call);
					return;
				}
				default: error = { code: -32601, message: "MCP method not supported" };
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...(error ? { error } : { result }) }));
		} catch {
			if (!response.headersSent) response.writeHead(400);
			response.end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not open ACP tool bridge");
	return {
		mcpServer: { type: "http", name: "learnharness", url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
		close: () => new Promise<void>((resolve) => {
			for (const call of pending) call.cancel();
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}
