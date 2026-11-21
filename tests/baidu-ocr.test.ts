import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	tryBaiduOcr,
	applyBaiduOcrToPdf,
	parsePaddleOcrStdout,
} from "../src/server/baidu-ocr.ts";
import type { PdfPage } from "../src/agent/subagents/pdf-markdown.ts";
import { createPluginDocumentConverter } from "../src/server/plugin-documents.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

describe("Baidu Unlimited OCR", () => {
	it("parsePaddleOcrStdout parses standard PaddleOCR output tuple format", () => {
		const sampleStdout = [
			"[INFO] 2026-11-13 10:00:00 paddleocr: loading models",
			"[2026/11/13 10:00:01] ppocr INFO: ppocr init done",
			"[[[10.0, 20.0], [200.0, 20.0], [200.0, 45.0], [10.0, 45.0]], ('Chapter 1: Introduction', 0.985)]",
			"[[[10.0, 50.0], [300.0, 50.0], [300.0, 75.0], [10.0, 75.0]], ('Machine Learning Foundations', 0.992)]",
		].join("\n");

		const parsed = parsePaddleOcrStdout(sampleStdout);
		assert.equal(parsed, "Chapter 1: Introduction\nMachine Learning Foundations");
	});

	it("parsePaddleOcrStdout falls back to plain text ignoring log lines", () => {
		const sampleStdout = [
			"[INFO] logger initialized",
			"Plain recognized line 1",
			"Plain recognized line 2",
		].join("\n");

		const parsed = parsePaddleOcrStdout(sampleStdout);
		assert.equal(parsed, "Plain recognized line 1\nPlain recognized line 2");
	});

	it("tryBaiduOcr returns null gracefully when neither credentials nor paddleocr are available", async () => {
		const oldToken = process.env.BAIDU_OCR_ACCESS_TOKEN;
		const oldKey = process.env.BAIDU_OCR_API_KEY;
		const oldSec = process.env.BAIDU_OCR_SECRET_KEY;
		delete process.env.BAIDU_OCR_ACCESS_TOKEN;
		delete process.env.BAIDU_OCR_API_KEY;
		delete process.env.BAIDU_OCR_SECRET_KEY;

		try {
			const dummyImg = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
			const result = await tryBaiduOcr(dummyImg, {
				execFile: async () => {
					throw new Error("paddleocr not installed");
				},
			});
			assert.equal(result, null);
		} finally {
			if (oldToken) process.env.BAIDU_OCR_ACCESS_TOKEN = oldToken;
			if (oldKey) process.env.BAIDU_OCR_API_KEY = oldKey;
			if (oldSec) process.env.BAIDU_OCR_SECRET_KEY = oldSec;
		}
	});

	it("tryBaiduOcr uses Baidu AI Cloud OCR when BAIDU_OCR_ACCESS_TOKEN is present", async () => {
		const oldToken = process.env.BAIDU_OCR_ACCESS_TOKEN;
		process.env.BAIDU_OCR_ACCESS_TOKEN = "test-token-123";

		try {
			let calledUrl = "";
			let calledBody = "";
			const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				calledUrl = String(input);
				calledBody = String(init?.body);
				return new Response(
					JSON.stringify({
						words_result: [{ words: "Extracted line 1" }, { words: "Extracted line 2" }],
						words_result_num: 2,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			};

			const dummyImg = new Uint8Array([1, 2, 3, 4]);
			const result = await tryBaiduOcr(dummyImg, { fetch: mockFetch as typeof fetch });

			assert.ok(calledUrl.includes("access_token=test-token-123"));
			assert.ok(calledBody.startsWith("image="));
			assert.equal(result, "Extracted line 1\nExtracted line 2");
		} finally {
			if (oldToken) process.env.BAIDU_OCR_ACCESS_TOKEN = oldToken;
			else delete process.env.BAIDU_OCR_ACCESS_TOKEN;
		}
	});

	it("tryBaiduOcr acquires token with API_KEY + SECRET_KEY then calls OCR", async () => {
		const oldToken = process.env.BAIDU_OCR_ACCESS_TOKEN;
		const oldKey = process.env.BAIDU_OCR_API_KEY;
		const oldSec = process.env.BAIDU_OCR_SECRET_KEY;
		delete process.env.BAIDU_OCR_ACCESS_TOKEN;
		process.env.BAIDU_OCR_API_KEY = "mock-key";
		process.env.BAIDU_OCR_SECRET_KEY = "mock-secret";

		try {
			const calls: string[] = [];
			const mockFetch = async (input: RequestInfo | URL) => {
				const url = String(input);
				calls.push(url);
				if (url.includes("/oauth/2.0/token")) {
					return new Response(JSON.stringify({ access_token: "acquired-token-abc", expires_in: 3600 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.includes("/ocr/v1/general_basic")) {
					return new Response(
						JSON.stringify({
							words_result: [{ words: "Baidu Cloud OCR text" }],
							words_result_num: 1,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("Not found", { status: 404 });
			};

			const dummyImg = new Uint8Array([1, 2, 3]);
			const result = await tryBaiduOcr(dummyImg, { fetch: mockFetch as typeof fetch });

			assert.equal(calls.length, 2);
			assert.ok(calls[0]!.includes("oauth/2.0/token"));
			assert.ok(calls[1]!.includes("access_token=acquired-token-abc"));
			assert.equal(result, "Baidu Cloud OCR text");
		} finally {
			if (oldToken) process.env.BAIDU_OCR_ACCESS_TOKEN = oldToken;
			if (oldKey) process.env.BAIDU_OCR_API_KEY = oldKey;
			else delete process.env.BAIDU_OCR_API_KEY;
			if (oldSec) process.env.BAIDU_OCR_SECRET_KEY = oldSec;
			else delete process.env.BAIDU_OCR_SECRET_KEY;
		}
	});

	it("tryBaiduOcr uses offline PaddleOCR when cloud credentials are not provided", async () => {
		const oldToken = process.env.BAIDU_OCR_ACCESS_TOKEN;
		const oldKey = process.env.BAIDU_OCR_API_KEY;
		const oldSec = process.env.BAIDU_OCR_SECRET_KEY;
		delete process.env.BAIDU_OCR_ACCESS_TOKEN;
		delete process.env.BAIDU_OCR_API_KEY;
		delete process.env.BAIDU_OCR_SECRET_KEY;

		try {
			let executedCli = "";
			const mockExec = async (file: string) => {
				executedCli = file;
				return {
					stdout: "[[[0, 0], [10, 0], [10, 10], [0, 10]], ('PaddleOCR Offline Result', 0.99)]",
					stderr: "",
				};
			};

			const dummyImg = new Uint8Array([1, 2, 3]);
			const result = await tryBaiduOcr(dummyImg, { execFile: mockExec });

			assert.ok(executedCli.includes("paddleocr"));
			assert.equal(result, "PaddleOCR Offline Result");
		} finally {
			if (oldToken) process.env.BAIDU_OCR_ACCESS_TOKEN = oldToken;
			if (oldKey) process.env.BAIDU_OCR_API_KEY = oldKey;
			if (oldSec) process.env.BAIDU_OCR_SECRET_KEY = oldSec;
		}
	});

	it("applyBaiduOcrToPdf skips OCR when all pages already contain text", async () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "Hello world" },
			{ kind: "text", number: 2, markdown: "Page 2 text" },
		];

		let ocrCalls = 0;
		const result = await applyBaiduOcrToPdf(new Uint8Array([1, 2]), pages, {
			ocrFn: async () => {
				ocrCalls++;
				return "OCR text";
			},
		});

		assert.equal(ocrCalls, 0);
		assert.equal(result.ocrCount, 0);
		assert.deepEqual(result.pages, pages);
	});

	it("applyBaiduOcrToPdf processes image-only pages and renders via custom renderPage", async () => {
		const pages: PdfPage[] = [
			{ kind: "image-only", number: 1 },
			{ kind: "text", number: 2, markdown: "Existing text" },
		];

		const rendered: number[] = [];
		const result = await applyBaiduOcrToPdf(new Uint8Array([1, 2]), pages, {
			renderPage: async (_pdfData, pageNum) => {
				rendered.push(pageNum);
				return new Uint8Array([0x89, 0x50]);
			},
			ocrFn: async () => "Scanned page recognized by Baidu OCR",
		});

		assert.deepEqual(rendered, [1]);
		assert.equal(result.ocrCount, 1);
		assert.equal(result.pages[0]!.kind, "text");
		if (result.pages[0]!.kind === "text") {
			assert.equal(result.pages[0]!.markdown, "Scanned page recognized by Baidu OCR");
		}
		assert.deepEqual(result.pages[1], pages[1]);
	});

	it("applyBaiduOcrToPdf integrates with real PDF bytes from tinyPdf and native renderer", async () => {
		const pdf = tinyPdf([{ image: true }]);
		const pages: PdfPage[] = [{ kind: "image-only", number: 1 }];

		let receivedImageBytes = 0;
		const result = await applyBaiduOcrToPdf(pdf, pages, {
			ocrFn: async (img) => {
				receivedImageBytes = img.length;
				return "Baidu OCR text from rendered canvas";
			},
		});

		assert.ok(receivedImageBytes > 0, "Canvas should have rendered a PNG image buffer");
		assert.equal(result.ocrCount, 1);
		assert.equal(result.pages[0]!.kind, "text");
		if (result.pages[0]!.kind === "text") {
			assert.equal(result.pages[0]!.markdown, "Baidu OCR text from rendered canvas");
		}
	});

	it("createPluginDocumentConverter succeeds on image-only PDF when Baidu OCR is available", async () => {
		const pages: PdfPage[] = [
			{ kind: "image-only", number: 1 },
			{ kind: "text", number: 2, markdown: "Second page" },
		];

		const service = createPluginDocumentConverter({
			convertPdf: async () => ({ kind: "converted", pages }),
			applyBaiduOcrToPdf: async (_bytes, p) => ({
				pages: [
					{ kind: "text", number: 1, markdown: "OCR Page 1 Content" },
					p[1]!,
				],
				ocrCount: 1,
			}),
		});

		const form = new FormData();
		form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "scanned.pdf"));
		const req = new Request("http://localhost/documents", { method: "POST", body: form });

		const result = await service.convert(req, new AbortController().signal);
		assert.ok(result.markdown.includes("OCR Page 1 Content"));
		assert.ok(result.notices.includes("Processed with Baidu OCR."));
	});
});
