/**
 * The on-device ("local") dictation engine: constants, settings helpers and the
 * wire shapes shared by the /api/stt/local/* and /api/stt/vad routes and the
 * client that calls them. Browser-safe.
 *
 * Catalog, recommendations, language policy and Chinese rules live in the
 * local-stt-*.ts modules next to this one (ported from pi-voice, MIT).
 */
import type { DictationLanguage } from "./dictation.ts";
import { type CatalogModel, isCatalogLanguage, languageIdentity } from "./local-stt-catalog.ts";
import type { LocalChineseOutput } from "./local-stt-chinese.ts";
import type { MachineTier } from "./local-stt-recommendations.ts";

export const LOCAL_STT_MODELS_URL = "/api/stt/local/models";
export const LOCAL_STT_TRANSCRIBE_URL = "/api/stt/local/transcribe";
export const STT_VAD_URL = "/api/stt/vad";

/** Silero VAD scores one frame per 512 samples: 32 ms at 16 kHz. */
export const VAD_FRAME_SAMPLES = 512;
/** No model chosen: the resolved `localModel` is this until the learner picks one. */
export const NO_LOCAL_MODEL = "";

/** The Local engine's preferred languages when none were chosen: the dictation language,
 * or English when that is Multilingual or a language no local model transcribes. */
export function defaultLocalPreferredLanguages(language: DictationLanguage | string): string[] {
	const identity = languageIdentity(language);
	return [isCatalogLanguage(identity) ? identity : "en"];
}

/** Preferred languages as stored: identities (tl is fil, no is nb), catalog languages only,
 * in the learner's order without repeats. Undefined when the value is not a non-empty list. */
export function normalizeLocalPreferredLanguages(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((language) => typeof language === "string")) return undefined;
	const languages = [...new Set(value.map(languageIdentity).filter((language) => isCatalogLanguage(language)))];
	return languages.length > 0 ? languages : undefined;
}

// ── wire shapes ──────────────────────────────────────────────────────────────

/** A download in progress, or one that failed. A finished or cancelled download has no entry. */
export type LocalModelDownload = {
	/** `verifying` is the SHA-256 and size check before the file is moved into place. */
	state: "downloading" | "verifying" | "error";
	/** Bytes on disk so far, including any resumed prefix. */
	bytes: number;
	total: number;
	/** Present when `state` is `error`: a short sentence for the learner. */
	message?: string;
};

export type LocalModelStatus = {
	/** A catalog id, or the language detector's id. */
	id: string;
	installed: boolean;
	/** Bytes of a resumable partial download left on disk (0 when none). */
	partialBytes: number;
	download: LocalModelDownload | null;
};

export type LocalModelsResponse = {
	/** `accelerated` when transcribe.cpp reports a non-CPU backend, else `cpu`. */
	hardwareTier: MachineTier;
	/** False when the native engine cannot load on this machine; `engineError` says why. */
	engineAvailable: boolean;
	engineError?: string;
	/** Every catalog model, in catalog order. */
	models: LocalModelStatus[];
	/** The shared language detector (VoxLingua107). Needed for Auto on models without native detection. */
	languageDetector: LocalModelStatus;
};

export type LocalTranscribeResponse = {
	text: string;
	/** The language the chunk was transcribed in, when known: the code to pin the take to. */
	language?: string;
	/** A limitation worth telling the learner about (e.g. the detector is not downloaded). */
	warning?: string;
};

export type VadResponse = {
	/** Speech probability (0 to 1) for each 512-sample frame, in order. The last frame is zero padded. */
	probs: number[];
};
