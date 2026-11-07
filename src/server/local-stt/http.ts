/**
 * The HTTP side of on-device dictation, behind /api/stt/local/* and /api/stt/vad.
 *
 *   GET    /api/stt/local/models        what is installed and downloading, plus the hardware tier
 *   POST   /api/stt/local/models/[id]   start or resume a download; JSON `{ action: "cancel" }` stops one,
 *                                       `{ action: "warm" }` loads an installed model ahead of its first chunk
 *   DELETE /api/stt/local/models/[id]   remove the file and any partial download
 *   POST   /api/stt/local/transcribe    one PCM16 16 kHz WAV chunk in, `{ text, language?, warning? }` out
 *   POST   /api/stt/vad                 one PCM16 16 kHz WAV in, Silero's `{ probs }` out
 *
 * Errors are `{ message, retryable }`, the Groq route's shape. Every request must show
 * same-origin browser intent (sameOriginIntent), as for Groq (groq-stt.ts): otherwise a
 * cross-origin page could make this machine download gigabytes or burn its CPU. Downloads
 * only fetch catalog URLs; a request names a catalog id, never a URL.
 */
import { DICTATION_SAMPLE_RATE, GROQ_DICTATION_HEADER } from "../../core/dictation.ts";
import { isCatalogLanguage, isCatalogModelId, isDownloadableModelId } from "../../core/local-stt-catalog.ts";
import { DEFAULT_LOCAL_CHINESE_OUTPUT, isLocalChineseOutput } from "../../core/local-stt-chinese.ts";
import { LOCAL_AUTO_LANGUAGE } from "../../core/local-stt-language-policy.ts";
import { normalizeLocalPreferredLanguages, type LocalModelsResponse, type VadResponse } from "../../core/local-stt.ts";
import { decodePcm16Wav } from "../../core/wav.ts";
import { readAudioUpload, STT_HEADERS, sttFail, sttForbidden } from "../stt-upload.ts";
import { sameOriginIntent } from "../web-subscription-http.ts";
import { localModelStore } from "./model-store.ts";
import { LocalSttError, localSttRuntime } from "./runtime.ts";

const TOO_LARGE = "The recording is too large to transcribe on this computer. Dictate in shorter runs.";

function ok(body: unknown): Response {
	return Response.json(body, { headers: STT_HEADERS });
}

/** An error thrown by the runtime, as the response a client can read. */
function failureResponse(error: unknown, request: Request): Response {
	if (request.signal.aborted) return sttFail(499, "The request was cancelled.");
	if (error instanceof LocalSttError) return sttFail(error.status, error.message, { retryable: error.retryable });
	console.error("[stt] local request failed:", error);
	return sttFail(500, "On-device dictation failed unexpectedly. Try again.", { retryable: true });
}

export async function localModelsResponse(request: Request): Promise<Response> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return sttForbidden();
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

/** Load an installed catalog model now, without transcribing, so the first chunk of a recording
 * does not wait for it. The client fires this when a Local recording starts and ignores the
 * answer; any real problem surfaces on the first chunk. */
async function warmModel(request: Request, id: string): Promise<Response> {
	if (!isCatalogModelId(id)) return sttFail(400, "Unsupported local dictation model.");
	try {
		await localSttRuntime().warm(id);
		return ok({ model: id });
	} catch (error) {
		return failureResponse(error, request);
	}
}

/** POST (download, or `{ "action": "cancel" | "warm" }`) and DELETE on one model. */
export async function localModelActionResponse(request: Request, id: string): Promise<Response> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return sttForbidden();
	if (!isDownloadableModelId(id)) return sttFail(404, "Unknown model.");
	const store = localModelStore();
	try {
		if (request.method === "DELETE") {
			// A loaded model must be freed before its file goes.
			await localSttRuntime().unload(id);
			return ok({ model: await store.delete(id) });
		}
		if (request.method !== "POST") return sttFail(405, "Unsupported method.");
		let action: unknown = "download";
		const text = (await request.text()).slice(0, MAX_ACTION_BODY_BYTES + 1);
		if (text.trim() !== "") {
			if (text.length > MAX_ACTION_BODY_BYTES) return sttFail(413, "Request too large.");
			try {
				action = (JSON.parse(text) as { action?: unknown }).action ?? "download";
			} catch {
				return sttFail(400, "Expected JSON.");
			}
		}
		if (action === "cancel") return ok({ model: await store.cancel(id) });
		if (action === "warm") return await warmModel(request, id);
		if (action !== "download") return sttFail(400, "Unsupported action.");
		return ok({ model: await store.start(id) });
	} catch (error) {
		console.error(`[stt] ${request.method} model ${id} failed:`, error);
		return sttFail(500, "The model could not be changed. Try again.");
	}
}

/** The multipart form of an audio request and its decoded WAV, or the response that refuses it. */
async function readAudio(request: Request): Promise<{ form: FormData; pcm: Int16Array } | { response: Response }> {
	if (!sameOriginIntent(request, GROQ_DICTATION_HEADER)) return { response: sttForbidden() };
	const upload = await readAudioUpload(request, TOO_LARGE);
	if ("response" in upload) return upload;
	const pcm = decodePcm16Wav(new Uint8Array(await upload.audio.arrayBuffer()), DICTATION_SAMPLE_RATE);
	if (!pcm) return { response: sttFail(400, "The audio must be a 16 kHz mono 16-bit WAV file.") };
	return { form: upload.form, pcm };
}

/** Multipart `audio` (WAV), `model` (a catalog id), `preferredLanguages` (JSON array), and optionally
 * `language` ("auto" by default, or a language code) and `chineseOutput`. */
export async function localTranscribeResponse(request: Request): Promise<Response> {
	const read = await readAudio(request);
	if ("response" in read) return read.response;
	const { form, pcm } = read;

	const model = form.get("model");
	if (!isCatalogModelId(model)) return sttFail(400, "Unsupported local dictation model.");
	const language = form.get("language") ?? LOCAL_AUTO_LANGUAGE;
	if (language !== LOCAL_AUTO_LANGUAGE && !isCatalogLanguage(language)) return sttFail(400, "Unsupported dictation language.");
	const chineseOutput = form.get("chineseOutput") ?? DEFAULT_LOCAL_CHINESE_OUTPUT;
	if (!isLocalChineseOutput(chineseOutput)) return sttFail(400, "Unsupported Chinese output.");
	let preferred: string[] | undefined;
	try {
		const raw = form.get("preferredLanguages");
		preferred = typeof raw === "string" ? normalizeLocalPreferredLanguages(JSON.parse(raw)) : undefined;
	} catch {
		preferred = undefined;
	}
	if (!preferred) return sttFail(400, "Unsupported preferred languages.");

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

/** Multipart `audio` (WAV). Answers Silero's speech probability for each 512-sample frame. */
export async function vadResponse(request: Request): Promise<Response> {
	const read = await readAudio(request);
	if ("response" in read) return read.response;
	try {
		const probs = await localSttRuntime().scoreVad(read.pcm, request.signal);
		const body: VadResponse = { probs };
		return ok(body);
	} catch (error) {
		return failureResponse(error, request);
	}
}
