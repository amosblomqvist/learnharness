/**
 * POST /api/attachments — the web build's file/folder upload (2026-11-11).
 *
 * A browser `File` has no local path, so the composer's attach button (which
 * normally produces path chips through the desktop bridge) uploads the bytes
 * here instead; the response carries the absolute server paths to chip, and the
 * agent reads them like any other allowed source.
 *
 * Body: multipart/form-data
 *   files: one or more file parts
 *   paths: JSON string array, aligned with the file parts, holding each file's
 *          relative path (folder uploads) — optional, defaults to the filename
 * Answer: { paths: string[], skipped: number } (+ an `error` when nothing landed)
 *
 * Bounds are enforced on the raw body first (Content-Length or streamed count);
 * a truncated or oversized body is refused, never partially stored.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ATTACHMENTS_DIR, safeRelativePath, writeUpload } from "@/src/server/attachments";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 40;

class AttachmentBodyLimitError extends Error {}

async function readBoundedForm(request: Request): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		throw new AttachmentBodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing upload body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_BODY_BYTES) throw new AttachmentBodyLimitError();
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
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function relativePaths(form: FormData): string[] {
	const raw = form.get("paths");
	if (typeof raw !== "string") return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.map((value) => (typeof value === "string" ? value : "")) : [];
	} catch {
		return [];
	}
}

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedForm(request);
	} catch (error) {
		if (error instanceof AttachmentBodyLimitError) {
			return Response.json({ paths: [], skipped: 0, error: "Upload is too large (max 100 MB per request)." }, { status: 413 });
		}
		return Response.json({ paths: [], skipped: 0, error: "Invalid upload body." }, { status: 400 });
	}

	const files = form.getAll("files").filter((value): value is File => value instanceof File);
	if (files.length === 0) return Response.json({ paths: [], skipped: 0, error: "No files in the request." }, { status: 400 });
	if (files.length > MAX_FILES) return Response.json({ paths: [], skipped: 0, error: `Too many files (max ${MAX_FILES}).` }, { status: 413 });

	const relatives = relativePaths(form);
	const dir = path.join(ATTACHMENTS_DIR, randomUUID());
	fs.mkdirSync(dir, { recursive: true });

	const paths: string[] = [];
	let skipped = 0;
	for (const [index, file] of files.entries()) {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (bytes.byteLength === 0) { skipped++; continue; }
			const relative = safeRelativePath(relatives[index] || file.name, `file-${index + 1}`);
			paths.push(writeUpload(dir, relative, bytes));
		} catch {
			skipped++;
		}
	}
	if (paths.length === 0) return Response.json({ paths: [], skipped, error: "No readable files in the request." }, { status: 400 });
	return Response.json({ paths, skipped });
}
