"use client";

/**
 * Built-in ```pixel fences: small pixel-art pictures the teacher writes as
 * text and the browser paints. It costs no tool call and has no server side.
 * The model writes a palette of one-character keys and one text row per
 * pixel row, at most 32×32:
 *
 *     title: Water molecule        (optional)
 *     scale: 8                     (optional, screen px per pixel, 1–32)
 *     palette:
 *       r: #e53935   # oxygen       (a "# label" becomes a legend chip)
 *       w: #ffffff   # hydrogen
 *     ---
 *     ..ww....ww..
 *     ...rrrrrr...
 *
 * `.` is always transparent. The picture is an inline SVG (crisp edges, one
 * rect per horizontal colour run), so it renders in static markup too; PNG
 * download paints the same grid on a canvas, only on click.
 */

import { useContext, useMemo } from "react";
import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { useIsCodeFenceIncomplete } from "streamdown";
import { CopyCorner, MarkdownDisplayOnlyContext } from "@/components/md-blocks";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { blurAfterPointerClick } from "@/components/focus-hygiene";

export const PIXEL_MAX_SIDE = 32;
export const PIXEL_MAX_COLORS = 16;
const TRANSPARENT = ".";
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Display width the automatic scale aims for, in CSS px. */
const AUTO_TARGET_PX = 320;

export interface PixelColor {
	key: string;
	hex: string;
	label?: string;
}

export interface PixelArt {
	title?: string;
	/** Screen px per pixel (explicit or automatic). */
	scale: number;
	palette: PixelColor[];
	/** One string per pixel row, all the same length. */
	rows: string[];
	width: number;
	height: number;
}

export type PixelParse = { ok: true; art: PixelArt } | { ok: false; error: string };

/** Parse and validate a pixel fence. Pure; every failure names the line. */
export function parsePixelArt(source: string): PixelParse {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const sep = lines.findIndex((line) => line.trim() === "---");
	if (sep < 0) return { ok: false, error: "Missing the `---` line between the palette and the pixel rows." };

	let title: string | undefined;
	let scale: number | undefined;
	let inPalette = false;
	const palette: PixelColor[] = [];
	for (let i = 0; i < sep; i++) {
		const line = lines[i]!.trim();
		if (line === "") continue;
		const at = `Line ${i + 1}`;
		const header = /^(title|scale|palette)\s*:\s*(.*)$/i.exec(line);
		if (header) {
			const name = header[1]!.toLowerCase();
			const value = header[2]!.trim();
			if (name === "title") {
				if (value) title = value;
				inPalette = false;
			} else if (name === "scale") {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 1 || n > 32) return { ok: false, error: `${at}: scale must be a whole number from 1 to 32.` };
				scale = n;
				inPalette = false;
			} else {
				if (value) return { ok: false, error: `${at}: put palette entries on their own lines under \`palette:\`.` };
				inPalette = true;
			}
			continue;
		}
		if (!inPalette) return { ok: false, error: `${at}: expected \`title:\`, \`scale:\` or \`palette:\`.` };
		const entry = /^(\S)\s*:\s*(#[0-9a-zA-Z]+)\s*(?:#\s*(.*))?$/.exec(line);
		if (!entry) return { ok: false, error: `${at}: a palette entry looks like \`r: #e53935 # label\`.` };
		const [, key, hex, label] = entry as unknown as [string, string, string, string | undefined];
		if (key === TRANSPARENT || key === "#") return { ok: false, error: `${at}: \`${key}\` can't be a palette key (\`.\` is always transparent).` };
		if (!HEX_RE.test(hex)) return { ok: false, error: `${at}: \`${hex}\` is not a #rgb or #rrggbb colour.` };
		if (palette.some((c) => c.key === key)) return { ok: false, error: `${at}: palette key \`${key}\` is defined twice.` };
		palette.push({ key, hex: hex.toLowerCase(), ...(label?.trim() ? { label: label.trim() } : {}) });
	}
	if (palette.length === 0) return { ok: false, error: "The palette is empty: add at least one `key: #rrggbb` line under `palette:`." };
	if (palette.length > PIXEL_MAX_COLORS) return { ok: false, error: `The palette has ${palette.length} colours; the limit is ${PIXEL_MAX_COLORS}.` };

	// Whitespace is never a pixel (`.` is transparent), so indentation and
	// trailing spaces are trimmed rather than misread.
	const body = lines.slice(sep + 1).map((line) => line.trim());
	let first = 0;
	let last = body.length - 1;
	while (first <= last && body[first] === "") first++;
	while (last >= first && body[last] === "") last--;
	const rows = body.slice(first, last + 1);
	if (rows.length === 0) return { ok: false, error: "There are no pixel rows after `---`." };
	if (rows.length > PIXEL_MAX_SIDE) return { ok: false, error: `The picture has ${rows.length} rows; the limit is ${PIXEL_MAX_SIDE}.` };
	const keys = new Set(palette.map((c) => c.key));
	const width = [...rows[0]!].length;
	for (let r = 0; r < rows.length; r++) {
		const at = `Line ${sep + 2 + first + r}`;
		const cells = [...rows[r]!];
		if (cells.length === 0) return { ok: false, error: `${at}: blank row inside the picture (use \`.\` for transparent pixels).` };
		if (cells.length !== width) return { ok: false, error: `${at}: row is ${cells.length} pixels wide but the first row is ${width}. Every row must be the same width.` };
		const bad = cells.find((c) => c !== TRANSPARENT && !keys.has(c));
		if (bad !== undefined) return { ok: false, error: `${at}: \`${bad === " " ? "space" : bad}\` is not in the palette (use \`.\` for transparent).` };
	}
	if (width > PIXEL_MAX_SIDE) return { ok: false, error: `The picture is ${width} pixels wide; the limit is ${PIXEL_MAX_SIDE}.` };

	const side = Math.max(width, rows.length);
	const autoScale = Math.max(4, Math.min(16, Math.floor(AUTO_TARGET_PX / side)));
	return { ok: true, art: { ...(title ? { title } : {}), scale: scale ?? autoScale, palette, rows, width, height: rows.length } };
}

