/**
 * The Groq (Whisper) dictation transport, behind /api/stt/transcribe. Groq has
 * no short-lived token mint, so the key stays here (GROQ_API_KEY, through
 * keyValue) and the audio passes through the local server on its way to Groq.
 *
 * POST multipart: `audio` (WAV), `model`, `language` (a dictation code, mapped
 * to Whisper's or omitted so Whisper auto-detects) and `prompt` (the end of the
 * previous chunk's transcript). Answers `{ text }`, or `{ message, retryable }`
 * where `retryable` says whether sending the same request again may work.
 *
 * Trust: a multipart POST is a CORS "simple request", so a page on another
 * origin could fire one and spend the user's quota. Like the subscription
 * controls, this demands same-origin browser intent (sameOriginIntent). That is
 * not user authentication and no defence against DNS rebinding. If the browser
 * goes away mid-request the call to Groq is aborted too.
 */
import {
	DEFAULT_GROQ_WHISPER_MODEL,
	GROQ_DICTATION_HEADER,
	GROQ_KEY_ID,
	GROQ_MAX_BODY_BYTES,
	GROQ_MAX_UPLOAD_BYTES,
	isDictationLanguage,
	isGroqWhisperModel,
	whisperLanguage,
} from "../core/dictation.ts";
import { looksLikeWav, WAV_HEADER_BYTES } from "../core/wav.ts";
import { keyValue } from "./keys.ts";
import { BodyTooLargeError, readUploadForm } from "./stt-upload.ts";
import { sameOriginIntent } from "./web-subscription-http.ts";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** A chunk transcribes in seconds; this only bounds a hang. */
const GROQ_TIMEOUT_MS = 90_000;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const TOO_LARGE = "The recording is too large for Groq. Dictate in shorter runs.";

function fail(status: number, message: string, options: { retryable?: boolean; headers?: HeadersInit } = {}): Response {
	return Response.json({ message, retryable: options.retryable === true }, { status, headers: { ...HEADERS, ...options.headers } });
}

const forbidden = () => fail(403, "Dictation requests must come from the LearnHarness window.");
const keyless = () => fail(503, `No ${GROQ_KEY_ID} — add it to auth.json (desktop) or .env.local (dev).`);

/** Groq's error body is OpenAI-shaped: { error: { message } }. It is shown to
 * the learner, so the key is scrubbed from it first (defence in depth). */
async function groqDetail(res: Response, key: string): Promise<string> {
	const text = await res.text().catch(() => "");
	let detail = text;
	try {
		const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
		if (typeof message === "string") detail = message;
	} catch {}
	return detail.replaceAll(key, "[redacted]").slice(0, 200);
}

/** Map a Groq failure to a user-facing message. 429 and 413 keep their status;
 * everything else is a 502 so it is never mistaken for our own 400/403/415/503. */
async function groqFailure(res: Response, key: string): Promise<Response> {
	const detail = await groqDetail(res, key);
	switch (res.status) {
		case 401:
			return fail(502, "Groq rejected the API key (401). Check GROQ_API_KEY in Settings → Providers.");
		case 403:
			return fail(502, "Groq refused the request (403). The key or organization may not have access to speech-to-text.");
		case 413:
			return fail(413, TOO_LARGE);
		case 429: {
			const seconds = Number(res.headers.get("retry-after"));
			const known = Number.isFinite(seconds) && seconds > 0;
			const wait = !known ? " Wait a moment and try again."
				: seconds < 90 ? ` Try again in ${Math.ceil(seconds)} s.` : ` Try again in ${Math.ceil(seconds / 60)} min.`;
			return fail(429, `Groq rate limit reached.${wait}`, {
				retryable: true,
				headers: known ? { "Retry-After": String(Math.ceil(seconds)) } : undefined,
			});
		}
		case 400:
		case 422:
			return fail(502, `Groq could not process the audio (${res.status})${detail ? `: ${detail}` : "."}`);
		default:
			return res.status >= 500
				? fail(502, `Groq is unavailable (${res.status}). Try again shortly.`, { retryable: true })
				: fail(502, `Groq transcription failed (${res.status})${detail ? `: ${detail}` : "."}`);
	}
}

export async function groqTranscribeResponse(request: Request): Promise<Response> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return forbidden();
	// Key before body: a keyless request must not make the client's upload buffer first.
	const key = keyValue(GROQ_KEY_ID);
	if (!key) return keyless();
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
		return fail(415, "Expected multipart/form-data.");
	}

	let form: FormData;
	try {
		form = await readUploadForm(request, GROQ_MAX_BODY_BYTES);
	} catch (err) {
		return err instanceof BodyTooLargeError ? fail(413, TOO_LARGE) : fail(400, "Could not read the upload.");
	}

	const audio = form.get("audio");
	if (!(audio instanceof File) || audio.size === 0) return fail(400, "Missing audio.");
	if (audio.size > GROQ_MAX_UPLOAD_BYTES) return fail(413, TOO_LARGE);
	if (audio.type !== "audio/wav") return fail(415, "Unsupported audio type; send a WAV file.");
	if (!looksLikeWav(new Uint8Array(await audio.slice(0, WAV_HEADER_BYTES).arrayBuffer()))) {
		return fail(400, "The audio is not a valid WAV file.");
	}

	const model = form.get("model") ?? DEFAULT_GROQ_WHISPER_MODEL;
	if (!isGroqWhisperModel(model)) return fail(400, "Unsupported Groq dictation model.");
	const requested = form.get("language");
	if (requested !== null && !isDictationLanguage(requested)) return fail(400, "Unsupported dictation language.");
	const language = requested === null ? undefined : whisperLanguage(requested);
	const rawPrompt = form.get("prompt");
	if (rawPrompt !== null && typeof rawPrompt !== "string") return fail(400, "Unsupported dictation prompt.");
	const prompt = rawPrompt?.trim();

	const upstream = new FormData();
	upstream.set("file", new File([audio], "dictation.wav", { type: "audio/wav" }));
	upstream.set("model", model);
	upstream.set("response_format", "json");
	if (language) upstream.set("language", language);
	if (prompt) upstream.set("prompt", prompt);

	let res: Response;
	try {
		res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			body: upstream,
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(GROQ_TIMEOUT_MS)]),
		});
	} catch (err) {
		if (request.signal.aborted) return fail(499, "The request was cancelled.");
		return err instanceof DOMException && err.name === "TimeoutError"
			? fail(502, "Groq took too long to respond. Try again.", { retryable: true })
			: fail(502, "Groq unreachable. Check your connection and try again.", { retryable: true });
	}
	if (!res.ok) return groqFailure(res, key);

	try {
		const data = (await res.json()) as { text?: unknown };
		if (typeof data.text !== "string") return fail(502, "Groq returned no transcript.");
		return Response.json({ text: data.text.trim() }, { headers: HEADERS });
	} catch {
		return fail(502, "Groq returned an unreadable response.");
	}
}
