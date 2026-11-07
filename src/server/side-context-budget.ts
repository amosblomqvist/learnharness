import { retryDrops } from "../core/input-events.ts";
import type { LhMessage } from "../core/native-messages.ts";

export const SIDE_CONTEXT_BUDGET_ERROR = "New side-chat exchanges exceed the selected model's context budget. The tutor paused before sending this request. Completed work and all pending side exchanges have been kept. Retry to let normal compaction free older lesson history, or select a model with a larger context window.";

/** Only a local budget Retry may cross compaction performed by ITS OWN
 * preflight gate. Prior/external compaction and any intervening input keep
 * the existing refusal policy. Failed attempts stay in native history. */
export function sideBudgetRetryDrops(before: readonly LhMessage[], after: readonly LhMessage[]): Set<string> | undefined {
	let omitted: Set<string>;
	try { omitted = retryDrops([...before]); } catch { return undefined; }
	const latestFailure = before.findLast((message) => omitted.has(message.id));
	if (latestFailure?.role !== "assistant" || latestFailure.errorMessage !== SIDE_CONTEXT_BUDGET_ERROR) return undefined;
	if (after.length < before.length || before.some((message, index) => message.id !== after[index]?.id)) return undefined;
	if (!after.slice(before.length).every((message) => message.role === "custom" && message.customType === "compaction")) return undefined;
	return omitted;
}
