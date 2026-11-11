import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationPulseSteps, citationSourceHref, revealPlan } from "../components/citation-source.ts";

describe("revealPlan", () => {
	it("navigates to a citation from another chat", () => {
		assert.equal(revealPlan({ citationChatId: "a", currentChatId: "b", rangeFound: true, messageFound: true }), "navigate");
	});
	it("highlights the quote when it can be re-found", () => {
		assert.equal(revealPlan({ citationChatId: "a", currentChatId: "a", rangeFound: true, messageFound: true }), "highlight");
	});
	it("falls back to the message when the quote changed", () => {
		assert.equal(revealPlan({ citationChatId: "a", currentChatId: "a", rangeFound: false, messageFound: true }), "message");
	});
	it("does nothing when the message is gone", () => {
		assert.equal(revealPlan({ citationChatId: "a", currentChatId: "a", rangeFound: false, messageFound: false }), "missing");
	});
});

describe("compact citation reveal", () => {
	it("uses exactly two quick pulses and no prolonged final hold", () => {
		assert.deepEqual(citationPulseSteps(false), [[true, 0], [false, 250], [true, 500], [false, 750]]);
	});
	it("respects reduced motion with one short steady highlight", () => {
		assert.deepEqual(citationPulseSteps(true), [[true, 0], [false, 750]]);
	});
});

describe("citationSourceHref", () => {
	it("is the existing message-anchor link into the citation's chat", () => {
		assert.equal(citationSourceHref({ chatId: "c 1", messageId: "m/2" }), "/chat/c%201#message-m%2F2");
	});
});
