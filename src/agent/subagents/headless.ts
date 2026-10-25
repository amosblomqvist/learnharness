import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "../../core/images.ts";
import { providerSafePng, readBoundedFile } from "../image-media.ts";
import { standardFontsDir } from "./pdf-ops";

/**
 * Verification engines for sub-agents: demos use the app's own Electron
 * browser-service via puppeteer-core, with system Chrome as fallback.
 * SVGs use resvg (browser fallback); PDFs use pdfjs + Skia (no browser).
 * No extra Chromium is shipped or downloaded.
 *
 * Chrome fallback resolution: CHROME_PATH first, then common macOS,
 * Windows and Linux install paths. `available()` is a cheap executable
 * check; the helper must still prove it can launch/connect at job time.
 *
 * Test seam: `headlessOverride.current` replaces the whole API (tests inject
 * a fake; nothing here touches a real browser). Builders call `getHeadless()`.
 */

export interface DemoRunResult {
	/** console.error / console messages of type "error". */
	consoleErrors: string[];
	/** Uncaught exceptions (window.onerror / unhandled rejections). */
	pageErrors: string[];
	/** Network requests that failed (CDN scripts that didn't load, …). */
	failedRequests: string[];
	/** Value of the optional probe expression, when requested and successful. */
	probeResult?: unknown;
	/** True when nothing above recorded anything. */
	ok: boolean;
}

export interface RunDemoOptions {
	/** How long to let the page settle (animations, async CDN loads) — default 2s. */
	settleMs?: number;
	/** Optional JS expression evaluated in the page after settling; its value
	 * is returned to the builder so it can assert on internal state. */
	probe?: string;
}

export interface RenderSvgOptions {
	/** Viewport size — defaults to the SVG's width/height attrs, else 900×700. */
	width?: number;
	height?: number;
}

export interface RenderPdfOptions {
	/** Render DPI — 72 is 100% zoom; the skill's guidance is 100/150/200. */
	dpi?: number;
	/** Normalized 0..1 crop rectangle, top-left origin, applied AFTER the
	 *  page's rotation. Only the crop is rasterized (no full-page canvas). */
	crop?: PdfCrop;
	/** Reject out-of-range pages and out-of-range dpi instead of skipping /
	 *  clamping (pdf_view). Legacy callers keep the lenient semantics. */
	strict?: boolean;
	signal?: AbortSignal;
}

export interface PdfCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** PDF render bounds (render-time, before any canvas is allocated). */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_RENDER_PAGES = 6;
export const MAX_PDF_DOC_PAGES = 5000;
export const MIN_PDF_DPI = 72;
export const MAX_PDF_DPI = 300;

export interface RenderedPdfPage {
	page: number;
	png: Buffer;
}

export interface HeadlessApi {
	/** True when a browser helper or Chrome is resolvable (cheap, no launch). */
	available(): boolean;
	/** Why not — for error messages. */
	unavailableReason(): string | null;
	/** Execute HTML in a browser, capture errors, optionally probe. */
	runDemo(html: string, opts?: RunDemoOptions): Promise<DemoRunResult>;
	/** Rasterize an SVG to a PNG buffer (for verify-by-looking). */
	renderSvg(svg: string, opts?: RenderSvgOptions): Promise<Buffer>;
	/** Render PDF pages to PNGs natively (pdfjs + Skia) for the pdf-reader. */
	renderPdfPages(pdfPath: string, pages: number[], opts?: RenderPdfOptions): Promise<RenderedPdfPage[]>;
}

/** Test seam — undefined in production. */
export const headlessOverride: { current?: HeadlessApi } = {};

export function getHeadless(): HeadlessApi {
	return headlessOverride.current ?? realHeadless;
}

// ─── Chrome resolution ───────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
	...(process.platform === "win32" ? [
		path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
		...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
	] : []),
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function resolveChromeExecutablePath(): string | null {
	const candidates = [process.env.CHROME_PATH, ...CHROME_CANDIDATES].filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			/* not readable — try the next */
		}
	}
	return null;
}

