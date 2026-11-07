/**
 * What an on-device take does about language: native detection, a fixed
 * language, or the external VoxLingua detector choosing among the preferred
 * languages. Ported from pi-voice src/language-detection-policy.ts (MIT,
 * Copyright (c) 2026 Earendil Works contributors); the audio and logging parts
 * live in src/server/local-stt/runtime.ts.
 */
import {
	LANGUAGE_DETECTION_MODEL,
	displayLanguage,
	getCatalogModel,
	languageIdentity,
	resolveModelLanguage,
} from "./local-stt-catalog.ts";

type LanguageModel = {
	readonly languages: readonly string[];
	readonly capabilities: { readonly languageDetection: boolean };
};

export type DetectPolicy = { kind: "detect"; languages: string[]; allowed: string[] };
/** What a take does about language. Auto is never `fixed`; `unsupported` hides it. */
export type AutoLanguagePolicy =
	| { kind: "native" }
	| { kind: "fixed"; language: string }
	| DetectPolicy
	| { kind: "unsupported" };

/** The Settings value that means "choose the language for me". */
export const LOCAL_AUTO_LANGUAGE = "auto";

const detectorCodes = new Map<string, string>(
	LANGUAGE_DETECTION_MODEL.languages.map((code) => [languageIdentity(code), code]),
);

/** The detector's own label (iw/jw/tl/no included), or undefined when it cannot identify the language. */
function detectorLanguageCode(language: string): string | undefined {
	return detectorCodes.get(languageIdentity(language));
}

/** Whether this ASR model needs the external detector for Auto, independent of preferences. */
export function requiresLanguageDetector(model: LanguageModel): boolean {
	return !model.capabilities.languageDetection && new Set(model.languages.map(languageIdentity)).size > 1;
}

/** Preferred languages this model supports, in preference order, one per identity. */
function compatiblePreferences(model: LanguageModel, preferred: readonly string[]): string[] {
	const byIdentity = new Map<string, string>();
	for (const preference of preferred) {
		const language = resolveModelLanguage(model, preference);
		if (language !== undefined && !byIdentity.has(languageIdentity(language))) {
			byIdentity.set(languageIdentity(language), language);
		}
	}
	return [...byIdentity.values()];
}

/** Supported preferred languages the external detector cannot identify (e.g. Irish). */
export function undetectablePreferences(model: LanguageModel, preferred: readonly string[]): string[] {
	if (!requiresLanguageDetector(model)) return [];
	return compatiblePreferences(model, preferred).filter((language) => detectorLanguageCode(language) === undefined);
}

/**
 * Resolve Auto. Without native detection, Auto exists only when at least two
 * preferred languages are supported and every one of them is detectable.
 */
export function autoLanguagePolicy(model: LanguageModel, preferred: readonly string[]): AutoLanguagePolicy {
	// Native detection retains its existing unrestricted semantics.
	if (model.capabilities.languageDetection) return { kind: "native" };

	const languages = compatiblePreferences(model, preferred);
	const allowed = languages.map(detectorLanguageCode);
	if (languages.length < 2 || allowed.includes(undefined)) return { kind: "unsupported" };
	return { kind: "detect", languages, allowed: allowed as string[] };
}

/** The policy a take runs with: an explicit language is fixed, "auto" resolves per model. */
export function localLanguagePolicy(
	modelId: string,
	language: string,
	preferredLanguages: readonly string[],
): AutoLanguagePolicy {
	if (language !== LOCAL_AUTO_LANGUAGE) return { kind: "fixed", language };
	const model = getCatalogModel(modelId);
	return model ? autoLanguagePolicy(model, preferredLanguages) : { kind: "unsupported" };
}

/** The language a model-aware default falls back to when Auto is not available. */
function defaultLanguage(model: LanguageModel, preferred: readonly string[]): string {
	if (autoLanguagePolicy(model, preferred).kind !== "unsupported") return LOCAL_AUTO_LANGUAGE;
	for (const language of preferred) {
		const code = resolveModelLanguage(model, language);
		if (code) return code;
	}
	return model.languages[0] ?? "en";
}

/**
 * Keep an exact model language when possible; otherwise choose a safe default.
 * Ported from pi-voice settings.ts (transcriptionLanguageForModel): preference
 * edits re-resolve the language, so Auto never outlives support for it.
 */
export function languageForModel(value: unknown, model: LanguageModel, preferred: readonly string[] = []): string {
	if (typeof value === "string") {
		if (value === LOCAL_AUTO_LANGUAGE && autoLanguagePolicy(model, preferred).kind !== "unsupported") return value;
		if (value !== LOCAL_AUTO_LANGUAGE) {
			const code = resolveModelLanguage(model, value);
			if (code) return code;
		}
	}
	return defaultLanguage(model, preferred);
}

// How the detector's answer is read. Seven seconds identify a language; shorter
// than half a second is not worth the detector's time.
export const DETECTION_WINDOW_SECONDS = 7;
export const DETECTION_MIN_SECONDS = 0.5;

/** The detector's ranking of one clip: the shape of transcribe-cpp's LangIdResult. */
export type LanguageIdentification = {
	candidates: readonly { code: string; p: number }[];
	code: string | null;
	allowedMass: number;
};

// Log a pick as uncertain when it is less than 1.5x as likely as the runner-up
// (with two languages: p < 0.6). The pick is used either way.
const UNSURE_RATIO = 1.5;

/** Read a detector result: the top candidate wins. A result with no usable top candidate
 * falls back to the first preferred language, with a warning. */
export function pickDetectedLanguage(
	policy: DetectPolicy,
	result: LanguageIdentification,
): { language: string; warning?: string; summary: string } {
	const fallback = policy.languages[0]!;
	const [first, second] = result.candidates;
	const language = policy.languages[policy.allowed.indexOf(result.code ?? "")];
	const scores = result.candidates.map((c) => `${c.code} ${(c.p * 100).toFixed(1)}%`).join(", ");
	const unsure = first && second && first.p < UNSURE_RATIO * second.p ? ", uncertain" : "";
	const summary = `${language ?? "none"} (${scores}; allowed mass ${(result.allowedMass * 100).toFixed(1)}%${unsure})`;
	if (!language || !first || !Number.isFinite(first.p)) {
		return { language: fallback, warning: `Couldn't detect the language. Transcribed as ${displayLanguage(fallback)}.`, summary };
	}
	return { language, summary };
}

/** Shown when Auto needs the language detector and it is not downloaded. */
export function missingDetectorWarning(fallback: string): string {
	return `The language detector isn't downloaded. Transcribed as ${displayLanguage(fallback)}. ` +
		"Download it in Settings → Dictation to use Auto detect.";
}
