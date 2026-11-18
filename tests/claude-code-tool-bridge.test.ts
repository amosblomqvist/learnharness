/**
 * Claude Code MCP tool bridge (src/agent/claude-code/tool-bridge.ts).
 *
 * A real MCP SDK client talks to the bridge over loopback HTTP, the same way
 * the claude CLI does, so listing, auth, pending calls and their results
 * are all exercised end to end.
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import test from "node:test";

import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

import { BRIDGE_SERVER_NAME, createToolBridge, toolNameFromMcp, type ToolBridge } from "../src/agent/claude-code/tool-bridge.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const SCREENSHOT_TOOL: Tool = { name: "screenshot", description: "Capture the screen", parameters: Type.Object({}) };

type BridgeServerConfig = { type: string; url: string; headers: { Authorization: string } };

function getServerConfig(bridge: ToolBridge): BridgeServerConfig {
	const config = JSON.parse(bridge.mcpConfig) as { mcpServers: Record<string, BridgeServerConfig> };
	const server = config.mcpServers[BRIDGE_SERVER_NAME];
	assert.ok(server);
	return server;
}

async function connectClient(bridge: ToolBridge, authorization = getServerConfig(bridge).headers.Authorization): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(getServerConfig(bridge).url), {
		requestInit: { headers: { Authorization: authorization } },
	});
	const client = new Client({ name: "test", version: "0" });
	await client.connect(transport);

	return client;
}

function toolResult(content: ToolResultMessage["content"], isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: "call-1", toolName: "read", content, isError, timestamp: 0 };
}

test("lists exactly the given tools with their JSON schemas", async (t) => {
	const bridge = await createToolBridge([READ_TOOL, SCREENSHOT_TOOL]);
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	const { tools } = await client.listTools();

	assert.deepEqual(
		tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
		[
			{ name: "read", description: "Read a file", inputSchema: JSON.parse(JSON.stringify(READ_TOOL.parameters)) },
			{ name: "screenshot", description: "Capture the screen", inputSchema: JSON.parse(JSON.stringify(SCREENSHOT_TOOL.parameters)) },
		],
	);

	assert.deepEqual(bridge.allowedTools, ["mcp__learnharness__read", "mcp__learnharness__screenshot"]);
});

test("rejects requests without the bearer token", async (t) => {
	const bridge = await createToolBridge([READ_TOOL]);
	t.after(() => bridge.close());

	await assert.rejects(connectClient(bridge, "Bearer wrong"), (error: { code?: number }) => error.code === 401);
	const response = await fetch(getServerConfig(bridge).url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	assert.equal(response.status, 401);
});

test("binds 127.0.0.1", async (t) => {
	const bridge = await createToolBridge([READ_TOOL]);
	t.after(() => bridge.close());

	const url = new URL(getServerConfig(bridge).url);
	assert.equal(url.hostname, "127.0.0.1");

	const externalAddress = Object.values(os.networkInterfaces())
		.flat()
		.find((address) => address && !address.internal && address.family === "IPv4");

	if (!externalAddress) {
		t.diagnostic("no non-loopback IPv4 interface; skipped external connect check");
		return;
	}

	await assert.rejects(
		new Promise((resolve, reject) => {
			const socket = net.connect(Number(url.port), externalAddress.address, () => resolve(socket.end()));
			socket.once("error", reject);
		}),
		{ code: "ECONNREFUSED" },
	);
});

test("tools/call stays pending until resolved and returns its text and image content", async (t) => {
	const bridge = await createToolBridge([READ_TOOL]);
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	let settled = false;
	const pending = client.callTool({ name: "read", arguments: { path: "notes.md" }, _meta: { "claudecode/toolUseId": "call-1" } }).finally(() => {
		settled = true;
	});

	const [call] = await bridge.waitForToolCalls(1);
	assert.ok(call);
	assert.deepEqual(call, { id: "call-1", name: "read", arguments: { path: "notes.md" } });
	assert.deepEqual(bridge.getPendingToolCalls(), [call]);

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(settled, false);

	bridge.resolveToolCall(
		call,
		toolResult([
			{ type: "text", text: "# Notes" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]),
	);

	const result = await pending;
	assert.deepEqual(result.content, [
		{ type: "text", text: "# Notes" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
	]);
	assert.notEqual(result.isError, true);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
});

test("individual MCP cancellation removes only that request and leaves the other request resolvable", async (t) => {
	let acknowledgeCancel!: () => void;
	const cancelled = new Promise<void>((resolve) => { acknowledgeCancel = resolve; });
	const cancellations: string[] = [];
	const bridge = await createToolBridge([READ_TOOL], {
		onCall() {}, onError(error) { throw error; },
		onCancel(call) { cancellations.push(call.id); acknowledgeCancel(); },
	});
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());
	const first = client.callTool({ name: "read", arguments: { path: "a" }, _meta: { "claudecode/toolUseId": "call-a" } });
	const controller = new AbortController();
	const second = client.callTool({ name: "read", arguments: { path: "b" }, _meta: { "claudecode/toolUseId": "call-b" } }, undefined, { signal: controller.signal });
	const rejected = assert.rejects(second, /cancelled B/);
	await bridge.waitForToolCalls(2);
	controller.abort("cancelled B");
	await cancelled;
	await rejected;
	assert.deepEqual(cancellations, ["call-b"]);
	const pending = bridge.getPendingToolCalls();
	assert.deepEqual(pending.map((call) => call.id), ["call-a"]);
	bridge.resolveToolCall(pending[0]!, toolResult([{ type: "text", text: "A" }]));
	assert.deepEqual((await first).content, [{ type: "text", text: "A" }]);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
});

test("waitForToolCalls resolves once that many calls are pending, in arrival order", async (t) => {
	const bridge = await createToolBridge([READ_TOOL, SCREENSHOT_TOOL]);
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	let waited = false;
	const waiting = bridge.waitForToolCalls(2).finally(() => {
		waited = true;
	});

	void client.callTool({ name: "read", arguments: { path: "a.md" }, _meta: { "claudecode/toolUseId": "call-1" } }).catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(waited, false);

	void client.callTool({ name: "screenshot", arguments: {}, _meta: { "claudecode/toolUseId": "call-2" } }).catch(() => {});

	assert.deepEqual(await waiting, [
		{ id: "call-1", name: "read", arguments: { path: "a.md" } },
		{ id: "call-2", name: "screenshot", arguments: {} },
	]);
});

test("isError result becomes MCP isError true", async (t) => {
	const bridge = await createToolBridge([READ_TOOL]);
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	const pending = client.callTool({ name: "read", arguments: { path: "missing.md" }, _meta: { "claudecode/toolUseId": "call-1" } });
	const [call] = await bridge.waitForToolCalls(1);
	assert.ok(call);

	bridge.resolveToolCall(call, toolResult([{ type: "text", text: "ENOENT" }], true));

	const result = await pending;
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "ENOENT" }]);
});

test("close fails pending calls and frees the port", async () => {
	const bridge = await createToolBridge([READ_TOOL]);
	const port = Number(new URL(getServerConfig(bridge).url).port);
	const client = await connectClient(bridge);
	const pending = client.callTool({ name: "read", arguments: { path: "notes.md" }, _meta: { "claudecode/toolUseId": "call-1" } });
	await bridge.waitForToolCalls(1);

	await bridge.close();

	await assert.rejects(pending);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
	await client.close();

	const probe = net.createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, "127.0.0.1", resolve);
	});
	await new Promise((resolve) => probe.close(resolve));
});

test("close rejects consumers still waiting for tool calls", { timeout: 1000 }, async () => {
	const bridge = await createToolBridge([READ_TOOL]);
	const waiting = bridge.waitForToolCalls(1);

	await bridge.close();
	await assert.rejects(waiting, /tool bridge closed/);
});

test('mcpConfig is {"mcpServers":{"learnharness":{"type":"http","url":...,"headers":{"Authorization":"Bearer ..."}}}}', async (t) => {
	const bridge = await createToolBridge([READ_TOOL]);
	t.after(() => bridge.close());

	const config = JSON.parse(bridge.mcpConfig) as { mcpServers: Record<string, unknown> };
	assert.deepEqual(Object.keys(config.mcpServers), ["learnharness"]);

	const server = getServerConfig(bridge);
	assert.deepEqual(Object.keys(server).sort(), ["headers", "type", "url"]);
	assert.equal(server.type, "http");
	assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.match(server.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
});

test("missing and reused Claude tool IDs are rejected rather than matched by arguments", async (t) => {
	const failures: string[] = [];
	const bridge = await createToolBridge([READ_TOOL], { onCall: () => {}, onError: (error) => failures.push(error.message) });
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());
	await assert.rejects(client.callTool({ name: "read", arguments: { path: "a" } }), /claudecode\/toolUseId/);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
	const params = { name: "read", arguments: { path: "a" }, _meta: { "claudecode/toolUseId": "same-id" } };
	const first = client.callTool(params);
	const [call] = await bridge.waitForToolCalls(1);
	assert.ok(call);
	bridge.resolveToolCall(call, toolResult([{ type: "text", text: "first" }]));
	await first;
	await assert.rejects(client.callTool(params), /claudecode\/toolUseId/);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
	assert.equal(failures.length, 2);
});

test("toolNameFromMcp strips the bridge prefix", () => {
	assert.equal(toolNameFromMcp("mcp__learnharness__read"), "read");
	assert.equal(toolNameFromMcp("read"), "read");
});
