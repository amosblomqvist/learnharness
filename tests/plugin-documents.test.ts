import assert from "node:assert/strict";
import { it } from "node:test";
import {
	createPluginDocumentConverter, MAX_DOCUMENT_BODY_BYTES, MAX_DOCUMENT_FILE_BYTES,
	MAX_DOCUMENT_MARKDOWN_BYTES, MAX_DOCUMENT_PDF_PAGES,
} from "../src/server/plugin-documents.ts";
import { PluginHostError } from "../src/server/plugin-host.ts";
import type { convertPdf, PdfConversion } from "../src/agent/subagents/pdf-ops.ts";
import { joinPages, type PdfPage } from "../src/agent/subagents/pdf-markdown.ts";

const signal = () => new AbortController().signal;
const converted = (pages: PdfPage[] = [{ kind: "text", number: 1, markdown: "PDF text" }]): PdfConversion => ({ kind: "converted", pages });
const stub = (result: PdfConversion = converted()): typeof convertPdf => async () => result;
function upload(content: string | Uint8Array<ArrayBuffer> = "plain text", name = "notes.md", type = "application/octet-stream") {
	const form = new FormData();
	form.append("file", new File([content], name, { type }));
	return formRequest(form);
}
function formRequest(form: FormData) {
	return new Request("http://localhost/documents", { method: "POST", body: form });
}
function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
	return new Request("http://localhost/documents", { method: "POST", body, duplex: "half", headers } as RequestInit);
}
function refusal(status: number, message?: RegExp) {
	return (error: unknown) => {
		assert.ok(error instanceof PluginHostError);
		assert.equal(error.status, status);
		if (message) assert.match(error.message, message);
		return true;
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function recovered(service: ReturnType<typeof createPluginDocumentConverter>) {
	assert.equal((await service.convert(upload(), signal())).markdown, "plain text");
}

it("returns strict UTF-8 text unchanged for arbitrary suffixes/MIME, Unicode and HTML (no conversion)", async () => {
	let pdfCalls = 0;
	const service = createPluginDocumentConverter({ convertPdf: async () => { pdfCalls++; return converted(); } });
	for (const name of ["notes.xyz", "archive.zip", "index.html", "no-suffix", "résumé (draft).notes"]) {
		const text = "  <h1>字 é 😀</h1>\r\n\tline\n ";
		assert.deepEqual(await service.convert(upload(text, name, "image/png"), signal()), { name, markdown: text, notices: [] });
	}
	assert.equal(pdfCalls, 0);
	assert.equal((await service.convert(upload("\uFEFFBOM text"), signal())).markdown, "BOM text", "default TextDecoder BOM handling");
});

it("refuses malformed UTF-8, binary and every disallowed C0/DEL/C1 control; recovers each time", async () => {
	const service = createPluginDocumentConverter();
	for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xe2, 0x82]), new Uint8Array([0xed, 0xa0, 0x80])]) {
		await assert.rejects(service.convert(upload(bytes), signal()), refusal(400, /UTF-8/));
		await recovered(service);
	}
	for (let code = 0; code <= 0x9f; code++) {
		if (code >= 0x20 && code < 0x7f || [9, 10, 13].includes(code)) continue;
		await assert.rejects(service.convert(upload(`a${String.fromCharCode(code)}b`), signal()), refusal(400, /control/));
		await recovered(service);
	}
});

it("refuses empty/whitespace text without accepting the BOM as content", async () => {
	const service = createPluginDocumentConverter();
	for (const text of ["", " \t\n\r ", "\uFEFF", "\u2003\u00a0"]) {
		await assert.rejects(service.convert(upload(text), signal()), refusal(400, /no text/));
		await recovered(service);
	}
});

