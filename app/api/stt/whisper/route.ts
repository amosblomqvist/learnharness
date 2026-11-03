/**
 * Local dictation — the whisper.cpp engine (the keyless alternative to the
 * Deepgram stream in /api/stt/token; see src/server/whisper.ts).
 *
 * The renderer captures the same linear16 16kHz mono frames the Deepgram
 * path streams, buffers them for the whole run, and POSTs the raw PCM here
 * once, at stop — the deferred transcript only ever appeared at the end.
 * Audio never leaves the machine.
 *
 *   GET  → 200 {ready, bin, model}
 *   POST ?language=<dictation language> (raw PCM body)
 *        → 200 {text} | 503 {message} (not installed) | 400/500 {message}
 */
import {
	WHISPER_BIN,
	WHISPER_MODEL,
	WHISPER_SAMPLE_RATE,
	transcribePcm,
	whisperInstalled,
	whisperLanguage,
} from "@/src/server/whisper";

export const dynamic = "force-dynamic";

/** 10 minutes of 16-bit mono 16kHz audio — a generous dictation ceiling. */
const MAX_PCM_BYTES = 10 * 60 * WHISPER_SAMPLE_RATE * 2;
/** Shorter than this (~0.25s) is a mis-click, not speech. */
const MIN_PCM_BYTES = WHISPER_SAMPLE_RATE / 2;

export async function GET() {
	return Response.json({ ready: whisperInstalled(), bin: WHISPER_BIN, model: WHISPER_MODEL });
}

export async function POST(request: Request) {
	if (!whisperInstalled()) {
		return Response.json(
			{ message: `Whisper not installed — expected ${WHISPER_BIN} and ${WHISPER_MODEL}.` },
			{ status: 503 },
		);
	}
	const pcm = Buffer.from(await request.arrayBuffer());
	if (pcm.length > MAX_PCM_BYTES) {
		return Response.json({ message: "Dictation too long for local Whisper (10 min max)" }, { status: 400 });
	}
	if (pcm.length < MIN_PCM_BYTES) return Response.json({ text: "" });
	const language = whisperLanguage(new URL(request.url).searchParams.get("language"));
	try {
		return Response.json({ text: await transcribePcm(pcm, language) });
	} catch (e) {
		return Response.json(
			{ message: `Whisper failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
