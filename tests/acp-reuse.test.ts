import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { normalizeContext, Type, type Message, type ToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAcpEngine, closeAcpSessions } from "../src/agent/acp/engine.ts";
import { usageToCallUsage } from "../src/core/usage.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { toToolResult } from "../src/agent/tool-execute.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { AcpClient } from "../src/agent/acp/client.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "acp-agent.mjs");
const parameters = Type.Object({ value: Type.String() });
const declaration = { name: "submit", description: "Submit", parameters };
const initial: Message = { role: "user", content: "Submit hello", timestamp: 1 };
const contentText = (message: AssistantMessage) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
const tool = (message: AssistantMessage) => { const call = message.content.find((part) => part.type === "toolCall"); assert.ok(call); return call; };
const resultFor = (call: ToolCall): Message => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "Actual app result" }], isError: false, timestamp: 2 });
const context = (messages: Message[], systemPrompt = "Use submit.", tools = [declaration]) => normalizeContext({ systemPrompt, tools, messages });

function reuseFixture(test: TestContext, id: "codex" | "claude" = "claude", mode = "reuse") {
	const root = mkdtempSync(path.join(tmpdir(), "lh-acp-reuse-"));
	const trace = path.join(root, "calls.jsonl");
	const config = { command: process.execPath, args: [fixture, mode, trace] };
	test.after(async () => {
		await closeAcpSessions();
		if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("lh-acp-reuse-")) rmSync(root, { recursive: true, force: true });
	});
	return { root, trace, config, engine: createAcpEngine(id, config), events: () => readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

describe("ACP native session reuse", () => {
	for (const id of ["codex", "claude"] as const) {
		it(`${id}: one native session spans Pi tool execution and receives its actual result`, async (test) => {
			const root = mkdtempSync(path.join(tmpdir(), "lh-acp-reuse-"));
			test.after(() => { if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("lh-acp-reuse-")) rmSync(root, { recursive: true, force: true }); });
			const trace = path.join(root, "calls.jsonl");
			const calls: string[] = [];
			const submit: AgentTool<typeof parameters> = { name: "submit", label: "Submit", description: "Submit", parameters,
				execute: async (_id, input) => { calls.push(input.value); return toToolResult(`Actual app result: ${input.value}`); } };
			const engine = createAcpEngine(id, { command: process.execPath, args: [fixture, "reuse", trace] });
			const result = await runSubagent([submit], { role: "extractor", engine, systemPrompt: "Use submit.", prompt: "Submit hello", maxTurns: 4 });
			assert.deepEqual(calls, ["hello"]);
			const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(events.filter((event) => event.event === "initialize").length, 1, "the tool result must resume the existing native process");
			assert.equal(events.filter((event) => event.event === "session").length, 1);
			assert.equal(events.filter((event) => event.event === "prompt").length, 1);
			const final = JSON.parse(result.text);
			assert.equal(final.replayed, false);
			assert.equal(final.pid, events[0]!.pid);
			assert.match(JSON.stringify(final.results), /Actual app result: hello/);
		});
	}

	for (const id of ["codex", "claude"] as const) for (const mode of ["reuse-multiple", "reuse-parallel", "reuse-validation"]) {
		it(`${id}: ${mode} preserves tool execution and records reported usage once`, async (test) => {
			const f = reuseFixture(test, id, mode);
			const calls: string[] = [];
			const submit: AgentTool<typeof parameters> = { ...declaration, label: "Submit", execute: async (_id, input) => { calls.push(input.value); return toToolResult(`Actual app result: ${input.value}`); } };
			const run = await runSubagent([submit], { role: "extractor", engine: f.engine, systemPrompt: "Use submit.", prompt: "Submit", maxTurns: 5 });
			assert.deepEqual(calls, mode === "reuse-multiple" ? ["hello", "again"] : mode === "reuse-parallel" ? ["one", "two"] : ["hello"]);
			assert.equal(f.events().filter((event) => event.event === "session").length, 1);
			const assistants = run.newMessages.filter((message) => message.role === "assistant");
			assert.equal(assistants.reduce((sum, message) => sum + (usageToCallUsage(message.usage).inputTokens ?? 0), 0), 123);
			assert.equal(usageToCallUsage(assistants[0]!.usage).inputTokens, undefined);
			if (mode === "reuse-validation") assert.equal(run.newMessages.filter((message) => message.role === "toolResult" && message.isError).length, 1);
			assert.equal(JSON.parse(run.text).replayed, false);
		});
	}

	it("a question-style pause resumes through a new engine using its saved conversation ID", async (test) => {
		const f = reuseFixture(test);
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
		assert.equal(first.stopReason, "toolUse");
		const resumed = createAcpEngine("claude", f.config);
		const last = await resumed.streamFn(resumed.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson" }).result();
		assert.equal(last.stopReason, "stop", last.errorMessage);
		assert.equal(JSON.parse(contentText(last)).pid, JSON.parse(contentText(first)).pid);
		assert.equal(f.events().filter((event) => event.event === "session").length, 1);
	});

	it("a real teacher question waits for the learner and resumes in a new agent without replay", async (test) => {
		const f = reuseFixture(test, "claude", "quiz");
		const teacher = createTeacherAgent(undefined, { engine: f.engine, chatId: "lesson", messages: [initial] });
		await teacher.continue();
		const first = teacher.state.messages.find((message) => message.role === "assistant");
		assert.ok(first && first.role === "assistant");
		assert.equal(tool(first).name, "quiz");
		const resumed = createTeacherAgent(undefined, { engine: createAcpEngine("claude", f.config), chatId: "lesson", messages: [initial, first, resultFor(tool(first))] });
		await resumed.continue();
		const last = resumed.state.messages.at(-1);
		assert.ok(last?.role === "assistant");
		assert.match(contentText(last), /saved tool result/);
		assert.equal(f.events().filter((event) => event.event === "session").length, 1);
	});

	for (const change of ["history", "steering", "prompt", "tools", "model", "reasoning"] as const) {
		it(`${change} changes rebuild from app truth without returning a stale MCP result`, async (test) => {
			const f = reuseFixture(test);
			const info = { id: "model/alpha", name: "Alpha", modelId: "alpha", reasoning: { low: "low", high: "high" } };
			const firstEngine = createAcpEngine("claude", f.config, info, "low");
			const first = await firstEngine.streamFn(firstEngine.model, context([initial]), { sessionId: "lesson" }).result();
			const messages: Message[] = [change === "history" ? { ...initial, content: "Compacted or changed history" } : initial, first, resultFor(tool(first))];
			if (change === "steering") messages.push({ role: "user", content: "New instruction", timestamp: 3 });
			const nextInfo = change === "model" ? { ...info, id: "model/beta", modelId: "beta", reasoning: { medium: "medium" } } : info;
			const engine = createAcpEngine("claude", f.config, nextInfo, change === "model" ? "medium" : change === "reasoning" ? "high" : "low");
			const last = await engine.streamFn(engine.model, context(messages, change === "prompt" ? "Different instructions" : "Use submit.", change === "tools" ? [{ ...declaration, description: "Changed tool" }] : [declaration]), { sessionId: "lesson" }).result();
			assert.equal(last.stopReason, "stop", last.errorMessage);
			assert.equal(JSON.parse(contentText(last)).replayed, true);
			assert.equal(f.events().filter((event) => event.event === "session").length, 2);
			assert.equal(f.events().some((event) => event.event === "result" && event.result?.isError === false), false);
		});
	}

	it("identical copied history cannot claim a different conversation's pending native session", async (test) => {
		const f = reuseFixture(test);
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "first" }).result();
		const next = await f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "second" }).result();
		assert.equal(next.stopReason, "stop", next.errorMessage);
		assert.equal(JSON.parse(contentText(next)).replayed, true);
		assert.equal(f.events().filter((event) => event.event === "session").length, 2);
	});

	for (const invalid of ["call-id", "tool-name", "duplicate-result"] as const) {
		it(`a mismatched ${invalid} cannot resume native execution`, async (test) => {
			const f = reuseFixture(test);
			const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
			const result = resultFor(tool(first));
			assert.equal(result.role, "toolResult");
			if (invalid === "call-id") result.toolCallId = "another-call";
			if (invalid === "tool-name") result.toolName = "another-tool";
			const messages = [initial, first, result, ...(invalid === "duplicate-result" ? [result] : [])];
			const last = await f.engine.streamFn(f.engine.model, context(messages), { sessionId: "lesson" }).result();
			assert.equal(last.stopReason, "stop", last.errorMessage);
			assert.equal(JSON.parse(contentText(last)).replayed, true);
			assert.equal(f.events().filter((event) => event.event === "session").length, 2);
		});
	}

	it("simultaneous continuation calls cannot both claim the same native session", async (test) => {
		const f = reuseFixture(test);
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
		const next = context([initial, first, resultFor(tool(first))]);
		const a = f.engine.streamFn(f.engine.model, next, { sessionId: "lesson" });
		const b = f.engine.streamFn(f.engine.model, next, { sessionId: "lesson" });
		const results = await Promise.all([a.result(), b.result()]);
		assert.equal(results.filter((message) => message.stopReason === "stop").length, 1);
		assert.equal(results.filter((message) => message.errorMessage?.includes("already has an active")).length, 1);
		assert.equal(f.events().filter((event) => event.event === "session").length, 1);
	});

	it("an adapter exiting while parked cannot leave a stale resumable session or workspace", async (test) => {
		const f = reuseFixture(test);
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
		const native = JSON.parse(contentText(first));
		process.kill(native.pid);
		await closeAcpSessions();
		assert.equal(existsSync(native.cwd), false);
		const last = await f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson" }).result();
		assert.equal(last.stopReason, "stop", last.errorMessage);
		assert.equal(JSON.parse(contentText(last)).replayed, true);
	});

	it("a stale abort signal cannot kill a session leased by the next Pi call", async (test) => {
		const f = reuseFixture(test);
		const old = new AbortController(), current = new AbortController();
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson", signal: old.signal }).result();
		const resumed = f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson", signal: current.signal });
		old.abort();
		assert.equal((await resumed.result()).stopReason, "stop");
		assert.equal(f.events().filter((event) => event.event === "session").length, 1);
	});

	it("cancellation while parked releases the process and workspace before later replay", async (test) => {
		const f = reuseFixture(test);
		const controller = new AbortController();
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson", signal: controller.signal }).result();
		const native = JSON.parse(contentText(first));
		controller.abort();
		await closeAcpSessions();
		assert.equal(existsSync(native.cwd), false);
		assert.throws(() => process.kill(native.pid, 0));
		const last = await f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson" }).result();
		assert.equal(last.stopReason, "stop", last.errorMessage);
		assert.equal(JSON.parse(contentText(last)).replayed, true);
	});

	it("cancellation after reuse terminates the retained adapter and its descendants", async (test) => {
		const f = reuseFixture(test, "codex", "reuse-hang-after-tool");
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
		const controller = new AbortController();
		const resumed = f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson", signal: controller.signal });
		let native: { cwd: string; pid: number; child: number } | undefined;
		for await (const event of resumed) if (event.type === "text_delta") { native = JSON.parse(event.delta); controller.abort(); }
		assert.equal((await resumed.result()).stopReason, "aborted");
		assert.ok(native);
		assert.equal(existsSync(native.cwd), false);
		for (const pid of [native.pid, native.child]) assert.throws(() => process.kill(pid, 0));
	});

	it("finite sub-agents dispose a paused final submit instead of retaining unused native work", async (test) => {
		const f = reuseFixture(test);
		const submit: AgentTool<typeof parameters> = { ...declaration, label: "Submit", execute: async () => toToolResult("Submitted") };
		await runSubagent([submit], { role: "extractor", engine: f.engine, systemPrompt: "Use submit.", prompt: "Submit", maxTurns: 1 });
		const native = f.events()[0]!;
		assert.equal(existsSync(native.cwd), false);
		assert.throws(() => process.kill(native.pid, 0));
	});

	it("idle expiry releases native resources; the next tool result reconstructs from saved history", async (test) => {
		test.mock.timers.enable({ apis: ["setTimeout"] });
		const f = reuseFixture(test);
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
		test.mock.timers.tick(10 * 60_000 + 1);
		await closeAcpSessions();
		assert.equal(existsSync(JSON.parse(contentText(first)).cwd), false);
		test.mock.timers.reset();
		const last = await f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson" }).result();
		assert.equal(last.stopReason, "stop", last.errorMessage);
		assert.equal(JSON.parse(contentText(last)).replayed, true);
	});

	it("waiting for a learner does not consume the resumed model call's timeout budget", async (test) => {
		test.mock.timers.enable({ apis: ["setTimeout"] });
		const requests = test.mock.method(AcpClient.prototype, "request");
		const f = reuseFixture(test, "claude", "reuse-hang-after-tool");
		const first = await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" }).result();
		const prompt = requests.mock.calls.find((call) => call.arguments[0] === "session/prompt")?.result;
		assert.ok(prompt);
		let failure: unknown;
		void prompt.catch((error) => { failure = error; });
		test.mock.timers.tick(9 * 60_000);
		const controller = new AbortController();
		const resumed = f.engine.streamFn(f.engine.model, context([initial, first, resultFor(tool(first))]), { sessionId: "lesson", signal: controller.signal });
		for await (const event of resumed) if (event.type === "text_delta") {
			try {
				test.mock.timers.tick(2 * 60_000);
				await Promise.resolve();
				await Promise.resolve();
				assert.equal(failure, undefined, "nine idle minutes must not leave only one minute for the next model call");
			} finally { controller.abort(); }
		}
		assert.equal((await resumed.result()).stopReason, "aborted");
	});

	it("the active inference deadline still terminates a hung native prompt", async (test) => {
		test.mock.timers.enable({ apis: ["setTimeout"] });
		const f = reuseFixture(test, "codex", "hang");
		const stream = f.engine.streamFn(f.engine.model, context([initial]), { sessionId: "lesson" });
		let native: { cwd: string; pid: number; child: number } | undefined;
		for await (const event of stream) if (event.type === "text_delta") {
			native = JSON.parse(event.delta);
			test.mock.timers.tick(10 * 60_000 + 1);
		}
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /model call timed out/);
		assert.ok(native);
		assert.equal(existsSync(native.cwd), false);
		for (const pid of [native.pid, native.child]) assert.throws(() => process.kill(pid, 0));
	});

	it("retention evicts the oldest waiter after four idle conversations", async (test) => {
		const f = reuseFixture(test);
		const waiting: AssistantMessage[] = [];
		for (let i = 0; i < 5; i++) waiting.push(await f.engine.streamFn(f.engine.model, context([initial]), { sessionId: `capacity-${i}` }).result());
		await closeAcpSessions(undefined, "capacity-0");
		assert.equal(existsSync(JSON.parse(contentText(waiting[0]!)).cwd), false);
		assert.equal(existsSync(JSON.parse(contentText(waiting[1]!)).cwd), true);
		const last = await f.engine.streamFn(f.engine.model, context([initial, waiting[0]!, resultFor(tool(waiting[0]!))]), { sessionId: "capacity-0" }).result();
		assert.equal(last.stopReason, "stop", last.errorMessage);
		assert.equal(JSON.parse(contentText(last)).replayed, true);
	});
});
