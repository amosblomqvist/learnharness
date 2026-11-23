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
	final: Type.Optional(Type.Boolean({
		description: "Set true on your last message of the turn: the turn ends immediately after it is delivered, " +
			"with no further response from you. Omit it when you will call another tool afterwards.",
	})),
});

/** The delivery acks. The non-final one is what the model reads right
 * before deciding whether to close the turn, so it states the ending. */
export const SEND_TO_USER_ACK = "Delivered. If this was your last message, end the turn with an empty response.";
export const SEND_TO_USER_FINAL_ACK = "Delivered. The turn has ended.";

const deliver = serverExecute(SEND_TO_USER_TOOL, sendToUserInput, (input) =>
	input.final === true ? SEND_TO_USER_FINAL_ACK : SEND_TO_USER_ACK);

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
		"By default this tool does not pause or end your turn. Continue with other tools when needed. " +
		"For your last message of the turn, set `final: true`: the turn ends as soon as it is delivered. " +
		"Never restate or summarize the delivered message in ordinary response text.",
	parameters: sendToUserInput,
	executionMode: "sequential",
	// A delivered final message ends the run natively (terminate: true), like
	// a posed question, so no closing model call follows. pi stops only when
	// every result in the batch terminates, so other calls still run on.
	execute: async (toolCallId, input, signal) => {
		const result = await deliver(toolCallId, input, signal);
		return (input as { final?: unknown }).final === true && !result.isError ? { ...result, terminate: true } : result;
	},
};
