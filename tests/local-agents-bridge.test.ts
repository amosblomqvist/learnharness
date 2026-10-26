import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

// Local agent connections (docs/architecture.md §8.2): the loopback tool
// bridge, the park/resume matching rules, the transcript, and the small
// server/core seams around them.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-bridge-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
const { startToolBridge } = await import("../src/agent/local-agents/mcp-server.ts");
const { createRun, findRun, StepWriter } = await import("../src/agent/local-agents/run.ts");
const { renderTranscript } = await import("../src/agent/local-agents/transcript.ts");
const { claudeChildEnv } = await import("../src/agent/local-agents/claude.ts");
const { configureAppHeldEnvVars } = await import("../src/agent/local-agents/binaries.ts");
const { configureLocalAgentPreferences, setLocalAgentAdapter, refreshLocalAgents, localAgentStatus } = await import("../src/agent/local-agents/state.ts");
const { localAgentPreferenceStore } = await import("../src/store/local-agents.ts");
const { parseLocalAgentAction } = await import("../src/server/local-agents.ts");
const { subscriptionLabel, isSubscriptionModel } = await import("../src/core/prices.ts");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function post(url: string, token: string | undefined, body: unknown) {
	return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
function sseResult(text: string) { return JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6)); }

test("the MCP bridge is loopback-only, token-gated, and answers parked calls over SSE", async () => {
	let release!: (text: string) => void;
	const bridge = await startToolBridge({
		tools: () => [{ name: "quiz", description: "Pose a quiz.", inputSchema: { type: "object", properties: {} } }],
		call: (request) => new Promise((resolve) => { release = (text) => resolve({ content: [{ type: "text", text: `${request.name}:${text}` }] }); }),
	});
	try {
		assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		assert.equal((await post(bridge.url, undefined, { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
		assert.equal((await post(bridge.url, "0".repeat(64), { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
		const init = await (await post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.equal((await post(bridge.url, bridge.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
		const list = await (await post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
		assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["quiz"]);
		const pending = post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quiz", arguments: {} } });
		await new Promise((resolve) => setTimeout(resolve, 50));
		release("answered");
		const response = await pending;
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		assert.deepEqual(sseResult(await response.text()), { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "quiz:answered" }] } });
	} finally { await bridge.close(); }
});

test("a CLI that abandons a parked call is detected", async () => {
	let abandoned: AbortSignal | undefined;
	const bridge = await startToolBridge({ tools: () => [], call: (request) => { abandoned = request.abandoned; return new Promise(() => {}); } });
	try {
		const controller = new AbortController();
		const request = fetch(bridge.url, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } }) }).then((r) => r.text()).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		await request;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(abandoned?.aborted, true);
	} finally { await bridge.close().catch(() => {}); }
});

const model = { id: "m", name: "m", api: "claude-code-cli", provider: "claude-code", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as never;
const result = (id: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "lookup", content: [{ type: "text", text }], isError: false, timestamp: 0 });

test("a parked run resumes only for exactly its pending calls, same prompt/tools/model, nothing appended", async () => {
	const run = createRun({ key: "k1", providerId: "claude-code", signature: "sig", model, surfaceOnArrival: false, tools: [], idleMs: 60_000 });
	const out = new AssistantMessageEventStream();
	run.attach(new StepWriter(out, model), [{ role: "user", content: "q", timestamp: 0 }]);
	run.declareToolCall({ id: "call-1", name: "lookup", arguments: { topic: "a" } });
	run.endMessage("stop");
	const step = await out.result();
	assert.equal(step.stopReason, "toolUse");
	assert.equal(run.parked, true);
	const history: Message[] = [{ role: "user", content: "q", timestamp: 0 }, step];
	assert.deepEqual(run.resumable([...history, result("call-1", "A")], "sig")?.map((r) => r.toolCallId), ["call-1"]);
	assert.equal(run.resumable([...history, result("call-1", "A")], "other-signature"), undefined, "prompt/tools/model changed");
	assert.equal(run.resumable([...history, result("call-1", "A"), { role: "user", content: "steer", timestamp: 0 }], "sig"), undefined, "a new user message");
	assert.equal(run.resumable([...history, result("call-9", "A")], "sig"), undefined, "a different call");
	assert.equal(run.resumable(history, "sig"), undefined, "no result yet");
	// The MCP request claims the call; pi's result answers it.
	const answer = run.onBridgeCall({ name: "lookup", arguments: { topic: "a" }, abandoned: new AbortController().signal });
	const next = new AssistantMessageEventStream();
	run.resume(new StepWriter(next, model), [result("call-1", "A")], model, [...history, result("call-1", "A")]);
	assert.deepEqual(await answer, { content: [{ type: "text", text: "A" }] });
	run.text("done");
	run.endMessage("stop");
	assert.equal((await next.result()).stopReason, "stop");
	assert.equal(findRun("k1"), undefined, "a finished run releases itself");
});

test("ACP-style runs surface tool calls when the MCP request arrives", async () => {
	const run = createRun({ key: "k2", providerId: "antigravity", signature: "sig", model, surfaceOnArrival: true, tools: [], idleMs: 60_000 });
	const out = new AssistantMessageEventStream();
	run.attach(new StepWriter(out, model), [{ role: "user", content: "q", timestamp: 0 }]);
	run.text("let me check");
	const answer = run.onBridgeCall({ name: "lookup", arguments: { topic: "b" }, abandoned: new AbortController().signal });
	const step = await out.result();
	assert.equal(step.stopReason, "toolUse");
	const call = step.content.find((c) => c.type === "toolCall")!;
	assert.equal(call.type === "toolCall" && call.name, "lookup");
	run.resume(new StepWriter(new AssistantMessageEventStream(), model), [result(call.type === "toolCall" ? call.id : "", "B")], model, []);
	assert.deepEqual(await answer, { content: [{ type: "text", text: "B" }] });
	run.close();
});

test("closing a run answers every parked call so no CLI hangs", async () => {
	const run = createRun({ key: "k3", providerId: "claude-code", signature: "sig", model, surfaceOnArrival: false, tools: [], idleMs: 60_000 });
	run.attach(new StepWriter(new AssistantMessageEventStream(), model), []);
	run.declareToolCall({ id: "c", name: "lookup", arguments: {} });
	const answer = run.onBridgeCall({ name: "lookup", arguments: {}, abandoned: new AbortController().signal });
	run.close();
	assert.equal((await answer).isError, true);
});

test("the transcript replays history once, then the new learner input as plain blocks", () => {
	const blocks = renderTranscript([
		{ role: "user", content: "first", timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "toolCall", id: "t1", name: "quiz", arguments: { q: 1 } }], api: "x", provider: "x", model: "x", usage: {} as never, stopReason: "toolUse", timestamp: 0 },
		{ role: "toolResult", toolCallId: "t1", toolName: "quiz", content: [{ type: "text", text: "B" }, { type: "image", data: "AA==", mimeType: "image/png" }], isError: false, timestamp: 0 },
		{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 0 },
	], { images: false });
	assert.match((blocks[0] as { text: string }).text, /conversation so far/);
	assert.equal((blocks[1] as { text: string }).text, "<user>\nfirst\n</user>");
	assert.equal((blocks[2] as { text: string }).text, '<assistant>\nhello\n<tool_call id="t1" name="quiz">{"q":1}</tool_call>\n</assistant>');
	assert.equal((blocks[3] as { text: string }).text, '<tool_result id="t1" name="quiz" status="ok">\nB\n</tool_result>');
	assert.deepEqual(blocks[4], { type: "text", text: "[image omitted: image/png]" });
	assert.deepEqual(blocks.at(-1), { type: "text", text: "next" });
	assert.deepEqual(renderTranscript([{ role: "user", content: "only", timestamp: 0 }], { images: true }), [{ type: "text", text: "only" }]);
});

test("the Claude Code child never inherits app-held provider keys or auth reroutes", () => {
	const env = claudeChildEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://proxy", OPENAI_API_KEY: "o", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "learner-own-token" } as unknown as NodeJS.ProcessEnv);
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]) assert.equal(env[key], undefined, key);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "learner-own-token", "the learner's own Claude Code token setup is theirs to keep");
	assert.equal(env.PATH, "/bin");
});

