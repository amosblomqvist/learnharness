/**
 * The auto-title's smart truncation (owner, 2026-10-06): the cut snaps to
 * a word boundary at or under TITLE_MAX_CHARS (72); a single word longer
 * than the cap splits at the cap. Pure seam: titleFromPrompt in
 * core/contracts/graph.ts, applied server-side at chat creation (the one
 * seam — home and both drafts post raw text; the route derives).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TITLE_MAX_CHARS, titleFromPrompt } from "../src/core/contracts/graph.ts";

describe("titleFromPrompt (smart truncation)", () => {
	it("short prompts pass through untouched — no ellipsis, whitespace collapsed", () => {
		assert.equal(titleFromPrompt("Relational databases"), "Relational databases");
		assert.equal(titleFromPrompt("line one\nline two\ttabbed"), "line one line two tabbed");
	});

	it("exactly at the cap: unchanged, no ellipsis", () => {
		const exact = "a".repeat(TITLE_MAX_CHARS);
		assert.equal(titleFromPrompt(exact), exact);
	});

	it("over the cap: the cut snaps to the last word boundary under it", () => {
		// > 72 chars total so truncation actually fires.
		const words = ["teach", "me", "the", "relational", "model", "and", "its", "information", "principle", "underlying", "everything", "please"];
		const joined = words.join(" "); // 10 words, > 72 chars
		const out = titleFromPrompt(joined);
		assert.ok(out.endsWith("…"), "marks the truncation");
		assert.ok(!out.slice(0, -1).endsWith(" "), "… attaches directly to the kept word");
		// The kept prefix is a prefix of the original at a word boundary:
		const kept = out.slice(0, -1);
		assert.ok(joined.startsWith(kept));
		assert.ok(kept.length <= TITLE_MAX_CHARS);
		assert.equal(joined[kept.length], " ", "the cut dropped a whole word, never half of one");
	});

	it("boundary landing exactly at the cap is a clean cut (no mid-word split)", () => {
		const first = "b".repeat(TITLE_MAX_CHARS); // fills the cap exactly
		const prompt = `${first} then more words after it`;
		const out = titleFromPrompt(prompt);
		assert.equal(out, `${first}…`);
	});

	it("a single word longer than the cap splits at the cap", () => {
		const giant = "x".repeat(TITLE_MAX_CHARS + 30);
		assert.equal(titleFromPrompt(giant), `${"x".repeat(TITLE_MAX_CHARS)}…`);
	});

	it("the kept title never carries a trailing space", () => {
		const prompt = `${"c".repeat(60)}  ${"d".repeat(60)}`; // collapses to one space
		const out = titleFromPrompt(prompt);
		assert.ok(!out.slice(0, -1).endsWith(" "));
		assert.ok(out.endsWith("…"));
	});
});
