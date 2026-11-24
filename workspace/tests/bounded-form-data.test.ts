import assert from "node:assert/strict";
import { it } from "node:test";
import { FormBodyLimitError, readBoundedFormData } from "../lib/bounded-form-data.ts";

function request(body: BodyInit, contentType: string, contentLength?: string) {
	return new Request("http://localhost/upload", { method: "POST", body, headers: {
		"content-type": contentType, ...(contentLength === undefined ? {} : { "content-length": contentLength }),
	} });
}

it("accepts exactly the actual-byte bound, rejects one byte beyond it independent of length header", async () => {
	const form = new FormData();
	form.append("file", new File(["text"], "notes.txt"));
	const original = new Request("http://localhost/upload", { method: "POST", body: form });
	const body = new Uint8Array(await original.arrayBuffer());
	const type = original.headers.get("content-type")!;
	for (const length of [undefined, "1", String(body.byteLength)]) {
		const parsed = await readBoundedFormData(request(body, type, length), body.byteLength);
		assert.equal((parsed.get("file") as File).name, "notes.txt");
		assert.equal(await (parsed.get("file") as File).text(), "text");
		await assert.rejects(readBoundedFormData(request(body, type, length === String(body.byteLength) ? "1" : length), body.byteLength - 1), FormBodyLimitError);
	}
});

it("refuses oversize tee without awaiting cancellation of the untouched other consumer", async () => {
	const [left, right] = new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(new Uint8Array(8)); },
	}).tee();
	try {
		const upload = new Request("http://localhost/upload", { method: "POST", body: left, duplex: "half" } as RequestInit);
		await assert.rejects(readBoundedFormData(upload, 7), FormBodyLimitError);
		assert.equal(left.locked, false);
	} finally { await right.cancel(); }
});
