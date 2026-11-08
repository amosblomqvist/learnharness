import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { CODEX_ARGS, CodexClient, codexEnv } from "../src/agent/codex/client.ts";
import { codexModel, setCodexSource } from "../src/agent/codex/provider.ts";
import { createCodexStream } from "../src/agent/codex/stream.ts";
import { CodexOwner, codexResponse, safeCodexAuthUrl } from "../src/server/codex.ts";
import { modelCatalog, toModelDto, validateChatSettings } from "../src/server/model-catalog.ts";
import { piEngineForSpec } from "../src/agent/models.ts";
import { callCost } from "../src/server/pricing.ts";
import { sanitizeUserSettings, isProviderKeyRefusal, providerKeyMissing } from "../src/core/settings.ts";

const fixture = fileURLToPath(new URL("./fixtures/codex/fake-codex.mjs", import.meta.url));
const model = codexModel({ model: "fixture-model", displayName: "Fixture Codex", inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] });
const context = normalizeContext({ systemPrompt: "Teach one idea at a time.", tools: [{ name: "quiz", description: "Ask a quiz", parameters: Type.Object({ question: Type.String() }) }],
	messages: [{ role: "user", content: "Explain derivatives", timestamp: 1 }] });
async function fake(mode = "text", extra: Record<string, string> = {}) {
	const client = new CodexClient(spawn(process.execPath, [fixture], { stdio: "pipe", env: { ...process.env, ...extra, LH_CODEX_MODE: mode } }));
	await client.request("initialize", { clientInfo: { name: "learnharness" } }); client.notify("initialized");
	return client;
}

test("Codex environment removes API billing routes and parent identity", () => {
	const names = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN", "CODEX_THREAD_ID"];
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	try {
		for (const name of names) process.env[name] = "fixture-private";
		const env = codexEnv("/fixture/profile");
		for (const name of names) assert.equal(env[name], undefined);
		assert.equal(env.CODEX_HOME, "/fixture/profile");
		assert(CODEX_ARGS.includes('forced_login_method="chatgpt"'));
		assert(CODEX_ARGS.includes("features.shell_tool=false"));
	} finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
});

test("Codex metadata comes from model/list, with unknown costs and limits", () => {
	assert.deepEqual(getSupportedThinkingLevels(model), ["low", "high"]);
	const dto = toModelDto(model); assert.equal(dto.cost, null); assert.equal(dto.contextWindow, null); assert.equal(dto.maxTokens, null);
	assert.equal(callCost({ inputTokens: 100, outputTokens: 20 }, "codex:fixture-model"), null);
	assert.equal(sanitizeUserSettings({ version: 1, codex: { enabled: "yes" } })?.codex?.enabled, undefined);
	assert(isProviderKeyRefusal(providerKeyMissing("codex", ["strong"]).error));
});

