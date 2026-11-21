import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PdfPage } from "./pdf-markdown.ts";
import { pdfCanvasGeometry } from "./headless.ts";
import { standardFontsDir } from "./pdf-ops.ts";

const defaultExecFileAsync = promisify(execFile);

export interface BaiduOcrOptions {
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	execFile?: (
		file: string,
		args: string[],
		options: { timeout?: number; signal?: AbortSignal; maxBuffer?: number; windowsHide?: boolean },
	) => Promise<{ stdout: string; stderr: string }>;
}

let cachedCloudToken: { token: string; expiresAt: number } | null = null;

/**
 * Acquire Baidu AI Cloud OAuth access token using client_id and client_secret.
 */
async function getBaiduCloudAccessToken(fetchFn: typeof globalThis.fetch, signal?: AbortSignal): Promise<string | null> {
	if (process.env.BAIDU_OCR_ACCESS_TOKEN) {
		return process.env.BAIDU_OCR_ACCESS_TOKEN;
	}
	const apiKey = process.env.BAIDU_OCR_API_KEY;
	const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
	if (!apiKey || !secretKey) return null;

	if (cachedCloudToken && Date.now() < cachedCloudToken.expiresAt - 60_000) {
		return cachedCloudToken.token;
	}

	try {
		const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
		const res = await fetchFn(url, { method: "POST", signal });
		if (!res.ok) return null;
		const data = (await res.json()) as { access_token?: string; expires_in?: number };
		if (data.access_token) {
			const expiresAt = Date.now() + (data.expires_in ?? 2592000) * 1000;
			cachedCloudToken = { token: data.access_token, expiresAt };
			return data.access_token;
		}
	} catch (err) {
		if (signal?.aborted) throw err;
	}
	return null;
}

/**
 * Call Baidu AI Cloud general basic OCR API.
 */
