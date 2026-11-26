/**
 * Graph-pipeline cost summary (2026-09 graph cost metrics wave) — the pure
 * fold behind the graph view's cost pill. Two usage channels in: chat
 * extraction runs (ChatRecord.extractions) and notes-source runs
 * (NotesSource.extractions). Out: per-stage totals (transcription /
 * extraction / audit)
 * + a capped recent-runs list. (The cluster-naming channel died with the
 * extraction-UX close-out, 2026-09-24 — UI's displayCostTotals had already
 * dropped it; historical naming-runs.jsonl spend is simply not displayed,
 * the same ruling as wave 7's stages.embedding.)
 *
 * MONEY CHANNEL LAW: dollars are INFERRED here at read time via
 * an injected server-side Pi pricer — never stored anywhere. An unpriced model contributes
 * ZERO dollars but is counted in `unpricedRuns` so the UI can render
 * "— unpriced" honestly, never a silent zero. Tokens always sum.
 *
 * Client-safe: pure types + math, no node imports; exposed via the core
 * barrel so the pill/panel components carry no cost math.
 */

import type { CallUsage, EmissionStats, ExtractionRunUsage, ExtractionStageUsage } from "./contracts.ts";
import { sumSteps, isSubscriptionModel, subscriptionLabels, type CallPricer } from "./prices.ts";

/** One pipeline stage's cumulative cost across every run. */
export interface StageCost {
	/** Subscription stage-runs, excluded from API dollars and unpriced counts. */
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** Inferred USD summed over PRICED runs (partial when unpricedRuns > 0). */
	dollars: number;
	/** Stage-runs whose model is missing from Pi's catalog (render "—", never zero). */
	unpricedRuns: number;
	/** Runs that billed this stage. */
	runs: number;
	/** Token totals across every run. */
	tokens: CallUsage;
}

/** One run in the recent-runs list (extraction or naming). */
export interface RecentRun {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	startedAt: number;
	/** ISO wall-clock. */
	at: string;
	durationMs: number;
	/** "extraction" covers both front doors (chat + notes). */
	kind: "extraction";
	/** Chat title / source file path / fixed label for naming runs. */
	title: string;
	/** Whole-run inferred USD; null only when EVERY stage is unpriced. */
	dollars: number | null;
	tokens: CallUsage;
	/** What the run merged into the graph; absent on failed runs. */
	merged?: EmissionStats;
	/** Stages whose model is neither priced nor a subscription — set only
	 *  when the run has no dollars and some stage is genuinely unpriced. */
	unpricedStages?: number;
}

