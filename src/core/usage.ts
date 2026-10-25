import type { CallUsage } from "./contracts/chat.ts";

/** pi needs numeric counters internally. Adapters with optional accounting
 * carry the fields actually reported alongside them, including measured zero.
 * This survives transcript serialization without inventing measurements. */
export interface PiUsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	lhReportedUsage?: Partial<CallUsage>;
}

export function usageToCallUsage(usage: PiUsageLike): CallUsage {
	const reported = usage.lhReportedUsage;
	return reported ? {
		inputTokens: reported.inputTokens,
		outputTokens: reported.outputTokens,
		cacheReadTokens: reported.cacheReadTokens,
		cacheWriteTokens: reported.cacheWriteTokens,
		cacheWrite1hTokens: reported.cacheWrite1hTokens,
		reasoningTokens: reported.reasoningTokens,
	} : {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		reasoningTokens: usage.reasoning ?? 0,
	};
}
