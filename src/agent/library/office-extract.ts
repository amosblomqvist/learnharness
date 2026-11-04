import { unzipSync, type Unzipped } from "fflate";

/**
 * In-app DOCX / PPTX extraction — the course library's fallback reader
 * when LibreOffice isn't installed (owner ruling 2026-10-29: hybrid).
 *
 * OOXML is a zip of XML parts. This module unzips with fflate (pure JS)
 * and walks the XML with a tiny tag tokenizer — no DOM, no native deps.
 * What comes out is READING material, not layout: paragraph and table
 * text, PPTX speaker notes, Office-math runs as their plain text, and
 * references to embedded pictures (zip paths, read back from the original
 * file on demand so extracted.json never balloons with image bytes).
 *
 * Units: a PPTX unit is a SLIDE (presentation order); a DOCX unit is a
 * SECTION — split at headings, with long stretches split further — since
 * Word files have no stable pages without a layout engine.
 *
 * Pure: bytes in, structure out. Throws on a file that isn't valid OOXML.
 */

export interface ExtractedUnit {
	/** 1-based slide / section number — the citation unit. */
	index: number;
	/** Slide title or section heading, when one is recognizable. */
	title?: string;
	text: string;
	/** PPTX speaker notes. */
	notes?: string;
	/** Zip paths of pictures shown in this unit (e.g. "ppt/media/image3.png"). */
	images: string[];
}

export interface ExtractedDocument {
	format: "docx" | "pptx";
	unitLabel: "slide" | "section";
	units: ExtractedUnit[];
}

/** Section split threshold for long heading-less DOCX stretches. */
const MAX_SECTION_CHARS = 4000;

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

/** Mime type of an embedded picture by extension; null for formats the
 *  model can't take (EMF/WMF/TIFF vector or legacy formats). */
export function embeddedImageMime(zipPath: string): string | null {
	const ext = zipPath.slice(zipPath.lastIndexOf(".") + 1).toLowerCase();
	return IMAGE_MIME[ext] ?? null;
}

/** Read one embedded picture's bytes out of the original file. */
export function readEmbeddedImage(original: Uint8Array, zipPath: string): Uint8Array | null {
	const files = unzipSync(original, { filter: (f) => f.name === zipPath });
	return files[zipPath] ?? null;
}

export function extractOffice(bytes: Uint8Array, format: "docx" | "pptx"): ExtractedDocument {
	let zip: Unzipped;
	try {
		zip = unzipSync(bytes, { filter: (f) => f.name.endsWith(".xml") || f.name.endsWith(".rels") });
	} catch {
		throw new Error(`Not a readable ${format.toUpperCase()} file`);
	}
	return format === "pptx" ? extractPptx(zip) : extractDocx(zip);
}

// ─── XML tokenizing ───────────────────────────────────────────────────────────

interface Tag {
	kind: "open" | "close" | "self";
	name: string;
	attrs: string;
}
type Token = Tag | { kind: "text"; text: string };

const TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;

function* tokens(xml: string): Generator<Token> {
	for (const m of xml.matchAll(TOKEN)) {
		if (m[5] !== undefined) {
			yield { kind: "text", text: decodeEntities(m[5]) };
		} else if (m[2] !== undefined) {
			yield { kind: m[1] ? "close" : m[4] ? "self" : "open", name: m[2], attrs: m[3] ?? "" };
		}
	}
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
		const lower = code.toLowerCase();
		if (lower === "amp") return "&";
		if (lower === "lt") return "<";
		if (lower === "gt") return ">";
		if (lower === "quot") return '"';
		if (lower === "apos") return "'";
		const n = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
		return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
	});
}

function attr(attrs: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
	return m ? decodeEntities(m[1] ?? m[2] ?? "") : undefined;
}

function text(zip: Unzipped, name: string): string | null {
	const bytes = zip[name];
	return bytes ? new TextDecoder().decode(bytes) : null;
}

/** Relationship id → resolved zip path for one part's .rels file. */
function relationships(zip: Unzipped, partPath: string): Map<string, { target: string; type: string }> {
	const dir = partPath.slice(0, partPath.lastIndexOf("/") + 1);
	const relsPath = `${dir}_rels/${partPath.slice(dir.length)}.rels`;
	const out = new Map<string, { target: string; type: string }>();
	const xml = text(zip, relsPath);
	if (!xml) return out;
	for (const t of tokens(xml)) {
		if (t.kind === "text" || t.name !== "Relationship") continue;
		const id = attr(t.attrs, "Id");
		const target = attr(t.attrs, "Target");
		if (!id || !target || attr(t.attrs, "TargetMode") === "External") continue;
		out.set(id, { target: resolvePath(dir, target), type: attr(t.attrs, "Type") ?? "" });
	}
	return out;
}

