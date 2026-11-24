import { MEDIA_ID_RE } from "@/src/core";
import { buildMediaFileResponse } from "@/src/server";

/** Session-scoped binary media streaming with HTTP Range support for audio/video playback. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; mediaId: string }> }) {
	const { id, mediaId } = await params;
	if (!MEDIA_ID_RE.test(mediaId)) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return buildMediaFileResponse(req, id, mediaId);
}
