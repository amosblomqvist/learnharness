/**
 * SCHEDULED PRACTICE — record → reviews (practiceReviewsOf): one review
 * per concluded, targeted problem, read from the saved record's clean
 * calls only. Dismissals review as "dismissed", and the synthesized
 * conclude that later follows a dismissal is the same review.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	concludedByDismissalPair,
	newProblemDismissedMarker,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { practiceReviewsOf } from "../src/core/review.ts";

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

function call(callId: string, name: string, args: JsonObject, at: number, isError = false): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		timestamp: at,
		...STAMPS,
	};
	const result: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details: null,
		isError,
		timestamp: at + 1,
	};
	return [assistant, result];
}

const pose = (callId: string, target: string[] | undefined, at = 1_000, extra: JsonObject = {}) =>
	call(callId, PRACTICE_PROBLEM_TOOL, { statement: "s", mode: "recall", modelSolution: "m", ...(target ? { target } : {}), ...extra }, at);

const conclude = (callId: string, outcome: string, rung: string | null, at = 5_000, isError = false, missClass: string | null = null) =>
	call(callId, PRACTICE_CONCLUDE_TOOL, { outcome, verdict: "v", rung, missClass, retest: false }, at, isError);

describe("practiceReviewsOf", () => {
	it("a clean conclude reviews its problem's targets at the conclude result's time", () => {
		const reviews = practiceReviewsOf("chat1", [...pose("p1", ["n_a"]), ...conclude("c1", "solvedWithHints", "R1")]);
		assert.deepEqual(reviews, [
			{
				id: "chat1:p1",
				chatId: "chat1",
				problemCallId: "p1",
				at: new Date(5_001).toISOString(),
				targets: ["n_a"],
				outcome: "solvedWithHints",
				rung: "R1",
				mode: "recall",
				missClass: null,
			},
		]);
	});

	it("records the brief's facts: mode and trimmed surface from the pose, miss class from the conclude", () => {
		const [review] = practiceReviewsOf("c", [
			...pose("p1", ["n_a"], 1_000, { mode: "composition", surface: "  ladder against a wall, find the angle  " }),
			...conclude("c1", "surrendered", "R4", 5_000, false, "discrimination"),
		]);
		assert.equal(review!.mode, "composition");
		assert.equal(review!.surface, "ladder against a wall, find the angle");
		assert.equal(review!.missClass, "discrimination");
	});

	it("unknown facts stay absent — never guessed", () => {
		const [review] = practiceReviewsOf("c", [
			...pose("p1", ["n_a"], 1_000, { mode: "drill", surface: "   " }),
			...conclude("c1", "solved", null, 5_000, false, "weird"),
		]);
		assert.equal("mode" in review!, false);
		assert.equal("surface" in review!, false);
		assert.equal("missClass" in review!, false);
	});

	it("multi-target problems carry every target; duplicates collapse", () => {
		const [review] = practiceReviewsOf("c", [...pose("p1", ["n_a", "n_b", "n_a"]), ...conclude("c1", "solved", null)]);
		assert.deepEqual(review!.targets, ["n_a", "n_b"]);
	});

	it("untagged problems are not reviews", () => {
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", undefined), ...conclude("c1", "solved", null)]), []);
	});

	it("an errored conclude never happened; a still-active problem is not a review", () => {
		assert.deepEqual(
			practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "solved", null, 5_000, true)]),
			[],
		);
		assert.deepEqual(practiceReviewsOf("c", pose("p1", ["n_a"])), []);
	});

	it("a dangling conclude (no result yet) is skipped", () => {
		const dangling = conclude("c1", "solved", null).slice(0, 1);
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...dangling]), []);
	});

	it("an errored pose never activates — the conclude attaches to the clean one", () => {
		const messages = [
			...pose("p1", ["n_a"]),
			...call("p_bad", PRACTICE_PROBLEM_TOOL, { statement: "x", mode: "recall", modelSolution: "x", target: ["n_b"] }, 2_000, true),
			...conclude("c1", "solved", null),
		];
		assert.deepEqual(practiceReviewsOf("c", messages).map((r) => r.targets), [["n_a"]]);
	});

	it("a dismissal marker reviews as dismissed (rung null); its synthesized conclude is the same review", () => {
		const marker = { ...newProblemDismissedMarker("p1"), timestamp: 3_000 };
		const pair = concludedByDismissalPair("p1") as LhMessage[];
		const alone = practiceReviewsOf("c", [...pose("p1", ["n_a"]), marker]);
		assert.equal(alone.length, 1);
		assert.equal(alone[0]!.outcome, "dismissed");
		assert.equal(alone[0]!.rung, null);
		assert.equal(alone[0]!.at, new Date(3_000).toISOString());
		assert.equal("missClass" in alone[0]!, false);
		assert.equal(alone[0]!.mode, "recall");
		const withPair = practiceReviewsOf("c", [...pose("p1", ["n_a"]), marker, ...pair]);
		assert.deepEqual(withPair, alone);
	});

	it("several problems in one record review in order, each once", () => {
		const messages = [
			...pose("p1", ["n_a"], 1_000),
			...conclude("c1", "solved", "R0", 2_000),
			...pose("p2", ["n_b"], 3_000),
			...conclude("c2", "surrendered", "R5", 4_000),
		];
		assert.deepEqual(
			practiceReviewsOf("c", messages).map((r) => [r.problemCallId, r.outcome, r.rung]),
			[["p1", "solved", "R0"], ["p2", "surrendered", "R5"]],
		);
	});

	it("an unknown outcome word is not a review; an unknown rung reads as null", () => {
		assert.deepEqual(practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "aced", null)]), []);
		const [review] = practiceReviewsOf("c", [...pose("p1", ["n_a"]), ...conclude("c1", "solved", "R9")]);
		assert.equal(review!.rung, null);
	});
});