const NO_CHROME_MESSAGE =
	"No render engine available: the app's own browser helper failed to start and no system Chrome/Chromium was found. " +
	"Install Google Chrome or set CHROME_PATH to a Chrome executable. " +
	"(Verification is mandatory — demos are never delivered untested.)";

// ─── The app's own Chromium as a browser service (Wave E stage 3) ────────────
// Demos execute JS and need a browser. PRIMARY: this very app's binary
// spawned with --browser-service (main.cjs boots a hidden window with a CDP
// port and prints "BROWSER_SERVICE_CDP <port>"). FALLBACK: system Chrome.
// A Node IPC channel owns its lifetime: parent death/disconnect quits the
// helper on every OS (Windows Electron stdin is synthetic EOF). No orphans.
// PDFs and SVGs never come here (native now).

/** Handshake line parser (pure; exported for tests). */
export function parseBrowserServiceLine(line: string): number | null {
	const m = line.match(/^BROWSER_SERVICE_CDP (\d+)$/);
	if (!m) return null;
	const port = Number(m[1]);
	return port >= 1 && port <= 65535 ? port : null;
}

/** Spawn env sanitizer (pure; exported for tests): the helper must run as a
 *  FULL Electron app — ELECTRON_RUN_AS_NODE must not leak — and must not
 *  inherit the dev-shell userData redirect. */
export function browserServiceSpawnEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...env };
	delete out.ELECTRON_RUN_AS_NODE;
	delete out.LH_DEV_URL;
	// The artifact renderer is not an authorized app API client.
	delete out.LH_DESKTOP_API_SECRET;
	delete out.LH_DESKTOP_SERVER;
	return out;
}

/** The helper binary: inside the packaged app the server runs under
 *  ELECTRON_RUN_AS_NODE so process.execPath IS the app binary; in dev
 *  (plain node) the electron package resolves to the dev binary path. */
export function browserServiceBinary(): string | null {
	if (process.versions.electron) return process.execPath;
	try {
		const req = createRequire(import.meta.url);
		const p = req("electron") as unknown as string;
		return typeof p === "string" && p.length > 0 ? p : null;
	} catch {
		return null;
	}
}

const BROWSER_SERVICE_TIMEOUT_MS = 15_000;
let browserServiceProc: import("node:child_process").ChildProcess | null = null;

async function connectBrowserService(): Promise<import("puppeteer-core").Browser | null> {
	const puppeteer = (await import("puppeteer-core")).default;
	const { spawn } = await import("node:child_process");
	let port: number | null = null;

	if (browserServiceProc && browserServiceProc.exitCode === null) {
		// Helper alive from a previous run — reuse its endpoint.
		port = (browserServiceProc as { __cdpPort?: number }).__cdpPort ?? null;
	}
	if (port === null) {
		const binary = browserServiceBinary();
		if (!binary) return null;
		// Packaged: execPath runs the bundled app (flag reaches main.cjs).
		// Dev: the bare electron binary needs the repo root as the app arg —
		// flagless it would open Electron's default app instead of our shell.
		const appArgs = process.versions.electron ? ["--browser-service"] : [
			// src/agent/subagents → repo root
			path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
			"--browser-service",
		];
		const proc = spawn(binary, appArgs, {
			// Cast: the sanitizer is pure over a loose record; NODE_ENV is
			// always present in a real process.env.
			env: browserServiceSpawnEnv(process.env) as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe", "ipc"] as const,
		});
		browserServiceProc = proc;
		port = await new Promise<number | null>((resolve) => {
			let buf = "";
			const timer = setTimeout(() => {
				proc.kill();
				resolve(null);
			}, BROWSER_SERVICE_TIMEOUT_MS);
			const onData = (chunk: Buffer) => {
				buf += chunk.toString("utf8");
				const line = buf.split("\n").find((l) => parseBrowserServiceLine(l) !== null);
				if (line !== undefined) {
					clearTimeout(timer);
					resolve(parseBrowserServiceLine(line));
				}
			};
			proc.stdout!.on("data", onData);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve(null);
			});
		});
		if (port === null) {
			browserServiceProc = null;
			return null;
		}
		(proc as { __cdpPort?: number }).__cdpPort = port;
	}

	try {
		const version = await fetch(`http://127.0.0.1:${port}/json/version`);
		const info = (await version.json()) as { webSocketDebuggerUrl?: string };
		if (!info.webSocketDebuggerUrl) return null;
		// connect ≠ launch: browser.close() below merely disconnects — the
		// helper stays resident for the next job (IPC-owned lifetime).
		return await puppeteer.connect({
			browserWSEndpoint: info.webSocketDebuggerUrl,
			defaultViewport: null,
		});
	} catch {
		return null;
	}
}

