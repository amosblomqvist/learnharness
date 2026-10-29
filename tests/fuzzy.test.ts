import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore } from "../src/core/fuzzy.ts";

// The picker's search ranking (pi's /model pattern): tokens must each match
// some field; exact beats prefix beats buried substring; whole-query
// contiguity in one field is a bonus.

describe("fuzzyScore", () => {
	const fields = (id: string, name: string) => ["openrouter", id, name];

	it("matches across fields case-insensitively", () => {
		assert.ok(fuzzyScore("GLM", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")) !== null);
		assert.ok(fuzzyScore("flash", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")) !== null);
	});

	it("multi-token queries need every token to match somewhere", () => {
		assert.ok(fuzzyScore("glm flash", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")) !== null);
		assert.equal(fuzzyScore("glm qwen", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")), null);
	});

	it("ranks exact field equality above prefix above buried substring", () => {
		const exact = fuzzyScore("flash", "openrouter", "flash", "other"); // field === token
		const prefix = fuzzyScore("flash", "openrouter", "flash-2", "other"); // field startsWith
		const buried = fuzzyScore("flash", "openrouter", "z-ai/glm-5.3-flash", "other");
		assert.ok(exact !== null && prefix !== null && buried !== null);
		assert.ok(exact > prefix && prefix > buried, `${exact} > ${prefix} > ${buried}`);
	});

	it("rewards whole-query contiguity in a single field", () => {
		const split = fuzzyScore("glm flash", ...fields("z-ai/glm-5.3-flash", "x")); // two fields, no contiguity
		const joined = fuzzyScore("glm 5.3", ...fields("z-ai/glm-5.3-flash", "x")); // contiguous in the id
		assert.ok(split !== null && joined !== null);
		// same per-token points; joined earns the +50 contiguity bonus
		assert.ok(joined > split, `${joined} > ${split}`);
	});

	it("empty query matches everything at score 0", () => {
		assert.equal(fuzzyScore("", "anything"), 0);
		assert.equal(fuzzyScore("   ", "anything"), 0);
	});

	it("matches Arabic tashkeel and spelling variants with the same ranking", () => {
		for (const [query, text] of [["احمد", "أَحْمَد"], ["مدرسه", "مدرسة"], ["على", "علي"], ["علم", "عَـلْم"]]) {
			// The folded operand scores exactly as the plain one does against itself.
			const exact = fuzzyScore(query!, query!);
			assert.ok(exact !== null);
			assert.equal(fuzzyScore(query!, text!), exact);
			assert.equal(fuzzyScore(text!, query!), exact);
		}
		assert.ok(fuzzyScore("احمد مدرسه", "أَحْمَد", "مدرسة") !== null);
		assert.equal(fuzzyScore("احمد مفقود", "أَحْمَد", "مدرسة"), null);
	});

	it("uses Unicode folding for Latin accents, Hebrew niqqud and compatibility text", () => {
		for (const [query, text] of [["cafe", "café"], ["שלום", "שָׁלוֹם"], ["ffi", "ﬃ"]] as const) {
			const exact = fuzzyScore(query, query);
			assert.ok(exact !== null);
			assert.equal(fuzzyScore(query, text), exact);
			assert.equal(fuzzyScore(text, query), exact);
		}
	});

	it("keeps voiced kana apart: a bus is not a lotus", () => {
		assert.equal(fuzzyScore("ハス", "バス"), null);
		assert.equal(fuzzyScore("バス", "ﾊﾞｽ"), fuzzyScore("バス", "バス"));
	});
});
