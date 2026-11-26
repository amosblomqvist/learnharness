/**
 * Tests for src/core/cost-summary.ts — the graph cost pill's pure fold.
 * Same laws as the money channel everywhere: dollars INFERRED at read
 * time (core/prices.ts), unpriced models excluded-but-counted (render
 * "—", never a silent zero), tokens always sum.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	graphCostSummary as foldGraphCostSummary,
	type CostSummaryInput,
	type GraphCostSummary,
} from "../src/core/cost-summary.ts";
import type { CallUsage, ExtractionRunUsage } from "../src/core/contracts.ts";
import { callCost } from "../src/server/pricing.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, callCost);

/** A model with full published pricing (from the generated registry). */
const PRICED = "openrouter:z-ai/glm-5.3-flash";
assert.notEqual(callCost({ inputTokens: 1, outputTokens: 1 }, PRICED), null);

const step = (input: number, output: number): CallUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: 0,
	cacheWriteTokens: undefined,
	reasoningTokens: 0,
});

const extractionRun = (
	startedAt: number,
	extractorModel: string,
	auditorModel: string,
	stats?: ExtractionRunUsage["stats"],
): ExtractionRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 10_000,
	stages: {
		extractor: { model: extractorModel, steps: [step(1000, 200)] },
		auditor: { model: auditorModel, steps: [step(2000, 100)] },
	},
	...(stats ? { stats } : {}),
});

describe("graphCostSummary (the cost pill's fold)", () => {
	test("folds both channels: stage totals, tokens, newest-first runs", () => {
		// (The cluster-naming channel died with the extraction-UX close-out,
		// 2026-09-24 — two channels: chat + notes front doors.)
		const input: CostSummaryInput = {
			chats: [{ title: "Testing session", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/modal.md", extractions: [extractionRun(200, PRICED, PRICED)] }],
		};
		const s = graphCostSummary(input);
		const extStep = callCost(step(1000, 200), PRICED)!;
		const audStep = callCost(step(2000, 100), PRICED)!;
		assert.equal(s.stages.extraction.dollars, extStep * 2);
		assert.equal(s.stages.audit.dollars, audStep * 2);
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.extraction.tokens.inputTokens, 2000);
		assert.equal(s.stages.audit.tokens.outputTokens, 200);
		assert.equal(s.totalDollars, extStep * 2 + audStep * 2);
		// Both runs, newest first, titles joined per front door — every
		// run is kind "extraction" now.
		assert.deepEqual(
			s.runs.map((r) => r.title),
			["/vault/modal.md", "Testing session"],
		);
		assert.deepEqual(s.runs.map((r) => r.kind), ["extraction", "extraction"]);
		assert.equal(s.unpricedRuns, 0);
	});

	test("unpriced models: excluded dollars, counted honestly, run null only when BOTH stages unpriced", () => {
		const s: GraphCostSummary = graphCostSummary({
			chats: [{ title: "partial", extractions: [extractionRun(100, PRICED, "unknown-model")] }],
			sources: [{ filePath: "/vault/x.md", extractions: [extractionRun(200, "unknown-model", "unknown-model")] }],
		});
		assert.equal(s.stages.audit.unpricedRuns, 2);
		assert.equal(s.stages.audit.dollars, 0); // never a silent zero: unpricedRuns says it
		assert.equal(s.stages.extraction.unpricedRuns, 1);
		// The partial run still prices its extractor side; the fully
		// unpriced run renders "—". Newest first: 200 (both unpriced), 100.
		assert.equal(s.runs[0]!.dollars, null);
		assert.notEqual(s.runs[1]!.dollars, null);
		assert.equal(s.unpricedRuns, 1); // run-level: only the both-stages run
	});

	test("recent runs cap: newest survive", () => {
		const extractions = [1, 2, 3, 4].map((n) => extractionRun(n * 100, PRICED, PRICED));
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions }],
			sources: [],
			recentCap: 2,
		});
		assert.equal(s.runs.length, 2);
		assert.deepEqual(s.runs.map((r) => r.startedAt), [400, 300]);
		// stage totals still count EVERY run, cap is presentational.
		assert.equal(s.stages.extraction.runs, 4);
	});

	test("failed runs carry no merged stats; empty input folds to zero", () => {
		const s = graphCostSummary({
			chats: [{ title: "failed", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [],
		});
		assert.equal(s.runs[0]!.merged, undefined);
		const empty = graphCostSummary({ chats: [], sources: [] });
		assert.equal(empty.totalDollars, 0);
		assert.equal(empty.runs.length, 0);
		assert.equal(empty.stages.extraction.tokens.inputTokens, undefined);
	});

	test("a transcription run (issue #285) folds into its own stage only", () => {
		const transcriptionRun = (startedAt: number, model: string): ExtractionRunUsage => ({
			startedAt,
			at: new Date(startedAt).toISOString(),
			durationMs: 5_000,
			stages: { transcription: { model, steps: [step(3000, 400), step(3000, 400)] } },
		});
		const s = graphCostSummary({
			chats: [],
			sources: [{ filePath: "lecture.pdf", extractions: [transcriptionRun(100, PRICED), extractionRun(200, PRICED, PRICED)] }],
		});
		const pageCost = callCost(step(3000, 400), PRICED)!;
		assert.equal(s.stages.transcription.runs, 1);
		assert.equal(s.stages.transcription.dollars, pageCost * 2);
		assert.equal(s.stages.transcription.tokens.inputTokens, 6000);
		assert.equal(s.stages.extraction.runs, 1, "the transcription run bills no extraction stage");
		assert.equal(s.stages.audit.runs, 1);
		assert.equal(s.totalDollars, s.stages.transcription.dollars + s.stages.extraction.dollars + s.stages.audit.dollars);
		assert.equal(s.runs.find((r) => r.startedAt === 100)!.dollars, pageCost * 2);
		assert.equal(s.unpricedRuns, 0);

		const unpriced = graphCostSummary({ chats: [], sources: [{ filePath: "x.png", extractions: [transcriptionRun(1, "nowhere:unknown-model")] }] });
		assert.equal(unpriced.stages.transcription.unpricedRuns, 1);
		assert.equal(unpriced.unpricedRuns, 1);
		assert.equal(unpriced.runs[0]!.unpricedStages, 1);

		const subscription = graphCostSummary({ chats: [], sources: [{ filePath: "y.png", extractions: [transcriptionRun(1, "chatgpt:gpt-5")] }] });
		assert.equal(subscription.stages.transcription.subscriptionRuns, 1);
		assert.equal(subscription.unpricedRuns, 0, "a subscription-only run is not unpriced");
		assert.equal(subscription.runs[0]!.unpricedStages, undefined);
	});
});
