// A real stdio ACP process and loopback MCP client; no inference or network services.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "text";
const reuseMode = mode.startsWith("reuse");
const trace = (event, details = {}) => { if (process.argv[3]) appendFileSync(process.argv[3], `${JSON.stringify({ event, pid: process.pid, cwd: process.cwd(), ...details })}\n`); };
let session;
let child;
let promptId;
const modelMode = mode.startsWith("models-") || reuseMode;
let selectedModel = "alpha";
let selectedReasoning = "high";
const selections = [];
const modelValues = ["alpha", "beta", "plain", "default"].map((value) => ({ value, name: `Fixture ${value}` }));
function configOptions() {
	const levels = selectedModel === "beta" ? ["medium", "max"] : selectedModel === "plain" ? [] : ["low", "high"];
	return [
		{ id: "fixture-model-option", type: "select", category: "model", currentValue: selectedModel,
			options: mode === "models-claude" ? [{ name: "Models", group: "models", options: modelValues }] : modelValues },
		...(levels.length ? [{ id: mode === "models-claude" ? "effort" : "reasoning_effort", type: "select", category: "thought_level", currentValue: selectedReasoning,
			options: [...(mode === "models-claude" ? [{ value: "default", name: "Default" }] : []), ...levels.map((value) => ({ value, name: value }))] }] : []),
	];
}
const usage = mode === "usage-missing" ? undefined : mode === "usage-partial" ? { inputTokens: 0, thoughtTokens: 8 } : { inputTokens: 123, outputTokens: 17, cachedReadTokens: 50, cachedWriteTokens: 4, thoughtTokens: 11, totalTokens: 194 };
const pendingClient = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (kind, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture", update: { sessionUpdate: kind, content: { type: "text", text } } } });

async function nativeThread() {
	const native = crossSpawn(process.env.CODEX_PATH, ["app-server"], { stdio: "pipe", windowsHide: true });
	native.stderr.resume();
	return new Promise((resolve, reject) => {
		createInterface({ input: native.stdout }).once("line", (line) => {
			const rpc = JSON.parse(line);
			native.stdin.end();
			if (rpc.error) reject(new Error(rpc.error.message)); else resolve(rpc.result);
		});
		native.once("error", reject);
		native.stdin.write(`${JSON.stringify({ id: 1, method: "thread/start", params: { cwd: process.cwd() } })}\n`);
	});
}

createInterface({ input: process.stdin }).on("line", async (line) => {
	const rpc = JSON.parse(line);
	if (!rpc.method && pendingClient.has(rpc.id)) { pendingClient.get(rpc.id)(rpc.result); pendingClient.delete(rpc.id); return; }
	try {
		if (rpc.method === "initialize") {
			trace("initialize");
			if (mode === "exit") process.exit(7);
			if (mode === "malformed") { process.stdout.write("not json\n"); return; }
			reply(rpc.id, {
				protocolVersion: mode === "version" ? 99 : 1,
				agentInfo: { name: "offline fixture", version: "1" },
				agentCapabilities: { mcpCapabilities: { http: mode !== "no-http" }, promptCapabilities: { image: mode !== "no-image" }, sessionCapabilities: { systemPrompt: {} } },
			});
			send({ jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind: mode === "api-auth" ? "api_key" : "account", label: "Fixture subscription" } } });
		} else if (rpc.method === "session/new") {
			trace("session");
			if (mode === "codex-history" || mode === "reuse-history") await nativeThread();
			else if (mode !== "codex-no-ephemeral-ack" && process.env.LH_CODEX_EPHEMERAL_ACK) writeFileSync(process.env.LH_CODEX_EPHEMERAL_ACK, JSON.stringify(["fixture"]));
			if (mode === "auth") { send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "Authentication required" } }); return; }
			session = rpc.params;
			reply(rpc.id, { sessionId: "fixture", models: { currentModelId: "fixture-model" }, ...(modelMode ? { configOptions: configOptions() } : {}) });
		} else if (rpc.method === "session/set_config_option" && modelMode) {
			const { configId, value } = rpc.params;
			selections.push({ configId, value });
			if (configId === "fixture-model-option") {
				if (!modelValues.some((entry) => entry.value === value)) throw new Error("Unknown model");
				if (mode !== "models-ignore") selectedModel = value;
				selectedReasoning = value === "beta" ? "medium" : "high";
			} else {
				const control = configOptions().find((option) => option.id === configId);
				if (!control?.options.some((entry) => entry.value === value)) throw new Error("Unsupported effort");
				selectedReasoning = value;
			}
			reply(rpc.id, { configOptions: configOptions() });
		} else if (rpc.method === "hang-request") {
			return;
		} else if (rpc.method === "session/prompt") {
			promptId = rpc.id;
			const history = rpc.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			trace("prompt", { replayed: history.includes('"role":"toolResult"') });
			if (mode === "hang") {
				child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				update("agent_message_chunk", JSON.stringify({ cwd: process.cwd(), pid: process.pid, child: child.pid }));
				setInterval(() => {}, 1000);
				return;
			}
			if (mode === "orphan") {
				child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				update("agent_message_chunk", JSON.stringify({ child: child.pid }));
				process.stdout.write("", () => process.exit(7));
				return;
			}
			if (mode === "permission") {
				send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "fixture", options: [{ optionId: "allow", kind: "allow_once" }] } });
				return;
			}
			if (reuseMode) {
				const results = [];
				if (!history.includes('"role":"toolResult"')) {
					update("agent_message_chunk", JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
					const mcp = session.mcpServers[0];
					let sequence = 0;
					const call = async (value) => {
						const name = mode === "reuse-question" ? "ask_user_question" : "submit";
						const args = mode === "reuse-question" ? { question: "What is your current level?", options: [{ label: "Beginner" }, { label: "Experienced" }] } : value === undefined ? { missingRequiredValue: true } : { value };
						const response = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(mcp.headers.map(({ name, value }) => [name, value])) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }) });
						const reply = await response.json();
						trace("result", { result: reply.result });
						return reply.result;
					};
					if (mode === "reuse-parallel") results.push(...await Promise.all([call("one"), call("two")]));
					else {
						if (mode === "reuse-validation") results.push(await call(undefined));
						results.push(await call("hello"));
						if (mode === "reuse-multiple" || mode === "reuse-history") results.push(await call("again"));
					}
				}
				if (mode === "reuse-hang-after-tool" && results.length) {
					child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
					update("agent_message_chunk", JSON.stringify({ pid: process.pid, cwd: process.cwd(), child: child.pid }));
					setInterval(() => {}, 1000);
					return;
				}
				update("agent_message_chunk", JSON.stringify({ pid: process.pid, replayed: history.includes('"role":"toolResult"'), results, model: selectedModel, reasoning: selectedReasoning }));
			} else if (modelMode) {
				update("agent_message_chunk", JSON.stringify({ model: selectedModel, reasoning: selectedReasoning, selections }));
			} else if (mode === "tool" || mode === "quiz" || mode === "validation") {
				const successfulResult = history.includes('"role":"toolResult"') && (mode !== "validation" || history.includes('"isError":false'));
				if (!successfulResult) {
					const mcp = session.mcpServers[0];
					const request = async (method, params, authorized = true) => {
						const response = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? Object.fromEntries(mcp.headers.map(({ name, value }) => [name, value])) : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
						if (!response.ok) return { status: response.status };
						return response.json();
					};
					if ((await request("tools/list", {}, false)).status !== 403) throw new Error("Tool bridge is not protected");
					await request("initialize", { protocolVersion: "2025-03-26" });
					const list = await request("tools/list", {});
					const name = mode === "quiz" ? "quiz" : list.result.tools[0].name;
					const permission = new Promise((resolve) => pendingClient.set("application-permission", resolve));
					const codex = process.env.INITIAL_AGENT_MODE === "read-only";
					if (codex) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture", update: { sessionUpdate: "tool_call", toolCallId: "application-call", rawInput: { server: "learnharness", tool: name } } } });
					send({ jsonrpc: "2.0", id: "application-permission", method: "session/request_permission", params: { sessionId: "fixture", toolCall: { toolCallId: "application-call", ...(codex ? {} : { _meta: { claudeCode: { toolName: `mcp__learnharness__${name}`, mcpServer: { name: "learnharness" } } } }) }, options: [{ optionId: "once", kind: "allow_once" }] } });
					if ((await permission)?.outcome?.optionId !== "once") throw new Error("Application tool permission was declined");
					const args = mode === "quiz" ? {
						question: "Which planet is closest to the sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Mercury is closest.", type: "check", nodeId: "planet-order",
					} : mode === "validation" && !history.includes('"isError":true') ? { missingRequiredValue: true } : { value: "hello" };
					update("agent_thought_chunk", "Use the app tool.");
					const result = await request("tools/call", { name, arguments: args });
					if (mode === "validation" && result.result?.isError) await request("tools/call", { name, arguments: { value: "hello" } });
				}
				update("agent_message_chunk", "The saved tool result was received.");
			} else if (mode === "inspect") {
				update("agent_message_chunk", JSON.stringify({ cwd: process.cwd(), imageCount: rpc.params.prompt.filter((part) => part.type === "image").length, systemPrompt: session.systemPrompt, meta: session._meta, leaked: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "AWS_SECRET_ACCESS_KEY", "DEEPGRAM_API_KEY"].filter((key) => process.env[key]) }));
			} else {
				update("agent_thought_chunk", "A thought.");
				update("agent_message_chunk", "Hello ");
				update("agent_message_chunk", "from ACP.");
			}
			reply(rpc.id, { stopReason: mode === "length" ? "max_tokens" : mode === "cancelled" ? "cancelled" : "end_turn", usage });
			promptId = undefined;
		} else if (rpc.method === "session/cancel") {
			if (promptId !== undefined) reply(promptId, { stopReason: "cancelled", usage });
			promptId = undefined;
		} else if (rpc.id === "permission") {
			if (rpc.result?.outcome?.outcome !== "cancelled") throw new Error("Native permission was allowed");
			update("agent_message_chunk", "Native permission declined.");
			reply(3, { stopReason: "end_turn" });
		} else if (rpc.id !== undefined) {
			send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown method" } });
		}
	} catch (error) {
		if (rpc.id !== undefined) send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: error.message } });
	}
});
