/** Local lesson speech contracts. No runtime or installation state is persisted. */
export interface SpeechSettings {
	engine?: "piper";
	voice?: string;
	automaticReading?: boolean;
	playbackRate?: number;
}
export const SPEECH_DEFAULTS = { automaticReading: false, playbackRate: 1 } as const;

/** The curated Piper voices, lightest first. Sizes and hashes live in the artifact lock. */
export const SPEECH_VOICES = [
	{ id: "en_US-danny-low", name: "Danny · English (US)", quality: "low", license: "CC BY-SA 4.0" },
	{ id: "en_US-joe-medium", name: "Joe · English (US)", quality: "medium", license: "CC0 1.0" },
	{ id: "en_US-amy-medium", name: "Amy · English (US)", quality: "medium", license: "CC BY-SA 4.0" },
	{ id: "en_GB-alba-medium", name: "Alba · English (GB)", quality: "medium", license: "CC BY 4.0" },
	{ id: "en_GB-northern_english_male-medium", name: "Northern English Male · English (GB)", quality: "medium", license: "CC BY-SA 4.0" },
	{ id: "en_US-ljspeech-high", name: "LJ Speech · English (US)", quality: "high", license: "Public domain dataset" },
] as const;
export type SpeechVoiceId = (typeof SPEECH_VOICES)[number]["id"];
/** The sentence every bundled preview sample speaks. */
export const SPEECH_PREVIEW_TEXT = "Welcome to your lesson. Let's explore an idea together.";
export type SpeechQuality = (typeof SPEECH_VOICES)[number]["quality"];
/** Weight in plain words; measured real-time factors are not shown until benchmarked. */
export const SPEECH_QUALITY_LABEL: Record<SpeechQuality, string> = { low: "Fastest", medium: "Balanced", high: "Highest quality, heaviest" };
export function isSpeechVoiceId(value: unknown): value is SpeechVoiceId {
	return SPEECH_VOICES.some(voice => voice.id === value);
}
export type SpeechVoiceState = "unavailable" | "not-installed" | "downloading" | "verifying" | "ready" | "removing" | "failed";
export interface SpeechOperation { id: string; voiceId: string; state: SpeechVoiceState; downloadedBytes: number; totalBytes: number; error?: string }
export interface SpeechStatus {
	engines: Array<{ id: "piper"; available: boolean; reason?: string }>;
	voices: Array<{ id: SpeechVoiceId; engine: "piper"; name: string; quality: SpeechQuality; license: string; downloadBytes: number; state: SpeechVoiceState; reason?: string }>;
	operation: SpeechOperation | null;
}
export function sanitizeSpeechSettings(value: unknown): SpeechSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	const out = { ...raw } as SpeechSettings;
	delete out.engine; delete out.voice; delete out.automaticReading; delete out.playbackRate;
	if (raw.engine === "piper") out.engine = raw.engine;
	if (isSpeechVoiceId(raw.voice)) out.voice = raw.voice;
	if (typeof raw.automaticReading === "boolean") out.automaticReading = raw.automaticReading;
	if (typeof raw.playbackRate === "number" && Number.isFinite(raw.playbackRate)) out.playbackRate = Math.max(0.75, Math.min(2, raw.playbackRate));
	return out;
}
