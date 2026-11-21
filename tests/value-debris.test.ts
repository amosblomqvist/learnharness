import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripModelValueDebris } from "../src/core/value-debris.ts";

// Membership values only: free text (statements, explanations) must never go
// through this strip. These are the shapes the whitehead incident recorded.
describe("stripModelValueDebris", () => {
	it("removes interleaved whitespace, colons and quotes around a value", () => {
		assert.equal(stripModelValueDebris(`":parmenides"`), "parmenides");
		assert.equal(stripModelValueDebris("  : `value`  "), "value");
		assert.equal(stripModelValueDebris("value"), "value");
	});

	it("never rewrites the interior of a value", () => {
		assert.equal(stripModelValueDebris(`":a:b"`), "a:b");
		assert.equal(stripModelValueDebris(" a b "), "a b");
		assert.equal(stripModelValueDebris("a\"b"), "a\"b");
	});

	it("is idempotent; an all-debris value reduces to the empty string", () => {
		assert.equal(stripModelValueDebris(`":"`), "");
		const once = stripModelValueDebris(`" : value : "`);
		assert.equal(stripModelValueDebris(once), once);
	});
});
