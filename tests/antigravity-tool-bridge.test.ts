import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS } from "../src/agent/antigravity/constants.ts";
import { LIVE_PROCESS_IDLE_TIMEOUT_MS } from "../src/agent/antigravity/live-processes.ts";
import { createAntigravityToolBridge } from "../src/agent/antigravity/tool-bridge.ts";

async function parseSseOrJson(res: Response): Promise<Record<string, unknown>> {
	const text = (await res.text()).trim();
	if (text.startsWith("{")) return JSON.parse(text) as Record<string, unknown>;
	let last: Record<string, unknown> = {};
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("data:")) {
			const payload = line.slice(5).trim();
			if (payload) last = JSON.parse(payload) as Record<string, unknown>;
		}
	}
	return last;
}

test("Loopback HTTP MCP bridge enforces 127.0.0.1 binding, timingSafeEqual bearer auth, declared-tool admission, and held calls", async () => {
	let callNotifications = 0;
	const cancelled: string[] = [];

	const bridge = await createAntigravityToolBridge(
		[
			{
				name: "probe_check",
				description: "Check learner understanding",
				parameters: Type.Object({ query: Type.String() }),
			},
		],
		{
			onCall: () => {
				callNotifications += 1;
			},
			onError: () => {},
			onCancel: (call) => {
				cancelled.push(call.id);
			},
		},
	);

	try {
		assert.equal(bridge.requestTimeoutMs, ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS);
		assert.equal(ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS, 30 * 60_000);
		assert.equal(LIVE_PROCESS_IDLE_TIMEOUT_MS, 10 * 60_000);
		assert.ok(bridge.requestTimeoutMs > LIVE_PROCESS_IDLE_TIMEOUT_MS);

		const spec = bridge.toAcpMcpServer();
		assert.equal(spec.type, "http");
		assert.equal(spec.name, "learnharness");
		const parsedUrl = new URL(spec.url);
		assert.equal(parsedUrl.hostname, "127.0.0.1");
		assert.equal(parsedUrl.pathname, "/mcp");
		assert.match(bridge.authorization, /^Bearer [0-9a-f]{64}$/);
		assert.deepEqual(spec.headers, [{ name: "Authorization", value: bridge.authorization }]);

		// 1) Missing or wrong bearer tokens return 401
		const noAuth = await fetch(bridge.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		assert.equal(noAuth.status, 401);

		const wrongAuth = await fetch(bridge.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${"0".repeat(64)}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		assert.equal(wrongAuth.status, 401);

		// 2) Wrong path returns 404
		const wrongPath = await fetch(`http://127.0.0.1:${parsedUrl.port}/other`, {
			method: "POST",
			headers: { Authorization: bridge.authorization },
		});
		assert.equal(wrongPath.status, 404);

		// 3) Valid bearer initializes MCP session and lists only declared tools
		const authHeaders = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: bridge.authorization,
		};
		const initRes = await fetch(bridge.url, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
			}),
		});
		assert.equal(initRes.status, 200);
		const sessionId = initRes.headers.get("mcp-session-id")!;
		assert.ok(sessionId);

		await fetch(bridge.url, {
			method: "POST",
			headers: { ...authHeaders, "mcp-session-id": sessionId },
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
		});

		const listRes = await fetch(bridge.url, {
			method: "POST",
			headers: { ...authHeaders, "mcp-session-id": sessionId },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		});
		const listBody = await parseSseOrJson(listRes);
		const tools = ((listBody.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
		assert.deepEqual(tools, ["probe_check"]);

		// 4) Undeclared tool is rejected before reaching queue
		const badToolRes = await fetch(bridge.url, {
			method: "POST",
			headers: { ...authHeaders, "mcp-session-id": sessionId },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "run_workflow", arguments: {} },
			}),
		});
		const badToolBody = await parseSseOrJson(badToolRes);
		assert.ok(badToolBody.error, "undeclared tool should return MCP error");
		assert.equal(bridge.getPendingToolCalls().length, 0);

		// 5) Declared tool stays open until resolved cleanly
		let resolved = false;
		const callPromise = fetch(bridge.url, {
			method: "POST",
			headers: { ...authHeaders, "mcp-session-id": sessionId },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "probe_check", arguments: { query: "derivatives" } },
			}),
		}).then(async (res) => {
			resolved = true;
			return parseSseOrJson(res);
		});

		const pendingCalls = await bridge.waitForToolCalls(1);
		assert.equal(pendingCalls.length, 1);
		assert.ok(callNotifications >= 1);
		assert.equal(resolved, false, "MCP tools/call must stay open until resolved");
		assert.match(pendingCalls[0]!.id, /^agy-call-/);
		assert.deepEqual(pendingCalls[0]!.arguments, { query: "derivatives" });

		bridge.resolveToolCall(pendingCalls[0]!, {
			role: "toolResult",
			toolCallId: pendingCalls[0]!.id,
			toolName: pendingCalls[0]!.name,
			content: [{ type: "text", text: "Mastered!" }],
			isError: false,
			timestamp: Date.now(),
		});
		const callBody = await callPromise;
		assert.equal(resolved, true);
		assert.equal((callBody.result as { content?: Array<{ text: string }> })?.content?.[0]?.text, "Mastered!");
		assert.equal(cancelled.length, 0);
	} finally {
		await bridge.close();
	}
});

test("bridge.close rejects pending waitForToolCalls promises", async () => {
	const bridge = await createAntigravityToolBridge([
		{
			name: "ask_user_question",
			description: "Ask the learner a question",
			parameters: Type.Object({ question: Type.String() }),
		},
	]);
	const waitPromise = bridge.waitForToolCalls(1);
	await bridge.close();
	await assert.rejects(waitPromise, /antigravity tool bridge closed/i);
});

test("aborting HTTP tools/call request clears pending call and fires onCancel", async () => {
	const cancelled: string[] = [];
	const bridge = await createAntigravityToolBridge(
		[
			{
				name: "recall",
				description: "Ask recall question",
				parameters: Type.Object({ question: Type.String() }),
			},
		],
		{
			onCall: () => {},
			onError: () => {},
			onCancel: (call) => {
				cancelled.push(call.id);
			},
		},
	);

	try {
		const authHeaders = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: bridge.authorization,
		};
		const initRes = await fetch(bridge.url, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
			}),
		});
		const sessionId = initRes.headers.get("mcp-session-id")!;
		await fetch(bridge.url, {
			method: "POST",
			headers: { ...authHeaders, "mcp-session-id": sessionId },
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
		});

		const abortCtrl = new AbortController();
		const callPromise = fetch(bridge.url, {
			method: "POST",
			headers: { ...authHeaders, "mcp-session-id": sessionId },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "recall", arguments: { question: "Ohm's law?" } },
			}),
			signal: abortCtrl.signal,
		}).catch(() => {});

		const pending = await bridge.waitForToolCalls(1);
		assert.equal(pending.length, 1);

		abortCtrl.abort();
		await callPromise;
		const deadline = Date.now() + 1_000;
		while (cancelled.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 15));
		}

		assert.deepEqual(cancelled, [pending[0]!.id]);
		assert.equal(bridge.getPendingToolCalls().length, 0);
	} finally {
		await bridge.close();
	}
});