test("preferences persist only the two choices, defaulting to off", () => {
	assert.deepEqual(localAgentPreferenceStore.read(), {});
	localAgentPreferenceStore.write("claude-code", { enabled: true, allowBackgroundUse: false });
	assert.deepEqual(localAgentPreferenceStore.read(), { "claude-code": { enabled: true, allowBackgroundUse: false } });
	fs.writeFileSync(path.join(process.env.LH_DATA_DIR!, "local-agents.json"), "{not json");
	assert.deepEqual(localAgentPreferenceStore.read(), {});
});

test("control actions are shape-gated", () => {
	assert.deepEqual(parseLocalAgentAction({ action: "enable", enabled: true }), { action: "enable", enabled: true });
	assert.deepEqual(parseLocalAgentAction({ action: "consent", allowBackgroundUse: false }), { action: "consent", allowBackgroundUse: false });
	assert.equal(parseLocalAgentAction({ action: "enable" }), null);
	assert.equal(parseLocalAgentAction({ action: "logout" }), null);
	assert.equal(parseLocalAgentAction([]), null);
});

test("usage on local agent connections reads as the plan, never dollars", () => {
	assert.equal(subscriptionLabel("claude-code:claude-opus-5-5"), "Claude");
	assert.equal(subscriptionLabel("antigravity:gemini-x"), "Antigravity");
	assert.equal(isSubscriptionModel("anthropic:claude-opus-5-5"), false);
});

// ── regressions from review ──────────────────────────────────────────────

test("a lone tools/call always gets a response: malformed → JSON error, no id → 202, batched → error", async () => {
	const bridge = await startToolBridge({ tools: () => [], call: async () => ({ content: [{ type: "text", text: "ok" }] }) });
	try {
		const noName = await post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} });
		assert.deepEqual(await noName.json(), { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "tool name required" } });
		assert.equal((await post(bridge.url, bridge.token, { jsonrpc: "2.0", method: "tools/call", params: { name: "x" } })).status, 202);
		const batched = await (await post(bridge.url, bridge.token, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } }])).json();
		assert.deepEqual(batched, [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "tools/call cannot be batched" } }]);
	} finally { await bridge.close(); }
});

