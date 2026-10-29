import * as fs from "node:fs/promises";
import type { LibraryFileFormat, LibraryFileMeta, LibraryReadVia, LibraryTag } from "../../core/contracts.ts";
import { parsePageSpec, pdfExtract, pdfSearch } from "../subagents/pdf-ops.ts";
import type { HeadlessApi } from "../subagents/headless.ts";
import { processImage, type ProcessImageOptions } from "../image-processing/index.ts";
import { embeddedImageMime, readEmbeddedImage, type ExtractedDocument } from "./office-extract.ts";

/**
 * THE LIBRARY READING SURFACE (course library wave, 2026-10-29): one view
 * of an attached library file, whatever its format, and the three reading
 * operations every consumer shares — the teacher's direct library tools,
 * the library-reader sub-agent (summaries + background briefs), and tests.
 *
 * Units are the citation grain: PDF pages, slides (PPTX — extracted, or
 * the converted PDF's pages), DOCX sections (extracted) or pages
 * (converted), and a single "image" for picture files.
 *
 * The server builds LibraryReadable values from the store (the agent layer
 * never touches the store); every operation here throws a readable Error
 * the tool layer turns into an error STRING for the model.
 */

export interface LibraryReadable {
	id: string;
	name: string;
	/** Library display path ("Math 3339/Unit 1/Quizzes/quiz1.pdf"). */
	path: string;
	/** Effective tag (own or inherited). */
	tag?: LibraryTag;
	format: LibraryFileFormat;
	status: LibraryFileMeta["status"];
	via?: LibraryReadVia;
	/** Unit count (pages / slides / sections). */
	pages?: number;
	error?: string;
	mime: string;
	/** The stored original. */
	originalPath: string;
	/** The PDF to read for via "pdf" | "converted-pdf". */
	pdfPath?: string;
	/** The extraction for via "extracted" (lazy: read on demand). */
	extracted?: () => ExtractedDocument | null;
	/** Cached summary text for the current content, when present. */
	summary?: string;
}

/** Text output ceiling per read — narrow the range instead of a book dump. */
export const READ_CAP = 24_000;
/** Units per view call — keeps one call from flooding vision context. */
export const VIEW_CAP = 6;

export type UnitLabel = "page" | "slide" | "section" | "image";

export function unitLabel(file: Pick<LibraryReadable, "format" | "via">): UnitLabel {
	if (file.format === "image") return "image";
	if (file.format === "pptx") return "slide";
	if (file.format === "docx") return file.via === "extracted" ? "section" : "page";
	return "page";
}

function requireReady(file: LibraryReadable): void {
	if (file.status === "processing") throw new Error(`${file.name} is still being imported — try again shortly`);
	if (file.status === "failed") throw new Error(`${file.name} could not be imported: ${file.error ?? "unknown error"}`);
}

function requireExtracted(file: LibraryReadable): ExtractedDocument {
	const doc = file.extracted?.();
	if (!doc) throw new Error(`${file.name}: extracted content is missing`);
	return doc;
}

function capText(text: string): string {
	if (text.length <= READ_CAP) return text;
	return `${text.slice(0, READ_CAP)}\n\n[Output truncated at ${READ_CAP} characters — request a narrower range.]`;
}

/** Text of the requested units ("all", "1-5", "1,3,7", "3"), each headed
 *  `--- Slide N: Title ---` / `--- Page N ---`. */
export async function readUnits(file: LibraryReadable, spec: string): Promise<{ text: string; units: number[] }> {
	requireReady(file);
	const label = unitLabel(file);
	if (label === "image") {
		return { text: `${file.name} is an image — use library_view to look at it.`, units: [] };
	}
	if (file.via === "extracted") {
		const doc = requireExtracted(file);
		const units = parsePageSpec(spec, doc.units.length);
		if (units.length === 0) return { text: `No ${label}s selected — ${file.name} has ${doc.units.length}.`, units };
		const Label = label[0]!.toUpperCase() + label.slice(1);
		const parts = units.map((n) => {
			const u = doc.units[n - 1]!;
			const lines = [`--- ${Label} ${n}${u.title ? `: ${u.title}` : ""} ---`, u.text || "(no text)"];
			if (u.notes) lines.push(`[Speaker notes] ${u.notes}`);
			if (u.images.length) lines.push(`[${u.images.length} picture${u.images.length === 1 ? "" : "s"} — library_view ${label} ${n} to see]`);
			return lines.join("\n");
		});
		return { text: capText(parts.join("\n\n")), units };
	}
	if (!file.pdfPath) throw new Error(`${file.name} has no readable content`);
	const total = file.pages ?? 0;
	const units = parsePageSpec(spec, total);
	if (units.length === 0) return { text: `No ${label}s selected — ${file.name} has ${total}.`, units };
	let text = await pdfExtract(file.pdfPath, units.join(","));
	if (label === "slide") text = text.replace(/^--- Page (\d+) ---$/gm, "--- Slide $1 ---");
	return { text: capText(text), units };
}

