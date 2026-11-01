import { MAX_DICTATION_BYTES, codexDictationAuth, transcribeCodexDictation } from "@/src/server";
export const runtime = "nodejs";

export async function GET(request: Request) {
 try { await codexDictationAuth(request.signal); return Response.json({ available: true }, { headers: { "Cache-Control": "no-store" } }); }
 catch { return Response.json({ available: false }, { headers: { "Cache-Control": "no-store" } }); }
}

export async function POST(request: Request) {
	if (!request.headers.get("content-type")?.startsWith("audio/pcm")) return Response.json({ message: "Expected 24 kHz mono PCM audio." }, { status: 415 });
	if (Number(request.headers.get("content-length")) > MAX_DICTATION_BYTES) return Response.json({ message: "Record up to two minutes at a time." }, { status: 413 });
	const reader = request.body?.getReader();
	if (!reader) return Response.json({ message: "No audio was recorded." }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_DICTATION_BYTES) { await reader.cancel(); return Response.json({ message: "Record up to two minutes at a time." }, { status: 413 }); }
			chunks.push(value);
		}
		if (!size || size % 2) return Response.json({ message: "No valid audio was recorded. Try again." }, { status: 400 });
		const requested = request.headers.get("x-lh-dictation-language")?.toLowerCase();
        if (requested && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(requested)) return Response.json({message:"Choose a supported dictation language."},{status:400});
        const text = await transcribeCodexDictation(Buffer.concat(chunks), request.signal, requested?.split("-")[0]);
		return Response.json({ text }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return Response.json({ message: request.signal.aborted ? "Dictation cancelled." : error instanceof Error ? error.message : "Codex dictation failed. Try again." }, { status: 502 });
	}
}
