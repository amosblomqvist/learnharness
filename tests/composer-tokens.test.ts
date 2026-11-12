import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseComposerTokens } from "../src/core/composer-tokens.ts";
import { quoteFilePath, serializeCitation } from "../src/core/index.ts";

const cite = (text: string) => serializeCitation({ version: 1, chatId: "c", messageId: "m", text, start: 0, end: text.length, prefix: "", suffix: "" });

describe("parseComposerTokens", () => {
	it("is lossless across paths, citations and Unicode", () => {
		const text = `☃ ${quoteFilePath("/a/b.md")}, ${cite("q")}${cite("r")}!`;
		const parts = parseComposerTokens(text);
		assert.equal(parts.map((p) => p.text).join(""), text);
		assert.deepEqual(parts.map((p) => p.kind), ["text", "path", "text", "citation", "citation", "text"]);
		for (const p of parts) assert.equal(text.slice(p.start, p.end), p.text);
	});

	it("lets a citation win over a path-looking span inside it", () => {
		assert.deepEqual(parseComposerTokens(cite("`/etc/x`")).map((p) => p.kind), ["citation"]);
	});

	it("keeps malformed citation links as editable text", () => {
		assert.deepEqual(parseComposerTokens("[Tutor quote](lh-citation://v1/a/b?text=x)").map((p) => p.kind), ["text"]);
	});

	it("returns nothing for empty text, like parseFilePaths", () => {
		assert.deepEqual(parseComposerTokens(""), []);
	});
});
