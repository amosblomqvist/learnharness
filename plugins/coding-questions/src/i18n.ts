/** Host interface language: <html lang> in the page, LH_LANG in the backend. */
export function tr<T>(zh: T, en: T): T {
	const docLang = typeof document !== "undefined" ? document.documentElement?.lang : "";
	const lang = docLang || (typeof process !== "undefined" ? process.env?.LH_LANG : "") || "zh";
	return lang.toLowerCase().startsWith("en") ? en : zh;
}
