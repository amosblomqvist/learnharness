"use client";
/**
 * THE UI LANGUAGE — app/layout.tsx reads `general.language` on the server and
 * hands it down as a prop, so the server render and hydration agree on the
 * first frame. Components translate with `const t = useT(); t("Save")`.
 * Outside a provider (tests, isolated renders) the language is English.
 */
import { createContext, useCallback, useContext } from "react";
import { DEFAULT_LOCALE, translate, type Locale, type Translate } from "@/src/core";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
	return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export const useLocale = (): Locale => useContext(LocaleContext);

export function useT(): Translate {
	const locale = useLocale();
	return useCallback<Translate>((text, vars) => translate(locale, text, vars), [locale]);
}
