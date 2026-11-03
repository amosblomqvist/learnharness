import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL } from "../core/native-messages.ts";

export const NARRATION_GUARD_MAX_BLOCKS = 2;

export const NARRATION_BLOCK_REASON =
	"Your teaching prose for this step was NOT delivered to the learner — it was converted into hidden thinking, and what remains in your history is only a short, lossy summary of it. Do NOT just restate that summary. Call `send_to_user` with the FULL lesson for this step, written out as you originally intended: the complete explanation, the worked example or code, and any setup or picture the question below depends on (markdown and LaTeX supported). Then call this question tool again in the same message.";

export const SEND_TO_USER_DELIVERY_RULE =
	"## Delivering your prose\n\n" +
	"Deliver every word of learner-facing prose through `send_to_user`, in the same message, BEFORE the question call. " +
	"On this model, ordinary response text is converted into hidden thinking and the learner never sees it; only `send_to_user` content reaches the transcript. " +
	"So each step is: (1) `send_to_user` with the full explanation, example and code, then (2) the question tool call, both in one message. " +
	"A question call with no `send_to_user` ahead of it is rejected, and you will have to rewrite the entire lesson from scratch.";

export function narrationGuardApplies(
	kind: string,
	model: { provider: string },
	toolsOverridden: boolean,
): boolean {
	return kind === "teacher" && !toolsOverridden && model.provider === "anthropic";
}

export function isNarrationBlock(block: { type: string; thinkingSignature?: string }): boolean {
	if (block.type !== "thinking" || typeof block.thinkingSignature !== "string") return false;
	try {
		return Buffer.from(block.thinkingSignature, "base64").subarray(0, 60).includes("narration");
	} catch {
		return false;
	}
}

export function questionLacksDeliveredProse(message: AssistantMessage, toolName: string): boolean {
	if (!(QUESTION_TOOLS as readonly string[]).includes(toolName)) return false;
	if (!message.content.some(isNarrationBlock as (b: AssistantMessage["content"][number]) => boolean)) return false;
	return !message.content.some(
		(b) => (b.type === "text" && b.text.trim().length > 0) || (b.type === "toolCall" && b.name === SEND_TO_USER_TOOL),
	);
}

export function makeNarrationGuard() {
	let blocked = 0;
	return async (context: { assistantMessage: AssistantMessage; toolCall: { name: string } }) => {
		if (blocked >= NARRATION_GUARD_MAX_BLOCKS) return undefined;
		if (!questionLacksDeliveredProse(context.assistantMessage, context.toolCall.name)) return undefined;
		blocked++;
		return { block: true, reason: NARRATION_BLOCK_REASON };
	};
}
