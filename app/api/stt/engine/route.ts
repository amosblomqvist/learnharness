/**
 * The dictation engine choice (local-whisper branch): GET → {engine},
 * PUT {engine} → {engine}. Stored beside settings.json, not inside it —
 * see src/server/whisper.ts for why.
 */
import { DICTATION_ENGINES, isDictationEngine, readDictationEngine, writeDictationEngine } from "@/src/server/whisper";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ engine: readDictationEngine() });
}

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as { engine?: unknown } | null;
	if (!isDictationEngine(body?.engine)) {
		return Response.json(
			{ error: `engine must be one of: ${DICTATION_ENGINES.join(", ")}` },
			{ status: 400 },
		);
	}
	writeDictationEngine(body.engine);
	return Response.json({ engine: body.engine });
}
