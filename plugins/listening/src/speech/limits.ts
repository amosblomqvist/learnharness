/** Speech limits and errors shared by the backend speech service and its providers. */

/** Speeds offered to the learner. Both reuse the same recording with pitch preservation. */
export const PLAYBACK_RATES = [1, 0.75] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export const MAX_CONCURRENT_GENERATIONS = 2;
export const SPEECH_CACHE_MAX_BYTES = 256 * 1024 * 1024;

const MIB = 1024 * 1024;
/** Fixed allowance plus a per-1,000-character share, so anything the model accepts can finish. */
const AUDIO_BASE_BYTES = 2 * MIB;
const AUDIO_BYTES_PER_1000_CHARACTERS = 1 * MIB;
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_MS_PER_1000_CHARACTERS = 20_000;

/** Language tags: an ISO 639-1 (or 639-3) code with optional subtags, such as "es" or "pt-BR". */
export const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$";
export function isLanguageTag(value: string): boolean {
  return new RegExp(LANGUAGE_TAG_PATTERN).test(value);
}

export function codePointLength(text: string): number {
  return [...text].length;
}

/** Largest generated audio accepted for this spoken text. */
export function maxAudioBytes(text: string): number {
  return AUDIO_BASE_BYTES + Math.ceil(codePointLength(text) / 1000) * AUDIO_BYTES_PER_1000_CHARACTERS;
}

/** Longest generation wait for this spoken text. */
export function generationTimeoutMs(text: string): number {
  return TIMEOUT_BASE_MS + Math.ceil(codePointLength(text) / 1000) * TIMEOUT_MS_PER_1000_CHARACTERS;
}

export type SpeechErrorCode =
  | "invalid_request" | "text_too_long" | "not_ready" | "key_missing"
  | "auth_failed" | "voice_unavailable" | "payment_required" | "rate_limited"
  | "busy" | "timeout" | "provider_failed" | "invalid_audio";

/** Readable, provider-detail-free failures. Messages are safe to show the learner. */
export class SpeechError extends Error {
  constructor(readonly code: SpeechErrorCode, message: string) {
    super(message);
    this.name = "SpeechError";
  }
}

/** Layout whitespace is immaterial; characters, script, case and punctuation are not. */
export function normalizeSpokenText(text: string): string {
  return text.replace(/[\t\r\n ]+/g, " ").trim();
}

/** Readable text only: no control characters other than layout whitespace. */
export function spokenTextProblem(text: string): string | undefined {
  if (!normalizeSpokenText(text)) return "The spoken text is empty.";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return "The spoken text contains control characters.";
  return undefined;
}
