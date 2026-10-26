/**
 * Translated system prompts for the background workers (Workbench job
 * agents + the Library extraction stages). English stays inline in each
 * worker module (the source of truth tests pin); every other language is
 * one module under locales/ registered below. A missing language or key
 * falls back to English.
 */

import { DEFAULT_LANGUAGE, type AppLanguage } from "../../core/i18n.ts";
import { es } from "./locales/es.ts";

export type WorkerPromptKey =
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "sessionPreamble"
	| "notesPreamble"
	| "extractionCore"
	| "sessionMessageIdRule"
	| "auditor";

export type WorkerPromptTranslations = Partial<Record<WorkerPromptKey, string>>;

const TRANSLATIONS: Partial<Record<AppLanguage, WorkerPromptTranslations>> = { es };

export function workerPrompt(key: WorkerPromptKey, english: string, language: AppLanguage = DEFAULT_LANGUAGE): string {
	if (language === DEFAULT_LANGUAGE) return english;
	return TRANSLATIONS[language]?.[key] ?? english;
}
