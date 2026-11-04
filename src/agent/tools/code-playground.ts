/** Client-executed like quiz: the call ends the turn, and the learner's
 *  attempt comes back as their next message. Nothing runs server-side here. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	codePlaygroundInputObject,
	engineKindFor,
	isCodingLanguage,
	modeNeedsExecution,
	type CodePlaygroundInput,
} from "../../core/code-playground.ts";
import { invalidInputResult, questionResult } from "../tool-execute.ts";

export function codePlaygroundTool(): AgentTool<typeof codePlaygroundInputObject> {
	return {
		name: "code_playground",
		label: "code_playground",
		description:
			"Hand the learner an editable code editor that runs their code. Use it whenever the next step involves " +
			"writing, fixing, or predicting the output of code — even three lines — instead of describing code in prose. " +
			"The learner's code, their output, and their failed attempts come back to you as their next message. " +
			"Not for decoration: it is the step itself. Non-coding lessons never use it.",
		parameters: codePlaygroundInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId: string, input: CodePlaygroundInput) => {
			// INVARIANT: a card that asks the learner to run code must be runnable in
			// this deployment. If the language has no engine, the teacher is told so
			// here — never by handing the learner a Run button that cannot work.
			const mode = input.mode ?? "implement";
			// The playground is for programming languages only — a prose subject
			// ("spanish", "history") must never be handed one, in any mode.
			if (!isCodingLanguage(input.language)) {
				return invalidInputResult("code_playground", [
					`"${input.language}" is not a programming language, so no card fits. Teach it in prose, ` +
						`or use quiz/ask_user_question for a check.`,
				]);
			}
			if (modeNeedsExecution(mode) && engineKindFor(input.language) === null) {
				return invalidInputResult("code_playground", [
					`No runtime for "${input.language}" in this deployment, so a ${mode} card would be ` +
						`unrunnable. Use mode "error-read" or "syntax" (both need no execution), pick a ` +
						`language with an engine, or teach this one in prose.`,
				]);
			}
			return questionResult();
		},
	};
}
