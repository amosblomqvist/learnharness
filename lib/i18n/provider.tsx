"use client";
/**
 * Locale context. The server layout reads the cookie and passes the initial
 * locale, so SSR markup, <html lang dir>, and the first client render agree.
 * `setLocale` writes the cookie, flips <html lang dir> immediately, and
 * re-renders every consumer — no navigation or reload needed.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, dirOf, type Locale } from "./locales.ts";
import type { MessageKey } from "./messages/en.ts";
import { formatNumber, translate, type MessageVars } from "./translate.ts";

export type TFunction = (key: MessageKey, vars?: MessageVars) => string;

interface LocaleContextValue {
	locale: Locale;
	dir: "ltr" | "rtl";
	t: TFunction;
	setLocale: (next: Locale) => void;
	formatNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
	locale: DEFAULT_LOCALE,
	dir: "ltr",
	t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
	setLocale: () => {},
	formatNumber: (n, opts) => formatNumber(DEFAULT_LOCALE, n, opts),
});

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(initialLocale);

	const setLocale = useCallback((next: Locale) => {
		setLocaleState(next);
		try {
			document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
		} catch {
			// cookies unavailable: the choice still applies for this session
		}
		const root = document.documentElement;
		root.lang = next;
		root.dir = dirOf(next);
	}, []);

	const value = useMemo<LocaleContextValue>(
		() => ({
			locale,
			dir: dirOf(locale),
			t: (key, vars) => translate(locale, key, vars),
			setLocale,
			formatNumber: (n, opts) => formatNumber(locale, n, opts),
		}),
		[locale, setLocale],
	);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
	return useContext(LocaleContext);
}

/** The translate function alone — most components only need this. */
export function useT(): TFunction {
	return useContext(LocaleContext).t;
}
