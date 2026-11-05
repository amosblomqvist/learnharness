import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-uploads-"));
process.env.LH_DATA_DIR = dataDir;
const { POST } = await import("../app/api/uploads/route.ts");
const { sanitizeUploadName } = await import("../src/server/uploads.ts");
const uploads = path.join(dataDir, "uploads");
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function upload(body: Uint8Array | null, name: string | null, headers: Record<string, string> = {}) {
	const h: Record<string, string> = { ...(body ? { "content-length": String(body.length) } : {}), ...headers };
	if (name !== null) h["x-file-name"] = encodeURIComponent(name);
	return new NextRequest("http://localhost/api/uploads", { method: "POST", body: body as BodyInit | null, headers: h });
}
const files = () => (fs.existsSync(uploads) ? fs.readdirSync(uploads, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()) : []);

describe("POST /api/uploads", () => {
	it("saves the exact bytes under uploads/<date>/<random>-<name> and returns the absolute path", async () => {
		const bytes = Uint8Array.from([0, 1, 2, 250, 255, 10]);
		const res = await POST(upload(bytes, "notes é.pdf"));
		assert.equal(res.status, 200);
		const { path: saved } = await res.json();
		assert.ok(path.isAbsolute(saved));
		const rel = path.relative(uploads, saved).split(path.sep) as [string, string];
		assert.equal(rel.length, 2);
		assert.match(rel[0], /^\d{4}-\d{2}-\d{2}$/);
		assert.match(rel[1], /^[0-9a-f]{8,}-notes é\.pdf$/);
		assert.deepEqual(new Uint8Array(fs.readFileSync(saved)), bytes);
	});

	it("neutralizes traversal and odd names", async () => {
		for (const name of ["../../etc/passwd", "..\\..\\evil.sh", "/abs/path.txt", ".hidden", "a\u0000b\nc.txt", "", "..", "x".repeat(500) + ".md"]) {
			const res = await POST(upload(new Uint8Array([1]), name));
			assert.equal(res.status, 200, name);
			const { path: saved } = await res.json();
			assert.equal(path.dirname(path.dirname(saved)), uploads, name);
			const base = path.basename(saved);
			assert.ok(base.length <= 8 + 1 + 100 + 8, name);
			assert.doesNotMatch(base, /[\\/\u0000-\u001f]|^\./, name);
		}
		assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
		assert.equal(sanitizeUploadName(".bashrc"), "bashrc");
		assert.equal(sanitizeUploadName(".."), "file");
		assert.equal(sanitizeUploadName(""), "file");
		assert.equal(sanitizeUploadName('a<b>c:d"e|f?g*h.txt'), "a_b_c_d_e_f_g_h.txt");
		const long = sanitizeUploadName("\u00e9".repeat(200) + ".pdf");
		assert.ok(Buffer.byteLength(long) <= 100, String(Buffer.byteLength(long)));
		assert.ok(long.endsWith(".pdf") && !long.includes("\ufffd"));
		const emoji = sanitizeUploadName("\u{1F600}".repeat(60));
		assert.ok(Buffer.byteLength(emoji) <= 100 && !emoji.includes("\ufffd"));
		assert.ok(sanitizeUploadName("x".repeat(500) + ".md").endsWith(".md"));
	});

	it("rejects a missing Content-Length and writes nothing", async () => {
		const before = files().length;
		const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
		const req = new NextRequest("http://localhost/api/uploads", { method: "POST", body: stream, headers: { "x-file-name": "a.txt" }, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
		req.headers.delete("content-length");
		const res = await POST(req);
		assert.equal(res.status, 411);
		assert.equal(files().length, before);
	});

	it("rejects an over-limit Content-Length with 413 and writes nothing", async () => {
		const before = files().length;
		const res = await POST(upload(new Uint8Array([1]), "big.bin", { "content-length": String(MAX_IMPORT_BODY_BYTES + 1) }));
		assert.equal(res.status, 413);
		assert.equal(files().length, before);
	});

	it("deletes the partial file and returns 400 when received bytes differ from Content-Length", async () => {
		const before = files().length;
		const req = upload(new Uint8Array([1, 2, 3]), "short.bin");
		const headers = new Headers(req.headers);
		headers.set("content-length", "10");
		const res = await POST({ headers, body: req.body } as unknown as NextRequest);
		assert.equal(res.status, 400);
		assert.equal(files().length, before);
	});

	it("accepts a body at exactly the limit", async () => {
		const res = await POST(upload(new Uint8Array(MAX_IMPORT_BODY_BYTES), "max.bin"));
		assert.equal(res.status, 200);
		assert.equal(fs.statSync((await res.json()).path).size, MAX_IMPORT_BODY_BYTES);
	});
});
