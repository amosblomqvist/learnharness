/**
 * Web attachment upload helpers (2026-11-11): a browser File has no path, so
 * the route stores the bytes under the app data dir and the agent reads the
 * returned absolute path. These tests pin the two safety properties — the
 * relative path can never escape its folder and the writer refuses an escape
 * even if the caller hands one in directly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
const originalEnv = process.env;
process.env = {
	...originalEnv,
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
};

const { safeRelativePath, writeUpload, ATTACHMENTS_DIR } = await import("../src/server/attachments.ts");

after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

test("safeRelativePath keeps folder structure but strips traversal and hostile characters", () => {
	assert.equal(safeRelativePath("course/week1/slides.pdf"), "course/week1/slides.pdf");
	assert.equal(safeRelativePath("../../etc/passwd"), "etc/passwd");
	assert.equal(safeRelativePath("/abs/./file.md"), "abs/file.md");
	assert.equal(safeRelativePath("a\\b\\c.txt"), "a/b/c.txt");
	assert.equal(safeRelativePath('we:ird?name*"<>.pdf'), "we_ird_name____.pdf");
	assert.equal(safeRelativePath(""), "file");
	assert.equal(safeRelativePath(undefined), "file");
	assert.equal(safeRelativePath("..."), "...");
});

test("writeUpload stores the bytes under the attachments dir and returns an absolute path", () => {
	const dir = path.join(ATTACHMENTS_DIR, "unit");
	const target = writeUpload(dir, "nested/notes.md", new TextEncoder().encode("# hello"));
	assert.ok(path.isAbsolute(target));
	assert.ok(target.startsWith(ATTACHMENTS_DIR + path.sep));
	assert.equal(fs.readFileSync(target, "utf8"), "# hello");
});

test("writeUpload refuses a relative path that resolves outside its dir", () => {
	assert.throws(() => writeUpload(path.join(ATTACHMENTS_DIR, "unit2"), "../escape.txt", new Uint8Array([1])), /unsafe upload path/);
});
