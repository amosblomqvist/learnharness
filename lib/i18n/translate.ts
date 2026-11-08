import type { Locale } from "./locales.ts";
import { en, type MessageKey } from "./messages/en.ts";
import { fa } from "./messages/fa.ts";
import { faLiterals } from "./messages/fa-literals.ts";

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, fa };

export type MessageVars = Record<string, string | number>;

/** Pure translate: catalog lookup (falls back to English), then {name}
 *  interpolation. Exported for tests and for non-React callers. */
export function translate(locale: Locale, key: MessageKey, vars?: MessageVars): string {
	const raw = CATALOGS[locale][key] ?? en[key];
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

const NUMBER_FORMATS: Partial<Record<Locale, string>> = { fa: "fa-IR" };

/** Locale-aware number formatting (Persian digits for fa). */
export function formatNumber(locale: Locale, n: number, opts?: Intl.NumberFormatOptions): string {
	// English keeps the app's historical plain digits ("1234", no grouping).
	if (locale === "en" && !opts) return String(n);
	return new Intl.NumberFormat(NUMBER_FORMATS[locale] ?? "en-US", opts).format(n);
}

const interpolate = (raw: string, vars?: MessageVars) =>
	vars ? raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : raw;

/** Literal-keyed translation for the long tail of one-off UI strings: the
 *  English text IS the key (`tl("Cancel")`), looked up in fa-literals.ts and
 *  falling back to the English text itself. `{slot}` interpolation works in
 *  both languages. Core, reusable strings use the typed catalog (`t`). */
export function translateLiteral(locale: Locale, english: string, vars?: MessageVars): string {
	const raw = locale === "en" ? english : (faLiterals[english] ?? english);
	return interpolate(raw, vars);
}
