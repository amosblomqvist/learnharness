/**
 * THE APP-LANGUAGE DIRECTIVE (i18n foundation, 2026-11-19): the ONE extra
 * instruction that makes the agents teach in the app language.
 *
 * Why a directive and not translated prompt files (owner-approved scope):
 * the teaching doctrine is tuned English prose. Re-translating 22 doctrine
 * fragments risks silent behavior drift and makes every doctrine edit twice
 * the work. The doctrine stays ONE source; this directive sets the language
 * the learner SEES. User prompt overrides still win — they compose after
 * the source fragment they replace, and a user is free to write their own.
 *
 * English needs no directive (the sources are English): the function returns
 * "" so composition is byte-identical to the pre-i18n prompts.
 */

import type { AppLanguage } from "../core/i18n.ts";

export function languageDirective(language: AppLanguage): string {
	if (language === "en") return "";
	return `# Teaching language

Write every learner-facing word in Simplified Chinese (简体中文). This covers
explanations, questions, options, hints, plans, verdicts, feedback and any
text you ask the learner to read.

Keep these verbatim, in their original language: code, LaTeX, file paths, tool
names and tool arguments, model and provider names, and quoted source material
(a quotation you are analyzing is evidence, not your prose). Introduce a
Chinese term on first use when the source is English, for example
"spacing effect（间隔效应）", and then keep using one consistent term.

The learner may write in another language. Keep answering in Chinese unless
they explicitly ask for a different language.
`;
}
