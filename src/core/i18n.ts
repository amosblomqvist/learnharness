/**
 * APP LANGUAGES (i18n foundation, 2026-11-19): the one list of languages the
 * shell can render in, plus the translation seam every component calls.
 *
 * WHY THIS SHAPE (owner-approved plan, aligned with the community foundation
 * in PR #156 / PR #457 and the proposal in issue #407): the app is a single
 * client tree whose strings were inlined into JSX. The cheapest reviewable
 * migration is therefore a DICTIONARY keyed by the ENGLISH SOURCE STRING —
 * components wrap a literal in `t("…")`, the dictionary maps that literal to
 * the target language, and a missing entry falls back to English. No key
 * naming decisions, no runtime URL routing, no new dependency: the locale
 * comes from the settings record like every other preference.
 *
 * The registry is the ONE source of truth for the language list: the settings
 * sanitizer/parser, the <html lang> attribute, the Settings picker and the
 * agent prompt locale directive all read it.
 *
 * BROWSER-SAFE: pure data + functions, no node imports (core barrel law).
 */

import { ZH_CN } from "./i18n/zh-CN/index.ts";

/** Every language the shell ships. `label` is written IN that language — a
 *  language picker must be readable by someone who does not read the current
 *  UI language yet. */
export const APP_LANGUAGES = [
	{ id: "en", label: "English", htmlLang: "en" },
	{ id: "zh-CN", label: "简体中文", htmlLang: "zh-CN" },
] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number]["id"];

/** English is the source language of every literal in the app. */
export const DEFAULT_APP_LANGUAGE: AppLanguage = "en";

/** Dictionary type: English source string → translated string. */
export type Dictionary = Readonly<Record<string, string>>;

/** The dictionaries actually shipped, by language. English needs none (the
 *  source literals ARE English). */
export const DICTIONARIES: Readonly<Partial<Record<AppLanguage, Dictionary>>> = {
	"zh-CN": ZH_CN,
};

export function isAppLanguage(value: unknown): value is AppLanguage {
	return typeof value === "string" && APP_LANGUAGES.some((language) => language.id === value);
}

/** Tolerant read-side resolution (settings sanitizer, disk records, a browser
 *  locale probe): `zh`, `zh-CN`, `zh-cn`, `zh-Hans` and `zh-Hans-CN` all mean
 *  Simplified Chinese; anything unknown resolves to English, never throws. */
export function resolveAppLanguage(value: unknown): AppLanguage {
	if (typeof value !== "string") return DEFAULT_APP_LANGUAGE;
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	if (!normalized) return DEFAULT_APP_LANGUAGE;
	if (normalized === "en" || normalized.startsWith("en-")) return "en";
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
	return DEFAULT_APP_LANGUAGE;
}

/** True when a value names a language this build understands (registered id
 *  or a BCP 47 tag whose primary subtag we ship). The settings sanitizer uses
 *  it to DROP junk instead of silently pinning English over a typo. */
export function isKnownLanguageTag(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	if (!normalized) return false;
	return APP_LANGUAGES.some(
		(language) => normalized === language.id.toLowerCase() || normalized.split("-")[0] === language.id.toLowerCase().split("-")[0],
	);
}

/** The BCP 47 tag for <html lang> — the registry's value, so a new language
 *  cannot forget it. */
export function htmlLangFor(language: AppLanguage): string {
	return APP_LANGUAGES.find((entry) => entry.id === language)?.htmlLang ?? "en";
}

/** The language's own label (the picker's option text). */
export function languageLabel(language: AppLanguage): string {
	return APP_LANGUAGES.find((entry) => entry.id === language)?.label ?? "English";
}

/** Template variables for one translated string. Placeholders are written
 *  `{name}` in BOTH the English source and the translation; an unknown
 *  placeholder is left verbatim (never "undefined"). */
export type TranslateVars = Readonly<Record<string, string | number>>;

/** Fill `{name}` placeholders. Missing values keep the placeholder literal —
 *  a visible `{count}` in a screenshot beats a silent "undefined". */
export function interpolate(template: string, vars?: TranslateVars): string {
	if (!vars) return template;
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) =>
		Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
	);
}

/** THE translation seam: English in, the current language out. A missing or
 *  empty entry falls back to the English source (interpolated), so a
 *  translation that lags behind the source can never break a screen. */
export function translate(language: AppLanguage, text: string, vars?: TranslateVars): string {
	if (language === DEFAULT_APP_LANGUAGE) return interpolate(text, vars);
	const entry = DICTIONARIES[language]?.[text];
	return interpolate(entry && entry.trim() ? entry : text, vars);
}

/** Two-way helper for label pairs authored as data (a menu's rows, a fixed
 *  list): returns the localized value when the language is not English. */
export function pickLocalized<T>(language: AppLanguage, english: T, localized: T): T {
	return language === DEFAULT_APP_LANGUAGE ? english : localized;
}
