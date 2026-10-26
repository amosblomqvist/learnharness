"use client";

/**
 * The UI language: the root layout seeds it from the settings record (no
 * English flash), and it follows every general-section save. Components
 * read copy through useT(); with no provider mounted they get English.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_LANGUAGE, resolveSettings, translate, type AppLanguage, type TranslationKey, type UserSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

const LanguageContext = createContext<AppLanguage>(DEFAULT_LANGUAGE);

export function I18nProvider({ initialLanguage, children }: { initialLanguage: AppLanguage; children: React.ReactNode }) {
	const [language, setLanguage] = useState<AppLanguage>(initialLanguage);
	useSettingsSaved((section) => {
		if (section !== "general") return;
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: UserSettings | null }>)
			.then((body) => setLanguage(resolveSettings(body.settings ?? null).general.language))
			.catch(() => {});
	});
	useEffect(() => {
		document.documentElement.lang = language;
	}, [language]);
	return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): AppLanguage {
	return useContext(LanguageContext);
}

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export function useT(): Translate {
	const language = useLanguage();
	return useCallback<Translate>((key, vars) => translate(language, key, vars), [language]);
}
