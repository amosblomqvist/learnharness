import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { pdfExtract, pdfInfo } from "../agent/subagents/pdf-ops.ts";

export type DocumentCategory = "lecture" | "exam";

export interface ParsedDocument {
	id: string;
	fileName: string;
	category: DocumentCategory;
	extension: string;
	size: number;
	text: string;
	summary: {
		pageOrSlideCount?: number;
		charCount: number;
	};
}

/** Extract text inside XML tags like <a:t>...</a:t> or <w:t>...</w:t> */
function extractXmlTags(xml: string, tagName: string): string[] {
	const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "g");
	const matches: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(xml)) !== null) {
		if (match[1]) {
			// Decode common XML entities
			const decoded = match[1]
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&apos;/g, "'");
			matches.push(decoded);
		}
	}
	return matches;
}

/** Parse PPTX presentation file buffer into text structured by slides */
export async function parsePptx(buffer: Buffer): Promise<{ text: string; slideCount: number }> {
	const zip = await JSZip.loadAsync(buffer);
	const slideFiles: { name: string; num: number; file: JSZip.JSZipObject }[] = [];

	zip.forEach((relativePath, file) => {
		const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
		if (match && match[1]) {
			slideFiles.push({
				name: relativePath,
				num: parseInt(match[1], 10),
				file,
			});
		}
	});

	slideFiles.sort((a, b) => a.num - b.num);

	const slideSections: string[] = [];
	for (const slide of slideFiles) {
		const xml = await slide.file.async("text");
		const textParts = extractXmlTags(xml, "a:t");
		const slideText = textParts.join(" ").replace(/\s+/g, " ").trim();
		if (slideText) {
			slideSections.push(`--- Slide ${slide.num} ---\n${slideText}`);
		}
	}

	return {
		text: slideSections.join("\n\n"),
		slideCount: slideFiles.length,
	};
}

/** Parse DOCX document file buffer into text */
export async function parseDocx(buffer: Buffer): Promise<{ text: string; paragraphCount: number }> {
	const zip = await JSZip.loadAsync(buffer);
	const docFile = zip.file("word/document.xml");
	if (!docFile) {
		throw new Error("Invalid DOCX file: word/document.xml not found");
	}

	const xml = await docFile.async("text");
	// Split by paragraphs <w:p>
	const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
	const paragraphs: string[] = [];
	let pMatch: RegExpExecArray | null;
	while ((pMatch = pRegex.exec(xml)) !== null) {
		if (pMatch[1]) {
			const textParts = extractXmlTags(pMatch[1], "w:t");
			const paragraphText = textParts.join("").trim();
			if (paragraphText) {
				paragraphs.push(paragraphText);
			}
		}
	}

	return {
		text: paragraphs.join("\n\n"),
		paragraphCount: paragraphs.length,
	};
}

/** Parse file buffer based on extension */
export async function parseDocumentFile(
	id: string,
	fileName: string,
	buffer: Buffer,
	category: DocumentCategory,
	tempFilePath?: string,
): Promise<ParsedDocument> {
	const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
	let text = "";
	let pageOrSlideCount: number | undefined;

	if (ext === ".pdf") {
		let cleanupTemp = false;
		let pdfPath = tempFilePath;
		if (!pdfPath) {
			pdfPath = path.join(os.tmpdir(), `doc_${id}_${Date.now()}.pdf`);
			await fs.writeFile(pdfPath, buffer);
			cleanupTemp = true;
		}
		try {
			const info = await pdfInfo(pdfPath);
			pageOrSlideCount = info.page_count;
			text = await pdfExtract(pdfPath, "all");
		} finally {
			if (cleanupTemp && pdfPath) {
				try {
					await fs.unlink(pdfPath);
				} catch {
					// Ignore cleanup error
				}
			}
		}
	} else if (ext === ".pptx") {
		const parsed = await parsePptx(buffer);
		text = parsed.text;
		pageOrSlideCount = parsed.slideCount;
	} else if (ext === ".docx") {
		const parsed = await parseDocx(buffer);
		text = parsed.text;
	} else if ([".txt", ".md", ".markdown"].includes(ext)) {
		text = buffer.toString("utf-8");
	} else if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext)) {
		text = `[Tài liệu hình ảnh đính kèm: ${fileName}]`;
	} else {
		// Fallback for other plain-text files: check if it contains binary null bytes
		const isBinary = buffer.subarray(0, 1000).includes(0);
		if (isBinary) {
			text = `[Tài liệu nhị phân đính kèm: ${fileName}]`;
		} else {
			text = buffer.toString("utf-8");
		}
	}

	return {
		id,
		fileName,
		category,
		extension: ext,
		size: buffer.length,
		text: text.trim(),
		summary: {
			pageOrSlideCount,
			charCount: text.length,
		},
	};
}
