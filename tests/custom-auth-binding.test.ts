import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCustomAuthBinding } from "../src/core/custom-provider-auth.ts";

// The custom-provider boundaries suite tests the HTTP seam. This pins the
// pure parser that decides whether a stored binding is usable at all.
const ID = "a".repeat(32);
const valid = (over: Record<string, unknown> = {}) => JSON.stringify({
	version: 1, id: ID, authMode: "apiKey", baseUrl: "https://api.example.com", ...over,
});

describe("parseCustomAuthBinding", () => {
	it("parses a well-formed binding and preserves its optional fields", () => {
		assert.deepEqual(parseCustomAuthBinding(valid()), {
			version: 1, id: ID, authMode: "apiKey", baseUrl: "https://api.example.com",
		});
		assert.deepEqual(parseCustomAuthBinding(valid({ fileKeyBaseUrl: "https://old.example.com" })), {
			version: 1, id: ID, authMode: "apiKey", baseUrl: "https://api.example.com",
			fileKeyBaseUrl: "https://old.example.com",
		});
	});

	it("a disabled binding needs no baseUrl", () => {
		assert.deepEqual(parseCustomAuthBinding(JSON.stringify({ version: 1, id: ID, authMode: "disabled" })), {
			version: 1, id: ID, authMode: "disabled",
		});
	});

	it("rejects bad versions, ids, modes and unnormalized URLs", () => {
		for (const raw of [
			valid({ version: 2 }), valid({ id: "short" }), valid({ id: "A".repeat(32) }),
			valid({ authMode: "oauth" }), valid({ baseUrl: "https://api.example.com/" }),
			valid({ baseUrl: "" }), valid({ fileKeyBaseUrl: 1 }),
			"not json", "null", "[]", undefined, 42,
		]) {
			assert.equal(parseCustomAuthBinding(raw), undefined, String(raw).slice(0, 90));
		}
	});
});
