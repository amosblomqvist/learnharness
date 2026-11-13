import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkNotes } from "../src/agent/subagents/extraction.ts";

describe("AST-aware chunkNotes", () => {
	it("returns empty array for empty or blank text", () => {
		assert.deepEqual(chunkNotes("", 100), []);
		assert.deepEqual(chunkNotes("   \n\n  ", 100), []);
	});

	it("keeps text within budget as a single chunk", () => {
		const text = "First line\nSecond line\nThird line";
		const chunks = chunkNotes(text, 100);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0], text);
	});

	it("does not split inside fenced code blocks when budget allows", () => {
		const lines = [
			"Some introductory text before code.",
			"```typescript",
			"function calculateTotal(items: Item[]): number {",
			"    let sum = 0;",
			"    for (const item of items) {",
			"        sum += item.price;",
			"    }",
			"    return sum;",
			"}",
			"```",
			"Follow-up paragraph after the code block.",
		];
		const text = lines.join("\n");
		// Budget is small enough that splitting could happen, but it must not split between ``` and ```
		const chunks = chunkNotes(text, 35);
		assert.ok(chunks.length >= 2);
		// Check that no chunk contains unclosed code fence
		for (const chunk of chunks) {
			const count = (chunk.match(/```/g) ?? []).length;
			assert.equal(count % 2, 0, `Chunk must not have unmatched code fence: ${chunk}`);
		}
	});

	it("does not split inside markdown tables when budget allows", () => {
		const lines = [
			"Here is a comparison table:",
			"| Feature | Old | New |",
			"| :--- | :--- | :--- |",
			"| Speed | Slow | Fast |",
			"| Memory | High | Low |",
			"End of the table description.",
		];
		const text = lines.join("\n");
		const chunks = chunkNotes(text, 25);
		// The table lines should stay together in one chunk
		const tableChunk = chunks.find((c) => c.includes("| Feature | Old | New |"));
		assert.ok(tableChunk);
		assert.ok(tableChunk.includes("| Memory | High | Low |"));
	});

	it("prefers splitting on markdown headings near budget", () => {
		const section1 = ["# Chapter 1: Foundations", "Line A", "Line B", "Line C"].join("\n");
		const section2 = ["# Chapter 2: Advanced Topics", "Line D", "Line E", "Line F"].join("\n");
		const text = `${section1}\n\n${section2}`;
		// Budget is set so section 1 fills ~75% of budget
		const budget = Math.ceil(section1.length / 4) + 10;
		const chunks = chunkNotes(text, budget);
		assert.equal(chunks.length, 2);
		assert.ok(chunks[0]?.startsWith("# Chapter 1:"));
		assert.ok(chunks[1]?.startsWith("# Chapter 2:"));
	});
});
