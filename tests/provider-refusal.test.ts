import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProviderKeyRefusal } from "../components/chat.tsx";
import { modelsNotConfigured, providerKeyMissing } from "../src/core/settings.ts";

/** Silent disconnect fix: the question-answer path surfaces the server's
 *  503 provider_key_missing body as the thrown error text; the parser must
 *  key on the structured code, not on the key-wording tail. */
const body = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parseProviderKeyRefusal — structured envelope", () => {
	it("accepts custom (subscription disconnect) wording", () => {
		assert.equal(parseProviderKeyRefusal(body({ error: "Your Claude subscription is disconnected — reconnect it in Settings", code: "provider_key_missing", provider: "anthropic", slots: ["strong"] })), true);
		assert.equal(parseProviderKeyRefusal(body({ error: "ChatGPT disconnected", code: "provider_key_missing", provider: "openai", slots: [] })), true);
	});

	it("accepts a Claude disconnect refused on a question answer", () => {
		assert.equal(parseProviderKeyRefusal(body({ error: "Claude is not connected", code: "provider_key_missing", provider: "claude", slots: ["cheap", "strong"] })), true);
	});

	it("still accepts the standard envelope and legacy code+wording without provider/slots", () => {
		assert.equal(parseProviderKeyRefusal(JSON.stringify(providerKeyMissing("openrouter", ["strong"]))), true);
		assert.equal(parseProviderKeyRefusal(body({ error: providerKeyMissing("openai", []).error, code: "provider_key_missing" })), true);
	});
});

describe("parseProviderKeyRefusal — no misclassification", () => {
	it("rejects custom wording without provider/slots", () => {
		assert.equal(parseProviderKeyRefusal(body({ error: "Claude disconnected", code: "provider_key_missing" })), false);
		assert.equal(parseProviderKeyRefusal(body({ error: "x", code: "provider_key_missing", provider: "", slots: [] })), false);
		assert.equal(parseProviderKeyRefusal(body({ error: "x", code: "provider_key_missing", provider: "anthropic", slots: "strong" })), false);
		assert.equal(parseProviderKeyRefusal(body({ error: "x", code: "provider_key_missing", provider: "anthropic", slots: [1] })), false);
	});

	it("rejects other codes, even with matching wording or provider/slots", () => {
		assert.equal(parseProviderKeyRefusal(body({ error: providerKeyMissing("openai", []).error, code: "other", provider: "openai", slots: [] })), false);
		assert.equal(parseProviderKeyRefusal(body({ error: "No key", provider: "openai", slots: [] })), false);
		assert.equal(parseProviderKeyRefusal(JSON.stringify(modelsNotConfigured(["strong"]))), false);
		assert.equal(parseProviderKeyRefusal(body({ error: "A turn is already running" })), false);
	});

	it("rejects non-JSON, null, arrays and empty input", () => {
		for (const m of [undefined, "", "null", "[]", "42", "{not json", "FAILED: provider_key_missing"]) {
			assert.equal(parseProviderKeyRefusal(m), false, String(m));
		}
	});
});
