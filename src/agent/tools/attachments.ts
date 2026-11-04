import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AttachmentRecord } from "../../core/contracts.ts";
import { serverExecute } from "../tool-execute.ts";
import { epubChapterMarkdown, epubInfo, epubSearch } from "../subagents/epub-ops.ts";
import { pdfExtract, pdfInfo, pdfSearch } from "../subagents/pdf-ops.ts";
import { processImage } from "../image-processing/index.ts";
import { capOutput, formatSize } from "./fs-shared.ts";
import { readTextSlice, type ReadModel } from "./read.ts";

/**
 * Session context attachments (2026-10-29) — the agent side. The learner
 * attaches images, PDFs and EPUBs; the server resolves the session's
 * ACTIVE files to absolute paths (SessionAttachment) — the agent never
 * learns where blobs live or which files were removed. Here:
 *
 * - attachmentsPromptSection: the system prompt's manifest, rebuilt every
 *   turn from the record (survives compaction and resume), stable while
 *   the list is unchanged so prompt caching holds;
 * - attachmentTools: paged readers scoped to THIS session's records (the
 *   blob root holds every session's files, so a dir check isn't enough) — pdf_*
 *   (pdf-ops, the researcher's text layer) and epub_* (epub-ops). The
 *   agent reads slices on demand, Claude Code style; nothing is inlined;
 * - attachmentImageParts: the wire hook that shows an image to a vision
 *   model on the message it was sent with (toLlmMessages), normalized and
 *   resized for that model like every other model-visible image (read,
 *   pdf, visuals share processImage).
 *
 * Tool contract (the web.ts law): expected failures RETURN error strings —
 * never throw into the agent loop.
 */

/** One active session attachment, resolved by the server: the record plus where its bytes live. */
export interface SessionAttachment {
	record: AttachmentRecord;
	/** Absolute path of the stored file. */
	path: string;
}

function describe(a: AttachmentRecord): string {
	const size = formatSize(a.bytes);
	if (a.kind === "pdf") return `PDF, ${a.pages ?? "?"} pages, ${size} → pdf_info / pdf_search / pdf_extract; the \`pdf\` job for figures and equations`;
	if (a.kind === "epub") return `EPUB${a.title ? ` "${a.title}"` : ""}, ${a.chapters ?? "?"} chapters, ${size} → epub_info / epub_search / epub_read`;
	return `image, ${size} → \`read\` this path to look at it (also shown on the message it was sent with, when there is one)`;
}

export function attachmentsPromptSection(attachments: readonly SessionAttachment[]): string {
	if (attachments.length === 0) return "";
	const lines = attachments.map((a) => `- ${a.record.name} — ${describe(a.record)} — path: ${a.path}`);
	return [
		"## Session attachments",
		"",
		"The learner attached these files to this session as context. Consult them when the lesson needs their content: " +
			"start from structure (pdf_info / epub_info), search for the passage you need, then read only those pages or that chapter. " +
			"Never read a whole book or document in one go. Cite page or chapter when you use them.",
		"",
		...lines,
	].join("\n");
}

/** Model-facing parts for one attached image id. */
type ImageParts = Array<TextContent | ImageContent>;

/** The wire hook for attached images (vision models only). Returns an
 *  async preparer: given the turn's messages, it processes every attached
 *  image they name with the model's resize limits (memoized for the
 *  agent's lifetime — one turn), then hands toLlmMessages a sync lookup.
 *  A missing or unprocessable file drops silently (the manifest still
 *  names it); an image processImage can't fit sends its omission note. */
export function attachmentImageParts(attachments: readonly SessionAttachment[], model: ReadModel) {
	const processed = new Map<string, Promise<ImageParts>>();
	const partsFor = (a: SessionAttachment): Promise<ImageParts> => {
		let parts = processed.get(a.record.id);
		if (!parts) {
			parts = fs
				.readFile(a.path)
				.then(async (bytes): Promise<ImageParts> => {
					const image = await processImage(bytes, a.record.mimeType, { resizeOptions: model.inputLimits?.images?.resize });
					if (!image.ok) return [{ type: "text", text: image.message }];
					const hints: ImageParts = image.hints.length > 0 ? [{ type: "text", text: image.hints.join("\n") }] : [];
					return [...hints, { type: "image", mimeType: image.mimeType, data: image.data }];
				})
				// File gone from disk, or processing threw: the image simply isn't
				// shown (convertToLlm must never throw).
				.catch((): ImageParts => []);
			processed.set(a.record.id, parts);
		}
		return parts;
	};
	return async (messages: readonly AgentMessage[]): Promise<(ids: readonly string[]) => ImageParts> => {
		const named = new Set<string>();
		for (const m of messages) {
			if ("attachmentIds" in m && Array.isArray(m.attachmentIds)) for (const id of m.attachmentIds) named.add(id);
		}
		const ready = new Map<string, ImageParts>();
		await Promise.all(
			attachments
				.filter((a) => a.record.kind === "image" && named.has(a.record.id))
				.map(async (a) => ready.set(a.record.id, await partsFor(a))),
		);
		return (ids) => ids.flatMap((id) => ready.get(id) ?? []);
	};
}

const pathParam = Type.String({ description: "The attachment's path, exactly as listed under Session attachments" });

