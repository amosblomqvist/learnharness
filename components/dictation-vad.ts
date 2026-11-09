import { encodePcm16Wav, GROQ_DICTATION_HEADER, STT_VAD_URL, type VadResponse } from "@/src/core";

/**
 * The renderer's side of Silero VAD for the chunker (src/core/dictation-chunks.ts):
 * one clip in, one speech probability per 512-sample frame out, through our own
 * /api/stt/vad route (the model is native and runs on the server). The route needs
 * no key and no Local model, so Groq and Local share it.
 */

/** A request that takes longer than this counts as failed, so a stuck server cannot
 * stall the cut while audio keeps arriving; the chunker then cuts at the target. The
 * first request also loads the native engine (about a second). */
const VAD_TIMEOUT_MS = 15_000;
const headers = { [GROQ_DICTATION_HEADER]: "1" };

/** Silero's probabilities for `pcm`. Rejects on any failure (no engine, a bad answer, a
 * timeout, `signal` aborting): the caller keeps the audio and carries on without them. */
export async function scoreVad(request: typeof fetch, pcm: Int16Array, sampleRate: number, signal?: AbortSignal): Promise<number[]> {
	const form = new FormData();
	form.set("audio", new Blob([encodePcm16Wav(pcm, sampleRate)], { type: "audio/wav" }), "dictation.wav");
	const timeout = AbortSignal.timeout(VAD_TIMEOUT_MS);
	const res = await request(STT_VAD_URL, {
		method: "POST", headers, body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) throw new Error(`Voice activity detection failed (${res.status})`);
	const body = await res.json() as Partial<VadResponse>;
	if (!Array.isArray(body.probs) || !body.probs.every((p) => typeof p === "number")) {
		throw new Error("Voice activity detection returned an unexpected answer.");
	}
	return body.probs;
}
