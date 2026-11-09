/**
 * Shared upload plumbing for the two file-ingesting routes (2026-11,
 * issue #175): the notes import (/api/graph/import) and document-sourced
 * session creation (POST /api/chats) read the SAME file kinds under the
 * SAME caps — a PDF converts to Markdown locally (no OCR), anything else
 * reads as text — and both bound the multipart body before parsing.
 * Extracted verbatim from the import route so the two front doors cannot
 * drift; conversion itself is pdf-markdown (src/agent/subagents/), the
 * local rule-based converter.
 */
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";

export const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

/** A PDF becomes page-marked Markdown; any other file is read as text. */
export async function readNotesFile(file: File): Promise<NotesFile> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) return { kind: "notes", text: new TextDecoder().decode(bytes) };
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", text, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

export class FormBodyLimitError extends Error {}

/** Bound actual body bytes before multipart parsing, including requests
 * without a trustworthy Content-Length. Next's proxy may truncate first;
 * parsing that incomplete body is a separate, handled refusal, never a
 * partial import. */
export async function readBoundedForm(request: Request, maxBytes: number): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > maxBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new FormBodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing form body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new FormBodyLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} finally {
		// Do not wait for a tee's other consumer to finish before refusing an upload.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