test("Codex stream carries harness prompt, schemas and reasoning to app-server", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-test-")), log = path.join(dir, "requests.jsonl");
	try {
		const stream = createCodexStream(() => fake("text", { LH_CODEX_TEST_LOG: log }))(model, context, { reasoning: "high" });
		const events = []; for await (const event of stream) events.push(event);
		const result = await stream.result();
		assert.equal(result.stopReason, "stop"); assert.deepEqual(result.content, [{ type: "text", text: "Let's learn." }]);
		assert.equal(result.usage.input, 75); assert.equal(result.usage.cacheRead, 25); assert.equal(result.usage.totalTokens, 112);
		assert(events.some((event) => event.type === "text_delta"));
		const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const thread = requests.find((r) => r.method === "thread/start").params;
		assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, "read-only"); assert.equal(thread.allowProviderModelFallback, false);
		assert.equal(thread.baseInstructions, "Teach one idea at a time."); assert.equal(thread.dynamicTools[0].name, "quiz");
		assert.equal(thread.dynamicTools[0].inputSchema.properties.question.type, "string");
		assert.equal(requests.find((r) => r.method === "turn/start").params.effort, "high");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("native Agent executes a Codex lesson tool and replays its result on the next operation", async () => {
	let executions = 0;
	const agent = new Agent({ initialState: { model, systemPrompt: "Teach derivatives.", tools: [{ name: "quiz", label: "Quiz", description: "Ask a quiz",
		parameters: Type.Object({ question: Type.String() }), execute: async (_id, args) => {
			executions++; assert.equal((args as { question: string }).question, "Why?"); return { content: [{ type: "text" as const, text: "The learner answered: rate of change." }], details: {} };
		} }] }, streamFn: createCodexStream(() => fake("lesson")) });
	await agent.prompt("Help me understand the derivative.");
	assert.equal(executions, 1);
	assert.equal(agent.state.messages.filter((m) => m.role === "toolResult").length, 1);
	const last = agent.state.messages.at(-1); assert.equal(last?.role, "assistant");
	if (last?.role === "assistant") assert.equal(last.stopReason, "stop");
});

test("image and prior tool-result context survive the Codex replay boundary", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-replay-")), log = path.join(dir, "requests.jsonl");
	try {
		const image = { type: "image" as const, mimeType: "image/png", data: "fixture-image-bytes" };
		const replay = normalizeContext({ messages: [{ role: "user", content: [image], timestamp: 1 },
			{ role: "toolResult", toolCallId: "previous", toolName: "read", content: [{ type: "text", text: "File missing" }, image], isError: true, timestamp: 2 }] });
		await createCodexStream(() => fake("text", { LH_CODEX_TEST_LOG: log }))(model, replay).result();
		const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const input = requests.find((r) => r.method === "turn/start").params.input;
		assert.equal(input.filter((part: any) => part.type === "image").length, 2);
		assert(input.some((part: any) => part.type === "text" && part.text.includes("[tool result read error]")));
		assert(input.some((part: any) => part.url === "data:image/png;base64,fixture-image-bytes"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

for (const reasoning of ["max", undefined] as const) test(`native Codex effort ${reasoning ?? "none"} is preserved`, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-effort-")), log = path.join(dir, "requests.jsonl");
	try {
		const mapped = codexModel({ model: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "none" }] });
		assert.deepEqual(getSupportedThinkingLevels(mapped), ["off", "max"]);
		await createCodexStream(() => fake("text", { LH_CODEX_TEST_LOG: log }))(mapped, context, { reasoning }).result();
		const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(requests.find((r) => r.method === "turn/start").params.effort, reasoning ?? "none");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("actual dynamic tool requests become native Pi tool calls exactly once", async () => {
	const stream = createCodexStream(() => fake("tool"))(model, context);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	const calls = result.content.filter((b) => b.type === "toolCall");
	assert.equal(calls.length, 1); assert.equal(calls[0]?.name, "quiz"); assert.deepEqual(calls[0]?.arguments, { question: "Why?" });
});

for (const mode of ["failed", "bad-tool", "native", "crash"]) test(`Codex ${mode} fails closed without a fallback`, async () => {
	const result = await createCodexStream(() => fake(mode))(model, context).result();
	assert.equal(result.stopReason, "error");
	assert.equal(result.content.filter((b) => b.type === "toolCall").length, 0);
});

test("aborting an idle Codex process settles the Pi stream", async () => {
	const controller = new AbortController();
	const stream = createCodexStream(() => fake("hang"))(model, context, { signal: controller.signal });
	setTimeout(() => controller.abort(), 100);
	assert.equal((await stream.result()).stopReason, "aborted");
});

test("tool intents are not executed; pre-aborted requests never start a process", async () => {
	const controller = new AbortController();
	const stream = createCodexStream(() => fake("intent-only"))(model, context, { signal: controller.signal });
	setTimeout(() => controller.abort(), 200);
	const result = await stream.result(); assert.equal(result.content.filter((b) => b.type === "toolCall").length, 0);
	const abort = new AbortController(); abort.abort();
	const unused = createCodexStream(async () => { assert.fail("must not connect"); })(model, context, { signal: abort.signal });
	assert.equal((await unused.result()).stopReason, "aborted");
});

test("signed-out Codex never starts inference", async () => {
	const result = await createCodexStream(() => fake("text", { LH_CODEX_SIGNED_OUT: "1" }))(model, context).result();
	assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /Sign in/);
});

test("owner supports login, catalog publication, opt-out and isolated cleanup", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-owner-test-"));
	let enabled = true;
	const owner = new CodexOwner(path.join(dir, "profile"), () => enabled, () => fake("text", { LH_CODEX_SIGNED_OUT: "1", LH_CODEX_LOGIN_SUCCESS: "1" }));
	try {
		await owner.refresh(); assert.equal(owner.snapshot().state, "signed-out");
		await owner.control("login"); assert.equal(owner.snapshot().state, "signing-in");
		assert.match(owner.snapshot().authUrl!, /^https:\/\/auth.openai.com\//);
		await new Promise((resolve) => setTimeout(resolve, 250)); await owner.refresh(true);
		assert.equal(owner.snapshot().state, "connected"); assert.equal(owner.snapshot().authUrl, undefined);
		assert.equal(piEngineForSpec({ provider: "codex", id: "fixture-model" }).model.provider, "codex");
		enabled = false; await owner.refresh(); assert.equal(owner.snapshot().state, "disabled");
		assert(!modelCatalog().models.some((m) => m.provider === "codex"));
		assert.equal(validateChatSettings({ model: { provider: "codex", id: "fixture-model" } }).ok, false);
	} finally { owner.close(); setCodexSource(); await rm(dir, { recursive: true, force: true }); }
});

test("Codex HTTP rejects forged origins and missing intent before starting processes", async () => {
	for (const headers of [{}, { "x-learnharness-codex": "1", origin: "https://attacker.invalid" }, { "x-learnharness-codex": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
		assert.equal((await codexResponse(new Request("http://localhost:3000/api/codex", { headers }))).status, 403);
	}
	assert.equal((await codexResponse(new Request("http://localhost:3000/api/codex", { method: "POST", headers: { "x-learnharness-codex": "1" } }))).status, 403);
	for (const url of ["javascript:alert(1)", "http://auth.openai.com/login", "https://auth.openai.com.evil.invalid", "https://user:pass@auth.openai.com"]) assert(!safeCodexAuthUrl(url));
});

test("cancelling login and signing out clear public sign-in state", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-cancel-test-"));
	const owner = new CodexOwner(path.join(dir, "profile"), () => true, () => fake("text", { LH_CODEX_SIGNED_OUT: "1" }));
	try {
		await owner.control("login"); assert.equal(owner.snapshot().state, "signing-in");
		await owner.control("cancel"); assert.equal(owner.snapshot().authUrl, undefined); assert.equal(owner.snapshot().state, "signed-out");
		await owner.control("logout"); assert.equal(owner.snapshot().state, "signed-out");
	} finally { owner.close(); await rm(dir, { recursive: true, force: true }); }
});

test("disabling Codex terminates an already running model operation", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-opt-out-test-"));
	let enabled = true, connections = 0, infer!: () => void;
	const launched = new Promise<void>((resolve) => { infer = resolve; });
	const owner = new CodexOwner(path.join(dir, "profile"), () => enabled, async () => {
		const client = await fake(connections++ === 0 ? "text" : "hang");
		if (connections > 1) infer(); return client;
	});
	try {
		await owner.refresh();
		const engine = piEngineForSpec({ provider: "codex", id: "fixture-model" });
		const stream = engine.streamFn(engine.model, context);
		await launched; await new Promise((resolve) => setTimeout(resolve, 30));
		enabled = false; owner.close();
		assert.equal((await stream.result()).stopReason, "error");
		assert.equal(owner.available(), false);
	} finally { owner.close(); await rm(dir, { recursive: true, force: true }); }
});
