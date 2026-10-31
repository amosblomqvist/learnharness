import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * PDF → Markdown by rule, no model: pdfjs text positions and font sizes become headings,
 * line-separated text and lists. Serves the notes import (whose chunker then splits the Markdown)
 * and the pdf-reader tools. Preserve extracted lines, words and repeated margin text: the model
 * interprets the source, rather than relying on deletion or wrapped-line reconstruction here.
 */

export type PdfPage =
	| { kind: "text"; number: number; markdown: string }
	| { kind: "image-only"; number: number }
	| { kind: "empty"; number: number };

type TextContentItem = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"][number];

interface Glyph {
	str: string;
	rtl: boolean;
	x: number;
	y: number;
	size: number;
	width: number;
	rotated: boolean;
	hasEOL: boolean;
}

interface Line {
	text: string;
	rotated: boolean;
	size: number;
	y: number;
	x0: number;
}

interface PageScan {
	page: PDFPageProxy;
	lines: Line[];
}

type Block =
	| { type: "heading"; level: 1 | 2 | 3; text: string }
	| { type: "item"; depth: number; y: number; text: string }
	| { type: "paragraph"; text: string };

const BULLET = /^\s*[\u2022\u25CF\u25AA\u2013\u2014\uF0B7-]\s+/;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
// Arabic presentation forms and Latin ligatures only: full-text NFKC would also flatten x² to x2.
const COMPAT = /[\uFB00-\uFB06\uFB50-\uFDFF\uFE70-\uFEFF]+/g;
const MAX_HEADING_CHARS = 150;

// Control bytes (NUL from emoji and stretchy math glyphs) carry no text; tab and newline are whitespace already.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const clean = (s: string) => s.replace(COMPAT, (m) => m.normalize("NFKC")).replace(PRIVATE_USE, "").replace(CONTROL, "");
const roundSize = (l: Line) => Math.round(l.size * 10) / 10;
// A heading is mostly letters; figure labels ("∑=") and chart or zone digits ("2 2/3 43") are not.
const mostlyLetters = (s: string) => (s.match(/\p{L}/gu) ?? []).length >= s.replace(/\s/g, "").length / 2;

function toGlyph(item: TextContentItem): Glyph | null {
	if (!("str" in item)) return null;
	const [a, b, c, d, x, y] = item.transform.map(Number);
	return {
		str: item.str,
		rtl: item.dir === "rtl",
		x: x ?? 0,
		y: y ?? 0,
		size: Math.hypot(a ?? 0, b ?? 0),
		width: item.width,
		rotated: Math.abs(b ?? 0) > 0.01 || Math.abs(c ?? 0) > 0.01,
		hasEOL: item.hasEOL,
	};
}

function toLine(glyphs: Glyph[]): Line | null {
	const visible = glyphs.filter((g) => g.str.trim());
	const first = visible[0];
	if (!first) return null;
	const rtl = glyphs.filter((g) => g.str && g.rtl).length > glyphs.filter((g) => g.str).length / 2;
	// pdfjs streams right-to-left words in visual order: read them back right to left.
	const ordered = rtl ? [...glyphs].sort((p, q) => q.x - p.x) : glyphs;
	let joined = "";
	let prevEnd: number | null = null;
	for (const g of ordered) {
		// Separate boxes on a form touch in the stream with no space item: add one on a visible gap, or when
		// the text jumps back left ("2025" then "U.S." on a form, "Hours" then the next column line).
		const size = g.size || 1;
		const apart = prevEnd !== null && (g.x - prevEnd > size * 0.25 || g.x < prevEnd - size * 2);
		if (!rtl && apart && g.str && !/\s$/.test(joined) && !/^\s/.test(g.str)) joined += " ";
		joined += g.str;
		if (g.str) prevEnd = g.x + g.width;
	}
	const text = clean(joined).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return {
		text,
		rotated: visible.some((g) => g.rotated),
		size: Math.max(...visible.map((g) => g.size)),
		y: first.y,
		x0: Math.min(...visible.map((g) => g.x)),
	};
}

const visible = (line: readonly Glyph[]) => line.filter((g) => g.str.trim() && !g.rotated && !g.rtl).sort((p, q) => p.x - q.x);

/** Gaps of at least a font size between neighbouring glyphs of one line. */
function gapsIn(line: readonly Glyph[]): { lo: number; hi: number; y: number; size: number }[] {
	const v = visible(line);
	return v.slice(1).flatMap((g, k) => {
		const lo = v[k]!.x + v[k]!.width;
		return g.x - lo >= Math.max(g.size, 6) ? [{ lo, hi: g.x, y: g.y, size: g.size }] : [];
	});
}

