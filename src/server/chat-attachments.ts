import type { ChatAttachment } from "../core/input-events.ts";
import { ChatInputError } from "../core/input-events.ts";

export const MAX_PDF_PAGES = 100;
export const MAX_PDF_TEXT_CHARS = 200_000;

export interface PreparedChatAttachment extends ChatAttachment {
	text?: string;
}

/** Validate file signatures and extract PDF text before the turn is written. */
export async function prepareChatAttachments(attachments: readonly ChatAttachment[]): Promise<PreparedChatAttachment[]> {
	const prepared: PreparedChatAttachment[] = [];
	for (const attachment of attachments) {
		const bytes = Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
		if (!hasExpectedSignature(bytes, attachment.mimeType)) throw new ChatInputError(`${attachment.name} does not match its declared file type`);
		if (attachment.mimeType !== "application/pdf") {
			prepared.push({ ...attachment });
			continue;
		}
		let loadingTask: ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs")["getDocument"]> | undefined;
		try {
			const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
			loadingTask = pdfjs.getDocument({ data: bytes, verbosity: 0 });
			const document = await loadingTask.promise;
			if (document.numPages > MAX_PDF_PAGES) throw new ChatInputError(`${attachment.name} has more than ${MAX_PDF_PAGES} pages`);
			const pages: string[] = [];
			let charCount = 0;
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
				const page = await document.getPage(pageNumber);
				const content = await page.getTextContent();
				const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").trim();
				charCount += text.length;
				if (charCount > MAX_PDF_TEXT_CHARS) throw new ChatInputError(`${attachment.name} contains more than ${MAX_PDF_TEXT_CHARS} extractable text characters`);
				pages.push(`[Page ${pageNumber}]\n${text}`);
			}
			const text = pages.join("\n\n").trim();
			if (!text.replace(/\[Page \d+\]/g, "").trim()) throw new ChatInputError(`${attachment.name} has no extractable text (scanned-only PDFs are not supported)`);
			prepared.push({ ...attachment, text });
		} catch (error) {
			if (error instanceof ChatInputError) throw error;
			throw new ChatInputError(`${attachment.name} is encrypted, malformed, or could not be read as a PDF`);
		} finally {
			await loadingTask?.destroy();
		}
	}
	return prepared;
}

function hasExpectedSignature(data: Uint8Array, mimeType: ChatAttachment["mimeType"]): boolean {
	if (mimeType === "application/pdf") return new TextDecoder().decode(data.subarray(0, Math.min(data.length, 1024))).includes("%PDF-");
	if (mimeType === "image/png") return data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte);
	if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
	return data.length >= 12 && new TextDecoder().decode(data.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(data.subarray(8, 12)) === "WEBP";
}
