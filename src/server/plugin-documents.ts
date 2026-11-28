import { readBoundedFormData, FormBodyLimitError } from "../../lib/bounded-form-data.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { PluginHostError } from "./plugin-host.ts";
import { tr } from "../core/i18n.ts";

export const MAX_DOCUMENT_BODY_BYTES = 26 * 1024 * 1024;
export const MAX_DOCUMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

/** Pure upload conversion only: no learning, provider, or storage services.
 * Compose ONE instance process-wide. The fail-fast slot covers body reading,
 * conversion, and converter teardown, even after the caller has aborted. */
export function createPluginDocumentConverter(deps: { convertPdf?: typeof convertPdf } = {}) {
	const pdfConverter = deps.convertPdf ?? convertPdf;
	let busy = false;
	return {
		async convert(request: Request, signal: AbortSignal): Promise<{ name: string; markdown: string; notices: string[] }> {
			if (busy) throw new PluginHostError(409, tr("文档转换正忙，请重试。", "Document conversion is busy. Please retry."));
			busy = true;
			try {
				signal.throwIfAborted();
				let form: FormData;
				try {
					form = await readBoundedFormData(request, MAX_DOCUMENT_BODY_BYTES, signal);
				} catch (error) {
					signal.throwIfAborted();
					if (error instanceof FormBodyLimitError) throw new PluginHostError(413, tr("上传的文档过大。上限为 26 MiB（含 multipart 元数据）。", "Document upload is too large. Max 26 MiB including multipart metadata."));
					throw new PluginHostError(400, tr("无法读取上传内容，可能不完整，请重新选择文件。", "Could not read the upload. It may be incomplete; please select the file again."));
				}
				signal.throwIfAborted();
				const entries = [...form.entries()];
				const entry = entries[0];
				if (entries.length !== 1 || !entry || entry[0] !== "file" || !(entry[1] instanceof File)) {
					throw new PluginHostError(400, tr("请在 file 字段中只上传一个文件。", "Upload exactly one file in the file field."));
				}
				const file = entry[1];
				if (file.size > MAX_DOCUMENT_FILE_BYTES) throw new PluginHostError(413, tr("文件过大，最大 25 MiB。", "Too big. Max 25 MiB."));
				const bytes = new Uint8Array(await file.arrayBuffer());
				signal.throwIfAborted();
				let markdown: string;
				const notices: string[] = [];
				if (PDF_MAGIC.every((byte, i) => bytes[i] === byte) || /\.pdf$/i.test(file.name)) {
					// Await the actual converter, never an abort race: its promise includes
					// loading-task destruction, which must settle before releasing busy.
					let pdf;
					try { pdf = await pdfConverter(bytes, MAX_DOCUMENT_PDF_PAGES, { signal }); }
					catch {
						signal.throwIfAborted();
						throw new PluginHostError(400, tr("无法打开此 PDF。", "Could not open this PDF."));
					}
					signal.throwIfAborted();
					if (pdf.kind === "unreadable") throw new PluginHostError(400, tr("无法打开此 PDF。", "Could not open this PDF."));
					if (pdf.kind === "too-long") throw new PluginHostError(400, tr("页数过多。上限为 1,000 页。", "Too long. Max 1,000 pages."));
					const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
					if (!pdf.pages.some((page) => page.kind === "text" && page.markdown.trim())) {
						throw new PluginHostError(400, skipped ? tr("不支持 OCR。此 PDF 没有可提取的文本。", "OCR is not supported. This PDF has no extractable text.") : tr("此 PDF 为空白或不含可提取的文本。", "This PDF is blank or contains no extractable text."));
					}
					markdown = joinPages(pdf.pages);
					notices.push(tr("PDF 文本提取可能存在错误，请对照原文检查结果。", "PDF text extraction may contain errors; check the result against the original."));
					if (skipped) notices.push(tr(`已跳过 ${skipped} 个纯图片页面；不支持 OCR。`, `Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.`));
				} else {
					try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
					catch { throw new PluginHostError(400, tr("此文档不是有效的 UTF-8 文本。", "This document is not valid UTF-8 text.")); }
					if (CONTROL.test(markdown)) throw new PluginHostError(400, tr("此文档包含二进制或控制字符，不是受支持的文本。", "This document contains binary or control characters, not supported text."));
					if (!markdown.trim()) throw new PluginHostError(400, tr("此文档不含文本。", "This document contains no text."));
				}
				signal.throwIfAborted();
				if (new TextEncoder().encode(markdown).byteLength > MAX_DOCUMENT_MARKDOWN_BYTES) {
					throw new PluginHostError(413, tr("转换后的 Markdown 过大。上限为 2 MiB。", "Converted Markdown is too large. Max 2 MiB."));
				}
				return { name: file.name, markdown, notices };
			} finally { busy = false; }
		},
	};
}
