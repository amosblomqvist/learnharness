/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing — settle kick + turn-start gate, the registry mutex, the
 * summary call, usage, events. Pinned here with an injected summarizer
 * (the sub-agent one-shot needs a live engine; the SERVICE laws don't).
 *
 * The laws:
 * - the registry is a mutex: concurrent ensureCompacted → ONE summary;
 * - over-threshold → marker appended + usage logged + events emitted;
 * - under-threshold (or the projection post-marker) → no-op;
 * - chained compaction: the span carries the prior summary forward;
 * - the effective threshold: min(setting, window − reserve).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const {
	ensureCompacted,
	kickCompaction,
	awaitCompaction,
	effectiveThresholdTokens,
	projectedContextTokens,
} = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
const { subscribe } = await import("../src/core/events.ts");
const { activeCompactionOf, newUserMessage, COMPACTED_HISTORY_HEADER } = await import("../src/core/index.ts");
import type { LhMessage } from "../src/core/index.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const big = (text: string, kb = 100): LhMessage => newUserMessage(`${text}: ${"x".repeat(kb * 1024)}`);

/** A chat whose record projects far over any test threshold. */
function overThresholdChat(label: string): string {
	const chat = chatStore.createChat(label);
	const messages = [big("m1"), big("m2"), big("m3"), newUserMessage("recent")];
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

let summarizeCalls = 0;
const depsOf = (chatId: string, thresholdTokens: number): CompactionDeps => ({
	chatStore,
	// The engine is never touched when summarize is injected (only its
	// identity rides the marker's provenance) — a minimal stand-in.
	engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
	modelId: "faux:test",
	kind: "teach",
	thresholdTokens,
	systemPromptTokens: 100,
	summarize: async (prompt) => {
		summarizeCalls++;
		assert.ok(prompt.includes("TRANSCRIPT") || prompt.length > 0);
		return {
			summary: `SUMMARY #${summarizeCalls}: the learner knows X.`,
			usage: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
	},
});

// ── the laws ────────────────────────────────────────────────────────────────

describe("the compaction service", () => {
	it("over-threshold record → marker appended, usage logged, both events emitted", async () => {
		const chatId = overThresholdChat("compact: basic");
		const events: string[] = [];
		const off = subscribe((e) => {
			const { chatId: c, running } = e as { chatId?: string; running?: boolean };
			if (e.type === "compaction-changed" && c === chatId) events.push(`${running}`);
			if (e.type === "record-changed" && c === chatId) events.push("record");
		});
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		off();

		const record = chatStore.getChat(chatId)!;
		const marker = activeCompactionOf(record.messages);
		assert.ok(marker, "the marker landed");
		assert.ok(marker!.content.includes("SUMMARY #"));
		assert.ok(marker!.details.tokensBefore > 40_000, "provenance carries the trigger reading");
		assert.equal(marker!.details.model, "faux:test");
		// the projection now fits: the dropped span is gone from the wire view
		assert.ok(projectedContextTokens(record.messages, 100) < 40_000, "the cut brought the projection under threshold+summary");
		// usage landed on the money channel, keyed by the marker
		assert.ok((record.turns ?? []).some((t) => t.messageId === marker!.id && t.model === "faux:test"), "usage keyed by the marker");
		// events: running true → record-changed → running false
		assert.deepEqual(events, ["true", "record", "false"]);
	});

	it("an UNREPORTED summary call logs unknown usage, never a priced zero", async () => {
		// A summarizer that failed or was cut off reports no usage at all —
		// the fixture's seeded zeros are not a billed zero (subscription
		// usage-presence wave). The turn must fold to unknown, not $0.
		const chatId = overThresholdChat("compact: unreported usage");
		const deps: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async () => ({
				summary: "PARTIAL SUMMARY.",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				usagePresence: false,
			}),
		};
		await ensureCompacted(deps, chatId);
		const record = chatStore.getChat(chatId)!;
		const marker = activeCompactionOf(record.messages);
		assert.ok(marker, "the marker landed");
		const turn = (record.turns ?? []).find((t) => t.messageId === marker!.id);
		assert.ok(turn, "usage keyed by the marker");
		assert.equal(turn!.steps[0]!.inputTokens, undefined, "unreported input stays unknown");
		assert.equal(turn!.steps[0]!.outputTokens, undefined, "unreported output stays unknown");
		const { turnEstimate } = await import("../src/core/prices.ts");
		const estimate = turnEstimate(turn);
		assert.equal(estimate.dollars, null, "no fake $0");
		assert.equal(estimate.coverage, "unknown");
	});

	it("under-threshold record → a no-op (no marker, no summary call)", async () => {
		const chatId = overThresholdChat("compact: under");
		const before = summarizeCalls;
		await ensureCompacted(depsOf(chatId, 10_000_000), chatId);
		assert.equal(summarizeCalls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null);
	});

	it("the registry is a mutex: concurrent ensureCompacted → ONE summary", async () => {
		const chatId = overThresholdChat("compact: mutex");
		const before = summarizeCalls;
		const deps = depsOf(chatId, 40_000);
		await Promise.all([ensureCompacted(deps, chatId), ensureCompacted(deps, chatId), ensureCompacted(deps, chatId)]);
		assert.equal(summarizeCalls, before + 1, "exactly one summary however many gates race");
	});

	it("awaitCompaction: a later call rides the in-flight one (the structural gate)", async () => {
		const chatId = overThresholdChat("compact: gate");
		const events: string[] = [];
		const off = subscribe((e) => {
			const { chatId: c, running } = e as { chatId?: string; running?: boolean };
			if (e.type === "compaction-changed" && c === chatId) events.push(`${running}`);
		});
		const p = ensureCompacted(depsOf(chatId, 40_000), chatId);
		await awaitCompaction(chatId); // rides the same promise
		await p;
		off();
		assert.deepEqual(events, ["true", "false"], "no second compaction started");
	});

	it("chained compaction: the span carries the PRIOR summary forward", async () => {
		const chatId = overThresholdChat("compact: chained");
		let seenPrompt = "";
		const deps: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async (prompt) => {
				seenPrompt = prompt;
				return {
					summary: "SECOND SUMMARY.",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		};
		// first compaction
		await ensureCompacted({ ...depsOf(chatId, 40_000) }, chatId);
		// grow the record past the threshold again (post-markers + new tail)
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, big("m9"), big("m10"), big("m11")]);
		// second compaction — the span must open with the FIRST summary
		await ensureCompacted(deps, chatId);
		assert.ok(seenPrompt.includes("prior compaction summary"), "the prior summary rides the span");
		assert.ok(seenPrompt.includes(COMPACTED_HISTORY_HEADER), "as the marker's canonical text");
		const record = chatStore.getChat(chatId)!;
		const markers = record.messages.filter((m) => (m as { customType?: string }).customType === "compaction");
		assert.equal(markers.length, 2, "both markers persist (history is never rewritten)");
		assert.ok(activeCompactionOf(record.messages)!.content.includes("SECOND SUMMARY"), "the newest rules");
	});

	it("effectiveThresholdTokens: the setting rules big windows; the window rule binds small ones", () => {
		assert.equal(effectiveThresholdTokens(150_000, 200_000), 150_000);
		assert.equal(effectiveThresholdTokens(150_000, 100_000), 100_000 - 16_384);
		assert.equal(effectiveThresholdTokens(undefined, 200_000), 150_000);
		assert.equal(effectiveThresholdTokens(undefined, undefined), 150_000);
	});

	it("kickCompaction: fire-and-forget, registry-set, over-threshold only", async () => {
		const chatId = overThresholdChat("compact: kick");
		const before = summarizeCalls;
		let built = 0;
		kickCompaction(() => {
			built++;
			return depsOf(chatId, 40_000);
		}, chatId);
		assert.equal(built, 1, "deps built once");
		await awaitCompaction(chatId);
		assert.equal(summarizeCalls, before + 1);
		// beneath threshold now → a second kick builds its deps, the
		// pre-check refuses, and NO summary runs (building deps is the
		// kick's discovery step — the run is what costs)
		const afterFirst = summarizeCalls;
		kickCompaction(() => {
			built++;
			return depsOf(chatId, 40_000);
		}, chatId);
		assert.equal(summarizeCalls, afterFirst, "post-compaction record is under threshold — no run");
		// a null deps build (engineless) is a silent no-op
		kickCompaction(() => null, chatId);
	});

	it("a summarizer failure leaves the record untouched and the gate re-arms", async () => {
		const chatId = overThresholdChat("compact: fail");
		const before = summarizeCalls;
		const failing: CompactionDeps = {
			...depsOf(chatId, 40_000),
			summarize: async () => {
				throw new Error("boom");
			},
		};
		await ensureCompacted(failing, chatId);
		assert.equal(activeCompactionOf(chatStore.getChat(chatId)!.messages), null, "no marker on failure");
		// the next gate retries cleanly
		await ensureCompacted(depsOf(chatId, 40_000), chatId);
		assert.ok(activeCompactionOf(chatStore.getChat(chatId)!.messages));
		assert.equal(summarizeCalls, before + 1);
	});
});
