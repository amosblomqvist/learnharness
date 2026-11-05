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

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}

/** Dictation engines. Deepgram streams over a browser WebSocket and stays the
 * default; Groq records first and sends one Whisper upload through our server. */
export const DICTATION_PROVIDERS = ["deepgram", "groq"] as const;
export type DictationProvider = (typeof DICTATION_PROVIDERS)[number];
export const DEFAULT_DICTATION_PROVIDER: DictationProvider = "deepgram";

export function isDictationProvider(value: unknown): value is DictationProvider {
	return DICTATION_PROVIDERS.some((id) => id === value);
}

/** Groq-hosted Whisper models (OpenAI-compatible transcription endpoint). */
export const GROQ_WHISPER_MODELS = [
	{ id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", hint: "Faster" },
	{ id: "whisper-large-v3", label: "Whisper Large v3", hint: "Most accurate" },
] as const;
export type GroqWhisperModel = (typeof GROQ_WHISPER_MODELS)[number]["id"];
export const DEFAULT_GROQ_WHISPER_MODEL: GroqWhisperModel = "whisper-large-v3-turbo";

export function isGroqWhisperModel(value: unknown): value is GroqWhisperModel {
	return GROQ_WHISPER_MODELS.some(({ id }) => id === value);
}

/** The env var holding the Groq key. It is the existing model-provider key. */
export const GROQ_KEY_ID = "GROQ_API_KEY";
/** Same-origin intent header the dictation client sends to /api/stt/transcribe. */
export const GROQ_DICTATION_HEADER = "x-learnharness-dictation";

/** Groq's documented upload limit is 25 MB on the free tier (100 MB on the
 * dev tier, which needs a URL upload for the top of that range). The docs do
 * not say MB or MiB, so the decimal figure is used. Each request is one chunk
 * of at most 18 s, 576 KB, so the limit is far away; the route still enforces
 * it, and its own body ceiling, on every request. */
export const GROQ_MAX_UPLOAD_BYTES = 25_000_000;
/** Request-body ceiling: the file plus multipart framing. It must stay inside
 * next.config.ts's proxyClientMaxBodySize, or Next hands the route a truncated body. */
export const GROQ_MAX_BODY_BYTES = GROQ_MAX_UPLOAD_BYTES + 64 * 1024;
export const DICTATION_SAMPLE_RATE = 16_000;
/** The longest single dictation: 20 minutes, after which it stops and
 * transcribes what it has. Two things set it. Memory: a run keeps the audio of
 * every chunk until the transcript is inserted, 32 KB per second, so 20 minutes
 * is at most 38.4 MB in the page. Quota: Groq's free tier allows about 7,200
 * audio-seconds an hour and bills each request at least 10 s (chunks are 12 s
 * or more, so nothing is rounded up), so one 20-minute run, about 80 requests,
 * uses a sixth of an hour's allowance and nowhere near the 20 requests a minute. */
export const GROQ_MAX_RECORDING_SECONDS = 1200;
/** Groq dictation is sent in chunks of about this long while the user is still
 * speaking (see dictation-chunks.ts). The cut goes at the quietest point
 * between MIN and MAX; MAX is also the longest a chunk can be. At 16 kHz mono
 * 16-bit, MAX is 576 KB, far below Groq's upload limit. */
export const GROQ_CHUNK_TARGET_SECONDS = 15;
export const GROQ_CHUNK_MIN_SECONDS = 12;
export const GROQ_CHUNK_MAX_SECONDS = 18;
/** A final chunk shorter than this (a stray double-click, or a click after the
 * last word) is dropped, not uploaded. */
export const GROQ_MIN_PCM_BYTES = Math.round(0.3 * DICTATION_SAMPLE_RATE) * 2;

/** The values Groq's transcription `language` field accepts: ISO-639-1 codes
 * plus `haw` (Hawaiian) and `yue` (Cantonese), which have no two-letter code.
 * Source: the `language` type in Groq's official SDK (groq-sdk 1.6.0), which
 * follows its API spec; `jv` is Javanese (Whisper's older `jw` is not accepted). */
const WHISPER_LANGUAGES: ReadonlySet<string> = new Set((
	"en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml " +
	"cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am " +
	"yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jv su yue"
).split(" "));

/** Map a dictation language onto the code Whisper takes, or undefined when it
 * has no equivalent (the caller then omits `language` so Whisper auto-detects).
 * Regional variants collapse to their base language (Whisper has no locales),
 * Cantonese (zh-HK) maps to `yue`, and Deepgram's "multi" auto-detects. */
export function whisperLanguage(language: DictationLanguage): string | undefined {
	if (language === "multi") return undefined;
	if (language === "zh-HK") return "yue";
	const base = language.split("-")[0]!.toLowerCase();
	return WHISPER_LANGUAGES.has(base) ? base : undefined;
}

/** The PUT body for the dictation section. The section is replaced whole, and
 * default provider/model are left out so a Deepgram user's record stays exactly
 * `{ language }` as before. */
export function dictationSettingsBody(pref: {
	language: DictationLanguage;
	provider?: DictationProvider;
	groqModel?: GroqWhisperModel;
}): { language: DictationLanguage; provider?: DictationProvider; groqModel?: GroqWhisperModel } {
	return {
		language: pref.language,
		...(pref.provider && pref.provider !== DEFAULT_DICTATION_PROVIDER ? { provider: pref.provider } : {}),
		...(pref.groqModel && pref.groqModel !== DEFAULT_GROQ_WHISPER_MODEL ? { groqModel: pref.groqModel } : {}),
	};
}
