import type { QuestionDraft } from "@/src/core";

export function serializeQuestionDraft(draft: QuestionDraft): string {
	return JSON.stringify(draft, (_key, value) => value instanceof Set ? [...value] : value);
}

/** Restore only the form for the same pending question. Invalid state is ignored. */
export function restoreQuestionDraft(saved: { questionId: string; text: string } | null | undefined, pendingKey: string | undefined): QuestionDraft | undefined {
	if (!saved || saved.questionId !== pendingKey) return;
	try {
		const draft = JSON.parse(saved.text) as QuestionDraft;
		if (!draft || typeof draft !== "object" || Array.isArray(draft)) return;
		if (draft.readingThinking !== undefined && typeof draft.readingThinking !== "string") return;
		if (draft.form) {
			const form = draft.form;
			if (!form.selection || !Array.isArray(form.selection.selected) || !form.selection.selected.every((index: unknown) => Number.isInteger(index) && Number(index) >= 0)) return;
			if (typeof form.selection.otherSelected !== "boolean" || typeof form.selection.dontKnow !== "boolean") return;
			if (![form.thinking, form.other, form.text].every(value => typeof value === "string")) return;
			if (!Number.isInteger(form.confidenceIndex) || form.confidenceIndex < 0 || form.confidenceIndex > 5) return;
			form.selection.selected = new Set(form.selection.selected);
		}
		return draft;
	} catch { return; }
}