/** The cost pill's whole payload: stage totals + recent runs. */
export interface GraphCostSummary {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** Inferred USD across all priced stages of all runs. */
	totalDollars: number;
	/** Runs with no priced API stage and at least one unknown stage. */
	unpricedRuns: number;
	/** The billable pipeline stages. (Wave 7, owner ruling 2026-09-23:
	 *  the embedding stage is gone with the provider embedder; the
	 *  2026-09-24 close-out culled cluster naming the same way —
	 *  historical spend on either is simply not displayed.) */
	stages: {
		/** PDF/image imports' vision pass (issue #285) — zero runs when
		 *  nothing was ever transcribed. */
		transcription: StageCost;
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

const emptyStage = (): StageCost => ({ dollars: 0, unpricedRuns: 0, runs: 0, tokens: { ...ZERO_TOKENS } });

/** One stage's dollars over its steps; null when the model is unpriced
 *  (all-or-nothing: a stage runs one model). */
function stageDollars(model: string, steps: readonly CallUsage[], price: CallPricer): number | null {
	if (isSubscriptionModel(model) || steps.length === 0) return null;
	let total = 0;
	for (const step of steps) {
		const c = price(step, model);
		if (c === null) return null;
		total += c;
	}
	return total;
}

/** Merge one step-set's tokens into an accumulating CallUsage. */
function mergeTokens(into: CallUsage, steps: readonly CallUsage[]): void {
	const summed = sumSteps(steps);
	// Fold this before updating total writes, so an older write-bearing
	// aggregate with a missing split remains unknown even after fresh data.
	into.cacheWrite1hTokens = sumSteps([into, summed]).cacheWrite1hTokens;
	into.inputTokens = (into.inputTokens ?? 0) + (summed.inputTokens ?? 0);
	into.outputTokens = (into.outputTokens ?? 0) + (summed.outputTokens ?? 0);
	into.cacheReadTokens = (into.cacheReadTokens ?? 0) + (summed.cacheReadTokens ?? 0);
	into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (summed.cacheWriteTokens ?? 0);
	into.reasoningTokens = (into.reasoningTokens ?? 0) + (summed.reasoningTokens ?? 0);
}

/** Fold every usage channel into the pill's payload. Pure: same input,
 *  same output — no clock, no fs, no store reads. */
export function graphCostSummary(input: CostSummaryInput, price: CallPricer): GraphCostSummary {
	const transcription = emptyStage();
	const extraction = emptyStage();
	const audit = emptyStage();
	const runs: RecentRun[] = [];
	// A run is "unpriced" when it billed nothing countable at all.
	let unpricedRuns = 0;

	/** Per-stage: tokens always count; dollars only when priced. */
	const foldStage = (cost: StageCost, stage: ExtractionStageUsage): number | null => {
		cost.runs++;
		mergeTokens(cost.tokens, stage.steps);
		const dollars = stageDollars(stage.model, stage.steps, price);
		if (isSubscriptionModel(stage.model)) {
			cost.subscriptionRuns = (cost.subscriptionRuns ?? 0) + 1;
			cost.subscriptionProviders = [...new Set([...(cost.subscriptionProviders ?? []), ...subscriptionLabels([stage.model])])];
		}
		else if (dollars === null) cost.unpricedRuns++;
		else cost.dollars += dollars;
		return dollars;
	};

	const foldExtractionRun = (run: ExtractionRunUsage, title: string) => {
		const stages = run.stages ?? { extractor: { model: "unknown", steps: [] }, auditor: { model: "unknown", steps: [] } };
		// Chunk runs carry extractor + auditor; a transcription run only its
		// own stage (issue #285). Absent stages never count.
		const billed = ([
			[transcription, stages.transcription],
			[extraction, stages.extractor],
			[audit, stages.auditor],
		] as const).filter((entry): entry is readonly [StageCost, ExtractionStageUsage] => entry[1] !== undefined);
		const used = billed.map(([, stage]) => stage);

		// Run-level: null only when EVERY stage is unpriced.
		const allStages = billed.map(([cost, stage]) => foldStage(cost, stage));
		const runDollars = allStages.every((d) => d === null)
			? null
			: allStages.reduce<number>((a, d) => a + (d ?? 0), 0);
		const subscriptionRuns = used.filter((stage) => isSubscriptionModel(stage.model)).length;
		const unpricedStages = runDollars === null ? used.length - subscriptionRuns : 0;
		if (unpricedStages > 0) unpricedRuns++;
		runs.push({
			...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: subscriptionLabels(used.map((stage) => stage.model)) } : {}),
			...(unpricedStages > 0 ? { unpricedStages } : {}),
			startedAt: run.startedAt,
			at: run.at,
			durationMs: run.durationMs,
			kind: "extraction",
			title,
			dollars: runDollars,
			tokens: sumSteps(used.flatMap((stage) => stage.steps)),
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

	const all = [transcription, extraction, audit];
	const subscriptionRuns = all.reduce((n, stage) => n + (stage.subscriptionRuns ?? 0), 0);
	return {
		...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: [...new Set(all.flatMap((stage) => stage.subscriptionProviders ?? []))] } : {}),
		totalDollars: transcription.dollars + extraction.dollars + audit.dollars,
		unpricedRuns,
		stages: { transcription, extraction, audit },
		runs: capped,
	};
}