/** One side of a gutter reads as a prose column: no cell gaps inside (a table's halves still hold them),
 * pieces of 15+ characters, and mostly lowercase words (table cells are codes and numbers: "SDA0 SA5 PCLK"). */
function isProseColumn(halves: readonly Glyph[][]): boolean {
	if (halves.filter((half) => gapsIn(half).length > 0).length > halves.length * 0.3) return false;
	const texts = halves.map((half) => visible(half).map((g) => g.str).join(" ").trim());
	const lengths = texts.map((t) => t.length).sort((a, b) => a - b);
	const words = texts.join(" ").split(/\s+/).filter(Boolean);
	const lowercase = words.filter((w) => /\p{Ll}/u.test(w)).length;
	return (lengths[Math.floor(lengths.length / 2)] ?? 0) >= 15 && lowercase >= words.length / 2;
}

/** Two prose columns that share baselines reach us glued, one pdfjs line per baseline ("generating" then
 * "• Direct Replacement"). A gutter is one empty vertical strip that at least 5 lines jump across; split
 * there only when both sides read as prose, then emit the whole left column before the right. */
function splitColumns(lines: Glyph[][]): Glyph[][] {
	const gaps = lines.flatMap((line, index) => gapsIn(line).map((gap) => ({ ...gap, index })));
	for (const seed of gaps) {
		let [lo, hi] = [seed.lo, seed.hi];
		const members = new Set<number>();
		const ys: number[] = [];
		for (const gap of gaps) {
			const [nlo, nhi] = [Math.max(lo, gap.lo), Math.min(hi, gap.hi)];
			if (nhi - nlo < seed.size * 0.5) continue;
			[lo, hi] = [nlo, nhi];
			members.add(gap.index);
			ys.push(gap.y);
		}
		if (members.size < 5) continue;
		const [top, bottom] = [Math.max(...ys) + seed.size, Math.min(...ys) - seed.size];
		const region = lines.flatMap((line, i) => (visible(line).some((g) => g.y <= top && g.y >= bottom) ? [i] : []));
		if (region.some((i) => visible(lines[i]!).some((g) => g.x < hi - 1 && g.x + g.width > lo + 1))) continue;
		const mid = (lo + hi) / 2;
		const half = (line: Glyph[], left: boolean) => line.filter((g) => (g.x + g.width / 2 < mid) === left);
		if (![true, false].every((left) => isProseColumn([...members].map((i) => half(lines[i]!, left))))) continue;
		const column = (left: boolean) => region.map((i) => half(lines[i]!, left)).filter((l) => l.some((g) => g.str.trim()));
		const outside = (keep: (i: number) => boolean) => lines.filter((_, i) => !region.includes(i) && keep(i));
		const first = region[0]!;
		return splitColumns([...outside((i) => i < first), ...column(true), ...column(false), ...outside((i) => i > first)]);
	}
	return lines;
}

async function scanPage(page: PDFPageProxy): Promise<PageScan> {
	const glyphs = (await page.getTextContent()).items.flatMap((item) => toGlyph(item) ?? []);
	const groups: Glyph[][] = [[]];
	for (const glyph of glyphs) {
		groups.at(-1)!.push(glyph);
		if (glyph.hasEOL) groups.push([]);
	}
	const lines = splitColumns(groups).flatMap((group) => toLine(group) ?? []);
	return { page, lines };
}

/** Whether a page without text draws a picture. Asked only of such pages: building the operator list
 * was two thirds of the conversion time when every page paid for it. */
async function drawsImage(page: PDFPageProxy): Promise<boolean> {
	const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const imageOps = new Set([
		OPS.paintImageXObject,
		OPS.paintImageXObjectRepeat,
		OPS.paintInlineImageXObject,
		OPS.paintInlineImageXObjectGroup,
		OPS.paintImageMaskXObject,
		OPS.paintImageMaskXObjectGroup,
		OPS.paintImageMaskXObjectRepeat,
		OPS.paintSolidColorImageMask,
	]);
	return (await page.getOperatorList()).fnArray.some((op) => imageOps.has(op));
}

/** Body size: the whole-point size covering the most characters. Whole points, because justified
 * text jitters between 9.8 and 10.2pt; sideways text (arXiv margin stamps) never counts. */
function bodySize(lines: readonly Line[]): number {
	const chars = new Map<number, number>();
	for (const l of lines) if (!l.rotated) chars.set(Math.round(l.size), (chars.get(Math.round(l.size)) ?? 0) + l.text.length);
	let best = 0;
	let most = -1;
	for (const [size, n] of chars) if (n > most) [best, most] = [size, n];
	return best;
}

