/**
 * Message ids must mint outside secure contexts. Browsers only expose
 * crypto.randomUUID on https and localhost; the self-hosted server is often
 * plain http on the LAN (http://192.168.x.x:3000), where minting with it
 * threw inside send() and the iPhone app never posted the answer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newMessageId, newUserMessage } from "../src/core/native-messages.ts";

describe("message id minting", () => {
	it("works where crypto.randomUUID is unavailable (plain http)", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
		Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
		try {
			assert.match(newMessageId(), /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
			assert.equal(newUserMessage("hello").role, "user");
		} finally {
			if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
			else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
		}
	});

	it("keeps ids distinct", () => {
		const ids = new Set(Array.from({ length: 500 }, () => newMessageId()));
		assert.equal(ids.size, 500);
	});
});
