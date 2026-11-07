/**
 * A stand-in for Silero in dictation tests: speech probabilities from the loudness of
 * synthetic PCM, so a sine is "speech" and zeros are "silence". The real model is only
 * exercised in dictation-vad-runtime.test.ts.
 */
import { decodePcm16Wav } from "../../src/core/wav.ts";

const FRAME = 512;
/** RMS of a frame (about -50 dBFS) above which the stand-in hears speech. */
const VOICED_RMS = 100;

/** 0.95 for each 512-sample frame (the last zero-padded, as the server does) with real
 * sound in it, 0.001 otherwise. */
export function energyProbs(pcm: Int16Array): number[] {
	const probs: number[] = [];
	for (let start = 0; start < pcm.length; start += FRAME) {
		let sum = 0;
		for (let i = start; i < Math.min(start + FRAME, pcm.length); i++) sum += pcm[i]! * pcm[i]!;
		probs.push(Math.sqrt(sum / FRAME) >= VOICED_RMS ? 0.95 : 0.001);
	}
	return probs;
}

/** The session's `vad` option, backed by the stand-in. */
export const energyVad = async (pcm: Int16Array): Promise<number[]> => energyProbs(pcm);

/** What POST /api/stt/vad answers for the WAV in `form`, by the stand-in. */
export async function vadAnswer(form: FormData): Promise<Response> {
	const bytes = new Uint8Array(await (form.get("audio") as File).arrayBuffer());
	const pcm = decodePcm16Wav(bytes, 16000);
	if (!pcm) return Response.json({ message: "bad wav", retryable: false }, { status: 400 });
	return Response.json({ probs: energyProbs(pcm) });
}
