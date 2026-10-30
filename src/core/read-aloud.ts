/**
 * Read-aloud voice and model choices (ElevenLabs voice slice 9). Pure and
 * browser-safe: the defaults, the plain-id check, and the model fallback rule
 * shared by the server (what plays) and the picker (what it shows).
 */

/** Alice — premade "Clear, Engaging Educator" (owner, 2026-10-29). */
export const DEFAULT_TTS_VOICE_ID = "Xb7hH8MSUJpSbSDYk0k2";
/** ElevenLabs' recommended low-latency model, the default when the account lists it. */
export const DEFAULT_TTS_MODEL_ID = "eleven_v4_turbo";
/** The fallback when the default is not listed. */
export const FALLBACK_TTS_MODEL_ID = "eleven_flash_v2_5";

/** A voice or model id the proxy will put in a URL path or JSON body. */
const PLAIN_ID = /^[A-Za-z0-9_.-]{1,100}$/;
export function isPlainTtsId(value: unknown): value is string {
	return typeof value === "string" && PLAIN_ID.test(value);
}

/** One account voice, as the voices route returns it. */
export interface TtsVoice {
	id: string;
	name: string;
	/** premade, cloned, generated, professional, ... (as the provider says). */
	category: string;
}

/** One text-to-speech model, as the models route returns it. */
export interface TtsModel {
	id: string;
	name: string;
	/** The provider's per-request character limit. */
	maxChars: number;
}

/**
 * The voice playback uses. A saved voice that is listed wins; otherwise Alice
 * (a voice removed from the account never silences playback). With no list
 * (unavailable), trust `saved`, else Alice.
 */
export function resolveTtsVoice(saved: string | undefined, listedIds: readonly string[]): string {
	if (listedIds.length === 0) return saved ?? DEFAULT_TTS_VOICE_ID;
	if (saved !== undefined && listedIds.includes(saved)) return saved;
	return DEFAULT_TTS_VOICE_ID;
}

/**
 * The model playback uses. A saved model that is listed wins; otherwise
 * eleven_v4_turbo if listed, else eleven_flash_v2_5, else the first listed.
 * With no list (unavailable), trust `saved`, else the default.
 */
export function resolveTtsModel(saved: string | undefined, listedIds: readonly string[]): string {
	if (listedIds.length === 0) return saved ?? DEFAULT_TTS_MODEL_ID;
	if (saved !== undefined && listedIds.includes(saved)) return saved;
	if (listedIds.includes(DEFAULT_TTS_MODEL_ID)) return DEFAULT_TTS_MODEL_ID;
	if (listedIds.includes(FALLBACK_TTS_MODEL_ID)) return FALLBACK_TTS_MODEL_ID;
	return listedIds[0]!;
}