/** Slide apps write text boxes in z-order (Keynote writes the title last), but stream order is right
 * for papers, whose columns and author grids a top-to-bottom sort scrambles. So only a title that sits
 * clearly above everything else, plus its wrapped lines, moves back to the front. */
function titleFirst(lines: Line[], body: number): Line[] {
	const [top, next] = lines.filter((l) => !l.rotated).sort((p, q) => q.y - p.y);
	if (!top || !next) return lines;
	const i = lines.indexOf(top);
	if (i <= 0 || top.size < body + 1.95 || top.y - next.y < top.size * 0.8) return lines;
	let j = i + 1;
	while (j < lines.length && Math.abs(lines[j]!.size - top.size) < 0.5 && lines[j - 1]!.y - lines[j]!.y < top.size * 1.8) j++;
	return [...lines.slice(i, j), ...lines.slice(0, i), ...lines.slice(j)];
}

function toBlocks(lines: readonly Line[], body: number): Block[] {
	// Levels by size relative to the page's body: ranking every size fails on slides, where one 72pt figure label takes level 1.
	const levelOf = (l: Line): 0 | 1 | 2 | 3 => {
		if (l.rotated || BULLET.test(l.text) || roundSize(l) < body + 1.95 || !mostlyLetters(l.text)) return 0;
		return l.size >= body * 1.6 ? 1 : l.size >= body * 1.3 ? 2 : 3;
	};
	const blocks: Block[] = [];
	const listXs: number[] = []; // x of each open list depth
	for (const l of lines) {
		const level = levelOf(l);
		const indent = l.size * 0.3;
		const bullet = BULLET.test(l.text);
		if (level) {
			blocks.push({ type: "heading", level, text: l.text });
		} else if (bullet) {
			// A bullet higher up the page than the last one starts a new side-by-side list column.
			const lastItem = blocks.findLast((b) => b.type === "item");
			if (lastItem && l.y > lastItem.y + indent) listXs.length = 0;
			while (listXs.length && l.x0 < listXs.at(-1)! - indent) listXs.pop();
			if (!listXs.length || l.x0 > listXs.at(-1)! + indent) listXs.push(l.x0);
			blocks.push({ type: "item", depth: listXs.length - 1, y: l.y, text: l.text.replace(BULLET, "") });
		} else {
			blocks.push({ type: "paragraph", text: l.text });
		}
	}
	return blocks;
}

function toMarkdown(blocks: readonly Block[]): string {
	// Body text that starts with "#" ("# of pixels") must not read as a heading.
	const plain = (s: string) => s.replace(/^#/, "\\#");
	return blocks
		.map((b, i) => {
			switch (b.type) {
				case "heading":
					return b.text.length <= MAX_HEADING_CHARS ? `${"#".repeat(b.level)} ${b.text}` : plain(b.text);
				case "item":
					return `${"  ".repeat(b.depth)}- ${plain(b.text)}${blocks[i + 1]?.type === "item" ? "\n" : ""}`;
				case "paragraph":
					return plain(b.text);
			}
		})
		.join("\n\n")
		.replace(/\n\n\n/g, "\n");
}

/** Convert the given pages (default: all). Formatting is page-local so search and selected reads agree. */
export async function documentToMarkdown(doc: PDFDocumentProxy, pageNumbers?: readonly number[]): Promise<PdfPage[]> {
	const numbers = pageNumbers ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
	const pages: PageScan[] = [];
	for (const n of numbers) pages.push(await scanPage(await doc.getPage(n)));
	const out: PdfPage[] = [];
	for (const p of pages) {
		const number = p.page.pageNumber;
		if (!p.lines.length) {
			out.push({ kind: (await drawsImage(p.page)) ? "image-only" : "empty", number });
			continue;
		}
		// Judge the body below the page's largest size (often its title), falling
		// back to the page's dominant size for uniform text. Never depend on which
		// other pages were requested: that would change title order and search lines.
		const top = Math.max(...p.lines.map(roundSize));
		const body = bodySize(p.lines.filter((l) => roundSize(l) < top)) || bodySize(p.lines);
		out.push({ kind: "text", number, markdown: toMarkdown(toBlocks(titleFirst(p.lines, body), body)) });
	}
	return out;
}

/** The pages that carry text, each under a `--- Page N ---` marker (the pdf-reader's existing format). */
export function joinPages(pages: readonly PdfPage[]): string {
	return pages.flatMap((p) => (p.kind === "text" ? [`--- Page ${p.number} ---\n\n${p.markdown}`] : [])).join("\n\n");
}
