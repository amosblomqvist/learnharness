import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Execute Microsoft MarkItDown CLI via child_process with a 30s timeout and signal support.
 * Returns the stdout markdown string if successful, or null if not installed / fails.
 */
export async function tryConvertWithMarkitdown(
	buffer: Uint8Array,
	filename: string,
	options?: { signal?: AbortSignal },
): Promise<{ markdown: string; notices: string[] } | null> {
	options?.signal?.throwIfAborted();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markitdown-"));
	const ext = path.extname(filename) || (filename.toLowerCase().endsWith(".pdf") ? ".pdf" : ".docx");
	const tempFilePath = path.join(tempDir, `input${ext}`);

	try {
		await fs.writeFile(tempFilePath, buffer);
		options?.signal?.throwIfAborted();

		let stdout: string | null = null;
		// 1. Try `markitdown` CLI
		try {
			const cli = process.platform === "win32" ? "markitdown.cmd" : "markitdown";
			const res = await execFileAsync(cli, [tempFilePath], {
				timeout: 30_000,
				signal: options?.signal,
				maxBuffer: 20 * 1024 * 1024,
				windowsHide: true,
			});
			stdout = res.stdout;
		} catch (err: unknown) {
			if (options?.signal?.aborted) throw err;
		}

		// 2. Fallback to `python -m markitdown`
		if (stdout === null) {
			try {
				const res = await execFileAsync("python", ["-m", "markitdown", tempFilePath], {
					timeout: 30_000,
					signal: options?.signal,
					maxBuffer: 20 * 1024 * 1024,
					windowsHide: true,
				});
				stdout = res.stdout;
			} catch (err: unknown) {
				if (options?.signal?.aborted) throw err;
			}
		}

		// 3. Fallback to `python3 -m markitdown`
		if (stdout === null) {
			try {
				const res = await execFileAsync("python3", ["-m", "markitdown", tempFilePath], {
					timeout: 30_000,
					signal: options?.signal,
					maxBuffer: 20 * 1024 * 1024,
					windowsHide: true,
				});
				stdout = res.stdout;
			} catch (err: unknown) {
				if (options?.signal?.aborted) throw err;
			}
		}

		if (stdout === null) return null;
		const markdown = stdout.trim();
		if (!markdown) return null;
		return { markdown, notices: ["Converted with Microsoft MarkItDown."] };
	} catch (err: unknown) {
		if (options?.signal?.aborted) throw err;
		return null;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Decode XML entities and character references. */
function decodeXml(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Read entries from a ZIP archive. */
function readZipEntries(buffer: Uint8Array): Map<string, Buffer> {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	if (buf.length < 22) throw new Error("Invalid archive: file too small");
	if (buf.readUInt32LE(0) !== 0x04034b50) {
		throw new Error("Invalid archive: missing PK signature");
	}

	const entries = new Map<string, Buffer>();

	// Find EOCD
	let eocdOffset = -1;
	const minSearch = Math.max(0, buf.length - 65557);
	for (let i = buf.length - 22; i >= minSearch; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocdOffset = i;
			break;
		}
	}

	if (eocdOffset !== -1) {
		const totalEntries = buf.readUInt16LE(eocdOffset + 10);
		const cdOffset = buf.readUInt32LE(eocdOffset + 16);

		let pos = cdOffset;
		for (let i = 0; i < totalEntries; i++) {
			if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
			const method = buf.readUInt16LE(pos + 10);
			const compressedSize = buf.readUInt32LE(pos + 20);
			const nameLen = buf.readUInt16LE(pos + 28);
			const extraLen = buf.readUInt16LE(pos + 30);
			const commentLen = buf.readUInt16LE(pos + 32);
			const localOffset = buf.readUInt32LE(pos + 42);

			const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");

			if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
				const localNameLen = buf.readUInt16LE(localOffset + 26);
				const localExtraLen = buf.readUInt16LE(localOffset + 28);
				const dataStart = localOffset + 30 + localNameLen + localExtraLen;
				if (dataStart + compressedSize <= buf.length) {
					const slice = buf.subarray(dataStart, dataStart + compressedSize);
					let decompressed: Buffer | null = null;
					if (method === 0) decompressed = slice;
					else if (method === 8) {
						try { decompressed = zlib.inflateRawSync(slice); } catch {}
					}
					if (decompressed) entries.set(name, decompressed);
				}
			}
			pos += 46 + nameLen + extraLen + commentLen;
		}
	}

	// Fallback to sequential local header scanning if central directory gave 0 entries
	if (entries.size === 0) {
		let offset = 0;
		while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
			const method = buf.readUInt16LE(offset + 8);
			const compSize = buf.readUInt32LE(offset + 18);
			const nameLen = buf.readUInt16LE(offset + 26);
			const extraLen = buf.readUInt16LE(offset + 28);
			const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
			const dataStart = offset + 30 + nameLen + extraLen;
			if (compSize > 0 && dataStart + compSize <= buf.length) {
				const slice = buf.subarray(dataStart, dataStart + compSize);
				if (method === 0) entries.set(name, slice);
				else if (method === 8) {
					try { entries.set(name, zlib.inflateRawSync(slice)); } catch {}
				}
				offset = dataStart + compSize;
			} else {
				break;
			}
		}
	}

	return entries;
}

