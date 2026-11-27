import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceFileLabel } from "../src/core/source-label.ts";

// Display-only projection: the stored path stays the source's identity, so
// these pins cover exactly the strings that get shortened in lists and chips.
describe("sourceFileLabel", () => {
	it("strips only the final extension, preserving spelling and punctuation", () => {
		assert.equal(sourceFileLabel("/notes/Chapter 2.final.md"), "Chapter 2.final");
		assert.equal(sourceFileLabel("report.pdf"), "report");
		assert.equal(sourceFileLabel("C:\\notes\\report.pdf"), "report");
	});

	it("leaves dotfiles and dot-only suffixes intact rather than returning an empty label", () => {
		assert.equal(sourceFileLabel(".gitignore"), ".gitignore");
		assert.equal(sourceFileLabel(".."), "..");
		assert.equal(sourceFileLabel("report.."), "report..");
	});

	it("keeps a trailing-separator path as-is (there is no basename to show)", () => {
		assert.equal(sourceFileLabel("/a/b/"), "/a/b/");
	});
});
