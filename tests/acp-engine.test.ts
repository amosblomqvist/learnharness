import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Type, normalizeContext, type AssistantMessageEvent, type Message } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { acpPrompt, createAcpEngine } from "../src/agent/acp/engine.ts";
import { subscriptionEnv, AcpClient } from "../src/agent/acp/client.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { toToolResult } from "../src/agent/tool-execute.ts";
import type { AcpAgentId } from "../src/core/acp.ts";
import { usageToCallUsage } from "../src/core/usage.ts";
import { piUsageToStep, accumulateJobUsage } from "../src/core/contracts/jobs.ts";
import { assertProcessStopped } from "./helpers/process-stopped.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "acp-agent.mjs");
const config = (mode = "text") => ({ command: process.execPath, args: [fixture, mode] });
const user = (content = "Teach me") => ({ role: "user" as const, content, timestamp: Date.now() });
const context = () => normalizeContext({ systemPrompt: "Tutor instructions.", messages: [user()] });
const text = (message: { content: Array<{ type: string; text?: string }> }) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");

describe("ACP engine over real subprocess stdio", () => {
	for (const id of ["codex", "claude"] as const) {
		it(`${id}: streams thinking/text and completes with subscription identity`, async () => {
			const engine = createAcpEngine(id, config());
			const stream = engine.streamFn(engine.model, context());
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			assert.equal(result.provider, `acp-${id}`);
			assert.equal(result.stopReason, "stop");
			assert.equal(text(result), "Hello from ACP.");
			assert.deepEqual(events.map((event) => event.type), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
			assert.equal(result.usage.cost.total, 0);
			assert.equal(result.usage.totalTokens, 194);
			assert.equal(result.usage.cacheRead, 50);
			assert.equal(result.usage.reasoning, 11);
		});

		it(`${id}: MCP tools execute in pi, return through history, and retry schema errors`, async () => {
			const calls: string[] = [];
			const parameters = Type.Object({ value: Type.String() });
			const submit: AgentTool<typeof parameters> = {
				name: "submit", label: "submit", description: "Submit a value", parameters,
				execute: async (_id, input) => { calls.push(input.value); return toToolResult("captured value"); },
			};
			const result = await runSubagent([submit], { role: "extractor", engine: createAcpEngine(id, config("validation")), systemPrompt: "Use submit.", prompt: "Submit hello", maxTurns: 4 });
			assert.deepEqual(calls, ["hello"], "invalid input never executes and valid input executes once");
			assert.match(result.text, /saved tool result/);
			const results = result.newMessages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 2);
			assert.equal((results[0] as { isError: boolean }).isError, true);
		});
	}

	it("a real teacher question pauses; answering resumes from the app record", async () => {
		const engine = createAcpEngine("codex", config("quiz"));
		const teacher = createTeacherAgent(undefined, { engine, messages: [user()] });
		await teacher.continue();
		const assistant = teacher.state.messages.find((message) => message.role === "assistant");
		assert.ok(assistant && assistant.role === "assistant");
		const quiz = assistant.content.find((part) => part.type === "toolCall");
		assert.ok(quiz && quiz.type === "toolCall");
		assert.equal(quiz.name, "quiz");
		assert.equal(teacher.state.messages.filter((message) => message.role === "assistant").length, 1, "no extra native turn after a question");
		const messages: Message[] = [user(), assistant, { role: "toolResult", toolCallId: quiz.id, toolName: "quiz", content: [{ type: "text", text: "Mercury — correct" }], isError: false, timestamp: Date.now() }];
		const next = createTeacherAgent(undefined, { engine, messages });
		await next.continue();
		const final = next.state.messages.at(-1);
		assert.ok(final && final.role === "assistant");
		assert.match(text(final), /saved tool result/);
	});

	it("passes current system instructions and images, never API keys, then removes workspace", async () => {
		const engine = createAcpEngine("claude", config("inspect"));
		const result = await engine.streamFn(engine.model, normalizeContext({
			systemPrompt: "Old prompt", messages: [user(), { role: "system", content: "Updated prompt", timestamp: Date.now() }, { role: "user", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], timestamp: Date.now() }],
		})).result();
		const inspected = JSON.parse(text(result));
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(inspected.imageCount, 1);
		assert.match(JSON.stringify(inspected.systemPrompt), /Old prompt.*Updated prompt/);
		assert.deepEqual(inspected.meta.claudeCode.options.tools, []);
		assert.deepEqual(inspected.leaked, []);
		assert.equal(existsSync(inspected.cwd), false);
	});

	for (const [mode, pattern] of [["auth", /Authentication required/], ["api-auth", /subscription account login is required/], ["version", /protocol version/], ["exit", /exited/], ["malformed", /invalid JSON/]] as const) {
		it(`reports ${mode} without API fallback`, async () => {
			const engine = createAcpEngine("codex", config(mode));
			const result = await engine.streamFn(engine.model, context()).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage!, pattern);
		});
	}
	it("refuses an agent without MCP when tools are required", async () => {
		const engine = createAcpEngine("claude", config("no-http"));
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [user()], tools: [{ name: "submit", description: "Submit", parameters: Type.Object({}) }] })).result();
		assert.match(result.errorMessage!, /HTTP MCP/);
	});
	it("refuses image input instead of silently dropping it", async () => {
		const engine = createAcpEngine("claude", config("no-image"));
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], timestamp: Date.now() }] })).result();
		assert.match(result.errorMessage!, /image input/);
	});
	it("aborts an active prompt and kills adapter descendants", async () => {
		const controller = new AbortController();
		const engine = createAcpEngine("codex", config("hang"));
		const stream = engine.streamFn(engine.model, context(), { signal: controller.signal });
		let inspected: { cwd: string; pid: number; child: number } | undefined;
		for await (const event of stream) {
			if (event.type === "text_delta") { inspected = JSON.parse(event.delta); controller.abort(); }
		}
		assert.equal((await stream.result()).stopReason, "aborted");
		assert.ok(inspected);
		// Cleanup is awaited before the stream iterator ends.
		assert.equal(existsSync(inspected.cwd), false);
		for (const pid of [inspected.pid, inspected.child]) await assertProcessStopped(pid);
	});
	it("an already-aborted request never starts an adapter", async () => {
		const controller = new AbortController(); controller.abort();
		const engine = createAcpEngine("codex", { command: "does-not-exist-acp" });
		assert.equal((await engine.streamFn(engine.model, context(), { signal: controller.signal }).result()).stopReason, "aborted");
	});
	it("retains ownership of descendants after the adapter exits", async () => {
		let descendant: number | undefined;
		const client = new AcpClient("codex", config("orphan"), { onNotification: (_method, params) => {
			const update = params.update as { content?: { text?: string } };
			if (update?.content?.text) descendant = JSON.parse(update.content.text).child;
		} });
		try {
			await client.initialize();
			const session = await client.newSession({ mcpServers: [] });
			await assert.rejects(client.request("session/prompt", { sessionId: session.sessionId, prompt: [] }), /exited/);
			await new Promise((resolve) => setTimeout(resolve, 300));
			// Positive control: the cleanup assertion must reject a running PID.
			await assert.rejects(assertProcessStopped(process.pid, 0), /still running/);
			await client.close();
			assert.ok(descendant);
			await assertProcessStopped(descendant);
		} finally {
			await client.close();
			if (descendant) { try { process.kill(descendant); } catch { /* Already disposed by the client. */ } }
		}
	});
	for (const mode of ["usage-missing", "usage-partial"] as const) {
		it(`${mode}: persists only reported token counts, including measured zero`, async () => {
			const engine = createAcpEngine("codex", config(mode));
			const message = await engine.streamFn(engine.model, context()).result();
			assert.equal(message.stopReason, "stop", message.errorMessage);
			const savedUsage = JSON.parse(JSON.stringify(message.usage));
			const call = usageToCallUsage(savedUsage);
			assert.equal(call.inputTokens, mode === "usage-partial" ? 0 : undefined);
			assert.equal(call.reasoningTokens, mode === "usage-partial" ? 8 : undefined);
			assert.equal(call.outputTokens, undefined);
			assert.equal(call.cacheReadTokens, undefined);
			const job = accumulateJobUsage(undefined, "acp-codex:default", piUsageToStep(savedUsage));
			assert.equal(job.inputTokens, call.inputTokens);
			assert.equal(job.outputTokens, undefined);
			assert.equal(job.reasoningTokens, call.reasoningTokens);
		});
	}
	it("aborting during a tool handoff remains an aborted model call", async () => {
		const controller = new AbortController();
		const engine = createAcpEngine("claude", config("tool"));
		const stream = engine.streamFn(engine.model, normalizeContext({ messages: [user()], tools: [{ name: "submit", description: "Submit", parameters: Type.Object({ value: Type.String() }) }] }), { signal: controller.signal });
		for await (const event of stream) if (event.type === "toolcall_end") controller.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
	});
	it("RPC timeout closes cleanly and unsupported native permissions are declined", async () => {
		const client = new AcpClient("codex", config());
		try { await assert.rejects(client.request("hang-request", {}, 1000), /timed out/); }
		finally { await client.close(); }
		const engine = createAcpEngine("codex", config("permission"));
		const result = await engine.streamFn(engine.model, context()).result();
		assert.equal(text(result), "Native permission declined.");
	});
});