it("detects leading PDF magic even when renamed and case-insensitive .PDF even without magic; forwards limit and signal", async () => {
	const calls: { bytes: Uint8Array; maxPages: number; options: { signal?: AbortSignal } | undefined }[] = [];
	const service = createPluginDocumentConverter({ convertPdf: async (bytes, maxPages, options?: { signal?: AbortSignal }) => {
		calls.push({ bytes, maxPages, options }); return converted();
	} });
	for (const [name, content] of [["renamed.txt", "%PDF-not-actually-validated-by-stub"], ["UPPER.PDF", "no magic"], ["mixed.PdF", "text"]]) {
		const abortSignal = signal();
		const result = await service.convert(upload(content, name), abortSignal);
		assert.equal(result.name, name);
		assert.equal(result.markdown, "--- Page 1 ---\n\nPDF text");
		assert.equal(calls.at(-1)!.maxPages, MAX_DOCUMENT_PDF_PAGES);
		assert.equal(calls.at(-1)!.options?.signal, abortSignal);
		assert.equal(new TextDecoder().decode(calls.at(-1)!.bytes), content);
	}
	assert.equal(calls.length, 3);
});

it("corrupt/encrypted PDFs and too-long PDFs refuse rather than fall back to text, and release the slot", async () => {
	for (const result of [{ kind: "unreadable" }, { kind: "too-long", pageCount: 1001 }] as PdfConversion[]) {
		const service = createPluginDocumentConverter({ convertPdf: stub(result) });
		for (const [content, name] of [["%PDF-corrupt", "renamed.txt"], ["perfectly valid text", "broken.PDF"]]) {
			await assert.rejects(service.convert(upload(content, name), signal()), refusal(400, result.kind === "too-long" ? /1,000/ : /Could not open/));
			await recovered(service);
		}
	}
	const service = createPluginDocumentConverter({ convertPdf: async () => { throw new Error("parser exploded"); } });
	await assert.rejects(service.convert(upload("%PDF-x"), signal()), refusal(400, /Could not open/));
	await recovered(service);
});

it("joins mixed PDF pages and gives truthful extraction/skipped-image notices, not blank-page omissions", async () => {
	const pages: PdfPage[] = [
		{ kind: "image-only", number: 1 }, { kind: "empty", number: 2 },
		{ kind: "text", number: 3, markdown: "# Text\n\nUnicode 字" }, { kind: "image-only", number: 4 },
	];
	const service = createPluginDocumentConverter({ convertPdf: stub(converted(pages)) });
	assert.deepEqual(await service.convert(upload("%PDF-x", "mixed.pdf"), signal()), {
		name: "mixed.pdf", markdown: joinPages(pages), notices: [
			"PDF text extraction may contain errors; check the result against the original.",
			"Skipped 2 image-only pages; OCR is not supported.",
		],
	});
	const textOnly = createPluginDocumentConverter({ convertPdf: stub() });
	assert.equal((await textOnly.convert(upload("%PDF-x"), signal())).notices.length, 1);
	const oneImage = createPluginDocumentConverter({ convertPdf: stub(converted([...pages.slice(0, 3)])) });
	assert.match((await oneImage.convert(upload("%PDF-x"), signal())).notices[1]!, /1 image-only page;/);
});

it("distinguishes all-image OCR refusal from blank/all-empty PDFs, including empty text pages", async () => {
	for (const pages of [[], [{ kind: "empty", number: 1 }], [{ kind: "text", number: 1, markdown: " \n\t" }]] as PdfPage[][]) {
		const service = createPluginDocumentConverter({ convertPdf: stub(converted(pages)) });
		await assert.rejects(service.convert(upload("%PDF-x"), signal()), refusal(400, /blank/));
		await recovered(service);
	}
	const service = createPluginDocumentConverter({ convertPdf: stub(converted([{ kind: "image-only", number: 1 }, { kind: "empty", number: 2 }])) });
	await assert.rejects(service.convert(upload("%PDF-x"), signal()), refusal(400, /OCR is not supported/));
	await recovered(service);
});

