"use client";
/**
 * THE UI LANGUAGE PROVIDER (i18n foundation, 2026-11-19): one context, one
 * `t()` hook, one live switch.
 *
 * Mounted at the ROOT LAYOUT level like AppearanceProvider: the server reads
 * the settings record and seeds the provider, so the first frame is already in
 * the user's language (no English flash), and `<html lang>` matches — screen
 * readers and the browser's own line-breaking/hyphenation follow.
 *
 * NO PROVIDER = ENGLISH. Every consumer works without this context, which is
 * why the existing render tests (they mount components standalone) keep
 * passing unchanged.
 *
 * Switching language is a SETTINGS write (Settings → General → Language) plus
 * this provider's state: the whole tree re-renders through `t()`, no reload.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	DEFAULT_APP_LANGUAGE,
	htmlLangFor,
	translate,
	type AppLanguage,
	type TranslateVars,
} from "@/src/core";

/** The translate function components receive. */
export type Translate = (text: string, vars?: TranslateVars) => string;

interface I18nContextValue {
	language: AppLanguage;
	/** Live switch after a successful settings write (English is the default). */
	setLanguage: (language: AppLanguage) => void;
}

const I18nContext = createContext<I18nContextValue>({
	language: DEFAULT_APP_LANGUAGE,
	setLanguage: () => {},
});

export function I18nProvider({
	language: initialLanguage,
	children,
}: {
	/** The record's general.language, server-resolved. */
	language: AppLanguage;
	children: React.ReactNode;
}) {
	const [language, setLanguage] = useState<AppLanguage>(initialLanguage);
	// The server prop is authoritative on navigation/refresh (e.g. the settings
	// record changed in another window); local state serves the instant switch.
	useEffect(() => {
		setLanguage(initialLanguage);
	}, [initialLanguage]);
	useEffect(() => {
		document.documentElement.lang = htmlLangFor(language);
	}, [language]);
	const value = useMemo<I18nContextValue>(
		() => ({ language, setLanguage: (next) => setLanguage(next) }),
		[language],
	);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The current language (English without a provider). */
export function useLanguage(): AppLanguage {
	return useContext(I18nContext).language;
}

/** The live switcher — the Settings language picker calls this after the
 *  record write succeeds. */
export function useSetLanguage(): (language: AppLanguage) => void {
	return useContext(I18nContext).setLanguage;
}

/** THE translate hook. Returns a plain function so components can call it in
 *  render, in a memo, or pass it down without provider plumbing. */
export function useT(): Translate {
	const { language } = useContext(I18nContext);
	return useCallback<Translate>((text, vars) => translate(language, text, vars), [language]);
}
