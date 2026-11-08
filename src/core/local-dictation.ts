/** Local transcription uses completed, in-memory 16 kHz mono PCM WAV recordings. */
export const DICTATION_SAMPLE_RATE = 16_000;
export const LOCAL_DICTATION_MAX_MS = 10 * 60_000;
export const LOCAL_DICTATION_MAX_BYTES = DICTATION_SAMPLE_RATE * 2 * LOCAL_DICTATION_MAX_MS / 1000 + 44;
export const LOCAL_DICTATION_TIMEOUT_MS = 5 * 60_000;
export const LOCAL_DICTATION_AUTH = "__learnharness_local_dictation_auth";

export interface LocalDictationSettings {
	server: "llama.cpp" | "whisper.cpp";
	/** Server base URL; previously saved full transcription URLs remain supported. */
	url: string;
	model?: string;
	/** Absent/auto asks the backend to detect the language. */
	language?: string;
}

export function normalizeDictationUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048) return "";
	try {
		const url = new URL(value.trim());
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[?#]/.test(value)) return "";
		return url.toString();
	} catch { return ""; }
}

export const LOCAL_DICTATION_PATHS = {
	"llama.cpp": "/v1/audio/transcriptions",
	"whisper.cpp": "/inference",
} as const;

/** Strip only the selected server's standard endpoint, preserving proxy prefixes. */
export function localDictationBaseUrl(config: Pick<LocalDictationSettings, "server" | "url">): string {
	const url = normalizeDictationUrl(config.url).replace(/\/+$/, "");
	const suffix = LOCAL_DICTATION_PATHS[config.server];
	return url.endsWith(suffix) ? url.slice(0, -suffix.length) : url;
}

export function localDictationEndpoint(config: Pick<LocalDictationSettings, "server" | "url">): string {
	const base = localDictationBaseUrl(config);
	return base ? base + LOCAL_DICTATION_PATHS[config.server] : "";
}

/** Backend-specific language codes; auto is distinct from Deepgram multilingual. */
export function isLocalDictationLanguage(value: unknown): value is string {
	return typeof value === "string" && /^(auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(value);
}

export function parseLocalDictation(value: unknown): LocalDictationSettings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const raw = value as Record<string, unknown>;
	if (raw.server !== "llama.cpp" && raw.server !== "whisper.cpp") return;
	const url = normalizeDictationUrl(raw.url);
	if (!url) return;
	if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.length > 256 || /[\r\n]/.test(raw.model))) return;
	if (raw.language !== undefined && !isLocalDictationLanguage(raw.language)) return;
	return { server: raw.server, url, ...(raw.model ? { model: (raw.model as string).trim() } : {}), ...(raw.language ? { language: raw.language as string } : {}) };
}

/** Frames are little-endian signed PCM16, produced by pcm-capture.js. */
export function dictationWav(frames: readonly ArrayBuffer[]): Uint8Array<ArrayBuffer> {
	const bytes = frames.reduce((size, frame) => size + frame.byteLength, 0);
	if (bytes === 0 || bytes % 2 || bytes + 44 > LOCAL_DICTATION_MAX_BYTES) throw new Error("Recording is empty or exceeds the 10-minute limit");
	const wav = new Uint8Array(44 + bytes);
	const view = new DataView(wav.buffer);
	const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i); };
	tag(0, "RIFF"); view.setUint32(4, 36 + bytes, true); tag(8, "WAVE"); tag(12, "fmt ");
	view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, DICTATION_SAMPLE_RATE, true); view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, bytes, true);
	let offset = 44;
	for (const frame of frames) { wav.set(new Uint8Array(frame), offset); offset += frame.byteLength; }
	return wav;
}

export function validDictationWav(wav: Uint8Array): boolean {
	if (wav.byteLength <= 44 || wav.byteLength > LOCAL_DICTATION_MAX_BYTES) return false;
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	const tag = (at: number, text: string) => [...text].every((c, i) => wav[at + i] === c.charCodeAt(0));
	return tag(0, "RIFF") && tag(8, "WAVE") && tag(12, "fmt ") && tag(36, "data") &&
		view.getUint32(4, true) === wav.length - 8 && view.getUint32(16, true) === 16 &&
		view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 &&
		view.getUint32(24, true) === DICTATION_SAMPLE_RATE && view.getUint32(28, true) === DICTATION_SAMPLE_RATE * 2 &&
		view.getUint16(32, true) === 2 && view.getUint16(34, true) === 16 &&
		view.getUint32(40, true) === wav.length - 44 && (wav.length - 44) % 2 === 0;
}
