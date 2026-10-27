/**
 * UI LANGUAGES — English is the source language. Every UI string is written
 * in English at its call site (`t("New session")`) and doubles as the key
 * into the other languages' dictionaries, so a missing translation falls
 * back to readable English instead of a key name, and English renders
 * exactly as before. Server/agent text stays English; the UI translates it
 * at display time when the dictionary knows the exact string.
 */
import { ES } from "./es/index.ts";

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Each language's own name, for the language picker. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: "English", es: "Español" };

export const isLocale = (value: unknown): value is Locale =>
	typeof value === "string" && (LOCALES as readonly string[]).includes(value);

const DICTIONARIES: Readonly<Record<Exclude<Locale, "en">, Readonly<Record<string, string>>>> = { es: ES };

export type TranslationVars = Readonly<Record<string, string | number>>;
export type Translate = (text: string, vars?: TranslationVars) => string;

/** Translate an English UI string; `{name}` placeholders are filled from vars. */
export function translate(locale: Locale, text: string, vars?: TranslationVars): string {
	const out = locale === "en" ? text : (DICTIONARIES[locale][text] ?? text);
	if (!vars) return out;
	return out.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}
