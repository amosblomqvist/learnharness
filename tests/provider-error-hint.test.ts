import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerErrorHint } from "../components/provider-error-hint.ts";

describe("providerErrorHint", () => {
	it("explains timeouts", () => {
		assert.ok(providerErrorHint("Request timed out."));
		assert.ok(providerErrorHint("connect ETIMEDOUT 1.2.3.4:443"));
	});
	it("stays silent for other errors", () => {
		assert.equal(providerErrorHint("401 Incorrect API key"), null);
		assert.equal(providerErrorHint("An error occurred."), null);
	});
});
