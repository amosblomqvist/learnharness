/**
 * Locale registry — the one place that knows which UI languages exist and
 * which direction each runs. The active locale lives in a cookie so the
 * server-rendered <html lang dir> matches the first paint (no LTR flash).
 */
export const LOCALES = ["en", "fa"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "lh-locale";

export const LOCALE_META: Record<Locale, { dir: "ltr" | "rtl"; nativeName: string }> = {
	en: { dir: "ltr", nativeName: "English" },
	fa: { dir: "rtl", nativeName: "فارسی" },
};

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
	return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function dirOf(locale: Locale): "ltr" | "rtl" {
	return LOCALE_META[locale].dir;
}
