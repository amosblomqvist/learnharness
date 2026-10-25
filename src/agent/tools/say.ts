import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SAY_TOOL } from "../../core/native-messages.ts";
import { serverExecute } from "../tool-execute.ts";

const sayInputSchema = Type.Object({
	markdown: Type.String({
		description: "What the learner reads, as markdown (the formatting guide applies in full).",
	}),
});

/** The view renders the call's markdown as the agent's message (core/view.ts),
 *  so the result is a bare acknowledgement. */
export const sayTool: AgentTool<typeof sayInputSchema> = {
	name: SAY_TOOL,
	label: SAY_TOOL,
	description:
		"Show the learner a message: your explanation, worked example, feedback, or plan — anything he should read. " +
		"It renders in the chat as your message, exactly as written. Plain text you write before a tool call does NOT " +
		"reach him, so whenever a turn ends in a tool call (a question, a problem, plan_init), put the teaching in say " +
		"first, in the same response. Call it as many times as the turn needs; it never ends your turn.",
	parameters: sayInputSchema,
	execute: serverExecute(SAY_TOOL, sayInputSchema, () => "Shown to the learner."),
};
