/**
 * THE APP LANGUAGE REGISTRY — the one list of languages the app speaks.
 * Adding a language: one entry here, one UI dictionary (i18n/<id>/, one
 * file per surface, typed as Dictionary so missing keys fail typecheck),
 * one mirrored tree of translated prompt segments
 * (src/agent/prompts/locales/<id>/), one worker prompt file
 * (src/agent/subagents/locales/<id>.ts, registered in worker-prompts.ts)
 * and an <id> entry in each
 * Localized<T> map (compaction prompts). Anything not yet translated
 * falls back to English, the source of truth.
 *
 * Browser-safe: pure data + logic, no node imports.
 */

import { en, type Dictionary, type TranslationKey } from "./i18n/en/index.ts";
import { es } from "./i18n/es/index.ts";
import type { DictationLanguage, ResolvedGeneralSettings } from "./settings.ts";

export type { Dictionary, TranslationKey };

export const APP_LANGUAGES = [
	{ id: "en", label: "English", dictation: "en" },
	{ id: "es", label: "Español", dictation: "es" },
] as const satisfies readonly { id: string; label: string; dictation: DictationLanguage }[];

export type AppLanguage = (typeof APP_LANGUAGES)[number]["id"];

export const DEFAULT_LANGUAGE: AppLanguage = "en";

export function isAppLanguage(value: unknown): value is AppLanguage {
	return APP_LANGUAGES.some((lang) => lang.id === value);
}

/** Per-language variants of one text; English is required, the rest fall back to it. */
export type Localized<T> = { en: T } & Partial<Record<AppLanguage, T>>;

export function pickLocalized<T>(map: Localized<T>, language: AppLanguage = DEFAULT_LANGUAGE): T {
	return map[language] ?? map.en;
}

/** Every registered language's UI dictionary (adding a language to
 *  APP_LANGUAGES makes this fail typecheck until its dictionary exists). */
export const DICTIONARIES: Record<AppLanguage, Dictionary> = { en, es };

/** The UI copy for `key` in `language`, with `{name}` placeholders filled from `vars`. */
export function translate(language: AppLanguage, key: TranslationKey, vars?: Record<string, string | number>): string {
	const text = DICTIONARIES[language]?.[key] ?? en[key];
	if (!vars) return text;
	return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** The Deepgram `language` code dictation uses for an app language. */
export function dictationCodeFor(language: AppLanguage): DictationLanguage {
	return APP_LANGUAGES.find((lang) => lang.id === language)?.dictation ?? DEFAULT_LANGUAGE;
}

/** The language dictation streams in: the override's pick while it is on
 *  (and something is picked), otherwise the app language's code. */
export function effectiveDictationLanguage(
	general: Pick<ResolvedGeneralSettings, "language" | "dictationOverride" | "dictationLanguage">,
): DictationLanguage {
	if (general.dictationOverride && general.dictationLanguage) return general.dictationLanguage;
	return dictationCodeFor(general.language);
}
