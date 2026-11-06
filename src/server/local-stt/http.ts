/**
 * The HTTP side of on-device dictation, behind /api/stt/local/* and /api/stt/vad.
 *
 *   GET    /api/stt/local/models        what is installed and downloading, plus the hardware tier
 *   POST   /api/stt/local/models/[id]   start or resume a download (JSON `{ action: "cancel" }` stops one)
 *   DELETE /api/stt/local/models/[id]   remove the file and any partial download
 *   POST   /api/stt/local/warm          load a model ahead of its first chunk, JSON `{ model }`
 *   POST   /api/stt/local/transcribe    one PCM16 16 kHz WAV chunk in, `{ text, language?, warning? }` out
 *   POST   /api/stt/vad                 one PCM16 16 kHz WAV in, Silero's `{ probs, frameSamples }` out
 *
 * Errors are `{ message, retryable, code? }`, the Groq route's shape. The audio routes
 * take multipart/form-data like it does.
 *
 * Trust: as for Groq (groq-stt.ts), every request must show same-origin browser intent
 * (sameOriginIntent with GROQ_DICTATION_HEADER): a cross-origin page could otherwise
 * make this machine download gigabytes or burn its CPU. That is not user authentication
 * and no defence against DNS rebinding. Downloads only ever fetch catalog URLs; the
 * request names a catalog id, never a URL.
 */
import { DICTATION_SAMPLE_RATE, GROQ_DICTATION_HEADER } from "../../core/dictation.ts";
import { isCatalogLanguage, isCatalogModelId, isDownloadableModelId } from "../../core/local-stt-catalog.ts";
import { DEFAULT_LOCAL_CHINESE_OUTPUT, isLocalChineseOutput } from "../../core/local-stt-chinese.ts";
import { LOCAL_AUTO_LANGUAGE } from "../../core/local-stt-language-policy.ts";
import {
	LOCAL_STT_MAX_AUDIO_BYTES,
	LOCAL_STT_MAX_BODY_BYTES,
	VAD_FRAME_SAMPLES,
	normalizeLocalPreferredLanguages,
	type LocalModelsResponse,
	type LocalSttErrorBody,
	type LocalSttErrorCode,
	type VadResponse,
} from "../../core/local-stt.ts";
import { decodePcm16Wav } from "../../core/wav.ts";
import { BodyTooLargeError, readUploadForm } from "../stt-upload.ts";
import { sameOriginIntent } from "../web-subscription-http.ts";
import { localModelStore } from "./model-store.ts";
import { LocalSttError, localSttRuntime } from "./runtime.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const TOO_LARGE = "The recording is too large to transcribe on this computer. Dictate in shorter runs.";

function fail(status: number, message: string, options: { retryable?: boolean; code?: LocalSttErrorCode } = {}): Response {
	const body: LocalSttErrorBody = { message, retryable: options.retryable === true, ...(options.code ? { code: options.code } : {}) };
	return Response.json(body, { status, headers: HEADERS });
}

const forbidden = () => fail(403, "Dictation requests must come from the LearnHarness window.");

function ok(body: unknown): Response {
	return Response.json(body, { headers: HEADERS });
}

/** An error thrown by the runtime, as the response a client can read. */
function failureResponse(error: unknown, request: Request): Response {
	if (request.signal.aborted) return fail(499, "The request was cancelled.");
	if (error instanceof LocalSttError) return fail(error.status, error.message, { retryable: error.retryable, code: error.code });
	console.error("[stt] local request failed:", error);
	return fail(500, "On-device dictation failed unexpectedly. Try again.", { retryable: true });
}

export async function localModelsResponse(request: Request): Promise<Response> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return forbidden();
	const hardware = await localSttRuntime().hardware();
	const body: LocalModelsResponse = {
		hardwareTier: hardware.tier,
		engineAvailable: hardware.available,
		...(hardware.error ? { engineError: hardware.error } : {}),
		...(await localModelStore().statuses()),
	};
	return ok(body);
}

const MAX_ACTION_BODY_BYTES = 1024;

/** POST (download, or `{ "action": "cancel" }`) and DELETE on one model. */
export async function localModelActionResponse(request: Request, id: string): Promise<Response> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return forbidden();
	if (!isDownloadableModelId(id)) return fail(404, "Unknown model.");
	const store = localModelStore();
	try {
		if (request.method === "DELETE") {
			// A loaded model must be freed before its file goes.
			await localSttRuntime().unload(id);
			return ok({ model: await store.delete(id) });
		}
		if (request.method !== "POST") return fail(405, "Unsupported method.");
		let action: unknown = "download";
		const text = (await request.text()).slice(0, MAX_ACTION_BODY_BYTES + 1);
		if (text.trim() !== "") {
			if (text.length > MAX_ACTION_BODY_BYTES) return fail(413, "Request too large.");
			try {
				action = (JSON.parse(text) as { action?: unknown }).action ?? "download";
			} catch {
				return fail(400, "Expected JSON.");
			}
		}
		if (action === "cancel") return ok({ model: await store.cancel(id) });
		if (action !== "download") return fail(400, "Unsupported action.");
		return ok({ model: await store.start(id) });
	} catch (error) {
		console.error(`[stt] ${request.method} model ${id} failed:`, error);
		return fail(500, "The model could not be changed. Try again.");
	}
}

