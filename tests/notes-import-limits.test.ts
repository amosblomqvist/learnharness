import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	IMPORT_EXTENSIONS,
	MAX_IMPORT_BODY_BYTES,
	MAX_IMPORT_BYTES,
	validNotesPath,
} from "../lib/notes-import-limits.ts";

describe("notes import limits", () => {
	it("caps each file at 25 MB and the multipart body at 26 MB", () => {
		assert.equal(MAX_IMPORT_BYTES, 25 * 1024 * 1024);
		assert.equal(MAX_IMPORT_BODY_BYTES, 26 * 1024 * 1024);
		assert.ok(MAX_IMPORT_BODY_BYTES > MAX_IMPORT_BYTES, "the body allowance sits above the file cap for metadata");
	});

	it("accepts the four note formats regardless of case", () => {
		for (const name of ["a.md", "a.MD", "a.markdown", "a.Markdown", "a.txt", "a.TXT", "a.pdf", "a.PDF"]) {
			assert.equal(IMPORT_EXTENSIONS.test(name), true, name);
		}
	});

	it("refuses anything else, including near-miss extensions", () => {
		for (const name of ["a.docx", "a.png", "a", "a.md.pdfx", "a.md.txt.bak", "a.rtf"]) {
			assert.equal(IMPORT_EXTENSIONS.test(name), false, name);
		}
	});

	it("stays stateless across repeated tests (no global flag)", () => {
		assert.equal(IMPORT_EXTENSIONS.test("notes.md"), true);
		assert.equal(IMPORT_EXTENSIONS.test("notes.md"), true);
	});
});

describe("validNotesPath", () => {
	it("accepts a bare basename or a nested relative path ending in the filename", () => {
		assert.equal(validNotesPath("notes.md", "notes.md"), true);
		assert.equal(validNotesPath("Course/Week 1/notes.md", "notes.md"), true);
	});

	it("accepts a Chromium full relative filename when it equals the path", () => {
		assert.equal(validNotesPath("Folder/Sub/notes.txt", "Folder/Sub/notes.txt"), true);
	});

	it("rejects a path whose last segment does not match the filename", () => {
		assert.equal(validNotesPath("Course/other.md", "notes.md"), false);
		assert.equal(validNotesPath("notes.md", "other.md"), false);
	});

	it("accepts paths up to 1024 characters and rejects longer ones", () => {
		const suffix = "/notes.md";
		const atLimit = "a".repeat(1024 - suffix.length) + suffix;
		assert.equal(atLimit.length, 1024);
		assert.equal(validNotesPath(atLimit, "notes.md"), true);
		assert.equal(validNotesPath(atLimit + "b", "notes.md"), false);
	});

	it("rejects empty and absolute paths", () => {
		assert.equal(validNotesPath("", "notes.md"), false);
		assert.equal(validNotesPath("/notes.md", "notes.md"), false);
	});

	it("rejects empty, dot and dot-dot segments", () => {
		assert.equal(validNotesPath("a//notes.md", "notes.md"), false);
		assert.equal(validNotesPath("a/./notes.md", "notes.md"), false);
		assert.equal(validNotesPath("a/../notes.md", "notes.md"), false);
		assert.equal(validNotesPath("notes.md/", "notes.md"), false);
	});

	it("rejects backslashes, colons and control characters", () => {
		assert.equal(validNotesPath("a\\notes.md", "notes.md"), false);
		assert.equal(validNotesPath("C:/notes.md", "notes.md"), false);
		assert.equal(validNotesPath("a/\u0001notes.md", "notes.md"), false);
		assert.equal(validNotesPath("a/\u007fnotes.md", "notes.md"), false);
	});
});
