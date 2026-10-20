/**
 * Graph-pipeline cost summary (2026-09 graph cost metrics wave) — the pure
 * fold behind the graph view's cost pill. Two usage channels in: chat
 * extraction runs (ChatRecord.extractions) and notes-source runs
 * (NotesSource.extractions). Out: per-stage totals (extraction / audit)
 * + a capped recent-runs list. (The cluster-naming channel died with the
 * extraction-UX close-out, 2026-09-24 — UI's displayCostTotals had already
 * dropped it; historical naming-runs.jsonl spend is simply not displayed,
 * the same ruling as wave 7's stages.embedding.)
 *
 * MONEY CHANNEL LAW: dollars are INFERRED here at read time via
 * core/prices.ts — never stored anywhere, so every figure is an ESTIMATED
 * MODEL COST, not a subscription bill. An unpriced model or unreported
 * token fields produce NO dollars (dollars === null, rendered "—") and are
 * counted, never folded into a silent zero. Every level therefore carries
 * `coverage`: "complete" (every call priced AND reported), "partial" (a
 * known subtotal that omits something — say so in the UI), or "unknown"
 * (nothing could be priced). A reported zero is a real zero; a stage that
 * ran no calls is a true $0. Tokens always sum.
 *
 * Client-safe: pure types + math, no node imports; exposed via the core
 * barrel so the pill/panel components carry no cost math.
 */

import type { CallUsage, EmissionStats, ExtractionRunUsage } from "./contracts.ts";
import {
	callEstimate,
	foldCostEstimates,
	sumSteps,
	type CostCoverage,
	type CostEstimate,
} from "./prices.ts";

/** One pipeline stage's cumulative estimate across every run. */
export interface StageCost {
	/** Estimated USD summed over the priceable runs; null when no run in the
	 *  stage could be priced (render "—", never 0). */
	dollars: number | null;
	/** complete / partial (dollars omit some runs) / unknown. */
	coverage: CostCoverage;
	/** Runs whose stage estimate has dollars. */
	pricedRuns: number;
	/** Runs where this stage produced no priceable call at all. */
	unpricedRuns: number;
	/** Runs where this stage reported usage with input or output missing. */
	missingUsageRuns: number;
	/** Runs that billed this stage. */
	runs: number;
	/** Token totals across every run. */
	tokens: CallUsage;
}

/** One run in the recent-runs list (extraction or naming). */
export interface RecentRun {
	startedAt: number;
	/** ISO wall-clock. */
	at: string;
	durationMs: number;
	/** "extraction" covers both front doors (chat + notes). */
	kind: "extraction";
	/** Chat title / source file path / fixed label for naming runs. */
	title: string;
	/** Whole-run estimated USD; null only when every stage is unpriced. */
	dollars: number | null;
	/** What the dollars cover — a "partial" run is a subtotal, not a total. */
	coverage: CostCoverage;
	tokens: CallUsage;
	/** What the run merged into the graph; absent on failed runs. */
	merged?: EmissionStats;
}

/** The cost pill's whole payload: stage totals + recent runs. */
export interface GraphCostSummary {
	/** Estimated USD across all priced stages of all runs; null when nothing
	 *  could be priced anywhere (render "—", never 0). */
	totalDollars: number | null;
	/** What totalDollars covers: complete / partial / unknown. */
	coverage: CostCoverage;
	/** Runs with at least one priced stage. */
	pricedRuns: number;
	/** Runs where EVERY stage was unpriced (totalDollars excludes them). */
	unpricedRuns: number;
	/** Runs whose dollars exist but omit an unpriced/unreported stage. */
	partialRuns: number;
	/** Runs where any stage reported usage with input or output missing. */
	missingUsageRuns: number;
	/** The billable pipeline stages. (Wave 7, owner ruling 2026-09-23:
	 *  the embedding stage is gone with the provider embedder; the
	 *  2026-09-24 close-out culled cluster naming the same way —
	 *  historical spend on either is simply not displayed.) */
	stages: {
		extraction: StageCost;
		audit: StageCost;
	};
	/** Newest first, capped at `recentCap` (default 10). */
	runs: RecentRun[];
}

/** What the fold reads: already-collected run records, front-door-tagged. */
export interface CostSummaryInput {
	/** Chat-front-door runs: chat title + the record's usage log. */
	chats: { title: string; extractions: ExtractionRunUsage[] }[];
	/** Notes-front-door runs: imported file path + the source's usage log. */
	sources: { filePath: string; extractions: ExtractionRunUsage[] }[];
	recentCap?: number;
}

const ZERO_TOKENS: CallUsage = {
	inputTokens: undefined,
	outputTokens: undefined,
	cacheReadTokens: undefined,
	cacheWriteTokens: undefined,
	reasoningTokens: undefined,
};

