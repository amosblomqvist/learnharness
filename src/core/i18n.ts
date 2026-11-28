/** Interface language: Simplified Chinese (default) or English.
 *  The browser reads <html lang> (server-rendered from settings); servers,
 *  plugin backends and the Electron shell read LH_LANG, which the shell and
 *  instrumentation set once per process from settings.general.language.
 *  Switching relaunches the app, so module-level strings never go stale. */
export type UiLanguage = "zh" | "en";
export const UI_LANGUAGES: readonly UiLanguage[] = ["zh", "en"];
export const isUiLanguage = (v: unknown): v is UiLanguage => v === "zh" || v === "en";

export function uiLanguage(): UiLanguage {
	const docLang = typeof document !== "undefined" ? document.documentElement?.lang : "";
	if (docLang) return docLang.toLowerCase().startsWith("en") ? "en" : "zh";
	return typeof process !== "undefined" && process.env?.LH_LANG === "en" ? "en" : "zh";
}

/** Pick the string for the interface language: tr("中文", "English"). */
export function tr<T>(zh: T, en: T): T {
	return uiLanguage() === "en" ? en : zh;
}
