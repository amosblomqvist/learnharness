/**
 * Usage-accounting tests — the money channel's pure helpers (core/prices.ts)
 * and the ChatStore usage-log seam (appendTurnUsage).
 *
 * Pure helper tests are pure. The store test uses the real fs chatStore with
 * a fixture chat, cleaned up in after().
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";

import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { PATHS, SOURCES_FILE } from "../config.ts";
import {
	callCost,
	callEstimate,
	contextWindow,
	foldCostEstimates,
	jobCost,
	jobEstimate,
	sessionCost,
	sumSteps,
	turnCost,
	turnEstimate,
} from "../src/core/prices.ts";
import type { CallUsage, ExtractionRunUsage, JobRecord, TurnUsage } from "../src/core/contracts.ts";
import { callUsageOf, messageUsagePresence, piUsageToStep, usagePresenceOf } from "../src/core/contracts.ts";

const call = (over: Partial<CallUsage> = {}): CallUsage => ({
	// A capture from pi always reports the cache-read split (the SDK seeds
	// it); only a genuinely un-reported field is undefined. Fixtures that
	// assert a COMPLETE estimate therefore carry 0, not undefined.
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: undefined,
	reasoningTokens: undefined,
	...over,
});

test("callUsageOf: field-level presence preserves each obtained token", () => {
	// pi's Usage as the SDK hands it over: input is FRESH (cached and written
	// tokens already subtracted).
	const usage = { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	const inputOnly = callUsageOf(usage, { input: true, output: false, cacheRead: false, cacheWrite: false, reasoning: false });
	assert.equal(inputOnly.inputTokens, 9, "the obtained input token survives");
	assert.equal(inputOnly.outputTokens, undefined);
	assert.equal(inputOnly.cacheReadTokens, undefined);
	assert.equal(inputOnly.cacheWriteTokens, undefined);
	assert.equal(inputOnly.reasoningTokens, undefined);

	// Total input is restored: fresh + reported cache parts (the price fold
	// subtracts them once; persisting the fresh figure would discount twice).
	const restored = callUsageOf({ input: 100, output: 5, cacheRead: 900, cacheWrite: 50, reasoning: 3 }, {
		input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true,
	});
	assert.equal(restored.inputTokens, 1_050);
	assert.equal(restored.cacheReadTokens, 900);
	assert.equal(restored.cacheWriteTokens, 50);
	assert.equal(restored.reasoningTokens, 3);

	// Legacy callers pass a boolean: every field reported (pre-wave behavior).
	const legacy = callUsageOf({ input: 7, output: 2, cacheRead: 1, cacheWrite: 0 }, true);
	assert.deepEqual(legacy, { inputTokens: 8, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0 });
});

test("piUsageToStep: unreported cache and reasoning stay absent, not zero", () => {
	const step = piUsageToStep(
		{ input: 7, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		{ input: true, output: true, cacheRead: false, cacheWrite: false, reasoning: false },
	);
	assert.equal(step.inputTokens, 7);
	assert.equal(step.outputTokens, 2);
	assert.equal(step.inputTokenDetails, undefined, "no fabricated cache report");
	assert.equal(step.outputTokenDetails, undefined, "no fabricated reasoning report");
	// A reported zero is still a report.
	const zero = piUsageToStep({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, true);
	assert.deepEqual(zero.inputTokenDetails, { cacheReadTokens: 0, cacheWriteTokens: 0 });
	assert.deepEqual(zero.outputTokenDetails, { reasoningTokens: 0 });
});

test("usagePresenceOf: an absent marker means reported; a boolean means every field", () => {
	assert.deepEqual(usagePresenceOf(undefined), { input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true });
	assert.deepEqual(usagePresenceOf(false), { input: false, output: false, cacheRead: false, cacheWrite: false, reasoning: false });
	assert.deepEqual(messageUsagePresence({}), usagePresenceOf(undefined));
	assert.deepEqual(
		messageUsagePresence({ diagnostics: [{ type: "usage_report", details: { reported: false } }] }),
		usagePresenceOf(false),
		"a first-wave boolean marker still reads field-for-field",
	);
});

test("callEstimate: a call without its cache-read split has no complete price", () => {
	const partial: CallUsage = {
		inputTokens: 7,
		outputTokens: 2,
		cacheReadTokens: undefined,
		cacheWriteTokens: undefined,
		reasoningTokens: undefined,
	};
	assert.equal(callCost(partial, "openrouter:z-ai/glm-5.3-flash"), null, "the numeric helper refuses too");
	assert.deepEqual(callEstimate(partial, "openrouter:z-ai/glm-5.3-flash"), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 0,
		missingUsageCalls: 1,
	});
	// An old record with the cache field absent still folds without crashing
	// and stays honestly unknown — never a fabricated $0.
	const turn: TurnUsage = { id: "t", messageId: "m", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [partial] };
	assert.equal(turnEstimate(turn).coverage, "unknown");
});

test("callEstimate: a priced cache-write category needs the supplier's write count", () => {
	// openai-codex:gpt-6-luna bills writes (cacheWrite: 0.125) and the Codex
	// Responses stream never reports cache_write_tokens. Missing here is not
	// "zero writes": the bill cannot be proven, so the call is unknown while
	// the tokens it did report stay in the record.
	const codex = "openai-codex:gpt-6-luna";
	const withoutWrites: CallUsage = {
		inputTokens: 1000,
		outputTokens: 10,
		cacheReadTokens: 0,
		cacheWriteTokens: undefined,
		reasoningTokens: undefined,
	};
	assert.equal(callCost(withoutWrites, codex), null, "the numeric helper refuses too");
	assert.deepEqual(callEstimate(withoutWrites, codex), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 0,
		missingUsageCalls: 1,
	});
	assert.equal(withoutWrites.inputTokens, 1000, "reported tokens are preserved, not erased");

	// The same call with an explicit write count of zero is a complete figure.
	assert.deepEqual(callEstimate({ ...withoutWrites, cacheWriteTokens: 0 }, codex), {
		dollars: (1000 / 1e6) * 0.1 + (10 / 1e6) * 0.5,
		coverage: "complete",
		pricedCalls: 1,
		unpricedCalls: 0,
		missingUsageCalls: 0,
	});

	// A model that does not bill writes needs no write report: its absence
	// cannot hide a dollar.
	const noWritePrice: CallUsage = { ...withoutWrites, cacheWriteTokens: undefined };
	assert.equal(callEstimate(noWritePrice, "openrouter:z-ai/glm-5.3-flash").coverage, "complete");
});

test("sumSteps folds steps; absent stays absent until a value appears", () => {
	const sum = sumSteps([
		call({ inputTokens: 100, outputTokens: 20 }),
		call({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 30 }),
	]);
	assert.equal(sum.inputTokens, 150);
	assert.equal(sum.outputTokens, 30);
	assert.equal(sum.cacheReadTokens, 30);
	assert.equal(sum.cacheWriteTokens, undefined); // never reported → stays undefined
	// all-absent → all-undefined (helper defaults input/output to 0, so
	// explicit undefined here)
	const empty = sumSteps([call({ inputTokens: undefined, outputTokens: undefined }), call({ inputTokens: undefined, outputTokens: undefined })]);
	assert.equal(empty.inputTokens, undefined);
});

test("callCost: glm-5.3-flash math — fresh input, cached read, output", () => {
	const cost = callCost(call({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 10_000 }), "openrouter:z-ai/glm-5.3-flash");
	assert.ok(cost !== null);
	// fresh 90k @ $0.15/M + cached 10k @ $0.03/M + output 20k @ $0.5/M
	// (pi-ai catalog prices — regenerated tables, scripts/sync-pricing;
	// glm-5.3-flash cacheRead corrected 0.05 → 0.03 in pi 1.0.2)
	assert.ok(Math.abs(cost! - (0.0135 + 0.0003 + 0.01)) < 1e-9);
});

test("callCost: cache writes bill at the cacheWrite rate", () => {
	const cost = callCost(
		// inputTokens is TOTAL input: 1M fresh + 500k written to the cache.
		call({ inputTokens: 1_500_000, outputTokens: 0, cacheWriteTokens: 500_000 }),
		"openrouter:qwen/qwen3.8-max-0902",
	);
	assert.ok(cost !== null);
	// fresh 1M @ $2/M + cache write 500k @ $2.5/M
	assert.ok(Math.abs(cost! - (2 + 1.25)) < 1e-9);
});

test("callCost: unknown model and absent fields are null, never zero", () => {
	assert.equal(callCost(call({ inputTokens: 100, outputTokens: 5 }), "not/a-model"), null);
	assert.equal(callCost(call({ inputTokens: 100, outputTokens: undefined }), "openrouter:z-ai/glm-5.3-flash"), null);
});

test("turnCost sums steps; sessionCost reports unpriced turns", () => {
	const turn: TurnUsage = {
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T00:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [call({ inputTokens: 10_000, outputTokens: 2_000 }), call({ inputTokens: 12_000, outputTokens: 1_000 })],
	};
	assert.ok(turnCost(turn) !== null);
	const totals = sessionCost({
		turns: [turn, { id: "t2", messageId: "m2", at: "x", model: "not/a-model", steps: [call({ inputTokens: 1, outputTokens: 1 })] }],
	});
	assert.equal(totals.unpriced, 1);
	assert.ok(totals.cost > 0);
});

test("contextWindow: last call's footprint against the live index's limit", () => {
	const limits = new Map([["openrouter:z-ai/glm-5.3-flash", 1_048_576]]);
	const cw = contextWindow(
		{
			turns: [
				{ id: "t1", messageId: "m1", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 9_000, outputTokens: 1_000 })] },
				{ id: "t2", messageId: "m2", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 90_000, outputTokens: 10_000 })] },
			],
		},
		limits,
	);
	assert.ok(cw);
	assert.equal(cw.model, "openrouter:z-ai/glm-5.3-flash");
	assert.equal(cw.usedTokens, 100_000);
	assert.equal(cw.limit, 1_048_576);
	assert.equal(contextWindow({ turns: [] }, limits), null);
});

test("contextWindow NUMERATOR: cache tokens count (owner audit, 2026-09-23)", () => {
	// The audit's live case: a cache-heavy session read 40k on the meter
	// while the real footprint was ~190k — provider `input` EXCLUDES the
	// cached portion, so input+output alone is wildly low. The fold is
	// pi's totalTokens semantics: all four fields.
	const limits = new Map([["openrouter:z-ai/glm-5.3-flash", 1_048_576]]);
	const cw = contextWindow(
		{
			turns: [
				{
					id: "t1",
					messageId: "m1",
					at: "x",
					model: "openrouter:z-ai/glm-5.3-flash",
					steps: [call({ inputTokens: 40_000, outputTokens: 1_000, cacheReadTokens: 145_000, cacheWriteTokens: 4_000 })],
				},
			],
		},
		limits,
	);
	assert.ok(cw);
	assert.equal(cw.usedTokens, 40_000 + 1_000 + 145_000 + 4_000, "input + output + cacheRead + cacheWrite");
	// Cache fields absent (non-caching providers): the fold is unchanged.
	const plain = contextWindow(
		{ turns: [{ id: "t1", messageId: "m1", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 9_000, outputTokens: 1_000 })] }] },
		limits,
	);
	assert.ok(plain);
	assert.equal(plain.usedTokens, 10_000);
});

test("contextWindow DENOMINATOR: the live index is the ONLY source — no fallback (owner amendment, 2026-09-23)", () => {
	const turns = [
		{ id: "t1", messageId: "m1", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 10_000, outputTokens: 1_000 })] },
	];
	const live = new Map([["openrouter:z-ai/glm-5.3-flash", 65_536]]);
	const cw = contextWindow({ turns }, live);
	assert.ok(cw);
	assert.equal(cw.limit, 65_536, "pi's catalog, via the index, is the one source");
	// No index at all (a client that hasn't fetched the catalog): the
	// meter renders usage-only — limit null, never a guessed window.
	const noIndex = contextWindow({ turns });
	assert.ok(noIndex);
	assert.equal(noIndex.usedTokens, 11_000);
	assert.equal(noIndex.limit, null);
	const emptyIndex = contextWindow({ turns }, new Map<string, number>());
	assert.ok(emptyIndex);
	assert.equal(emptyIndex.limit, null, "an empty index (failed fetch) is usage-only too");
	// A model missing from the live catalog (historical session, package
	// update removed it): usage-only, never a fake window.
	const missing = contextWindow({ turns: [{ ...turns[0]!, model: "nope/gone-model" }] }, live);
	assert.ok(missing);
	assert.equal(missing.limit, null);
	assert.equal(missing.usedTokens, 11_000, "the footprint still reads honestly");
});

test("contextWindow ride-along: a zeroed/aborted last step falls back to the previous step", () => {
	// An aborted last call reports zeroed usage — that is not the session
	// footprint. The honest reading is the previous step's usage.
	const limits = new Map([["openrouter:z-ai/glm-5.3-flash", 1_048_576]]);
	const cw = contextWindow(
		{
			turns: [
				{
					id: "t1",
					messageId: "m1",
					at: "x",
					model: "openrouter:z-ai/glm-5.3-flash",
					steps: [
						call({ inputTokens: 80_000, outputTokens: 5_000 }),
						call({ inputTokens: 0, outputTokens: 0 }), // aborted — zeroed
					],
				},
			],
		},
		limits,
	);
	assert.ok(cw);
	assert.equal(cw.usedTokens, 85_000, "the previous step's footprint, not a bogus tiny meter");
	// ALL steps zeroed (a first-call abort): no reading at all — null.
	assert.equal(
		contextWindow(
			{ turns: [{ id: "t1", messageId: "m1", at: "x", model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 0, outputTokens: 0 })] }] },
			limits,
		),
		null,
	);
});

test("jobCost: null without usage, computed with it", () => {
	assert.equal(jobCost({}), null);
	const job: Pick<JobRecord, "usage"> = {
		usage: {
			model: "openrouter:z-ai/glm-5.3-flash",
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			steps: 4,
		},
	};
	assert.ok(jobCost(job) !== null);
	assert.ok(jobCost(job)! > 0);
});

// ─── Estimated model cost: completeness metadata (issue #8) ─────────────────

const PRICED_MODEL = "openrouter:z-ai/glm-5.3-flash";
const SUBSCRIPTION_MODEL = "openai-codex:gpt-6-luna";

test("callEstimate: price and reported usage are separate — an explicit zero is a complete estimate", () => {
	assert.deepEqual(callEstimate(call({ inputTokens: 0, outputTokens: 0 }), PRICED_MODEL), {
		dollars: 0,
		coverage: "complete",
		pricedCalls: 1,
		unpricedCalls: 0,
		missingUsageCalls: 0,
	});
	// Cache fields are optional by contract: their absence is not a gap.
	assert.equal(callEstimate(call({ inputTokens: 10, outputTokens: 2 }), PRICED_MODEL).coverage, "complete");
	// A model missing from PRICES is unknown — never $0.
	assert.deepEqual(callEstimate(call({ inputTokens: 100, outputTokens: 5 }), "not/a-model"), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 1,
		missingUsageCalls: 0,
	});
	// The provider not reporting output tokens is a different gap: same
	// absent figure, different reason.
	assert.deepEqual(callEstimate(call({ inputTokens: 100, outputTokens: undefined }), PRICED_MODEL), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 0,
		missingUsageCalls: 1,
	});
	// Both conditions at once: the capture gap is the reported reason (a
	// price lookup cannot price an unreported call either way).
	assert.deepEqual(callEstimate(call({ inputTokens: undefined, outputTokens: undefined }), "not/a-model"), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 0,
		missingUsageCalls: 1,
	});
});

test("foldCostEstimates: a known subtotal is not a complete total — partial keeps the priced dollars", () => {
	const priced = callEstimate(call({ inputTokens: 1_000_000, outputTokens: 0 }), PRICED_MODEL);
	const unpriced = callEstimate(call({ inputTokens: 100, outputTokens: 5 }), "not/a-model");
	const unreported = callEstimate(call({ inputTokens: 100, outputTokens: undefined }), PRICED_MODEL);
	// One priced + one unpriced call: the dollars are a SUBTOTAL, flagged.
	const folded = foldCostEstimates([priced, unpriced]);
	assert.equal(folded.dollars, priced.dollars);
	assert.equal(folded.coverage, "partial");
	assert.deepEqual(
		[folded.pricedCalls, folded.unpricedCalls, folded.missingUsageCalls],
		[1, 1, 0],
	);
	// Nothing priceable → absent, never zero.
	assert.deepEqual(foldCostEstimates([unpriced, unreported]), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 1,
		missingUsageCalls: 1,
	});
	// No calls at all is unknown too: no evidence of a $0 spend.
	assert.deepEqual(foldCostEstimates([]), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 0,
		missingUsageCalls: 0,
	});
	// Every call priced (explicit zeros included) → complete.
	const zero = callEstimate(call({ inputTokens: 0, outputTokens: 0 }), PRICED_MODEL);
	assert.equal(foldCostEstimates([zero, priced]).coverage, "complete");
});

test("turnEstimate: one unreported step inside a priced turn makes the turn partial", () => {
	const turn: TurnUsage = {
		id: "t1",
		messageId: "m1",
		at: "2026-10-19T00:00:00Z",
		model: PRICED_MODEL,
		steps: [call({ inputTokens: 10_000, outputTokens: 1_000 }), call({ inputTokens: 5_000, outputTokens: undefined })],
	};
	const est = turnEstimate(turn);
	assert.ok(est.dollars !== null && est.dollars > 0);
	assert.equal(est.coverage, "partial");
	assert.equal(est.missingUsageCalls, 1);
	assert.equal(est.unpricedCalls, 0);
});

test("sessionCost: subscription and API-key turns fold into one estimate — subscription usage is never zeroed", () => {
	const apiTurn: TurnUsage = {
		id: "t1",
		messageId: "m1",
		at: "2026-10-19T00:00:00Z",
		model: PRICED_MODEL,
		steps: [call({ inputTokens: 10_000, outputTokens: 1_000 })],
	};
	const subscriptionTurn: TurnUsage = {
		id: "t2",
		messageId: "m2",
		at: "2026-10-19T00:01:00Z",
		model: SUBSCRIPTION_MODEL,
		// This fixture declares complete metering: the codex row prices writes,
		// so a complete report carries an explicit zero for them.
		steps: [call({ inputTokens: 10_000, outputTokens: 1_000, cacheWriteTokens: 0 })],
	};
	assert.ok(turnCost(subscriptionTurn)! > 0, "a subscription call bills an estimated model cost, not $0");
	const totals = sessionCost({ turns: [apiTurn, subscriptionTurn] });
	assert.equal(totals.unpriced, 0);
	assert.equal(totals.estimate.coverage, "complete");
	assert.equal(totals.estimate.dollars, turnCost(apiTurn)! + turnCost(subscriptionTurn)!);
	assert.equal(totals.cost, totals.estimate.dollars);
	// One unpriceable turn among priced ones: subtotal kept, coverage partial,
	// the unpriced turn still counted.
	const mixed = sessionCost({
		turns: [apiTurn, subscriptionTurn, { id: "t3", messageId: "m3", at: "x", model: "not/a-model", steps: [call({ inputTokens: 1, outputTokens: 1 })] }],
	});
	assert.equal(mixed.unpriced, 1);
	assert.equal(mixed.estimate.coverage, "partial");
	assert.equal(mixed.cost, totals.cost);
});

test("jobEstimate: absent usage is unknown, not $0; reported usage is complete", () => {
	assert.deepEqual(jobEstimate({}), {
		dollars: null,
		coverage: "unknown",
		pricedCalls: 0,
		unpricedCalls: 0,
		missingUsageCalls: 0,
	});
	const job: Pick<JobRecord, "usage"> = {
		usage: {
			model: SUBSCRIPTION_MODEL,
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			steps: 4,
		},
	};
	const est = jobEstimate(job);
	assert.equal(est.coverage, "complete");
	assert.equal(est.dollars, jobCost(job));
	assert.ok(est.dollars !== null && est.dollars > 0);
});

// ─── the store seam ──────────────────────────────────────────────────────────

test("appendTurnUsage: appends, idempotent per turn id, continuation turns (same message) all kept, survives saveMessages", () => {
	const record = chatStore.createChat("usage test chat");
	const entry: TurnUsage = {
		id: "turn_1",
		messageId: "msg_a",
		at: "2026-09-09T00:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [call({ inputTokens: 100, outputTokens: 10 })],
	};
	chatStore.appendTurnUsage(record.id, entry);
	chatStore.appendTurnUsage(record.id, entry); // replay (abort/retry) → no-op
	// continuation turn: SAME response message (SDK coalesces), new turn id —
	// usage must survive, not collapse into the first entry
	chatStore.appendTurnUsage(record.id, { ...entry, id: "turn_2" });
	let reread = chatStore.getChat(record.id);
	assert.equal(reread?.turns?.length, 2);

	// saveMessages must not clobber the log (read-mutate-write record) —
	// Wave B: a NATIVE message list (the record holds agent history).
	chatStore.saveMessages(record.id, [
		{ id: "msg_a", role: "user", content: "native", timestamp: Date.now() } as never,
	]);
	reread = chatStore.getChat(record.id);
	assert.equal(reread?.turns?.length, 2);

	// and the list payload must NOT leak turns
	const listed = chatStore.listChats().find((c) => c.id === record.id);
	assert.ok(listed);
	assert.equal("turns" in listed, false);

	fs.unlinkSync(`${PATHS.chats}/${record.id}.json`);
});

test("appendExtractionUsage: appends, idempotent per startedAt, not in list payload", () => {
	const record = chatStore.createChat("extraction usage test chat");
	const runEntry = (startedAt: number): ExtractionRunUsage => ({
		startedAt,
		at: "2026-09-09T00:00:00Z",
		durationMs: 42_000,
		stats: { nodes: 1, chains: 2 },
		stages: {
			extractor: { model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 100, outputTokens: 10 })] },
			auditor: { model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 50, outputTokens: 5 })] },
		},
	});
	chatStore.appendExtractionUsage(record.id, runEntry(1));
	chatStore.appendExtractionUsage(record.id, runEntry(1)); // same run appended twice → no-op
	chatStore.appendExtractionUsage(record.id, runEntry(2)); // a retried run is a NEW spend
	let reread = chatStore.getChat(record.id);
	assert.equal(reread?.extractions?.length, 2);
	// failed runs (stats absent) persist with usage — money was spent
	chatStore.appendExtractionUsage(record.id, { ...runEntry(3), stats: undefined });
	reread = chatStore.getChat(record.id);
	assert.equal(reread?.extractions?.length, 3);
	assert.equal(reread?.extractions?.at(-1)?.stats, undefined);

	// the list payload must NOT leak the extractions log
	const listed = chatStore.listChats().find((c) => c.id === record.id);
	assert.ok(listed);
	assert.equal("extractions" in listed, false);

	fs.unlinkSync(`${PATHS.chats}/${record.id}.json`);
});

test("appendSourceUsage: appends to the source record, idempotent per startedAt, upsert keeps history", () => {
	// The real fs graphStore — sources.json backed up and restored around
	// this test (same discipline as the chat fixture files).
	fs.mkdirSync(PATHS.graph, { recursive: true });
	let bak: string | undefined;
	if (fs.existsSync(SOURCES_FILE)) bak = `${SOURCES_FILE}.w5test.bak`;
	if (bak) fs.renameSync(SOURCES_FILE, bak);
	try {
		const runEntry = (startedAt: number): ExtractionRunUsage => ({
			startedAt,
			at: "2026-09-13T00:00:00Z",
			durationMs: 42_000,
			stats: { nodes: 1, chains: 2 },
			stages: {
				extractor: { model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 100, outputTokens: 10 })] },
				auditor: { model: "openrouter:z-ai/glm-5.3-flash", steps: [call({ inputTokens: 50, outputTokens: 5 })] },
			},
		});
		const id = "src_usagetest01";
		graphStore.upsertSource({ id, filePath: "/vault/usagetest.md", importedAt: "2026-09-13T00:00:00Z" });
		graphStore.appendSourceUsage(id, runEntry(1));
		graphStore.appendSourceUsage(id, runEntry(1)); // same run appended twice → no-op
		graphStore.appendSourceUsage(id, runEntry(2)); // a retried run is a NEW spend
		assert.equal(graphStore.readSources().find((s) => s.id === id)?.extractions?.length, 2);

		// An upsert (re-import) KEEPS the usage history.
		graphStore.upsertSource({ id, filePath: "/vault/usagetest.md", importedAt: "2026-09-14T00:00:00Z" });
		assert.equal(graphStore.readSources().find((s) => s.id === id)?.extractions?.length, 2);

		// Unknown ids are a silent no-op (nothing to bill against).
		graphStore.appendSourceUsage("src_nope", runEntry(1));
	} finally {
		fs.rmSync(SOURCES_FILE, { force: true });
		if (bak) fs.renameSync(bak, SOURCES_FILE);
	}
});