const DEFAULT_STAGES = {
	extractor: { model: "unknown", steps: [] as CallUsage[] },
	auditor: { model: "unknown", steps: [] as CallUsage[] },
};

/** One stage's estimate over its steps. A stage with no calls billed a true
 *  $0 (complete); otherwise the fold reports only what it could price. */
function stageEstimate(model: string, steps: readonly CallUsage[]): CostEstimate {
	if (steps.length === 0) {
		return { dollars: 0, coverage: "complete", pricedCalls: 0, unpricedCalls: 0, missingUsageCalls: 0 };
	}
	return foldCostEstimates(steps.map((step) => callEstimate(step, model)));
}

/** Merge one step-set's tokens into an accumulating CallUsage. */
function mergeTokens(into: CallUsage, steps: readonly CallUsage[]): void {
	const summed = sumSteps(steps);
	into.inputTokens = (into.inputTokens ?? 0) + (summed.inputTokens ?? 0);
	into.outputTokens = (into.outputTokens ?? 0) + (summed.outputTokens ?? 0);
	into.cacheReadTokens = (into.cacheReadTokens ?? 0) + (summed.cacheReadTokens ?? 0);
	into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (summed.cacheWriteTokens ?? 0);
	into.reasoningTokens = (into.reasoningTokens ?? 0) + (summed.reasoningTokens ?? 0);
}

/** Fold one stage's per-run estimates into its StageCost row. */
function summarizeStage(estimates: readonly CostEstimate[], tokens: CallUsage): StageCost {
	const folded = foldCostEstimates(estimates);
	return {
		dollars: folded.dollars,
		coverage: folded.coverage,
		pricedRuns: estimates.filter((e) => e.dollars !== null).length,
		unpricedRuns: estimates.filter((e) => e.dollars === null).length,
		missingUsageRuns: estimates.filter((e) => e.missingUsageCalls > 0).length,
		runs: estimates.length,
		tokens,
	};
}

/** Fold every usage channel into the pill's payload. Pure: same input,
 *  same output — no clock, no fs, no store reads. */
export function graphCostSummary(input: CostSummaryInput): GraphCostSummary {
	const extractionEstimates: CostEstimate[] = [];
	const auditEstimates: CostEstimate[] = [];
	const extractionTokens: CallUsage = { ...ZERO_TOKENS };
	const auditTokens: CallUsage = { ...ZERO_TOKENS };
	const runEstimates: CostEstimate[] = [];
	const runs: RecentRun[] = [];

	const foldExtractionRun = (run: ExtractionRunUsage, title: string) => {
		const stages = run.stages ?? DEFAULT_STAGES;
		// Per-stage: tokens always count; dollars only when priced.
		const extractor = stageEstimate(stages.extractor.model, stages.extractor.steps);
		extractionEstimates.push(extractor);
		mergeTokens(extractionTokens, stages.extractor.steps);

		const auditor = stageEstimate(stages.auditor.model, stages.auditor.steps);
		auditEstimates.push(auditor);
		mergeTokens(auditTokens, stages.auditor.steps);

		// Run-level: the fold over its stages keeps the known part and the
		// coverage that qualifies it (null only when NOTHING is priceable).
		const estimate = foldCostEstimates([extractor, auditor]);
		runEstimates.push(estimate);
		runs.push({
			startedAt: run.startedAt,
			at: run.at,
			durationMs: run.durationMs,
			kind: "extraction",
			title,
			dollars: estimate.dollars,
			coverage: estimate.coverage,
			tokens: sumSteps([...stages.extractor.steps, ...stages.auditor.steps]),
			...(run.stats ? { merged: run.stats } : {}),
		});
	};

	for (const chat of input.chats) {
		for (const run of chat.extractions) foldExtractionRun(run, chat.title);
	}
	for (const source of input.sources) {
		for (const run of source.extractions) foldExtractionRun(run, source.filePath);
	}

	runs.sort((a, b) => b.startedAt - a.startedAt);
	const capped = runs.slice(0, input.recentCap ?? 10);

	// The pill's total: a fold of the runs, so an empty pipeline is unknown
	// (no evidence of a $0 spend), never a zero-dollar bill.
	const total = foldCostEstimates(runEstimates);
	return {
		totalDollars: total.dollars,
		coverage: total.coverage,
		pricedRuns: runEstimates.filter((e) => e.dollars !== null).length,
		unpricedRuns: runEstimates.filter((e) => e.dollars === null).length,
		partialRuns: runEstimates.filter((e) => e.coverage === "partial").length,
		missingUsageRuns: runEstimates.filter((e) => e.missingUsageCalls > 0).length,
		stages: {
			extraction: summarizeStage(extractionEstimates, extractionTokens),
			audit: summarizeStage(auditEstimates, auditTokens),
		},
		runs: capped,
	};
}
