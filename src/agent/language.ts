/**
 * THE OUTPUT-LANGUAGE DIRECTIVE (language wave, 2026-10-24): prompts stay
 * English (calibrated, upstream-mergeable); a short directive appended at
 * the end of a system prompt steers everything the model writes for the
 * user. "en" appends nothing — byte-identical to the pre-wave prompts.
 *
 * Chat agents get the language explicitly (AgentBuildOptions.language).
 * Sub-agents and one-shot model calls read it through a seam wired by the
 * server (src/server/stores.ts), fresh per run — the agent layer never
 * imports the settings store.
 */

import type { OutputLanguage } from "../core/settings.ts";

const DIRECTIVES: Record<OutputLanguage, string> = {
	"pt-BR": `## Language

Write everything the learner will read in Brazilian Portuguese (pt-BR): replies, questions, quiz and ask_user_question text (prompts, options, explanations), practice problems and verdicts, plans and their titles, knowledge-graph node names and descriptions, session names, diagram and demo labels, research briefs, and summaries. Use natural Brazilian wording, not literal translation. If the learner writes in another language, still answer in pt-BR unless they explicitly ask otherwise.

Keep unchanged: tool names, tool input field names and enum values, file paths, code, identifiers, LaTeX, and established technical terms that are normally left in English. When quoting source material in another language, quote it verbatim and explain it in pt-BR.`,
	en: "",
};

/** The directive block for a language ("" for English). */
export function languageDirective(language: OutputLanguage | undefined): string {
	return DIRECTIVES[language ?? "en"] ?? "";
}

/** Append the directive to a composed system prompt (no-op for English). */
export function withLanguage(prompt: string, language: OutputLanguage | undefined): string {
	const directive = languageDirective(language);
	return directive ? `${prompt}\n\n---\n\n${directive}` : prompt;
}

/** The seam: where sub-agents learn the current language. Default English
 *  (tests, bare agent layer); the server wires the settings-backed reader. */
export const languageSource: { current: () => OutputLanguage } = { current: () => "en" };

/** Sub-agent system prompt with the current language directive applied. */
export function localizedPrompt(prompt: string): string {
	return withLanguage(prompt, languageSource.current());
}
