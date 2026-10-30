/**
 * The read tool (sources v0) — a Node port of pi's read semantics:
 * truncation with continuation offsets, image mime detection, error paths.
 * Driven through the NATIVE AgentTool execute (Wave A, 2026-09-26): text
 * reads return the raw string as details (the record's tool part output
 * reads it); image reads return native pi content parts (text + image)
 * with null details (the output-less part until the record persists).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { readTool } from "../src/agent/tools/read.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: string): string {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, content, "utf-8");
	return file;
}

/** Native execute → the raw string body (text reads ride details verbatim). */
const run = (args: { path: string; offset?: number; limit?: number }) =>
	readTool.execute!("test", args).then((r) => {
		assert.ok(r.content.length >= 1);
		const first = r.content[0]!;
		assert.equal(first.type, "text");
		return { text: (first as { type: "text"; text: string }).text, details: r.details };
	});

describe("read tool — text semantics", () => {
	it("reads a small file verbatim", async () => {
		const file = write("small.txt", "hello\nworld");
		const { text, details } = await run({ path: file });
		assert.equal(text, "hello\nworld");
		assert.equal(details, "hello\nworld", "the record part output carries the string verbatim");
	});

	it("resolves relative paths against the learner's home (sources v1 anchoring)", async () => {
		// sources v1: the harness has no meaningful cwd — "find my notes" must
		// work from a bare relative path, so the home directory is the anchor
		// (fs-shared resolveSourcePath). Scratch file in home, cleaned up.
		const rel = `lh-read-rel-test-${process.pid}.txt`;
		const homeFile = path.join(os.homedir(), rel);
		fs.writeFileSync(homeFile, "rel", "utf-8");
		try {
			assert.equal((await run({ path: rel })).text, "rel");
		} finally {
			fs.unlinkSync(homeFile);
		}
	});

	it("honors offset (1-indexed) and limit", async () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const file = write("thirty.txt", body);
		const out = (await run({ path: file, offset: 10, limit: 3 })).text;
		// pi parity: the explicit limit stopping short gets a remaining notice
		assert.match(out, /^line 10\nline 11\nline 12\n\n\[18 more lines in file\. Use offset=13 to continue\.\]$/);
	});

	it("offset beyond EOF is an error the model sees", async () => {
		const file = write("tiny.txt", "one");
		await assert.rejects(() => run({ path: file, offset: 99 }), /beyond end of file/);
	});

	it("a missing file throws (pi's error-result semantics)", async () => {
		await assert.rejects(() => run({ path: path.join(tmp, "nope.txt") }), /ENOENT/);
	});

	it("truncates at 2000 lines with a use-offset continuation notice", async () => {
		const body = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n");
		const file = write("big.txt", body);
		const out = (await run({ path: file })).text;
		assert.match(out, /Showing lines 1-2000 of 3000 \(2000 line limit\)/);
		assert.match(out, /Use offset=2001 to continue/);
		assert.ok(!out.includes("l2001\n"), "line 2001 must not ride along");
	});

	it("truncates at 50KB with the same continuation notice", async () => {
		// 200 lines of ~400B = ~80KB total, under the line cap — byte cap fires
		const line = "x".repeat(400);
		const body = Array.from({ length: 200 }, () => line).join("\n");
		const file = write("wide.txt", body);
		const out = (await run({ path: file })).text;
		assert.match(out, /50\.0KB limit\)\. Use offset=\d+ to continue\./);
		// and the truncation actually cut content
		assert.ok(out.length < 52_000, "the 50KB ceiling must cut the 80KB body");
	});

	it("an explicit limit that stops short gets a remaining-lines notice", async () => {
		const body = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
		const file = write("ten.txt", body);
		const out = (await run({ path: file, limit: 4 })).text;
		assert.match(out, /\[6 more lines in file\. Use offset=5 to continue\.\]/);
	});
});

describe("read tool — image semantics (native content parts)", () => {
	it("returns native text + image parts for image files, details null (output-less part)", async () => {
		const file = path.join(tmp, "dot.png");
		// Detection now sniffs bytes and the native processor decodes the image.
		const canvas = createCanvas(1, 1);
		canvas.getContext("2d").fillRect(0, 0, 1, 1);
		fs.writeFileSync(file, canvas.toBuffer("image/png"));
		const result = await readTool.execute!("test", { path: file });
		assert.equal(result.content.length, 2);
		const parts = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		const textPart = parts[0]!;
		const imagePart = parts[1]!;
		assert.equal(textPart.type, "text");
		assert.match(textPart.text!, /Read image file \[image\/png\]/);
		assert.equal(imagePart.type, "image");
		assert.equal(imagePart.mimeType, "image/png");
		assert.match(imagePart.data!, /^[A-Za-z0-9+/]+={0,2}$/);
		assert.equal(result.details, null, "image reads keep the record part output-less");
	});

	it("plain string results map to a single text part (parity)", async () => {
		const file = write("plain.txt", "body");
		const result = await readTool.execute!("test", { path: file });
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0]!.type, "text");
		assert.equal((result.content[0] as { type: "text"; text: string }).text, "body");
	});
});
