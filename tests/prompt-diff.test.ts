import assert from "node:assert/strict";
import { it } from "node:test";
import { diffPromptText, pairPromptDiffRows } from "../src/core/prompt-diff.ts";

it("shows changed words inside replaced lines and keeps unchanged context", () => {
	assert.deepEqual(diffPromptText("Use the old label\nKeep this.", "Use the new label\nKeep this."), [
		{
			kind: "removed",
			oldLine: 1,
			newLine: null,
			parts: [{ text: "Use the ", changed: false }, { text: "old", changed: true }, { text: " label", changed: false }],
		},
		{
			kind: "added",
			oldLine: null,
			newLine: 1,
			parts: [{ text: "Use the ", changed: false }, { text: "new", changed: true }, { text: " label", changed: false }],
		},
		{
			kind: "same",
			oldLine: 2,
			newLine: 2,
			parts: [{ text: "Keep this.", changed: false }],
		},
	]);
});

it("pairs removed and added lines for side-by-side comparisons", () => {
	const pairs = pairPromptDiffRows(diffPromptText("old line\nKeep this.", "new line\nKeep this."));
	assert.deepEqual(pairs.map((pair) => [pair.old?.kind, pair.current?.kind]), [
		["removed", "added"],
		["same", "same"],
	]);
});

it("treats an empty saved prompt as zero lines", () => {
	assert.deepEqual(diffPromptText("", "First line\nSecond line"), [
		{ kind: "added", oldLine: null, newLine: 1, parts: [{ text: "First line", changed: false }] },
		{ kind: "added", oldLine: null, newLine: 2, parts: [{ text: "Second line", changed: false }] },
	]);
});
