/**
 * PRACTICE RECORD MECHANICS (practice sessions, owner 2026-10-04): the
 * native shapes beneath the two practice tools — the active-problem fold
 * (conclude-before-next-problem), the thinking marker (label registers),
 * the ask-style dismissal (UI-only marker; the conclude pair rides the
 * NEXT input), and the model-facing flattening (markers labeled, the
 * dismissal filtered, the synthesized pair native).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	activeProblemOf,
	asAgentMessages,
	concludedByDismissalPair,
	newProblemDismissedMarker,
	newNextMessage,
	newThinkingMessage,
	needsContinuation,
	newUserMessage,
	pendingProblemDismissalOf,
	toLlmMessages,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import { dismissAppends, inputAppends, parseChatInput, parseDismissInput } from "../src/core/input-events.ts";
import { modelSolutionForConclude } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/index.ts";

// ── builders (native-shaped test fixtures) ───────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

function problemPose(callId = "call_p1", statement = "Show that…"): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [
			{ type: "toolCall", id: callId, name: PRACTICE_PROBLEM_TOOL, arguments: { statement, mode: "recall", modelSolution: statement } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here." }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [assistant, ack];
}

function concludeCall(outcome: string): LhMessage[] {
	// Honest folds: the conclude call rides WITH its clean ack — a
	// dangling or errored conclude never freed anything.
	return [
		{
			id: `msg_c_${outcome}`,
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `call_conclude_${outcome}`,
					name: PRACTICE_CONCLUDE_TOOL,
					arguments: { outcome },
				},
			],
			timestamp: 3,
			...STAMPS,
		},
		{
			id: `msg_cr_${outcome}`,
			role: "toolResult",
			toolCallId: `call_conclude_${outcome}`,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: "Problem concluded — the composer is free; pose the next problem or wrap up." }],
			details: null,
			isError: false,
			timestamp: 4,
		},
	];
}

// ── the active-problem fold ──────────────────────────────────────────────────

describe("activeProblemOf (the conclude-before-next-problem gate's fold)", () => {
	it("no messages → nothing active", () => {
		assert.equal(activeProblemOf([]), null);
	});

	it("a posed problem (call + ack) is ACTIVE — the ack does not conclude", () => {
		const messages = problemPose();
		const active = activeProblemOf(messages);
		assert.equal(active?.toolCallId, "call_p1");
		assert.deepEqual(active?.input, { statement: "Show that…", mode: "recall", modelSolution: "Show that…" });
	});

	it("thinking submissions keep it active (nudges never conclude)", () => {
		const messages = [
			...problemPose(),
			newThinkingMessage("call_p1", "stuck at the second step"),
		];
		assert.equal(activeProblemOf(messages)?.toolCallId, "call_p1");
	});

	it("a conclude call deactivates", () => {
		const messages = [...problemPose(), ...concludeCall("solved")];
		assert.equal(activeProblemOf(messages), null);
	});

	it("an ERRORED pose never activates (the BKT phantom — honest activation)", () => {
		// The gate refused the pose ("a problem is already active" in the
		// BKT incident); the composer must not mount from its arguments.
		const rejected = problemPose("call_bad", "A different student…");
		(rejected[1]! as unknown as { isError: boolean }).isError = true;
		assert.equal(activeProblemOf(rejected), null, "a lone refused pose is nothing");
	});

	it("a clean pose UNDER an errored rejection stays active (the scan skips refusals)", () => {
		const rejected = problemPose("call_bad", "A different student…");
		(rejected[1]! as unknown as { isError: boolean }).isError = true;
		const active = activeProblemOf([...problemPose(), ...rejected]);
		assert.ok(active, "the clean pose below is still the active one");
		assert.equal(active!.toolCallId, "call_p1");
	});

	it("an ERRORED conclude does not free (only the clean ack frees)", () => {
		const badConclude = concludeCall("solved");
		(badConclude[1]! as unknown as { isError: boolean }).isError = true;
		const active = activeProblemOf([...problemPose(), ...badConclude]);
		assert.ok(active, "the conclude never happened — the problem stays live");
		assert.equal(active!.toolCallId, "call_p1");
	});

	it("a DANGLING pose (mid-turn, no result) does not activate — it has not gone through", () => {
		const dangling = problemPose("call_new", "Fresh problem…")[0]!;
		assert.equal(activeProblemOf([dangling]), null, "no ack, no problem");
	});

	it("a dismissal marker deactivates immediately (the card closes at Esc)", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1")];
		assert.equal(activeProblemOf(messages), null);
	});

	it("a NEWER problem after a conclude is the active one", () => {
		const messages = [
			...problemPose("call_p1"),
			...concludeCall("solved"),
			...problemPose("call_p2", "second"),
		];
		assert.equal(activeProblemOf(messages)?.toolCallId, "call_p2");
	});
});

// ── the dismissal's deferred conclude ────────────────────────────────────────

describe("pendingProblemDismissalOf (the marker waiting for its synthesis)", () => {
	it("a trailing dismissal marker pends", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1")];
		assert.equal(pendingProblemDismissalOf(messages), "call_p1");
	});

	it("the synthesized pair clears it", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1"), ...concludedByDismissalPair("call_p1")];
		assert.equal(pendingProblemDismissalOf(messages), null);
	});

	it("a plain record pends nothing", () => {
		assert.equal(pendingProblemDismissalOf(problemPose()), null);
	});
});

// ── the input channel ────────────────────────────────────────────────────────

describe("the thinking input", () => {
	it("parses and appends the marker against the active problem (ONE lane)", () => {
		const input = parseChatInput({
			type: "thinking",
			problemCallId: "call_p1",
			text: "I think the inactivity constraint applies here",
		});
		assert.deepEqual(input, {
			type: "thinking",
			problemCallId: "call_p1",
			text: "I think the inactivity constraint applies here",
		});
		const appends = inputAppends({ messages: problemPose() }, input);
		assert.equal(appends.length, 1);
		const marker = appends[0] as { customType: string; content: string; details: unknown };
		assert.equal(marker.customType, "practice-thinking");
		// The single label (owner round 2, 2026-10-05): the register is read
		// from the text by the agent, never declared by a button.
		assert.match(marker.content, /Your thinking:\n/);
		assert.deepEqual(marker.details, {
			problemCallId: "call_p1",
			text: "I think the inactivity constraint applies here",
		});
	});

	it("400s against a stale or unknown problem call", () => {
		assert.throws(
			() => inputAppends({ messages: problemPose() }, { type: "thinking", problemCallId: "call_ghost", text: "x" }),
			/targets no active problem/,
		);
		assert.throws(
			() => inputAppends({ messages: [] }, { type: "thinking", problemCallId: "call_p1", text: "x" }),
			/targets no active problem/,
		);
	});

	it("empty text 400s at parse", () => {
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "c", text: "  " }), /non-empty/);
	});
});

// ── the move-on signal (owner round 16, 2026-10-06) ─────────────────────────

describe("the next input", () => {
	it("parses bare and appends the practice-next marker in an idle practice session", () => {
		const input = parseChatInput({ type: "next" });
		assert.deepEqual(input, { type: "next" });
		const appends = inputAppends({ messages: [], kind: "practice" }, input);
		assert.equal(appends.length, 1);
		const marker = appends[0] as { customType: string; content: string };
		assert.equal(marker.customType, "practice-next");
		// The model's unambiguous go-ahead, single-sourced in contracts.
		assert.match(marker.content, /\[NEXT PROBLEM\]/);
	});

	it("400s outside practice sessions (the affordance is practice-only)", () => {
		assert.throws(() => inputAppends({ messages: [], kind: "teach" }, { type: "next" }), /practice-session/);
		assert.throws(() => inputAppends({ messages: [] }, { type: "next" }), /practice-session/);
	});

	it("400s while a problem is active (mid-problem input rides the dock)", () => {
		assert.throws(() => inputAppends({ messages: problemPose(), kind: "practice" }, { type: "next" }), /no active problem/);
	});

	it("rides AFTER a pending dismissal conclusion, exactly like text", () => {
		const dismissed = [...problemPose(), newProblemDismissedMarker("call_p1")];
		const appends = inputAppends({ messages: dismissed, kind: "practice" }, { type: "next" });
		assert.equal(appends.length, 3); // conclude pair + the next marker
		assert.equal((appends[2] as { customType: string }).customType, "practice-next");
	});
});

describe("the dismissal's conclude synthesis rides the next input", () => {
	it("text after a dismissal prepends the conclude pair before the user message", () => {
		const record = { messages: [...problemPose(), newProblemDismissedMarker("call_p1")] };
		const appends = inputAppends(record, { type: "text", text: "that one was over my head" });
		assert.equal(appends.length, 3);
		const [call, ack, user] = appends as [AssistantMessage & { id: string }, ToolResultMessage & { id: string }, { role: string; content: string }];
		assert.equal(call.content[0]!.type, "toolCall");
		assert.equal((call.content[0] as { name: string }).name, PRACTICE_CONCLUDE_TOOL);
		assert.deepEqual((call.content[0] as { arguments: unknown }).arguments, { outcome: "dismissed" });
		assert.equal(ack.toolCallId, (call.content[0] as { id: string }).id);
		assert.equal((ack.content[0] as { text: string }).text, CONCLUDE_ACK_TEXT);
		assert.equal(user.role, "user");
		assert.equal(user.content, "that one was over my head");
	});

	it("continue after a dismissal carries the pair alone", () => {
		const record = { messages: [...problemPose(), newProblemDismissedMarker("call_p1")] };
		const appends = inputAppends(record, { type: "continue" });
		assert.equal(appends.length, 2);
	});

	it("with nothing pending, text appends only the user message", () => {
		const appends = inputAppends({ messages: problemPose() }, { type: "text", text: "hello" });
		assert.equal(appends.length, 1);
	});
});

describe("the dismiss-problem input (ask-style discard)", () => {
	it("parses and appends the UI-only marker against the active problem", () => {
		const input = parseDismissInput({ type: "dismiss-problem", problemCallId: "call_p1" });
		assert.deepEqual(input, { type: "dismiss-problem", problemCallId: "call_p1" });
		const appends = dismissAppends({ messages: problemPose() }, input);
		assert.equal(appends.length, 1);
		assert.equal((appends[0] as { customType: string }).customType, "problem-dismissed");
	});

	it("400s when nothing active or a stale id", () => {
		assert.throws(() => dismissAppends({ messages: [] }, { type: "dismiss-problem", problemCallId: "x" }), /no active problem/);
		const concluded = [...problemPose(), ...concludeCall("solved")];
		assert.throws(() => dismissAppends({ messages: concluded }, { type: "dismiss-problem", problemCallId: "call_p1" }), /no active problem/);
	});
});

// ── the model-facing seam ────────────────────────────────────────────────────

describe("toLlmMessages (practice shapes)", () => {
	it("the thinking marker flattens to a labeled user message", () => {
		const out = toLlmMessages(asAgentMessages([newThinkingMessage("call_p1", "It is 42")]));
		assert.equal(out.length, 1);
		const user = out[0] as { role: string; content: Array<{ type: string; text: string }> };
		assert.equal(user.role, "user");
		assert.match(user.content[0]!.text, /^Your thinking:\nIt is 42$/);
	});

	it("the dismissal marker is UI-only (the synthesized pair carries the face)", () => {
		const out = toLlmMessages(asAgentMessages([newProblemDismissedMarker("call_p1")]));
		assert.equal(out.length, 0);
	});

	it("the synthesized pair passes through natively", () => {
		const out = toLlmMessages(asAgentMessages(concludedByDismissalPair("call_p1")));
		assert.equal(out.length, 2);
		assert.equal(out[0]!.role, "assistant");
		assert.equal(out[1]!.role, "toolResult");
	});
});

// ── the continuation fold's practice carve-out ──────────────────────────────

describe("needsContinuation (a persisted pose ack owes nothing)", () => {
	it("a record ending on a problem-pose ack does NOT wake a continuation", () => {
		// The pose's terminate:true ended that turn deliberately; the
		// ack persists (unlike a question's placeholder). Without the
		// carve-out, a reload after a posed problem would wake a
		// phantom turn (owner design, 2026-10-04).
		assert.equal(needsContinuation(problemPose()), false);
	});

	it("a mixed batch (conclude ack then pose ack) still owes nothing — the pose is terminal", () => {
		const messages = [
			...problemPose("call_p0", "the earlier one"),
			...concludeCall("solved"),
			{
				id: "msg_r_conclude",
				role: "toolResult",
				toolCallId: "call_conclude_solved",
				toolName: PRACTICE_CONCLUDE_TOOL,
				content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
				details: null,
				isError: false,
				timestamp: 4,
			} as LhMessage & ToolResultMessage,
			...problemPose("call_p2", "the next one"),
		];
		assert.equal(needsContinuation(messages), false);
	});

	it("an ERROR result is not a pose — the agent loop continues past it, so a record ending there (an abort) is owed the wake like any interrupted tool", () => {
		const messages = [...problemPose("call_pe")];
		const err = messages[1] as LhMessage & ToolResultMessage;
		err.isError = true;
		err.content = [{ type: "text", text: "A problem is already active." }];
		assert.equal(needsContinuation(messages), true);
	});
});


// ── the reveal join (owner round, 2026-10-05) ───────────────────────────────

describe("modelSolutionForConclude (the conclusion's hero is the pose's commitment)", () => {
	it("returns the cleanly-posed problem's modelSolution before the conclude", () => {
		const messages = [...problemPose(), ...concludeCall("solved")];
		assert.equal(modelSolutionForConclude(messages, "call_conclude_solved"), "Show that…");
	});

	it("skips refused poses — a rejected pose revealed nothing", () => {
		const rejected = problemPose("call_bad", "A different student…");
		(rejected[1]! as unknown as { isError: boolean }).isError = true;
		const messages = [...rejected, ...concludeCall("solved")];
		assert.equal(modelSolutionForConclude(messages, "call_conclude_solved"), undefined);
	});

	it("the newest pose before ITS conclude wins (multi-problem records)", () => {
		const messages = [
			...problemPose("call_p1", "first"),
			...concludeCall("solved"),
			...problemPose("call_p2", "second"),
			...concludeCall("movedOn"),
		];
		assert.equal(modelSolutionForConclude(messages, "call_conclude_movedOn"), "second");
		assert.equal(modelSolutionForConclude(messages, "call_conclude_solved"), "first");
	});

	it("projectView enriches the conclude part with the reveal", () => {
		const messages = [...problemPose(), ...concludeCall("solved")];
		const view = projectView(messages);
		const conclude = view.flatMap((m) => m.parts).find((p) => p.type === "tool-conclude");
		assert.ok(conclude, "the conclude part projects");
		assert.equal(conclude!.reveal, "Show that…", "the view-seam join carries the committed solution");
		// THE FULL POSE FOLD (owner round 17): the whole problem-call input
		// rides the conclude part — the observability drawer's data.
		assert.deepEqual(conclude!.problemInput, {
			statement: "Show that…",
			mode: "recall",
			modelSolution: "Show that…",
		}, "mode + statement + the commitment; no targets posed here");
	});
});

// ── the transcript face of the signal ───────────────────────────────────────

describe("projectView renders the move-on signal", () => {
	it("the practice-next marker projects the compact part (the centered NEXT PROBLEM line)", () => {
		const view = projectView([newNextMessage()]);
		const parts = view[0]?.parts ?? [];
		assert.ok(
			parts.some((p) => p.type === "data-practice-next"),
			"the data-practice-next part rides the view",
		);
	});
});