function resolvePath(dir: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = (dir + target).split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "..") out.pop();
		else if (part !== "." && part !== "") out.push(part);
	}
	return out.join("/");
}

/** Text-run elements across WordprocessingML, DrawingML and Office Math. */
const TEXT_ELEMENTS = new Set(["w:t", "a:t", "m:t", "w:delText"]);

/**
 * Walk a part's XML into paragraphs: text runs concatenate, tabs/breaks
 * become whitespace, table cells join with " | " and rows end lines.
 * Picture references (r:embed / r:id on blips and image data) collect in
 * order via `onImage`, with the index of the paragraph they belong to in
 * the returned list. A picture alone in its paragraph (no text, so the
 * paragraph is dropped) rides with the PRECEDING paragraph — a figure
 * belongs to the content it follows, never to the next heading. Each
 * paragraph carries its style id (for DOCX heading detection).
 */
function paragraphs(xml: string, onImage: (relId: string, paraIndex: number) => void): { text: string; style?: string }[] {
	const out: { text: string; style?: string }[] = [];
	let current = "";
	let style: string | undefined;
	let inText = 0;
	let cellDepth = 0;
	let rowCells: string[] | null = null;
	let pendingImages: string[] = [];
	// Office Math delimiters (m:d): brackets live in properties, not text
	// runs — default "(" ")" unless m:begChr / m:endChr say otherwise.
	const delimiters: { beg: string; end: string; opened: boolean }[] = [];
	const flush = () => {
		const cleaned = current.replace(/[ \t]+/g, " ").trim();
		if (rowCells !== null && cellDepth > 0) {
			// Inside a table cell: paragraphs accumulate into the cell.
			if (cleaned) rowCells[rowCells.length - 1] = `${rowCells[rowCells.length - 1]} ${cleaned}`.trim();
		} else if (cleaned) {
			out.push({ text: cleaned, ...(style ? { style } : {}) });
		}
		// Table-cell pictures wait for the row (out.length is its index then).
		if (rowCells === null || cellDepth === 0) {
			for (const rel of pendingImages) onImage(rel, Math.max(0, out.length - 1));
			pendingImages = [];
		}
		current = "";
		style = undefined;
	};
	for (const t of tokens(xml)) {
		if (t.kind === "text") {
			if (inText > 0) current += t.text;
			continue;
		}
		const { name } = t;
		if (TEXT_ELEMENTS.has(name)) {
			if (t.kind === "open") inText++;
			else if (t.kind === "close") inText = Math.max(0, inText - 1);
			continue;
		}
		if (t.kind === "close") {
			if (name === "m:d") {
				const d = delimiters.pop();
				if (d) current += d.opened ? d.end : `${d.beg}${d.end}`;
			} else if (name === "w:p" || name === "a:p") flush();
			else if (name === "w:tc" || name === "a:tc") cellDepth = Math.max(0, cellDepth - 1);
			else if (name === "w:tr" || name === "a:tr") {
				if (rowCells && rowCells.some((c) => c)) out.push({ text: rowCells.join(" | ") });
				rowCells = null;
				for (const rel of pendingImages) onImage(rel, Math.max(0, out.length - 1));
				pendingImages = [];
			}
			continue;
		}
		switch (name) {
			case "m:d":
				if (t.kind === "open") delimiters.push({ beg: "(", end: ")", opened: false });
				break;
			case "m:begChr":
			case "m:endChr": {
				const d = delimiters[delimiters.length - 1];
				const value = attr(t.attrs, "m:val");
				if (d && value !== undefined) d[name === "m:begChr" ? "beg" : "end"] = value;
				break;
			}
			case "m:e": {
				const d = delimiters[delimiters.length - 1];
				if (d && !d.opened) {
					current += d.beg;
					d.opened = true;
				}
				break;
			}
			case "w:tab":
			case "a:tab":
				current += "\t";
				break;
			case "w:br":
			case "a:br":
			case "w:cr":
				current += " ";
				break;
			case "w:tr":
			case "a:tr":
				rowCells = [];
				break;
			case "w:tc":
			case "a:tc":
				if (t.kind === "open") {
					cellDepth++;
					rowCells?.push("");
				}
				break;
			case "w:pStyle":
				style = attr(t.attrs, "w:val");
				break;
			case "a:blip":
			case "v:imagedata": {
				const rel = attr(t.attrs, "r:embed") ?? attr(t.attrs, "r:id");
				if (rel) pendingImages.push(rel);
				break;
			}
		}
	}
	flush();
	return out;
}

// ─── PPTX ─────────────────────────────────────────────────────────────────────

