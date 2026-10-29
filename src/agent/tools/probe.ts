import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { probeDoneInputSchema, PROBE_DONE_ACK_TEXT } from "../../core/contracts.ts";
import { danglingQuestionOf, hasProbeDone, type LhMessage } from "../../core/native-messages.ts";
import type { ChatStore } from "../../core/ports.ts";
import { buildProbeHandoffSteer, type SteerMessage } from "../../core/contracts.ts";

/** What the probe_done tool closes over. */
export interface ProbeDoneContext {
	chatId: string;
	/** The storage port (open-question + already-concluded checks). */
	chatStore: ChatStore;
	/** Queue the handoff steer (the wake pipeline — src/server/jobs.ts).
	 *  Injected so this module never imports the server seam. */
	deliver: (steer: SteerMessage) => void;
}

/** Does the transcript already carry a concluded probe (any state)?
 *  Wave B: the native scan (any probe_done tool call, any state) — same
 *  semantics the UIMessage part scan had. */
function probeConcluded(messages: readonly LhMessage[]): boolean {
	return hasProbeDone(messages);
}

/**
 * probe_done — the probe→planning seam (docs/probe-teach-split.md §2).
 *
 * SERVER-SIDE. The prober concludes the probe by authoring the learner
 * assessment (the tool INPUT — it streams to the learner live and is
 * durable in the transcript as the tool part itself). Three outcomes:
 *
 *   ok:false + error — a question is still open ("resolve it first"), or
 *     the probe is already concluded. The refusal returns to the prober as
 *     a tool result; it fixes course and retries (the return-to-agent
 *     doctrine, same as nodeId validation).
 *   ok:true — the assessment is recorded, and the HANDOFF is queued: a
 *     steer through the wake pipeline that fires the teacher's first turn
 *     (plan authoring) the moment the prober's turn ends. Auto-wake is the
 *     user-decided trigger — the learner experiences assessment → plan as
 *     one continuous flow. CONTEXT-SLIM (owner, context diet 2026-10-09):
 *     the call's arguments already carry the assessment (durable, streamed
 *     live), so the agent sees the fixed PROBE_DONE_ACK_TEXT — never an
 *     echo. details = {ok:true} only.
 *
 * The first concluded probe_done (non-failed call plus matching successful
 * result) is also the construction seam: from that result on, every request
 * builds the TEACHER agent. Bare calls and refused results keep probing.
 */
export function probeDoneTool(ctx: ProbeDoneContext): Record<string, AgentTool<any>> {
	return {
		probe_done: {
			name: "probe_done",
			label: "probe_done",
			description:
				"Conclude the probing phase and hand off to the teaching phase. Call this ONCE, when the probe is " +
				"complete: every strand the lesson depends on is bracketed (a floor he reliably gets right AND a " +
				"ceiling where it runs out), and his learning goal is concrete. The input IS the learner assessment — " +
				"one strand per dependency the lesson will rest on, with your read of where his edge sits on it " +
				"(floor, ceiling, misconceptions, what to build from). It streams to the learner live and becomes " +
				"the handoff artifact the teacher plans from. Refused while a question is still open, and after " +
				"the probe is already concluded. After it succeeds, say your closing sentence and end your turn.",
			// The core-owned schema (contracts/probe.ts) — the SAME schema the UI
			// parse seam (tool-parts.ts) runs, so boundary-valid ⇔ consumer-parseable.
			parameters: probeDoneInputSchema,
			execute: serverExecute("probe_done", probeDoneInputSchema, async (input) => {
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };

				if (danglingQuestionOf(record.messages) !== null) {
					return {
						ok: false,
						error:
							"A question is still open — resolve it (or let him answer) before concluding the probe. " +
							"probe_done only fires with no question outstanding.",
					};
				}
				if (probeConcluded(record.messages)) {
					return { ok: false, error: "The probe is already concluded — probe_done fires exactly once." };
				}
				try {
					ctx.deliver(buildProbeHandoffSteer(ctx.chatId));
				} catch (err) {
					console.error(`[chat ${ctx.chatId}] probe handoff queueing failed:`, err);
					// The handoff is recoverable-by-design (the next client message
					// constructs the teacher off the transcript seam) — record the
					// assessment anyway; the wake is an optimization, not a gate.
				}
				// Context diet (owner, 2026-10-09): the assessment lives ONCE — as
				// this call's arguments. content is the fixed ack (the agent never
				// sees an echo); details = {ok:true} for the record/UI — the
				// probe-done card reads the call's input, which it always preferred.
				return {
					text: PROBE_DONE_ACK_TEXT,
					details: { ok: true },
				};
			}),
		},
	};
}
