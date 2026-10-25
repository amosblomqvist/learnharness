import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { PATHS, SOURCES_FILE } from "../config.ts";
import { callCost, jobCost, sessionCost, turnCost } from "../src/server/pricing.ts";
import { sumSteps } from "../src/core/prices.ts";
import type { CallUsage, ExtractionRunUsage, JobRecord, TurnUsage } from "../src/core/contracts.ts";

const call = (over: Partial<CallUsage> = {}): CallUsage => ({
	inputTokens: 0, outputTokens: 0, cacheReadTokens: undefined,
	cacheWriteTokens: undefined, reasoningTokens: undefined, ...over,
});

test("sumSteps: absent stays absent; unknown long-cache detail stays unknown", () => {
	const sum = sumSteps([call({ inputTokens: 100, outputTokens: 20 }), call({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 30 })]);
	assert.equal(sum.inputTokens, 150);
	assert.equal(sum.outputTokens, 30);
	assert.equal(sum.cacheReadTokens, 30);
	assert.equal(sum.cacheWriteTokens, undefined);
	assert.equal(sumSteps([call({ inputTokens: undefined, outputTokens: undefined })]).inputTokens, undefined);
	assert.equal(sumSteps([call({ cacheWriteTokens: 10 }), call({ cacheWriteTokens: 20, cacheWrite1hTokens: 5 })]).cacheWrite1hTokens, undefined);
});

test("callCost prices normalized fresh input directly, without subtracting caches again", () => {
	const cost = callCost(call({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 10_000 }), "openrouter:z-ai/glm-5.3-flash");
	assert.ok(cost !== null);
	assert.ok(Math.abs(cost - (0.015 + 0.0003 + 0.01)) < 1e-9);
	assert.equal(callCost(call({ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 70_000 }), "openrouter:openai/gpt-6.1-sol"), 0.037);
});

test("cache writes: precise short/one-hour costs and honest unknown historical splits", () => {
	const usage = call({ inputTokens: 1_000_000, cacheWriteTokens: 500_000, cacheWrite1hTokens: 0 });
	assert.equal(callCost(usage, "anthropic:claude-haiku-4-5"), 1.625);
	assert.equal(callCost({ ...usage, cacheWrite1hTokens: 200_000 }, "anthropic:claude-haiku-4-5"), 1.775);
	assert.equal(callCost({ ...usage, cacheWrite1hTokens: undefined }, "anthropic:claude-haiku-4-5"), null);
});

test("unknown model, absent or invalid required usage is null, never fake zero", () => {
	assert.equal(callCost(call(), "not/a-model"), null);
	assert.equal(callCost(call({ outputTokens: undefined }), "openai:gpt-5"), null);
	for (const value of [-1, NaN, Infinity]) assert.equal(callCost(call({ inputTokens: value }), "openai:gpt-5"), null);
});

test("turn/session costs sum calls and count unpriced separately", () => {
	const turn: TurnUsage = { id: "t1", messageId: "m1", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 10_000, outputTokens: 2_000 }), call({ inputTokens: 12_000, outputTokens: 1_000 })] };
	const totals = sessionCost({ turns: [turn, { ...turn, id: "t2", model: "not/a-model" }] });
	assert.equal(totals.unpriced, 1);
	assert.equal(totals.cost, turnCost(turn));
	assert.equal(totals.turnCosts.t1, totals.cost);
	assert.equal(totals.turnCosts.t2, null);
});

test("legacy flat-rate jobs remain priceable; missing usage stays absent", () => {
	assert.equal(jobCost({}), null);
	const job: Pick<JobRecord, "usage"> = { usage: { model: "openrouter:z-ai/glm-5.3-flash", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 4 } };
	assert.ok(jobCost(job)! > 0);
});

test("appendTurnUsage: idempotent per turn; continuations survive saveMessages; list omits log", () => {
	const record = chatStore.createChat("usage fixture");
	try {
		const entry: TurnUsage = { id: "turn_1", messageId: "msg_a", at: "x", model: "openai:gpt-5", steps: [call({ inputTokens: 100, outputTokens: 10, cacheWrite1hTokens: 0 })] };
		chatStore.appendTurnUsage(record.id, entry);
		chatStore.appendTurnUsage(record.id, entry);
		chatStore.appendTurnUsage(record.id, { ...entry, id: "turn_2" });
		assert.equal(chatStore.getChat(record.id)?.turns?.length, 2);
		chatStore.saveMessages(record.id, [{ id: "msg_a", role: "user", content: "fixture", timestamp: 1 }]);
		assert.deepEqual(chatStore.getChat(record.id)?.turns?.[0]?.steps, JSON.parse(JSON.stringify(entry.steps)));
		assert.equal(chatStore.getChat(record.id)?.turns?.length, 2);
		assert.equal("turns" in chatStore.listChats().find((c) => c.id === record.id)!, false);
	} finally { fs.unlinkSync(`${PATHS.chats}/${record.id}.json`); }
});

const runEntry = (startedAt: number): ExtractionRunUsage => ({
	startedAt, at: "2026-09-09T00:00:00Z", durationMs: 42_000,
	stats: { nodes: 1, chains: 2 }, stages: {
		extractor: { model: "openai:gpt-5", steps: [call({ inputTokens: 100, outputTokens: 10 })] },
		auditor: { model: "openai:gpt-5", steps: [call({ inputTokens: 50, outputTokens: 5 })] },
	},
});

test("appendExtractionUsage: idempotent; failed runs persist; list omits log", () => {
	const record = chatStore.createChat("extraction usage fixture");
	try {
		chatStore.appendExtractionUsage(record.id, runEntry(1));
		chatStore.appendExtractionUsage(record.id, runEntry(1));
		chatStore.appendExtractionUsage(record.id, runEntry(2));
		chatStore.appendExtractionUsage(record.id, { ...runEntry(3), stats: undefined });
		assert.equal(chatStore.getChat(record.id)?.extractions?.length, 3);
		assert.equal(chatStore.getChat(record.id)?.extractions?.at(-1)?.stats, undefined);
		assert.equal("extractions" in chatStore.listChats().find((c) => c.id === record.id)!, false);
	} finally { fs.unlinkSync(`${PATHS.chats}/${record.id}.json`); }
});

test("appendSourceUsage: idempotent; reimport keeps history; absent source is a no-op", () => {
	fs.mkdirSync(PATHS.graph, { recursive: true });
	const backup = fs.existsSync(SOURCES_FILE) ? fs.readFileSync(SOURCES_FILE) : undefined;
	try {
		const id = "src_usagetest01";
		graphStore.upsertSource({ id, filePath: "/fixture/notes.md", importedAt: "2026-09-13T00:00:00Z" });
		graphStore.appendSourceUsage(id, runEntry(1));
		graphStore.appendSourceUsage(id, runEntry(1));
		graphStore.appendSourceUsage(id, runEntry(2));
		assert.equal(graphStore.readSources().find((s) => s.id === id)?.extractions?.length, 2);
		graphStore.upsertSource({ id, filePath: "/fixture/notes.md", importedAt: "2026-09-14T00:00:00Z" });
		assert.equal(graphStore.readSources().find((s) => s.id === id)?.extractions?.length, 2);
		graphStore.appendSourceUsage("src_missing", runEntry(1));
	} finally {
		if (backup) fs.writeFileSync(SOURCES_FILE, backup);
		else fs.rmSync(SOURCES_FILE, { force: true });
	}
});
