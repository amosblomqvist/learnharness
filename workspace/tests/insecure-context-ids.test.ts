import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { newMessageId, newPlanBlockMessage, newUserMessage } from "../src/core/native-messages.ts";
import { randomHex } from "../src/core/random-id.ts";
import { newSideThreadId } from "../src/core/side-chat.ts";
import { uuid } from "../plugins/flashcards/src/uuid.js";

/**
 * The phone opens the app over plain HTTP on a LAN/tailnet address, which is
 * not a secure context, so the browser leaves crypto.randomUUID undefined.
 * Sending a message used to throw "crypto.randomUUID is not a function"
 * because the optimistic user bubble's id came from it. These pins run the
 * browser-facing mints with randomUUID removed.
 */
describe("ids minted without crypto.randomUUID (plain-HTTP phone link)", () => {
	before(() => {
		Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
		assert.equal(typeof crypto.randomUUID, "undefined");
	});
	after(() => {
		delete (crypto as { randomUUID?: unknown }).randomUUID;
		assert.equal(typeof crypto.randomUUID, "function");
	});

	it("randomHex returns two hex characters per byte", () => {
		assert.match(randomHex(), /^[0-9a-f]{32}$/);
		assert.match(randomHex(4), /^[0-9a-f]{8}$/);
	});

	it("core mints keep their id shapes", () => {
		assert.match(newMessageId(), /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newUserMessage("Teach me how to drive").id, /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newPlanBlockMessage("call_1", {}).id, /^pb_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(newSideThreadId(), /^side_[0-9a-z]+_[0-9a-f]{8}$/);
	});

	it("flashcards request ids are version 4 UUIDs", () => {
		const ids = new Set(Array.from({ length: 64 }, () => uuid()));
		assert.equal(ids.size, 64);
		for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});