/** Parse paragraph XML into Markdown text line. */
function parseParagraph(pXml: string, rels: Map<string, string>): string {
	const styleMatch = pXml.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
	const numPrMatch = pXml.match(/<w:numPr>[\s\S]*?<\/w:numPr>/);

	let prefix = "";
	if (styleMatch && styleMatch[1]) {
		const val = styleMatch[1].toLowerCase().replace(/\s+/g, "");
		if (val === "heading1" || val === "title") prefix = "# ";
		else if (val === "heading2" || val === "subtitle") prefix = "## ";
		else if (val === "heading3") prefix = "### ";
		else if (val === "heading4") prefix = "#### ";
		else if (val === "heading5") prefix = "##### ";
		else if (val === "heading6") prefix = "###### ";
	} else if (numPrMatch && numPrMatch[0]) {
		const ilvlMatch = numPrMatch[0].match(/<w:ilvl[^>]*w:val="(\d+)"/);
		const ilvl = ilvlMatch && ilvlMatch[1] ? parseInt(ilvlMatch[1], 10) : 0;
		prefix = "  ".repeat(ilvl) + "- ";
	}

	let content = "";
	const tokenRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:drawing(?:\s+[^>]*)?>([\s\S]*?)<\/w:drawing>|<v:imagedata(?:\s+[^>]*)?>/g;
	let match: RegExpExecArray | null;
	while ((match = tokenRegex.exec(pXml)) !== null) {
		if (match[1] !== undefined) {
			content += decodeXml(match[1]);
		} else if (match[0] === "<w:tab/>") {
			content += "\t";
		} else if (match[0] === "<w:br/>") {
			content += "\n";
		} else if (match[2] !== undefined) {
			const blipMatch = match[2].match(/(?:r:embed|r:id|r:link)="([^"]+)"/);
			if (blipMatch && blipMatch[1]) {
				const id = blipMatch[1];
				const target = rels.get(id) || id;
				const sep = content.length > 0 && !content.endsWith(" ") ? " " : "";
				content += `${sep}![Image](${target})`;
			}
		} else if (match[0] && match[0].startsWith("<v:imagedata")) {
			const vmlMatch = match[0].match(/(?:r:id|r:embed)="([^"]+)"/);
			if (vmlMatch && vmlMatch[1]) {
				const id = vmlMatch[1];
				const target = rels.get(id) || id;
				const sep = content.length > 0 && !content.endsWith(" ") ? " " : "";
				content += `${sep}![Image](${target})`;
			}
		}
	}
	const trimmed = content.trim();
	if (!trimmed) return "";
	return prefix + trimmed;
}

