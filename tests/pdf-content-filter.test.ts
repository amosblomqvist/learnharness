import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterNonContentPages, type PdfPage } from "../src/agent/subagents/pdf-markdown.ts";

describe("filterNonContentPages", () => {
	it("preserves ordinary content pages", () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "# Chapter 1\nThis is core subject matter." },
			{ kind: "text", number: 2, markdown: "# Chapter 2\nAnother important concept explained." },
		];
		const result = filterNonContentPages(pages);
		assert.equal(result.pages.length, 2);
		assert.equal(result.skippedCount, 0);
	});

	it("filters out Table of Contents pages", () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "# Table of Contents\nChapter 1: Intro ...... 1\nChapter 2: Core ....... 15\nChapter 3: Advanced ... 40" },
			{ kind: "text", number: 2, markdown: "# Chapter 1\nActual core learning material." },
		];
		const result = filterNonContentPages(pages);
		assert.equal(result.pages.length, 1);
		assert.equal(result.pages[0]?.number, 2);
		assert.equal(result.skippedCount, 1);
		assert.ok(result.skippedTypes.includes("contents"));
	});

	it("filters out Index pages with word-number references", () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "# Chapter 1\nCore material." },
			{ kind: "text", number: 2, markdown: "# Index\nAbstraction, 12, 14, 99\nAlgorithm, 5, 23, 45\nArray, 18, 32" },
		];
		const result = filterNonContentPages(pages);
		assert.equal(result.pages.length, 1);
		assert.equal(result.pages[0]?.number, 1);
		assert.equal(result.skippedCount, 1);
		assert.ok(result.skippedTypes.includes("index"));
	});
});