function extractPptx(zip: Unzipped): ExtractedDocument {
	const presentation = text(zip, "ppt/presentation.xml");
	if (presentation === null) throw new Error("Not a readable PPTX file (no presentation part)");
	const presRels = relationships(zip, "ppt/presentation.xml");
	const slidePaths: string[] = [];
	for (const t of tokens(presentation)) {
		if (t.kind === "text" || t.name !== "p:sldId") continue;
		const rel = presRels.get(attr(t.attrs, "r:id") ?? "");
		if (rel) slidePaths.push(rel.target);
	}
	const units: ExtractedUnit[] = slidePaths.map((slidePath, i) => {
		const rels = relationships(zip, slidePath);
		const images: string[] = [];
		const xml = text(zip, slidePath) ?? "";
		const paras = paragraphs(xml, (relId) => {
			const target = rels.get(relId)?.target;
			if (target && !images.includes(target)) images.push(target);
		});
		const title = slideTitle(xml);
		const notesRel = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"));
		const notes = notesRel ? notesText(text(zip, notesRel.target) ?? "") : "";
		return {
			index: i + 1,
			...(title ? { title } : {}),
			text: paras.map((p) => p.text).join("\n"),
			...(notes ? { notes } : {}),
			images,
		};
	});
	return { format: "pptx", unitLabel: "slide", units };
}

/** The text of the slide's title placeholder (type="title"/"ctrTitle"). */
function slideTitle(xml: string): string | undefined {
	for (const shape of xml.split(/<p:sp[\s>]/).slice(1)) {
		if (/<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/.test(shape)) {
			const title = paragraphs(shape, () => {}).map((p) => p.text).join(" ").trim();
			if (title) return title;
		}
	}
	return undefined;
}

/** Speaker notes: the notes slide's body placeholder only (the slide
 *  thumbnail and page number placeholders are not notes). */
function notesText(xml: string): string {
	const bodies = xml.split(/<p:sp[\s>]/).slice(1).filter((shape) => /<p:ph\b[^>]*\btype="body"/.test(shape));
	return bodies.flatMap((shape) => paragraphs(shape, () => {}).map((p) => p.text)).join("\n").trim();
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

function extractDocx(zip: Unzipped): ExtractedDocument {
	const documentPath = "word/document.xml";
	const xml = text(zip, documentPath);
	if (xml === null) throw new Error("Not a readable DOCX file (no document part)");
	const rels = relationships(zip, documentPath);
	const headingStyles = headingStyleIds(text(zip, "word/styles.xml") ?? "");

	// Each picture rides with the paragraph it sits in, so it lands in
	// that paragraph's section.
	const imagesAt = new Map<number, string[]>();
	const paras = paragraphs(xml, (relId, paraIndex) => {
		const target = rels.get(relId)?.target;
		if (target) imagesAt.set(paraIndex, [...(imagesAt.get(paraIndex) ?? []), target]);
	});
	const units: ExtractedUnit[] = [];
	let section: { title?: string; lines: string[]; images: string[]; chars: number } = { lines: [], images: [], chars: 0 };
	const close = () => {
		if (section.lines.length === 0 && section.images.length === 0) return;
		units.push({
			index: units.length + 1,
			...(section.title ? { title: section.title } : {}),
			text: section.lines.join("\n"),
			images: section.images,
		});
		section = { lines: [], images: [], chars: 0 };
	};
	paras.forEach((p, i) => {
		const isHeading = p.style !== undefined && headingStyles.has(p.style);
		if (isHeading || section.chars + p.text.length > MAX_SECTION_CHARS) {
			close();
			if (isHeading) section.title = p.text;
		}
		section.lines.push(p.text);
		section.chars += p.text.length;
		for (const target of imagesAt.get(i) ?? []) if (!section.images.includes(target)) section.images.push(target);
	});
	// Pictures after the last text paragraph join the final section.
	for (const [at, targets] of imagesAt) {
		if (at < paras.length) continue;
		for (const target of targets) if (!section.images.includes(target)) section.images.push(target);
	}
	close();
	return { format: "docx", unitLabel: "section", units };
}

/** Style ids that are headings: built-in Title/Heading N (by id or name)
 *  and any style with an outline level. */
function headingStyleIds(stylesXml: string): Set<string> {
	const ids = new Set<string>(["Title"]);
	for (let n = 1; n <= 9; n++) ids.add(`Heading${n}`);
	for (const block of stylesXml.split(/<w:style[\s>]/).slice(1)) {
		const id = /w:styleId="([^"]*)"/.exec(block)?.[1];
		if (!id) continue;
		const name = /<w:name\s+w:val="([^"]*)"/.exec(block)?.[1]?.toLowerCase() ?? "";
		if (/^(heading \d|title)$/.test(name) || /<w:outlineLvl\b/.test(block)) ids.add(id);
	}
	return ids;
}
