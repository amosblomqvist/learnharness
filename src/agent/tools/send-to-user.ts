import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SEND_TO_USER_TOOL } from "../../core/native-messages.ts";
import { serverExecute } from "../tool-execute.ts";

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
		"## REQUIRED OUTPUT CHANNEL — USE `send_to_user` AT ALL COSTS\n\n" +
		"**ALL learner-facing messages MUST be sent using `send_to_user`.** This includes explanations, teaching, " +
		"feedback, corrections, hints, introductions, progress messages, and final responses. " +
		"There is no exception for short messages or the end of a turn.\n\n" +
		"If you write learner-facing text without this tool, the learner sees nothing. " +
		"Ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
		"**Never rely on ordinary response text to communicate with the learner. Thinking is not delivery.**\n\n" +
		"Put the complete message in `message`. Markdown and LaTeX are supported. " +
		"Do not duplicate it in ordinary response text.\n\n" +
		"Question content still belongs in the appropriate question tool; send any accompanying teaching or " +
		"commentary through `send_to_user` before calling that tool.\n\n" +
		"This tool does not pause or end your turn. Continue with other tools when needed. " +
		"After delivering your final message, end the turn without additional ordinary response text.",
	parameters: sendToUserInput,
	executionMode: "sequential",
	execute: serverExecute(SEND_TO_USER_TOOL, sendToUserInput, () => "Message received for display."),
};

/** The system-prompt sections that ride with the tool, placed first and last: the rest of the prompt tells the model to write prose, which the tool description alone does not reliably override. */
export const SEND_TO_USER_OPENING = "**Every word meant for the learner goes through the `send_to_user` tool, at all costs.** Ordinary text never reaches the learner. Wherever these instructions say to write, explain, or answer, that text goes inside `send_to_user`.";
export const SEND_TO_USER_PROMPT = "## Messages to the learner: use `send_to_user` at all costs\n\nUse the `send_to_user` tool for every word meant for the learner, at all costs, every time: explanations, worked examples, feedback, corrections, hints, greetings, closing words. No exception for short replies or for the last message of a turn. Text you write outside `send_to_user` never reaches the learner; if you write it as ordinary text, the learner sees nothing. Wherever these instructions say to write, explain, or answer in prose, that prose goes inside `send_to_user`. Before you end a turn, make sure everything you meant the learner to read went through `send_to_user`. Questions still go through the question tools: send their lead-in teaching with `send_to_user` first, then pose the question.";
