import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { convertPdf, createPdfConverter } from "../src/agent/subagents/pdf-ops.ts";
import { documentToMarkdown } from "../src/agent/subagents/pdf-markdown.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function observed(promise: Promise<unknown>) {
	let settled = false;
	void promise.then(() => { settled = true; }, () => { settled = true; });
	return () => settled;
}

// Flush only promise continuations; tests use explicit gates, never timing races.
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakeDoc(getPage: (n: number) => Promise<PDFPageProxy>, numPages = 2): PDFDocumentProxy {
	return { numPages, getPage } as PDFDocumentProxy;
}

function emptyPage(number: number): PDFPageProxy {
	return { pageNumber: number, getTextContent: async () => ({ items: [] }), getOperatorList: async () => ({ fnArray: [] }) } as unknown as PDFPageProxy;
}

function assertNoListener(signal: AbortSignal) {
	assert.equal(getEventListeners(signal, "abort").length, 0);
}

describe("PDF conversion cooperative cancellation", () => {
	it("pre-aborted calls preserve the exact reason and never invoke the loader", async () => {
		let opens = 0;
		const convert = createPdfConverter(() => { opens++; throw new Error("must not open"); });
		const controller = new AbortController();
		const reason = { cancelled: "before open" };
		controller.abort(reason);
		await assert.rejects(convert(new Uint8Array(), 1000, { signal: controller.signal }), (error) => error === reason);
		assert.equal(opens, 0);
		assertNoListener(controller.signal);

		// The actual entry point also avoids pdfjs opening/transferring the bytes.
		const bytes = tinyPdf([{}]);
		const length = bytes.byteLength;
		const defaultAbort = new AbortController();
		defaultAbort.abort();
		await assert.rejects(convertPdf(bytes, 1000, { signal: defaultAbort.signal }), (error) => error === defaultAbort.signal.reason && error instanceof Error && error.name === "AbortError");
		assert.equal(bytes.byteLength, length);
	});

	it("abort while the loader is pending waits for both opening and destroy (destroy settles first)", async () => {
		const loading = deferred<PDFDocumentProxy>();
		const destroying = deferred<void>();
		const destroyStarted = deferred<void>();
		let destroys = 0;
		const task = { promise: loading.promise, destroy: () => { destroys++; destroyStarted.resolve(); return destroying.promise; } };
		const loader = deferred<typeof task>();
		const convert = createPdfConverter(() => loader.promise);
		const controller = new AbortController();
		const reason = new Error("cancel loader");
		const result = convert(new Uint8Array(), 1000, { signal: controller.signal });
		const settled = observed(result);
		controller.abort(reason);
		await flush();
		assert.equal(settled(), false, "cannot abandon a pending loader");
		loader.resolve(task);
		await destroyStarted.promise;
		destroying.resolve();
		await flush();
		assert.equal(settled(), false, "destroy alone does not settle the underlying opening");
		loading.reject(new Error("parser stopped"));
		await assert.rejects(result, (error) => error === reason);
		assert.equal(destroys, 1);
		assertNoListener(controller.signal);
	});

	it("abort while opening waits for destroy after task.promise rejects, preserving reason over destroy failure", async () => {
		const loading = deferred<PDFDocumentProxy>();
		const destroying = deferred<void>();
		const destroyStarted = deferred<void>();
		const controller = new AbortController();
		let destroys = 0;
		const convert = createPdfConverter(() => ({ promise: loading.promise, destroy: () => {
			destroys++;
			destroyStarted.resolve();
			return destroying.promise;
		} }));
		const result = convert(new Uint8Array(), 1000, { signal: controller.signal });
		const settled = observed(result);
		await flush();
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		controller.abort("caller reason");
		await destroyStarted.promise;
		loading.reject(new Error("pdfjs loading aborted"));
		await flush();
		assert.equal(settled(), false);
		destroying.reject(new Error("destroy failed"));
		await assert.rejects(result, (error) => error === "caller reason");
		assert.equal(destroys, 1);
		assertNoListener(controller.signal);
	});

	it("a late successful open after abort is destroyed without reading any pages", async () => {
		const loading = deferred<PDFDocumentProxy>();
		const destroyStarted = deferred<void>();
		const controller = new AbortController();
		let destroys = 0;
		const convert = createPdfConverter(() => ({ promise: loading.promise, destroy: async () => {
			destroys++;
			destroyStarted.resolve();
		} }));
		const result = convert(new Uint8Array(), 1000, { signal: controller.signal });
		observed(result);
		await flush();
		controller.abort();
		await destroyStarted.promise;
		loading.resolve(fakeDoc(async () => { assert.fail("must not read a page after abort"); }));
		await assert.rejects(result, (error) => error === controller.signal.reason);
		assert.equal(destroys, 1);
		assertNoListener(controller.signal);
	});

	it("failed opens are destroyed and awaited even without cancellation", async () => {
		const destroying = deferred<void>();
		const destroyStarted = deferred<void>();
		const controller = new AbortController();
		let destroys = 0;
		const convert = createPdfConverter(() => ({ promise: Promise.reject(new Error("invalid PDF")), destroy: () => {
			destroys++;
			destroyStarted.resolve();
			return destroying.promise;
		} }));
		const result = convert(new Uint8Array(), 1000, { signal: controller.signal });
		const settled = observed(result);
		await destroyStarted.promise;
		assert.equal(settled(), false);
		destroying.reject(new Error("best effort cleanup failed"));
		assert.deepEqual(await result, { kind: "unreadable" });
		assert.equal(destroys, 1);
		assertNoListener(controller.signal);
	});

	it("abort during text extraction does not release the conversion early or request the next page", async () => {
		const text = deferred<Awaited<ReturnType<PDFPageProxy["getTextContent"]>>>();
		const textStarted = deferred<void>();
		const destroying = deferred<void>();
		const destroyStarted = deferred<void>();
		const requested: number[] = [];
		let destroys = 0;
		let operators = 0;
		const doc = fakeDoc(async (number) => {
			requested.push(number);
			return { pageNumber: number,
				getTextContent: () => { textStarted.resolve(); return text.promise; },
				getOperatorList: async () => { operators++; return { fnArray: [] }; },
			} as unknown as PDFPageProxy;
		});
		const convert = createPdfConverter(() => ({ promise: Promise.resolve(doc), destroy: () => {
			destroys++;
			destroyStarted.resolve();
			return destroying.promise;
		} }));
		const controller = new AbortController();
		const result = convert(new Uint8Array(), 1000, { signal: controller.signal });
		const settled = observed(result);
		await textStarted.promise;
		controller.abort();
		await destroyStarted.promise;
		destroying.resolve();
		await flush();
		assert.equal(settled(), false, "still waiting for in-flight extraction");
		text.resolve({ items: [], styles: {}, lang: null });
		await assert.rejects(result, (error) => error === controller.signal.reason);
		assert.deepEqual(requested, [1]);
		assert.equal(operators, 0);
		assert.equal(destroys, 1);
		assertNoListener(controller.signal);
	});

	it("abort during final teardown is observed, and destroy is idempotent", async () => {
		const controller = new AbortController();
		const destroying = deferred<void>();
		const destroyStarted = deferred<void>();
		let destroys = 0;
		let pages = 0;
		const convert = createPdfConverter(() => ({
			promise: Promise.resolve(fakeDoc(async () => { pages++; return emptyPage(1); }, 1001)),
			destroy: () => { destroys++; destroyStarted.resolve(); return destroying.promise; },
		}));
		const result = convert(new Uint8Array(), 1000, { signal: controller.signal });
		const settled = observed(result);
		await destroyStarted.promise;
		controller.abort(new Error("cancel teardown"));
		await flush();
		assert.equal(settled(), false);
		assert.equal(destroys, 1);
		destroying.resolve();
		await assert.rejects(result, (error) => error === controller.signal.reason);
		assert.equal(pages, 0, "page cap still precedes extraction");
		assertNoListener(controller.signal);
	});

	it("never relabels an AbortError as unreadable, including without a signal", async () => {
		const reason = new DOMException("parser abort", "AbortError");
		let destroys = 0;
		const convert = createPdfConverter(() => ({ promise: Promise.reject(reason), destroy: async () => { destroys++; } }));
		await assert.rejects(convert(new Uint8Array(), 1000), (error) => error === reason);
		assert.equal(destroys, 1);
	});

	it("non-cancellation extraction failures remain unreadable and clean up the listener", async () => {
		const controller = new AbortController();
		let destroys = 0;
		const convert = createPdfConverter(() => ({
			promise: Promise.resolve(fakeDoc(async () => { throw new Error("page unavailable"); })),
			destroy: async () => { destroys++; },
		}));
		assert.deepEqual(await convert(new Uint8Array(), 1000, { signal: controller.signal }), { kind: "unreadable" });
		assert.equal(destroys, 1);
		assertNoListener(controller.signal);
	});

	it("normal success/cap paths remove abort listeners and preserve old two-argument callers", async () => {
		for (const maxPages of [1, 2]) {
			const controller = new AbortController();
			let destroys = 0;
			const convert = createPdfConverter(() => ({ promise: Promise.resolve(fakeDoc(async (n) => emptyPage(n))), destroy: async () => { destroys++; } }));
			const result = await convert(new Uint8Array(), maxPages, { signal: controller.signal });
			assert.equal(result.kind, maxPages === 1 ? "too-long" : "converted");
			assert.equal(destroys, 1);
			assertNoListener(controller.signal);
			controller.abort();
			assert.equal(destroys, 1);
		}
		const bytes = tinyPdf([{ runs: [{ text: "Existing notes import", x: 72, y: 700 }] }, { image: true }, {}]);
		const result = await convertPdf(bytes.slice(), 1000);
		assert.deepEqual(result, { kind: "converted", pages: [
			{ kind: "text", number: 1, markdown: "Existing notes import" },
			{ kind: "image-only", number: 2 },
			{ kind: "empty", number: 3 },
		] });
		const controller = new AbortController();
		assert.deepEqual(await convertPdf(bytes.slice(), 1000, { signal: controller.signal }), result);
		assertNoListener(controller.signal);
		assert.deepEqual(await convertPdf(bytes.slice(), 2), { kind: "too-long", pageCount: 3 });
		assert.deepEqual(await convertPdf(new TextEncoder().encode("not a PDF"), 1000), { kind: "unreadable" });
	});
});

