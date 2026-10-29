/** Read-time API-dollar estimates. Pi owns both rates and arithmetic.
 * Catalog resolution is key-independent; no provider dispatch/auth is needed.
 * Never mutate saved native messages: calculateCost mutates its usage.cost.
 */
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { piModels } from "../agent/models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "../core/contracts.ts";
import { isSubscriptionModel, sessionCost as foldSessionCost, turnCost as foldTurnCost, jobCost as foldJobCost } from "../core/prices.ts";

function catalogModel(id: string) {
	const colon = id.indexOf(":");
	// Native CLI routing determines billing. Adapter zero-rate placeholders
	// must never become an apparent $0 estimate or subscription classification.
	if (colon < 0 || isSubscriptionModel(id) || [CLAUDE_CODE_PROVIDER, CUSTOM_PROVIDER.id].includes(id.slice(0, colon))) return undefined;
	return piModels().getModel(id.slice(0, colon), id.slice(colon + 1));
}

export function callCost(call: Partial<CallUsage>, modelId: string): number | null {
	const model = catalogModel(modelId);
	if (!model || call.inputTokens === undefined || call.outputTokens === undefined) return null;
	const input = call.inputTokens;
	const output = call.outputTokens;
	const cacheRead = call.cacheReadTokens ?? 0;
	const cacheWrite = call.cacheWriteTokens ?? 0;
	const cacheWrite1h = call.cacheWrite1hTokens ?? 0;
	if ([input, output, cacheRead, cacheWrite, cacheWrite1h].some((v) => !Number.isFinite(v) || v < 0) || cacheWrite1h > cacheWrite) return null;
	// Old records discarded this split. Only price them if it cannot affect
	// the result; do not invent short-retention precision from a missing field.
	if (cacheWrite > 0 && call.cacheWrite1hTokens === undefined &&
		[model.cost, ...(model.cost.tiers ?? [])].some((rate) => rate.cacheWrite !== 2 * rate.input)) return null;
	const usage: Usage = {
		input, output, cacheRead, cacheWrite, cacheWrite1h,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const total = calculateCost(model, usage).total;
	return Number.isFinite(total) && total >= 0 ? total : null;
}

export function turnCost(turn: TurnUsage): number | null {
	return foldTurnCost(turn, callCost);
}
export function sessionCost(record: Pick<ChatRecord, "turns">) {
	return foldSessionCost(record, callCost);
}
export function jobCost(job: Pick<JobRecord, "usage">): number | null {
	const usage = job.usage;
	if (!usage || usage.steps < 1) return null;
	const hasCalls = usage.calls?.length === usage.steps;
	if (!hasCalls && usage.steps > 1 && catalogModel(usage.model)?.cost.tiers?.length) return null;
	return foldJobCost(job, callCost);
}
