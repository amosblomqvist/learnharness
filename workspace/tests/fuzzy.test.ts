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
});