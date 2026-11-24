import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data";
import { MAX_MEDIA_FORM_BODY_BYTES } from "@/src/core";
import { MediaUploadError, saveUploadedMedia } from "@/src/server";

/** Upload a session-scoped image, audio, or video asset into data/media/<chatId>/. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let form: FormData;
	try {
		form = await readBoundedFormData(req, MAX_MEDIA_FORM_BODY_BYTES, req.signal);
	} catch (error) {
		if (error instanceof FormBodyLimitError) {
			return Response.json({ error: "Media file exceeds the 25 MiB upload limit." }, { status: 413 });
		}
		return Response.json({ error: "Invalid multipart media upload." }, { status: 400 });
	}

	const file = form.get("file");
	if (!(file instanceof File)) {
		return Response.json({ error: "Missing file field in upload." }, { status: 400 });
	}

	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const media = saveUploadedMedia(id, bytes, {
			mimeType: file.type || undefined,
			filename: file.name || "media",
		});
		return Response.json({ media }, { status: 201, headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof MediaUploadError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		return Response.json({ error: "Failed to save media upload." }, { status: 500 });
	}
}
