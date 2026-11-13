import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanRepeatingHeadersFooters, type PdfPage } from "../src/agent/subagents/pdf-markdown.ts";

describe("cleanRepeatingHeadersFooters", () => {
	it("preserves pages when count is under 3", () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "Title\nBody 1" },
			{ kind: "text", number: 2, markdown: "Title\nBody 2" },
		];
		const cleaned = cleanRepeatingHeadersFooters(pages);
		assert.deepEqual(cleaned, pages);
	});

	it("removes repeating running header and trailing page numbers across >= 3 pages", () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "Introduction to Calculus\nCore content on derivatives.\n1" },
			{ kind: "text", number: 2, markdown: "Introduction to Calculus\nDiscussion of chain rule.\n2" },
			{ kind: "text", number: 3, markdown: "Introduction to Calculus\nIntegral definitions.\n3" },
			{ kind: "text", number: 4, markdown: "Introduction to Calculus\nFundamental theorem.\n4" },
		];
		const cleaned = cleanRepeatingHeadersFooters(pages);
		assert.equal(cleaned.length, 4);
		assert.equal(cleaned[0]?.kind, "text");
		if (cleaned[0]?.kind === "text") {
			assert.equal(cleaned[0].markdown, "Core content on derivatives.");
		}
		if (cleaned[1]?.kind === "text") {
			assert.equal(cleaned[1].markdown, "Discussion of chain rule.");
		}
		if (cleaned[2]?.kind === "text") {
			assert.equal(cleaned[2].markdown, "Integral definitions.");
		}
		if (cleaned[3]?.kind === "text") {
			assert.equal(cleaned[3].markdown, "Fundamental theorem.");
		}
	});

	it("leaves distinct first and last lines untouched", () => {
		const pages: PdfPage[] = [
			{ kind: "text", number: 1, markdown: "Chapter 1\nUnique content A\nEnd of chapter 1" },
			{ kind: "text", number: 2, markdown: "Chapter 2\nUnique content B\nEnd of chapter 2" },
			{ kind: "text", number: 3, markdown: "Chapter 3\nUnique content C\nEnd of chapter 3" },
		];
		const cleaned = cleanRepeatingHeadersFooters(pages);
		assert.deepEqual(cleaned, pages);
	});
});
