/** Nova-3 language choices. Regional variants are offered where they differ.
 * https://developers.deepgram.com/docs/models-languages-overview/#nova-3 */
export const TRANSCRIPTION_LANGUAGES = [
	["multi", "Multilingual (auto-detect)"],
	["af", "Afrikaans"],
	["ar", "Arabic"],
	["hy", "Armenian"],
	["as", "Assamese"],
	["be", "Belarusian"],
	["bn", "Bengali"],
	["bs", "Bosnian"],
	["bg", "Bulgarian"],
	["ca", "Catalan"],
	["zh-HK", "Chinese (Cantonese)"],
	["zh", "Chinese (Mandarin, Simplified)"],
	["zh-TW", "Chinese (Mandarin, Traditional)"],
	["hr", "Croatian"],
	["cs", "Czech"],
	["da", "Danish"],
	["nl", "Dutch"],
	["en", "English"],
	["et", "Estonian"],
	["fi", "Finnish"],
	["nl-BE", "Flemish"],
	["fr", "French"],
	["fr-CA", "French (Canada)"],
	["ka", "Georgian"],
	["de", "German"],
	["de-CH", "German (Switzerland)"],
	["el", "Greek"],
	["gu", "Gujarati"],
	["he", "Hebrew"],
	["hi", "Hindi"],
	["hu", "Hungarian"],
	["id", "Indonesian"],
	["it", "Italian"],
	["ja", "Japanese"],
	["kn", "Kannada"],
	["kk", "Kazakh"],
	["ko", "Korean"],
	["lv", "Latvian"],
	["lt", "Lithuanian"],
	["mk", "Macedonian"],
	["ms", "Malay"],
	["mr", "Marathi"],
	["mn", "Mongolian"],
	["ne", "Nepali"],
	["no", "Norwegian"],
	["ps", "Pashto"],
	["fa", "Persian"],
	["pl", "Polish"],
	["pt", "Portuguese"],
	["pt-BR", "Portuguese (Brazil)"],
	["pt-PT", "Portuguese (Portugal)"],
	["pa", "Punjabi"],
	["ro", "Romanian"],
	["ru", "Russian"],
	["sr", "Serbian"],
	["sk", "Slovak"],
	["sl", "Slovenian"],
	["es", "Spanish"],
	["sv", "Swedish"],
	["tl", "Tagalog"],
	["ta", "Tamil"],
	["te", "Telugu"],
	["th", "Thai"],
	["tr", "Turkish"],
	["uk", "Ukrainian"],
	["ur", "Urdu"],
	["vi", "Vietnamese"],
] as const;

export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGES)[number][0];
/** Preserve Deepgram's previous English default for existing settings. */
export const DEFAULT_TRANSCRIPTION_LANGUAGE: TranscriptionLanguage = "en";

export function isTranscriptionLanguage(value: unknown): value is TranscriptionLanguage {
	return TRANSCRIPTION_LANGUAGES.some(([code]) => code === value);
}

export function transcriptionLanguage(value: unknown): TranscriptionLanguage {
	return isTranscriptionLanguage(value) ? value : DEFAULT_TRANSCRIPTION_LANGUAGE;
}

/** One URL builder for initial connections and reconnects. */
export function dictationUrl(language: TranscriptionLanguage): string {
	const url = new URL("wss://api.deepgram.com/v1/listen");
	url.search = new URLSearchParams({
		model: "nova-3", language, encoding: "linear16", sample_rate: "16000",
		channels: "1", smart_format: "true", punctuate: "true", endpointing: "300",
	}).toString();
	return url.toString();
}
