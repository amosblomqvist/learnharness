/** Actual-body bound, independent of absent or untrustworthy Content-Length. */
export class FormBodyLimitError extends Error {}

/** Buffer before multipart parsing: malformed/truncated uploads never yield a
 * partial form. Optional cancellation interrupts even a blocked reader.read(). */
export async function readBoundedFormData(request: Request, maxBytes: number, signal?: AbortSignal): Promise<FormData> {
	signal?.throwIfAborted();
	if (Number(request.headers.get("content-length")) > maxBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new FormBodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing import body");
	const cancel = () => { void reader.cancel().catch(() => undefined); };
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		signal?.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new FormBodyLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
		signal?.throwIfAborted();
		return form;
	} finally {
		signal?.removeEventListener("abort", cancel);
		// Do not wait for a tee's other consumer to finish before refusing an upload.
		cancel();
		reader.releaseLock();
	}
}