/** Serialized helper-page use: the helper owns ONE page target (Electron's
 *  CDP has no Target.createTarget — pages must be windows the helper made),
 *  so concurrent jobs queue here instead of fighting over one webContents. */
let helperPageChain: Promise<unknown> = Promise.resolve();

async function withBrowserPage<T>(fn: (page: import("puppeteer-core").Page) => Promise<T>): Promise<T> {
	// Helper first (owner ruling 2026-10-10: the app's own Chromium primary,
	// system Chrome fallback) — deterministic across users, zero install.
	const helper = await connectBrowserService();
	if (helper) {
		const run = async (): Promise<T> => {
			const pages = await helper.pages();
			const page = pages.find((p) => p.target().type() === "page");
			if (!page) throw new Error("browser service: no page target");
			try {
				return await fn(page);
			} finally {
				// Drop all page state (JS heap, listeners) between jobs.
				await page.goto("about:blank").catch(() => {});
			}
		};
		const next = helperPageChain.then(run, run);
		helperPageChain = next.catch(() => {});
		return next;
	}

	// Chrome fallback: per-job launch, close on the way out (old semantics).
	const puppeteer = (await import("puppeteer-core")).default;
	const executablePath = resolveChromeExecutablePath();
	const browser = await puppeteer.launch({
		headless: true,
		// Explicit path when we found one; otherwise let puppeteer resolve the
		// system Chrome install itself via the "chrome" channel.
		...(executablePath ? { executablePath } : { channel: "chrome" as const }),
		args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
	});
	try {
		const page = await browser.newPage();
		return await fn(page);
	} finally {
		await browser.close().catch(() => {});
	}
}

/** A temp dir per invocation; removed in finally. */
function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Demo execution ──────────────────────────────────────────────────────────

