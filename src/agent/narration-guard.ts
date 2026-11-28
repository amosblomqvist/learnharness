import type { ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, sendToUserText, type LhMessage } from "../core/native-messages.ts";
import { sendToUserApplies } from "./tools/send-to-user.ts";

export const NARRATION_GUARD_MAX_BLOCKS = 2;

export const NARRATION_BLOCK_REASON =
	"This response contains narration but no delivered learner-facing prose. Write the explanation or commentary the learner needs through `send_to_user`, then retry this question. Deliver learner-facing content, not internal reasoning.";

export const BARE_SEND_TO_USER_BLOCK_REASON =
	"Your `send_to_user` call used the bare tool name, so it was rejected and the learner has not seen that message. Resend it through `send_to_user` (exposed as `mcp__learnharness__send_to_user`), then retry this question.";

export const SEND_TO_USER_DELIVERY_RULE =
	"## Delivering your prose\n\n" +
	"Deliver learner-facing prose through `send_to_user`; ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
	"Send the complete explanation, example, or commentary before calling the accompanying question tool. " +
	"Question-only turns do not require an extra message. " +
	"A question whose response contains narration but no delivered prose may be rejected so you can deliver the missing explanation and retry.";

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

/** A question in a response whose `send_to_user` the Claude CLI rejected under its bare name (#791). */
export function questionFollowsRejectedOutput(message: AssistantMessage, toolName: string, delivered = false): boolean {
	if (!(QUESTION_TOOLS as readonly string[]).includes(toolName)) return false;
	const rejected = (message as AssistantMessage & Pick<LhMessage, "cliRejectedBareCalls">).cliRejectedBareCalls;
	return !delivered && rejected?.includes(SEND_TO_USER_TOOL) === true;
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
			const wasDelivered = delivered.has(assistantMessage);
			const reason = questionFollowsRejectedOutput(assistantMessage, toolCall.name, wasDelivered)
				? BARE_SEND_TO_USER_BLOCK_REASON
				: questionLacksDeliveredProse(assistantMessage, toolCall.name, wasDelivered) ? NARRATION_BLOCK_REASON : undefined;
			if (!reason) return undefined;
			blocked++;
			return { block: true, reason };
		},
		afterToolCall: async ({ assistantMessage, toolCall, result, isError }) => {
			if (toolCall.name === SEND_TO_USER_TOOL && !isError && !result.isError && sendToUserText(toolCall) !== undefined) {
				delivered.add(assistantMessage);
			}
			return undefined;
		},
	};
}
