import assert from "node:assert/strict";
import test from "node:test";
import { ContextWindowProbe } from "../src/agent/claude-code/context-window.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { asAgentMessages, cliContextWindowOf, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { catalogLimits } from "../components/model-picker.tsx";
import { contextLimitForModel, formatContextMeasurement } from "../components/stats-bar.tsx";
import { toModelDto } from "../src/server/model-catalog.ts";

function setup() {
	const writes: { type: string; request_id: string; request: Record<string, string> }[] = [];
	const windows: number[] = [];
	let prompts = 0;
	const probe = new ContextWindowProbe((line) => writes.push(JSON.parse(line)), () => prompts++, (tokens) => windows.push(tokens));
	probe.start();
	const reply = (index: number, body: unknown, subtype = "success") => probe.handle({ type: "control_response", response: {
		request_id: writes[index]!.request_id, subtype, response: body,
	} });
	return { probe, writes, windows, reply, prompts: () => prompts };
}

test("control initialization precedes a summary-only query; neither needs user input or a model request", () => {
	const p = setup();
	assert.deepEqual(p.writes[0]!.request, { subtype: "initialize" }); assert.equal(p.prompts(), 0);
	p.reply(0, {});
	assert.deepEqual(p.writes[1]!.request, { subtype: "get_context_usage", detail: "summary" });
	assert.equal(p.prompts(), 1, "conversation does not wait for metadata");
	assert.notEqual(p.writes[0]!.request_id, p.writes[1]!.request_id);
	p.probe.handle({ type: "control_response", response: { request_id: "foreign", subtype: "success", response: { maxTokens: 999 } } });
	assert.deepEqual(p.windows, []);
	p.reply(1, { maxTokens: 200000, rawMaxTokens: 1000000 });
	assert.deepEqual(p.windows, [200000], "effective maxTokens, not an assumed nominal window");
	p.reply(0, {}); p.reply(1, { maxTokens: 1 });
	assert.equal(p.prompts(), 1); assert.deepEqual(p.windows, [200000]);
	p.probe.close();
});

test("metadata unavailable before first response can be queried again locally; stale/closed replies are ignored", () => {
	const p = setup(); p.reply(0, {}); p.reply(1, {}, "error");
	assert.equal(p.prompts(), 1); assert.deepEqual(p.windows, []);
	p.probe.refresh();
	assert.deepEqual(p.writes[2]!.request, { subtype: "get_context_usage", detail: "summary" });
	p.reply(1, { maxTokens: 1 }); assert.deepEqual(p.windows, []);
	p.reply(2, { maxTokens: 200000 }); assert.deepEqual(p.windows, [200000]);
	p.probe.refresh(); p.probe.close(); p.reply(3, { maxTokens: 999999 });
	assert.deepEqual(p.windows, [200000]); assert.equal(p.prompts(), 1);
});

for (const tokens of [null, undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "200000"]) test(`invalid summary budget ${tokens} remains unknown without failing the prompt`, () => {
	const p = setup(); p.reply(0, {}); p.reply(1, { maxTokens: tokens });
	assert.deepEqual(p.windows, []); assert.equal(p.prompts(), 1); p.probe.close();
});

test("initialization errors/timeouts fall back to ordinary prompt delivery; close cancels the timer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const error = setup(); error.reply(0, undefined, "error");
	assert.equal(error.prompts(), 1); assert.equal(error.writes.length, 1); error.probe.close();
	const timeout = setup(); t.mock.timers.tick(5000);
	assert.equal(timeout.prompts(), 1); assert.equal(timeout.writes.length, 1);
	timeout.reply(0, {}); assert.equal(timeout.writes.length, 1); timeout.probe.close();
	const closed = setup(); closed.probe.close(); t.mock.timers.tick(5000);
	assert.equal(closed.prompts(), 0);
});

function assistant(model = "opus", tokens: number | undefined = 200000): LhMessage & { role: "assistant" } {
	return { id: "cli-assistant", role: "assistant", api: "claude-code-cli", provider: "claude-code", model,
		content: [], timestamp: 0, stopReason: "stop", cliContextWindow: tokens,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("per-session metadata survives JSON persistence, never borrows older reports, and cannot override other model selections", () => {
	const first = assistant();
	const window = cliContextWindowOf(JSON.parse(JSON.stringify([first])));
	assert.deepEqual(window, { model: "claude-code:opus", tokens: 200000 });
	assert(!("cliContextWindow" in toLlmMessages(asAgentMessages([first]))[0]!));
	assert.equal(first.cliContextWindow, 200000, "provider projection never mutates the stored report");
	const catalog = new Map([["anthropic:fixture", 100000], ["claude-code:opus", 1000000]]);
	assert.equal(contextLimitForModel("claude-code:opus", catalog, window), 200000);
	assert.equal(contextLimitForModel("claude-code:sonnet", catalog, window), null);
	assert.equal(contextLimitForModel("claude-code:opus", catalog, null), null, "no placeholder fallback");
	assert.equal(contextLimitForModel("anthropic:fixture", catalog, window), 100000);
	assert.equal(contextLimitForModel(undefined, catalog, window), null);
	assert.equal(formatContextMeasurement(42000, 200000), "42k / 200k");
	assert.equal(formatContextMeasurement(42000, null), "42k");
	const unreported = assistant("opus"); delete unreported.cliContextWindow;
	assert.equal(cliContextWindowOf([first, unreported]), null);
	const other = assistant("api"); other.provider = "anthropic";
	assert.equal(cliContextWindowOf([first, other]), null);
	const compacted: LhMessage = { id: "compact", role: "custom", customType: "compaction", content: "summary", display: false, details: {}, timestamp: 1 };
	assert.equal(cliContextWindowOf([first, compacted]), null);
	assert.equal(cliContextWindowOf([]), null);
});

test("CLI catalog limits remain unknown and cannot create a global denominator", () => {
	const models = CLAUDE_CODE_MODELS.map(toModelDto);
	assert(models.every((model) => model.contextWindow === null && model.maxTokens === null));
	assert.equal(catalogLimits({ models }).size, 0);
});
