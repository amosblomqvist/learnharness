/**
 * Response language preference & runtime prompt directives (update-safe seam).
 * Pure, browser-safe module shared by settings validation, UI, and runtime
 * prompt injection across teaching agents, side-chat, extraction, subagents,
 * and plugins.
 */

export interface AgentLanguageOption {
	readonly code: string;
	readonly label: string;
	readonly promptName?: string;
}

export const AGENT_LANGUAGES: readonly AgentLanguageOption[] = [
	{ code: "auto", label: "Auto (match learner)" },
	{ code: "hu", label: "Magyar (Hungarian)", promptName: "Hungarian (Magyar)" },
	{ code: "en", label: "English", promptName: "English" },
	{ code: "de", label: "Deutsch (German)", promptName: "German (Deutsch)" },
	{ code: "fr", label: "Français (French)", promptName: "French (Français)" },
	{ code: "es", label: "Español (Spanish)", promptName: "Spanish (Español)" },
	{ code: "it", label: "Italiano (Italian)", promptName: "Italiano (Italian)" },
	{ code: "pl", label: "Polski (Polish)", promptName: "Polish (Polski)" },
	{ code: "pt", label: "Português (Portuguese)", promptName: "Portuguese (Português)" },
	{ code: "ja", label: "日本語 (Japanese)", promptName: "Japanese (日本語)" },
	{ code: "ko", label: "한국어 (Korean)", promptName: "Korean (한국어)" },
	{ code: "zh", label: "中文 (Chinese)", promptName: "Chinese (中文)" },
] as const;

const KNOWN_BY_LOWER = new Map<string, AgentLanguageOption>(
	AGENT_LANGUAGES.map((entry) => [entry.code.toLowerCase(), entry]),
);

const CONTROL_CHARS = /[\x00-\x1f\x7f\u2028\u2029]/;

/** Normalize a raw response-language value against the strict AGENT_LANGUAGES
 *  whitelist. Returns undefined for "auto", empty strings, or any unlisted /
 *  malformed input so raw user text can never enter system prompts. */
export function normalizeAgentLanguage(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed || CONTROL_CHARS.test(trimmed)) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "auto") return undefined;
	const entry = KNOWN_BY_LOWER.get(lower);
	return entry?.promptName ? entry.code : undefined;
}

/** Strict check for write-side validation: accepts undefined, null, "",
 *  "auto", or a whitelisted AGENT_LANGUAGES code. */
export function isValidAgentLanguageInput(raw: unknown): boolean {
	if (raw === undefined || raw === null) return true;
	if (typeof raw !== "string") return false;
	const trimmed = raw.trim();
	if (!trimmed) return true;
	if (CONTROL_CHARS.test(trimmed)) return false;
	const lower = trimmed.toLowerCase();
	return lower === "auto" || KNOWN_BY_LOWER.has(lower);
}

export function agentLanguageDisplayName(language: string): string | undefined {
	return KNOWN_BY_LOWER.get(language.toLowerCase())?.promptName;
}

export type LanguageDirectiveScope = "conversation" | "extraction" | "subagent" | "plugin";

/** Build a compact, scope-tailored output-language block when a whitelisted
 *  language is configured, or null for Auto/unset/unlisted (leaving default
 *  prompts byte-identical and never interpolating raw user text). */
export function formatLanguageDirective(
	language: string | undefined,
	scope: LanguageDirectiveScope,
): string | null {
	const normalized = normalizeAgentLanguage(language);
	const name = normalized ? KNOWN_BY_LOWER.get(normalized)?.promptName : undefined;
	if (!name) return null;
	switch (scope) {
		case "conversation":
			return (
				`## Output language\n\n` +
				`Write every learner-facing reply, question, multiple-choice option, learning-plan node title, feedback, summary, and internal subagent brief in **${name}** — even when attached PDFs, source documents, tool results, or internal instructions are in English. Keep standard scientific/technical terms, mathematical formulas, code identifiers, and ASCII plan slugs intact.`
			);
		case "extraction":
			return (
				`## Output language\n\n` +
				`Write every new or updated knowledge-graph node's \`name\`, \`statement\`, and \`aliases\` in **${name}** — even when the source material, session transcript, or imported PDF/notes are in English. Preserve established English or Latin technical/scientific terms where helpful (e.g. in parentheses or as aliases) and keep formulas and identifiers intact.`
			);
		case "subagent":
			return (
				`## Output language\n\n` +
				`Write all learner-visible diagram labels, UI control labels, legends, readouts, and summaries in **${name}**, keeping standard scientific/technical terms, formulas, and code identifiers intact.`
			);
		case "plugin":
			return (
				`## Output language\n\n` +
				`Write all generated flashcards (questions, answers, hints, explanations) and other learner-visible outputs in **${name}**, keeping standard scientific/technical terms, formulas, and code identifiers intact.`
			);
	}
}

/** Append the scope's language directive when an explicit language is set.
 *  Returns `instructions` untouched when language is Auto/unset. */
export function appendLanguageDirective(
	instructions: string,
	language: string | undefined,
	scope: LanguageDirectiveScope,
): string {
	const directive = formatLanguageDirective(language, scope);
	if (!directive) return instructions;
	return instructions.trim().length > 0 ? `${instructions}\n\n---\n\n${directive}` : directive;
}
