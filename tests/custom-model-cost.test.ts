import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeCustomModelCost, sanitizeCustomModelOverrides } from "../src/core/settings.ts";
import { parseCustomModelOverridesBody } from "../src/server/settings-body.ts";
import { callCost } from "../src/server/pricing.ts";

const cost = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 };

describe("custom model cost pins", () => {
	it("keeps a valid rate pin through parse and sanitize", () => {
		const parsed = parseCustomModelOverridesBody({ overrides: { "ds/flash": { cost } } });
		assert.ok(parsed.ok);
		assert.deepEqual(sanitizeCustomModelOverrides(parsed.settings, ["ds/flash"])["ds/flash"]?.cost, cost);
	});

	it("rejects partial, negative and all-zero rates", () => {
		assert.equal(sanitizeCustomModelCost({ input: 1, output: 1 }), undefined);
		assert.equal(sanitizeCustomModelCost({ ...cost, output: -1 }), undefined);
		assert.equal(sanitizeCustomModelCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
		assert.equal(parseCustomModelOverridesBody({ overrides: { a: { cost: { input: 1 } } } }).ok, false);
	});

	it("leaves an unpinned custom model unpriced, not free", () => {
		assert.equal(callCost({ inputTokens: 100, outputTokens: 10 }, "custom:missing-model"), null);
	});
});
