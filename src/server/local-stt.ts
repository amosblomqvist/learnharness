/**
 * Local dictation: the renderer posts one recorded clip here and this server
 * forwards it to the configured OpenAI-compatible transcription endpoint
 * (`POST {base}/audio/transcriptions`, multipart). The renderer never talks to
 * that endpoint, and an optional key stays server-side, as with Deepgram.
 */
import { isDictationLanguage, LOCAL_STT_MAX_BYTES, localTranscriptionLanguage } from "../core/dictation.ts";
import { resolveSettings } from "../core/settings-resolution.ts";
import { readSettings } from "../store/settings.ts";
import { apiRequestRefusal } from "./desktop-access.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { localSttKeyFor } from "./local-stt-auth.ts";

/** Accepted clip types; the renderer sends WAV. */
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/flac"]);
const EXTENSIONS: Record<string, string> = {
	"audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm",
	"audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac",
};
const RESPONSE_LIMIT = 1024 * 1024;
export const LOCAL_STT_TIMEOUT_MS = 120_000;

export interface LocalSttDeps {
	settings?: () => ReturnType<typeof resolveSettings>["dictation"];
	/** The key bound to exactly this base URL, if any. */
	apiKey?: (baseUrl: string) => string | undefined;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

const failure = (message: string, status: number) =>
	Response.json({ message }, { status, headers: { "cache-control": "no-store" } });

/** Read the request body up to `limit` bytes; null when it is larger. */
async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array | null> {
	if (Number(request.headers.get("content-length")) > limit) {
		await request.body?.cancel();
		return null;
	}
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) return null;
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** POST /api/stt/transcribe — body: raw audio, `?language=<dictation code>`. */
export async function transcribeLocalRequest(request: Request, deps: LocalSttDeps = {}): Promise<Response> {
	// Proxy already gates /api; the handler repeats it so the route is never
	// reachable without the same-origin/desktop rules.
	const refusal = apiRequestRefusal(request);
	if (refusal) return failure(refusal, 403);
	const settings = (deps.settings ?? (() => resolveSettings(readSettings()).dictation))();
	if (settings.provider !== "local") return failure("Local dictation is not enabled in Settings.", 409);
	const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!AUDIO_TYPES.has(type)) return failure("Audio content-type is required.", 415);
	const language = new URL(request.url).searchParams.get("language") ?? settings.language;
	if (!isDictationLanguage(language)) return failure("Unsupported dictation language", 400);
	const audio = await readBoundedBytes(request, LOCAL_STT_MAX_BYTES);
	if (!audio) return failure(`Recording exceeds ${LOCAL_STT_MAX_BYTES / (1024 * 1024)} MB.`, 413);
	if (audio.byteLength === 0) return failure("Recording is empty.", 400);

	const form = new FormData();
	form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type }), `dictation.${EXTENSIONS[type] ?? "wav"}`);
	form.append("model", settings.localModel);
	form.append("response_format", "json");
	const iso = localTranscriptionLanguage(language);
	if (iso) form.append("language", iso);
	const key = (deps.apiKey ?? localSttKeyFor)(settings.localBaseUrl)?.trim();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LOCAL_STT_TIMEOUT_MS);
	try {
		const res = await (deps.fetch ?? fetch)(`${settings.localBaseUrl}/audio/transcriptions`, {
			method: "POST",
			body: form,
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: controller.signal,
			// A configured URL must not bounce the clip (or key) elsewhere.
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			return failure("Local transcription server redirected; redirects are not followed.", 502);
		}
		if (!res.ok) {
			await res.body?.cancel();
			if (res.status === 401 || res.status === 403) return failure(`Local transcription server rejected the key (HTTP ${res.status}).`, 502);
			if (res.status === 404) return failure(`Local transcription server has no ${settings.localBaseUrl}/audio/transcriptions (HTTP 404).`, 502);
			return failure(`Local transcription server returned HTTP ${res.status}.`, 502);
		}
		const body = await readBoundedJson(res, RESPONSE_LIMIT);
		const text = body && typeof body === "object" && !Array.isArray(body) ? (body as { text?: unknown }).text : undefined;
		if (typeof text !== "string") return failure("Local transcription server returned no text.", 502);
		return Response.json({ text: text.trim() }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (controller.signal.aborted) return failure("Local transcription server timed out.", 504);
		if (error instanceof CustomBodyLimitError) return failure("Local transcription response is too large.", 502);
		if (error instanceof SyntaxError) return failure("Local transcription server returned invalid JSON.", 502);
		return failure(`Local transcription server unreachable at ${settings.localBaseUrl}.`, 502);
	} finally {
		clearTimeout(timer);
	}
}