/** The multipart form of an audio request and its WAV, or the response that refuses it. */
async function readAudio(request: Request): Promise<{ form: FormData; pcm: Int16Array } | { response: Response }> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return { response: forbidden() };
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
		return { response: fail(415, "Expected multipart/form-data.") };
	}
	let form: FormData;
	try {
		form = await readUploadForm(request, LOCAL_STT_MAX_BODY_BYTES);
	} catch (err) {
		return { response: err instanceof BodyTooLargeError ? fail(413, TOO_LARGE) : fail(400, "Could not read the upload.") };
	}
	const audio = form.get("audio");
	if (!(audio instanceof File) || audio.size === 0) return { response: fail(400, "Missing audio.") };
	if (audio.size > LOCAL_STT_MAX_AUDIO_BYTES) return { response: fail(413, TOO_LARGE) };
	if (audio.type !== "audio/wav") return { response: fail(415, "Unsupported audio type; send a WAV file.") };
	const pcm = decodePcm16Wav(new Uint8Array(await audio.arrayBuffer()), DICTATION_SAMPLE_RATE);
	if (!pcm) return { response: fail(400, "The audio must be a 16 kHz mono 16-bit WAV file.") };
	return { form, pcm };
}

/** Multipart `audio` (WAV), `model` (a catalog id), `preferredLanguages` (JSON array), and optionally
 * `language` ("auto" by default, or a language code) and `chineseOutput`. */
export async function localTranscribeResponse(request: Request): Promise<Response> {
	const read = await readAudio(request);
	if ("response" in read) return read.response;
	const { form, pcm } = read;

	const model = form.get("model");
	if (!isCatalogModelId(model)) return fail(400, "Unsupported local dictation model.");
	const language = form.get("language") ?? LOCAL_AUTO_LANGUAGE;
	if (language !== LOCAL_AUTO_LANGUAGE && !isCatalogLanguage(language)) return fail(400, "Unsupported dictation language.");
	const chineseOutput = form.get("chineseOutput") ?? DEFAULT_LOCAL_CHINESE_OUTPUT;
	if (!isLocalChineseOutput(chineseOutput)) return fail(400, "Unsupported Chinese output.");
	let preferred: string[] | undefined;
	try {
		const raw = form.get("preferredLanguages");
		preferred = typeof raw === "string" ? normalizeLocalPreferredLanguages(JSON.parse(raw)) : undefined;
	} catch {
		preferred = undefined;
	}
	if (!preferred) return fail(400, "Unsupported preferred languages.");

	try {
		const result = await localSttRuntime().transcribeChunk(pcm, {
			modelId: model,
			language: language as string,
			preferredLanguages: preferred,
			chineseOutput,
			signal: request.signal,
		});
		return ok(result);
	} catch (error) {
		return failureResponse(error, request);
	}
}

/** JSON `{ model }` (a catalog id): load that installed model now, without transcribing, so the first
 * chunk of a recording does not wait for it. The client fires this when a Local recording starts and
 * ignores the answer; any real problem surfaces on the first chunk. */
export async function localWarmResponse(request: Request): Promise<Response> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return forbidden();
	let model: unknown;
	try {
		const text = (await request.text()).slice(0, MAX_ACTION_BODY_BYTES + 1);
		if (text.length > MAX_ACTION_BODY_BYTES) return fail(413, "Request too large.");
		model = (JSON.parse(text) as { model?: unknown }).model;
	} catch {
		return fail(400, "Expected JSON.");
	}
	if (!isCatalogModelId(model)) return fail(400, "Unsupported local dictation model.");
	try {
		await localSttRuntime().warm(model);
		return ok({ model });
	} catch (error) {
		return failureResponse(error, request);
	}
}

/** Multipart `audio` (WAV). Answers Silero's speech probability for each 512-sample frame. */
export async function vadResponse(request: Request): Promise<Response> {
	const read = await readAudio(request);
	if ("response" in read) return read.response;
	try {
		const probs = await localSttRuntime().scoreVad(read.pcm, request.signal);
		const body: VadResponse = { probs, frameSamples: VAD_FRAME_SAMPLES };
		return ok(body);
	} catch (error) {
		return failureResponse(error, request);
	}
}
