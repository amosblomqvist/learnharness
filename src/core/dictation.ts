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

/** The "System default" choice (input-device selection wave): an EMPTY
 *  deviceId means "no pin" — getUserMedia runs unconstrained and the OS
 *  picks. It is the first option in every list and clearing the preference
 *  resolves back to it (absent inputDeviceId in the record = this). */
export const DICTATION_DEFAULT_DEVICE_ID = "";
export const DICTATION_DEFAULT_DEVICE_LABEL = "System default";

/** One selectable microphone — a live enumerateDevices() entry mapped to the
 *  minimal shape the picker and the stored preference share. */
export interface DictationInputDevice {
	deviceId: string;
	label: string;
}

/** The platform's own "follow the OS default" aliases (Chromium lists a real
 *  audioinput with deviceId "default", and "communications" on Windows). Our
 *  synthetic "System default" already IS that choice — keeping the aliases
 *  would duplicate it (with a confusing moving label like "Default -
 *  Headphones") AND collide with the synthetic's key/testid. Dropped. */
const PLATFORM_DEFAULT_IDS = new Set(["default", "communications"]);

/**
 * Build the microphone option list from a raw enumerateDevices() result:
 * keep audio inputs only, drop the platform default aliases (see above) and
 * duplicate deviceIds (enumerateDevices can list the same device twice),
 * supply a stable fallback label for entries whose label is still empty (no
 * mic permission yet — the browser blanks labels until the first grant), and
 * ALWAYS prepend "System default" so the user can revert to the
 * unconstrained pick. Pure + browser-safe (types only, no `navigator`) so
 * the mapping is unit-testable away from the DOM.
 */
export function dictationInputDeviceOptions(devices: readonly MediaDeviceInfo[]): DictationInputDevice[] {
	const out: DictationInputDevice[] = [
		{ deviceId: DICTATION_DEFAULT_DEVICE_ID, label: DICTATION_DEFAULT_DEVICE_LABEL },
	];
	const seen = new Set<string>([DICTATION_DEFAULT_DEVICE_ID]);
	let unnamed = 0;
	for (const device of devices) {
		if (device.kind !== "audioinput") continue;
		const deviceId = device.deviceId;
		// An empty id (never selectable), a platform default alias (the
		// synthetic above covers it), or a duplicate id adds nothing.
		if (!deviceId || PLATFORM_DEFAULT_IDS.has(deviceId) || seen.has(deviceId)) continue;
		seen.add(deviceId);
		const label = device.label.trim() || `Microphone ${++unnamed}`;
		out.push({ deviceId, label });
	}
	return out;
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}
