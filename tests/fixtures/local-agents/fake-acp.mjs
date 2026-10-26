#!/usr/bin/env node
// A scripted stand-in for Google's Antigravity ACP server
// (tests/local-agents-antigravity.test.ts): newline-delimited JSON-RPC over
// stdio. Every prompt first asks for a native-tool permission (the client
// must reject it), then "use the tool" calls `lookup` through the HTTP MCP
// server from session/new and streams the result back; anything else
// replies with plain text naming how many prompt blocks it received.
import fs from "node:fs";
import readline from "node:readline";

const log = (entry) => { if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let outbound = 0;
function request(method, params) { const id = `agent-${++outbound}`; send({ id, method, params }); return new Promise((resolve) => pending.set(id, resolve)); }
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });

let model = "gemini-x", thought = "medium", mode = "yolo";
const configOptions = () => [
	{ id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: "gemini-x", name: "Gemini X" }, { value: "gemini-y", name: "Gemini Y" }] },
	{ id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: thought, options: model === "gemini-x" ? [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] : [{ value: "medium", name: "Medium" }] },
];
const sessions = new Map();

async function mcpCall(server, body) {
	const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
	const response = await fetch(server.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
	const text = await response.text();
	if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6));
	return text ? JSON.parse(text) : undefined;
}

async function handle(message) {
	const { id, method, params } = message;
	log({ type: "request", method, params });
	switch (method) {
		case "initialize": return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false } }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }], agentInfo: { name: "fake-antigravity", version: "1.0.0" } };
		case "authenticate": return {};
		case "session/new": { const sessionId = `s${sessions.size + 1}`; sessions.set(sessionId, params.mcpServers); return { sessionId, modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] }, configOptions: configOptions() }; }
		case "session/set_mode": mode = params.modeId; return {};
		case "session/set_config_option": if (params.configId === "model") model = params.value; else thought = params.value; return { configOptions: configOptions() };
		case "session/prompt": {
			const { sessionId } = params;
			const permission = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "native-1", title: "run_command rm -rf ~" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
			log({ type: "permission", outcome: permission.outcome, mode, model, thought });
			const text = params.prompt.filter((b) => b.type === "text").at(-1)?.text ?? ""; // the new input, not replayed history
			const server = sessions.get(sessionId)?.[0];
			if (/use the tool/.test(text) && server) {
				update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } });
				await mcpCall(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
				const result = await mcpCall(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup", arguments: { topic: "rivers" } } });
				update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `got: ${result.result.content[0].text}` } });
			} else {
				update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `plain blocks=${params.prompt.length}` } });
			}
			return { stopReason: "end_turn" };
		}
		case "session/cancel": return undefined;
		default: throw Object.assign(new Error(`unknown ${method}`), { code: -32601 });
	}
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.method === undefined && message.id !== undefined) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
	try {
		const result = await handle(message);
		if (message.id !== undefined) send({ id: message.id, result: result ?? null });
	} catch (error) {
		if (message.id !== undefined) send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
	}
});
