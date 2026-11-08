"use client";
/**
 * The interface-language switch (General section). The choice lives in a
 * cookie (lib/i18n), applies instantly to every consumer, and flips
 * <html lang dir> — so Persian turns the whole app right-to-left and
 * switches the font to Vazirmatn without a reload.
 */

import { LOCALES, LOCALE_META, isLocale } from "@/lib/i18n/locales";
import { useLocale } from "@/lib/i18n/provider";
import { SettingsRow, ThinSelect } from "./controls.tsx";

export function LanguageRow() {
	const { locale, setLocale, t } = useLocale();
	return (
		<SettingsRow label={t("language.label")} hint={t("language.hint")} testid="row-language">
			<ThinSelect
				value={locale}
				ariaLabel={t("language.label")}
				testid="select-language"
				onChange={(next) => {
					if (isLocale(next)) setLocale(next);
				}}
			>
				{LOCALES.map((l) => (
					<option key={l} value={l}>
						{LOCALE_META[l].nativeName}
					</option>
				))}
			</ThinSelect>
		</SettingsRow>
	);
}
