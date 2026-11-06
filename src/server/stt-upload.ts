/** Bounded multipart reading for the dictation upload routes (Groq and local). */

export class BodyTooLargeError extends Error {}

/** Bound actual body bytes (Content-Length can be absent or wrong) before
 * multipart parsing, as the notes import does. */
export async function readUploadForm(request: Request, maxBytes: number): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > maxBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new BodyTooLargeError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new BodyTooLargeError();
			chunks.push(value);
		}
		return await new Response(new Blob(chunks as BlobPart[]), {
			headers: { "Content-Type": request.headers.get("content-type") ?? "" },
		}).formData();
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
