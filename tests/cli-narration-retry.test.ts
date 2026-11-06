/** Block-and-resend through the real Agent, stream parser and MCP bridge. Fake CLI; no provider calls. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { makeNarrationGuard, NARRATION_BLOCK_REASON } from "../src/agent/narration-guard.ts";
import { projectView } from "../src/core/view.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const LESSON = "A complete synthetic explanation.";
const REPLY = JSON.stringify({ fake: "reply" });

type Call = { id: string; name: string; arguments: Record<string, unknown> };
const quiz = (id: string): Call => ({ id, name: "quiz", arguments: { prompt: "Synthetic question" } });
const send = (id: string): Call => ({ id, name: "send_to_user", arguments: { message: LESSON } });
const event = (e: unknown) => JSON.stringify({ type: "stream_event", event: e });

/** One assistant response: optional thinking text, then its tool calls. */
function response(thinking: string | undefined, calls: Call[]): string[] {
	const offset = thinking === undefined ? 0 : 1;
	return [
		event({ type: "message_start", message: { usage: {} } }),
		...(thinking === undefined ? [] : [
			event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
			...(thinking ? [event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } })] : []),
			event({ type: "content_block_stop", index: 0 }),
		]),
		...calls.flatMap((call, i) => [
			event({ type: "content_block_start", index: i + offset, content_block: { type: "tool_use", id: call.id, name: `mcp__learnharness__${call.name}`, input: {} } }),
			event({ type: "content_block_delta", index: i + offset, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } }),
			event({ type: "content_block_stop", index: i + offset }),
		]),
		event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		event({ type: "message_stop" }),
		...calls.map((call, i) => JSON.stringify({ fake: i === calls.length - 1 ? "call" : "start-call", ...call })),
	];
}

async function run(t: TestContext, scenario: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "cli-narration-retry-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "scenario.jsonl");
	writeFileSync(file, `${scenario.join("\n")}\n`);
	const runClaude: RunClaude = (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: file },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
	const executed: string[] = [];
	const tool = (name: string) => ({
		name, label: name, description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => { executed.push(name); return { content: [{ type: "text" as const, text: `${name} ok` }], details: null }; },
	});
	const agent = new Agent({
		sessionId: "cli-narration-retry",
		initialState: { model: CLAUDE_CODE_MODELS[0]!, tools: [tool("send_to_user"), tool("quiz")] },
		streamFn: createClaudeCodeStreamFunction(runClaude),
		toolExecution: "sequential",
		...makeNarrationGuard(),
	});
	await agent.prompt("hi");
	const messages = agent.state.messages.map((m, i) => ({ id: `m${i}`, ...m })) as never[];
	const visible = projectView(messages).flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
	const finalText = (agent.state.messages.at(-1) as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
	return { executed, visible, finalText };
}

test("rejected narration reaches the model, which resends the lesson once and asks", async (t) => {
	const { executed, visible, finalText } = await run(t, [
		...response("Summary of the prose.", [quiz("toolu_q1")]),
		...response("", [send("toolu_s1")]),
		...response("", [quiz("toolu_q2")]),
		REPLY,
	]);
	assert.ok(finalText.includes(NARRATION_BLOCK_REASON), finalText);
	assert.deepEqual(executed, ["send_to_user", "quiz"]);
	assert.equal(visible.filter((text) => text === LESSON).length, 1);
});

test("a model that ignores the rejection cannot loop forever", async (t) => {
	const { executed } = await run(t, [
		...response("Summary one.", [quiz("toolu_q1")]),
		...response("Summary two.", [quiz("toolu_q2")]),
		...response("Summary three.", [quiz("toolu_q3")]),
		REPLY,
	]);
	assert.deepEqual(executed, ["quiz"]);
});

test("narration delivered through send_to_user in the same response is not rejected", async (t) => {
	const { executed, visible } = await run(t, [...response("Summary.", [send("toolu_s1"), quiz("toolu_q1")]), REPLY]);
	assert.deepEqual(executed, ["send_to_user", "quiz"]);
	assert.equal(visible.filter((text) => text === LESSON).length, 1);
});

test("a bare question after empty reasoning is not rejected", async (t) => {
	const { executed } = await run(t, [...response("", [quiz("toolu_q1")]), REPLY]);
	assert.deepEqual(executed, ["quiz"]);
});