function parkedRun(key: string, surfaceOnArrival = false) {
	const run = createRun({ key, providerId: surfaceOnArrival ? "antigravity" : "claude-code", signature: "sig", model, surfaceOnArrival, tools: [], idleMs: 60_000 });
	const out = new AssistantMessageEventStream();
	run.attach(new StepWriter(out, model), [{ role: "user", content: "q", timestamp: 0 }]);
	return { run, out };
}

test("history rewritten under a parked run (compaction) forces a cold start", async () => {
	const { run, out } = parkedRun("k-hist");
	run.declareToolCall({ id: "h1", name: "lookup", arguments: {} });
	run.endMessage("stop");
	const step = await out.result();
	assert(run.resumable([{ role: "user", content: "q", timestamp: 0 }, step, result("h1", "A")], "sig"));
	assert.equal(run.resumable([{ role: "user", content: "[summary of the session so far]", timestamp: 0 }, step, result("h1", "A")], "sig"), undefined);
	run.close();
});

test("a CLI that moves on while parked (settled a call itself) is released, not resumed into a hang", async () => {
	const { run, out } = parkedRun("k-moved");
	run.declareToolCall({ id: "m1", name: "lookup", arguments: {} });
	run.endMessage("stop");
	await out.result();
	run.messageStarted();
	assert.equal(run.closed, true);
	assert.equal(findRun("k-moved"), undefined);
	const { run: acp, out: acpOut } = parkedRun("k-turn", true);
	void acp.onBridgeCall({ name: "lookup", arguments: {}, abandoned: new AbortController().signal });
	await acpOut.result();
	acp.endTurn("stop");
	assert.equal(acp.closed, true);
});

test("ACP calls that arrive while parked surface in the resumed step", async () => {
	const { run, out } = parkedRun("k-queue", true);
	const first = run.onBridgeCall({ name: "lookup", arguments: { n: 1 }, abandoned: new AbortController().signal });
	const step = await out.result();
	const firstId = step.content.find((c) => c.type === "toolCall")!;
	const second = run.onBridgeCall({ name: "lookup", arguments: { n: 2 }, abandoned: new AbortController().signal });
	const history: Message[] = [{ role: "user", content: "q", timestamp: 0 }, step, result(firstId.type === "toolCall" ? firstId.id : "", "one")];
	const results = run.resumable(history, "sig");
	assert(results, "the surfaced call alone decides resumability");
	const next = new AssistantMessageEventStream();
	run.resume(new StepWriter(next, model), results, model, history);
	assert.deepEqual(await first, { content: [{ type: "text", text: "one" }] });
	const step2 = await next.result();
	const queued = step2.content.find((c) => c.type === "toolCall")!;
	assert.deepEqual(queued.type === "toolCall" && queued.arguments, { n: 2 });
	run.resume(new StepWriter(new AssistantMessageEventStream(), model), [result(queued.type === "toolCall" ? queued.id : "", "two")], model, []);
	assert.deepEqual(await second, { content: [{ type: "text", text: "two" }] });
	run.close();
});

test("tool-service keys and anything saved in the key store never reach a vendor runtime", () => {
	configureAppHeldEnvVars(() => ["MY_SAVED_TOKEN"]);
	const env = claudeChildEnv({ DEEPGRAM_API_KEY: "d", TAVILY_API_KEY: "t", MY_SAVED_TOKEN: "s", PATH: "/bin" } as unknown as NodeJS.ProcessEnv);
	assert.deepEqual([env.DEEPGRAM_API_KEY, env.TAVILY_API_KEY, env.MY_SAVED_TOKEN, env.PATH], [undefined, undefined, undefined, "/bin"]);
	configureAppHeldEnvVars(() => []);
});

test("an inconclusive sign-in check keeps the connection instead of tearing live work down", async () => {
	const prefs: Record<string, { enabled: boolean; allowBackgroundUse: boolean }> = { "claude-code": { enabled: true, allowBackgroundUse: true } };
	configureLocalAgentPreferences({ read: () => prefs, write: (id, value) => { prefs[id] = value; } });
	let uncertain = false;
	const models = [model];
	setLocalAgentAdapter({ providerId: "claude-code", surfaceOnArrival: false, images: false, open: async () => { throw new Error("unused"); },
		probe: async () => uncertain ? { installed: true, signedIn: false, models: [], uncertain: true } : { installed: true, signedIn: true, account: "a@b.c", models } });
	await refreshLocalAgents({ providerId: "claude-code", force: true });
	const before = localAgentStatus("claude-code");
	assert.equal(before.connected, true);
	uncertain = true;
	await refreshLocalAgents({ providerId: "claude-code", force: true });
	const afterStatus = localAgentStatus("claude-code");
	assert.equal(afterStatus.connected, true);
	assert.equal(afterStatus.generation, before.generation);
});
