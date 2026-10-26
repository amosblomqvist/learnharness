import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { guardSourcePath } from "./file-access.ts";

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
 * - image files (jpg/png/gif/webp/bmp): returned as native image content
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

/** Extension map for v0 (pi sniffs magic bytes; extensions suffice here —
 *  learner files are pasted paths, not adversarial uploads). */
const IMAGE_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

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
	description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50.0KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
	parameters: readInput,
	execute: serverExecute("read", readInput, async ({ path: rawPath, offset, limit }): Promise<string | ImageFileResult> => {
		const absolute = await guardSourcePath(resolveSourcePath(rawPath));
		const ext = path.extname(absolute).toLowerCase();
		const mime = IMAGE_MIME[ext];
		const buffer = await fs.readFile(absolute); // ENOENT/EACCES → error result the model sees
		if (mime) {
			// NOTE v0: no resize — raw bytes as base64. Learner files are study
			// material (screenshots, figures), not adversarial payloads; a resize
			// step (sharp) can land later if large images prove wasteful.
			return {
				text: `Read image file [${mime}] — ${path.basename(absolute)} (${formatSize(buffer.byteLength)}), attached as an image.`,
				images: [{ data: buffer.toString("base64"), mimeType: mime }],
			};
		}
		const text = buffer.toString("utf-8");
		return readTextSlice(text, offset, limit);
	}),
};
