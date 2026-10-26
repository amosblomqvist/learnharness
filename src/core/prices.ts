/** Client-safe accounting folds. Rates and calculation live on the server,
 * using Pi's catalog and calculateCost; no copied pricing table lives here. */
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "./contracts.ts";
import { NATIVE_SUBSCRIPTIONS } from "./contracts/subscriptions.ts";

export type CallPricer = (usage: Partial<CallUsage>, model: string) => number | null;

/** Per-call dollars avoided by the provider's prefix cache. Null when the
 *  call or its model cannot be priced; 0 when the call reused nothing. */
export type CacheSaver = (usage: CallUsage, model: string) => number | null;

/** One session's prefix-cache economics, folded at read time from the same
 *  append-only turns log the money channel uses. Token counts are
 *  provider-reported and disjoint (fresh input excludes cache reads/writes). */
export interface CacheSummary {
	/** Fresh input + cache reads + cache writes across every call. */
	promptTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** `cacheReadTokens / promptTokens`; 0 when nothing was measured. */
	hitRate: number;
	/** Net USD avoided by cache reads (can be negative on write-heavy
	 *  routes; the stats surface clamps the display, not the fold). */
	savedUsd: number;
	/** Calls whose savings were priced / could not be priced. */
	pricedCalls: number;
	unpricedCalls: number;
}

export interface SessionPricing {
	cost: number;
	unpriced: number;
	subscription?: number;
	subscriptionProviders?: string[];
	/** Derived at read time, keyed by the persisted turn's id. Never stored. */
	turnCosts: Record<string, number | null>;
	/** Prefix-cache economics (DeepSeek automatic cache). Server-computed;
	 *  absent on client-only folds that have no rate table. */
	cache?: CacheSummary;
}

export function isChatGPTPlan(model: string | undefined): boolean {
	return model?.startsWith("chatgpt:") === true;
}
export function subscriptionLabel(model: string | undefined): string | undefined {
	if (isChatGPTPlan(model)) return "ChatGPT";
	return NATIVE_SUBSCRIPTIONS.find((p) => model?.startsWith(`${p.logicalId}:`))?.label;
}
export function isSubscriptionModel(model: string | undefined): boolean { return subscriptionLabel(model) !== undefined; }
export function subscriptionLabels(models: readonly (string | undefined)[]): string[] {
	return [...new Set(models.flatMap((model) => { const label = subscriptionLabel(model); return label ? [label] : []; }))];
}

/** Absent stays absent. Long-cache precision is unknown if any write-bearing
 * step lacks the split; never silently turn that missing detail into zero. */
export function sumSteps(steps: readonly CallUsage[]): CallUsage {
	const sumIfAny = (vals: (number | undefined)[]): number | undefined =>
		vals.every((v) => v === undefined) ? undefined : vals.reduce<number>((a, v) => a + (v ?? 0), 0);
	return {
		inputTokens: sumIfAny(steps.map((s) => s.inputTokens)),
		outputTokens: sumIfAny(steps.map((s) => s.outputTokens)),
		cacheReadTokens: sumIfAny(steps.map((s) => s.cacheReadTokens)),
		cacheWriteTokens: sumIfAny(steps.map((s) => s.cacheWriteTokens)),
		cacheWrite1hTokens: steps.some((s) => (s.cacheWriteTokens ?? 0) > 0 && s.cacheWrite1hTokens === undefined)
			? undefined : sumIfAny(steps.map((s) => s.cacheWrite1hTokens)),
		reasoningTokens: sumIfAny(steps.map((s) => s.reasoningTokens)),
	};
}

export function turnCost(turn: Pick<TurnUsage, "model" | "steps">, price: CallPricer): number | null {
	if (isSubscriptionModel(turn.model) || turn.steps.length === 0) return null;
	let total = 0;
	for (const step of turn.steps) {
		const cost = price(step, turn.model);
		if (cost === null) return null;
		total += cost;
	}
	return total;
}

export function sessionCost(record: Pick<ChatRecord, "turns">, price: CallPricer): SessionPricing {
	let cost = 0;
	let unpriced = 0;
	let subscription = 0;
	const turnCosts: Record<string, number | null> = {};
	for (const turn of record.turns ?? []) {
		const dollars = turnCost(turn, price);
		turnCosts[turn.id] = dollars;
		if (isSubscriptionModel(turn.model)) subscription++;
		else if (dollars === null) unpriced++;
		else cost += dollars;
	}
	return { cost, unpriced, ...(subscription ? { subscription, subscriptionProviders: subscriptionLabels((record.turns ?? []).map((turn) => turn.model)) } : {}), turnCosts };
}

/** Fold the prefix-cache half of the same turns log. Token counts and hit
 *  rate need no rate table (provider-reported), so they stay honest even
 *  when a model is unpriced; only `savedUsd` depends on the injected saver. */
export function sessionCache(record: Pick<ChatRecord, "turns">, save: CacheSaver): CacheSummary {
	let promptTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let savedUsd = 0;
	let pricedCalls = 0;
	let unpricedCalls = 0;
	for (const turn of record.turns ?? []) {
		for (const step of turn.steps) {
			const fresh = step.inputTokens ?? 0;
			const read = step.cacheReadTokens ?? 0;
			const write = step.cacheWriteTokens ?? 0;
			promptTokens += fresh + read + write;
			cacheReadTokens += read;
			cacheWriteTokens += write;
			const saved = save(step, turn.model);
			if (saved === null) unpricedCalls++;
			else {
				savedUsd += saved;
				pricedCalls++;
			}
		}
	}
	return {
		promptTokens,
		cacheReadTokens,
		cacheWriteTokens,
		hitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
		savedUsd,
		pricedCalls,
		unpricedCalls,
	};
}

export function jobCost(job: Pick<JobRecord, "usage">, price: CallPricer): number | null {
	const usage = job.usage;
	if (!usage || isSubscriptionModel(usage.model)) return null;
	if (usage.calls && usage.calls.length === usage.steps) {
		return turnCost({ model: usage.model, steps: usage.calls }, price);
	}
	// An old one-call job is fully reconstructible from its total. For a
	// multi-call job, the server resolver decides whether aggregate pricing
	// is safe for this model (tiered models need the lost per-call sizes).
	return price(usage, usage.model);
}
