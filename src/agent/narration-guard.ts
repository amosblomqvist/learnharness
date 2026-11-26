import type { ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, sendToUserText } from "../core/native-messages.ts";
import { sendToUserApplies } from "./tools/send-to-user.ts";

export const NARRATION_GUARD_MAX_BLOCKS = 2;

export const NARRATION_BLOCK_REASON =
	"This response contains narration but no delivered learner-facing prose. Write the explanation or commentary the learner needs through `send_to_user`, then retry this question. Deliver learner-facing content, not internal reasoning.";

/** Every agent offered `send_to_user` (sendToUserApplies). */
export const SEND_TO_USER_DELIVERY_RULE =
	"## Delivering your prose\n\n" +
	"Deliver learner-facing prose through `send_to_user`; ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
	"Send the complete explanation, example, or commentary before calling the accompanying question tool. " +
	"Question-only turns do not require an extra message. " +
	"When a `send_to_user` message is the last thing you do in a turn, set `final: true` on it. " +
	"Leave it off if any tool call follows, including a question tool.";

/** Appended to the delivery rule only where the narration guard runs. */
export const NARRATION_RETRY_RULE =
	"A question whose response contains narration but no delivered prose may be rejected so you can deliver the missing explanation and retry.";

/** The prompt section for an agent offered `send_to_user`. */
export function deliveryRule(guarded: boolean): string {
	return guarded ? `${SEND_TO_USER_DELIVERY_RULE} ${NARRATION_RETRY_RULE}` : SEND_TO_USER_DELIVERY_RULE;
}

export function narrationGuardApplies(
	kind: string,
	model: { provider: string; id: string },
	toolsOverridden: boolean,
): boolean {
	return kind === "teacher" && sendToUserApplies(kind, model, toolsOverridden);
}

export function isNarrationBlock(block: { type: string; thinkingSignature?: string }): boolean {
	if (block.type !== "thinking" || typeof block.thinkingSignature !== "string") return false;
	try {
		return Buffer.from(block.thinkingSignature, "base64").subarray(0, 60).includes("narration");
	} catch {
		return false;
	}
}

export function questionLacksDeliveredProse(message: AssistantMessage, toolName: string, delivered = false): boolean {
	if (!(QUESTION_TOOLS as readonly string[]).includes(toolName)) return false;
	if (!message.content.some(isNarrationBlock as (b: AssistantMessage["content"][number]) => boolean)) return false;
	return !delivered && !message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

export function makeNarrationGuard(): ToolCallHooks {
	let blocked = 0;
	// The sequential output/question tools run in call order. Credit only a
	// successful output already executed for THIS response, never a later
	// call, an older lesson, or a failed/aborted output. State is run-local.
	const delivered = new WeakSet<AssistantMessage>();
	return {
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (blocked >= NARRATION_GUARD_MAX_BLOCKS) return undefined;
			if (!questionLacksDeliveredProse(assistantMessage, toolCall.name, delivered.has(assistantMessage))) return undefined;
			blocked++;
			return { block: true, reason: NARRATION_BLOCK_REASON };
		},
		afterToolCall: async ({ assistantMessage, toolCall, result, isError }) => {
			if (toolCall.name === SEND_TO_USER_TOOL && !isError && !result.isError && sendToUserText(toolCall) !== undefined) {
				delivered.add(assistantMessage);
			}
			return undefined;
		},
	};
}
