import { readBoundedFormData, FormBodyLimitError } from "../../lib/bounded-form-data.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { PluginHostError } from "./plugin-host.ts";
import { convertDocx, convertPdfWithMarkitdown } from "./markitdown.ts";
import { applyBaiduOcrToPdf } from "./baidu-ocr.ts";

export const MAX_DOCUMENT_BODY_BYTES = 26 * 1024 * 1024;
export const MAX_DOCUMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

/** Pure upload conversion only: no learning, provider, or storage services.
 * Compose ONE instance process-wide. The fail-fast slot covers body reading,
 * conversion, and converter teardown, even after the caller has aborted. */
export function createPluginDocumentConverter(deps: {
	convertPdf?: typeof convertPdf;
	convertDocx?: typeof convertDocx;
	convertPdfWithMarkitdown?: typeof convertPdfWithMarkitdown;
	applyBaiduOcrToPdf?: typeof applyBaiduOcrToPdf;
} = {}) {
	const pdfConverter = deps.convertPdf ?? convertPdf;
	const docxConverter = deps.convertDocx ?? convertDocx;
	const pdfWithMarkitdown = deps.convertPdfWithMarkitdown ?? convertPdfWithMarkitdown;
	const ocrPdf = deps.applyBaiduOcrToPdf ?? applyBaiduOcrToPdf;
	let busy = false;
	return {
		async convert(request: Request, signal: AbortSignal): Promise<{ name: string; markdown: string; notices: string[] }> {
			if (busy) throw new PluginHostError(409, "Document conversion is busy. Please retry.");
			busy = true;
			try {
				signal.throwIfAborted();
				let form: FormData;
				try {
					form = await readBoundedFormData(request, MAX_DOCUMENT_BODY_BYTES, signal);
				} catch (error) {
					signal.throwIfAborted();
					if (error instanceof FormBodyLimitError) throw new PluginHostError(413, "Document upload is too large. Max 26 MiB including multipart metadata.");
					throw new PluginHostError(400, "Could not read the upload. It may be incomplete; please select the file again.");
				}
				signal.throwIfAborted();
				const entries = [...form.entries()];
				const entry = entries[0];
				if (entries.length !== 1 || !entry || entry[0] !== "file" || !(entry[1] instanceof File)) {
					throw new PluginHostError(400, "Upload exactly one file in the file field.");
				}
				const file = entry[1];
				if (file.size > MAX_DOCUMENT_FILE_BYTES) throw new PluginHostError(413, "Too big. Max 25 MiB.");
				const bytes = new Uint8Array(await file.arrayBuffer());
				signal.throwIfAborted();
				let markdown: string;
				const notices: string[] = [];
				if (/\.docx$/i.test(file.name)) {
					let docx;
					try {
						docx = await docxConverter(bytes, file.name, { signal });
					} catch {
						signal.throwIfAborted();
						throw new PluginHostError(400, "Could not open this DOCX document.");
					}
					signal.throwIfAborted();
					if (!docx.markdown.trim()) {
						throw new PluginHostError(400, "This document contains no text.");
					}
					markdown = docx.markdown;
					notices.push(...docx.notices);
				} else if (PDF_MAGIC.every((byte, i) => bytes[i] === byte) || /\.pdf$/i.test(file.name)) {
					const markitdown = await pdfWithMarkitdown(bytes, file.name, { signal });
					if (markitdown) {
						markdown = markitdown.markdown;
						notices.push(...markitdown.notices);
					} else {
						let pdf;
						try { pdf = await pdfConverter(bytes, MAX_DOCUMENT_PDF_PAGES, { signal }); }
						catch {
							signal.throwIfAborted();
							throw new PluginHostError(400, "Could not open this PDF.");
						}
						signal.throwIfAborted();
						if (pdf.kind === "unreadable") throw new PluginHostError(400, "Could not open this PDF.");
						if (pdf.kind === "too-long") throw new PluginHostError(400, "Too long. Max 1,000 pages.");
						let pages = pdf.pages;
						const needsOcr = pages.some((page) => page.kind === "image-only") || !pages.some((page) => page.kind === "text" && page.markdown.trim());
						let ocrCount = 0;
						if (needsOcr) {
							const ocrResult = await ocrPdf(bytes, pages, { signal });
							pages = ocrResult.pages;
							ocrCount = ocrResult.ocrCount;
						}
						const skipped = pages.filter((page) => page.kind === "image-only").length;
						if (!pages.some((page) => page.kind === "text" && page.markdown.trim())) {
							throw new PluginHostError(400, skipped ? "OCR is not supported. This PDF has no extractable text." : "This PDF is blank or contains no extractable text.");
						}
						markdown = joinPages(pages);
						notices.push("PDF text extraction may contain errors; check the result against the original.");
						if (ocrCount > 0) notices.push("Processed with Baidu OCR.");
						if (skipped) notices.push(`Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.`);
					}
				} else {
					try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
					catch { throw new PluginHostError(400, "This document is not valid UTF-8 text."); }
					if (CONTROL.test(markdown)) throw new PluginHostError(400, "This document contains binary or control characters, not supported text.");
					if (!markdown.trim()) throw new PluginHostError(400, "This document contains no text.");
				}
				signal.throwIfAborted();
				if (new TextEncoder().encode(markdown).byteLength > MAX_DOCUMENT_MARKDOWN_BYTES) {
					throw new PluginHostError(413, "Converted Markdown is too large. Max 2 MiB.");
				}
				return { name: file.name, markdown, notices };
			} finally { busy = false; }
		},
	};
}