async function tryBaiduCloudOcr(
	imageBuffer: Uint8Array,
	options?: BaiduOcrOptions,
): Promise<string | null> {
	const fetchFn = options?.fetch ?? globalThis.fetch;
	const token = await getBaiduCloudAccessToken(fetchFn, options?.signal);
	if (!token) return null;

	try {
		const base64Image = Buffer.from(imageBuffer).toString("base64");
		const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${encodeURIComponent(token)}`;
		const res = await fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `image=${encodeURIComponent(base64Image)}`,
			signal: options?.signal,
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			words_result?: Array<{ words: string }>;
			words_result_num?: number;
			error_code?: number;
			error_msg?: string;
		};
		if (data.words_result && Array.isArray(data.words_result) && data.words_result.length > 0) {
			const lines = data.words_result.map((w) => w.words).filter(Boolean);
			if (lines.length > 0) {
				return lines.join("\n");
			}
		}
	} catch (err) {
		if (options?.signal?.aborted) throw err;
	}
	return null;
}

/**
 * Parse stdout emitted by Baidu PaddleOCR CLI.
 */
export function parsePaddleOcrStdout(stdout: string): string | null {
	const lines: string[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		if (/^\[(INFO|DEBUG|WARNING|ERROR)\]/i.test(trimmed)) continue;
		if (/^\[\d{4}[-/]\d{2}[-/]\d{2}/.test(trimmed)) continue;

		// Match PaddleOCR line pattern: [box, ('recognized text', confidence)] or ('recognized text', confidence)
		const match = trimmed.match(/\(\s*['"](.*?)['"]\s*,\s*([0-9.]+)\s*\)\s*\]?$/);
		if (match && match[1]) {
			lines.push(match[1]);
		}
	}
	if (lines.length > 0) return lines.join("\n");

	// Fallback if stdout is plain text lines
	const fallbackLines: string[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		if (/^\[(INFO|DEBUG|WARNING|ERROR)\]/i.test(trimmed)) continue;
		if (/^\[\d{4}[-/]\d{2}[-/]\d{2}/.test(trimmed)) continue;
		if (trimmed.startsWith("Traceback ") || trimmed.includes("ModuleNotFoundError")) continue;
		fallbackLines.push(trimmed);
	}
	return fallbackLines.length > 0 ? fallbackLines.join("\n") : null;
}

/**
 * Execute offline Baidu PaddleOCR via child_process.
 */
async function tryPaddleOcr(
	imageBuffer: Uint8Array,
	options?: BaiduOcrOptions,
): Promise<string | null> {
	options?.signal?.throwIfAborted();
	const execFn = options?.execFile ?? defaultExecFileAsync;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paddleocr-"));
	const tempFilePath = path.join(tempDir, "page.png");

	try {
		await fs.writeFile(tempFilePath, imageBuffer);
		options?.signal?.throwIfAborted();

		let stdout: string | null = null;

		// 1. Try `paddleocr` CLI
		try {
			const cli = process.platform === "win32" ? "paddleocr.exe" : "paddleocr";
			const res = await execFn(cli, ["--image_dir", tempFilePath, "--use_angle_cls", "true"], {
				timeout: 30_000,
				signal: options?.signal,
				maxBuffer: 20 * 1024 * 1024,
				windowsHide: true,
			});
			stdout = res.stdout;
		} catch (err: unknown) {
			if (options?.signal?.aborted) throw err;
		}

		// 2. Fallback to `python -m paddleocr`
		if (stdout === null) {
			try {
				const res = await execFn("python", ["-m", "paddleocr", "--image_dir", tempFilePath, "--use_angle_cls", "true"], {
					timeout: 30_000,
					signal: options?.signal,
					maxBuffer: 20 * 1024 * 1024,
					windowsHide: true,
				});
				stdout = res.stdout;
			} catch (err: unknown) {
				if (options?.signal?.aborted) throw err;
			}
		}

		// 3. Fallback to `python3 -m paddleocr`
		if (stdout === null) {
			try {
				const res = await execFn("python3", ["-m", "paddleocr", "--image_dir", tempFilePath, "--use_angle_cls", "true"], {
					timeout: 30_000,
					signal: options?.signal,
					maxBuffer: 20 * 1024 * 1024,
					windowsHide: true,
				});
				stdout = res.stdout;
			} catch (err: unknown) {
				if (options?.signal?.aborted) throw err;
			}
		}

		if (!stdout) return null;
		return parsePaddleOcrStdout(stdout);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Try OCR on an image buffer using Baidu AI Cloud OCR (if configured) or Baidu PaddleOCR offline.
 * Returns text markdown or null if unavailable / failed.
 */
export async function tryBaiduOcr(
	imageBuffer: Uint8Array,
	options?: BaiduOcrOptions,
): Promise<string | null> {
	options?.signal?.throwIfAborted();

	// 1. Try Baidu AI Cloud OCR if credentials are present
	if (process.env.BAIDU_OCR_ACCESS_TOKEN || (process.env.BAIDU_OCR_API_KEY && process.env.BAIDU_OCR_SECRET_KEY)) {
		const cloudResult = await tryBaiduCloudOcr(imageBuffer, options);
		if (cloudResult && cloudResult.trim().length > 0) {
			return cloudResult.trim();
		}
	}

	// 2. Try Baidu PaddleOCR (unlimited offline open-source OCR)
	const paddleResult = await tryPaddleOcr(imageBuffer, options);
	if (paddleResult && paddleResult.trim().length > 0) {
		return paddleResult.trim();
	}

	return null;
}

export interface ApplyBaiduOcrOptions extends BaiduOcrOptions {
	ocrFn?: (imageBuffer: Uint8Array, options?: { signal?: AbortSignal }) => Promise<string | null>;
	renderPage?: (pdfData: Uint8Array, pageNumber: number, options?: { signal?: AbortSignal }) => Promise<Uint8Array | null>;
}

/**
 * Apply Baidu OCR to image-only / unscanned pages of a PDF document.
 * Returns the updated pages and the number of pages successfully OCR-processed.
 */
export async function applyBaiduOcrToPdf(
	pdfData: Uint8Array,
	pages: PdfPage[],
	options?: ApplyBaiduOcrOptions,
): Promise<{ pages: PdfPage[]; ocrCount: number }> {
	options?.signal?.throwIfAborted();
	const ocr = options?.ocrFn ?? ((img, opts) => tryBaiduOcr(img, { ...options, ...opts }));

	const hasText = pages.some((p) => p.kind === "text" && p.markdown.trim().length > 0);
	const targetIndices = new Set<number>();
	for (let i = 0; i < pages.length; i++) {
		const p = pages[i]!;
		if (p.kind === "image-only" || (!hasText && p.kind === "empty")) {
			targetIndices.add(i);
		}
	}

	if (targetIndices.size === 0) {
		return { pages, ocrCount: 0 };
	}

	let ocrCount = 0;
	const updatedPages: PdfPage[] = [...pages];

	if (options?.renderPage) {
		for (const idx of targetIndices) {
			options?.signal?.throwIfAborted();
			const page = pages[idx]!;
			try {
				const imgBuffer = await options.renderPage(pdfData, page.number, { signal: options?.signal });
				if (imgBuffer) {
					const text = await ocr(imgBuffer, { signal: options?.signal });
					if (text && text.trim().length > 0) {
						updatedPages[idx] = { kind: "text", number: page.number, markdown: text.trim() };
						ocrCount++;
					}
				}
			} catch (err) {
				if (options?.signal?.aborted) throw err;
			}
		}
		return { pages: updatedPages, ocrCount };
	}

	// Native rendering via pdfjs + @napi-rs/canvas
	let loadingTask: {
		promise: Promise<any>;
		destroy(): Promise<void>;
	} | undefined;

	try {
		// Static import cannot work: pdfjs-dist legacy and @napi-rs/canvas contain native addons excluded from browser bundling.
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const { createCanvas } = await import("@napi-rs/canvas");
		loadingTask = pdfjs.getDocument({
			data: pdfData,
			standardFontDataUrl: standardFontsDir(),
			verbosity: 0,
		});
		const doc = await loadingTask.promise;
		options?.signal?.throwIfAborted();

		for (const idx of targetIndices) {
			options?.signal?.throwIfAborted();
			const page = pages[idx]!;
			if (page.number >= 1 && page.number <= doc.numPages) {
				try {
					const pg = await doc.getPage(page.number);
					const base = pg.getViewport({ scale: 1 });
					const geometry = pdfCanvasGeometry(base.width, base.height, 150);
					const vp = pg.getViewport({ scale: geometry.scale });
					const canvas = createCanvas(geometry.width, geometry.height);
					const ctx = canvas.getContext("2d");
					await pg.render({
						canvasContext: ctx as unknown as CanvasRenderingContext2D,
						canvas: canvas as unknown as HTMLCanvasElement,
						viewport: vp,
					}).promise;
					const imgBuffer = new Uint8Array(canvas.toBuffer("image/png"));
					const text = await ocr(imgBuffer, { signal: options?.signal });
					if (text && text.trim().length > 0) {
						updatedPages[idx] = { kind: "text", number: page.number, markdown: text.trim() };
						ocrCount++;
					}
				} catch (err) {
					if (options?.signal?.aborted) throw err;
				}
			}
		}
	} catch (err) {
		if (options?.signal?.aborted) throw err;
		return { pages, ocrCount: 0 };
	} finally {
		try {
			await loadingTask?.destroy();
		} catch {}
	}

	return { pages: updatedPages, ocrCount };
}