it("enforces exact UTF-8 Markdown cap for text, never truncates", async () => {
	const service = createPluginDocumentConverter();
	const exact = "é".repeat(MAX_DOCUMENT_MARKDOWN_BYTES / 2);
	assert.equal((await service.convert(upload(exact), signal())).markdown, exact);
	await assert.rejects(service.convert(upload(exact + "a"), signal()), refusal(413, /2 MiB/));
	await recovered(service);
});

it("counts PDF page markers and separators inside the exact UTF-8 output cap", async () => {
	const pages: PdfPage[] = [{ kind: "text", number: 1, markdown: "" }, { kind: "text", number: 1000, markdown: "字" }];
	const remaining = MAX_DOCUMENT_MARKDOWN_BYTES - new TextEncoder().encode(joinPages(pages)).byteLength;
	const page = pages[0] as Extract<PdfPage, { kind: "text" }>;
	page.markdown = "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2);
	const service = createPluginDocumentConverter({ convertPdf: stub(converted(pages)) });
	const result = await service.convert(upload("%PDF-x"), signal());
	assert.equal(new TextEncoder().encode(result.markdown).byteLength, MAX_DOCUMENT_MARKDOWN_BYTES);
	assert.equal(result.markdown, joinPages(pages));
	page.markdown += "a";
	await assert.rejects(service.convert(upload("%PDF-x"), signal()), refusal(413, /2 MiB/));
	await recovered(service);
});

it("requires exactly one multipart File in field file (no duplicates, strings or extra metadata)", async () => {
	const service = createPluginDocumentConverter();
	const variants: [string, string | File][][] = [
		[], [["files", new File(["text"], "a.txt")]], [["file", "text"]],
		[["file", new File(["a"], "a.txt")], ["file", new File(["b"], "b.txt")]],
		[["file", new File(["a"], "a.txt")], ["metadata", "extra"]],
		[["file", new File(["a"], "a.txt")], ["file", "duplicate"]],
	];
	for (const fields of variants) {
		const form = new FormData();
		for (const [key, value] of fields) form.append(key, value);
		await assert.rejects(service.convert(formRequest(form), signal()), refusal(400, /exactly one file/));
		await recovered(service);
	}
});

it("enforces actual file cap before conversion even with lying Content-Length", async () => {
	let calls = 0;
	const service = createPluginDocumentConverter({ convertPdf: async () => { calls++; return converted(); } });
	const request = upload(new Uint8Array(MAX_DOCUMENT_FILE_BYTES + 1), "oversized.pdf");
	request.headers.set("content-length", "1");
	await assert.rejects(service.convert(request, signal()), refusal(413, /25 MiB/));
	assert.equal(calls, 0);
	await recovered(service);
	// The exact file bound reaches conversion (and can produce a small output).
	await service.convert(upload(new Uint8Array(MAX_DOCUMENT_FILE_BYTES), "exact.pdf"), signal());
	assert.equal(calls, 1);
});

for (const declared of [undefined, "1"]) it(`bounds actual streamed body with ${declared ? "lying" : "no"} Content-Length and cancels it`, async () => {
	let chunks = 0, cancelled = false;
	const request = streamed(new ReadableStream({
		pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 }), { "content-type": "multipart/form-data; boundary=test", ...(declared ? { "content-length": declared } : {}) });
	const service = createPluginDocumentConverter();
	await assert.rejects(service.convert(request, signal()), refusal(413, /26 MiB/));
	assert.equal(chunks, MAX_DOCUMENT_BODY_BYTES / (1024 * 1024) + 1);
	assert.equal(cancelled, true);
	await recovered(service);
});

it("refuses excessive declared length before any body read", async () => {
	let reads = 0, cancelled = false;
	const request = streamed(new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), {
		"content-length": String(MAX_DOCUMENT_BODY_BYTES + 1),
	});
	const service = createPluginDocumentConverter();
	await assert.rejects(service.convert(request, signal()), refusal(413));
	assert.equal(reads, 0); assert.equal(cancelled, true);
	await recovered(service);
});

