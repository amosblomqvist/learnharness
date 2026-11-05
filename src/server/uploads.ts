/**
 * Browser attachments (LAN web access, S4). One file per request, sent as the
 * raw body with its name URI-encoded in the `x-file-name` header. Saved under
 * `<data dir>/uploads/<yyyy-mm-dd>/<random>-<name>`; the caller gets the
 * absolute host path to insert like a desktop attachment.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PATHS } from "../../config.ts";
import { MAX_IMPORT_BODY_BYTES } from "../../lib/notes-import-limits.ts";

const MAX_NAME_LENGTH = 100;

/** Basename only; no separators, control characters or leading dots; capped; never empty. */
export function sanitizeUploadName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? "";
	const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, (c) => (c < " " || c === "\u007f" ? "" : "_")).replace(/^\.+/, "").trim();
	if (!clean) return "file";
	if (Buffer.byteLength(clean) <= MAX_NAME_LENGTH) return clean;
	const ext = path.extname(clean);
	const keepExt = ext.length > 0 && ext.length <= 16 ? ext : "";
	let stem = "";
	for (const ch of clean.slice(0, clean.length - keepExt.length)) {
		if (Buffer.byteLength(stem + ch + keepExt) > MAX_NAME_LENGTH) break;
		stem += ch;
	}
	return stem + keepExt;
}

export type UploadResult = { status: 200; path: string } | { status: 400 | 411 | 413; error: string };

export async function saveUpload(headers: Headers, body: ReadableStream<Uint8Array> | null): Promise<UploadResult> {
	const header = headers.get("content-length");
	if (header === null || !/^\d+$/.test(header)) return { status: 411, error: "Content-Length is required." };
	const expected = Number(header);
	if (expected > MAX_IMPORT_BODY_BYTES) return { status: 413, error: `File is larger than ${MAX_IMPORT_BODY_BYTES} bytes.` };
	let name: string;
	try { name = decodeURIComponent(headers.get("x-file-name") ?? ""); } catch { name = ""; }
	const day = new Date().toISOString().slice(0, 10);
	const dir = path.join(PATHS.data, "uploads", day);
	const target = path.join(dir, `${randomBytes(6).toString("hex")}-${sanitizeUploadName(name)}`);
	await fs.promises.mkdir(dir, { recursive: true });
	let received = 0;
	try {
		const source = body ? Readable.fromWeb(body as never) : Readable.from([]);
		await pipeline(source, async function* (chunks: AsyncIterable<Buffer>) {
			for await (const chunk of chunks) {
				received += chunk.length;
				if (received > expected) throw new RangeError("size");
				yield chunk;
			}
		}, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }));
		if (received !== expected) throw new RangeError("size");
	} catch (error) {
		await fs.promises.rm(target, { force: true });
		if (error instanceof RangeError) return { status: 400, error: "Body size does not match Content-Length." };
		throw error;
	}
	return { status: 200, path: target };
}
