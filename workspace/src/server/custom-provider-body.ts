/** Byte-bounded JSON for the custom endpoint's request/discovery surfaces. */
export class CustomBodyLimitError extends Error {}

export async function readBoundedJson(message: Request | Response, limit: number, allowEmptyObject = false): Promise<unknown> {
	if (Number(message.headers.get("content-length")) > limit) {
		await message.body?.cancel();
		throw new CustomBodyLimitError("JSON body exceeds the allowed byte limit");
	}
	const reader = message.body?.getReader();
	if (!reader) {
		if (allowEmptyObject) return {};
		throw new SyntaxError("Missing JSON body");
	}
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) throw new CustomBodyLimitError("JSON body exceeds the allowed byte limit");
			text += decoder.decode(value, { stream: true });
		}
		if (bytes === 0 && allowEmptyObject) return {};
		return JSON.parse(text + decoder.decode());
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