describe("subscription environment and transcript", () => {
	it("isolates API credentials and routing overrides without touching the parent", () => {
		const parent: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "test-path", HOME: "test-home", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", OPENROUTER_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", DEEPGRAM_API_KEY: "secret", ANTHROPIC_BASE_URL: "https://unexpected.test", CODEX_HOME: "native-login" };
		for (const id of ["codex", "claude"] satisfies AcpAgentId[]) {
			const env = subscriptionEnv(id, parent);
			assert.equal(env.PATH, parent.PATH);
			assert.equal(env.CODEX_HOME, "native-login");
			for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "AWS_SECRET_ACCESS_KEY", "DEEPGRAM_API_KEY", "ANTHROPIC_BASE_URL"]) assert.equal(env[key], undefined);
		}
		assert.equal(parent.OPENAI_API_KEY, "secret");
	});
	it("history images remain images and private reasoning/signatures are not replayed", () => {
		const blocks = acpPrompt(normalizeContext({ systemPrompt: "Tutor instructions.", messages: [user(), {
			role: "assistant", content: [{ type: "thinking", thinking: "private reasoning", thinkingSignature: "private-signature" }, { type: "text", text: "Visible answer" }], model: "default", provider: "acp-codex", api: "acp", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}, { role: "user", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], timestamp: Date.now() }] }));
		assert.match(JSON.stringify(blocks), /Teach me/);
		assert.match(JSON.stringify(blocks), /Visible answer/);
		assert.doesNotMatch(JSON.stringify(blocks), /Tutor instructions|private reasoning|private-signature/);
		assert.deepEqual(blocks.find((part) => part.type === "image"), { type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
	});
});
