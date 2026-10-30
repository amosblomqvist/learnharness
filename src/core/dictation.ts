/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Languages ElevenLabs Scribe v2 lists as supported, as `language_code`
 * values (ISO 639-1 where one exists, else 639-3: `yue`). The docs list is in
 * ISO 639-3; each entry is its 639-1 equivalent. Languages without a 639-1
 * code that the app never offers are omitted (ast, ceb, ful, lug, kea, luo,
 * nso, umb); `fil` stays, as Tagalog's target.
 * Source: https://elevenlabs.io/docs/overview/capabilities/speech-to-text
 * ("90+ languages", the page's list; checked 2026-10-29). */
export const ELEVENLABS_SCRIBE_LANGUAGES: ReadonlySet<string> = new Set([
	"af", "am", "ar", "hy", "as", "az", "be", "bn", "bs", "bg", "my", "yue", "ca", "ny", "hr", "cs", "da", "nl",
	"en", "et", "fi", "fr", "gl", "ka", "de", "el", "gu", "ha", "he", "hi", "hu", "is", "ig", "id", "ga", "it",
	"ja", "jv", "kn", "kk", "km", "ko", "ku", "ky", "lo", "lv", "ln", "lt", "lb", "mk", "ms", "ml", "mt", "zh",
	"mi", "mr", "mn", "ne", "no", "oc", "or", "ps", "fa", "pl", "pt", "pa", "ro", "ru", "sr", "sn", "sd", "si",
	"sk", "sl", "so", "es", "sw", "sv", "ta", "tg", "te", "th", "tr", "uk", "ur", "uz", "vi", "cy", "wo", "xh", "zu",
	"fil",
]);

/** A regional code whose region changes the LANGUAGE, not just the accent. */
const SCRIBE_REGION_LANGUAGES: Partial<Record<DictationLanguage, string>> = {
	"zh-HK": "yue", // Cantonese, not Mandarin `zh`
	tl: "fil", // Scribe lists Filipino, Tagalog's standardized form (owner, 2026-10-29)
};

/** The Scribe `language_code` for the saved dictation language, or undefined
 *  to omit it (Scribe then auto-detects; verified live, PRD slice 1). "multi"
 *  and any language Scribe doesn't list auto-detect. Regional codes use their
 *  base language. */
export function elevenLabsLanguageCode(language: DictationLanguage): string | undefined {
	if (language === "multi") return undefined;
	const code = SCRIBE_REGION_LANGUAGES[language] ?? language.split("-")[0]!;
	return ELEVENLABS_SCRIBE_LANGUAGES.has(code) ? code : undefined;
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}
