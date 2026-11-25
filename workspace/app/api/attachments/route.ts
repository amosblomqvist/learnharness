import { saveAttachments } from "@/src/server";
import { MAX_ATTACHMENT_BODY_BYTES } from "@/lib/attachment-limits";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	try {
		const form = await readBoundedFormData(request, MAX_ATTACHMENT_BODY_BYTES, request.signal);
		const entries = form.getAll("files");
		if (entries.some(entry => !(entry instanceof File)) || [...form.keys()].some(key => key !== "files")) {
			return Response.json({ error: "Choose files to upload." }, { status: 400 });
		}
		return Response.json({ paths: await saveAttachments(entries as File[]) }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		const tooLarge = error instanceof FormBodyLimitError;
		return Response.json({ error: tooLarge ? "Choose files totaling 25 MiB or less." : error instanceof Error ? error.message : "Upload failed. Try again." }, { status: tooLarge ? 413 : 400 });
	}
}
