/**
 * Dictation methods (issue #15, PR #50).
 *
 *   GET → 200 DictationStatus (core/dictation.ts): the selected method,
 *         every configured one, the device, Deepgram key presence, and
 *         every curated model's download state.
 *   PUT {selected?: string, device?: "webgpu" | "cpu"}
 *         → 200 DictationStatus. `selected` picks the one method Dictate
 *         uses (400 unless it is configured); `device` is where local
 *         models run (the WebGPU/CPU picker).
 *
 * Access control is the app-wide /api capability check (proxy.ts).
 */
import { dictationStatus, selectDictationMethod, setDictationDevice } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
	return Response.json(dictationStatus(), NO_STORE);
}

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
	}
	if (body.selected !== undefined) {
		if (typeof body.selected !== "string" || !selectDictationMethod(body.selected)) {
			return Response.json({ error: "That dictation method isn't set up." }, { status: 400 });
		}
	}
	if (body.device !== undefined) {
		if (body.device !== "webgpu" && body.device !== "cpu") {
			return Response.json({ error: "Device must be webgpu or cpu." }, { status: 400 });
		}
		setDictationDevice(body.device);
	}
	return Response.json(dictationStatus(), NO_STORE);
}
