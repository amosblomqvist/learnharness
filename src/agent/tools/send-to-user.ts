import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SEND_TO_USER_TOOL } from "../../core/native-messages.ts";
import { CLAUDE_CODE_PROVIDER } from "../claude-code/constants.ts";
import { serverExecute } from "../tool-execute.ts";

/** Claude models get the output tool (their plain text may be summarized
 *  into thinking). Matches Claude across providers (including OpenRouter),
 *  not the API transport. The side-question agent uses this directly. */
export function needsSendToUser(model: { provider: string; id: string }): boolean {
	return model.provider === CLAUDE_CODE_PROVIDER || model.id.toLowerCase().includes("claude");
}

/** One availability rule for the tool and its teacher-only delivery guard.
 * Practice uses ordinary final prose; explicit registries remain caller-owned. */
export function sendToUserApplies(
	kind: string,
	model: { provider: string; id: string },
	toolsOverridden: boolean,
): boolean {
	return (kind === "prober" || kind === "teacher") && !toolsOverridden && needsSendToUser(model);
}

const sendToUserInput = Type.Object({
	message: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "The complete content to display to the learner. Markdown and LaTeX are supported.",
	}),
});

/** Claude's documented verbatim mid-turn output channel. Availability is
 * model-gated at the shared conversation-agent construction boundary;
 * the native call remains in history, and the view renders its message. */
export const sendToUserTool: AgentTool<typeof sendToUserInput> = {
	name: SEND_TO_USER_TOOL,
	label: SEND_TO_USER_TOOL,
	description:
		"## REQUIRED OUTPUT CHANNEL — ALWAYS USE `send_to_user`\n\n" +
		"**ALL learner-facing messages MUST be sent using `send_to_user`.** This includes explanations, teaching, " +
		"feedback, corrections, hints, introductions, progress messages, and final responses. " +
		"There is no exception for short messages or the end of a turn.\n\n" +
		"Ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
		"**Never rely on ordinary response text to communicate with the learner. Thinking is not delivery.**\n\n" +
		"Put the complete message in `message`. Markdown and LaTeX are supported. " +
		"Do not duplicate it in ordinary response text.\n\n" +
		"Question content still belongs in the appropriate question tool; send any accompanying teaching or " +
		"commentary through `send_to_user` before calling that tool.\n\n" +
		"This tool does not pause or end your turn. Continue with other tools when needed. " +
		"After your final `send_to_user`, end the turn with an empty response. " +
		"Never restate or summarize the delivered message in ordinary response text.",
	parameters: sendToUserInput,
	executionMode: "sequential",
	execute: serverExecute(SEND_TO_USER_TOOL, sendToUserInput, () => "Message received for display."),
};