/** Horizontal runs of one colour: the rects the SVG draws. Pure. */
export function pixelRuns(art: Pick<PixelArt, "rows" | "palette">): Array<{ x: number; y: number; w: number; hex: string }> {
	const colour = new Map(art.palette.map((c) => [c.key, c.hex]));
	const runs: Array<{ x: number; y: number; w: number; hex: string }> = [];
	art.rows.forEach((row, y) => {
		const cells = [...row];
		let x = 0;
		while (x < cells.length) {
			const key = cells[x]!;
			let end = x + 1;
			while (end < cells.length && cells[end] === key) end++;
			const hex = colour.get(key);
			if (key !== TRANSPARENT && hex) runs.push({ x, y, w: end - x, hex });
			x = end;
		}
	});
	return runs;
}

/** The picture as a standalone SVG document (fullscreen overlay input). Pure. */
export function pixelSvgDocument(art: PixelArt): string {
	const rects = pixelRuns(art).map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.hex}"/>`).join("");
	const w = art.width * art.scale;
	const h = art.height * art.scale;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${art.width} ${art.height}" shape-rendering="crispEdges">${rects}</svg>`;
}

/** Paint the grid on a canvas and save it as PNG. DOM-only; runs on click. */
function downloadPng(art: PixelArt): void {
	const canvas = document.createElement("canvas");
	canvas.width = art.width * art.scale;
	canvas.height = art.height * art.scale;
	const g = canvas.getContext("2d");
	if (!g) return;
	for (const r of pixelRuns(art)) {
		g.fillStyle = r.hex;
		g.fillRect(r.x * art.scale, r.y * art.scale, r.w * art.scale, art.scale);
	}
	canvas.toBlob((blob) => {
		if (!blob) return;
		void blob.arrayBuffer().then((buf) => downloadFile(`${slugFilename(art.title ?? "pixel-art")}.png`, new Uint8Array(buf), "image/png"));
	}, "image/png");
}

function PixelError({ source, error, displayOnly }: { source: string; error: string; displayOnly: boolean }) {
	return (
		<div className="my-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4" data-testid="md-pixel-error">
			<p className="text-sm font-medium text-destructive">Pixel art failed to render</p>
			<p className="mt-1 font-mono text-xs break-words text-muted-foreground">{error}</p>
			{displayOnly ? (
				<pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">{source}</pre>
			) : (
				<details className="mt-3">
					<summary className="cursor-pointer text-xs text-muted-foreground">Show pixel source</summary>
					<pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">{source}</pre>
				</details>
			)}
		</div>
	);
}

const iconButton = "flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/md:opacity-100";

/** The in-message pixel picture: the image, its title and legend, and the
 *  hover corner (copy source, download PNG, fullscreen). */
export function PixelArtInline({ source }: { source: string }) {
	const displayOnly = useContext(MarkdownDisplayOnlyContext);
	const incomplete = useIsCodeFenceIncomplete();
	const overlay = useSessionMermaid();
	const parsed = useMemo(() => (incomplete ? null : parsePixelArt(source)), [source, incomplete]);

	if (parsed === null) {
		return (
			<div data-testid="md-pixel" className="my-4 flex justify-center p-4" aria-busy="true">
				<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
			</div>
		);
	}
	if (!parsed.ok) return <PixelError source={source} error={parsed.error} displayOnly={displayOnly} />;
	const { art } = parsed;
	const legend = art.palette.filter((c) => c.label);
	return (
		<figure data-testid="md-pixel" className="group/md relative my-4 mx-auto w-fit max-w-full">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				role="img"
				aria-label={art.title ?? "Pixel art"}
				width={art.width * art.scale}
				height={art.height * art.scale}
				viewBox={`0 0 ${art.width} ${art.height}`}
				shapeRendering="crispEdges"
				className="mx-auto block h-auto max-w-full"
			>
				{pixelRuns(art).map((r) => (
					<rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.hex} />
				))}
			</svg>
			{(art.title || legend.length > 0) && (
				<figcaption className="mt-2 flex w-0 min-w-full flex-col items-center gap-1.5">
					{art.title && <span className="text-sm text-muted-foreground" data-testid="md-pixel-title">{art.title}</span>}
					{legend.length > 0 && (
						<ul className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="md-pixel-legend">
							{legend.map((c) => (
								<li key={c.key} className="flex items-center gap-1.5">
									<span aria-hidden="true" className="inline-block size-3 rounded-sm border border-border" style={{ backgroundColor: c.hex }} />
									{c.label}
								</li>
							))}
						</ul>
					)}
				</figcaption>
			)}
			{!displayOnly && (
				<div className="absolute top-0 right-0 flex items-start gap-0.5">
					<CopyCorner getText={() => source} label="Copy pixel source" />
					<button
						type="button"
						aria-label="Download PNG"
						data-testid="md-pixel-download"
						className={iconButton}
						onClick={(e) => {
							blurAfterPointerClick(e);
							downloadPng(art);
						}}
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open pixel art full-screen"
							data-testid="md-pixel-expand"
							className={iconButton}
							onClick={(e) => {
								blurAfterPointerClick(e);
								overlay.openFigure(pixelSvgDocument(art), false);
							}}
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			)}
		</figure>
	);
}
