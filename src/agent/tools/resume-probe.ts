import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";
import { newProbeResumeMessage } from "../../core/native-messages.ts";
import type { ProbeDoneContext } from "./probe.ts";

interface ResumeProbeContext extends Pick<ProbeDoneContext, "chatId" | "chatStore"> {
	deliver?: ProbeDoneContext["deliver"];
	onResume?: () => void;
}

/** A successful result reopens the diagnostic without deleting its history.
 * The phase handoff waits for the current run to settle before rebuilding. */
export function resumeProbeTool(ctx: ResumeProbeContext): Record<string, AgentTool<any>> {
	return {
		resume_probe: {
			name: "resume_probe",
			label: "resume_probe",
			description: "Return to diagnostic probing when the learner asks to keep exploring their foundations. " +
				"Preserves the conversation and provisional map. Call instead of quiz/explain, then end your turn. " +
				"The dedicated prober continues automatically and must conclude again before planning resumes.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async (toolCallId) => {
				if (!ctx.chatStore.getChat(ctx.chatId)) return invalidInputResult("resume_probe", ["Chat not found."]);
				if (!ctx.deliver) return invalidInputResult("resume_probe", ["Diagnostic handoff delivery is not configured."]);
				ctx.deliver(newProbeResumeMessage(ctx.chatId, toolCallId));
				ctx.onResume?.();
				return {
					content: [{ type: "text", text: "Diagnostic reopened. End this turn; the prober continues next." }],
					details: { ok: true },
					terminate: true,
				};
			},
		},
	};
}
