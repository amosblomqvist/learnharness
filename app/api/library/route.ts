import { librarySnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/library — the whole course-library tree + per-file summary
 *  state (the library page and the attach picker both read this). */
export async function GET() {
	try {
		return Response.json(librarySnapshot());
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