it("refuses malformed/truncated/missing/errored bodies and recovers the slot", async () => {
	const complete = upload();
	const bytes = new Uint8Array(await complete.arrayBuffer());
	const service = createPluginDocumentConverter();
	for (const request of [
		new Request(complete.url, { method: "POST", body: bytes.slice(0, -20), headers: complete.headers }),
		new Request(complete.url, { method: "POST", body: "not multipart" }),
		new Request(complete.url, { method: "POST" }),
		streamed(new ReadableStream({ pull(controller) { controller.error(new Error("broken stream")); } })),
	]) {
		await assert.rejects(service.convert(request, signal()), refusal(400, /Could not read/));
		await recovered(service);
	}
});

it("acquires global factory slot BEFORE buffering: simultaneous calls fail fast without reading", async () => {
	const entered = deferred<void>(), finish = deferred<PdfConversion>();
	const service = createPluginDocumentConverter({ convertPdf: async () => { entered.resolve(); return finish.promise; } });
	const first = service.convert(upload("%PDF-x"), signal());
	await entered.promise;
	let reads = 0;
	const other = streamed(new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }));
	await assert.rejects(service.convert(other, signal()), refusal(409, /^Document conversion is busy\. Please retry\.$/));
	assert.equal(reads, 0); assert.equal(other.bodyUsed, false);
	finish.resolve(converted());
	await first;
	await recovered(service);
});

it("also holds slot during body buffering, not just PDF conversion", async () => {
	const entered = deferred<void>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { entered.resolve(); } }, { highWaterMark: 0 });
	const service = createPluginDocumentConverter();
	const first = service.convert(streamed(body), signal());
	const rejection = assert.rejects(first, refusal(400));
	await entered.promise;
	const other = upload();
	await assert.rejects(service.convert(other, signal()), refusal(409));
	assert.equal(other.bodyUsed, false);
	controller.error(new Error("stop"));
	await rejection;
	await recovered(service);
});

for (const rejects of [false, true]) it(`abort retains busy until deferred converter ${rejects ? "rejects" : "settles"} (including its teardown)`, async () => {
	const entered = deferred<void>(), finish = deferred<PdfConversion>();
	const controller = new AbortController();
	const service = createPluginDocumentConverter({ convertPdf: async () => { entered.resolve(); return finish.promise; } });
	let settled = false;
	const first = service.convert(upload("%PDF-x"), controller.signal);
	void first.then(() => { settled = true; }, () => { settled = true; });
	const reason = new Error("caller cancelled");
	const rejection = assert.rejects(first, (error: unknown) => error === reason);
	await entered.promise;
	controller.abort(reason);
	await Promise.resolve();
	assert.equal(settled, false, "no abortRace releasing actual work");
	await assert.rejects(service.convert(upload(), signal()), refusal(409));
	if (rejects) finish.reject(new Error("parser stopped after destroy")); else finish.resolve(converted());
	await rejection;
	await recovered(service);
});

it("pre-abort prevents reading and immediately frees slot", async () => {
	const controller = new AbortController();
	controller.abort();
	let reads = 0;
	const service = createPluginDocumentConverter();
	await assert.rejects(service.convert(streamed(new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 })), controller.signal), { name: "AbortError" });
	assert.equal(reads, 0);
	await recovered(service);
});

it("abort cancels a blocked reader.read cooperatively and recovers slot", async () => {
	const entered = deferred<void>();
	let cancelled = false;
	const controller = new AbortController();
	const body = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
	const service = createPluginDocumentConverter();
	const first = service.convert(streamed(body), controller.signal);
	const rejection = assert.rejects(first, { name: "AbortError" });
	await entered.promise;
	controller.abort();
	await rejection;
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
	await recovered(service);
});
