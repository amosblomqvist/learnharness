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

export type DictationProvider = "deepgram" | "handy";

export const DICTATION_PROVIDERS: readonly { id: DictationProvider; label: string }[] = [
	{ id: "handy", label: "Handy (Local)" },
	{ id: "deepgram", label: "Deepgram (Cloud)" },
];

export function isDictationProvider(value: unknown): value is DictationProvider {
	return value === "deepgram" || value === "handy";
}

export interface HandyModel {
	id: string;
	name: string;
	filename?: string;
	is_downloaded: boolean;
}

/**
 * Encodes 16-bit linear PCM audio buffers (16kHz mono) into a standard 44-byte RIFF/WAVE container.
 */
export function encodeWavPcm16Mono(
	frames: readonly (ArrayBuffer | ArrayBufferView)[],
	sampleRate = 16000,
): Uint8Array {
	let totalBytes = 0;
	for (const frame of frames) totalBytes += frame.byteLength;

	const wav = new Uint8Array(44 + totalBytes);
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

	// "RIFF" chunk descriptor
	wav[0] = 0x52; // 'R'
	wav[1] = 0x49; // 'I'
	wav[2] = 0x46; // 'F'
	wav[3] = 0x46; // 'F'
	view.setUint32(4, 36 + totalBytes, true);
	// "WAVE" format
	wav[8] = 0x57; // 'W'
	wav[9] = 0x41; // 'A'
	wav[10] = 0x56; // 'V'
	wav[11] = 0x45; // 'E'

	// "fmt " subchunk
	wav[12] = 0x66; // 'f'
	wav[13] = 0x6d; // 'm'
	wav[14] = 0x74; // 't'
	wav[15] = 0x20; // ' '
	view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
	view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
	view.setUint16(22, 1, true); // NumChannels (1 = Mono)
	view.setUint32(24, sampleRate, true); // SampleRate
	view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
	view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
	view.setUint16(34, 16, true); // BitsPerSample (16 bits)

	// "data" subchunk
	wav[36] = 0x64; // 'd'
	wav[37] = 0x61; // 'a'
	wav[38] = 0x74; // 't'
	wav[39] = 0x61; // 'a'
	view.setUint32(40, totalBytes, true);

	let offset = 44;
	for (const frame of frames) {
		const bytes = ArrayBuffer.isView(frame)
			? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
			: new Uint8Array(frame);
		wav.set(bytes, offset);
		offset += bytes.byteLength;
	}

	return wav;
}

