/**
 * THE WHITEHEAD INCIDENT PINS (owner, 2026-10-09): glm-5.3 (z-ai via
 * OpenRouter) emitted two argument-wobble shapes in one real session —
 * quiz `type: "\"predict\""` (the literal with quotes baked in; the
 * schema's own description displayed the values quoted+colon) rejected
 * TEN times with byte-identical retries while the lesson never started,
 * and `correctAnswer: [":parmenides"]` (the option value with the JSON
 * key-value colon glued on) rejected four times.
 *
 * The fixes these pins hold:
 *  1. THE STANDARD HEAL EVERYWHERE — healToolRecord wraps every registry
 *     (bareQuestionTools carried NO prepareArguments at all), and the
 *     quote-encoded literal heals before TypeBox validation.
 *  2. THE DEBRIS STRIP AT MEMBERSHIP SEAMS — stripModelValueDebris in
 *     coerceCorrectAnswer (boundary check + grading), normalizeQuizType,
 *     and resolveTargetId.
 *  3. THE DISPLAY MIRROR — the record keeps RAW arguments, so
 *     parseQuizInput heals the same wobble on read (the tool-parts law:
 *     a healed-at-boundary quiz whose display parse rejects is an
 *     invisible pending quiz and a learner lockout).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { healEncodedArguments } from "../src/core/argument-heal.ts";
import { stripModelValueDebris } from "../src/core/value-debris.ts";
import {
	coerceCorrectAnswer,
	normalizeQuizType,
	quizInputObject,
	quizInputProblems,
} from "../src/core/question-core.ts";
import { parseQuizInput } from "../src/core/tool-parts.ts";
import { resolveTargetId } from "../src/core/chains.ts";
import { bareQuestionTools } from "../src/agent/teacher-agent.ts";
import { probeQuizTool } from "../src/agent/tools.ts";

/** The incident's exact encoding: the value wrapped in literal quotes. */
function QUOTED(value: string): string {
	return `"${value}"`;
}

// A complete, well-formed teach-quiz input — the incident's call with
// every field valid BUT the wobbled one.
function whiteheadQuiz(type: unknown, correctAnswer: unknown) {
	return {
		question: "What was Parmenides' claim?",
		options: [
			{ label: "Being is changeless and complete", value: "parmenides" },
			{ label: "Becoming is fundamental", value: "heraclitus" },
			{ label: "Split world", value: "split" },
			{ label: "Both unreal", value: "both-illusion" },
		],
		explanation: "What truly *is* cannot come to be or pass away — the flux is appearance.",
		correctAnswer,
		type,
		nodeId: "experience-first",
	};
}

describe("the death-loop shape — quiz type with quotes baked in", () => {
	it("heals the quote-encoded literal (the ten-retry loop)", () => {
		const healed = healEncodedArguments({ type: QUOTED("predict") }, quizInputObject) as {
			type: unknown;
		};
		assert.equal(healed.type, "predict");
	});

	it("END-TO-END: the healed args pass pi-ai validation where the raw threw", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), ["parmenides"]);
		assert.throws(() => {
			validateToolArguments({ name: "quiz", parameters: quizInputObject } as never, {
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: raw,
			} as never);
		});
		const validated = validateToolArguments(
			{ name: "quiz", parameters: quizInputObject } as never,
			{
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: healEncodedArguments(raw, quizInputObject),
			} as never,
		);
		assert.equal((validated as { type: unknown }).type, "predict");
	});

	it("WIRING: bareQuestionTools (the registry with NO prepareArguments) now heals", () => {
		const tools = bareQuestionTools();
		const quiz = tools.quiz;
		assert.ok(quiz, "the bare quiz must exist");
		assert.ok(quiz.prepareArguments, "the bare quiz must carry the standard heal");
		const healed = quiz.prepareArguments!(
			whiteheadQuiz(QUOTED("predict"), ["parmenides"]),
		) as { type: unknown };
		assert.equal(healed.type, "predict");
	});

	it("WIRING: the 2026-09-26 string-options shape heals through the bare quiz too", () => {
		// The universal heal covers the ORIGINAL incident's shape as well:
		// options serialized as a JSON string (then healed only on the
		// plan-tree quiz path; the bare registries had nothing).
		const quiz = bareQuestionTools().quiz;
		assert.ok(quiz?.prepareArguments, "the bare quiz must carry the standard heal");
		const input = whiteheadQuiz("predict", ["parmenides"]);
		const stringified = { ...input, options: JSON.stringify(input.options) };
		const healed = quiz.prepareArguments!(stringified) as { options: unknown };
		assert.ok(Array.isArray(healed.options), "the JSON string heals to the array");
		assert.equal(
				(healed.options as Array<{ value?: string }>)[0]?.value,
			"parmenides",
		);
	});
});

