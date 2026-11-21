/**
 * write_note (2026-11-12): the teacher's only write surface. Two safety
 * properties matter and are pinned here — the name stays a single flat file
 * name, and an existing note is never silently replaced.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-note-write-"));
process.env = { ...process.env, NODE_ENV: "test", LH_DATA_DIR: path.join(scratch, "data") };

const { sanitizeNoteName, writeNote, notesDir } = await import("../src/agent/tools/write-note.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("sanitizeNoteName keeps one flat, unicode-friendly file name", () => {
	assert.equal(sanitizeNoteName("SecAI Domain 1 - weak areas"), "SecAI Domain 1 - weak areas");
	assert.equal(sanitizeNoteName("notes.md"), "notes");
	assert.equal(sanitizeNoteName("../../etc/passwd"), "passwd");
	assert.equal(sanitizeNoteName("a/b/c.md"), "c");
	assert.equal(sanitizeNoteName('we:ird?name*"<>'), "we_ird_name____");
	assert.equal(sanitizeNoteName("  "), "note");
	assert.equal(sanitizeNoteName("..."), "note");
	assert.equal(sanitizeNoteName("Türkçe Özet"), "Türkçe Özet");
});

test("notesDir honours LH_NOTES_DIR and falls back to <data>/notes", () => {
	delete process.env.LH_NOTES_DIR;
	assert.equal(notesDir(), path.join(scratch, "data", "notes"));
	process.env.LH_NOTES_DIR = path.join(scratch, "vault", "sub");
	assert.equal(notesDir(), path.join(scratch, "vault", "sub"));
	delete process.env.LH_NOTES_DIR;
});

test("writeNote creates the folder, writes markdown, and never overwrites by default", () => {
	const dir = path.join(scratch, "notes-out");
	const first = writeNote(dir, "Session notes", "# hello\n");
	assert.equal(first.name, "Session notes.md");
	assert.equal(fs.readFileSync(first.path, "utf8"), "# hello\n");

	const second = writeNote(dir, "Session notes", "# second\n");
	assert.equal(second.suffixed, true);
	assert.equal(second.name, "Session notes-2.md");
	assert.equal(fs.readFileSync(first.path, "utf8"), "# hello\n", "original stays intact");

	const replaced = writeNote(dir, "Session notes", "# replaced\n", true);
	assert.equal(replaced.suffixed, false);
	assert.equal(fs.readFileSync(first.path, "utf8"), "# replaced\n");
});
