/** Client-safe accounting folds. Rates and calculation live on the server,
 * using Pi's catalog and calculateCost; no copied pricing table lives here. */
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "./contracts.ts";

export type CallPricer = (usage: Partial<CallUsage>, model: string) => number | null;
export interface SessionPricing {
	cost: number;
	unpriced: number;
	subscription?: number;
	/** Derived at read time, keyed by the persisted turn's id. Never stored. */
	turnCosts: Record<string, number | null>;
}

export function isChatGPTPlan(model: string | undefined): boolean {
	return model?.startsWith("chatgpt:") === true;
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
	if (isChatGPTPlan(turn.model) || turn.steps.length === 0) return null;
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
		if (isChatGPTPlan(turn.model)) subscription++;
		else if (dollars === null) unpriced++;
		else cost += dollars;
	}
	return { cost, unpriced, ...(subscription ? { subscription } : {}), turnCosts };
}

export function jobCost(job: Pick<JobRecord, "usage">, price: CallPricer): number | null {
	const usage = job.usage;
	if (!usage || isChatGPTPlan(usage.model)) return null;
	if (usage.calls && usage.calls.length === usage.steps) {
		return turnCost({ model: usage.model, steps: usage.calls }, price);
	}
	// An old one-call job is fully reconstructible from its total. For a
	// multi-call job, the server resolver decides whether aggregate pricing
	// is safe for this model (tiered models need the lost per-call sizes).
	return price(usage, usage.model);
}
