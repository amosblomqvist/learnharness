import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { MAX_SOURCE_IMAGE_BYTES } from "../../core/images.ts";
import { inspectImageBytes } from "../../core/images.ts";
import { normalizeImage, readBoundedImageFile } from "../image-media.ts";
import { resolveSourcePath } from "./fs-shared.ts";

/**
 * The read tool — sources v0 (2026-09): a Node port of pi's read semantics
 * for the learner's local files. The flow is learner-owned: he pastes file
 * paths into the chat, the agent reads on its own terms (nothing is
 * auto-injected). Unrestricted local reads are the user-decided v0 scope —
 * this is a personal study harness, not a multi-tenant service.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/read.js):
 * - text files: utf-8, offset (1-indexed) / limit slicing, and the
 *   2000-line / 50KB truncation ceiling with actionable "use offset=N"
 *   continuation notices — a huge file never silently floods the context.
 * - image files (jpg/png/gif/webp/bmp, detected by bytes, normalized to PNG
 *   within 20MiB source / 25MP / 2048px / 5MiB): returned as native image content
 *   parts so the vision-capable model actually SEES them (teacher's
 *   glm-5.3-flash accepts image input per pi's zai catalog; tool-execute's
 *   toToolResult maps ImageFileResult to pi's ImageContent).
 * - unreadable/missing files throw — pi turns that into an error tool
 *   result the model sees and recovers from.
 *
 * Usage guidance ships in the description (the self-contained-tools
 * principle, user-decided 2026-09: system prompts reference only
 * always-on tools — read IS always-on, but its doctrine still lives here).
 */

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

/** Extensions that CLAIM an image. The bytes decide: a claimed image that
 *  does not sniff as one is an error, and an image with a wrong or missing
 *  extension is still read as an image (magic bytes, below). */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/** Magic bytes of the formats we can sniff without an extension. BMP's
 *  two-byte "BM" is too weak for text files, so it needs the extension. */
function hasImageMagic(head: Buffer): boolean {
	if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return true;
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
	if (head.length >= 4 && head.toString("ascii", 0, 4) === "GIF8") return true;
	return head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
}

async function readHead(file: string, n = 12): Promise<Buffer> {
	const handle = await fs.open(file, "r");
	try {
		const buf = Buffer.alloc(n);
		const { bytesRead } = await handle.read(buf, 0, n, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

const readInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Slice + truncate the text body, pi's continuation-notice style. */
function readTextSlice(text: string, offset: number | undefined, limit: number | undefined): string {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
	}
	// honor an explicit limit first (never beyond EOF)
	let selected = allLines.slice(startLine, limit !== undefined ? startLine + limit : totalLines);
	// then the 2000-line ceiling
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > MAX_LINES) {
		selected = selected.slice(0, MAX_LINES);
		truncatedBy = "lines";
	}
	// then the 50KB ceiling
	if (Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
		while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
			selected.pop();
		}
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) {
		const remaining = totalLines - (startLine + selected.length);
		if (remaining > 0) {
			return `${selected.join("\n")}\n\n[${remaining} more lines in file. Use offset=${startLine + selected.length + 1} to continue.]`;
		}
		return selected.join("\n");
	}
	const endLineDisplay = startLine + selected.length;
	const reason =
		truncatedBy === "lines" ? `${MAX_LINES} line limit` : `${formatSize(MAX_BYTES)} limit`;
	return `${selected.join("\n")}\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalLines} (${reason}). Use offset=${endLineDisplay + 1} to continue.]`;
}

/**
 * The read tool, shared verbatim by the prober and the teacher. Sources v1
 * (2026-09-19): the description is pi-verbatim (user: copy tool usage
 * guidance exactly) — the teaching doctrine moved to the shared prompt
 * fragment (prompts/shared/). Relative paths resolve against the
 * learner's home (fs-shared.ts), the harness's anchor.
 */
export const readTool: AgentTool<typeof readInput> = {
	name: "read",
	label: "read",
	description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments, normalized to PNG (max 2048px, 5MiB). For text files, output is truncated to 2000 lines or 50.0KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
	parameters: readInput,
	execute: serverExecute("read", readInput, async ({ path: rawPath, offset, limit }, { signal }): Promise<string | ImageFileResult> => {
		const absolute = resolveSourcePath(rawPath);
		const ext = path.extname(absolute).toLowerCase();
		const stat = await fs.stat(absolute); // ENOENT/EACCES → error result the model sees
		const head = stat.isFile() ? await readHead(absolute) : Buffer.alloc(0);
		const claimsImage = IMAGE_EXTENSIONS.has(ext);
		if (claimsImage || hasImageMagic(head)) {
			// Bound BEFORE allocating the file buffer.
			if (stat.size > MAX_SOURCE_IMAGE_BYTES) {
				throw new Error(`Image file is too large (${formatSize(stat.size)}; max ${MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)}MiB).`);
			}
			const bytes = await readBoundedImageFile(absolute, signal);
			const sniffed = inspectImageBytes(bytes);
			if (!sniffed) throw new Error(`${path.basename(absolute)} is not a readable PNG, JPEG, GIF, WebP or BMP image.`);
			const image = await normalizeImage(bytes, signal);
			return {
				text: `Read image file [${image.mimeType}] — ${path.basename(absolute)} (${formatSize(bytes.byteLength)}), attached as an image.`,
				images: [{ data: image.data, mimeType: image.mimeType }],
			};
		}
		const buffer = await fs.readFile(absolute);
		const text = buffer.toString("utf-8");
		return readTextSlice(text, offset, limit);
	}),
};
