import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	IMPORT_ACCEPT, IMPORT_EXTENSIONS, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES,
	validNotesPath,
} from "../lib/notes-import-limits.ts";

// The import route tests exercise these through HTTP. Here the pure constants
// and the path grammar are pinned directly, so a change to the shared list is
// visible without going through a multipart request.
describe("import extension contract", () => {
	it("matches case-insensitively and only at the end of the name", () => {
		for (const name of ["a.md", "a.MARKDOWN", "notes.tex", "x.pdf", "a.md.txt"]) assert.ok(IMPORT_EXTENSIONS.test(name), name);
		for (const name of ["a.docx", "a.txt.bak", "md", "a.md/"]) assert.ok(!IMPORT_EXTENSIONS.test(name), name);
	});

	it("keeps the picker accept list and the regex derived from the same source", () => {
		assert.equal(IMPORT_ACCEPT, ".txt,.md,.markdown,.rst,.org,.adoc,.tex,.pdf");
		assert.ok(MAX_IMPORT_BODY_BYTES > MAX_IMPORT_BYTES);
	});
});

describe("validNotesPath", () => {
	it("accepts a plain basename and a folder-relative identity", () => {
		assert.equal(validNotesPath("a.md", "a.md"), true);
		assert.equal(validNotesPath("unit/week1/a.md", "a.md"), true);
	});

	it("refuses traversal, empty segments, mismatched names and unsafe characters", () => {
		const cases: [string, string][] = [
			["a/../b.md", "b.md"], ["a//b.md", "b.md"], ["a/b.md/", "b.md"],
			["a/b.md", "other.md"], ["a\\b.md", "b.md"], ["a/b" + String.fromCharCode(0) + ".md", "b.md"], ["", "a.md"],
		];
		for (const [p, filename] of cases) assert.equal(validNotesPath(p, filename), false, `${p} / ${filename}`);
	});

	it("bounds the whole identity at 1024 characters", () => {
		const long = "a".repeat(1025);
		assert.equal(validNotesPath(long, long), false);
	});
});
