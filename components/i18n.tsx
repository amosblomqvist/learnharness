"use client";

/**
 * The UI language: the root layout seeds it from the settings record (no
 * English flash), and it follows every general-section save. Components
 * read copy through useT(); with no provider mounted they get English.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_LANGUAGE, getLanguageDirection, getTextDirection, resolveSettings, translate, type AppLanguage, type TextDirection, type TranslationKey, type UserSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

export { getTextDirection };

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
		document.documentElement.dir = getLanguageDirection(language);
	}, [language]);
	return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): AppLanguage {
	return useContext(LanguageContext);
}

export function useDirection(): TextDirection {
	const language = useLanguage();
	return getLanguageDirection(language);
}

export function useTextDirection(text?: string | null): TextDirection {
	const dir = useDirection();
	return getTextDirection(text, dir);
}

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export function useT(): Translate {
	const language = useLanguage();
	return useCallback<Translate>((key, vars) => translate(language, key, vars), [language]);
}
