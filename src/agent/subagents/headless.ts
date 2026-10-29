import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
}

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

/** Canonicalize a raw Chrome screenshot for the model's eyes (2026-09-19 fix).
 *
 *  WHY: Chrome writes PNGs with a SPLIT IDAT stream (4KB chunks) — and
 *  Alibaba's vision decoder (behind OpenRouter's qwen3.8-flash, the
 *  visual-maker's look-model) rejected those outright during the
 *  2026-09-18/19 window: "The image format is illegal and cannot be opened",
 *  deterministically, at every size (50–800px) — while every single-IDAT
 *  form passed (a handcrafted 1×1, and sharp re-encodes). On a later re-test
 *  raw Chrome PNGs passed too (the upstream decoder was fixed or is flaky
 *  per backend), but the canonical form stays: PNG spec says the IDAT chunks
 *  are an arbitrary SPLIT of one zlib stream, so merging them is the more
 *  standard shape, byte-identical stream, zero re-encoding.
 *
 *  Pure Node on purpose (no sharp): historically the process already carried
 *  a native image lib via @huggingface/transformers' nested sharp + libvips,
 *  and importing the root sharp (Next's optional dependency) put a SECOND
 *  libvips into the process — macOS's ObjC runtime warns (duplicate
 *  GNotificationCenterDelegate, "mysterious crashes"). The transformers
 *  embedder died with wave 6 (2026-09-23) but the rule lives on: one native
 *  image lib per process; app code carries none. */
