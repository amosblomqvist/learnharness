/**
 * The phone build's stand-in for src/agent/subagents/headless.ts (mobile
 * Phase 4). The desktop drives headless Chrome (demos), resvg (SVGs) and
 * pdf.js + Skia (PDF pages); in the browser the page itself can do all
 * three. scripts/build-mobile.mjs points the sub-agents' import of
 * "./headless.ts" here.
 *
 * - runDemo: the demo runs in a hidden iframe sandboxed WITHOUT
 *   same-origin (model-written code can't reach the app's storage or keys),
 *   with an injected script reporting console errors, uncaught errors and
 *   failed resource loads, then evaluating the optional probe.
 * - renderSvg: the SVG is drawn onto a canvas and exported as PNG.
 * - renderPdfPages: pdf.js renders each page onto a canvas → PNG.
 */
import type { DemoRunResult, HeadlessApi, RenderedPdfPage, RunDemoOptions } from "../agent/subagents/headless.ts";
import type { Buffer as NodeBuffer } from "node:buffer";
import { Buffer } from "./shims/buffer.ts";
import * as fs from "./shims/fs.ts";

export type * from "../agent/subagents/headless.ts";

const MAX_CANVAS_SIDE = 4096;
const MAX_CANVAS_PIXELS = 16_000_000;

/** Runs inside the demo frame before the demo's own scripts. */
const CAPTURE = `<script>(function () {
	var send = function (kind, text) { try { parent.postMessage({ lhDemo: kind, text: String(text).slice(0, 2000) }, "*"); } catch (e) {} };
	var origError = console.error;
	console.error = function () { send("console", Array.prototype.map.call(arguments, String).join(" ")); return origError.apply(console, arguments); };
	addEventListener("error", function (e) {
		var t = e.target;
		if (t && t !== window && (t.src || t.href)) send("request", (t.src || t.href) + " failed to load");
		else send("page", e.message || String(e.error));
	}, true);
	addEventListener("unhandledrejection", function (e) { send("page", "Unhandled rejection: " + (e.reason && e.reason.message || e.reason)); });
	addEventListener("message", function (e) {
		if (!e.data || e.data.lhProbe === undefined) return;
		Promise.resolve().then(function () { return (0, eval)(e.data.lhProbe); }).then(
			function (v) { var out; try { out = JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (err) { out = String(v); } parent.postMessage({ lhDemo: "probe", value: out }, "*"); },
			function (err) { parent.postMessage({ lhDemo: "probeError", text: String(err && err.message || err) }, "*"); }
		);
	});
})();</script>`;

function withCapture(html: string): string {
	const head = /<head[^>]*>/i.exec(html);
	if (head) return html.slice(0, head.index + head[0].length) + CAPTURE + html.slice(head.index + head[0].length);
	return CAPTURE + html;
}

async function runDemo(html: string, opts: RunDemoOptions = {}): Promise<DemoRunResult> {
	const result: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("aria-hidden", "true");
	frame.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:700px;border:0;visibility:hidden;";
	let probeDone: ((v: unknown) => void) | null = null;
	const onMessage = (e: MessageEvent) => {
		if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
		const msg = e.data as { lhDemo?: string; text?: string; value?: unknown };
		if (msg.lhDemo === "console") result.consoleErrors.push(msg.text ?? "");
		else if (msg.lhDemo === "page") result.pageErrors.push(msg.text ?? "");
		else if (msg.lhDemo === "request") result.failedRequests.push(msg.text ?? "");
		else if (msg.lhDemo === "probe") probeDone?.(msg.value);
		else if (msg.lhDemo === "probeError") {
			result.pageErrors.push(`Probe failed: ${msg.text}`);
			probeDone?.(undefined);
		}
	};
	addEventListener("message", onMessage);
	try {
		frame.srcdoc = withCapture(html);
		document.body.append(frame);
		await new Promise((resolve) => setTimeout(resolve, opts.settleMs ?? 2000));
		if (opts.probe) {
			const value = await new Promise<unknown>((resolve) => {
				probeDone = resolve;
				frame.contentWindow?.postMessage({ lhProbe: opts.probe }, "*");
				setTimeout(() => resolve(undefined), 3000);
			});
			if (value !== undefined) result.probeResult = value;
		}
	} finally {
		removeEventListener("message", onMessage);
		frame.remove();
	}
	result.ok = result.consoleErrors.length === 0 && result.pageErrors.length === 0 && result.failedRequests.length === 0;
	return result;
}

/** The sub-agents type their images as Node Buffers; the phone build's
 *  Buffer (./shims/buffer.ts) is what actually backs that name here. */
async function canvasPng(canvas: HTMLCanvasElement): Promise<NodeBuffer> {
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("Could not encode the image");
	return Buffer.wrap(new Uint8Array(await blob.arrayBuffer())) as unknown as NodeBuffer;
}

function svgSize(svg: string): { width: number; height: number } | null {
	const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
	const num = (name: string) => Number.parseFloat(new RegExp(`\\b${name}\\s*=\\s*["']?([\\d.]+)`, "i").exec(tag)?.[1] ?? "");
	const w = num("width");
	const h = num("height");
	if (w > 0 && h > 0) return { width: w, height: h };
	const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
	return vb ? { width: Number(vb[1]), height: Number(vb[2]) } : null;
}

async function renderSvg(svg: string, opts: { width?: number; height?: number } = {}): Promise<NodeBuffer> {
	const natural = svgSize(svg);
	const width = Math.min(opts.width ?? natural?.width ?? 900, MAX_CANVAS_SIDE);
	const height = Math.min(opts.height ?? natural?.height ?? 700, MAX_CANVAS_SIDE);
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const img = new Image();
		img.decoding = "async";
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("The SVG could not be rendered (invalid markup?)"));
			img.src = url;
		});
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(width);
		canvas.height = Math.round(height);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("No 2D canvas available");
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return await canvasPng(canvas);
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function renderPdfPages(pdfPath: string, pages: number[], opts: { dpi?: number } = {}): Promise<RenderedPdfPage[]> {
	const pdfjs = await import("./pdfjs.ts");
	const data = new Uint8Array((await fs.promises.readFile(pdfPath)) as Uint8Array);
	const task = pdfjs.getDocument({ data, verbosity: 0 });
	const doc = await task.promise;
	try {
		const out: RenderedPdfPage[] = [];
		for (const n of pages) {
			if (n < 1 || n > doc.numPages) continue;
			const page = await doc.getPage(n);
			const base = page.getViewport({ scale: 1 });
			let scale = (opts.dpi ?? 100) / 72;
			scale = Math.min(scale, MAX_CANVAS_SIDE / base.width, MAX_CANVAS_SIDE / base.height);
			const area = base.width * scale * base.height * scale;
			if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
			const viewport = page.getViewport({ scale });
			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			await page.render({ canvas, viewport }).promise;
			out.push({ page: n, png: await canvasPng(canvas) });
			page.cleanup();
		}
		return out;
	} finally {
		await task.destroy();
	}
}

const browserHeadless: HeadlessApi = {
	available: () => true,
	unavailableReason: () => null,
	runDemo,
	renderSvg,
	renderPdfPages,
};

/** Test seam, as in the desktop module. */
export const headlessOverride: { current?: HeadlessApi } = {};

export function getHeadless(): HeadlessApi {
	return headlessOverride.current ?? browserHeadless;
}
