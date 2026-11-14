import { Type } from "typebox";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ERROR_TYPES, parseAnalysis, type MistakeAnalysis, type MistakeRecord } from "../core/mistakes.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/**
 * The short error analysis: the error-analysis skill's diagnosis, one cheap
 * model call per mistake. It never restates the key — it works out what the
 * learner's answer implies and where the reasoning broke, with the real
 * numbers, and ends in one reusable rule.
 */

const INSTRUCTIONS = `You are an error analyst inside a learning app. A learner got one item wrong (or could not answer it).
Write a SHORT diagnosis — the learner reads it right after the miss. Call submit_analysis once.

Do NOT restate the answer key. Work out what the learner's answer implies and where their reasoning broke.

1. errorType — pick exactly one:
   - knowledge-gap: did not know the fact, definition, or formula
   - confusable-pair: mixed up two similar terms, numbers, or cases
   - reversal: flipped a direction, sign, increase/decrease, cause/effect
   - setup-error: wrong formula, wrong model, wrong diagram, wrong variable
   - calculation-slip: arithmetic, units, conversion, rounding
   - misread: missed NOT / EXCEPT / LEAST, or answered a different question
   - incomplete-reasoning: right idea, missing justification or step
   - wrong-situation: right rule applied where it does not apply
   - code-logic-bug: off-by-one, wrong condition, unhandled case
   An "I don't know" is usually knowledge-gap unless their thinking shows otherwise.
2. topic — a short subject label (2-5 words) such as "static friction on a ramp".
3. whatYouDid — 1-2 sentences: what they picked or did, what that choice implies, and why that logic fails.
4. correct — 1-2 sentences: what is correct and why, using the REAL numbers and named objects from the problem (a 10 kg block on a 30 degree ramp, not "an object"). Show the wrong result next to the right one when there is one.
5. rule — one concrete, reusable "note for next time", ideally with a real example.

Style: plain and direct, no praise, no hedging, no padding. All math in LaTeX ($...$). Never invent a fact; when the answer key or the committed solution is given, rely on it. Use the learner's own thinking when present: it shows the actual reasoning that broke.`;

const submitSchema = Type.Object({
	errorType: Type.Union(ERROR_TYPES.map((t) => Type.Literal(t)) as never, { description: "Exactly one error type." }),
	topic: Type.String({ description: "A short subject label, 2-5 words." }),
	whatYouDid: Type.String({ description: "What they did and why that logic fails (1-2 sentences)." }),
	correct: Type.String({ description: "What is correct and why, with the real numbers (1-2 sentences)." }),
	rule: Type.String({ description: "One reusable note for next time." }),
});

function promptFor(r: MistakeRecord): string {
	const lines = [
		`Item type: ${r.kind === "unanswered" ? "the learner answered \"I don't know\"" : r.kind === "problem" ? "a practice problem not solved cleanly" : "a wrong answer"}`,
		`Session: ${r.sessionTitle}`,
		"",
		"Question:",
		r.question,
		"",
		`Learner's answer: ${r.yourAnswer}`,
		`Correct answer: ${r.correctAnswer}`,
	];
	if (r.explanation) lines.push("", "The original explanation of the correct answer:", r.explanation);
	if (r.thinking) lines.push("", "The learner's own thinking while answering:", r.thinking);
	if (typeof r.confidence === "number") lines.push("", `The learner's stated confidence that their pick was right: ${r.confidence}%`);
	if (r.kind === "problem") {
		lines.push("", `How it ended: ${r.yourAnswer}`);
		if (r.verdict) lines.push(`The tutor's verdict: ${r.verdict}`);
		if (r.missClass) lines.push(`The tutor's miss class: ${r.missClass}`);
	}
	return lines.join("\n");
}

export class AnalysisUnavailable extends Error {}

/** The analyst's engine: the cheap slot, read fresh; throws when none. */
export function analystEngine(): PiEngine {
	const spec = resolveRoleSpec("analyst", stores.settingsStore.readSettings());
	if (!spec) throw new AnalysisUnavailable("No model is set up for analysis (settings → models).");
	if (!providerKeyPresent(spec.provider)) throw new AnalysisUnavailable(`No API key for ${spec.provider}.`);
	return piEngineForSpec(spec);
}

export async function analyzeMistake(
	record: MistakeRecord,
	opts: { engine?: PiEngine; signal?: AbortSignal } = {},
): Promise<MistakeAnalysis> {
	const engine = opts.engine ?? analystEngine();
	return runSubmitAgent<MistakeAnalysis>({
		role: "analyst",
		toolName: "submit_analysis",
		toolDescription: "Submit the short error analysis for this item.",
		parameters: submitSchema,
		fill: (input) => parseAnalysis(input) ?? (input as MistakeAnalysis),
		validate: (value) => (parseAnalysis(value) ? null : "Fill every field: errorType (one of the listed types), topic, whatYouDid, correct, rule."),
		systemPrompt: INSTRUCTIONS,
		prompt: promptFor(record),
		engine,
		signal: opts.signal,
		onStep: () => {},
		neverSubmitted: "The analyst never submitted an analysis.",
	});
}
