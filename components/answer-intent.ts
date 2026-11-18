import type { AnswerIntent, AnswerRequest, QuestionData } from "@/src/core";

/** A select-mode submit with thinking but no pick: the pick comes from the thinking. */
export function needsAnswerIntent(question: QuestionData, req: AnswerRequest): boolean {
	return question.mode !== "text" && !req.dontKnow && !req.values?.length && !req.other?.trim() && !!req.thinking?.trim();
}

/** Fill the pick from the Cheap model's reading (POST /api/answer-intent). */
export async function resolveAnswerIntent(question: QuestionData, req: AnswerRequest): Promise<AnswerRequest> {
	const res = await fetch("/api/answer-intent", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			// What the learner saw: details under the question, ask descriptions under options.
			question: question.context ? `${question.question}\n\n${question.context}` : question.question,
			mode: question.mode,
			options: question.options.map((option) => (question.kind !== "quiz" && option.description ? `${option.label} (${option.description})` : option.label)),
			allowDontKnow: question.kind === "quiz",
			thinking: req.thinking,
		}),
	});
	const data = (await res.json().catch(() => ({}))) as Partial<AnswerIntent> & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Picking an option failed (${res.status})`);
	if ("dontKnow" in data) return { ...req, dontKnow: true };
	if ("indices" in data && Array.isArray(data.indices)) {
		const values = data.indices.flatMap((index) => (question.options[index - 1] ? [question.options[index - 1]!.value] : []));
		if (values.length) return { ...req, values };
	}
	throw new Error("Couldn't tell which option you meant. Pick one");
}