describe("documentToMarkdown cancellation checkpoints", () => {
	it("does not access a pre-aborted document", async () => {
		const controller = new AbortController();
		controller.abort();
		const doc = new Proxy({} as PDFDocumentProxy, { get() { assert.fail("must not access document"); } });
		await assert.rejects(documentToMarkdown(doc, undefined, controller.signal), (error) => error === controller.signal.reason);
	});

	it("checks after getPage before extracting text or requesting another page", async () => {
		const controller = new AbortController();
		const page = deferred<PDFPageProxy>();
		const started = deferred<void>();
		const requested: number[] = [];
		const doc = fakeDoc((n) => { requested.push(n); started.resolve(); return page.promise; });
		const result = documentToMarkdown(doc, undefined, controller.signal);
		const settled = observed(result);
		await started.promise;
		controller.abort("stop pages");
		await flush();
		assert.equal(settled(), false);
		page.resolve(new Proxy({} as PDFPageProxy, { get(_target, key) {
			if (key === "then") return undefined; // Promise resolution probes thenables.
			assert.fail("must not access aborted page");
		} }));
		await assert.rejects(result, (error) => error === "stop pages");
		assert.deepEqual(requested, [1]);
	});

	it("checks between pages when the completed text call triggers abort", async () => {
		const controller = new AbortController();
		const requested: number[] = [];
		const doc = fakeDoc(async (n) => {
			requested.push(n);
			return { pageNumber: n, getTextContent: async () => { controller.abort(); return { items: [] }; } } as unknown as PDFPageProxy;
		});
		await assert.rejects(documentToMarkdown(doc, undefined, controller.signal), (error) => error === controller.signal.reason);
		assert.deepEqual(requested, [1]);
	});

	it("waits for an in-flight image operator list and checks abort before another page's operators", async () => {
		const controller = new AbortController();
		const operators = deferred<Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>>();
		const started = deferred<void>();
		const requested: number[] = [];
		const doc = fakeDoc(async (n) => ({
			pageNumber: n,
			getTextContent: async () => ({ items: [] }),
			getOperatorList: () => { requested.push(n); started.resolve(); return operators.promise; },
		}) as unknown as PDFPageProxy);
		const result = documentToMarkdown(doc, undefined, controller.signal);
		const settled = observed(result);
		await started.promise;
		controller.abort();
		await flush();
		assert.equal(settled(), false);
		operators.resolve({ fnArray: [], argsArray: [] });
		await assert.rejects(result, (error) => error === controller.signal.reason);
		assert.deepEqual(requested, [1]);
	});
});