async function runDemo(html: string, opts: RunDemoOptions = {}): Promise<DemoRunResult> {
	const settleMs = opts.settleMs ?? 2000;
	const dir = tempDir("lh-demo-");
	const file = path.join(dir, "demo.html");
	fs.writeFileSync(file, html, "utf-8");

	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	let probeResult: unknown;
	let probed = false;

	try {
		await withBrowserPage(async (page) => {
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});
		page.on("pageerror", (err) => pageErrors.push(err instanceof Error ? err.message : String(err)));
		page.on("requestfailed", (req) => failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? "failed"})`));

		try {
			await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 });
			await new Promise((resolve) => setTimeout(resolve, settleMs));
			if (opts.probe) {
				try {
					probeResult = await page.evaluate(opts.probe);
				} catch (err) {
					pageErrors.push(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				probed = true;
			}
		} catch (err) {
			pageErrors.push(err instanceof Error ? err.message : String(err));
		}
		});
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}

	return {
		consoleErrors,
		pageErrors,
		failedRequests,
		...(probed ? { probeResult } : {}),
		ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
	};
}

// ─── SVG rasterization ───────────────────────────────────────────────────────

function svgViewport(svg: string, opts: RenderSvgOptions): { width: number; height: number } {
	if (opts.width && opts.height) return { width: opts.width, height: opts.height };
	const width = Number(svg.match(/\bwidth\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	const height = Number(svg.match(/\bheight\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	return {
		width: Math.ceil(Number.isFinite(width) && width > 0 ? width : 900),
		height: Math.ceil(Number.isFinite(height) && height > 0 ? height : 700),
	};
}

export { providerSafePng };

async function renderSvg(svg: string, opts: RenderSvgOptions = {}): Promise<Buffer> {
	// NATIVE FIRST (Wave E stage 2, owner 2026-10-10): resvg rasterizes
	// static SVG in-process — visual-maker SVGs never execute script, so a
	// browser adds nothing but a process. White background mirrors the old
	// Chrome page (html,body{background:#fff}); fitTo width mirrors
	// svgViewport semantics (attrs win, viewBox-only gets the 900 default,
	// opts override). The browser path below stays as the fallback for
	// exotic-SVG features resvg cannot parse — failures there used to be
	// the ONLY path, so nothing regresses.
	const { width } = svgViewport(svg, opts);
	try {
		const { Resvg } = await import("@resvg/resvg-js");
		const resvg = new Resvg(svg, {
			fitTo: { mode: "width", value: width },
			font: { loadSystemFonts: true },
			background: "#ffffff",
		});
		return providerSafePng(resvg.render().asPng());
	} catch {
		/* fall through to the browser path */
	}
	const dir = tempDir("lh-visual-");
	const file = path.join(dir, "figure.html");
	fs.writeFileSync(
		file,
		`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`,
		"utf-8",
	);

	return withBrowserPage(async (page) => {
		const { width, height } = svgViewport(svg, opts);
		await page.setViewport({ width, height });
		await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 });
		const shot = (await page.screenshot({ fullPage: true, type: "png" })) as Buffer;
		// Chrome's raw split-IDAT PNG is canonicalized before it reaches a
		// provider (see providerSafePng) — the visual-maker feeds this exact
		// buffer back to the vision model as its only way to "look".
		return providerSafePng(Buffer.from(shot));
	}).finally(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});
}

// ─── PDF page rasterization (pdfjs paints, Skia hosts) ─────────────────

/** Render PDF pages to PNGs — the sources-v0 pdf-reader's eyes.
 *
 *  History: pdfjs ALWAYS painted the pages (scale = dpi/72, the skill's
 *  zoom arithmetic) — first inside a headless Chrome tab (canvas shim,
 *  toDataURL, 2026-09-19), now into @napi-rs/canvas in this process (Wave
 *  E, 2026-10-10). The paint engine never changed; only the canvas host:
 *  Skia in-process via pdfjs-dist v6's own Node integration. No browser,
 *  no temp files, no base64 hop. */
async function renderPdfPages(
	pdfPath: string,
	pages: number[],
	opts: RenderPdfOptions = {},
): Promise<RenderedPdfPage[]> {
	const signal = opts.signal;
	const aborted = () => {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
	};
	aborted();
	let dpi = opts.dpi ?? 150;
	if (typeof dpi !== "number" || !Number.isFinite(dpi)) throw new Error("dpi must be a finite number");
	if (dpi < MIN_PDF_DPI || dpi > MAX_PDF_DPI) {
		if (opts.strict) throw new Error(`dpi must be between ${MIN_PDF_DPI} and ${MAX_PDF_DPI}`);
		dpi = Math.min(MAX_PDF_DPI, Math.max(MIN_PDF_DPI, dpi));
	}
	const crop = opts.crop;
	if (crop) {
		const { x, y, width, height } = crop;
		const eps = 1e-9;
		if (![x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v))) throw new Error("crop values must be finite numbers");
		if (width <= 0 || height <= 0) throw new Error("crop width and height must be greater than 0");
		if (x < 0 || y < 0 || x + width > 1 + eps || y + height > 1 + eps) throw new Error("crop must lie inside the page (normalized 0..1)");
	}
	const wanted = [...new Set(pages)];
	if (wanted.length > MAX_PDF_RENDER_PAGES) throw new Error(`at most ${MAX_PDF_RENDER_PAGES} pages can be rendered per call`);
	const absolute = path.resolve(pdfPath);
	const stat = fs.statSync(absolute);
	if (stat.size > MAX_PDF_BYTES) throw new Error(`PDF is too large (${MAX_PDF_BYTES / (1024 * 1024)} MiB max)`);
	// NATIVE CANVAS (Wave E, owner 2026-10-10): pdfjs paints into
	// @napi-rs/canvas in this process, no browser. Local render only.
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const { createCanvas } = await import("@napi-rs/canvas");
	const data = new Uint8Array(
		await readBoundedFile(absolute, MAX_PDF_BYTES, () => new Error(`PDF is too large (${MAX_PDF_BYTES / (1024 * 1024)} MiB max)`), signal),
	);
	aborted();
	// pdfjs-dist v6 has no eval/new Function path and no isEvalSupported
	// option (verified: none in pdf.mjs / pdf.worker.mjs), so eval is off by
	// construction; standard-font data as a directory path (2026-09-19);
	// verbosity 0 = errors only.
	const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const onAbort = () => void loadingTask.destroy().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const doc = await loadingTask.promise;
		aborted();
		if (doc.numPages > MAX_PDF_DOC_PAGES) throw new Error(`PDF has too many pages (${MAX_PDF_DOC_PAGES} max)`);
		const out: RenderedPdfPage[] = [];
		for (const pageNo of wanted) {
			aborted();
			if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > doc.numPages) {
				if (opts.strict) throw new Error(`page ${pageNo} is out of range (document has ${doc.numPages} pages)`);
				continue;
			}
			const pg = await doc.getPage(pageNo);
			const c = crop ?? { x: 0, y: 0, width: 1, height: 1 };
			// Page size in points AFTER rotation; the output is capped by
			// longest side and pixel count before any canvas exists.
			const base = pg.getViewport({ scale: 1 });
			const cropW = base.width * c.width;
			const cropH = base.height * c.height;
			const scale = Math.min(
				dpi / 72,
				MAX_IMAGE_DIMENSION / Math.max(cropW, cropH),
				Math.sqrt(MAX_IMAGE_PIXELS / (cropW * cropH)),
			);
			const vp = pg.getViewport({ scale });
			const w = Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.ceil(vp.width * c.width - 1e-6)));
			const h = Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.ceil(vp.height * c.height - 1e-6)));
			const canvas = createCanvas(w, h);
			const ctx = canvas.getContext("2d");
			// pdfjs's render types speak the DOM context; @napi-rs/canvas's
			// context is the same 2D API over Skia. The transform shifts the
			// crop's top-left to the canvas origin.
			await pg.render({
				canvasContext: ctx as unknown as CanvasRenderingContext2D,
				canvas: canvas as unknown as HTMLCanvasElement,
				viewport: vp,
				transform: [1, 0, 0, 1, -vp.width * c.x, -vp.height * c.y],
			}).promise;
			aborted();
			out.push({ page: pageNo, png: providerSafePng(canvas.toBuffer("image/png")) });
		}
		return out;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await loadingTask.destroy().catch(() => {});
	}
}

// ─── the real API ────────────────────────────────────────────────────────────

export const realHeadless: HeadlessApi = {
	available() {
		// The helper binary exists by construction in the packaged app; in dev
		// it resolves via the electron package. System Chrome widens coverage.
		return browserServiceBinary() !== null || resolveChromeExecutablePath() !== null;
	},
	unavailableReason() {
		return browserServiceBinary() === null && resolveChromeExecutablePath() === null ? NO_CHROME_MESSAGE : null;
	},
	runDemo,
	renderSvg,
	renderPdfPages,
};