describe("the colon shape — correctAnswer with copy-syntax debris", () => {
	it("stripModelValueDebris: the observed shapes heal, interiors stay", () => {
		assert.equal(stripModelValueDebris(":parmenides"), "parmenides");
		assert.equal(stripModelValueDebris(QUOTED("predict")), "predict");
		assert.equal(stripModelValueDebris(`: "primary-external" `), "primary-external");
		assert.equal(stripModelValueDebris("`value`"), "value");
		assert.equal(stripModelValueDebris("a:b"), "a:b"); // interior colon is content
		assert.equal(stripModelValueDebris('["x"]'), '["x"]'); // interior quotes are content (JSON-array strings)
	});

	it("coerceCorrectAnswer cleans non-matching entries (boundary check + grading seam)", () => {
		assert.deepEqual(coerceCorrectAnswer([":parmenides"], ["parmenides"]), ["parmenides"]);
		assert.deepEqual(coerceCorrectAnswer(QUOTED("primary-external"), ["primary-external"]), ["primary-external"]);
	});

	it("the incident's exact call passes the semantic boundary (quizInputProblems)", () => {
		const input = whiteheadQuiz("predict", [":parmenides"]) as Parameters<
			typeof quizInputProblems
		>[0];
		assert.deepEqual(quizInputProblems(input), []);
	});

	it("normalizeQuizType heals a persisted wobbled record", () => {
		assert.equal(normalizeQuizType(QUOTED("predict")), "predict");
		assert.equal(normalizeQuizType('"check"'), "check");
		assert.equal(normalizeQuizType(undefined), undefined);
		assert.equal(normalizeQuizType("bogus"), undefined);
	});

	it("resolveTargetId heals copy-syntax on targets", () => {
		const nodes = [{ id: "experience-first", name: "Experience first" }];
		assert.equal(resolveTargetId(":experience-first", nodes), "experience-first");
		assert.equal(resolveTargetId('"Experience first"', nodes), "experience-first");
		assert.equal(resolveTargetId("nope", nodes), null);
	});
});

describe("the calculus retry loop — an exact answer was incorrectly stripped", () => {
	it("the real probe tool accepts a label with its sentence-final period", async () => {
		const input = {
			question: "Which claim?",
			options: [{ label: "The claim holds." }, { label: "The claim need not hold." }],
			explanation: "The premise does not imply the claim.",
			correctAnswer: "The claim need not hold.",
		};
		const validated = validateToolArguments(probeQuizTool, {
			type: "toolCall",
			id: "calculus-period",
			name: "probe",
			arguments: probeQuizTool.prepareArguments!(input),
		});
		assert.equal(validated.correctAnswer, input.correctAnswer);
		const result = await probeQuizTool.execute("calculus-period", validated);
		assert.notEqual(result.isError, true, "an already-exact answer must not trigger a retry");
		assert.equal(result.terminate, true, "the valid question is posed normally");
	});
});

describe("the display mirror — raw records heal on read", () => {
	it("parseQuizInput renders the incident's persisted raw record (no invisible quiz)", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), [":parmenides"]);
		const parsed = parseQuizInput(raw);
		assert.ok(parsed, "the wobbled record must parse — else the quiz is invisible");
		// The display schema's type is DELIBERATELY a lenient string (old
		// and probe records carry none); the read seam is normalizeQuizType —
		// which strips the recorded wobble to the intended role.
		assert.equal(normalizeQuizType(parsed?.type), "predict");
		// The graded answer resolves to the option despite the recorded colon.
		assert.deepEqual(parsed ? coerceCorrectAnswer(parsed.correctAnswer, parsed.options.map((o) => o.value ?? o.label)) : [], ["parmenides"]);
	});
});