export function providerSafePng(png: Buffer): Buffer {
	const SIG_LEN = 8;
	if (png.length < SIG_LEN + 12 || png.subarray(0, SIG_LEN).toString("hex") !== "89504e470d0a1a0a") return png;
	// Walk the chunks once, merging the IDAT split into its canonical
	// single-chunk form (first IDAT's position, concatenated payload).
	const parts: Array<{ type: string; data: Buffer }> = [];
	let off = SIG_LEN;
	while (off + 12 <= png.length) {
		const len = png.readUInt32BE(off);
		if (off + 12 + len > png.length) break; // truncated tail — leave as-is
		parts.push({ type: png.subarray(off + 4, off + 8).toString("ascii"), data: png.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	const idats = parts.filter((p) => p.type === "IDAT");
	if (idats.length < 2) return png; // already canonical
	const merged = Buffer.concat(idats.map((p) => p.data));
	let emittedIdat = false;
	const out: Buffer[] = [png.subarray(0, SIG_LEN)];
	for (const p of parts) {
		if (p.type !== "IDAT") out.push(chunk(p.type, p.data));
		else if (!emittedIdat) {
			out.push(chunk("IDAT", merged));
			emittedIdat = true;
		}
	}
	return Buffer.concat(out);
}

/** One PNG chunk (length + type + data + CRC32) — the spec's exact layout. */
function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** CRC-32 (PNG's polynomial, table-less) for chunk checksums. */
function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

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

/** Decimal megapixels: at four bytes per pixel this is about 61 MiB per
 *  page canvas, before pdfjs/Skia's other working memory. */
export const MAX_PDF_CANVAS_PIXELS = 16_000_000;
export const MAX_PDF_CANVAS_SIDE = 8192;

/** Plan the allocation from the scale-1 viewport (including PDF rotation).
 *  Keep ordinary DPI/ceil arithmetic unchanged; oversized pages lose scale,
 *  never gain it. Exported as a pure seam so extreme geometry needs no canvas. */
export function pdfCanvasGeometry(baseWidth: number, baseHeight: number, dpi: number): {
	scale: number;
	width: number;
	height: number;
} {
	if (![baseWidth, baseHeight].every((n) => Number.isFinite(n) && n > 0)) {
		throw new Error("PDF page dimensions must be finite and positive");
	}
	if (!Number.isFinite(dpi) || dpi <= 0 || dpi / 72 === 0) {
		throw new Error("PDF render DPI must be finite and positive");
	}
	// Limit sides first, so the area calculation cannot overflow even when
	// the unscaled page dimensions or requested DPI are enormous.
	let scale = Math.min(dpi / 72, MAX_PDF_CANVAS_SIDE / baseWidth, MAX_PDF_CANVAS_SIDE / baseHeight);
	const area = (baseWidth * scale) * (baseHeight * scale);
	if (area > MAX_PDF_CANVAS_PIXELS) scale *= Math.sqrt(MAX_PDF_CANVAS_PIXELS / area);
	const dimensions = (s: number) => ({
		width: Math.max(1, Math.ceil(baseWidth * s)),
		height: Math.max(1, Math.ceil(baseHeight * s)),
	});
	const fits = ({ width, height }: { width: number; height: number }) =>
		width <= MAX_PDF_CANVAS_SIDE && height <= MAX_PDF_CANVAS_SIDE && width * height <= MAX_PDF_CANVAS_PIXELS;
	// Ceil can put an otherwise bounded floating-point viewport over budget.
	// Find a safe scale rather than clipping the viewport or allocating first.
	if (!fits(dimensions(scale))) {
		let low = 0;
		let high = scale;
		for (let i = 0; i < 64; i++) {
			const mid = low + (high - low) / 2;
			if (fits(dimensions(mid))) low = mid;
			else high = mid;
		}
		scale = low;
	}
	if (scale <= 0 || baseWidth * scale === 0 || baseHeight * scale === 0) {
		throw new Error("PDF page dimensions cannot be rendered at a positive scale");
	}
	return { scale, ...dimensions(scale) };
}

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
	const dpi = opts.dpi ?? 150;
	if (!Number.isFinite(dpi) || dpi <= 0 || dpi / 72 === 0) {
		throw new Error("PDF render DPI must be finite and positive");
	}
	// NATIVE CANVAS (Wave E, owner 2026-10-10): pdfjs paints into
	// @napi-rs/canvas in this process — no browser involved. pdfjs-dist v6's
	// own Node integration IS @napi-rs/canvas (its optionalDependency: the
	// NodeCanvasFactory requires it), so the paint engine is the exact code
	// that used to run in the Chrome shim tab; only the canvas host changed
	// (Skia in-process instead of a DOM canvas). Text-side pdf tools never
	// needed a browser; now renders don't either.
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const { createCanvas } = await import("@napi-rs/canvas");
	const data = new Uint8Array(fs.readFileSync(path.resolve(pdfPath)));
	// Standard-font data as a directory path (live-smoke finding 2026-09-19:
	// without it pdfjs renders non-embedded standard fonts via fallback);
	// verbosity 0 = errors only (JBIG2 noise on scanned PDFs).
	const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = await loadingTask.promise;
	try {
		const out: RenderedPdfPage[] = [];
		for (const pageNo of pages) {
			if (pageNo < 1 || pageNo > doc.numPages) continue;
			const pg = await doc.getPage(pageNo);
			const base = pg.getViewport({ scale: 1 });
			const geometry = pdfCanvasGeometry(base.width, base.height, dpi);
			const vp = pg.getViewport({ scale: geometry.scale });
			const canvas = createCanvas(geometry.width, geometry.height);
			const ctx = canvas.getContext("2d");
			// pdfjs's render types speak the DOM context; @napi-rs/canvas's
			// context is the same 2D API implemented over Skia.
			await pg.render({
				canvasContext: ctx as unknown as CanvasRenderingContext2D,
				canvas: canvas as unknown as HTMLCanvasElement,
				viewport: vp,
			}).promise;
			out.push({
				page: pageNo,
				// Skia-encoded PNG → providerSafePng for the same single-IDAT
				// canonical form every other vision-model image gets.
				png: providerSafePng(canvas.toBuffer("image/png")),
			});
		}
		return out;
	} finally {
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
