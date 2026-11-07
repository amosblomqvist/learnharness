/**
 * Language identity for the on-device dictation catalog.
 * Ported from pi-voice src/languages.ts (MIT, Copyright (c) 2026 Earendil Works
 * contributors): https://github.com/earendil-works/pi-voice
 */

/** A base code, without changing the identity or the model's exact code. */
export function canonicalLanguage(language: string): string {
	return language.trim().toLowerCase().split("-", 1)[0] ?? "";
}

// Model cards, benchmarks and the language detector use different ISO codes for
// these languages (iw/jw are legacy codes for Hebrew and Javanese). This identity
// is for matching, never a code to send directly to a backend.
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { tl: "fil", no: "nb", iw: "he", jw: "jv" };

export function languageIdentity(language: string): string {
	const base = canonicalLanguage(language);
	return LANGUAGE_ALIASES[base] ?? base;
}

/** A model's exact code for `language`, preserving an explicitly chosen regional variant. */
export function resolveModelLanguage(
	model: { readonly languages: readonly string[] },
	language: string,
): string | undefined {
	const exact = model.languages.find((code) => code.toLowerCase() === language.trim().toLowerCase());
	return exact ?? model.languages.find((code) => languageIdentity(code) === languageIdentity(language));
}
