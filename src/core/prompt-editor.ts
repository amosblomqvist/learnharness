export const PROMPT_EDITOR_IDS = ["prober", "teacher", "practice", "proberTeacherShared", "common"] as const;

export type PromptEditorId = (typeof PROMPT_EDITOR_IDS)[number];
export type PromptRole = "prober" | "teacher" | "practice";
export type PromptEditorTexts = Record<PromptEditorId, string>;

export interface PromptEditorVersion {
	id: string;
	editor: PromptEditorId;
	text: string;
	savedAt: string;
}

export function composePrompt(role: PromptRole, editors: PromptEditorTexts): string {
	const parts = role === "practice"
		? [editors.practice, editors.common]
		: [editors[role], editors.proberTeacherShared, editors.common];
	return parts.map((part) => part.trim()).filter(Boolean).join("\n\n---\n\n");
}
