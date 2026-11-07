/** Shared plumbing for the dictation routes (Groq and local): error answers and the audio upload. */
import { STT_MAX_AUDIO_BYTES, STT_MAX_BODY_BYTES } from "../core/dictation.ts";

export const STT_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** An error answer: `{ message, retryable }`. */
export function sttFail(status: number, message: string, options: { retryable?: boolean; headers?: HeadersInit } = {}): Response {
	return Response.json({ message, retryable: options.retryable === true }, { status, headers: { ...STT_HEADERS, ...options.headers } });
}

export const sttForbidden = () => sttFail(403, "Dictation requests must come from the LearnHarness window.");

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

/** The multipart form of an audio request and its WAV file, or the response that refuses it.
 * `tooLarge` is the message for an upload over the limit. */
export async function readAudioUpload(
	request: Request,
	tooLarge: string,
): Promise<{ form: FormData; audio: File } | { response: Response }> {
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
		return { response: sttFail(415, "Expected multipart/form-data.") };
	}
	let form: FormData;
	try {
		form = await readUploadForm(request, STT_MAX_BODY_BYTES);
	} catch (err) {
		return { response: err instanceof BodyTooLargeError ? sttFail(413, tooLarge) : sttFail(400, "Could not read the upload.") };
	}
	const audio = form.get("audio");
	if (!(audio instanceof File) || audio.size === 0) return { response: sttFail(400, "Missing audio.") };
	if (audio.size > STT_MAX_AUDIO_BYTES) return { response: sttFail(413, tooLarge) };
	if (audio.type !== "audio/wav") return { response: sttFail(415, "Unsupported audio type; send a WAV file.") };
	return { form, audio };
}
