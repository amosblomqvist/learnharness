/**
 * The summary call is bounded: the structural gate holds every turn of the
 * chat while a compaction runs, so a summarizer that never returns must fail
 * the compaction (record untouched, gate released) instead of freezing the
 * session. The summarizer also runs at a capped thinking level.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-deadline-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { ensureCompacted, kickCompaction, awaitCompaction, compactionInFlight, summarizerEngine } = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
const { subscribe } = await import("../src/core/events.ts");
const { activeCompactionOf, newUserMessage } = await import("../src/core/index.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function overThresholdChat(label: string): string {
	const chat = chatStore.createChat(label);
	chatStore.saveMessages(chat.id, [
		...["m1", "m2", "m3"].map((text) => newUserMessage(`${text}: ${"x".repeat(100 * 1024)}`)),
		newUserMessage("recent"),
	]);
	return chat.id;
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function depsOf(summarize: CompactionDeps["summarize"], summaryTimeoutMs?: number): CompactionDeps {
	return {
		chatStore,
		engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
		modelId: "faux:test",
		kind: "teach",
		thresholdTokens: 40_000,
		systemPromptTokens: 100,
		summarize,
		summaryTimeoutMs,
	};
}

describe("the compaction summary deadline", () => {
	it("a summarizer that never returns is aborted, and the gate is released with the record untouched", async () => {
		const chatId = overThresholdChat("stalled gate");
		const before = JSON.stringify(chatStore.getChat(chatId)!.messages);
		const events: boolean[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "compaction-changed" && event.chatId === chatId) events.push(event.running);
		});
		let aborted = false;
		const started = Date.now();
		await ensureCompacted(depsOf((_prompt, _engine, signal) => new Promise(() => {
			signal?.addEventListener("abort", () => { aborted = true; });
		}), 60), chatId);
		unsubscribe();
		assert.ok(Date.now() - started < 5_000, "the gate must not wait for the stalled summary");
		assert.equal(aborted, true);
		assert.equal(compactionInFlight(chatId), false);
		assert.deepEqual(events, [true, false]);
		assert.equal(JSON.stringify(chatStore.getChat(chatId)!.messages), before);
		assert.equal(chatStore.getChat(chatId)!.turns?.length ?? 0, 0);
	});

	it("a stalled background kick stops blocking later turns, and a later attempt can succeed", async () => {
		const chatId = overThresholdChat("stalled kick");
		kickCompaction(() => depsOf(() => new Promise(() => {}), 60), chatId);
		assert.equal(compactionInFlight(chatId), true);
		await awaitCompaction(chatId);
		assert.equal(compactionInFlight(chatId), false);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
		await ensureCompacted(depsOf(async () => ({ summary: "the learner knows X", usage })), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages)?.content.endsWith("the learner knows X"));
	});

	it("a summary that finishes inside the deadline is unaffected", async () => {
		const chatId = overThresholdChat("fast summary");
		await ensureCompacted(depsOf(async (_prompt, _engine, signal) => {
			assert.equal(signal?.aborted, false);
			return { summary: "fast", usage };
		}, 5_000), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages)?.content.endsWith("fast"));
	});

	it("the summarizer keeps the chat's model but caps its thinking level", () => {
		const model = { provider: "claude-code", id: "opus" };
		for (const [level, expected] of [["max", "medium"], ["xhigh", "medium"], ["high", "medium"], ["medium", "medium"], ["low", "low"], [undefined, undefined]] as const) {
			const capped = summarizerEngine({ model, level } as never);
			assert.equal(capped.level, expected);
			assert.equal(capped.model, model);
		}
	});
});