/** Parse table XML into Markdown table. */
function parseTable(tblXml: string, rels: Map<string, string>): string {
	const trRegex = /<w:tr(?:\s+[^>]*)?>([\s\S]*?)<\/w:tr>/g;
	const rows: string[][] = [];
	let trMatch: RegExpExecArray | null;
	while ((trMatch = trRegex.exec(tblXml)) !== null) {
		const row: string[] = [];
		const rowXml = trMatch[1] ?? "";
		const tcRegex = /<w:tc(?:\s+[^>]*)?>([\s\S]*?)<\/w:tc>/g;
		let tcMatch: RegExpExecArray | null;
		while ((tcMatch = tcRegex.exec(rowXml)) !== null) {
			const pRegex = /<w:p(?:\s+[^>]*)?>([\s\S]*?)<\/w:p>/g;
			const cellTexts: string[] = [];
			let pMatch: RegExpExecArray | null;
			const cellXml = tcMatch[1] ?? "";
			while ((pMatch = pRegex.exec(cellXml)) !== null) {
				const pInner = pMatch[1] ?? "";
				const text = parseParagraph(pInner, rels).trim();
				if (text) cellTexts.push(text);
			}
			row.push(cellTexts.join(" ").replace(/\|/g, "\\|"));
		}
		if (row.length > 0) rows.push(row);
	}
	if (rows.length === 0) return "";
	const maxCols = Math.max(...rows.map((r) => r.length), 1);
	const normalizedRows = rows.map((r) => {
		const copy = [...r];
		while (copy.length < maxCols) copy.push("");
		return copy;
	});

	const header = normalizedRows[0] ?? [];
	const separator = new Array(maxCols).fill("---");
	const markdownRows = [
		`| ${header.join(" | ")} |`,
		`| ${separator.join(" | ")} |`,
		...normalizedRows.slice(1).map((r) => `| ${r.join(" | ")} |`),
	];
	return markdownRows.join("\n");
}

/** Parse DOCX bytes using pure Node fallback reader. */
export function parseDocx(buffer: Uint8Array): string {
	const entries = readZipEntries(buffer);
	const docData = entries.get("word/document.xml");
	if (!docData) throw new Error("Invalid DOCX: missing word/document.xml");

	const rels = new Map<string, string>();
	const relsData = entries.get("word/_rels/document.xml.rels");
	if (relsData) {
		const relsXml = relsData.toString("utf8");
		const relRegex = /<Relationship\s+([^>]+)\/?>/g;
		let match: RegExpExecArray | null;
		while ((match = relRegex.exec(relsXml)) !== null) {
			const attrs = match[1];
			if (!attrs) continue;
			const idMatch = attrs.match(/Id="([^"]+)"/);
			const targetMatch = attrs.match(/Target="([^"]+)"/);
			if (idMatch && idMatch[1] && targetMatch && targetMatch[1]) {
				let target = targetMatch[1];
				if (!target.startsWith("word/") && !target.startsWith("/") && !target.includes("://")) {
					target = `word/${target}`;
				}
				rels.set(idMatch[1], target);
			}
		}
	}

	const docXml = docData.toString("utf8");
	const bodyMatch = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
	if (!bodyMatch || !bodyMatch[1]) return "";
	const body = bodyMatch[1];

	const blockRegex = /<w:(p|tbl)(?:\s+[^>]*)?>([\s\S]*?)<\/w:\1>/g;
	const blocks: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = blockRegex.exec(body)) !== null) {
		const tag = match[1] ?? "";
		const inner = match[2] ?? "";
		if (tag === "p") {
			const line = parseParagraph(inner, rels);
			if (line) blocks.push(line);
		} else if (tag === "tbl") {
			const table = parseTable(inner, rels);
			if (table) blocks.push(table);
		}
	}
	return blocks.join("\n\n").trim();
}

/**
 * Convert DOCX buffer to Markdown.
 * First tries MarkItDown CLI. Falls back to pure Node DOCX reader.
 */
export async function convertDocx(
	buffer: Uint8Array,
	filename: string,
	options?: { signal?: AbortSignal },
): Promise<{ markdown: string; notices: string[] }> {
	options?.signal?.throwIfAborted();
	const markitdown = await tryConvertWithMarkitdown(buffer, filename, options);
	if (markitdown) return markitdown;
	options?.signal?.throwIfAborted();

	const markdown = parseDocx(buffer);
	return {
		markdown,
		notices: ["Converted with built-in DOCX reader. Install Microsoft markitdown for full AI image analysis."],
	};
}

/**
 * Convert PDF buffer with MarkItDown CLI.
 * Returns null if MarkItDown CLI is unavailable.
 */
export async function convertPdfWithMarkitdown(
	buffer: Uint8Array,
	filename: string,
	options?: { signal?: AbortSignal },
): Promise<{ markdown: string; notices: string[] } | null> {
	return tryConvertWithMarkitdown(buffer, filename, options);
}
