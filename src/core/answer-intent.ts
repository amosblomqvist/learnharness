/**
 * Spoken picks: a learner who dictates "I think it's the second one" and
 * submits without clicking still answers. The cheap model reads the
 * thinking against the visible options; the client then grades the pick
 * exactly like a click. The correct answer never leaves the client.
 */

export interface AnswerIntentRequest {
	question: string;
	mode: "single-select" | "multi-select";
	/** Option labels in display order; the model answers with 1-based numbers. */
	options: string[];
	/** Quizzes offer "I don't know"; asks do not. */
	allowDontKnow: boolean;
	thinking: string;
}

export type AnswerIntent = { indices: number[] } | { dontKnow: true } | { unclear: true };

const MAX_TEXT = 20_000;
const MAX_OPTIONS = 26;

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${field} must be a non-empty string`);
	return value;
}

export function parseAnswerIntentRequest(body: unknown): AnswerIntentRequest {
	if (!body || typeof body !== "object") throw new Error("Expected a JSON object");
	const item = body as Record<string, unknown>;
	if (item.mode !== "single-select" && item.mode !== "multi-select") throw new Error("mode must be single-select or multi-select");
	if (!Array.isArray(item.options) || item.options.length === 0 || item.options.length > MAX_OPTIONS) throw new Error("options must be a non-empty list");
	return {
		question: text(item.question, "question"),
		mode: item.mode,
		options: item.options.map((option, i) => text(option, `options[${i}]`)),
		allowDontKnow: item.allowDontKnow === true,
		thinking: text(item.thinking, "thinking"),
	};
}

export function answerIntentPrompt(req: AnswerIntentRequest): { system: string; user: string } {
	const choices = req.mode === "single-select" ? "exactly one option number" : "one or more option numbers";
	const outputs = [
		`{"choice": [n, ...]} with ${choices}`,
		...(req.allowDontKnow ? [`{"choice": "dont_know"} when they say they don't know`] : []),
		`{"choice": "unclear"} when they do not commit to an answer`,
	];
	return {
		system: [
			"A learner answered a multiple-choice question by thinking out loud instead of clicking an option.",
			"The text is transcribed speech, so expect recognition noise.",
			"Decide which option(s) the learner finally committed to. Judge their final stated answer, not which option is correct.",
			"Letters map to numbers (A = 1, B = 2, ...). Paraphrases of an option's wording count.",
			`Reply with JSON only, one of: ${outputs.join("; ")}.`,
		].join("\n"),
		user: [
			`Question: ${req.question}`,
			"Options:",
			...req.options.map((label, i) => `${i + 1}. ${label}`),
			"",
			"Learner's thinking:",
			req.thinking,
		].join("\n"),
	};
}

/** Strict reading of the model reply: anything off-contract is "unclear". */
export function parseAnswerIntent(reply: string, req: AnswerIntentRequest): AnswerIntent {
	const json = reply.match(/\{[\s\S]*\}/)?.[0];
	if (!json) return { unclear: true };
	let choice: unknown;
	try {
		choice = (JSON.parse(json) as { choice?: unknown }).choice;
	} catch {
		return { unclear: true };
	}
	if (choice === "dont_know" && req.allowDontKnow) return { dontKnow: true };
	if (!Array.isArray(choice)) return { unclear: true };
	if (choice.length === 0 || !choice.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= req.options.length)) return { unclear: true };
	const indices = [...new Set(choice as number[])].sort((a, b) => a - b);
	if (req.mode === "single-select" && indices.length !== 1) return { unclear: true };
	return { indices };
}
