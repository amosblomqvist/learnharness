import { uiLanguage } from "../core/i18n.ts";

/** Output-language rules, present only when the interface language is Chinese;
 *  in English the prompts are upstream's (the model follows the learner). */
export const OUTPUT_LANGUAGE_RULE =
	"LANGUAGE: write all learner-facing text (names, statements, labels, captions, UI text) in Simplified Chinese (简体中文), unless the source material is clearly meant for another language. Keep code, identifiers, formulas, and proper names in their original form. Tool names and field names never change.";

/** Conversational agents (prober, teacher, practice, side chat). */
export const VOICE_LANGUAGE_RULE = `## Language

Write everything the learner reads — prose, questions, options, plans, titles, hints, figure labels — in Simplified Chinese (简体中文), unless the learner clearly writes in another language; then follow theirs. Keep code, identifiers, formulas, and proper names in their original form; when a standard English term helps, give it in parentheses on first use. Tool names, field names, and other structural values never change.`;

/** Append `rule` to a system prompt when the interface language is Chinese. */
export function withOutputLanguage(prompt: string, rule: string = OUTPUT_LANGUAGE_RULE): string {
	return uiLanguage() === "zh" ? `${prompt}\n\n${rule}` : prompt;
}
