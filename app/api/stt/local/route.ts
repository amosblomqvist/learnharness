/**
 * Local dictation (src/server/local-stt.ts) — the keyless engine.
 *
 *   GET  → 200 LocalSttStatus. Also WARMS the helper: the client probes at
 *          dictation start, so the model loads while the learner talks.
 *   POST → body: the run's raw linear16 16 kHz mono PCM
 *          (application/octet-stream) → 200 {text}; 503 when local
 *          dictation is unavailable here; 413 over the size cap; 500 with
 *          {message} when transcription fails.
 */
import { localStt, MAX_PCM_BYTES } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const engine = localStt();
	engine.warm();
	return Response.json(engine.status());
}

export async function POST(request: Request) {
	const engine = localStt();
	if (!engine.status().available) {
		return Response.json({ message: "Local dictation is unavailable on this machine" }, { status: 503 });
	}
	const pcm = new Uint8Array(await request.arrayBuffer());
	if (pcm.byteLength > MAX_PCM_BYTES) {
		return Response.json({ message: "Dictation too long for one run (30 min max)" }, { status: 413 });
	}
	try {
		return Response.json({ text: await engine.transcribe(pcm) });
	} catch (e) {
		return Response.json({ message: e instanceof Error ? e.message : "local transcription failed" }, { status: 500 });
	}
}
