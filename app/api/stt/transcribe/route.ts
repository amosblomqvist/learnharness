import { readSettingsRecord, transcribeWithHandy } from "@/src/server";

export const maxDuration = 60;

export async function POST(request: Request) {
	try {
		const arrayBuf = await request.arrayBuffer();
		if (!arrayBuf || arrayBuf.byteLength === 0) {
			return Response.json({ message: "No audio data provided" }, { status: 400 });
		}
		if (arrayBuf.byteLength > 50 * 1024 * 1024) {
			return Response.json({ message: "Audio payload exceeds maximum size (50MB)" }, { status: 413 });
		}

		const url = new URL(request.url);
		const requestedModel = url.searchParams.get("model");
		const storedModel = readSettingsRecord()?.dictation?.handyModel;
		const model = requestedModel || storedModel || undefined;

		const result = await transcribeWithHandy(new Uint8Array(arrayBuf), {
			model,
			signal: request.signal,
		});
		return Response.json({ text: result.text });
	} catch (error) {
		if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
			return new Response(null, { status: 499 });
		}
		const message = error instanceof Error ? error.message : "Handy transcription failed";
		return Response.json({ message }, { status: 500 });
	}
}
