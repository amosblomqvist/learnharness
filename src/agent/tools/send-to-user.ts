import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SEND_TO_USER_TOOL } from "../../core/native-messages.ts";
import { serverExecute } from "../tool-execute.ts";

const sendToUserInput = Type.Object({
	message: Type.String({ description: "The content to display to the learner. Markdown and LaTeX render." }),
});

/** The send_to_user tool — Anthropic's documented fix for verbatim mid-turn content: newer Claude models return text written right before a tool call only as a short summary, but tool input is never summarized. */
export const sendToUserTool: AgentTool<typeof sendToUserInput> = {
	name: SEND_TO_USER_TOOL,
	label: SEND_TO_USER_TOOL,
	description: "Display a message directly to the learner. Use this for content the learner must see exactly as written before your turn finishes, such as the teaching before a check, a worked example, or a correction.",
	parameters: sendToUserInput,
	execute: serverExecute(SEND_TO_USER_TOOL, sendToUserInput, () => "Shown to the learner."),
};
