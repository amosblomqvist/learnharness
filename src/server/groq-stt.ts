/**
 * The Groq (Whisper) dictation transport, behind /api/stt/transcribe.
 *
 * Groq has no short-lived token mint like Deepgram's, so the browser cannot
 * talk to it without holding the real key. The renderer records a dictation
 * run, wraps it in a WAV and posts it here; this reads GROQ_API_KEY
 * server-side (the existing model-provider key, through keyValue) and
 * forwards the audio to Groq's OpenAI-compatible transcription endpoint. The
 * key never reaches the browser. Audio therefore passes through the local
 * server on its way to Groq (unlike Deepgram's browser-direct stream).
 *
 * POST multipart fields: `audio` (WAV, required), `model` (a Groq Whisper
 * model id, default turbo), `language` (a dictation language code; mapped to
 * Whisper's code, or omitted so Whisper auto-detects). Response `{ text }`;
 * failures `{ message }`. GET answers whether a key is configured, so the
 * client can refuse before the user has spoken rather than after.
 *
 * Trust: proxy.ts already gates every /api route behind the desktop
 * capability. A multipart POST is a CORS "simple request", so a page on
 * another origin could fire one without a preflight and spend the user's Groq
 * quota; like the subscription controls this therefore also demands
 * same-origin browser intent (custom header, Sec-Fetch-Site, and an Origin
 * equal to the Host-derived origin on POST). That is not user authentication,
 * grants no CORS, and is no defence against DNS rebinding (a forged Host with
 * a matching Origin passes), the same limit the subscription controls have.
 *
 * If the browser goes away mid-request the call to Groq is aborted too, so a
 * closed tab stops spending quota.
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
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Whisper turbo transcribes a capped recording in seconds; this only bounds a hang. */
const GROQ_TIMEOUT_MS = 90_000;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const TOO_LARGE = "The recording is too large for Groq. Dictate in shorter runs.";
const WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);

function fail(status: number, message: string, extra?: HeadersInit): Response {
	return Response.json({ message }, { status, headers: { ...HEADERS, ...extra } });
}

/** Same rule as the subscription controls: browsers send Origin on every POST,
 * including same-origin ones, so a POST without it is not from a page; a GET may
 * omit it (same-origin GETs usually do). */
function sameOriginIntent(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get(GROQ_DICTATION_HEADER) !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? supplied === null || supplied === origin : supplied === origin;
}

const forbidden = () => fail(403, "Dictation requests must come from the LearnHarness window.");
const keyless = () => fail(503, `No ${GROQ_KEY_ID} — add it to auth.json (desktop) or .env.local (dev).`);

/** GET: is a Groq key configured? No Groq request is made. */
export function groqDictationReadyResponse(request: Request): Response {
	if (!sameOriginIntent(request)) return forbidden();
	if (!keyValue(GROQ_KEY_ID)) return keyless();
	return Response.json({ ready: true }, { headers: HEADERS });
}

class BodyTooLargeError extends Error {}

/** Bound actual body bytes (Content-Length can be absent or wrong) before
 * multipart parsing, as the notes import does. */
async function readForm(request: Request): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > GROQ_MAX_BODY_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		throw new BodyTooLargeError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > GROQ_MAX_BODY_BYTES) throw new BodyTooLargeError();
			chunks.push(value);
		}
		return await new Response(new Blob(chunks as BlobPart[]), {
			headers: { "Content-Type": request.headers.get("content-type") ?? "" },
		}).formData();
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Groq's error body is OpenAI-shaped: { error: { message } }. It is relayed
 * to the learner, so the key is scrubbed from it first (Groq does not echo
 * keys; this is defence in depth). */
async function groqDetail(res: Response, key: string): Promise<string> {
	const text = await res.text().catch(() => "");
	let detail = text;
	try {
		const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
		if (typeof message === "string") detail = message;
	} catch {}
	return detail.replaceAll(key, "[redacted]").slice(0, 200);
}

function retryAfter(res: Response): string {
	const seconds = Number(res.headers.get("retry-after"));
	if (!Number.isFinite(seconds) || seconds <= 0) return "";
	return seconds < 90 ? ` Try again in ${Math.ceil(seconds)} s.` : ` Try again in ${Math.ceil(seconds / 60)} min.`;
}

/** Map a Groq failure to a user-facing message. 429 and 413 keep their status
 * (the client may react); everything else is a 502 so it is never mistaken for
 * our own 400/403/415/503. */
async function groqFailure(res: Response, key: string): Promise<Response> {
	const detail = await groqDetail(res, key);
	switch (res.status) {
		case 401:
			return fail(502, "Groq rejected the API key (401). Check GROQ_API_KEY in Settings → Providers.");
		case 403:
			return fail(502, "Groq refused the request (403). The key or organization may not have access to speech-to-text.");
		case 413:
			return fail(413, TOO_LARGE);
		case 429:
			return fail(429, `Groq rate limit reached.${retryAfter(res) || " Wait a moment and try again."}`);
		case 400:
		case 422:
			return fail(502, `Groq could not process the audio (${res.status})${detail ? `: ${detail}` : "."}`);
		default:
			return fail(502, res.status >= 500
				? `Groq is unavailable (${res.status}). Try again shortly.`
				: `Groq transcription failed (${res.status})${detail ? `: ${detail}` : "."}`);
	}
}

/** POST: validate the upload, forward it to Groq, return `{ text }`. */
export async function groqTranscribeResponse(request: Request): Promise<Response> {
	if (!sameOriginIntent(request)) return forbidden();
	// Key before body: a keyless request must not make the client's upload buffer first.
	const key = keyValue(GROQ_KEY_ID);
	if (!key) return keyless();
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
		return fail(415, "Expected multipart/form-data.");
	}

	let form: FormData;
	try {
		form = await readForm(request);
	} catch (err) {
		return err instanceof BodyTooLargeError ? fail(413, TOO_LARGE) : fail(400, "Could not read the upload.");
	}

	const audio = form.get("audio");
	if (!(audio instanceof File) || audio.size === 0) return fail(400, "Missing audio.");
	if (audio.size > GROQ_MAX_UPLOAD_BYTES) return fail(413, TOO_LARGE);
	if (!WAV_TYPES.has(audio.type.toLowerCase())) return fail(415, "Unsupported audio type; send a WAV file.");
	if (!looksLikeWav(new Uint8Array(await audio.slice(0, WAV_HEADER_BYTES).arrayBuffer()))) {
		return fail(400, "The audio is not a valid WAV file.");
	}

	const model = form.get("model") ?? DEFAULT_GROQ_WHISPER_MODEL;
	if (!isGroqWhisperModel(model)) return fail(400, "Unsupported Groq dictation model.");
	const requested = form.get("language");
	if (requested !== null && !isDictationLanguage(requested)) return fail(400, "Unsupported dictation language.");
	const language = requested === null ? undefined : whisperLanguage(requested);

	const upstream = new FormData();
	upstream.set("file", new File([audio], "dictation.wav", { type: "audio/wav" }));
	upstream.set("model", model);
	upstream.set("response_format", "json");
	if (language) upstream.set("language", language);

	let res: Response;
	try {
		res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			body: upstream,
			// Stop when the browser goes away as well as on the timeout.
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(GROQ_TIMEOUT_MS)]),
		});
	} catch (err) {
		if (request.signal.aborted) return fail(499, "The request was cancelled.");
		return err instanceof DOMException && err.name === "TimeoutError"
			? fail(502, "Groq took too long to respond. Try again.")
			: fail(502, "Groq unreachable. Check your connection and try again.");
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
