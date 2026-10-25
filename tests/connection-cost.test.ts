import assert from "node:assert/strict";
import { it } from "node:test";
import { callCost } from "../src/server/pricing.ts";
it("subscription and custom-provider costs remain unpriced, not a zero subscription bill", () => {
	for (const model of ["subscription-anthropic:claude-sonnet-5-5", "subscription-openai-codex:gpt-6-luna", "custom-local:test-model"]) {
		assert.equal(callCost({ inputTokens: 100, outputTokens: 50 }, model), null);
	}
});


import { priceLabel } from "../components/settings/model-menu.tsx";
it("the model menu distinguishes unknown costs, explicit zero rates and subscriptions", () => {
	assert.equal(priceLabel(null), "Unpriced");
	assert.equal(priceLabel(null, "subscription"), "Subscription");
	assert.match(priceLabel({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), /\$0/);
});
