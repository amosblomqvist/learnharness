import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterNonContentPages, type PdfPage } from "../src/agent/subagents/pdf-markdown.ts";

describe("filterNonContentPages", () => {
	for (const { heading, entries } of [
		{
			heading: "Table of Contents",
			entries: ["Chapter 1: Intro ...... 1", "Chapter 2: Core ....... 15", "Chapter 3: Advanced ... 40"],
		},
		{
			heading: "Index",
			entries: ["Abstraction, 12, 14, 99", "Algorithm, 5, 23, 45", "Array, 18, 32"],
		},
	]) {
		for (const entryCount of [2, 3]) {
			it(`retains ${heading} pages with ${entryCount} entries and ${4 - entryCount} prose lines`, () => {
				const prose = ["Plants make sugar using sunlight.", "Roots absorb water from the soil."].slice(0, 4 - entryCount);
				const pages: PdfPage[] = [{
					kind: "text",
					number: 1,
					markdown: [`# ${heading}`, ...entries.slice(0, entryCount), ...prose].join("\n"),
				}];
				const result = filterNonContentPages(pages);
				assert.deepEqual(result.pages, pages);
				assert.equal(result.skippedCount, 0);
				assert.deepEqual(result.skippedTypes, []);
			});
		}
	}

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
