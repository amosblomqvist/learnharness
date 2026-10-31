import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { createAntigravityStream, parseActions, type RunAntigravity } from "../src/agent/antigravity/stream.ts";
import { ANTIGRAVITY_MODELS } from "../src/agent/antigravity/provider.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { callCost } from "../src/server/pricing.ts";
import { SETTINGS_SECTIONS } from "../src/server/settings-body.ts";

const model = ANTIGRAVITY_MODELS[0]!;
const tool: Tool = { name: "quiz", description: "Ask a quiz", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } };
const context = normalizeContext({ systemPrompt: "Teach carefully", tools: [tool], messages: [{ role: "user", content: "Teach addition", timestamp: 0 }] });

function fakeRun(output: object, code = 0) {
	const calls: { args: string[]; cwd: string; prompt: string; settings: Record<string, unknown> }[] = [];
	const run: RunAntigravity = (_binary, args, options) => {
		assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
		assert.equal(statSync(options.cwd + "/request.txt").mode & 0o777, 0o600);
		calls.push({ args, cwd: options.cwd, prompt: readFileSync(options.cwd + "/request.txt", "utf8"), settings: JSON.parse(args[args.indexOf("--settings") + 1]!) });
		return spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify({ event: "result", result: output }) + "\n")}); process.exitCode=${code}; });`], { stdio: "pipe" });
	};
	return { run, calls };
}

function success(structured_output: unknown) {
	return { status: "SUCCESS", structured_output, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 } };
}

test("Antigravity emits admitted harness tools and keeps subscription auth/overages explicit", async () => {
	const { run, calls } = fakeRun(success({ text: "Try this", toolCalls: [{ name: "quiz", arguments: { question: "1+1?" } }] }));
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context, { reasoning: "medium" });
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.map((b) => b.type), ["text", "toolCall"]);
	assert.equal(result.usage.input, 70);
	assert.equal(result.usage.cacheRead, 30);
	assert.equal(result.usage.totalTokens, 120);
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(calls[0]!.settings.useG1Credits, false);
	assert.ok(calls[0]!.prompt.includes("Teach carefully"));
	assert.ok(calls[0]!.prompt.includes("Teach addition"));
	assert.ok(!calls[0]!.args.includes("--model"));
	assert.ok(!calls[0]!.args.includes("--dangerously-skip-permissions"));
	assert.equal(existsSync(calls[0]!.cwd), false);
});

test("Antigravity requests explicit model slugs without falling back", async () => {
	const { run, calls } = fakeRun(success({ text: "Done", toolCalls: [] }));
	const stream = createAntigravityStream(run, () => "/fake/agy")(ANTIGRAVITY_MODELS[1]!, context);
	await stream.result();
	assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--model") + 1], ANTIGRAVITY_MODELS[1]!.id);
});

test("a real Pi agent executes harness tools and replays tool results to the next CLI request", async () => {
	let index = 0;
	const responses = [
		fakeRun(success({ text: "", toolCalls: [{ name: "check", arguments: { answer: 2 } }] })),
		fakeRun(success({ text: "Correct: two", toolCalls: [] })),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const agent = new Agent({ initialState: {
		model, systemPrompt: "Teach addition", tools: [{ name: "check", label: "Check", description: "Check the answer", parameters: Type.Object({ answer: Type.Number() }),
			execute: async (_id, args) => ({ content: [{ type: "text", text: `Answer ${(args as { answer: number }).answer} is correct` }], details: {} }),
		}],
	}, streamFn: createAntigravityStream(run, () => "/fake/agy") });
	await agent.prompt("What is one plus one?");
	assert.equal(index, 2);
	assert.ok(responses[1]!.calls[0]!.prompt.includes("Answer 2 is correct"));
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
	assert.ok(JSON.stringify(agent.state.messages.at(-1)).includes("Correct: two"));
});

test("invalid tool names and missing structured output fail without executing tools", async () => {
	assert.throws(() => parseActions({ text: "", toolCalls: [{ name: "bash", arguments: {} }] }, [tool]), /undeclared/);
	for (const payload of [undefined, { text: "", toolCalls: [{ name: "bash", arguments: {} }] }]) {
		const { run, calls } = fakeRun(success(payload));
		const stream = createAntigravityStream(run, () => "/fake/agy")(model, context);
		assert.equal((await stream.result()).stopReason, "error");
		// Consume through cleanup, which follows the terminal event.
		for await (const _event of stream) { /* drain */ }
		assert.equal(existsSync(calls[0]!.cwd), false);
	}
});

test("CLI authentication errors remain errors, including nonzero exits", async () => {
	const { run } = fakeRun({ status: "ERROR", error: "authentication required" }, 1);
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /authentication required/);
	const missing = await createAntigravityStream(run, () => null)(model, context).result();
	assert.match(missing.errorMessage!, /not found/);
});

test("cancellation terminates a waiting child and removes private files", async () => {
	const controller = new AbortController();
	let cwd = "";
	const run: RunAntigravity = (_binary, _args, options) => {
		cwd = options.cwd;
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe" });
		setTimeout(() => controller.abort(), 30);
		return child;
	};
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context, { signal: controller.signal } as SimpleStreamOptions);
	for await (const _event of stream) { /* drain through cleanup */ }
	assert.equal((await stream.result()).stopReason, "aborted");
	assert.equal(existsSync(cwd), false);
});

test("Antigravity settings sanitize, validate, and report unknown prices and limits", () => {
	assert.deepEqual(SETTINGS_SECTIONS.antigravity({ enabled: true }), { ok: true, settings: { enabled: true } });
	assert.equal(SETTINGS_SECTIONS.antigravity({ enabled: "true" }).ok, false);
	assert.deepEqual(sanitizeUserSettings({ antigravity: { enabled: true } })?.antigravity, { enabled: true });
	const dto = toModelDto(model);
	assert.equal(dto.cost, null);
	assert.equal(dto.contextWindow, null);
	assert.equal(dto.maxTokens, null);
	assert.equal(callCost({ inputTokens: 100, outputTokens: 10 }, "antigravity:default"), null);
});
