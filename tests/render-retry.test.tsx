/**
 * The Retry affordance (#122): retryPlacement decides where `Retry`
 * renders (under the LAST assistant group only; hidden while busy or
 * compacting; NOT hidden by a pending question; under the error when the
 * transcript ends on the learner's input) and RetryAction is the button.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { RetryAction, retryPlacement } from "../components/retry-action.tsx";
import type { LhViewMessage } from "../src/core/view.ts";

const user = (id: string): LhViewMessage => ({ id, role: "user", parts: [{ type: "text", text: "hi" }] });
const agent = (id: string, parts: LhViewMessage["parts"] = [{ type: "text", text: "reply" }]): LhViewMessage => ({
	id,
	role: "assistant",
	parts,
});
const idle = { busy: false, compacting: false, hasError: false, lastServerStamped: true };

describe("retryPlacement", () => {
	it("shows under the LAST assistant group only", () => {
		const messages = [user("u1"), agent("a1"), user("u2"), agent("a2")];
		assert.equal(retryPlacement({ ...idle, messages }), "group");
		// the caller renders it at index === last: exactly one group qualifies
		assert.equal(messages.at(-1)!.id, "a2");
	});

	it("is absent while busy or compacting", () => {
		const messages = [user("u1"), agent("a1")];
		assert.equal(retryPlacement({ ...idle, messages, busy: true }), null);
		assert.equal(retryPlacement({ ...idle, messages, compacting: true }), null);
	});

	it("is present with a pending question (the unanswered question goes with the span)", () => {
		const messages = [
			user("u1"),
			agent("a1", [{ type: "tool-quiz", toolCallId: "q1", state: "input-available" }]),
		];
		assert.equal(retryPlacement({ ...idle, messages }), "group");
	});

	it("under the error when the transcript ends on the learner's input", () => {
		const messages = [user("u1"), agent("a1"), user("u2")];
		assert.equal(retryPlacement({ ...idle, messages, hasError: true }), "error");
		assert.equal(retryPlacement({ ...idle, messages }), null, "no error, nothing to retry under");
	});

	it("is absent while the last message is client-minted (not in the record yet)", () => {
		const messages = [user("u1"), agent("a1"), user("u2")];
		assert.equal(retryPlacement({ ...idle, messages, hasError: true, lastServerStamped: false }), null);
		assert.equal(retryPlacement({ ...idle, messages: [user("u1"), agent("a1")], lastServerStamped: false }), null);
	});

	it("nothing in an empty transcript", () => {
		assert.equal(retryPlacement({ ...idle, messages: [], hasError: true }), null);
	});
});

describe("RetryAction", () => {
	it("renders a visible Retry button with the test id", () => {
		const html = renderToStaticMarkup(<RetryAction onRetry={() => {}} />);
		assert.match(html, /data-testid="retry-message"/);
		assert.match(html, /Retry/);
		assert.match(html, /<svg/, "the RotateCcw icon rides the label");
	});
});