function failure(tool: string, err: unknown): string {
	return `${tool} failed: ${err instanceof Error ? err.message : String(err)}`;
}

export function attachmentTools(attachments: readonly SessionAttachment[]): Record<string, AgentTool<any>> {
	if (attachments.length === 0) return {};
	const tools: Record<string, AgentTool<any>> = {};
	const own = new Set(attachments.map((a) => a.path));
	const scoped = (p: string): string | null => {
		const resolved = path.resolve(p);
		return own.has(resolved) ? resolved : null;
	};
	const outside = (tool: string) => `${tool} failed: the path must be one of this session's attachments`;

	if (attachments.some((a) => a.record.kind === "pdf")) {
		const infoInput = Type.Object({ path: pathParam });
		const extractInput = Type.Object({
			path: pathParam,
			pages: Type.String({ description: "Pages to extract: '1-5', '1,3,7', or '3'. Use pdf_info / pdf_search first and keep the range narrow." }),
		});
		const searchInput = Type.Object({ path: pathParam, query: Type.String({ description: "Text to find (case-insensitive substring)" }) });
		tools.pdf_info = {
			name: "pdf_info",
			label: "pdf_info",
			description: "Triage an attached PDF: page count plus per-page signals (text_length, image_count, math_density).",
			parameters: infoInput,
			execute: serverExecute("pdf_info", infoInput, async ({ path: p }) => {
				const file = scoped(p);
				if (!file) return outside("pdf_info");
				try {
					const info = await pdfInfo(file);
					return { page_count: info.page_count, mean_text_length: info.mean_text_length, pages: info.pages };
				} catch (err) {
					return failure("pdf_info", err);
				}
			}),
		};
		tools.pdf_extract = {
			name: "pdf_extract",
			label: "pdf_extract",
			description: `Extract the text of specific pages of an attached PDF. Output is capped at ${formatSize(50 * 1024)} — request fewer pages if it truncates.`,
			parameters: extractInput,
			execute: serverExecute("pdf_extract", extractInput, async ({ path: p, pages }) => {
				const file = scoped(p);
				if (!file) return outside("pdf_extract");
				try {
					const { content, truncated } = capOutput((await pdfExtract(file, pages)).split("\n"));
					return truncated ? `${content}\n\n[Output truncated at ${formatSize(50 * 1024)}. Request a narrower page range.]` : content;
				} catch (err) {
					return failure("pdf_extract", err);
				}
			}),
		};
		tools.pdf_search = {
			name: "pdf_search",
			label: "pdf_search",
			description: "Find text in an attached PDF — returns the pages and contexts that hit.",
			parameters: searchInput,
			execute: serverExecute("pdf_search", searchInput, async ({ path: p, query }) => {
				const file = scoped(p);
				if (!file) return outside("pdf_search");
				try {
					return { hits: (await pdfSearch(file, query, { literal: true })).hits };
				} catch (err) {
					return failure("pdf_search", err);
				}
			}),
		};
	}

	if (attachments.some((a) => a.record.kind === "epub")) {
		const infoInput = Type.Object({ path: pathParam });
		const readInput = Type.Object({
			path: pathParam,
			chapter: Type.Integer({ minimum: 1, description: "Chapter number from epub_info (reading order, 1-based)" }),
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
		});
		const searchInput = Type.Object({ path: pathParam, query: Type.String({ description: "Text to find (case-insensitive substring)" }) });
		tools.epub_info = {
			name: "epub_info",
			label: "epub_info",
			description: "The structure of an attached EPUB: title, author, and every chapter (number, title, word count) in reading order.",
			parameters: infoInput,
			execute: serverExecute("epub_info", infoInput, async ({ path: p }) => {
				const file = scoped(p);
				if (!file) return outside("epub_info");
				try {
					return await epubInfo(file);
				} catch (err) {
					return failure("epub_info", err);
				}
			}),
		};
		tools.epub_read = {
			name: "epub_read",
			label: "epub_read",
			description:
				"Read one chapter of an attached EPUB as Markdown. Output is truncated to 2000 lines or 50.0KB (whichever is hit first); " +
				"use offset/limit to page through a long chapter.",
			parameters: readInput,
			execute: serverExecute("epub_read", readInput, async ({ path: p, chapter, offset, limit }) => {
				const file = scoped(p);
				if (!file) return outside("epub_read");
				try {
					return readTextSlice(await epubChapterMarkdown(file, chapter), offset, limit);
				} catch (err) {
					return failure("epub_read", err);
				}
			}),
		};
		tools.epub_search = {
			name: "epub_search",
			label: "epub_search",
			description: "Find text in an attached EPUB — returns matching lines with their chapter number, chapter title and nearest heading.",
			parameters: searchInput,
			execute: serverExecute("epub_search", searchInput, async ({ path: p, query }) => {
				const file = scoped(p);
				if (!file) return outside("epub_search");
				try {
					const hits = await epubSearch(file, query);
					if (hits.length === 0) return "No matches.";
					const lines = hits.map((h) => `ch ${h.chapter} (${h.chapterTitle}${h.heading ? ` › ${h.heading}` : ""}): ${h.text}`);
					return capOutput(lines).content;
				} catch (err) {
					return failure("epub_search", err);
				}
			}),
		};
	}

	return tools;
}