/** Case-insensitive search (literal text) across the file's units; each
 *  hit is the unit number plus a snippet around the match. */
export async function searchUnits(file: LibraryReadable, query: string, maxHits = 20): Promise<{ text: string; units: number[] }> {
	requireReady(file);
	const label = unitLabel(file);
	if (label === "image") return { text: `${file.name} is an image — use library_view to look at it.`, units: [] };
	if (!query.trim()) throw new Error("query is empty");
	const texts = new Map<number, string>();
	if (file.via === "extracted") {
		requireExtracted(file).units.forEach((u) => texts.set(u.index, [u.title, u.text, u.notes].filter(Boolean).join("\n")));
	} else {
		if (!file.pdfPath) throw new Error(`${file.name} has no readable content`);
		for (const [page, text] of (await pdfSearch(file.pdfPath, query, { literal: true, contextLines: 0 })).pageTexts) texts.set(page, text);
	}
	const needle = query.toLowerCase();
	const hits: string[] = [];
	const units: number[] = [];
	for (const [n, text] of texts) {
		const at = text.toLowerCase().indexOf(needle);
		if (at < 0) continue;
		units.push(n);
		if (hits.length < maxHits) {
			const start = Math.max(0, at - 160);
			const end = Math.min(text.length, at + needle.length + 160);
			const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
			hits.push(`${label} ${n}: ${snippet}`);
		}
	}
	if (units.length === 0) return { text: `No matches for "${query}" in ${file.name}.`, units };
	const more = units.length > hits.length ? `\n[${units.length - hits.length} more ${label}s match — refine the query.]` : "";
	return { text: `${units.length} ${label}${units.length === 1 ? "" : "s"} match:\n${hits.join("\n")}${more}`, units };
}

export interface ViewedImage {
	data: string;
	mimeType: string;
}

export interface ViewOptions {
	headless: HeadlessApi;
	dpi?: number;
	/** The consuming model's image resize limits. */
	resize?: ProcessImageOptions["resizeOptions"];
}

/** Look at units as images: rendered PDF pages/slides, an extracted
 *  unit's embedded pictures, or the image file itself. */
export async function viewUnits(
	file: LibraryReadable,
	spec: string,
	opts: ViewOptions,
): Promise<{ text: string; images: ViewedImage[]; units: number[] }> {
	requireReady(file);
	const label = unitLabel(file);
	const notes: string[] = [];
	const images: ViewedImage[] = [];
	const push = async (bytes: Uint8Array, mime: string, caption: string) => {
		const processed = await processImage(bytes, mime, { resizeOptions: opts.resize });
		if (processed.ok) {
			images.push({ data: processed.data, mimeType: processed.mimeType });
			notes.push([caption, ...processed.hints].join(" "));
		} else notes.push(`${caption}: ${processed.message}`);
	};

	if (label === "image") {
		await push(new Uint8Array(await fs.readFile(file.originalPath)), file.mime, `${file.name}`);
		return { text: notes.join("\n"), images, units: [1] };
	}

	if (file.via === "extracted") {
		const doc = requireExtracted(file);
		const units = parsePageSpec(spec, doc.units.length).slice(0, VIEW_CAP);
		if (units.length === 0) return { text: `No ${label}s selected — ${file.name} has ${doc.units.length}.`, images, units };
		const original = new Uint8Array(await fs.readFile(file.originalPath));
		for (const n of units) {
			const unit = doc.units[n - 1]!;
			if (unit.images.length === 0) {
				notes.push(`${label} ${n}: no pictures (its text is available via library_read).`);
				continue;
			}
			for (const zipPath of unit.images) {
				const mime = embeddedImageMime(zipPath);
				const bytes = mime ? readEmbeddedImage(original, zipPath) : null;
				if (!mime || !bytes) {
					notes.push(`${label} ${n}: a picture in an unsupported format was skipped.`);
					continue;
				}
				await push(bytes, mime, `${label} ${n} picture`);
			}
		}
		notes.unshift(`(${file.name} is read from extracted content — layout isn't available, only its embedded pictures.)`);
		return { text: notes.join("\n"), images, units };
	}

	if (!file.pdfPath) throw new Error(`${file.name} has no readable content`);
	const units = parsePageSpec(spec, file.pages ?? 0).slice(0, VIEW_CAP);
	if (units.length === 0) return { text: `No ${label}s selected — ${file.name} has ${file.pages ?? 0}.`, images, units };
	const rendered = await opts.headless.renderPdfPages(file.pdfPath, units, { dpi: opts.dpi ?? 150 });
	for (const page of rendered) await push(new Uint8Array(page.png), "image/png", `${label} ${page.page}`);
	return { text: notes.join("\n"), images, units };
}
