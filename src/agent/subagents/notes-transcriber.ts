import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { processImage, type SupportedImageMimeType } from "../image-processing/index.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";
import type { PdfPage } from "./pdf-markdown.ts";
import { pdfInfo, type PdfPageInfo } from "./pdf-ops.ts";
import { streamOnce } from "./pdf-reader.ts";

/**
 * The notes transcriber (issue #285): turns an imported PDF or image into
 * Markdown text BEFORE the notes front door's extract → audit → merge — the
 * pipeline stays text-in; this is the only stage that sees pixels.
 *
 * PDFs are HYBRID (owner, 2026-10-29): the shared converter's Markdown
 * (pdf-markdown.ts, PR #324) for every text page, and a vision call only for
 * the pages that text can't carry — picture-only or empty (scans, vector
 * handwriting exports), or text pages that are math- or image-heavy or
 * text-poor (the pdf-reader's flagged-page signals). One call per page,
 * each under the shared background-LLM semaphore, so a long scan never
 * floods the provider.
 * Runs as the pdfReader role (vision slot) — no role of its own.
 *
 * Aborts propagate; any other failed page call fails the transcription
 * (nothing is merged yet, so a retry is clean).
 */

const INSTRUCTIONS = `You transcribe one page of a learner's own study material (lecture notes, slides, a textbook
or paper page, handwriting, a whiteboard photo) into Markdown, so a later step can extract
the ideas it contains.

Rules:
- Transcribe what is on the page, in reading order. Do not summarize, explain, correct, or
  add anything that is not there.
- Keep the structure: headings, lists, tables (as Markdown tables), and visible emphasis.
- Write all mathematics as LaTeX: $…$ inline, $$…$$ for display equations.
- For diagrams, figures, and charts, write a short bracketed description of what they show,
  including their labels and values, e.g. [Figure: …].
- Transcribe handwriting as written; mark unreadable words as [illegible].
- If extracted text is provided, use it for spelling and numbers, but trust the image where
  they disagree.
- Output only the transcription. If the page is blank, output nothing.`;

/** Render DPI for flagged pages — the pdf-reader doctrine's default. */
const RENDER_DPI = 150;
/** Below this many extracted chars a page is text-poor: a scan, a photo,
 *  or handwriting exported as vector ink. */
const TEXT_POOR_BELOW = 200;

export interface TranscribeOptions {
	engine: PiEngine;
	signal?: AbortSignal;
	/** One billed call — the stage's money channel ("provider:id" model). */
	onUsage?: (usage: Usage, model: string) => void;
	headless?: HeadlessApi;
}

/** Pages whose pdfjs text can't stand in for the page itself. */
export function needsVision(page: PdfPageInfo): boolean {
	return page.math_density >= 0.03 || page.image_count > 0 || page.text_length < TEXT_POOR_BELOW;
}

/** One vision call over one image; returns the transcription text. */
async function transcribeOne(
	image: { data: string; mimeType: string; hints: string[] },
	context: string,
	opts: TranscribeOptions,
): Promise<string> {
	const messages: Message[] = [{
		role: "user",
		content: [
			{ type: "text", text: [context, ...image.hints].join("\n") },
			{ type: "image", data: image.data, mimeType: image.mimeType },
		],
		timestamp: Date.now(),
	}];
	const result: AssistantMessage = await streamOnce(
		opts.engine,
		INSTRUCTIONS,
		messages,
		[],
		randomUUID(),
		opts.engine.level,
		opts.signal,
	);
	opts.onUsage?.(result.usage, `${result.provider}:${result.model}`);
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

function seesImages(engine: PiEngine): boolean {
	return engine.model.input.includes("image");
}

/** The pages the text layer can't carry, ascending: every picture-only or
 *  empty page, plus the text pages the signals flag. Empty = no vision. */
export async function visionPages(pdfPath: string, pages: readonly PdfPage[]): Promise<number[]> {
	const signals = new Map((await pdfInfo(pdfPath)).pages.map((page) => [page.page, page]));
	return pages
		.filter((page) => {
			const info = signals.get(page.number);
			return page.kind !== "text" || (info !== undefined && needsVision(info));
		})
		.map((page) => page.number);
}

/** A PDF as Markdown under `--- Page N ---` markers (joinPages' format):
 *  each `needed` page transcribed from its render (its converted text rides
 *  along as a hint), every other text page as converted. A model without
 *  image input, or a page image that can't be processed, keeps the page's
 *  converted text — picture-only pages then have none and drop out. */
export async function transcribePdf(pdfPath: string, pages: readonly PdfPage[], needed: readonly number[], opts: TranscribeOptions): Promise<string> {
	const headless = opts.headless ?? getHeadless();
	opts.signal?.throwIfAborted();
	const want = new Set(seesImages(opts.engine) ? needed : []);
	// The first failed page stops its siblings: no spend after a doomed run.
	const siblings = new AbortController();
	const signal = opts.signal ? AbortSignal.any([opts.signal, siblings.signal]) : siblings.signal;
	const pageOpts = { ...opts, signal };
	const bodies = await Promise.all(pages.map(async (page): Promise<string> => {
		const text = page.kind === "text" ? page.markdown : "";
		if (!want.has(page.number)) return text;
		try {
			// Render inside the permit: at most three page images in memory.
			return await withBgLlmSlot(signal, async () => {
				signal.throwIfAborted();
				const [rendered] = await headless.renderPdfPages(pdfPath, [page.number], { dpi: RENDER_DPI });
				if (!rendered) return text;
				const image = await processImage(rendered.png, "image/png", { resizeOptions: opts.engine.model.inputLimits?.images?.resize });
				signal.throwIfAborted();
				if (!image.ok) return text;
				const context = text.trim()
					? `Page ${page.number} of ${pages.length}. Extracted text (may be garbled or incomplete):\n${text}`
					: `Page ${page.number} of ${pages.length}. No text could be extracted from this page.`;
				return transcribeOne(image, context, pageOpts);
			});
		} catch (err) {
			siblings.abort();
			throw err;
		}
	}));
	return pages
		.flatMap((page, i) => (bodies[i]!.trim() ? [`--- Page ${page.number} ---\n\n${bodies[i]}`] : []))
		.join("\n\n");
}

/** An image file as Markdown — one vision call. */
export async function transcribeImage(bytes: Uint8Array, mimeType: SupportedImageMimeType, opts: TranscribeOptions): Promise<string> {
	if (!seesImages(opts.engine)) {
		throw new Error(`The vision model (${opts.engine.model.provider}:${opts.engine.model.id}) does not accept image input, so this image cannot be read. Choose an image-capable vision model in Settings.`);
	}
	const image = await processImage(bytes, mimeType, { resizeOptions: opts.engine.model.inputLimits?.images?.resize });
	opts.signal?.throwIfAborted();
	if (!image.ok) throw new Error(image.message);
	return withBgLlmSlot(opts.signal, () => transcribeOne(image, "An image of the learner's notes.", opts));
}
