import {
	GROQ_DICTATION_HEADER, LOCAL_STT_MODELS_URL, LOCAL_STT_TRANSCRIBE_URL, NO_LOCAL_MODEL,
	type LocalChineseOutput, type LocalModelsResponse, type LocalTranscribeResponse,
} from "@/src/core";
import { postChunk, routeFailure, TranscribeRequestError, type ChunkTransport } from "@/components/dictation-chunk-session";

/**
 * The renderer's side of Local (on-device) dictation: a readiness check against
 * /api/stt/local/models, and chunk uploads to /api/stt/local/transcribe, which runs
 * the chosen model on this machine (src/server/local-stt/). The twin of
 * dictation-groq.ts; the chunk session is shared.
 */

/** The client-authored line for "Local is selected but no model can run", the twin of
 * GROQ_DICTATION_KEYLESS. Shown in the bar's error slot, where a click opens Settings. */
export const LOCAL_DICTATION_NO_MODEL = "Choose a local model in Settings → Dictation first.";

/** Where that click goes: the Settings section that holds the Dictation group. */
export const LOCAL_DICTATION_SETTINGS_SECTION = "keys";

const headers = { [GROQ_DICTATION_HEADER]: "1" };

/** Can the chosen model run? Resolves when it is installed and the engine loads;
 * rejects with a line fit to show the user when not, so a run can refuse before the
 * user has spoken. An unchosen model is refused without any request. A model that was
 * chosen and then deleted reads as no model: the fix is the same. */
export async function checkLocalReady(model: string, request: typeof fetch = fetch): Promise<void> {
	if (model === NO_LOCAL_MODEL) throw new Error(LOCAL_DICTATION_NO_MODEL);
	let res: Response;
	try {
		res = await request(LOCAL_STT_MODELS_URL, { headers, cache: "no-store" });
	} catch {
		throw new Error("Could not reach LearnHarness to check the local model.");
	}
	if (!res.ok) throw new Error((await routeFailure(res, "Local")).message);
	const status = await res.json() as Partial<LocalModelsResponse>;
	if (status.engineAvailable === false) throw new Error(status.engineError || "On-device dictation can't run on this computer.");
	if (!status.models?.some((entry) => entry.id === model && entry.installed)) throw new Error(LOCAL_DICTATION_NO_MODEL);
}

/** Ask the server to load `model` now, so the load overlaps the user's speech instead of
 * delaying the first chunk (a large model takes tens of seconds). Fire and forget: the
 * answer is ignored and a failure changes nothing, because the first chunk meets any real
 * problem itself and shows it. */
export function warmLocalModel(model: string, request: typeof fetch = fetch): void {
	try {
		void request(`${LOCAL_STT_MODELS_URL}/${encodeURIComponent(model)}`, {
			method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ action: "warm" }),
		}).then((res) => res.body?.cancel(), () => {});
	} catch {}
}

/** Local as a chunk session's transport: each chunk goes to /api/stt/local/transcribe.
 *
 * Language: the first chunk is sent with the take's setting, `auto` or a fixed code;
 * when it is `auto`, the language the first answer reports is pinned for the rest of
 * the take, as pi-voice detects once per take. Without that, each chunk would run
 * the detector again and a take could flip language between chunks. The session
 * sends chunks one at a time, so each sees the pin of the ones before it. */
export function localTransport(request: typeof fetch, args: {
	model: string;
	language: string;
	preferredLanguages: readonly string[];
	chineseOutput: LocalChineseOutput;
}): ChunkTransport {
	let pinned: string | undefined;
	return {
		failure: "Local transcription failed",
		async transcribe({ wav, signal }) {
			const form = new FormData();
			form.set("audio", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
			form.set("model", args.model);
			form.set("preferredLanguages", JSON.stringify(args.preferredLanguages));
			form.set("language", pinned ?? args.language);
			form.set("chineseOutput", args.chineseOutput);
			const res = await postChunk(request, LOCAL_STT_TRANSCRIBE_URL, form, signal);
			if (!res.ok) throw await routeFailure(res, "Local");
			const body = await res.json().catch(() => ({})) as Partial<LocalTranscribeResponse>;
			if (typeof body.text !== "string") throw new TranscribeRequestError("Local dictation returned no transcript.", false);
			const text = body.text.trim();
			// A chunk with no words says nothing about the language: its detection ran on noise.
			if (!pinned && args.language === "auto" && text && typeof body.language === "string" && body.language) pinned = body.language;
			return { text, warning: typeof body.warning === "string" && body.warning ? body.warning : undefined };
		},
	};
}
